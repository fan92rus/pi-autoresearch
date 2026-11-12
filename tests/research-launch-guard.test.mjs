import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import { appendEntry } from "../extensions/pi-autoresearch/chain-journal.ts";

function makeWorkDir(label) { const dir = path.join(os.tmpdir(), `pi-ar-guard-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`); fs.mkdirSync(dir, { recursive: true }); return dir; }
function rulesFor(id) { return ["yes", "no", "unknown", "wait"].map((x) => ({ id: `${id}-${x}`, verdict: ({ yes: "confirmed", no: "rejected", unknown: "inconclusive", wait: "waiting_for_data" })[x], when: "evidence condition" })); }
function briefFixture() { return { schema_version: 1, goal: "Check the cache effect.", plan_source: "docs/plan.md", caveat_block: "Observational results.", data_roles: { explore: ["a"], validate: ["b"], confirm: [] }, questions: ["Q1", "Q2"].map((id) => ({ id, text: `Question ${id}?`, decision_rules: rulesFor(id), needs_data: null })), process_metrics: ["files read"], stop_rules: [{ id: "S1", when: "two failures" }] }; }
async function load(dir, label, args) { const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `guard-${label}`, realGit: false }); const ctx = makeCtx(dir, `guard-${label}`, pi); const { default: extension } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href); extension(pi); await command("autoresearch").handler(args, ctx); return { pi, tool, command, hook, ctx, dir }; }
function call(h, name, params) { return h.tool(name).execute("tool-call-id", params, null, null, h.ctx); }
function textOf(r) { return r?.content?.[0]?.text ?? ""; }
async function draftAndApprove(h, id) { assert.match(textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() })), /Brief draft saved/); h.ctx.ui.confirm = async () => true; assert.match(textOf(await call(h, "research_brief", { action: "propose" })), /Brief approved/); return createHash("sha256").update(fs.readFileSync(path.join(h.dir, ".auto", "research", id, "brief.json")).toString()).digest("hex"); }
async function makeResearch(dir, id) { const h = await load(dir, `old-${id}`, `research --id ${id}`); const hash = await draftAndApprove(h, id); await call(h, "research", { action: "start", expected_sha256: hash }); await call(h, "research", { action: "open", question_id: "Q1" }); return h; }
function archivedNames(dir) { const p = path.join(dir, ".auto", "research-archive"); return fs.existsSync(p) ? fs.readdirSync(p) : []; }

test("stale research is closed at bare launch then archived by the next draft", async () => {
 const dir = makeWorkDir("stale"); await makeResearch(dir, "c1"); const h = await load(dir, "new", "research"); assert.equal(h.pi.notifications.some((n) => /Cannot launch research/.test(n.text)), false); assert.match(textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() })), /Brief draft saved/); const archived = path.join(dir, ".auto", "research-archive", archivedNames(dir).find((n) => n.startsWith("c1-"))); assert.ok(fs.existsSync(archived)); assert.equal(JSON.parse(fs.readFileSync(path.join(archived, "state.json"), "utf8")).phase, "stopped"); assert.match(fs.readFileSync(path.join(archived, "log.jsonl"), "utf8"), /"event":"abandon"/); assert.ok(fs.existsSync(path.join(archived, "report.md"))); 
});
test("same campaign id in work and state roots closes both directories before kickoff", async () => {
 const dir = makeWorkDir("same-id-roots");
 const work = await makeResearch(dir, "c1");
 const stateBase = path.join(dir, "runs");
 const stateDir = path.join(stateBase, ".auto", "research", "c1");
 fs.mkdirSync(stateDir, { recursive: true });
 fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: new Date().toISOString(), phase: "research" }, null, 2) + "\n");
 const h = await load(dir, "same-id-new", "research --state-root runs");
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "state.json"), "utf8")).phase, "stopped");
 assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).phase, "stopped");
 assert.match(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "log.jsonl"), "utf8"), /"event":"abandon"/);
 assert.match(fs.readFileSync(path.join(stateDir, "log.jsonl"), "utf8"), /"event":"abandon"/);
 assert.ok(h.pi.sentMessages.length > 0, "bare launch sends kickoff after closing both copies");
});

test("stopped work-root copy does not hide active same-id state-root campaign", async () => {
 const dir = makeWorkDir("stopped-same-id");
 const work = await makeResearch(dir, "c1");
 await call(work, "research", { action: "stop", rule_id: "S1", reason: "done" });
 const stateBase = path.join(dir, "runs");
 const stateDir = path.join(stateBase, ".auto", "research", "c1");
 fs.mkdirSync(stateDir, { recursive: true });
 fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: new Date().toISOString(), phase: "research" }, null, 2) + "\n");
 const h = await load(dir, "stopped-same-id-new", "research --state-root runs");
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "state.json"), "utf8")).phase, "stopped");
 assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).phase, "stopped");
 assert.match(fs.readFileSync(path.join(stateDir, "log.jsonl"), "utf8"), /"event":"abandon"/);
 assert.ok(h.pi.sentMessages.length > 0, "bare launch proceeds after closing active state-root copy");
});

test("closable campaigns close before an unclosable pending operation refuses launch", async () => {
 const dir = makeWorkDir("mixed"); await makeResearch(dir, "c_ok"); const p = path.join(dir, ".auto", "research", "c_pend"); fs.cpSync(path.join(dir, ".auto", "research", "c_ok"), p, { recursive: true }); const statePath = path.join(p, "state.json"); const copiedState = JSON.parse(fs.readFileSync(statePath, "utf8")); copiedState.campaign_id = "c_pend"; copiedState.phase = "briefing"; fs.writeFileSync(statePath, JSON.stringify(copiedState)); fs.writeFileSync(path.join(p, "pending-op.json"), "{}"); const h = await load(dir, "mixed-new", "research"); const refusal = h.pi.notifications.map((n) => n.text).find((x) => /Cannot launch research/.test(x)) ?? ""; assert.match(refusal, /c_pend/); assert.match(refusal, /pending op/i); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c_ok", "state.json"), "utf8")).phase, "stopped"); assert.equal(JSON.parse(fs.readFileSync(path.join(p, "state.json"), "utf8")).phase, "briefing");
});
test("unlistable research root refuses bare launch and names the root", async () => {
 const dir = makeWorkDir("unlistable-root"); const root = path.join(dir, ".auto", "research"); fs.mkdirSync(path.dirname(root), { recursive: true }); fs.writeFileSync(root, "not a directory");
 const h = await load(dir, "unlistable-root-new", "research");
 const refusal = h.pi.notifications.map((n) => n.text).find((x) => /Cannot launch research/.test(x)) ?? "";
 assert.match(refusal, /unreadable root/); assert.ok(refusal.includes(dir), "refusal names the unlistable work root");
 assert.equal(h.pi.sentMessages.length, 0, "unlistable root refuses before kickoff");
});
test("unreadable campaign state refuses launch without modifying its directory", async () => {
 const dir = makeWorkDir("unreadable"); const h0 = await load(dir, "bad", "research --id c_bad"); await call(h0, "research_brief", { action: "draft", brief: briefFixture() }); const state = path.join(dir, ".auto", "research", "c_bad", "state.json"); fs.writeFileSync(state, "garbage"); const before = fs.readFileSync(state); const h = await load(dir, "bad-new", "research"); const refusal = h.pi.notifications.map((n) => n.text).find((x) => /Cannot launch research/.test(x)) ?? ""; assert.match(refusal, /c_bad/); assert.match(refusal, /unreadable state/); assert.deepEqual(fs.readFileSync(state), before);
});
test("briefing campaign pinned to this session refuses bare launch and explicit replacement", async () => {
 const dir = makeWorkDir("pinned"); const h = await load(dir, "pinned", "research --id c0"); await call(h, "research_brief", { action: "draft", brief: briefFixture() }); await h.command("autoresearch").handler("research", h.ctx); const first = h.pi.notifications.map((n) => n.text).at(-1); assert.match(first, /c0 is active or unreadable/); assert.match(first, /resume it with \/autoresearch research --id c0/); assert.match(first, /finish it first/); await h.command("autoresearch").handler("research --id c1", h.ctx); const second = h.pi.notifications.map((n) => n.text).at(-1); assert.match(second, /pin is not replaced/); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c0", "state.json"), "utf8")).phase, "briefing");
});
test("campaign in an active chain is not closed by a bare launch", async () => {
 const dir = makeWorkDir("active-chain");
 const rootDir = path.join(dir, ".auto", "research", "c_root"); fs.mkdirSync(rootDir, { recursive: true });
 fs.writeFileSync(path.join(rootDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c_root", created_at: new Date().toISOString(), phase: "stopped" }, null, 2) + "\n");
 const charter = path.join(os.tmpdir(), `guard-charter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
 fs.writeFileSync(charter, JSON.stringify({ stop_rules: ["two rejected findings in a row"] }) + "\n");
 const { pi, tool, command, hook } = createFakePi({ dir, sessionId: "guard-chain-create", realGit: false }); const ctx = makeCtx(dir, "guard-chain-create", pi); ctx.ui.confirm = async () => true;
 const { default: extension } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href); extension(pi);
 await command("autoresearch").handler(`research --charter ${charter} --id c_root study`, ctx);
 const chainBase = path.join(dir, ".auto", "research-chain"); assert.ok(fs.existsSync(chainBase), `charter launch did not create chain: ${JSON.stringify(pi.notifications.map((n) => n.text))}`); const chainId = fs.readdirSync(chainBase)[0]; const chainDir = path.join(chainBase, chainId);
 const appended = await appendEntry(chainDir, dir, chainId, "campaign_added", { campaign_id: "c_chain" }); assert.equal(appended.ok, true);
 const campaignDir = path.join(dir, ".auto", "research", "c_chain"); fs.mkdirSync(campaignDir, { recursive: true });
 fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c_chain", created_at: new Date().toISOString(), phase: "research" }, null, 2) + "\n");
 const journalPath = path.join(chainDir, "chain.json"); const before = fs.readFileSync(journalPath);
 await command("autoresearch").handler("research", ctx); const refusal = pi.notifications.map((n) => n.text).find((x) => /Cannot launch research/.test(x)) ?? "";
 assert.match(refusal, /c_chain/); assert.match(refusal, /active chain/); assert.deepEqual(fs.readFileSync(journalPath), before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8")).phase, "research"); assert.equal(fs.existsSync(path.join(campaignDir, "report.md")), false);
});

test("tampered approved brief refuses launch with brief_changed", async () => {
 const dir = makeWorkDir("tampered"); const h0 = await load(dir, "tamper", "research --id c0"); await draftAndApprove(h0, "c0"); fs.writeFileSync(path.join(dir, ".auto", "research", "c0", "brief.json"), JSON.stringify({ ...briefFixture(), goal: "Tampered." })); const h = await load(dir, "tampered-new", "research"); const refusal = h.pi.notifications.map((n) => n.text).find((x) => /Cannot launch research/.test(x)) ?? ""; assert.match(refusal, /c0/); assert.match(refusal, /brief.json changed after approval/); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c0", "state.json"), "utf8")).phase, "briefing");
});

test("stopped campaign does not block expedition launch", async () => {
 const dir = makeWorkDir("exp-stopped"); const h0 = await makeResearch(dir, "c1"); await call(h0, "research", { action: "stop", rule_id: "S1", reason: "done" }); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "state.json"), "utf8")).phase, "stopped"); const h = await load(dir, "exp-stopped-new", "expedition cache study"); assert.equal(h.pi.notifications.some((n) => /Cannot launch expedition/.test(n.text)), false, "finished campaign must not refuse expedition launch"); assert.ok(h.pi.sentMessages.length > 0, "expedition design phase kickoff is sent"); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "state.json"), "utf8")).phase, "stopped"); assert.equal(fs.existsSync(path.join(dir, ".auto", "research-archive")), false, "stopped campaign stays in place");
});
test("research-phase campaign still refuses expedition launch", async () => {
 const dir = makeWorkDir("exp-active"); const campaignDir = path.join(dir, ".auto", "research", "c_act"); fs.mkdirSync(campaignDir, { recursive: true }); fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c_act", created_at: new Date().toISOString(), phase: "research" }, null, 2) + "\n"); const h = await load(dir, "exp-active-new", "expedition x"); const refusal = h.pi.notifications.map((n) => n.text).find((x) => /Cannot launch expedition/.test(x)) ?? ""; assert.match(refusal, /active/); assert.equal(h.pi.sentMessages.length, 0, "expedition refuses before kickoff"); assert.equal(JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8")).phase, "research");
});
test("pending-op campaign refuses expedition launch (fail closed)", async () => {
 const dir = makeWorkDir("exp-pending"); const campaignDir = path.join(dir, ".auto", "research", "c_pend"); fs.mkdirSync(campaignDir, { recursive: true }); fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "c_pend", created_at: new Date().toISOString(), phase: "briefing" }, null, 2) + "\n"); fs.writeFileSync(path.join(campaignDir, "pending-op.json"), "{}"); const h = await load(dir, "exp-pending-new", "expedition x"); assert.ok(h.pi.notifications.some((n) => /Cannot launch expedition/.test(n.text))); assert.equal(h.pi.sentMessages.length, 0);
});
test("unreadable campaign state refuses expedition launch (fail closed)", async () => {
 const dir = makeWorkDir("exp-unreadable"); const campaignDir = path.join(dir, ".auto", "research", "c_bad"); fs.mkdirSync(campaignDir, { recursive: true }); fs.writeFileSync(path.join(campaignDir, "state.json"), "garbage"); const before = fs.readFileSync(path.join(campaignDir, "state.json")); const h = await load(dir, "exp-unreadable-new", "expedition x"); assert.ok(h.pi.notifications.some((n) => /Cannot launch expedition/.test(n.text))); assert.equal(h.pi.sentMessages.length, 0); assert.deepEqual(fs.readFileSync(path.join(campaignDir, "state.json")), before);
});
