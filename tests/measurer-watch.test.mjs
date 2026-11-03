/**
 * Measurer-file control (openspec add-result-reflection, task 2.7; spec
 * measurement-track: «Граница с подгонкой бенчмарка», сценарий «попытка тихой
 * правки метрики»; design.md decision 6).
 *
 * Covers extensions/pi-autoresearch/measurement.ts (hash comparison helpers +
 * measurerControlOfDir) and its wiring into the observer's health line and the
 * council brief:
 *  - изменение хеша: хеш в манифесте последнего прогона отличается от
 *    предыдущего манифеста → предупреждение «неучтённое изменение»; учёт через
 *    measurement_change после более раннего прогона снимает предупреждение;
 *  - зарегистрированный откат (measurement_change + measurement_change_reverted,
 *    2.8; bd pi-autoresearch-s1m, ревью 2.7 Minor-1): переход хеша v2→v1 между
 *    прогонами закрывается revert-записью — без постоянного ложного
 *    «неучтённого изменения»; новое неучтённое изменение ПОСЛЕ отката
 *    предупреждает как прежде (откат не учитывает «наперёд»);
 *  - revert БЕЗ предшествующего measurement_change (сценарий R4 того же ревью):
 *    change_ref не указывает на существующую запись — учётом отката не
 *    является, тихие переходы вокруг него остаются предупреждениями;
 *  - revert со ссылкой на ДРУГУЮ СУЩЕСТВУЮЩУЮ эпоху (bd pi-autoresearch-0uj,
 *    минор ревью s1m): change_ref называет e2, зарегистрированную ПРЕДШЕСТВУЮЩИМ
 *    measurement_change, но не последнее изменение (после неё открыта e3) —
 *    проверка существования (changeEpochsSoFar по порядку скана) засчитывает
 *    такую запись как учёт отката: переход-откат закрывается без ложной тревоги;
 *  - изменение после последнего прогона (текущий файл ≠ манифест) — то же правило;
 *  - отсутствие объявления (analysis.measurement_files пуст / секции нет) и
 *    невалидная секция — явное ограничение контроля, не «здоровое состояние»;
 *  - недоступный объявленный файл (отсутствует сейчас или при прогоне) — честное
 *    предупреждение;
 *  - сводка без поля measurer (старые вызовы) рендерится как прежде;
 *  - observer (runObserver) и бриф совета (buildBrief) показывают те же строки.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurer-watch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { allocateRunArtifacts, writeRunManifest } from "../extensions/pi-autoresearch/lens.ts";
import {
  evaluateMeasurerControl,
  formatMeasurementHealth,
  measurementHealthLine,
  measurementHealthSummary,
  measurerControlOfDir,
} from "../extensions/pi-autoresearch/measurement.ts";
import { buildBrief } from "../extensions/pi-autoresearch/council.ts";
import { runObserver } from "../extensions/pi-autoresearch/observer.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCORER = "eval/scorer.py";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-measurer-watch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha16(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function appendLine(dir, entry) {
  const file = path.join(dir, ".auto", "log.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

/** Campaign ledger with the config header (optionally carrying an analysis section). */
function campaign(label, analysis) {
  const dir = makeWorkDir(label);
  const header = { type: "config", name: "measurer", metricName: "ms", metricUnit: "ms", bestDirection: "lower" };
  if (analysis !== undefined) header.analysis = analysis;
  appendLine(dir, header);
  return dir;
}

function writeScorer(dir, text, rel = SCORER) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf-8");
}

/** A real run: manifest written by lens.ts (as run_experiment does) + ledger run entry. */
function recordRun(dir, run, declared = [SCORER]) {
  const artifacts = allocateRunArtifacts(dir, run);
  assert.equal(artifacts.runNumber, run, "run dir number matches the requested run");
  writeRunManifest(dir, artifacts, { artifacts: [], measurementFiles: declared, copyLimitMb: 32 });
  // Same shape as observer-lens fixtures: runs 1–6 improve, later runs are discards.
  const keep = run <= 6;
  appendLine(dir, { run, status: keep ? "keep" : "discard", metric: keep ? 100 - 5 * (run - 1) : 76, description: keep ? "improvement" : "no gain", timestamp: run });
}

function changeRecord(epoch) {
  return { type: "measurement_change", epoch, diff_ref: ".auto/measurement/e2.diff", rescore_ref: ".auto/measurement/e2/rescore.md", justification: "finding f1", needs_verification: true };
}

/** The compensating record of revert_measurement_change (task 2.8): the change is refuted. */
function revertRecord(epoch) {
  return { type: "measurement_change_reverted", change_ref: `e${epoch}`, epoch, rescore_ref: ".auto/measurement/e2-counter/rescore.md", justification: "verification refuted the change", timestamp: 1 };
}

const healthOf = (dir) => measurementHealthLine(dir);

// ---------------------------------------------------------------------------
// Pure comparison (evaluateMeasurerControl)
// ---------------------------------------------------------------------------

function runsWith(entries) {
  return entries.map(([run, sha]) => ({ run, files: new Map([[SCORER, sha === undefined ? {} : { sha16: sha }]]) }));
}

test("hash change between two consecutive manifests without accounting → unaccounted", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "bbbb"]]),
    current: () => ({ kind: "hash", sha16: "bbbb" }),
    accounted: () => false,
  });
  assert.equal(control.state, "watching");
  assert.deepEqual(control.unaccounted, [`${SCORER} — sha16 aaaa→bbbb между прогонами 1 и 2`]);
  assert.deepEqual(control.unavailable, []);
});

test("hash change accounted by a measurement_change after the older run → no warning", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "bbbb"]]),
    current: () => ({ kind: "hash", sha16: "bbbb" }),
    accounted: (run) => run === 1,
  });
  assert.deepEqual(control.unaccounted, []);
});

test("unaccounted change mid-series stays visible in later runs (not only the last pair)", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "bbbb"], [3, "bbbb"], [4, "bbbb"]]),
    current: () => ({ kind: "hash", sha16: "bbbb" }),
    accounted: () => false,
  });
  assert.deepEqual(control.unaccounted, [`${SCORER} — sha16 aaaa→bbbb между прогонами 1 и 2`]);
  const accountedLater = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "bbbb"], [3, "bbbb"], [4, "bbbb"]]),
    current: () => ({ kind: "hash", sha16: "bbbb" }),
    // A measurement_change logged after run 2 lies inside the windows of runs 1 and 2.
    accounted: (run) => run <= 2,
  });
  assert.deepEqual(accountedLater.unaccounted, [], "a change recorded after run 2 covers the 1→2 transition");
});

test("file edited after the last run (current ≠ last manifest) → unaccounted, named after that run", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "aaaa"]]),
    current: () => ({ kind: "hash", sha16: "cccc" }),
    accounted: () => false,
  });
  assert.deepEqual(control.unaccounted, [`${SCORER} — sha16 aaaa→cccc после прогона 2`]);
});

test("unchanged hashes and unchanged current file → no warnings", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"], [2, "aaaa"]]),
    current: () => ({ kind: "hash", sha16: "aaaa" }),
    accounted: () => false,
  });
  assert.deepEqual(control, { state: "watching", unaccounted: [], unavailable: [] });
});

test("declared file missing now → unavailable (not silently skipped)", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: runsWith([[1, "aaaa"]]),
    current: () => ({ kind: "missing" }),
    accounted: () => false,
  });
  assert.deepEqual(control.unavailable, [`${SCORER} — файл не найден`]);
  assert.deepEqual(control.unaccounted, []);
});

test("declared file unreadable now → unavailable with the reason", () => {
  const control = evaluateMeasurerControl({
    declared: [SCORER],
    runs: [],
    current: () => ({ kind: "error", message: "EACCES" }),
    accounted: () => false,
  });
  assert.deepEqual(control.unavailable, [`${SCORER} — не читается (EACCES)`]);
});

test("last manifest recorded the file as missing or unreadable → unavailable at that run", () => {
  const missing = evaluateMeasurerControl({
    declared: [SCORER],
    runs: [{ run: 3, files: new Map([[SCORER, { missing: true }]]) }],
    current: () => ({ kind: "hash", sha16: "aaaa" }),
    accounted: () => false,
  });
  assert.deepEqual(missing.unavailable, [`${SCORER} — недоступен при прогоне 3 (файл отсутствовал)`]);

  const unreadable = evaluateMeasurerControl({
    declared: [SCORER],
    runs: [{ run: 4, files: new Map([[SCORER, { read_error: "EPERM" }]]) }],
    current: () => ({ kind: "hash", sha16: "aaaa" }),
    accounted: () => false,
  });
  assert.deepEqual(unreadable.unavailable, [`${SCORER} — недоступен при прогоне 4 (EPERM)`]);
});

// ---------------------------------------------------------------------------
// Disk: declared / undeclared / invalid (measurerControlOfDir + health line)
// ---------------------------------------------------------------------------

test("no declaration (no analysis section): state undeclared, limit stated, healthy annotation kept (no measurer change)", () => {
  const dir = campaign("undeclared-none");
  writeScorer(dir, "v1");
  recordRun(dir, 1, []);
  const control = measurerControlOfDir(dir, fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8"));
  assert.equal(control.state, "undeclared");
  const line = healthOf(dir);
  assert.match(line, /контроль измерителя ограничен: analysis\.measurement_files не объявлен/);
  assert.match(line, /полнота контроля не гарантирована/);
  assert.match(line, /Measurement health: изменений измерителя не зарегистрировано \(здоровое состояние\)/);
});

test("analysis section without measurement_files (artifacts only) is the same undeclared limit", () => {
  const dir = campaign("undeclared-artifacts", { artifacts: ["eval_output.json"] });
  recordRun(dir, 1, []);
  assert.match(healthOf(dir), /analysis\.measurement_files не объявлен/);
});

test("invalid analysis header: state invalid, reported as a limit (not silently healthy)", () => {
  const dir = campaign("invalid", { measurement_files: [7] });
  recordRun(dir, 1, []);
  const control = measurerControlOfDir(dir, fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8"));
  assert.equal(control.state, "invalid");
  assert.match(healthOf(dir), /контроль измерителя недоступен: секция analysis не разобрана/);
});

test("declared, unchanged scorer across runs: no measurer warning, healthy annotation kept", () => {
  const dir = campaign("unchanged", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  recordRun(dir, 2);
  const line = healthOf(dir);
  assert.doesNotMatch(line, /неучтённое|недоступен|ограничен|не разобрана/);
  assert.match(line, /здоровое состояние/);
});

test("hash changed between runs without measurement_change → unaccounted warning; accounted once logged", () => {
  const dir = campaign("changed", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  recordRun(dir, 2);
  writeScorer(dir, "gold v2 — silent edit");
  recordRun(dir, 3);

  const expected = `${SCORER} — sha16 ${sha16("gold v1")}→${sha16("gold v2 — silent edit")} между прогонами 2 и 3`;
  let line = healthOf(dir);
  assert.ok(line.includes(`неучтённое изменение измерителя (без measurement_change): ${expected}`), line);
  assert.doesNotMatch(line, /здоровое состояние/, "a contradicted healthy claim is withheld");

  // Accounting: a measurement_change logged after run 2 covers the change.
  appendLine(dir, changeRecord(2));
  line = healthOf(dir);
  assert.doesNotMatch(line, /неучтённое/);
});

test("registered revert (change + reverted, file restored) closes the v2→v1 transition → no unaccounted warning", () => {
  const dir = campaign("revert-accounted", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  appendLine(dir, changeRecord(2));
  writeScorer(dir, "gold v2");
  recordRun(dir, 2);
  appendLine(dir, revertRecord(2));
  writeScorer(dir, "gold v1"); // the file is returned to the pre-change content
  recordRun(dir, 3);

  // Without the revert accounting the 2→3 transition (sha16 v2→v1) has window
  // start = run 2, the revert record is invisible → a PERMANENT false alarm.
  const line = healthOf(dir);
  assert.doesNotMatch(line, /неучтённое/);
});

test("after a revert a NEW unaccounted change (v1→v3) still warns — the revert does not blanket-account", () => {
  const dir = campaign("revert-then-new-change", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  appendLine(dir, changeRecord(2));
  writeScorer(dir, "gold v2");
  recordRun(dir, 2);
  appendLine(dir, revertRecord(2));
  writeScorer(dir, "gold v1"); // reverted
  recordRun(dir, 3);
  writeScorer(dir, "gold v3 — silent edit"); // new change, no accounting
  recordRun(dir, 4);

  // Exactly the new transition warns: the closed 2→3 rollback transition must
  // NOT be reported alongside (the exact-string match pins that).
  const expected = `${SCORER} — sha16 ${sha16("gold v1")}→${sha16("gold v3 — silent edit")} между прогонами 3 и 4`;
  const line = healthOf(dir);
  assert.ok(line.includes(`неучтённое изменение измерителя (без measurement_change): ${expected}`), line);
});

test("revert without a preceding measurement_change is not accounting — silent transitions keep warning", () => {
  // R4 (bd pi-autoresearch-s1m, review Minor-1): the ledger carries only a
  // measurement_change_reverted whose change_ref points at NO existing
  // preceding measurement_change. The tool refuses to write such a record
  // (resolveChangeForVerdict), so this is a manual/foreign ledger edit — and it
  // must NOT open an accounting window: both silent transitions (v1→v2 before
  // it, v2→v3 after it) keep the unaccounted warning instead of a healthy claim.
  const dir = campaign("dangling-revert", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  writeScorer(dir, "gold v2 — silent edit"); // silent change, no measurement_change
  recordRun(dir, 2);
  appendLine(dir, revertRecord(2)); // change_ref "e2" — no measurement_change e2 precedes it
  writeScorer(dir, "gold v3 — silent edit"); // silent change again
  recordRun(dir, 3);

  const expected12 = `${SCORER} — sha16 ${sha16("gold v1")}→${sha16("gold v2 — silent edit")} между прогонами 1 и 2`;
  // Per-file details are joined with "; " inside ONE unaccounted entry, so the
  // second transition carries no second "${SCORER} — " prefix (see the exact
  // line format in measurerControlParts/evaluateMeasurerControl).
  const expected23 = `sha16 ${sha16("gold v2 — silent edit")}→${sha16("gold v3 — silent edit")} между прогонами 2 и 3`;
  const line = healthOf(dir);
  assert.ok(line.includes(`неучтённое изменение измерителя (без measurement_change): ${expected12}`), line);
  assert.ok(line.includes(expected23), line);
  assert.doesNotMatch(line, /здоровое состояние/, "a contradicted healthy claim is withheld");
});

test("revert referencing ANOTHER EXISTING epoch (e2 registered, newer e3 open) still accounts the rollback transition", () => {
  // bd pi-autoresearch-0uj (review minor of s1m): the revert's change_ref names
  // an epoch that EXISTS in the ledger (e2 — a preceding measurement_change)
  // but is NOT the latest change (e3 was registered after it). The accounting
  // check is existence-based (changeEpochsSoFar in scan order), not
  // latest-change-based: such a revert still closes the rollback transition.
  // The revert_measurement_change tool itself refuses to revert a non-latest
  // change, so this record is a manual/foreign ledger edit — the test pins
  // that it does not manufacture a false alarm.
  const dir = campaign("revert-foreign-existing-epoch", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  appendLine(dir, changeRecord(2));
  appendLine(dir, changeRecord(3)); // a newer change — e2 is now "another existing epoch"
  writeScorer(dir, "gold v2");
  recordRun(dir, 2);
  appendLine(dir, revertRecord(2)); // change_ref "e2": exists, but not the latest change (e3)
  writeScorer(dir, "gold v1"); // the file is returned to the pre-change content
  recordRun(dir, 3);

  // The 2→3 transition (sha16 v2→v1) has window start = run 2's entry; after
  // it lies ONLY the revert — no change line. It is accounted because "e2"
  // resolves to an existing preceding measurement_change (existence check).
  const line = healthOf(dir);
  assert.doesNotMatch(line, /неучтённое/);
});

test("file edited after the last run, not yet run → unaccounted warning (current ≠ last manifest)", () => {
  const dir = campaign("edited-after", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  writeScorer(dir, "gold v1 + silent fix");
  const line = healthOf(dir);
  assert.ok(
    line.includes(`${SCORER} — sha16 ${sha16("gold v1")}→${sha16("gold v1 + silent fix")} после прогона 1`),
    line,
  );
});

test("declared file deleted: unavailable warning names the file", () => {
  const dir = campaign("missing-now", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  fs.rmSync(path.join(dir, SCORER));
  const line = healthOf(dir);
  assert.ok(line.includes(`объявленный файл измерителя недоступен, его изменения не контролируются: ${SCORER} — файл не найден`), line);
});

test("declared file absent when the run happened: manifest says missing → unavailable at that run", () => {
  const dir = campaign("missing-at-run", { measurement_files: [SCORER] });
  recordRun(dir, 1); // no scorer yet → manifest entry missing
  writeScorer(dir, "gold v1");
  const line = healthOf(dir);
  assert.ok(line.includes(`${SCORER} — недоступен при прогоне 1 (файл отсутствовал)`), line);
});

// ---------------------------------------------------------------------------
// Compat: summaries without measurer render exactly as before
// ---------------------------------------------------------------------------

test("measurementHealthSummary keeps exactly the four spec fields (control rides on the line, not the summary)", () => {
  const dir = campaign("four-fields", { measurement_files: [SCORER] });
  recordRun(dir, 1);
  assert.deepEqual(Object.keys(measurementHealthSummary(dir)).sort(), ["epoch", "floor_stale", "open_measurement_count", "top_impact"]);
});

test("summary without a measurer part renders the pre-2.7 line unchanged", () => {
  const line = formatMeasurementHealth({ epoch: 1, floor_stale: false, open_measurement_count: 0, top_impact: null });
  assert.equal(
    line,
    "Measurement health: изменений измерителя не зарегистрировано (здоровое состояние); epoch 1; floor_stale: нет; открытых measurement-находок: 0 (open_measurement_count: 0); top_impact: —",
  );
});

// ---------------------------------------------------------------------------
// Consumers: council brief and observer carry the same line
// ---------------------------------------------------------------------------

const BRIEF_INPUT = {
  seq: 1,
  metricName: "ms",
  metricUnit: "ms",
  direction: "lower",
  baselineMetric: 100,
  bestMetric: 100,
  noiseFloor: 2,
  goal: "bench",
};

test("council brief: silent scorer change is shown in the Measurement health section", () => {
  const dir = campaign("brief", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  recordRun(dir, 1);
  writeScorer(dir, "gold v2");
  recordRun(dir, 2);
  const { text } = buildBrief(dir, path.join(dir, ".auto", "councils", "1"), BRIEF_INPUT);
  const section = text.slice(text.indexOf("## Measurement health"));
  assert.ok(section.includes("неучтённое изменение измерителя"), section);
  assert.ok(section.includes(`${SCORER} — sha16 ${sha16("gold v1")}→${sha16("gold v2")} между прогонами 1 и 2`), section);
});

test("council brief: undeclared campaign states the control limit", () => {
  const dir = campaign("brief-undeclared");
  recordRun(dir, 1, []);
  const { text } = buildBrief(dir, path.join(dir, ".auto", "councils", "1"), BRIEF_INPUT);
  assert.ok(text.slice(text.indexOf("## Measurement health")).includes("analysis.measurement_files не объявлен"), text);
});

test("observer reflection checkpoint: unaccounted measurer change reaches the periodic message", () => {
  const dir = campaign("observer", { measurement_files: [SCORER] });
  writeScorer(dir, "gold v1");
  for (let run = 1; run <= 5; run++) recordRun(dir, run);
  writeScorer(dir, "gold v2 silent");
  // 10 decided runs in the segment → reflection checkpoint (see observer-lens fixtures).
  for (let run = 6; run <= 10; run++) recordRun(dir, run);

  const steer = runObserver({
    cwd: dir,
    direction: "lower",
    metricName: "ms",
    metricUnit: "ms",
    baselineMetric: 100,
    bestMetric: 75,
    runCount: 10,
    goal: "make it faster",
  });
  assert.ok(steer, "observer speaks at the checkpoint");
  assert.match(steer, /REFLECTION CHECKPOINT/);
  assert.match(steer, /неучтённое изменение измерителя/);
  assert.ok(steer.includes(`sha16 ${sha16("gold v1")}→${sha16("gold v2 silent")}`), steer);
});
