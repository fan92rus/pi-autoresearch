/**
 * Expedition completion through finalize_research (owner request 2026-11-14,
 * live lob-collector-data): a finished expedition chain (all campaigns stopped,
 * chain in awaiting_child) used to restore on every restart forever — no tool
 * recorded completion. finalize_research on a pinned expedition now:
 *   - refuses while any chain campaign is still in phase research;
 *   - journals expedition_stop + status completed, writes the final expedition
 *     report, leaves research mode, archives finished campaigns;
 *   - is idempotent on an already-final chain (no journal writes).
 *
 * Run: timeout 240 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/expedition-finalize.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const brief = {
  schema_version: 1, goal: "Study cache latency", plan_source: "plan.md",
  caveat_block: "Observational only", data_roles: { explore: [], validate: [], confirm: [] },
  questions: [{ id: "Q1", text: "Does latency improve?", decision_rules: [
    { id: "yes", verdict: "confirmed", when: "measured improvement" },
    { id: "no", verdict: "rejected", when: "no improvement" },
    { id: "unknown", verdict: "inconclusive", when: "unclear" },
    { id: "wait", verdict: "waiting_for_data", when: "data missing" },
  ], needs_data: null }],
  process_metrics: [], stop_rules: [{ id: "S1", when: "work finished" }],
};
const doc = { charter: { stop_rules: ["territory_complete"] }, goal: "Study cache latency", directions: [{ name: "cache", why: "Measure cache effects" }], campaign0: brief };

function workdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "expedition-finalize-")); }

async function harness(dir, confirm = true) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: "exp-finalize", realGit: false });
  const ctx = makeCtx(dir, "exp-finalize", pi);
  ctx.ui.confirm = async () => confirm;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  return { pi, tool, command, ctx, ext };
}
const text = (r) => r?.content?.[0]?.text ?? "";
const call = (h, name, params) => h.tool(name).execute("id", params, null, null, h.ctx);

/** Builds a live expedition chain with campaign 0 in phase research. */
async function makeExpedition(dir) {
  const h = await harness(dir, true);
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  await call(h, "expedition_brief", { action: "draft", doc });
  const out = await call(h, "expedition_brief", { action: "propose" });
  const id = text(out).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(id, text(out));
  return { h, id, chainId: `${id}-chain` };
}

/** Moves campaign 0 through start → (no questions) → stop → report. The chain
 *  then sits in awaiting_child with NO active research-phase campaign. */
async function finishCampaign0(h, id) {
  const shaPath = path.join(dir0(h), ".auto", "research", id, "brief.json");
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(fs.readFileSync(shaPath)).digest("hex");
  const start = await call(h, "research_questions", { action: "start", expected_sha256: sha });
  assert.match(text(start), /started|running|✅|Start/i, text(start));
  const stop = await call(h, "research_questions", { action: "stop", rule_id: "S1", reason: "done" });
  assert.match(text(stop), /Research stopped by S1/, text(stop));
  const report = await call(h, "research_questions", { action: "report" });
  assert.match(text(report), /awaiting_child|awaiting the brief/, text(report));
  return report;
}
const dir0 = (h) => h.ctx.cwd;

function chainStatus(dir, chainId) {
  const entries = fs.readFileSync(path.join(dir, ".auto", "research-chain", chainId, "chain.json"), "utf8")
    .trim().split("\n").map(JSON.parse);
  let status = "";
  for (const e of entries) if (e.type === "status_change" && typeof e.status === "string") status = e.status;
  const stops = entries.filter((e) => e.type === "expedition_stop");
  return { status, stopCount: stops.length, entries };
}

test("finalize refuses while an expedition campaign is still in phase research", async () => {
  const dir = workdir();
  const { h, chainId } = await makeExpedition(dir);
  const res = await call(h, "finalize_research", { reason: "done" });
  assert.match(text(res), /phase research/, text(res));
  assert.match(text(res), /strand/, "refusal explains the stranding risk");
  const st = chainStatus(dir, chainId);
  assert.equal(st.stopCount, 0, "no expedition_stop journaled during a refused finalize");
  assert.equal(st.status, "active", "chain status unchanged after the refused finalize");
});

test("finalize marks a finished expedition completed: stop entry, completed status, report, mode OFF, no restore", async () => {
  const dir = workdir();
  const { h, id, chainId, ext } = await makeExpedition(dir);
  await finishCampaign0(h, id);

  const res = await call(h, "finalize_research", { reason: "all directions closed" });
  const out = text(res);
  assert.match(out, /marked completed/, out);
  assert.match(out, /Expedition report saved/, out);
  assert.match(out, /Archived finished campaigns/, "finished campaigns are archived so nothing blocks or restores");
  assert.ok(h.pi.notifications.some((n) => /research mode OFF/.test(n.text)), "research mode is left");

  const st = chainStatus(dir, chainId);
  assert.equal(st.stopCount, 1, "exactly one expedition_stop entry");
  assert.equal(st.status, "completed");
  const stopEntry = st.entries.filter((e) => e.type === "expedition_stop")[0];
  assert.equal(stopEntry.basis, "rule");
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research-chain", chainId, "expedition-report.md")));

  // No restore on restart: the chain is final, scanActiveExpeditionChains skips it.
  const extMod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  const freshCtx = makeCtx(dir, "exp-finalize-after", h.pi);
  await extMod.restoreExpeditionForTest(freshCtx);
  assert.ok(!h.pi.sentMessages.some((m) => /restored after restart/.test(m.text)), "completed chain must not restore");

  // The archive holds the finished campaign; the research root is empty.
  const archiveRoot = path.join(dir, ".auto", "research-archive");
  assert.ok(fs.existsSync(archiveRoot) && fs.readdirSync(archiveRoot).some((n) => n.startsWith(id)), "campaign archived");
  const researchRoot = path.join(dir, ".auto", "research");
  const remaining = fs.existsSync(researchRoot) ? fs.readdirSync(researchRoot).filter((n) => fs.existsSync(path.join(researchRoot, n, "state.json"))) : [];
  assert.equal(remaining.length, 0, "no campaigns left to block the ordinary loop");
});

test("finalize on an already-final expedition chain is idempotent (no journal writes)", async () => {
  const dir = workdir();
  const { h, id, chainId } = await makeExpedition(dir);
  await finishCampaign0(h, id);
  const first = await call(h, "finalize_research", { reason: "done" });
  assert.match(text(first), /marked completed/, text(first));
  const before = fs.readFileSync(path.join(dir, ".auto", "research-chain", chainId, "chain.json"), "utf8");

  // A fresh session re-binds nothing (chain is final), so pin manually is impossible —
  // finalize with NO pinned chain must not touch the final chain journal either
  // (the ordinary branch: research block is gone after archive).
  const h2ctx = makeCtx(dir, "exp-finalize-2", h.pi);
  h2ctx.ui.confirm = async () => true;
  const second = await h.tool("finalize_research").execute("id", { reason: "again" }, null, null, h2ctx);
  assert.ok(!text(second).includes("already"), text(second));
  const after = fs.readFileSync(path.join(dir, ".auto", "research-chain", chainId, "chain.json"), "utf8");
  assert.equal(after, before, "final chain journal untouched by a second finalize");
  assert.equal(after.split("\n").filter((l) => l.includes('"expedition_stop"')).length, 1, "exactly one expedition_stop entry after both finalizes");
  void id;
});

test("finalize without an expedition keeps the legacy gates (blocked by an active research campaign)", async () => {
  const dir = workdir();
  const h = await harness(dir, true);
  // A plain pinned research campaign in phase research (no expedition), started
  // the same way the legacy flow does: /autoresearch research --id c1.
  await h.command("autoresearch").handler("research --id c1", h.ctx);
  const draft = await call(h, "research_brief", { action: "draft", brief: { ...brief, stop_rules: [{ id: "S1", when: "work finished" }] } });
  assert.match(text(draft), /draft saved/i, text(draft));
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(text(proposed), /approved/i, text(proposed));
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "brief.json"))).digest("hex");
  await call(h, "research_questions", { action: "start", expected_sha256: sha });
  const res = await call(h, "finalize_research", { reason: "done" });
  assert.match(text(res), /Research campaign active/, "legacy finalize is refused by the research block");
});
