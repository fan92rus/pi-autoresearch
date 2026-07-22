import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newPhaseStore, startPhase, recordExploreStep, endPhaseDecision, clearPhase,
  regressionPct, overHardFloor, overSoftRegression, markBestCheckpoint,
} from "../extensions/pi-autoresearch/parallel/phases.ts";

test("regressionPct — lower direction: faster is positive", () => {
  // baseline 100, candidate 80 → improvement +20%
  assert.equal(regressionPct(80, 100, "lower"), 20);
  // candidate 120 → regression -20%
  assert.equal(regressionPct(120, 100, "lower"), -20);
  assert.equal(regressionPct(100, 100, "lower"), 0);
});

test("regressionPct — higher direction: bigger is positive", () => {
  assert.equal(regressionPct(120, 100, "higher"), 20);
  assert.equal(regressionPct(80, 100, "higher"), -20);
});

test("regressionPct — zero baseline guard", () => {
  assert.equal(regressionPct(0, 0, "lower"), 0);
  assert.equal(regressionPct(5, 0, "lower"), -100); // got worse from 0
});

test("overHardFloor / overSoftRegression", () => {
  // 40% floor: candidate 150 vs baseline 100, lower → -50% < -40 → over floor
  assert.equal(overHardFloor(150, 100, "lower", 40), true);
  assert.equal(overHardFloor(130, 100, "lower", 40), false); // -30% within floor
  assert.equal(overSoftRegression(130, 100, "lower", 25), true); // -30 < -25
  assert.equal(overSoftRegression(120, 100, "lower", 25), false); // -20 not below -25
});

test("startPhase rejects a second concurrent phase", () => {
  const store = newPhaseStore();
  const a = startPhase(store, { name: "p1", rationale: "x", phaseBase: "sha1", baselineMetric: 100 });
  assert.equal(a.ok, true);
  const b = startPhase(store, { name: "p2", rationale: "y", phaseBase: "sha2", baselineMetric: 100 });
  assert.equal(b.ok, false);
  clearPhase(store);
});

test("recordExploreStep: continue within bounds", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100, maxSteps: 5, hardFloorPct: 40, maxRegressionPct: 25 });
  // -10% : within soft and hard → continue
  const r = recordExploreStep(store, { metric: 110, direction: "lower" });
  assert.equal(r.kind, "continue");
});

test("recordExploreStep: steer_deep beyond soft regression", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100, maxSteps: 5, hardFloorPct: 40, maxRegressionPct: 25 });
  // -30% : beyond soft (25) but within hard (40) → steer_deep
  const r = recordExploreStep(store, { metric: 130, direction: "lower" });
  assert.equal(r.kind, "steer_deep");
});

test("recordExploreStep: auto_abort_floor on hard floor", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100, maxSteps: 5, hardFloorPct: 40, maxRegressionPct: 25 });
  // -50% : over hard floor → auto_abort_floor
  const r = recordExploreStep(store, { metric: 150, direction: "lower" });
  assert.equal(r.kind, "auto_abort_floor");
});

test("recordExploreStep: auto_abort_steps at maxSteps", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100, maxSteps: 2, hardFloorPct: 40, maxRegressionPct: 25 });
  recordExploreStep(store, { metric: 105, direction: "lower" }); // step 1
  const r = recordExploreStep(store, { metric: 104, direction: "lower" }); // step 2 = max
  assert.equal(r.kind, "auto_abort_steps");
  clearPhase(store);
});

test("endPhaseDecision: keep when final better than baseline", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100 });
  assert.deepEqual(endPhaseDecision(store, 80, "lower"), { decision: "keep" });
  assert.equal(endPhaseDecision(store, 120, "lower").decision, "abort");
  assert.equal(endPhaseDecision(store, null, "lower").decision, "abort");
  clearPhase(store);
});

test("markBestCheckpoint updates phase best", () => {
  const store = newPhaseStore();
  startPhase(store, { name: "p", rationale: "x", phaseBase: "s", baselineMetric: 100 });
  recordExploreStep(store, { metric: 95, direction: "lower" });
  markBestCheckpoint(store, "sha-best");
  assert.equal(store.active.bestCheckpointSha, "sha-best");
  clearPhase(store);
});
