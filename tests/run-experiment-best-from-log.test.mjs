/** Regression: run_experiment must report the best kept metric from the durable ledger. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { bestMetricFromJsonl } from "../extensions/pi-autoresearch/run-experiment-tool.ts";

const log = [
  JSON.stringify({ type: "config", name: "bench", metricName: "score", metricUnit: "", bestDirection: "higher" }),
  JSON.stringify({ run: 1, metric: 11.09, status: "keep", segment: 1, epoch: 1, description: "baseline" }),
  JSON.stringify({ run: 2, metric: 54.45, status: "keep", segment: 2, epoch: 2, description: "epoch restore" }),
  JSON.stringify({ run: 3, metric: 65.79, status: "keep", segment: 3, epoch: 2, description: "champion" }),
].join("\n");

test("best kept metric comes from the latest ledger segment, not a stale in-memory baseline", () => {
  assert.equal(bestMetricFromJsonl(log, "higher", 54.45), 65.79);
});

test("malformed or empty ledger falls back without throwing", () => {
  assert.equal(bestMetricFromJsonl("", "higher", 54.45), 54.45);
  assert.equal(bestMetricFromJsonl("not json", "higher", 54.45), 54.45);
});
