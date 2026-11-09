/**
 * Loop-prompt finding routes (openspec add-result-reflection, task 1.9): the
 * before_agent_start prompt string carries the per-theme routing rules
 * (behavior → hypothesis, capability → ideas + owner gate, tradeoff → owner
 * question / secondary metric, measurement → log_measurement_change with
 * accounting) and stays within the size budget of the autoresearch section.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/loop-finding-routes.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

// Size budget for the whole "## Autoresearch Mode" section. The section was
// 4373 chars before task 1.9 (measured on the same harness); the finding routes
// add ~1270 chars, and the precedent-search guidance (agent-guidance.test.mjs)
// adds ~1100 more. The budget is chosen by the implementation, not the spec:
// it stays a hard upper bound that is checked on every run.
// 7300 (was 7000): the two-phase start instruction adds ~260 chars.
// 7500 (was 7300): the subagent-wait-guard bg_wait instruction adds ~250 chars
// (owner decision 2026-11-09: no shrinking of existing lines, one-time raise).
const AUTORESEARCH_SECTION_MAX_CHARS = 7500;
// Budget for the finding-routes block alone (short lines, per design.md).
const FINDING_ROUTES_MAX_CHARS = 1400;

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-routes-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadLoopPrompt(label) {
  const dir = makeTempDir(label);
  const { pi, command, hook } = createFakePi({ dir, sessionId: `routes-${label}`, realGit: false });
  const ctx = makeCtx(dir, `routes-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  const event = { systemPrompt: "BASE" };
  const out = await hook("before_agent_start")(event, ctx);
  const prompt = out?.systemPrompt ?? event.systemPrompt;
  return { prompt, dir };
}

/**
 * Text from the autoresearch section header to the end of the prompt (the
 * conditional "Backpressure Checks" block is absent in this harness).
 */
function autoresearchSection(prompt) {
  const start = prompt.indexOf("## Autoresearch Mode");
  assert.ok(start >= 0, "prompt must contain the autoresearch section");
  return prompt.slice(start);
}

/** Text from the finding-routes header up to the next section. */
function findingRoutes(prompt) {
  const start = prompt.indexOf("## Result Findings (route by theme)");
  assert.ok(start >= 0, "prompt must contain the Result Findings section");
  const rest = prompt.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next >= 0 ? prompt.slice(start, start + 1 + next) : prompt.slice(start);
}

/** The single prompt line that starts with the given theme label. */
function routeLine(block, theme) {
  const line = block.split("\n").find((l) => l.startsWith(`- ${theme} (`));
  assert.ok(line, `route line for theme "${theme}" must be present`);
  return line;
}

const { prompt, dir } = await loadLoopPrompt("main");
const section = autoresearchSection(prompt);
const routes = findingRoutes(prompt);

test("finding block tells the agent to record findings with evidence", () => {
  assert.ok(routes.includes("record_finding({theme, description, evidence_ref})"), "record_finding call shape");
  assert.ok(routes.includes("inspect_results"), "findings come from reading raw results");
  assert.ok(/evidence_ref must cite a concrete case/.test(routes), "evidence requirement");
  assert.ok(routes.includes("generalizations without examples are rejected"), "generalization rejection");
});

test("behavior route: ordinary hypothesis via propose_hypothesis citing the finding", () => {
  const line = routeLine(routes, "behavior");
  assert.ok(line.includes("propose_hypothesis"), "behavior → propose_hypothesis");
  assert.ok(line.includes("finding id"), "hypothesis cites the finding id");
  assert.ok(!/owner-input|owner gate/.test(line), "behavior is not an owner gate");
});

test("capability route: idea in ideas backlog marked owner-input, no hypothesis or run", () => {
  const line = routeLine(routes, "capability");
  assert.ok(line.includes("NOT a hypothesis and NOT a run"), "capability creates no hypothesis and no run");
  assert.ok(line.includes("ideas"), "capability goes to the ideas backlog");
  assert.ok(line.includes("owner-input"), "capability is marked owner-input");
  assert.ok(line.includes("owner gate"), "capability is an owner gate");
  assert.ok(line.includes("resume"), "gate is lifted only on the owner's go-ahead at resume");
});

test("tradeoff route: owner question or secondary metric", () => {
  const line = routeLine(routes, "tradeoff");
  assert.ok(line.includes("ask the owner"), "tradeoff asks the owner which side to prefer");
  assert.ok(line.includes("secondary metric"), "tradeoff may track the cost as a secondary metric");
  assert.ok(line.includes("log_experiment"), "secondary metric is passed through log_experiment");
});

test("measurement route: log_measurement_change with accounting and S3 stage note", () => {
  const line = routeLine(routes, "measurement");
  assert.ok(line.includes("log_measurement_change"), "measurement → log_measurement_change");
  assert.ok(line.includes("mandatory accounting"), "accounting is mandatory");
  assert.ok(line.includes("diff"), "accounting names the diff");
  assert.ok(line.includes("rescore artifact"), "accounting names the rescore artifact");
  assert.ok(line.includes("justification = finding id"), "justification is the finding id");
  assert.ok(line.includes("provisional until independently verified"), "change is provisional until verified");
  assert.ok(line.includes("stage S3"), "stage note: the tool arrives in S3");
  assert.ok(line.includes("do NOT edit the scorer or gold silently"), "no silent measurement edits");
});

test("every theme of the closed set has exactly one route line", () => {
  for (const theme of ["behavior", "capability", "tradeoff", "measurement"]) {
    const count = routes.split("\n").filter((l) => l.startsWith(`- ${theme} (`)).length;
    assert.equal(count, 1, `theme ${theme} has one route line`);
  }
});

test("finding routes stay within the block budget", () => {
  assert.ok(
    routes.length <= FINDING_ROUTES_MAX_CHARS,
    `finding routes ${routes.length} chars exceed ${FINDING_ROUTES_MAX_CHARS}`,
  );
});

test("autoresearch section stays within the prompt size budget", () => {
  assert.ok(
    section.length <= AUTORESEARCH_SECTION_MAX_CHARS,
    `autoresearch section ${section.length} chars exceed ${AUTORESEARCH_SECTION_MAX_CHARS}`,
  );
});

test("routes sit inside the autoresearch section, before the hypothesis workflow", () => {
  assert.ok(section.includes("## Result Findings (route by theme)"), "routes are part of the autoresearch section");
  assert.ok(
    section.indexOf("## Result Findings") < section.indexOf("## Hypothesis-First Workflow"),
    "routes precede the hypothesis workflow",
  );
});

test("existing benchmark guardrail and loop rules are kept", () => {
  assert.ok(section.includes("Be careful not to overfit to the benchmarks"), "benchmark guardrail kept");
  assert.ok(section.includes("PRE-APPROVED"), "pre-approval rule kept");
  assert.ok(section.includes("Ask the owner ONLY when stepping outside"), "owner-frame rule kept");
});

test("observer steer emoji are real characters, not literal escapes", () => {
  assert.ok(!prompt.includes("U0001f"), "no literal U0001f escape leaked into the prompt");
  assert.ok(prompt.includes("\u{1f504} STAGNATION"), "stagnation steer rendered");
  assert.ok(prompt.includes("\u{1f3af} MILESTONE"), "milestone steer rendered");
});

test("capability route points at the real ideas backlog path", () => {
  const line = routeLine(routes, "capability");
  const ideasDir = path.join(dir, ".auto", "ideas");
  // resolveWorkDir may differ from the temp dir spelling on Windows; compare the tail.
  assert.ok(line.includes(path.join(".auto", "ideas")) || line.includes(ideasDir), "ideas backlog path in capability route");
});
