import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { renderDashboardLines } from "../extensions/pi-autoresearch/widget.ts";
import {
  computeBugfixScore, evaluateCredit, formatMetricLines,
} from "../extensions/pi-autoresearch/bugfix-mode.ts";
import { createBugfixModeTool } from "../extensions/pi-autoresearch/bugfix-mode-tool.ts";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const th = { fg: (_style, value) => value, bold: (value) => value };
const metricNames = [
  "bugfix_score_v2", "discovery_credit", "fix_credit", "detector_tests", "proof_tests",
  "mutation_proven_fixed", "weighted_defects", "regression_failures", "new_regressions",
  "changed_lines", "changed_lines_over_budget", "scorer_changed", "invalid_proofs",
  "tentative_credit", "duplicate_credits", "tests_total", "tests_gain",
];
const secondaryMetrics = ["discovery_credit", "fix_credit", "detector_tests", "proof_tests"]
  .map((name) => ({ name, unit: "" }));
const state = (results) => ({
  results,
  bestMetric: null,
  bestDirection: "higher",
  metricName: "bugfix_score_v2",
  metricUnit: "",
  secondaryMetrics,
  name: null,
  currentSegment: 0,
  maxExperiments: null,
  confidence: null,
});
const metrics = (score, discovery, fix, detector, proof) => ({
  bugfix_score_v2: score,
  discovery_credit: discovery,
  fix_credit: fix,
  detector_tests: detector,
  proof_tests: proof,
});

test("dashboard attributes keep status, progress and secondary credits to the best keep", () => {
  const lines = renderDashboardLines(state([
    // Discard has a higher primary metric than the keep: "higher" must still pick the keep.
    { commit: "d1", metric: 99, metrics: metrics(99, 91, 92, 93, 94), status: "discard", description: "discarded", timestamp: "t1", segment: 0 },
    { commit: "k1", metric: 2, metrics: metrics(2, 3, 4, 5, 6), status: "keep", description: "kept", timestamp: "t2", segment: 0 },
    { commit: "c1", metric: 0, metrics: metrics(0, 71, 72, 73, 74), status: "crash", description: "crashed", timestamp: "t3", segment: 0 },
    { commit: "f1", metric: 0, metrics: metrics(0, 81, 82, 83, 84), status: "checks_failed", description: "failed", timestamp: "t4", segment: 0 },
  ]), 160, th);
  const text = lines.join("\n");
  assert.match(text, /1 kept/);
  assert.match(text, /1 discarded/);
  assert.match(text, /1 crashed/);
  assert.match(text, /1 checks failed/);
  for (const status of ["keep", "discard", "crash", "checks_failed"]) {
    assert.match(text, new RegExp(status), `status ${status} missing from TUI table`);
  }
  // Labeled pairs appear only in the Progress secondary block; row tables print bare values.
  for (const [name, value] of Object.entries(metrics(2, 3, 4, 5, 6))) {
    assert.match(text, new RegExp(`${name}: ${value}(?!\\d)`), `${name} must belong to the best keep`);
  }
  for (const value of [91, 92, 93, 94, 71, 72, 73, 74, 81, 82, 83, 84]) {
    assert.doesNotMatch(text, new RegExp(`(?:discovery_credit|fix_credit|detector_tests|proof_tests): ${value}(?!\\d)`));
  }
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("every METRIC keeps its identity through format → log state → dashboard", () => {
  const result = {
    score: 10, discoveryCredit: 11, fixCredit: 12, detectorTests: 13, proofTests: 14,
    creditedDefects: 15, severityWeighted: 16, regressionFailures: 17, newRegressions: 18,
    changedLines: 19, changedLinesOverBudget: 20, scorerChanged: 21, invalidKeeps: 22,
    tentativeCredit: 23, duplicateCredits: 24, testsTotal: 25, testsGain: 26,
  };
  const lines = formatMetricLines(result);
  assert.equal(lines.length, metricNames.length);
  const parsed = Object.fromEntries(lines.map((line, index) => {
    const match = /^METRIC\s+([A-Za-z0-9_]+)=([^\s]+)$/.exec(line);
    assert.ok(match, `malformed METRIC line ${line}`);
    assert.equal(match[1], metricNames[index], `METRIC order changed at ${index}`);
    return [match[1], Number(match[2])];
  }));
  const expected = {
    bugfix_score_v2: 10, discovery_credit: 11, fix_credit: 12, detector_tests: 13,
    proof_tests: 14, mutation_proven_fixed: 15, weighted_defects: 16,
    regression_failures: 17, new_regressions: 18, changed_lines: 19,
    changed_lines_over_budget: 20, scorer_changed: 21, invalid_proofs: 22,
    tentative_credit: 23, duplicate_credits: 24, tests_total: 25, tests_gain: 26,
  };
  assert.deepEqual(parsed, expected, "values must stay bound to their metric names");

  const text = renderDashboardLines(state([{
    commit: "metric-run", metric: parsed.bugfix_score_v2, metrics: parsed,
    status: "keep", description: "parsed metrics", timestamp: "t", segment: 0,
  }]), 180, th).join("\n");
  for (const name of ["discovery_credit", "fix_credit", "detector_tests", "proof_tests"]) {
    assert.match(text, new RegExp(`${name}: ${parsed[name]}(?!\\d)`), `${name} was lost or swapped in TUI`);
  }
  assert.match(text, new RegExp(`bugfix_score_v2: ${parsed.bugfix_score_v2}(?!\\d)`));
  assert.doesNotMatch(text, /NaN|undefined/);
});

function git(dir, ...args) {
  return execFileSync("git", ["-c", "user.email=tui@example.com", "-c", "user.name=TUI", ...args], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}

function configureTool(dir) {
  return createBugfixModeTool({
    assertModeActive: () => undefined,
    validateWorkDir: () => null,
    resolveWorkDir: (cwd) => cwd,
    campaignBlocksOrdinaryLoop: async () => false,
    campaignBlockedResponse: () => ({ content: [{ type: "text", text: "blocked" }], details: {} }),
    researchBlocksOrdinaryLoop: async () => false,
    researchBlockedResponse: () => ({ content: [{ type: "text", text: "blocked" }], details: {} }),
    execBashScript: async (args, options) => {
      try {
        const stdout = execFileSync("bash", args, {
          cwd: options?.cwd ?? dir, encoding: "utf8", timeout: options?.timeout ?? 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (error) {
        return {
          stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "",
          code: error.status ?? 1, killed: false,
        };
      }
    },
    scorerFilePaths: [],
    measureCliPath: path.join(dir, "measure.mjs"),
    isBugfixMeasureCommand: () => true,
  });
}

function commitState(dir, tag, files) {
  for (const file of files) {
    const full = path.join(dir, file);
    if (file.startsWith("!")) rmSync(path.join(dir, file.slice(1)), { force: true });
    else writeFileSync(full, `${tag}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--allow-empty", "-qm", tag);
  git(dir, "tag", "-f", tag);
}

function readRows(dir, campaignId, name) {
  const file = path.join(dir, ".auto", "bugfix", campaignId, name);
  const raw = readFileSync(file, "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("full bugfix cycle keeps every phase in the log and shows real credits in the TUI", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bugfix-mode-tui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  commitState(dir, "base-state", []);
  commitState(dir, "good-state", ["detector.test"]);
  commitState(dir, "defect-state", ["!detector.test", "defect-marker"]);
  commitState(dir, "fixed-state", ["!defect-marker", "proof.test"]);
  commitState(dir, "counterfactual-state", ["!proof.test", "counter-marker"]);
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "preflight needs a clean tree");

  const pi = createFakePi({ dir, sessionId: "bugfix-tui", realGit: true });
  const ctx = makeCtx(dir, "bugfix-tui", pi);
  const tool = configureTool(dir);
  const campaignId = "tui-cycle";
  const invoke = (params) => tool.execute(
    "call", { campaignId, ...params }, undefined, undefined, ctx,
  );
  const logged = [];
  const invokeLogged = async (params) => {
    const result = await invoke(params);
    logged.push(result.content[0].text);
    return result;
  };

  const prepared = await invokeLogged({
    action: "prepare",
    config: {
      name: "bugfix_score_v2",
      testCommand: "true",
      testIdCommand: "test -f {test}",
      proofCommands: {
        good: "test -f detector.test", defect: "test -f detector.test",
        fixed: "test -f proof.test", counterfactual: "test -f proof.test",
      },
      scopePaths: ["."], baseRef: "base-state", baselineFail: 0, baselineTests: 10,
    },
  });
  const discovery = await invokeLogged({
    action: "record", phase: "discover", experimentId: "d1", defectId: "P1:alpha", severity: "P1",
    detectorTests: ["detector.test"],
    stateIds: { good: "good-state", defect: "defect-state" },
  });
  assert.deepEqual(discovery.details.detectorTests, ["detector.test"], "detector test must actually separate states");
  const discarded = await invokeLogged({ action: "decide", experimentId: "d1", status: "discard" });
  assert.equal(discarded.details.status, "discard");

  const afterDiscard = evaluateCredit(
    readRows(dir, campaignId, "evidence.jsonl"), readRows(dir, campaignId, "decisions.jsonl"),
  );
  assert.equal(afterDiscard.discoveryCount, 1, "discovery credit survives discard");
  assert.equal(afterDiscard.fixCount, 0, "discard gives no fix credit");
  assert.equal(afterDiscard.detectorTests, 1);

  const proof = await invokeLogged({
    action: "record", phase: "proof", experimentId: "f1", defectId: "P1:alpha", severity: "P1",
    proofTests: ["proof.test"],
    stateIds: { defect: "defect-state", fixed: "fixed-state", counterfactual: "counterfactual-state" },
  });
  assert.deepEqual(proof.details.proofTests, ["proof.test"], "proof test must actually separate states");
  const kept = await invokeLogged({ action: "decide", experimentId: "f1", status: "keep" });
  assert.equal(kept.details.status, "keep");

  const credit = evaluateCredit(
    readRows(dir, campaignId, "evidence.jsonl"), readRows(dir, campaignId, "decisions.jsonl"),
  );
  assert.equal(credit.discoveryCount, 1);
  assert.equal(credit.fixCount, 1);
  assert.equal(credit.detectorTests, 1);
  assert.equal(credit.proofTests, 1);
  const stored = JSON.parse(readFileSync(path.join(dir, ".auto", "bugfix", campaignId, "config.json"), "utf8"));
  const score = computeBugfixScore({
    config: stored.config,
    summary: { tests: 10, pass: 10, fail: 0, skipped: 0 },
    credit,
    changedLines: 0,
    scorerChanged: 0,
  });
  assert.equal(score.discoveryCredit, 3.33);
  assert.equal(score.fixCredit, 6.67);
  assert.equal(score.detectorTests, 1);
  assert.equal(score.proofTests, 1);
  assert.ok(Number.isFinite(score.score), `score must be numeric, got ${score.score}`);

  const parsed = Object.fromEntries(formatMetricLines(score).map((line) => {
    const match = /^METRIC ([A-Za-z0-9_]+)=(.*)$/.exec(line);
    return [match[1], Number(match[2])];
  }));
  const dashboard = renderDashboardLines(state([{
    commit: "final", metric: score.score, metrics: parsed,
    status: "keep", description: "bugfix cycle", timestamp: "final", segment: 0,
  }]), 180, th).join("\n");
  assert.match(dashboard, new RegExp(`discovery_credit: ${score.discoveryCredit}(?!\\d)`));
  assert.match(dashboard, new RegExp(`fix_credit: ${score.fixCredit}(?!\\d)`));
  assert.match(dashboard, new RegExp(`detector_tests: ${score.detectorTests}(?!\\d)`));
  assert.match(dashboard, new RegExp(`proof_tests: ${score.proofTests}(?!\\d)`));

  // The harness does not auto-append tool results to pi.sentMessages; the complete
  // reply sequence is the canonical TUI log for this tool, so assert none is dropped.
  assert.equal(logged.length, 5);
  for (const [index, marker] of [
    [0, /prepared/i], [1, /discovery credit is paid now/i], [2, /discard recorded/i],
    [3, /fix credit becomes durable/i], [4, /keep recorded/i],
  ]) {
    assert.match(logged[index], marker, `phase ${index} lost from tool log`);
  }
  assert.match(prepared.content[0].text, /execution mode|prepared/i);
  assert.match(kept.content[0].text, /durable credit/i);

  const refused = await invoke({ action: "decide", experimentId: "no-proof", status: "keep" });
  assert.match(refused.content[0].text, /❌/);
  assert.ok(refused.details.refusal ?? refused.details.reason, "refusal reason is retained");
  assert.equal(evaluateCredit(
    readRows(dir, campaignId, "evidence.jsonl"), readRows(dir, campaignId, "decisions.jsonl"),
  ).fixCount, 1, "refused keep does not create a second fix credit");
});
