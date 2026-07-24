import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  checkFinalize,
  checkFloor,
  computeState,
  DEFAULT_OBSERVER_CONFIG,
  markIdeaTried,
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

const NO_IDEAS = "/dev/null"; // non-existent path → untriedIdeas always 0

// Helper: create a .auto/ideas/ directory with N .md files
function makeIdeasDir(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
  const ideasDir = path.join(dir, "ideas");
  fs.mkdirSync(ideasDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(ideasDir, `idea-${i + 1}.md`), `# Idea ${i + 1}\n\nThis is idea number ${i + 1} to try out.\n`);
  }
  return ideasDir;
}

// ── checkFinalize: basic confidence thresholds ──────────────────────────────

test("checkFinalize: no finalize entry → null", () => {
  const entries = [keepRun(90, 1), discardRun(95, 2)];
  const state = computeState(
    entries.filter((e) => typeof e.run === "number").map((e) => ({ ...e, commit: "", metrics: {}, segment: 0, confidence: null, asi: {} })),
    "lower",
  );
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.equal(result, null);
});

test("checkFinalize: strong confidence (>0.8) → strong recommendation", () => {
  const entries = [finalizeEntry(0.95, "architectural floor reached")];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.ok(result, "should return a steer");
  assert.match(result, /FINALIZE SIGNAL.*95%/);
  assert.match(result, /Strongly recommended/);
});

test("checkFinalize: advisory confidence (>0.5, <=0.8) → advisory steer", () => {
  const entries = [finalizeEntry(0.6)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.ok(result);
  assert.match(result, /Consider whether/);
});

test("checkFinalize: low confidence (<=0.5) → null", () => {
  const entries = [finalizeEntry(0.3)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.equal(result, null);
});

// ── Stale detection: improvements after finalize → suppressed ───────────────

test("STALE DETECTION: improvement after finalize → null", () => {
  const entries = [
    finalizeEntry(0.95),
    { run: 1, status: "keep", metric: 80, description: "found an improvement", timestamp: 2 },
  ];
  const state = { streak: 0, improvements: 1, best: 80, recent: [], impHistory: [80], recentMetrics: [80] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.equal(result, null, "improvement after finalize → stale → null");
});

test("STALE DETECTION: last finalize entry governs (not earlier ones)", () => {
  const entries = [
    finalizeEntry(0.9, "first attempt"),
    { run: 1, status: "keep", metric: 80, description: "gain after first finalize", timestamp: 1 },
    finalizeEntry(0.95, "second attempt, still valid"),
  ];
  const state = { streak: 0, improvements: 1, best: 80, recent: [], impHistory: [80], recentMetrics: [80] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.ok(result, "the LAST finalize entry governs — no runs after it → fires");
  assert.match(result, /95%/);
});

// ── Untried-ideas: simplify (not suppress) ────────────────────────────────────

test("UNTRIED IDEAS: >=2 ideas → simplify to nudge (even with 0 runs after finalize)", () => {
  const ideasDir = makeIdeasDir(3);
  const entries = [finalizeEntry(0.95, "floor reached")];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasDir);
  assert.ok(result, "should return a nudge, not null");
  assert.match(result, /3 untried ideas remain/);
  assert.doesNotMatch(result, /FINALIZE SIGNAL.*Strongly recommended/);
});

test("UNTRIED IDEAS: >=2 ideas + runs after → null (anti-nagging takes priority)", () => {
  const ideasDir = makeIdeasDir(2);
  const entries = [
    finalizeEntry(0.9),
    discardRun(100, 1),
    discardRun(100, 2),
    discardRun(100, 3),
  ];
  const state = { streak: 3, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [100, 100, 100] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasDir);
  assert.equal(result, null, "should be null — anti-nagging suppresses finalize after agent continued");
});

test("UNTRIED IDEAS: 1 idea → full finalize block (threshold is >=2)", () => {
  const ideasDir = makeIdeasDir(1);
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasDir);
  assert.match(result, /FINALIZE SIGNAL.*95%/);
  assert.match(result, /Strongly recommended/);
});

// ── Anti-nagging: finalize goes quiet after agent continued working ──────────

test("ANTI-NAGGING: 0 runs after finalize → fires (just called, observer can surface)", () => {
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.ok(result, "with 0 runs after, finalize should fire as fallback");
  assert.match(result, /95%/);
});

test("ANTI-NAGGING: 1 run after finalize → null (tool steer was enough)", () => {
  const entries = [
    finalizeEntry(0.95),
    discardRun(100, 1),
  ];
  const state = { streak: 1, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [100] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, NO_IDEAS);
  assert.equal(result, null, "1+ runs after finalize → null (don't nag)");
});

// ── checkFloor: untried-ideas guard ──────────────────────────────────────────

function makeFloorState(streak, best) {
  const metrics = Array(streak).fill(best);
  return {
    streak,
    improvements: 0,
    best,
    recent: [],
    impHistory: [],
    recentMetrics: metrics,
  };
}

function makeFloorPayload(cwd, unit = "\u00b5s") {
  return {
    workDir: cwd,
    direction: "lower",
    metricName: "total_\u00b5s",
    metricUnit: unit,
    bestMetric: 100,
    segment: 0,
  };
}

test("CHECK FLOOR: >=2 untried ideas → downgrade to nudge (don't claim limit)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-floor-"));
  // Create .auto/ideas/ with 3 idea files
  const ideasDir = path.join(dir, ".auto", "ideas");
  fs.mkdirSync(ideasDir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(ideasDir, `idea-${i + 1}.md`), `Idea ${i + 1} to try out`);
  }

  const state = makeFloorState(15, 100);
  const asi = { floor: false, profiled: false, noise: false, exhausted: false };
  const payload = makeFloorPayload(dir);
  const result = checkFloor(state, asi, payload, dir, DEFAULT_OBSERVER_CONFIG);
  assert.ok(result, "should return a nudge");
  assert.match(result, /3 untried ideas remain/);
  assert.doesNotMatch(result, /FLOOR DETECTED/);
});

test("CHECK FLOOR: 0 untried ideas → full floor block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-floor-"));
  // No ideas directory → 0 untried ideas
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });

  const state = makeFloorState(15, 100);
  const asi = { floor: false, profiled: false, noise: false, exhausted: false };
  const payload = makeFloorPayload(dir);
  const result = checkFloor(state, asi, payload, dir, DEFAULT_OBSERVER_CONFIG);
  assert.ok(result);
  assert.match(result, /FLOOR DETECTED/);
});

// ── markIdeaTried: file-per-idea auto-removal ───────────────────────────────

test("markIdeaTried: removes the correct idea file", () => {
  const ideasDir = makeIdeasDir(3);
  const removed = markIdeaTried(ideasDir, "idea-2");
  assert.equal(removed, true);
  const remaining = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes("idea-1.md"));
  assert.ok(!remaining.includes("idea-2.md"), "idea-2.md should be deleted");
  assert.ok(remaining.includes("idea-3.md"));
});

test("markIdeaTried: accepts filename with .md extension", () => {
  const ideasDir = makeIdeasDir(2);
  const removed = markIdeaTried(ideasDir, "idea-1.md");
  assert.equal(removed, true);
  const remaining = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
  assert.equal(remaining.length, 1);
  assert.ok(!remaining.includes("idea-1.md"));
});

test("markIdeaTried: returns false for non-existent idea", () => {
  const ideasDir = makeIdeasDir(2);
  const removed = markIdeaTried(ideasDir, "nonexistent");
  assert.equal(removed, false);
  // Files unchanged
  assert.equal(fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md")).length, 2);
});

test("markIdeaTried: returns false for non-existent directory", () => {
  const removed = markIdeaTried("/nonexistent/path/ideas", "some-idea");
  assert.equal(removed, false);
});

test("markIdeaTried: after removal, countUntriedIdeas reflects it", () => {
  const ideasDir = makeIdeasDir(3);
  markIdeaTried(ideasDir, "idea-2");
  // checkFinalize should see only 2 untried now
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasDir);
  assert.ok(result);
  assert.match(result, /2 untried ideas remain/);
});

test("FILE-PER-IDEA: multi-line content works correctly", () => {
  // Ideas with rich content (multi-line, code blocks, etc.)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-multi-"));
  const ideasDir = path.join(dir, "ideas");
  fs.mkdirSync(ideasDir, { recursive: true });
  fs.writeFileSync(
    path.join(ideasDir, "cache-ast.md"),
    "# Cache AST Nodes\n\nStore the AST in a WeakMap keyed by source hash.\n\n```js\nconst cache = new WeakMap();\n```\n\nThis could save ~30% on re-parses.",
  );
  fs.writeFileSync(
    path.join(ideasDir, "bit-packed.md"),
    "# Bit-Packed Representation\n\nUse Uint8Array instead of number[].\n\n   - Saves memory\n   - Faster access\n   - Cache-friendly",
  );

  // Should count 2 ideas
  const entries = [finalizeEntry(0.95)];
  const state = { streak: 0, improvements: 0, best: 100, recent: [], impHistory: [], recentMetrics: [] };
  const result = checkFinalize(entries, DEFAULT_OBSERVER_CONFIG, state, ideasDir);
  assert.ok(result);
  assert.match(result, /2 untried ideas remain/);

  // Remove one
  markIdeaTried(ideasDir, "cache-ast");
  const remaining = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0], "bit-packed.md");
});
