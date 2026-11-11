/**
 * experiment-rigor (openspec change experiment-rigor, tasks 1.x): noise units.
 *
 * The calibrated noise floor was stored as a fraction (0.04 = ±4%) and read by the
 * council as an absolute value in metric units, so the 2x-noise gate for millisecond
 * metrics was effectively off. This file pins the contract:
 *   - a config written by the new calibration carries noiseFloorUnit "metric" and an
 *     absolute noiseFloor;
 *   - a legacy config (fraction, no marker) is "not calibrated": readNoiseFloor returns
 *     null and the gate does not apply.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/experiment-rigor.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateSlate, readNoiseFloor } from "../extensions/pi-autoresearch/council.ts";

function tmpCwdWithConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-rigor-"));
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify(config));
  return dir;
}

// One experiment section with a numeric EXPECTED_GAIN in metric units (ms).
function slateWithGain(gain) {
  return [
    "### EXP 1",
    `EXPECTED_GAIN: ${gain} ms`,
    "KILL_WHEN: the run is not faster than the baseline",
    "",
  ].join("\n");
}

test("1.1 gate: a metric-unit noise floor of 4 ms rejects EXPECTED_GAIN 5 ms (< 2x)", () => {
  const dir = tmpCwdWithConfig({ noiseFloor: 4, noiseFloorUnit: "metric" });
  const noise = readNoiseFloor(dir);
  assert.equal(noise, 4, "metric-unit floor is read as absolute");
  const v = validateSlate(slateWithGain(5), noise, 1, 5);
  assert.equal(v.ok, false, "5 ms gain is below 2x the 4 ms floor");
  assert.match(v.errors.join("\n"), /below 2× noise floor/);
});

test("1.1 legacy: a fraction floor without the unit marker is 'not calibrated' (null)", () => {
  // Written by the old calibration: 0.04 = ±4%, not milliseconds. Must not reach the gate.
  const dir = tmpCwdWithConfig({ noiseFloor: 0.04 });
  assert.equal(readNoiseFloor(dir), null, "legacy fraction must not be used as absolute noise");
  const v = validateSlate(slateWithGain(0.05), readNoiseFloor(dir), 1, 5);
  assert.equal(v.ok, true, "without a calibrated floor the gate is not applied");
});

// ---------------------------------------------------------------------------
// experiment-rigor tasks 3.x: confidence from repeats of ONE hypothesis.
// MAD of all segment runs mixes different ideas; it must not be the noise.
// ---------------------------------------------------------------------------

import { computeConfidence } from "../extensions/pi-autoresearch/index.ts";

function res(metric, status, asi, description = "x") {
  return { commit: "", metric, metrics: {}, status, description, timestamp: 0, segment: 0, epoch: 1, confidence: null, asi };
}

test("3.1 confidence: repeats of the best hypothesis give sd, not MAD of all runs", () => {
  // Baseline 100. Best keep 90 from node n1, its repeat n4 gives 91 (repeat_of n1).
  // Other ideas spread the segment wide (60, 140): MAD of ALL runs would be 10 -> 1.0.
  const results = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(60, "discard", { hypothesis_node: "n2" }),
    res(140, "discard", { hypothesis_node: "n3" }),
    res(91, "keep", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  // Group {90, 91}: sample sd = sqrt(0.5) ≈ 0.7071; |90 - 100| / sd ≈ 14.14.
  const c = computeConfidence(results, 0, "lower");
  assert.ok(c !== null && Math.abs(c - 10 / Math.sqrt(0.5)) < 1e-9, `expected ≈14.14, got ${c}`);
});

test("3.1 confidence: no repeat of the best hypothesis -> unknown (null)", () => {
  const results = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(60, "discard", { hypothesis_node: "n2" }),
    res(140, "discard", { hypothesis_node: "n3" }),
  ];
  assert.equal(computeConfidence(results, 0, "lower"), null);
});

test("3.1 confidence: identical repeats (zero sd) -> unknown (null), no division by zero", () => {
  const results = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(90, "keep", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  assert.equal(computeConfidence(results, 0, "lower"), null);
});

// ---------------------------------------------------------------------------
// experiment-rigor tasks 4.x: keep status (confirmed / preliminary), never a refusal.
// ---------------------------------------------------------------------------

import { keepStatus } from "../extensions/pi-autoresearch/confidence.ts";

test("4.1 keep: first keep with no repeat is accepted as preliminary (no refusal)", () => {
  const runs = [res(100, "keep", {}, "baseline"), res(90, "keep", { hypothesis_node: "n1" })];
  assert.equal(keepStatus(runs, runs[1], 100, "lower"), "preliminary");
});

test("4.2 keep: a repeat of the same hypothesis that also beats the baseline confirms it", () => {
  const runs = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(91, "keep", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  assert.equal(keepStatus(runs, runs[1], 100, "lower"), "confirmed");
});

test("m2: a repeat that beats the baseline confirms even when the 2x spread rule alone would not (same-hypothesis rule)", () => {
  // sd({90, 99}) = 6.364; |90 - 100| / sd = 1.571 < 2, so only the same-hypothesis rule can confirm.
  const runs = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(99, "keep", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  assert.equal(keepStatus(runs, runs[1], 100, "lower"), "confirmed");
});

test("4.2 keep: a repeat that does not beat the baseline does not confirm", () => {
  const runs = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(101, "discard", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  assert.equal(keepStatus(runs, runs[1], 100, "lower"), "preliminary");
});

// ---------------------------------------------------------------------------
// experiment-rigor tasks 5.x: report counters and best-keep status.
// ---------------------------------------------------------------------------

import { buildReport } from "../extensions/pi-autoresearch/report.ts";
import { sessionFilePath } from "../extensions/pi-autoresearch/paths.ts";

test("5.1/5.2 report: summary counts attempts, keeps and hypotheses; best keep status is shown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-rigor-report-"));
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const rows = [
    { type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" },
    { run: 1, commit: "", metric: 100, metrics: {}, status: "keep", description: "baseline", timestamp: 1, segment: 0, confidence: null },
    { run: 2, commit: "", metric: 90, metrics: {}, status: "keep", description: "idea one", timestamp: 2, segment: 0, confidence: null, asi: { hypothesis_node: "n1" } },
    { run: 3, commit: "", metric: 60, metrics: {}, status: "discard", description: "idea two", timestamp: 3, segment: 0, confidence: null, asi: { hypothesis_node: "n2" } },
  ];
  fs.writeFileSync(sessionFilePath(dir, "log"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const report = buildReport(dir);
  const line = report.split("\n").find((l) => l.startsWith("- Прогоны:")) ?? "(no Прогоны line)";
  console.error("SUMMARY LINE: " + line);
  assert.ok(line.includes("в эпохе: попыток 3"), "attempts counted in the active epoch: " + line);
  assert.ok(line.includes("keep 2"), "keeps counted: " + line);
  assert.ok(line.includes("гипотез 3"), "unique hypotheses counted: " + line);
  assert.ok(line.includes("предварительный"), "best keep is marked preliminary: " + line);
});

test("B3: the report shows the segment MAD as a labelled diagnostic, not as confidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-rigor-mad-"));
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const rows = [
    { type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" },
    { run: 1, commit: "", metric: 100, metrics: {}, status: "keep", description: "baseline", timestamp: 1, segment: 0, confidence: null },
    { run: 2, commit: "", metric: 90, metrics: {}, status: "keep", description: "idea one", timestamp: 2, segment: 0, confidence: null, asi: { hypothesis_node: "n1" } },
    { run: 3, commit: "", metric: 60, metrics: {}, status: "discard", description: "idea two", timestamp: 3, segment: 0, confidence: null, asi: { hypothesis_node: "n2" } },
  ];
  fs.writeFileSync(sessionFilePath(dir, "log"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const report = buildReport(dir);
  const diag = report.split("\n").find((l) => l.startsWith("Диагностика:")) ?? "";
  // values {100, 90, 60}: median 90, |dev| {10, 0, 30}, MAD = 10
  assert.ok(diag.includes("(MAD) = 10 ms"), "MAD of the segment is shown: " + diag);
  assert.ok(diag.includes("не влияет"), "the diagnostic states it does not affect confidence: " + diag);
  const conf = report.split("\n").find((l) => l.startsWith("Уверенность:")) ?? "";
  assert.ok(!conf.includes("10.0×"), "confidence is not the MAD multiple (|90-100|/MAD = 1.0)");
});

test("B4: the report marks a floor from an older measurement epoch as stale (УСТАРЕЛ)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-rigor-stale-"));
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ noiseFloor: 1, noiseFloorUnit: "metric", noiseFloorEpoch: 1 }));
  const rows = [
    { type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" },
    { run: 1, commit: "", metric: 100, metrics: {}, status: "keep", description: "baseline", timestamp: 1, segment: 0, confidence: null },
    { type: "measurement_change", epoch: 2, diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md", justification: "finding f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true },
  ];
  fs.writeFileSync(sessionFilePath(dir, "log"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const report = buildReport(dir);
  assert.ok(report.includes("УСТАРЕЛ (floor_stale)"), "stale floor is marked in the report noise section");
  assert.ok(report.includes("эпоха 2"), "the active scale epoch is named");
});

test("B5: a discarded repeat of the same hypothesis counts in the 2x spread, as in the displayed confidence", () => {
  // computeConfidence = |90 - 100| / sd({90, 91}) = 14.14 >= 2, so the keep is confirmed.
  const runs = [
    res(100, "keep", {}, "baseline"),
    res(90, "keep", { hypothesis_node: "n1" }),
    res(91, "discard", { hypothesis_node: "n4", repeat_of: "n1" }),
  ];
  assert.equal(keepStatus(runs, runs[1], 100, "lower"), "confirmed");
});
