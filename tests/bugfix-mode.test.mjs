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
  proofCommands: { defect: "run-defect", fixed: "run-fixed", counterfactual: "run-counterfactual" },
  scopePaths: ["src", "tests"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

const proof = (experimentId, defectId, severity = "P1", exitCodes = [1, 0, 1]) => ({
  kind: "evidence",
  experimentId,
  defectId,
  severity,
  stateIds: { defect: "d", fixed: "f", counterfactual: "c" },
  checks: ["defect", "fixed", "counterfactual"].map((name, i) => ({
    name, command: `run-${name}`, exitCode: exitCodes[i], output: `output-${name}`,
  })),
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
  assert.equal(inspectEvidence({ kind: "evidence", experimentId: "e1", defectId: "d", mutation_red: true }).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P1", [1, 1, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P1", [0, 0, 1])).valid, false);
  assert.equal(inspectEvidence(proof("e1", "d", "P4", [1, 0, 1])).valid, false);
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

test("score formula preserves v2 accounting with project-owned baselines", () => {
  const summary = { tests: 10, pass: 10, fail: 0, skipped: 0 };
  const credit = evaluateCredit([proof("e1", "P1:bug")], [{ kind: "decision", experimentId: "e1", status: "keep" }]);
  const result = computeBugfixScore({ config: goodConfig, summary, credit, changedLines: 0, scorerChanged: 0 });
  assert.equal(result.score, 10.2);
  assert.equal(result.creditedDefects, 1);
  assert.equal(result.severityWeighted, 1);
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
  assert.equal(regressed.score, 10 - 2 - 10 - 5 + 0.2);
  assert.ok(formatMetricLines(result).some((line) => line === `METRIC ${BUGFIX_METRIC_VERSION}=10.2`));
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
