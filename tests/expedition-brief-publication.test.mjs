/** Regression coverage for bd pi-autoresearch-tj0.5: draft retention and resumable publication. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const brief = { schema_version:1, goal:"Study cache latency", plan_source:"plan.md", caveat_block:"Observational only", data_roles:{explore:[],validate:[],confirm:[]}, questions:[{id:"Q1",text:"Does latency improve?",decision_rules:[{id:"yes",verdict:"confirmed",when:"measured improvement"},{id:"no",verdict:"rejected",when:"no improvement"},{id:"unknown",verdict:"inconclusive",when:"unclear"},{id:"wait",verdict:"waiting_for_data",when:"data missing"}],needs_data:null}], process_metrics:[], stop_rules:[] };
const doc = { charter:{stop_rules:[]}, goal:"Study cache latency", directions:[{name:"cache",why:"Measure cache effects"}], campaign0:brief };
const text = r => r?.content?.[0]?.text ?? "";

function container() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "expedition-publication-"));
  return { root, dir: path.join(root, "work"), makeWork: () => fs.mkdirSync(path.join(root, "work")) };
}
const draftPath = dir => path.join(dir, ".auto", "research-expedition-drafts", "expedition-draft.json");
const journalPath = dir => path.join(dir, ".auto", "expedition-publication.json");
const copies = root => fs.readdirSync(root).filter(n => /^expedition-\d+-[0-9a-f]+\.json$/.test(n));
const chainRoot = dir => path.join(dir, ".auto", "research-chain");
const chainIds = dir => fs.existsSync(chainRoot(dir)) ? fs.readdirSync(chainRoot(dir)).filter(n => n.endsWith("-chain")) : [];
const chainEntries = (dir, chainId) => fs.readFileSync(path.join(chainRoot(dir), chainId, "chain.json"), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));

async function harness(dir, confirm = true) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: "expedition-publication", realGit: false });
  const ctx = makeCtx(dir, "expedition-publication", pi);
  ctx.ui.confirm = async () => typeof confirm === "function" ? confirm() : confirm;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  await command("autoresearch").handler("expedition goal", ctx);
  return { pi, tool, ctx, ext };
}
const draft = (h, value = doc) => h.tool("expedition_brief").execute("draft", { action: "draft", doc: value }, null, null, h.ctx);
const propose = h => h.tool("expedition_brief").execute("propose", { action: "propose" }, null, null, h.ctx);

test("declined confirmation keeps the canonical draft and removes only the copy", async () => {
  const c = container(); c.makeWork();
  const h = await harness(c.dir, false);
  assert.match(text(await draft(h)), /draft saved/i);
  const canonicalBefore = fs.readFileSync(draftPath(c.dir), "utf8");
  assert.match(text(await propose(h)), /owner_declined/);
  assert.equal(fs.readFileSync(draftPath(c.dir), "utf8"), canonicalBefore, "canonical draft survives a refusal");
  assert.deepEqual(copies(c.root), [], "only the out-of-workdir copy is removed");
  assert.equal(fs.existsSync(journalPath(c.dir)), false, "a refusal must not publish a journal");
  h.ctx.ui.confirm = async () => true;
  const retry = text(await propose(h));
  assert.match(retry, /created/i, "the retained draft can be proposed again");
  assert.equal(fs.existsSync(draftPath(c.dir)), false, "a successful publication consumes the canonical draft");
  assert.equal(copies(c.root).length, 1, "the confirmed copy remains as the charter path");
});

test("expedition_changed keeps the canonical draft and removes the copy", async () => {
  const c = container(); c.makeWork();
  const known = new Set(copies(c.root));
  const h = await harness(c.dir, async () => {
    const fresh = copies(c.root).filter(name => !known.has(name));
    assert.equal(fresh.length, 1, "confirmation sees the copied document outside the workdir");
    fs.appendFileSync(path.join(c.root, fresh[0]), "\n");
    return true;
  });
  assert.match(text(await draft(h)), /draft saved/i);
  const canonicalBefore = fs.readFileSync(draftPath(c.dir), "utf8");
  assert.match(text(await propose(h)), /expedition_changed/);
  assert.equal(fs.readFileSync(draftPath(c.dir), "utf8"), canonicalBefore, "canonical draft survives a changed document");
  assert.deepEqual(copies(c.root), [], "the changed copy is removed");
  assert.deepEqual(chainIds(c.dir), [], "no chain is created");
});

test("partial publication resumes from the journal with the same expedition id", async () => {
  const c = container(); c.makeWork();
  const h = await harness(c.dir, true);
  assert.match(text(await draft(h)), /draft saved/i);
  // Failure injection: the campaign root is a file, so createCampaign fails
  // after the chain and its first entries have already been committed.
  const blocker = path.join(c.dir, ".auto", "research");
  fs.writeFileSync(blocker, "blocked");
  assert.match(text(await propose(h)), /io_failed/);
  const journal = JSON.parse(fs.readFileSync(journalPath(c.dir), "utf8"));
  assert.ok(journal.id && journal.chain_id && journal.doc_path && journal.doc_sha256 && journal.step,
    `journal must carry id, step, doc path and sha: ${JSON.stringify(journal)}`);
  assert.match(journal.doc_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(chainIds(c.dir), [journal.chain_id]);
  const partial = chainEntries(c.dir, journal.chain_id).map(e => e.type);
  assert.ok(partial.includes("expedition_created") && partial.includes("direction_opened"), partial.join(","));
  assert.ok(!partial.includes("campaign_added"), partial.join(","));
  assert.equal(h.pi.sentMessages.filter(m => /expedition_map\(subaction="activate"/.test(m.text)).length, 0);

  fs.unlinkSync(blocker);
  const resumed = text(await propose(h));
  assert.match(resumed, /RESUME/i, `retry must announce the journal resume: ${resumed}`);
  assert.match(resumed, /created/i);
  assert.ok(resumed.includes(journal.chain_id), "the original chain id is reused");
  assert.deepEqual(chainIds(c.dir), [journal.chain_id], "no second chain is created on retry");
  const complete = chainEntries(c.dir, journal.chain_id).map(e => e.type);
  assert.equal(complete.filter(t => t === "expedition_created").length, 1);
  assert.equal(complete.filter(t => t === "direction_opened").length, 1);
  assert.equal(complete.filter(t => t === "campaign_added").length, 1);
  assert.ok(fs.existsSync(path.join(c.dir, ".auto", "research", journal.id)), "the campaign is created on resume");
  const runtime = h.ext.runtimeForTest(h.ctx);
  assert.equal(runtime.researchChain.chainId, journal.chain_id);
  assert.equal(runtime.researchCampaignId, journal.id);
  assert.equal(runtime.researchChain.charterPath, journal.doc_path);
  assert.equal(h.pi.sentMessages.filter(m => /expedition_map\(subaction="activate"/.test(m.text)).length, 1,
    "the kickoff is delivered once, after successful publication");
  assert.equal(JSON.parse(fs.readFileSync(journalPath(c.dir), "utf8")).step, "complete");
  assert.match(text(await propose(h)), /expedition_already_published/, "a third propose must refuse explicitly");
  assert.deepEqual(chainIds(c.dir), [journal.chain_id]);
});

test("an explicit doc_path with the journal digest resumes instead of publishing twice", async () => {
  const c = container(); c.makeWork();
  const h = await harness(c.dir, true);
  assert.match(text(await draft(h)), /draft saved/i);
  const blocker = path.join(c.dir, ".auto", "research");
  fs.writeFileSync(blocker, "blocked");
  assert.match(text(await propose(h)), /io_failed/);
  const journal = JSON.parse(fs.readFileSync(journalPath(c.dir), "utf8"));
  fs.unlinkSync(blocker);
  const resumed = text(await h.tool("expedition_brief").execute("propose", { action: "propose", doc_path: journal.doc_path }, null, null, h.ctx));
  assert.match(resumed, /RESUME/i);
  assert.ok(resumed.includes(journal.chain_id));
  assert.deepEqual(chainIds(c.dir), [journal.chain_id]);
  assert.equal(JSON.parse(fs.readFileSync(journalPath(c.dir), "utf8")).step, "complete");
});

test("a changed draft cannot silently start a second publication", async () => {
  const c = container(); c.makeWork();
  const h = await harness(c.dir, true);
  assert.match(text(await draft(h)), /draft saved/i);
  const blocker = path.join(c.dir, ".auto", "research");
  fs.writeFileSync(blocker, "blocked");
  assert.match(text(await propose(h)), /io_failed/);
  const journal = JSON.parse(fs.readFileSync(journalPath(c.dir), "utf8"));
  fs.unlinkSync(blocker);
  const changed = structuredClone(doc);
  changed.goal = "Different goal";
  assert.match(text(await draft(h, changed)), /draft saved/i);
  assert.match(text(await propose(h)), /expedition_publication_conflict/);
  assert.deepEqual(chainIds(c.dir), [journal.chain_id], "the pending publication is not replaced by a new chain");
  assert.equal(h.pi.sentMessages.filter(m => /expedition_map\(subaction="activate"/.test(m.text)).length, 0);
});

test("draft accepts a schema-conformant doc_path and ignores it", async () => {
  const c = container(); c.makeWork();
  const h = await harness(c.dir, true);
  const explicit = path.join(c.root, "explicit.json");
  fs.writeFileSync(explicit, JSON.stringify(doc));
  const result = text(await h.tool("expedition_brief").execute("draft", { action: "draft", doc, doc_path: explicit }, null, null, h.ctx));
  assert.match(result, /draft saved/i);
  assert.ok(!/invalid_argument/.test(result), `doc_path is in the schema and must not be refused: ${result}`);
  assert.equal(fs.readFileSync(explicit, "utf8"), JSON.stringify(doc), "doc_path is ignored on draft");
  assert.ok(fs.existsSync(draftPath(c.dir)), "the canonical draft is still written");
});
