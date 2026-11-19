/**
 * bd tj0.8: one inspection/refusal vocabulary across candidate, research and
 * loop gates, generated tool vocabularies and checked finding references.
 *
 * Run with the shared test loader (TS stripping is required for the modules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalRefusalReason,
  inspectionRefusalReason,
  refusalDetails,
} from "../extensions/pi-autoresearch/refusal.ts";
import * as candidateState from "../extensions/pi-autoresearch/candidate-state.ts";
import {
  FINDING_STATUSES,
  FINDING_TRANSITIONS,
  recordFinding,
} from "../extensions/pi-autoresearch/findings.ts";
import {
  findingStatusAndTransitionsDescription,
  findingStatusDescription,
  findingTransitionsDescription,
  registerFindingsTools,
} from "../extensions/pi-autoresearch/findings-tools.ts";
import {
  measurementJustificationProblem,
  registerMeasurementTools,
} from "../extensions/pi-autoresearch/measurement-tools.ts";
import { createFakePi, createHarness, makeCtx } from "./fake-pi.ts";

function makeDir(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ar-tj08-${label}-`));
  return root;
}

function policy() {
  return {
    metric_name: "p95_ms",
    candidate_step_limit: 3,
    candidate_time_limit_seconds: 100,
    benchmark_argv: ["node", "bench.js"],
  };
}

/** A minimal tool-registration collector for the DI adapters. */
function toolCollector() {
  const tools = new Map();
  return {
    pi: { registerTool(tool) { tools.set(tool.name, tool); } },
    tool(name) { return tools.get(name); },
  };
}

const toolDeps = (dir) => ({
  assertModeActive: () => undefined,
  validateWorkDir: () => null,
  resolveWorkDir: () => dir,
});

const ctxFor = (dir, pi) => makeCtx(dir, "tj08", pi);

test("one mapper covers both inspection vocabularies and existing refusal reasons only", () => {
  const expected = new Map([
    ["ready", null],
    ["uninitialized", "not_initialized"],
    ["state_unreadable", "state_unreadable"],
    ["manual_check_required", "manual_check_required"],
    ["invalid_argument", "invalid_argument"],
    // Candidate-only status: conservative existing reason, no new literal.
    ["disabled", "manual_check_required"],
    ["future_status", null],
  ]);
  for (const [status, reason] of expected) {
    assert.equal(inspectionRefusalReason(status), reason, status);
  }
  // Tool-level reasons keep their existing canonical spelling; anything
  // outside both vocabularies falls back to an existing conservative reason.
  assert.equal(canonicalRefusalReason("campaign_disabled"), "campaign_disabled");
  assert.equal(canonicalRefusalReason("evidence_gate_blocked"), "evidence_gate_blocked");
  assert.equal(canonicalRefusalReason("not_an_expedition"), "operation_failed");
  assert.deepEqual(refusalDetails("disabled"), { refusal_reason: "manual_check_required" });
});

test("candidate inspection carries a refusal_reason and refuses an uncontained directory", async () => {
  const root = makeDir("candidate-inspection");
  try {
    const dir = path.join(root, "candidate");
    await candidateState.initCampaign(dir, policy());

    assert.equal((await candidateState.inspectCampaign(dir)).status, "ready");
    assert.equal((await candidateState.inspectCampaign(dir)).refusal_reason, null);

    await candidateState.disableCampaign(dir);
    let insp = await candidateState.inspectCampaign(dir);
    assert.equal(insp.status, "disabled");
    assert.equal(insp.refusal_reason, "manual_check_required");

    await candidateState.manualResolvePendingOp(dir, candidateState.OPERATOR_CONFIRMATION).catch(() => undefined);
    fs.writeFileSync(path.join(dir, candidateState.PENDING_OP_FILE), JSON.stringify({ name: "probe", started_at: "" }));
    insp = await candidateState.inspectCampaign(dir);
    assert.equal(insp.status, "manual_check_required");
    assert.equal(insp.refusal_reason, "manual_check_required");
    fs.rmSync(path.join(dir, candidateState.PENDING_OP_FILE));

    fs.writeFileSync(path.join(dir, candidateState.STATE_FILE), "{broken");
    insp = await candidateState.inspectCampaign(dir);
    assert.equal(insp.status, "state_unreadable");
    assert.equal(insp.refusal_reason, "state_unreadable");

    fs.rmSync(path.join(dir, candidateState.STATE_FILE));
    insp = await candidateState.inspectCampaign(dir);
    assert.equal(insp.status, "uninitialized");
    assert.equal(insp.refusal_reason, "not_initialized");

    // A valid state file OUTSIDE the campaign directory must not be inspected.
    const outside = path.join(root, "not-a-campaign");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, candidateState.STATE_FILE), JSON.stringify({
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      disabled: false,
      policy: policy(),
      candidates: [],
    }));
    const before = fs.readFileSync(path.join(outside, candidateState.STATE_FILE), "utf8");
    insp = await candidateState.inspectCampaign(outside);
    assert.equal(insp.status, "invalid_argument");
    assert.equal(insp.refusal_reason, "invalid_argument");
    assert.equal(insp.state, null);
    assert.equal(fs.readFileSync(path.join(outside, candidateState.STATE_FILE), "utf8"), before);
    const bad = await candidateState.inspectCampaign("");
    assert.equal(bad.status, "invalid_argument");
    assert.equal(bad.refusal_reason, "invalid_argument");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status and transition descriptions are generated from the exported constants", async () => {
  const statusText = findingStatusDescription();
  const transitionText = findingTransitionsDescription();
  for (const status of FINDING_STATUSES) assert.ok(statusText.includes(status), `status ${status}`);
  for (const [from, targets] of Object.entries(FINDING_TRANSITIONS)) {
    assert.ok(transitionText.includes(`${from}→${targets.join("|")}`), `${from}→${targets.join("|")}`);
  }

  const { pi, tool } = toolCollector();
  registerFindingsTools(pi, toolDeps(makeDir("findings-description")));
  assert.equal(tool("update_finding")?.name, "update_finding");
  assert.equal(findingStatusAndTransitionsDescription(), `${statusText} Transitions are restricted (${transitionText}).`);

  // Changing the constants changes both the generator and a freshly built tool schema.
  const originalStatus = FINDING_STATUSES[0];
  const originalTargets = [...FINDING_TRANSITIONS.open];
  try {
    FINDING_STATUSES[0] = "opened";
    FINDING_TRANSITIONS.open.push("opened");
    const changed = toolCollector();
    registerFindingsTools(changed.pi, toolDeps(makeDir("findings-description-changed")));
    assert.equal(changed.tool("update_finding")?.name, "update_finding");
    const description = findingStatusAndTransitionsDescription();
    assert.match(description, /opened/);
    assert.match(description, /open→verified\|revised\|deferred\|opened/);
    assert.equal(findingStatusDescription().includes("opened"), true);
    assert.equal(findingTransitionsDescription().includes("open→verified|revised|deferred|opened"), true);
  } finally {
    FINDING_STATUSES[0] = originalStatus;
    FINDING_TRANSITIONS.open.splice(originalTargets.length);
  }
});

test("measurement-change justification checks finding existence and theme; free text still works", async () => {
  const dir = makeDir("measurement-justification");
  try {
    const evidence = ".auto/runs/1/output.txt";
    fs.mkdirSync(path.join(dir, path.dirname(evidence)), { recursive: true });
    fs.writeFileSync(path.join(dir, evidence), "MISMATCH gold=заместитель pred=зампред\n");
    const behavior = await recordFinding(dir, {
      theme: "behavior",
      description: "behavior finding",
      evidence_ref: `${evidence}:1`,
    });
    assert.equal(behavior.ok, true);
    const behaviorId = behavior.value.id;
    const measurement = await recordFinding(dir, {
      theme: "measurement",
      description: "measurement finding",
      evidence_ref: `${evidence}:1`,
    });
    assert.equal(measurement.ok, true);
    const measurementId = measurement.value.id;

    assert.match(measurementJustificationProblem(dir, "f999") ?? "", /f999/);
    assert.match(measurementJustificationProblem(dir, behaviorId) ?? "", /measurement/);
    assert.equal(measurementJustificationProblem(dir, measurementId), null);
    assert.equal(measurementJustificationProblem(dir, "because the timer drifted"), null);

    const { pi, tool } = toolCollector();
    registerMeasurementTools(pi, toolDeps(dir));
    const ctx = ctxFor(dir, pi);
    const bad = await tool("log_measurement_change").execute("id", { justification: behaviorId }, null, null, ctx);
    assert.match(bad.content[0].text, /log_measurement_change rejected/);
    assert.equal(bad.details.refusal_reason, "invalid_argument");
    assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);

    const stale = await tool("log_measurement_change").execute("id", { justification: "f999" }, null, null, ctx);
    assert.match(stale.content[0].text, /f999/);
    assert.equal(stale.details.refusal_reason, "invalid_argument");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gated tool fail() details carry a canonical refusal_reason", async () => {
  const dir = makeDir("tool-fail-details");
  try {
    const { tool, command, ctx } = await createHarness({ dir, realGit: false, sessionId: "tj08-tool-fail" });
    await command("autoresearch").handler("on", ctx);

    const candidate = await tool("candidate_branch").execute("id", { action: "create", candidate_id: "c1" }, null, null, ctx);
    assert.match(candidate.content[0].text, /⛔ uninitialized:/);
    assert.equal(candidate.details.reason, "uninitialized");
    assert.equal(candidate.details.refusal_reason, "not_initialized");

    const research = await tool("research_questions").execute("id", { action: "bogus" }, null, null, ctx);
    assert.equal(research.details.reason, "invalid_argument");
    assert.equal(research.details.refusal_reason, "invalid_argument");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary-loop gate rejects an invalid disabled candidate state with canonical details", async () => {
  const dir = makeDir("loop-gate");
  try {
    const { tool, command, ctx } = await createHarness({ dir, realGit: false, sessionId: "tj08-loop" });
    await command("autoresearch").handler("on", ctx);
    const campDir = path.join(dir, ".auto", "candidate");
    fs.mkdirSync(campDir, { recursive: true });
    // disabled:true alone used to release the loop; the policy makes the state
    // invalid, so the shared full validator must still block it.
    fs.writeFileSync(path.join(campDir, candidateState.STATE_FILE), JSON.stringify({
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      disabled: true,
      policy: { ...policy(), candidate_step_limit: 0 },
      candidates: [],
    }));

    const result = await tool("init_experiment").execute("id", {}, null, null, ctx);
    assert.match(result.content[0].text, /Candidate campaign active/);
    assert.equal(result.details.refusal_reason, "manual_check_required");

    // The research loop gate carries the same canonical refusal vocabulary.
    const researchDir = makeDir("research-loop-gate");
    const researchHarness = await createHarness({ dir: researchDir, realGit: false, sessionId: "tj08-research-loop" });
    await researchHarness.command("autoresearch").handler("on", researchHarness.ctx);
    const researchCampaign = path.join(researchDir, ".auto", "research", "r1");
    fs.mkdirSync(researchCampaign, { recursive: true });
    fs.writeFileSync(path.join(researchCampaign, "state.json"), JSON.stringify({
      schema_version: 1,
      campaign_id: "r1",
      created_at: "2026-01-01T00:00:00.000Z",
      phase: "research",
    }));
    const researchResult = await researchHarness.tool("init_experiment").execute("id", {}, null, null, researchHarness.ctx);
    assert.match(researchResult.content[0].text, /Research campaign active/);
    assert.equal(researchResult.details.refusal_reason, "manual_check_required");
    fs.rmSync(researchDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
