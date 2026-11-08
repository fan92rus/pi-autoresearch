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
