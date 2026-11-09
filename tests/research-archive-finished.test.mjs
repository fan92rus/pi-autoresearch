/**
 * Finished research campaigns do not block the next one: an unpinned research_brief
 * draft moves every STOPPED campaign under .auto/research-archive/ (a move, never a
 * delete). Active or unreadable campaigns still refuse with "several campaigns exist"
 * and nothing is moved.
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-archive-finished.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-archive-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCampaignState(dir, id, phase) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
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

async function loadExtensionBare(dir, label) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `archive-${label}`, realGit: false });
  const ctx = makeCtx(dir, `archive-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, tool, hook, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

function listDirs(p) {
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

test("a stopped campaign is archived (moved, not deleted) when the next campaign is drafted", async () => {
  const dir = makeWorkDir("one-stopped");
  writeCampaignState(dir, "old1", "stopped");
  fs.writeFileSync(path.join(dir, ".auto", "research", "old1", "report.md"), "# old report\n");
  const h = await loadExtensionBare(dir, "one-stopped");

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(res, /Brief draft saved/, res);

  const campaigns = listDirs(path.join(dir, ".auto", "research"));
  assert.equal(campaigns.length, 1, `only the new campaign may stay in research: ${campaigns}`);
  assert.notEqual(campaigns[0], "old1");
  const archived = listDirs(path.join(dir, ".auto", "research-archive"));
  assert.equal(archived.length, 1, `old1 must be archived: ${archived}`);
  assert.match(archived[0], /^old1-/);
  assert.equal(fs.readFileSync(path.join(dir, ".auto", "research-archive", archived[0], "report.md"), "utf8"), "# old report\n",
    "archived campaign keeps its files byte-for-byte");
});

test("several stopped campaigns are all archived by one draft", async () => {
  const dir = makeWorkDir("two-stopped");
  writeCampaignState(dir, "x1", "stopped");
  writeCampaignState(dir, "x2", "stopped");
  const h = await loadExtensionBare(dir, "two-stopped");

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(res, /Brief draft saved/, res);
  assert.equal(listDirs(path.join(dir, ".auto", "research")).length, 1);
  const archived = listDirs(path.join(dir, ".auto", "research-archive"));
  assert.equal(archived.length, 2, `both finished campaigns archived: ${archived}`);
  assert.ok(archived.some((n) => n.startsWith("x1-")) && archived.some((n) => n.startsWith("x2-")), archived.join(","));
});

test("an active campaign still blocks the draft and nothing is moved", async () => {
  const dir = makeWorkDir("one-active");
  writeCampaignState(dir, "old1", "stopped");
  writeCampaignState(dir, "live", "briefing");
  const h = await loadExtensionBare(dir, "one-active");

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(res, /several campaigns exist/, res);
  assert.deepEqual(listDirs(path.join(dir, ".auto", "research")), ["live", "old1"], "no campaign may be moved");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-archive")), false, "archive must not be created");
});

test("an unreadable state keeps the refusal and nothing is moved", async () => {
  const dir = makeWorkDir("unreadable");
  writeCampaignState(dir, "old1", "stopped");
  const broken = path.join(dir, ".auto", "research", "broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "state.json"), "{not json");
  const h = await loadExtensionBare(dir, "unreadable");

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(res, /several campaigns exist|state_unreadable|cannot be read|not valid JSON/, res);
  assert.deepEqual(listDirs(path.join(dir, ".auto", "research")), ["broken", "old1"]);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-archive")), false);
});
