/**
 * research-charter wiring (bd pi-autoresearch-5ol): /autoresearch research
 * --charter launch, chain state in the session runtime, research chain_stop
 * (operator dialog / charter stop-rule self-report), the chain-aware report
 * branch (intermediate report keeps the mode ON and hands out ONE continuation,
 * final report leaves the mode), archive exclusion for chain campaigns and the
 * auto-approved child brief draft. Non-chain behavior must stay byte-for-byte.
 *
 * Run: timeout 300 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-charter-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-charter-w-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rulesFor(qid) {
  return [
    { id: `${qid}-yes`, verdict: "confirmed", when: "effect is present in validate data" },
    { id: `${qid}-no`, verdict: "rejected", when: "effect is absent in validate data" },
    { id: `${qid}-unknown`, verdict: "inconclusive", when: "data are too noisy to decide" },
    { id: `${qid}-wait`, verdict: "waiting_for_data", when: "validate data are missing" },
  ];
}

function briefFixture(questionOverrides = {}) {
  return {
    schema_version: 1,
    goal: "Check whether the cache layer explains the latency drop.",
    plan_source: "docs/plan.md",
    caveat_block: "Results are observational; no causal claim is made beyond the listed data.",
    data_roles: { explore: ["logs/2024-01.txt"], validate: ["logs/2024-02.txt"], confirm: [] },
    questions: [{
      id: "Q1",
      text: "Does the cache hit rate rise after the change?",
      decision_rules: rulesFor("Q1"),
      needs_data: null,
      ...questionOverrides,
    }],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
}

/** Writes a charter OUTSIDE the work directory (parent of dir). */
function writeCharter(dir, body = {}) {
  const p = path.join(dir, "..", `charter-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(p, JSON.stringify(body) + "\n", "utf8");
  return p;
}

/** Writes a schema-valid campaign state with the given phase. */
function writeCampaignState(dir, id, phase) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
}

function writeApproval(campaignDir, briefText) {
  fs.writeFileSync(
    path.join(campaignDir, "approval.json"),
    JSON.stringify({ schema_version: 1, brief_sha256: sha256Hex(briefText), approved_at: new Date().toISOString(), confirmed: true }, null, 2) + "\n",
  );
}

function writeBriefAndLog(campaignDir, brief, logEvents) {
  const briefText = JSON.stringify(brief, null, 2) + "\n";
  fs.writeFileSync(path.join(campaignDir, "brief.json"), briefText);
  writeApproval(campaignDir, briefText);
  const log = logEvents.map((e) => JSON.stringify({ at: new Date().toISOString(), ...e })).join("\n") + "\n";
  fs.writeFileSync(path.join(campaignDir, "log.jsonl"), log);
  return briefText;
}

/** A stopped root campaign with one closed-with-evidence question. */
function writeStoppedRootCampaign(dir, id = "c1") {
  const campaignDir = writeCampaignState(dir, id, "stopped");
  const brief = briefFixture();
  const briefText = writeBriefAndLog(campaignDir, brief, [
    { event: "open", question_id: "Q1" },
    { event: "record", question_id: "Q1", evidence_ref: "logs/x.txt:1-2", evidence_path: "logs/x.txt", evidence_sha256: "a".repeat(64) },
    { event: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed", reason: null, evidence_count: 1 },
    { event: "stop", rule_id: "S1", reason: "done" },
  ]);
  fs.writeFileSync(path.join(campaignDir, "report.md"), "# report\n");
  return { campaignDir, brief, briefText };
}

async function loadExtensionBare(dir, label, confirmReply = undefined) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `charter-w-${label}`, realGit: false });
  const ctx = makeCtx(dir, `charter-w-${label}`, pi);
  if (confirmReply !== undefined) ctx.ui.confirm = async () => confirmReply;
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, tool, command, hook, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

function listDirs(p) {
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

function chainDirOf(dir, chainId) {
  return path.join(dir, ".auto", "research-chain", chainId);
}

function chainStatus(dir, chainId) {
  const lines = fs.readFileSync(path.join(chainDirOf(dir, chainId), "chain.json"), "utf8").split("\n").filter((l) => l !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    if (e.type === "status_change") return e.status;
  }
  return "active";
}

async function launchWithCharter(h, charterPath, campaignId) {
  const args = `research --charter ${charterPath}` + (campaignId ? ` --id ${campaignId}` : "") + " cache latency study";
  return h.command("autoresearch").handler(args, h.ctx);
}

// ─── Launch with a charter ───────────────────────────────────────────────────

test("launch with --charter confirms the charter in a dialog and creates the chain for an existing pinned campaign", async () => {
  const dir = makeWorkDir("launch");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { stop_rules: ["two rejected findings in a row"] });
  const h = await loadExtensionBare(dir, "launch", true);

  await launchWithCharter(h, charterPath, "c1");

  assert.ok(fs.existsSync(chainDirOf(dir, "c1-chain")), "chain directory created under .auto/research-chain");
  assert.equal(chainStatus(dir, "c1-chain"), "active", "chain starts active");
  const head = fs.readFileSync(path.join(chainDirOf(dir, "c1-chain"), "chain-head"), "utf8");
  assert.match(head, /^[0-9a-f]{64}/, "chain-head anchor written");
});

test("launch refuses a charter inside the work directory and starts nothing", async () => {
  const dir = makeWorkDir("inside");
  const insidePath = path.join(dir, "charter-inside.json");
  fs.writeFileSync(insidePath, JSON.stringify({}) + "\n");
  const h = await loadExtensionBare(dir, "inside", true);

  await launchWithCharter(h, insidePath, "c1");

  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-chain")), false, "no chain directory");
  assert.ok(
    h.pi.notifications.some((n) => n.type === "error"),
    "an error notify names the refusal",
  );
});

test("launch with --charter is refused when the owner does not confirm the dialog", async () => {
  const dir = makeWorkDir("refused");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "refused", false);

  await launchWithCharter(h, charterPath, "c1");

  assert.equal(fs.existsSync(chainDirOf(dir, "c1-chain")), false, "no chain state on owner refusal");
});

// ─── chain_stop ──────────────────────────────────────────────────────────────

test("chain_stop without an operator dialog is refused: the model cannot stop the chain", async () => {
  const dir = makeWorkDir("stop-nodialog");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "stop-nodialog", true);
  await launchWithCharter(h, charterPath, "c1");
  // Drop the confirm function: the model calls the tool without a dialog channel.
  delete h.ctx.ui.confirm;

  const res = textOf(await call(h, "research", { action: "chain_stop" }));

  assert.match(res, /chain_stop|operator|dialog/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "active", "status unchanged");
});

test("chain_stop with the operator dialog from awaiting_child stops the chain and turns the mode OFF", async () => {
  const dir = makeWorkDir("stop-pause");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "stop-pause", true);
  await launchWithCharter(h, charterPath, "c1");
  // Intermediate report: the chain moves to awaiting_child, mode stays ON.
  const rep = textOf(await call(h, "research", { action: "report" }));
  assert.match(rep, /awaiting/i, rep);
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child");

  const res = textOf(await call(h, "research", { action: "chain_stop" }));

  assert.match(res, /stopped_by_owner|chain/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "stopped_by_owner");
  assert.ok(
    h.pi.notifications.some((n) => /mode OFF/i.test(n.text)),
    "mode-off notify sent immediately from the pause",
  );
  // After the pause stop the mode is OFF: chain actions refuse at the mode gate
  // (spec: after the exit, the mode tools refuse; /autoresearch on restarts).
  const again = textOf(await call(h, "research", { action: "chain_stop" }));
  assert.match(again, /Autoresearch mode is OFF/i, again);
});

test("chain_stop with the operator dialog during an active campaign keeps the mode ON", async () => {
  const dir = makeWorkDir("stop-active");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "stop-active", true);
  await launchWithCharter(h, charterPath, "c1");

  const res = textOf(await call(h, "research", { action: "chain_stop" }));

  assert.match(res, /stopped_by_owner|chain/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "stopped_by_owner");
  assert.equal(h.pi.notifications.some((n) => /mode OFF/i.test(n.text)), false, "mode stays ON during an active campaign");
});

test("chain_stop with a charter stop rule is a self-report and does not need the operator", async () => {
  const dir = makeWorkDir("stop-rule");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { stop_rules: ["two rejected findings in a row"] });
  const h = await loadExtensionBare(dir, "stop-rule", true);
  await launchWithCharter(h, charterPath, "c1");
  // The charter stop rule is an agent self-report: no dialog needed. Remove the
  // dialog channel to prove it.
  delete h.ctx.ui.confirm;

  const res = textOf(await call(h, "research", { action: "chain_stop", rule_id: "two rejected findings in a row", reason: "met" }));

  assert.match(res, /stopped_by_rule|chain/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "stopped_by_rule");
});

test("chain_stop with a rule that is not in the charter is refused", async () => {
  const dir = makeWorkDir("stop-badrule");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { stop_rules: ["two rejected findings in a row"] });
  const h = await loadExtensionBare(dir, "stop-badrule", true);
  await launchWithCharter(h, charterPath, "c1");
  delete h.ctx.ui.confirm;

  const res = textOf(await call(h, "research", { action: "chain_stop", rule_id: "invented rule", reason: "met" }));

  assert.match(res, /not .*charter|invalid_argument|stop rule/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "active");
});

// ─── Report branch ───────────────────────────────────────────────────────────

test("intermediate report keeps the mode ON, sets awaiting_child and sends ONE continuation with the parent id", async () => {
  const dir = makeWorkDir("report-inter");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "report-inter", true);
  await launchWithCharter(h, charterPath, "c1");
  const before = h.pi.sentMessages.length;

  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /awaiting/i, res);
  assert.match(res, /c1/, res);
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child");
  assert.equal(h.pi.sentMessages.length, before + 1, "exactly one continuation message");
  assert.match(h.pi.sentMessages[h.pi.sentMessages.length - 1].text, /c1/, "continuation names the parent campaign");
  // A second report does not send another continuation for the same period.
  const before2 = h.pi.sentMessages.length;
  await call(h, "research", { action: "report" });
  assert.equal(h.pi.sentMessages.length, before2, "no repeated continuation without a new brief");
});

test("report of a stopped campaign without a charter leaves the mode OFF as before", async () => {
  const dir = makeWorkDir("report-noch");
  writeStoppedRootCampaign(dir, "c1");
  const h = await loadExtensionBare(dir, "report-noch", true);

  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /Research mode is OFF/, res);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-chain")), false, "no chain artifacts without a charter");
});

// ─── Archive exclusion ───────────────────────────────────────────────────────

test("an active chain keeps its campaigns in place; unrelated stopped campaigns are archived", async () => {
  const dir = makeWorkDir("archive-excl");
  writeStoppedRootCampaign(dir, "c1");
  writeCampaignState(dir, "x9", "stopped");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "archive-excl", true);
  await launchWithCharter(h, charterPath, "c1");
  // Move the chain into awaiting_child so a child draft is legal.
  await call(h, "research", { action: "report" });
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /chain|approved|draft/i, res);
  const campaigns = listDirs(path.join(dir, ".auto", "research"));
  assert.ok(campaigns.includes("c1"), `the chain parent stays: ${campaigns}`);
  assert.ok(campaigns.some((c) => /-c1$/.test(c)), `a system child campaign exists: ${campaigns}`);
  const archived = listDirs(path.join(dir, ".auto", "research-archive"));
  assert.ok(archived.some((n) => n.startsWith("x9-")), `the unrelated stopped campaign is archived: ${archived}`);
  assert.equal(archived.some((n) => n.startsWith("c1-")), false, "the chain campaign is never archived");
});

// ─── Child brief auto-approval ───────────────────────────────────────────────

test("child brief draft in awaiting_child is auto-approved with source charter and no dialog", async () => {
  const dir = makeWorkDir("child-draft");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "child-draft", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /charter|auto-approved|sha256/i, res);
  const campaigns = listDirs(path.join(dir, ".auto", "research"));
  const childId = campaigns.find((c) => /-c1$/.test(c));
  assert.ok(childId, `child campaign created with a system id: ${campaigns}`);
  const approval = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", childId, "approval.json"), "utf8"));
  assert.equal(approval.source, "charter", "approval provenance recorded");
  assert.match(approval.charter_sha256, /^[0-9a-f]{64}$/, "charter hash recorded");
  assert.equal(chainStatus(dir, "c1-chain"), "active", "the chain returns to active after the child draft");
  const chainLines = fs.readFileSync(path.join(chainDirOf(dir, "c1-chain"), "chain.json"), "utf8").split("\n").filter((l) => l !== "");
  const approved = chainLines.map((l) => JSON.parse(l)).find((e) => e.type === "brief_approved");
  assert.ok(approved, "brief_approved entry in the chain journal");
  assert.ok(approved.snapshot && approved.snapshot.campaign_id === "c1", "parent snapshot recorded");
});

test("child brief without a finding_refs reference is refused and the refusal is journaled", async () => {
  const dir = makeWorkDir("child-refused");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "child-refused", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  const childBrief = briefFixture(); // no finding_refs

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /finding_missing|finding_refs/i, res);
  const chainLines = fs.readFileSync(path.join(chainDirOf(dir, "c1-chain"), "chain.json"), "utf8").split("\n").filter((l) => l !== "");
  const rejected = chainLines.map((l) => JSON.parse(l)).find((e) => e.type === "brief_rejected");
  assert.ok(rejected, "brief_rejected entry with the named reason");
  assert.equal(rejected.reason, "finding_missing");
  // The chain stays in awaiting_child: the agent may fix the brief and retry.
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child");
});

// ─── Non-chain regression ────────────────────────────────────────────────────

test("without a charter every chain action is refused and nothing chain-related is created", async () => {
  const dir = makeWorkDir("no-chain");
  writeStoppedRootCampaign(dir, "c1");
  const h = await loadExtensionBare(dir, "no-chain", true);

  const stop = textOf(await call(h, "research", { action: "chain_stop" }));
  assert.match(stop, /no .*chain|not active/i, stop);
  const rep = textOf(await call(h, "research", { action: "report" }));
  assert.match(rep, /Research mode is OFF/, rep);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-chain")), false);
});

test("orchestrator-fix: the report of a campaign that reached max_campaigns sets limit_reached and turns the mode OFF", async () => {
  const dir = makeWorkDir("report-limit");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { max_campaigns: 1 });
  const h = await loadExtensionBare(dir, "report-limit", true);
  await launchWithCharter(h, charterPath, "c1");
  const before = h.pi.sentMessages.length;

  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /limit_reached/i, res);
  assert.match(res, /Research mode is OFF/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "limit_reached");
  assert.equal(h.pi.sentMessages.length, before, "no continuation prompt after the limit report");
});

test("orchestrator-fix: after limit_reached a chain draft refuses as a final-status action", async () => {
  const dir = makeWorkDir("draft-limit");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { max_campaigns: 1 });
  const h = await loadExtensionBare(dir, "draft-limit", true);
  await launchWithCharter(h, charterPath, "c1");
  // The root report at the max_campaigns=1 boundary sets limit_reached and
  // turns the mode OFF (spec: the prospective predicate is false).
  await call(h, "research", { action: "report" });
  assert.equal(chainStatus(dir, "c1-chain"), "limit_reached");

  const child = briefFixture();
  child.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];
  const res = textOf(await call(h, "research_brief", { action: "draft", brief: child }));
  assert.match(res, /mode is OFF|invalid_transition|limit_reached/i, res);
});

test("orchestrator-fix: the charter predicate is prospective — max_depth 0 stops after the root report", async () => {
  const dir = makeWorkDir("depth-limit");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { max_depth: 0 });
  const h = await loadExtensionBare(dir, "depth-limit", true);
  await launchWithCharter(h, charterPath, "c1");

  const res = textOf(await call(h, "research", { action: "report" }));
  assert.match(res, /limit_reached/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "limit_reached");
});

test("review-B3: --charter without --id starts no chain", async () => {
  const dir = makeWorkDir("no-id");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "no-id", true);
  await launchWithCharter(h, charterPath, null);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research-chain")), false, "no chain journal is created without a pinned root");
  assert.ok(h.pi.notifications.some((n) => /--id/.test(n.text)), "the refusal names --id");
});

test("review-ef7d8951: a charter file changed after confirmation refuses the child draft with charter_changed and sets manual_check_required", async () => {
  const dir = makeWorkDir("charter-changed");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "charter-changed", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child", "precondition: parent reported");
  fs.writeFileSync(charterPath, JSON.stringify({ max_campaigns: 9 }) + "\n", "utf8");
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /charter_changed/, res);
  assert.equal(chainStatus(dir, "c1-chain"), "manual_check_required", "chain status is manual_check_required");
  assert.deepEqual(listDirs(path.join(dir, ".auto", "research")).filter((c) => /-c1$/.test(c)), [], "no child campaign created");
});

test("review-M1 owner decision: a chain report written in phase research does not advance the chain", async () => {
  const dir = makeWorkDir("report-research");
  writeCampaignState(dir, "c1", "research");
  const brief = briefFixture();
  writeBriefAndLog(path.join(dir, ".auto", "research", "c1"), brief, [
    { event: "open", question_id: "Q1" },
  ]);
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "report-research", true);
  await launchWithCharter(h, charterPath, "c1");
  assert.equal(chainStatus(dir, "c1-chain"), "active", "precondition: chain active");

  const before = h.pi.sentMessages.length;
  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /does not advance|phase research/i, res);
  assert.equal(chainStatus(dir, "c1-chain"), "active", "chain stays active, no awaiting_child");
  assert.equal(h.pi.sentMessages.length, before, "no continuation message sent after the report");
});

test("review-M6: resubmitting an already confirmed child brief in active returns the first confirmation, no second campaign", async () => {
  const dir = makeWorkDir("resubmit-active");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "resubmit-active", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];
  await call(h, "research_brief", { action: "draft", brief: childBrief });
  assert.equal(chainStatus(dir, "c1-chain"), "active", "precondition: child confirmed, chain active");
  const before = listDirs(path.join(dir, ".auto", "research"));

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /already approved/i, res);
  assert.doesNotMatch(res, /parent_not_reported/, res);
  assert.deepEqual(listDirs(path.join(dir, ".auto", "research")), before, "no second campaign created");
});

test("review-701ded3d B1: a charter changed after a confirmation refuses even a resubmitted brief with charter_changed", async () => {
  const dir = makeWorkDir("resubmit-tampered");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "resubmit-tampered", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];
  await call(h, "research_brief", { action: "draft", brief: childBrief });
  assert.equal(chainStatus(dir, "c1-chain"), "active", "precondition: child confirmed");
  fs.writeFileSync(charterPath, JSON.stringify({ max_campaigns: 9 }) + "\n", "utf8");

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /charter_changed/, res);
  assert.doesNotMatch(res, /already approved/, res);
  assert.equal(chainStatus(dir, "c1-chain"), "manual_check_required", "chain is manual_check_required");
});


test("review-2.5: without a chain the ordinary brief flow still requires the owner dialog", async () => {
  const dir = makeWorkDir("noch-dialog");
  writeCampaignState(dir, "c1", "briefing");
  const brief = briefFixture();
  const h = await loadExtensionBare(dir, "noch-dialog", true);
  await call(h, "research_brief", { action: "draft", brief });
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "research", "c1", "approval.json")), "draft alone approves nothing");

  // No dialog channel: propose refuses — the owner approves, never the model.
  delete h.ctx.ui.confirm;
  const noUi = textOf(await call(h, "research_brief", { action: "propose" }));
  assert.match(noUi, /owner action|interactive dialog|not_approved/i, noUi);
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "research", "c1", "approval.json")), "no approval without the dialog");

  // The owner confirms in the dialog: the approval has NO charter provenance.
  h.ctx.ui.confirm = async () => true;
  const res = textOf(await call(h, "research_brief", { action: "propose" }));
  assert.match(res, /approved|sha256/i, res);
  const approval = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "approval.json"), "utf8"));
  assert.equal(approval.source, undefined, "the ordinary approval has no charter provenance");
});

test("review-3.4: every final status refuses drafts and reports as final-status actions", async () => {
  const dir = makeWorkDir("finals");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { max_campaigns: 1 });
  const h = await loadExtensionBare(dir, "finals", true);
  await launchWithCharter(h, charterPath, "c1");
  // Two reachable final statuses: limit_reached (report) and stopped_by_owner (dialog).
  await call(h, "research", { action: "report" });
  assert.equal(chainStatus(dir, "c1-chain"), "limit_reached", "precondition");
  const child = briefFixture();
  child.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];
  const draft = textOf(await call(h, "research_brief", { action: "draft", brief: child }));
  assert.match(draft, /mode is OFF|invalid_transition|limit_reached/i, draft);
  // stopped_by_owner from an active campaign keeps the mode ON; the report then exits by the final status.
  const dir2 = makeWorkDir("finals2");
  writeStoppedRootCampaign(dir2, "c1");
  const charter2 = writeCharter(dir2, {});
  const h2 = await loadExtensionBare(dir2, "finals2", true);
  await launchWithCharter(h2, charter2, "c1");
  await call(h2, "research", { action: "chain_stop" });
  assert.equal(chainStatus(dir2, "c1-chain"), "stopped_by_owner", "precondition");
  const res = textOf(await call(h2, "research", { action: "report" }));
  assert.match(res, /Research mode is OFF/i, res);
  assert.match(res, /stopped_by_owner/i, res);
});

test("review-4.1: the idle mechanism does not send chain continuations without a new agent action", async () => {
  const dir = makeWorkDir("idle-nocont");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "idle-nocont", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child", "precondition: paused");
  const before = h.pi.sentMessages.length;

  // An idle turn (agent_end, no experiment tools) must not produce a SECOND
  // chain continuation; at most the ordinary research drift nudge fires.
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1200)); // SETTLED_WINDOW_MS = 800

  const chainContinuations = h.pi.sentMessages.slice(before).filter((m) => /chain can continue|research chain/i.test(m.text));
  assert.equal(chainContinuations.length, 0, `no idle chain continuation; got: ${chainContinuations.map((m) => m.text.slice(0, 80)).join(" | ")}`);
});

test("review-4.3: the final report of the active campaign of a chain stopped during work turns the mode OFF", async () => {
  const dir = makeWorkDir("stopped-work");
  writeCampaignState(dir, "c1", "research");
  const brief = briefFixture();
  writeBriefAndLog(path.join(dir, ".auto", "research", "c1"), brief, [
    { event: "open", question_id: "Q1" },
  ]);
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "stopped-work", true);
  await launchWithCharter(h, charterPath, "c1");
  // The owner stops the chain while the campaign is still in phase research.
  await call(h, "research", { action: "chain_stop" });
  assert.equal(chainStatus(dir, "c1-chain"), "stopped_by_owner", "precondition: stopped during work");

  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /Research mode is OFF/i, res);
  assert.match(res, /stopped_by_owner/i, res);
});

test("review-nit: a charter file that is not valid JSON is refused with a notify, nothing started", async () => {
  const dir = makeWorkDir("charter-badjson");
  writeStoppedRootCampaign(dir, "c1");
  const badPath = path.join(dir, "..", `charter-bad-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(badPath, "{broken json", "utf8");
  const h = await loadExtensionBare(dir, "charter-badjson", true);

  await launchWithCharter(h, badPath, "c1");

  assert.equal(fs.existsSync(chainDirOf(dir, "c1-chain")), false, "no chain state created");
  assert.ok(h.pi.notifications.some((n) => /not valid JSON/i.test(n.text)), "the refusal names the JSON problem");
  fs.rmSync(badPath, { force: true });
});
test("review-3.7 full flow: campaign stop-rule -> report -> next brief is a new consent phase with no dialog", async () => {
  const dir = makeWorkDir("new-phase");
  writeStoppedRootCampaign(dir, "c1"); // stopped by its OWN campaign stop rule (stop event in the log)
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "new-phase", true);
  await launchWithCharter(h, charterPath, "c1");
  const beforeDialogs = h.pi.notifications.length;

  // 1) The report of the stopped campaign advances the chain (owner decision:
  //    phase must be stopped; the campaign stop-rule produced that phase).
  const rep = textOf(await call(h, "research", { action: "report" }));
  assert.match(rep, /awaiting/i, rep);
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child");

  // 2) The next brief is auto-approved WITHOUT any owner dialog (new consent
  //    phase exception of the delta), while the ordinary flow needs one (2.5).
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];
  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));
  assert.match(res, /auto-approved/i, res);
  assert.equal(h.pi.notifications.slice(beforeDialogs).some((n) => /Brief SHA-256/i.test(n.text)), false, "no owner dialog in the chain child phase");
  assert.equal(chainStatus(dir, "c1-chain"), "active", "the chain returned to active");
});

test("review-M3: a damaged chain journal records manual_check_required durably (marker) and refuses later actions", async () => {
  const dir = makeWorkDir("journal-damaged");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "journal-damaged", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  fs.appendFileSync(path.join(chainDirOf(dir, "c1-chain"), "chain.json"), "{broken\n", "utf8");
  const childBrief = briefFixture();
  childBrief.questions[0].finding_refs = [{ campaign: "c1", question: "Q1" }];

  const res = textOf(await call(h, "research_brief", { action: "draft", brief: childBrief }));

  assert.match(res, /manual_check_required/, res);
  assert.ok(fs.existsSync(path.join(chainDirOf(dir, "c1-chain"), "manual-check")), "durable manual-check marker written");
  const later = textOf(await call(h, "research", { action: "chain_stop" }));
  assert.match(later, /manual_check_required|manual check/i, later);
});

test("review-4.7: git in a chain campaign is blocked by the research-vectors rule", async () => {
  const dir = makeWorkDir("git-chain");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, {});
  const h = await loadExtensionBare(dir, "git-chain", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  const hook = h.hook("tool_call");
  for (const command of ["git status", "git commit -m x", "echo ok && git add -A"]) {
    const result = await hook({ toolName: "bash", input: { command } }, h.ctx);
    assert.equal(result?.block, true, `${command} must be blocked in a chain campaign`);
  }
});

test("review-3.7: charter stop rule from awaiting_child stops the chain and turns the mode OFF at once", async () => {
  const dir = makeWorkDir("stop-rule-pause");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { stop_rules: ["two rejected findings in a row"] });
  const h = await loadExtensionBare(dir, "stop-rule-pause", true);
  await launchWithCharter(h, charterPath, "c1");
  await call(h, "research", { action: "report" });
  assert.equal(chainStatus(dir, "c1-chain"), "awaiting_child", "precondition: paused in awaiting_child");

  const res = textOf(await call(h, "research", { action: "chain_stop", rule_id: "two rejected findings in a row" }));

  assert.equal(chainStatus(dir, "c1-chain"), "stopped_by_rule", res);
  assert.equal(h.pi.notifications.some((n) => /mode OFF/i.test(n.text)), true, "mode OFF announced immediately from the pause");
});

test("review-B2: a failed limit_reached write keeps the mode ON (M4/N2 invariant)", async () => {
  const dir = makeWorkDir("limit-write-fail");
  writeStoppedRootCampaign(dir, "c1");
  const charterPath = writeCharter(dir, { max_campaigns: 1 });
  const h = await loadExtensionBare(dir, "limit-write-fail", true);
  await launchWithCharter(h, charterPath, "c1");
  // Plant a stale chain lock AFTER launch: verify/statusOf read without the
  // lock (the report path passes its checks), but setChainStatus ->
  // appendEntry -> acquireChainLock refuses lock_busy, so the status write
  // fails while everything else is healthy — exactly the swallowed write.
  const chainDirHere = chainDirOf(dir, "c1-chain");
  fs.writeFileSync(path.join(chainDirHere, "lock"), '{"token":"stale","pid":0}');

  const res = textOf(await call(h, "research", { action: "report" }));

  assert.match(res, /limit_reached could not be recorded/i, res);
  assert.match(res, /mode stays ON/i, res);
  // Mode must still be ON: the gated research tools keep working (not the
  // mode-OFF refusal).
  const status = textOf(await call(h, "research", { action: "status" }));
  assert.doesNotMatch(status, /Autoresearch mode is OFF/);
  // Repair the journal (drop the stale lock): the SAME report action now
  // succeeds and exits the mode — no permanent lock-out.
  fs.rmSync(path.join(chainDirHere, "lock"));
  const res2 = textOf(await call(h, "research", { action: "report" }));
  assert.match(res2, /Research mode is OFF/i, res2);
  assert.equal(chainStatus(dir, "c1-chain"), "limit_reached");
});
