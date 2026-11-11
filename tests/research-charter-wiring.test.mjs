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
  const { pi, tool, command } = createFakePi({ dir, sessionId: `charter-w-${label}`, realGit: false });
  const ctx = makeCtx(dir, `charter-w-${label}`, pi);
  if (confirmReply !== undefined) ctx.ui.confirm = async () => confirmReply;
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, tool, command, ctx, dir };
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
