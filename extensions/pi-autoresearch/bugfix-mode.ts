/**
 * bugfix-mode: portable scoring core for the reusable defect-hunting loop.
 *
 * This module deliberately contains no campaign paths, no test baseline and no
 * file IO. Everything that belongs to a project arrives through BugfixConfig;
 * everything that belongs to an experiment arrives through evidence/decisions.
 * The CLI in bugfix-measure.ts and the tool in bugfix-mode-tool.ts own IO.
 */

export const BUGFIX_METRIC_VERSION = "bugfix_score_v1";

/** Weights and penalties of this metric version. Changing them requires a new version. */
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

export interface BugfixConfig {
  campaignId: string;
  name: string;
  testCommand: string;
  proofCommands: { defect: string; fixed: string; counterfactual: string };
  scopePaths: string[];
  baseRef: string;
  baselineFail: number;
  baselineTests: number;
}

const CONFIG_KEYS: readonly string[] = [
  "campaignId", "name", "testCommand", "proofCommands", "scopePaths",
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

  for (const field of ["campaignId", "name", "testCommand", "baseRef"] as const) {
    const problem = nonEmptyString(raw[field], field);
    if (problem) return { ok: false, error: problem };
  }
  if (!isSafeCampaignId(raw.campaignId)) {
    return { ok: false, error: "campaignId: expected 1-64 characters from [A-Za-z0-9._-]" };
  }

  const proofCommands = raw.proofCommands;
  if (!isRecord(proofCommands) || !CHECK_NAMES.every((name) => {
    const problem = nonEmptyString((proofCommands as Record<string, unknown>)[name], `proofCommands.${name}`);
    if (problem === null) return true;
    return false;
  })) {
    return { ok: false, error: "proofCommands: expected defect/fixed/counterfactual commands" };
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

export type CheckName = "defect" | "fixed" | "counterfactual";

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
  stateIds: { defect: string; fixed: string; counterfactual: string };
  checks: ProofCheck[];
}

const CHECK_NAMES: readonly CheckName[] = ["defect", "fixed", "counterfactual"];

function nonEmptyCheckField(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** A flag in a ledger is an attestation; only executed checks with expected outcomes count. */
export function inspectEvidence(raw: unknown): { valid: boolean; reason: string } {
  if (!isRecord(raw) || raw.kind !== "evidence") return { valid: false, reason: "not an evidence record" };
  if (!nonEmptyCheckField(raw.experimentId) || !nonEmptyCheckField(raw.defectId)) {
    return { valid: false, reason: "missing experimentId or defectId" };
  }
  if (typeof raw.severity !== "string" || !(raw.severity in V1.severity)) {
    return { valid: false, reason: "severity must be P1, P2 or P3" };
  }
  const states = raw.stateIds;
  if (!isRecord(states) || !CHECK_NAMES.every((name) => nonEmptyCheckField(states[name]))) {
    return { valid: false, reason: "missing checked state identities" };
  }
  if (!Array.isArray(raw.checks) || raw.checks.length !== CHECK_NAMES.length) {
    return { valid: false, reason: "expected exactly three executed checks" };
  }
  const seen = new Set<string>();
  for (const check of raw.checks) {
    if (!isRecord(check) || !CHECK_NAMES.includes(check.name as CheckName)) {
      return { valid: false, reason: "unknown check name" };
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
    const expected = name === "fixed" ? exitCode === 0 : exitCode !== 0;
    if (!expected) return { valid: false, reason: `check ${name} outcome does not match its contract` };
  }
  return { valid: true, reason: "executed proof" };
}

export interface CreditedDefect {
  defectId: string;
  severity: Severity;
}

export interface CreditReport {
  creditedExperiments: string[];
  creditedDefects: CreditedDefect[];
  provisionalCount: number;
  discardedCount: number;
  duplicateCount: number;
  invalidKeepCount: number;
}

/**
 * Durable credit requires: valid executed proof + a keep decision + a unique defect.
 * A discard earns nothing and is NOT an invalid proof; a pending decision stays
 * provisional and never enters the campaign score.
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
    creditedExperiments: [], creditedDefects: [], provisionalCount: 0,
    discardedCount: 0, duplicateCount: 0, invalidKeepCount: 0,
  };
  const defects = new Set<string>();
  const credited = new Set<string>();
  for (const raw of evidenceRows) {
    if (!isRecord(raw) || raw.kind !== "evidence" || !nonEmptyCheckField(raw.experimentId)) continue;
    const experimentId = raw.experimentId as string;
    const status = decisions.get(experimentId);
    const proof = inspectEvidence(raw);
    if (status === undefined) {
      if (proof.valid) report.provisionalCount += 1;
      continue;
    }
    if (status === "discard") {
      report.discardedCount += 1;
      continue;
    }
    if (!proof.valid) {
      report.invalidKeepCount += 1;
      continue;
    }
    const defectId = raw.defectId as string;
    if (credited.has(experimentId) || defects.has(defectId)) {
      report.duplicateCount += 1;
      continue;
    }
    defects.add(defectId);
    credited.add(experimentId);
    report.creditedExperiments.push(experimentId);
    report.creditedDefects.push({ defectId, severity: raw.severity as Severity });
  }
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
  creditedDefects: number;
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
  const n = credit.creditedDefects.length;
  const severity = credit.creditedDefects.reduce(
    (total, defect) => total + V1.severity[defect.severity],
    0,
  );
  const batch = n > 0 ? severity / Math.sqrt(1 + V1.decay * (n - 1)) : 0;
  const newRegressions = Math.max(0, summary.fail - config.baselineFail);
  const over = Math.max(0, input.changedLines - V1.lineBudget * n);
  const testsGain = Math.max(0, summary.tests - config.baselineTests);
  const scorerChanged = input.scorerChanged === 0 ? 0 : 1;
  const score =
    V1.reward * batch
    - V1.regression * summary.fail
    - V1.newRegressionPenalty * newRegressions
    - V1.linePenalty * over
    - V1.scorerPenalty * scorerChanged
    - V1.invalidProofPenalty * credit.invalidKeepCount
    + V1.testGain * testsGain;
  return {
    score: Number(score.toFixed(2)),
    creditedDefects: n,
    severityWeighted: Number(severity.toFixed(3)),
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
