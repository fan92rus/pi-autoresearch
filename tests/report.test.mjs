/**
 * Campaign report generator (openspec add-result-reflection, task 3.1; spec
 * campaign-report/spec.md).
 *
 * Covers extensions/pi-autoresearch/report.ts:
 *  - полный отчёт fixture-кампании: все семь секций с содержимым (прогоны и
 *    метрики по активной эпохе, находки по темам со статусами и флагом
 *    needs_verification, measurement-трек с эпохами и верификацией, шум и
 *    уверенность, идеи/dead-ends, owner-input gates без measurement-находок,
 *    сводка) и инвентарь переиспользуемых артефактов: манифесты .auto/runs/,
 *    скрипты кампании (.auto/measure.sh, .auto/checks.sh — путь + назначение,
 *    присутствие) и объявленные инструменты кампании (spec: «скрипты,
 *    инструменты»);
 *  - отчёт без находок: секция находок помечена «линза не применялась»,
 *    остальные секции строятся по леджеру;
 *  - отчёт пустой кампании: все семь секций присутствуют, пустые отмечены
 *    явно («нет данных»), генератор не падает;
 *  - идемпотентность: два вызова на неизменных данных — байт-в-байт одинаковый
 *    вывод (в отчёте нет временных меток генерации);
 *  - needs_verification: measurement-находка с флагом попадает в подсекцию
 *    «Требуют независимой проверки» с пометкой «рабочая очередь, а не
 *    owner-гейт» и НЕ попадает в секцию Owner-input gates; в очереди остаются
 *    все непроверенные статусы (open/revised/deferred) — verified исключён,
 *    потому что findings.ts флаг не снимает;
 *  - owner-input gates: capability/tradeoff-находки попадают в гейты при
 *    любом статусе (spec статус не ограничивает), в т.ч. verified.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/report.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { buildReport } from "../extensions/pi-autoresearch/report.ts";
import { recordFinding, updateFinding } from "../extensions/pi-autoresearch/findings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S1 = "## 1. Прогоны и метрики";
const S2 = "## 2. Находки по темам";
const S3 = "## 3. Measurement-трек";
const S4 = "## 4. Шум и уверенность";
const S5 = "## 5. Идеи и dead-ends";
const S6 = "## 6. Ограничения и owner-input gates";
const S7 = "## 7. Сводка";
const SEVEN_SECTIONS = [S1, S2, S3, S4, S5, S6, S7];

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");
const LATER = new Date("2026-11-02T04:00:00.000Z");

function makeWorkDir(label) {
  const dir = path.join(
    os.tmpdir(),
    `pi-ar-report-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sha16 = (content) => createHash("sha256").update(content).digest("hex").slice(0, 16);

const MEASURER = "def score(prediction, gold):\n    return 1.0 if prediction == gold else 0.0\n";

const OUT1 = ["run 1 output", "METRIC accuracy=0.50", "baseline pipeline"];

const OUT5 = [
  "run 5 output — epoch 2, window dev87",
  "MISMATCH gold=зампред pred=зампред (форма 2)",
  "MISMATCH gold=совет pred=совет",
  "METRIC accuracy=0.61",
  "verified by independent rescore run 45 window dev366",
  "capability check: cache-friendly layout skipped",
  "tradeoff: accuracy vs latency unresolved",
  "filler 8",
  "filler 9",
  "filler 10",
];

function writeOutput(workDir, run, lines) {
  const abs = path.join(workDir, ".auto", "runs", String(run), "output.txt");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join("\n") + "\n", "utf-8");
}

function writeManifest(workDir, run, manifest) {
  const abs = path.join(workDir, ".auto", "runs", String(run), "manifest.json");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(manifest, null, 2), "utf-8");
}

function writeLedger(workDir) {
  const entries = [
    {
      type: "config",
      name: "fixture-campaign",
      metricName: "accuracy",
      metricUnit: "",
      bestDirection: "higher",
      analysis: { measurement_files: ["measurer.py"], artifacts: ["eval.json"] },
      timestamp: 1700000000000,
    },
    { run: 1, commit: "a1b2c3d", metric: 0.5, status: "keep", description: "baseline: текущий пайплайн", timestamp: 1700000001000 },
    { run: 2, commit: "b2c3d4e", metric: 0.58, status: "keep", description: "векторизация scorer", timestamp: 1700000002000 },
    {
      run: 3, commit: "c3d4e5f", metric: 0.52, status: "discard", description: "кэш ответов модели",
      timestamp: 1700000003000, asi: { do_not_retry: "кэш-инвалидация дороже выигрыша" },
    },
    {
      run: 4, commit: null, metric: 0.49, status: "crash", description: "параллельный запуск eval упал",
      timestamp: 1700000004000, asi: { rollback_reason: "timeout" },
    },
    {
      type: "measurement_change", epoch: 2,
      diff_ref: ".auto/measurement/e2_gold_v16.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
      justification: "finding f1", old_scale_score: 0.5598, new_scale_score: 0.6383,
      needs_verification: true, timestamp: "2026-11-02T03:00:00.000Z",
    },
    { run: 5, commit: "d4e5f6a", metric: 0.61, status: "keep", description: "gold v16 после коррекции измерителя", timestamp: 1700000005000, epoch: 2 },
    { run: 6, commit: "e5f6a7b", metric: 0.6, status: "discard", description: "кэш-френдли структура (повтор)", timestamp: 1700000006000, epoch: 2 },
    { run: 7, commit: "f6a7b8c", metric: 0.66, status: "keep", description: "нормализация форм + gold v16", timestamp: 1700000007000, epoch: 2 },
    {
      type: "measurement_change_completed", change_ref: "e2", epoch: 2,
      rescore_ref: ".auto/measurement/e2/rescore.md",
      old_scale_score: 0.5598, new_scale_score: 0.6383, timestamp: "2026-11-02T03:30:00.000Z",
    },
    {
      type: "measurement_change_verified", change_ref: "e2", epoch: 2,
      proof_ref: ".auto/measurement/e2/proof.md", timestamp: "2026-11-02T04:00:00.000Z",
    },
  ];
  fs.mkdirSync(path.join(workDir, ".auto"), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, ".auto", "log.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

function writeMeasurementArtifacts(workDir) {
  const dir = path.join(workDir, ".auto", "measurement", "e2");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rescore.md"), 'rescore artifact: {"anchor":"run 45 window dev366"}\n', "utf-8");
  fs.writeFileSync(path.join(dir, "proof.md"), "proof artifact\n", "utf-8");
  fs.writeFileSync(path.join(workDir, ".auto", "measurement", "e2_gold_v16.diff"), "diff\n", "utf-8");
}

function treeNode(id, parentId, status, extra = {}) {
  return {
    id,
    parentId,
    children: [],
    commit: null,
    metric: 0.5,
    hypothesis: id,
    hypothesisLabel: null,
    status,
    asi: null,
    simhashLabel: null,
    simhashFull: null,
    ideaId: null,
    depth: 1,
    createdAt: 1700000000000,
    exhausted: false,
    nodeType: "experiment",
    ...extra,
  };
}

function writeTree(workDir) {
  const tree = {
    version: 1,
    rootId: "n0",
    activeNodeId: "n7",
    nextId: 8,
    baselineMetric: 0.5,
    direction: "higher",
    metricName: "accuracy",
    nodes: {
      n0: { ...treeNode("n0", null, "baseline", { nodeType: "baseline", depth: 0 }), children: ["n2"] },
      n2: treeNode("n2", "n0", "discard", {
        hypothesis: "cache-friendly layout",
        hypothesisLabel: "cache-friendly layout",
        exhausted: true,
        asi: { do_not_retry: "кэш-инвалидация дороже выигрыша", finding: "инвалидация на каждом шаге" },
        runRef: 3,
      }),
    },
  };
  fs.writeFileSync(path.join(workDir, ".auto", "tree.json"), JSON.stringify(tree, null, 2), "utf-8");
}

function writeDeadEnds(workDir) {
  const entry = {
    nodeId: "n2",
    hypothesis: "cache-friendly layout",
    do_not_retry: "кэш-инвалидация дороже выигрыша",
    finding: "инвалидация на каждом шаге",
    commit: null,
    savedAt: "2026-11-02T00:00:00.000Z",
  };
  fs.writeFileSync(path.join(workDir, ".auto", "dead-ends.json"), JSON.stringify([entry], null, 2), "utf-8");
}

function writeIdeas(workDir) {
  const dir = path.join(workDir, ".auto", "ideas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "idea-vector-hash.md"), "Vector-hash hypothesis: bucket by simhash\n", "utf-8");
  // registration file with frontmatter — tracked in the tree, NOT an untried idea
  fs.writeFileSync(path.join(dir, "n2.md"), "---\nnode: n2\n---\nregistered hypothesis\n", "utf-8");
}

function seedFindings(workDir) {
  const mk = (theme, description, evidence_ref, extra = {}) => ({ theme, description, evidence_ref, ...extra });
  const r1 = recordFinding(
    workDir,
    mk("measurement", "Правило недостижимо (unreachable) для верных форм: 0/87 примеров в dev-окне", ".auto/runs/5/output.txt:2-4", { run: 5, estimated_impact: "~14% всех ошибок" }),
    FIXED_NOW,
  );
  assert.equal(r1.ok, true, r1.ok ? "" : r1.errors.join("; "));
  const r2 = recordFinding(
    workDir,
    mk("behavior", "Дубликаты гипотез повторяют discard-ветку без изменения предположения", ".auto/runs/5/output.txt#MISMATCH gold=", { run: 5 }),
    FIXED_NOW,
  );
  assert.equal(r2.ok, true, r2.ok ? "" : r2.errors.join("; "));
  const r3 = recordFinding(
    workDir,
    mk("capability", "Кэш-френдли структура данных не попробована — нужно решение о направлении", ".auto/runs/5/output.txt:6-8", { estimated_impact: "~8% потенциала" }),
    FIXED_NOW,
  );
  assert.equal(r3.ok, true, r3.ok ? "" : r3.errors.join("; "));
  const r4 = recordFinding(
    workDir,
    mk("tradeoff", "Точность против задержки: развилка не выбрана", ".auto/runs/5/output.txt:7-8"),
    FIXED_NOW,
  );
  assert.equal(r4.ok, true, r4.ok ? "" : r4.errors.join("; "));
  const r5 = recordFinding(
    workDir,
    mk("measurement", "Шум между запусками до 2% без признаков недостижимости", ".auto/runs/1/output.txt:1-2", { run: 1 }),
    FIXED_NOW,
  );
  assert.equal(r5.ok, true, r5.ok ? "" : r5.errors.join("; "));
  const v2 = updateFinding(
    workDir,
    { id: r2.value.id, status: "verified", evidence_ref: ".auto/runs/5/output.txt:5-6", note: "подтверждено повторным чтением" },
    LATER,
  );
  assert.equal(v2.ok, true, v2.ok ? "" : v2.errors.join("; "));
}

/** Full fixture campaign; `withFindings: false` leaves findings.jsonl absent. */
function buildFullCampaign(label, { withFindings = true } = {}) {
  const dir = makeWorkDir(label);
  writeLedger(dir);
  fs.writeFileSync(path.join(dir, "measurer.py"), MEASURER, "utf-8");
  writeOutput(dir, 1, OUT1);
  writeOutput(dir, 5, OUT5);

  const measurerSha = sha16(MEASURER);
  const out1 = fs.readFileSync(path.join(dir, ".auto", "runs", "1", "output.txt"), "utf-8");
  const out5 = fs.readFileSync(path.join(dir, ".auto", "runs", "5", "output.txt"), "utf-8");
  writeManifest(dir, 1, {
    run: 1,
    output: "output.txt",
    bytes: Buffer.byteLength(out1),
    sha16: sha16(out1),
    measurement_files: [{ path: "measurer.py", sha16: measurerSha }],
    artifacts: [
      { declared: "eval.json", copied: true, file: "eval.json", bytes: 8192, sha16: "1122334455667788" },
      { declared: "trace.bin", copied: false, size_only: true, bytes: 99999999 },
    ],
  });
  writeManifest(dir, 5, {
    run: 5,
    output: "output.txt",
    bytes: Buffer.byteLength(out5),
    sha16: sha16(out5),
    measurement_files: [{ path: "measurer.py", sha16: measurerSha }],
    artifacts: [{ declared: "gold.json", missing: true }],
  });

  writeMeasurementArtifacts(dir);
  // переиспользуемые скрипты кампании (инвентарь «скрипты, инструменты»)
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf-8");
  fs.writeFileSync(path.join(dir, ".auto", "checks.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf-8");
  writeTree(dir);
  writeDeadEnds(dir);
  writeIdeas(dir);
  fs.writeFileSync(
    path.join(dir, ".auto", "config.json"),
    JSON.stringify({ noiseFloor: 0.04, noiseFloorUnit: "metric", noiseFloorEpoch: 2 }),
    "utf-8",
  );
  if (withFindings) seedFindings(dir);
  return dir;
}

function assertSevenSections(report) {
  let last = -1;
  for (const title of SEVEN_SECTIONS) {
    const at = report.indexOf(title);
    assert.ok(at !== -1, `секция отсутствует: ${title}`);
    assert.ok(at > last, `секция не по порядку: ${title}`);
    last = at;
  }
}

function sectionOf(report, title, nextTitle) {
  const start = report.indexOf(title);
  const end = nextTitle === null ? report.length : report.indexOf(nextTitle);
  assert.ok(start !== -1, `секция отсутствует: ${title}`);
  assert.ok(end > start, `секция после ${title} не найдена: ${nextTitle}`);
  return report.slice(start, end);
}

// ---------------------------------------------------------------------------
// Полный отчёт fixture-кампании
// ---------------------------------------------------------------------------

test("полный отчёт: семь секций, заголовок кампании, без служебного мусора", () => {
  const dir = buildFullCampaign("full");
  const report = buildReport(dir);

  assertSevenSections(report);
  assert.ok(report.startsWith("# Отчёт кампании: fixture-campaign"));
  assert.ok(!report.includes("undefined"));
  assert.ok(!report.includes("[object Object]"));
  assert.ok(!report.includes("NaN"));
});

test("полный отчёт: секция 1 — прогоны, метрики активной эпохи, инвентарь артефактов", () => {
  const dir = buildFullCampaign("full-runs");
  const s1 = sectionOf(buildReport(dir), S1, S2);

  assert.ok(s1.includes("Метрика: accuracy · лучше: больше"));
  assert.ok(s1.includes("Прогонов: 7 (keep 4 · discard 2 · crash 1)"));
  // всё в границах активной эпохи 2 (cross-epoch дельты запрещены)
  assert.ok(s1.includes("Baseline (эпоха 2): 0.61 (#5)"));
  assert.ok(s1.includes("Лучший keep: 0.66 (#7, +8.2% к baseline) — нормализация форм + gold v16"));
  assert.ok(s1.includes("Измеренные сильные стороны (keep'ы активной эпохи 2, в порядке):"));
  assert.ok(s1.includes("- #7 0.66 (+8.2% к baseline)"));
  assert.ok(s1.includes("- #4 crash — параллельный запуск eval упал"));
  assert.ok(s1.includes("худшая регрессия (эпоха 2): #6 0.6 (-1.6% к baseline эпохи)"));
  // инвентарь переиспользуемых артефактов из манифестов .auto/runs/
  assert.ok(s1.includes("Инвентарь артефактов (.auto/runs/, 2 с манифестами):"));
  assert.ok(s1.includes("#1: output.txt"));
  assert.ok(s1.includes("eval.json → скопирован (8192 Б)"));
  assert.ok(s1.includes("trace.bin → size-only (99999999 Б)"));
  assert.ok(s1.includes("gold.json → отсутствует"));
  assert.ok(s1.includes("измеритель: measurer.py (sha16 " + sha16(MEASURER) + ")"));
  // инвентарь скриптов и инструментов (spec: «скрипты, инструменты»)
  assert.ok(s1.includes("Скрипты и инструменты (переиспользуемая обвязка кампании):"));
  assert.ok(s1.includes("- .auto/measure.sh — скрипт замера (команда run_experiment): присутствует"));
  assert.ok(s1.includes("- .auto/checks.sh — скрипт проверок корректности (статус checks_failed): присутствует"));
  assert.ok(s1.includes("- Инструменты кампании (расширение): inspect_results — чтение персистированных выводов .auto/runs/"));
  assert.ok(s1.includes("record_finding — запись находки в .auto/findings.jsonl"));
  assert.ok(s1.includes("update_finding — обновление статуса находки и фиксация доказательств"));
  assert.ok(s1.includes("log_measurement_change — регистрация изменения измерителя"));
  assert.ok(s1.includes("команда /autoresearch report — промежуточный отчёт по кампании"));
});

test("полный отчёт: секция 2 — находки по темам со статусами и флагом", () => {
  const dir = buildFullCampaign("full-findings");
  const s2 = sectionOf(buildReport(dir), S2, S3);

  assert.ok(s2.includes("### measurement (2)"));
  assert.ok(s2.includes("### behavior (1)"));
  assert.ok(s2.includes("### capability (1)"));
  assert.ok(s2.includes("### tradeoff (1)"));
  assert.ok(s2.includes("- f1 [needs_verification] (~14% всех ошибок) Правило недостижимо (unreachable)"));
  assert.ok(s2.includes("— evidence: .auto/runs/5/output.txt:2-4 — статус: open"));
  assert.ok(s2.includes("статус: verified"), "поведенческая находка подтверждена переходом");
  // f5 — measurement-находка без заявления о недостижимости: флага нет
  assert.ok(s2.includes("- f5 (") === false);
  assert.ok(/- f5 .*— статус: open/.test(s2));
  assert.ok(!/- f5 \[needs_verification\]/.test(s2));
});

test("полный отчёт: секция 3 — measurement-трек с эпохами и верификацией", () => {
  const dir = buildFullCampaign("full-measure");
  const s3 = sectionOf(buildReport(dir), S3, S4);

  assert.ok(s3.includes("Активная шкала: эпоха 2 · счётчик эпох: 2."));
  assert.ok(s3.includes("old_scale_score 0.5598 → new_scale_score 0.6383"));
  assert.ok(s3.includes("подтверждено независимой проверкой — needs_verification снят"));
  assert.ok(s3.includes("доказательство: .auto/measurement/e2/proof.md"));
  assert.ok(s3.includes("обоснование: finding f1"));
  assert.ok(s3.includes("Прогоны по эпохам: эпоха 1 — 4 · эпоха 2 — 3."));
  assert.ok(s3.includes("Артефакты (.auto/measurement/):"));
  assert.ok(s3.includes("e2/rescore.md"));
});

test("полный отчёт: секция 4 — шум и уверенность", () => {
  const dir = buildFullCampaign("full-noise");
  const s4 = sectionOf(buildReport(dir), S4, S5);

  // floor 0.04, калиброван на эпохе 2, активная шкала — эпоха 2: свежий
  assert.ok(s4.includes("Noise floor: ±0.04 (калиброван на эпохе 2) — свежий"), "floor is shown as an absolute metric value, not a percent");
  // epoch 2: значения 0.61/0.60/0.66 → MAD 0.01, delta 0.05 → 5.0×
  assert.ok(s4.includes("Уверенность: 5.0× — отрыв лучшего keep от baseline в единицах MAD"));
  assert.ok(s4.includes("baseline 0.61 → лучший 0.66"));
});

test("полный отчёт: секция 5 — исчерпанные каналы и неразобранные идеи", () => {
  const dir = buildFullCampaign("full-ideas");
  const s5 = sectionOf(buildReport(dir), S5, S6);

  assert.ok(s5.includes("Исчерпанные каналы (семейства отклонённых гипотез):"));
  assert.ok(s5.includes('- n2 — "cache-friendly layout" — причина: кэш-инвалидация дороже выигрыша'));
  // dead-ends.json и исчерпанная ветвь дерева сливаются по nodeId без дублей
  assert.ok((s5.match(/n2 —/g) ?? []).length === 1);
  assert.ok(s5.includes("Неразобранные идеи (1, .auto/ideas/):"));
  assert.ok(s5.includes("- idea-vector-hash.md"));
  assert.ok(!s5.includes("n2.md"), "файл гипотезы с frontmatter не является неразобранной идеей");
});

test("полный отчёт: секция 6 — owner-input gates без measurement-находок, контроль чист", () => {
  const dir = buildFullCampaign("full-gates");
  const report = buildReport(dir);
  const s6 = sectionOf(report, S6, S7);

  assert.ok(s6.includes("Owner-input gates (требуется решение владельца):"));
  assert.ok(s6.includes("- f3 (capability) (~8% потенциала):"));
  assert.ok(s6.includes("требуется решение владельца: развивать ли это направление (capability)"));
  assert.ok(s6.includes("- f4 (tradeoff):"));
  assert.ok(s6.includes("требуется решение владельца: какую сторону развилки выбрать (tradeoff)"));
  // measurement-находка с needs_verification НЕ является owner-гейтом (spec)
  assert.ok(!s6.includes("f1"));
  assert.ok(!s6.includes("unreachable"));
  // манифесты согласованы с текущим measurer.py, хранилище читается — ограничений нет
  assert.ok(s6.includes("Ограничения контроля: нет данных (нарушений контроля не обнаружено)"));
});

test("полный отчёт: секция 7 — сводка", () => {
  const dir = buildFullCampaign("full-summary");
  const s7 = sectionOf(buildReport(dir), S7, null);

  assert.ok(s7.includes('- Кампания: "fixture-campaign" · метрика accuracy · лучше: больше'));
  assert.ok(s7.includes("- Прогоны: 7 (keep 4 · discard 2 · crash 1) · активная эпоха 2 · baseline 0.61 · лучший 0.66"));
  assert.ok(s7.includes("- Measurement-трек: изменений 1 · активная шкала эпоха 2 · последнее изменение подтверждено независимой проверкой"));
  assert.ok(s7.includes("- Шум: floor ±0.04 (свежий) · уверенность 5.0×"));
  assert.ok(s7.includes("- Находки: всего 5 · открытых 4 · требуют независимой проверки 1 · owner-гейтов 2"));
  assert.ok(s7.includes("- Dead-ends: 1 · неразобранные идеи: 1"));
});

// ---------------------------------------------------------------------------
// Отчёт без находок
// ---------------------------------------------------------------------------

test("отчёт без находок: «линза не применялась», остальные секции строятся", () => {
  const dir = buildFullCampaign("no-findings", { withFindings: false });
  const report = buildReport(dir);

  assertSevenSections(report);
  const s2 = sectionOf(report, S2, S3);
  assert.ok(s2.includes("линза не применялась — находок не записано (.auto/findings.jsonl отсутствует или пуст)"));

  const s3 = sectionOf(report, S3, S4);
  assert.ok(s3.includes("Активная шкала: эпоха 2"), "measurement-трек строится без находок");
  const s6 = sectionOf(report, S6, S7);
  assert.ok(s6.includes("Owner-input gates: нет данных (capability/tradeoff-находок нет)"));
  const s7 = sectionOf(report, S7, null);
  assert.ok(s7.includes("- Находки: линза не применялась"));
});

// ---------------------------------------------------------------------------
// Отчёт пустой кампании
// ---------------------------------------------------------------------------

test("пустая кампания: все семь секций с явными отметками, генератор не падает", () => {
  const dir = makeWorkDir("empty");
  const report = buildReport(dir);

  assertSevenSections(report);
  assert.ok(report.startsWith("# Отчёт кампании: Autoresearch"));
  assert.ok(report.includes("Метрика: нет данных (config-заголовок леджера отсутствует)"));
  assert.ok(report.includes("Прогоны: нет данных (прогонов нет)"));
  assert.ok(report.includes("линза не применялась"));
  assert.ok(report.includes("Изменений измерителя не зарегистрировано (здоровое состояние)"));
  assert.ok(report.includes("Noise floor: не калиброван"));
  assert.ok(report.includes("Уверенность: нет данных"));
  assert.ok(report.includes("нет данных (исчерпанных ветвей и dead-end'ов нет)"));
  // честное ограничение пустой кампании: измеритель не объявлен
  assert.ok(report.includes("analysis.measurement_files не объявлен"));
  // инвентарь называет и отсутствующие скрипты, и инструменты (spec:
  // «скрипты, инструменты» — секция не исчезает в пустой кампании)
  assert.ok(report.includes("- .auto/measure.sh — скрипт замера (команда run_experiment): отсутствует"));
  assert.ok(report.includes("- .auto/checks.sh — скрипт проверок корректности (статус checks_failed): отсутствует"));
  assert.ok(report.includes("- Инструменты кампании (расширение): inspect_results"));
  assert.ok(!report.includes("undefined"));
});

// ---------------------------------------------------------------------------
// Идемпотентность
// ---------------------------------------------------------------------------

test("идемпотентность: два вызова на неизменных данных — одинаковый вывод", () => {
  const dir = buildFullCampaign("idempotent");
  const first = buildReport(dir);
  const second = buildReport(dir);
  const third = buildReport(dir);

  assert.ok(first.length > 1000, "полный отчёт не должен быть пустым");
  assert.equal(first, second);
  assert.equal(second, third);
  // нет метки времени генерации — вывод определяется только данными кампании
  assert.ok(!first.includes("сгенерирован"));
});

test("идемпотентность: вывод меняется вместе с данными, а не между вызовами", () => {
  const dir = buildFullCampaign("idem-data");
  const before = buildReport(dir);
  const res = recordFinding(
    dir,
    { theme: "behavior", description: "Новая находка после первого отчёта", evidence_ref: ".auto/runs/1/output.txt:1-2", run: 1 },
    LATER,
  );
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const after = buildReport(dir);

  assert.notEqual(before, after);
  assert.ok(after.includes("Новая находка после первого отчёта"));
  assert.equal(buildReport(dir), after);
});

// ---------------------------------------------------------------------------
// needs_verification
// ---------------------------------------------------------------------------

test("needs_verification: попадает в очередь проверки с пометкой, вне owner-гейтов", () => {
  const dir = buildFullCampaign("verification");
  const report = buildReport(dir);
  const s2 = sectionOf(report, S2, S3);

  assert.ok(s2.includes("### Требуют независимой проверки"));
  assert.ok(
    s2.includes("Проверка не приостанавливает цикл и не требует одобрения владельца — это рабочая очередь верификации, а не owner-гейт."),
  );
  const queue = s2.slice(s2.indexOf("### Требуют независимой проверки"));
  assert.ok(queue.includes("- f1"), "measurement-находка с флагом — в очереди проверки");
  assert.ok(queue.includes("~14% всех ошибок"), "impact указан в очереди");
  assert.ok(!queue.includes("- f5"), "measurement-находка без флага не в очереди");
  assert.ok(queue.includes("статус: open"));
  assert.ok(!queue.includes("статус: verified"), "подтверждённая находка не возвращается в очередь");

  const s6 = sectionOf(report, S6, S7);
  assert.ok(!s6.includes("f1"), "очередь проверки не попадает в Owner-input gates");
  assert.ok(!s6.includes("unreachable"));
});

test("needs_verification: deferred-находка с флагом остаётся в очереди, verified — нет", () => {
  const dir = buildFullCampaign("verification-deferred");
  const d1 = updateFinding(
    dir,
    { id: "f1", status: "deferred", note: "отложено до следующей эпохи" },
    LATER,
  );
  assert.equal(d1.ok, true, d1.ok ? "" : d1.errors.join("; "));
  const report = buildReport(dir);
  const s2 = sectionOf(report, S2, S3);
  const queue = s2.slice(s2.indexOf("### Требуют независимой проверки"));
  assert.ok(queue.includes("- f1"), "deferred-находка с needs_verification не покидает очередь");
  assert.ok(queue.includes("статус: deferred"));
  assert.ok(!queue.includes("статус: verified"), "подтверждённая находка не возвращается в очередь");
  // счётчик очереди в сводке согласован с подсекцией
  const s7 = sectionOf(report, S7, null);
  assert.ok(s7.includes("требуют независимой проверки 1"));
});

test("needs_verification: behavior-находка с флагом и статусом open не попадает в очередь проверки", () => {
  const dir = buildFullCampaign("verification-behavior");
  // описание с паттерном unreachable → флаг needs_verification ставится findings.ts
  const b = recordFinding(
    dir,
    { theme: "behavior", description: "Ветка повтора unreachable при пустом кэше", evidence_ref: ".auto/runs/5/output.txt:2-4", run: 5 },
    LATER,
  );
  assert.equal(b.ok, true, b.ok ? "" : b.errors.join("; "));
  const report = buildReport(dir);
  const s2 = sectionOf(report, S2, S3);

  // видна в секции 2 с тегом и статусом open
  const line = s2.split("\n").find((l) => l.startsWith(`- ${b.value.id} [needs_verification]`));
  assert.ok(line, "behavior-находка с флагом видна в секции 2 с тегом [needs_verification]");
  assert.ok(line.includes("— статус: open"));

  // очередь проверки содержит только measurement-находку f1
  const queue = s2.slice(s2.indexOf("### Требуют независимой проверки"));
  assert.ok(queue.includes("- f1"));
  assert.ok(!queue.includes(b.value.id), "behavior-находка не попадает в очередь проверки");
  // счётчик очереди в сводке не считает behavior-находку
  const s7 = sectionOf(report, S7, null);
  assert.ok(s7.includes("требуют независимой проверки 1"));
});

test("owner-input gates: capability-находка попадает в гейт при любом статусе", () => {
  const dir = buildFullCampaign("gates-verified");
  const v3 = updateFinding(
    dir,
    { id: "f3", status: "verified", evidence_ref: ".auto/runs/5/output.txt:6-8", note: "направление подтверждено" },
    LATER,
  );
  assert.equal(v3.ok, true, v3.ok ? "" : v3.errors.join("; "));
  const report = buildReport(dir);
  const s6 = sectionOf(report, S6, S7);
  assert.ok(s6.includes("- f3 (capability)"), "verified capability-находка остаётся в owner-гейтах");
  assert.ok(s6.includes("требуется решение владельца: развивать ли это направление (capability)"));
  // счётчик гейтов в сводке согласован: f3 (verified) + f4 (open)
  const s7 = sectionOf(report, S7, null);
  assert.ok(s7.includes("owner-гейтов 2"));
});
