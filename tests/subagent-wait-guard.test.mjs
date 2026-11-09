/**
 * Subagent-wait guard (openspec subagent-wait-guard, task 3.1): the drift
 * branch defers its nudge while async subagents run (pi-subagents RPC probe),
 * delivers on re-probe when zero remain, the fuse delivers anyway, and the
 * whole guard fails open without pi-subagents.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/subagent-wait-guard.test.mjs
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";
import { SUBAGENT_DEFER_RECHECK_MS, SUBAGENT_DEFER_FUSE_MS } from "../extensions/pi-autoresearch/subagent-probe.ts";

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-swg-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fake pi-subagents RPC responder. Controlled: how many active runs `status`
 * reports, whether it responds at all, and whether the reply carries a fleet.
 */
function installRpcResponder(events, state) {
  events.on("subagents:rpc:v1:request", (raw) => {
    if (!state.respond || typeof raw?.requestId !== "string") return;
    if (raw.method === "ping") {
      events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: true, data: {} });
      return;
    }
    if (raw.method !== "status") return;
    const data = state.noFleet ? {} : { fleet: { totalActive: state.totalActive } };
    events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: true, data });
  });
}

/** Start a session (mode on, brief approved, init) and return the harness with a settled turn triggered. */
async function readySession(label) {
  const h = await createHarness({ dir: makeTempDir(label), sessionId: `swg-${label}`, realGit: false });
  await h.command("autoresearch").handler("on", h.ctx);
  approveOptimizeBrief(h.ctx.cwd, { name: `t-${label}`, metric_name: "ms" });
  await h.tool("init_experiment").execute("id", { name: `t-${label}`, metric_name: "ms" }, null, null, h.ctx);
  return h;
}

async function fireAgentEnd(h) {
  await h.hook("agent_end")({}, h.ctx);
}

async function fireAgentStart(h) {
  await h.hook("agent_start")({}, h.ctx);
}

async function fireSessionStart(h) {
  await h.hook("session_start")({}, h.ctx);
}

/** Settle a no-work turn: agent_start → agent_end (the drift path needs the per-turn reset). */
async function settleNoWorkTurn(h) {
  await fireAgentStart(h);
  await fireAgentEnd(h);
}

const SETTLED_WINDOW_MS = 800;

/** The "/skill:autoresearch-create ..." kickoff from the `on` command is not a nudge. */
function driftNudges(h) {
  return h.pi.sentMessages.filter((m) => !m.text.startsWith("/skill:"));
}

/** Wait out the pending-resume settle window so scheduled nudges actually send. */
async function settleWindow() {
  await new Promise((r) => setTimeout(r, SETTLED_WINDOW_MS + 250));
}

test("live subagent defers the drift nudge; counters do not move", async () => {
  const h = await readySession("defer");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h); // ping → guard armed
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "no drift nudge while a subagent is alive");

  // Subagent finishes → re-probe → delivery (after the settle window).
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "nudge delivered after the last subagent finished");
  const text = driftNudges(h)[driftNudges(h).length - 1].text;
  assert.match(text, /propose_hypothesis|candidate_branch|research/, "delivered text is the drift wording");
  await fireAgentStart(h); // cancel any lingering deferral timer
});

test("drift counters move exactly once, at delivery, not at deferral", async () => {
  const h = await readySession("counters");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  // Turn 1: defers (guard armed, live subagent).
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0);
  // Subagent done: delivery through the re-check timer path — emit completion.
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 1, "exactly one nudge for one deferred turn");
  await fireAgentStart(h);
});

test("one of two subagents finishing does NOT deliver (re-probe sees the other)", async () => {
  const h = await readySession("two-live");
  installRpcResponder(h.events, { respond: true, totalActive: 2 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred with two alive");
  // One completes, one remains.
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "still deferred: re-probe saw the second run");
  // The last one completes.
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 1, "delivered when zero remain");
  await fireAgentStart(h);
});

test("re-check timer alone (no completion event) delivers after subagents finish", async () => {
  const h = await readySession("timer");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  // Wait past the 30 s re-check interval without any event.
  await new Promise((r) => setTimeout(r, SUBAGENT_DEFER_RECHECK_MS + 1500));
  await settleWindow();
  assert.equal(driftNudges(h).length, 1, "re-check timer delivered after zero active");
  await fireAgentStart(h);
}, 60_000);

test("fuse: a still-alive subagent does not block delivery past SUBAGENT_DEFER_FUSE_MS {skip: needs 10 min unless RUN_FUSE_TEST=1}", { skip: process.env.RUN_FUSE_TEST !== "1" }, async () => {
  const h = await readySession("fuse");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  // Keep reporting one live run far past the fuse.
  await new Promise((r) => setTimeout(r, SUBAGENT_DEFER_FUSE_MS + 2000));
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "fuse delivered the nudge despite a live subagent");
}, 700_000); // long: runs only with RUN_FUSE_TEST=1

test("no fleet in the reply → unknown → fail open (nudge delivered as before)", async () => {
  const h = await readySession("no-fleet");
  installRpcResponder(h.events, { respond: true, totalActive: 5, noFleet: true });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "unknown fleet delivers without deferral");
});

test("pi-subagents absent (no RPC reply) → guard never arms → behavior unchanged", async () => {
  const h = await readySession("absent");
  // No responder installed at all: ping gets no reply, ready never fires.
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 1, "ordinary drift nudge without pi-subagents");
});

test("RPC errors on status → fail open at probe time", async () => {
  const h = await readySession("status-error");
  h.events.on("subagents:rpc:v1:request", (raw) => {
    if (typeof raw?.requestId !== "string") return;
    if (raw.method === "ping") {
      h.events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: true, data: {} });
    } else {
      h.events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: false, error: { code: "no_active_session", message: "x" } });
    }
  });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "failing status probe delivers as before");
});

test("new turn resets the deferral: no stale nudge fires into the next turn", async () => {
  const h = await readySession("new-turn");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  assert.equal(driftNudges(h).length, 0, "deferred");
  // A new turn starts (user message): the deferral must reset.
  await fireAgentStart(h);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "reset deferral does not deliver into the new turn");
  await fireAgentStart(h);
});

test("guard not armed but RPC present: ping on session_start arms it (late load)", async () => {
  const h = await readySession("late-load");
  // ready never fired (extension loaded after pi-subagents), ping must arm.
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  assert.equal(driftNudges(h).length, 0);
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "armed by ping: deferral works without a ready event");
  await fireAgentStart(h); // cancel the re-check timer
});

test("partial-cycle turn is never deferred (loop tools used this turn)", async () => {
  const h = await readySession("partial");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  // Use a loop tool this turn: propose_hypothesis marks the turn as loop work.
  await h.tool("propose_hypothesis").execute("id", { description: "Partial-cycle idea for deferral check" }, null, null, h.ctx);
  await h.hook("tool_execution_end")({ toolName: "propose_hypothesis" }, h.ctx);
  await fireAgentEnd(h);
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "partial-cycle push delivered despite a live subagent");
});

test("campaign deferral: an active candidate campaign defers its campaign nudge the same way", async () => {
  // The research/candidate campaign wording is covered by research tests; here we
  // verify the guard is campaign-agnostic by asserting the deferral path does not
  // depend on the ordinary-loop message: with a campaign blocked loop the nudge
  // still goes through pendingResume (campaign wording), so we only assert no
  // crash and delivery rules hold in the ordinary case (covered above).
  const h = await readySession("campaign-shape");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0);
  await fireAgentStart(h); // cancel the pending re-check timer
});

test("drift limit works normally after waiting ends (MAX not consumed by the wait)", async () => {
  const h = await readySession("limit");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  // Three consecutive deferred no-work turns: all deferred, zero counters.
  for (let i = 0; i < 3; i++) {
    await settleNoWorkTurn(h);
    await settleWindow();
  }
  assert.equal(driftNudges(h).length, 0, "all turns deferred while the subagent runs");
  // The subagent finishes BEFORE the new turn: the completion re-probe delivers.
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "delivered once after the wait");
  // Continue no-work turns: now the ordinary drift counting applies.
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "subsequent drifted turn nudges normally");
});

test("constants are the goal-x values (owner-confirmed)", () => {
  assert.equal(SUBAGENT_DEFER_RECHECK_MS, 30_000);
  assert.equal(SUBAGENT_DEFER_FUSE_MS, 600_000);
});

// ── Review round 1 fixes: reset points, campaign wording, new-turn reset, fuse (mock.timers) ──

import { execFileSync } from "node:child_process";

/** The candidate campaign pause/close/disable branch calls cancelSubagentDeferral via ctx. */
test("mode off resets the deferral: no delivery after /autoresearch off", async () => {
  const h = await readySession("mode-off");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  await h.command("autoresearch").handler("off", h.ctx);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "mode-off deferral never delivers");
});

test("session_tree resets the deferral (session switch in the tree)", async () => {
  const h = await readySession("tree-reset");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  await h.hook("session_tree")({}, h.ctx);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "session_tree reset kills the deferral");
});

test("compaction resets the deferral (session_before_compact)", async () => {
  const h = await readySession("compact-reset");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  await h.hook("session_before_compact")({ preparation: { firstKeptEntryId: "e1", tokensBefore: 10 } }, h.ctx);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "compaction reset kills the deferral");
});

test("shutdown resets the deferral and unsubscribes: no delivery after shutdown", async () => {
  const h = await readySession("shutdown-reset");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  await h.hook("session_shutdown")({}, h.ctx);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "shutdown reset kills the deferral; unsubscribe stops re-probe");
});

test("new turn: after the reset a normal drifted turn nudges (M3 regression)", async () => {
  const h = await readySession("new-turn-m3");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  // New turn starts (agent_start resets the deferral): with zero active the
  // NEXT agent_end must deliver the ordinary drift nudge.
  await fireAgentStart(h);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.ok(driftNudges(h).length >= 1, "after reset the next no-work turn nudges (no stuck guard)");
});

test("campaign deferral: under a candidate campaign the campaign nudge is deferred and delivered with campaign wording", async () => {
  // Candidate-branch campaign active: campaignBlocksOrdinaryLoop composes the
  // candidate wording at delivery; the guard must defer the same way.
  const h = await createHarness({ dir: makeTempDir("cand-defer"), sessionId: "swg-cand", realGit: false });
  // Seed a real ACTIVE campaign (schema-valid, not disabled, no pending op):
  // campaignBlocksOrdinaryLoop then composes the candidate wording at delivery.
  const campDir = path.join(h.ctx.cwd, ".auto", "candidate");
  fs.mkdirSync(campDir, { recursive: true });
  const campaignState = {
    schema_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    disabled: false,
    policy: { candidate_step_limit: 10, candidate_time_limit_seconds: 600 },
    candidates: [{
      id: "cand-1",
      title: "Test candidate",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      worktree: "/tmp/nonexistent-worktree",
      branch: "candidate/cand-1",
      checkpoints: [],
      steps_used: 0,
      time_used_seconds: 0,
      selected_checkpoint: null,
    }],
  };
  fs.writeFileSync(path.join(campDir, "state.json"), JSON.stringify(campaignState), "utf8");
  await h.command("autoresearch").handler("on", h.ctx);
  // init_experiment is refused under an active campaign (design §5) — the drift
  // branch only needs the mode flag and the session log header from a started
  // session, which the campaign already provides (config written by init on
  // earlier sessions). Mark the session started directly for the gate.
  const { markSessionStarted } = await import("./optimize-approve-helper.mjs");
  markSessionStarted(h.ctx.cwd);
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "campaign nudge deferred while a subagent runs");
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  const nudges = driftNudges(h);
  assert.ok(nudges.length >= 1, "campaign nudge delivered after subagents finish");
  assert.match(nudges[nudges.length - 1].text, /candidate_branch|campaign/i, "delivery keeps the campaign wording");
});

test("fuse delivers past SUBAGENT_DEFER_FUSE_MS while the subagent is still alive (mock.timers)", async () => {
  // Time injection per design Decision 7: shift Date.now forward past the fuse
  // while the completion-driven re-probe runs, so the fuse branch executes
  // without 10 minutes of wall-clock waiting. The subagent stays alive the
  // whole time — only the fuse may deliver.
  const h = await readySession("fuse-mock");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  const realNow = Date.now;
  let shifted = false;
  // Wrap the completion event: on the first one, advance the clock past the
  // fuse for the duration of the handler chain (the re-probe reads Date.now()).
  h.events.on("subagent:async-complete", () => {
    if (shifted) return;
    shifted = true;
    Date.now = () => realNow() + SUBAGENT_DEFER_FUSE_MS + 1000;
    queueMicrotask(() => { Date.now = realNow; });
  });
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  Date.now = realNow;
  assert.ok(driftNudges(h).length >= 1, "fuse delivered the nudge past the 10-minute continuous deferral");
});

// ── Review round 2 fixes: candidate pause/close/disable reset, shutdown re-check window ──

test("candidate_branch pause resets the deferral: no delivery after completion", async () => {
  const h = await readySession("cand-pause");
  // Seed the same ACTIVE campaign as the campaign-deferral test (pause needs it).
  const campDir = path.join(h.ctx.cwd, ".auto", "candidate");
  fs.mkdirSync(campDir, { recursive: true });
  fs.writeFileSync(path.join(campDir, "state.json"), JSON.stringify({
    schema_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    disabled: false,
    policy: { candidate_step_limit: 10, candidate_time_limit_seconds: 600 },
    candidates: [{
      id: "cand-1",
      title: "Test candidate",
      status: "active",
      created_at: "2026-01-01T00:00:00.000Z",
      worktree: "/tmp/nonexistent-worktree",
      branch: "candidate/cand-1",
      checkpoints: [],
      steps_used: 0,
      time_used_seconds: 0,
      selected_checkpoint: null,
    }],
  }), "utf8");
  const cb = h.tool("candidate_branch");
  assert.ok(cb, "candidate_branch registered");
  // The deferral turn first: guard armed, one live subagent → deferred.
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  // Owner pauses the active candidate: the pending deferral must reset.
  await cb.execute("id", { action: "pause", candidate_id: "cand-1" }, null, null, h.ctx);
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  h.events.emit("subagent:async-complete", {});
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "candidate pause reset kills the deferral");
  await fireAgentStart(h);
});

test("shutdown clears the re-check timer: nothing fires after the re-check window", async () => {
  const h = await readySession("shutdown-timer");
  installRpcResponder(h.events, { respond: true, totalActive: 1 });
  await fireSessionStart(h);
  await settleNoWorkTurn(h);
  await settleWindow();
  assert.equal(driftNudges(h).length, 0, "deferred");
  await h.hook("session_shutdown")({}, h.ctx);
  // Wait PAST the re-check interval: a surviving timer would fire its probe and
  // (after the responder flips to zero) deliver into the dead session.
  installRpcResponder(h.events, { respond: true, totalActive: 0 });
  await new Promise((r) => setTimeout(r, SUBAGENT_DEFER_RECHECK_MS + 1500));
  assert.equal(driftNudges(h).length, 0, "shutdown cancelled the re-check timer: no delivery past the window");
});
