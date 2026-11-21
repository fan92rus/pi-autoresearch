/**
 * bugfix-mode: portable scoring core for the reusable defect-hunting loop.
 *
 * This module deliberately contains no campaign paths, no test baseline and no
 * file IO. Everything that belongs to a project arrives through BugfixConfig;
 * everything that belongs to an experiment arrives through evidence/decisions.
 * The CLI in bugfix-measure.ts and the tool in bugfix-mode-tool.ts own IO.
 */

export const BUGFIX_METRIC_VERSION = "bugfix_score_v2";
export const BUGFIX_METRIC_UNIT = "score";
export const BUGFIX_METRIC_DIRECTION = "higher";

/** Weights and penalties of this metric version. Changing them requires a new version. */
/** Legacy v1 weights, kept only so the version bump is explicit and reviewable. */
export const V1 = Object.freeze({
  severity: Object.freeze({ P1: 1, P2: 0.7, P3: 0.3 }),
  reward: 10,
  decay: 0.35,
  regression: 1,
  newRegressionPenalty: 5,
  lineBudget: 200,
  linePenalty: 0.05,
  scorerPenalty: 20,
  invalidProofPenalty: 10,
  testGain: 0.02,
});

/** v2: discovery pays immediately, fix pays twice as much, tests must detect or lock behaviour. */
export const V2 = Object.freeze({
  severity: V1.severity,
  decay: V1.decay,
  regression: V1.regression,
  newRegressionPenalty: V1.newRegressionPenalty,
  lineBudget: V1.lineBudget,
  linePenalty: V1.linePenalty,
  scorerPenalty: V1.scorerPenalty,
  invalidProofPenalty: V1.invalidProofPenalty,
  discoveryPoints: 10 / 3,
  fixPoints: 20 / 3,
  testBonus: 0.1,
  testCap: 3,
});

export interface BugfixConfig {
  campaignId: string;
  name: string;
  testCommand: string;
  /** Template with {test}; used to execute each claimed test id in isolation. */
  testIdCommand: string;
  proofCommands: { good: string; defect: string; fixed: string; counterfactual: string };
  scopePaths: string[];
  baseRef: string;
  baselineFail: number;
  baselineTests: number;
}

const CONFIG_KEYS: readonly string[] = [
  "campaignId", "name", "testCommand", "testIdCommand", "proofCommands", "scopePaths",
  "baseRef", "baselineFail", "baselineTests",
];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return `${field}: expected a non-empty string`;
  if (/[\r\n]/.test(value)) return `${field}: line breaks are not allowed`;
  return null;
}

export function isSafeCampaignId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

/** Strict project parameters: nothing is inherited from a previous campaign. */
export function validateBugfixConfig(raw: unknown): ValidationResult<BugfixConfig> {
  if (!isRecord(raw)) return { ok: false, error: "config: expected an object" };
  const unknownKeys = Object.keys(raw).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknownKeys.length > 0) return { ok: false, error: `config: unknown fields ${unknownKeys.join(", ")}` };

  for (const field of ["campaignId", "name", "testCommand", "testIdCommand", "baseRef"] as const) {
    const problem = nonEmptyString(raw[field], field);
    if (problem) return { ok: false, error: problem };
  }
  if (!raw.testIdCommand.includes("{test}")) {
    return { ok: false, error: "testIdCommand: expected a command template containing {test}" };
  }
  if (!isSafeCampaignId(raw.campaignId)) {
    return { ok: false, error: "campaignId: expected 1-64 characters from [A-Za-z0-9._-]" };
  }

  const proofCommands = raw.proofCommands;
  if (!isRecord(proofCommands) || !PROOF_COMMANDS.every((name) =>
    nonEmptyString((proofCommands as Record<string, unknown>)[name], `proofCommands.${name}`) === null,
  )) {
    return { ok: false, error: "proofCommands: expected good/defect/fixed/counterfactual commands" };
  }

  const scopePaths = raw.scopePaths;
  if (!Array.isArray(scopePaths) || scopePaths.length === 0) {
    return { ok: false, error: "scopePaths: expected a non-empty array" };
  }
  for (const entry of scopePaths) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false, error: "scopePaths: expected non-empty relative paths" };
    }
    if (pathIsAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      return { ok: false, error: `scopePaths: absolute paths and '..' are not allowed (${entry})` };
    }
  }

  for (const field of ["baselineFail", "baselineTests"] as const) {
    const value = raw[field];
    if (!Number.isInteger(value) || (value as number) < 0) {
      return { ok: false, error: `${field}: expected a non-negative integer` };
    }
  }

  return {
    ok: true,
    value: {
      campaignId: raw.campaignId as string,
      name: raw.name as string,
      testCommand: raw.testCommand as string,
      testIdCommand: raw.testIdCommand as string,
      proofCommands: proofCommands as BugfixConfig["proofCommands"],
      scopePaths: scopePaths as string[],
      baseRef: raw.baseRef as string,
      baselineFail: raw.baselineFail as number,
      baselineTests: raw.baselineTests as number,
    },
  };
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export interface TestSummary {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}

/** Strict TAP summary parsing. An unreadable suite result is NOT a clean suite. */
export function parseTestSummary(output: string): ValidationResult<TestSummary> {
  if (typeof output !== "string") return { ok: false, error: "test output: expected a string" };
  const last = (label: string): number | null => {
    const pattern = new RegExp(`^#\\s+${label}\\s+(\\d+)\\s*$`, "gm");
    let found: number | null = null;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) found = Number(match[1]);
    return found;
  };
  const tests = last("tests");
  const pass = last("pass");
  const fail = last("fail");
  const skipped = last("skipped") ?? 0;
  if (tests === null || pass === null || fail === null) {
    return { ok: false, error: `test output: missing TAP summary (# tests/# pass/# fail); got ${output.length} chars` };
  }
  if (pass + fail + skipped !== tests) {
    return { ok: false, error: `test output: inconsistent TAP totals (${pass}+${fail}+${skipped} != ${tests})` };
  }
  return { ok: true, value: { tests, pass, fail, skipped } };
}

export type CheckName = "good" | "defect" | "fixed" | "counterfactual";
export type EvidencePhase = "discover" | "proof";

export interface ProofCheck {
  name: CheckName;
  command: string;
  exitCode: number;
  output: string;
  killed?: boolean;
}

export type Severity = "P1" | "P2" | "P3";

export interface EvidenceRecord {
  kind: "evidence";
  experimentId: string;
  defectId: string;
  severity: Severity;
  /** Missing phase means the original three-check proof. */
  phase?: EvidencePhase;
  stateIds: { defect: string; good?: string; fixed?: string; counterfactual?: string };
  checks: ProofCheck[];
  /** Tests whose failure revealed the defect (discovery) or lock in the fix (proof). */
  detectorTests?: string[];
  proofTests?: string[];
  testChecks?: TestCheck[];
}

export interface TestCheck {
  name: string;
  testId: string;
  command: string;
  exitCode: number;
  output: string;
  killed?: boolean;
}

export const PROOF_COMMANDS: readonly CheckName[] = ["good", "defect", "fixed", "counterfactual"];
export const DISCOVERY_CHECKS: readonly CheckName[] = ["good", "defect"];
export const PROOF_CHECKS: readonly CheckName[] = ["defect", "fixed", "counterfactual"];

function nonEmptyCheckField(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function testIdList(value: unknown, field: string): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 ||
      value.some((entry) => !nonEmptyCheckField(entry) || !/^[A-Za-z0-9._/-]{1,120}$/.test(entry)) ||
      new Set(value).size !== value.length) {
    return null;
  }
  return value as string[];
}

/** A flag in a ledger is an attestation; only executed checks with expected outcomes count. */
export function inspectEvidence(raw: unknown): { valid: boolean; reason: string } {
  if (!isRecord(raw) || raw.kind !== "evidence") return { valid: false, reason: "not an evidence record" };
  if (!nonEmptyCheckField(raw.experimentId) || !nonEmptyCheckField(raw.defectId)) {
    return { valid: false, reason: "missing experimentId or defectId" };
  }
  if (typeof raw.severity !== "string" || !(raw.severity in V2.severity)) {
    return { valid: false, reason: "severity must be P1, P2 or P3" };
  }
  for (const field of ["detectorTests", "proofTests"] as const) {
    if (testIdList(raw[field], field) === null) return { valid: false, reason: `${field} must be unique non-empty ids (<=10)` };
  }
  if (raw.testChecks !== undefined) {
    if (!Array.isArray(raw.testChecks) || raw.testChecks.length > 12 || raw.testChecks.some((check) =>
      !isRecord(check) || !nonEmptyCheckField(check.testId) || !nonEmptyCheckField(check.command) ||
      typeof check.output !== "string" || !Number.isInteger(check.exitCode) || check.killed === true ||
      !/^(detector|proof):[^:]+:(good|defect|fixed|counterfactual)$/.test(String(check.name)),
    )) {
      return { valid: false, reason: "testChecks must be executed, completed and well named" };
    }
  }
  const phase = raw.phase === "discover" ? "discover" : raw.phase === undefined || raw.phase === "proof" ? "proof" : null;
  if (phase === null) return { valid: false, reason: "unknown evidence phase" };
  const names = phase === "discover" ? DISCOVERY_CHECKS : PROOF_CHECKS;
  const states = raw.stateIds;
  if (!isRecord(states) || !names.every((name) => nonEmptyCheckField(states[name]))) {
    return { valid: false, reason: `missing checked state identities for ${phase}` };
  }
  if (!Array.isArray(raw.checks) || raw.checks.length !== names.length) {
    return { valid: false, reason: `expected exactly ${names.length} executed checks for ${phase}` };
  }
  const seen = new Set<string>();
  for (const check of raw.checks) {
    if (!isRecord(check) || !names.includes(check.name as CheckName)) {
      return { valid: false, reason: "unknown check name for this phase" };
    }
    const name = check.name as CheckName;
    if (seen.has(name)) return { valid: false, reason: `duplicate check ${name}` };
    seen.add(name);
    if (!nonEmptyCheckField(check.command) || typeof check.output !== "string") {
      return { valid: false, reason: `check ${name} has no executed command/output` };
    }
    if (!Number.isInteger(check.exitCode) || check.killed === true) {
      return { valid: false, reason: `check ${name} has no completed exit code` };
    }
    const exitCode = check.exitCode as number;
    const expected = name === "good" || name === "fixed" ? exitCode === 0 : exitCode !== 0;
    if (!expected) return { valid: false, reason: `check ${name} outcome does not match its contract` };
  }
  return { valid: true, reason: `executed ${phase} proof` };
}

export interface CreditedDefect {
  defectId: string;
  severity: Severity;
}

export interface DiscoveryCredit {
  defectId: string;
  severity: Severity;
  detectorTests: string[];
}

export interface CreditReport {
  creditedExperiments: string[];
  creditedDefects: CreditedDefect[];
  discoveryCredits: DiscoveryCredit[];
  discoveryCount: number;
  fixCount: number;
  detectorTests: number;
  proofTests: number;
  provisionalCount: number;
  discardedCount: number;
  duplicateCount: number;
  invalidKeepCount: number;
}

/** A test id earns a bonus only when its own executed checks separate the states. */
function verifiedTestIds(raw: Record<string, unknown>, category: "detectorTests" | "proofTests"): string[] {
  const ids = testIdList(raw[category], category) ?? [];
  const checks = Array.isArray(raw.testChecks) ? raw.testChecks : [];
  const expected = category === "detectorTests"
    ? { good: true, defect: false }
    : { fixed: true, counterfactual: false };
  const prefix = category === "detectorTests" ? "detector" : "proof";
  return ids.filter((id) => Object.entries(expected).every(([state, shouldPass]) => checks.some((check) =>
    isRecord(check) && check.testId === id && check.name === `${prefix}:${id}:${state}` &&
    check.killed !== true && (shouldPass ? check.exitCode === 0 : check.exitCode !== 0),
  )));
}

/**
 * Discovery credit (N) is paid on a confirmed new defect and is never revoked by a
 * later discard; fix credit (2N) needs a full executed proof plus keep. Both are
 * deduplicated globally by defectId, so a regressed defect cannot be paid twice.
 */
export function evaluateCredit(evidenceRows: unknown[], decisionRows: unknown[]): CreditReport {
  const decisions = new Map<string, "keep" | "discard">();
  for (const raw of decisionRows) {
    if (!isRecord(raw) || raw.kind !== "decision") continue;
    if (!nonEmptyCheckField(raw.experimentId)) continue;
    if (raw.status === "keep" || raw.status === "discard") {
      decisions.set(raw.experimentId as string, raw.status);
    }
  }
  const report: CreditReport = {
    creditedExperiments: [], creditedDefects: [], discoveryCredits: [],
    discoveryCount: 0, fixCount: 0, detectorTests: 0, proofTests: 0,
    provisionalCount: 0, discardedCount: 0, duplicateCount: 0, invalidKeepCount: 0,
  };
  const discovered = new Set<string>();
  const fixedDefects = new Set<string>();
  const credited = new Set<string>();
  const provisional = new Set<string>();
  const discarded = new Set<string>();
  for (const raw of evidenceRows) {
    if (!isRecord(raw) || raw.kind !== "evidence" || !nonEmptyCheckField(raw.experimentId)) continue;
    const experimentId = raw.experimentId as string;
    const defectId = raw.defectId as string;
    const status = decisions.get(experimentId);
    const proof = inspectEvidence(raw);

    // Discovery pays in the moment of confirmation: no keep decision and no clawback.
    if (raw.phase === "discover") {
      if (!proof.valid) {
        if (status === "keep") report.invalidKeepCount += 1;
        continue;
      }
      if (discovered.has(defectId)) {
        report.duplicateCount += 1;
        continue;
      }
      discovered.add(defectId);
      const detectorTests = verifiedTestIds(raw, "detectorTests");
      report.discoveryCredits.push({ defectId, severity: raw.severity as Severity, detectorTests });
      report.detectorTests += detectorTests.length;
      report.discoveryCount += 1;
      if (status === "discard" && !discarded.has(experimentId)) {
        discarded.add(experimentId);
        report.discardedCount += 1;
      }
      continue;
    }

    if (status === undefined) {
      if (proof.valid) provisional.add(experimentId);
      continue;
    }
    if (status === "discard") {
      if (!discarded.has(experimentId)) {
        discarded.add(experimentId);
        report.discardedCount += 1;
      }
      continue;
    }
    if (!proof.valid) {
      report.invalidKeepCount += 1;
      continue;
    }
    if (credited.has(experimentId) || fixedDefects.has(defectId)) {
      report.duplicateCount += 1;
      continue;
    }
    fixedDefects.add(defectId);
    credited.add(experimentId);
    report.creditedExperiments.push(experimentId);
    report.creditedDefects.push({ defectId, severity: raw.severity as Severity });
    report.proofTests += verifiedTestIds(raw, "proofTests").length;
    report.fixCount += 1;
  }
  report.provisionalCount = provisional.size;
  return report;
}

export interface ScoreInput {
  config: BugfixConfig;
  summary: TestSummary;
  credit: CreditReport;
  changedLines: number;
  scorerChanged: number;
}

export interface BugfixScore {
  score: number;
  discoveryCount: number;
  fixCount: number;
  creditedDefects: number;
  discoveryCredit: number;
  fixCredit: number;
  detectorTests: number;
  proofTests: number;
  severityWeighted: number;
  regressionFailures: number;
  newRegressions: number;
  changedLines: number;
  changedLinesOverBudget: number;
  scorerChanged: number;
  invalidKeeps: number;
  tentativeCredit: number;
  duplicateCredits: number;
  testsTotal: number;
  testsGain: number;
}

export function computeBugfixScore(input: ScoreInput): BugfixScore {
  const { config, summary, credit } = input;
  const allDefects = new Set([
    ...credit.discoveryCredits.map((entry) => entry.defectId),
    ...credit.creditedDefects.map((entry) => entry.defectId),
  ]);
  const n = allDefects.size;
  const discoveryCredit = credit.discoveryCredits.reduce(
    (total, entry) => total + V2.discoveryPoints * V2.severity[entry.severity], 0,
  );
  const fixCredit = credit.creditedDefects.reduce(
    (total, entry) => total + V2.fixPoints * V2.severity[entry.severity], 0,
  );
  const detectorTests = Math.min(V2.testCap, credit.detectorTests);
  const proofTests = Math.min(V2.testCap, credit.proofTests);
  const testBonus = V2.testBonus * (detectorTests + proofTests);
  const gain = discoveryCredit + fixCredit + testBonus;
  const batch = n > 0 ? gain / Math.sqrt(1 + V2.decay * (n - 1)) : 0;
  const newRegressions = Math.max(0, summary.fail - config.baselineFail);
  const over = Math.max(0, input.changedLines - V2.lineBudget * n);
  const testsGain = Math.max(0, summary.tests - config.baselineTests);
  const scorerChanged = input.scorerChanged === 0 ? 0 : 1;
  const score =
    batch
    - V2.regression * summary.fail
    - V2.newRegressionPenalty * newRegressions
    - V2.linePenalty * over
    - V2.scorerPenalty * scorerChanged
    - V2.invalidProofPenalty * credit.invalidKeepCount;
  return {
    score: Number(score.toFixed(2)),
    discoveryCount: credit.discoveryCount,
    fixCount: credit.fixCount,
    creditedDefects: credit.fixCount,
    discoveryCredit: Number(discoveryCredit.toFixed(2)),
    fixCredit: Number(fixCredit.toFixed(2)),
    detectorTests,
    proofTests,
    severityWeighted: Number((discoveryCredit + fixCredit).toFixed(3)),
    regressionFailures: summary.fail,
    newRegressions,
    changedLines: input.changedLines,
    changedLinesOverBudget: over,
    scorerChanged,
    invalidKeeps: credit.invalidKeepCount,
    tentativeCredit: credit.provisionalCount,
    duplicateCredits: credit.duplicateCount,
    testsTotal: summary.tests,
    testsGain,
  };
}

export function formatMetricLines(result: BugfixScore): string[] {
  return [
    `METRIC ${BUGFIX_METRIC_VERSION}=${result.score}`,
    `METRIC discovery_credit=${result.discoveryCredit}`,
    `METRIC fix_credit=${result.fixCredit}`,
    `METRIC detector_tests=${result.detectorTests}`,
    `METRIC proof_tests=${result.proofTests}`,
    `METRIC mutation_proven_fixed=${result.creditedDefects}`,
    `METRIC weighted_defects=${result.severityWeighted}`,
    `METRIC regression_failures=${result.regressionFailures}`,
    `METRIC new_regressions=${result.newRegressions}`,
    `METRIC changed_lines=${result.changedLines}`,
    `METRIC changed_lines_over_budget=${result.changedLinesOverBudget}`,
    `METRIC scorer_changed=${result.scorerChanged}`,
    `METRIC invalid_proofs=${result.invalidKeeps}`,
    `METRIC tentative_credit=${result.tentativeCredit}`,
    `METRIC duplicate_credits=${result.duplicateCredits}`,
    `METRIC tests_total=${result.testsTotal}`,
    `METRIC tests_gain=${result.testsGain}`,
  ];
}
