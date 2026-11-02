/**
 * Findings store (openspec add-result-reflection, task 1.6; spec findings/spec.md).
 *
 * Covers the pure store in extensions/pi-autoresearch/findings.ts:
 *  - record_finding: a correct finding is appended with status open; rejections
 *    without evidence (with a concrete example), unknown theme, missing file,
 *    anchor not found, line range past EOF, path outside workDir;
 *  - update_finding: allowed transitions, transitions without evidence,
 *    forbidden transitions;
 *  - append-only: earlier bytes of findings.jsonl are never rewritten.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/findings.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import {
  FINDING_TRANSITIONS,
  FINDINGS_FILE,
  checkEvidenceRef,
  loadFindings,
  parseEvidenceRef,
  recordFinding,
  updateFinding,
} from "../extensions/pi-autoresearch/findings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-11-02T03:00:00.000Z");
const LATER = new Date("2026-11-02T04:00:00.000Z");

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-findings-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 140 numbered lines; line 125 carries an anchor. */
function makeOutput() {
  const lines = [];
  for (let i = 1; i <= 140; i++) lines.push(`line ${i}`);
  lines[124] = "MISMATCH gold=заместитель pred=зампред";
  return lines.join("\n") + "\n";
}

function writeRunOutput(workDir, run = 45) {
  const rel = `.auto/runs/${run}/output.txt`;
  const abs = path.join(workDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, makeOutput(), "utf-8");
  return rel;
}

function readJsonl(workDir) {
  const raw = fs.readFileSync(path.join(workDir, ".auto", FINDINGS_FILE), "utf-8");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

function validFinding(evidence) {
  return {
    theme: "behavior",
    description: "Зампред штрафуется как ошибка, хотя совпадает с gold по смыслу",
    evidence_ref: evidence,
  };
}

/** Create one finding and return its id (asserting success). */
function seedFinding(workDir, evidence, extra = {}) {
  const res = recordFinding(workDir, { ...validFinding(evidence), ...extra }, FIXED_NOW);
  assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
  return res.value.id;
}

function errorsOf(res) {
  assert.equal(res.ok, false, "expected rejection");
  return res.errors.join("\n");
}

// ---------------------------------------------------------------------------
// record_finding
// ---------------------------------------------------------------------------

test("record_finding: корректная находка дописывается со статусом open и id", () => {
  const dir = makeWorkDir("ok");
  const evidence = writeRunOutput(dir) + ":120-134";

  const res = recordFinding(dir, { ...validFinding(evidence), run: 45, estimated_impact: "~14% ошибок" }, FIXED_NOW);

  assert.equal(res.ok, true);
  assert.equal(res.value.id, "f1");
  assert.equal(res.value.status, "open");
  assert.equal(res.value.theme, "behavior");
  assert.equal(res.value.evidence_ref, evidence);
  assert.equal(res.value.run, 45);
  assert.equal(res.value.created, FIXED_NOW.toISOString());

  const lines = readJsonl(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "finding");
  assert.equal(lines[0].id, "f1");
  assert.equal(lines[0].status, "open");
  assert.equal(lines[0].estimated_impact, "~14% ошибок");
});

test("record_finding: id растёт монотонно, состояние восстанавливается из файла", () => {
  const dir = makeWorkDir("ids");
  const evidence = writeRunOutput(dir) + ":10";
  assert.equal(seedFinding(dir, evidence), "f1");
  assert.equal(seedFinding(dir, evidence), "f2");

  const loaded = loadFindings(dir);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.findings.size, 2);
  assert.equal(loaded.value.nextId, "f3");
  assert.equal(loaded.value.findings.get("f2").status, "open");
});

test("record_finding: отказ без evidence_ref с конкретным примером", () => {
  const dir = makeWorkDir("noev");
  writeRunOutput(dir);

  const text = errorsOf(recordFinding(dir, { theme: "behavior", description: "многие FP — верные факты" }, FIXED_NOW));

  assert.match(text, /evidence_ref: отсутствует/);
  assert.match(text, /\.auto\/runs\/45\/output\.txt:120-134/);
  assert.match(text, /#MISMATCH gold=/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", FINDINGS_FILE)), false, "rejected record must not create the file");
});

test("record_finding: неизвестная тема отвергается с перечислением допустимых", () => {
  const dir = makeWorkDir("theme");
  const evidence = writeRunOutput(dir) + ":1";

  const text = errorsOf(recordFinding(dir, { ...validFinding(evidence), theme: "other" }, FIXED_NOW));

  assert.match(text, /theme: "other" не входит в допустимые темы/);
  assert.match(text, /measurement, behavior, capability, tradeoff/);
});

test("record_finding: якорь не найден — отказ с именем якоря", () => {
  const dir = makeWorkDir("anchor-miss");
  const rel = writeRunOutput(dir);

  const text = errorsOf(recordFinding(dir, validFinding(`${rel}#NO SUCH TEXT`), FIXED_NOW));

  assert.match(text, /якорь "NO SUCH TEXT" не найден/);
});

test("record_finding: якорь найден — находка принята", () => {
  const dir = makeWorkDir("anchor-hit");
  const rel = writeRunOutput(dir);

  const res = recordFinding(dir, validFinding(`${rel}#MISMATCH gold=заместитель`), FIXED_NOW);

  assert.equal(res.ok, true);
  assert.equal(res.value.id, "f1");
});

test("record_finding: строки за пределами файла — отказ", () => {
  const dir = makeWorkDir("range");
  const rel = writeRunOutput(dir); // 140 lines

  const text = errorsOf(recordFinding(dir, validFinding(`${rel}:138-141`), FIXED_NOW));

  assert.match(text, /строки 138-141 выходят за пределы файла \(в .*output\.txt 140 строк\)/);
});

test("record_finding: граничные строки 1 и последняя принимаются, 0 и start>end — нет", () => {
  const dir = makeWorkDir("bounds");
  const rel = writeRunOutput(dir);

  assert.equal(recordFinding(dir, validFinding(`${rel}:1`), FIXED_NOW).ok, true);
  assert.equal(recordFinding(dir, validFinding(`${rel}:140`), FIXED_NOW).ok, true);
  assert.match(errorsOf(recordFinding(dir, validFinding(`${rel}:0-3`), FIXED_NOW)), /1-based/);
  assert.match(errorsOf(recordFinding(dir, validFinding(`${rel}:9-3`), FIXED_NOW)), /1-based и start ≤ end/);
});

test("record_finding: путь вне workDir отвергается без чтения файла", () => {
  const dir = makeWorkDir("outside");
  const outsideFile = path.join(os.tmpdir(), `pi-ar-findings-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, "secret evidence\n", "utf-8");

  const relOutside = errorsOf(recordFinding(dir, validFinding("../" + path.basename(outsideFile) + ":1"), FIXED_NOW));
  assert.match(relOutside, /вне workDir/);
  const absOutside = errorsOf(recordFinding(dir, validFinding(outsideFile + "#secret"), FIXED_NOW));
  assert.match(absOutside, /вне workDir/);
});

test("record_finding: несуществующий файл отвергается", () => {
  const dir = makeWorkDir("missing");
  const text = errorsOf(recordFinding(dir, validFinding(".auto/runs/9/output.txt:1"), FIXED_NOW));
  assert.match(text, /файл не найден/);
});

test("parseEvidenceRef: формы путь:строки, путь:строка, путь#якорь и отказ на прочее", () => {
  assert.deepEqual(parseEvidenceRef(".auto/runs/45/output.txt:120-134").value, {
    kind: "lines", path: ".auto/runs/45/output.txt", start: 120, end: 134,
  });
  assert.deepEqual(parseEvidenceRef("D:/work/out.txt:7").value, {
    kind: "lines", path: "D:/work/out.txt", start: 7, end: 7,
  });
  assert.deepEqual(parseEvidenceRef("a.txt#x # y").value, { kind: "anchor", path: "a.txt", anchor: "x # y" });
  assert.equal(parseEvidenceRef("just a sentence").ok, false);
  assert.equal(parseEvidenceRef("a.txt#").ok, false);
});

test("checkEvidenceRef: строки и якорь проверяются против реального файла", () => {
  const dir = makeWorkDir("check");
  const rel = writeRunOutput(dir);
  assert.equal(checkEvidenceRef(dir, `${rel}:125`).ok, true);
  assert.equal(checkEvidenceRef(dir, `${rel}#line 140`).ok, true);
  assert.equal(checkEvidenceRef(dir, `${rel}#line 1400`).ok, false);
});

// ---------------------------------------------------------------------------
// update_finding: transitions
// ---------------------------------------------------------------------------

test("update_finding: open → verified с доказательством сохраняет ссылку в переходе", () => {
  const dir = makeWorkDir("verify");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);

  const res = updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=`, note: "перечитано" }, LATER);

  assert.equal(res.ok, true);
  assert.equal(res.value.from, "open");
  assert.equal(res.value.status, "verified");
  const loaded = loadFindings(dir);
  assert.equal(loaded.value.findings.get(id).status, "verified");
  assert.equal(loaded.value.findings.get(id).updated, LATER.toISOString());
  const last = readJsonl(dir).at(-1);
  assert.equal(last.type, "finding_transition");
  assert.equal(last.evidence_ref, `${rel}#MISMATCH gold=`);
  assert.equal(last.note, "перечитано");
});

test("update_finding: разрешённые переходы по карте принимаются", () => {
  const dir = makeWorkDir("map");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);
  const ev = `${rel}:125`;

  // open → deferred → open → revised → verified → revised → deferred → open
  const steps = [
    { status: "deferred" },
    { status: "open" },
    { status: "revised", evidence_ref: ev },
    { status: "verified", evidence_ref: ev },
    { status: "revised", evidence_ref: ev },
    { status: "deferred" },
    { status: "open" },
  ];
  let from = "open";
  for (const step of steps) {
    const res = updateFinding(dir, { id, ...step }, LATER);
    assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
    assert.equal(res.value.from, from);
    from = step.status;
  }
  assert.equal(loadFindings(dir).value.findings.get(id).status, "open");
});

test("update_finding: карта переходов совпадает с спецификацией", () => {
  assert.deepEqual([...FINDING_TRANSITIONS.open].sort(), ["deferred", "revised", "verified"]);
  assert.deepEqual([...FINDING_TRANSITIONS.revised].sort(), ["deferred", "verified"]);
  assert.deepEqual([...FINDING_TRANSITIONS.deferred], ["open"]);
  assert.deepEqual([...FINDING_TRANSITIONS.verified], ["revised"]);
});

// ---------------------------------------------------------------------------
// update_finding: rejections
// ---------------------------------------------------------------------------

test("update_finding: переход в verified без evidence_ref отвергается", () => {
  const dir = makeWorkDir("noproof-v");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);

  const text = errorsOf(updateFinding(dir, { id, status: "verified" }, LATER));

  assert.match(text, /переход в verified требует доказательство/);
  assert.match(text, /независимую проверку/);
  assert.equal(loadFindings(dir).value.findings.get(id).status, "open");
});

test("update_finding: переход в revised без evidence_ref отвергается", () => {
  const dir = makeWorkDir("noproof-r");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);

  const text = errorsOf(updateFinding(dir, { id, status: "revised" }, LATER));

  assert.match(text, /переход в revised требует доказательство/);
  assert.match(text, /контрпример/);
});

test("update_finding: evidence_ref с неверным якорем отвергает переход", () => {
  const dir = makeWorkDir("badanchor");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);

  const text = errorsOf(updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#НЕТ ТАКОГО` }, LATER));

  assert.match(text, /якорь "НЕТ ТАКОГО" не найден/);
});

test("update_finding: запрещённый переход verified → open отвергается со списком допустимых", () => {
  const dir = makeWorkDir("forbidden");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);
  assert.equal(updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}:125` }, LATER).ok, true);

  const text = errorsOf(updateFinding(dir, { id, status: "open" }, LATER));

  assert.match(text, /переход verified → open запрещён/);
  assert.match(text, /Допустимо из verified: revised/);
  assert.equal(loadFindings(dir).value.findings.get(id).status, "verified");
});

test("update_finding: прочие запрещённые переходы (open→open, deferred→verified, revised→open)", () => {
  const dir = makeWorkDir("forbidden2");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);

  assert.match(errorsOf(updateFinding(dir, { id, status: "open" }, LATER)), /open → open запрещён/);

  assert.equal(updateFinding(dir, { id, status: "deferred" }, LATER).ok, true);
  assert.match(errorsOf(updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}:125` }, LATER)), /deferred → verified запрещён/);

  assert.equal(updateFinding(dir, { id, status: "open" }, LATER).ok, true);
  assert.equal(updateFinding(dir, { id, status: "revised", evidence_ref: `${rel}:125` }, LATER).ok, true);
  assert.match(errorsOf(updateFinding(dir, { id, status: "open" }, LATER)), /revised → open запрещён/);
});

test("update_finding: неизвестный id и неизвестный статус отвергаются", () => {
  const dir = makeWorkDir("unknown");
  const rel = writeRunOutput(dir);
  seedFinding(dir, `${rel}:125`);

  assert.match(errorsOf(updateFinding(dir, { id: "f99", status: "deferred" }, LATER)), /находка f99 не найдена/);
  assert.match(errorsOf(updateFinding(dir, { id: "f1", status: "closed" }, LATER)), /"closed" не входит в статусы/);
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

test("append-only: предыдущие строки findings.jsonl не переписываются", () => {
  const dir = makeWorkDir("append");
  const rel = writeRunOutput(dir);
  const file = path.join(dir, ".auto", FINDINGS_FILE);

  const id = seedFinding(dir, `${rel}:125`);
  const afterCreate = fs.readFileSync(file, "utf-8");

  assert.equal(updateFinding(dir, { id, status: "verified", evidence_ref: `${rel}#MISMATCH gold=` }, LATER).ok, true);
  const afterVerify = fs.readFileSync(file, "utf-8");
  assert.ok(afterVerify.startsWith(afterCreate), "creation line must stay byte-identical");

  // Rejected calls must not touch the file at all.
  assert.equal(updateFinding(dir, { id, status: "open" }, LATER).ok, false);
  assert.equal(recordFinding(dir, { theme: "behavior", description: "без примера" }, LATER).ok, false);
  assert.equal(fs.readFileSync(file, "utf-8"), afterVerify);

  assert.equal(updateFinding(dir, { id, status: "revised", evidence_ref: `${rel}:125` }, LATER).ok, true);
  const afterRevise = fs.readFileSync(file, "utf-8");
  assert.ok(afterRevise.startsWith(afterVerify), "earlier transition lines must stay byte-identical");

  const lines = readJsonl(dir);
  assert.deepEqual(lines.map((l) => l.type), ["finding", "finding_transition", "finding_transition"]);
  assert.equal(lines[0].status, "open", "creation line keeps its original status");
  assert.equal(loadFindings(dir).value.findings.get(id).status, "revised");
});

test("loadFindings: переход, не совпадающий с текущим статусом, делает хранилище невалидным", () => {
  const dir = makeWorkDir("tampered");
  const rel = writeRunOutput(dir);
  const id = seedFinding(dir, `${rel}:125`);
  const file = path.join(dir, ".auto", FINDINGS_FILE);
  const bogus = { type: "finding_transition", id, from: "verified", status: "open", updated: LATER.toISOString() };
  fs.appendFileSync(file, JSON.stringify(bogus) + "\n", "utf-8");

  const loaded = loadFindings(dir);
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join("\n"), /переход .* начинается из verified, а текущий статус open/);

  const res = recordFinding(dir, validFinding(`${rel}:1`), LATER);
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /запись отклонена/);
});

test("loadFindings: битая строка и неизвестный type отвергаются явно", () => {
  const dir = makeWorkDir("garbage");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", FINDINGS_FILE), "not json\n{\"type\":\"mystery\",\"id\":\"f1\"}\n", "utf-8");

  const loaded = loadFindings(dir);
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors[0], /строка 1: не JSON/);
  assert.match(loaded.errors[1], /строка 2/);
});

test("loadFindings: отсутствующий файл — пустое валидное хранилище", () => {
  const dir = makeWorkDir("empty");
  const loaded = loadFindings(dir);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.findings.size, 0);
  assert.equal(loaded.value.nextId, "f1");
});

// ---------------------------------------------------------------------------
// index.ts wiring (tool registration only; behaviour is tested above)
// ---------------------------------------------------------------------------

test("index.ts: record_finding и update_finding зарегистрированы и работают через store", async () => {
  const dir = makeWorkDir("wiring");
  const rel = writeRunOutput(dir);
  const { pi, tool, command } = createFakePi({ dir, sessionId: "findings-wiring", realGit: false });
  const ctx = makeCtx(dir, "findings-wiring", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);

  // Mode off: the gate refuses before touching the store.
  const gated = await tool("record_finding").execute("id", validFinding(`${rel}:125`), null, null, ctx);
  assert.match(gated.content[0].text, /Autoresearch mode is OFF/);
  assert.equal(fs.existsSync(path.join(dir, ".auto", FINDINGS_FILE)), false);

  await command("autoresearch").handler("on", ctx);

  const rejected = await tool("record_finding").execute("id", { theme: "behavior", description: "обобщение" }, null, null, ctx);
  assert.match(rejected.content[0].text, /record_finding rejected/);
  assert.match(rejected.content[0].text, /evidence_ref: отсутствует/);

  const created = await tool("record_finding").execute("id", validFinding(`${rel}:125`), null, null, ctx);
  assert.match(created.content[0].text, /Finding f1 recorded/);
  assert.equal(created.details.id, "f1");

  const verifyNoProof = await tool("update_finding").execute("id", { id: "f1", status: "verified" }, null, null, ctx);
  assert.match(verifyNoProof.content[0].text, /update_finding rejected/);

  const verified = await tool("update_finding").execute(
    "id",
    { id: "f1", status: "verified", evidence_ref: `${rel}#MISMATCH gold=` },
    null,
    null,
    ctx,
  );
  assert.match(verified.content[0].text, /Finding f1: open → verified/);
  assert.equal(loadFindings(dir).value.findings.get("f1").status, "verified");
});
