/**
 * Необязательная метка activity_type у log_experiment (openspec research-map,
 * design D-RM-03 / I-11, requirements FR-01.5.1–FR-01.5.3, tasks.md 1.1).
 *
 * Covers the wiring in extensions/pi-autoresearch/index.ts:
 *  - допустимые значения measurement | intermediate | verification | attribution
 *    попадают в строку .auto/log.jsonl ключом activity_type на каждом статусе
 *    обычного пути записи;
 *  - значение unknown и любое иное значение отвергаются до побочных эффектов:
 *    леджер байт-в-байт прежний, ожидающий номер прогона не потребляется;
 *  - отсутствующий параметр не добавляет ключа: строка леджера не содержит
 *    activity_type, а разница с вызовом с меткой — ровно этот ключ;
 *  - метка не меняет status, решение keep/discard, git-вызовы, metric, best,
 *    streak (реконструкция) и эпоху (I-11, T37/T38 в части log_experiment).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-activity-label.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";

const ALLOWED = ["measurement", "intermediate", "verification", "attribution"];
const STATUSES = ["keep", "discard", "crash", "checks_failed", "budget_exceeded"];
const BASE_KEYS = ["run", "commit", "metric", "metrics", "status", "description", "timestamp", "segment", "epoch", "confidence"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-activity-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerTextOf(dir) {
  const file = path.join(dir, ".auto", "log.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function readLedger(dir) {
  return ledgerTextOf(dir).split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

/** Experiment rows only (run_started / run_result markers carry no `run` key). */
function experimentRows(dir) {
  return readLedger(dir).filter((e) => e.run !== undefined);
}

/** Turn autoresearch on and init a segment on a fresh temp dir (canned git: no real repo). */
async function setup(label) {
  const dir = makeWorkDir(label);
  const h = await createHarness({ dir, sessionId: `activity-${label}`, realGit: false });
  await h.command("autoresearch").handler("on", h.ctx);
  approveOptimizeBrief(dir, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" });
  await h.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, h.ctx);
  return { ...h, dir };
}

function logExp(h, params) {
  return h.tool("log_experiment").execute("id", params, null, null, h.ctx);
}

function runExp(h) {
  return h.tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC ms=123')"`, timeout_seconds: 10,
  }, null, null, h.ctx);
}

// ---------------------------------------------------------------------------
// Allowed values are persisted on every ordinary status path
// ---------------------------------------------------------------------------

for (const status of STATUSES) {
  test(`log_experiment status=${status}: supplied activity_type is persisted as an ordinary ledger key`, async () => {
    const h = await setup(`persist-${status}`);
    const res = await logExp(h, {
      metric: 123, status, description: `label on ${status}`, activity_type: "verification",
    });
    const text = res.content[0].text;
    assert.doesNotMatch(text, /^❌/, `allowed value must not be rejected: ${text.slice(0, 160)}`);

    const rows = experimentRows(h.dir);
    assert.equal(rows.length, 1, "exactly one ledger row");
    assert.equal(rows[0].status, status, "status unchanged by the label");
    assert.equal(rows[0].activity_type, "verification", "label persisted verbatim");
  });
}

test("log_experiment: each allowed value is written verbatim (discard path)", async () => {
  const h = await setup("each-allowed");
  for (const value of ALLOWED) {
    await logExp(h, { metric: 200, status: "discard", description: `value ${value}`, activity_type: value });
  }
  assert.deepEqual(experimentRows(h.dir).map((r) => r.activity_type), ALLOWED);
});

// ---------------------------------------------------------------------------
// Invalid values are rejected before any side effect
// ---------------------------------------------------------------------------

for (const [i, bad] of ["unknown", "foo", "", null].entries()) {
  test(`log_experiment rejects activity_type ${JSON.stringify(bad)} without touching the ledger or the pending run number`, async () => {
    const h = await setup(`invalid-${i}`);
    await runExp(h);
    const pendingRun = readLedger(h.dir).find((e) => e.type === "run_started").run_dir;
    const before = ledgerTextOf(h.dir);

    const res = await logExp(h, {
      metric: 123, status: "keep", description: "bad label", activity_type: bad,
    });
    assert.match(res.content[0].text, /^❌/, `expected rejection, got: ${res.content[0].text.slice(0, 160)}`);
    assert.match(res.content[0].text, /activity_type/);
    assert.equal(ledgerTextOf(h.dir), before, "rejected call must not write the ledger");
    assert.equal(h.pi.execCalls.filter((c) => c.cmd === "git" && c.args[0] === "commit").length, 0, "rejected keep must not commit");

    // The run number minted by run_experiment is still pending: a valid retry binds to it.
    await logExp(h, { metric: 123, status: "discard", description: "valid retry", activity_type: "measurement" });
    const rows = experimentRows(h.dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run, pendingRun, "pending run number was not consumed by the rejected call");
    assert.equal(rows[0].activity_type, "measurement");
  });
}

// ---------------------------------------------------------------------------
// Absent parameter: no key, and the only difference from a labelled call is the key
// ---------------------------------------------------------------------------

test("log_experiment without activity_type writes no activity_type key", async () => {
  const h = await setup("absent");
  await logExp(h, { metric: 150, status: "discard", description: "no label" });
  const rows = experimentRows(h.dir);
  assert.equal(rows.length, 1);
  assert.equal("activity_type" in rows[0], false, "absent parameter must not add the key");
  for (const key of BASE_KEYS) {
    assert.ok(key in rows[0], `base ledger key ${key} still present`);
  }
});

test("absent vs labelled: the experiment row differs by exactly the activity_type key", async () => {
  const plain = await setup("diff-plain");
  const labelled = await setup("diff-labelled");
  const params = { metric: 150, status: "discard", description: "same call" };
  await logExp(plain, params);
  await logExp(labelled, { ...params, activity_type: "intermediate" });

  const a = experimentRows(plain.dir)[0];
  const b = experimentRows(labelled.dir)[0];
  const { timestamp: _ta, ...restA } = a;
  const { timestamp: _tb, activity_type: label, ...restB } = b;
  assert.equal(label, "intermediate");
  assert.deepEqual(restB, restA, "all other keys identical");
  assert.deepEqual(Object.keys(b).filter((k) => !(k in a)), ["activity_type"]);
});

// ---------------------------------------------------------------------------
// The label is inert: same response, same git calls, same reconstruction
// ---------------------------------------------------------------------------

test("activity_type does not change status, keep/discard, git calls, metric, best or streak", async () => {
  const plain = await setup("inert-plain");
  const labelled = await setup("inert-labelled");
  await runExp(plain);
  await runExp(labelled);

  const sequence = [
    { metric: 123, status: "keep", description: "first keep" },
    { metric: 999, status: "discard", description: "worse" },
    { metric: 110, status: "keep", description: "better keep" },
    { metric: 0, status: "crash", description: "crashed" },
  ];

  const texts = { plain: [], labelled: [] };
  for (const [i, params] of sequence.entries()) {
    const p = await logExp(plain, params);
    const l = await logExp(labelled, { ...params, activity_type: i % 2 ? "verification" : "measurement" });
    texts.plain.push(p.content[0].text);
    texts.labelled.push(l.content[0].text);
    assert.equal(p.details.experiment.status, l.details.experiment.status, `status equal at step ${i}`);
    assert.equal(p.details.state.bestMetric, l.details.state.bestMetric, `best equal at step ${i}`);
  }

  assert.deepEqual(texts.labelled, texts.plain, "log_experiment response text identical with and without the label");

  const gitOf = (h) => h.pi.execCalls.filter((c) => c.cmd === "git").map((c) => [c.cmd, ...c.args]);
  assert.ok(gitOf(plain).some((c) => c[1] === "add"), "keep path reached git add in the baseline");
  assert.deepEqual(gitOf(labelled), gitOf(plain), "git invocations identical");

  const statePlain = reconstructJsonlState(ledgerTextOf(plain.dir));
  const stateLabelled = reconstructJsonlState(ledgerTextOf(labelled.dir));
  const strip = (r) => ({ ...r, timestamp: 0 });
  assert.deepEqual(stateLabelled.results.map(strip), statePlain.results.map(strip), "reconstructed runs identical");
  assert.equal(stateLabelled.currentEpoch, statePlain.currentEpoch, "epoch identical");
  assert.equal(stateLabelled.currentSegment, statePlain.currentSegment, "segment identical");

  const withoutLabel = experimentRows(labelled.dir).map(({ timestamp, activity_type, ...r }) => r);
  const plainRows = experimentRows(plain.dir).map(({ timestamp, ...r }) => r);
  assert.deepEqual(withoutLabel, plainRows, "experiment rows identical except the label");
});
