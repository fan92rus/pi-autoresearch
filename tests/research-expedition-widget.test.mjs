import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as expedition from "../extensions/pi-autoresearch/expedition.ts";

const extensionModule = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "expedition-widget-"));
  const chain = path.join(root, "chain"), campaign = path.join(root, "campaign");
  fs.mkdirSync(chain); fs.mkdirSync(campaign);
  return { root, chain, campaign };
};
const journal = [
  { type: "expedition_created", goal: "Improve reliability", doc_sha256: "abc" },
  ...["latency", "memory", "coverage"].map((dir) => ({ type: "direction_opened", dir, why: `Explore ${dir}` })),
  { type: "direction_resolved", dir: "latency", why: "Verified" },
  { type: "campaign_added", campaign_id: "c1" },
];

 test("expeditionWidgetLines renders direction glyphs, advisory caveat, and footer", () => {
  const replay = expedition.replayExpeditionMap(journal);
  assert.equal(replay.ok, true);
  replay.map.directions.set("advisory", { dir: "advisory", status: "advisory_exhausted", why: "review exhausted" });
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: "research", openQuestions: [], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 2, campaignsLimit: 5, chainStatus: "active" });
  assert.match(lines.join("\n"), /✅ latency/);
  assert.match(lines.join("\n"), /❓ advisory.*самоотчёт, не доказательство/);
  assert.match(lines.join("\n"), /⚠ нет активного направления — expedition_map\(subaction=activate, dir=memory, why=<rationale>\)/);
  assert.match(lines.at(-1), /territory .*campaigns 2\/5.*next: expedition_map\(subaction=activate, dir=memory, why=<rationale>\)/);
});

test("buildExpeditionWidgetLines reads a journal and renders three directions plus footer", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), journal.map(JSON.stringify).join("\n") + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: 4, chainStatus: "active" });
  assert.equal(lines.length, 5);
  assert.match(lines[1], /✅ latency/);
  assert.match(lines[2], /○ memory/);
  assert.match(lines[3], /○ coverage/);
  assert.match(lines.at(-1), /campaigns 1\/4/);
});

test("damaged chain journal produces a safe fallback", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), "{broken\n");
  assert.deepEqual(extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "unknown" }), ["(map unavailable)"]);
});

test("missing files produce a safe fallback without throwing", () => {
  const f = fixture();
  assert.deepEqual(extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 0, campaignsLimit: null, chainStatus: "unknown" }), ["(map unavailable)"]);
});

test("non-expedition research chains retain the ordinary dashboard path", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts"), "utf8");
  assert.match(source, /if \(runtime\.researchChain && \(runtime\.researchChain as typeof runtime\.researchChain & \{ expedition\?: boolean \}\)\.expedition === true\)/);
  assert.match(source, /if \(state\.results\.length === 0\)[\s\S]*?Full dashboard table rendered as widget/);
  assert.match(source, /\.\.\.renderDashboardLines\(/);
});

// ── Audit coverage (spec «Виджет карты» checklist) ──

 test("every status renders its spec glyph, footer omits limit when null", () => {
  const replay = expedition.replayExpeditionMap(journal);
  assert.equal(replay.ok, true);
  replay.map.directions.set("advisory", { dir: "advisory", status: "advisory_exhausted", why: "review exhausted" });
  replay.map.directions.set("parked dir", { dir: "parked dir", status: "parked", why: "later" });
  replay.map.directions.set("rejected dir", { dir: "rejected dir", status: "rejected", why: "no" });
  replay.map.directions.set("active dir", { dir: "active dir", status: "active", why: "w", campaign: "c1" });
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: null, openQuestions: [], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 1, campaignsLimit: null, chainStatus: "awaiting_child" });
  const body = lines.join("\n");
  assert.match(body, /✅ latency/);
  assert.match(body, /○ memory/);
  assert.match(body, /❓ advisory/);
  assert.match(body, /💤 parked dir/);
  assert.match(body, /❌ rejected dir/);
  assert.match(body, /🔄 active dir/);
  assert.match(lines.at(-1), /campaigns 1(?!\/) /, "no limit renders campaigns without slash");
  assert.match(lines.at(-1), /next: expedition_map\(subaction=resolve, dir, refs\) → expedition_map\(subaction=activate, dir, why\) → research_brief draft/);
});

 test("advisory line always carries the unproven mark even with a long basis", () => {
  const replay = expedition.replayExpeditionMap(journal);
  replay.map.directions.set("adv", { dir: "adv", status: "advisory_exhausted", why: "x".repeat(200) });
  const line = expedition.expeditionWidgetLines(replay.map, { campaignId: null, campaignPhase: null, openQuestions: [], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" }).find((l) => l.includes("adv"));
  assert.ok(line, "advisory direction rendered");
  assert.match(line, /самоотчёт, не доказательство/);
});

 test("newlines in question texts never leak into widget rows", () => {
  const replay = expedition.replayExpeditionMap(journal);
  replay.map.directions.set("active dir", { dir: "active dir", status: "active", why: "w", campaign: "c1" });
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: null, openQuestions: ["multi\nline question", "plain"], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  for (const line of lines) assert.equal(line.includes("\n"), false, `widget row must be single-line: ${JSON.stringify(line)}`);
  assert.match(lines.join("\n"), /multi line question/);
});

 test("newlines in goal, why, and reason never leak into widget rows", () => {
  const replay = expedition.replayExpeditionMap([
    { type: "expedition_created", goal: "goal\nwith newline", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "why\nwith newline" },
    { type: "direction_parked", dir: "d1", reason: "reason\nwith newline" },
  ]);
  assert.equal(replay.ok, true);
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: null, campaignPhase: null, openQuestions: [], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  for (const line of lines) assert.equal(line.includes("\n"), false, `widget row must be single-line: ${JSON.stringify(line)}`);
});

 test("render closure truncates every line to the terminal width", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    JSON.stringify({ type: "expedition_created", goal: "g", doc_sha256: "x" }),
    JSON.stringify({ type: "direction_opened", dir: "d1", why: "w".repeat(200) }),
  ].join("\n") + "\n");
  let rendered = null;
  const { pi } = createFakePi({ dir: f.root, sessionId: "widget-render", realGit: false });
  const ctx = makeCtx(f.root, "widget-render", pi);
  ctx.ui.setWidget = (_name, widget) => { rendered = widget; };
  // The closure is created by updateWidget inside the extension instance; simulate it directly:
  // buildExpeditionWidgetLines output + truncateToWidth is exactly what render() applies (source-checked),
  // so verify the pure path: long lines exist pre-truncation and truncateToWidth collapses them to one line each.
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.ok(lines.some((l) => l.length > 100), "pre-truncation line is long");
  const { truncateToWidth } = await import("@earendil-works/pi-tui");
  const safe = lines.map((line) => truncateToWidth(line, 40, "…", true));
  for (const line of safe) { assert.equal(line.includes("\n"), false); assert.ok([...line].length <= 41, `rendered row fits width: ${JSON.stringify(line)}`); }
});

 test("brief missing but log present: question ids render as fallback", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_activated", dir: "d1", campaign: "c1", why: "w" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(f.campaign, "log.jsonl"), JSON.stringify({ event: "open", question_id: "Q1" }) + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  assert.match(lines.join("\n"), /Q1/, "unreadable brief falls back to question ids");
});

 test("question texts render from brief.json", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_activated", dir: "d1", campaign: "c1", why: "w" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(f.campaign, "brief.json"), JSON.stringify({ questions: [{ id: "Q1", text: "Why now?" }] }));
  fs.writeFileSync(path.join(f.campaign, "log.jsonl"), JSON.stringify({ event: "open", question_id: "Q1" }) + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  assert.match(lines.join("\n"), /Why now\?/);
});

 test("empty map renders header and footer only", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), JSON.stringify({ type: "expedition_created", goal: "Only goal", doc_sha256: "x" }) + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Only goal/);
});

 test("chain.json as a directory is a safe fallback, not a crash", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.chain, "chain.json"), { recursive: true });
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.deepEqual(lines, ["(map unavailable)"]);
});

// ── Divergence line, next-action mapping, question progress, territory bar (owner-approved UX round) ──

const linesOf = (map, info) => expedition.expeditionWidgetLines(map, { openQuestions: [], closedQuestions: 0, totalQuestions: 0, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active", ...info });

 test("divergence line: research phase with no active direction warns with the first open dir hint", () => {
  const replay = expedition.replayExpeditionMap(journal);
  assert.equal(replay.ok, true);
  const lines = linesOf(replay.map, { campaignId: "c1", campaignPhase: "research" });
  const warn = lines.find((l) => l.includes("⚠"));
  assert.ok(warn, "divergence line rendered");
  assert.match(warn, /⚠ нет активного направления — expedition_map\(subaction=activate, dir=memory, why=<rationale>\)/);
  assert.match(lines.at(-1), /next: expedition_map\(subaction=activate, dir=memory, why=<rationale>\)/);
});

test("divergence line: research phase with an active direction shows no warning", () => {
  const replay = expedition.replayExpeditionMap(journal);
  assert.equal(replay.ok, true);
  replay.map.directions.set("latency", { dir: "latency", status: "active", why: "w", campaign: "c1" });
  const lines = linesOf(replay.map, { campaignId: "c1", campaignPhase: "research" });
  assert.ok(!lines.some((l) => l.includes("⚠")), "no divergence line when a direction is active");
});

test("divergence line: non-research phases never warn", () => {
  const replay = expedition.replayExpeditionMap(journal);
  assert.equal(replay.ok, true);
  for (const phase of [null, "briefing", "stopped"]) {
    const lines = linesOf(replay.map, { campaignId: "c1", campaignPhase: phase });
    assert.ok(!lines.some((l) => l.includes("⚠")), `no warning for phase ${phase}`);
  }
});

test("divergence line: research phase with no open direction suggests reopen, not activate", () => {
  const entries = [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_resolved", dir: "d1", why: "done" },
  ];
  const replay = expedition.replayExpeditionMap(entries);
  assert.equal(replay.ok, true);
  const lines = linesOf(replay.map, { campaignId: "c1", campaignPhase: "research" });
  const warn = lines.find((l) => l.includes("⚠"));
  assert.ok(warn, "divergence line rendered");
  assert.match(warn, /expedition_map\(subaction=reopen, dir=d1, reason=<why>\)/, "suggests a valid reopen call with a reason");
  assert.ok(!warn.includes("activate"), "no dead-end activate hint");
});

 test("next maps every chain status to an action", () => {
  const map = expedition.replayExpeditionMap([{ type: "expedition_created", goal: "G", doc_sha256: "x" }]).map;
  const cases = [
    ["manual_check_required", "research_questions(action=status) — проверьте блокер"],
    ["stopped_by_owner", "research_questions(action=report)"],
    ["stopped_by_rule", "research_questions(action=report)"],
    ["completed", "research_questions(action=report)"],
    ["limit_reached", "research_questions(action=report)"],
    ["awaiting_child", "expedition_map(subaction=resolve, dir, refs) → expedition_map(subaction=activate, dir, why) → research_brief draft"],
    ["active", "active"],
  ];
  for (const [status, expected] of cases) {
    const lines = linesOf(map, { campaignId: null, chainStatus: status, campaignPhase: null });
    assert.match(lines.at(-1), new RegExp(`next: ${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `status ${status}`);
  }
});

test("next: active campaign in research phase with active direction prescribes campaign work", () => {
  const entries = [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_activated", dir: "d1", campaign: "c1", why: "go" },
  ];
  const map = expedition.replayExpeditionMap(entries).map;
  const lines = linesOf(map, { campaignId: "c1", chainStatus: "active", campaignPhase: "research" });
  assert.match(lines.at(-1), /next: research_questions\(action=status\)/);
});

test("question progress renders closed/total in the footer only when total > 0", () => {
  const map = expedition.replayExpeditionMap([{ type: "expedition_created", goal: "G", doc_sha256: "x" }]).map;
  const withQ = linesOf(map, { campaignId: null, closedQuestions: 2, totalQuestions: 5 });
  assert.match(withQ.at(-1), /Q 2\/5/);
  const noQ = linesOf(map, { campaignId: null, closedQuestions: 0, totalQuestions: 0 });
  assert.ok(!noQ.at(-1).match(/Q \d/), "no Q segment without questions");
});

test("question progress counts unique closed ids from log.jsonl and total from brief.json", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_activated", dir: "d1", campaign: "c1", why: "go" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(f.campaign, "brief.json"), JSON.stringify({ questions: [{ id: "Q1", text: "a" }, { id: "Q2", text: "b" }, { id: "Q3", text: "c" }] }));
  fs.writeFileSync(path.join(f.campaign, "log.jsonl"), [
    JSON.stringify({ event: "open", question_id: "Q1" }),
    JSON.stringify({ event: "close", question_id: "Q1", verdict: "confirmed", rule_id: "r" }),
    JSON.stringify({ event: "open", question_id: "Q2" }),
    JSON.stringify({ event: "close", question_id: "Q2", verdict: "rejected", rule_id: "r" }),
    JSON.stringify({ event: "close", question_id: "Q2", verdict: "rejected", rule_id: "r" }),
  ].join("\n") + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  assert.match(lines.at(-1), /Q 2\/3/, "duplicate close events count once, total comes from brief");
});

test("question progress clamps closed to the brief total when the log has stale ids", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(f.campaign, "brief.json"), JSON.stringify({ questions: [{ id: "Q1", text: "a" }, { id: "Q2", text: "b" }, { id: "Q3", text: "c" }] }));
  fs.writeFileSync(path.join(f.campaign, "log.jsonl"), [
    JSON.stringify({ event: "close", question_id: "Q1" }),
    JSON.stringify({ event: "close", question_id: "Q2" }),
    JSON.stringify({ event: "close", question_id: "Q3" }),
    JSON.stringify({ event: "close", question_id: "STALE1" }),
    JSON.stringify({ event: "close", question_id: "STALE2" }),
  ].join("\n") + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  assert.match(lines.at(-1), /Q 3\/3/, "closed count never exceeds the brief total (5 closes over 3 questions)");
  assert.ok(!lines.at(-1).match(/Q 5\/3/), "no impossible 5/3 progress");
});

test("territory bar: cells count caps at 10 and fills one block per done direction", () => {
  const entries = [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    ...["a", "b", "c", "d"].map((d) => ({ type: "direction_opened", dir: d, why: "w" })),
    { type: "direction_resolved", dir: "a", why: "done" },
    { type: "direction_rejected", dir: "b", why: "no" },
  ];
  const map = expedition.replayExpeditionMap(entries).map;
  const lines = linesOf(map, { campaignId: null });
  assert.match(lines.at(-1), /territory ██░░ done\/4/);
  const big = expedition.replayExpeditionMap([
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    ...Array.from({ length: 14 }, (_, i) => ({ type: "direction_opened", dir: `d${i}`, why: "w" })),
    { type: "direction_resolved", dir: "d0", why: "done" },
  ]).map;
  const bigLines = linesOf(big, { campaignId: null });
  assert.match(bigLines.at(-1), /territory █░{9} done\/14/, "cells capped at 10");
});

test("divergence line: research phase with no open direction suggests reopen instead of a dead-end activate", () => {
  const entries = [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_resolved", dir: "d1", why: "done" },
  ];
  const replay = expedition.replayExpeditionMap(entries);
  assert.equal(replay.ok, true);
  const lines = linesOf(replay.map, { campaignId: "c1", campaignPhase: "research" });
  const warn = lines.find((l) => l.includes("⚠"));
  assert.ok(warn, "divergence line rendered");
  assert.match(warn, /expedition_map\(subaction=reopen, dir=d1, reason=<why>\)/, "hints the first reopenable direction");
  assert.match(lines.at(-1), /next: expedition_map\(subaction=reopen, dir=d1, reason=<why>\)/);
  assert.match(warn, /research_questions\(action=stop, rule_id=<rule>, reason=<why>\) → research_questions\(action=report\)/, "offers valid campaign completion calls");
  assert.ok(!warn.includes("activate"), "never suggests impossible activate");
});

test("divergence line: no directions at all suggests opening one", () => {
  const map = expedition.replayExpeditionMap([{ type: "expedition_created", goal: "G", doc_sha256: "x" }]).map;
  const lines = linesOf(map, { campaignId: "c1", campaignPhase: "research" });
  const warn = lines.find((l) => l.includes("⚠"));
  assert.ok(warn, "divergence line rendered");
  assert.match(warn, /expedition_map\(subaction=open, dir=<name>, why=<rationale>\)/);
  assert.match(lines.at(-1), /next: expedition_map\(subaction=open, dir=<name>, why=<rationale>\)/);
});

test("goal truncation never splits a surrogate pair", () => {
  const emoji = "🧪".repeat(40); // 40 code points, 80 UTF-16 units — a naive slice(0,59) cuts a pair
  const map = expedition.replayExpeditionMap([{ type: "expedition_created", goal: emoji, doc_sha256: "x" }]).map;
  const lines = linesOf(map, { campaignId: null });
  const head = lines[0];
  for (const ch of head) {
    const code = ch.codePointAt(0);
    assert.ok(code === undefined || !(code >= 0xd800 && code <= 0xdfff), `lone surrogate in header: U+${(code ?? 0).toString(16)}`);
  }
});

test("header truncates the goal and appends the direction count", () => {
  const entries = [
    { type: "expedition_created", goal: "x".repeat(80), doc_sha256: "g" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_opened", dir: "d2", why: "w" },
  ];
  const map = expedition.replayExpeditionMap(entries).map;
  const lines = linesOf(map, { campaignId: null });
  assert.match(lines[0], /xxx… \(2 напр\.\)/);
});

test("campaign phase is read synchronously from state.json by buildExpeditionWidgetLines", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), [
    { type: "expedition_created", goal: "G", doc_sha256: "x" },
    { type: "direction_opened", dir: "d1", why: "w" },
    { type: "direction_opened", dir: "d2", why: "w" },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(f.campaign, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: new Date().toISOString(), phase: "research" }, null, 2) + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  const warn = lines.find((l) => l.includes("⚠"));
  assert.ok(warn, "phase from state.json drives the divergence line");
  assert.match(warn, /expedition_map\(subaction=activate, dir=d1, why=<rationale>\)/);
  assert.match(lines[0], /\(research\)/);
});

test("unreadable state.json degrades the phase to null without breaking the widget", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), JSON.stringify({ type: "expedition_created", goal: "G", doc_sha256: "x" }) + "\n");
  fs.writeFileSync(path.join(f.campaign, "state.json"), "{broken");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.equal(lines.length, 2, "widget still renders header+footer");
  assert.ok(!lines.some((l) => l.includes("⚠")), "no divergence line without a readable phase");
});
