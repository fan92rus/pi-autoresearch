import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrateConcurrency } from "../extensions/pi-autoresearch/parallel/cpu.ts";

test("calibrateConcurrency: no sample keeps requested", () => {
  const r = calibrateConcurrency(4, null);
  assert.equal(r.concurrency, 4);
  assert.equal(r.cpuWarning, undefined);
});

test("calibrateConcurrency: idle CPU keeps requested", () => {
  const r = calibrateConcurrency(4, { idleRatio: 0.7 });
  assert.equal(r.concurrency, 4);
  assert.equal(r.cpuWarning, undefined);
});

test("calibrateConcurrency: saturated CPU lowers to 2 with advisory", () => {
  const r = calibrateConcurrency(4, { idleRatio: 0.05 });
  assert.equal(r.concurrency, 2);
  assert.ok(r.cpuWarning && r.cpuWarning.includes("concurrency lowered"));
});

test("calibrateConcurrency: requested already 2 stays at 2 even when saturated", () => {
  const r = calibrateConcurrency(2, { idleRatio: 0.0 });
  assert.equal(r.concurrency, 2);
});

test("calibrateConcurrency: requested 1 never goes below 1", () => {
  const r = calibrateConcurrency(1, { idleRatio: 0.0 });
  assert.equal(r.concurrency, 1);
});

test("calibrateConcurrency: threshold 0.15 — 0.20 idle is NOT saturated", () => {
  const r = calibrateConcurrency(4, { idleRatio: 0.2 });
  assert.equal(r.concurrency, 4);
  assert.equal(r.cpuWarning, undefined);
});
