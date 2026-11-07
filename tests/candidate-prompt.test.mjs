/**
 * Candidate-branch prompt mode (tasks.md 4.1): while a candidate campaign is active the
 * before_agent_start system prompt must NOT prescribe the legacy experiment loop
 * (run_experiment/log_experiment cycle, auto-revert, pre-approval of owner questions),
 * and must keep the owner's policy consent. With no active campaign the legacy prompt
 * stays byte-for-byte the same family (the "Autoresearch Mode (ACTIVE)" section).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/candidate-prompt.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

const LEGACY_LOOP_MARKERS = [
  "One idea = one cycle",
  "Do not commit or revert manually",
  "EVERYTHING within the active goal is PRE-APPROVED",
];

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-candprompt-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadPrompt(label, { campaignActive }) {
  const dir = makeTempDir(label);
  if (campaignActive) {
    // campaignBlocksOrdinaryLoop reads .auto/candidate/state.json and blocks when disabled === false.
    fs.mkdirSync(path.join(dir, ".auto", "candidate"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".auto", "candidate", "state.json"),
      JSON.stringify({ schema_version: 1, disabled: false, policy: {}, candidates: [] }),
      "utf8",
    );
  }
  const { pi, command, hook } = createFakePi({ dir, sessionId: `candprompt-${label}`, realGit: false });
  const ctx = makeCtx(dir, `candprompt-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  const event = { systemPrompt: "BASE" };
  const out = await hook("before_agent_start")(event, ctx);
  return out?.systemPrompt ?? event.systemPrompt;
}

test("active candidate campaign: prompt carries candidate-mode rules, not the legacy loop", async () => {
  const prompt = await loadPrompt("active", { campaignActive: true });
  assert.match(prompt, /## Candidate Branch Campaign \(ACTIVE\)/, "candidate section must be present");
  assert.match(prompt, /candidate_branch/, "must point the agent at the candidate_branch tool");
  assert.match(prompt, /Policy consent is the user's alone/, "owner consent rule must be stated");
  assert.match(prompt, /manual_check_required/, "pending-op stop rule must be stated");
  for (const marker of LEGACY_LOOP_MARKERS) {
    assert.equal(prompt.includes(marker), false, `legacy loop text must not be prescribed: "${marker}"`);
  }
  assert.equal(prompt.includes("## Autoresearch Mode (ACTIVE)"), false, "legacy mode section must not be injected");
});

test("no candidate campaign: the legacy experiment-loop prompt is unchanged", async () => {
  const prompt = await loadPrompt("inactive", { campaignActive: false });
  assert.match(prompt, /## Autoresearch Mode \(ACTIVE\)/, "legacy mode section must be present");
  assert.match(prompt, /One idea = one cycle/, "legacy loop rules must be present");
  assert.equal(prompt.includes("## Candidate Branch Campaign (ACTIVE)"), false, "no candidate section without a campaign");
});

test("disabled candidate campaign does not change the prompt (legacy loop comes back)", async () => {
  const dir = makeTempDir("disabled");
  fs.mkdirSync(path.join(dir, ".auto", "candidate"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".auto", "candidate", "state.json"),
    JSON.stringify({ schema_version: 1, disabled: true, policy: {}, candidates: [] }),
    "utf8",
  );
  const { pi, command, hook } = createFakePi({ dir, sessionId: "candprompt-disabled", realGit: false });
  const ctx = makeCtx(dir, "candprompt-disabled", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  const event = { systemPrompt: "BASE" };
  const out = await hook("before_agent_start")(event, ctx);
  const prompt = out?.systemPrompt ?? event.systemPrompt;
  assert.match(prompt, /## Autoresearch Mode \(ACTIVE\)/, "disabled campaign must not suppress the legacy loop");
  assert.equal(prompt.includes("## Candidate Branch Campaign (ACTIVE)"), false);
});

// ─── B1 steers/compaction + M2 template (final review) ───────────────────────

/** Full harness for hook-level tests (agent_end / session_compact). */
async function makeFullHarness(label, { campaignActive }) {
  const dir = makeTempDir(label);
  if (campaignActive) {
    fs.mkdirSync(path.join(dir, ".auto", "candidate"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".auto", "candidate", "state.json"),
      JSON.stringify({ schema_version: 1, disabled: false, policy: {}, candidates: [] }),
      "utf8",
    );
  }
  const { pi, command, hook } = createFakePi({ dir, sessionId: `candprompt-${label}`, realGit: false });
  const ctx = makeCtx(dir, `candprompt-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, hook, dir, ctx };
}

test("B1: agent_end under an active campaign never sends legacy-cycle resume text", async () => {
  const { pi, hook, ctx } = await makeFullHarness("steer-active", { campaignActive: true });
  await hook("agent_start")({ messages: [] }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1100)); // SETTLED_WINDOW_MS = 800
  const legacy = pi.sentMessages.filter((m) => /run_experiment|log_experiment|propose_hypothesis/.test(m.text));
  assert.equal(legacy.length, 0, `no legacy-cycle steers under a campaign: ${JSON.stringify(legacy.map((m) => m.text))}`);
}, { timeout: 30000 });

test("B1: agent_end without a campaign keeps the legacy drift-resume text", async () => {
  const { pi, hook, ctx } = await makeFullHarness("steer-legacy", { campaignActive: false });
  await hook("agent_start")({ messages: [] }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const drift = pi.sentMessages.filter((m) => /propose_hypothesis → run_experiment → log_experiment/.test(m.text));
  assert.equal(drift.length, 1, `legacy drift resume must survive without a campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("B1: session_compact under an active campaign resumes the campaign, not the legacy loop", async () => {
  const { pi, hook, ctx } = await makeFullHarness("compact-active", { campaignActive: true });
  await hook("session_compact")({}, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const legacy = pi.sentMessages.filter((m) => /run_experiment|log_experiment/.test(m.text));
  assert.equal(legacy.length, 0, `compaction must not prescribe the legacy loop under a campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
  const cand = pi.sentMessages.filter((m) => /candidate_branch/.test(m.text));
  assert.equal(cand.length, 1, `compaction must resume the campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("M2: an existing user .auto/prompt.md is never rewritten by the campaign wiring", async () => {
  // The extension never writes .auto/prompt.md (only reads it); assert the
  // invariant on the wiring side by exercising init with a user prompt present.
  const dir = makeTempDir("prompt-preserve");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const USER_PROMPT = "# my own loop rules\n- keep it weird\n";
  fs.writeFileSync(path.join(dir, ".auto", "prompt.md"), USER_PROMPT, "utf8");
  const { createFakePi, makeCtx } = await import("./fake-pi.ts");
  const { pi, command, tool } = createFakePi({ dir, sessionId: "candprompt-preserve", realGit: false });
  const ctx = makeCtx(dir, "candprompt-preserve", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  // no consent dialog available => init refuses BEFORE any write; either way
  // the user's prompt file must be byte-identical.
  ctx.ui.confirm = async () => false;
  const cb = tool("candidate_branch");
  await cb.execute("t1", { action: "init", policy: { metric_name: "m", direction: "higher", repeats: 1, min_gain: 0, benchmark_argv: ["node", "-e", "console.log('METRIC m=1')"], checks_argv: ["node", "-e", "process.exit(0)"], benchmark_timeout_seconds: 10, confirm_budget_seconds: 10, candidate_step_limit: 5, candidate_time_limit_seconds: 600, methodology_files: [], change_files: ["src/x.ts"] } }, undefined, undefined, ctx);
  assert.equal(fs.readFileSync(path.join(dir, ".auto", "prompt.md"), "utf8"), USER_PROMPT, "user prompt bytes must be untouched");
});

test("B1: a partial-cycle turn (loop tool used, no experiment) under a campaign never sends legacy text", async () => {
  const { pi, hook, ctx } = await makeFullHarness("steer-partial", { campaignActive: true });
  await hook("agent_start")({ messages: [] }, ctx);
  // A loop tool that the campaign does NOT block (propose_hypothesis) marks the
  // turn as partial; agent_end would previously send the default (legacy) resume.
  await hook("tool_execution_end")({ toolName: "propose_hypothesis" }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const legacy = pi.sentMessages.filter((m) => /run_experiment|log_experiment|propose_hypothesis/.test(m.text));
  assert.equal(legacy.length, 0, `partial-cycle resume must not prescribe the legacy cycle: ${JSON.stringify(legacy.map((m) => m.text))}`);
  const cand = pi.sentMessages.filter((m) => /candidate_branch/.test(m.text));
  assert.equal(cand.length, 1, `partial-cycle resume must steer to the campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("B1: a partial-cycle turn without a campaign keeps the legacy default resume", async () => {
  const { pi, hook, ctx } = await makeFullHarness("steer-partial-legacy", { campaignActive: false });
  await hook("agent_start")({ messages: [] }, ctx);
  await hook("tool_execution_end")({ toolName: "propose_hypothesis" }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const legacy = pi.sentMessages.filter((m) => /run_experiment \+ log_experiment/.test(m.text));
  assert.equal(legacy.length, 1, `legacy default resume must survive without a campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

test("B1: a campaign under a configured workingDir is detected by drift/compaction steers", async () => {
  const dir = makeTempDir("steer-wd");
  // workingDir = "sub": the campaign state lives in sub/.auto/candidate.
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ workingDir: "sub" }), "utf8");
  fs.mkdirSync(path.join(dir, "sub", ".auto", "candidate"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sub", ".auto", "candidate", "state.json"),
    JSON.stringify({ schema_version: 1, disabled: false, policy: {}, candidates: [] }),
    "utf8",
  );
  const { pi, hook, ctx } = await makeFullHarnessAt(dir, "steer-wd-ctx");
  await hook("agent_start")({ messages: [] }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await hook("session_compact")({}, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  const legacy = pi.sentMessages.filter((m) => /run_experiment|log_experiment|propose_hypothesis/.test(m.text));
  assert.equal(legacy.length, 0, `workingDir campaign must be detected for steers: ${JSON.stringify(legacy.map((m) => m.text))}`);
  const cand = pi.sentMessages.filter((m) => /candidate_branch/.test(m.text));
  // The drift resume stays pending, so session_compact reschedules it rather
  // than sending a second message; one campaign steer is enough.
  assert.equal(cand.length, 1, `the steer must resume the campaign: ${JSON.stringify(pi.sentMessages.map((m) => m.text))}`);
}, { timeout: 30000 });

/** Harness bound to an explicit directory (workingDir fixtures). */
async function makeFullHarnessAt(dir, label) {
  const { pi, command, hook } = createFakePi({ dir, sessionId: `candprompt-${label}`, realGit: false });
  const ctx = makeCtx(dir, `candprompt-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  return { pi, hook, ctx };
}

test("N4: a partial-cycle turn under a campaign with a pending operation sends NO automatic resume", async () => {
  const dir = makeTempDir("steer-pending");
  fs.mkdirSync(path.join(dir, ".auto", "candidate"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".auto", "candidate", "state.json"),
    JSON.stringify({ schema_version: 1, disabled: false, policy: {}, candidates: [] }),
    "utf8",
  );
  // An interrupted operation: design §5 requires stopping, not an automatic resume.
  fs.writeFileSync(
    path.join(dir, ".auto", "candidate", "pending-op.json"),
    JSON.stringify({ name: "checkpoint cand-a", started_at: new Date().toISOString() }),
    "utf8",
  );
  const { pi, hook, ctx } = await makeFullHarnessAt(dir, "steer-pending-ctx");
  await hook("agent_start")({ messages: [] }, ctx);
  await hook("tool_execution_end")({ toolName: "propose_hypothesis" }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1100));
  // Only automatic RESUME steers are forbidden; the /skill kickoff is not a resume.
  const RESUME_TEXT = /Continue the candidate campaign|Last turn did no candidate-campaign work|Run the next iteration|Resume the cycle/;
  const resumes = pi.sentMessages.filter((m) => RESUME_TEXT.test(m.text));
  assert.equal(
    resumes.length,
    0,
    `no automatic resume may be scheduled while a campaign operation is pending: ${JSON.stringify(resumes.map((m) => m.text))}`,
  );
}, { timeout: 30000 });
