/**
 * Exhaustion hint engine (design.md §12.3, §12.3a, §12.3b, §12.4, §12.4a, §15.5 T107–T126;
 * requirements FR-06.3).
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/exhaustion-hints.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ADVISORY_DISCLAIMER,
  ADVISORY_THRESHOLDS,
  COMPARISONS_CAP,
  EXHAUSTION_DISCLAIMER,
  FIRST_KEYS_LIMIT,
  REF_CHECKS_PER_CALL,
  affectedWithinFirst16,
  classifyWindow,
  compareExhaustionKeys,
  computeExhaustionState,
  exhaustionHintsBetween,
  exhaustionKeyId,
  first16Keys,
  segmentMaximum,
  sortExhaustionKeys,
} from "../extensions/pi-autoresearch/exhaustion-hints.ts";

// ---------------------------------------------------------------------------
// Fixture builder: real files in a temp .auto directory
// ---------------------------------------------------------------------------

const PREREG = "pre-k1-00000001";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON (sorted keys, undefined dropped) — the analysis content hash form. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sealAnalysis(record) {
  return JSON.stringify({ ...record, content_sha256: sha256(canonical(record)) });
}

function hex32(n) {
  return n.toString(16).padStart(32, "0");
}

class Fixture {
  constructor(t, { metricName = "F1", bestDirection = "higher" } = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-"));
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    this.autoDir = path.join(this.root, ".auto");
    fs.mkdirSync(this.autoDir);
    this.logLines = [JSON.stringify({ type: "config", name: "t", metricName, metricUnit: "", bestDirection })];
    this.analysisLines = [];
    this.links = [];
    this.pending = new Map();
    this.runs = new Set();
    this.metricName = metricName;
    this.seq = 0;
    this.noLog = false;
  }

  logText() {
    return this.logLines.map((line) => `${line}\n`).join("");
  }

  analysisText() {
    return this.analysisLines.map((line) => `${line}\n`).join("");
  }

  /** Add a run: start, result and ordinary row lines (in that order). */
  addRun(run, metric, { link = true, snapshot = true, epoch = 1, node = "n1" } = {}) {
    const startedAt = `2026-11-05T10:00:00.${String(run).padStart(3, "0")}Z`;
    const start = JSON.stringify({ type: "run_started", run_dir: run, node_id: node, command: "bench", started_at: startedAt });
    const result = JSON.stringify({
      type: "run_result",
      run_dir: run,
      started_at: startedAt,
      node_id: node,
      exit_code: 0,
      killed: false,
      duration_seconds: 1,
    });
    const row = JSON.stringify({
      run,
      commit: "abc1234",
      metric,
      metrics: { [this.metricName]: metric },
      status: "keep",
      description: "d",
      timestamp: run,
      segment: 0,
      epoch,
      confidence: null,
    });
    const analysisText = this.analysisText();
    this.pending.set(run, {
      start,
      result,
      row,
      snapBytes: snapshot ? Buffer.byteLength(analysisText) : null,
      snapSha: snapshot ? sha256(analysisText) : null,
    });
    this.logLines.push(start, result, row);
    this.runs.add(run);
    if (link) this.linkRun(run);
    return this;
  }

  /** Write the sidecar record of a run (late link: the snapshot taken at its start is kept). */
  linkRun(run) {
    const p = this.pending.get(run);
    if (this.links.includes(run)) return this;
    this.links.push(run);
    this.linkLines = this.linkLines ?? [];
    this.linkLines.push(
      JSON.stringify({
        v: 1,
        execution_id: hex32(run),
        run_dir: run,
        started_sha256: sha256(p.start),
        result_sha256: sha256(p.result),
        log_sha256: sha256(p.row),
        analysis_prefix_bytes: p.snapBytes,
        analysis_prefix_sha256: p.snapSha,
      }),
    );
    return this;
  }

  addPrereg({
    id = PREREG,
    axis = "s21",
    rule = { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 3 },
    noise = true,
    noiseRef = { run: 1, artifact: "output", lines: null, anchor: null },
    hypothesisId,
  } = {}) {
    const prefix = this.logText();
    const record = {
      v: 1,
      record: "analysis",
      kind: "prereg",
      id,
      recorded_at: "2026-11-05T09:00:00.000Z",
      axis,
      branches: [{ name: "champion_stronger", metric_name: "F1", op: ">=", threshold: 0.5952, meaning: "x" }],
      exhaustion_rule: rule,
      ledger_prefix_bytes: Buffer.byteLength(prefix),
      ledger_prefix_sha256: sha256(prefix),
    };
    if (hypothesisId !== undefined) record.hypothesis_id = hypothesisId;
    if (noise) {
      record.noise_band = 0.002;
      record.noise_basis_ref = noiseRef;
    }
    this.analysisLines.push(sealAnalysis(record));
    return this;
  }

  addComparison({
    axis = "s21",
    prereg = PREREG,
    baseline = 1,
    candidate,
    changed = [],
    metricName,
    id,
  }) {
    this.seq++;
    const record = {
      v: 1,
      record: "analysis",
      kind: "comparison",
      id: id ?? `cmp-${this.seq}`,
      recorded_at: "2026-11-05T09:30:00.000Z",
      purpose: "exploration",
      baseline_run: baseline,
      candidate_run: candidate,
    };
    if (changed !== null) record.changed_components = changed;
    if (metricName !== undefined) record.metric_name = metricName;
    if (axis !== undefined) record.axis = axis;
    if (prereg !== null) record.prereg_id = prereg;
    this.analysisLines.push(sealAnalysis(record));
    return this;
  }

  /** A measurement_change row: it becomes the active scale for runs started after it (§5.2a). */
  addScaleChange(epoch) {
    this.logLines.push(JSON.stringify({ type: "measurement_change", change_ref: `e${epoch}`, epoch, needs_verification: true, justification: "rescore" }));
    return this;
  }

  addTornLine() {
    this.analysisLines.push('{"v":1,"record":"analysis","kind":"comparison","id":"cmp-to');
    return this;
  }

  flush() {
    if (!this.noLog) fs.writeFileSync(path.join(this.autoDir, "log.jsonl"), this.logText());
    fs.writeFileSync(path.join(this.autoDir, "analysis.jsonl"), this.analysisText());
    if (this.links.length > 0) {
      fs.writeFileSync(path.join(this.autoDir, "run-links.jsonl"), `${this.linkLines.join("\n")}\n`);
    }
    for (const run of this.runs) {
      const dir = path.join(this.autoDir, "runs", String(run));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "output.txt"), "METRIC F1=0.5\n");
    }
    return this;
  }

  compute() {
    this.flush();
    return computeExhaustionState(this.autoDir);
  }
}

/** Only the S_exh (per-key) hints; advisory S_exh_adv hints are asserted in their own tests. */
function sExh(hints) {
  return hints.filter((hint) => hint.kind === "S_exh");
}

/** Add one comparison; `hints` = S_exh hints, `all` = every hint the record produces (§12.4). */
function stepComparison(fx, options) {
  const before = fx.compute();
  fx.addComparison(options);
  const after = fx.compute();
  const all = exhaustionHintsBetween(before, after);
  return { before, after, all, hints: sExh(all) };
}

/** Candidates 2..n with the same metric, compared against baseline run 1. */
function keyReport(state, axis = "s21", prereg = PREREG) {
  return state.keys.find((key) => key.key.axis === axis && key.key.prereg_id === prereg && key.key.run_epoch === 1);
}

// Metric 0.5 baseline: gains 0.008 (below T=0.009, within noise B=0.002 → not beyond),
// 0.005 (below T−B=0.007 → beyond). Values chosen away from boundaries.
const G_WITHIN = 0.508;
const G_BEYOND = 0.505;
const G_ABOVE = 0.52;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("classifyWindow: beyond, within noise, not triggered (higher)", () => {
  const rule = { direction: "higher", threshold: 0.009, noiseBand: 0.002 };
  const pair = (candidate) => ({ candidate, baseline: 0.5 });
  assert.deepEqual(classifyWindow([pair(G_BEYOND), pair(G_BEYOND), pair(G_BEYOND)], rule), {
    stage: 2,
    code: "beyond_noise_series",
  });
  assert.deepEqual(classifyWindow([pair(G_WITHIN), pair(G_BEYOND), pair(G_BEYOND)], rule), {
    stage: 1,
    code: "below_threshold_within_noise",
  });
  assert.deepEqual(classifyWindow([pair(G_BEYOND), pair(G_ABOVE), pair(G_BEYOND)], rule), {
    stage: 0,
    code: "not_triggered",
  });
  assert.deepEqual(classifyWindow([], rule), { stage: null, code: "window_short" });
});

test("classifyWindow: lower direction uses baseline − candidate", () => {
  const rule = { direction: "lower", threshold: 0.009, noiseBand: 0.002 };
  // Candidate 0.492 against baseline 0.5 is an improvement of 0.008 (within noise).
  const within = { candidate: 0.492, baseline: 0.5 };
  assert.equal(classifyWindow([within, within, within], rule).stage, 1);
  // Candidate 0.508 is worse by 0.008 → gain −0.008 < T−B → beyond.
  const worse = { candidate: 0.508, baseline: 0.5 };
  assert.equal(classifyWindow([worse, worse, worse], rule).stage, 2);
  // The same worse values read as an improvement under higher → not triggered.
  const higher = { direction: "higher", threshold: 0.009, noiseBand: 0.002 };
  assert.equal(classifyWindow([worse, worse, worse], higher).stage, 1);
  const improvedHigher = { candidate: 0.52, baseline: 0.5 };
  assert.equal(classifyWindow([improvedHigher, improvedHigher, improvedHigher], higher).stage, 0);
});

test("segmentMaximum: unknown wins over known stages; empty segment is 0", () => {
  assert.equal(segmentMaximum([]), 0);
  assert.equal(segmentMaximum([1, 2, 0]), 2);
  assert.equal(segmentMaximum([1, null, 2]), "unknown");
});

test("budget constants match the design (§12.3a, §10.3)", () => {
  assert.equal(FIRST_KEYS_LIMIT, 16);
  assert.equal(COMPARISONS_CAP, 200);
  assert.equal(REF_CHECKS_PER_CALL, 20);
  assert.deepEqual([...ADVISORY_THRESHOLDS], [3, 6]);
});

test("key order is axis, prereg_id, then run_epoch as an integer", () => {
  const keys = [
    { axis: "b", prereg_id: "pre-x-00000001", run_epoch: 1 },
    { axis: "a", prereg_id: "pre-y-00000001", run_epoch: 10 },
    { axis: "a", prereg_id: "pre-y-00000001", run_epoch: 2 },
    { axis: "a", prereg_id: "pre-x-00000002", run_epoch: 1 },
  ];
  const sorted = sortExhaustionKeys(keys).map(exhaustionKeyId);
  assert.deepEqual(sorted, ["a|pre-x-00000002|1", "a|pre-y-00000001|2", "a|pre-y-00000001|10", "b|pre-x-00000001|1"]);
  assert.equal(compareExhaustionKeys(keys[2], keys[1]) < 0, true);
});

test("first16Keys and affected intersection are deterministic regardless of input order", () => {
  const keys = [];
  for (let i = 0; i < 20; i++) {
    keys.push({ axis: `ax${String(19 - i).padStart(2, "0")}`, prereg_id: PREREG, run_epoch: 1 });
  }
  const shuffled = [...keys].reverse();
  const first = first16Keys(keys);
  assert.equal(first.length, 16);
  assert.deepEqual(first16Keys(shuffled), first);
  assert.equal(first[0].axis, "ax00");
  // Key 17 in global order (ax16) is outside the first 16; the affected intersection drops it.
  const seventeenth = first16Keys(keys)[15];
  const outside = keys.find((key) => key.axis === "ax17");
  assert.deepEqual(affectedWithinFirst16(keys, [outside]), []);
  assert.deepEqual(affectedWithinFirst16(keys, [seventeenth]), [seventeenth]);
});

// ---------------------------------------------------------------------------
// Stage transitions and hints (§12.3a, T108, T111, T112)
// ---------------------------------------------------------------------------

test("stage up over history maxima issues one hint with the unknown-comparability disclaimer", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  const candidates = [G_WITHIN, G_WITHIN, G_WITHIN, G_BEYOND, G_BEYOND, G_BEYOND, G_BEYOND, G_BEYOND, G_BEYOND];
  candidates.forEach((metric, i) => fx.addRun(2 + i, metric));

  const hintsPerStep = [];
  for (let i = 0; i < candidates.length; i++) {
    hintsPerStep.push(stepComparison(fx, { candidate: 2 + i }).hints);
  }

  // Window ends: c4 → stage 1 (H 0 → 1); c7 → stage 2 (H 1 → 2); nothing else.
  const issued = hintsPerStep.map((hints, i) => ({ step: i + 2, hints: hints.length }));
  assert.deepEqual(
    issued.filter((entry) => entry.hints > 0),
    [
      { step: 4, hints: 1 },
      { step: 7, hints: 1 },
    ],
  );
  const first = hintsPerStep[2][0];
  assert.equal(first.kind, "S_exh");
  assert.equal(first.stage, 1);
  assert.equal(first.axis, "s21");
  assert.equal(first.key.prereg_id, PREREG);
  assert.equal(first.key.run_epoch, 1);
  assert.ok(first.text.includes(EXHAUSTION_DISCLAIMER), "disclaimer is mandatory");
  assert.ok(first.text.includes("Ключ: (s21, pre-k1-00000001, 1)"));
  assert.ok(first.text.includes("Оснований для вывода об исчерпании оси s21 недостаточно"));
  const second = hintsPerStep[5][0];
  assert.equal(second.stage, 2);
  assert.ok(second.text.includes("Кандидат на пересмотр оси s21"));
  assert.ok(second.text.includes("Это не вывод об исчерпании"));
  for (const hint of [first, second]) {
    assert.equal(hint.text.includes("исчерпана"), false, "never states that the axis is exhausted");
  }
});

test("at most two hints per key-epoch segment: stages 1 then 2, no repeats", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 12; r++) fx.addRun(r, r < 5 ? G_WITHIN : G_BEYOND);
  let total = 0;
  for (let r = 2; r <= 12; r++) total += stepComparison(fx, { candidate: r }).hints.length;
  assert.equal(total, 2);
  const state = fx.compute();
  assert.equal(keyReport(state).historyMax, 2);
});

test("window before stage growth yields no hint and H stays unknown-free", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_ABOVE).addRun(3, G_ABOVE).addRun(4, G_ABOVE);
  const steps = [2, 3, 4].map((r) => stepComparison(fx, { candidate: r }));
  for (const step of steps) assert.deepEqual(step.hints, []);
  const report = keyReport(steps[2].after);
  assert.equal(report.historyMax, 0);
  assert.deepEqual(report.display, { value: "false", code: null, detail: null }, "H = 0 after one complete window → false");
});

// ---------------------------------------------------------------------------
// Barriers, unknown handling and fail-closed rules (§12.3a «Барьеры», T109, T119, T123)
// ---------------------------------------------------------------------------

test("null-epoch element poisons pair windows; windows on either side are computed independently", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_WITHIN).addRun(3, G_WITHIN).addRun(4, G_WITHIN);
  fx.addRun(5, G_WITHIN, { link: false }); // no sidecar → run_epoch null
  fx.addRun(6, G_WITHIN).addRun(7, G_WITHIN).addRun(8, G_WITHIN);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const hintAt4 = stepComparison(fx, { candidate: 4 });
  assert.equal(keyReport(hintAt4.after).historyMax, 1);

  const barrier = stepComparison(fx, { candidate: 5 });
  assert.deepEqual(barrier.hints, []);
  assert.equal(barrier.after.barriers.length, 1);
  assert.equal(barrier.after.barriers[0].code, "epoch_unproven");
  assert.deepEqual(barrier.after.barriers[0].scope, { kind: "pair", axis: "s21", preregId: PREREG });

  // Element after the barrier: segment of 1 element, window crossing the barrier → not assessed.
  const afterBarrier = stepComparison(fx, { candidate: 6 });
  const r1 = keyReport(afterBarrier.after);
  assert.equal(r1.lastWindow.code, "epoch_unproven");
  assert.equal(r1.historyMax, 0, "segment after the barrier has no complete window");
  assert.deepEqual(r1.display, { value: "unknown", code: "window_short", detail: null });

  // Two elements after the barrier: the window [4, 6, 7] still crosses it.
  stepComparison(fx, { candidate: 7 });
  assert.equal(keyReport(fx.compute()).lastWindow.code, "epoch_unproven");

  // Three elements after the barrier: the window [6, 7, 8] lies on one side, computed normally.
  const third = stepComparison(fx, { candidate: 8 });
  const r3 = keyReport(third.after);
  assert.equal(r3.lastWindow.stage, 1);
  assert.equal(r3.historyMax, 1);
  assert.equal(third.hints.length, 1, "a repeat of stage 1 after a barrier is allowed once per segment");
  assert.equal(third.hints[0].stage, 1);
});

test("torn analysis line is a barrier: window across it is incomplete_data, count reported", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_WITHIN);
  fx.addComparison({ candidate: 2 }).addComparison({ candidate: 3 }).addTornLine();
  fx.addComparison({ candidate: 4 });
  const state = fx.compute();
  assert.equal(state.unreadableLines, 1);
  assert.equal(state.complete, false);
  const report = keyReport(state);
  assert.equal(report.lastWindow.code, "incomplete_data");
  assert.equal(report.historyMax, 0);
  assert.equal(state.barriers[0].code, "incomplete_data");
  assert.deepEqual(state.barriers[0].scope, { kind: "all" });
});

test("window after a torn line is computed independently of elements before it", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 9; r++) fx.addRun(r, r <= 4 ? G_BEYOND : G_ABOVE);
  fx.addComparison({ candidate: 2 }).addComparison({ candidate: 3 }).addComparison({ candidate: 4 });
  const before = fx.compute();
  assert.equal(keyReport(before).historyMax, 2);
  fx.addTornLine();
  for (let r = 5; r <= 7; r++) fx.addComparison({ candidate: r });
  const state = fx.compute();
  const report = keyReport(state);
  // Segment after the barrier holds 3 elements (5, 6, 7), all above threshold → stage 0.
  assert.equal(report.segmentCount, 3);
  assert.equal(report.historyMax, 0);
  assert.equal(report.lastWindow.stage, 0);
});

test("repeat hint after a global barrier is allowed once per segment", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 8; r++) fx.addRun(r, G_BEYOND);
  const hints = [];
  for (const r of [2, 3, 4]) hints.push(...stepComparison(fx, { candidate: r }).hints);
  assert.deepEqual(hints.map((hint) => hint.stage), [2]);

  fx.addTornLine();
  const afterTorn = fx.compute();
  assert.equal(keyReport(afterTorn).historyMax, 0, "new segment starts empty");

  const repeat = [];
  for (const r of [5, 6, 7, 8]) repeat.push(...stepComparison(fx, { candidate: r }).hints);
  assert.deepEqual(repeat.map((hint) => hint.stage), [2], "one repeat in the new segment, none after it");
});

test("barrier removal (proven epoch recovery) gives no hint in that transition", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_WITHIN);
  fx.addRun(5, G_WITHIN, { link: false }).addRun(6, G_WITHIN);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  fx.addComparison({ candidate: 5 });
  fx.addComparison({ candidate: 6 });
  const before = fx.compute();
  assert.equal(before.barriers.length, 1);

  // The sidecar record of run 5 appears later (the epoch becomes proven, barrier removed).
  fx.linkRun(5);
  const after = fx.compute();
  assert.equal(after.barriers.length, 0);
  assert.equal(keyReport(after).historyMax, 1, "merged segment is now computed");
  assert.deepEqual(sExh(exhaustionHintsBetween(before, after)), []);
});

test("missing preregistration: no S_exh hints; advisory signal still counts", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  let hints = [];
  for (const r of [2, 3, 4]) {
    const step = stepComparison(fx, { axis: "s21", prereg: null, candidate: r });
    hints.push(...step.all);
  }
  assert.equal(hints.filter((hint) => hint.kind === "S_exh").length, 0);
  const state = fx.compute();
  assert.equal(state.keys.length, 0);
  assert.equal(state.barriers[0].code, "prereg_unknown");
  assert.deepEqual(hints.map((hint) => hint.kind), ["S_exh_adv"], "advisory at n = 3 is allowed without prereg");
});

test("unknown prefix or post-hoc candidate poisons H and yields the matching code", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addRun(2, G_WITHIN);
  fx.addPrereg();
  fx.addRun(3, G_WITHIN).addRun(4, G_WITHIN);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const state = fx.compute();
  const report = keyReport(state);
  // Candidate 2 started before the prereg was recorded → post_hoc → window not assessed.
  assert.equal(report.historyMax, "unknown");
  assert.equal(report.historyCode, "post_hoc_prereg");
  assert.equal(report.lastWindow.code, "post_hoc_prereg");
});

test("candidate without analysis snapshot is unknown (prereg_order_unknown), never trusted", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_BEYOND, { snapshot: false }).addRun(3, G_BEYOND).addRun(4, G_BEYOND);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const report = keyReport(fx.compute());
  assert.equal(report.historyMax, "unknown");
  assert.equal(report.lastWindow.code, "prereg_order_unknown");
});

test("no noise basis: complete windows are no_noise_basis, never false", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg({ noise: false });
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_ABOVE);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const report = keyReport(fx.compute());
  assert.equal(report.lastWindow.code, "no_noise_basis");
  assert.equal(report.historyMax, "unknown");
  assert.deepEqual(report.display, { value: "unknown", code: "no_noise_basis", detail: null });
});

test("unreadable noise reference: noise_ref_unavailable", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg({ noiseRef: { run: 9, artifact: "output", lines: null, anchor: null } });
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const report = keyReport(fx.compute());
  assert.equal(report.lastWindow.code, "noise_ref_unavailable");
  assert.equal(report.historyMax, "unknown");
});

test("unknown control (changed_components not declared) is a barrier, never a window", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  for (const r of [2, 3]) fx.addComparison({ candidate: r, changed: null });
  fx.addComparison({ candidate: 4 });
  const state = fx.compute();
  assert.equal(state.barriers.length, 2);
  assert.ok(state.barriers.every((barrier) => barrier.code === "control_unknown"));
  const report = keyReport(state);
  assert.equal(report.eligibleCount, 1);
  assert.equal(report.historyMax, 0);
});

test("declared multiple changes are uncontrolled and excluded without a barrier", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r, changed: ["weights", "prompt"] });
  const state = fx.compute();
  assert.equal(state.barriers.length, 0);
  assert.equal(keyReport(state).eligibleCount, 0);
});

test("metric name mismatch with the rule → metric_context_unknown (window, not false)", (t) => {
  const fx = new Fixture(t, { metricName: "F2" }).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const report = keyReport(fx.compute());
  assert.equal(report.lastWindow.code, "metric_context_unknown");
  assert.equal(report.historyMax, "unknown");
});

test("comparison metric_name that differs from the header is a metric-context barrier", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  fx.addComparison({ candidate: 2 }).addComparison({ candidate: 3, metricName: "F2" }).addComparison({ candidate: 4 });
  const state = fx.compute();
  assert.equal(state.barriers[0].code, "metric_context_unknown");
  assert.equal(keyReport(state).historyMax, 0);
});

test("lower direction: an improvement below threshold is stage 1 and issues the hint", (t) => {
  const fx = new Fixture(t, { bestDirection: "lower" }).addRun(1, 0.5).addPrereg({
    rule: { metric_name: "F1", direction: "lower", threshold_gain: 0.009, k: 3 },
  });
  for (let r = 2; r <= 4; r++) fx.addRun(r, 0.492);
  const hints = [];
  for (const r of [2, 3, 4]) hints.push(...stepComparison(fx, { candidate: r }).hints);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].stage, 1);
  assert.equal(hints[0].key.prereg_id, PREREG);
});

test("ledger missing: nothing is trusted and no hints are issued", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  fs.rmSync(path.join(fx.autoDir, "log.jsonl"), { force: true });
  fx.noLog = true;
  const state = computeExhaustionState(fx.autoDir);
  assert.equal(state.ledger, "missing");
  assert.equal(state.complete, false);
  const hints = exhaustionHintsBetween(state, state);
  assert.deepEqual(hints, []);
});

// ---------------------------------------------------------------------------
// Advisory signal S_exh_adv (§12.3b, T122, T126)
// ---------------------------------------------------------------------------

test("advisory fires exactly at 3 and 6 readable comparisons per axis, not at 4 or 5", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg({ axis: "s30", id: "pre-k2-00000002" });
  for (let r = 2; r <= 8; r++) fx.addRun(r, G_ABOVE);
  const firedAt = [];
  for (let n = 1; n <= 7; n++) {
    const step = stepComparison(fx, { axis: "s30", prereg: "pre-k2-00000002", candidate: n + 1 });
    for (const hint of step.all.filter((h) => h.kind === "S_exh_adv")) firedAt.push({ n: step.after.axes[0].n, threshold: hint.threshold });
  }
  assert.deepEqual(firedAt, [
    { n: 3, threshold: 3 },
    { n: 6, threshold: 6 },
  ]);
});

test("advisory wording names the axis, count and the not-confirmed disclaimer", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_ABOVE);
  fx.addTornLine();
  let advisory = null;
  for (const r of [2, 3, 4]) {
    const step = stepComparison(fx, { axis: "s30", prereg: null, candidate: r });
    const found = step.all.find((hint) => hint.kind === "S_exh_adv");
    if (found) advisory = found;
  }
  assert.ok(advisory, "advisory issued at n = 3");
  assert.equal(advisory.axis, "s30");
  assert.equal(advisory.n, 3);
  assert.ok(advisory.text.includes("накоплено 3 читаемых сравнений"));
  assert.ok(advisory.text.includes(ADVISORY_DISCLAIMER));
  assert.ok(advisory.text.includes("Исчерпание направления и сопоставимость результатов не подтверждены"));
  assert.ok(advisory.text.includes("нечитаемых строк анализа 1"), "incomplete history is marked");
  assert.ok(advisory.text.includes("cmp-"), "references to readable records are listed");
  assert.equal(advisory.text.includes("исчерпана"), false);
});

test("advisory is computed from readable comparisons only (torn lines are not counted)", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  fx.addComparison({ axis: "s30", prereg: null, candidate: 1 }).addTornLine();
  const state = fx.compute();
  assert.equal(state.axes.find((axis) => axis.axis === "s30").n, 1);
  assert.equal(state.unreadableLines, 1);
});

// ---------------------------------------------------------------------------
// Budgets (§12.3a «Объём», §10.3, T116, T117)
// ---------------------------------------------------------------------------

test("17th campaign key is unknown (key_limit) and receives no hint even when its windows are full", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  const seventeenthId = `pre-k${16}-${(16).toString(16).padStart(8, "0")}`;
  for (let i = 0; i < 17; i++) {
    const id = `pre-k${i}-${i.toString(16).padStart(8, "0")}`;
    fx.addPrereg({ id, axis: `ax${String(i).padStart(2, "0")}` });
    for (let j = 0; j < 3; j++) {
      const run = 2 + i * 3 + j;
      fx.addRun(run, G_BEYOND);
    }
  }
  for (let i = 0; i < 17; i++) {
    const id = `pre-k${i}-${i.toString(16).padStart(8, "0")}`;
    for (let j = 0; j < 3; j++) {
      const run = 2 + i * 3 + j;
      if (i === 16 && j === 2) break;
      fx.addComparison({ axis: `ax${String(i).padStart(2, "0")}`, prereg: id, candidate: run });
    }
  }
  const before = fx.compute();
  assert.equal(before.keys.length, 17);
  assert.equal(before.keys.filter((key) => key.assessed).length, 16);
  const seventeenth = before.keys[16];
  assert.equal(seventeenth.key.prereg_id, seventeenthId);
  assert.equal(seventeenth.assessed, false);
  assert.equal(seventeenth.budgetDetail, "key_limit");
  assert.deepEqual(seventeenth.display, { value: "unknown", code: "budget_exhausted", detail: "key_limit" });

  fx.addComparison({ axis: "ax16", prereg: seventeenthId, candidate: 2 + 16 * 3 + 2 });
  const after = fx.compute();
  const affected = affectedWithinFirst16(
    after.keys.map((key) => key.key),
    [after.keys[16].key],
  );
  assert.deepEqual(affected, [], "key 17 is outside the global first 16");
  assert.deepEqual(sExh(exhaustionHintsBetween(before, after, { affectedKeys: [after.keys[16].key] })), []);
});

test("more than 200 eligible comparisons on one key → unknown (comparison_cap), no hints", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addRun(2, G_BEYOND).addPrereg();
  for (let i = 0; i <= COMPARISONS_CAP; i++) fx.addComparison({ candidate: 2 });
  const state = fx.compute();
  const report = keyReport(state);
  assert.equal(report.eligibleCount, COMPARISONS_CAP + 1);
  assert.equal(report.assessed, false);
  assert.equal(report.budgetDetail, "comparison_cap");
  assert.deepEqual(report.display, { value: "unknown", code: "budget_exhausted", detail: "comparison_cap" });
  assert.deepEqual(exhaustionHintsBetween(state, state), []);
});

test("exactly 200 eligible comparisons are still assessed", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addRun(2, G_BEYOND).addPrereg();
  for (let i = 0; i < COMPARISONS_CAP; i++) fx.addComparison({ candidate: 2 });
  const report = keyReport(fx.compute());
  assert.equal(report.assessed, true);
  assert.equal(report.eligibleCount, COMPARISONS_CAP);
});

// ---------------------------------------------------------------------------
// Determinism, restart and reading files (§12.3a «Рестарт», T115)
// ---------------------------------------------------------------------------

test("same files give the same state (restart), and key order is deterministic", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_WITHIN);
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const first = fx.compute();
  const second = computeExhaustionState(fx.autoDir);
  assert.deepEqual(second, first);
  assert.equal(keyReport(first).historyMax, 1);
  const hintsAgain = sExh(exhaustionHintsBetween(first, second));
  assert.deepEqual(hintsAgain, [], "no transition when nothing changed; no repeat after restart");
});

test("stage hint from a fresh process equals the hint of the original process (T115)", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_WITHIN);
  fx.addComparison({ candidate: 2 }).addComparison({ candidate: 3 });
  const beforeLast = fx.compute();
  fx.addComparison({ candidate: 4 });
  const after = fx.compute();
  const hints = sExh(exhaustionHintsBetween(beforeLast, after));
  assert.equal(hints.length, 1);
  // Recomputing "before" from files (as a restarted process would) yields the same hint.
  const restarted = computeExhaustionState(fx.autoDir);
  assert.deepEqual(sExh(exhaustionHintsBetween(computeExhaustionState(fx.autoDir), restarted)), []);
});

test("unreadable analysis file degrades to unknown without throwing", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  fs.mkdirSync(path.join(fx.autoDir, "analysis.jsonl"));
  const state = computeExhaustionState(fx.autoDir);
  assert.equal(state.analysis, "unavailable");
  assert.equal(state.complete, false);
  assert.equal(state.axes, null);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(exhaustionHintsBetween(state, state), []);
});

test("display: window_short is unknown; H = 0 after a complete window is false; H ∈ {1,2} is true", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_ABOVE);
  fx.addComparison({ candidate: 2 });
  assert.deepEqual(keyReport(fx.compute()).display, { value: "unknown", code: "window_short", detail: null });
  fx.addComparison({ candidate: 3 }).addComparison({ candidate: 4 });
  assert.deepEqual(keyReport(fx.compute()).display, { value: "false", code: null, detail: null });

  const fx2 = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx2.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) fx2.addComparison({ candidate: r });
  assert.deepEqual(keyReport(fx2.compute()).display, { value: "true", code: null, detail: null });
});

test("the hint text never uses forbidden wording and never states a delta as fact", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  const hints = [];
  for (const r of [2, 3, 4]) hints.push(...stepComparison(fx, { candidate: r }).hints);
  assert.equal(hints.length, 1);
  for (const hint of hints) {
    for (const forbidden of ["исчерпана", "доказано", "причина установлена", "вероятность успеха", "уверенность"]) {
      assert.equal(hint.text.includes(forbidden), false, `forbidden phrase: ${forbidden}`);
    }
    assert.ok(hint.text.includes("не подтверждены"));
  }
});

// ---------------------------------------------------------------------------
// Epochs, noise references and hypothesis matching (§5.2a, §9.3, §10.3)
// ---------------------------------------------------------------------------

test("T114: a new scale epoch is a new key with H = 0; epoch-1 history does not enter epoch-2 windows", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
  const epochOne = [];
  for (const r of [2, 3, 4]) epochOne.push(...stepComparison(fx, { candidate: r }).hints);
  assert.deepEqual(epochOne.map((hint) => [hint.key.run_epoch, hint.stage]), [[1, 2]]);

  fx.addScaleChange(2);
  fx.addRun(5, 0.5, { epoch: 2 });
  for (let r = 6; r <= 8; r++) fx.addRun(r, G_BEYOND, { epoch: 2 });
  const epochTwo = [];
  for (const r of [6, 7, 8]) epochTwo.push(...stepComparison(fx, { baseline: 5, candidate: r }).hints);
  assert.deepEqual(epochTwo.map((hint) => [hint.key.run_epoch, hint.stage]), [[2, 2]]);
  const state = fx.compute();
  const keyEpochTwo = state.keys.find((key) => key.key.run_epoch === 2);
  assert.equal(keyEpochTwo.eligibleCount, 3);
  assert.equal(keyEpochTwo.historyMax, 2);
  // Epoch-1 comparisons now have a null run epoch (scale changed after their start): barriers.
  assert.ok(state.barriers.some((barrier) => barrier.code === "epoch_unproven"));
});

test("noise anchor and line range are checked against the referenced output file", (t) => {
  const cases = [
    { ref: { run: 1, artifact: "output", lines: null, anchor: "METRIC F1=" }, code: null, stage: 2 },
    { ref: { run: 1, artifact: "output", lines: null, anchor: "METRIC F9=" }, code: "noise_ref_unavailable" },
    { ref: { run: 1, artifact: "output", lines: [1, 1], anchor: null }, code: null, stage: 2 },
    { ref: { run: 1, artifact: "output", lines: [1, 5], anchor: null }, code: "noise_ref_unavailable" },
    { ref: { run: 1, artifact: "manifest", lines: null, anchor: null }, code: "noise_ref_unavailable" },
  ];
  for (const { ref, code, stage } of cases) {
    const fx = new Fixture(t).addRun(1, 0.5).addPrereg({ noiseRef: ref });
    for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
    for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
    const report = keyReport(fx.compute());
    if (code === null) {
      assert.equal(report.lastWindow.stage, stage, JSON.stringify(ref));
    } else {
      assert.equal(report.lastWindow.code, code, JSON.stringify(ref));
    }
  }
});

test("hypothesis_id must equal the candidate's node_id, else the candidate is unknown", (t) => {
  const mismatch = new Fixture(t).addRun(1, 0.5).addPrereg({ hypothesisId: "n7" });
  for (let r = 2; r <= 4; r++) mismatch.addRun(r, G_BEYOND);
  for (const r of [2, 3, 4]) mismatch.addComparison({ candidate: r });
  const report = keyReport(mismatch.compute());
  assert.equal(report.lastWindow.code, "prereg_order_unknown");
  assert.equal(report.historyMax, "unknown");

  const match = new Fixture(t).addRun(1, 0.5).addPrereg({ hypothesisId: "n7" });
  for (let r = 2; r <= 4; r++) match.addRun(r, G_BEYOND, { node: "n7" });
  for (const r of [2, 3, 4]) match.addComparison({ candidate: r });
  const matched = keyReport(match.compute());
  assert.equal(matched.lastWindow.stage, 2);
  assert.equal(matched.historyMax, 2);
});

test("a key whose earlier comparisons were barriers gets no hint once they are proven (prior maximum unknown)", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND, { link: false });
  for (const r of [2, 3, 4]) fx.addComparison({ candidate: r });
  const before = fx.compute();
  assert.equal(before.keys.length, 0, "null-epoch comparisons create no key, only barriers");
  assert.equal(before.barriers.length, 3);

  for (const r of [2, 3, 4]) fx.linkRun(r);
  const after = fx.compute();
  assert.equal(keyReport(after).historyMax, 2, "the key is computed once its runs are proven");
  assert.deepEqual(sExh(exhaustionHintsBetween(before, after)), []);
});

// ---------------------------------------------------------------------------
// Barrier removal (§12.3a «Барьеры», T125), cause priority (§12.3a), foreign lines (§6.4), advisory merge (§12.3b)
// ---------------------------------------------------------------------------

test("T125 / X1c: barrier removal lifts the merged segment above both known maxima → one stage-2 hint", (t) => {
  // Segment A [within, beyond, beyond] has H_A = 1; run 5 has no sidecar (barrier); segment B [beyond, beyond]
  // is shorter than K, so H_B = 0. The merged segment has H = 2 > max(1, 0).
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_WITHIN).addRun(3, G_BEYOND).addRun(4, G_BEYOND);
  fx.addRun(5, G_BEYOND, { link: false });
  fx.addRun(6, G_BEYOND).addRun(7, G_BEYOND);
  for (const r of [2, 3, 4, 5, 6, 7]) fx.addComparison({ candidate: r });
  const before = fx.compute();
  assert.equal(before.barriers.length, 1);
  assert.equal(before.barriers[0].code, "epoch_unproven");
  assert.equal(keyReport(before).historyMax, 0, "current segment B has no complete window");

  fx.linkRun(5);
  const after = fx.compute();
  assert.equal(after.barriers.length, 0);
  assert.equal(keyReport(after).historyMax, 2, "merged segment: windows [3,4,5] and later are stage 2");

  const hints = sExh(exhaustionHintsBetween(before, after));
  assert.equal(hints.length, 1, "exactly one hint for the raised stage");
  assert.equal(hints[0].stage, 2);
  assert.equal(hints[0].key.prereg_id, PREREG);
  assert.equal(hints[0].key.run_epoch, 1);
  assert.ok(hints[0].text.includes(EXHAUSTION_DISCLAIMER));
});

test("T125: barrier removal whose merged stage does not exceed the known maxima gives no hint", (t) => {
  // Both segments are stage 1 (A: 3 within-noise windows, B: too short); merged stage stays 1.
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  for (let r = 2; r <= 4; r++) fx.addRun(r, G_WITHIN);
  fx.addRun(5, G_WITHIN, { link: false }).addRun(6, G_WITHIN);
  for (const r of [2, 3, 4, 5, 6]) fx.addComparison({ candidate: r });
  const before = fx.compute();
  fx.linkRun(5);
  const after = fx.compute();
  assert.equal(keyReport(after).historyMax, 1);
  assert.deepEqual(sExh(exhaustionHintsBetween(before, after)), []);
});

test("T125 negative: removal with an unknown prior segment history gives no hint", (t) => {
  // Segment B holds a candidate whose prereg order is unknown (no analysis snapshot): its history
  // is unknown, so the removal cannot be compared with a known maximum.
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_WITHIN).addRun(3, G_WITHIN).addRun(4, G_WITHIN);
  fx.addRun(5, G_BEYOND, { link: false });
  fx.addRun(6, G_BEYOND, { snapshot: false }).addRun(7, G_BEYOND);
  for (const r of [2, 3, 4, 5, 6, 7]) fx.addComparison({ candidate: r });
  const before = fx.compute();
  assert.equal(keyReport(before).historyMax, "unknown");
  fx.linkRun(5);
  const after = fx.compute();
  assert.equal(keyReport(after).historyMax, "unknown");
  assert.deepEqual(sExh(exhaustionHintsBetween(before, after)), []);
});

test("X2b: unproven epoch on a comparison without prereg_id is epoch_unproven on the axis, not prereg_unknown", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
  fx.addRun(2, G_BEYOND, { link: false });
  fx.addComparison({ candidate: 2, prereg: null });
  const state = fx.compute();
  assert.equal(state.barriers.length, 1);
  assert.equal(state.barriers[0].code, "epoch_unproven");
  assert.deepEqual(state.barriers[0].scope, { kind: "axis", axis: "s21" });
});

test("X3b: a parseable line that is not an analysis record is invalid inside a window (fail-closed)", (t) => {
  const foreign = [
    '{"foo":1}',
    '{"type":"config"}',
    '{"run":9,"commit":"abc1234","metric":0.5,"status":"keep"}',
    '{"v":1,"record":"observation"}',
    '{"record":"analysis"}',
  ];
  for (const line of foreign) {
    const fx = new Fixture(t).addRun(1, 0.5).addPrereg();
    for (let r = 2; r <= 4; r++) fx.addRun(r, G_BEYOND);
    fx.addComparison({ candidate: 2 }).addComparison({ candidate: 3 });
    fx.analysisLines.push(line);
    fx.addComparison({ candidate: 4 });
    const state = fx.compute();
    assert.equal(state.unreadableLines, 1, line);
    assert.ok(
      state.barriers.some((barrier) => barrier.code === "incomplete_data" && barrier.scope.kind === "all"),
      `incomplete_data barrier for ${line}`,
    );
    const report = keyReport(state);
    assert.equal(report.lastWindow.code, "incomplete_data", line);
    assert.notEqual(report.display.value, "true", line);
  }
});

test("bulk write crossing both advisory thresholds (0 → 6) issues one advisory at 6, not two", (t) => {
  const fx = new Fixture(t).addRun(1, 0.5);
  for (let r = 2; r <= 7; r++) fx.addRun(r, G_ABOVE);
  const before = fx.compute();
  for (let r = 2; r <= 7; r++) fx.addComparison({ axis: "s30", prereg: null, candidate: r });
  const after = fx.compute();
  const advisory = exhaustionHintsBetween(before, after).filter((hint) => hint.kind === "S_exh_adv");
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0].threshold, 6);
  assert.equal(advisory[0].n, 6);
});
