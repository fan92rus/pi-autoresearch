/**
 * Учёт обеих шкал измерителя (openspec add-result-reflection, task 2.4;
 * spec measurement-track: «Обязательный учёт обеих шкал», сценарии
 * «обе шкалы известны», «рескор отложен», «вызов без рескор-артефакта» —
 * отказы покрыты в measurement-change.test.mjs).
 *
 * Covers:
 *  - measurement.ts: `measurement_change` / `measurement_change_completed`
 *    записи несут old/new_scale_score, распарсенные из рескор-артефакта;
 *    `measurementScaleStatus` сводит леджер (эпоха — из jsonl.ts reconstruct),
 *    `formatMeasurementScale` и `confidenceSuppressionReason` дают честные
 *    пометки: обе шкалы рядом, rescore_pending, предварительная до верификации,
 *    подавление confidence только при незавершённом рескоре;
 *  - index.ts: строка шкалы в дашборде (renderDashboardLines): оба числа
 *    рядом, пометка предварительной шкалы, conf-маркер подавлен при pending,
 *    здоровая шкала и прежний conf без изменений измерителя; wiring:
 *    keep при rescore_pending не блокируется, ответ честно помечен;
 *  - миноры ревью 2.2 (bd pi-autoresearch-1wp.3.2): один источник currentEpoch —
 *    jsonl.ts reconstruct — для measurement (measurementLedgerFacts), lens-inspect
 *    (currentEpochOf/inspect_results) и дашборда; reverted-запись
 *    (measurement_change_reverted) учитывается в currentEpoch, битый epoch у
 *    прогона новой эпохи не сбрасывает эпоху и не расходит потребителей.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurement-scales.test.mjs
 */
import { test } from "node:test";
import { markSessionStarted } from "./optimize-approve-helper.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import {
  confidenceSuppressionReason,
  formatMeasurementScale,
  logMeasurementChange,
  measurementLedgerFacts,
  measurementScaleStatus,
  measurementScaleStatusOfDir,
} from "../extensions/pi-autoresearch/measurement.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import {
  currentEpochOf,
  inspectResults,
  ledgerRunMetas,
  selectInspectRun,
} from "../extensions/pi-autoresearch/lens-inspect.ts";
import { renderDashboardLines } from "../extensions/pi-autoresearch/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");
const LATER = new Date("2026-11-02T04:00:00.000Z");

const FULL_ARTIFACT = {
  anchor: "run 45 window dev366",
  commands: ["python rescore.py --gold v15", "python rescore.py --gold v16"],
  old_scale_score: 0.5598,
  new_scale_score: 0.6383,
};

const PENDING_ARTIFACT = {
  anchor: FULL_ARTIFACT.anchor,
  commands: FULL_ARTIFACT.commands,
};

const CONFIG = '{"type":"config","name":"scales","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}';

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-scales-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMeasurementFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return rel;
}

const writeDiff = (dir, name = "e2_gold_v16.diff") =>
  writeMeasurementFile(
    dir,
    `.auto/measurement/${name}`,
    "--- a/gold.json\n+++ b/gold.json\n@@ -1 +1 @@\n-зампред\n+заместитель\n",
  );

const writeRescore = (dir, artifact, name = "e2/rescore.md") =>
  writeMeasurementFile(dir, `.auto/measurement/${name}`, JSON.stringify(artifact, null, 2) + "\n");

function seedLedger(dir, entries = []) {
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function ledgerTextOf(dir) {
  return fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
}

function readLedger(dir) {
  return ledgerTextOf(dir).split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function ledgerRunEntry(n, metric, extra = {}) {
  return JSON.parse(run(n, metric, extra));
}

function run(n, metric, extra = {}) {
  return JSON.stringify({ run: n, metric, status: "keep", description: `run ${n}`, metrics: {}, ...extra });
}

function change(epoch, extra = {}) {
  return JSON.stringify({
    type: "measurement_change",
    epoch,
    diff_ref: `.auto/measurement/e${epoch}_gold.diff`,
    rescore_ref: `.auto/measurement/e${epoch}/rescore.md`,
    justification: "finding f7",
    old_scale_score: 0.5,
    new_scale_score: 0.6,
    needs_verification: true,
    ...extra,
  });
}

/** Ledger seeded with one legacy run + a full-artifact change e2 (task-2.4 happy path). */
function makeFullChangeDir(label) {
  const dir = makeWorkDir(label);
  seedLedger(dir, [{ type: "config", name: "bench", metricName: "ms" }, ledgerRunEntry(45, 1.2, { status: "keep" })]);
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold penalises form variants twice",
  }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  return dir;
}

/** Dashboard stub: theme without colors, minimal ExperimentState with 3 runs. */
const stubTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function dashboardState(confidence = 1.5) {
  const mk = (n, metric, status) => ({
    commit: `c${n}`, metric, metrics: {}, status, description: `run ${n}`, timestamp: n, segment: 0, confidence: null,
  });
  return {
    results: [mk(1, 100, "keep"), mk(2, 95, "discard"), mk(3, 92, "keep")],
    bestMetric: 100,
    bestDirection: "lower",
    metricName: "ms",
    metricUnit: "ms",
    secondaryMetrics: [],
    name: "scales",
    currentSegment: 0,
    maxExperiments: null,
    confidence,
  };
}

function renderWithScale(scale) {
  return renderDashboardLines(dashboardState(), 240, stubTheme, 6, [], scale);
}

// ---------------------------------------------------------------------------
// Обе шкалы из артефакта (записи + сводка)
// ---------------------------------------------------------------------------

test("полный артефакт: запись несёт обе шкалы, статус — предварительная без подавления", () => {
  const dir = makeFullChangeDir("full");

  const rec = readLedger(dir).find((e) => e.type === "measurement_change");
  assert.equal(rec.epoch, 2);
  assert.equal(rec.old_scale_score, 0.5598);
  assert.equal(rec.new_scale_score, 0.6383);
  assert.equal("rescore_pending" in rec, false);

  const status = measurementScaleStatusOfDir(dir);
  assert.deepEqual(status, {
    epoch: 2,
    change_ref: "e2",
    rescore_pending: false,
    provisional: true, // needs_verification: до независимой проверки шкала предварительная
    old_scale_score: 0.5598,
    new_scale_score: 0.6383,
  });

  // Дашборд-строка: оба числа рядом + пометка предварительной.
  assert.equal(
    formatMeasurementScale(status),
    "Шкала: эпоха 2 · old_scale_score 0.5598 → new_scale_score 0.6383 · шкала предварительная (needs_verification)",
  );
  // Обе оценки известны — confidence НЕ подавляется (2.4 подавляет только pending).
  assert.equal(confidenceSuppressionReason(status), null);
});

test("рескор отложен: pending без оценок — предварительная шкала и подавленный confidence", () => {
  const dir = makeWorkDir("pending");
  seedLedger(dir, [{ type: "config", name: "bench", metricName: "ms" }]);

  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix, rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.rescore_pending, true);
  assert.equal("old_scale_score" in res.value, false);
  assert.equal("new_scale_score" in res.value, false);

  const status = measurementScaleStatusOfDir(dir);
  assert.equal(status.epoch, 2);
  assert.equal(status.change_ref, "e2");
  assert.equal(status.rescore_pending, true);
  assert.equal(status.provisional, true);
  assert.equal(status.old_scale_score, null);
  assert.equal(status.new_scale_score, null);

  const line = formatMeasurementScale(status);
  assert.match(line, /Шкала: эпоха 2 · rescore_pending \(e2: рескор не завершён/);
  assert.match(line, /шкала предварительная \(needs_verification\)/);
  assert.doesNotMatch(line, /old_scale_score/);

  const suppression = confidenceSuppressionReason(status);
  assert.match(suppression, /рескор изменения e2 не завершён \(rescore_pending\)/);
});

test("завершение pending: подавление снято, оценки из полного артефакта, эпоха та же", () => {
  const dir = makeWorkDir("complete");
  seedLedger(dir, [{ type: "config", name: "bench", metricName: "ms" }]);
  const pendingRes = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix",
    rescore_pending: true,
  }, FIXED_NOW);
  assert.equal(pendingRes.ok, true, pendingRes.ok ? "" : pendingRes.errors.join("; "));

  const fullRef = writeRescore(dir, FULL_ARTIFACT, "e2/rescore-full.md");
  const done = logMeasurementChange(dir, { change_ref: "e2", rescore_ref: fullRef }, LATER);
  assert.equal(done.ok, true, done.ok ? "" : done.errors.join("; "));
  assert.equal(done.value.type, "measurement_change_completed");
  assert.equal(done.value.epoch, 2); // та же эпоха, без инкремента
  assert.equal(done.value.old_scale_score, 0.5598);
  assert.equal(done.value.new_scale_score, 0.6383);

  const status = measurementScaleStatusOfDir(dir);
  assert.equal(status.rescore_pending, false);
  assert.equal(status.provisional, true); // верификации ещё не было (задача 2.8)
  assert.equal(status.old_scale_score, 0.5598);
  assert.equal(status.new_scale_score, 0.6383);
  assert.equal(confidenceSuppressionReason(status), null);
  assert.match(formatMeasurementScale(status), /old_scale_score 0\.5598 → new_scale_score 0\.6383/);
});

test("новое изменение сбрасывает завершение предыдущего: подавление по последней записи", () => {
  const dir = makeFullChangeDir("two-changes");
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir, "e3_timer.diff"),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT, "e3/rescore.md"),
    justification: "timer recalibrated",
    rescore_pending: true,
  }, LATER);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.epoch, 3);

  const status = measurementScaleStatusOfDir(dir);
  assert.equal(status.epoch, 3);
  assert.equal(status.change_ref, "e3");
  assert.equal(status.rescore_pending, true, "завершение e2 не завершает e3");
  assert.notEqual(confidenceSuppressionReason(status), null);
});

// ---------------------------------------------------------------------------
// Предварительная шкала в дашборде (renderDashboardLines)
// ---------------------------------------------------------------------------

test("дашборд: обе шкалы рядом и пометка предварительной, conf показан как прежде", () => {
  const lines = renderWithScale(measurementScaleStatusOfDir(makeFullChangeDir("dash-full")));
  const scaleLine = lines.find((l) => l.includes("Шкала: эпоха"));
  assert.match(scaleLine, /old_scale_score 0\.5598 → new_scale_score 0\.6383/);
  assert.match(scaleLine, /шкала предварительная \(needs_verification\)/);

  const runsLine = lines.find((l) => l.includes("Runs:"));
  assert.match(runsLine, /\(conf: 1\.5×\)/, "без pending число confidence не подавляется");
});

test("дашборд: pending — conf подавлен честной пометкой вместо числа", () => {
  const dir = makeWorkDir("dash-pending");
  seedLedger(dir, [{ type: "config", name: "bench", metricName: "ms" }]);
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix",
    rescore_pending: true,
  }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));

  const lines = renderWithScale(measurementScaleStatusOfDir(dir));
  const scaleLine = lines.find((l) => l.includes("Шкала: эпоха"));
  assert.match(scaleLine, /rescore_pending \(e2/);
  assert.match(scaleLine, /шкала предварительная/);

  const runsLine = lines.find((l) => l.includes("Runs:"));
  assert.match(runsLine, /\(conf: suppressed — rescore_pending\)/);
  assert.doesNotMatch(runsLine, /1\.5×/, "число confidence скрыто, пока шкалы не сопоставлены");
});

test("дашборд: без изменений измерителя — здоровая шкала и прежний conf; без статуса строки нет", () => {
  const healthy = renderWithScale(measurementScaleStatus(""));
  const scaleLine = healthy.find((l) => l.includes("Шкала: эпоха"));
  assert.equal(scaleLine, "  Шкала: эпоха 1 · изменений измерителя не зарегистрировано");
  assert.match(healthy.find((l) => l.includes("Runs:")), /\(conf: 1\.5×\)/);

  // Legacy-вызовы без статуса (старые сигнатуры/кампании) — строки шкалы нет.
  const legacy = renderDashboardLines(dashboardState(), 240, stubTheme, 6);
  assert.equal(legacy.find((l) => l.includes("Шкала:")), undefined);
  assert.match(legacy.find((l) => l.includes("Runs:")), /\(conf: 1\.5×\)/);
});

test("дашборд: пустое состояние показывает строку шкалы (минор ревью 2.4)", () => {
  // measurement_change может открыть эпоху до первого прогона — пустой дашборд
  // не должен скрывать активную шкалу.
  const empty = { ...dashboardState(), results: [] };
  const withScale = renderDashboardLines(
    empty, 240, stubTheme, 6, [],
    measurementScaleStatusOfDir(makeFullChangeDir("dash-empty")),
  );
  assert.equal(withScale[0], "  No experiments yet.");
  const scaleLine = withScale.find((l) => l.includes("Шкала: эпоха"));
  assert.notEqual(scaleLine, undefined, "строка шкалы присутствует в пустом состоянии");
  assert.match(scaleLine, /old_scale_score 0\.5598 → new_scale_score 0\.6383/);
  assert.match(scaleLine, /шкала предварительная \(needs_verification\)/);

  // Pending-шкала тоже видна: честная пометка вместо тихого отсутствия.
  const pendingDir = makeWorkDir("dash-empty-pending");
  seedLedger(pendingDir, [{ type: "config", name: "bench", metricName: "ms" }]);
  const changeRes = logMeasurementChange(pendingDir, {
    diff_ref: writeDiff(pendingDir),
    rescore_ref: writeRescore(pendingDir, PENDING_ARTIFACT),
    justification: "scorer fix, rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW);
  assert.equal(changeRes.ok, true, changeRes.ok ? "" : changeRes.errors.join("; "));
  const pendingLines = renderDashboardLines(
    empty, 240, stubTheme, 6, [], measurementScaleStatusOfDir(pendingDir),
  );
  assert.match(pendingLines.find((l) => l.includes("Шкала: эпоха")), /rescore_pending \(e2/);

  // Legacy-вызов без статуса — как прежде, только плейсхолдер.
  const legacy = renderDashboardLines(empty, 240, stubTheme, 6);
  assert.deepEqual(legacy, ["  No experiments yet."]);
});

// ---------------------------------------------------------------------------
// Wiring: keep при rescore_pending не блокируется, ответ честно помечен
// ---------------------------------------------------------------------------

test("index.ts: pending-изменение и keep — keep записан, ответ содержит шкалу и подавление", async () => {
  const dir = makeWorkDir("wiring");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "scales-wiring", realGit: true });
  await command("autoresearch").handler("on", ctx);

  const changeRes = await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix",
    rescore_pending: true,
  }, null, null, ctx);
  assert.match(changeRes.content[0].text, /Measurement change e2 recorded \(epoch 2, rescore pending — the new scale is provisional, needs_verification: true\)/);
  assert.match(changeRes.content[0].text, /Шкала: эпоха 2 · rescore_pending \(e2: рескор не завершён/);
  assert.match(changeRes.content[0].text, /шкала предварительная \(needs_verification\)/);
  assert.equal(changeRes.details.rescore_pending, true);
  assert.equal(changeRes.details.provisional, true);

  // Keep НЕ блокируется pending-рескором — запись принимается с честной пометкой.
  const keep = await tool("log_experiment").execute("id", {
    metric: 1.23,
    status: "keep",
    description: "first keep on the new scale",
    asi: { hypothesis: "h" },
  }, null, null, ctx);
  assert.match(keep.content[0].text, /Logged #1: keep/);
  assert.match(keep.content[0].text, /Шкала: эпоха 2 · rescore_pending \(e2: рескор не завершён/);
  assert.match(keep.content[0].text, /⚠️ Confidence suppressed: рескор изменения e2 не завершён \(rescore_pending\)/);
  assert.match(keep.content[0].text, /change_ref: "e2"/);
  assert.doesNotMatch(keep.content[0].text, /📊 Confidence:/, "число confidence не показывается при pending");

  const runEntry = readLedger(dir).find((e) => e.run === 1);
  assert.equal(runEntry.status, "keep");
});

test("index.ts: keep при сопоставленных шкалах показывает confidence как прежде", async () => {
  const dir = makeWorkDir("wiring-full");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "scales-wiring-full", realGit: true });
  await command("autoresearch").handler("on", ctx);

  const changeRes = await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  }, null, null, ctx);
  assert.match(changeRes.content[0].text, /Measurement change e2 recorded \(epoch 2: 0\.5598 → 0\.6383, needs_verification: true\)/);
  assert.match(changeRes.content[0].text, /Шкала: эпоха 2 · old_scale_score 0\.5598 → new_scale_score 0\.6383/);
  assert.equal(changeRes.details.rescore_pending, false);
  assert.equal(changeRes.details.provisional, true);

  const keep = await tool("log_experiment").execute("id", {
    metric: 1.23,
    status: "keep",
    description: "keep with both scales known",
    asi: { hypothesis: "h" },
  }, null, null, ctx);
  assert.match(keep.content[0].text, /Logged #1: keep/);
  assert.match(keep.content[0].text, /Шкала: эпоха 2 · old_scale_score 0\.5598 → new_scale_score 0\.6383 · шкала предварительная/);
  assert.doesNotMatch(keep.content[0].text, /Confidence suppressed/, "обе оценки известны — подавления нет");
});

// ---------------------------------------------------------------------------
// Миноры ревью 2.2: один источник currentEpoch (jsonl.ts reconstruct)
// ---------------------------------------------------------------------------

test("reverted-запись учитывается в currentEpoch — все потребители согласны", () => {
  const reverted = JSON.stringify({ type: "measurement_change_reverted", epoch: 2, change_ref: "e2", justification: "контр-рескор" });
  const text = [CONFIG, run(1, 100), change(2), run(2, 90, { epoch: 2 }), reverted].join("\n");

  assert.equal(reconstructJsonlState(text).currentEpoch, 2, "jsonl.ts reconstruct");
  assert.equal(measurementLedgerFacts(text).epoch, 2, "measurement.ts через тот же reconstruct");
  assert.equal(currentEpochOf(text), 2, "lens-inspect через тот же reconstruct");
  assert.equal(measurementLedgerFacts(text).measurement_change_count, 1, "счётчик считает только measurement_change");

  // Монотонность: более поздняя legacy-запись без epoch эпоху не снижает.
  const afterLegacyRun = text + "\n" + run(3, 85);
  assert.equal(reconstructJsonlState(afterLegacyRun).currentEpoch, 2);
  assert.equal(measurementLedgerFacts(afterLegacyRun).epoch, 2);
  assert.equal(currentEpochOf(afterLegacyRun), 2);

  // Запись reverted без usable epoch эпоху не двигает.
  const revertedNoEpoch = JSON.stringify({ type: "measurement_change_reverted", change_ref: "e2" });
  assert.equal(reconstructJsonlState(text + "\n" + revertedNoEpoch).currentEpoch, 2);
});

test("битый epoch у прогона новой эпохи не сбрасывает currentEpoch и не расходит потребителей", () => {
  const text = [CONFIG, run(1, 100), change(2), run(2, 90, { epoch: "2" }), run(3, 88, { epoch: 2.5 })].join("\n");

  const state = reconstructJsonlState(text);
  assert.deepEqual(state.results.map((r) => r.epoch), [1, 1, 1], "битый epoch трактуется как отсутствие (эпоха 1)");
  assert.equal(state.currentEpoch, 2, "эпоху новой эры держит measurement_change");

  // Один источник: measurement и lens-inspect дают то же число.
  assert.equal(measurementLedgerFacts(text).epoch, 2);
  assert.equal(currentEpochOf(text), 2);

  // Metas-only fallback (legacy прямые вызовы) видит только прогоны — поэтому
  // путь инструмента обязан передавать текст леджера.
  assert.equal(currentEpochOf(ledgerRunMetas(text)), 1);
  const sel = selectInspectRun(ledgerRunMetas(text), undefined, "lower", currentEpochOf(text));
  assert.equal(sel.ok, false);
  assert.match(sel.error, /эпохе \(2\)/);
});

test("inspect_results: эпоха, открытая measurement_change без прогонов в ней, видна в ответе", () => {
  const dir = makeWorkDir("inspect");
  fs.mkdirSync(path.join(dir, ".auto", "runs", "1"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [CONFIG, run(1, 100), change(2)].join("\n") + "\n", "utf-8");
  fs.writeFileSync(path.join(dir, ".auto", "runs", "1", "output.txt"), "METRIC ms=100\n", "utf-8");

  // До сведения источников дефолт выбрал бы лучший keep «эпохи 1» (прогоны
  // ещё не несут epoch 2); теперь текущей считается эпоха 2 из measurement_change.
  const res = inspectResults(dir, {});
  assert.match(res.text, /эпохе \(2\)/);
  assert.match(res.text, /нет keep-прогона/);
});
