/**
 * bd tj0.3 — one ordered research policy for scanner, launch, blocking,
 * archiving and loop exit. Table-driven: four policy rows x six campaign
 * states, then the two fail-open exits (report/finalize) that used to turn
 * research mode OFF even when a stopped campaign could not be archived.
 *
 * Run: timeout 240 node --experimental-strip-types --env-file=./tests/test.env --experimental-loader ./tests/redirect-loader.mjs --test tests/research-policy-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import {
  STATE_FILE,
  inspectCampaign,
  inspectionPolicyInput,
  researchPolicyRefusal,
  researchRoot,
} from "../extensions/pi-autoresearch/research-state.ts";
import {
  archiveFinishedCampaignsForTest,
  archiveOutcomeForTest,
  blockingCampaignIdsForTest,
} from "../extensions/pi-autoresearch/index.ts";

const ROWS = ["ordinaryLoop", "halt", "git", "launch"];
const ID = "camp";
const BLOCK_TEXT = "Research campaign active; use research_questions(action=status) or the operator resolve; the ordinary loop is blocked";

/** reason === null means the row does not block; the token is the typed reason. */
const MATRIX = [
  { kind: "briefing", reason: { ordinaryLoop: null, halt: null, git: null, launch: "briefing" } },
  { kind: "research", reason: { ordinaryLoop: "research", halt: null, git: "research", launch: "research" } },
  { kind: "stopped", reason: { ordinaryLoop: "stopped", halt: "stopped", git: null, launch: null } },
  { kind: "pending_op", reason: { ordinaryLoop: "pending_op", halt: "pending_op", git: "pending_op", launch: "pending_op" } },
  { kind: "unreadable", reason: { ordinaryLoop: "unreadable", halt: "unreadable", git: "unreadable", launch: "unreadable" } },
  { kind: "invalid", reason: { ordinaryLoop: "unreadable", halt: "unreadable", git: "unreadable", launch: "unreadable" } },
];

function workDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-ar-policy-${label}-`));
}

function writeCampaign(base, kind, id = ID) {
  const dir = path.join(researchRoot(base), id);
  fs.mkdirSync(dir, { recursive: true });
  const phase = kind === "briefing" || kind === "research" ? kind : "stopped";
  const state = { schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase };
  if (kind === "invalid") state.extra_field = "readState refuses this, so the scanner must too";
  fs.writeFileSync(
    path.join(dir, STATE_FILE),
    kind === "unreadable" ? "{not json" : JSON.stringify(state, null, 2) + "\n",
  );
  if (kind === "pending_op") {
    fs.writeFileSync(path.join(dir, "pending-op.json"), JSON.stringify({ name: "interrupted", started_at: new Date().toISOString() }));
  }
  return dir;
}

async function load(dir, label, args = null) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `policy-${label}`, realGit: false });
  const ctx = makeCtx(dir, `policy-${label}`, pi);
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  if (args !== null) await command("autoresearch").handler(args, ctx);
  return { pi, tool, command, hook, ctx, dir };
}

const call = (h, name, params) => h.tool(name).execute("policy-call", params, null, null, h.ctx);
const textOf = (r) => r?.content?.[0]?.text ?? "";
const archivedNames = (dir) => {
  const root = path.join(dir, ".auto", "research-archive");
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
};

test("scanner + typed policy reason: 4 rows x 6 campaign states", async () => {
  for (const row of MATRIX) {
    const base = workDir(`scan-${row.kind}`);
    const dir = writeCampaign(base, row.kind);
    const { scanCampaignsSync } = await import("../extensions/pi-autoresearch/research-state.ts");
    const scan = scanCampaignsSync(base);
    assert.equal(scan.ok, true);
    assert.equal(scan.campaigns.length, 1, row.kind);
    const campaign = scan.campaigns[0];
    assert.equal(campaign.pendingOp, row.kind === "pending_op", `${row.kind}: pending flag`);
    assert.equal(campaign.state !== null, !["unreadable", "invalid"].includes(row.kind),
      `${row.kind}: scanner and readState must agree on validity`);
    for (const policyRow of ROWS) {
      assert.equal(researchPolicyRefusal(campaign, policyRow), row.reason[policyRow],
        `${row.kind}/${policyRow}: typed reason`);
      assert.equal(researchPolicyRefusal(campaign, policyRow) !== null,
        (await import("../extensions/pi-autoresearch/research-state.ts")).researchPolicyBlocks(campaign, policyRow),
        `${row.kind}/${policyRow}: reason and boolean agree`);
    }
    if (["unreadable", "invalid"].includes(row.kind)) {
      assert.equal(fs.readFileSync(path.join(dir, STATE_FILE), "utf8").includes("extra_field"), row.kind === "invalid");
    }
  }
});

test("blocking ids: only a READY stopped campaign counts as finished", async () => {
  for (const row of MATRIX) {
    const base = workDir(`blocking-${row.kind}`);
    writeCampaign(base, row.kind);
    const h = await load(base, `blocking-${row.kind}`);
    const ids = await blockingCampaignIdsForTest([base], h.pi);
    assert.deepEqual(ids, row.kind === "stopped" ? [] : [ID], `${row.kind}: blocking ids`);

    const insp = await inspectCampaign(path.join(researchRoot(base), ID));
    const reason = researchPolicyRefusal(inspectionPolicyInput(insp), "launch");
    assert.equal(reason, row.reason.launch, `${row.kind}: inspection uses the same ordered vocabulary`);
    if (row.kind !== "stopped") assert.equal(insp.status === "ready" && !insp.pendingOp && insp.state?.phase === "stopped", false);
  }
});

test("archive: only a readable, pending-free stopped campaign is moved", async () => {
  for (const row of MATRIX) {
    const base = workDir(`archive-${row.kind}`);
    const dir = writeCampaign(base, row.kind);
    const h = await load(base, `archive-${row.kind}`);
    const archived = await archiveFinishedCampaignsForTest(base, base, undefined, undefined, h.pi);
    if (row.kind === "stopped") {
      assert.equal(archived?.length, 1, `${row.kind}: archived`);
      assert.ok(archivedNames(base).some((n) => n.startsWith(`${ID}-`)));
      assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), false, "campaign left the research root");
    } else {
      assert.equal(archived, null, `${row.kind}: archive refuses`);
      assert.deepEqual(archivedNames(base), [], `${row.kind}: nothing moved`);
      assert.equal(fs.existsSync(path.join(dir, STATE_FILE)), true, `${row.kind}: campaign stays in place`);
    }
  }
});

test("ordinary loop, git and expedition launch: 4 rows x 6 campaign states", async () => {
  for (const row of MATRIX) {
    const base = workDir(`wiring-${row.kind}`);
    writeCampaign(base, row.kind);

    const active = await load(base, `active-${row.kind}`, "on");
    const loopText = textOf(await call(active, "init_experiment", {}));
    assert.equal(loopText.includes(BLOCK_TEXT), row.reason.ordinaryLoop !== null, `${row.kind}: ordinary loop`);
    const gitResult = await active.hook("tool_call")({ toolName: "bash", input: { command: "git status" } }, active.ctx);
    assert.equal(gitResult?.block === true, row.reason.git !== null, `${row.kind}: git ban`);

    const launch = await load(base, `launch-${row.kind}`);
    await launch.command("autoresearch").handler("expedition x", launch.ctx);
    const refused = launch.pi.notifications.some((n) => /Cannot launch expedition/.test(n.text));
    assert.equal(refused, row.reason.launch !== null, `${row.kind}: expedition launch`);
    if (row.reason.launch !== null) assert.equal(launch.pi.sentMessages.length, 0, `${row.kind}: no kickoff after refusal`);
  }
});

test("explicit --id launch: ordered refusal, but a pending active campaign stays resumable", async () => {
  const pendingActive = workDir("explicit-pending-active");
  writeCampaign(pendingActive, "pending_op");
  const statePath = path.join(researchRoot(pendingActive), ID, STATE_FILE);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.phase = "briefing";
  fs.writeFileSync(statePath, JSON.stringify(state));
  const resumable = await load(pendingActive, "explicit-pending-active", `research --id ${ID}`);
  assert.match(textOf(await call(resumable, "research", { action: "status" })), /manual_check_required/,
    "explicit --id keeps the mode ON so the operator can resolve a stranded active campaign");

  const pendingStopped = workDir("explicit-pending-stopped");
  writeCampaign(pendingStopped, "pending_op");
  const stopped = await load(pendingStopped, "explicit-pending-stopped", `research --id ${ID}`);
  assert.ok(stopped.pi.notifications.some((n) => /interrupted operation|manual check required/i.test(n.text)),
    `a stranded stopped campaign is refused with the pending reason: ${JSON.stringify(stopped.pi.notifications.map((n) => n.text))}`);
  assert.match(textOf(await call(stopped, "research", { action: "status" })), /Autoresearch mode is OFF/);

  const unreadable = workDir("explicit-unreadable");
  writeCampaign(unreadable, "unreadable");
  const broken = await load(unreadable, "explicit-unreadable", `research --id ${ID}`);
  assert.ok(broken.pi.notifications.some((n) => /unreadable/i.test(n.text)));
});

function briefFixture() {
  return {
    schema_version: 1,
    goal: "Study the cache effect.",
    plan_source: "docs/plan.md",
    caveat_block: "Observational results only.",
    data_roles: { explore: ["a"], validate: ["b"], confirm: [] },
    questions: [{
      id: "Q1",
      text: "Does the cache matter?",
      decision_rules: [
        { id: "yes", verdict: "confirmed", when: "measured improvement" },
        { id: "no", verdict: "rejected", when: "no improvement" },
        { id: "unknown", verdict: "inconclusive", when: "unclear" },
        { id: "wait", verdict: "waiting_for_data", when: "data missing" },
      ],
      needs_data: null,
    }],
    process_metrics: [],
    stop_rules: [{ id: "S1", when: "work finished" }],
  };
}

function writePendingBlocker(base, id) {
  const dir = path.join(researchRoot(base), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({
    schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase: "stopped",
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "pending-op.json"), JSON.stringify({ name: "interrupted", started_at: new Date().toISOString() }));
}

async function draftApproveStartStop(h, id) {
  assert.match(textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() })), /Brief draft saved/);
  h.ctx.ui.confirm = async () => true;
  assert.match(textOf(await call(h, "research_brief", { action: "propose" })), /Brief approved/);
  const sha = createHash("sha256").update(fs.readFileSync(path.join(h.dir, ".auto", "research", id, "brief.json"))).digest("hex");
  await call(h, "research", { action: "start", expected_sha256: sha });
  assert.match(textOf(await call(h, "research", { action: "stop", rule_id: "S1", reason: "done" })), /Research stopped/);
}

test("report with an unarchivable campaign keeps research mode ON", { timeout: 60000 }, async () => {
  const dir = workDir("report-archive-null");
  const h = await load(dir, "report-archive-null", "research --id c1");
  await draftApproveStartStop(h, "c1");
  writePendingBlocker(dir, "blocker");

  const out = textOf(await call(h, "research", { action: "report" }));
  assert.match(out, /Manual check/i, out);
  assert.match(out, /stays ON/i, out);
  assert.equal(h.pi.notifications.some((n) => /research mode OFF/i.test(n.text)), false, "no OFF notice on archive refusal");
  assert.equal(fs.existsSync(path.join(researchRoot(dir), "c1", "state.json")), true, "blocked campaign is not archived");
  assert.deepEqual(archivedNames(dir), []);
});

test("report: a benign campaign sorting before a stopped pending campaign cannot mask the blocker", { timeout: 60000 }, async () => {
  const dir = workDir("report-mixed-archive");
  const h = await load(dir, "report-mixed-archive", "research --id c1");
  await draftApproveStartStop(h, "c1");
  // listResearchCampaignIds sorts by id, so aaa-briefing is inspected first.
  writeCampaign(dir, "briefing", "aaa-briefing");
  writeCampaign(dir, "pending_op", "zzz-stopped");

  const outcome = await archiveOutcomeForTest(dir, dir, h.ctx, { includeChainCampaigns: true }, h.pi);
  assert.deepEqual(outcome, { ok: false, reason: "pending_op" }, `mixed archive reason: ${JSON.stringify(outcome)}`);

  const out = textOf(await call(h, "research", { action: "report" }));
  assert.match(out, /Manual check required/i, out);
  assert.match(out, /\(pending_op\)/, out);
  assert.match(out, /stays ON/i, out);
  assert.equal(h.pi.notifications.some((n) => /research mode OFF/i.test(n.text)), false, "no OFF notice when a blocking campaign is masked by a benign one");
  assert.equal(fs.existsSync(path.join(researchRoot(dir), "c1", "state.json")), true, "no campaign is archived while a blocker exists");
  assert.deepEqual(archivedNames(dir), []);
});

test("report with nothing blocking still archives and exits", { timeout: 60000 }, async () => {
  const dir = workDir("report-archive-ok");
  const h = await load(dir, "report-archive-ok", "research --id c1");
  await draftApproveStartStop(h, "c1");

  const out = textOf(await call(h, "research", { action: "report" }));
  assert.match(out, /Research mode is OFF\./, out);
  assert.ok(h.pi.notifications.some((n) => /research mode OFF/i.test(n.text)));
  assert.ok(archivedNames(dir).some((n) => n.startsWith("c1-")), "finished campaign archived before the exit");
});

const EXPEDITION_DOC = {
  charter: { stop_rules: ["territory_complete"] },
  goal: "Study the cache effect.",
  directions: [{ name: "cache", why: "Measure cache effects" }],
  campaign0: briefFixture(),
};

async function makeExpedition(h) {
  await h.command("autoresearch").handler("expedition goal", h.ctx);
  await call(h, "expedition_brief", { action: "draft", doc: EXPEDITION_DOC });
  const proposed = textOf(await call(h, "expedition_brief", { action: "propose" }));
  const id = proposed.match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(id, proposed);
  return id;
}

test("finalize with an unarchivable campaign keeps research mode ON", { timeout: 60000 }, async () => {
  const dir = workDir("finalize-archive-null");
  const { pi, tool, command } = createFakePi({ dir, sessionId: "policy-finalize", realGit: false });
  const ctx = makeCtx(dir, "policy-finalize", pi);
  ctx.ui.confirm = async () => true;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  const h = { pi, tool, command, ctx, dir };
  const id = await makeExpedition(h);
  const sha = createHash("sha256").update(fs.readFileSync(path.join(researchRoot(dir), id, "brief.json"))).digest("hex");
  await call(h, "research_questions", { action: "start", expected_sha256: sha });
  await call(h, "research_questions", { action: "stop", rule_id: "S1", reason: "done" });
  assert.match(textOf(await call(h, "research_questions", { action: "report" })), /awaiting_child|awaiting the brief/);

  writePendingBlocker(dir, "blocker");
  const out = textOf(await call(h, "finalize_research", { reason: "done" }));
  assert.match(out, /Manual check/i, out);
  assert.match(out, /stays ON/i, out);
  assert.equal(pi.notifications.some((n) => /research mode OFF/i.test(n.text)), false, "no OFF notice on archive refusal");
  assert.equal(fs.existsSync(path.join(researchRoot(dir), id, "state.json")), true, "chain campaign stays when archive refuses");
});
