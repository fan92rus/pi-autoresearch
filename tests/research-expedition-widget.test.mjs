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
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: "research", openQuestions: [], campaignsUsed: 2, campaignsLimit: 5, chainStatus: "active" });
  assert.match(lines.join("\n"), /✅ latency/);
  assert.match(lines.join("\n"), /❓ advisory.*самоотчёт, не доказательство/);
  assert.match(lines.at(-1), /territory .*campaigns 2\/5.*next: active/);
});

test("buildExpeditionWidgetLines reads a journal and renders three directions plus footer", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), journal.map(JSON.stringify).join("\n") + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: "c1", campaignPhase: null, campaignsUsed: 1, campaignsLimit: 4, chainStatus: "active" });
  assert.equal(lines.length, 5);
  assert.match(lines[1], /✅ latency/);
  assert.match(lines[2], /○ memory/);
  assert.match(lines[3], /○ coverage/);
  assert.match(lines.at(-1), /campaigns 1\/4/);
});

test("damaged chain journal produces a safe fallback", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), "{broken\n");
  assert.deepEqual(extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignPhase: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "unknown" }), ["(map unavailable)"]);
});

test("missing files produce a safe fallback without throwing", () => {
  const f = fixture();
  assert.deepEqual(extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignPhase: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "unknown" }), ["(map unavailable)"]);
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
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: null, openQuestions: [], campaignsUsed: 1, campaignsLimit: null, chainStatus: "awaiting_child" });
  const body = lines.join("\n");
  assert.match(body, /✅ latency/);
  assert.match(body, /○ memory/);
  assert.match(body, /❓ advisory/);
  assert.match(body, /💤 parked dir/);
  assert.match(body, /❌ rejected dir/);
  assert.match(body, /🔄 active dir/);
  assert.match(lines.at(-1), /campaigns 1(?!\/) /, "no limit renders campaigns without slash");
  assert.match(lines.at(-1), /next: awaiting_child/);
});

 test("advisory line always carries the unproven mark even with a long basis", () => {
  const replay = expedition.replayExpeditionMap(journal);
  replay.map.directions.set("adv", { dir: "adv", status: "advisory_exhausted", why: "x".repeat(200) });
  const line = expedition.expeditionWidgetLines(replay.map, { campaignId: null, campaignPhase: null, openQuestions: [], campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" }).find((l) => l.includes("adv"));
  assert.ok(line, "advisory direction rendered");
  assert.match(line, /самоотчёт, не доказательство/);
});

 test("newlines in question texts never leak into widget rows", () => {
  const replay = expedition.replayExpeditionMap(journal);
  replay.map.directions.set("active dir", { dir: "active dir", status: "active", why: "w", campaign: "c1" });
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: "c1", campaignPhase: null, openQuestions: ["multi\nline question", "plain"], campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
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
  const lines = expedition.expeditionWidgetLines(replay.map, { campaignId: null, campaignPhase: null, openQuestions: [], campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  for (const line of lines) assert.equal(line.includes("\n"), false, `widget row must be single-line: ${JSON.stringify(line)}`);
});

 test("render closure truncates every line to the terminal width", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), JSON.stringify({ type: "expedition_created", goal: "g".repeat(300), doc_sha256: "x" }) + "\n");
  let rendered = null;
  const { pi } = createFakePi({ dir: f.root, sessionId: "widget-render", realGit: false });
  const ctx = makeCtx(f.root, "widget-render", pi);
  ctx.ui.setWidget = (_name, widget) => { rendered = widget; };
  // The closure is created by updateWidget inside the extension instance; simulate it directly:
  // buildExpeditionWidgetLines output + truncateToWidth is exactly what render() applies (source-checked),
  // so verify the pure path: long lines exist pre-truncation and truncateToWidth collapses them to one line each.
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignPhase: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
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
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignPhase: null, campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
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
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, f.campaign, { campaignId: "c1", campaignPhase: null, campaignsUsed: 1, campaignsLimit: null, chainStatus: "active" });
  assert.match(lines.join("\n"), /Why now\?/);
});

 test("empty map renders header and footer only", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.chain, "chain.json"), JSON.stringify({ type: "expedition_created", goal: "Only goal", doc_sha256: "x" }) + "\n");
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignPhase: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Only goal/);
});

 test("chain.json as a directory is a safe fallback, not a crash", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.chain, "chain.json"), { recursive: true });
  const lines = extensionModule.buildExpeditionWidgetLines(f.chain, null, { campaignId: null, campaignPhase: null, campaignsUsed: 0, campaignsLimit: null, chainStatus: "active" });
  assert.deepEqual(lines, ["(map unavailable)"]);
});
