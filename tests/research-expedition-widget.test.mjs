import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
