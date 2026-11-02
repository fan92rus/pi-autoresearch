/**
 * Observer nudges + measurement health (openspec add-result-reflection,
 * task 1.7; spec findings/spec.md "Нуджи observer'а на инспекцию результатов"
 * and "Секции находок в брифе совета" — Measurement health line).
 *
 * Covers:
 *  - measurement.ts: ledger fold (measurement_change records, epochs), the
 *    four-field summary (epoch, floor_stale, open_measurement_count,
 *    top_impact), the single disk entry point measurementHealthSummary(workDir)
 *    and the rendering: all four field names are always present, the healthy
 *    state adds the annotation «изменений измерителя не зарегистрировано
 *    (здоровое состояние)» instead of replacing the fields;
 *  - observer.ts: the reflection-checkpoint lens item (suppressed once findings
 *    reference the current segment), the stagnation inspection requirement
 *    before the council hint, and the Measurement health line in the periodic
 *    messages (reflection checkpoint + progress milestone);
 *  - compat: campaigns without findings and old campaigns without .auto/runs
 *    are never nudged and keep working unchanged.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/observer-lens.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkProgress,
  checkReflection,
  checkStagnation,
  DEFAULT_OBSERVER_CONFIG,
  findingTargetsSegment,
  runObserver,
} from "../extensions/pi-autoresearch/observer.ts";
import {
  formatMeasurementHealth,
  measurementHealthFromFacts,
  measurementHealthSummary,
  measurementLedgerFacts,
  measurementLedgerPath,
} from "../extensions/pi-autoresearch/measurement.ts";
import { recordFinding } from "../extensions/pi-autoresearch/findings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-obs-lens-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLedger(workDir, entries) {
  fs.mkdirSync(path.join(workDir, ".auto"), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  fs.writeFileSync(path.join(workDir, ".auto", "log.jsonl"), lines.join("\n") + "\n", "utf-8");
}

function configEntry() {
  return { type: "config", name: "lens-test", metricName: "ms", metricUnit: "ms", bestDirection: "lower" };
}

function runEntry(run, status, metric) {
  return { run, status, metric, description: status === "keep" ? "improvement" : "no gain", timestamp: run };
}

/** Reflection-checkpoint campaign: 6 improving keeps (runs 1–6) + 4 discards → decidedRuns = 10. */
function reflectionCampaign(workDir) {
  const entries = [configEntry()];
  for (let run = 1; run <= 6; run++) entries.push(runEntry(run, "keep", 100 - 5 * (run - 1)));
  for (let run = 7; run <= 10; run++) entries.push(runEntry(run, "discard", 76));
  writeLedger(workDir, entries);
}

/** Stagnation campaign: 1 keep then 5 discards → streak = 5. */
function stagnationCampaign(workDir) {
  const entries = [configEntry(), runEntry(1, "keep", 100)];
  for (let run = 2; run <= 6; run++) entries.push(runEntry(run, "discard", 101));
  writeLedger(workDir, entries);
}

function payload(cwd) {
  return {
    cwd,
    direction: "lower",
    metricName: "ms",
    metricUnit: "ms",
    baselineMetric: 100,
    bestMetric: 75,
    runCount: 10,
    goal: "make it faster",
  };
}

/** Creates .auto/runs/<run>/output.txt (also makes .auto/runs itself exist). */
function writeRunOutput(workDir, run, text = "METRIC ms=76\nsome output line\n") {
  const abs = path.join(workDir, ".auto", "runs", String(run), "output.txt");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf-8");
  return `.auto/runs/${run}/output.txt`;
}

async function addFinding(workDir, { theme, description, evidenceRef, run, impact }) {
  const result = recordFinding(
    workDir,
    {
      theme,
      description,
      evidence_ref: evidenceRef,
      ...(run !== undefined ? { run } : {}),
      ...(impact !== undefined ? { estimated_impact: impact } : {}),
    },
    FIXED_NOW,
  );
  assert.equal(result.ok, true, `fixture finding must be accepted: ${JSON.stringify(result)}`);
}

function findingsState(views) {
  return { findings: new Map(views.map((v) => [v.id, v])), nextId: "f999" };
}

function view(id, theme, status, estimated_impact) {
  return {
    id,
    theme,
    status,
    description: "desc",
    evidence_ref: "x:1-1",
    needs_verification: false,
    created: "2026-11-02T03:00:00.000Z",
    ...(estimated_impact !== undefined ? { estimated_impact } : {}),
  };
}

const FACTS_HEALTHY = { epoch: 1, measurement_change_count: 0, floor_stale: false };

// ---------------------------------------------------------------------------
// measurement.ts — ledger fold
// ---------------------------------------------------------------------------

test("measurementLedgerFacts: empty text → epoch 1, no changes, floor fresh", () => {
  assert.deepEqual(measurementLedgerFacts(""), { epoch: 1, measurement_change_count: 0, floor_stale: false });
});

test("measurementLedgerFacts: entries without epoch stay in epoch 1; epochs fold to the max", () => {
  const facts = measurementLedgerFacts(
    [
      JSON.stringify(configEntry()),
      JSON.stringify(runEntry(1, "keep", 100)),
      JSON.stringify({ run: 2, status: "keep", metric: 90, epoch: 3 }),
      "not json at all",
    ].join("\n"),
  );
  assert.equal(facts.epoch, 3);
  assert.equal(facts.measurement_change_count, 0);
  assert.equal(facts.floor_stale, false);
});

test("measurementLedgerFacts: measurement_change records count and stale the floor", () => {
  const facts = measurementLedgerFacts(
    [
      JSON.stringify(configEntry()),
      JSON.stringify(runEntry(1, "keep", 100)),
      JSON.stringify({ type: "measurement_change", epoch: 2, diff_ref: "d.diff", rescore_ref: "r.md", needs_verification: true }),
      JSON.stringify({ type: "measurement_change_completed", change_ref: "e2", epoch: 2 }),
      JSON.stringify({ run: 2, status: "keep", metric: 90, epoch: 2 }),
    ].join("\n"),
  );
  assert.equal(facts.epoch, 2);
  assert.equal(facts.measurement_change_count, 1);
  assert.equal(facts.floor_stale, true);
});

// ---------------------------------------------------------------------------
// measurement.ts — summary fields (spec: the four fields)
// ---------------------------------------------------------------------------

test("measurementHealthFromFacts: no findings → zeros and null impact", () => {
  assert.deepEqual(
    measurementHealthFromFacts(FACTS_HEALTHY, findingsState([])),
    { epoch: 1, floor_stale: false, open_measurement_count: 0, top_impact: null },
  );
  assert.deepEqual(
    measurementHealthFromFacts(FACTS_HEALTHY, null),
    { epoch: 1, floor_stale: false, open_measurement_count: 0, top_impact: null },
  );
});

test("measurementHealthFromFacts: only OPEN measurement findings count; top_impact is the largest percent", () => {
  const state = findingsState([
    view("f1", "measurement", "open", "~3% всех ошибок"),
    view("f2", "measurement", "open", "~14% всех ошибок"),
    view("f3", "measurement", "verified", "~99% всех ошибок"), // not open
    view("f4", "behavior", "open", "~50% всех ошибок"), // wrong theme
    view("f5", "measurement", "deferred", "~7% всех ошибок"),
  ]);
  assert.deepEqual(measurementHealthFromFacts({ epoch: 2, measurement_change_count: 1, floor_stale: true }, state), {
    epoch: 2,
    floor_stale: true,
    open_measurement_count: 2,
    top_impact: "~14% всех ошибок",
  });
});

test("measurementHealthFromFacts: unparseable impacts keep file order; missing impact ignored", () => {
  const state = findingsState([
    view("f1", "measurement", "open"), // no impact
    view("f2", "measurement", "open", "заметно замедляет"),
    view("f3", "measurement", "open", "0/87 случаев"),
  ]);
  const summary = measurementHealthFromFacts(FACTS_HEALTHY, state);
  assert.equal(summary.open_measurement_count, 3); // all three are open measurement findings
  assert.equal(summary.top_impact, "заметно замедляет"); // first unparseable string wins over later unparseable ones
});

// ---------------------------------------------------------------------------
// measurement.ts — disk entry point + rendering
// ---------------------------------------------------------------------------

test("measurementHealthSummary: folds ledger + findings from disk", async () => {
  const workDir = makeWorkDir("summary");
  writeLedger(workDir, [
    configEntry(),
    runEntry(1, "keep", 100),
    { type: "measurement_change", epoch: 2, diff_ref: ".auto/measurement/e2.diff", rescore_ref: ".auto/measurement/e2/rescore.md", justification: "finding f1", needs_verification: true },
    { run: 2, status: "keep", metric: 90, epoch: 2 },
  ]);
  const evidence = writeRunOutput(workDir, 2);
  await addFinding(workDir, { theme: "measurement", description: "scorer double-penalises", evidenceRef: `${evidence}:1-1`, run: 2, impact: "~14% всех ошибок" });
  await addFinding(workDir, { theme: "measurement", description: "timeout counts as zero", evidenceRef: `${evidence}:2-2`, run: 2, impact: "~3% прогонов" });

  const summary = measurementHealthSummary(workDir);
  assert.deepEqual(summary, { epoch: 2, floor_stale: true, open_measurement_count: 2, top_impact: "~14% всех ошибок" });

  const line = formatMeasurementHealth(summary);
  assert.match(line, /^Measurement health: /);
  assert.match(line, /\bepoch 2\b/);
  assert.match(line, /\bfloor_stale: да/);
  assert.match(line, /открытых measurement-находок: 2 \(open_measurement_count: 2\)/);
  assert.match(line, /\btop_impact: ~14% всех ошибок/);
});

test("measurementHealthSummary: mixed layout (.auto/config.json + legacy autoresearch.jsonl) reads the same ledger as observer/council (review N2)", () => {
  const workDir = makeWorkDir("summary-mixed");
  // Current layout marker without a current ledger: sessionFilePath would pick
  // the missing .auto/log.jsonl, but observer.ts/council.ts fall back to the legacy file.
  fs.mkdirSync(path.join(workDir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(workDir, ".auto", "config.json"), "{}\n", "utf-8");
  fs.writeFileSync(
    path.join(workDir, "autoresearch.jsonl"),
    [
      JSON.stringify(configEntry()),
      JSON.stringify(runEntry(1, "keep", 100)),
      JSON.stringify({ type: "measurement_change", epoch: 2, diff_ref: "d.diff", rescore_ref: "r.md", needs_verification: true }),
      JSON.stringify({ run: 2, status: "keep", metric: 90, epoch: 2 }),
    ].join("\n") + "\n",
    "utf-8",
  );

  assert.equal(measurementLedgerPath(workDir), path.join(workDir, "autoresearch.jsonl"));
  const summary = measurementHealthSummary(workDir);
  assert.deepEqual(summary, { epoch: 2, floor_stale: true, open_measurement_count: 0, top_impact: null });
  const line = formatMeasurementHealth(summary);
  assert.match(line, /\bepoch 2\b/);
  assert.match(line, /\bfloor_stale: да/);
  assert.doesNotMatch(line, /здоровое состояние/);
});

test("measurementHealthSummary: empty workDir → healthy defaults (old campaign compat)", () => {
  const workDir = makeWorkDir("empty");
  const summary = measurementHealthSummary(workDir);
  assert.deepEqual(summary, { epoch: 1, floor_stale: false, open_measurement_count: 0, top_impact: null });
  assert.match(formatMeasurementHealth(summary), /Measurement health: изменений измерителя не зарегистрировано \(здоровое состояние\)/);
});

test("formatMeasurementHealth: healthy state with no findings shows all four field names (review B2)", () => {
  const line = formatMeasurementHealth(measurementHealthFromFacts(FACTS_HEALTHY, findingsState([])));
  assert.match(line, /\bepoch\b/);
  assert.match(line, /\bfloor_stale\b/);
  assert.match(line, /\bopen_measurement_count\b/);
  assert.match(line, /\btop_impact\b/);
  // The healthy phrase is an annotation on top of the fields, not a replacement.
  assert.match(line, /изменений измерителя не зарегистрировано \(здоровое состояние\)/);
});

test("formatMeasurementHealth: healthy state with open findings keeps the annotation and all four fields", () => {
  const line = formatMeasurementHealth(
    measurementHealthFromFacts(FACTS_HEALTHY, findingsState([view("f1", "measurement", "open", "~5% прогонов")])),
  );
  assert.match(line, /изменений измерителя не зарегистрировано \(здоровое состояние\)/);
  assert.match(line, /\bepoch 1\b/);
  assert.match(line, /\bfloor_stale: нет/);
  assert.match(line, /open_measurement_count: 1/);
  assert.match(line, /\btop_impact: ~5% прогонов/);
});

// ---------------------------------------------------------------------------
// observer.ts — checkReflection (lens item + health line)
// ---------------------------------------------------------------------------

function reflectionState() {
  return {
    streak: 4,
    improvements: 6,
    best: 75,
    recent: [],
    impHistory: [100, 95, 90, 85, 80, 75],
    recentMetrics: [76, 76, 76, 76],
    runsSinceBestImprovement: 4,
  };
}

test("checkReflection: checkpoint fires at decidedRuns multiple of the interval", () => {
  const steer = checkReflection(reflectionState(), payload("/dev/null"), DEFAULT_OBSERVER_CONFIG);
  assert.ok(steer);
  assert.match(steer, /REFLECTION CHECKPOINT \(10 decided runs/);
});

test("checkReflection: no checkpoint → null even with lens context", () => {
  const state = { ...reflectionState(), streak: 3 };
  assert.equal(checkReflection(state, payload("/dev/null"), DEFAULT_OBSERVER_CONFIG, { lensDone: false }), null);
});

test("checkReflection: lens nudge present by default (no findings for the segment)", () => {
  const steer = checkReflection(reflectionState(), payload("/dev/null"), DEFAULT_OBSERVER_CONFIG);
  assert.match(steer, /RESULT LENS/);
  assert.match(steer, /inspect_results/);
  assert.match(steer, /record_finding/);
});

test("checkReflection: lens nudge suppressed when the segment already has findings (spec scenario)", () => {
  const steer = checkReflection(reflectionState(), payload("/dev/null"), DEFAULT_OBSERVER_CONFIG, { lensDone: true });
  assert.ok(steer);
  assert.doesNotMatch(steer, /RESULT LENS/);
  assert.doesNotMatch(steer, /inspect_results/);
});

test("checkReflection: measurement health line appended; absent without context", () => {
  const withLine = checkReflection(reflectionState(), payload("/dev/null"), DEFAULT_OBSERVER_CONFIG, {
    lensDone: true,
    measurementHealth: "Measurement health: изменений измерителя не зарегистрировано (здоровое состояние)",
  });
  assert.match(withLine, /Measurement health: изменений измерителя не зарегистрировано/);

  const without = checkReflection(reflectionState(), payload("/dev/null"), DEFAULT_OBSERVER_CONFIG, { lensDone: true });
  assert.doesNotMatch(without, /Measurement health/);
});

// ---------------------------------------------------------------------------
// observer.ts — checkProgress (health line in the periodic milestone)
// ---------------------------------------------------------------------------

function progressState() {
  return {
    streak: 0,
    improvements: 5,
    best: 75,
    recent: [],
    impHistory: [100, 95, 90, 85, 75],
    recentMetrics: [100, 95, 90, 85, 75],
    runsSinceBestImprovement: 0,
  };
}

test("checkProgress: measurement health line present with context, absent without", () => {
  const dir = makeWorkDir("progress");
  const withLine = checkProgress(progressState(), payload(dir), dir, DEFAULT_OBSERVER_CONFIG, {
    measurementHealth: "Measurement health: изменений измерителя не зарегистрировано (здоровое состояние)",
  });
  assert.ok(withLine);
  assert.match(withLine, /MILESTONE: 5 improvements made/);
  assert.match(withLine, /Measurement health: изменений измерителя не зарегистрировано/);

  const without = checkProgress(progressState(), payload(dir), dir, DEFAULT_OBSERVER_CONFIG);
  assert.ok(without);
  assert.doesNotMatch(without, /Measurement health/);
});

// ---------------------------------------------------------------------------
// observer.ts — checkStagnation (inspection required before the council)
// ---------------------------------------------------------------------------

function stagnationState() {
  const recent = [1, 2, 3, 4, 5].map((i) => ({
    run: i,
    status: "discard",
    metric: 101,
    description: "no gain",
    asi: undefined,
  }));
  return {
    streak: 5,
    improvements: 1,
    best: 100,
    recent,
    impHistory: [100],
    recentMetrics: [101, 101, 101, 101, 101],
    runsSinceBestImprovement: 5,
  };
}

const STAG_ASI = { floor: false, profiled: false, noise: false, exhausted: false };

test("checkStagnation: inspection required before the council when the segment has no findings", () => {
  const dir = makeWorkDir("stag");
  const steer = checkStagnation(stagnationState(), STAG_ASI, payload(dir), dir, DEFAULT_OBSERVER_CONFIG);
  assert.ok(steer);
  assert.match(steer, /STAGNATION: No metric improvement in 5 runs/);
  assert.match(steer, /RESULT LENS/);
  assert.match(steer, /inspect_results/);
  assert.match(steer, /record_finding/);
  assert.ok(steer.indexOf("RESULT LENS") < steer.indexOf("COUNCIL"), "lens requirement must precede the council hint");
});

test("checkStagnation: measurement health line present with context, absent without", () => {
  const dir = makeWorkDir("stag-health");
  const withLine = checkStagnation(stagnationState(), STAG_ASI, payload(dir), dir, DEFAULT_OBSERVER_CONFIG, {
    lensDone: true,
    measurementHealth: formatMeasurementHealth(
      measurementHealthFromFacts({ epoch: 2, measurement_change_count: 1, floor_stale: true }, findingsState([])),
    ),
  });
  assert.match(withLine, /Measurement health: epoch 2; floor_stale: да; открытых measurement-находок: 0/);
  assert.ok(withLine.indexOf("Measurement health") < withLine.indexOf("COUNCIL"), "health line precedes the council hint");

  const without = checkStagnation(stagnationState(), STAG_ASI, payload(dir), dir, DEFAULT_OBSERVER_CONFIG, { lensDone: true });
  assert.doesNotMatch(without, /Measurement health/);
});

test("checkStagnation: lens requirement suppressed when inspection is done for the segment", () => {
  const dir = makeWorkDir("stag-done");
  const steer = checkStagnation(stagnationState(), STAG_ASI, payload(dir), dir, DEFAULT_OBSERVER_CONFIG, { lensDone: true });
  assert.ok(steer);
  assert.match(steer, /COUNCIL/);
  assert.doesNotMatch(steer, /RESULT LENS/);
});

// ---------------------------------------------------------------------------
// observer.ts — findingTargetsSegment (review B1: segment binding via evidence)
// ---------------------------------------------------------------------------

function findingWith(run, evidence_ref) {
  return { ...view("f1", "behavior", "open"), ...(run !== undefined ? { run } : {}), evidence_ref };
}

const SEGMENT_RUNS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

test("findingTargetsSegment: run field inside the segment", () => {
  assert.equal(findingTargetsSegment(findingWith(2, "elsewhere:1-1"), SEGMENT_RUNS), true);
});

test("findingTargetsSegment: no run, evidence path inside the segment (review B1)", () => {
  assert.equal(findingTargetsSegment(findingWith(undefined, ".auto/runs/2/output.txt:1-2"), SEGMENT_RUNS), true);
});

test("findingTargetsSegment: leading ./ in evidence_ref is normalized before matching (review N1)", () => {
  assert.equal(findingTargetsSegment(findingWith(undefined, "./.auto/runs/2/output.txt:1-2"), SEGMENT_RUNS), true);
  assert.equal(findingTargetsSegment(findingWith(undefined, ".\\.auto\\runs\\2\\output.txt:1-2"), SEGMENT_RUNS), true);
  assert.equal(findingTargetsSegment(findingWith(undefined, "./.auto/runs/999/output.txt:1-2"), SEGMENT_RUNS), false);
});

test("findingTargetsSegment: no run, evidence path in another run", () => {
  assert.equal(findingTargetsSegment(findingWith(undefined, ".auto/runs/999/output.txt:1-1"), SEGMENT_RUNS), false);
});

test("findingTargetsSegment: evidence_ref with backslashes is normalized before matching", () => {
  assert.equal(findingTargetsSegment(findingWith(undefined, ".auto\\runs\\2\\output.txt:1-2"), SEGMENT_RUNS), true);
  assert.equal(findingTargetsSegment(findingWith(undefined, ".auto\\runs\\999\\output.txt:1-2"), SEGMENT_RUNS), false);
});

test("findingTargetsSegment: run field wins over out-of-segment evidence, unrelated evidence never matches", () => {
  assert.equal(findingTargetsSegment(findingWith(2, ".auto/runs/999/output.txt:1-1"), SEGMENT_RUNS), true);
  assert.equal(findingTargetsSegment(findingWith(undefined, ".auto/log.jsonl:1-5"), SEGMENT_RUNS), false);
  assert.equal(findingTargetsSegment(findingWith(undefined, "src/autoruns/2/output.txt:1-1"), SEGMENT_RUNS), false);
});

// ---------------------------------------------------------------------------
// observer.ts — runObserver wiring (fixture campaigns)
// ---------------------------------------------------------------------------

test("runObserver reflection checkpoint: lens nudge + healthy measurement line (no findings, runs persisted)", () => {
  const workDir = makeWorkDir("wire-reflect");
  reflectionCampaign(workDir);
  writeRunOutput(workDir, 2);

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /REFLECTION CHECKPOINT \(10 decided runs/);
  assert.match(steer, /RESULT LENS/);
  assert.match(steer, /inspect_results/);
  assert.match(steer, /Measurement health: изменений измерителя не зарегистрировано \(здоровое состояние\)/);
});

test("runObserver reflection checkpoint: finding tied to a segment run suppresses the lens nudge (spec scenario)", async () => {
  const workDir = makeWorkDir("wire-reflect-done");
  reflectionCampaign(workDir);
  const evidence = writeRunOutput(workDir, 2);
  await addFinding(workDir, { theme: "behavior", description: "discards share the same warm-up bias", evidenceRef: `${evidence}:1-2`, run: 2 });

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /REFLECTION CHECKPOINT/);
  assert.doesNotMatch(steer, /RESULT LENS/);
  assert.doesNotMatch(steer, /inspect_results/);
  assert.match(steer, /Measurement health:/);
});

test("runObserver reflection checkpoint: finding outside the segment does not suppress the nudge", async () => {
  const workDir = makeWorkDir("wire-reflect-other");
  reflectionCampaign(workDir);
  // Outside on BOTH axes: run: 999 ∉ segment, and the evidence path points at
  // run 999 (review B1: an evidence path inside the segment binds the finding
  // to the segment even without a run field).
  const evidence = writeRunOutput(workDir, 999);
  await addFinding(workDir, { theme: "behavior", description: "stale segment finding", evidenceRef: `${evidence}:1-1`, run: 999 });

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /RESULT LENS/);
});

test("runObserver reflection checkpoint: finding without run, evidence in segment run → no RESULT LENS (review B1)", async () => {
  const workDir = makeWorkDir("wire-reflect-evidence");
  reflectionCampaign(workDir);
  const evidence = writeRunOutput(workDir, 2);
  // record_finding does not derive `run` from evidence_ref, so the finding is
  // written WITHOUT the run field; the evidence path is the only binding.
  await addFinding(workDir, { theme: "behavior", description: "discards share the same warm-up bias", evidenceRef: `${evidence}:1-2` });

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /REFLECTION CHECKPOINT/);
  assert.doesNotMatch(steer, /RESULT LENS/);
  assert.doesNotMatch(steer, /inspect_results/);
});

test("runObserver reflection checkpoint: finding without run, evidence outside the segment keeps the nudge", async () => {
  const workDir = makeWorkDir("wire-reflect-evidence-other");
  reflectionCampaign(workDir);
  const evidence = writeRunOutput(workDir, 999); // exists on disk for validation, but run 999 ∉ segment
  await addFinding(workDir, { theme: "behavior", description: "evidence from another segment", evidenceRef: `${evidence}:1-1` });

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /RESULT LENS/);
});

test("runObserver: old campaign without .auto/runs is never nudged (compat)", () => {
  const workDir = makeWorkDir("wire-old");
  reflectionCampaign(workDir); // ledger only, no .auto/runs

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /REFLECTION CHECKPOINT/);
  assert.doesNotMatch(steer, /RESULT LENS/);
  assert.doesNotMatch(steer, /inspect_results/);
  // Measurement health still folds the ledger and reports the healthy state.
  assert.match(steer, /Measurement health: изменений измерителя не зарегистрировано/);
});

test("runObserver stagnation: lens inspection required before the council", () => {
  const workDir = makeWorkDir("wire-stag");
  stagnationCampaign(workDir);
  writeRunOutput(workDir, 1);

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /STAGNATION: No metric improvement in 5 runs/);
  assert.match(steer, /RESULT LENS/);
  assert.match(steer, /inspect_results/);
  assert.ok(steer.indexOf("RESULT LENS") < steer.indexOf("COUNCIL"), "lens requirement must precede the council hint");
});

test("runObserver stagnation: with a segment finding the requirement disappears", async () => {
  const workDir = makeWorkDir("wire-stag-done");
  stagnationCampaign(workDir);
  const evidence = writeRunOutput(workDir, 1);
  await addFinding(workDir, {
    theme: "measurement",
    description: "recall 0 for cold-start fixtures",
    evidenceRef: `${evidence}:2-2`,
    run: 1,
    impact: "~8% прогонов",
  });

  const steer = runObserver(payload(workDir));
  assert.ok(steer);
  assert.match(steer, /STAGNATION/);
  assert.doesNotMatch(steer, /RESULT LENS/);
  // measurement findings are visible in the health line even without changes
  assert.match(steer, /Measurement health: изменений измерителя не зарегистрировано/);
  assert.match(steer, /открытых measurement-находок: 1/);
  assert.match(steer, /~8% прогонов/);
});
