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
