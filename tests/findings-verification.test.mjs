/**
 * needs_verification flag (openspec add-result-reflection, task 1.6a; spec findings
 * "Пометка аудитов на верификацию").
 *
 * Covers the pattern check in extensions/pi-autoresearch/findings.ts:
 *  - positive examples for every named pattern (unreachable, impossible,
 *    «никогда не», «recall 0», «0/N») on any theme;
 *  - negative examples that must NOT flag (recall 0.85, 10/87, plain claims);
 *  - the flag is written on record_finding and re-evaluated on every status
 *    transition, persists through the fold, and never blocks a write or the cycle.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/findings-verification.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FINDINGS_FILE,
  loadFindings,
  needsVerificationClaim,
  recordFinding,
  updateFinding,
} from "../extensions/pi-autoresearch/findings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");
const LATER = new Date("2026-11-02T04:00:00.000Z");

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-verif-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 140 numbered lines; line 125 carries an anchor. */
function writeRunOutput(workDir, run = 45) {
  const lines = [];
  for (let i = 1; i <= 140; i++) lines.push(`line ${i}`);
  lines[124] = "MISMATCH gold=заместитель pred=зампред";
  const rel = `.auto/runs/${run}/output.txt`;
  const abs = path.join(workDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join("\n") + "\n", "utf-8");
  return rel;
}

function readJsonl(workDir) {
  const raw = fs.readFileSync(path.join(workDir, ".auto", FINDINGS_FILE), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function finding(description, evidence, extra = {}) {
  return { theme: "measurement", description, evidence_ref: evidence, ...extra };
}

/** Create one finding and return its id (asserting success). */
function seed(workDir, description, evidence, extra = {}) {
  const res = recordFinding(workDir, finding(description, evidence, extra), FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  return res.value.id;
}

// ---------------------------------------------------------------------------
// Pattern check: positive examples
// ---------------------------------------------------------------------------

test("claim patterns: «0/N» флагует заявление о нулевом охвате (пример из спеки)", () => {
  assert.equal(needsVerificationClaim("FN-replay: 0/87 недостижимы"), true);
  assert.equal(needsVerificationClaim("Совпадений 0/12 в dev-окне"), true);
  assert.equal(needsVerificationClaim("0/0 кандидатов"), true);
});

test("claim patterns: «unreachable» и «impossible» флагуют без учёта регистра", () => {
  assert.equal(needsVerificationClaim("Ветка правила unreachable для gold-форм"), true);
  assert.equal(needsVerificationClaim("UNREACHABLE: путь не вызывается"), true);
  assert.equal(needsVerificationClaim("Совпадение impossible при текущем нормализаторе"), true);
  assert.equal(needsVerificationClaim("Impossible to hit with dev split"), true);
});

test("claim patterns: «никогда не» флагует в любом регистре", () => {
  assert.equal(needsVerificationClaim("Для формы зампред правило никогда не срабатывает"), true);
  assert.equal(needsVerificationClaim("Никогда не попадает в gold-набор"), true);
  assert.equal(needsVerificationClaim("значение  никогда   не сравнивается"), true);
});

test("claim patterns: «recall 0» флагует нулевой recall, включая 0.0 и конец предложения", () => {
  assert.equal(needsVerificationClaim("recall 0 на dev-окне"), true);
  assert.equal(needsVerificationClaim("Recall 0)"), true);
  assert.equal(needsVerificationClaim("вариант дал recall 0.0 на всех прогонах"), true);
  assert.equal(needsVerificationClaim("вариант дал recall 0."), true);
});

test("claim patterns: флаг ставится для любой темы, не только measurement", () => {
  // Spec: "Находка с темой measurement (или любая находка)".
  for (const theme of ["measurement", "behavior", "capability", "tradeoff"]) {
    const dir = makeWorkDir(`theme-ok-${theme}`);
    const rel = writeRunOutput(dir);
    const res = recordFinding(
      dir,
      { theme, description: "FN-replay: 0/87 недостижимы", evidence_ref: `${rel}:125` },
      FIXED_NOW,
    );
    assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
    assert.equal(res.value.needs_verification, true, `theme ${theme}`);
  }
});

// ---------------------------------------------------------------------------
// Pattern check: negative examples (must not flag)
// ---------------------------------------------------------------------------

test("claim patterns: «recall» с ненулевым значением не флагуется", () => {
  assert.equal(needsVerificationClaim("recall 0.85 на dev-окне"), false);
  assert.equal(needsVerificationClaim("recall 0,85 на dev-окне"), false);
  assert.equal(needsVerificationClaim("recall 0.05 после правки"), false);
  assert.equal(needsVerificationClaim("recall 0.5"), false);
  assert.equal(needsVerificationClaim("recall 10 из 87"), false);
  assert.equal(needsVerificationClaim("recall 1.0"), false);
});

test("claim patterns: «0/N» внутри большего числа не флагуется", () => {
  assert.equal(needsVerificationClaim("ошибок 10/87"), false);
  assert.equal(needsVerificationClaim("доля 20/87 от всех"), false);
  assert.equal(needsVerificationClaim("доля 1/0 не определена"), false);
  assert.equal(needsVerificationClaim("версия 1.0/87"), false);
});

test("claim patterns: обычные описания и близкие слова не флагуются", () => {
  assert.equal(needsVerificationClaim("Зампред штрафуется как ошибка, хотя совпадает с gold"), false);
  assert.equal(needsVerificationClaim("Ветка reachable и вызывается на всех прогонах"), false);
  assert.equal(needsVerificationClaim("Possible regression in the parser"), false);
  assert.equal(needsVerificationClaim("Никогда в жизни не видел такого"), false, "«никогда» без «не» рядом");
  assert.equal(needsVerificationClaim("Метрика выросла на 0.02 относительно прогона 44"), false);
});

// ---------------------------------------------------------------------------
// record_finding: the flag is written and never blocks
// ---------------------------------------------------------------------------

test("record_finding: описание с шаблоном получает needs_verification и пишется в строку finding", () => {
  const dir = makeWorkDir("record-flag");
  const rel = writeRunOutput(dir);

  const res = recordFinding(dir, finding("FN-replay: 0/87 недостижимы", `${rel}:125`), FIXED_NOW);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.needs_verification, true);
  const line = readJsonl(dir)[0];
  assert.equal(line.type, "finding");
  assert.equal(line.needs_verification, true);
  assert.equal(loadFindings(dir).value.findings.get(res.value.id).needs_verification, true);
});

test("record_finding: описание без шаблона не получает поле в записи и во view", () => {
  const dir = makeWorkDir("record-noflag");
  const rel = writeRunOutput(dir);

  const res = recordFinding(dir, finding("Зампред штрафуется дважды", `${rel}:125`), FIXED_NOW);

  assert.equal(res.ok, true);
  assert.equal("needs_verification" in res.value, false);
  assert.equal("needs_verification" in readJsonl(dir)[0], false);
  assert.equal(loadFindings(dir).value.findings.get(res.value.id).needs_verification, false);
});

test("record_finding: флаг не блокирует запись и не требует владельца", () => {
  const dir = makeWorkDir("record-nonblocking");
  const rel = writeRunOutput(dir);

  // Flagged claim with a valid evidence_ref: accepted in one call, no owner step.
  const created = recordFinding(dir, finding("impossible: ветка никогда не достигается", `${rel}:125`), FIXED_NOW);
  assert.equal(created.ok, true, created.ok ? "" : created.errors.join("; "));
  assert.equal(created.value.status, "open");

  // The cycle continues: the flagged finding can be deferred without any evidence.
  const deferred = updateFinding(dir, { id: created.value.id, status: "deferred" }, LATER);
  assert.equal(deferred.ok, true, deferred.ok ? "" : deferred.errors.join("; "));
});

test("record_finding: флаг не отменяет остальные проверки evidence_ref", () => {
  const dir = makeWorkDir("record-still-validated");
  writeRunOutput(dir);

  const noEvidence = recordFinding(dir, finding("0/87 недостижимы", undefined), FIXED_NOW);
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.errors.join("\n"), /evidence_ref: отсутствует/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", FINDINGS_FILE)), false);
});

// ---------------------------------------------------------------------------
// update_finding: the flag is re-set on transitions and kept by the fold
// ---------------------------------------------------------------------------

test("update_finding: переход находки с шаблоном ставит флаг в строке finding_transition", () => {
  const dir = makeWorkDir("transition-flag");
  const rel = writeRunOutput(dir);
  const id = seed(dir, "FN-replay: 0/87 недостижимы", `${rel}:125`);

  const res = updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=` }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.needs_verification, true);
  assert.equal(readJsonl(dir).at(-1).needs_verification, true);
  assert.equal(loadFindings(dir).value.findings.get(id).needs_verification, true);
});

test("update_finding: переход находки без шаблона не добавляет флаг", () => {
  const dir = makeWorkDir("transition-noflag");
  const rel = writeRunOutput(dir);
  const id = seed(dir, "Зампред штрафуется дважды", `${rel}:125`);

  const res = updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=` }, LATER);

  assert.equal(res.ok, true);
  assert.equal("needs_verification" in readJsonl(dir).at(-1), false);
  assert.equal(loadFindings(dir).value.findings.get(id).needs_verification, false);
});

test("update_finding: старая запись без флага получает его при первом переходе", () => {
  const dir = makeWorkDir("transition-legacy");
  const rel = writeRunOutput(dir);
  // Pre-flag store: the creation line has no needs_verification.
  const legacy = {
    type: "finding",
    id: "f1",
    theme: "behavior",
    description: "Ветка recall 0 на всех прогонах",
    evidence_ref: `${rel}:125`,
    status: "open",
    created: FIXED_NOW.toISOString(),
  };
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", FINDINGS_FILE), JSON.stringify(legacy) + "\n", "utf-8");
  assert.equal(loadFindings(dir).value.findings.get("f1").needs_verification, false);

  const res = updateFinding(dir, { id: "f1", status: "deferred" }, LATER);

  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  assert.equal(res.value.needs_verification, true);
  assert.equal(loadFindings(dir).value.findings.get("f1").needs_verification, true);
});

test("update_finding: флаг сохраняется через verified → revised (контрпример не снимает пометку)", () => {
  const dir = makeWorkDir("transition-chain");
  const rel = writeRunOutput(dir);
  const id = seed(dir, "FN-replay: 0/87 недостижимы", `${rel}:125`);
  const verified = updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=` }, LATER);
  assert.equal(verified.ok, true, verified.ok ? "" : verified.errors.join("; "));

  const revised = updateFinding(dir, { id, status: "revised", evidence_ref: `${rel}:120-130` }, LATER);

  assert.equal(revised.ok, true, revised.ok ? "" : revised.errors.join("; "));
  assert.equal(loadFindings(dir).value.findings.get(id).status, "revised");
  assert.equal(loadFindings(dir).value.findings.get(id).needs_verification, true);
  assert.equal(readJsonl(dir).at(-1).needs_verification, true);
});

test("update_finding: флаг не мешает карте переходов — запрещённый переход отвергается как раньше", () => {
  const dir = makeWorkDir("transition-forbidden");
  const rel = writeRunOutput(dir);
  const id = seed(dir, "FN-replay: 0/87 недостижимы", `${rel}:125`);
  updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=` }, LATER);

  const res = updateFinding(dir, { id, status: "open" }, LATER);

  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /verified → open запрещён/);
  assert.equal(readJsonl(dir).length, 2, "rejected transition is not appended");
});
