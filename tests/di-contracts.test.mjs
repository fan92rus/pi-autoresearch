/**
 * bd tj0.10 — DI contracts:
 *  - test hooks are resolved per fake-pi instance, never last-writer-wins;
 *  - every adapter collaborator is a getter function read at call time;
 *  - same-named council/state helpers keep their distinct contracts (pin).
 *
 * Run:
 *   timeout 120 node --experimental-strip-types --env-file=./tests/test.env \
 *     --experimental-loader ./tests/redirect-loader.mjs --test tests/di-contracts.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as testHooks from "../extensions/pi-autoresearch/test-hooks.ts";
import {
  closeStaleCampaign,
  runtimeForTest,
} from "../extensions/pi-autoresearch/index.ts";
import { createOptimizeBriefTool } from "../extensions/pi-autoresearch/brief-tools.ts";
import { writeOptimizeBriefDraft } from "../extensions/pi-autoresearch/optimize-brief.ts";
import { createRunExperimentTool } from "../extensions/pi-autoresearch/run-experiment-tool.ts";
import { createLogExperimentTool } from "../extensions/pi-autoresearch/log-experiment-tool.ts";
import { parseVerdicts as parseDelegationVerdicts } from "../extensions/pi-autoresearch/council-delegation.ts";
import { parseVerdicts as parseBlackboardVerdicts } from "../extensions/pi-autoresearch/council-tools.ts";
import * as candidateState from "../extensions/pi-autoresearch/candidate-state.ts";
import * as researchState from "../extensions/pi-autoresearch/research-state.ts";

const extensionUrl = pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href;
const { default: autoresearchExtension } = await import(extensionUrl);
const textOf = (res) => res?.content?.[0]?.text ?? "";

test("two fake-pi instances in one process resolve their own hooks and runtime", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "di-hooks-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "di-hooks-b-"));
  const a = createFakePi({ dir: dirA, sessionId: "di-a", realGit: false });
  const b = createFakePi({ dir: dirB, sessionId: "di-b", realGit: false });
  const ctxA = makeCtx(dirA, "di-a", a.pi);
  const ctxB = makeCtx(dirB, "di-b", b.pi);
  autoresearchExtension(a.pi);
  autoresearchExtension(b.pi); // the later instance must NOT steal A's hooks
  const hooksA = testHooks.testHookRegistry.forPi(a.pi);
  const hooksB = testHooks.testHookRegistry.forPi(b.pi);

  assert.ok(hooksA && hooksB);
  assert.notEqual(hooksA, hooksB, "each extension instance owns its hooks object");
  assert.equal(testHooks.testHookRegistry.forContext(ctxA), hooksA);
  assert.equal(testHooks.testHookRegistry.forContext(ctxB), hooksB);

  const rtA = runtimeForTest(ctxA);
  const rtB = runtimeForTest(ctxB);
  assert.notEqual(rtA, rtB, "per-ctx accessor must not return the last-bound runtime");
  assert.equal(rtA, hooksA.getRuntime(ctxA));
  assert.equal(rtB, hooksB.getRuntime(ctxB));
  rtA.uiMode = "expedition";
  assert.notEqual(rtB.uiMode, "expedition", "mutating one runtime leaves the other untouched");

  // No-ctx accessor with an explicit per-instance target: each call reaches its own hook.
  const calls = [];
  const originalA = hooksA.closeStaleCampaign;
  hooksA.closeStaleCampaign = async (dir) => { calls.push(["A", dir]); return originalA(dir); };
  try {
    await closeStaleCampaign("campaign-A", a.pi);
    await closeStaleCampaign("campaign-B", b.pi);
    assert.deepEqual(calls, [["A", "campaign-A"]], "B's call must not use A's hook");
  } finally {
    hooksA.closeStaleCampaign = originalA;
  }
});

test("getter-only adapter deps follow a mutable late binding", async () => {
  // Every collaborator is a thunk: no plain snapshot can be frozen at creation.
  const gate = () => async () => undefined;
  const shared = () => undefined;
  const makeDeps = () => ({
    assertModeActive: gate,
    autoresearchChecksPath: shared,
    autoresearchJsonlPath: shared,
    autoresearchScriptPath: shared,
    campaignBlockedResponse: shared,
    campaignBlocksOrdinaryLoop: shared,
    execBashScript: shared,
    formatElapsed: shared,
    getRuntime: shared,
    isAutoresearchShCommand: shared,
    isBugfixCampaignMeasureCommand: shared,
    optimizeNotStartedGate: shared,
    overlayTui: () => null,
    parseMetricLines: shared,
    readExperimentMaxMinutes: shared,
    readLedgerMaxRun: shared,
    readRunAnalysisConfig: shared,
    researchBlockedResponse: shared,
    researchBlocksOrdinaryLoop: shared,
    resolveWorkDir: shared,
    tryBeginRunIdentity: shared,
    tryRecordPendingMarker: shared,
    updateWidget: shared,
    validateWorkDir: shared,
    writeRunStartedMarkerWithPrefix: shared,
    EXPERIMENT_MAX_LINES: () => 10,
    EXPERIMENT_MAX_BYTES: () => 4096,
    RunParams: () => ({ type: "object" }),
  });
  const runDeps = makeDeps();
  assert.ok(Object.values(runDeps).every((v) => typeof v === "function"), "run deps are getter-only");
  let gateText = "first";
  runDeps.assertModeActive = () => () => ({ content: [{ type: "text", text: gateText }], details: {} });
  const runTool = createRunExperimentTool(runDeps);
  const ctx = makeCtx(os.tmpdir(), "di-deps", null);
  assert.match(textOf(await runTool.execute("id", {}, null, null, ctx)), /first/);
  gateText = "second";
  assert.match(textOf(await runTool.execute("id", {}, null, null, ctx)), /second/, "execute re-reads the getter");

  // Overlay TUI is a mutable late-bound object, not a snapshot captured at factory time.
  let overlay = null;
  const renders = [];
  const logDeps = {
    LogParams: () => ({ type: "object" }),
    overlayTui: () => overlay,
    assertModeActive: () => () => ({ content: [{ type: "text", text: "gate" }], details: {} }),
  };
  assert.ok(Object.values(logDeps).every((v) => typeof v === "function"), "log deps are getter-only");
  const logTool = createLogExperimentTool(logDeps);
  assert.match(textOf(await logTool.execute("id", {}, null, null, ctx)), /gate/);
  overlay = { requestRender: () => renders.push(1) };
  assert.equal(renders.length, 0, "creating the tool never froze the overlay snapshot");

  // Brief tool render reads the mutable brief dir through its getter on every render.
  let briefDir = null;
  const briefTool = createOptimizeBriefTool({
    optimizeBriefDir: () => briefDir,
    setOptimizeBriefDir: (dir) => { briefDir = dir; },
  });
  assert.match(briefTool.renderCall({ action: "propose" }, null, null).content, /не было optimize_brief draft/);
  const lateDir = fs.mkdtempSync(path.join(os.tmpdir(), "di-brief-late-"));
  const written = writeOptimizeBriefDraft(lateDir, { name: "late-binding", metric_name: "ms" });
  assert.equal(written.ok, true);
  briefDir = lateDir; // mutable binding in the test stands in for index.ts's let
  assert.match(briefTool.renderCall({ action: "propose" }, null, null).content, /late-binding/, "render re-reads the brief dir");
});

test("same-named helpers keep distinct contracts (pins)", async () => {
  const body = "VERDICT H-A1: accept — because the metric held\nVERDICT H-B2: refine - rerun with fresh data";
  assert.deepEqual(parseDelegationVerdicts(body, " Analyst "), [
    { id: "H-A1", verdict: "accept", speaker: " Analyst " },
    { id: "H-B2", verdict: "refine", speaker: " Analyst " },
  ]);
  assert.deepEqual(parseBlackboardVerdicts(body, "analyst"), [
    { hypothesisId: "H-A1", verdict: "accept", reason: "because the metric held", by: "analyst" },
    { hypothesisId: "H-B2", verdict: "refine", reason: "rerun with fresh data", by: "analyst" },
  ]);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "di-pending-pin-"));
  const candidateDir = path.join(cwd, "candidate");
  const researchDir = path.join(cwd, ".auto", "research", "r1");
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.mkdirSync(researchDir, { recursive: true });
  const candidateWrong = await candidateState.manualResolvePendingOp(candidateDir, "yes");
  const researchWrong = await researchState.manualResolvePendingOp(researchDir, "yes");
  assert.equal(candidateWrong.reason, "invalid_argument");
  assert.equal(researchWrong.reason, "invalid_argument");
  assert.equal(candidateWrong.message, "this operator action needs the explicit operator confirmation token");
  assert.equal(researchWrong.message, "manual resolution requires the operator confirmation token");
  const candidateMissing = await candidateState.manualResolvePendingOp(candidateDir, candidateState.OPERATOR_CONFIRMATION);
  const researchMissing = await researchState.manualResolvePendingOp(researchDir, researchState.OPERATOR_CONFIRMATION);
  assert.equal(candidateMissing.reason, "invalid_transition");
  assert.equal(researchMissing.reason, "invalid_transition");

  const marker = JSON.stringify({ name: "operator-check", started_at: "t" });
  fs.writeFileSync(path.join(candidateDir, candidateState.PENDING_OP_FILE), marker);
  fs.writeFileSync(path.join(researchDir, researchState.PENDING_OP_FILE), marker);
  const candidateOk = await candidateState.manualResolvePendingOp(candidateDir, candidateState.OPERATOR_CONFIRMATION);
  const researchOk = await researchState.manualResolvePendingOp(researchDir, researchState.OPERATOR_CONFIRMATION);
  assert.equal(candidateOk.ok, true);
  assert.equal(researchOk.ok, true);
  assert.match(candidateOk.message, /state\.json was left as last written/);
  assert.match(researchOk.message, /the marker is cleared, state\.json is untouched/);
});

test("empty and bare-dash verdict reasons do not swallow the next VERDICT line", () => {
  const cases = [
    {
      body: "VERDICT H-F6: reject\r\nVERDICT H-G7: refine",
      expected: [
        { id: "H-F6", verdict: "reject", reason: "" },
        { id: "H-G7", verdict: "refine", reason: "" },
      ],
    },
    {
      body: "VERDICT H-L3: accept —\nVERDICT H-M4: reject —  spaced reason",
      expected: [
        { id: "H-L3", verdict: "accept", reason: "" },
        { id: "H-M4", verdict: "reject", reason: "spaced reason" },
      ],
    },
  ];
  for (const { body, expected } of cases) {
    assert.deepEqual(
      parseDelegationVerdicts(body, "analyst"),
      expected.map(({ id, verdict }) => ({ id, verdict, speaker: "analyst" })),
    );
    const blackboard = parseBlackboardVerdicts(body, "analyst");
    assert.deepEqual(
      blackboard,
      expected.map(({ id, verdict, reason }) => ({ hypothesisId: id, verdict, reason, by: "analyst" })),
    );
    for (const v of blackboard) {
      assert.doesNotMatch(v.reason, /VERDICT/, "reason must not contain the following VERDICT line");
    }
  }
});
