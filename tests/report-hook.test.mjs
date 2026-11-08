/**
 * Campaign report hooks (openspec add-result-reflection, task 3.2; spec
 * campaign-report/spec.md «Идемпотентность и ручной вызов»).
 *
 * Covers the two call paths implemented in extensions/pi-autoresearch/index.ts:
 *  - finalize_research строит отчёт кампании и пишет .auto/report.md со всеми
 *    семью секциями (spec «Генерация отчёта на finalize»);
 *  - ручной вызов `/autoresearch report` пишет промежуточный отчёт и обновляет
 *    его по текущему состоянию леджера (spec «отчёт до finalize»);
 *  - идемпотентность перезаписи: повторный вызов перезаписывает файл свежими
 *    данными без накопления дублей (в т.ч. поверх устаревшего/мусорного файла);
 *  - пустая кампания: отчёт всё равно строится, пустые секции отмечены явно
 *    («нет данных»), секция находок — «линза не применялась».
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/report-hook.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SEVEN_SECTIONS = [
  "## 1. Прогоны и метрики",
  "## 2. Находки по темам",
  "## 3. Measurement-трек",
  "## 4. Шум и уверенность",
  "## 5. Идеи и dead-ends",
  "## 6. Ограничения и owner-input gates",
  "## 7. Сводка",
];

function makeTempDir(label) {
  const dir = path.join(
    os.tmpdir(),
    `pi-ar-report-hook-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

async function loadExtension(dir) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: "report-hook", realGit: true });
  const ctx = makeCtx(dir, "report-hook", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { pi, tool, command, ctx };
}

async function startCampaign(dir) {
  initGitRepo(dir);
  const session = await loadExtension(dir);
  await session.command("autoresearch").handler("on", session.ctx);
  approveOptimizeBrief(dir, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" });
  await session.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "accuracy", metric_unit: "", direction: "higher",
  }, null, null, session.ctx);
  return session;
}

const reportPath = (dir) => path.join(dir, ".auto", "report.md");

function appendLedgerLines(dir, entries) {
  const logPath = path.join(dir, ".auto", "log.jsonl");
  fs.appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function readReport(dir) {
  return fs.readFileSync(reportPath(dir), "utf-8");
}

// ---------------------------------------------------------------------------
// finalize_research → .auto/report.md
// ---------------------------------------------------------------------------

test("finalize_research builds the campaign report with all seven sections", async () => {
  const dir = makeTempDir("finalize");
  const { tool, ctx } = await startCampaign(dir);
  appendLedgerLines(dir, [
    { run: 1, commit: "a1b2c3d", metric: 0.5, status: "keep", description: "baseline pipeline", timestamp: 1700000001000 },
    { run: 2, commit: "b2c3d4e", metric: 0.58, status: "keep", description: "векторизация scorer", timestamp: 1700000002000 },
  ]);

  const res = await tool("finalize_research").execute("id", {
    reason: "goal metric achieved", evidence: "eval above target", confidence: 0.9,
  }, null, null, ctx);

  assert.ok(fs.existsSync(reportPath(dir)), "finalize_research must write .auto/report.md");
  const report = readReport(dir);
  for (const section of SEVEN_SECTIONS) {
    assert.ok(report.includes(section), `report must contain section ${section}`);
  }
  assert.ok(report.includes("векторизация scorer"), "report must be built from the ledger runs");

  assert.ok(
    res.content[0].text.includes(reportPath(dir)),
    `tool response must point at the report, got: ${res.content[0].text}`,
  );
  assert.strictEqual(res.details.reportPath, reportPath(dir));

  // The finalize entry itself was recorded in the ledger (existing behavior intact).
  const ledger = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
  assert.ok(ledger.includes('"type":"finalize"'), "finalize entry must still be appended to log.jsonl");

  // Idempotent overwrite on the finalize path: a repeated finalize rewrites the
  // same data to the same bytes — no duplicates accumulate (finalize entries
  // themselves are not report input).
  const res2 = await tool("finalize_research").execute("id", {
    reason: "goal metric achieved", evidence: "eval above target", confidence: 0.9,
  }, null, null, ctx);
  assert.strictEqual(res2.details.reportPath, reportPath(dir));
  assert.strictEqual(readReport(dir), report, "second finalize must produce byte-identical report");
});

// ---------------------------------------------------------------------------
// /autoresearch report — manual intermediate report
// ---------------------------------------------------------------------------

test("manual /autoresearch report writes the file and updates it with fresh data", async () => {
  const dir = makeTempDir("manual");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [
    JSON.stringify({ type: "config", name: "bench", metricName: "accuracy", metricUnit: "", bestDirection: "higher" }),
    JSON.stringify({ run: 1, commit: "a1b2c3d", metric: 0.5, status: "keep", description: "baseline pipeline", timestamp: 1700000001000 }),
  ].join("\n") + "\n", "utf-8");

  const { command, ctx, pi } = await loadExtension(dir);
  await command("autoresearch").handler("report", ctx);

  assert.ok(fs.existsSync(reportPath(dir)), "the command must write .auto/report.md before finalize");
  const first = readReport(dir);
  for (const section of SEVEN_SECTIONS) {
    assert.ok(first.includes(section), `report must contain section ${section}`);
  }
  assert.ok(first.includes("baseline pipeline"), "manual report must be built from the ledger");
  assert.ok(
    pi.notifications.some((n) => n.type === "info" && n.text.includes(reportPath(dir))),
    `owner must be told where the report landed, got: ${JSON.stringify(pi.notifications)}`,
  );

  // Campaign moved on: a new run is logged → the manual call rebuilds the report.
  appendLedgerLines(dir, [
    { run: 2, commit: "b2c3d4e", metric: 0.61, status: "keep", description: "gold v16 after measurer fix", timestamp: 1700000005000 },
  ]);
  await command("autoresearch").handler("report", ctx);

  const updated = readReport(dir);
  assert.ok(updated.includes("baseline pipeline"), "updated report keeps earlier runs");
  assert.ok(updated.includes("gold v16 after measurer fix"), "updated report includes the new run");
  assert.notStrictEqual(updated, first, "the report must be refreshed, not left stale");
});

test("repeated report calls are idempotent: rewrite replaces stale content without duplicates", async () => {
  const dir = makeTempDir("idempotent");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [
    JSON.stringify({ type: "config", name: "bench", metricName: "accuracy", metricUnit: "", bestDirection: "higher" }),
    JSON.stringify({ run: 1, commit: "a1b2c3d", metric: 0.5, status: "keep", description: "baseline pipeline", timestamp: 1700000001000 }),
  ].join("\n") + "\n", "utf-8");

  // Stale garbage from an earlier generation must be fully replaced.
  fs.writeFileSync(reportPath(dir), [
    "# Отчёт кампании: Autoresearch",
    "",
    "## 1. Прогоны и метрики",
    "STALE",
    "",
    "## 1. Прогоны и метрики",
    "STALE AGAIN",
    "",
  ].join("\n"), "utf-8");

  const { command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("report", ctx);

  const first = readReport(dir);
  assert.ok(!first.includes("STALE"), "old file content must be replaced, not appended to");
  assert.strictEqual(first.match(/^## 1\. Прогоны и метрики$/gm)?.length, 1, "no duplicate sections");
  assert.ok(first.includes("baseline pipeline"), "fresh report reflects current data");

  // Same data again → byte-identical overwrite (no duplicates accumulate).
  await command("autoresearch").handler("report", ctx);
  const second = readReport(dir);
  assert.strictEqual(second, first, "repeated generation on unchanged data must be byte-identical");
  assert.strictEqual(second.match(/baseline pipeline/g)?.length, first.match(/baseline pipeline/g)?.length);

  // Atomic write discipline: no temp files left behind next to the report.
  assert.ok(
    !fs.readdirSync(path.join(dir, ".auto")).some((f) => f.includes(".tmp")),
    "no temp files left behind",
  );
});

// ---------------------------------------------------------------------------
// Empty campaign
// ---------------------------------------------------------------------------

test("empty campaign: report is still built with all seven sections explicitly marked empty", async () => {
  const dir = makeTempDir("empty");
  const { command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("report", ctx);

  assert.ok(fs.existsSync(reportPath(dir)), "report must exist even for an empty campaign");
  const report = readReport(dir);
  for (const section of SEVEN_SECTIONS) {
    assert.ok(report.includes(section), `empty-campaign report must contain section ${section}`);
  }
  assert.ok(report.includes("нет данных"), "empty sections must be marked explicitly");
  assert.ok(report.includes("линза не применялась"), "findings section must mark the unused lens");
});

// ---------------------------------------------------------------------------
// Degradation: report path unwritable (task 3.2 — сбой отчёта не ломает вызов)
// ---------------------------------------------------------------------------

test("finalize_research degrades: .auto/report.md as a directory → finalized:true + ⚠️ note, no crash", async () => {
  const dir = makeTempDir("finalize-degrade");
  const { tool, ctx } = await startCampaign(dir);
  appendLedgerLines(dir, [
    { run: 1, commit: "a1b2c3d", metric: 0.5, status: "keep", description: "baseline pipeline", timestamp: 1700000001000 },
  ]);
  // Sabotage: the report path is occupied by a directory — the atomic rename
  // must fail, and the failure must degrade instead of crashing finalize.
  fs.mkdirSync(reportPath(dir));

  const res = await tool("finalize_research").execute("id", {
    reason: "goal metric achieved", evidence: "eval above target", confidence: 0.9,
  }, null, null, ctx);

  // The finalize signal itself succeeds…
  assert.strictEqual(res.details.finalized, true, "finalize must not fail because of the report");
  const ledger = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
  assert.ok(ledger.includes('"type":"finalize"'), "finalize entry must still be appended to log.jsonl");
  // …while the report failure degrades to a ⚠️ note (no reportPath).
  assert.ok(
    res.content[0].text.includes("⚠️"),
    `response must carry the degradation note, got: ${res.content[0].text}`,
  );
  assert.strictEqual(res.details.reportPath, null, "no report path when writing failed");
});

test("/autoresearch report degrades: .auto/report.md as a directory → error notify, no crash", async () => {
  const dir = makeTempDir("manual-degrade");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [
    JSON.stringify({ type: "config", name: "bench", metricName: "accuracy", metricUnit: "", bestDirection: "higher" }),
  ].join("\n") + "\n", "utf-8");
  fs.mkdirSync(reportPath(dir));

  const { command, ctx, pi } = await loadExtension(dir);
  // Must resolve (no throw) — the failure degrades into a user-facing notify.
  await command("autoresearch").handler("report", ctx);
  assert.ok(
    pi.notifications.some((n) => n.type === "error" && n.text.includes("Failed to write campaign report")),
    `owner must be notified of the report failure, got: ${JSON.stringify(pi.notifications)}`,
  );
});
