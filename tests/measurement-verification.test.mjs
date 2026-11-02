/**
 * Верификация measurement_change (openspec add-result-reflection, task 2.8;
 * spec measurement-track/spec.md: «Верификация measurement_change», сценарии
 * «верификация подтвердила» и «верификация опровергла»).
 *
 * Covers the logic in extensions/pi-autoresearch/measurement.ts (and the
 * minimal bd pi-autoresearch-1wp.3.2 guard in jsonl.ts):
 *  - verifyMeasurementChange: дополняющая запись measurement_change_verified
 *    (исходные записи не переписываются), файл доказательства в
 *    .auto/measurement/ с командами, выводами и воспроизведёнными оценками;
 *    при реконструкции needs_verification снят, шкала не предварительная;
 *  - measurement_change_completed остаётся без новой эпохи, верификация
 *    заверешённого pending идёт по оценкам завершения, с файлом доказательства;
 *  - revertMeasurementChange: контр-рескор с иными оценками → компенсирующая
 *    запись measurement_change_reverted (append-only); контр-рескор с теми же
 *    оценками и чужой якорь отвергаются;
 *  - несравнимость: прогоны отклонённой эпохи не получают новых соседей —
 *    новые прогоны штампуются восстановленной активной эпохой (cross-epoch
 *    блокировка самой сверки покрыта в cross-epoch-lock.test.mjs);
 *  - дашборд/дерево после опровержения (ревью B1): текущая эпоха — активная
 *    (восстановленная) шкала — baseline и прогоны эпохи 1, прогоны e2 — prior;
 *    view.epoch === 1, узлы e2 вне scope (renderDashboardLines/epochTreeView);
 *  - машинная проверка команд (ревью B3): те же оценки и якорь, но другие
 *    команды — отказ у подтверждения и у опровержения («те же команды/входы»);
 *  - wiring index.ts (ревью B2): verify_measurement_change и
 *    revert_measurement_change за тем же gate (mode off отказывает) пишут
 *    вердикты в леджер через fake-pi;
 *  - восстановление активной шкалы по последней подтверждённой эпохе
 *    (подтверждённая e2 + отклонённая e3 → активная 2; без подтверждений → 1),
 *    floor, откалиброванный на восстановленной шкале, снова свежий;
 *  - монотонность id эпох: после отклонения e2 следующее изменение открывает
 *    e3 (id никогда не переиспользуются), reverted- И verified-записи не
 *    завышают currentEpoch при max-семантике (bd pi-autoresearch-1wp.3.2, M1).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurement-verification.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import {
  computeConfidence,
  epochTreeView,
  findBaselineMetric,
  renderDashboardLines,
} from "../extensions/pi-autoresearch/index.ts";

import {
  confidenceSuppressionReason,
  formatMeasurementScale,
  logMeasurementChange,
  measurementHealthSummary,
  measurementLedgerFacts,
  measurementScaleStatus,
  measurementVerificationState,
  noiseFloorStatus,
  revertMeasurementChange,
  verifyMeasurementChange,
} from "../extensions/pi-autoresearch/measurement.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");
const LATER = new Date("2026-11-02T04:00:00.000Z");
const EVEN_LATER = new Date("2026-11-02T05:00:00.000Z");

const ANCHOR = "run 45 window dev366";
const FULL_ARTIFACT = {
  anchor: ANCHOR,
  commands: ["python rescore.py --gold v15", "python rescore.py --gold v16"],
  old_scale_score: 0.5598,
  new_scale_score: 0.6383,
};
const PENDING_ARTIFACT = { anchor: ANCHOR, commands: FULL_ARTIFACT.commands };
/** Контр-рескор: тот же якорь и команды, другие оценки (опровержение). */
const COUNTER_ARTIFACT = {
  anchor: ANCHOR,
  commands: FULL_ARTIFACT.commands,
  old_scale_score: 0.5598,
  new_scale_score: 0.6011,
};
/** Доказательство: те же команды/входы дали те же оценки + выводы команд. */
const PROOF = {
  anchor: ANCHOR,
  commands: FULL_ARTIFACT.commands,
  outputs: ["0.5598 (366 примеров)", "0.6383 (366 примеров)"],
  old_scale_score: 0.5598,
  new_scale_score: 0.6383,
};

const CONFIG = '{"type":"config","name":"verify","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}';

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

function readLedger(dir) {
  return fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8")
    .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function ledgerTextOf(dir) {
  return fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
}

function ledgerCount(dir, type) {
  return readLedger(dir).filter((e) => e.type === type).length;
}

function run(n, metric, extra = {}) {
  return JSON.stringify({ run: n, metric, status: "keep", description: `run ${n}`, metrics: {}, ...extra });
}

function writeConfigFile(dir, obj) {
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

/**
 * Кампания с изменением e2 (полный артефакт, needs_verification) поверх
 * legacy-прогона эпохи 1 — базовая раскладка для вердиктов.
 */
function makeChangeDir(label, artifact = FULL_ARTIFACT) {
  const dir = makeWorkDir(label);
  seedLedger(dir, [JSON.parse(CONFIG), JSON.parse(run(1, 100))]);
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, artifact),
    justification: "gold penalises form variants twice",
  }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  return dir;
}

function errorsOf(res) {
  assert.equal(res.ok, false, "expected rejection");
  return res.errors.join("\n");
}

const stubTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * Состояние дашборда из текста леджера — так же, как восстанавливает его
 * index.ts (resume-путь с фиксом B1): baseline и confidence — активной эпохи
 * (measurementScaleStatus().epoch), а не max по прогонам сегмента.
 */
function dashboardStateFromLedger(text) {
  const rec = reconstructJsonlState(text);
  const results = rec.results.map((r) => ({ ...r, metrics: { ...r.metrics } }));
  const seg = rec.currentSegment;
  const epoch = measurementScaleStatus(text).epoch;
  return {
    results,
    bestMetric: findBaselineMetric(results, seg, epoch),
    bestDirection: rec.bestDirection,
    metricName: rec.metricName,
    metricUnit: rec.metricUnit,
    secondaryMetrics: [],
    name: rec.name,
    currentSegment: seg,
    maxExperiments: null,
    confidence: computeConfidence(results, seg, rec.bestDirection, epoch),
  };
}

/**
 * Minimal ExperimentTree: nodes = [{ id, parentId, runRef, metric, status, nodeType? }].
 * Every node hangs off the root n0 (flat tree, like real campaigns).
 */
function makeTree(nodes, activeNodeId) {
  const byId = {};
  for (const n of nodes) {
    byId[n.id] = {
      id: n.id,
      parentId: n.parentId,
      children: [],
      commit: null,
      metric: n.metric,
      hypothesis: n.id,
      hypothesisLabel: null,
      status: n.status,
      asi: null,
      simhashLabel: null,
      simhashFull: null,
      ideaId: null,
      depth: n.parentId === null ? 0 : 1,
      createdAt: 0,
      exhausted: false,
      nodeType: n.nodeType ?? "experiment",
      runRef: n.runRef,
    };
  }
  for (const n of nodes) if (n.parentId !== null) byId[n.parentId].children.push(n.id);
  return {
    version: 1,
    rootId: "n0",
    activeNodeId,
    nextId: nodes.length,
    baselineMetric: 100,
    direction: "lower",
    metricName: "ms",
    nodes: byId,
  };
}

/**
 * Кампания «e2 опровергнута»: legacy-прогон эпохи 1, изменение e2 (полный
 * артефакт), прогон эпохи 2, затем компенсирующее отклонение — базовая
 * раскладка для дашборда/дерева после опровержения (ревью B1).
 */
function makeRevertedChangeDir(label) {
  const dir = makeWorkDir(label);
  const change = {
    type: "measurement_change", epoch: 2,
    diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
    justification: "f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true,
  };
  seedLedger(dir, [JSON.parse(CONFIG), JSON.parse(run(1, 100)), change, JSON.parse(run(2, 90, { epoch: 2 }))]);
  writeRescore(dir, FULL_ARTIFACT);
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "контр-рескор",
  }, LATER).ok, true);
  return dir;
}

// ---------------------------------------------------------------------------
// Дополняющее подтверждение (verify) — append-only, needs_verification снят
// ---------------------------------------------------------------------------

test("подтверждение: measurement_change_verified дописана, исходные записи не переписаны, needs_verification снят", () => {
  const dir = makeChangeDir("verify-ok");
  const before = readLedger(dir);
  assert.equal(before.length, 3);

  const proofRel = writeRescore(dir, PROOF, "e2/verify-1.md");
  const res = verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: proofRel }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const rec = res.value;
  assert.equal(rec.type, "measurement_change_verified");
  assert.equal(rec.change_ref, "e2");
  assert.equal(rec.epoch, 2, "подтверждение не открывает эпоху");
  assert.equal(rec.proof_ref, ".auto/measurement/e2/verify-1.md");
  assert.equal(rec.timestamp, LATER.toISOString());

  // Append-only: исходные записи байт-в-байт те же, сверху одна новая.
  const after = readLedger(dir);
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(0, 3), before);
  assert.deepEqual(after[3], rec);
  assert.equal(ledgerCount(dir, "measurement_change"), 1, "исходная запись не дублируется");

  // Файл доказательства на месте: команды, выводы, воспроизведённые оценки.
  const proof = JSON.parse(fs.readFileSync(path.join(dir, proofRel), "utf-8"));
  assert.deepEqual(proof.commands, FULL_ARTIFACT.commands);
  assert.deepEqual(proof.outputs, ["0.5598 (366 примеров)", "0.6383 (366 примеров)"]);
  assert.equal(proof.old_scale_score, 0.5598);
  assert.equal(proof.new_scale_score, 0.6383);

  // Реконструкция: needs_verification снят, шкала не предварительная, эпоха та же.
  const verification = measurementVerificationState(ledgerTextOf(dir));
  assert.equal(verification.verified, true);
  assert.equal(verification.reverted, false);
  assert.equal(verification.active_epoch, 2);
  assert.deepEqual(verification.rejected_epochs, []);
  assert.equal(verification.proof_ref, ".auto/measurement/e2/verify-1.md");

  const status = measurementScaleStatus(ledgerTextOf(dir));
  assert.equal(status.epoch, 2);
  assert.equal(status.provisional, false, "независимая проверка сняла предварительную метку");
  assert.equal(status.rescore_pending, false);
  assert.equal(status.old_scale_score, 0.5598);
  assert.equal(status.new_scale_score, 0.6383);

  const line = formatMeasurementScale(status, verification);
  assert.match(line, /подтверждено независимой проверкой \(needs_verification снят\)/);
  assert.doesNotMatch(line, /предварительная/);
  // Сам сгиб уже несёт снятие needs_verification (спека: «при реконструкции… не
  // помечена предварительной»), поэтому и 1-аргументный вызов без метки;
  // тег «подтверждено» добавляет только передача верификационного сгиба.
  assert.doesNotMatch(formatMeasurementScale(status), /предварительная/);
});

test("повторное подтверждение и подтверждение после отклонения отвергаются — записи не переписываются", () => {
  const dir = makeChangeDir("verify-twice");
  const proofRel = writeRescore(dir, PROOF, "e2/verify-1.md");
  assert.equal(verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: proofRel }, LATER).ok, true);
  const snapshot = readLedger(dir);

  const dup = errorsOf(verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: proofRel }, EVEN_LATER));
  assert.match(dup, /change_ref: изменение e2 уже подтверждено/);
  assert.match(dup, /не переписываются/);
  assert.deepEqual(readLedger(dir), snapshot, "отклонённый вызов не пишет в леджер");

  // Ветка опровержения после подтверждения закрыта: вердикт уже вынесен.
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter.md");
  const late = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "поздний контр-рескор",
  }, EVEN_LATER));
  assert.match(late, /уже подтверждено/);
  assert.deepEqual(readLedger(dir), snapshot);
});

test("подтверждение без доказательства, с неполным доказательством (нет outputs / нет оценок / чужой якорь) отвергается", () => {
  const dir = makeChangeDir("verify-rejects");
  const snapshot = readLedger(dir);

  const none = errorsOf(verifyMeasurementChange(dir, { change_ref: "e2" }, LATER));
  assert.match(none, /proof_ref: отсутствует/);
  assert.match(none, /\.auto\/measurement\//);

  const noOutputs = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { anchor: ANCHOR, commands: FULL_ARTIFACT.commands, old_scale_score: 0.5598, new_scale_score: 0.6383 }, "e2/p1.md"),
  }, LATER));
  assert.match(noOutputs, /outputs отсутствует/);

  const shortOutputs = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, outputs: ["только один вывод"] }, "e2/p2.md"),
  }, LATER));
  assert.match(shortOutputs, /outputs должен содержать вывод каждой команды \(commands: 2, outputs: 1\)/);

  const noScores = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { anchor: ANCHOR, commands: FULL_ARTIFACT.commands, outputs: ["out1", "out2"] }, "e2/p3.md"),
  }, LATER));
  assert.match(noScores, /доказательство неполное/);
  assert.match(noScores, /old_scale_score и new_scale_score/);

  const wrongScores = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, old_scale_score: 0.5, new_scale_score: 0.7 }, "e2/p4.md"),
  }, LATER));
  assert.match(wrongScores, /не воспроизвели оценки изменения e2/);
  assert.match(wrongScores, /это ОПРОВЕРЖЕНИЕ/, "расхождение — путь опровержения, а не подтверждения");
  assert.match(wrongScores, /контр-рескор/);

  const wrongAnchor = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, anchor: "run 7 window dev50" }, "e2/p5.md"),
  }, LATER));
  assert.match(wrongAnchor, /якорь доказательства .* не совпадает с якорем рескор-артефакта изменения e2/);

  const missing = errorsOf(verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: ".auto/measurement/e2/absent.md" }, LATER));
  assert.match(missing, /proof_ref: "\.auto\/measurement\/e2\/absent\.md": файл не найден/);

  const unknown = errorsOf(verifyMeasurementChange(dir, { change_ref: "e9", proof_ref: writeRescore(dir, PROOF, "e9/p.md") }, LATER));
  assert.match(unknown, /изменение e9 не найдено в леджере/);

  assert.deepEqual(readLedger(dir), snapshot, "отклонённые вердикты никогда не доходят до леджера");
});

test("машинная проверка команд (ревью B3): те же оценки и якорь, другие команды — отказ; тот же список с пробелами проходит", () => {
  const dir = makeChangeDir("commands-mismatch");
  const snapshot = readLedger(dir);
  const otherCommands = ["python rescore.py --gold v17"];

  // Подтверждение чужими командами (оценки и якорь совпадают) — не воспроизведение:
  const verifyOther = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, commands: otherCommands, outputs: ["один вывод"] }, "e2/verify-other-cmds.md"),
  }, LATER));
  assert.match(verifyOther, /команды доказательства не совпадают с командами рескор-артефакта изменения e2/);
  assert.match(verifyOther, /ТЕМИ ЖЕ командами\/входами/);
  assert.match(verifyOther, /python rescore\.py --gold v15/, "в отказе названы команды исходного артефакта");

  // Опровержение чужими командами — измеряет другую процедуру, а не эту:
  const revertOther = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, { ...COUNTER_ARTIFACT, commands: otherCommands }, "e2/counter-other-cmds.md"),
    justification: "не сошлось",
  }, LATER));
  assert.match(revertOther, /команды контр-рескора не совпадают с командами рескор-артефакта изменения e2/);

  // Порядок команд — часть контракта воспроизведения: перестановка отвергается.
  const reordered = errorsOf(verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, commands: [...FULL_ARTIFACT.commands].reverse() }, "e2/verify-reordered.md"),
  }, LATER));
  assert.match(reordered, /команды доказательства не совпадают/);

  assert.deepEqual(readLedger(dir), snapshot, "отклонённые вердикты не пишутся в леджер");

  // Позитив: тот же список команд (лишние пробелы нормализуются парсером) проходит.
  const padded = verifyMeasurementChange(dir, {
    change_ref: "e2",
    proof_ref: writeRescore(dir, {
      ...PROOF,
      commands: FULL_ARTIFACT.commands.map((c) => `  ${c}  `),
    }, "e2/verify-padded.md"),
  }, LATER);
  assert.equal(padded.ok, true, padded.ok ? "" : padded.errors.join("; "));
  assert.equal(readLedger(dir).at(-1).type, "measurement_change_verified");
});

// ---------------------------------------------------------------------------
// measurement_change_completed без новой эпохи + файл доказательства
// ---------------------------------------------------------------------------

test("pending → completed (обе оценки, та же эпоха) → подтверждение завершённого с файлом доказательства", () => {
  const dir = makeWorkDir("complete-verify");
  seedLedger(dir, [JSON.parse(CONFIG)]);
  const rescoreRel = ".auto/measurement/e2/rescore.md";
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "gold fixed, rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW).ok, true);

  // Рескор выполнен, завершение — та же эпоха, без инкремента.
  const fullRef = writeRescore(dir, FULL_ARTIFACT, "e2/rescore-full.md");
  const done = logMeasurementChange(dir, { change_ref: "e2", rescore_ref: fullRef }, LATER);
  assert.equal(done.ok, true, done.ok ? "" : done.errors.join("; "));
  assert.equal(done.value.type, "measurement_change_completed");
  assert.equal(done.value.epoch, 2);

  // Верификация завершённого изменения: опорные оценки — из measurement_change_completed
  // (артефакт завершения rescore-full.md), доказательство дописывается отдельным файлом.
  const proofRel = writeRescore(dir, PROOF, "e2/verify-1.md");
  const res = verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: proofRel }, EVEN_LATER);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.epoch, 2, "верификация не открывает новую эпоху");

  const entries = readLedger(dir);
  assert.equal(ledgerCount(dir, "measurement_change"), 1);
  assert.equal(ledgerCount(dir, "measurement_change_completed"), 1);
  assert.equal(ledgerCount(dir, "measurement_change_verified"), 1);
  assert.deepEqual(entries.filter((e) => e.type === "measurement_change" || e.type === "measurement_change_completed")
    .map((e) => e.epoch), [2, 2], "все записи изменения — в той же эпохе");

  const verification = measurementVerificationState(ledgerTextOf(dir));
  assert.equal(verification.verified, true);
  assert.equal(verification.active_epoch, 2);
  const status = measurementScaleStatus(ledgerTextOf(dir));
  assert.equal(status.epoch, 2);
  assert.equal(status.provisional, false);
  assert.equal(status.old_scale_score, 0.5598, "оценки завершения не потеряны");
  assert.equal(status.new_scale_score, 0.6383);
  assert.match(formatMeasurementScale(status, verification), /old_scale_score 0\.5598 → new_scale_score 0\.6383 · подтверждено/);
});

// ---------------------------------------------------------------------------
// Опровержение: контр-рескор и компенсирующая запись
// ---------------------------------------------------------------------------

test("опровержение: контр-рескор с иными оценками — measurement_change_reverted дописана, леджер append-only", () => {
  const dir = makeChangeDir("revert-ok");
  const before = readLedger(dir);

  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  const revertJustification = "повторное воспроизведение дало 0.6011 вместо 0.6383";
  const res = revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: revertJustification,
  }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const rec = res.value;
  assert.equal(rec.type, "measurement_change_reverted");
  assert.equal(rec.change_ref, "e2");
  assert.equal(rec.epoch, 2);
  assert.equal(rec.rescore_ref, ".auto/measurement/e2/counter-rescore.md");
  assert.equal(rec.justification, revertJustification);

  const after = readLedger(dir);
  assert.equal(after.length, 4, "config + run + change + reverted — одна дописанная запись");
  assert.deepEqual(after.slice(0, before.length), before, "исходные записи не переписаны");
  assert.deepEqual(after[after.length - 1], rec);
});

test("сгиб после опровержения: reverted, активная шкала восстановлена на 1, оценки отклонённого изменения скрыты", () => {
  const dir = makeChangeDir("revert-fold");
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "повторное воспроизведение дало 0.6011 вместо 0.6383",
  }, LATER).ok, true);

  const verification = measurementVerificationState(ledgerTextOf(dir));
  assert.equal(verification.reverted, true);
  assert.equal(verification.verified, false);
  assert.equal(verification.active_epoch, 1, "нет подтверждённых эпох — активна базовая эпоха 1");
  assert.deepEqual(verification.rejected_epochs, [2]);
  assert.equal(verification.counter_rescore_ref, ".auto/measurement/e2/counter-rescore.md");
  assert.equal(verification.proof_ref, null);

  const status = measurementScaleStatus(ledgerTextOf(dir));
  assert.equal(status.epoch, 1, "активная шкала восстановлена по последней подтверждённой эпохе");
  assert.equal(status.change_ref, "e2");
  assert.equal(status.provisional, false, "восстановленная шкала — подтверждённая база, не предварительная");
  assert.equal(status.rescore_pending, false);
  assert.equal(status.old_scale_score, null, "опровергнутые числа — не состояние шкалы");
  assert.equal(status.new_scale_score, null);

  const line = formatMeasurementScale(status, verification);
  assert.match(line, /изменение e2 опровергнуто \(контр-рескор\)/);
  assert.match(line, /активная шкала восстановлена по последней подтверждённой эпохе: 1/);
  assert.match(line, /прогоны эпохи 2 несравнимы \(cross-epoch\)/);
  // После опровержения rescore_pending нет — шкала не подавляет confidence
  // (сравнимость восстановленной эпохи регулируют cross-epoch блокировки и floor).
  assert.equal(confidenceSuppressionReason(status), null);
});

test("отказы опровержения: те же оценки, чужой якорь, неполный контр-рескор, не последнее изменение, повтор, pending без оценок", () => {
  const dir = makeChangeDir("revert-rejects");
  const snapshot = readLedger(dir);

  // Контр-рескор воспроизвёл те же оценки — это подтверждение, не опровержение.
  const sameScores = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, FULL_ARTIFACT, "e2/same.md"),
    justification: "не сошлось",
  }, LATER));
  assert.match(sameScores, /воспроизвёл те же оценки/);
  assert.match(sameScores, /подтверждение/);

  const wrongAnchor = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, { ...COUNTER_ARTIFACT, anchor: "run 7 window dev50" }, "e2/other-anchor.md"),
    justification: "не сошлось",
  }, LATER));
  assert.match(wrongAnchor, /якорь контр-рескора .* не совпадает/);

  const noScores = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, { anchor: ANCHOR, commands: FULL_ARTIFACT.commands }, "e2/incomplete.md"),
    justification: "не сошлось",
  }, LATER));
  assert.match(noScores, /неполный/);
  assert.match(noScores, /обе оценки/);

  const noCounter = errorsOf(revertMeasurementChange(dir, { change_ref: "e2", justification: "причина" }, LATER));
  assert.match(noCounter, /rescore_ref: отсутствует/);
  assert.match(noCounter, /контр-рескор/);

  const noJustification = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, COUNTER_ARTIFACT, "e2/counter.md"),
  }, LATER));
  assert.match(noJustification, /justification: отсутствует/);

  // Повторное опровержение и «не последнее» — порядок важен: сначала
  // регистрируем более новое изменение e3, потом проверяем оба отказа.
  const newer = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir, "e3_timer.diff"),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT, "e3/rescore.md"),
    justification: "timer recalibrated",
  }, EVEN_LATER);
  assert.equal(newer.ok, true, newer.ok ? "" : newer.errors.join("; "));
  assert.equal(newer.value.epoch, 3, "новое изменение монотонно открывает эпоху 3");

  // e2 — не последнее изменение: отклонить можно только актуальное.
  const notLatest = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: writeRescore(dir, COUNTER_ARTIFACT, "e2/counter2.md"),
    justification: "устаревший вердикт",
  }, EVEN_LATER));
  assert.match(notLatest, /не последнее \(последнее: e3\)/);
  assert.match(notLatest, /только актуальное изменение шкалы/);

  // Актуальное e3 отклоняется, повтор — нет:
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e3",
    rescore_ref: writeRescore(dir, { ...COUNTER_ARTIFACT, new_scale_score: 0.71 }, "e3/counter.md"),
    justification: "контр-рескор e3",
  }, EVEN_LATER).ok, true);
  const snapshotAfterRevert = readLedger(dir);
  const dup = errorsOf(revertMeasurementChange(dir, {
    change_ref: "e3",
    rescore_ref: writeRescore(dir, { ...COUNTER_ARTIFACT, new_scale_score: 0.71 }, "e3/counter.md"),
    justification: "повтор",
  }, EVEN_LATER));
  assert.match(dup, /уже отклонено/);
  assert.match(dup, /не переигрывается/);
  assert.deepEqual(readLedger(dir), snapshotAfterRevert);

  // Pending-изменение без оценок нечего опровергать:
  const pendDir = makeWorkDir("revert-pending");
  assert.equal(logMeasurementChange(pendDir, {
    diff_ref: writeDiff(pendDir),
    rescore_ref: writeRescore(pendDir, PENDING_ARTIFACT),
    justification: "rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW).ok, true);
  const pendingText = errorsOf(revertMeasurementChange(pendDir, {
    change_ref: "e2",
    rescore_ref: writeRescore(pendDir, COUNTER_ARTIFACT, "e2/counter.md"),
    justification: "преждевременно",
  }, LATER));
  assert.match(pendingText, /нет обеих оценок в леджере/);
  assert.match(pendingText, /рескор ещё не завершён/);

  assert.deepEqual(readLedger(dir).filter((e) => e.type === "measurement_change_reverted").length, 1);
});

// ---------------------------------------------------------------------------
// Несравнимость отклонённых прогонов
// ---------------------------------------------------------------------------

test("отклонённые прогоны несравнимы: новые прогоны штампуются восстановленной эпохой, а не отклонённой", () => {
  const dir = makeWorkDir("incomparable");
  const change = {
    type: "measurement_change", epoch: 2,
    diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
    justification: "f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true,
  };
  seedLedger(dir, [JSON.parse(CONFIG), JSON.parse(run(1, 100)), change, JSON.parse(run(2, 90, { epoch: 2 }))]);
  // Исходный рескор-артефакт изменения (опорный якорь для контр-рескора):
  writeRescore(dir, FULL_ARTIFACT);
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "контр-рескор",
  }, LATER).ok, true);

  const status = measurementScaleStatus(ledgerTextOf(dir));
  assert.equal(status.epoch, 1, "активная эпоха восстановлена — её получают новые прогоны (штамп index.ts)");

  // Прогон, записанный после отклонения (так пишет цикл: epoch = status.epoch),
  // попадает в восстановленную эпоху 1 — у него нет общих эпох с отклонёнными
  // прогонами run 2, значит поперечные дельты к ним заблокированы (контракт 2.3,
  // сама блокировка сверок покрыта в cross-epoch-lock.test.mjs).
  const afterRevertText = ledgerTextOf(dir) + run(3, 88, { epoch: status.epoch }) + "\n";
  const epochs = reconstructJsonlState(afterRevertText).results.map((r) => r.epoch);
  assert.deepEqual(epochs, [1, 2, 1], "отклонённый прогон 2 остаётся в эпохе 2, новый — в восстановленной 1");
  assert.equal(epochs[2] === measurementVerificationState(afterRevertText).rejected_epochs[0], false);

  // В самих записях леджера ничего не переписано: отклонённый прогон несёт свою эпоху.
  const rejectedRun = readLedger(dir).find((e) => e.run === 2);
  assert.equal(rejectedRun.epoch, 2);
  assert.equal(rejectedRun.status, "keep");
});

// ---------------------------------------------------------------------------
// Дашборд/дерево после опровержения (ревью B1): активная эпоха, не max по прогонам
// ---------------------------------------------------------------------------

test("дашборд после опровержения (ревью B1): baseline и прогресс — активная эпоха 1, прогоны e2 — prior, а не текущие", () => {
  const dir = makeRevertedChangeDir("revert-dashboard");
  // Прогон, записанный циклом ПОСЛЕ опровержения: штампуется восстановленной эпохой 1.
  const text = ledgerTextOf(dir) + run(3, 88, { epoch: 1 }) + "\n";

  const lines = renderDashboardLines(dashboardStateFromLedger(text), 240, stubTheme, 6, [], measurementScaleStatus(text));
  const joined = lines.join("\n");

  // Шкала: активная (восстановленная) эпоха 1 — а не max прогонов сегмента (2).
  assert.match(joined, /Шкала: эпоха 1 /, "текущая эпоха дашборда = активная шкала");

  // Baseline — первый прогон активной эпохи 1 (#1, 100), а не отклонённой эпохи 2 (#2, 90).
  const baselineLine = lines.find((l) => l.includes("Baseline:"));
  assert.match(baselineLine, /★ ms: 100ms #1/);
  assert.doesNotMatch(baselineLine, /#2/);

  // Прогресс — лучший keep активной эпохи (88, #3), дельта от baseline эпохи 1.
  const progress = lines.find((l) => l.includes("Progress:"));
  assert.match(progress, /★ ms: 88ms #3/);
  assert.match(progress, /-12\.0%/, "дельта считается внутри активной эпохи 1: 100 → 88");
  assert.doesNotMatch(progress, /90/, "прогон отклонённой эпохи не попадает в текущие");

  // Прогоны e2 — prior/cross-epoch: разделитель чужой эпохи вокруг отклонённого прогона.
  assert.match(joined, /── epoch 2 ──/, "прогоны эпохи 2 помечены как другая эпоха");
  assert.doesNotMatch(joined, /Cross-epoch:/, "раньше эпохи 1 ничего нет — cross-epoch-справки нет");

  // С контрфактом (старый max): epoch был бы 2 — baseline #2/прогон 90/разделитель epoch 1.
});

test("дерево после опровержения (ревью B1): view.epoch === 1 — активная эпоха без max по узлам, узлы e2 вне scope", () => {
  const dir = makeRevertedChangeDir("revert-tree");
  const text = ledgerTextOf(dir) + run(3, 88, { epoch: 1 }) + "\n";
  const tree = makeTree([
    { id: "n0", parentId: null, runRef: 1, metric: 100, status: "keep", nodeType: "baseline" },
    { id: "n1", parentId: "n0", runRef: 2, metric: 90, status: "keep" },
    { id: "n2", parentId: "n0", runRef: 3, metric: 88, status: "keep" },
  ], "n2");

  const view = epochTreeView(tree, text);
  assert.equal(view.epoch, 1, "активная эпоха (measurementVerificationState), а не max по treeNodeEpochs");
  assert.equal(view.scoped.nodes.n1, undefined, "узел отклонённой эпохи 2 вне scope");
  assert.equal(view.scoped.nodes.n2.metric, 88, "узел активной эпохи в scope");
  assert.equal(view.prior, null, "раньше эпохи 1 опорной эпохи нет");
});

// ---------------------------------------------------------------------------
// Восстановление активной шкалы по последней подтверждённой эпохе
// ---------------------------------------------------------------------------

test("восстановление: подтверждённая e2 + отклонённая e3 → активная эпоха 2; legacy-запись reverted без epoch понимается по change_ref", () => {
  const dir = makeChangeDir("restore-confirmed");
  // e2 подтверждена:
  const proofRel = writeRescore(dir, PROOF, "e2/verify-1.md");
  assert.equal(verifyMeasurementChange(dir, { change_ref: "e2", proof_ref: proofRel }, LATER).ok, true);

  // e3 опровергнута:
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir, "e3_timer.diff"),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT, "e3/rescore.md"),
    justification: "timer recalibrated",
  }, LATER).ok, true);
  const counter3 = writeRescore(dir, { ...COUNTER_ARTIFACT, new_scale_score: 0.71 }, "e3/counter.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e3",
    rescore_ref: counter3,
    justification: "контр-рескор e3",
  }, EVEN_LATER).ok, true);

  const text = ledgerTextOf(dir);
  const verification = measurementVerificationState(text);
  assert.equal(verification.active_epoch, 2, "активная шкала = последняя подтверждённая эпоха (e2)");
  assert.deepEqual(verification.rejected_epochs, [3]);
  const status = measurementScaleStatus(text);
  assert.equal(status.epoch, 2);
  assert.equal(status.change_ref, "e3");
  assert.equal(status.provisional, false, "активна подтверждённая e2 — предварительной метки нет");

  // Hand-written reverted-запись без epoch, только change_ref (совместимость со
  // стандартным видом записи): сгиб восстанавливает эпоху по ссылке.
  const handWritten = text + JSON.stringify({ type: "measurement_change_reverted", change_ref: "e2", justification: "контр-рескор" }) + "\n";
  const legacyVerification = measurementVerificationState(handWritten);
  assert.equal(legacyVerification.reverted, true);
  assert.deepEqual(legacyVerification.rejected_epochs, [2, 3]);
  assert.equal(measurementScaleStatus(handWritten).epoch, 1, "e2 была единственной подтверждённой — откат к базе");
});

test("floor, откалиброванный на восстановленной шкале, снова свежий после опровержения", () => {
  const dir = makeWorkDir("floor-restore");
  seedLedger(dir, [JSON.parse(CONFIG), JSON.parse(run(1, 100))]);
  writeConfigFile(dir, { noiseFloor: 0.04, noiseFloorEpoch: 1 });
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  }, FIXED_NOW).ok, true);

  // На эпохе 2 floor эпохи 1 устарел (2.5):
  assert.equal(noiseFloorStatus(ledgerTextOf(dir), { floor: 0.04, epoch: 1 }).stale, true);
  assert.equal(measurementHealthSummary(dir).floor_stale, true);

  // Опровержение возвращает активную шкалу к эпохе 1 — floor снова на той шкале:
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "контр-рескор",
  }, LATER).ok, true);

  assert.equal(noiseFloorStatus(ledgerTextOf(dir), { floor: 0.04, epoch: 1 }).stale, false);
  assert.equal(measurementLedgerFacts(ledgerTextOf(dir), 1).floor_stale, false);
  assert.equal(measurementHealthSummary(dir).floor_stale, false);
});

// ---------------------------------------------------------------------------
// Монотонность идентификаторов эпох (id никогда не переиспользуются)
// ---------------------------------------------------------------------------

test("монотонность id: после отклонения e2 следующее изменение открывает e3, номер 2 не переиспользуется", () => {
  const dir = makeChangeDir("monotonic");
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");
  assert.equal(revertMeasurementChange(dir, {
    change_ref: "e2",
    rescore_ref: counterRel,
    justification: "контр-рескор",
  }, LATER).ok, true);

  // Активная шкала — эпоха 1, но счётчик эпох держит максимум: новое изменение
  // открывает эпоху 3, а не переиспользует отклонённую 2.
  const third = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir, "e3_timer.diff"),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT, "e3/rescore.md"),
    justification: "timer recalibrated",
  }, EVEN_LATER);
  assert.equal(third.ok, true, third.ok ? "" : third.errors.join("; "));
  assert.equal(third.value.epoch, 3);

  const changeEpochs = readLedger(dir)
    .filter((e) => e.type === "measurement_change")
    .map((e) => e.epoch);
  assert.deepEqual(changeEpochs, [2, 3], "id монотонны и не повторяются");

  // И ещё одно изменение поверх — эпоха 4.
  const fourth = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir, "e4_matcher.diff"),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT, "e4/rescore.md"),
    justification: "matcher fix",
  }, EVEN_LATER);
  assert.equal(fourth.ok, true);
  assert.equal(fourth.value.epoch, 4);
});

test("bd pi-autoresearch-1wp.3.2: reverted-запись не завышает currentEpoch при max-семантике", () => {
  const base = [CONFIG, run(1, 100), JSON.stringify({
    type: "measurement_change", epoch: 2,
    diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
    justification: "f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true,
  }), run(2, 90, { epoch: 2 })].join("\n");

  // Валидная reverted-запись (эпоха отклонённого изменения) счётчик не двигает…
  const reverted = JSON.stringify({ type: "measurement_change_reverted", epoch: 2, change_ref: "e2", justification: "контр-рескор" });
  assert.equal(reconstructJsonlState(base + "\n" + reverted).currentEpoch, 2);

  // …а битая/завышенная — и подавно не должна: счётчик держат change/run-записи.
  const inflated = JSON.stringify({ type: "measurement_change_reverted", epoch: 9, change_ref: "e9", justification: "контр-рескор" });
  assert.equal(reconstructJsonlState(base + "\n" + inflated).currentEpoch, 2, "reverted не завышает currentEpoch");

  // Запись reverted без usable epoch эпоху не двигает.
  const noEpoch = JSON.stringify({ type: "measurement_change_reverted", change_ref: "e2" });
  assert.equal(reconstructJsonlState(base + "\n" + noEpoch).currentEpoch, 2);

  // Единый источник: measurement-сгиб против той же ledger-текст даёт активную эпоху 1,
  // счётчик (facts.epoch) остаётся 2 — следующее изменение откроет 3, а не переиспользует 2.
  const text = base + "\n" + reverted;
  assert.equal(measurementLedgerFacts(text).epoch, 2);
  assert.equal(measurementVerificationState(text).active_epoch, 1);
});

test("M1 (ревью): verified-запись не завышает currentEpoch при max-семантике — как reverted в 1wp.3.2", () => {
  const base = [CONFIG, run(1, 100), JSON.stringify({
    type: "measurement_change", epoch: 2,
    diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
    justification: "f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true,
  }), run(2, 90, { epoch: 2 })].join("\n");

  // Валидная verified-запись (эпоха подтверждённого изменения) счётчик не двигает…
  const verified = JSON.stringify({ type: "measurement_change_verified", epoch: 2, change_ref: "e2", proof_ref: ".auto/measurement/e2/proof.md" });
  assert.equal(reconstructJsonlState(base + "\n" + verified).currentEpoch, 2);

  // …а рукописная/завышенная — и подавно: счётчик держат change/run-записи.
  const inflated = JSON.stringify({ type: "measurement_change_verified", epoch: 9, change_ref: "e9", proof_ref: ".auto/measurement/e9/proof.md" });
  assert.equal(reconstructJsonlState(base + "\n" + inflated).currentEpoch, 2, "verified не завышает currentEpoch");

  // Запись verified без usable epoch эпоху не двигает.
  const noEpoch = JSON.stringify({ type: "measurement_change_verified", change_ref: "e2" });
  assert.equal(reconstructJsonlState(base + "\n" + noEpoch).currentEpoch, 2);

  // Сгиб верификации при этом понимает подтверждение (активная эпоха 2),
  // а счётчик остаётся 2 — то же разделение, что у reverted в 1wp.3.2.
  assert.equal(measurementVerificationState(base + "\n" + verified).active_epoch, 2);
  assert.equal(measurementVerificationState(base + "\n" + verified).verified, true);
  assert.equal(measurementLedgerFacts(base + "\n" + inflated).epoch, 2);
});

// ---------------------------------------------------------------------------
// index.ts wiring (ревью B2): verify/revert tools за тем же gate, fake-pi
// ---------------------------------------------------------------------------

async function loadExtensionOnFakePi(dir, sessionId) {
  const { pi, tool, command } = createFakePi({ dir, sessionId, realGit: false });
  const ctx = makeCtx(dir, sessionId, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { pi, tool, command, ctx };
}

test("index.ts: verify_measurement_change за gate — режим off отказывает, on пишет measurement_change_verified", async () => {
  const dir = makeChangeDir("wiring-verify");
  const { tool, command, ctx } = await loadExtensionOnFakePi(dir, "verify-wiring");
  const proofRel = writeRescore(dir, PROOF, "e2/verify-1.md");

  // Режим off: гейт отказывает до записи в леджер.
  const gated = await tool("verify_measurement_change").execute("id", { change_ref: "e2", proof_ref: proofRel }, null, null, ctx);
  assert.match(gated.content[0].text, /Autoresearch mode is OFF/);
  assert.equal(ledgerCount(dir, "measurement_change_verified"), 0);

  await command("autoresearch").handler("on", ctx);

  // Отказ инструмента доходит как rejected (машинная проверка команд внутри tool):
  const bad = await tool("verify_measurement_change").execute("id", {
    change_ref: "e2",
    proof_ref: writeRescore(dir, { ...PROOF, commands: ["другая команда"], outputs: ["x"] }, "e2/verify-bad.md"),
  }, null, null, ctx);
  assert.match(bad.content[0].text, /verify_measurement_change rejected/);
  assert.match(bad.content[0].text, /команды доказательства не совпадают/);
  assert.equal(ledgerCount(dir, "measurement_change_verified"), 0, "отклонённый вызов не пишет");

  const ok = await tool("verify_measurement_change").execute("id", { change_ref: "e2", proof_ref: proofRel }, null, null, ctx);
  assert.match(ok.content[0].text, /Measurement change e2 verified \(epoch 2, needs_verification lifted/);
  assert.match(ok.content[0].text, /подтверждено независимой проверкой/);
  assert.equal(ok.details.change_ref, "e2");
  assert.equal(ok.details.epoch, 2);
  assert.equal(ok.details.verified, true);

  const last = readLedger(dir).at(-1);
  assert.equal(last.type, "measurement_change_verified", "tool записал подтверждение в леджер");
  assert.equal(last.change_ref, "e2");
  assert.equal(last.proof_ref, ".auto/measurement/e2/verify-1.md");
});

test("index.ts: revert_measurement_change пишет компенсацию и восстанавливает активную эпоху", async () => {
  const dir = makeChangeDir("wiring-revert");
  const { tool, command, ctx } = await loadExtensionOnFakePi(dir, "revert-wiring");
  const counterRel = writeRescore(dir, COUNTER_ARTIFACT, "e2/counter-rescore.md");

  const gated = await tool("revert_measurement_change").execute("id", {
    change_ref: "e2", rescore_ref: counterRel, justification: "контр-рескор",
  }, null, null, ctx);
  assert.match(gated.content[0].text, /Autoresearch mode is OFF/);
  assert.equal(ledgerCount(dir, "measurement_change_reverted"), 0);

  await command("autoresearch").handler("on", ctx);

  const ok = await tool("revert_measurement_change").execute("id", {
    change_ref: "e2", rescore_ref: counterRel, justification: "повторное воспроизведение дало иные оценки",
  }, null, null, ctx);
  assert.match(ok.content[0].text, /Measurement change e2 reverted \(epoch 2 refuted — active scale restored to epoch 1/);
  assert.match(ok.content[0].text, /активная шкала восстановлена по последней подтверждённой эпохе: 1/);
  assert.match(ok.content[0].text, /прогоны эпохи 2 несравнимы \(cross-epoch\)/);
  assert.equal(ok.details.reverted, true);
  assert.equal(ok.details.active_epoch, 1);
  assert.deepEqual(ok.details.rejected_epochs, [2]);

  const last = readLedger(dir).at(-1);
  assert.equal(last.type, "measurement_change_reverted", "tool записал компенсацию в леджер");
  assert.equal(last.epoch, 2);
  assert.equal(last.rescore_ref, ".auto/measurement/e2/counter-rescore.md");
});
