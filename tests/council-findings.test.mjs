/**
 * Findings in the council brief + challenge-phase input (openspec
 * add-result-reflection, task 1.8; spec findings/spec.md requirements
 * "Секции находок в брифе совета", "Мягкий маркер линзы в брифе совета").
 *
 * Covers extensions/pi-autoresearch/council.ts (buildBrief) and
 * council-delegation.ts (extractOpenFindingsSection + challenge input):
 *  - brief with open findings: grouped by theme, impact, [needs_verification]
 *    highlight, measurement-health line; non-open findings are excluded;
 *  - brief without findings.jsonl (old campaigns): no findings section, no
 *    marker, healthy health line, nothing throws;
 *  - `lens: not done` marker: present when .auto/runs exists but the current
 *    segment has no findings, absent when a segment run has a finding, absent
 *    for campaigns without persisted run dirs (nothing to inspect);
 *  - the challenge phase receives the findings section as input (and does not
 *    when the brief has none).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/council-findings.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { buildBrief } from "../extensions/pi-autoresearch/council.ts";
import {
  extractOpenFindingsSection,
  runCouncilDelegated,
} from "../extensions/pi-autoresearch/council-delegation.ts";
import { recordFinding, updateFinding } from "../extensions/pi-autoresearch/findings.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-ar-council-f-${label}-`));
}

/** Ledger with runs 1–3 in segment 0 (no segment restarts → currentSegment 0). */
function plantLedger(dir) {
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const lines = [JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" })];
  lines.push(JSON.stringify({ run: 1, metric: 100, status: "keep", description: "baseline keep" }));
  lines.push(JSON.stringify({ run: 2, metric: 103, status: "discard", description: "tweak a" }));
  lines.push(JSON.stringify({ run: 3, metric: 104, status: "discard", description: "tweak b" }));
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), lines.join("\n") + "\n", "utf-8");
}

/** Persisted run output (makes .auto/runs exist and gives evidence a target). */
function plantRunOutput(dir, run = 3) {
  const abs = path.join(dir, ".auto", "runs", String(run), "output.txt");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "METRIC ms 104\nMISMATCH gold=x pred=y\n", "utf-8");
  return `.auto/runs/${run}/output.txt`;
}

const BRIEF_INPUT = {
  seq: 1,
  metricName: "ms",
  metricUnit: "ms",
  direction: "lower",
  baselineMetric: 100,
  bestMetric: 104,
  noiseFloor: 2,
  goal: "bench",
};

function buildInto(dir) {
  return buildBrief(dir, path.join(dir, ".auto", "councils", "1"), BRIEF_INPUT);
}

/** Two open findings (one flagged) + one deferred finding that must not show. */
function plantFindings(dir, evidenceRef) {
  const flagged = recordFinding(dir, {
    theme: "measurement",
    description: "FN-replay: 0/87 unreachable — form variants of correct facts never scored",
    evidence_ref: `${evidenceRef}:1-2`,
    estimated_impact: "~14% всех ошибок",
    run: 3,
  });
  assert.equal(flagged.ok, true, `fixture finding f1 rejected: ${JSON.stringify(flagged)}`);
  const plain = recordFinding(dir, {
    theme: "behavior",
    description: "Form variants of correct facts are scored as mismatches (зампред vs заместитель)",
    evidence_ref: `${evidenceRef}#MISMATCH`,
    estimated_impact: "~5% всех ошибок",
    run: 3,
  });
  assert.equal(plain.ok, true, `fixture finding f2 rejected: ${JSON.stringify(plain)}`);
  const closing = recordFinding(dir, {
    theme: "tradeoff",
    description: "Speed-vs-recall tradeoff in the extractor",
    evidence_ref: `${evidenceRef}:1`,
    run: 3,
  });
  assert.equal(closing.ok, true, `fixture finding f3 rejected: ${JSON.stringify(closing)}`);
  const deferred = updateFinding(dir, { id: "f3", status: "deferred", note: "owner input pending" });
  assert.equal(deferred.ok, true, `fixture transition rejected: ${JSON.stringify(deferred)}`);
}

// ── Delegation harness (fake event bus, mirrors smoke.test.mjs) ──────────────

const delegationMod = await import("../extensions/pi-autoresearch/council-delegation.ts");

const NAMES = ["AnalystA", "AnalystB", "AnalystC"];
const PARTICIPANTS = [
  { name: "AnalystA", letter: "A", model: "model-a", personaPrompt: "patterns lens" },
  { name: "AnalystB", letter: "B", model: "model-b", personaPrompt: "explorer lens" },
  { name: "AnalystC", letter: "C", model: "model-c", personaPrompt: "skeptic lens" },
];
const GOOD_SLATE =
  "## EXP1: a\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: x\n\n## EXP2: b\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: y\n\n## EXP3: c\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: z";
const hypFor = (name) => "### H-" + name.slice(-1) + "1: alpha hypothesis\nEXPECTED_GAIN: 5 ms; KILL_WHEN: nothing";
const verdictsFrom = (selfName) =>
  NAMES.filter((n) => n !== selfName).map((n) => "VERDICT H-" + n.slice(-1) + "1: accept — ok").join("\n");
const selfNameOf = (task) => NAMES.find((n) => task.includes("You are " + n + " ("));

function miniPi(respond) {
  const listeners = new Map();
  const bus = {
    on(n, h) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(h); },
    emit(n, p) { for (const h of [...(listeners.get(n) ?? [])]) h(p); },
  };
  bus.on("prompt-template:subagent:request", (req) => {
    const r = respond(req);
    const payload = { requestId: req.requestId, status: r.status ?? "completed" };
    if (r.text !== undefined) payload.result = { kind: "text", text: r.text };
    bus.emit("prompt-template:subagent:response", payload);
  });
  return { events: bus };
}

const delegationArgs = (briefText, over = {}) => ({
  seq: 1,
  briefText,
  participants: PARTICIPANTS,
  chairModel: "model-chair",
  maxChallengeRounds: 5,
  minExperiments: 3,
  cwd: ".",
  deadlineAt: Date.now() + 10 * 60000,
  validate: (s) => ({ ok: (String(s).match(/##\s*EXP/gi) ?? []).length >= 3, errors: [] }),
  ...over,
});
const stdEngine = (req) => {
  const self = selfNameOf(req.task);
  if (req.nodeId.startsWith("diverge")) return { text: hypFor(self) };
  if (req.nodeId.startsWith("challenge")) return { text: verdictsFrom(self) };
  if (req.nodeId.startsWith("chair")) return { text: GOOD_SLATE };
  return { status: "failed", error: "unexpected node" };
};

// ---------------------------------------------------------------------------
// Brief with open findings
// ---------------------------------------------------------------------------

await test("brief with open findings: grouped by theme, impact, needs_verification flag, health line", () => {
  const dir = makeWorkDir("with");
  plantLedger(dir);
  const evidenceRef = plantRunOutput(dir, 3);
  plantFindings(dir, evidenceRef);

  const { text } = buildInto(dir);

  // Section + grouping headers, in FINDING_THEMES order.
  assert.ok(text.includes("## Open findings"), "brief must contain the Open findings section");
  const m = text.indexOf("### measurement (1)");
  const b = text.indexOf("### behavior (1)");
  assert.ok(m !== -1 && b !== -1, `both theme groups present: ${text.slice(text.indexOf("## Open findings"), text.indexOf("## Measurement health"))}`);
  assert.ok(m < b, "measurement group precedes behavior group (FINDING_THEMES order)");

  // Flagged finding: id, flag, impact, description, evidence — one bullet.
  assert.ok(text.includes("- f1 [needs_verification] (~14% всех ошибок) FN-replay: 0/87 unreachable"), `flagged bullet: ${text}`);
  assert.ok(text.includes("— evidence: .auto/runs/3/output.txt:1-2"), "evidence reference included");

  // Unflagged finding has no flag.
  const f2line = text.split("\n").find((l) => l.startsWith("- f2 "));
  assert.ok(f2line, "behavior finding listed");
  assert.ok(!f2line.includes("[needs_verification]"), `unflagged finding carries no flag: ${f2line}`);

  // Deferred (non-open) finding is excluded.
  assert.ok(!text.includes("- f3 ") && !text.includes("### tradeoff"), "deferred finding is not in the brief");

  // Flag explanation for analysts.
  assert.ok(text.includes("[needs_verification] states an unverified claim"), "flag meaning explained");

  // Marker absent: findings reference run 3, which is in the current segment.
  assert.ok(!text.includes("lens: not done"), "no lens marker when the segment has findings");

  // Measurement health line (same renderer as the observer's).
  assert.ok(text.includes("Measurement health:"), "health line present");
  assert.ok(text.includes("открытых measurement-находок: 1"), `open measurement count in health line: ${text}`);
  assert.ok(text.includes("~14% всех ошибок"), "top impact surfaced in health line");

  // Deterministic (smoke suite asserts brief determinism — keep it true).
  const again = buildInto(dir);
  assert.equal(again.text, text, "brief is deterministic");
});

// ---------------------------------------------------------------------------
// Old campaigns: no findings.jsonl, no .auto/runs
// ---------------------------------------------------------------------------

await test("brief without findings.jsonl (old campaign): no findings section, no marker, nothing throws", () => {
  const dir = makeWorkDir("old");
  plantLedger(dir);

  const { text } = buildInto(dir);

  assert.ok(!text.includes("## Open findings"), "no findings section without findings.jsonl");
  assert.ok(!text.includes("[needs_verification]"), "no flag anywhere");
  assert.ok(!text.includes("### measurement") && !text.includes("### behavior"), "no theme groups");
  assert.ok(!text.includes("lens: not done"), "no marker: campaign has no persisted runs to inspect");
  assert.ok(
    text.includes("Measurement health: изменений измерителя не зарегистрировано (здоровое состояние)"),
    `healthy health line: ${text}`,
  );
  for (const section of ["## Goal", "## Recent runs", "## Rules"]) {
    assert.ok(text.includes(section), `core section kept: ${section}`);
  }
});

// ---------------------------------------------------------------------------
// Result-lens marker
// ---------------------------------------------------------------------------

await test("lens: not done marker shown when runs exist but the current segment has no findings", () => {
  const dir = makeWorkDir("marker");
  plantLedger(dir);
  plantRunOutput(dir, 3);

  // (a) no findings at all.
  const { text } = buildInto(dir);
  assert.ok(text.includes("lens: not done"), "marker present without any inspection");
  assert.ok(text.includes("without reading raw results are guesses"), "marker explains the risk");
  assert.ok(!text.includes("## Open findings"), "no findings section when nothing was recorded");
  assert.ok(text.includes("## Result lens"), "marker is a visible section");

  // (b) findings exist but reference a run outside the current segment.
  const planted = recordFinding(dir, {
    theme: "capability",
    description: "Caching layer untouched so far",
    evidence_ref: ".auto/runs/3/output.txt:1",
    run: 99, // not a run of the current segment
  });
  assert.equal(planted.ok, true, `fixture finding rejected: ${JSON.stringify(planted)}`);
  const text2 = buildInto(dir).text;
  assert.ok(text2.includes("lens: not done"), "marker stays when segment has no findings");
  assert.ok(text2.includes("## Open findings") && text2.includes("- f1 "), "open findings from other segments are still listed");
});

await test("corrupt findings.jsonl degrades gracefully: no findings section, marker still by inspection state", () => {
  const dir = makeWorkDir("corrupt");
  plantLedger(dir);
  plantRunOutput(dir, 3);
  const findingsPath = path.join(dir, ".auto", "findings.jsonl");
  fs.writeFileSync(findingsPath, "{ not json\n", "utf-8");

  const { text } = buildInto(dir);
  assert.ok(!text.includes("## Open findings"), "unreadable store → no findings section");
  assert.ok(text.includes("lens: not done"), "marker reflects the (absent) inspection");
  assert.ok(text.includes("## Rules"), "brief still fully built");
});

// ---------------------------------------------------------------------------
// extractOpenFindingsSection
// ---------------------------------------------------------------------------

await test("extractOpenFindingsSection: returns the section body, null without one", () => {
  const dir = makeWorkDir("extract");
  plantLedger(dir);
  const evidenceRef = plantRunOutput(dir, 3);
  plantFindings(dir, evidenceRef);
  const { text } = buildInto(dir);

  const section = extractOpenFindingsSection(text);
  assert.ok(section, "section extracted from a findings brief");
  assert.ok(section.includes("### measurement (1)") && section.includes("- f1 [needs_verification]"), `body content: ${section}`);
  assert.ok(!section.includes("## Measurement health"), "stops at the next section header");
  assert.ok(!section.startsWith("## Open findings"), "header line excluded");

  const oldDir = makeWorkDir("extract-old");
  plantLedger(oldDir);
  const oldBrief = buildBrief(oldDir, path.join(oldDir, ".auto", "councils", "1"), BRIEF_INPUT);
  assert.equal(extractOpenFindingsSection(oldBrief.text), null, "null when the brief has no findings section");
  assert.equal(extractOpenFindingsSection(""), null, "empty brief → null");
});

// ---------------------------------------------------------------------------
// Challenge phase receives findings as input
// ---------------------------------------------------------------------------

await test("council-delegation: challenge tasks carry the open findings with the flag highlighted", async () => {
  const dir = makeWorkDir("deleg");
  plantLedger(dir);
  const evidenceRef = plantRunOutput(dir, 3);
  plantFindings(dir, evidenceRef);
  const briefText = buildInto(dir).text;

  const requests = [];
  const pi = miniPi((req) => { requests.push(req); return stdEngine(req); });
  const out = await delegationMod.runCouncilDelegated(pi, delegationArgs(briefText));
  assert.equal(out.ok, true, `pipeline ok: ${JSON.stringify(out).slice(0, 200)}`);

  const challenge = requests.filter((r) => r.nodeId.startsWith("challenge"));
  assert.equal(challenge.length, 3, "one challenge task per analyst");
  for (const r of challenge) {
    assert.ok(r.task.includes("=== OPEN FINDINGS"), `challenge input block present: ${r.task.slice(0, 400)}`);
    assert.ok(r.task.includes("[needs_verification] marks a claim NOT yet independently verified"), "flag meaning highlighted");
    assert.ok(r.task.includes("- f1 [needs_verification]"), "flagged finding relayed");
    assert.ok(r.task.includes("The analysts' proposals follow"), "proposals still included");
  }
  // Diverge and chair see the section via the brief itself.
  assert.ok(
    requests.filter((r) => r.nodeId.startsWith("diverge")).every((r) => r.task.includes("- f1 [needs_verification]")),
    "diverge tasks carry the brief with findings",
  );
  const chair = requests.find((r) => r.nodeId.startsWith("chair"));
  assert.ok(chair && chair.task.includes("- f1 [needs_verification]"), "chair sees the findings via the brief");
});

await test("council-delegation: no findings block in challenge tasks when the brief has none (old campaign)", async () => {
  const dir = makeWorkDir("deleg-old");
  plantLedger(dir);
  const briefText = buildInto(dir).text;
  assert.equal(extractOpenFindingsSection(briefText), null);

  const requests = [];
  const pi = miniPi((req) => { requests.push(req); return stdEngine(req); });
  const out = await delegationMod.runCouncilDelegated(pi, delegationArgs(briefText));
  assert.equal(out.ok, true, "pipeline ok without findings");
  const challenge = requests.filter((r) => r.nodeId.startsWith("challenge"));
  assert.equal(challenge.length, 3);
  for (const r of challenge) {
    assert.ok(!r.task.includes("OPEN FINDINGS"), "no findings block without findings");
    assert.ok(r.task.includes("The analysts' proposals follow"), "challenge task unchanged otherwise");
  }
});
