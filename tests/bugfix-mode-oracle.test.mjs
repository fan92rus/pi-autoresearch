/**
 * Independent oracle + property tests for bugfix_score_v2.
 *
 * The oracle below is transcribed from the approved bugfix-mode spec, NOT from
 * extensions/pi-autoresearch/bugfix-mode.ts. It intentionally does not import
 * V1/V2 constants or any credit helper: a bug in the implementation cannot
 * silently become the expected value here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { forAll, genInt, genPick } from "./pbt-harness.mjs";
import { evaluateCredit, computeBugfixScore, formatMetricLines } from "../extensions/pi-autoresearch/bugfix-mode.ts";

// ── Spec constants (independent copies) ─────────────────────────────
const SPEC = Object.freeze({
  severity: Object.freeze({ P1: 1, P2: 0.7, P3: 0.3 }),
  discoveryPoints: 10 / 3,
  fixPoints: 20 / 3,
  decay: 0.35,
  testBonus: 0.1,
  testCap: 3,
  lineBudget: 200,
  regression: 1,
  newRegressionPenalty: 5,
  linePenalty: 0.05,
  scorerPenalty: 20,
  invalidProofPenalty: 10,
});

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const safeId = (v) => typeof v === "string" && /^[A-Za-z0-9._/-]{1,120}$/.test(v);

function oraclePhase(raw) {
  if (raw.phase === "discover") return "discover";
  if (raw.phase === undefined || raw.phase === "proof") return "proof";
  return null;
}

function oracleCheckNames(phase) {
  return phase === "discover" ? ["good", "defect"] : ["defect", "fixed", "counterfactual"];
}

function oracleInspect(raw) {
  if (!isRecord(raw) || raw.kind !== "evidence") return { valid: false, reason: "not evidence" };
  if (!nonEmpty(raw.experimentId) || !nonEmpty(raw.defectId)) return { valid: false, reason: "ids" };
  if (typeof raw.severity !== "string" || !(raw.severity in SPEC.severity)) return { valid: false, reason: "severity" };

  for (const field of ["detectorTests", "proofTests"]) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 10 || value.some((id) => !safeId(id)) ||
        new Set(value).size !== value.length) return { valid: false, reason: field };
  }
  if (raw.testChecks !== undefined) {
    if (!Array.isArray(raw.testChecks) || raw.testChecks.length > 12 || raw.testChecks.some((check) =>
      !isRecord(check) || !nonEmpty(check.testId) || !nonEmpty(check.command) ||
      typeof check.output !== "string" || !Number.isInteger(check.exitCode) || check.killed === true ||
      !/^(detector|proof):[^:]+:(good|defect|fixed|counterfactual)$/.test(String(check.name)),
    )) return { valid: false, reason: "testChecks" };
  }

  const phase = oraclePhase(raw);
  if (phase === null) return { valid: false, reason: "phase" };
  const names = oracleCheckNames(phase);
  const states = raw.stateIds;
  if (!isRecord(states) || !names.every((name) => nonEmpty(states[name]))) return { valid: false, reason: "states" };
  if (!Array.isArray(raw.checks) || raw.checks.length !== names.length) return { valid: false, reason: "check length" };

  const seen = new Set();
  for (const check of raw.checks) {
    if (!isRecord(check) || !names.includes(check.name)) return { valid: false, reason: "check name" };
    if (seen.has(check.name)) return { valid: false, reason: "duplicate check" };
    seen.add(check.name);
    if (!nonEmpty(check.command) || typeof check.output !== "string") return { valid: false, reason: "check evidence" };
    if (!Number.isInteger(check.exitCode) || check.killed === true) return { valid: false, reason: "check exit" };
    const shouldPass = check.name === "good" || check.name === "fixed";
    if (shouldPass ? check.exitCode !== 0 : check.exitCode === 0) return { valid: false, reason: "check outcome" };
  }
  return { valid: true, reason: `executed ${phase} proof` };
}

function oracleVerifiedIds(raw, field) {
  const ids = Array.isArray(raw[field]) && raw[field].every(safeId) ? raw[field] : [];
  const checks = Array.isArray(raw.testChecks) ? raw.testChecks : [];
  const prefix = field === "detectorTests" ? "detector" : "proof";
  const pairs = field === "detectorTests"
    ? [["good", true], ["defect", false]]
    : [["fixed", true], ["counterfactual", false]];
  return ids.filter((id) => pairs.every(([state, shouldPass]) => checks.some((check) =>
    isRecord(check) && check.testId === id && check.name === `${prefix}:${id}:${state}` &&
    check.killed !== true && (shouldPass ? check.exitCode === 0 : check.exitCode !== 0),
  )));
}

function oracleCredit(evidenceRows, decisionRows) {
  const decisions = new Map();
  for (const raw of decisionRows) {
    if (!isRecord(raw) || raw.kind !== "decision" || !nonEmpty(raw.experimentId)) continue;
    if (raw.status === "keep" || raw.status === "discard") decisions.set(raw.experimentId, raw.status);
  }
  const report = {
    creditedExperiments: [], creditedDefects: [], discoveryCredits: [],
    discoveryCount: 0, fixCount: 0, detectorTests: 0, proofTests: 0,
    provisionalCount: 0, discardedCount: 0, duplicateCount: 0, invalidKeepCount: 0,
  };
  const discovered = new Set();
  const fixed = new Set();
  const credited = new Set();
  const provisional = new Set();
  const discarded = new Set();

  for (const raw of evidenceRows) {
    if (!isRecord(raw) || raw.kind !== "evidence" || !nonEmpty(raw.experimentId)) continue;
    const experimentId = raw.experimentId;
    const defectId = raw.defectId;
    const status = decisions.get(experimentId);
    const proof = oracleInspect(raw);
    const phase = oraclePhase(raw);

    if (phase === "discover") {
      if (!proof.valid) {
        if (status === "keep") report.invalidKeepCount += 1;
        continue;
      }
      if (discovered.has(defectId)) { report.duplicateCount += 1; continue; }
      discovered.add(defectId);
      const detectorTests = oracleVerifiedIds(raw, "detectorTests");
      report.discoveryCredits.push({ defectId, severity: raw.severity, detectorTests });
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
      if (!discarded.has(experimentId)) { discarded.add(experimentId); report.discardedCount += 1; }
      continue;
    }
    if (!proof.valid) { report.invalidKeepCount += 1; continue; }
    if (credited.has(experimentId) || fixed.has(defectId)) { report.duplicateCount += 1; continue; }
    fixed.add(defectId);
    credited.add(experimentId);
    report.creditedExperiments.push(experimentId);
    report.creditedDefects.push({ defectId, severity: raw.severity });
    report.proofTests += oracleVerifiedIds(raw, "proofTests").length;
    report.fixCount += 1;
  }
  report.provisionalCount = provisional.size;
  return report;
}

function oracleScore(config, summary, credit, changedLines, scorerChanged) {
  const allDefects = new Set([
    ...credit.discoveryCredits.map((e) => e.defectId),
    ...credit.creditedDefects.map((e) => e.defectId),
  ]);
  const n = allDefects.size;
  const discoveryCredit = credit.discoveryCredits.reduce(
    (total, e) => total + SPEC.discoveryPoints * SPEC.severity[e.severity], 0,
  );
  const fixCredit = credit.creditedDefects.reduce(
    (total, e) => total + SPEC.fixPoints * SPEC.severity[e.severity], 0,
  );
  const detectorTests = Math.min(SPEC.testCap, credit.detectorTests);
  const proofTests = Math.min(SPEC.testCap, credit.proofTests);
  const gain = discoveryCredit + fixCredit + SPEC.testBonus * (detectorTests + proofTests);
  const batch = n > 0 ? gain / Math.sqrt(1 + SPEC.decay * (n - 1)) : 0;
  const newRegressions = Math.max(0, summary.fail - config.baselineFail);
  const over = Math.max(0, changedLines - SPEC.lineBudget * n);
  const score = batch
    - SPEC.regression * summary.fail
    - SPEC.newRegressionPenalty * newRegressions
    - SPEC.linePenalty * over
    - SPEC.scorerPenalty * (scorerChanged === 0 ? 0 : 1)
    - SPEC.invalidProofPenalty * credit.invalidKeepCount;
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
    changedLines,
    changedLinesOverBudget: over,
    scorerChanged: scorerChanged === 0 ? 0 : 1,
    invalidKeeps: credit.invalidKeepCount,
    tentativeCredit: credit.provisionalCount,
    duplicateCredits: credit.duplicateCount,
    testsTotal: summary.tests,
    testsGain: Math.max(0, summary.tests - config.baselineTests),
  };
}

// ── Scenario generation ─────────────────────────────────────────────
const DEFECTS = ["P1:alpha", "P2:beta", "P3:gamma", "P1:delta"];
const TEST_IDS = ["pbt.test", "oracle.test", "differential.test", "imaginary.test; exit 0"];

function makeCheck(rng, name, valid) {
  const shouldPass = name === "good" || name === "fixed";
  let exitCode = shouldPass ? 0 : 1;
  if (!valid && rng() < 0.5) exitCode = shouldPass ? 1 : 0;
  const check = { name, command: `run-${name}`, exitCode, output: `output-${name}` };
  if (!valid && rng() < 0.25) check.killed = true;
  if (!valid && rng() < 0.25) delete check.output;
  return check;
}

function makeTestIds(rng) {
  if (rng() < 0.1) return [];
  const count = genInt(rng, 0, 3);
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = genPick(rng, TEST_IDS);
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length && rng() < 0.5) ids.push(genPick(rng, TEST_IDS));
  return ids;
}

function makeTestChecks(rng, prefix, id, states, valid) {
  return states.map((state) => {
    const shouldPass = state === "good" || state === "fixed";
    let exitCode = shouldPass ? 0 : 1;
    if (!valid && rng() < 0.4) exitCode = shouldPass ? 1 : 0;
    return {
      name: `${prefix}:${id}:${state}`,
      testId: id,
      command: `test ${id}`,
      output: `output ${id}`,
      exitCode,
      ...(!valid && rng() < 0.15 ? { killed: true } : {}),
    };
  });
}

function makeScenario(rng, count) {
  const evidence = [];
  const decisions = [];
  const log = [];
  const config = {
    campaignId: "oracle",
    name: "oracle",
    testCommand: "npm test",
    testIdCommand: "node --test {test}",
    proofCommands: { good: "g", defect: "d", fixed: "f", counterfactual: "c" },
    scopePaths: ["tests"],
    baseRef: "HEAD",
    baselineFail: genInt(rng, 0, 3),
    baselineTests: genInt(rng, 80, 120),
  };
  for (let i = 0; i < count; i += 1) {
    const experimentId = `e${genInt(rng, 0, Math.max(1, count))}`;
    const defectId = genPick(rng, DEFECTS);
    const severity = genPick(rng, ["P1", "P2", "P3"]);
    const phase = rng() < 0.45 ? "discover" : rng() < 0.9 ? "proof" : null;
    const valid = rng() < 0.75;
    const names = phase === "discover" ? ["good", "defect"] : ["defect", "fixed", "counterfactual"];
    const checks = names.map((name) => makeCheck(rng, name, valid));
    const stateIds = {};
    for (const name of names) stateIds[name] = valid ? `ref-${name}` : "";

    const detectorTests = phase === "discover" ? makeTestIds(rng) : [];
    const proofTests = phase === "proof" ? makeTestIds(rng) : [];
    const testChecks = [];
    for (const id of detectorTests) testChecks.push(...makeTestChecks(rng, "detector", id, ["good", "defect"], valid));
    for (const id of proofTests) testChecks.push(...makeTestChecks(rng, "proof", id, ["fixed", "counterfactual"], valid));
    if (!valid && testChecks.length && rng() < 0.3) testChecks[0].name = "bad:name";

    evidence.push({
      kind: rng() < 0.05 ? "not-evidence" : "evidence",
      experimentId, defectId, severity,
      ...(phase === null ? {} : { phase }),
      stateIds, checks, detectorTests, proofTests,
      ...(testChecks.length ? { testChecks } : {}),
    });
    log.push(`${experimentId}:${phase ?? "unknown"}:${defectId}:${valid ? "valid" : "bad"}`);

    if (rng() < 0.75) {
      decisions.push({
        kind: "decision",
        experimentId: rng() < 0.2 ? `e${genInt(rng, 0, Math.max(1, count))}` : experimentId,
        status: rng() < 0.55 ? "keep" : "discard",
      });
    }
  }
  const fail = genInt(rng, 0, 5);
  return {
    config,
    evidence,
    decisions,
    summary: { tests: genInt(rng, 80, 140), pass: 0, fail, skipped: 4 },
    fail,
    changedLines: genInt(rng, 0, 900),
    scorerChanged: genInt(rng, 0, 1),
    log,
  };
}

// ── Property: implementation == spec oracle ─────────────────────────
test("bugfix_score_v2 matches an independent spec oracle over random credit histories", async () => {
  const result = await forAll({
    name: "bugfix-score-v2-oracle",
    seeds: 80,
    maxActions: 28,
    run: (rng, seed, maxActions) => {
      const scenario = makeScenario(rng, maxActions);
      const check = (fn) => {
        try { fn(); } catch (error) {
          error.log = [`seed=${seed}`, ...scenario.log];
          throw error;
        }
      };

      check(() => {
        const actual = evaluateCredit(scenario.evidence, scenario.decisions);
        const expected = oracleCredit(scenario.evidence, scenario.decisions);
        assert.deepEqual(actual, expected, "credit report differs from the spec oracle");
        assert.ok(actual.discoveryCount <= DEFECTS.length, "discovery is deduplicated per defect");
        assert.ok(actual.fixCount <= DEFECTS.length, "fix is deduplicated per defect");
        assert.ok(actual.detectorTests <= SPEC.testCap * actual.discoveryCount, "detector bonus is capped");
        assert.ok(actual.proofTests <= SPEC.testCap * actual.fixCount, "proof bonus is capped");
      });

      check(() => {
        const credit = oracleCredit(scenario.evidence, scenario.decisions);
        const expected = oracleScore(
          scenario.config, scenario.summary, credit, scenario.changedLines, scenario.scorerChanged,
        );
        const actual = computeBugfixScore({
          config: scenario.config,
          summary: scenario.summary,
          credit: evaluateCredit(scenario.evidence, scenario.decisions),
          changedLines: scenario.changedLines,
          scorerChanged: scenario.scorerChanged,
        });
        assert.deepEqual(actual, expected, "score differs from the spec oracle");

        const lines = formatMetricLines(actual);
        const expectedLines = [
          ["bugfix_score_v2", expected.score],
          ["discovery_credit", expected.discoveryCredit],
          ["fix_credit", expected.fixCredit],
          ["detector_tests", expected.detectorTests],
          ["proof_tests", expected.proofTests],
          ["mutation_proven_fixed", expected.creditedDefects],
          ["weighted_defects", expected.severityWeighted],
          ["regression_failures", expected.regressionFailures],
          ["new_regressions", expected.newRegressions],
          ["changed_lines", expected.changedLines],
          ["changed_lines_over_budget", expected.changedLinesOverBudget],
          ["scorer_changed", expected.scorerChanged],
          ["invalid_proofs", expected.invalidKeeps],
          ["tentative_credit", expected.tentativeCredit],
          ["duplicate_credits", expected.duplicateCredits],
          ["tests_total", expected.testsTotal],
          ["tests_gain", expected.testsGain],
        ].map(([name, value]) => `METRIC ${name}=${value}`);
        assert.deepEqual(lines, expectedLines, "every METRIC line, value and order must match the spec oracle");
      });
    },
  });
  assert.equal(result.pbtFail, 0, "oracle property failed for at least one seed");
});

// ── Targeted invariants that the random generator may rarely hit ────
const validDiscovery = (experimentId, defectId, severity, detectorTests = []) => ({
  kind: "evidence", experimentId, defectId, severity, phase: "discover",
  detectorTests,
  stateIds: { good: "good-ref", defect: "defect-ref" },
  checks: [
    { name: "good", command: "run-good", exitCode: 0, output: "ok" },
    { name: "defect", command: "run-defect", exitCode: 1, output: "red" },
  ],
  testChecks: detectorTests.flatMap((id) => [
    { name: `detector:${id}:good`, testId: id, command: `test ${id}`, output: "ok", exitCode: 0 },
    { name: `detector:${id}:defect`, testId: id, command: `test ${id}`, output: "red", exitCode: 1 },
  ]),
});

const validProof = (experimentId, defectId, severity, proofTests = []) => ({
  kind: "evidence", experimentId, defectId, severity, phase: "proof",
  proofTests,
  stateIds: { defect: "defect-ref", fixed: "fixed-ref", counterfactual: "counter-ref" },
  checks: [
    { name: "defect", command: "run-defect", exitCode: 1, output: "red" },
    { name: "fixed", command: "run-fixed", exitCode: 0, output: "ok" },
    { name: "counterfactual", command: "run-counter", exitCode: 1, output: "red" },
  ],
  testChecks: proofTests.flatMap((id) => [
    { name: `proof:${id}:fixed`, testId: id, command: `test ${id}`, output: "ok", exitCode: 0 },
    { name: `proof:${id}:counterfactual`, testId: id, command: `test ${id}`, output: "red", exitCode: 1 },
  ]),
});

test("PBT invariants: discard never revokes discovery and a fix never pays twice", () => {
  const evidence = [
    validDiscovery("d1", "P1:alpha", "P1", ["pbt.test"]),
    validDiscovery("d2", "P1:alpha", "P1"), // duplicate defect id
    validProof("f1", "P1:alpha", "P1", ["oracle.test"]),
    validProof("f2", "P1:alpha", "P1"), // duplicate defect id, different experiment
  ];
  const decisions = [
    { kind: "decision", experimentId: "d1", status: "discard" },
    { kind: "decision", experimentId: "f1", status: "keep" },
    { kind: "decision", experimentId: "f2", status: "keep" },
  ];
  const credit = evaluateCredit(evidence, decisions);
  assert.deepEqual(credit, oracleCredit(evidence, decisions));
  assert.equal(credit.discoveryCount, 1);
  assert.equal(credit.fixCount, 1);
  assert.equal(credit.detectorTests, 1);
  assert.equal(credit.proofTests, 1);
  assert.equal(credit.discardedCount, 1);
  assert.equal(credit.duplicateCount, 2);
});

test("PBT invariant: adding a keep cannot lower the score when failures stay fixed", () => {
  const config = {
    campaignId: "oracle", name: "oracle", testCommand: "npm test",
    testIdCommand: "node --test {test}",
    proofCommands: { good: "g", defect: "d", fixed: "f", counterfactual: "c" },
    scopePaths: ["tests"], baseRef: "HEAD", baselineFail: 0, baselineTests: 100,
  };
  const summary = { tests: 100, pass: 100, fail: 0, skipped: 0 };
  const base = computeBugfixScore({
    config, summary,
    credit: evaluateCredit([validDiscovery("d1", "P1:alpha", "P1")], []),
    changedLines: 0, scorerChanged: 0,
  });
  const withFix = computeBugfixScore({
    config, summary,
    credit: evaluateCredit([
      validDiscovery("d1", "P1:alpha", "P1"),
      validProof("f1", "P1:alpha", "P1"),
    ], [{ kind: "decision", experimentId: "f1", status: "keep" }]),
    changedLines: 0, scorerChanged: 0,
  });
  assert.ok(withFix.score > base.score, "the larger fix reward pulls the agent from discovery to fixes");
  assert.ok(Math.abs(withFix.fixCredit - (20 / 3) * SPEC.severity.P1) < 0.01, "fix payout is 2N before display rounding");
});
