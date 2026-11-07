/**
 * candidate-policy.ts — standalone validation and explicit human consent for
 * candidate-branch campaign policy.
 *
 * Scope: openspec/changes/candidate-branches design.md §2 step 1 and §3;
 * epic pi-autoresearch-3e4.4.1, task pi-autoresearch-3e4.4.1.1.
 *
 * Deliberately standalone (no campaign state, no worktree/Git access, no
 * measurement): later tasks integrate this module behind the candidate
 * tool. Nothing here touches the filesystem — proposed SHA-256 hashes are
 * validated for shape only; verifying them against disk is integration work.
 *
 * What this module guarantees:
 *   - validateCandidatePolicy: the proposed policy must be a complete,
 *     exactly-shaped set of fields. Missing values are never silently
 *     substituted, unknown fields are rejected (not ignored), numbers must
 *     be finite, time/budget limits must be positive, counts must be
 *     integers >= 1, both command argvs (benchmark and checks) must contain
 *     at least one non-empty argument (design §3: promotion requires
 *     successful checks for the exact checkpoint, so an empty checks_argv
 *     would leave checkpoint exactness unverified), and methodology files
 *     must never appear in the candidate's editable set (design §3:
 *     methodology files are not modified by the candidate).
 *   - formatCandidatePolicy: a full human-readable summary of every field,
 *     shown to the user before they decide.
 *   - confirmCandidatePolicy / requestCandidatePolicyConsent: explicit
 *     confirmation by the real user through the passed-in UI dialog.
 *
 * Consent rules (design §2: "Модель не может заменить подтверждение
 * аргументом"; requirements FR-15):
 *   - There is intentionally NO boolean/flag parameter anywhere in this
 *     API. An agent-supplied argument can never count as consent; unknown
 *     fields such as "confirmed: true" in the raw proposal are rejected.
 *   - Only a literal `true` resolved from the passed-in UI dialog is
 *     consent.
 *   - Missing UI, missing confirm dialog, refusal (false), a thrown or
 *     rejected UI error, cancellation, and any non-boolean answer
 *     (including truthy strings like "yes") all block: the caller receives
 *     ok:false and must not start the campaign.
 */

// ─── Policy shape ────────────────────────────────────────────────────────────

export type PolicyDirection = "higher" | "lower";

export interface MethodologyFileRef {
  /** Repo-relative path of the pinned methodology file. */
  path: string;
  /** SHA-256 of the file content at proposal time (64 hex chars). */
  sha256: string;
}

export interface CandidatePolicy {
  /** Metric being optimized, as agreed with the user. */
  metric_name: string;
  /** Which direction is an improvement. */
  direction: PolicyDirection;
  /** Measurements per side per comparison; integer >= 1. */
  repeats: number;
  /** Minimum directed gain required for promotion; finite >= 0. */
  min_gain: number;
  /** Benchmark command; at least one non-empty argument. */
  benchmark_argv: string[];
  /** Checks command; at least one non-empty argument — promotion requires
   *  successful checks for the exact checkpoint (design §3), so an empty
   *  checks_argv is rejected, not treated as "no checks". */
  checks_argv: string[];
  /** Timeout for one benchmark run; finite > 0. */
  benchmark_timeout_seconds: number;
  /** Total budget for the confirmation re-measurement; finite > 0. */
  confirm_budget_seconds: number;
  /** Step limit for the candidate; integer >= 1. */
  candidate_step_limit: number;
  /** Wall-clock limit for the candidate; finite > 0. */
  candidate_time_limit_seconds: number;
  /** Methodology files pinned by path + SHA-256; at least one. */
  methodology_files: MethodologyFileRef[];
  /** Files the candidate is allowed to change; at least one, unique. */
  change_files: string[];
}

const KNOWN_POLICY_KEYS: readonly string[] = [
  "metric_name",
  "direction",
  "repeats",
  "min_gain",
  "benchmark_argv",
  "checks_argv",
  "benchmark_timeout_seconds",
  "confirm_budget_seconds",
  "candidate_step_limit",
  "candidate_time_limit_seconds",
  "methodology_files",
  "change_files",
];

const SHA256_RE = /^[0-9a-f]{64}$/i;

// ─── Validation ──────────────────────────────────────────────────────────────

export interface PolicyValidationResult {
  ok: boolean;
  /** The validated, frozen policy. Present only when ok is true. */
  policy?: CandidatePolicy;
  /** All problems found; every error names the offending field. */
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "string") {
    const s = v.length > 40 ? v.slice(0, 40) + "…" : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return typeof v;
}

/**
 * Escape control characters (LF, CR, ESC, …) into visible backslash escapes
 * so a message stays an honest single line: a LF inside e.g. a UI error
 * message must never forge additional lines in a one-line diagnostic.
 */
function escapeControlChars(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    switch (ch) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      case "\b": return "\\b";
      case "\f": return "\\f";
      default:
        return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    }
  });
}

/**
 * Validate a proposed candidate policy against the full required field set.
 * Collects every problem into `errors` (field-naming messages) instead of
 * failing on the first one, and never substitutes defaults for missing
 * values. The returned policy is deeply frozen: the policy is immutable for
 * the whole campaign (design §3).
 */
export function validateCandidatePolicy(raw: unknown): PolicyValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        `policy must be an object with named fields, got ${describeValue(raw)}`,
      ],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_POLICY_KEYS.includes(key)) {
      errors.push(
        `unknown field ${JSON.stringify(key)}: the policy is a fixed field set; extra fields (including any agent-supplied consent flag) are rejected, not ignored`,
      );
    }
  }

  const missing = (field: string) =>
    errors.push(
      `"${field}" is required; a missing value is never silently substituted`,
    );

  // metric_name
  const metricName = raw.metric_name;
  if (metricName === undefined) {
    missing("metric_name");
  } else if (typeof metricName !== "string" || metricName.trim().length === 0) {
    errors.push(
      `"metric_name" must be a non-empty string, got ${describeValue(metricName)}`,
    );
  }

  // direction
  const direction = raw.direction;
  if (direction === undefined) {
    missing("direction");
  } else if (direction !== "higher" && direction !== "lower") {
    errors.push(
      `"direction" must be exactly "higher" or "lower", got ${describeValue(direction)}`,
    );
  }

  // repeats: integer >= 1
  const repeats = raw.repeats;
  if (repeats === undefined) {
    missing("repeats");
  } else if (
    !isFiniteNumber(repeats) ||
    !Number.isInteger(repeats) ||
    repeats < 1
  ) {
    errors.push(
      `"repeats" must be an integer >= 1, got ${describeValue(repeats)}`,
    );
  }

  // min_gain: finite >= 0
  const minGain = raw.min_gain;
  if (minGain === undefined) {
    missing("min_gain");
  } else if (!isFiniteNumber(minGain) || minGain < 0) {
    errors.push(
      `"min_gain" must be a finite number >= 0, got ${describeValue(minGain)}`,
    );
  }

  const benchmarkArgv = validateStringList(raw, "benchmark_argv", errors, {
    minItems: 1,
    unique: false,
  });
  // checks_argv is mandatory: a successful checks run is required for the
  // exact checkpoint before promotion (design §3).
  const checksArgv = validateStringList(raw, "checks_argv", errors, {
    minItems: 1,
    unique: false,
  });

  const benchmarkTimeout = validatePositiveLimit(
    raw,
    "benchmark_timeout_seconds",
    errors,
  );
  const confirmBudget = validatePositiveLimit(
    raw,
    "confirm_budget_seconds",
    errors,
  );
  const candidateTimeLimit = validatePositiveLimit(
    raw,
    "candidate_time_limit_seconds",
    errors,
  );

  // candidate_step_limit: integer >= 1
  const stepLimit = raw.candidate_step_limit;
  if (stepLimit === undefined) {
    missing("candidate_step_limit");
  } else if (
    !isFiniteNumber(stepLimit) ||
    !Number.isInteger(stepLimit) ||
    stepLimit < 1
  ) {
    errors.push(
      `"candidate_step_limit" must be an integer >= 1, got ${describeValue(stepLimit)}`,
    );
  }

  const methodologyFiles = validateMethodologyFiles(raw, errors);
  const changeFiles = validateStringList(raw, "change_files", errors, {
    minItems: 1,
    unique: true,
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Cross-field: the candidate must never be able to edit methodology files
  // (design §3: "Файлы методики не изменяются кандидатом").
  // Compare in one spelling: a backslash path (src\\method.md) names the same
  // file as src/method.md and must not slip past the methodology guard.
  const slash = (p: string): string => p.replace(/\\/g, "/");
  const methodologyPaths = new Set(methodologyFiles.map((f) => slash(f.path)));
  for (const p of changeFiles) {
    if (methodologyPaths.has(slash(p))) {
      errors.push(
        `"change_files" must not contain methodology file ${JSON.stringify(p)}: methodology files are not modified by the candidate`,
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Explicit construction — never a spread of `raw`, so no unvalidated key
  // can leak into the policy.
  const policy: CandidatePolicy = {
    metric_name: metricName as string,
    direction: direction as PolicyDirection,
    repeats: repeats as number,
    min_gain: minGain as number,
    benchmark_argv: (benchmarkArgv as string[]).slice(),
    checks_argv: (checksArgv as string[]).slice(),
    benchmark_timeout_seconds: benchmarkTimeout as number,
    confirm_budget_seconds: confirmBudget as number,
    candidate_step_limit: stepLimit as number,
    candidate_time_limit_seconds: candidateTimeLimit as number,
    methodology_files: methodologyFiles.map((f) => ({
      path: f.path,
      sha256: f.sha256,
    })),
    change_files: (changeFiles as string[]).slice(),
  };
  return { ok: true, policy: deepFreezePolicy(policy), errors: [] };
}

function validateStringList(
  raw: Record<string, unknown>,
  field: string,
  errors: string[],
  opts: { minItems: number; unique: boolean },
): string[] | undefined {
  const value = raw[field];
  if (value === undefined) {
    errors.push(
      `"${field}" is required; a missing value is never silently substituted`,
    );
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push(
      `"${field}" must be an array of strings, got ${describeValue(value)}`,
    );
    return undefined;
  }
  if (value.length < opts.minItems) {
    errors.push(
      `"${field}" must contain at least ${opts.minItems} entr${opts.minItems === 1 ? "y" : "ies"}, got ${value.length}`,
    );
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(
        `"${field}[${i}]" must be a non-empty string, got ${describeValue(item)}`,
      );
      return undefined;
    }
    if (opts.unique) {
      if (seen.has(item)) {
        errors.push(
          `"${field}" contains duplicate entry ${JSON.stringify(item)}`,
        );
        return undefined;
      }
      seen.add(item);
    }
    out.push(item);
  }
  return out;
}

function validatePositiveLimit(
  raw: Record<string, unknown>,
  field: string,
  errors: string[],
): number | undefined {
  const value = raw[field];
  if (value === undefined) {
    errors.push(
      `"${field}" is required; a missing value is never silently substituted`,
    );
    return undefined;
  }
  if (!isFiniteNumber(value) || value <= 0) {
    errors.push(
      `"${field}" must be a finite number > 0, got ${describeValue(value)}`,
    );
    return undefined;
  }
  return value;
}

function validateMethodologyFiles(
  raw: Record<string, unknown>,
  errors: string[],
): MethodologyFileRef[] {
  const value = raw.methodology_files;
  if (value === undefined) {
    errors.push(
      `"methodology_files" is required; a missing value is never silently substituted`,
    );
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(
      `"methodology_files" must be an array of {path, sha256}, got ${describeValue(value)}`,
    );
    return [];
  }
  if (value.length === 0) {
    errors.push(
      `"methodology_files" must list at least one pinned file; an empty list would leave the mandatory methodology unpinned`,
    );
    return [];
  }
  const seenPaths = new Set<string>();
  const out: MethodologyFileRef[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      errors.push(
        `"methodology_files[${i}]" must be an object {path, sha256}, got ${describeValue(entry)}`,
      );
      return [];
    }
    for (const key of Object.keys(entry)) {
      if (key !== "path" && key !== "sha256") {
        errors.push(
          `"methodology_files[${i}]": unknown field ${JSON.stringify(key)}; entries have exactly "path" and "sha256"`,
        );
      }
    }
    const path = entry.path;
    if (path === undefined) {
      errors.push(
        `"methodology_files[${i}].path" is required; a missing value is never silently substituted`,
      );
    } else if (typeof path !== "string" || path.trim().length === 0) {
      errors.push(
        `"methodology_files[${i}].path" must be a non-empty string, got ${describeValue(path)}`,
      );
    }
    const sha = entry.sha256;
    if (sha === undefined) {
      errors.push(
        `"methodology_files[${i}].sha256" is required; a missing value is never silently substituted`,
      );
    } else if (typeof sha !== "string" || !SHA256_RE.test(sha)) {
      errors.push(
        `"methodology_files[${i}].sha256" must be a 64-char hex SHA-256 string, got ${describeValue(sha)}`,
      );
    }
    if (typeof path === "string" && path.trim().length > 0) {
      if (seenPaths.has(path)) {
        errors.push(
          `"methodology_files" contains duplicate path ${JSON.stringify(path)}`,
        );
        return [];
      }
      seenPaths.add(path);
    }
    if (
      typeof path === "string" &&
      typeof sha === "string" &&
      SHA256_RE.test(sha)
    ) {
      out.push({ path, sha256: sha });
    }
  }
  return out;
}

function deepFreezePolicy(policy: CandidatePolicy): CandidatePolicy {
  Object.freeze(policy.benchmark_argv);
  Object.freeze(policy.checks_argv);
  Object.freeze(policy.change_files);
  for (const f of policy.methodology_files) Object.freeze(f);
  Object.freeze(policy.methodology_files);
  return Object.freeze(policy);
}

// ─── Display ─────────────────────────────────────────────────────────────────

/**
 * Full human-readable summary of every policy field. This exact text is what
 * the user sees in the confirmation dialog — the user confirms a complete
 * parameter set, never a partial one (design §2 step 1, §3).
 *
 * Every user-controlled string value (metric_name, every argv element, every
 * methodology path, every change file) is JSON-quoted individually, so LF/CR
 * or other control characters inside a value render as visible escapes
 * instead of being injected literally into the dialog text: the policy is
 * always displayed on exactly its own field lines, with no forged extra
 * lines, and any value can be recovered exactly by JSON.parse-ing its quoted
 * rendering.
 */
export function formatCandidatePolicy(policy: CandidatePolicy): string {
  // Quote each displayed string individually (JSON.stringify per value) and
  // join with ", ". Quoting the whole array and then replacing commas would
  // distort values that themselves contain commas ("a,b" displayed as
  // "a, b"), and per-value JSON escaping keeps control characters (newlines,
  // tabs, quotes, backslashes) visible as escapes instead of being injected
  // as raw control characters into the dialog text.
  const prettyArgv = (argv: string[]): string =>
    `[${argv.map((value) => JSON.stringify(value)).join(", ")}]`;
  const lines = [
    `metric_name: ${JSON.stringify(policy.metric_name)}`,
    `direction: ${policy.direction}`,
    `repeats: ${policy.repeats}`,
    `min_gain: ${policy.min_gain}`,
    `benchmark_argv: ${prettyArgv(policy.benchmark_argv)}`,
    `checks_argv: ${prettyArgv(policy.checks_argv)}`,
    `benchmark_timeout_seconds: ${policy.benchmark_timeout_seconds}`,
    `confirm_budget_seconds: ${policy.confirm_budget_seconds}`,
    `candidate_step_limit: ${policy.candidate_step_limit}`,
    `candidate_time_limit_seconds: ${policy.candidate_time_limit_seconds}`,
    `methodology_files:`,
    ...policy.methodology_files.map(
      (f) => `  - ${JSON.stringify(f.path)} (sha256: ${f.sha256})`,
    ),
    `change_files: ${prettyArgv(policy.change_files)}`,
  ];
  return lines.join("\n");
}

// ─── Consent ─────────────────────────────────────────────────────────────────

/**
 * Duck-typed UI context, matching pi's ExtensionUIContext dialogs as used in
 * parallel/config-ui.ts. `confirm` is mandatory: without a real dialog there
 * is no consent path at all.
 */
export interface PolicyUIContext {
  confirm(title: string, message: string): Promise<boolean>;
}

export type PolicyConsentResult =
  | { ok: true; policy: CandidatePolicy }
  | {
      ok: false;
      /** Which stage blocked: shaping the policy, or the human dialog. */
      stage: "validation" | "consent";
      /** Single-line reason, safe to show to the user. */
      reason: string;
      /** Field-level problems (validation stage only, otherwise empty). */
      errors: string[];
    };

const CONSENT_TITLE =
  "Candidate-branch campaign policy — explicit human confirmation required";

const CONSENT_QUESTION = [
  "",
  "Do you confirm this exact policy for the candidate campaign?",
  "The policy is immutable for the whole campaign; a changed policy means a new campaign.",
  "Only an explicit confirmation in this dialog enables the mode.",
  "Refusal, cancellation, a closed dialog or an error blocks the campaign.",
].join("\n");

/**
 * Ask the real user, through the passed-in UI, to confirm an already-shaped
 * candidate policy. This is the only consent path in the API: there is no
 * flag parameter, and a policy object carrying extra fields (e.g. an
 * agent-supplied "confirmed") is re-validated here and blocked before the
 * dialog opens.
 *
 * Blocking outcomes (ok:false): missing UI or confirm method, UI error or
 * rejection, refusal (false), cancellation or any non-boolean answer —
 * including truthy strings like "yes"; nothing is coerced.
 */
export async function confirmCandidatePolicy(
  ui: PolicyUIContext | null | undefined,
  policy: CandidatePolicy,
): Promise<PolicyConsentResult> {
  // Defense in depth: never show a dialog about an object that is not a
  // valid complete policy.
  const validation = validateCandidatePolicy(policy);
  if (!validation.ok || !validation.policy) {
    return {
      ok: false,
      stage: "validation",
      reason: `candidate policy invalid (${validation.errors.length} problem(s)); the user was not asked`,
      errors: validation.errors,
    };
  }

  if (!ui || typeof ui.confirm !== "function") {
    return {
      ok: false,
      stage: "consent",
      reason:
        "no interactive UI with a confirm dialog is available — explicit human confirmation is required and cannot be substituted; the campaign does not start",
      errors: [],
    };
  }

  const message = formatCandidatePolicy(validation.policy) + CONSENT_QUESTION;

  let answer: unknown;
  try {
    answer = await ui.confirm(CONSENT_TITLE, message);
  } catch (err) {
    // The reason is documented as single-line; a LF or CR inside a UI error
    // message must not forge additional lines in it.
    const detail =
      err instanceof Error
        ? escapeControlChars(err.message)
        : describeValue(err);
    return {
      ok: false,
      stage: "consent",
      reason: `UI confirm dialog failed (${detail}) — the campaign does not start`,
      errors: [],
    };
  }

  if (answer === true) {
    return { ok: true, policy: validation.policy };
  }
  if (answer === false) {
    return {
      ok: false,
      stage: "consent",
      reason:
        "user refused the candidate policy — the campaign does not start",
      errors: [],
    };
  }
  return {
    ok: false,
    stage: "consent",
    reason: `UI confirm returned a non-boolean answer (${describeValue(answer)}) — treated as cancelled, nothing is coerced; the campaign does not start`,
    errors: [],
  };
}

/**
 * Combined entry point for later integration: validate the raw proposed
 * policy, then ask the real user to confirm it via the passed-in UI.
 * Validation failures block before the user is asked; every consent-failure
 * rule of confirmCandidatePolicy applies. An agent cannot consent by
 * argument — there is no consent parameter at all.
 */
export async function requestCandidatePolicyConsent(
  ui: PolicyUIContext | null | undefined,
  raw: unknown,
): Promise<PolicyConsentResult> {
  const validation = validateCandidatePolicy(raw);
  if (!validation.ok || !validation.policy) {
    return {
      ok: false,
      stage: "validation",
      reason: `candidate policy invalid (${validation.errors.length} problem(s)); the user was not asked`,
      errors: validation.errors,
    };
  }
  return confirmCandidatePolicy(ui, validation.policy);
}
