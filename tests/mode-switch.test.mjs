/**
 * es1.7/es1.8 — mutual exclusion between the legacy optimization loop and a
 * research expedition, plus a TUI that matches the active mode.
 *
 * Run:
 *   timeout 240 node --experimental-strip-types --env-file=./tests/test.env \
 *     --experimental-loader ./tests/redirect-loader.mjs --test tests/mode-switch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const brief = {
  schema_version: 1, goal: "Study cache latency", plan_source: "plan.md", caveat_block: "Observational only",
  data_roles: { explore: [], validate: [], confirm: [] },
  questions: [{ id: "Q1", text: "Does latency improve?", needs_data: null, decision_rules: [
    { id: "yes", verdict: "confirmed", when: "measured improvement" },
    { id: "no", verdict: "rejected", when: "no improvement" },
    { id: "unknown", verdict: "inconclusive", when: "unclear" },
    { id: "wait", verdict: "waiting_for_data", when: "data missing" },
  ] }],
  process_metrics: [], stop_rules: [],
};
const doc = { charter: { stop_rules: [] }, goal: "Study cache latency", directions: [{ name: "cache", why: "Measure cache effects" }], campaign0: brief };
const text = (r) => r?.content?.[0]?.text ?? "";
function workdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mode-switch-")); }

async function harness(dir, sessionId = "mode-switch") {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId, realGit: false });
  const ctx = makeCtx(dir, sessionId, pi);
  // expedition_brief propose asks the owner to confirm the document; every
  // other expedition harness supplies this fake-pi surface explicitly.
  ctx.ui.confirm = async () => true;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  return { pi, tool, command, hook, ctx, ext };
}

function plantOptimization(dir) {
  const auto = path.join(dir, ".auto");
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, "log.jsonl"), [
    JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" }),
    JSON.stringify({ run: 1, metric: 100, status: "keep", description: "baseline" }),
  ].join("\n") + "\n");
}

function lastWidget(h) {
  const entries = h.pi.widgets.filter((w) => w.name === "autoresearch" && w.widget);
  assert.ok(entries.length > 0, "extension registered an autoresearch widget");
  const widget = entries.at(-1).widget;
  // Theme.fg(style, text) returns the styled TEXT; a one-argument stub would
  // discard every label and make any widget assertion meaningless.
  const obj = typeof widget === "function" ? widget(null, { fg: (_style, s) => s }) : widget;
  return obj.render(200).join("\n");
}

test("expedition launch finalizes active optimization and shows the expedition TUI", async () => {
  const dir = workdir();
  const h = await harness(dir);
  plantOptimization(dir);
  await h.command("autoresearch").handler("on", h.ctx);
  assert.equal(h.ext.runtimeForTest(h.ctx).uiMode, "optimization");

  await h.command("autoresearch").handler("expedition study latency", h.ctx);
  const rt = h.ext.runtimeForTest(h.ctx);
  assert.equal(rt.uiMode, "expedition", "mode switch is explicit, not inferred from a chain that does not exist yet");
  const lines = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(lines.some((e) => e.type === "finalize" && /expedition/i.test(e.reason ?? "")), "active optimization is finalized at expedition launch");
  assert.ok(fs.existsSync(path.join(dir, ".auto", "report.md")), "finalize writes the campaign report");
  assert.match(lastWidget(h), /expedition/i, "TUI follows the expedition mode");
  assert.doesNotMatch(lastWidget(h), /0 runs — waiting for baseline/, "no stale optimization widget after the switch");
});

test("starting optimization finalizes an expedition with no campaign in research and restores the optimization TUI", async () => {
  const dir = workdir();
  const h = await harness(dir);
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  await h.tool("expedition_brief").execute("id", { action: "draft", doc }, null, null, h.ctx);
  const created = await h.tool("expedition_brief").execute("id", { action: "propose" }, null, null, h.ctx);
  const id = text(created).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(id, text(created));
  assert.equal(h.ext.runtimeForTest(h.ctx).uiMode, "expedition");

  // The campaign has already reported; finalizing the expedition is safe.
  const statePath = path.join(dir, ".auto", "research", id, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.phase = "stopped";
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  await h.command("autoresearch").handler("optimize the metric", h.ctx);
  const rt = h.ext.runtimeForTest(h.ctx);
  assert.equal(rt.uiMode, "optimization");
  assert.equal(rt.researchChain, null, "expedition binding is removed before the optimization starts");
  const journal = fs.readFileSync(path.join(dir, ".auto", "research-chain", `${id}-chain`, "chain.json"), "utf8");
  assert.ok(journal.includes('"type":"expedition_stop"'), "expedition is journaled as stopped");
  assert.ok(journal.includes('"status":"completed"'), "expedition chain is completed");
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  const entries = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(entries.some((e) => e.type === "finalize" && /optimization/i.test(e.reason ?? "")), "mode switch records a finalize entry");
  assert.match(lastWidget(h), /runs|baseline|🔬/, "TUI follows the optimization mode");
});

test("starting optimization refuses while an expedition campaign is still in research", async () => {
  const dir = workdir();
  const h = await harness(dir);
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  await h.tool("expedition_brief").execute("id", { action: "draft", doc }, null, null, h.ctx);
  const created = await h.tool("expedition_brief").execute("id", { action: "propose" }, null, null, h.ctx);
  const id = text(created).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(id, text(created));

  await h.command("autoresearch").handler("optimize the metric", h.ctx);
  assert.equal(h.ext.runtimeForTest(h.ctx).uiMode, "expedition", "no silent mode switch");
  assert.ok(h.ext.runtimeForTest(h.ctx).researchChain, "expedition stays bound");
  assert.ok(h.pi.notifications.some((n) => /phase research|finish|finalize/i.test(n.text)), "explicit refusal reason is shown");
  const journal = fs.readFileSync(path.join(dir, ".auto", "research-chain", `${id}-chain`, "chain.json"), "utf8");
  assert.ok(!journal.includes('"type":"expedition_stop"'), "no journal mutation on refusal");
});
