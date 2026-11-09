/**
 * Two-phase start of the ordinary optimization loop (openspec: optimize-two-phase-start).
 * Unit rules of optimize-brief.ts, and wiring through the REAL extension on the fake pi harness:
 * optimize_brief draft/propose, init_experiment gate, run/log gate, resume without a brief.
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/optimize-two-phase-start.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as ob from "../extensions/pi-autoresearch/optimize-brief.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-optimize-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function briefArgs(overrides = {}) {
  return { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", ...overrides };
}

/** Loads the REAL extension on a fake pi and turns the mode on (no campaign pin). */
async function loadBare(dir, label) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `optimize-${label}`, realGit: false });
  const ctx = makeCtx(dir, `optimize-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, tool, hook, ctx, dir };
}

async function run(h, name, params) {
  const res = await h.tool(name).execute("t-" + Math.random().toString(36).slice(2), params, undefined, undefined, h.ctx);
  return res?.content?.[0]?.text ?? "";
}

// ── unit: the pure rules ─────────────────────────────────────────────

test("canonical bytes do not depend on key order and carry schema_version 1", () => {
  const a = ob.validateOptimizeBrief({ name: "n", metric_name: "m", direction: "higher" });
  const b = ob.validateOptimizeBrief({ direction: "higher", metric_name: "m", name: "n" });
  assert.equal(a.ok && b.ok, true);
  const bytesA = ob.canonicalBriefBytes(a.brief);
  assert.equal(bytesA, ob.canonicalBriefBytes(b.brief));
  assert.equal(bytesA, '{\n  "direction": "higher",\n  "metric_name": "m",\n  "name": "n",\n  "schema_version": 1\n}\n');
});

test("an unknown brief field is refused, not dropped, and nothing is written", () => {
  const dir = makeWorkDir("unknown");
  const res = ob.writeOptimizeBriefDraft(path.join(dir, ".auto", "optimize"), briefArgs({ notes: "x" }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /unknown field "notes"/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize", "brief.json")), false);
});

test("a brief changed after approval is stale, not approved", () => {
  const dir = path.join(makeWorkDir("stale"), ".auto", "optimize");
  const first = ob.writeOptimizeBriefDraft(dir, briefArgs());
  ob.writeOptimizeApproval(dir, true, first.sha256);
  assert.equal(ob.approvedBriefFor(dir).ok, true);
  ob.writeOptimizeBriefDraft(dir, briefArgs({ metric_name: "other" }));
  const after = ob.approvedBriefFor(dir);
  assert.equal(after.ok, false);
  assert.equal(after.reason, "stale_approval");
});

test("a refused brief stays not approved", () => {
  const dir = path.join(makeWorkDir("refused"), ".auto", "optimize");
  const draft = ob.writeOptimizeBriefDraft(dir, briefArgs());
  ob.writeOptimizeApproval(dir, false, draft.sha256);
  assert.equal(ob.approvedBriefFor(dir).reason, "not_approved");
});

test("the consent body is at most 10 lines and starts with the SHA line", () => {
  const brief = ob.validateOptimizeBrief(briefArgs()).brief;
  const body = ob.optimizeConsentSummary(brief, "a".repeat(64)).split("\n");
  assert.ok(body.length <= 10, `dialog has ${body.length} lines`);
  assert.equal(body[0], `Brief SHA-256: ${"a".repeat(64)}`);
});

test("init arguments must equal the brief, with defaults applied on both sides", () => {
  const brief = ob.validateOptimizeBrief({ name: "n", metric_name: "m" }).brief;
  assert.deepEqual(ob.initArgsMismatch(brief, { name: "n", metric_name: "m" }), []);
  assert.equal(ob.initArgsMismatch(brief, { name: "n", metric_name: "m", direction: "higher" }).length, 1);
});

// ── wiring: the real extension ───────────────────────────────────────

// Runs before any test that pins a cwd: the module-level workDir override would leak into this session.
test("direction after start: a changed direction needs a new brief, and the approved one starts with it", async () => {
  const dir = makeWorkDir("direction-change");
  const h = await loadBare(dir, "direction-change");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  const before = readConfigHeaders(dir).length;

  const refused = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "higher" });
  assert.match(refused, /does not match the approved brief/, refused);
  assert.match(refused, /direction: brief "lower", init "higher"/);
  assert.equal(readConfigHeaders(dir).length, before, "a refused direction change must not append a config header");

  await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ direction: "higher" }) });
  await run(h, "optimize_brief", { action: "propose" });
  const started = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "higher" });
  assert.doesNotMatch(started, /refused|does not match/, started);
  const headers = readConfigHeaders(dir);
  assert.equal(headers.length, before + 1);
  assert.equal(headers[headers.length - 1].bestDirection, "higher");
});

test("4.4: changing metric_name after the start needs a new brief; the new metric starts a new segment", async () => {
  const dir = makeWorkDir("metric-change");
  const h = await loadBare(dir, "metric-change");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  const before = readConfigHeaders(dir).length;

  const refused = await run(h, "init_experiment", { name: "liquid speed", metric_name: "bundle_kb", metric_unit: "us", direction: "lower" });
  assert.match(refused, /does not match the approved brief/, refused);
  assert.match(refused, /metric_name: brief "total_us", init "bundle_kb"/);
  assert.equal(readConfigHeaders(dir).length, before, "a refused metric change must not append a config header");

  await run(h, "optimize_brief", { action: "draft", brief: { name: "liquid speed", metric_name: "bundle_kb", metric_unit: "kb" } });
  await run(h, "optimize_brief", { action: "propose" });
  const started = await run(h, "init_experiment", { name: "liquid speed", metric_name: "bundle_kb", metric_unit: "kb" });
  assert.doesNotMatch(started, /refused|does not match/, started);
  const headers = readConfigHeaders(dir);
  assert.equal(headers.length, before + 1, "the approved metric change appends exactly one config header");
  assert.equal(headers[headers.length - 1].metricName, "bundle_kb");
});

// Unpinned tests (5.1, D1) stay before every test that pins a cwd: the module-level _customWorkDir would leak into them.

test("5.1: the ordinary-loop system prompt states the order draft -> propose -> init_experiment", async () => {
  const dir = makeWorkDir("prompt-order");
  const h = await loadBare(dir, "prompt-order");
  const out = await h.hook("before_agent_start")({ systemPrompt: "BASE" }, h.ctx);
  const prompt = out?.systemPrompt ?? "";
  const d = prompt.indexOf("optimize_brief draft");
  const p = prompt.indexOf("propose", d + 1);
  const i = prompt.indexOf("init_experiment with the same", p + 1);
  assert.ok(d > 0 && p > d && i > p, `order draft -> propose -> init_experiment missing in system prompt: ${d} ${p} ${i}`);
  assert.match(prompt, /run_experiment and log_experiment are refused/);
});

test("D1: a legacy session with a config header in log.jsonl works without any brief", async () => {
  const dir = makeWorkDir("legacy-d1");
  // A session started before the two-phase start: the ledger has its config header, there is no .auto/optimize/.
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".auto", "log.jsonl"),
    JSON.stringify({ type: "config", name: "liquid speed", metricName: "total_us", metricUnit: "us", bestDirection: "lower" }) + "\n",
  );
  const h = await loadBare(dir, "legacy-d1");
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.doesNotMatch(init, /refused|does not match|optimize_brief/, init);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize")), false, "resume of the same config must not ask for a brief");

  const run1 = await run(h, "run_experiment", { command: "echo METRIC total_us=1", timeout_seconds: 30 });
  assert.doesNotMatch(run1, /not started|optimize_brief/, run1);
  // The run must land in this session's own ledger, not in a directory pinned by an earlier test.
  const ledger = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
  assert.match(ledger, /"type":"run_started"/, "the run must be logged in this session's own directory");
});

// ── audit round 3: campaign isolation, name change, zero-width cwd ─────

function writeResearchCampaign(dir, id, phase) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
}

test("campaign isolation: an active research campaign refuses optimize_brief and the optimize gates, writing nothing", async () => {
  const dir = makeWorkDir("campaign-isolation");
  writeResearchCampaign(dir, "c1", "research");
  const { pi, tool, command, hook, ctx } = createFakePi({ dir, sessionId: "optimize-campaign-isolation", realGit: false });
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1", makeCtx(dir, "optimize-campaign-isolation", pi));
  const h = { pi, tool, hook, ctx: makeCtx(dir, "optimize-campaign-isolation", pi), dir };
  const BLOCK = /Research campaign active/;

  const draft = await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  assert.match(draft, BLOCK, draft);
  const propose = await run(h, "optimize_brief", { action: "propose" });
  assert.match(propose, BLOCK, propose);
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.match(init, BLOCK, init);
  const runText = await run(h, "run_experiment", { command: "echo METRIC total_us=1", timeout_seconds: 5 });
  assert.match(runText, BLOCK, runText);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize")), false, "no optimize state may be written under a research campaign");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "no ordinary-loop ledger may be written under a research campaign");
});

test("name change after the start needs a new brief, and the approved new name starts a new segment", async () => {
  const dir = makeWorkDir("name-change");
  const h = await loadBare(dir, "name-change");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  const before = readConfigHeaders(dir).length;

  const refused = await run(h, "init_experiment", { name: "other goal", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.match(refused, /does not match the approved brief/, refused);
  assert.match(refused, /name: brief "liquid speed", init "other goal"/);
  assert.equal(readConfigHeaders(dir).length, before, "a refused name change must not append a config header");

  await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ name: "other goal" }) });
  await run(h, "optimize_brief", { action: "propose" });
  const started = await run(h, "init_experiment", { name: "other goal", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.doesNotMatch(started, /refused|does not match/, started);
  const headers = readConfigHeaders(dir);
  assert.equal(headers.length, before + 1, "the approved name change appends exactly one config header");
  assert.equal(headers[headers.length - 1].name, "other goal");
});

test("invisible-format cwd (U+2060, U+180E, U+00AD, U+200E) is refused as empty", async () => {
  const dir = makeWorkDir("invisible-cwd");
  const h = await loadBare(dir, "invisible-cwd");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  for (const cwd of ["\u2060", "\u180E", "\u00AD", "\u200E"]) {
    const text = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd });
    assert.match(text, /cwd must be a non-empty path/, `${JSON.stringify(cwd)} must be refused: ${text}`);
  }
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("zero-width cwd is refused as empty, like a blank one", async () => {
  const dir = makeWorkDir("zero-width-cwd");
  const h = await loadBare(dir, "zero-width-cwd");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  const text = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd: "​​" });
  assert.match(text, /cwd must be a non-empty path/, text);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("draft, owner approval, then init_experiment starts the session", async () => {
  const dir = makeWorkDir("happy");
  const h = await loadBare(dir, "happy");
  h.ctx.ui.confirm = async () => true;
  const draft = await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  assert.match(draft, /Brief draft saved/);
  const propose = await run(h, "optimize_brief", { action: "propose" });
  assert.match(propose, /Brief approved/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "optimize", "approval.json"), "utf-8")).confirmed, true);
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.doesNotMatch(init, /refused|does not match/, init);
});

test("the owner refusal is recorded and init_experiment stays refused", async () => {
  const dir = makeWorkDir("refuse");
  const h = await loadBare(dir, "refuse");
  h.ctx.ui.confirm = async () => false;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  const propose = await run(h, "optimize_brief", { action: "propose" });
  assert.match(propose, /did not confirm/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "optimize", "approval.json"), "utf-8")).confirmed, false);
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.match(init, /init_experiment refused \(not_approved\)/);
});

test("init_experiment with a metric different from the approved brief is refused", async () => {
  const dir = makeWorkDir("mismatch");
  const h = await loadBare(dir, "mismatch");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "bundle_kb", metric_unit: "us", direction: "lower" });
  assert.match(init, /does not match the approved brief/);
  assert.match(init, /metric_name: brief "total_us", init "bundle_kb"/);
});

test("run_experiment before the start names the missing step", async () => {
  const dir = makeWorkDir("gate");
  const h = await loadBare(dir, "gate");
  const text = await run(h, "run_experiment", { command: "echo 1", timeout_seconds: 5, hypothesis_id: undefined });
  assert.match(text, /next step is optimize_brief draft/);
});

test("propose without an interactive dialog approves nothing", async () => {
  const dir = makeWorkDir("noui");
  const h = await loadBare(dir, "noui");
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  h.ctx.hasUI = false;
  const propose = await run(h, "optimize_brief", { action: "propose" });
  assert.match(propose, /needs an interactive dialog/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize", "approval.json")), false);
});

test("a model-supplied approval field is refused", async () => {
  const dir = makeWorkDir("fields");
  const h = await loadBare(dir, "fields");
  const text = await run(h, "optimize_brief", { action: "propose", confirmed: true });
  assert.match(text, /approval and confirmation fields are not model arguments/);
});

test("the transcript row shows the readable brief before the dialog, not JSON", async () => {
  const dir = makeWorkDir("row");
  const h = await loadBare(dir, "row");
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  const component = h.tool("optimize_brief").renderCall({ action: "propose" }, { fg: (_c, t) => t, bold: (t) => t }, {});
  const out = String(Array.isArray(component.render(200)) ? component.render(200).join("\n") : component.render(200));
  assert.match(out, /Бриф оптимизации/);
  assert.match(out, /total_us/);
  assert.doesNotMatch(out, /"schema_version"/);
});

// ── review round 1 (b2109ec6): blockers and gaps ─────────────────────

function readConfigHeaders(dir) {
  const p = path.join(dir, ".auto", "log.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "config");
}

test("B1: a started session cannot be re-initialised in another directory with the same fields", async () => {
  const dir = makeWorkDir("cwd-bypass");
  const other = makeWorkDir("cwd-bypass-other");
  const h = await loadBare(dir, "cwd-bypass");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  const init = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd: other });
  assert.match(init, /refused|does not match/, init);
  assert.equal(fs.existsSync(path.join(other, ".auto", "log.jsonl")), false, "the other directory's ledger must not be written");
});

test("B2: a multi-line name is refused at draft, so the dialog budget holds", async () => {
  const dir = makeWorkDir("multiline");
  const h = await loadBare(dir, "multiline");
  const text = await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ name: "liquid\n\n\n\n\n\n\n\n\n\n\n\nspeed" }) });
  assert.match(text, /single line/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize", "brief.json")), false);
});

test("B2: the consent body counts physical lines, not array items", async () => {
  const { consentDialogBody } = await import("../extensions/pi-autoresearch/brief-consent.ts");
  assert.throws(() => consentDialogBody("a".repeat(64), ["x\n\n\n\n\n\n\n\n\n\n"], "Q?"), /line budget/);
});

test("B3: an approved brief without direction starts with lower, not with an inherited higher", async () => {
  const dir = makeWorkDir("direction");
  const h = await loadBare(dir, "direction");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ name: "a", direction: "higher" }) });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "a", metric_name: "total_us", metric_unit: "us", direction: "higher" });
  await run(h, "optimize_brief", { action: "draft", brief: { name: "b", metric_name: "total_us" } });
  await run(h, "optimize_brief", { action: "propose" });
  const init = await run(h, "init_experiment", { name: "b", metric_name: "total_us" });
  assert.doesNotMatch(init, /refused|does not match/, init);
  const headers = readConfigHeaders(dir);
  assert.equal(headers[headers.length - 1].bestDirection, "lower");
});

test("gap: a refused init leaves log.jsonl absent and brief.json byte-identical", async () => {
  const dir = makeWorkDir("no-write");
  const h = await loadBare(dir, "no-write");
  h.ctx.ui.confirm = async () => false;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  const briefBefore = fs.readFileSync(path.join(dir, ".auto", "optimize", "brief.json"), "utf-8");
  await run(h, "optimize_brief", { action: "propose" });
  assert.equal(fs.readFileSync(path.join(dir, ".auto", "optimize", "brief.json"), "utf-8"), briefBefore);
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower" });
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("N5: propose refuses a brief argument instead of ignoring it", async () => {
  const dir = makeWorkDir("propose-brief");
  const h = await loadBare(dir, "propose-brief");
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs() });
  const text = await run(h, "optimize_brief", { action: "propose", brief: briefArgs({ metric_name: "other" }) });
  assert.match(text, /propose takes no brief/);
});

test("B2 round 2: U+2028 and U+0085 in a name are refused at draft", async () => {
  const dir = makeWorkDir("unicode-breaks");
  const h = await loadBare(dir, "unicode-breaks");
  for (const name of ["liquid\u2028speed", "liquid\u0085speed"]) {
    const text = await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ name }) });
    assert.match(text, /single line/, `name with ${JSON.stringify(name)} must be refused`);
  }
  assert.equal(fs.existsSync(path.join(dir, ".auto", "optimize", "brief.json")), false);
});

test("B4: a pinned session (init with cwd) refuses a cwd-less brief and writes nothing to the pinned dir", async () => {
  const dir = makeWorkDir("pin-a");
  const pinned = makeWorkDir("pin-b");
  const h = await loadBare(dir, "pin");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ cwd: pinned }) });
  await run(h, "optimize_brief", { action: "propose" });
  const first = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd: pinned });
  assert.doesNotMatch(first, /refused|does not match/, first);
  const before = readConfigHeaders(pinned).length;
  await run(h, "optimize_brief", { action: "draft", brief: { name: "other", metric_name: "bundle_kb" } });
  await run(h, "optimize_brief", { action: "propose" });
  const second = await run(h, "init_experiment", { name: "other", metric_name: "bundle_kb" });
  assert.match(second, /does not match the approved brief/, second);
  assert.match(second, /cwd: brief ""/);
  assert.equal(readConfigHeaders(pinned).length, before, "the pinned dir's ledger must not get a new config header");
});

test("B4 round 3: init with cwd \"\" is refused on a pinned session and writes no config header", async () => {
  const dir = makeWorkDir("empty-cwd-a");
  const pinned = makeWorkDir("empty-cwd-b");
  const h = await loadBare(dir, "empty-cwd");
  h.ctx.ui.confirm = async () => true;
  await run(h, "optimize_brief", { action: "draft", brief: briefArgs({ cwd: pinned }) });
  await run(h, "optimize_brief", { action: "propose" });
  await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd: pinned });
  const before = readConfigHeaders(pinned).length;
  const text = await run(h, "init_experiment", { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", cwd: "" });
  assert.match(text, /cwd must be a non-empty path/, text);
  assert.equal(readConfigHeaders(pinned).length, before, "the pinned dir's ledger must not get a new config header");
  assert.equal(readConfigHeaders(dir).length, 0, "the session dir must not get a config header from the refused call");
});
