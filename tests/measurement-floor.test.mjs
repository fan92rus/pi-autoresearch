/**
 * Переоценка noise floor после изменения измерителя (openspec
 * add-result-reflection, task 2.5; spec measurement-track: «Переоценка noise
 * floor после изменения измерителя», сценарий «keep без свежего floor»).
 *
 * Covers:
 *  - measurement.ts: один источник floor — `readNoiseFloorConfig` читает
 *    noiseFloor + штамп эпохи noiseFloorEpoch из .auto/config.json;
 *    `noiseFloorStatus` сводит устаревание против единого источника эпох
 *    (jsonl.ts reconstruct): штамп ниже текущей эпохи = floor устарел;
 *    `measurementLedgerFacts` уточняет v1-семантику floor_stale (со штампом —
 *    переоценка снимает пометку, без штампа — прежнее поведение);
 *    `confidenceSuppressionReason` добавляет причину устаревшего floor;
 *    `formatFloorStale` — явная пометка keep-вердикта (keep не блокируется);
 *  - index.ts: keep при устаревшем floor принимается с явной пометкой и
 *    подавленным confidence; после переоценки (штамп = текущая эпоха) пометка
 *    и подавление сняты; pending-рескор + устаревший floor подавляют вместе
 *    (рескор-причина первой); автокалибровка baseline ставит noiseFloorEpoch
 *    текущей эпохи; кампания без штампа (до 2.5) ведёт себя как прежде;
 *  - дашборд: conf подавлен честной пометкой floor_stale, legacy-вызовы без
 *    floor-статуса не меняются.
 *
 * Механизм переоценки: спека описывает только нудж наблюдателя, автоматического
 * механизма нет — floor устаревает до ручного обновления .auto/config.json
 * (noiseFloor + noiseFloorEpoch = текущая эпоха); это задокументировано в
 * пометке и причине подавления.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurement-floor.test.mjs
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
  formatFloorStale,
  logMeasurementChange,
  measurementHealthSummary,
  measurementLedgerFacts,
  measurementScaleStatus,
  noiseFloorStatus,
  noiseFloorStatusOfDir,
  readNoiseFloorConfig,
} from "../extensions/pi-autoresearch/measurement.ts";
import { renderDashboardLines } from "../extensions/pi-autoresearch/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");

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

const CONFIG = '{"type":"config","name":"floor","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}';

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-floor-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedLedger(dir, lines) {
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), lines.join("\n") + "\n", "utf-8");
}

function writeConfigFile(dir, obj) {
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function run(n, metric, extra = {}) {
  return JSON.stringify({ run: n, metric, status: "keep", description: `run ${n}`, metrics: {}, ...extra });
}

function change(epoch) {
  return JSON.stringify({
    type: "measurement_change",
    epoch,
    diff_ref: `.auto/measurement/e${epoch}_gold.diff`,
    rescore_ref: `.auto/measurement/e${epoch}/rescore.md`,
    justification: "finding f7",
    old_scale_score: 0.5,
    new_scale_score: 0.6,
    needs_verification: true,
  });
}

/** Леджер эпохи 2: legacy-прогон, measurement_change e2 и прогон новой эпохи. */
const EPOCH2_LEDGER = [CONFIG, run(1, 100), change(2), run(2, 90, { epoch: 2 })].join("\n");

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

function readConfigJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".auto", "config.json"), "utf-8"));
}

function readLedger(dir) {
  return fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
    name: "floor",
    currentSegment: 0,
    maxExperiments: null,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// measurement.ts — чистый сгиб noiseFloorStatus (один источник эпох)
// ---------------------------------------------------------------------------

test("noiseFloorStatus: штамп ниже текущей эпохи — floor устарел, переоценка снимает", () => {
  const stale = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.04, epoch: 1 });
  assert.equal(stale.epoch, 2, "эпоха — из jsonl.ts reconstruct (единый источник)");
  assert.equal(stale.floor, 0.04);
  assert.equal(stale.floor_epoch, 1);
  assert.equal(stale.stale, true);

  // Переоценка: floor перемерен на новой шкале, штамп = текущая эпоха.
  const fresh = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.03, epoch: 2 });
  assert.equal(fresh.stale, false);
});

test("noiseFloorStatus: без measurement_change старый штамп свеж; новое изменение снова устаревает", () => {
  const epoch1 = [CONFIG, run(1, 100)].join("\n");
  assert.equal(noiseFloorStatus(epoch1, { floor: 0.04, epoch: 1 }).stale, false);

  const epoch3 = [CONFIG, run(1, 100), change(2), change(3)].join("\n");
  assert.equal(noiseFloorStatus(epoch3, { floor: 0.03, epoch: 2 }).stale, true, "e3 открыла эпоху 3 — штамп эпохи 2 устарел");
  assert.equal(noiseFloorStatus(epoch3, { floor: 0.03, epoch: 3 }).stale, false, "переоценка на эпохе 3 снимает");
});

test("noiseFloorStatus: штамп без калибровки и будущий штамп не помечаются устаревшими", () => {
  assert.equal(noiseFloorStatus(EPOCH2_LEDGER, { floor: null, epoch: null }).stale, false, "нет штампа — keep-гейт не активируется (compat)");
  assert.equal(noiseFloorStatus(EPOCH2_LEDGER, { floor: null, epoch: 2 }).stale, false, "штамп без значения — решает штамп");
  assert.equal(noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.04, epoch: 3 }).stale, false, "штамп впереди эпохи трактуется как свежий");
});

// ---------------------------------------------------------------------------
// measurement.ts — чтение конфига через один источник
// ---------------------------------------------------------------------------

test("readNoiseFloorConfig: floor и штамп; отсутствующий/кривой конфиг деградирует", () => {
  const dir = makeWorkDir("config");
  assert.deepEqual(readNoiseFloorConfig(dir), { floor: null, epoch: null }, "конфига нет");

  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 2 });
  assert.deepEqual(readNoiseFloorConfig(dir), { floor: 0.04, epoch: 2 });

  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: "2" });
  assert.equal(readNoiseFloorConfig(dir).epoch, null, "штамп не-числом трактуется как отсутствие");

  writeConfigFile(dir, { noiseFloor: -1, noiseFloorEpoch: 2 });
  assert.equal(readNoiseFloorConfig(dir).floor, null, "неположительный floor не годится");

  fs.writeFileSync(path.join(dir, ".auto", "config.json"), "{broken", "utf-8");
  assert.deepEqual(readNoiseFloorConfig(dir), { floor: null, epoch: null }, "битый JSON не роняет чтение");
});

test("noiseFloorStatusOfDir: леджер + конфиг согласованы; без леджера — эпоха 1", () => {
  const dir = makeWorkDir("ofdir");
  seedLedger(dir, [CONFIG, run(1, 100), change(2)]);
  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });

  const status = noiseFloorStatusOfDir(dir);
  assert.equal(status.epoch, 2);
  assert.equal(status.floor, 0.04);
  assert.equal(status.floor_epoch, 1);
  assert.equal(status.stale, true);

  assert.equal(noiseFloorStatusOfDir(makeWorkDir("empty")).epoch, 1, "пустой workDir — эпоха 1, не устарел");
});

// ---------------------------------------------------------------------------
// measurement.ts — floor_stale в сводке (v1-семантика уточняется штампом)
// ---------------------------------------------------------------------------

test("measurementLedgerFacts: без штампа — v1 (любое изменение = stale); со штампом — по эпохе", () => {
  assert.deepEqual(measurementLedgerFacts(""), { epoch: 1, measurement_change_count: 0, floor_stale: false });

  const facts = measurementLedgerFacts(EPOCH2_LEDGER);
  assert.equal(facts.floor_stale, true, "v1: одинарный вызов (конфиг не виден) — консервативная пометка");
  assert.equal(measurementLedgerFacts(EPOCH2_LEDGER, 1).floor_stale, true, "штамп эпохи 1 < эпохи 2");
  assert.equal(measurementLedgerFacts(EPOCH2_LEDGER, 2).floor_stale, false, "переоценка на эпохе 2 снимает пометку");
});

test("measurementHealthSummary: переоценённый floor (штамп = текущая эпоха) даёт floor_stale: нет", () => {
  const dir = makeWorkDir("summary-fresh");
  seedLedger(dir, [CONFIG, run(1, 100), change(2), run(2, 90, { epoch: 2 })]);

  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });
  assert.equal(measurementHealthSummary(dir).floor_stale, true);

  writeConfigFile(dir, { noiseFloor: 0.03, noiseFloorEpoch: 2 });
  assert.equal(measurementHealthSummary(dir).floor_stale, false, "переоценка сняла пометку сводки");
});

// ---------------------------------------------------------------------------
// measurement.ts — гейт подавления и явная пометка
// ---------------------------------------------------------------------------

test("confidenceSuppressionReason: устаревший floor даёт причину с требованием переоценки", () => {
  const scale = measurementScaleStatus(EPOCH2_LEDGER); // обе шкалы известны, pending нет
  const staleFloor = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.04, epoch: 1 });
  const freshFloor = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.03, epoch: 2 });

  const reason = confidenceSuppressionReason(scale, staleFloor);
  assert.match(reason, /noise floor устарел \(floor_stale: калиброван на эпохе 1, шкала — эпоха 2\)/);
  assert.match(reason, /переоцените floor на новой шкале/);
  assert.match(reason, /noiseFloor и noiseFloorEpoch в \.auto\/config\.json/);

  assert.equal(confidenceSuppressionReason(scale, freshFloor), null, "свежий floor не подавляет");
  assert.equal(confidenceSuppressionReason(scale), null, "одинарный вызов — прежнее поведение (2.4)");
});

test("confidenceSuppressionReason: pending + устаревший floor — обе причины, рескор первой", () => {
  const pendingChange = JSON.stringify({
    type: "measurement_change", epoch: 2, diff_ref: ".auto/measurement/e2_gold.diff",
    rescore_ref: ".auto/measurement/e2/rescore.md", justification: "f7", rescore_pending: true, needs_verification: true,
  });
  const pendingLedger = [CONFIG, run(1, 100), pendingChange].join("\n");
  const pendingScale = measurementScaleStatus(pendingLedger);
  assert.equal(pendingScale.rescore_pending, true);

  const staleFloor = noiseFloorStatus(pendingLedger, { floor: 0.04, epoch: 1 });
  const reason = confidenceSuppressionReason(pendingScale, staleFloor);
  assert.match(reason, /рескор изменения e2 не завершён \(rescore_pending\)/);
  assert.ok(reason.indexOf("рескор изменения e2") < reason.indexOf("noise floor устарел"), "рескор-причина первая");
});

test("formatFloorStale: keep принят, требование переоценки с обоими ключами конфига", () => {
  const mark = formatFloorStale(noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.04, epoch: 1 }));
  assert.match(mark, /Noise floor устарел \(floor_stale\): калиброван на эпохе 1, текущая шкала — эпоха 2/);
  assert.match(mark, /Keep записан — не блокируется/);
  assert.match(mark, /noiseFloor и noiseFloorEpoch: 2/);
  assert.match(mark, /До переоценки confidence подавлен/);
});

// ---------------------------------------------------------------------------
// index.ts — дашборд: conf подавлен при устаревшем floor
// ---------------------------------------------------------------------------

test("дашборд: floor_stale подавляет conf честной пометкой; свежий floor и legacy-вызов — как прежде", () => {
  const scale = measurementScaleStatus(EPOCH2_LEDGER);
  const staleFloor = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.04, epoch: 1 });
  const freshFloor = noiseFloorStatus(EPOCH2_LEDGER, { floor: 0.03, epoch: 2 });

  const withStale = renderDashboardLines(dashboardState(), 240, stubTheme, 6, [], scale, staleFloor);
  assert.match(withStale.find((l) => l.includes("Runs:")), /\(conf: suppressed — floor_stale\)/);
  assert.doesNotMatch(withStale.join("\n"), /1\.5×/, "число confidence скрыто");

  const withFresh = renderDashboardLines(dashboardState(), 240, stubTheme, 6, [], scale, freshFloor);
  assert.match(withFresh.find((l) => l.includes("Runs:")), /\(conf: 1\.5×\)/);

  const legacy = renderDashboardLines(dashboardState(), 240, stubTheme, 6);
  assert.match(legacy.find((l) => l.includes("Runs:")), /\(conf: 1\.5×\)/, "вызов без floor-статуса не меняется");
});

// ---------------------------------------------------------------------------
// index.ts — wiring: keep до/после переоценки
// ---------------------------------------------------------------------------

test("keep при устаревшем floor: принят с явной пометкой, confidence подавлен", async () => {
  const dir = makeWorkDir("wiring-stale");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "floor-stale", realGit: true });
  await command("autoresearch").handler("on", ctx);

  const changeRes = await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  }, null, null, ctx);
  assert.match(changeRes.content[0].text, /Measurement change e2 recorded \(epoch 2/);

  // Floor откалиброван ДО изменения (эпоха 1) — теперь устарел.
  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });

  const keep = await tool("log_experiment").execute("id", {
    metric: 100,
    status: "keep",
    description: "keep on the new scale, floor not re-evaluated",
    asi: { hypothesis: "h" },
  }, null, null, ctx);
  const text = keep.content[0].text;
  assert.match(text, /Logged #1: keep/, "keep принимается — не блокируется");
  assert.match(text, /⚠️ Noise floor устарел \(floor_stale\): калиброван на эпохе 1, текущая шкала — эпоха 2\. Keep записан/);
  assert.match(text, /noiseFloor и noiseFloorEpoch: 2/);
  assert.match(text, /⚠️ Confidence suppressed: noise floor устарел \(floor_stale: калиброван на эпохе 1, шкала — эпоха 2\)/);
  assert.doesNotMatch(text, /📊 Confidence:/, "число confidence скрыто до переоценки");

  const entry = readLedger(dir).find((e) => e.description === "keep on the new scale, floor not re-evaluated");
  assert.equal(entry.status, "keep", "keep записан в леджер");
  assert.equal(entry.epoch, 2);
});

test("после переоценки (штамп = текущая эпоха): пометка и подавление сняты", async () => {
  const dir = makeWorkDir("wiring-reeval");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "floor-reeval", realGit: true });
  await command("autoresearch").handler("on", ctx);

  await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  }, null, null, ctx);
  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });

  const first = await tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "before re-evaluation", asi: { hypothesis: "h" },
  }, null, null, ctx);
  assert.match(first.content[0].text, /floor_stale/);

  // Переоценка floor на новой шкале — ручное обновление обоих ключей конфига.
  writeConfigFile(dir, { noiseFloor: 0.03, noiseFloorEpoch: 2 });

  const second = await tool("log_experiment").execute("id", {
    metric: 80, status: "keep", description: "after re-evaluation", asi: { hypothesis: "h" },
  }, null, null, ctx);
  const text = second.content[0].text;
  assert.match(text, /Logged #2: keep/);
  assert.doesNotMatch(text, /floor_stale/, "пометка снята после переоценки");
  assert.doesNotMatch(text, /Confidence suppressed/, "подавление снято после переоценки");
});

test("pending-рескор + устаревший floor: обе причины в одном подавлении, пометка на месте", async () => {
  const dir = makeWorkDir("wiring-combined");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "floor-combined", realGit: true });
  await command("autoresearch").handler("on", ctx);

  await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix",
    rescore_pending: true,
  }, null, null, ctx);
  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });

  const keep = await tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "pending and stale floor", asi: { hypothesis: "h" },
  }, null, null, ctx);
  const text = keep.content[0].text;
  assert.match(text, /Logged #1: keep/);
  const suppressed = text.match(/⚠️ Confidence suppressed: [^\n]*/);
  assert.ok(suppressed, "подавление присутствует");
  assert.match(suppressed[0], /рескор изменения e2 не завершён \(rescore_pending\)/);
  assert.match(suppressed[0], /noise floor устарел \(floor_stale: калиброван на эпохе 1, шкала — эпоха 2\)/);
  assert.ok(
    suppressed[0].indexOf("рескор изменения e2") < suppressed[0].indexOf("noise floor устарел"),
    "рескор-причина первая",
  );
  assert.match(text, /change_ref: "e2"/, "подсказка о завершении рескора сохранена");
  assert.match(text, /⚠️ Noise floor устарел \(floor_stale\)/, "явная пометка keep-вердикта на месте");
});

test("кампания без штампа (до 2.5): keep после изменения ведёт себя как прежде", async () => {
  const dir = makeWorkDir("wiring-nostamp");
  markSessionStarted(dir);
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "floor-nostamp", realGit: true });
  await command("autoresearch").handler("on", ctx);

  await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  }, null, null, ctx);

  const keep = await tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "no stamp campaign", asi: { hypothesis: "h" },
  }, null, null, ctx);
  const text = keep.content[0].text;
  assert.match(text, /Logged #1: keep/);
  assert.doesNotMatch(text, /floor_stale/, "без штампа новый гейт не активируется");
  assert.doesNotMatch(text, /Confidence suppressed/, "кампания до 2.5 — прежнее поведение");
});

test("автокалибровка baseline ставит noiseFloorEpoch текущей эпохи — floor свеж", async () => {
  const dir = makeWorkDir("wiring-calibrate");
  markSessionStarted(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "#!/bin/sh\necho 'METRIC ms=101'\n", "utf-8");
  const { tool, command, ctx } = await createHarness({
    dir,
    sessionId: "floor-calibrate",
    realGit: true,
    execTable: { ".auto/measure.sh": { code: 0, stdout: "METRIC ms=101\n", stderr: "" } },
  });
  await command("autoresearch").handler("on", ctx);

  // Дерево с baseline-корнем и baselineMetric: 0 (как после init_experiment):
  // первая же keep-запись проходит через recordTreeNode и запускает калибровку.
  fs.writeFileSync(path.join(dir, ".auto", "tree.json"), JSON.stringify({
    version: 1,
    rootId: "n0",
    activeNodeId: "n0",
    nextId: 1,
    baselineMetric: 0,
    direction: "lower",
    metricName: "ms",
    nodes: {
      n0: {
        id: "n0", parentId: null, children: [], commit: "aaa1111", metric: 0,
        hypothesis: "baseline", hypothesisLabel: null, status: "baseline", asi: null,
        simhashLabel: null, simhashFull: null, ideaId: null, depth: 0, createdAt: 0,
        exhausted: false, nodeType: "baseline", runRef: null,
      },
    },
  }), "utf-8");

  // Изменение измерителя открывает эпоху 2 ДО первого keep — калибровка baseline
  // идёт уже по новой шкале и обязана проштамповать эпоху 2.
  await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "scorer fix",
    rescore_pending: true,
  }, null, null, ctx);

  const keep1 = await tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "baseline keep calibrates", asi: { hypothesis: "h" },
  }, null, null, ctx);
  assert.match(keep1.content[0].text, /Logged #1: keep/);

  const cfg = readConfigJson(dir);
  assert.equal(cfg.noiseFloor, 0.01, "floor = |101-100|/100");
  assert.equal(cfg.noiseFloorEpoch, 2, "штамп — эпоха на момент калибровки");
  assert.equal(noiseFloorStatusOfDir(dir).stale, false, "свежая калибровка — не устарел");

  const keep2 = await tool("log_experiment").execute("id", {
    metric: 96, status: "keep", description: "after calibration", asi: { hypothesis: "h" },
  }, null, null, ctx);
  assert.doesNotMatch(keep2.content[0].text, /floor_stale/);
  assert.doesNotMatch(keep2.content[0].text, /noise floor устарел/);
});
