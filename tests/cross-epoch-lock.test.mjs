/**
 * Блокировка поперечных сравнений по эпохам шкалы (openspec add-result-reflection,
 * task 2.3; spec measurement-track: «Эпохи шкалы и блокировка поперечных сравнений» —
 * сценарии «сравнение поперёк эпохи», «сравнение внутри эпохи», «старая кампания без эпох»).
 *
 * Covers:
 *  - index.ts (чистые хелперы): confidence, baseline и best считаются только в
 *    текущей эпохе; прошлая эпоха — справка (priorEpochBest) с собственным
 *    значением и номером прогона, без дельты;
 *  - дашборд (renderDashboardLines): Baseline/Progress от эпохи 2, строка
 *    Cross-epoch, разделитель эпох; эпоха, открытая measurement_change без
 *    прогонов, не получает baseline прошлой эпохи;
 *  - дерево (epochTreeView): ★ best и тело дерева — только текущая эпоха, узлы
 *    прошлой эпохи — справка; дельты и «(baseline: …)» — от baseline текущей эпохи,
 *    а не от корня эпохи 1; без эпох вид совпадает с renderTree;
 *  - миноры ревью 2.2 (bd pi-autoresearch-1wp.3.2): прогон с битым epoch
 *    присоединяется к эпохе 1 и не сравнивается с лучшим эпохи 2 — ни в
 *    confidence, ни в дашборде, ни в дереве. Поведение reverted-записей
 *    (активная шкала после отката) — задача 2.8, здесь не покрывается;
 *  - wiring log_experiment: прогон после measurement_change пишет epoch в
 *    леджер, дельта считается от baseline своей эпохи, Cross-epoch — справка.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/cross-epoch-lock.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { measurementScaleStatus } from "../extensions/pi-autoresearch/measurement.ts";
import {
  computeConfidence,
  epochTreeView,
  findBaselineMetric,
  findBestMetric,
  priorEpochBest,
  renderDashboardLines,
} from "../extensions/pi-autoresearch/index.ts";
import { findBestNodeId, renderNodeDetail, renderTree } from "../extensions/pi-autoresearch/parallel/treeview.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG = '{"type":"config","name":"lock","metricName":"ms","metricUnit":"ms","bestDirection":"lower"}';

const FULL_ARTIFACT = {
  anchor: "run 4 window dev",
  commands: ["python rescore.py --gold v15", "python rescore.py --gold v16"],
  old_scale_score: 0.5598,
  new_scale_score: 0.6383,
};

/** Ledger text: config header + the given record lines. */
function ledger(...lines) {
  return [CONFIG, ...lines].join("\n") + "\n";
}

/** Keep run record; `extra.epoch` absent = epoch 1 (legacy). */
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
    old_scale_score: 0.5598,
    new_scale_score: 0.6383,
    needs_verification: true,
  });
}

/** Three legacy (epoch 1) keep runs: 100, 60, 58 (best 58 at run #3), 62. */
const EPOCH1_RUNS = [run(1, 100), run(2, 60), run(3, 58), run(4, 62)];

/**
 * Dashboard/confidence state built the way index.ts restores it from the ledger
 * (reconstructState): results + baseline + confidence of the current epoch.
 */
function stateFromLedger(text) {
  const rec = reconstructJsonlState(text);
  const results = rec.results.map((r) => ({ ...r, metrics: { ...r.metrics } }));
  const seg = rec.currentSegment;
  return {
    results,
    bestMetric: findBaselineMetric(results, seg),
    bestDirection: rec.bestDirection,
    metricName: rec.metricName,
    metricUnit: rec.metricUnit,
    secondaryMetrics: [],
    name: rec.name,
    currentSegment: seg,
    maxExperiments: null,
    confidence: computeConfidence(results, seg, rec.bestDirection),
  };
}

const stubTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function dashboard(text) {
  return renderDashboardLines(stateFromLedger(text), 240, stubTheme, 6, [], measurementScaleStatus(text));
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

const FLAT_NODES = [
  { id: "n0", parentId: null, runRef: 1, metric: 100, status: "keep", nodeType: "baseline" },
  { id: "n1", parentId: "n0", runRef: 2, metric: 60, status: "keep" },
  { id: "n2", parentId: "n0", runRef: 3, metric: 58, status: "keep" },
  { id: "n3", parentId: "n0", runRef: 4, metric: 62, status: "discard" },
];

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-xepoch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  return dir;
}

function writeMeasurementFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return rel;
}

const writeDiff = (dir) =>
  writeMeasurementFile(dir, ".auto/measurement/e2_gold_v16.diff", "--- a/gold.json\n+++ b/gold.json\n@@ -1 +1 @@\n-зампред\n+заместитель\n");

const writeRescore = (dir) =>
  writeMeasurementFile(dir, ".auto/measurement/e2/rescore.md", JSON.stringify(FULL_ARTIFACT, null, 2) + "\n");

// ---------------------------------------------------------------------------
// Чистые хелперы: confidence / baseline / best и прошлая эпоха
// ---------------------------------------------------------------------------

test("внутри эпохи: baseline, best и confidence считаются как прежде", () => {
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 92, { epoch: 2 }), run(7, 88, { epoch: 2 }));
  const { results } = reconstructJsonlState(text);

  assert.equal(findBaselineMetric(results, 0), 90, "baseline — первый прогон эпохи 2, а не 100 из эпохи 1");
  assert.equal(findBestMetric(results, 0, "lower"), 88, "лучший keep текущей эпохи, не 58 из эпохи 1");
  // Эпоха 2: 90, 92, 88 → медиана 90, |отклонения| 0, 2, 2 → MAD 2;
  // лучший 88 от baseline 90 → |дельта| 2 → confidence 2 / 2 = 1.0.
  assert.equal(computeConfidence(results, 0, "lower"), 1);
});

test("поперёк эпох: прошлая эпоха — только справка с собственным значением и номером", () => {
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }));
  const { results } = reconstructJsonlState(text);

  assert.deepEqual(priorEpochBest(results, 0, 2, "lower"), { epoch: 1, metric: 58, runNumber: 3 });
  assert.equal(priorEpochBest(results, 0, 1, "lower"), null, "у самой первой эпохи прошлой нет");
});

test("поперёк эпох: прошлая эпоха не входит в confidence текущей", () => {
  // Если бы значения эпохи 1 (100, 60, 58, 62) попали в MAD/baseline, результат был бы иным.
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 92, { epoch: 2 }), run(7, 88, { epoch: 2 }));
  const withoutEpoch1 = ledger(change(2), run(5, 90, { epoch: 2 }), run(6, 92, { epoch: 2 }), run(7, 88, { epoch: 2 }));
  assert.equal(computeConfidence(reconstructJsonlState(text).results, 0, "lower"), computeConfidence(reconstructJsonlState(withoutEpoch1).results, 0, "lower"));
});

// ---------------------------------------------------------------------------
// Дашборд
// ---------------------------------------------------------------------------

test("дашборд: эпоха 2 — Baseline/Progress от эпохи 2, Cross-epoch с обеими шкалами, разделитель эпох", () => {
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 92, { epoch: 2 }), run(7, 88, { epoch: 2 }));
  const lines = dashboard(text);

  assert.match(lines.find((l) => l.includes("Baseline:")), /★ ms: 90ms #5/);
  const progress = lines.find((l) => l.includes("Progress:"));
  assert.match(progress, /★ ms: 88ms #7/);
  assert.match(progress, /-2\.2%/, "дельта внутри эпохи 2: 88 против 90");

  const cross = lines.find((l) => l.includes("Cross-epoch:"));
  assert.match(cross, /e1 best ★ ms: 58ms #3 — other scale, delta not computed/);
  assert.doesNotMatch(lines.join("\n"), /58ms[^\n]*%/, "никакого процента относительно значения прошлой эпохи");

  assert.ok(lines.some((l) => l.includes("── epoch 2 ──")), "строки таблицы разделены по эпохам");
});

test("дашборд: эпоха, открытая measurement_change без прогонов, не получает baseline прошлой эпохи", () => {
  const text = ledger(...EPOCH1_RUNS, change(2));
  const lines = dashboard(text);

  assert.match(lines.find((l) => l.includes("Baseline:")), /★ ms: —/, "у эпохи 2 пока нет baseline");
  assert.equal(lines.find((l) => l.includes("Progress:")), undefined, "дельта прошлой эпохи не показывается");
  assert.match(lines.find((l) => l.includes("Cross-epoch:")), /e1 best ★ ms: 58ms #3/);
});

test("дашборд: прогон с битым epoch присоединяется к эпохе 1 и не сравнивается с эпохой 2", () => {
  // Эпоха 2 — 90, 92, 88. Прогон 5 с битым epoch ("2") — эпоха 1 и лучшее 80.
  const text = ledger(
    run(1, 100),
    change(2),
    run(2, 90, { epoch: 2 }),
    run(3, 92, { epoch: 2 }),
    run(4, 88, { epoch: 2 }),
    run(5, 80, { epoch: "2" }),
  );
  const rec = reconstructJsonlState(text);
  assert.deepEqual(rec.results.map((r) => r.epoch), [1, 2, 2, 2, 1], "битый epoch = эпоха 1 (контракт jsonl.ts)");
  assert.equal(rec.currentEpoch, 2, "эпоху новой шкалы держит measurement_change");

  // Лучший и baseline — только эпоха 2; 80 не становится лучшим текущей эпохи.
  assert.equal(findBestMetric(rec.results, 0, "lower"), 88);
  assert.equal(findBaselineMetric(rec.results, 0), 90);
  assert.equal(computeConfidence(rec.results, 0, "lower"), 1, "MAD и baseline без прогона 5");
  assert.deepEqual(priorEpochBest(rec.results, 0, 2, "lower"), { epoch: 1, metric: 80, runNumber: 5 });

  const lines = dashboard(text);
  const progress = lines.find((l) => l.includes("Progress:"));
  assert.match(progress, /★ ms: 88ms #4/);
  assert.match(progress, /-2\.2%/, "дельта только от baseline эпохи 2 (90)");
  assert.doesNotMatch(lines.join("\n"), /-9\.1%|-11\.1%/, "80 не сравнивается с 88 или 90 поперёк эпох");
  assert.match(lines.find((l) => l.includes("Cross-epoch:")), /e1 best ★ ms: 80ms #5/);
});

// ---------------------------------------------------------------------------
// Дерево
// ---------------------------------------------------------------------------

test("дерево: ★ best и тело — только текущая эпоха; прошлая эпоха — справка", () => {
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 88, { epoch: 2 }));
  const tree = makeTree(
    [
      ...FLAT_NODES,
      { id: "n4", parentId: "n0", runRef: 5, metric: 90, status: "keep" },
      { id: "n5", parentId: "n0", runRef: 6, metric: 88, status: "keep" },
    ],
    "n5",
  );
  const view = epochTreeView(tree, text);

  assert.equal(view.epoch, 2);
  assert.equal(findBestNodeId(tree), "n2", "полное дерево без фильтра эпох дало бы ★ 58 из эпохи 1");
  assert.equal(findBestNodeId(view.scoped), "n5", "★ текущей эпохи — 88");
  assert.equal(view.scoped.nodes.n1, undefined, "узлы эпохи 1 не входят в дерево эпохи 2");
  assert.deepEqual(view.scoped.nodes.n0.children, ["n4", "n5"], "дочерние узлы эпохи 2 под корнем");
  assert.equal(view.prior.node.id, "n2");
  assert.equal(view.prior.epoch, 1);
  assert.doesNotMatch(renderTree(view.scoped, 60, 3, 7), /n2/);
});

test("дерево: справка прошлой эпохи — тот же прогон, что в дашборде (keep с metric 0 не берётся)", () => {
  // priorEpochBest пропускает metric <= 0; дерево должно показывать ту же справку.
  const text = ledger(run(1, 100), run(2, 0), run(3, 58), change(2), run(4, 90, { epoch: 2 }));
  const tree = makeTree(
    [
      { id: "n0", parentId: null, runRef: 1, metric: 100, status: "keep", nodeType: "baseline" },
      { id: "n1", parentId: "n0", runRef: 2, metric: 0, status: "keep" },
      { id: "n2", parentId: "n0", runRef: 3, metric: 58, status: "keep" },
      { id: "n3", parentId: "n0", runRef: 4, metric: 90, status: "keep" },
    ],
    "n3",
  );
  const view = epochTreeView(tree, text);

  assert.deepEqual(priorEpochBest(reconstructJsonlState(text).results, 0, 2, "lower"), { epoch: 1, metric: 58, runNumber: 3 });
  assert.equal(view.prior.node.id, "n2", "справка дерева — 58, не 0");
});

test("дерево: прогон с битым epoch остаётся в эпохе 1 и не становится ★ эпохи 2", () => {
  const text = ledger(
    run(1, 100),
    change(2),
    run(2, 90, { epoch: 2 }),
    run(3, 88, { epoch: 2 }),
    run(4, 80, { epoch: "2" }),
  );
  const tree = makeTree(
    [
      { id: "n0", parentId: null, runRef: 1, metric: 100, status: "keep", nodeType: "baseline" },
      { id: "n1", parentId: "n0", runRef: 2, metric: 90, status: "keep" },
      { id: "n2", parentId: "n0", runRef: 3, metric: 88, status: "keep" },
      { id: "n3", parentId: "n0", runRef: 4, metric: 80, status: "keep" },
    ],
    "n2",
  );
  const view = epochTreeView(tree, text);

  assert.equal(view.epoch, 2);
  assert.equal(view.scoped.nodes.n3, undefined, "узел прогона с битым epoch не входит в дерево эпохи 2");
  assert.equal(findBestNodeId(view.scoped), "n2", "★ эпохи 2 — 88, а не 80 с битым epoch");
  assert.equal(view.prior.node.id, "n3", "80 видно только как справка прошлой эпохи");
});

test("дерево: тело и карточка узла эпохи 2 — дельты от baseline эпохи 2, не эпохи 1 (блокер ревью)", () => {
  const text = ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 88, { epoch: 2 }));
  const tree = makeTree(
    [
      ...FLAT_NODES,
      { id: "n4", parentId: "n0", runRef: 5, metric: 90, status: "keep" },
      { id: "n5", parentId: "n0", runRef: 6, metric: 88, status: "keep" },
    ],
    "n5",
  );
  const view = epochTreeView(tree, text);
  assert.equal(view.scoped.baselineMetric, 90, "baseline дерева эпохи 2 — первый прогон эпохи 2");

  const body = renderTree(view.scoped, 60, 3, 7);
  // Дельта считается от 90 (baseline эпохи 2): 90→90 = 0, 90→88 = +2 (2%).
  assert.match(body, /n4 .*\s0\.0 \(0%\)/);
  assert.match(body, /n5 .*\s\+2\.0 \(2%\)/);
  // От 100 (эпоха 1) было бы +10.0 (10%) и +12.0 (12%) — поперечных процентов быть не должно.
  assert.doesNotMatch(body, /\(10%\)|\(12%\)/);

  const detail = renderNodeDetail(view.scoped, view.scoped.nodes.n5);
  assert.match(detail, /\(baseline: 90\.0\)/);
  assert.doesNotMatch(detail, /baseline: 100\.0/);
});

test("дерево без эпох (старая кампания): вид совпадает с полным деревом", () => {
  const text = ledger(run(1, 100), run(2, 60), run(3, 58), run(4, 62));
  const tree = makeTree(FLAT_NODES, "n2");
  const view = epochTreeView(tree, text);

  assert.equal(view.epoch, 1);
  assert.equal(view.prior, null);
  assert.equal(renderTree(view.scoped, 60, 3, 7), renderTree(tree, 60, 3, 7));
});

test("без эпох: дашборд как прежде — без Cross-epoch и разделителей, conf по всей сессии", () => {
  const text = ledger(...EPOCH1_RUNS);
  const lines = dashboard(text);

  assert.match(lines.find((l) => l.includes("Baseline:")), /★ ms: 100ms #1/);
  assert.equal(lines.find((l) => l.includes("Cross-epoch:")), undefined);
  assert.equal(lines.find((l) => l.includes("── epoch")), undefined);
  // 100, 60, 58, 62: медиана 61, отклонения 39, 1, 3, 1 → MAD 2; лучший 58 от baseline 100 → 42 / 2 = 21.0.
  assert.match(lines.find((l) => l.includes("Runs:")), /\(conf: 21\.0×\)/);
});

// ---------------------------------------------------------------------------
// Wiring: log_experiment после measurement_change
// ---------------------------------------------------------------------------

test("log_experiment после measurement_change: epoch в леджере, дельта от baseline своей эпохи, Cross-epoch — справка", async () => {
  const dir = makeWorkDir("wiring");
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), ledger(run(1, 100), run(2, 98), run(3, 97)), "utf-8");

  const { tool, command, hook, ctx } = await createHarness({ dir, sessionId: "cross-epoch-wiring", realGit: true });
  await hook("session_start")({}, ctx);
  await command("autoresearch").handler("on", ctx);

  const changeRes = await tool("log_measurement_change").execute("id", {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir),
    justification: "gold fixed",
  }, null, null, ctx);
  assert.match(changeRes.content[0].text, /Measurement change e2 recorded \(epoch 2/);

  const first = await tool("log_experiment").execute("id", {
    metric: 90,
    status: "keep",
    description: "epoch two first",
    asi: { hypothesis: "h" },
  }, null, null, ctx);
  const firstText = first.content[0].text;
  assert.match(firstText, /Cross-epoch: e1 best 97ms \(run #3\) is on another scale than epoch 2 — delta not computed/);
  assert.doesNotMatch(firstText, /\| this:/, "первый прогон новой эпохи не сравнивается с прогонами эпохи 1");

  const second = await tool("log_experiment").execute("id", {
    metric: 92,
    status: "keep",
    description: "epoch two second",
    asi: { hypothesis: "h" },
  }, null, null, ctx);
  const secondText = second.content[0].text;
  assert.match(secondText, /\| this: 92ms \(\+2\.2%\)/, "дельта от baseline эпохи 2 (90), не от 97 эпохи 1");
  assert.doesNotMatch(secondText, /\(-5\.2%\)/);

  const entries = fs
    .readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const epochOf = (description) => entries.find((e) => e.description === description)?.epoch;
  assert.equal(epochOf("epoch two first"), 2, "новый прогон несёт эпоху 2 в леджере");
  assert.equal(epochOf("epoch two second"), 2);
  assert.equal(entries.find((e) => e.description === "run 1")?.epoch, undefined, "legacy-записи остаются без epoch");
});

// ---------------------------------------------------------------------------
// Wiring: tree_status и виджет дерева (реальные пути инструмента и команды)
// ---------------------------------------------------------------------------

test("tree_status и виджет дерева: текущая эпоха, прошлая — справка, узел с битым epoch не входит", async () => {
  const dir = makeWorkDir("tree-wiring");
  fs.writeFileSync(
    path.join(dir, ".auto", "log.jsonl"),
    ledger(...EPOCH1_RUNS, change(2), run(5, 90, { epoch: 2 }), run(6, 80, { epoch: "2" })),
    "utf-8",
  );
  const tree = makeTree(
    [
      { id: "n0", parentId: null, runRef: 1, metric: 100, status: "keep", nodeType: "baseline" },
      { id: "n1", parentId: "n0", runRef: 2, metric: 60, status: "keep" },
      { id: "n2", parentId: "n0", runRef: 3, metric: 58, status: "keep" },
      { id: "n3", parentId: "n0", runRef: 4, metric: 62, status: "discard" },
      { id: "n4", parentId: "n0", runRef: 5, metric: 90, status: "keep" },
      { id: "n5", parentId: "n0", runRef: 6, metric: 80, status: "keep" },
    ],
    "n4",
  );
  fs.writeFileSync(path.join(dir, ".auto", "tree.json"), JSON.stringify(tree), "utf-8");

  const { tool, command, hook, ctx } = await createHarness({ dir, sessionId: "cross-epoch-tree", realGit: true });
  await hook("session_start")({}, ctx);
  await command("autoresearch").handler("on", ctx);

  const res = await tool("tree_status").execute("id", {}, null, null, ctx);
  const text = res.content[0].text;
  assert.match(text, /Epoch 2 \(current\): best and deltas within this epoch only/);
  assert.match(text, /n4 .*← HERE ★ BEST/, "★ текущей эпохи — n4 (90), в теле дерева");
  assert.match(text, /Nodes: 2 /, "в дереве эпохи 2 — корень и узел текущей эпохи");
  assert.match(text, /↔ e1 best: n2 \(58\) — other scale, not compared with epoch 2/);
  assert.doesNotMatch(text, /n5/, "прогон с битым epoch — в эпохе 1, не в дереве эпохи 2");
  assert.match(text, /n4 .*\s0\.0 \(0%\)/, "baseline эпохи 2 — n4 (90)");
  assert.doesNotMatch(text, /\(10%\)/, "+10% — дельта 90 от 100 эпохи 1 — не должна попасть в вывод");

  let widgetFactory = null;
  ctx.ui.setWidget = (_key, factory) => {
    if (factory) widgetFactory = factory;
  };
  await command("autoresearch").handler("tree", ctx);
  assert.ok(widgetFactory, "виджет дерева отрисован");
  const widgetLines = widgetFactory({ requestRender() {} }, stubTheme).render(240);
  const widgetText = widgetLines.join("\n");
  assert.match(widgetText, /Epoch 2 \(current\): best and deltas within this epoch only/);
  assert.match(widgetText, /↔ e1 best: n2 \(58\)/);
  assert.doesNotMatch(widgetText, /n5/);
});
