import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { registerSearchPrecedentsTool } from "../extensions/pi-autoresearch/precedent-report.ts";
import { registerAssessPrecedentsTool } from "../extensions/pi-autoresearch/precedent-assess.ts";
import { buildBrief, loadLatestPrecedentDigest } from "../extensions/pi-autoresearch/council.ts";

const PROBLEM = "lobprobe parsing throughput parser regression";
const LEGACY_LEDGER = "autoresearch.jsonl";
const CURRENT_LEDGER = ".auto/log.jsonl";

// Fake Pi exposes the real registered tool definitions and invokes their actual execute methods.
function fakePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    async call(name, params, cwd) {
      const tool = tools.get(name);
      assert.ok(tool, `registered tool ${name}`);
      return tool.execute(`e2e-${name}`, params, undefined, undefined, { cwd });
    },
  };
}

function write(root, rel, content) {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function entry(obj) { return `${JSON.stringify(obj)}\n`; }

/** Generate deterministic campaign catalogs (stable record order/content, unique temporary roots). */
function generateCampaign(root, kind) {
  fs.mkdirSync(path.join(root, ".auto"), { recursive: true });
  if (kind === "empty") { write(root, LEGACY_LEDGER, ""); return; }
  const records = [
    { type: "config", name: "lobprobe", metricName: "requests_per_second", metricUnit: "ops/s" },
    { run: 1, commit: "a11ce01", status: "keep", metric: 120, description: "lobprobe parsing throughput improved with buffered token scanning" },
    { run: 2, commit: "a11ce02", status: "discard", metric: 90, description: "lobprobe parsing throughput regressed with oversized allocation" },
    { run: 3, commit: "a11ce01", status: "discard", metric: 70, description: "late refutation: a11ce01 was invalid under full validation; throughput gain was false" },
    { type: "note", text: "clarification: the earlier a11ce01 keep fails on large records" },
    { type: "config", name: "perf-profile", metricName: "memory_bytes", metricUnit: "bytes" },
    { run: 4, commit: "beef004", status: "keep", metric: 4096, description: "perf profile parser throughput cache cuts memory allocation" },
    { type: "config", name: "perf-profile-v2", metricName: "latency", metricUnit: "ns" },
    { run: 5, commit: "beef004", status: "discard", metric: 9000, description: "parser throughput regressed in latency profile" },
  ];
  // Mixed modern config + legacy ledger is intentional: the precedent source must choose legacy.
  write(root, LEGACY_LEDGER, records.map(entry).join(""));
  write(root, ".auto/config.json", JSON.stringify({ campaign: "lobprobe", council: { share_precedent_details: false } }, null, 2));
  if (kind === "rich") {
    write(root, ".auto/tree.json", JSON.stringify({
      version: 1, rootId: "n0", activeNodeId: "n1", baselineMetric: 200,
      direction: "higher", metricName: "requests_per_second",
      nodes: { n0: { id: "n0", hypothesis: "baseline" }, n1: { id: "n1", hypothesis: "lobprobe parsing throughput with bounded buffers", status: "keep", metric: 120, commit: "a11ce01" } },
    }, null, 2));
    write(root, ".auto/ideas/idea.md", "# lobprobe parsing throughput\nConsider a bounded token cache; validate on large records.\n");
    write(root, ".auto/councils/1/summary.md", "lobprobe parsing throughput: buffered scanning won only on the small profile.\n");
  }
}

function setup(t, kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-precedents-${kind}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  generateCampaign(root, kind);
  const pi = fakePi();
  registerSearchPrecedentsTool(pi);
  registerAssessPrecedentsTool(pi);
  return { root, pi };
}

async function search(pi, root, problem = PROBLEM) {
  const result = await pi.call("search_precedents", { problem, ...(problem === PROBLEM ? { finding_ref: "finding/lobprobe-17" } : {}) }, root);
  assert.equal(result.content[0].type, "text");
  assert.ok(!result.content[0].text.startsWith("❌"), result.content[0].text);
  return JSON.parse(result.content[0].text);
}

function candidate(report, predicate = () => true) {
  const found = report.search.candidates.find(predicate);
  assert.ok(found, `expected candidate among ${report.search.candidates.length}`);
  return found;
}

function councilBrief(root, precedents) {
  const dir = path.join(root, ".auto", "councils", "9");
  const brief = buildBrief(root, dir, {
    seq: 9, metricName: "requests_per_second", metricUnit: "ops/s", direction: "higher",
    baselineMetric: 100, bestMetric: 120, noiseFloor: 2, goal: "lobprobe parsing",
    precedents,
  });
  return brief.text;
}

test("E2E empty campaign: report is no-matches and brief says not-searched", async (t) => {
  const { root, pi } = setup(t, "empty");
  const report = await search(pi, root);
  assert.equal(report.search.outcome, "no-matches", "an empty but readable legacy ledger is a complete search");
  assert.equal(report.search.memory.status, "unavailable");
  assert.equal(report.search.candidates.length, 0);
  const digest = await loadLatestPrecedentDigest(root);
  assert.equal(digest, null);
  const brief = councilBrief(root, digest);
  assert.match(brief, /not-searched/);
});

test("E2E rich campaign: source selection, late refutation, assessment action and private council digest", async (t) => {
  const { root, pi } = setup(t, "rich");
  const report = await search(pi, root);
  assert.equal(report.query.finding_ref, "finding/lobprobe-17");
  assert.equal(report.search.outcome, "matches");
  assert.equal(report.search.memory.status, "unavailable");
  assert.equal(report.search.sources.find((s) => s.source === "log").ledger, "legacy");
  assert.ok(report.search.candidates.length >= 5, "success, failure and tree/idea/archive records are candidates");
  const failed = candidate(report, (c) => c.ref.source === "log" && c.ref.line === 3);
  assert.match(failed.untrusted_content.text, /oversized allocation/, "failed experiment description is present for evaluation");
  const perfReport = await search(pi, root, "perf profile parser throughput");
  const perf = candidate(perfReport, (c) => c.ref.source === "log" && c.ref.line === 7);
  const perfFollowUp = perf.follow_up.links.find((link) => link.ref.line === 9);
  assert.ok(perfFollowUp, "perf-profile candidate finds the later discard by its commit");
  assert.equal(perfFollowUp.scale_relation, "different");
  assert.equal(Object.hasOwn(perfFollowUp, "delta"), false, "cross-scale metric deltas are forbidden");
  const keep = candidate(report, (c) => c.ref.source === "log" && c.ref.line === 2);
  assert.equal(keep.follow_up.classification, "unknown", "historical keep is not presumed supported");
  assert.ok(keep.follow_up.links.some((link) => link.ref.line === 4), "late record is linked by identifier");
  assert.ok(keep.follow_up.links.some((link) => link.ref.line === 5), "identifier-free correction is included in follow-up context");
  assert.equal(keep.follow_up.links.find((link) => link.ref.line === 4).status, "discard", "later negative run is offered as evidence");

  const assessment = await pi.call("assess_precedents", {
    report_id: report.id, primary_ref: keep.ref, claim: "contradicts",
    follow_up_ref: keep.follow_up.links.find((link) => link.ref.line === 4).ref,
    action: "avoid", similarity: "same parser throughput bottleneck",
    differences: "different profile and metric scale", risks: "invalid result under full validation",
  }, root);
  assert.ok(!assessment.content[0].text.startsWith("❌"), assessment.content[0].text);
  const evaluated = JSON.parse(assessment.content[0].text);
  assert.equal(evaluated.classification, "contradicted");
  assert.equal(evaluated.assessment.judgments.action, "avoid");
  assert.equal(evaluated.assessment.facts.assessed_by, "agent");
  assert.equal(evaluated.assessment.judgments.label, "agent-judgment");

  // Brief receives only metadata by default; report IDs/statuses may pass, private details may not.
  const digest = await loadLatestPrecedentDigest(root);
  const dir = path.join(root, ".auto", "councils", "10");
  const brief = buildBrief(root, dir, {
    seq: 10, metricName: "requests_per_second", metricUnit: "ops/s", direction: "higher",
    baselineMetric: 100, bestMetric: 120, noiseFloor: 2, goal: "lobprobe parsing", precedents: digest,
  }).text;
  assert.match(brief, new RegExp(report.id));
  assert.match(brief, /contradicted 1/);
  assert.match(brief, /metadata-only/);
  const precedentSection = brief.slice(brief.indexOf("## Precedent search"));
  assert.doesNotMatch(precedentSection, /same parser throughput bottleneck|invalid result under full validation|autoresearch\.jsonl|oversized allocation|buffered token scanning|bounded token cache/);

  write(root, ".auto/config.json", JSON.stringify({ campaign: "lobprobe", council: { share_precedent_details: true } }));
  const optInBrief = buildBrief(root, dir, {
    seq: 10, metricName: "requests_per_second", metricUnit: "ops/s", direction: "higher",
    baselineMetric: 100, bestMetric: 120, noiseFloor: 2, goal: "lobprobe parsing", precedents: digest,
  }).text;
  assert.match(optInBrief, /same parser throughput bottleneck/);
  assert.match(optInBrief, /UNTRUSTED/);
});

test("E2E memory unavailable: local candidates survive and report does not claim memory was searched", async (t) => {
  const { root, pi } = setup(t, "rich");
  const report = await search(pi, root, "lobprobe throughput");
  assert.equal(report.search.memory.status, "unavailable");
  assert.match(report.search.memory.instruction, /память не просмотрена/);
  assert.ok(report.search.candidates.length > 0);
  assert.equal(report.search.complete, true, "unconfigured memory does not make local search incomplete");
});

test("E2E deadline: registered search tool returns incomplete report when search subprocess misses deadline", async (t) => {
  const { root } = setup(t, "rich");
  class HungChild extends EventEmitter {
    constructor() { super(); this.stdout = new EventEmitter(); this.stdin = { end() {}, on() {} }; this.killed = 0; }
    kill() { this.killed++; return true; }
  }
  const child = new HungChild();
  const versionChild = new HungChild();
  const pi = fakePi();
  registerSearchPrecedentsTool(pi, (cwd) => cwd, {
    deadlineMs: 25,
    versions: { deps: { spawn: () => versionChild } },
    search: { deps: { spawn: () => child } },
  });
  const result = await pi.call("search_precedents", { problem: PROBLEM }, root);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.search.outcome, "incomplete");
  assert.equal(report.search.deadline.hit, true);
  assert.equal(child.killed, 1);
});
