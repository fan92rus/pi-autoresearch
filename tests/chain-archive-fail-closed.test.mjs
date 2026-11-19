/** Regression: a damaged chain journal must block campaign archival. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { archiveOutcomeForTest } from "../extensions/pi-autoresearch/index.ts";
import { chainDir } from "../extensions/pi-autoresearch/chain-journal.ts";
import { STATE_FILE } from "../extensions/pi-autoresearch/research-state.ts";

const text = (r) => r?.content?.[0]?.text ?? "";
const rulesFor = (id) => [
  { id: `${id}-yes`, verdict: "confirmed", when: "effect is present" },
  { id: `${id}-no`, verdict: "rejected", when: "effect is absent" },
  { id: `${id}-unknown`, verdict: "inconclusive", when: "data are noisy" },
  { id: `${id}-wait`, verdict: "waiting_for_data", when: "data are missing" },
];
const brief = {
  schema_version: 1, goal: "Archive guard", plan_source: "plan.md", caveat_block: "Observational only.",
  data_roles: { explore: ["evidence.txt"], validate: ["evidence.txt"], confirm: [] },
  questions: ["Q1"].map((id) => ({ id, text: `Question ${id}?`, decision_rules: rulesFor(id), needs_data: null })),
  process_metrics: [], stop_rules: [{ id: "S1", when: "all questions closed" }],
};
const doc = {
  charter: { stop_rules: [] },
  goal: "Archive guard",
  directions: [{ name: "cache", why: "Measure cache effects" }],
  campaign0: brief,
};

async function setup(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ar-chain-archive-${label}-`));
  fs.writeFileSync(path.join(dir, "evidence.txt"), "evidence\n");
  const { pi, tool, command } = createFakePi({ dir, sessionId: label, realGit: false });
  const ctx = makeCtx(dir, label, pi);
  ctx.ui.confirm = async () => true;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  const call = (name, params) => tool(name).execute("id", params, null, null, ctx);
  await command("autoresearch").handler("expedition goal", ctx);
  await call("expedition_brief", { action: "draft", doc });
  const proposed = await call("expedition_brief", { action: "propose" });
  const campaignId = text(proposed).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(campaignId, text(proposed));
  const chainId = `${campaignId}-chain`;
  const dirPath = chainDir(dir, chainId);
  assert.ok(dirPath, `chain dir for ${chainId}`);
  return { dir, ctx, pi, call, campaignId, chainId, chainDir: dirPath };
}

function writeStoppedCampaign(dir, id) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, STATE_FILE),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase: "stopped" }) + "\n",
  );
}

test("a damaged active-chain journal blocks archival of its campaign", { timeout: 60000 }, async () => {
  const h = await setup("broken-journal");
  writeStoppedCampaign(h.dir, h.campaignId);

  // Corrupt the hash-linked journal after creation: verifyChain must refuse.
  const headPath = path.join(h.chainDir, "chain-head");
  assert.ok(fs.existsSync(headPath), "chain-head exists before corruption");
  fs.writeFileSync(headPath, "f".repeat(64) + "\n");

  const outcome = await archiveOutcomeForTest(h.dir, h.dir, h.ctx, {}, h.pi);
  assert.deepEqual(outcome, { ok: false, reason: "unlistable" }, `archive must fail closed: ${JSON.stringify(outcome)}`);
  assert.equal(
    fs.existsSync(path.join(h.dir, ".auto", "research", h.campaignId, STATE_FILE)),
    true,
    "campaign is not archived while the chain journal is damaged",
  );
});
