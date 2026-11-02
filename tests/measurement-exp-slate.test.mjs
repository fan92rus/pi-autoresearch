/**
 * Measurement-EXP contract in the slate validator + synced chair/challenge
 * instructions (openspec add-result-reflection, task 2.6; spec
 * measurement-track/spec.md requirement "Measurement-EXP в слейте совета").
 *
 * Covers extensions/pi-autoresearch/council.ts (validateSlate, the chair EXP
 * template + slate check in the facilitator message) and council-delegation.ts
 * (chair + challenge briefs):
 *  - measurement-EXP (own `TRACK: measurement` line inside the section) with
 *    the full DIFF/RESCORE/JUSTIFY plan is accepted without a numeric
 *    EXPECTED_GAIN (mixed slates and all-measurement slates);
 *  - an incomplete plan is rejected with the missing field's name in the
 *    error (each field alone, several together, and a bare label with an
 *    empty value);
 *  - a model-EXP without a numeric EXPECTED_GAIN is still rejected (prose,
 *    and plan fields without TRACK do not rescue it);
 *  - `TRACK: measurement` glued into the section header line does not switch
 *    the contract; KILL_WHEN stays required for both classes; tolerance for
 *    bold labels and list markers;
 *  - chair instructions (manual facilitator message) and the delegation
 *    chair/challenge briefs teach the same contract.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurement-exp-slate.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSlate, composeFacilitatorMessage } from "../extensions/pi-autoresearch/council.ts";
import { chairTask, challengeTask } from "../extensions/pi-autoresearch/council-delegation.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOISE_FLOOR = 0.005;

/** A model-EXP section: the classic contract — numeric gain + kill condition. */
const MODEL_EXP = (n, gain) =>
  [`## EXP${n}: model tweak`, "CHANGE: tweak the parser loop", `EXPECTED_GAIN: ${gain}`, "KILL_WHEN: no gain after 2 runs"].join("\n");

/** A measurement-EXP section; plan fields can be dropped one by one. */
const MEAS_EXP = (n, plan = { DIFF: true, RESCORE: true, JUSTIFY: true }) => {
  const lines = [`## EXP${n}: fix gold forms`, "CHANGE: fix the gold set forms", "TRACK: measurement"];
  if (plan.DIFF) lines.push("DIFF: .auto/measurement/e2_gold_v16.diff");
  if (plan.RESCORE) lines.push("RESCORE: anchor run 45 window dev366, rescore with the old and the new gold, both scores recorded");
  if (plan.JUSTIFY) lines.push("JUSTIFY: finding f7");
  lines.push("KILL_WHEN: rescore contradicts the diff intent");
  return lines.join("\n");
};

const slate3 = (first, second, third) => [first, second, third].join("\n");

// ── Validator ────────────────────────────────────────────────────────────────

await test("measurement-EXP with the full DIFF/RESCORE/JUSTIFY plan is accepted", () => {
  const mixed = slate3(MEAS_EXP(1), MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03"));
  const v = validateSlate(mixed, NOISE_FLOOR);
  assert.strictEqual(v.ok, true, `mixed slate rejected: ${v.errors.join("; ")}`);
  assert.strictEqual(v.experimentCount, 3);

  const allMeasurement = slate3(MEAS_EXP(1), MEAS_EXP(2), MEAS_EXP(3));
  const v2 = validateSlate(allMeasurement, NOISE_FLOOR);
  assert.strictEqual(v2.ok, true, `all-measurement slate rejected: ${v2.errors.join("; ")}`);

  // Threshold still enforced on the model sections of a mixed slate.
  const belowFloor = mixed.replace("EXPECTED_GAIN: 0.02", "EXPECTED_GAIN: 0.004");
  const v3 = validateSlate(belowFloor, NOISE_FLOOR);
  assert.strictEqual(v3.ok, false);
  assert.ok(v3.errors.some((e) => e.includes("below 2× noise floor")), "gain threshold untouched by the measurement branch");
});

await test("measurement-EXP tolerates list markers, bold labels and trailing prose on the TRACK line", () => {
  const tolerant = slate3(
    [
      "## EXP1: gold fix",
      "- **TRACK:** measurement (gold form variants)",
      "- **DIFF:** .auto/measurement/e2_gold.diff",
      "- **RESCORE:** anchor run 45, old vs new gold",
      "- **JUSTIFY:** finding f7",
      "- KILL_WHEN: mismatch direction flips",
    ].join("\n"),
    MODEL_EXP(2, "0.02"),
    MODEL_EXP(3, "0.03"),
  );
  const v = validateSlate(tolerant, NOISE_FLOOR);
  assert.strictEqual(v.ok, true, `tolerance failed: ${v.errors.join("; ")}`);
});

await test("measurement-EXP with an incomplete plan is rejected naming the missing field", () => {
  for (const field of ["DIFF", "RESCORE", "JUSTIFY"]) {
    const plan = { DIFF: true, RESCORE: true, JUSTIFY: true, [field]: false };
    const slate = slate3(MEAS_EXP(1, plan), MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03"));
    const v = validateSlate(slate, null);
    assert.strictEqual(v.ok, false, `dropping ${field} must fail`);
    const named = v.errors.find((e) => e.includes("incomplete measurement plan"));
    assert.ok(named, `error must name the plan problem: ${v.errors.join("; ")}`);
    assert.ok(named.includes(field), `error must name ${field}: ${named}`);
  }

  // Several missing fields are named together.
  const v2 = validateSlate(slate3(MEAS_EXP(1, { DIFF: false, RESCORE: false, JUSTIFY: true }), MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03")), null);
  assert.strictEqual(v2.ok, false);
  const named2 = v2.errors.find((e) => e.includes("incomplete measurement plan"));
  assert.ok(named2?.includes("DIFF") && named2?.includes("RESCORE") && !named2?.includes("JUSTIFY"), `both missing fields named: ${named2}`);

  // A bare label with no value counts as missing (the plan field must carry content).
  const emptyValue = MEAS_EXP(1).replace("DIFF: .auto/measurement/e2_gold_v16.diff", "DIFF:");
  const v3 = validateSlate(slate3(emptyValue, MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03")), null);
  assert.strictEqual(v3.ok, false);
  assert.ok(v3.errors.some((e) => e.includes("incomplete measurement plan") && e.includes("DIFF")), `empty DIFF value rejected: ${v3.errors.join("; ")}`);
});

await test("model-EXP without a numeric EXPECTED_GAIN is still rejected", () => {
  // Prose instead of a number (the shape from the real campaign slate).
  const prose = slate3(MODEL_EXP(1, "см. таблицу после замера шума"), MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03"));
  const v = validateSlate(prose, null);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("missing EXPECTED_GAIN")), `prose gain must be rejected: ${v.errors.join("; ")}`);

  // The plan fields without TRACK: measurement do not rescue a model section.
  const planNoTrack = [
    "## EXP1: measurement-ish",
    "DIFF: .auto/measurement/x.diff",
    "RESCORE: anchor run 45",
    "JUSTIFY: finding f7",
    "KILL_WHEN: nothing works",
  ].join("\n");
  const v2 = validateSlate(slate3(planNoTrack, MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03")), null);
  assert.strictEqual(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("missing EXPECTED_GAIN")), `plan without TRACK must not switch the contract: ${v2.errors.join("; ")}`);
});

await test("TRACK in the header line does not switch the contract; KILL_WHEN stays required", () => {
  // The token glued into the section header is not the declared format (the
  // spec puts TRACK on its own line inside the section).
  const headerTrack = [
    "## EXP1: gold fix TRACK: measurement",
    "DIFF: .auto/measurement/x.diff",
    "RESCORE: anchor run 45",
    "JUSTIFY: finding f7",
    "KILL_WHEN: nothing works",
  ].join("\n");
  const v = validateSlate(slate3(headerTrack, MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03")), null);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("missing EXPECTED_GAIN")), `header TRACK must not switch the contract: ${v.errors.join("; ")}`);

  // KILL_WHEN is required for measurement sections too.
  const noKill = MEAS_EXP(1).replace("\nKILL_WHEN: rescore contradicts the diff intent", "");
  const v2 = validateSlate(slate3(noKill, MODEL_EXP(2, "0.02"), MODEL_EXP(3, "0.03")), null);
  assert.strictEqual(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("KILL_WHEN")), `measurement section still needs KILL_WHEN: ${v2.errors.join("; ")}`);
});

// ── Instruction sync (chair template + challenge briefs) ────────────────────

const FACILITATOR_INPUT = {
  councilDir: ".auto/councils/1",
  seq: 1,
  briefAbsPath: "/tmp/council/1/00-brief.md",
  roster: {
    mode: "models",
    chairModel: "m",
    participants: [
      { name: "AnalystA", letter: "A", model: "m1", persona: "patterns" },
      { name: "AnalystB", letter: "B", model: "m2", persona: "skeptic" },
    ],
  },
  maxChallengeRounds: 3,
  minExperiments: 3,
};

await test("manual facilitator message: chair template, challenge task and slate check teach the measurement contract", () => {
  const msg = composeFacilitatorMessage(FACILITATOR_INPUT);
  for (const marker of ["TRACK: measurement", "DIFF:", "RESCORE:", "JUSTIFY:", "accounting plan"]) {
    assert.ok(msg.includes(marker), `facilitator message must teach "${marker}"`);
  }
  assert.ok(msg.includes("every measurement EXP"), "slate-check line names the measurement branch");
  assert.ok(msg.includes("DIFF/RESCORE/JUSTIFY plan"), "slate-check line names the plan");
});

await test("delegation chair brief teaches the measurement EXP template", () => {
  const chair = chairTask("BRIEF TEXT", undefined, "PROPOSALS", "VERDICTS");
  for (const marker of ["TRACK: measurement", "DIFF:", "RESCORE:", "JUSTIFY:", "NO numeric EXPECTED_GAIN"]) {
    assert.ok(chair.includes(marker), `delegation chair brief must teach "${marker}"`);
  }
  assert.ok(chair.includes("`TRACK:`") && chair.includes("`DIFF:`"), "token list includes the measurement labels");
});

await test("delegation challenge brief checks the accounting plan, not a number", () => {
  const p = { name: "AnalystA", letter: "A", model: "m", personaPrompt: "lens" };
  const challenge = challengeTask(p, 1, [], "OTHERS", null);
  assert.ok(challenge.includes("TRACK: measurement"), "challenge brief names the measurement contract");
  for (const field of ["DIFF", "RESCORE", "JUSTIFY"]) {
    assert.ok(challenge.includes(field), `challenge brief names the plan field ${field}`);
  }
  assert.ok(challenge.includes("NO expected-gain number"), "challenge brief says the number is replaced");
});
