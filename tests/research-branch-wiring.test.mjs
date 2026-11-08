/**
 * research-vectors wiring (openspec/changes/research-vectors, tasks 2bi.2.1):
 * the research_brief (phase 1) and research (phase 2) tools, the ordinary-loop
 * blocks, the research prompt and resume wording, the Git hook, and the
 * operator-only resolve. Drives the REAL extension through the fake pi harness.
 *
 * Run: timeout 120 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-branch-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

const LEGACY_TOOL_NAMES = /run_experiment|log_experiment|propose_hypothesis/;
const LEGACY_MARKERS = [
  "One idea = one cycle",
  "Do not commit or revert manually",
  "EVERYTHING within the active goal",
];
// Exact text of a legacy guideline line that the research prompt must drop.
const LEGACY_GUIDELINE_LINE =
  "- log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.";
const BLOCK_TEXT = "Research campaign active; use research status or the operator resolve; the ordinary loop is blocked";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-research-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes a schema-valid campaign state with the given phase (no brief, no log). */
function writeCampaignState(dir, id, phase) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
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
      { id: "Q2", text: "Does the retry policy add latency?", decision_rules: rulesFor("Q2"), needs_data: "independent confirm set" },
    ],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
  return { ...base, ...overrides };
}

/** Loads the REAL extension on a fake pi, turns autoresearch mode on via the research subcommand (pins campaign c1), returns the handles. */
async function loadExtension(dir, label) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: `research-${label}`, realGit: false });
  const ctx = makeCtx(dir, `research-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1", ctx);
  return { pi, tool, command, hook, ctx, dir };
}

/** Loads the REAL extension on a fake pi with the mode on and NO campaign pin. */
async function loadExtensionBare(dir, label) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: `research-${label}`, realGit: false });
  const ctx = makeCtx(dir, `research-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, tool, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readLog(dir, id) {
  const text = fs.readFileSync(path.join(dir, ".auto", "research", id, "log.jsonl"), "utf8");
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

/** Drafts a campaign (id auto-generated/pinned) and approves it through the owner dialog. */
async function draftAndApprove(h, id = "c1") {
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  const dirs = fs.readdirSync(path.join(h.dir, ".auto", "research"));
  assert.deepEqual(dirs, [id], `single campaign dir ${id} expected, got: ${dirs}`);
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  return sha256Of(fs.readFileSync(path.join(h.dir, ".auto", "research", id, "brief.json")));
}

// ─── (a) prompt ─────────────────────────────────────────────────────────────

test("(a) research campaign: prompt carries research rules and drops legacy loop text", async () => {
  const dir = makeWorkDir("prompt");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "prompt");
  const out = await h.hook("before_agent_start")({ systemPrompt: `BASE\n${LEGACY_GUIDELINE_LINE}` }, h.ctx);
  const prompt = out.systemPrompt;
  assert.match(prompt, /## Research Campaign \(ACTIVE\)/, "research section must be present");
  assert.match(prompt, /Git operations are FORBIDDEN/, "git ban must be stated");
  for (const marker of LEGACY_MARKERS) {
    assert.equal(prompt.includes(marker), false, `legacy loop text must not be prescribed: "${marker}"`);
  }
  assert.equal(prompt.includes(LEGACY_GUIDELINE_LINE), false, "legacy guideline line must be filtered out");
  assert.equal(prompt.includes("## Candidate Branch Campaign (ACTIVE)"), false, "no candidate section");
  assert.equal(prompt.includes("## Autoresearch Mode (ACTIVE)"), false, "no legacy mode section");
});

// ─── (b) steers ─────────────────────────────────────────────────────────────

test("(b) agent_end during an active research campaign never steers toward the legacy loop", async () => {
  const dir = makeWorkDir("steer");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "steer");
  await h.hook("agent_start")({ messages: [] }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1100)); // SETTLED_WINDOW_MS = 800
  const legacy = h.pi.sentMessages.filter((m) => LEGACY_TOOL_NAMES.test(m.text));
  assert.equal(legacy.length, 0, `no legacy-loop steers: ${JSON.stringify(legacy.map((m) => m.text))}`);
  // The activation kickoff (sent at load) also mentions research status; the
  // drift steer is its own message and must be present exactly once.
  const research = h.pi.sentMessages.filter((m) => /Continue the research campaign/.test(m.text));
  assert.equal(research.length, 1, `research resume must be sent instead: ${JSON.stringify(h.pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("(b) a stopped research campaign never auto-continues", async () => {
  const dir = makeWorkDir("steer-stopped");
  writeCampaignState(dir, "c1", "stopped");
  const h = await loadExtension(dir, "steer-stopped");
  await h.hook("agent_start")({ messages: [] }, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(h.pi.sentMessages.length, 0, `stopped campaign must not be resumed: ${JSON.stringify(h.pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

// ─── (c) blocked ordinary-loop tools ────────────────────────────────────────

test("(c) research campaign: init/propose/finalize and the other loop tools refuse without running", async () => {
  const dir = makeWorkDir("blocked");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "blocked");
  const calls = [
    ["init_experiment", {}],
    ["propose_hypothesis", { description: "try a cache" }],
    ["finalize_research", { reason: "done" }],
    ["run_experiment", { command: "echo hi", timeout_seconds: 5 }],
    ["log_experiment", { metric: 1, status: "keep", description: "x" }],
    ["candidate_branch", { action: "status" }],
  ];
  for (const [name, params] of calls) {
    const text = textOf(await call(h, name, params));
    assert.ok(text.includes(BLOCK_TEXT), `${name} must be blocked: ${text}`);
    assert.equal(LEGACY_TOOL_NAMES.test(text), false, `${name} must not name the legacy tools: ${text}`);
  }
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "no legacy ledger written");
});

test("(c) a stopped campaign blocks the loop too, and an unreadable state fails closed", async () => {
  const stoppedDir = makeWorkDir("blocked-stopped");
  writeCampaignState(stoppedDir, "c1", "stopped");
  const stopped = await loadExtension(stoppedDir, "blocked-stopped");
  assert.ok(textOf(await call(stopped, "init_experiment", {})).includes(BLOCK_TEXT), "stopped campaign must block");

  const brokenDir = makeWorkDir("blocked-broken");
  const campaignDir = writeCampaignState(brokenDir, "c1", "briefing");
  fs.writeFileSync(path.join(campaignDir, "state.json"), "{broken");
  const broken = await loadExtension(brokenDir, "blocked-broken");
  assert.ok(textOf(await call(broken, "init_experiment", {})).includes(BLOCK_TEXT), "unreadable state must block");
});

// ─── (d) research_brief propose: owner consent ──────────────────────────────

test("(d) research_brief propose without UI refuses and writes no approval", async () => {
  const dir = makeWorkDir("propose-noui");
  const h = await loadExtension(dir, "propose-noui");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  h.ctx.hasUI = false;
  let dialogs = 0;
  h.ctx.ui.confirm = async () => {
    dialogs += 1;
    return true;
  };
  const text = textOf(await call(h, "research_brief", { action: "propose" }));
  assert.match(text, /needs an interactive dialog/, text);
  assert.equal(dialogs, 0, "no dialog without UI");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c1", "approval.json")), false, "no approval.json");
});

test("(d) research_brief propose: owner confirm === true writes approval.json with the brief hash", async () => {
  const dir = makeWorkDir("propose-yes");
  const h = await loadExtension(dir, "propose-yes");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  const dialogs = [];
  h.ctx.ui.confirm = async (title, message) => {
    dialogs.push({ title, message, chatBefore: h.pi.chatMessages.length });
    return true;
  };
  const text = textOf(await call(h, "research_brief", { action: "propose" }));
  const briefPath = path.join(dir, ".auto", "research", "c1", "brief.json");
  const expected = sha256Of(fs.readFileSync(briefPath));
  assert.equal(dialogs.length, 1, "exactly one owner dialog");
  assert.ok(dialogs[0].message.includes(expected), "dialog must show the brief hash");
  assert.equal(dialogs[0].chatBefore, 1, "full brief must be in the chat before the dialog opens");
  const chat = h.pi.chatMessages[0];
  assert.equal(chat.customType, "research-brief");
  assert.match(chat.content, /cache layer explains the latency drop/, "chat must show the brief goal");
  assert.ok(chat.content.includes(expected), "chat must show the brief SHA-256");
  assert.doesNotMatch(chat.content, /"schema_version"|"questions"\s*:/, "chat must not be raw JSON");
  const approval = readJson(path.join(dir, ".auto", "research", "c1", "approval.json"));
  assert.equal(approval.confirmed, true);
  assert.equal(approval.brief_sha256, expected);
  assert.ok(text.includes(expected) && /research start/.test(text), `launch prompt must carry path and hash: ${text}`);
});

test("(d) research_brief propose: dialog is a summary of at most 10 lines starting with the SHA", async () => {
  const dir = makeWorkDir("propose-summary");
  const h = await loadExtension(dir, "propose-summary");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  let message = "";
  h.ctx.ui.confirm = async (_title, msg) => {
    message = msg;
    return true;
  };
  await call(h, "research_brief", { action: "propose" });
  const expected = sha256Of(fs.readFileSync(path.join(dir, ".auto", "research", "c1", "brief.json")));
  const lines = message.split("\n");
  assert.ok(lines.length <= 10, `summary has ${lines.length} lines`);
  assert.equal(lines[0], `Brief SHA-256: ${expected}`, "first line must be the SHA line");
  assert.doesNotMatch(message, /"schema_version"|Results are observational/, "dialog must not carry the full brief");
});

test("(d) research_brief propose: any confirm other than true approves nothing", async () => {
  const dir = makeWorkDir("propose-no");
  const h = await loadExtension(dir, "propose-no");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  h.ctx.ui.confirm = async () => "yes";
  const text = textOf(await call(h, "research_brief", { action: "propose" }));
  assert.match(text, /did not confirm/, text);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c1", "approval.json")), false);
});

test("(d) research_brief rejects model-supplied approval fields without a dialog", async () => {
  const dir = makeWorkDir("propose-fields");
  const h = await loadExtension(dir, "propose-fields");
  await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  let dialogs = 0;
  h.ctx.ui.confirm = async () => {
    dialogs += 1;
    return true;
  };
  for (const extra of ["approved", "confirmed", "operator_confirmation"]) {
    const text = textOf(await call(h, "research_brief", { action: "propose", [extra]: true }));
    assert.match(text, /invalid_argument/, `${extra} must be refused: ${text}`);
  }
  assert.equal(dialogs, 0);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "research", "c1", "approval.json")), false);
});

test("(d) an approved brief cannot be redrafted or proposed again (no second dialog)", async () => {
  const dir = makeWorkDir("approved-redraft");
  const h = await loadExtension(dir, "approved-redraft");
  await draftAndApprove(h);
  const changed = { ...briefFixture(), goal: "A different goal." };
  const text = textOf(await call(h, "research_brief", { action: "draft", brief: changed }));
  assert.match(text, /approved and cannot be changed/, text);
  let dialogs = 0;
  h.ctx.ui.confirm = async () => {
    dialogs += 1;
    return true;
  };
  const again = textOf(await call(h, "research_brief", { action: "propose" }));
  assert.match(again, /already approved/, again);
  assert.equal(dialogs, 0, "an approved brief must not be shown for consent again");
});

// ─── (e) research start ─────────────────────────────────────────────────────

test("(e) research start with a wrong hash refuses and keeps the briefing phase", async () => {
  const dir = makeWorkDir("start-wrong");
  const h = await loadExtension(dir, "start-wrong");
  await draftAndApprove(h);
  const text = textOf(await call(h, "research", { action: "start", expected_sha256: "0".repeat(64) }));
  assert.match(text, /brief_changed/, text);
  assert.equal(readJson(path.join(dir, ".auto", "research", "c1", "state.json")).phase, "briefing");
});

test("(e) research start with the approved hash moves the campaign to the research phase", async () => {
  const dir = makeWorkDir("start-ok");
  const h = await loadExtension(dir, "start-ok");
  const sha = await draftAndApprove(h);
  const text = textOf(await call(h, "research", { action: "start", expected_sha256: sha }));
  assert.match(text, /Research phase started/, text);
  assert.equal(readJson(path.join(dir, ".auto", "research", "c1", "state.json")).phase, "research");
});

// ─── (f) full cycle ─────────────────────────────────────────────────────────

test("(f) draft -> propose -> start -> open -> record -> close -> status shows the vector closed", async () => {
  const dir = makeWorkDir("cycle");
  const h = await loadExtension(dir, "cycle");
  const sha = await draftAndApprove(h);
  assert.match(textOf(await call(h, "research", { action: "start", expected_sha256: sha })), /started/);

  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  const evidenceBytes = Buffer.from("line one\nline two\nline three\n");
  fs.writeFileSync(path.join(dir, "evidence", "run1.txt"), evidenceBytes);

  assert.match(textOf(await call(h, "research", { action: "open", question_id: "Q1" })), /Vector Q1 opened/);
  assert.match(
    textOf(await call(h, "research", { action: "record", evidence_ref: "evidence/run1.txt:1-2" })),
    /Evidence recorded for vector Q1/,
  );
  assert.match(
    textOf(await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" })),
    /Vector Q1 closed: confirmed by rule Q1-yes/,
  );

  const status = textOf(await call(h, "research", { action: "status" }));
  assert.match(status, /Q1: closed — verdict confirmed by rule Q1-yes; evidence hashes match \(1\)/, status);
  assert.match(status, /Q2: not opened/, status);

  const log = readLog(dir, "c1");
  assert.deepEqual(log.map((e) => e.event), ["open", "record", "close"]);
  assert.equal(log[1].evidence_sha256, sha256Of(evidenceBytes), "record stores the SHA-256 of the evidence file");
  assert.equal(log[2].question_text, "Does the cache hit rate rise after the change?", "close keeps the question text");
  assert.equal(log[2].rule_when, "effect is present in validate data", "close keeps the applied rule text");
});

test("(f) a changed evidence file is reported by status as not reproducible", async () => {
  const dir = makeWorkDir("evidence-changed");
  const h = await loadExtension(dir, "evidence-changed");
  const sha = await draftAndApprove(h);
  await call(h, "research", { action: "start", expected_sha256: sha });
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "run1.txt"), "original\n");
  await call(h, "research", { action: "open", question_id: "Q1" });
  await call(h, "research", { action: "record", evidence_ref: "evidence/run1.txt#anchor" });
  fs.writeFileSync(path.join(dir, "evidence", "run1.txt"), "edited after record\n");
  const status = textOf(await call(h, "research", { action: "status" }));
  assert.match(status, /1 of 1 evidence file\(s\) changed or missing — not reproducible/, status);
});

// ─── (f) stop and report ────────────────────────────────────────────────────

test("(f) stop moves to stopped; report carries the caveat verbatim and no target metric", async () => {
  const dir = makeWorkDir("stop-report");
  const h = await loadExtension(dir, "stop-report");
  const sha = await draftAndApprove(h);
  await call(h, "research", { action: "start", expected_sha256: sha });
  const stopText = textOf(await call(h, "research", { action: "stop", rule_id: "S1", reason: "two rejections recorded" }));
  assert.match(stopText, /Research stopped by S1/, stopText);
  assert.equal(readJson(path.join(dir, ".auto", "research", "c1", "state.json")).phase, "stopped");

  const refusedOpen = textOf(await call(h, "research", { action: "open", question_id: "Q1" }));
  assert.match(refusedOpen, /phase stopped/, "no vector may open after a stop");

  const report = textOf(await call(h, "research", { action: "report" }));
  assert.ok(report.includes(briefFixture().caveat_block), "caveat block must be copied verbatim");
  assert.match(report, /S1: .* — TRIGGERED \(two rejections recorded\)/, report);
  assert.match(report, /No target metric/, report);
});

// ─── (i) open/record/close rules ────────────────────────────────────────────

test("(i) open, record and close refuse every rule violation", async () => {
  const dir = makeWorkDir("rules");
  const h = await loadExtension(dir, "rules");
  const sha = await draftAndApprove(h);
  await call(h, "research", { action: "start", expected_sha256: sha });
  const act = (params) => call(h, "research", params).then(textOf);

  assert.match(await act({ action: "open", question_id: "Q9" }), /not in the approved brief/);
  assert.match(await act({ action: "record", evidence_ref: "evidence/none.txt:1" }), /no vector is open/);
  assert.match(await act({ action: "open", question_id: "Q1" }), /Vector Q1 opened/);
  assert.match(await act({ action: "open", question_id: "Q2" }), /vector Q1 is open/);
  assert.match(await act({ action: "record", evidence_ref: "evidence/none.txt:1" }), /cannot be read/);
  // Bare paths are refused at record (review M2: the findings routing on close
  // stores the recorded ref verbatim, so it must already be lines/anchor form).
  assert.match(await act({ action: "record", evidence_ref: "../outside.txt" }), /path:lines or path#anchor/);
  assert.match(await act({ action: "close", question_id: "Q1", rule_id: "Q2-yes", verdict: "confirmed" }), /is not a decision rule of question Q1/);
  assert.match(await act({ action: "close", question_id: "Q1", rule_id: "Q1-no", verdict: "confirmed" }), /has verdict rejected, not confirmed/);
  assert.match(await act({ action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" }), /no evidence recorded/);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "run1.txt"), "data\n");
  assert.match(await act({ action: "record", evidence_ref: "evidence/run1.txt:1" }), /Evidence recorded/);
  assert.match(await act({ action: "close", question_id: "Q1", rule_id: "Q1-unknown", verdict: "inconclusive" }), /requires a reason/);
  assert.match(await act({ action: "close", question_id: "Q1", rule_id: "Q1-unknown", verdict: "inconclusive", reason: "noisy" }), /Vector Q1 closed: inconclusive/);
  assert.match(await act({ action: "open", question_id: "Q1" }), /already closed/, "a closed vector is never reopened");
  assert.match(await act({ action: "open", question_id: "Q2", approved: true }), /unexpected field/, "model approval fields are refused");
});

// ─── (g) git hook ───────────────────────────────────────────────────────────

test("(g) git through the shell is blocked while a research campaign is active", async () => {
  const dir = makeWorkDir("git-hook");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "git-hook");
  const hook = h.hook("tool_call");
  const B = String.fromCharCode(92); // single backslash for path cases
  for (const [toolName, command] of [
    ["bash", "git commit -m x"],
    ["bash", "echo ok && git status"],
    ["bash", "  git status"],
    ["bash", "cd repo\ngit status"],
    ["bash", "git.exe status"],
    ["bash", "GIT status"],
    ["bash", "/usr/bin/git status"],
    ["bash", "\"C:\\Program Files\\Git\\cmd\\git.exe\" status"],
    ["bash", "cmd /c git status"],
    ["bash", "cmd /c \"git status\""],
    ["bash", "cmd.exe /c \"git status\""],
    ["bash", "powershell -c git status"],
    ["bash", "powershell -Command \"git status\""],
    ["bash", "powershell.exe -Command \"git status\""],
    ["bash", "pwsh -Command git add -A"],
    ["bash", "pwsh -Command \"git add -A\""],
    ["bash", "pwsh.exe -Command \"git add -A\""],
    ["bash", "pwsh -NoProfile -Command \"git status\""],
    ["bash", "powershell -NoProfile -Command \"git status\""],
    ["bash", "nice git status"],
    ["bash", "nice -n 5 git status"],
    ["bash", "nice -15 git status"],
    ["bash", "sudo -u root git status"],
    ["bash", "env -i git status"],
    ["bash", "command -p git status"],
    ["bash", "xargs -0 git status"],
    ["bash", "bash -lc \"git add -A\""],
    ["powershell", "git push"],
    ["bash", "env git log"],
    ["bash", "FOO=1 git commit"],
  ]) {
    const result = await hook({ toolName, input: { command } }, h.ctx);
    assert.equal(result?.block, true, `${command} must be blocked`);
    assert.equal(LEGACY_TOOL_NAMES.test(result.reason), false, `reason must not name legacy tools: ${result.reason}`);
  }
  assert.equal(await hook({ toolName: "bash", input: { command: "node -e \"console.log(1)\"" } }, h.ctx), undefined);
});

test("(g) git is not blocked during briefing (no research phase yet)", async () => {
  const dir = makeWorkDir("git-briefing");
  writeCampaignState(dir, "c1", "briefing");
  const h = await loadExtension(dir, "git-briefing");
  assert.equal(await h.hook("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx), undefined);
});

// ─── (h) resolve is operator-only ───────────────────────────────────────────

test("(h) research resolve requires an interactive operator dialog to clear a pending operation", async () => {
  const dir = makeWorkDir("resolve");
  const campaignDir = writeCampaignState(dir, "c1", "research");
  fs.writeFileSync(
    path.join(campaignDir, "pending-op.json"),
    JSON.stringify({ name: "record evidence for Q1", started_at: new Date().toISOString() }),
  );
  const h = await loadExtension(dir, "resolve");
  const status = textOf(await call(h, "research", { action: "status" }));
  assert.match(status, /manual_check_required/, status);

  h.ctx.hasUI = false;
  const noUi = textOf(await call(h, "research", { action: "resolve" }));
  assert.match(noUi, /manual_check_required/, noUi);
  assert.equal(fs.existsSync(path.join(campaignDir, "pending-op.json")), true, "marker stays without UI");

  h.ctx.hasUI = true;
  h.ctx.ui.confirm = async () => false;
  const denied = textOf(await call(h, "research", { action: "resolve" }));
  assert.match(denied, /requires explicit operator consent/, denied);
  assert.equal(fs.existsSync(path.join(campaignDir, "pending-op.json")), true, "marker stays without consent");

  h.ctx.ui.confirm = async () => true;
  const done = textOf(await call(h, "research", { action: "resolve" }));
  assert.match(done, /resolved by the operator/, done);
  assert.equal(fs.existsSync(path.join(campaignDir, "pending-op.json")), false, "marker cleared after consent");
  assert.equal(readJson(path.join(campaignDir, "state.json")).phase, "research", "state.json untouched by resolve");
});

// ─── Review B1/B2/B3 fixes ───────────────────────────────────────────────────

test("B1: council_* tools are blocked under an active research campaign and open without one", async () => {
  const dir = makeWorkDir("council-block");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "council-block");
  const dirPath = path.join(dir, ".auto", "councils", "1");
  fs.mkdirSync(dirPath, { recursive: true });
  const params = { councilDir: ".auto/councils/1" };
  for (const name of ["council_write_entry", "council_read_index", "council_read_entry", "council_check_consensus"]) {
    const res = textOf(await call(h, name, name === "council_write_entry" ? { ...params, speaker: "A", phase: "facts", summary: "s", content: "c" } : params));
    assert.match(res, /Research campaign active/, `${name} must be blocked under research: ${res}`);
  }
  const convene = textOf(await call(h, "council_convene", {}));
  assert.match(convene, /Research campaign active/, `council_convene must be blocked under research: ${convene}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "councils")), true, "no council state is created under the block");
  const empty = makeWorkDir("council-open");
  const h2 = await loadExtension(empty, "council-open");
  fs.mkdirSync(path.join(empty, ".auto", "councils", "2"), { recursive: true });
  const openRes = textOf(await call(h2, "council_read_index", { councilDir: ".auto/councils/2" }));
  assert.equal(/Research campaign active/.test(openRes), false, `without a campaign the tool must run: ${openRes}`);
});

test("B2: git hook catches bash -c wrappers and skips harmless prose", async () => {
  const dir = makeWorkDir("git-hook");
  writeCampaignState(dir, "c1", "research");
  const h = await loadExtension(dir, "git-hook");
  const hooked = h.hook("tool_call");
  for (const cmd of ["git status", "bash -c 'git status'", "bash -lc \"git add -A\"", "command git push", "sh -c 'git commit -m x'", "env git log"]) {
    const out = await hooked({ toolName: "bash", input: { command: cmd } }, h.ctx);
    assert.equal(out?.block, true, `must block: ${cmd} -> ${JSON.stringify(out)}`);
  }
  for (const cmd of ["echo git is useful", "grep -r git docs", "echo 'use git later'"]) {
    const out = await hooked({ toolName: "bash", input: { command: cmd } }, h.ctx);
    assert.equal(out?.block ?? false, false, `must NOT block: ${cmd} -> ${JSON.stringify(out)}`);
  }
});

test("B3: a second campaign is impossible through the tools; pre-existing multiple dirs refuse", async () => {
  const dir = makeWorkDir("two-campaigns");
  const h = await loadExtension(dir, "two-campaigns");
  // campaign 1: full brief + approval + started
  const d1 = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.doesNotMatch(textOf(d1), /⛔/, textOf(d1));
  const c1dir = path.join(dir, ".auto", "research", "c1");
  const hash1 = sha256Of(fs.readFileSync(path.join(c1dir, "brief.json")));
  h.ctx.hasUI = true;
  h.ctx.ui.confirm = async () => true;
  const prop1 = await call(h, "research_brief", { action: "propose" });
  assert.doesNotMatch(textOf(prop1), /⛔/, textOf(prop1));
  const start1 = await call(h, "research", { action: "start", expected_sha256: hash1 });
  assert.doesNotMatch(textOf(start1), /⛔/, textOf(start1));

  // A second campaign cannot be expressed: the tools take no campaign id and
  // the single-campaign session reuses c1 (its draft is refused: approved).
  const d2 = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(d2, /approved and cannot be changed/, d2);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".auto", "research")), ["c1"], "no second campaign dir may appear");

  // Legacy multiple dirs (pre-fix leftovers like the live bench): the pinned
  // session still works on its own campaign; the UNPINNED tools refuse.
  writeCampaignState(dir, "c2", "briefing");
  const d3 = textOf(await call(h, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(d3, /approved and cannot be changed/, d3);
  const dir2 = makeWorkDir("two-campaigns-unpinned");
  writeCampaignState(dir2, "x1", "briefing");
  writeCampaignState(dir2, "x2", "briefing");
  const h2 = await loadExtensionBare(dir2, "two-campaigns-unpinned");
  const statH2 = textOf(await call(h2, "research", { action: "status" }));
  assert.match(statH2, /several campaigns exist/, statH2);
  const d4 = textOf(await call(h2, "research_brief", { action: "draft", brief: briefFixture() }));
  assert.match(d4, /several campaigns exist/, d4);

  // M1: editing the approved brief of c1 blocks its actions with brief_changed
  // (single campaign again: the leftover c2 dir is removed first).
  fs.rmSync(path.join(dir, ".auto", "research", "c2"), { recursive: true, force: true });
  fs.writeFileSync(path.join(c1dir, "brief.json"), JSON.stringify(briefFixture({ goal: "tampered" })));
  const stat2 = textOf(await call(h, "research", { action: "status" }));
  assert.match(stat2, /brief_changed/, stat2);
});
