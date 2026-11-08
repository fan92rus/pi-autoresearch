/**
 * --state-root decoupling (bd pi-autoresearch-7ii): the research campaign
 * state may live under a custom base inside the work directory (project
 * layouts that only allow writes into runs/<id>/), while evidence still
 * resolves from the project root. Drives the REAL extension through the fake
 * pi harness.
 *
 * Run: timeout 120 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-state-root.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-sr-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rulesFor(qid) {
  return [
    { id: `${qid}-yes`, verdict: "confirmed", when: "effect is present in validate data" },
    { id: `${qid}-no`, verdict: "rejected", when: "effect is absent in validate data" },
    { id: `${qid}-unknown`, verdict: "inconclusive", when: "data are too noisy to decide" },
    { id: `${qid}-wait`, verdict: "waiting_for_data", when: "validate data are missing" },
  ];
}

function briefFixture(overrides = {}) {
  const base = {
    schema_version: 1,
    goal: "Check whether the cache layer explains the latency drop.",
    plan_source: "docs/plan.md",
    caveat_block: "Results are observational; no causal claim is made beyond the listed data.",
    data_roles: { explore: ["logs/2024-01.txt"], validate: ["logs/2024-02.txt"], confirm: [] },
    questions: [
      { id: "Q1", text: "Does the cache hit rate rise after the change?", decision_rules: rulesFor("Q1"), needs_data: null },
    ],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
  return { ...base, ...overrides };
}

function writeCampaignState(base, id, phase) {
  const campaignDir = path.join(base, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
}

async function loadExtension(dir, label) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `sr-${label}`, realGit: false });
  const ctx = makeCtx(dir, `sr-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  const run = (args) => command("autoresearch").handler(args, ctx);
  return { pi, tool, command, hook, ctx, dir, run };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

const ACTIVATION_ENTRY_TYPE = "pi-autoresearch.activation";
function activationCount(pi) {
  return pi.entries.filter((e) => e === ACTIVATION_ENTRY_TYPE).length;
}

// ─── parsing and validation ──────────────────────────────────────────────────

test("'--state-root <path>' after --id pins the state root and is accepted", async () => {
  const dir = makeWorkDir("pin");
  const h = await loadExtension(dir, "pin");
  await h.run("research --id c1 --state-root runs/c1 investigate the incident");

  assert.equal(activationCount(h.pi), 1, "activation recorded once");
  assert.ok(h.pi.sentMessages.length === 1, "kickoff sent");
  assert.match(h.pi.sentMessages[0].text, /investigate the incident/, "description tail preserved");
  // Nothing is created on disk by the command itself; draft creates the campaign.
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research")), false, "default root untouched");
  assert.equal(fs.existsSync(path.join(dir, "runs", "c1")), false, "state root untouched until draft");
});

test("'--state-root' outside the work directory refuses before any activation", async () => {
  const dir = makeWorkDir("outside");
  const h = await loadExtension(dir, "outside");
  await h.run("research --id c1 --state-root ../evil");

  assert.equal(activationCount(h.pi), 0, "refusal must not record activation");
  assert.equal(h.pi.sentMessages.length, 0, "no kickoff on refusal");
  assert.ok(h.pi.notifications.some((n) => n.text.includes("--state-root") && n.type === "error"), "error notify names --state-root");
  assert.equal(fs.existsSync(path.join(dir, ".auto")), false, "nothing written");
});

test("'--state-root' with an absolute path outside the work directory refuses", async () => {
  const dir = makeWorkDir("abs-out");
  const h = await loadExtension(dir, "abs-out");
  await h.run(`research --id c1 --state-root ${path.join(os.tmpdir(), "elsewhere")}`);
  assert.equal(activationCount(h.pi), 0, "no activation on absolute outside refusal");
});

test("an absolute --state-root INSIDE the work directory is accepted", async () => {
  const dir = makeWorkDir("abs-in");
  const h = await loadExtension(dir, "abs-in");
  const abs = path.join(dir, "runs", "c1");
  await h.run(`research --id c1 --state-root ${abs}`);
  assert.equal(activationCount(h.pi), 1, "absolute inside is fine");
});

// ─── campaign state placement ────────────────────────────────────────────────

test("draft creates the campaign under the state root, never under the default root", async () => {
  const dir = makeWorkDir("place");
  const h = await loadExtension(dir, "place");
  await h.run("research --id c1 --state-root runs/c1");
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  const campaignDir = path.join(dir, "runs", "c1", ".auto", "research", "c1");
  assert.ok(fs.existsSync(path.join(campaignDir, "state.json")), "state.json under the state root");
  assert.ok(fs.existsSync(path.join(campaignDir, "brief.json")), "brief.json under the state root");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research")), false, "default root stays empty");
});

test("evidence still resolves from the project root with a pinned state root (lob layout)", async () => {
  const dir = makeWorkDir("evidence");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "logs", "2024-02.txt"), "line1\nhit rate 0.62\nline3\n");
  const h = await loadExtension(dir, "evidence");
  await h.run("research --id c1 --state-root runs/c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  const briefSha = sha256Of(fs.readFileSync(path.join(dir, "runs", "c1", ".auto", "research", "c1", "brief.json")));
  const started = await call(h, "research", { action: "start", expected_sha256: briefSha });
  assert.match(textOf(started), /Research phase started/, textOf(started));
  const opened = await call(h, "research", { action: "open", question_id: "Q1" });
  assert.match(textOf(opened), /Vector Q1 opened/, textOf(opened));
  const recorded = await call(h, "research", { action: "record", evidence_ref: "logs/2024-02.txt:2" });
  assert.match(textOf(recorded), /Evidence recorded/, textOf(recorded));
  const logText = fs.readFileSync(path.join(dir, "runs", "c1", ".auto", "research", "c1", "log.jsonl"), "utf8");
  const rec = logText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((e) => e.event === "record");
  assert.equal(rec.evidence_path, path.join("logs", "2024-02.txt"), "evidence path is project-root relative");
});

// ─── resume and discovery ────────────────────────────────────────────────────

test("resume with --id and --state-root finds the campaign under the state root", async () => {
  const dir = makeWorkDir("resume");
  const campaignDir = writeCampaignState(path.join(dir, "runs", "c1"), "c1", "briefing");
  fs.writeFileSync(path.join(campaignDir, "brief.json"), JSON.stringify(briefFixture(), null, 2) + "\n");
  const h = await loadExtension(dir, "resume");
  await h.run("research --id c1 --state-root runs/c1");
  assert.equal(h.pi.sentMessages.length, 1, "resume kickoff sent");
  assert.match(h.pi.sentMessages[0].text, /already has a brief draft/, "phase-aware resume kickoff");
});

test("resume by --id without --state-root still finds default-root campaigns (unchanged)", async () => {
  const dir = makeWorkDir("resume-default");
  writeCampaignState(dir, "c1", "briefing");
  const h = await loadExtension(dir, "resume-default");
  await h.run("research --id c1");
  assert.equal(h.pi.sentMessages.length, 1, "resume kickoff sent");
  assert.match(h.pi.sentMessages[0].text, /already has a brief draft/, "default resume still works");
});

test("bare research with a state-root campaign visible only via the pin: no pin means default-root scan only", async () => {
  // Cross-session invisibility is the documented limitation: a fresh session
  // without --state-root sees no campaign in the default root, so bare
  // research starts a new campaign (it must not resume or crash).
  const dir = makeWorkDir("cross-session");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "cross-session");
  await h.run("research");
  assert.equal(h.pi.sentMessages.length, 1, "bare research on a default-empty dir starts a new campaign");
  assert.match(h.pi.sentMessages[0].text, /Research campaign: briefing phase/, "fresh briefing kickoff");
});

test("launch guard refuses when campaigns exist in either root (union check)", async () => {
  const dir = makeWorkDir("union");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "briefing");
  const h = await loadExtension(dir, "union");
  // No --id: with a state-root campaign on disk the launch must refuse and hint.
  await h.run("research --state-root runs/c1");
  assert.equal(activationCount(h.pi), 0, "refused launch records no activation");
  assert.ok(h.pi.notifications.some((n) => n.text.includes("resume")), "refusal hints at resume");
});

test("session-aware guards: a state-root campaign in research phase blocks the ordinary loop in the same session", async () => {
  const dir = makeWorkDir("guards");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "guards");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.notifications.length = 0;

  const LEGACY_GUIDELINE_LINE =
    "- log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.";
  const out = await h.hook("before_agent_start")({ systemPrompt: `BASE\n${LEGACY_GUIDELINE_LINE}` }, h.ctx);
  const prompt = out.systemPrompt;
  assert.match(prompt, /## Research Campaign \(ACTIVE\)/, "research rules injected in-session");
  assert.equal(prompt.includes(LEGACY_GUIDELINE_LINE), false, "legacy guideline dropped");

  const init = await call(h, "init_experiment", { name: "x", metric_name: "m" });
  assert.match(textOf(init), /blocked/i, "ordinary loop tool blocked in-session");
});

test("clear refuses while a pinned state-root campaign exists in the same session", async () => {
  const dir = makeWorkDir("clear-guard");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "clear-guard");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.notifications.length = 0;
  await h.run("clear");
  assert.ok(h.pi.notifications.some((n) => n.text.includes("Research campaign active")), "clear refuses under the pinned campaign");
  assert.ok(fs.existsSync(path.join(dir, "runs", "c1", ".auto", "research", "c1", "state.json")), "campaign untouched");
});

test("'off' clears the state-root pin", async () => {
  const dir = makeWorkDir("off-pin");
  const h = await loadExtension(dir, "off-pin");
  await h.run("research --id c1 --state-root runs/c1");
  await h.run("off");
  // After off, a fresh draft in a NEW session would target the default root;
  // here we assert via a second research launch that no union refusal fires
  // from a stale pin (the pin died with off).
  await h.run("research --id c2");
  assert.equal(activationCount(h.pi) >= 2, true, "mode re-activated");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research", "c2", "state.json")), "c2 created under the DEFAULT root after the pin was cleared");
});

// ─── default behavior is byte-identical ──────────────────────────────────────

test("without --state-root everything stays in the default root (unchanged)", async () => {
  const dir = makeWorkDir("default");
  const h = await loadExtension(dir, "default");
  await h.run("research --id c1");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.ok(fs.existsSync(path.join(dir, ".auto", "research", "c1", "brief.json")), "default placement unchanged");
});

// ─── same-session pin guards (review B1/B1b/B2) ─────────────────────────────

test("B1: bare research relaunch is refused while a pinned research-phase state-root campaign is active", async () => {
  const dir = makeWorkDir("b1-bare");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "b1-bare");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.notifications.length = 0;
  h.pi.sentMessages.length = 0;

  await h.run("research investigate something else");
  assert.equal(activationCount(h.pi), 1, "refused bare relaunch records no new activation");
  assert.equal(h.pi.sentMessages.length, 0, "no second kickoff");
  assert.ok(h.pi.notifications.some((n) => n.text.includes("c1") && /resume/i.test(n.text)), "refusal names the pinned campaign and hints resume");

  // The ordinary loop must STILL be blocked after the refused relaunch.
  const init = await call(h, "init_experiment", { name: "x", metric_name: "m" });
  assert.match(textOf(init), /blocked/i, "init_experiment stays blocked after the refusal");
});

test("B1b: --id relaunch with a DIFFERENT id is refused while the pin is live", async () => {
  const dir = makeWorkDir("b1b-diff");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "b1b-diff");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.notifications.length = 0;
  h.pi.sentMessages.length = 0;

  await h.run("research --id c2");
  assert.equal(activationCount(h.pi), 1, "no activation for the refused --id c2");
  assert.equal(h.pi.sentMessages.length, 0, "no kickoff");
  assert.ok(h.pi.notifications.some((n) => /pin is not replaced/i.test(n.text)), "refusal explains the pin is kept");

  const init = await call(h, "init_experiment", { name: "x", metric_name: "m" });
  assert.match(textOf(init), /blocked/i, "init_experiment stays blocked — pin c1 survives");
  assert.ok(fs.existsSync(path.join(dir, "runs", "c1", ".auto", "research", "c1", "state.json")), "c1 untouched");
});

test("B1b: resuming the SAME id with the SAME --state-root is allowed (no false refusal)", async () => {
  const dir = makeWorkDir("b1b-same");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "b1b-same");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.notifications.length = 0;
  h.pi.sentMessages.length = 0;
  await h.run("research --id c1 --state-root runs/c1");
  assert.equal(h.pi.sentMessages.length, 1, "same-id same-root resume proceeds");
  assert.match(h.pi.sentMessages[0].text, /research phase/, "phase-aware resume kickoff");
});

test("B2: a pinned state-root campaign with a pending-op marker never auto-resumes (agent_end steer suppressed)", async () => {
  const dir = makeWorkDir("b2-steer");
  const campaignDir = writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  fs.writeFileSync(
    path.join(campaignDir, "pending-op.json"),
    JSON.stringify({ name: "interrupted record", started_at: "2026-11-08T00:00:00Z" }),
  );
  const h = await loadExtension(dir, "b2-steer");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.sentMessages.length = 0;
  await h.hook("agent_start")({ messages: [] }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1100)); // SETTLED_WINDOW_MS = 800
  assert.equal(h.pi.sentMessages.length, 0, `pending-op campaign must not auto-resume: ${JSON.stringify(h.pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("B2 contrast: a pinned CLEAN research-phase state-root campaign resumes with research wording (not legacy)", async () => {
  const dir = makeWorkDir("b2-clean");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "b2-clean");
  await h.run("research --id c1 --state-root runs/c1");
  h.pi.sentMessages.length = 0;
  await h.hook("agent_start")({ messages: [] }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const research = h.pi.sentMessages.filter((m) => /Continue the research campaign/.test(m.text));
  assert.equal(research.length, 1, `state-root campaign resumes with research wording: ${JSON.stringify(h.pi.sentMessages.map((m) => m.text))}`);
  const legacy = h.pi.sentMessages.filter((m) => /run_experiment/.test(m.text));
  assert.equal(legacy.length, 0, "no legacy wording under a state-root campaign");
}, { timeout: 30000 });

test("M1: a quoted --state-root value is refused before any activation", async () => {
  const dir = makeWorkDir("m1-quoted");
  const h = await loadExtension(dir, "m1-quoted");
  await h.run('research --id c1 --state-root "my runs/c1" investigate');
  assert.equal(activationCount(h.pi), 0, "quoted refusal records no activation");
  assert.equal(h.pi.sentMessages.length, 0, "no kickoff");
  assert.ok(h.pi.notifications.some((n) => /quoted/i.test(n.text)), "error names the quoting problem");
});

test("off drops the pin: a later bare launch no longer sees the state-root campaign (strengthened)", async () => {
  const dir = makeWorkDir("off-strength");
  writeCampaignState(path.join(dir, "runs", "c1"), "c1", "research");
  const h = await loadExtension(dir, "off-strength");
  await h.run("research --id c1 --state-root runs/c1");
  // Ordinary loop blocked while pinned.
  const initWhilePinned = await call(h, "init_experiment", { name: "x", metric_name: "m" });
  assert.match(textOf(initWhilePinned), /blocked/i);
  await h.run("off");
  h.pi.notifications.length = 0;
  // After off the pin is gone: the (cross-session invisible) state-root
  // campaign no longer blocks, and a bare research launch starts fresh
  // instead of refusing via the pin.
  const initAfter = await call(h, "init_experiment", { name: "x", metric_name: "m" });
  assert.doesNotMatch(textOf(initAfter), /Research campaign active/, "research pin no longer blocks after off");
  await h.run("research fresh campaign after off");
  const refusals = h.pi.notifications.filter((n) => /pin is not replaced|resume it with/i.test(n.text));
  assert.equal(refusals.length, 0, "no stale-pin refusal after off");
  const kickoffs = h.pi.sentMessages.filter((m) => /briefing phase/i.test(m.text));
  assert.ok(kickoffs.length >= 1, `bare launch sends a fresh briefing kickoff after off: ${JSON.stringify(h.pi.sentMessages.map((m) => m.text))}`);
});
