/**
 * candidate-measure.ts — candidate measurement, promotion gate and CAS
 * leader promotion for candidate-branch campaigns.
 *
 * Scope: openspec/changes/candidate-branches design.md §3 (policy and
 * measurement) and §5; epic pi-autoresearch-3e4.4, task
 * pi-autoresearch-3e4.4.3.2.
 *
 * Deliberately standalone: no imports at all, no filesystem access, no
 * child processes of its own. Every external command (benchmark, checks,
 * git) runs through an injected ExecRunner, so tests substitute a fake.
 * The caller provides clean worktrees and passes their paths in; this
 * module never creates, deletes or checks out a worktree, never touches
 * the user's branch, and mutates Git state ONLY via
 * `git update-ref <leaderRef> <newSha> <expectedSha>` (compare-and-swap).
 *
 * Guarantees:
 *   - Every refusal is { ok: false, reason, message } with a single-line
 *     message (control characters escaped, dynamic values quoted); no
 *     refusal mutates anything.
 *   - A measurement value must come from the repository convention line
 *     `METRIC <metric_name>=<value>` printed by the benchmark on stdout,
 *     where <metric_name> matches [\w.µ]+ (the convention used by
 *     run_experiment in index.ts). Policy validation should therefore
 *     restrict metric_name to that charset at init time; a policy metric
 *     outside the charset can never parse and every measurement refuses
 *     with metric_missing.
 *     A missing line, more than one line for the requested metric, or a
 *     non-finite value refuse the measurement. (This deliberately
 *     diverges from index.ts last-wins parsing: promotion evidence must
 *     be unambiguous.)
 *   - A repeated measurement refuses on the first failed repeat (wrong
 *     exit code, timeout, unparsable output); a partial average is never
 *     produced for a comparison. The optional budgetMs (policy
 *     confirm_budget_seconds) refuses further repeats once elapsed time
 *     has consumed the budget before a repeat starts.
 *   - compareForPromotion requires ALL of: non-empty commits, matching
 *     metric name and direction on both sides, equal leader/candidate
 *     epochs, unchanged methodology hashes (exact string compare —
 *     case normalization is the caller's job), a read-only rev-parse
 *     proving the checks worktree HEAD is exactly the candidate
 *     checkpoint, successful checks, and a directed gain strictly
 *     greater than min_gain (equality refuses with gain_below_threshold;
 *     the comparison tolerates float subtraction noise scaled to the
 *     operand magnitudes — ULP-based epsilon over leader/candidate
 *     averages plus min_gain — so a decimal-exact equality cannot be
 *     promoted by representation error at normal magnitudes (subnormal
 *     scales below ~2.2e-308 keep a MIN_VALUE floor tolerance), while
 *     gains exceeding the threshold by more than that tolerance still promote).
 *   - promoteLeader uses compare-and-swap. On CAS mismatch (git reports
 *     "is at ... but expected ...") the refusal is leader_moved and the
 *     leader stays as it was; any other update-ref failure is
 *     update_failed (the ref is likewise unchanged); when the outcome is
 *     unknown (runner threw, run killed by timeout) the refusal is
 *     uncertain and tells the operator to verify the ref by hand.
 *
 * Not promised (design §1/§4): power-loss durability, filesystem
 * corruption, concurrent old versions, external Git commands, statistical
 * significance of repeats (repeats + min_gain are an agreed rule, not a
 * proof).
 */

// ─── Shared types and helpers ────────────────────────────────────────────────

export type PolicyDirection = "higher" | "lower";

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number;
  /** Set by the runner when the process was killed (e.g. timeout). */
  killed?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** Full argv (including the program), e.g. ["git", "update-ref", ...]. */
export type ExecRunner = (
  cmd: string[],
  opts?: ExecOptions,
) => Promise<ExecOutcome>;

export interface Refusal<R extends string = string> {
  ok: false;
  reason: R;
  message: string;
}

/** Escape control characters so a message can never span multiple lines. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Quote a user-controlled value for a message. */
function quote(s: string): string {
  return oneLine(JSON.stringify(s));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collapse whitespace and cap the length of captured command output. */
function excerpt(s: string, max = 300): string {
  return oneLine(s.replace(/\s+/g, " ").trim().slice(0, max));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One ULP of a non-negative magnitude: the gap to the next representable
 *  double. Used to scale float-subtraction tolerance to operand magnitude.
 *  Math.max guards subnormals: EPSILON * MIN_VALUE underflows to 0, and a
 *  zero tolerance would let a decimal-exact equality promote below ~2.2e-308. */
function ulpOf(magnitude: number): number {
  const m = magnitude > 0 ? magnitude : Number.MIN_VALUE;
  return Math.max(Number.EPSILON * m, Number.MIN_VALUE);
}

function refuse<R extends string>(reason: R, message: string): Refusal<R> {
  return { ok: false, reason, message: oneLine(message) };
}

/** Validate dir/argv/timeout triple shared by benchmark and checks runs. */
function validateDirArgvTimeout(
  dir: unknown,
  argv: unknown,
  timeoutMs: unknown,
): string | null {
  if (!isNonEmptyString(dir)) return `"dir" must be a non-empty string`;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
    return `"argv" must be a non-empty array of strings`;
  }
  if (!argv.some((a) => (a as string).trim().length > 0)) {
    return `"argv" must contain at least one non-empty argument`;
  }
  if (!isFiniteNumber(timeoutMs) || (timeoutMs as number) <= 0) {
    return `"timeoutMs" must be a finite number > 0`;
  }
  return null;
}

// ─── Single measurement ──────────────────────────────────────────────────────

export type MeasureFailureReason =
  | "invalid_argument"
  | "exec_failed"
  | "timeout"
  | "metric_missing"
  | "metric_duplicate"
  | "metric_not_finite";

export interface MeasurementRequest {
  /** Directory to run the benchmark in (a clean worktree the caller provides). */
  dir: string;
  /** Metric name from the policy; the parsed METRIC line must match it. */
  metricName: string;
  /** Benchmark command as full argv; at least one non-empty argument. */
  argv: string[];
  /** Timeout for one benchmark run in milliseconds; finite > 0. */
  timeoutMs: number;
}

export type MeasurementResult =
  | { ok: true; value: number; stdout: string }
  | Refusal<MeasureFailureReason>;

const METRIC_LINE_PREFIX = "METRIC";

type ParsedMetric =
  | { ok: true; value: number }
  | {
      ok: false;
      reason: "metric_missing" | "metric_duplicate" | "metric_not_finite";
      message: string;
    };

/**
 * Parse the requested metric from benchmark stdout. Only lines of the form
 * `METRIC <name>=<value>` count; names are matched exactly. Zero matching
 * lines, or more than one, refuse — promotion evidence must be unambiguous.
 */
function parseRequestedMetric(stdout: string, metricName: string): ParsedMetric {
  // Horizontal whitespace only: a newline between tokens would let a METRIC
  // prefix on one line pair with a name=value fragment on the next.
  const re = new RegExp(`^${METRIC_LINE_PREFIX}[ \\t]+([\\w.µ]+)=(\\S+)[ \\t]*$`, "gm");
  let valueToken: string | null = null;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    if (m[1] !== metricName) continue;
    count += 1;
    if (count > 1) break;
    valueToken = m[2];
  }
  if (count === 0) {
    return {
      ok: false,
      reason: "metric_missing",
      message: `no ${quote(`${METRIC_LINE_PREFIX} ${metricName}=<value>`)} line in benchmark output (metric names must match [\\w.µ]+ per the repository METRIC convention)`,
    };
  }
  if (count > 1) {
    return {
      ok: false,
      reason: "metric_duplicate",
      message: `benchmark printed ${count} "${METRIC_LINE_PREFIX} ${metricName}=..." lines; promotion evidence must be unambiguous`,
    };
  }
  // Strict decimal-number token: rejects hex (Number would accept "0x10"),
  // bare separators, and anything with trailing garbage.
  const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!DECIMAL_RE.test(valueToken ?? "")) {
    return {
      ok: false,
      reason: "metric_not_finite",
      message: `${METRIC_LINE_PREFIX} ${metricName}=${quote(valueToken ?? "")} is not a finite decimal number`,
    };
  }
  const value = Number(valueToken);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      reason: "metric_not_finite",
      message: `${METRIC_LINE_PREFIX} ${metricName}=${quote(valueToken ?? "")} is not a finite number`,
    };
  }
  return { ok: true, value };
}

/** Run one benchmark and extract the requested metric value. */
export async function runMeasurement(
  runner: ExecRunner,
  req: MeasurementRequest,
): Promise<MeasurementResult> {
  if (typeof runner !== "function") {
    return refuse("invalid_argument", `"runner" must be a function`);
  }
  if (req === null || typeof req !== "object") {
    return refuse("invalid_argument", `"req" must be an object`);
  }
  const bad = validateDirArgvTimeout(req.dir, req.argv, req.timeoutMs);
  if (bad) return refuse("invalid_argument", bad);
  if (!isNonEmptyString(req.metricName)) {
    return refuse("invalid_argument", `"metricName" must be a non-empty string`);
  }

  let out: ExecOutcome;
  try {
    out = await runner(req.argv, { cwd: req.dir, timeoutMs: req.timeoutMs });
  } catch (err) {
    return refuse("exec_failed", `benchmark failed to run: ${excerpt(errorText(err))}`);
  }
  if (out.killed) {
    return refuse("timeout", `benchmark exceeded the ${req.timeoutMs} ms limit and was killed`);
  }
  if (out.code !== 0) {
    return refuse(
      "exec_failed",
      `benchmark exited with code ${out.code}: ${excerpt(out.stderr || out.stdout)}`,
    );
  }
  const parsed = parseRequestedMetric(out.stdout, req.metricName);
  if (!parsed.ok) return refuse(parsed.reason, parsed.message);
  return { ok: true, value: parsed.value, stdout: out.stdout };
}

// ─── Repeated measurement ────────────────────────────────────────────────────

export interface RepeatedMeasurementRequest extends MeasurementRequest {
  /** Number of measurements; integer >= 1. */
  repeats: number;
  /**
   * Optional total wall-clock budget in milliseconds for all repeats
   * (policy confirm_budget_seconds). Checked before each repeat after the
   * first; one already-started repeat may overshoot it (per-run timeouts
   * are the caller's per-run limit).
   */
  budgetMs?: number;
  /**
   * Injectable clock (Date.now by default) so tests can simulate elapsed
   * time deterministically without real sleeps.
   */
  now?: () => number;
}

export type RepeatedMeasurementResult =
  | { ok: true; values: number[]; average: number }
  | Refusal<MeasureFailureReason | "budget_exhausted">;

/** Run `repeats` identical measurements; refuse on the first failure. */
export async function runRepeatedMeasurement(
  runner: ExecRunner,
  req: RepeatedMeasurementRequest,
): Promise<RepeatedMeasurementResult> {
  if (typeof runner !== "function") {
    return refuse("invalid_argument", `"runner" must be a function`);
  }
  if (req === null || typeof req !== "object") {
    return refuse("invalid_argument", `"req" must be an object`);
  }
  if (!Number.isInteger(req.repeats) || req.repeats < 1) {
    return refuse("invalid_argument", `"repeats" must be an integer >= 1`);
  }
  if (req.budgetMs !== undefined && (!isFiniteNumber(req.budgetMs) || req.budgetMs <= 0)) {
    return refuse("invalid_argument", `"budgetMs" must be a finite number > 0 when provided`);
  }

  const values: number[] = [];
  const now = typeof req.now === "function" ? req.now : Date.now;
  const startedAt = now();
  for (let i = 0; i < req.repeats; i++) {
    if (i > 0 && req.budgetMs !== undefined) {
      const elapsed = now() - startedAt;
      if (elapsed >= req.budgetMs) {
        return refuse(
          "budget_exhausted",
          `confirm budget ${req.budgetMs} ms exhausted after ${i} of ${req.repeats} repeats`,
        );
      }
    }
    const one = await runMeasurement(runner, req);
    if (!one.ok) return one;
    values.push(one.value);
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return { ok: true, values, average: sum / values.length };
}

// ─── Checks ──────────────────────────────────────────────────────────────────

export type CheckFailureReason =
  | "invalid_argument"
  | "exec_failed"
  | "timeout"
  | "checks_failed";

export interface ChecksRequest {
  /** Candidate worktree root to run the checks in (the exact checkpoint). */
  dir: string;
  /** Checks command as full argv; at least one non-empty argument. */
  argv: string[];
  /** Timeout in milliseconds; finite > 0. */
  timeoutMs: number;
}

export type ChecksResult = { ok: true } | Refusal<CheckFailureReason>;

/** Run the checks command; exit 0 is the only success. */
export async function runChecks(
  runner: ExecRunner,
  req: ChecksRequest,
): Promise<ChecksResult> {
  if (typeof runner !== "function") {
    return refuse("invalid_argument", `"runner" must be a function`);
  }
  if (req === null || typeof req !== "object") {
    return refuse("invalid_argument", `"req" must be an object`);
  }
  const bad = validateDirArgvTimeout(req.dir, req.argv, req.timeoutMs);
  if (bad) return refuse("invalid_argument", bad);

  let out: ExecOutcome;
  try {
    out = await runner(req.argv, { cwd: req.dir, timeoutMs: req.timeoutMs });
  } catch (err) {
    return refuse("exec_failed", `checks failed to run: ${excerpt(errorText(err))}`);
  }
  if (out.killed) {
    return refuse("timeout", `checks exceeded the ${req.timeoutMs} ms limit and were killed`);
  }
  if (out.code !== 0) {
    return refuse(
      "checks_failed",
      `checks exited with code ${out.code}: ${excerpt(out.stderr || out.stdout)}`,
    );
  }
  return { ok: true };
}

// ─── Promotion gate ──────────────────────────────────────────────────────────

export type CompareFailureReason =
  | "invalid_argument"
  | "metric_mismatch"
  | "direction_mismatch"
  | "incomparable_context"
  | "methodology_changed"
  | "checkpoint_mismatch"
  | "checks_failed"
  | "checks_error"
  | "gain_below_threshold";

export interface MethodologyHash {
  /** Repo-relative path of the methodology file. */
  path: string;
  /** SHA-256 of the file content (hex string; case preserved). */
  sha256: string;
}

/** Aggregated result of a repeated measurement for one side. */
export interface SideAverage {
  metricName: string;
  direction: PolicyDirection;
  /** Finite arithmetic mean of the repeats. */
  average: number;
}

export interface PromotionChecksConfig {
  argv: string[];
  dir: string;
  timeoutMs: number;
}

export interface PromotionComparisonInput {
  runner: ExecRunner;
  policyMetricName: string;
  policyDirection: PolicyDirection;
  /** Finite >= 0; promotion requires a strictly greater directed gain. */
  policyMinGain: number;
  /** Methodology files pinned by the policy (path + sha256). */
  policyMethodology: readonly MethodologyHash[];
  /** Methodology hashes observed right before the comparison. */
  currentMethodology: readonly MethodologyHash[];
  /** Leader (base) commit; non-empty string. */
  leaderCommit: string;
  /** Candidate checkpoint commit; non-empty string. */
  candidateCommit: string;
  /** Active measurement scale/epoch of the leader; non-empty string. */
  leaderEpoch: string;
  /** Active measurement scale/epoch of the candidate; non-empty string. */
  candidateEpoch: string;
  leaderMeasurement: SideAverage;
  candidateMeasurement: SideAverage;
  checks: PromotionChecksConfig;
}

export type PromotionComparisonResult =
  | { ok: true; gain: number; leaderAverage: number; candidateAverage: number }
  | Refusal<CompareFailureReason>;

function validateSide(sideName: string, side: unknown): string | null {
  if (side === null || typeof side !== "object") {
    return `${sideName} must be an object`;
  }
  const s = side as SideAverage;
  if (!isNonEmptyString(s.metricName)) return `${sideName}.metricName must be a non-empty string`;
  if (s.direction !== "higher" && s.direction !== "lower") {
    return `${sideName}.direction must be "higher" or "lower"`;
  }
  if (!isFiniteNumber(s.average)) return `${sideName}.average must be a finite number`;
  return null;
}

function validateMethodology(list: readonly MethodologyHash[], fieldName: string): string | null {
  if (!Array.isArray(list) || list.length === 0) {
    return `${fieldName} must be a non-empty array`;
  }
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") {
      return `${fieldName} entries must be objects`;
    }
    if (!isNonEmptyString(entry.path)) return `${fieldName} entries need a non-empty "path"`;
    if (!isNonEmptyString(entry.sha256)) return `${fieldName} entries need a non-empty "sha256"`;
    if (seen.has(entry.path)) {
      return `${fieldName} lists ${quote(entry.path)} more than once; duplicate paths would hide an extra unpinned file`;
    }
    seen.add(entry.path);
  }
  return null;
}

/**
 * Exact comparison of policy-pinned methodology hashes against the hashes
 * observed right before the comparison. Same set of paths and identical
 * sha256 strings required; case normalization is the caller's job.
 */
function methodologyUnchanged(
  policyList: readonly MethodologyHash[],
  currentList: readonly MethodologyHash[],
): { unchanged: true } | { unchanged: false; detail: string } {
  if (policyList.length !== currentList.length) {
    return {
      unchanged: false,
      detail: `methodology file set changed: policy lists ${policyList.length} file(s), current lists ${currentList.length}`,
    };
  }
  const currentByPath = new Map<string, string>();
  for (const entry of currentList) currentByPath.set(entry.path, entry.sha256);
  for (const entry of policyList) {
    const actual = currentByPath.get(entry.path);
    if (actual === undefined) {
      return { unchanged: false, detail: `methodology file ${quote(entry.path)} is missing from the current set` };
    }
    if (actual !== entry.sha256) {
      return {
        unchanged: false,
        detail: `methodology file ${quote(entry.path)} changed (policy ${quote(entry.sha256)} vs current ${quote(actual)})`,
      };
    }
  }
  return { unchanged: true };
}

/**
 * The full promotion gate. Every condition below is mandatory, in order:
 * scalar validity → metric match → direction match → equal epochs →
 * unchanged methodology → successful checks for the exact candidate
 * checkpoint → directed gain strictly greater than min_gain. On success
 * the caller may attempt promoteLeader with the returned values.
 */
export async function compareForPromotion(
  input: PromotionComparisonInput,
): Promise<PromotionComparisonResult> {
  if (input === null || typeof input !== "object") {
    return refuse("invalid_argument", `"input" must be an object`);
  }
  const i = input as PromotionComparisonInput;
  if (typeof i.runner !== "function") return refuse("invalid_argument", `"runner" must be a function`);
  if (!isNonEmptyString(i.policyMetricName)) {
    return refuse("invalid_argument", `"policyMetricName" must be a non-empty string`);
  }
  if (i.policyDirection !== "higher" && i.policyDirection !== "lower") {
    return refuse("invalid_argument", `"policyDirection" must be "higher" or "lower"`);
  }
  if (!isFiniteNumber(i.policyMinGain) || i.policyMinGain < 0) {
    return refuse("invalid_argument", `"policyMinGain" must be a finite number >= 0`);
  }
  if (!isNonEmptyString(i.leaderCommit)) return refuse("invalid_argument", `"leaderCommit" must be a non-empty string`);
  if (!isNonEmptyString(i.candidateCommit)) return refuse("invalid_argument", `"candidateCommit" must be a non-empty string`);
  if (!isNonEmptyString(i.leaderEpoch)) return refuse("invalid_argument", `"leaderEpoch" must be a non-empty string`);
  if (!isNonEmptyString(i.candidateEpoch)) return refuse("invalid_argument", `"candidateEpoch" must be a non-empty string`);
  const methodologyBad =
    validateMethodology(i.policyMethodology, "policyMethodology") ??
    validateMethodology(i.currentMethodology, "currentMethodology");
  if (methodologyBad) return refuse("invalid_argument", methodologyBad);
  const leaderBad = validateSide("leaderMeasurement", i.leaderMeasurement);
  if (leaderBad) return refuse("invalid_argument", leaderBad);
  const candidateBad = validateSide("candidateMeasurement", i.candidateMeasurement);
  if (candidateBad) return refuse("invalid_argument", candidateBad);
  if (i.checks === null || typeof i.checks !== "object") {
    return refuse("invalid_argument", `"checks" must be an object`);
  }
  const checksBad = validateDirArgvTimeout(i.checks.dir, i.checks.argv, i.checks.timeoutMs);
  if (checksBad) {
    return refuse("invalid_argument", checksBad.replace(/^"([a-zA-Z]+)"/, "checks.$1"));
  }

  if (i.leaderMeasurement.metricName !== i.policyMetricName) {
    return refuse(
      "metric_mismatch",
      `leader measurement is for metric ${quote(i.leaderMeasurement.metricName)} but the policy metric is ${quote(i.policyMetricName)}`,
    );
  }
  if (i.candidateMeasurement.metricName !== i.policyMetricName) {
    return refuse(
      "metric_mismatch",
      `candidate measurement is for metric ${quote(i.candidateMeasurement.metricName)} but the policy metric is ${quote(i.policyMetricName)}`,
    );
  }
  if (i.leaderMeasurement.direction !== i.policyDirection) {
    return refuse(
      "direction_mismatch",
      `leader measurement direction is ${quote(i.leaderMeasurement.direction)} but the policy direction is ${quote(i.policyDirection)}`,
    );
  }
  if (i.candidateMeasurement.direction !== i.policyDirection) {
    return refuse(
      "direction_mismatch",
      `candidate measurement direction is ${quote(i.candidateMeasurement.direction)} but the policy direction is ${quote(i.policyDirection)}`,
    );
  }
  if (i.leaderEpoch !== i.candidateEpoch) {
    return refuse(
      "incomparable_context",
      `leader epoch ${quote(i.leaderEpoch)} does not match candidate epoch ${quote(i.candidateEpoch)}`,
    );
  }
  const meth = methodologyUnchanged(i.policyMethodology, i.currentMethodology);
  if (!meth.unchanged) return refuse("methodology_changed", meth.detail);

  // Prove the checks worktree HEAD is exactly the candidate checkpoint
  // (design §3: checks run for the exact checkpoint). Read-only rev-parse;
  // any mismatch, non-zero exit or throw refuses before checks run.
  let head: ExecOutcome;
  try {
    head = await i.runner(["git", "rev-parse", "--verify", "HEAD"], { cwd: i.checks.dir, timeoutMs: 15000 });
  } catch (err) {
    return refuse(
      "checkpoint_mismatch",
      `could not verify the candidate checkpoint (rev-parse failed: ${excerpt(errorText(err))}); checks were not run`,
    );
  }
  if (head.killed) {
    return refuse(
      "checkpoint_mismatch",
      `could not verify the candidate checkpoint (rev-parse was killed before answering); checks were not run`,
    );
  }
  const headSha = head.stdout.trim();
  if (head.code !== 0 || headSha !== i.candidateCommit) {
    return refuse(
      "checkpoint_mismatch",
      `checks worktree HEAD ${quote(headSha || "(empty)")} does not match the candidate checkpoint ${quote(i.candidateCommit)} (exit ${head.code}); checks were not run`,
    );
  }

  const checks = await runChecks(i.runner, {
    dir: i.checks.dir,
    argv: i.checks.argv,
    timeoutMs: i.checks.timeoutMs,
  });
  if (!checks.ok) {
    if (checks.reason === "checks_failed") return checks;
    return refuse(
      "checks_error",
      `checks did not produce a verdict (${checks.reason}): ${checks.message}`,
    );
  }

  const directedGain =
    i.policyDirection === "higher"
      ? i.candidateMeasurement.average - i.leaderMeasurement.average
      : i.leaderMeasurement.average - i.candidateMeasurement.average;
  // Design §3: promote only when the directed gain is STRICTLY greater than
  // min_gain. Float subtraction can overshoot a decimal-exact equality
  // (1.1 - 1.0 === 0.10000000000000009, and at magnitudes >= 1e3 the error
  // exceeds 12 significant digits, so rounding the gain cannot help). Instead
  // the comparison tolerates representation noise scaled to the operands:
  // the gain must exceed min_gain by more than a few ULPs of the subtraction
  // inputs (plus a few ULPs of min_gain itself). A decimal-exact equality
  // differs from the threshold by less than one ULP of the operands, so it
  // refuses; a genuine gain larger than that tolerance still promotes.
  const gainEpsilon =
    ulpOf(Math.abs(i.leaderMeasurement.average)) +
    ulpOf(Math.abs(i.candidateMeasurement.average)) +
    ulpOf(i.policyMinGain);
  const tolerance = gainEpsilon * 4;
  if (!(directedGain > i.policyMinGain + tolerance)) {
    return refuse(
      "gain_below_threshold",
      `directed gain ${directedGain} is not greater than min_gain ${i.policyMinGain}`,
    );
  }
  return {
    ok: true,
    gain: directedGain,
    leaderAverage: i.leaderMeasurement.average,
    candidateAverage: i.candidateMeasurement.average,
  };
}

// ─── CAS leader promotion ────────────────────────────────────────────────────

export type PromoteFailureReason = "invalid_argument" | "leader_moved" | "uncertain" | "update_failed";

export interface PromotionRequest {
  /** Directory of the campaign repository (passed as the runner cwd). */
  repoDir: string;
  /** Full ref name of the campaign leader, e.g. refs/pi-autoresearch/leader. */
  leaderRef: string;
  /** Expected current leader sha (compare-and-swap old value). */
  expectedSha: string;
  /** Candidate checkpoint commit to promote. */
  newSha: string;
}

export type PromotionResult =
  | { ok: true; promoted: true; from: string; to: string }
  | Refusal<PromoteFailureReason>;

const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Conservative Git ref-name check for the value we pass to update-ref. */
function isValidRefName(ref: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(ref)) return false; // printable ASCII, no spaces
  if (ref.startsWith("-") || ref.startsWith("/")) return false;
  if (ref.endsWith("/") || ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("@{")) return false;
  if (!ref.includes("/")) return false;
  if (ref.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return true;
}

/**
 * Promote the leader ref with compare-and-swap:
 * `git update-ref <leaderRef> <newSha> <expectedSha>`.
 * The user's branches are never touched; no checkout, no reset, nothing
 * but this single update-ref. On CAS mismatch (git "is at ... but
 * expected ...") the refusal is leader_moved; any other failure is
 * update_failed; the ref is left unchanged in both cases. When the
 * outcome is unknown the refusal is uncertain and requires manual
 * verification of the ref.
 */
export async function promoteLeader(
  runner: ExecRunner,
  req: PromotionRequest,
): Promise<PromotionResult> {
  if (typeof runner !== "function") {
    return refuse("invalid_argument", `"runner" must be a function`);
  }
  if (req === null || typeof req !== "object") {
    return refuse("invalid_argument", `"req" must be an object`);
  }
  if (!isNonEmptyString(req.repoDir)) return refuse("invalid_argument", `"repoDir" must be a non-empty string`);
  if (!isNonEmptyString(req.leaderRef) || !isValidRefName(req.leaderRef)) {
    return refuse("invalid_argument", `"leaderRef" must be a valid full Git ref name`);
  }
  if (!isNonEmptyString(req.expectedSha) || !GIT_SHA_RE.test(req.expectedSha)) {
    return refuse("invalid_argument", `"expectedSha" must be a 40- or 64-char hex commit sha`);
  }
  if (!isNonEmptyString(req.newSha) || !GIT_SHA_RE.test(req.newSha)) {
    return refuse("invalid_argument", `"newSha" must be a 40- or 64-char hex commit sha`);
  }

  let out: ExecOutcome;
  try {
    out = await runner(
      ["git", "update-ref", req.leaderRef, req.newSha, req.expectedSha],
      { cwd: req.repoDir, timeoutMs: 15000 },
    );
  } catch (err) {
    return refuse(
      "uncertain",
      `git update-ref could not be executed (${excerpt(errorText(err))}); the leader may or may not have moved — verify the leader ref manually before further operations`,
    );
  }
  if (out.killed) {
    return refuse(
      "uncertain",
      `git update-ref timed out after 15000 ms; the leader may or may not have moved — verify the leader ref manually before further operations`,
    );
  }
  if (out.code !== 0) {
    // Only the git CAS-mismatch wording means the leader actually moved;
    // every other non-zero exit (not a repo, bad ref name, ...) is a
    // plain update failure. In both cases the ref is left unchanged.
    const output = `${out.stderr}\n${out.stdout}`;
    if (/is at \S+ but expected \S+/.test(output)) {
      return refuse(
        "leader_moved",
        `compare-and-swap failed (exit ${out.code}): ${excerpt(out.stderr || out.stdout)}; the leader ref was left unchanged`,
      );
    }
    return refuse(
      "update_failed",
      `git update-ref failed (exit ${out.code}): ${excerpt(out.stderr || out.stdout)}; the leader ref was left unchanged`,
    );
  }
  return { ok: true, promoted: true, from: req.expectedSha, to: req.newSha };
}
