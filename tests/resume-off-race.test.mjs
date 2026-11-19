/**
 * bd tj0.1 — resume races: stale drift nudges, persisted off markers, and
 * off fired while a resume is already in flight.
 *
 * Run:
 *   env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_PARENT_SESSION node --experimental-strip-types \
 *     --env-file=./tests/test.env --experimental-loader ./tests/redirect-loader.mjs \
 *     --test tests/resume-off-race.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createHarness, makeCtx } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";

const SETTLED_WINDOW_MS = 800;

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-resume-race-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const extensionModule = async () =>
  import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);

async function readySession(label) {
  const h = await createHarness({ dir: makeTempDir(label), sessionId: `resume-race-${label}`, realGit: false });
  await h.command("autoresearch").handler("on", h.ctx);
  approveOptimizeBrief(h.ctx.cwd, { name: `t-${label}`, metric_name: "ms" });
  await h.tool("init_experiment").execute("id", { name: `t-${label}`, metric_name: "ms" }, null, null, h.ctx);
  return h;
}

/** Kickoff messages are explicit user actions, not auto-resume nudges. */
const nudges = (h) => h.pi.sentMessages.filter((m) => !(m.text ?? "").startsWith("/skill:"));
const waitForDelivery = () => new Promise((resolve) => setTimeout(resolve, SETTLED_WINDOW_MS + 350));

test("productive turn after a pending drift nudge delivers no drift accusation and spends no drift budget", async () => {
  const h = await readySession("stale-drift");
  const runtime = (await extensionModule()).runtimeForTest(h.ctx);

  // Turn 1: no loop work → a drift nudge is queued for the settle window.
  await h.hook("agent_start")({}, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  assert.equal(runtime.pendingResumeIsDrift, true, "a drift nudge is pending");

  // Turn 2: a productive user turn starts before that timer fires.
  await h.hook("agent_start")({}, h.ctx);
  assert.equal(runtime.pendingResumeMessage, null, "the stale drift nudge is dropped at the turn boundary");

  runtime.experimentsThisSession = 1;
  await h.hook("tool_execution_end")({ toolName: "run_experiment" }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await waitForDelivery();

  const texts = nudges(h).map((m) => m.text);
  assert.ok(texts.some((t) => /Run the next iteration now/.test(t)), "the productive turn still gets its plain resume");
  assert.ok(!texts.some((t) => /Last turn (did no|used no)/i.test(t)), "no stale 'Last turn did no work' accusation");
  assert.equal(runtime.consecutiveDriftResumes, 0, "drift budget was not spent by the dropped nudge");
  assert.equal(runtime.pendingResumeIsDrift, false, "no drift tag survives into the new turn");
}, { timeout: 60000 });

test("a new turn preserves an explicit compaction resume", async () => {
  const h = await readySession("compact-keep");
  const runtime = (await extensionModule()).runtimeForTest(h.ctx);

  await h.hook("session_compact")({}, h.ctx);
  assert.ok(runtime.pendingResumeMessage, "compaction resume is pending");
  await h.hook("agent_start")({}, h.ctx);
  assert.ok(runtime.pendingResumeMessage, "compaction resume survives the turn boundary");
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await waitForDelivery();

  assert.ok(
    nudges(h).some((m) => /Do not re-read \.auto\/prompt\.md/.test(m.text)),
    "the explicit compaction resume is still delivered",
  );
}, { timeout: 60000 });

test("fresh session with a persisted off marker stays off; explicit /autoresearch on wins", async () => {
  const dir = makeTempDir("fresh-off");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), JSON.stringify({ type: "config", name: "t-fresh" }) + "\n");
  const h = await createHarness({ dir, sessionId: "fresh-off-1", realGit: false });
  const ext = await extensionModule();

  await h.hook("session_start")({}, h.ctx);
  assert.equal(ext.runtimeForTest(h.ctx).autoresearchMode, true, "control: a persisted log auto-activates without a marker");

  await h.command("autoresearch").handler("off", h.ctx);
  const marker = path.join(dir, ".auto", "autoresearch-off.json");
  assert.ok(fs.existsSync(marker), "off persists the marker");

  const freshCtx = makeCtx(dir, "fresh-off-2", h.pi);
  await h.hook("session_start")({}, freshCtx);
  assert.equal(ext.runtimeForTest(freshCtx).autoresearchMode, false, "a genuinely fresh session must not resurrect the loop");

  await h.command("autoresearch").handler("on", freshCtx);
  assert.equal(ext.runtimeForTest(freshCtx).autoresearchMode, true, "explicit on wins over the marker");
  assert.equal(fs.existsSync(marker), false, "explicit on clears the marker");
}, { timeout: 60000 });

test("a newer pending nudge replaces an in-flight sender instead of being cancelled by it", async () => {
  const h = await readySession("replacement-race");
  const ext = await extensionModule();
  const runtime = ext.runtimeForTest(h.ctx);

  await h.hook("agent_start")({}, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  assert.equal(runtime.pendingResumeIsDrift, true, "a drift nudge is scheduled");
  const staleText = runtime.pendingResumeMessage.text;
  const replacement = { mode: "legacy", text: "NEWER PENDING NUDGE" };

  let gatesEvaluated = false;
  let replacementFired = false;
  const racingCtx = Object.create(h.ctx);
  racingCtx.isIdle = () => {
    if (!replacementFired) {
      replacementFired = true;
      gatesEvaluated = true;
      runtime.pendingResumeMessage = replacement;
    }
    return h.ctx.isIdle();
  };

  await ext.sendPendingResumeIfReadyForTest(racingCtx, runtime);

  assert.ok(replacementFired, "replacement really fired inside the gate/send window");
  assert.equal(runtime.pendingResumeMessage, replacement, "the newer pending object survives the stale sender");
  assert.ok(!nudges(h).some((m) => m.text === staleText), "the stale drift nudge is not delivered");
  assert.equal(runtime.consecutiveDriftResumes, 0, "the stale sender does not spend the drift budget");
  await ext.sendPendingResumeIfReadyForTest(h.ctx, runtime);
  assert.ok(nudges(h).some((m) => m.text === replacement.text), "the replacement nudge is still deliverable");
}, { timeout: 60000 });

test("off during an in-flight send cancels the nudge and leaves both counters untouched", async () => {
  const h = await readySession("off-race");
  const ext = await extensionModule();
  const runtime = ext.runtimeForTest(h.ctx);

  await h.hook("agent_start")({}, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  assert.equal(runtime.pendingResumeIsDrift, true, "a drift nudge is scheduled");
  const queuedText = runtime.pendingResumeMessage.text;

  // Fire off exactly after the gates awaited and before the send-time mode
  // refresh: the composer/send path has already passed its initial checks.
  let gatesEvaluated = false;
  let offFired = false;
  const racingCtx = Object.create(h.ctx);
  racingCtx.sessionManager = {
    ...h.ctx.sessionManager,
    getSessionId() {
      if (gatesEvaluated && !offFired) {
        offFired = true;
        void h.command("autoresearch").handler("off", h.ctx);
      }
      return h.ctx.sessionManager.getSessionId();
    },
  };
  racingCtx.isIdle = () => {
    gatesEvaluated = true;
    return h.ctx.isIdle();
  };

  await ext.sendPendingResumeIfReadyForTest(racingCtx, runtime);

  assert.ok(offFired, "off really fired inside the gate/send window");
  assert.equal(runtime.autoresearchMode, false);
  assert.ok(!nudges(h).some((m) => m.text === queuedText), "the in-flight nudge is not sent after off");
  assert.equal(runtime.consecutiveDriftResumes, 0, "drift budget not spent by a cancelled send");
  assert.equal(runtime.autoResumeTurns, 0, "auto-resume budget not spent by a cancelled send");
}, { timeout: 60000 });
