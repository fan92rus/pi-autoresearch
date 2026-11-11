import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-charter-command-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
async function setup(label, isolated = false) {
  const base = makeWorkDir(label);
  const dir = isolated ? path.join(base, "work") : base;
  if (isolated) fs.mkdirSync(dir, { recursive: true });
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: label, realGit: false });
  const ctx = makeCtx(dir, label, pi);
  const { default: extension } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  extension(pi);
  return { dir, pi, ctx, tool, command, hook, run: (args) => command("autoresearch").handler(args, ctx) };
}
const notices = (h) => h.pi.notifications.map((n) => n.text);

test("charter command opens a draft dialog without enabling research mode; can be reopened", async () => {
  const h = await setup("draft");
  await h.run("charter Study the cache");
  assert.equal(h.pi.sentMessages.length, 1);
  assert.match(h.pi.sentMessages[0].text, /research_charter draft/);
  assert.match(h.pi.sentMessages[0].text, /Study the cache/);
  assert.equal(fs.existsSync(path.join(h.dir, ".auto", "research-chain")), false);
  assert.match((await h.tool("research_brief").execute("x", { action: "draft" }, null, null, h.ctx)).content[0].text, /Autoresearch mode is OFF/);
  await h.run("charter Study another cache");
  assert.equal(h.pi.sentMessages.length, 2);
  assert.equal(notices(h).some((t) => /refused/.test(t)), false);
});

test("charter command requires description or --id", async () => {
  const h = await setup("usage");
  await h.run("charter");
  assert.equal(h.pi.sentMessages.length, 0);
  assert.ok(notices(h).some((t) => t.includes("Usage: /autoresearch charter")));
});

test("charter command refuses an active research campaign before kickoff", async () => {
  const h = await setup("campaign");
  const campaignDir = path.join(h.dir, ".auto", "research", "c2");
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c2", created_at: new Date().toISOString(), phase: "research" }));
  await h.run("charter Study it");
  assert.equal(h.pi.sentMessages.length, 0);
  assert.ok(notices(h).some((t) => t.includes("campaign active")));
});

test("pinned root id appears in the kickoff root and journal hint", async () => {
  const h = await setup("id");
  await h.run("charter --id c9 Study it");
  assert.match(h.pi.sentMessages[0].text, /campaign c9, journal c9-chain/);
});

function writeCampaignState(dir, id, phase = "stopped") {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({
    schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase,
  }, null, 2) + "\n");
}

test("cross-phase active-chain propose is guarded", async () => {
  const h = await setup("phase-conflict", true);
  await h.run("charter Study it");
  await h.tool("research_charter").execute("x", { action: "draft", charter: { max_campaigns: 3 } }, null, null, h.ctx);
  writeCampaignState(h.dir, "c1");
  const source = path.join(h.dir, "..", `charter-src-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(source, "{}\n");
  h.ctx.ui.confirm = async () => true;
  await h.command("autoresearch").handler(`research --charter ${source} --id c1 study`, h.ctx);

  const parent = path.dirname(h.dir);
  const existingCharters = fs.readdirSync(parent).filter((n) => n.startsWith("charter-") && n.endsWith(".json"));
  const target = path.join(parent, "proposed-charter-must-not-exist.json");
  const result = await h.tool("research_charter").execute("x", { action: "propose" }, null, null, h.ctx);
  assert.match(result.content[0].text, /chain_active|active/i);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith("charter-") && n.endsWith(".json")), existingCharters);
});

test("propose refuses an existing pinned campaign transactionally and can retry after removal", async () => {
  const h = await setup("campaign-exists", true);
  await h.run("charter --id c1 Study it");
  writeCampaignState(h.dir, "c1", "stopped");
  await h.tool("research_charter").execute("x", { action: "draft", charter: { max_campaigns: 2 } }, null, null, h.ctx);
  h.ctx.ui.confirm = async () => true;
  const parent = path.dirname(h.dir);
  const before = fs.readdirSync(parent).filter((n) => n.startsWith("charter-c1-") && n.endsWith(".json"));
  const rejected = await h.tool("research_charter").execute("x", { action: "propose" }, null, null, h.ctx);
  assert.match(rejected.content[0].text, /campaign_exists.*campaign c1 already exists/);
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith("charter-c1-") && n.endsWith(".json")), before);
  assert.equal(fs.existsSync(path.join(h.dir, ".auto", "research-chain", "c1-chain")), false);
  assert.match((await h.tool("research_charter").execute("x", { action: "propose" }, null, null, h.ctx)).content[0].text, /campaign_exists/);
  fs.rmSync(path.join(h.dir, ".auto", "research", "c1"), { recursive: true, force: true });
  assert.match((await h.tool("research_charter").execute("x", { action: "propose" }, null, null, h.ctx)).content[0].text, /started/);
});

test("git remains available while charter dialog is open; propose enables research mode", async () => {
  const h = await setup("git-gate", true);
  await h.run("charter Study it");
  const before = await h.hook("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx);
  assert.notEqual(before?.block, true);
  await h.tool("research_charter").execute("x", { action: "draft", charter: { max_campaigns: 2 } }, null, null, h.ctx);
  h.ctx.ui.confirm = async () => true;
  const proposed = await h.tool("research_charter").execute("x", { action: "propose" }, null, null, h.ctx);
  assert.match(proposed.content[0].text, /started/i);
  await h.run("charter Another study");
  assert.ok(notices(h).some((text) => /chain .* active.*charter refused/i.test(text)));
  // Git blocking requires a research campaign; the review-4.7 wiring test covers that case.
  const after = await h.hook("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx);
  assert.notEqual(after?.block, true);
});
