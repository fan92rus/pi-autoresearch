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

// ── tj0.2: transactional mode-transition invariant matrix ────────────────
function ledgerEntries(dir) {
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function switchFinalizes(dir, reason) {
  return ledgerEntries(dir).filter((e) => e.type === "finalize" && e.reason === reason);
}

async function launchAndProposeExpedition(h) {
  await h.command("autoresearch").handler("expedition study latency", h.ctx);
  await h.tool("expedition_brief").execute("id", { action: "draft", doc }, null, null, h.ctx);
  const created = await h.tool("expedition_brief").execute("id", { action: "propose" }, null, null, h.ctx);
  const id = text(created).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(id, text(created));
  return id;
}

function setCampaignPhase(dir, id, phase) {
  const statePath = path.join(dir, ".auto", "research", id, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.phase = phase;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function seedBlockingCampaign(dir, id, { phase = "research", unreadable = false, pending = false } = {}) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "state.json"), unreadable
    ? "{broken\n"
    : JSON.stringify({
      schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase,
    }, null, 2) + "\n");
  if (pending) fs.writeFileSync(path.join(campaignDir, "pending-op.json"), "{}");
}

function seedCandidateCampaign(dir) {
  const candidateDir = path.join(dir, ".auto", "candidate");
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(candidateDir, "state.json"), "{}\n");
}

test("tj0.2 mode-transition invariant matrix", async (t) => {
  await t.test("expedition → optimization: journal, single finalize/report, no OFF notification", async () => {
    const dir = workdir();
    const h = await harness(dir);
    const id = await launchAndProposeExpedition(h);
    setCampaignPhase(dir, id, "stopped");

    await h.command("autoresearch").handler("optimize the metric", h.ctx);
    const rt = h.ext.runtimeForTest(h.ctx);
    assert.equal(rt.uiMode, "optimization");
    assert.equal(rt.researchChain, null);
    const journal = fs.readFileSync(path.join(dir, ".auto", "research-chain", `${id}-chain`, "chain.json"), "utf8");
    assert.match(journal, /"type":"expedition_stop"/);
    assert.match(journal, /"status":"completed"/);
    assert.equal(switchFinalizes(dir, "switch to optimization mode").length, 1);
    assert.ok(fs.existsSync(path.join(dir, ".auto", "report.md")));
    const notices = h.pi.notifications.map((n) => n.text).join("\n");
    assert.doesNotMatch(notices, /research mode OFF/i, "a mode switch must not announce research OFF before ON");
    assert.match(notices, /Autoresearch mode ON/);
    assert.match(lastWidget(h), /runs|baseline|🔬/);
  });

  await t.test("optimization → expedition: one switch finalize and expedition kickoff", async () => {
    const dir = workdir();
    const h = await harness(dir);
    plantOptimization(dir);
    await h.command("autoresearch").handler("on", h.ctx);
    await h.command("autoresearch").handler("expedition study latency", h.ctx);
    assert.equal(h.ext.runtimeForTest(h.ctx).uiMode, "expedition");
    assert.equal(switchFinalizes(dir, "switch to expedition mode").length, 1);
    assert.match(lastWidget(h), /expedition/i);
    assert.ok(h.pi.sentMessages.some((m) => /Expedition design phase\. Goal: study latency/.test(m.text)));
  });

  await t.test("repeated design-phase expedition: no second finalize", async () => {
    const dir = workdir();
    const h = await harness(dir);
    plantOptimization(dir);
    await h.command("autoresearch").handler("on", h.ctx);
    await h.command("autoresearch").handler("expedition first goal", h.ctx);
    assert.equal(switchFinalizes(dir, "switch to expedition mode").length, 1);
    await h.command("autoresearch").handler("expedition second goal", h.ctx);
    assert.equal(switchFinalizes(dir, "switch to expedition mode").length, 1, "design phase stays in expedition: finalize is idempotent");
    assert.equal(h.ext.runtimeForTest(h.ctx).uiMode, "expedition");
    assert.ok(h.pi.sentMessages.some((m) => /Expedition design phase\. Goal: second goal/.test(m.text)), "kickoff is still delivered");
  });

  await t.test("off → on: stale expedition chain and view are cleared", async () => {
    const dir = workdir();
    const h = await harness(dir);
    const id = await launchAndProposeExpedition(h);
    const rt = h.ext.runtimeForTest(h.ctx);
    rt.chainContinuationSent = true;

    await h.command("autoresearch").handler("off", h.ctx);
    assert.equal(rt.autoresearchMode, false);
    assert.equal(rt.researchChain, null, "off unbinds the expedition chain");
    assert.equal(rt.chainContinuationSent, false, "off re-arms the continuation flag");

    // The journal may stay on disk; remove only the finished campaign state so
    // the ordinary launch guard has nothing to block on.
    fs.rmSync(path.join(dir, ".auto", "research", id), { recursive: true, force: true });
    await h.command("autoresearch").handler("on", h.ctx);
    assert.equal(rt.uiMode, "optimization");
    assert.match(lastWidget(h), /0 runs — waiting for baseline/);
    assert.doesNotMatch(lastWidget(h), /expedition/i, "ordinary launch never renders a stale expedition view");
  });

  await t.test("mode switch drops a live fullscreen overlay", async (st) => {
    const dir = workdir();
    const h = await harness(dir);
    await h.command("autoresearch").handler("on", h.ctx);
    h.ext.runtimeForTest(h.ctx).state.results = [{ run: 1, status: "keep", metric: 100, metrics: {} }];
    let overlayRenders = 0;
    let overlayView = null;
    // A fake custom() never runs the view's dispose() on its own; release the
    // spinner timer at the end so the assertion is about the mode switch, not
    // about teardown of the harness.
    st.after(() => overlayView?.dispose?.());
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => { overlayRenders++; } };
      overlayView = factory(tui, { fg: (_style, s) => s }, {}, () => {});
    };
    await h.command("autoresearch").handler("dashboard", h.ctx);
    await h.hook("agent_end")({ messages: [] }, h.ctx);
    assert.ok(overlayRenders > 0, "fullscreen overlay is live before the switch");

    await h.command("autoresearch").handler("expedition study latency", h.ctx);
    const afterSwitch = overlayRenders;
    await h.hook("agent_end")({ messages: [] }, h.ctx);
    assert.equal(overlayRenders, afterSwitch, "stale optimization overlay no longer renders in expedition mode");
  });

  await t.test("refused ordinary launch changes no mode, view, activation or kickoff", async () => {
    const dir = workdir();
    const h = await harness(dir);
    seedBlockingCampaign(dir, "exp-blocking");
    const activationCount = () => h.pi.entries.filter((e) => e.customType === "pi-autoresearch.activation").length;
    const before = { messages: h.pi.sentMessages.length, activations: activationCount() };

    await h.command("autoresearch").handler("optimize the metric", h.ctx);
    const rt = h.ext.runtimeForTest(h.ctx);
    assert.equal(rt.autoresearchMode, false, "refusal does not leave the mode ON");
    assert.equal(rt.uiMode, "optimization");
    assert.equal(h.pi.widgets.at(-1)?.widget, undefined, "refusal leaves the widget cleared");
    assert.equal(h.pi.sentMessages.length, before.messages, "refusal sends no kickoff");
    assert.equal(activationCount(), before.activations, "refusal records no activation");
    assert.ok(h.pi.notifications.some((n) => /Research campaign active — continue it with research_questions/.test(n.text)));
  });

  await t.test("briefing/stopped/pending/unreadable research: manual activation stays ON, kickoff suppressed", async () => {
    const variants = [
      { name: "briefing", seed: (dir) => seedBlockingCampaign(dir, "exp-briefing", { phase: "briefing" }) },
      { name: "stopped", seed: (dir) => seedBlockingCampaign(dir, "exp-finished", { phase: "stopped" }) },
      { name: "pending op", seed: (dir) => seedBlockingCampaign(dir, "exp-pending", { phase: "stopped", pending: true }) },
      { name: "unreadable", seed: (dir) => seedBlockingCampaign(dir, "exp-broken", { unreadable: true }) },
    ];
    for (const variant of variants) {
      const dir = workdir();
      const h = await harness(dir);
      variant.seed(dir);
      const messagesBefore = h.pi.sentMessages.length;

      await h.command("autoresearch").handler("optimize the metric", h.ctx);
      const rt = h.ext.runtimeForTest(h.ctx);
      assert.equal(rt.autoresearchMode, true, `${variant.name}: research tools stay reachable for manual recovery`);
      assert.equal(rt.uiMode, "optimization");
      assert.match(lastWidget(h), /0 runs — waiting for baseline/);
      assert.equal(h.pi.sentMessages.length, messagesBefore, `${variant.name}: the ordinary kickoff stays suppressed`);
      assert.ok(h.pi.notifications.some((n) => /Research campaign active — continue it with research_questions\(action=status\); the legacy autoresearch kickoff is not sent\./.test(n.text)), `${variant.name}: exact notice`);
    }
  });

  await t.test("candidate block refuses before any mutation", async () => {
    const variants = [
      { name: "candidate campaign", seed: seedCandidateCampaign, notice: /Candidate campaign active — continue it with candidate_branch status/ },
    ];
    for (const variant of variants) {
      const dir = workdir();
      const h = await harness(dir);
      variant.seed(dir);
      const activationCount = () => h.pi.entries.filter((e) => e.customType === "pi-autoresearch.activation").length;
      const before = { messages: h.pi.sentMessages.length, activations: activationCount() };

      await h.command("autoresearch").handler("optimize the metric", h.ctx);
      const rt = h.ext.runtimeForTest(h.ctx);
      assert.equal(rt.autoresearchMode, false, `${variant.name}: mode untouched`);
      assert.equal(rt.uiMode, "optimization", `${variant.name}: view untouched`);
      assert.equal(rt.researchChain, null, `${variant.name}: no chain binding created`);
      assert.equal(h.pi.widgets.at(-1)?.widget, undefined, `${variant.name}: no widget registered`);
      assert.equal(h.pi.sentMessages.length, before.messages, `${variant.name}: no kickoff`);
      assert.equal(activationCount(), before.activations, `${variant.name}: no activation entry`);
      assert.ok(h.pi.notifications.some((n) => variant.notice.test(n.text)), `${variant.name}: exact refusal notice`);
    }
  });
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
