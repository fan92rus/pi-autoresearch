import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { parseJsonlEntry, reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";

const CONFIG = '{"type":"config","name":"Epoch session","metricName":"total_ms","metricUnit":"ms","bestDirection":"lower"}';

function run(n, metric, extra = {}) {
  return JSON.stringify({ run: n, commit: `c${n}`, metric, status: "keep", description: `run ${n}`, timestamp: n, metrics: {}, ...extra });
}

function change(epoch, extra = {}) {
  return JSON.stringify({
    type: "measurement_change",
    epoch,
    diff_ref: `.auto/measurement/e${epoch}_gold.diff`,
    rescore_ref: `.auto/measurement/e${epoch}/rescore.md`,
    justification: "finding f1",
    old_scale_score: 0.5,
    new_scale_score: 0.6,
    needs_verification: true,
    ...extra,
  });
}

test("legacy ledger without epoch fields: every run is epoch 1", () => {
  const state = reconstructJsonlState([CONFIG, run(1, 10), run(2, 9, { status: "discard" }), run(3, 8)].join("\n"));

  assert.deepEqual(state.results.map((r) => r.epoch), [1, 1, 1]);
  assert.equal(state.currentEpoch, 1);
  assert.equal(state.currentSegment, 0);
});

test("empty and header-only ledgers report epoch 1", () => {
  assert.equal(reconstructJsonlState("").currentEpoch, 1);
  assert.equal(reconstructJsonlState(CONFIG).currentEpoch, 1);
});

test("parseJsonlEntry keeps the epoch field of measurement_change records", () => {
  const entry = parseJsonlEntry(change(2));

  assert.equal(entry.type, "measurement_change");
  assert.equal(entry.epoch, 2);
});

test("mixed ledger: legacy runs stay epoch 1, runs after measurement_change are epoch 2", () => {
  const state = reconstructJsonlState(
    [CONFIG, run(1, 10), run(2, 9), change(2), run(3, 0.9, { epoch: 2 }), run(4, 0.8, { epoch: 2 })].join("\n"),
  );

  assert.deepEqual(state.results.map((r) => r.run), [1, 2, 3, 4]);
  assert.deepEqual(state.results.map((r) => r.epoch), [1, 1, 2, 2]);
  assert.equal(state.currentEpoch, 2);
});

test("measurement_change records are not counted as runs", () => {
  const state = reconstructJsonlState([CONFIG, run(1, 10), change(2)].join("\n"));

  assert.equal(state.results.length, 1);
  assert.equal(state.currentEpoch, 2);
});

test("several measurement_change records advance the current epoch to the latest one", () => {
  const state = reconstructJsonlState(
    [CONFIG, run(1, 10), change(2), run(2, 9, { epoch: 2 }), change(3), run(3, 8, { epoch: 3 })].join("\n"),
  );

  assert.deepEqual(state.results.map((r) => r.epoch), [1, 2, 3]);
  assert.equal(state.currentEpoch, 3);
});

test("a run without epoch after a later epoch stays epoch 1 and does not lower the current epoch", () => {
  const state = reconstructJsonlState([CONFIG, run(1, 10), change(2), run(2, 9, { epoch: 2 }), run(3, 8)].join("\n"));

  assert.deepEqual(state.results.map((r) => r.epoch), [1, 2, 1]);
  assert.equal(state.currentEpoch, 2);
});

test("broken epoch values are treated as absent and never throw", () => {
  const broken = ['"2"', "2.5", "0", "-1", "null", "true", '"NaN"', "[2]", "{}", "1e300"];
  const lines = [CONFIG, run(1, 10)];
  for (const value of broken) {
    lines.push(run(lines.length, 9, { epoch: JSON.parse(value) }));
    lines.push(`{"type":"measurement_change","epoch":${value},"diff_ref":"x"}`);
  }

  const state = reconstructJsonlState(lines.join("\n"));

  assert.equal(state.results.length, broken.length + 1);
  assert.deepEqual([...new Set(state.results.map((r) => r.epoch))], [1]);
  assert.equal(state.currentEpoch, 1);
});

test("broken epoch on a run does not hide a valid later epoch", () => {
  const state = reconstructJsonlState([CONFIG, run(1, 10, { epoch: "2" }), change(3), run(2, 9, { epoch: 3 })].join("\n"));

  assert.deepEqual(state.results.map((r) => r.epoch), [1, 3]);
  assert.equal(state.currentEpoch, 3);
});

test("epochs do not reset across config headers and segments stay intact", () => {
  const state = reconstructJsonlState(
    [
      CONFIG,
      run(1, 10),
      run(2, 9),
      change(2),
      CONFIG,
      run(3, 0.9, { epoch: 2 }),
      run(4, 0.8),
    ].join("\n"),
  );

  assert.deepEqual(state.results.map((r) => r.segment), [0, 0, 1, 1]);
  assert.deepEqual(state.results.map((r) => r.epoch), [1, 1, 2, 1]);
  assert.equal(state.currentSegment, 1);
  assert.equal(state.currentEpoch, 2);
});

test("header-less ledger completed by a config header keeps runs in one segment with their epochs", () => {
  const state = reconstructJsonlState([run(1, 10), change(2), run(2, 9, { epoch: 2 }), CONFIG].join("\n"));

  assert.deepEqual(state.results.map((r) => r.segment), [0, 0]);
  assert.deepEqual(state.results.map((r) => r.epoch), [1, 2]);
  assert.equal(state.currentSegment, 0);
  assert.equal(state.currentEpoch, 2);
});

test("reconstruction after restart reproduces the epoch state from the ledger file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-epochs-"));
  const file = path.join(dir, "log.jsonl");
  try {
    fs.writeFileSync(file, [CONFIG, run(1, 10), change(2), run(2, 9, { epoch: 2 })].join("\n") + "\n");
    const beforeRestart = reconstructJsonlState(fs.readFileSync(file, "utf-8"));

    // Simulated restart: a new process reads the file and continues appending in epoch 2.
    fs.appendFileSync(file, run(3, 8, { epoch: 2 }) + "\n");
    const afterRestart = reconstructJsonlState(fs.readFileSync(file, "utf-8"));

    assert.equal(beforeRestart.currentEpoch, 2);
    assert.deepEqual(afterRestart.results.slice(0, 2), beforeRestart.results);
    assert.deepEqual(afterRestart.results.map((r) => r.epoch), [1, 2, 2]);
    assert.equal(afterRestart.currentEpoch, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restart after a change with no runs yet keeps the epoch from the change record", () => {
  const state = reconstructJsonlState([CONFIG, run(1, 10), change(2)].join("\n"));

  assert.equal(state.currentEpoch, 2);
  assert.deepEqual(state.results.map((r) => r.epoch), [1]);
});
