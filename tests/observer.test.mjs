import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  checkFinalize,
  computeState,
  DEFAULT_OBSERVER_CONFIG,
} from "../extensions/pi-autoresearch/observer.ts";

// Helper: a "keep" run entry that improved the metric (lower is better)
function keepRun(metric, runNum) {
  return { run: runNum, status: "keep", metric, description: "improvement", timestamp: Date.now() };
}

// Helper: a "discard" run entry
function discardRun(metric, runNum) {
  return { run: runNum, status: "discard", metric, description: "no gain", timestamp: Date.now() };
}

function finalizeEntry(confidence, reason = "floor reached") {
  return { type: "finalize", reason, confidence, best_metric: 100, run_count: 5, timestamp: Date.now() };
}

const IDEAS = "/dev/null"; // non-existent path → untriedIdeas always 0

test("checkFinalize: no finalize entry → null", () => {
  const entries = [keepRun(90, 1), discardRun(95, 2)];
  const state = computeState(
    entries.filter((e) => typeof e.run === "number").map((e) => ({ ...e, commit: "", metrics: {}, segment: 0, confidence: null, asi: {} })),
    "lower",
  );
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.equal(result, null);
});

test("checkFinalize: strong confidence (>0.8) → strong recommendation", () => {
  const entries = [finalizeEntry(0.95, "architectural floor reached")];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.ok(result, "should return a steer");
  assert.match(result, /FINALIZE SIGNAL.*95%/);
  assert.match(result, /Strongly recommended/);
});

test("checkFinalize: advisory confidence (>0.5, <=0.8) → advisory steer", () => {
  const entries = [finalizeEntry(0.6)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.ok(result);
  assert.match(result, /FINALIZE SIGNAL.*60%/);
  assert.match(result, /Consider whether/);
});

test("checkFinalize: low confidence (<=0.5) → null", () => {
  const entries = [finalizeEntry(0.3)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.equal(result, null);
});

test("STALE DETECTION: improvement after finalize → suppressed (null)", () => {
  // Agent called finalize at entry 2, then found a keep improvement at entry 3.
  // The finalize claim "no more improvements" was premature → suppress.
  const entries = [
    { run: 1, status: "keep", metric: 100, description: "baseline-ish", timestamp: 1 },
    finalizeEntry(0.95, "floor reached"),
    { run: 2, status: "keep", metric: 90, description: "found a gain!", timestamp: 2 },
  ];
  const state = { streak: 0, improvements: 1, best: 90, recent: [], impHistory: [90], recentMetrics: [90] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.equal(result, null, "finalize should be suppressed when improvements found after it");
});

test("STALE DETECTION: only discards after finalize → still fires (claim not yet disproven)", () => {
  const entries = [
    finalizeEntry(0.95, "floor reached"),
    discardRun(100, 1),
    discardRun(100, 2),
  ];
  const state = { streak: 2, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [100, 100] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.ok(result, "finalize should fire when no improvements after it");
  assert.match(result, /FINALIZE SIGNAL.*95%/);
});

test("STALE DETECTION: last finalize entry matters, not earlier ones", () => {
  // First finalize (stale, improvements after), then a second finalize (current).
  const entries = [
    finalizeEntry(0.9, "first attempt"),
    { run: 1, status: "keep", metric: 80, description: "gain after first finalize", timestamp: 1 },
    finalizeEntry(0.95, "second attempt, still valid"),
  ];
  const state = { streak: 0, improvements: 1, best: 80, recent: [], impHistory: [80], recentMetrics: [80] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, IDEAS);
  assert.ok(result, "the LAST finalize entry governs — no runs after it → fires");
  assert.match(result, /95%/);
});

// ── Untried-ideas: simplify (not suppress) ────────────────────────────────────

function makeIdeasFile(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
  const ideasPath = path.join(dir, "ideas.md");
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`- Idea number ${i + 1} to try out`);
  // Add a struck-through (tried) idea that should NOT count
  lines.push("- ~~This one was tried already~~");
  fs.writeFileSync(ideasPath, lines.join("\n") + "\n");
  return ideasPath;
}

test("UNTRIED IDEAS: >=2 ideas → simplify to nudge (even with 0 runs after finalize)", () => {
  const ideasPath = makeIdeasFile(3);
  const entries = [finalizeEntry(0.95, "floor reached")];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasPath);
  assert.ok(result, "should return a nudge, not null");
  assert.match(result, /3 untried ideas remain/);
  assert.doesNotMatch(result, /FINALIZE SIGNAL.*Strongly recommended/);
});

test("UNTRIED IDEAS: >=2 ideas + runs after → nudge mentions run count", () => {
  const ideasPath = makeIdeasFile(2);
  const entries = [
    finalizeEntry(0.9),
    discardRun(100, 1),
    discardRun(100, 2),
    discardRun(100, 3),
  ];
  const state = { streak: 3, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [100, 100, 100] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasPath);
  assert.ok(result);
  assert.match(result, /3 runs attempted since/);
});

test("UNTRIED IDEAS: 1 idea → full finalize block (threshold is >=2)", () => {
  const ideasPath = makeIdeasFile(1);
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasPath);
  assert.match(result, /FINALIZE SIGNAL.*95%/);
  assert.match(result, /Strongly recommended/);
});

test("UNTRIED IDEAS: struck-through ideas don't count", () => {
  // makeIdeasFile adds 1 struck-through line; with count=1 total real = 1
  const ideasPath = makeIdeasFile(1);
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasPath);
  // Only 1 real idea → full block, not nudge
  assert.match(result, /Strongly recommended/);
});
