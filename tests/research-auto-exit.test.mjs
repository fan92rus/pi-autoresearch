/**
 * Auto-exit from research mode. The research tools are gated by the mode flag,
 * so the exit happens at the campaign's LAST step: a `report` of a STOPPED
 * campaign. `stop` alone keeps the mode on (the report still has to run).
 * The report writes report.md first, then autoresearch mode goes OFF, the OFF
 * activation is persisted, the campaign pin is released, and no automatic
 * continuation follows.
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-auto-exit.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-autoexit-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rulesFor(qid) {
  return [
    { id: `${qid}-yes`, verdict: "confirmed", when: "effect is present in validate data" },
    { id: `${qid}-no`, verdict: "rejected", when: "effect is absent in validate data" },
    { id: `${qid}-unknown`, verdict: "inconclusive", when: "data are too noisy to decide" },
    { id: `${qid}-wait`, verdict: "waiting_for_data", when: "validate data are missing" },
  ];
}

function briefFixture() {
  return {
    schema_version: 1,
    goal: "Check whether the cache layer explains the latency drop.",
    plan_source: "docs/plan.md",
    caveat_block: "Results are observational; no causal claim is made beyond the listed data.",
    data_roles: { explore: ["logs/2024-01.txt"], validate: ["logs/2024-02.txt"], confirm: [] },
    questions: [{ id: "Q1", text: "Does the cache hit rate rise after the change?", decision_rules: rulesFor("Q1"), needs_data: null }],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
}

async function loadExtension(dir, label) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `autoexit-${label}`, realGit: false });
  const ctx = makeCtx(dir, `autoexit-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1", ctx);
  return { pi, tool, command, hook, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

async function draftAndApprove(h) {
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  return sha256Of(fs.readFileSync(path.join(h.dir, ".auto", "research", "c1", "brief.json")));
}

async function stopCampaign(h, sha) {
  await call(h, "research", { action: "start", expected_sha256: sha });
  const stopText = textOf(await call(h, "research", { action: "stop", rule_id: "S1", reason: "two rejections recorded" }));
  assert.match(stopText, /Research stopped by S1/, stopText);
}

test("stop keeps research mode on; the report of a stopped campaign leaves it", async () => {
  const dir = makeWorkDir("report-exit");
  const h = await loadExtension(dir, "report-exit");
  const sha = await draftAndApprove(h);
  await stopCampaign(h, sha);

  assert.equal(h.pi.notifications.some((n) => /research mode OFF/.test(n.text)), false, "stop alone must not leave the mode");
  const entriesBefore = h.pi.entries.length;

  const report = textOf(await call(h, "research", { action: "report" }));
  assert.match(report, /No target metric/, report);
  assert.match(report, /Research mode is OFF\./, report);
  assert.ok(h.pi.notifications.some((n) => /research mode OFF/.test(n.text)), "owner must be told research mode is OFF");
  assert.ok(
    h.pi.entries.slice(entriesBefore).some((e) => e === "pi-autoresearch.activation"),
    `the OFF activation must be persisted: ${JSON.stringify(h.pi.entries.slice(entriesBefore))}`,
  );
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research", "c1", "report.md")), "report.md must be written before the exit");
  const afterExit = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(afterExit, /Autoresearch mode is OFF/, `gated tools must refuse after the exit: ${afterExit}`);
}, { timeout: 30000 });

test("after the exit no automatic continuation is sent", async () => {
  const dir = makeWorkDir("exit-no-resume");
  const h = await loadExtension(dir, "exit-no-resume");
  const sha = await draftAndApprove(h);
  await stopCampaign(h, sha);
  await call(h, "research", { action: "report" });
  const sentBefore = h.pi.sentMessages.length;
  await h.hook("agent_start")({ messages: [] }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.pi.sentMessages.length, sentBefore, `no resume after the exit: ${JSON.stringify(h.pi.sentMessages.slice(sentBefore).map((m) => m.text))}`);
}, { timeout: 30000 });

test("a new session activation after the exit drafts a new campaign and archives the finished one", async () => {
  const dir = makeWorkDir("exit-then-new");
  const h = await loadExtension(dir, "exit-then-new");
  const sha = await draftAndApprove(h);
  await stopCampaign(h, sha);
  await call(h, "research", { action: "report" });

  await h.command("autoresearch").handler("on", h.ctx);
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(draft, /Brief draft saved/, draft);
  const archived = fs.readdirSync(path.join(dir, ".auto", "research-archive"));
  assert.ok(archived.some((n) => n.startsWith("c1-")), `finished c1 must be archived: ${archived}`);
}, { timeout: 30000 });
