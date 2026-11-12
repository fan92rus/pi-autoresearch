import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const rulesFor = (id) => [
  { id: `${id}-yes`, verdict: "confirmed", when: "effect is present" },
  { id: `${id}-no`, verdict: "rejected", when: "effect is absent" },
  { id: `${id}-unknown`, verdict: "inconclusive", when: "data are noisy" },
  { id: `${id}-wait`, verdict: "waiting_for_data", when: "data are missing" },
];
const brief = {
  schema_version: 1, goal: "Test close nudges", plan_source: "plan.md", caveat_block: "Observational only.",
  data_roles: { explore: ["evidence.txt"], validate: ["evidence.txt"], confirm: [] },
  questions: ["Q1", "Q2"].map((id) => ({ id, text: `Question ${id}?`, decision_rules: rulesFor(id), needs_data: null })),
  process_metrics: ["files read"], stop_rules: [{ id: "S1", when: "both questions closed" }],
};

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-close-nudges-"));
  fs.writeFileSync(path.join(dir, "evidence.txt"), "evidence\n");
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: "close-nudges", realGit: false });
  const ctx = makeCtx(dir, "close-nudges", pi);
  const module = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  const { default: extension } = module;
  extension(pi);
  await command("autoresearch").handler("research --id c1", ctx);
  const call = (name, params) => tool(name).execute("id", params, null, null, ctx);
  await call("research_brief", { action: "draft", brief });
  ctx.ui.confirm = async () => true;
  await call("research_brief", { action: "propose" });
  const sha = createHash("sha256").update(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "brief.json"))).digest("hex");
  await call("research", { action: "start", expected_sha256: sha });
  async function close(id) {
    await call("research", { action: "open", question_id: id });
    await call("research", { action: "record", evidence_ref: "evidence.txt:1" });
    return call("research", { action: "close", question_id: id, rule_id: `${id}-yes`, verdict: "confirmed" });
  }
  async function nudge() {
    await hook("agent_start")({}, ctx);
    await hook("agent_end")({ messages: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return pi.sentMessages.at(-1)?.text ?? "";
  }
  return { dir, close, nudge, pi, ctx, module };
}
const textOf = (res) => res?.content?.[0]?.text ?? "";

test("close points to stop and report only after the final brief question", async () => {
  const h = await fixture();
  const first = textOf(await h.close("Q1"));
  assert.doesNotMatch(first, /pick a stop rule/i);
  const last = textOf(await h.close("Q2"));
  assert.match(last, /all questions are closed/i);
  assert.match(last, /research_questions\(action=stop, rule_id=<rule_id>, reason=/);
  assert.match(last, /research_questions\(action=report\)/);
}, { timeout: 60000 });

test("drift reminder changes from open-work wording to stop/report after all questions close", async () => {
  const h = await fixture();
  const openText = await h.nudge();
  assert.match(openText, /research_questions\(action=status\)/);
  assert.match(openText, /research_questions calls with action=open, action=record, or action=close/);
  await h.close("Q1");
  await h.close("Q2");
  const closedText = await h.nudge();
  assert.match(closedText, /research_questions\(action=stop, rule_id=<rule_id>, reason=/);
  assert.match(closedText, /research_questions\(action=report\)/);
  assert.doesNotMatch(closedText, /research status\/open\/record\/close/);
}, { timeout: 60000 });

test("auto-resume limit notification names a questions-complete campaign needing stop and report", async () => {
  const h = await fixture();
  await h.close("Q1");
  await h.close("Q2");
  await h.module.notifyAutoResumeLimitReachedAsyncForTest(h.ctx, "Autoresearch auto-resume limit reached (200 turns)");
  const notification = h.pi.notifications.at(-1)?.text ?? "";
  assert.match(notification, /c1/);
  assert.match(notification, /needs stop \+ report/i);
}, { timeout: 60000 });

test("send-time override replaces legacy message only while research campaign blocks", async () => {
  const h = await fixture();
  const runtime = { pendingResumeMessage: "Please run_experiment and log_experiment.", pendingResumeTimer: null, autoresearchMode: true, autoResumeTurns: 0, state: { results: [], currentSegment: 0 } };
  await h.module.sendPendingResumeIfReadyForTest(h.ctx, runtime);
  assert.equal(h.pi.sentMessages.at(-1)?.text, "Continue the research campaign: call research_questions(action=status), then issue separate research_questions calls with action=open, action=record, or action=close as indicated by the approved brief; STOP on manual_check_required.");
  const stateAware = "Continue the active research campaign with its recorded evidence.";
  runtime.pendingResumeMessage = stateAware;
  await h.module.sendPendingResumeIfReadyForTest(h.ctx, runtime);
  assert.equal(h.pi.sentMessages.at(-1)?.text, stateAware);
}, { timeout: 60000 });

test("pending operation and stopped phase do not deliver a research reminder", async () => {
  const h = await fixture();
  const baseline = h.pi.sentMessages.length;
  fs.writeFileSync(path.join(h.dir, ".auto", "research", "c1", "pending-op.json"), "{}");
  await h.nudge();
  assert.equal(h.pi.sentMessages.length, baseline);
  fs.unlinkSync(path.join(h.dir, ".auto", "research", "c1", "pending-op.json"));
  await h.close("Q1");
  await h.close("Q2");
  await h.pi.tools.find((t) => t.name === "research").execute("id", { action: "stop", rule_id: "S1", reason: "closed" }, null, null, h.ctx);
  await h.nudge();
  assert.equal(h.pi.sentMessages.length, baseline);
}, { timeout: 60000 });
