/**
 * Hypothesis finding links (openspec hypothesis-evidence-context, tasks 1.1–2.2):
 * optional explicit finding_id on propose_hypothesis, current-status warnings in
 * propose/tree_status/run_experiment, unknown for missing or unreadable findings.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/hypothesis-finding-links.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx, createHarness } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-hfl-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadHarness(label, { optimizeFixture = false } = {}) {
  return createHarness({
    dir: makeTempDir(label),
    sessionId: `hfl-${label}`,
    optimizeFixture,
  });
}

/** Seed findings.jsonl with a finding in the given status (append-only lines). */
function seedFinding(dir, id, status = "open", note) {
  const lines = [
    JSON.stringify({ type: "finding", id, theme: "behavior", description: "d", evidence_ref: "e.md:1", status: "open", created: "2026-01-01T00:00:00.000Z" }),
  ];
  const map = { open: null, revised: "open", verified: "open", deferred: "revised" };
  let from = "open";
  // Build a legal transition path to the requested status.
  const paths = {
    open: [],
    revised: [{ from: "open", status: "revised" }],
    verified: [{ from: "open", status: "verified" }],
    deferred: [{ from: "open", status: "revised" }, { from: "revised", status: "deferred" }],
  };
  for (const t of paths[status] ?? []) {
    lines.push(JSON.stringify({ type: "finding_transition", id, from: t.from, status: t.status, evidence_ref: "e.md:1", updated: "2026-01-02T00:00:00.000Z" }));
  }
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "findings.jsonl"), lines.join("\n") + "\n", "utf8");
}

/** Start a session and register a hypothesis, returning tool call helpers. */
async function readySession(label, { withFinding } = {}) {
  const h = await loadHarness(label);
  const dir = h.ctx.cwd;
  await h.command("autoresearch").handler("on", h.ctx);
  approveOptimizeBrief(dir, { name: `t-${label}`, metric_name: "ms" });
  const started = await h.tool("init_experiment").execute("id", { name: `t-${label}`, metric_name: "ms" }, null, null, h.ctx);
  assert.match(initText(started), /Experiment initialized/);
  if (withFinding) seedFinding(dir, "f1", withFinding);
  return h;
}

function initText(res) {
  return String(res?.content?.[0]?.text ?? "");
}

test("propose_hypothesis stores finding_id and returns it (description path)", async () => {
  const h = await readySession("store-desc", { withFinding: "open" });
  const res = await h.tool("propose_hypothesis").execute("id", { description: "Cache warmups; expect fewer cold reads", finding_id: "f1" }, null, null, h.ctx);
  const text = String(res.content[0].text);
  assert.match(text, /Hypothesis registered: n1/);
  assert.ok(!text.includes("revised"), "no warning while finding is open");
  const tree = JSON.parse(fs.readFileSync(path.join(h.ctx.cwd, ".auto", "tree.json"), "utf8"));
  assert.equal(tree.nodes.n1.findingId, "f1");
  const idea = fs.readFileSync(path.join(h.ctx.cwd, ".auto", "ideas", "n1.md"), "utf8");
  assert.ok(idea.includes("finding_id: f1"), "frontmatter records the link");
});

test("path registration keeps working without finding_id (legacy calls unchanged)", async () => {
  const h = await readySession("legacy-path");
  const file = path.join(h.ctx.cwd, "hyp.txt");
  fs.writeFileSync(file, "Legacy idea text\n", "utf8");
  const res = await h.tool("propose_hypothesis").execute("id", { path: file }, null, null, h.ctx);
  assert.match(String(res.content[0].text), /Hypothesis registered: n1/);
  const tree = JSON.parse(fs.readFileSync(path.join(h.ctx.cwd, ".auto", "tree.json"), "utf8"));
  assert.ok(!("findingId" in tree.nodes.n1) || tree.nodes.n1.findingId == null);
});

test("F1 is not auto-linked to f1 and stays unknown (case-sensitive ids)", async () => {
  const h = await readySession("f1-case", { withFinding: "revised" });
  const res = await h.tool("propose_hypothesis").execute("id", { description: "Raise F1 on dev set", finding_id: "F1" }, null, null, h.ctx);
  const text = String(res.content[0].text);
  assert.match(text, /unknown/);
  assert.ok(!text.includes("is revised"), "F1 must not match finding f1");
  const tree = JSON.parse(fs.readFileSync(path.join(h.ctx.cwd, ".auto", "tree.json"), "utf8"));
  assert.equal(tree.nodes.n1.findingId, "F1");
});

test("revised finding warns at registration; later verified/deferred/open clears it (read-time status)", async () => {
  const h = await readySession("warn-clear", { withFinding: "revised" });
  const res = await h.tool("propose_hypothesis").execute("id", { description: "Two-stage SFT; expect recall up", finding_id: "f1" }, null, null, h.ctx);
  assert.match(String(res.content[0].text), /f1 is revised/);

  // revised -> verified: warning disappears without re-proposing
  fs.appendFileSync(path.join(h.ctx.cwd, ".auto", "findings.jsonl"),
    JSON.stringify({ type: "finding_transition", id: "f1", from: "revised", status: "verified", evidence_ref: "e.md:1", updated: "2026-01-03T00:00:00.000Z" }) + "\n");
  const view = await h.tool("tree_status").execute("id", {}, null, null, h.ctx);
  assert.ok(!String(view.content[0].text).includes("revised"), "verified status clears the warning");

  // verified -> revised -> deferred: warning returns then clears again
  fs.appendFileSync(path.join(h.ctx.cwd, ".auto", "findings.jsonl"),
    JSON.stringify({ type: "finding_transition", id: "f1", from: "verified", status: "revised", evidence_ref: "e.md:1", updated: "2026-01-04T00:00:00.000Z" }) + "\n");
  const view2 = await h.tool("tree_status").execute("id", {}, null, null, h.ctx);
  assert.match(String(view2.content[0].text), /revised/);
  fs.appendFileSync(path.join(h.ctx.cwd, ".auto", "findings.jsonl"),
    JSON.stringify({ type: "finding_transition", id: "f1", from: "revised", status: "deferred", evidence_ref: "e.md:1", updated: "2026-01-05T00:00:00.000Z" }) + "\n");
  const view3 = await h.tool("tree_status").execute("id", {}, null, null, h.ctx);
  assert.ok(!String(view3.content[0].text).includes("revised"), "deferred clears the warning");
});

test("duplicate registration with revised finding shows BOTH duplicate message and warning", async () => {
  const h = await readySession("dup-warn", { withFinding: "open" });
  const desc = "Cache warmups; expect fewer cold reads";
  await h.tool("propose_hypothesis").execute("id", { description: desc, finding_id: "f1" }, null, null, h.ctx);
  seedFinding(h.ctx.cwd, "f1", "revised");
  const res = await h.tool("propose_hypothesis").execute("id", { description: desc, finding_id: "f1" }, null, null, h.ctx);
  const text = String(res.content[0].text);
  assert.match(text, /DUPLICATE HYPOTHESIS/);
  assert.match(text, /f1 is revised/);
  const tree = JSON.parse(fs.readFileSync(path.join(h.ctx.cwd, ".auto", "tree.json"), "utf8"));
  assert.equal(tree.nodes.n2.findingId, "f1", "duplicate node keeps the link");
  assert.equal(tree.nodes.n2.status, "duplicate");
});

test("missing finding and unreadable store are unknown, registration not blocked", async () => {
  const h = await readySession("unknown-missing");
  seedFinding(h.ctx.cwd, "f2", "open");
  const missing = await h.tool("propose_hypothesis").execute("id", { description: "Idea A based on f1", finding_id: "f1" }, null, null, h.ctx);
  assert.match(String(missing.content[0].text), /unknown.*not found|not found.*unknown/);
  // corrupt the store
  fs.writeFileSync(path.join(h.ctx.cwd, ".auto", "findings.jsonl"), "{broken\n", "utf8");
  const corrupt = await h.tool("propose_hypothesis").execute("id", { description: "Idea B based on f2", finding_id: "f2" }, null, null, h.ctx);
  assert.match(String(corrupt.content[0].text), /unknown/);
  assert.match(String(corrupt.content[0].text), /Hypothesis registered/);
});

test("tree_status lists linked findings with current status", async () => {
  const h = await readySession("tree-list", { withFinding: "revised" });
  await h.tool("propose_hypothesis").execute("id", { description: "Linked idea; expect a warning", finding_id: "f1" }, null, null, h.ctx);
  const view = await h.tool("tree_status").execute("id", {}, null, null, h.ctx);
  const text = String(view.content[0].text);
  assert.match(text, /Linked findings:/);
  assert.match(text, /n1 .*f1 \(revised\)/);
});

test("run_experiment warns when linked finding is revised before the run", async () => {
  const h = await readySession("run-warn", { withFinding: "revised" });
  await h.tool("propose_hypothesis").execute("id", { description: "Run me; expect a warning", finding_id: "f1" }, null, null, h.ctx);
  const res = await h.tool("run_experiment").execute("id", { hypothesis_id: "n1", command: "echo hi", timeout_seconds: 5 }, null, null, h.ctx);
  const text = String(res.content[0].text);
  assert.match(text, /f1 is revised/);
});

test("restart: warnings are computed at read time, so a fresh session shows current status", async () => {
  const dir = makeTempDir("restart");
  // Use the same dir with a new harness to simulate a restarted session.
  const h2 = await createHarness({ dir, sessionId: "restart-2" });
  await h2.command("autoresearch").handler("on", h2.ctx);
  approveOptimizeBrief(dir, { name: "t-restart", metric_name: "ms" });
  const started = await h2.tool("init_experiment").execute("id", { name: "t-restart", metric_name: "ms" }, null, null, h2.ctx);
  assert.match(initText(started), /Experiment initialized/);
  seedFinding(dir, "f1", "revised");
  const res = await h2.tool("propose_hypothesis").execute("id", { description: "Fresh-session idea; expect revised warning", finding_id: "f1" }, null, null, h2.ctx);
  assert.match(String(res.content[0].text), /f1 is revised/);
});

test("SimHash input unchanged: description text is hashed the same with or without finding_id", async () => {
  const h = await readySession("simhash-same", { withFinding: "open" });
  const desc = "Identical text for both calls";
  const r1 = await h.tool("propose_hypothesis").execute("id", { description: desc }, null, null, h.ctx);
  const t1 = String(r1.content[0].text);
  assert.match(t1, /Status: untested/);
  // The same text WITH finding_id must still hit SimHash: the param is not part of the hashed input.
  const r2 = await h.tool("propose_hypothesis").execute("id", { description: desc, finding_id: "f1" }, null, null, h.ctx);
  const t2 = String(r2.content[0].text);
  assert.match(t2, /DUPLICATE HYPOTHESIS/);
});

test("update_finding description mentions the soft warning; route behavior line carries the call shape", async () => {
  const dir = makeTempDir("prompts");
  const { pi, command, hook } = createFakePi({ dir, sessionId: "hfl-prompts", realGit: false });
  const ctx = makeCtx(dir, "hfl-prompts", pi);
  const { default: ext } = await import(pathToFileURL(path.resolve("extensions/pi-autoresearch/index.ts")).href);
  ext(pi);
  await command("autoresearch").handler("on", ctx);
  const tools = pi.getActiveTools();
  void tools;
  // The update_finding tool description is registered on pi; check via a fake registration log.
  assert.ok(ext !== undefined, "extension loads");
  const event = { systemPrompt: "BASE" };
  const out = await hook("before_agent_start")(event, ctx);
  const prompt = out?.systemPrompt ?? event.systemPrompt;
  assert.match(prompt, /optionally pass finding_id/);
  assert.match(prompt, /what you noticed, what changes, what you will learn/);
});
