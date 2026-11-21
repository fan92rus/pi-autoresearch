import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUGFIX_METRIC_VERSION,
  computeBugfixScore,
  evaluateCredit,
  formatMetricLines,
  inspectEvidence,
  parseTestSummary,
  validateBugfixConfig,
} from "../extensions/pi-autoresearch/bugfix-mode.ts";

const goodConfig = {
  campaignId: "c1",
  name: "bugfix",
  testCommand: "npm test",
  testIdCommand: "node --test {test}",
  proofCommands: { good: "run-good", defect: "run-defect", fixed: "run-fixed", counterfactual: "run-counterfactual" },
  scopePaths: ["src", "tests"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

const proof = (experimentId, defectId, severity = "P1", exitCodes = [1, 0, 1], proofTests = []) => ({
  kind: "evidence",
  experimentId,
  defectId,
  severity,
  phase: "proof",
  proofTests,
  stateIds: { defect: "d", fixed: "f", counterfactual: "c" },
  checks: ["defect", "fixed", "counterfactual"].map((name, i) => ({
    name, command: `run-${name}`, exitCode: exitCodes[i], output: `output-${name}`,
  })),
  testChecks: (proofTests ?? []).flatMap((id) => [
    { name: `proof:${id}:fixed`, testId: id, command: `run-${id}`, exitCode: 0, output: `output-${id}` },
    { name: `proof:${id}:counterfactual`, testId: id, command: `run-${id}`, exitCode: 1, output: `output-${id}` },
  ]),
});

const discovery = (experimentId, defectId, severity = "P1", exitCodes = [0, 1], detectorTests = []) => ({
  kind: "evidence",
  experimentId,
  defectId,
  severity,
  phase: "discover",
  detectorTests,
  stateIds: { good: "g", defect: "d" },
  checks: ["good", "defect"].map((name, i) => ({
    name, command: `run-${name}`, exitCode: exitCodes[i], output: `output-${name}`,
  })),
  testChecks: detectorTests.flatMap((id) => [
    { name: `detector:${id}:good`, testId: id, command: `run-${id}`, exitCode: 0, output: `output-${id}` },
    { name: `detector:${id}:defect`, testId: id, command: `run-${id}`, exitCode: 1, output: `output-${id}` },
  ]),
});

test("config is explicit and carries no previous campaign constants", () => {
  assert.deepEqual(validateBugfixConfig(goodConfig), { ok: true, value: goodConfig });
  for (const bad of [
    { ...goodConfig, scopePaths: [] },
    { ...goodConfig, scopePaths: ["D:/Documents/Repositories/pi-autoresearch"] },
    { ...goodConfig, scopePaths: ["../outside"] },
    { ...goodConfig, baselineFail: -1 },
    { ...goodConfig, baselineTests: 1.5 },
    { ...goodConfig, extra: true },
    { ...goodConfig, testCommand: "" },
  ]) {
    assert.equal(validateBugfixConfig(bad).ok, false);
  }
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode.ts"), "utf8",
  );
  for (const legacy of ["9fba532", "2031", "D:/Documents/Repositories", "extensions tests"]) {
    assert.ok(!source.includes(legacy), `portable core must not contain ${legacy}`);
  }
});

test("TAP parsing is strict and uses the last summary", () => {
  const output = "# tests 4\n# pass 4\n# fail 0\n# skipped 0\n";
  assert.deepEqual(parseTestSummary(output), { ok: true, value: { tests: 4, pass: 4, fail: 0, skipped: 0 } });
  const repeated = `${output}# tests 6\n# pass 5\n# fail 1\n# skipped 0\n`;
  assert.deepEqual(parseTestSummary(repeated), { ok: true, value: { tests: 6, pass: 5, fail: 1, skipped: 0 } });
  assert.equal(parseTestSummary("# pass 3\n").ok, false);
  assert.equal(parseTestSummary("# tests 3\n# pass 2\n# fail 0\n# skipped 0\n").ok, false);
  assert.equal(parseTestSummary("").ok, false);
});

test("evidence requires executed checks with the expected outcomes", () => {
  assert.equal(inspectEvidence(proof("e1", "P1:bug")).valid, true);
  assert.equal(inspectEvidence(discovery("e1", "P1:bug")).valid, true);
  assert.equal(inspectEvidence(discovery("e1", "P1:bug", "P1", [1, 1])).valid, false);
  assert.equal(inspectEvidence(discovery("e1", "P1:bug", "P1", [0, 0])).valid, false);
  const detectorDup = discovery("e1", "P1:bug", "P1", [0, 1], ["t1", "t1"]);
  assert.equal(inspectEvidence(detectorDup).valid, false);
  const shellInjection = discovery("e1", "P1:bug", "P1", [0, 1], ["imaginary.test; test -f fixed.txt"]);
  assert.equal(inspectEvidence(shellInjection).valid, false);
  assert.equal(inspectEvidence({ kind: "evidence", experimentId: "e1", defectId: "d", mutation_red: true }).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P1", [1, 1, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P1", [0, 0, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P4", [1, 0, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "toString", [1, 0, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "constructor", [1, 0, 1])).valid, false);
  const missingOutput = proof("e1", "d");
  missingOutput.checks[0].output = undefined;
  assert.equal(inspectEvidence(missingOutput).valid, false);
});

test("credit is durable only for a unique keep with a valid executed proof", () => {
  const evidence = [
    proof("e1", "P1:first"),
    proof("e2", "P2:discarded"),
    proof("e3", "P3:pending"),
    { ...proof("e4", "P1:bad-flag"), mutation_red: true, checks: [] },
    proof("e5", "P1:first"),
  ];
  const decisions = [
    { kind: "decision", experimentId: "e1", status: "keep" },
    { kind: "decision", experimentId: "e2", status: "discard" },
    { kind: "decision", experimentId: "e4", status: "keep" },
    { kind: "decision", experimentId: "e5", status: "keep" },
  ];
  const credit = evaluateCredit(evidence, decisions);
  assert.deepEqual(credit.creditedExperiments, ["e1"]);
  assert.equal(credit.discardedCount, 1);
  assert.equal(credit.provisionalCount, 1);
  assert.equal(credit.duplicateCount, 1);
  assert.equal(credit.invalidKeepCount, 1);
});

test("score formula pays N on discovery and 2N on an executed fix", () => {
  const summary = { tests: 10, pass: 10, fail: 0, skipped: 0 };
  const decisions = [
    { kind: "decision", experimentId: "d1", status: "keep" },
    { kind: "decision", experimentId: "f1", status: "keep" },
  ];
  const credit = evaluateCredit([
    discovery("d1", "P1:bug", "P1", [0, 1], ["pbt.test"]),
    proof("f1", "P1:bug", "P1", [1, 0, 1], ["regression.test"]),
  ], decisions);
  assert.equal(credit.discoveryCount, 1);
  assert.equal(credit.fixCount, 1);
  assert.equal(credit.detectorTests, 1);
  assert.equal(credit.proofTests, 1);
  const result = computeBugfixScore({ config: goodConfig, summary, credit, changedLines: 0, scorerChanged: 0 });
  assert.equal(result.score, 10.2); // 3.33 + 6.67 + 0.1 + 0.1
  assert.equal(result.creditedDefects, 1);
  assert.equal(result.discoveryCredit, 3.33);
  assert.equal(result.fixCredit, 6.67);
  assert.ok(formatMetricLines(result).includes("METRIC discovery_credit=3.33"));
  assert.ok(formatMetricLines(result).includes("METRIC fix_credit=6.67"));
  assert.ok(formatMetricLines(result).includes("METRIC detector_tests=1"));
  assert.ok(formatMetricLines(result).includes("METRIC proof_tests=1"));
  assert.ok(formatMetricLines(result).some((line) => line === `METRIC ${BUGFIX_METRIC_VERSION}=10.2`));

  const tampered = computeBugfixScore({ config: goodConfig, summary, credit, changedLines: 0, scorerChanged: 1 });
  assert.equal(tampered.score, -9.8);
  const regressed = computeBugfixScore({
    config: goodConfig,
    summary: { tests: 10, pass: 8, fail: 2, skipped: 0 },
    credit,
    changedLines: 300,
    scorerChanged: 0,
  });
  assert.equal(regressed.newRegressions, 2);
  assert.equal(regressed.changedLinesOverBudget, 100);
  assert.equal(regressed.score, -6.8);
});

test("discovery survives discard, cannot be paid twice and decays across defects", () => {
  const decisions = [
    { kind: "decision", experimentId: "d1", status: "discard" },
    { kind: "decision", experimentId: "d2", status: "keep" },
    { kind: "decision", experimentId: "d3", status: "keep" },
  ];
  const credit = evaluateCredit([
    discovery("d1", "P1:same"),
    discovery("d2", "P1:same"),
    discovery("d3", "P1:other"),
  ], decisions);
  assert.equal(credit.discoveryCount, 2, "a discarded discovery is still durable and deduplicates the id");
  assert.equal(credit.duplicateCount, 1);
  const summary = { tests: 10, pass: 10, fail: 0, skipped: 0 };
  const single = computeBugfixScore({ config: goodConfig, summary, credit: evaluateCredit([discovery("x", "P1:one")], [{ kind: "decision", experimentId: "x", status: "keep" }]), changedLines: 0, scorerChanged: 0 });
  assert.equal(single.score, 3.33);
  assert.ok(computeBugfixScore({ config: goodConfig, summary, credit, changedLines: 0, scorerChanged: 0 }).score < 6.66);
});

test("only capped proof-backed and detector tests earn a bonus", () => {
  const credit = evaluateCredit([
    discovery("d1", "P1:bug", "P1", [0, 1], ["pbt", "oracle", "model", "extra"]),
    proof("f1", "P1:bug", "P1", [1, 0, 1], ["r1", "r2", "r3", "r4"]),
  ], [
    { kind: "decision", experimentId: "d1", status: "keep" },
    { kind: "decision", experimentId: "f1", status: "keep" },
  ]);
  const result = computeBugfixScore({
    config: goodConfig, summary: { tests: 10, pass: 10, fail: 0, skipped: 0 },
    credit, changedLines: 0, scorerChanged: 0,
  });
  assert.equal(result.detectorTests, 3);
  assert.equal(result.proofTests, 3);
  assert.equal(result.score, 10.6);
});

test("one keep gives at most one credit even with several evidence rows", () => {
  const evidence = [proof("e1", "P1:first"), proof("e1", "P2:second")];
  const decisions = [{ kind: "decision", experimentId: "e1", status: "keep" }];
  const credit = evaluateCredit(evidence, decisions);
  assert.equal(credit.creditedExperiments.length, 1);
  assert.equal(credit.duplicateCount, 1);
});

test("a timed-out check is not an expected failure", () => {
  const timedOut = proof("e1", "P1:bug");
  timedOut.checks[0].killed = true;
  assert.equal(inspectEvidence(timedOut).valid, false);
});
