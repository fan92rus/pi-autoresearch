/**
 * Property-based tests for the TUI renderer.
 *
 * The renderer remains the implementation under test; the expected best keep,
 * status counts and metric attribution are recomputed by a small independent
 * oracle in this file. No production constants or helpers are imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { forAll, genInt, genPick } from "./pbt-harness.mjs";
import { renderDashboardLines } from "../extensions/pi-autoresearch/widget.ts";
import { formatMetricLines } from "../extensions/pi-autoresearch/bugfix-mode.ts";

const th = { fg: (_style, value) => value, bold: (value) => value };
const STATUSES = ["keep", "discard", "crash", "checks_failed"];
const NO_KEEP_STATUSES = ["discard", "crash", "checks_failed"];
const SECONDARY = ["discovery_credit", "fix_credit", "detector_tests", "proof_tests"];
const METRIC_NAMES = [
  "bugfix_score_v2", "discovery_credit", "fix_credit", "detector_tests", "proof_tests",
  "mutation_proven_fixed", "weighted_defects", "regression_failures", "new_regressions",
  "changed_lines", "changed_lines_over_budget", "scorer_changed", "invalid_proofs",
  "tentative_credit", "duplicate_credits", "tests_total", "tests_gain",
];

function makeResult(rng, index, options = {}) {
  const metricValue = (max) => genInt(rng, 0, max);
  const statuses = options.noKeep === true ? NO_KEEP_STATUSES : STATUSES;
  return {
    commit: `c${index}`,
    // Zero metrics are legitimate rows: keeps with metric === 0 never open Progress.
    metric: options.allowZeroMetric === true ? genInt(rng, 0, 99) : genInt(rng, 1, 99),
    metrics: {
      bugfix_score_v2: metricValue(99),
      discovery_credit: metricValue(40),
      fix_credit: metricValue(40),
      detector_tests: metricValue(9),
      proof_tests: metricValue(9),
    },
    status: genPick(rng, statuses),
    description: `run-${index}`,
    timestamp: index,
    segment: 0,
    epoch: 1,
  };
}

function makeState(results, direction) {
  return {
    results,
    bestMetric: results[0]?.metric ?? null,
    bestDirection: direction,
    metricName: "bugfix_score_v2",
    metricUnit: "",
    secondaryMetrics: SECONDARY.map((name) => ({ name, unit: "" })),
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

/** Walks backwards exactly like the renderer: last occurrence wins on a tie. */
function oracleBestKeep(results, direction) {
  let best = null;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (result.status !== "keep" || result.metric <= 0) continue;
    const better = best === null ||
      (direction === "higher" ? result.metric > best.metric : result.metric < best.metric);
    if (better) best = result;
  }
  return best;
}

function guard(seed, log, assertion) {
  try { assertion(); } catch (error) {
    error.log = [`seed=${seed}`, ...log];
    throw error;
  }
}

test("TUI PBT: random result histories keep statuses, progress and secondary credits consistent", async () => {
  const outcome = await forAll({
    name: "tui-render-history",
    seeds: 60,
    maxActions: 16,
    run: (rng, seed, count) => {
      const direction = rng() < 0.5 ? "higher" : "lower";
      const noKeep = rng() < 0.2;
      const allowZeroMetric = rng() < 0.2;
      const results = Array.from({ length: count }, (_, index) =>
        makeResult(rng, index, { noKeep, allowZeroMetric }));
      const log = results.map((r) => `${r.commit}:${r.status}:${r.metric}`);
      guard(seed, log, () => {
        const lines = renderDashboardLines(makeState(results, direction), 200, th, count);
        const text = lines.join("\n");
        for (const line of lines) {
          assert.equal(line.includes("\n"), false, "rendered row must be single-line");
          assert.ok(line.length <= 200, `rendered row exceeds width: ${line}`);
        }
        assert.doesNotMatch(text, /NaN|undefined/, "unrendered metric leaked into TUI");

        const counts = Object.fromEntries(STATUSES.map((status) => [
          status, results.filter((r) => r.status === status).length,
        ]));
        assert.match(text, new RegExp(`${counts.keep} kept`), "kept count lost");
        for (const [status, label] of [["discard", "discarded"], ["crash", "crashed"], ["checks_failed", "checks failed"]]) {
          if (counts[status] > 0) assert.match(text, new RegExp(`${counts[status]} ${label}`), `${label} count lost`);
        }
        for (const status of new Set(results.map((r) => r.status))) {
          assert.match(text, new RegExp(`\\b${status}\\b`), `status ${status} missing from table`);
        }
        for (const result of results) {
          assert.match(text, new RegExp(`\\b${result.description}(?!\\d)`), "a run disappeared from the table");
        }

        const best = oracleBestKeep(results, direction);
        const progress = lines.find((line) => line.includes("Progress:"));
        if (best === null) {
          assert.equal(progress, undefined, "no Progress line without a positive keep");
        } else {
          assert.ok(progress, "Progress must show the best keep");
          assert.match(progress, new RegExp(`bugfix_score_v2: ${best.metric}(?!\\d)`), "wrong best primary metric");
          // Secondary metrics are wrapped onto following indented lines, not appended to Progress.
          for (const name of SECONDARY) {
            assert.match(text, new RegExp(`${name}: ${best.metrics[name]}(?!\\d)`), `${name} does not belong to the best keep`);
          }
        }
      });
    },
  });
  assert.equal(outcome.pbtFail, 0, "TUI render property failed");
});

test("TUI PBT edge: no keep means no Progress line", () => {
  const results = [
    { commit: "d1", metric: 42, metrics: { bugfix_score_v2: 42, discovery_credit: 1, fix_credit: 2, detector_tests: 3, proof_tests: 4 }, status: "discard", description: "run-0", timestamp: 0, segment: 0, epoch: 1 },
    { commit: "c1", metric: 7, metrics: { bugfix_score_v2: 7, discovery_credit: 1, fix_credit: 2, detector_tests: 3, proof_tests: 4 }, status: "crash", description: "run-1", timestamp: 1, segment: 0, epoch: 1 },
  ];
  const lines = renderDashboardLines(makeState(results, "higher"), 200, th, results.length);
  assert.equal(lines.some((line) => line.includes("Progress:")), false);
  assert.match(lines.join("\n"), /0 kept/);
});

test("TUI PBT edge: a keep with metric 0 does not open Progress", () => {
  const result = {
    commit: "k0", metric: 0, metrics: { bugfix_score_v2: 0, discovery_credit: 11, fix_credit: 12, detector_tests: 13, proof_tests: 14 }, status: "keep", description: "run-0", timestamp: 0, segment: 0, epoch: 1,
  };
  const lines = renderDashboardLines(makeState([result], "higher"), 200, th, 1);
  assert.equal(lines.some((line) => line.includes("Progress:")), false);
  assert.match(lines.join("\n"), /1 kept/);
});

test("TUI PBT: every formatted METRIC survives parse → TUI with its own value", async () => {
  const outcome = await forAll({
    name: "tui-metric-roundtrip",
    seeds: 60,
    maxActions: 4,
    run: (rng, seed) => {
      const score = {
        score: genInt(rng, 1, 99), // renderer needs a positive primary metric to open the Progress block
        discoveryCredit: genInt(rng, 0, 40),
        fixCredit: genInt(rng, 0, 40),
        detectorTests: genInt(rng, 0, 9),
        proofTests: genInt(rng, 0, 9),
        creditedDefects: genInt(rng, 0, 9),
        severityWeighted: genInt(rng, 0, 99),
        regressionFailures: genInt(rng, 0, 9),
        newRegressions: genInt(rng, 0, 9),
        changedLines: genInt(rng, 0, 999),
        changedLinesOverBudget: genInt(rng, 0, 999),
        scorerChanged: genInt(rng, 0, 1),
        invalidKeeps: genInt(rng, 0, 9),
        tentativeCredit: genInt(rng, 0, 9),
        duplicateCredits: genInt(rng, 0, 9),
        testsTotal: genInt(rng, 80, 140),
        testsGain: genInt(rng, 0, 60),
      };
      const expected = {
        bugfix_score_v2: score.score,
        discovery_credit: score.discoveryCredit,
        fix_credit: score.fixCredit,
        detector_tests: score.detectorTests,
        proof_tests: score.proofTests,
        mutation_proven_fixed: score.creditedDefects,
        weighted_defects: score.severityWeighted,
        regression_failures: score.regressionFailures,
        new_regressions: score.newRegressions,
        changed_lines: score.changedLines,
        changed_lines_over_budget: score.changedLinesOverBudget,
        scorer_changed: score.scorerChanged,
        invalid_proofs: score.invalidKeeps,
        tentative_credit: score.tentativeCredit,
        duplicate_credits: score.duplicateCredits,
        tests_total: score.testsTotal,
        tests_gain: score.testsGain,
      };
      const log = METRIC_NAMES.map((name) => `${name}=${expected[name]}`);
      guard(seed, log, () => {
        const lines = formatMetricLines(score);
        assert.deepEqual(lines, METRIC_NAMES.map((name) => `METRIC ${name}=${expected[name]}`));
        const parsed = Object.fromEntries(lines.map((line) => {
          const match = /^METRIC ([A-Za-z0-9_]+)=(.*)$/.exec(line);
          assert.ok(match, `malformed METRIC line ${line}`);
          return [match[1], Number(match[2])];
        }));
        assert.deepEqual(parsed, expected, "value detached from its METRIC name");

        const rendered = renderDashboardLines(makeState([{
          commit: "pbt", metric: parsed.bugfix_score_v2, metrics: parsed,
          status: "keep", description: "pbt-metric", timestamp: 0, segment: 0, epoch: 1,
        }], "higher"), 220, th, 1).join("\n");
        assert.match(rendered, new RegExp(`bugfix_score_v2: ${parsed.bugfix_score_v2}(?!\\d)`));
        for (const name of SECONDARY) {
          assert.match(rendered, new RegExp(`${name}: ${parsed[name]}(?!\\d)`), `${name} lost in TUI`);
        }
        assert.doesNotMatch(rendered, /NaN|undefined/);
      });
    },
  });
  assert.equal(outcome.pbtFail, 0, "TUI metric roundtrip property failed");
});
