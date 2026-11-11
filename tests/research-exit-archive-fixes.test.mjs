/**
 * Fixes from openspec/changes/research-exit-and-archive (tasks 2.1–2.3):
 *  2.1 a failed report save must NOT leave research mode;
 *  2.2 a new pinned draft (--id <new>) archives finished campaigns too;
 *  2.3 a bare /autoresearch research with only finished campaigns is not refused,
 *      and the next draft archives them; an active campaign still refuses.
 *  Plus: an invalid brief moves nothing (archive runs after validation).
 *
 * Run: timeout 240 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-exit-archive-fixes.test.mjs
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
  const dir = path.join(os.tmpdir(), `pi-ar-fixes-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

/** commandArgs: "research --id c1" (pinned), "research" (bare) or "on". */
async function load(dir, label, commandArgs) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `fixes-${label}`, realGit: false });
  const ctx = makeCtx(dir, `fixes-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler(commandArgs, ctx);
  return { pi, tool, command, hook, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

async function draftAndApprove(h, id) {
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  return sha256Of(fs.readFileSync(path.join(h.dir, ".auto", "research", id, "brief.json")));
}

/** Creates a finished campaign `id` on disk: pinned session, draft, start, stop. */
async function makeStopped(dir, id) {
  const h = await load(dir, `make-${id}`, `research --id ${id}`);
  const sha = await draftAndApprove(h, id);
  await call(h, "research", { action: "start", expected_sha256: sha });
  const stopText = textOf(await call(h, "research", { action: "stop", rule_id: "S1", reason: "two rejections recorded" }));
  assert.match(stopText, /Research stopped by S1/, stopText);
  return h;
}

function archivedNames(dir) {
  const root = path.join(dir, ".auto", "research-archive");
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

// ─── 2.1 report save failure keeps research mode ────────────────────────────

test("2.1 a failed report save keeps research mode on; a retry that saves leaves it", async () => {
  const dir = makeWorkDir("save-fail");
  const h = await makeStopped(dir, "c1");
  // A directory named report.md makes the atomic rename fail: the save fails.
  const blocker = path.join(dir, ".auto", "research", "c1", "report.md");
  fs.mkdirSync(blocker);

  const failed = textOf(await call(h, "research", { action: "report" }));
  assert.match(failed, /warning: the report could not be saved/, failed);
  assert.equal(failed.includes("Research mode is OFF"), false, "no exit without a saved report");
  assert.equal(h.pi.notifications.some((n) => /research mode OFF/.test(n.text)), false, "no OFF notice");
  const stillOn = textOf(await call(h, "research", { action: "status" }));
  assert.equal(stillOn.includes("Autoresearch mode is OFF"), false, `mode must stay on: ${stillOn}`);

  fs.rmdirSync(blocker);
  const saved = textOf(await call(h, "research", { action: "report" }));
  assert.match(saved, /Research mode is OFF\./, saved);
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research", "c1", "report.md")), "report.md written on retry");
}, { timeout: 60000 });

// ─── 2.2 pinned new draft archives finished campaigns ───────────────────────

test("2.2 a pinned new draft (--id <new>) archives a finished campaign", async () => {
  const dir = makeWorkDir("pinned-archive");
  await makeStopped(dir, "c0");
  const h = await load(dir, "pinned-new", "research --id c1");
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(draft, /Brief draft saved for campaign c1/, draft);
  const archived = archivedNames(dir);
  assert.ok(archived.some((n) => n.startsWith("c0-")), `finished c0 must be archived: ${archived}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c0")), false, "c0 left the research root");
}, { timeout: 60000 });

test("2.2 a pinned new draft refuses while another campaign is briefing; nothing moves", async () => {
  const dir = makeWorkDir("pinned-blocked");
  const other = await load(dir, "other", "research --id c0");
  await call(other, "research_brief", { action: "draft", brief: briefFixture() });
  const h = await load(dir, "pinned-blocked", "research --id c1");
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(draft, /active or unreadable/, draft);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c1")), false, "c1 must not be created");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c0", "brief.json")), true, "c0 stays in place");
  assert.deepEqual(archivedNames(dir), [], "nothing archived");
}, { timeout: 60000 });

// ─── 2.3 bare activation with finished campaigns ────────────────────────────

test("2.3 bare /autoresearch research with only a finished campaign starts; the draft archives it", async () => {
  const dir = makeWorkDir("bare-stopped");
  await makeStopped(dir, "c0");
  const h = await load(dir, "bare", "research");
  assert.equal(h.pi.notifications.some((n) => /exists|Several campaigns/.test(n.text)), false,
    `a finished campaign must not refuse activation: ${JSON.stringify(h.pi.notifications.map((n) => n.text))}`);
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(draft, /Brief draft saved/, draft);
  assert.ok(archivedNames(dir).some((n) => n.startsWith("c0-")), `finished c0 must be archived: ${archivedNames(dir)}`);
}, { timeout: 60000 });

test("2.3 bare /autoresearch research closes a stale briefing campaign before launch", async () => {
  const dir = makeWorkDir("bare-briefing");
  const other = await load(dir, "other", "research --id c0");
  await call(other, "research_brief", { action: "draft", brief: briefFixture() });
  const h = await load(dir, "bare-b", "research");
  assert.equal(h.pi.notifications.some((n) => /Cannot launch research/.test(n.text)), false,
    `stale briefing should close: ${JSON.stringify(h.pi.notifications.map((n) => n.text))}`);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c0", "state.json"), "utf8"));
  assert.equal(state.phase, "stopped");
  assert.match(fs.readFileSync(path.join(dir, ".auto", "research", "c0", "log.jsonl"), "utf8"), /\"event\":\"abandon\"/);
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research", "c0", "report.md")));
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(draft, /Brief draft saved/, draft);
  assert.ok(archivedNames(dir).some((n) => n.startsWith("c0-")), `c0 archived: ${archivedNames(dir)}`);
}, { timeout: 60000 });

// ─── invalid brief moves nothing ────────────────────────────────────────────

test("an invalid brief draft archives nothing (validation runs before the move)", async () => {
  const dir = makeWorkDir("invalid-brief");
  await makeStopped(dir, "c0");
  const h = await load(dir, "invalid", "research");
  const bad = { ...briefFixture(), unknown_field: 1 };
  const refused = textOf(await call(h, "research_brief", { action: "draft", brief: bad }));
  assert.match(refused, /brief rejected/, refused);
  assert.deepEqual(archivedNames(dir), [], "nothing archived on a refused draft");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c0", "state.json")), true, "c0 stays in place");
}, { timeout: 60000 });
