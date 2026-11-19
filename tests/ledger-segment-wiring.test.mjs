// bd pi-autoresearch-tj0.9: the shared advanceSegment contract is per-segment.
// Two config headers in a row must not stack empty segments: only a header
// following a run in the CURRENT segment starts a new one. Both ledger readers
// (jsonl reconstruction and the exhaustion scan) must wire the counter that
// way while keeping their cumulative run records intact.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { scanLogContexts } from "../extensions/pi-autoresearch/exhaustion-hints.ts";

const config = (name) => JSON.stringify({ type: "config", name, metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" });
const run = (n) => JSON.stringify({ run: n, commit: `c${n}`, metric: 100 - n, metrics: {}, status: "keep", description: `run ${n}`, timestamp: n });

// CONFIG, run1, CONFIG, CONFIG, run2, CONFIG, run3:
// the second header has no run behind it, so run2 stays in segment 1; the
// following header DOES follow run2 and therefore opens segment 2.
const ledger = [config("one"), run(1), config("two"), config("three"), run(2), config("four"), run(3)];

test("jsonl reconstruction counts runs since the last header, not all runs", () => {
  const state = reconstructJsonlState(ledger.join("\n"));

  assert.deepEqual(state.results.map((r) => [r.run, r.segment]), [[1, 0], [2, 1], [3, 2]]);
  assert.equal(state.currentSegment, 2);
});

test("exhaustion ledger scan counts runs since the last header, not all runs", () => {
  const contexts = scanLogContexts(ledger.join("\n"));
  const segmentOf = (n) => {
    const index = ledger.findIndex((line) => JSON.parse(line).run === n);
    return contexts.get(index)?.segment;
  };

  assert.equal(segmentOf(1), 0);
  assert.equal(segmentOf(2), 1, "a header directly after another header must not open an empty segment");
  assert.equal(segmentOf(3), 2, "the next real run still advances the segment on the next header");
});
