/** Tests for stale research campaign closure (openspec research-campaign-switch tasks 1.1+2.1). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-stale-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sha256Of(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function rulesFor(qid) {
  return [
    { id: `${qid}-yes`, verdict: "confirmed", when: "effect is present in validate data" },
    { id: `${qid}-no`, verdict: "rejected", when: "effect is absent in validate data" },
    { id: `${qid}-unknown`, verdict: "inconclusive", when: "data are too noisy to decide" },
    { id: `${qid}-wait`, verdict: "waiting_for_data", when: "validate data are missing" },
  ];
}
function briefFixture() {
  return {
    schema_version: 1,
    goal: "Check whether the cache layer explains the latency drop.",
    plan_source: "docs/plan.md",
    caveat_block: "Results are observational; no causal claim is made beyond the listed data.",
    data_roles: { explore: ["logs/2024-01.txt"], validate: ["logs/2024-02.txt"], confirm: [] },
    questions: [{ id: "Q1", text: "Does the cache hit rate rise after the change?", decision_rules: rulesFor("Q1"), needs_data: null }],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
}
async function load(dir, label, commandArgs) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `stale-${label}`, realGit: false });
  const ctx = makeCtx(dir, `stale-${label}`, pi);
  const { default: autoresearchExtension } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  autoresearchExtension(pi);
  await command("autoresearch").handler(commandArgs, ctx);
  const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  return { pi, tool, command, hook, ctx, dir, closeStaleCampaign: mod.closeStaleCampaign };
}
function call(h, name, params) { return h.tool(name).execute("tool-call-id", params, null, null, h.ctx); }
function textOf(res) { return res?.content?.[0]?.text ?? ""; }
async function draftAndApprove(h, id) {
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  return sha256Of(fs.readFileSync(path.join(h.dir, ".auto", "research", id, "brief.json")));
}
async function makeStopped(dir, id) {
  const h = await load(dir, `make-${id}`, `research --id ${id}`);
  const sha = await draftAndApprove(h, id);
  await call(h, "research", { action: "start", expected_sha256: sha });
  await call(h, "research", { action: "stop", rule_id: "S1", reason: "two rejections recorded" });
  return h;
}
function campaignDir(h, id = "c1") { return path.join(h.dir, ".auto", "research", id); }

 test("stale research closure logs abandon and reports open vectors without verdicts", async () => {
  const dir = makeWorkDir("research");
  const h = await load(dir, "research", "research --id c1");
  const sha = await draftAndApprove(h, "c1");
  await call(h, "research", { action: "start", expected_sha256: sha });
  await call(h, "research", { action: "open", question_id: "Q1" });
  const result = await h.closeStaleCampaign(campaignDir(h));
  assert.equal(result.ok, true, JSON.stringify(result));
  const state = JSON.parse(fs.readFileSync(path.join(campaignDir(h), "state.json"), "utf8"));
  assert.equal(state.phase, "stopped");
  const log = fs.readFileSync(path.join(campaignDir(h), "log.jsonl"), "utf8");
  assert.match(log, /"event":"abandon","reason":"stale"/);
  const report = fs.readFileSync(path.join(campaignDir(h), "report.md"), "utf8");
  assert.match(report, /CLOSED AS STALE/);
  assert.match(report, /Q1.*OPEN: not closed, no verdict/);
  assert.doesNotMatch(report, /successfully completed|campaign completed/i);
}, { timeout: 60000 });

test("stale briefing closure embeds an unapproved draft and omits result sections", async () => {
  const dir = makeWorkDir("briefing");
  const h = await load(dir, "briefing", "research --id c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  const draft = fs.readFileSync(path.join(campaignDir(h), "brief.json"), "utf8");
  const result = await h.closeStaleCampaign(campaignDir(h));
  assert.equal(result.ok, true, JSON.stringify(result));
  const report = fs.readFileSync(path.join(campaignDir(h), "report.md"), "utf8");
  assert.match(report, /CLOSED AS STALE/);
  assert.ok(report.includes(draft.split("\n").map((line) => `    ${line}`).join("\n")));
  assert.match(report, /Check whether the cache layer explains the latency drop/);
  assert.doesNotMatch(report, /## Questions|Stop rule/i);
}, { timeout: 60000 });

test("stale reports keep hostile draft and approved brief text inside their report structure", async () => {
  const hostile = "First line\n```\n## Questions\nStatus: COMPLETED COMPLETED";
  const draftDir = makeWorkDir("hostile-draft");
  const draftHandle = await load(draftDir, "hostile-draft", "research --id c1");
  await call(draftHandle, "research_brief", { action: "draft", brief: { ...briefFixture(), goal: `Goal\nStatus: COMPLETED COMPLETED`, plan_source: "plan.md", caveat_block: hostile } });
  const draftResult = await draftHandle.closeStaleCampaign(campaignDir(draftHandle));
  assert.equal(draftResult.ok, true, JSON.stringify(draftResult));
  const draftReport = fs.readFileSync(path.join(campaignDir(draftHandle), "report.md"), "utf8");
  assert.equal(draftReport.split("\n").filter((line) => line.includes("CLOSED AS STALE")).length, 1);
  assert.match(draftReport, /Goal: Goal Status: COMPLETED COMPLETED/);
  const hostileDraft = fs.readFileSync(path.join(campaignDir(draftHandle), "brief.json"), "utf8");
  assert.ok(draftReport.includes(hostileDraft.split("\n").map((line) => `    ${line}`).join("\n")));
  assert.ok(draftReport.split("\n").filter((line) => line.startsWith("## ")).every((line) => ["## Draft brief"].includes(line)));
  const embeddedDraft = draftReport.slice(draftReport.indexOf("## Draft brief") + "## Draft brief".length);
  assert.ok(embeddedDraft.split("\n").slice(1).filter(Boolean).every((line) => line.startsWith("    ")));

  const approvedDir = makeWorkDir("hostile-approved");
  const approvedHandle = await load(approvedDir, "hostile-approved", "research --id c1");
  const brief = briefFixture();
  brief.goal = "Approved goal\nStatus: COMPLETED COMPLETED";
  brief.questions[0].text = "Q text\n## Questions\n```";
  brief.questions[0].decision_rules[0].when = "rule\nStatus: COMPLETED";
  brief.caveat_block = hostile;
  await call(approvedHandle, "research_brief", { action: "draft", brief });
  approvedHandle.ctx.ui.confirm = async () => true;
  await call(approvedHandle, "research_brief", { action: "propose" });
  const approvedResult = await approvedHandle.closeStaleCampaign(campaignDir(approvedHandle));
  assert.equal(approvedResult.ok, true, JSON.stringify(approvedResult));
  const approvedReport = fs.readFileSync(path.join(campaignDir(approvedHandle), "report.md"), "utf8");
  assert.equal(approvedReport.split("\n").filter((line) => line.includes("CLOSED AS STALE")).length, 1);
  assert.match(approvedReport, /Goal: Approved goal Status: COMPLETED COMPLETED/);
  assert.ok(approvedReport.split("\n").every((line) => !/^## (?!Questions$|Stop rules$)/.test(line)));
  assert.match(approvedReport, /Q1: Q text ## Questions ```/);
}, { timeout: 60000 });

test("stale briefing closure succeeds when no draft brief was ever written", async () => {
  const dir = makeWorkDir("no-brief");
  const h = await load(dir, "no-brief", "research --id setup");
  const cdir = path.join(dir, ".auto", "research", "empty");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, "state.json"), JSON.stringify({
    schema_version: 1, campaign_id: "empty", created_at: new Date().toISOString(), phase: "briefing",
  }, null, 2) + "\n");
  const result = await h.closeStaleCampaign(cdir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cdir, "state.json"), "utf8")).phase, "stopped");
  assert.match(fs.readFileSync(path.join(cdir, "log.jsonl"), "utf8"), /"event":"abandon","reason":"stale"/);
  const report = fs.readFileSync(path.join(cdir, "report.md"), "utf8");
  assert.match(report, /Draft brief: none was written/);
  assert.match(report, /CLOSED AS STALE/);
  assert.doesNotMatch(report, /## Questions/);
}, { timeout: 60000 });

test("corrupt unapproved draft refuses stale closure without changing phase or journal", async () => {
  const dir = makeWorkDir("corrupt-brief");
  const h = await load(dir, "corrupt-brief", "research --id setup");
  const cdir = path.join(dir, ".auto", "research", "broken");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, "state.json"), JSON.stringify({
    schema_version: 1, campaign_id: "broken", created_at: new Date().toISOString(), phase: "briefing",
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(cdir, "brief.json"), Buffer.from([0xff, 0xfe, 0x00]));
  const result = await h.closeStaleCampaign(cdir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "brief_unreadable");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cdir, "state.json"), "utf8")).phase, "briefing");
  assert.equal(fs.existsSync(path.join(cdir, "log.jsonl")), false);
}, { timeout: 60000 });

test("pending operation refuses stale closure without changing journal or phase", async () => {
  const dir = makeWorkDir("pending");
  const h = await load(dir, "pending", "research --id c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  const cdir = campaignDir(h);
  fs.writeFileSync(path.join(cdir, "pending-op.json"), JSON.stringify({ name: "held", started_at: new Date().toISOString() }));
  const result = await h.closeStaleCampaign(cdir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "manual_check_required");
  assert.equal(fs.existsSync(path.join(cdir, "log.jsonl")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cdir, "state.json"), "utf8")).phase, "briefing");
}, { timeout: 60000 });

test("failed report write leaves pending operation and blocks retry", async () => {
  const dir = makeWorkDir("atomic");
  const h = await load(dir, "atomic", "research --id c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  const cdir = campaignDir(h);
  fs.mkdirSync(path.join(cdir, "report.md"));
  const failed = await h.closeStaleCampaign(cdir);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "operation_failed");
  assert.ok(fs.existsSync(path.join(cdir, "pending-op.json")));
  const retry = await h.closeStaleCampaign(cdir);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "manual_check_required");
}, { timeout: 60000 });

test("stopped campaign cannot be closed stale twice", async () => {
  const dir = makeWorkDir("reclose");
  const h = await makeStopped(dir, "c1");
  const result = await h.closeStaleCampaign(campaignDir(h));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_transition");
  assert.equal(fs.readFileSync(path.join(campaignDir(h), "log.jsonl"), "utf8").match(/"event":"abandon"/g), null);
}, { timeout: 60000 });

test("abandon is accepted only as the final event and never after stop", async () => {
  const dir = makeWorkDir("replay");
  const h = await load(dir, "replay", "research --id c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  const cdir = campaignDir(h);
  const valid = [{ event: "open", question_id: "Q1" }, { event: "abandon", reason: "stale" }];
  for (const events of [valid]) {
    fs.writeFileSync(path.join(cdir, "log.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const result = await call(h, "research", { action: "status" });
    assert.doesNotMatch(textOf(result), /state_unreadable|entry \d+ is/i);
  }
  const invalidSets = [
    [...valid, { event: "record", question_id: "Q1", evidence_ref: "x", evidence_path: "x", evidence_sha256: "0".repeat(64) }],
    [{ event: "open", question_id: "Q1" }, { event: "stop", rule_id: "S1" }, { event: "abandon", reason: "stale" }],
    [...valid, { event: "abandon", reason: "stale" }],
  ];
  for (const events of invalidSets) {
    fs.writeFileSync(path.join(cdir, "log.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const result = await call(h, "research", { action: "status" });
    assert.match(textOf(result), /state_unreadable|entry \d+ is/i, textOf(result));
  }
}, { timeout: 60000 });

test("approved brief hash tampering refuses stale closure", async () => {
  const dir = makeWorkDir("tamper");
  const h = await load(dir, "tamper", "research --id c1");
  await draftAndApprove(h, "c1");
  fs.appendFileSync(path.join(campaignDir(h), "brief.json"), " ");
  const result = await h.closeStaleCampaign(campaignDir(h));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "brief_changed");
  assert.equal(fs.existsSync(path.join(campaignDir(h), "log.jsonl")), false);
}, { timeout: 60000 });
