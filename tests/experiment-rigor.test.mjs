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
