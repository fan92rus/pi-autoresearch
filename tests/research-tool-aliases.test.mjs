import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

const brief = {
  schema_version: 1,
  goal: "Study cache latency",
  plan_source: "plan.md",
  caveat_block: "Observational only",
  data_roles: { explore: [], validate: [], confirm: [] },
  questions: [{ id: "Q1", text: "Does latency improve?", decision_rules: [{ id: "yes", verdict: "confirmed", when: "measured improvement" }, { id: "no", verdict: "rejected", when: "no improvement" }, { id: "unknown", verdict: "inconclusive", when: "unclear" }, { id: "wait", verdict: "waiting_for_data", when: "data missing" }], needs_data: null }],
  process_metrics: [], stop_rules: [],
};
const doc = { charter: { stop_rules: [] }, goal: "Study cache latency", directions: [{ name: "cache", why: "Measure cache effects" }], campaign0: brief };
const text = (result) => result?.content?.[0]?.text ?? "";

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-aliases-"));
  const { pi, tool, command } = createFakePi({ dir, sessionId: "research-aliases", realGit: false });
  const ctx = makeCtx(dir, "research-aliases", pi);
  ctx.ui.confirm = async () => true;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  return { dir, pi, tool, command, ctx, ext };
}

async function startExpedition(h) {
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  const draft = await h.tool("expedition_brief").execute("draft", { action: "draft", doc }, null, null, h.ctx);
  assert.match(text(draft), /draft saved/i, text(draft));
  const result = await h.tool("expedition_brief").execute("propose", { action: "propose" }, null, null, h.ctx);
  const campaignId = text(result).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(campaignId, text(result));
  return campaignId;
}

function properties(tool) {
  return tool.parameters.properties;
}

test("model-facing campaign guidance never directs calls to the hidden dispatcher", async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts"), "utf8");
  for (const hiddenCall of ["research status", "research start", "research open", "research record", "research close", "research stop"]) {
    assert.equal(source.includes(hiddenCall), false, `model-facing guidance still contains ${hiddenCall}`);
  }
  assert.match(source, /research_questions\(action=status\)/);
  assert.match(source, /research_questions\(action=start/);
  assert.match(source, /research_questions\(action=report\)/);
  assert.doesNotMatch(source, /research_questions\(action=[^)]*\|/, "instructions must not present an enum union as one action call");
  assert.doesNotMatch(source, /expedition_map\(subaction=[^)]*[|/]/, "map subaction examples must also be one value per call");
  assert.match(source, /research_questions\(action=stop,[^)]*rule_id[^)]*reason/);
  assert.match(source, /research_questions\(action="close", question_id, rule_id, verdict\)/);
  assert.match(source, /expedition_map\(subaction=activate, dir=<name>, why=<rationale>\)/);
  assert.match(source, /expedition_map\(subaction="resolve", dir=<name>, refs=\[\{campaign,question\}\]\)/);
  assert.match(source, /expedition_map\(subaction="reject", dir=<name>, refs=\[\{campaign,question\}\]\)/);
  assert.match(source, /expedition_map\(subaction="advisory", dir=<name>, review_ref=<path>, review_sha256=<sha256>\)/);
  assert.match(source, /expedition_map\(subaction="park", dir=<name>, reason=<why>\)/);
  assert.match(source, /expedition_map\(subaction="pivot", from=<active>, to=<target>, reason=<why>\)/);
  assert.doesNotMatch(source, /expedition_map\(subaction="(?:activate|pivot|resolve|reject)"\)/, "map prompts must include required parameters");
});

test("registers separate aliases with non-overlapping schemas and hides combined dispatcher", async () => {
  const h = await harness();
  const questions = h.tool("research_questions");
  const map = h.tool("expedition_map");
  const legacy = h.tool("research");
  assert.ok(questions && map && legacy);
  assert.equal(legacy.exposure, "hidden", "combined research dispatcher must not be callable by the model");
  assert.ok(properties(questions).action.enum.includes("close"));
  for (const key of ["rule_id", "verdict", "question_id", "evidence_ref"]) assert.ok(key in properties(questions));
  for (const key of ["refs", "review_ref", "review_sha256", "from", "to"]) assert.equal(key in properties(questions), false, `research_questions exposes ${key}`);
  assert.ok(properties(map).subaction.enum.includes("resolve"));
  for (const key of ["dir", "from", "to", "reason", "why", "refs", "review_ref", "review_sha256"]) assert.ok(key in properties(map));
  for (const key of ["rule_id", "verdict"]) assert.equal(key in properties(map), false, `expedition_map exposes ${key}`);
  assert.ok(properties(legacy).action.enum.includes("expedition"), "hidden dispatcher retains internal action schema for shared executor/tests");
});

test("campaign question close delegates to legacy campaign executor", async () => {
  const h = await harness();
  await h.command("autoresearch").handler("on", h.ctx);
  const params = { action: "close", question_id: "Q1", rule_id: "yes", verdict: "confirmed" };
  const alias = await h.tool("research_questions").execute("alias", params, null, null, h.ctx);
  const legacy = await h.tool("research").execute("legacy", params, null, null, h.ctx);
  assert.equal(text(alias), text(legacy));
  assert.match(text(alias), /no campaign|not found|brief|not approved/i);
});

test("map alias delegates to the existing expedition map executor", async () => {
  const h = await harness();
  await startExpedition(h);
  const result = await h.tool("expedition_map").execute("map-status", { subaction: "status" }, null, null, h.ctx);
  assert.match(text(result), /cache|expedition map/i);
  assert.equal(result.details?.action, "expedition");
});

test("cross-facade fields are refused with an actionable redirect and no map write", async () => {
  const h = await harness();
  await h.command("autoresearch").handler("on", h.ctx);
  await startExpedition(h);
  const chainFile = path.join(h.dir, ".auto", "research-chain");
  const beforeDirs = fs.readdirSync(chainFile);
  const mapBad = await h.tool("expedition_map").execute("bad-map", { subaction: "resolve", dir: "cache", rule_id: "yes", verdict: "confirmed" }, null, null, h.ctx);
  assert.match(text(mapBad), /research_questions\(action=close/);
  assert.deepEqual(fs.readdirSync(chainFile), beforeDirs);
  const questionBad = await h.tool("research_questions").execute("bad-question", { action: "close", question_id: "Q1", refs: [{ campaign: "c", question: "Q1" }] }, null, null, h.ctx);
  assert.match(text(questionBad), /expedition_map\(subaction=\.\.\., refs=\.\.\.\)/);
});

test("research_questions resolve remains operator pending-op resolution and never changes map", async () => {
  const h = await harness();
  await h.command("autoresearch").handler("on", h.ctx);
  const campaignId = await startExpedition(h);
  const campaignDir = path.join(h.dir, ".auto", "research", campaignId);
  fs.writeFileSync(path.join(campaignDir, "pending-op.json"), JSON.stringify({ name: "test operation", started_at: new Date().toISOString() }));
  const chainDir = path.join(h.dir, ".auto", "research-chain", `${campaignId}-chain`);
  const chainFile = path.join(chainDir, "chain.json");
  const before = fs.readFileSync(chainFile, "utf8");
  let confirmations = 0;
  h.ctx.ui.confirm = async () => { confirmations++; return true; };
  const result = await h.tool("research_questions").execute("resolve", { action: "resolve" }, null, null, h.ctx);
  assert.equal(confirmations, 1, "pending-op resolution requires owner confirmation");
  assert.match(text(result), /resolved by the operator/i);
  assert.equal(fs.existsSync(path.join(campaignDir, "pending-op.json")), false);
  assert.equal(fs.readFileSync(chainFile, "utf8"), before, "operator cleanup must not append a map transition");
});

test("aliases preserve execution-time autoresearch mode gate", async () => {
  const h = await harness();
  const map = await h.tool("expedition_map").execute("off-map", { subaction: "status" }, null, null, h.ctx);
  const questions = await h.tool("research_questions").execute("off-questions", { action: "status" }, null, null, h.ctx);
  assert.match(text(map), /Autoresearch mode is OFF/);
  assert.match(text(questions), /Autoresearch mode is OFF/);
});

test("renderCall for each alias always returns a renderable component", async () => {
  const h = await harness();
  const theme = { fg: (_color, value) => value, bold: (value) => value };
  const map = h.tool("expedition_map");
  const questions = h.tool("research_questions");
  for (const [tool, args] of [[map, { subaction: "activate", dir: "cache", why: "fresh" }], [map, null], [questions, { action: "close", question_id: "Q1" }], [questions, undefined]]) {
    const component = tool.renderCall(args, theme, {});
    assert.ok(component && typeof component.render === "function");
    assert.doesNotThrow(() => component.render(100));
  }
  const output = map.renderCall({ subaction: "activate", dir: "cache" }, theme, {}).render(100).join?.("\n") ?? map.renderCall({ subaction: "activate", dir: "cache" }, theme, {}).render(100);
  assert.match(String(output), /activate.*cache/);
});

test("restart restore message uses the map and question aliases", async () => {
  const h = await harness();
  await startExpedition(h);
  const resumed = makeCtx(h.dir, "research-aliases-restored", h.pi);
  await h.ext.restoreExpeditionForTest(resumed);
  const message = h.pi.sentMessages.find((item) => /restored after restart/.test(item.text))?.text ?? "";
  assert.match(message, /research_questions/);
  assert.match(message, /expedition_map/);
  assert.match(message, /Question close is not direction resolve/);
});

test("child campaign continuation teaches aliases for question and map operations", async () => {
  const h = await harness();
  const campaignId = await startExpedition(h);
  const campaignDir = path.join(h.dir, ".auto", "research", campaignId);
  const stateFile = path.join(campaignDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), phase: "stopped" }, null, 2) + "\n");
  fs.writeFileSync(path.join(campaignDir, "log.jsonl"), [
    JSON.stringify({ at: new Date().toISOString(), event: "open", question_id: "Q1" }),
    JSON.stringify({ at: new Date().toISOString(), event: "close", question_id: "Q1", rule_id: "yes", verdict: "confirmed", reason: null }),
    JSON.stringify({ at: new Date().toISOString(), event: "stop", rule_id: "S1", reason: "done" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(campaignDir, "report.md"), "# report\n");
  await h.tool("research_questions").execute("report", { action: "report" }, null, null, h.ctx);
  const message = h.pi.sentMessages.at(-1)?.text ?? "";
  assert.match(message, /research_questions\(action="close", question_id, rule_id, verdict\)/);
  assert.match(message, /expedition_map/);
  assert.match(message, /question close is not direction resolve/i);
});

test("expedition kickoff steer and reply use aliases and explain question/direction distinction", async () => {
  const h = await harness();
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  const draft = await h.tool("expedition_brief").execute("draft", { action: "draft", doc }, null, null, h.ctx);
  assert.match(text(draft), /draft saved/i, text(draft));
  const result = await h.tool("expedition_brief").execute("propose", { action: "propose" }, null, null, h.ctx);
  const messages = h.pi.sentMessages.map((message) => message.text).join("\n") + "\n" + text(result);
  assert.match(messages, /expedition_map/);
  assert.match(messages, /research_questions/);
  assert.match(messages, /Question close is not map direction resolve/i);
  assert.doesNotMatch(messages, /research expedition/i, "messages must not prescribe or mention the removed combined tool syntax");
});
