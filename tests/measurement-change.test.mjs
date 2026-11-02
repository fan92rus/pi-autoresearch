/**
 * Measurement change tool (openspec add-result-reflection, task 2.1;
 * spec measurement-track/spec.md).
 *
 * Covers the logic in extensions/pi-autoresearch/measurement.ts:
 *  - log_measurement_change: a correct record (epoch+1, needs_verification,
 *    scores parsed FROM the rescore artifact); rejections without a diff /
 *    artifact / justification; pending with an artifact that has anchor +
 *    commands but no scores; completing a pending change with a full artifact
 *    (measurement_change_completed, same epoch); paths outside workDir;
 *    file-symlink escapes, an accepted internal file symlink, and a junction on
 *    the .auto/measurement directory itself; broken artifacts;
 *  - index.ts wiring: the gate refuses with the mode off; the tool writes the
 *    ledger record through the store when the mode is on.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/measurement-change.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { logMeasurementChange } from "../extensions/pi-autoresearch/measurement.ts";
import { recordFinding } from "../extensions/pi-autoresearch/findings.ts";

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

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-meas-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), text, "utf-8");
}

function readLedger(dir) {
  return fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8")
    .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function ledgerCount(dir, type) {
  return readLedger(dir).filter((e) => e.type === type).length;
}

function validInput(dir) {
  return {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold penalises form variants twice (scorer double-counts)",
  };
}

function errorsOf(res) {
  assert.equal(res.ok, false, "expected rejection");
  return res.errors.join("\n");
}

function symlinkFile(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    // Windows without developer mode / admin refuses file symlinks.
    return false;
  }
}

function symlinkDir(target, linkPath) {
  try {
    // "junction" needs no privileges on Windows; on POSIX the type argument is
    // ignored and a regular directory symlink is created (same realpath
    // resolution, so the test covers both platforms).
    fs.symlinkSync(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Correct record
// ---------------------------------------------------------------------------

test("корректная запись: epoch+1, needs_verification, числа распарсены из артефакта", () => {
  const dir = makeWorkDir("ok");
  // Записи без epoch = эпоха 1 → первое изменение открывает эпоху 2.
  seedLedger(dir, [{ type: "config", name: "bench", metricName: "ms" }, { run: 45, metric: 1.2, status: "keep" }]);
  const input = validInput(dir);

  const res = logMeasurementChange(dir, input, FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const rec = res.value;
  assert.equal(rec.type, "measurement_change");
  assert.equal(rec.epoch, 2);
  assert.equal(rec.diff_ref, ".auto/measurement/e2_gold_v16.diff");
  assert.equal(rec.rescore_ref, ".auto/measurement/e2/rescore.md");
  assert.equal(rec.justification, "gold penalises form variants twice (scorer double-counts)");
  assert.equal(rec.old_scale_score, 0.5598);
  assert.equal(rec.new_scale_score, 0.6383);
  assert.equal(rec.needs_verification, true);
  assert.equal("rescore_pending" in rec, false);
  assert.equal(rec.timestamp, FIXED_NOW.toISOString());

  const lines = readLedger(dir);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2], rec);
});

test("epoch растёт: второе изменение открывает следующую эпоху", () => {
  const dir = makeWorkDir("epochs");
  seedLedger(dir, [{ type: "measurement_change", epoch: 2, needs_verification: true }]);

  const first = logMeasurementChange(dir, validInput(dir), FIXED_NOW);
  assert.equal(first.ok, true, first.ok ? "" : first.errors.join("; "));
  assert.equal(first.value.epoch, 3);

  const second = logMeasurementChange(dir, validInput(dir), LATER);
  assert.equal(second.ok, true, second.ok ? "" : second.errors.join("; "));
  assert.equal(second.value.epoch, 4);
  assert.equal(ledgerCount(dir, "measurement_change"), 3);
});

test("артефакт в markdown-обёртке ``` читается", () => {
  const dir = makeWorkDir("fenced");
  const fenced = "```json\n" + JSON.stringify(FULL_ARTIFACT, null, 2) + "\n```";
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeMeasurementFile(dir, ".auto/measurement/e2/rescore.md", fenced),
    justification: "reason",
  }, FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.old_scale_score, 0.5598);
  assert.equal(res.value.new_scale_score, 0.6383);
});

// ---------------------------------------------------------------------------
// Rejections: diff / artifact / justification
// ---------------------------------------------------------------------------

test("отказ: нет diff_ref — требование зафиксировать дифф в .auto/measurement/", () => {
  const dir = makeWorkDir("no-diff");
  const input = validInput(dir);
  delete input.diff_ref;

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /diff_ref: отсутствует/);
  assert.match(text, /\.auto\/measurement\//);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "rejected call must not write the ledger");
});

test("отказ: diff_ref не существует", () => {
  const dir = makeWorkDir("diff-missing");
  const input = validInput(dir);
  input.diff_ref = ".auto/measurement/missing.diff";

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /diff_ref: "\.auto\/measurement\/missing\.diff": файл не найден/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("отказ: diff_ref внутри workDir, но вне .auto/measurement/", () => {
  const dir = makeWorkDir("diff-wrongdir");
  const input = validInput(dir);
  input.diff_ref = writeMeasurementFile(dir, "eval/gold_v16.diff", "--- a\n+++ b\n");

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /diff_ref: "eval\/gold_v16\.diff":/);
  assert.match(text, /путь должен находиться в \.auto\/measurement\//);
});

test("отказ: пустой дифф", () => {
  const dir = makeWorkDir("diff-empty");
  const input = validInput(dir);
  input.diff_ref = writeMeasurementFile(dir, ".auto/measurement/empty.diff", "   \n");

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /diff_ref: ".*" пуст/);
});

test("отказ: нет rescore_ref", () => {
  const dir = makeWorkDir("no-rescore");
  const input = validInput(dir);
  delete input.rescore_ref;

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /rescore_ref: отсутствует/);
  assert.match(text, /anchor/);
  assert.match(text, /commands/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("отказ: rescore_ref не существует", () => {
  const dir = makeWorkDir("rescore-missing");
  const input = validInput(dir);
  input.rescore_ref = ".auto/measurement/e2/absent.md";

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /rescore_ref: "\.auto\/measurement\/e2\/absent\.md": файл не найден/);
});

test("отказ: нет justification", () => {
  const dir = makeWorkDir("no-just");
  const input = validInput(dir);
  delete input.justification;

  const text = errorsOf(logMeasurementChange(dir, input, FIXED_NOW));

  assert.match(text, /justification: отсутствует/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("justification: несуществующий finding id отвергается, существующий принимается", () => {
  const dir = makeWorkDir("just-finding");
  const input = validInput(dir);
  const outRel = writeMeasurementFile(dir, ".auto/runs/45/output.txt", "MISMATCH gold=заместитель pred=зампред\n");

  const bad = errorsOf(logMeasurementChange(dir, { ...input, justification: "f99" }, FIXED_NOW));
  assert.match(bad, /justification: "f99" — находка с таким id не найдена/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);

  const created = recordFinding(dir, {
    theme: "measurement",
    description: "scorer double-counts form variants",
    evidence_ref: `${outRel}:1`,
  }, FIXED_NOW);
  assert.equal(created.ok, true);

  const res = logMeasurementChange(dir, { ...input, justification: "f1" }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.justification, "f1");
});

// ---------------------------------------------------------------------------
// Pending
// ---------------------------------------------------------------------------

test("pending: артефакт с якорем и командами без оценок → запись pending, эпоха открыта без завершения", () => {
  const dir = makeWorkDir("pending");
  const res = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "gold fixed, rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const rec = res.value;
  assert.equal(rec.type, "measurement_change");
  assert.equal(rec.epoch, 2);
  assert.equal(rec.rescore_pending, true);
  assert.equal(rec.needs_verification, true);
  assert.equal("old_scale_score" in rec, false);
  assert.equal("new_scale_score" in rec, false);
  assert.deepEqual(readLedger(dir), [rec]);
});

test("отказ: артефакт без оценок, а rescore_pending не установлен", () => {
  const dir = makeWorkDir("pending-noflag");
  const text = errorsOf(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "reason",
  }, FIXED_NOW));

  assert.match(text, /нет old_scale_score и new_scale_score/);
  assert.match(text, /rescore_pending: true/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("rescore_pending: true при полном артефакте — оценки записаны, pending-флага нет (артефакт — источник истины)", () => {
  const dir = makeWorkDir("pending-full");
  const res = logMeasurementChange(dir, { ...validInput(dir), rescore_pending: true }, FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.old_scale_score, 0.5598);
  assert.equal(res.value.new_scale_score, 0.6383);
  assert.equal("rescore_pending" in res.value, false);
});

// ---------------------------------------------------------------------------
// Completion of a pending change (numbers from the FULL artifact)
// ---------------------------------------------------------------------------

test("завершение pending: measurement_change_completed в той же эпохе, числа из полного артефакта", () => {
  const dir = makeWorkDir("complete");
  const rescoreRel = ".auto/measurement/e2/rescore.md";
  const pending = logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "gold fixed, rescore not run yet",
    rescore_pending: true,
  }, FIXED_NOW);
  assert.equal(pending.ok, true, pending.ok ? "" : pending.errors.join("; "));

  // Агент выполняет рескор и дополняет ТОТ же файл оценками.
  writeRescore(dir, FULL_ARTIFACT);

  const res = logMeasurementChange(dir, { change_ref: "e2", rescore_ref: rescoreRel }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  const rec = res.value;
  assert.equal(rec.type, "measurement_change_completed");
  assert.equal(rec.change_ref, "e2");
  assert.equal(rec.epoch, 2, "completion stays in the same epoch — no bump");
  assert.equal(rec.rescore_ref, rescoreRel);
  assert.equal(rec.old_scale_score, 0.5598);
  assert.equal(rec.new_scale_score, 0.6383);

  assert.equal(ledgerCount(dir, "measurement_change"), 1, "original record is not rewritten or duplicated");
  assert.equal(ledgerCount(dir, "measurement_change_completed"), 1);
  assert.deepEqual(readLedger(dir)[1], rec);
});

test("завершение: change_ref без префикса e нормализуется в e<n>", () => {
  const dir = makeWorkDir("complete-bare");
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "reason",
    rescore_pending: true,
  }, FIXED_NOW).ok, true);

  const res = logMeasurementChange(dir, { change_ref: "2", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.change_ref, "e2");
});

test("отказ завершения: неизвестный change_ref, не-pending изменение, повторное завершение, неполный артефакт", () => {
  const dir = makeWorkDir("complete-rejects");

  // Ни одного изменения в леджере:
  const none = errorsOf(logMeasurementChange(dir, { change_ref: "e2", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, FIXED_NOW));
  assert.match(none, /change_ref: изменение e2 не найдено в леджере/);
  assert.match(none, /изменений измерителя не зарегистрировано/);

  // Pending-изменение e2, полное завершение:
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT),
    justification: "reason",
    rescore_pending: true,
  }, FIXED_NOW).ok, true);
  assert.equal(logMeasurementChange(dir, { change_ref: "e2", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, FIXED_NOW).ok, true);

  // Неизвестная эпоха после регистрации e2:
  const unknown = errorsOf(logMeasurementChange(dir, { change_ref: "e9", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, FIXED_NOW));
  assert.match(unknown, /изменение e9 не найдено/);
  assert.match(unknown, /зарегистрированы: e2/);

  // Повторное завершение уже завершённого:
  const dup = errorsOf(logMeasurementChange(dir, { change_ref: "e2", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, FIXED_NOW));
  assert.match(dup, /уже завершено/);

  // Не-pending изменение (оценки уже в записи):
  const full = logMeasurementChange(dir, validInput(dir), LATER);
  assert.equal(full.ok, true, full.ok ? "" : full.errors.join("; ")); // e3, полный артефакт
  const notPending = errorsOf(logMeasurementChange(dir, { change_ref: "e3", rescore_ref: writeRescore(dir, FULL_ARTIFACT) }, LATER));
  assert.match(notPending, /не в pending/);

  // Неполный артефакт при завершении pending e4:
  assert.equal(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, PENDING_ARTIFACT, "e4/rescore.md"),
    justification: "reason",
    rescore_pending: true,
  }, LATER).ok, true);
  const incomplete = errorsOf(logMeasurementChange(dir, { change_ref: "e4", rescore_ref: writeRescore(dir, PENDING_ARTIFACT, "e4/rescore.md") }, LATER));
  assert.match(incomplete, /неполный/);
  assert.match(incomplete, /old_scale_score и new_scale_score/);
});

// ---------------------------------------------------------------------------
// Paths outside workDir
// ---------------------------------------------------------------------------

test("отказ: путь вне workDir (абсолютный и относительный выход за корень)", () => {
  const dir = makeWorkDir("outside");
  const sibling = makeWorkDir("outside-sibling");
  const outsideDiff = path.join(sibling, "evil.diff");
  fs.writeFileSync(outsideDiff, "--- a\n+++ b\n", "utf-8");
  const outsideRescore = path.join(sibling, "rescore.json");
  fs.writeFileSync(outsideRescore, JSON.stringify(FULL_ARTIFACT), "utf-8");

  const base = {
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "reason",
  };

  const absText = errorsOf(logMeasurementChange(dir, { ...base, diff_ref: outsideDiff }, FIXED_NOW));
  assert.match(absText, /diff_ref: ".*evil\.diff": путь вне workDir/);

  const relDiff = path.relative(dir, outsideDiff);
  assert.ok(relDiff.startsWith(".."), "relative escape expected");
  const relText = errorsOf(logMeasurementChange(dir, { ...base, diff_ref: relDiff }, FIXED_NOW));
  assert.match(relText, /путь вне workDir/);

  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);
});

test("отказ: symlink внутри .auto/measurement/ на файл в другом месте workDir", (t) => {
  const dir = makeWorkDir("symlink-escape-dir");
  const evilDiff = path.join(dir, "evil.diff");
  fs.writeFileSync(evilDiff, "--- a\n+++ b\n", "utf-8");
  const evilRescore = path.join(dir, "evil-rescore.json");
  fs.writeFileSync(evilRescore, JSON.stringify(FULL_ARTIFACT), "utf-8");

  fs.mkdirSync(path.join(dir, ".auto", "measurement", "e2"), { recursive: true });
  const linkDiff = path.join(dir, ".auto", "measurement", "link.diff");
  const linkRescore = path.join(dir, ".auto", "measurement", "e2", "link-rescore.json");
  if (!symlinkFile(evilDiff, linkDiff) || !symlinkFile(evilRescore, linkRescore)) {
    t.skip("file symlinks not permitted on this host");
    return;
  }

  const diffText = errorsOf(logMeasurementChange(dir, {
    diff_ref: ".auto/measurement/link.diff",
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "reason",
  }, FIXED_NOW));
  assert.match(diffText, /diff_ref/);
  assert.match(diffText, /вне \.auto\/measurement\//);

  const rescoreText = errorsOf(logMeasurementChange(dir, {
    diff_ref: writeDiff(dir),
    rescore_ref: ".auto/measurement/e2/link-rescore.json",
    justification: "reason",
  }, FIXED_NOW));
  assert.match(rescoreText, /rescore_ref/);
  assert.match(rescoreText, /вне \.auto\/measurement\//);

  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "rejected symlinks never reach the ledger");
});

test("symlink на файл внутри .auto/measurement/ принимается: realpath остаётся в каталоге", (t) => {
  const dir = makeWorkDir("symlink-inside");
  const realDiff = path.join(dir, ".auto", "measurement", "real.diff");
  fs.mkdirSync(path.dirname(realDiff), { recursive: true });
  fs.writeFileSync(realDiff, "--- a\n+++ b\n", "utf-8");
  if (!symlinkFile(realDiff, path.join(dir, ".auto", "measurement", "alias.diff"))) {
    t.skip("file symlinks not permitted on this host");
    return;
  }

  const res = logMeasurementChange(dir, {
    diff_ref: ".auto/measurement/alias.diff",
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "reason",
  }, FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.diff_ref, ".auto/measurement/alias.diff");
});

test("отказ: каталог .auto/measurement — junction на каталог вне .auto/ (внутри workDir)", (t) => {
  const dir = makeWorkDir("dirlink-escape");
  // Валидные дифф и артефакт лежат в реальном каталоге внутри workDir, но
  // вне .auto/ — junction подменяет сам .auto/measurement на этот каталог.
  const target = path.join(dir, "eval");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "gold.diff"),
    "--- a/gold.json\n+++ b/gold.json\n@@ -1 +1 @@\n-зампред\n+заместитель\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(target, "rescore.json"), JSON.stringify(FULL_ARTIFACT, null, 2) + "\n", "utf-8");

  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  if (!symlinkDir(target, path.join(dir, ".auto", "measurement"))) {
    t.skip("directory symlinks/junctions not permitted on this host");
    return;
  }

  const text = errorsOf(logMeasurementChange(dir, {
    diff_ref: ".auto/measurement/gold.diff",
    rescore_ref: ".auto/measurement/rescore.json",
    justification: "reason",
  }, FIXED_NOW));
  assert.match(text, /diff_ref/);
  assert.match(text, /rescore_ref/);
  // Fix 1 (review): realpath(.auto/measurement) resolves to the junction
  // target, so the file-vs-directory check alone passes — the REAL directory
  // itself must be contained in the REAL .auto/.
  assert.match(text, /каталог \.auto\/measurement\/ ведёт вне \.auto\//);
  assert.match(text, /вне \.auto\/measurement\//);

  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "rejected directory link never reaches the ledger");
});

// ---------------------------------------------------------------------------
// Broken artifacts
// ---------------------------------------------------------------------------

test("битый артефакт: не-JSON, массив, нет anchor, пустые commands, строковая оценка", () => {
  const dir = makeWorkDir("broken");
  const cases = [
    { content: "это вообще не json", match: /не читается как JSON/ },
    { content: JSON.stringify([1, 2]), match: /должен быть JSON-объектом/ },
    { content: JSON.stringify({ commands: ["cmd"], old_scale_score: 1, new_scale_score: 2 }), match: /anchor отсутствует/ },
    { content: JSON.stringify({ anchor: "run 45", old_scale_score: 1, new_scale_score: 2 }), match: /commands отсутствует/ },
    { content: JSON.stringify({ anchor: "run 45", commands: [] }), match: /commands отсутствует/ },
    { content: JSON.stringify({ anchor: "run 45", commands: ["ok", 42] }), match: /commands .* содержит не-строки/ },
    { content: JSON.stringify({ anchor: "run 45", commands: ["ok"], old_scale_score: "0.56", new_scale_score: 2 }), match: /old_scale_score должно быть конечным числом/ },
  ];
  for (const [i, c] of cases.entries()) {
    const rel = writeMeasurementFile(dir, ".auto/measurement/e2/rescore.md", c.content);
    const text = errorsOf(logMeasurementChange(dir, {
      diff_ref: writeDiff(dir, `e2_case${i}.diff`),
      rescore_ref: rel,
      justification: "reason",
    }, FIXED_NOW));
    assert.match(text, c.match, `case ${i}: ${c.content}`);
  }
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false, "broken artifacts never reach the ledger");
});

// ---------------------------------------------------------------------------
// index.ts wiring (gate + tool response)
// ---------------------------------------------------------------------------

test("index.ts: log_measurement_change за gate — режим off отказывает, on записывает через tool", async () => {
  const dir = makeWorkDir("wiring");
  const { pi, tool, command } = createFakePi({ dir, sessionId: "meas-wiring", realGit: false });
  const ctx = makeCtx(dir, "meas-wiring", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);

  const input = {
    diff_ref: writeDiff(dir),
    rescore_ref: writeRescore(dir, FULL_ARTIFACT),
    justification: "gold fixed",
  };

  // Mode off: the gate refuses before touching the ledger.
  const gated = await tool("log_measurement_change").execute("id", input, null, null, ctx);
  assert.match(gated.content[0].text, /Autoresearch mode is OFF/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), false);

  await command("autoresearch").handler("on", ctx);

  const rejected = await tool("log_measurement_change").execute("id", { diff_ref: input.diff_ref }, null, null, ctx);
  assert.match(rejected.content[0].text, /log_measurement_change rejected/);
  assert.match(rejected.content[0].text, /rescore_ref: отсутствует/);
  assert.match(rejected.content[0].text, /justification: отсутствует/);

  const ok = await tool("log_measurement_change").execute("id", input, null, null, ctx);
  assert.match(ok.content[0].text, /Measurement change e2 recorded \(epoch 2: 0\.5598 → 0\.6383, needs_verification: true\)/);
  assert.equal(ok.details.change_ref, "e2");
  assert.equal(ok.details.epoch, 2);
  assert.equal(ok.details.needs_verification, true);

  const ledger = readLedger(dir);
  assert.equal(ledger[ledger.length - 1].type, "measurement_change");
  assert.equal(ledger[ledger.length - 1].epoch, 2);
});
