// bd pi-autoresearch-lrx.1: ledger-metrics.ts owns the segment/epoch
// invariants (cross-epoch comparison ban, shared split rule). Pure unit tests
// without the fake-pi harness — the point of the extraction.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  advanceSegment,
  resultEpoch,
  segmentEpoch,
  currentResults,
  epochResults,
  findBaselineMetric,
  findBaselineSecondary,
  findBest,
  findBestMetric,
  findBestRunNumber,
  priorEpochBest,
  isBetter,
} from "../extensions/pi-autoresearch/ledger-metrics.ts";

const row = (segment, metric, status = "keep", epoch = 1, metrics = {}) => ({ segment, metric, status, epoch, metrics });

test("resultEpoch: missing/invalid epochs fall back to 1 (never compared with a later epoch)", () => {
  assert.equal(resultEpoch({}), 1);
  assert.equal(resultEpoch({ epoch: 0 }), 1);
  assert.equal(resultEpoch({ epoch: -1 }), 1);
  assert.equal(resultEpoch({ epoch: 1.5 }), 1);
  assert.equal(resultEpoch({ epoch: Number.NaN }), 1);
  assert.equal(resultEpoch({ epoch: 2 }), 2);
});

test("segmentEpoch is the max epoch of the segment, never below 1", () => {
  assert.equal(segmentEpoch([], 0), 1);
  assert.equal(segmentEpoch([row(0, 10, "keep", 3), row(0, 12, "keep", 2)], 0), 3);
  assert.equal(segmentEpoch([row(1, 9, "keep", 4)], 0), 1, "other segments do not count");
});

test("findBaselineMetric / findBest never cross epoch boundaries", () => {
  const results = [
    row(0, 100, "keep", 1),
    row(0, 90, "keep", 1),
    row(0, 50, "keep", 2), // new scale epoch: its own baseline
    row(0, 45, "keep", 2),
  ];
  assert.equal(findBaselineMetric(results, 0, 1), 100);
  assert.equal(findBaselineMetric(results, 0, 2), 50);
  assert.equal(findBestMetric(results, 0, "lower", 1), 90);
  assert.equal(findBestMetric(results, 0, "lower", 2), 45);
  assert.equal(findBestRunNumber(results, 0, "lower", 2), 4);
});

test("findBest ignores 0-metric keeps and non-keep rows (lrx.4 invariant)", () => {
  const results = [row(0, 0, "keep"), row(0, 10, "discard"), row(0, 20, "keep")];
  assert.equal(findBestMetric(results, 0, "lower"), 20);
  assert.equal(findBest(results, 0, "lower", 1).metric, 20);
});

test("priorEpochBest is a cross-epoch REFERENCE only (nearest earlier epoch)", () => {
  const results = [
    row(0, 100, "keep", 1),
    row(0, 90, "keep", 1),
    row(0, 50, "keep", 2),
  ];
  assert.deepEqual(priorEpochBest(results, 0, 2, "lower"), { epoch: 1, metric: 90, runNumber: 2 });
  assert.equal(priorEpochBest(results, 0, 1, "lower"), null, "no earlier epoch");
  assert.deepEqual(priorEpochBest(results, 0, 2, "higher"), { epoch: 1, metric: 100, runNumber: 1 }, "direction picks best within the earlier epoch");
});

test("findBaselineSecondary fills missing known metrics from the first epoch occurrence", () => {
  const results = [
    { ...row(0, 100, "keep", 1), metrics: { p95_ms: 100 } },
    { ...row(0, 90, "keep", 1), metrics: { p95_ms: 90, cache_hit: 0.8 } },
  ];
  assert.deepEqual(findBaselineSecondary(results, 0, [{ name: "cache_hit" }]), { p95_ms: 100, cache_hit: 0.8 });
});

test("currentResults/epochResults/advanceSegment share the reconstructJsonlState contract", () => {
  const results = [row(0, 10), row(1, 20), row(0, 30, "keep", 2)];
  assert.deepEqual(currentResults(results, 0).map((r) => r.metric), [10, 30]);
  assert.deepEqual(epochResults(results, 0, 1).map((r) => r.metric), [10]);
  assert.equal(advanceSegment(0, false), 0, "header before any run stays in the same segment");
  assert.equal(advanceSegment(0, true), 1, "header after runs starts a new segment");
});

test("isBetter respects direction", () => {
  assert.equal(isBetter(9, 10, "lower"), true);
  assert.equal(isBetter(11, 10, "lower"), false);
  assert.equal(isBetter(11, 10, "higher"), true);
});
