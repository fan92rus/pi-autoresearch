/**
 * Run-links writer wiring in extensions/pi-autoresearch/index.ts
 * (research-map design §5.1/§5.2/§9.3, tasks 2.2 writer side + 1.3 legacy compat).
 *
 * Covers the sidecar contract around the UNCHANGED run_experiment/log_experiment
 * byte formats:
 *  - happy path: run_experiment -> log_experiment writes one valid run-links.jsonl
 *    record (3 line hashes + analysis prefix pair), runLinkOf = proven,
 *    run_epoch proven;
 *  - legacy ledger without sidecar: log_experiment behaves as before, adds only
 *    the allowed run-link warning; the fresh row is ambiguous, old rows absent;
 *  - log_experiment without a prior run_experiment -> no_pending warning, no sidecar;
 *  - marker and ledger bytes are byte-identical to the pre-wiring format;
 *  - marker-write failure injection -> reason incomplete -> no sidecar + warning;
 *  - restart eviction: a new run_experiment evicts the unconsumed pending identity.
 *
 * NOT covered here (own suites): run-links.ts core (tests/run-links.test.mjs),
 * activity_type label behavior (tests/research-activity-label.test.mjs — asserted
 * green by the gate run, not duplicated here).
 *
 * Run: timeout 300 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/run-links-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import { sha256Line, runLinkOf } from "../extensions/pi-autoresearch/run-links.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-runlinks-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function setup(label) {
  const dir = makeWorkDir(label);
  const h = await createHarness({ dir, sessionId: `runlinks-${label}`, realGit: false, optimizeFixture: true });
  await h.command("autoresearch").handler("on", h.ctx);
  await h.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, h.ctx);
  return { ...h, dir };
}

function runExp(h) {
  return h.tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC ms=123')"`, timeout_seconds: 10,
  }, null, null, h.ctx);
}

function logExp(h, params) {
  return h.tool("log_experiment").execute("id", params, null, null, h.ctx);
}

function autoDirOf(dir) {
  return path.join(dir, ".auto");
}

function sidecarLines(dir) {
  const file = path.join(autoDirOf(dir), "run-links.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function ledgerLines(dir) {
  return fs.readFileSync(path.join(autoDirOf(dir), "log.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
}

function sha256FileBytes(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Run the start/result marker lines of run number N from the ledger text. */
function markerLines(dir, run) {
  return ledgerLines(dir).filter((l) => l.includes(`"run_dir":${run}`));
}

// ---------------------------------------------------------------------------
// 1. Happy path: run_experiment -> log_experiment -> sidecar record, proven
// ---------------------------------------------------------------------------

test("happy path: run + log writes a valid sidecar record and runLinkOf returns proven with a proven epoch", async () => {
  const h = await setup("happy");
  await runExp(h);
  const res = await logExp(h, { metric: 123, status: "keep", description: "first" });

  const lines = sidecarLines(h.dir);
  assert.equal(lines.length, 1, "exactly one sidecar record");
  const record = JSON.parse(lines[0]);

  // §5.2 shape: exactly the eight fields, in order.
  assert.deepEqual(Object.keys(record), [
    "v", "execution_id", "run_dir", "started_sha256", "result_sha256", "log_sha256",
    "analysis_prefix_bytes", "analysis_prefix_sha256",
  ]);
  assert.equal(record.v, 1);
  assert.match(record.execution_id, /^[0-9a-f]{32}$/);
  assert.equal(record.run_dir, 1);
  assert.match(record.started_sha256, /^[0-9a-f]{64}$/);
  assert.match(record.result_sha256, /^[0-9a-f]{64}$/);
  assert.match(record.log_sha256, /^[0-9a-f]{64}$/);

  // Hashes match the exact ledger lines actually written (same buffers).
  const [started, result] = markerLines(h.dir, 1);
  const ordinary = ledgerLines(h.dir).find((l) => l.includes(`"run":1,`));
  assert.equal(record.started_sha256, sha256Line(started));
  assert.equal(record.result_sha256, sha256Line(result));
  assert.equal(record.log_sha256, sha256Line(ordinary));

  // analysis.jsonl was never written: the snapshot is the 0-byte empty prefix.
  const emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  assert.equal(record.analysis_prefix_bytes, 0);
  assert.equal(record.analysis_prefix_sha256, emptySha);

  // Reader side: proven, binding verified, epoch proven (no scale rows after start).
  const verdict = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.binding, "verified");
  assert.equal(verdict.executionId, record.execution_id);
  assert.equal(verdict.runEpochBasis, "proven");
  assert.equal(verdict.runEpoch, 1);

  // The response carries no failure warning on success.
  assert.doesNotMatch(res.content[0].text, /Run link not recorded/);
});

// ---------------------------------------------------------------------------
// 2. Legacy campaign: pre-existing ledger without sidecar
// ---------------------------------------------------------------------------

test("legacy ledger without sidecar: new instrumented run links proven; old runs stay absent", async () => {
  const h = await setup("legacy");
  // Pre-existing campaign history: one settled run, never instrumented.
  const configLine = JSON.stringify({ type: "config", name: "t", metricName: "ms", metricUnit: "", bestDirection: "lower" });
  const legacyRow = JSON.stringify({ run: 7, commit: "aaa1111", metric: 100, metrics: { ms: 100 }, status: "keep", description: "old", timestamp: 1, segment: 0, epoch: 1, confidence: null });
  fs.writeFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), configLine + "\n" + legacyRow + "\n");

  await runExp(h);
  const res = await logExp(h, { metric: 90, status: "keep", description: "new run" });

  // New writer behavior: the instrumented run creates the sidecar (compat spec:
  // the sidecar MAY be created; the ledger bytes themselves are unchanged).
  assert.equal(sidecarLines(h.dir).length, 1, "instrumented run writes its sidecar record");
  assert.match(res.content[0].text, /Logged #8: keep/);
  assert.doesNotMatch(res.content[0].text, /Run link not recorded/);

  const fresh = runLinkOf(autoDirOf(h.dir), 8);
  assert.equal(fresh.link, "proven", "new runs on a legacy campaign still prove their link");

  // Old sidecar-less runs with an ordinary ledger row are ambiguous (fail-closed);
  // absent is only for numbers without any ordinary row.
  const old = runLinkOf(autoDirOf(h.dir), 7);
  assert.equal(old.link, "ambiguous");
  const unknown = runLinkOf(autoDirOf(h.dir), 9);
  assert.equal(unknown.link, "absent");
});

// ---------------------------------------------------------------------------
// 3. No pending: log_experiment without a prior run_experiment
// ---------------------------------------------------------------------------

test("log_experiment without prior run_experiment: no sidecar, no_pending warning, row binds the fallback number", async () => {
  const h = await setup("nopending");
  const res = await logExp(h, { metric: 80, status: "discard", description: "cold log" });

  assert.match(res.content[0].text, /Run link not recorded: no pending run identity/);
  assert.equal(sidecarLines(h.dir).length, 0, "no sidecar record without a pending identity");
  assert.ok(ledgerLines(h.dir).some((l) => l.includes('"run":1,')), "fallback-numbered row written");
});

// ---------------------------------------------------------------------------
// 4. Byte-compat: markers and ledger rows unchanged vs the pre-wiring format
// ---------------------------------------------------------------------------

test("marker and ledger bytes unchanged: run_started/run_result keys and row key order identical", async () => {
  const h = await setup("bytes");
  await runExp(h);
  await logExp(h, { metric: 123, status: "keep", description: "byte check" });

  const started = JSON.parse(ledgerLines(h.dir).find((l) => l.includes('"run_started"')));
  const result = JSON.parse(ledgerLines(h.dir).find((l) => l.includes('"run_result"')));
  const row = JSON.parse(ledgerLines(h.dir).find((l) => l.includes('"run":1,')));

  // Marker shape: exactly the pre-wiring keys, in order (§5.1/13: bytes unchanged).
  assert.deepEqual(Object.keys(started), ["type", "run_dir", "node_id", "command", "started_at"]);
  assert.deepEqual(Object.keys(result), ["type", "run_dir", "started_at", "node_id", "exit_code", "killed", "duration_seconds"]);
  assert.equal(started.started_at, result.started_at, "markers share started_at");

  // Ordinary row: base keys in the pre-wiring order, no run-links keys.
  assert.deepEqual(Object.keys(row), ["run", "commit", "metric", "metrics", "status", "description", "timestamp", "segment", "epoch", "confidence"]);
});

// ---------------------------------------------------------------------------
// 6. Failure injection: marker write fails -> incomplete -> no sidecar
// ---------------------------------------------------------------------------

test("marker write failure: run completes, identity incomplete, no sidecar, warning present", async (t) => {
  const dir = makeWorkDir("injection");
  const h = await createHarness({ dir, sessionId: "runlinks-injection", realGit: false, optimizeFixture: true });
  await h.command("autoresearch").handler("on", h.ctx);
  await h.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, h.ctx);

  // Failure injection with healthy reads: the ledger file is made read-only so
  // every marker append fails with EPERM while readJsonlLines keeps working.
  // Both marker writes then fail (sticky incomplete, §5.2) but the run itself
  // completes — the best-effort contract.
  const ledgerPath = path.join(autoDirOf(dir), "log.jsonl");
  const seed = fs.readFileSync(ledgerPath);
  fs.chmodSync(ledgerPath, 0o444);
  t.after(() => { try { fs.chmodSync(ledgerPath, 0o666); } catch { /* already gone */ } });

  const runRes = await runExp(h);
  assert.ok(runRes.content[0].text.length > 0, "run_experiment completed despite the marker failure");
  const markersDuringRun = ledgerLines(dir).filter((l) => l.includes("run_")).length;
  assert.equal(markersDuringRun, 0, "no marker could be appended");

  // Reads stay healthy: log_experiment consumes the incomplete identity.
  const logRes = await logExp(h, { metric: 123, status: "crash", description: "marker failed" });
  assert.match(logRes.content[0].text, /Run link not recorded:/);
  assert.doesNotMatch(logRes.content[0].text, /no pending run identity/, "the pending identity exists but is incomplete");
  assert.equal(sidecarLines(dir).length, 0, "incomplete identity never produces a sidecar record");

  // The ledger append itself also failed (read-only) — restore and verify the
  // consume path STILL refuses the link on the retry (sticky failure).
  fs.chmodSync(ledgerPath, 0o666);
  const retry = await logExp(h, { metric: 123, status: "crash", description: "marker failed retry" });
  assert.match(retry.content[0].text, /no pending run identity/, "the slot was cleared by the first consume (§5.2)");
  assert.equal(sidecarLines(dir).length, 0, "still no sidecar record");
});

// ---------------------------------------------------------------------------
// 7. Restart eviction: a new run_experiment evicts the unconsumed pending
// ---------------------------------------------------------------------------

test("restart eviction: new run_experiment evicts unconsumed pending; late completion cannot resurrect it", async () => {
  const h = await setup("eviction");
  // Run A completes but is never logged; run B then evicts A's pending identity.
  await runExp(h);
  await runExp(h);

  const markers = ledgerLines(h.dir);
  assert.equal(markers.filter((l) => l.includes('"run_started"')).length, 2, "both runs wrote markers");
  assert.equal(sidecarLines(h.dir).length, 0, "nothing logged yet, no sidecar");

  // Logging after B binds to B's number (2) — but B's identity was begun while
  // A was still pending, so B is poisoned (conservative intersection rule §5.2).
  const res = await logExp(h, { metric: 123, status: "keep", description: "after overlap" });
  const runNumber = JSON.parse(ledgerLines(h.dir).find((l) => l.includes('"run":')).match(/"run":(\d+)/)[1]);
  assert.equal(runNumber, 2, "log binds the minted number of the last run");

  const verdict = runLinkOf(autoDirOf(h.dir), runNumber);
  assert.equal(verdict.link, "ambiguous", "poisoned identity never proves a link");
  assert.equal(sidecarLines(h.dir).length, 0, "poisoned consumption writes no sidecar record");
  assert.match(res.content[0].text, /overlapped|poisoned|Run link not recorded/);

  // A restart resets memory; the sidecar stays empty and the ledger unchanged.
  await h.command("autoresearch").handler("off", h.ctx);
  await h.command("autoresearch").handler("on", h.ctx);
  await logExp(h, { metric: 120, status: "discard", description: "after restart" });
  assert.equal(sidecarLines(h.dir).length, 0, "no sidecar records across restarts");
});

// ---------------------------------------------------------------------------
// 8. Busy analysis.lock: bare marker fallback, snapshot unconfirmed (null pair)
// ---------------------------------------------------------------------------

test("busy analysis.lock: marker still appended (bare path), null prefix pair, the link still proves proven", async (t) => {
  const h = await setup("busy-lock");
  // §5.2: when the shared analysis.lock cannot be acquired, the run takes the
  // old path WITHOUT a confirmed prefix — the null pair — but the run_started
  // marker is still written through the bare best-effort append (lock held by
  // a stale owner record: acquireLock sees EEXIST, exhausts its retries
  // (~2 s) and reports lock_busy).
  const lockPath = path.join(autoDirOf(h.dir), "analysis.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ token: "ff".repeat(16), pid: 1, host: "other", acquired_at: "2026-01-01T00:00:00.000Z" }));
  t.after(() => { try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ } });

  await runExp(h);
  await logExp(h, { metric: 123, status: "keep", description: "busy lock" });

  // The marker went out despite the busy lock (bare fallback path).
  const started = ledgerLines(h.dir).filter((l) => l.includes('"run_started"'));
  assert.equal(started.length, 1, "run_started marker appended even when analysis.lock stays busy");

  const lines = sidecarLines(h.dir);
  assert.equal(lines.length, 1, "the link itself is still recorded");
  const record = JSON.parse(lines[0]);
  // §5.2 null pairing: both prefix fields null together (unconfirmed snapshot).
  assert.equal(record.analysis_prefix_bytes, null);
  assert.equal(record.analysis_prefix_sha256, null);

  const verdict = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(verdict.link, "proven", "a missing snapshot never blocks the link itself");
  assert.equal(verdict.analysisPrefixBytes, null);
  assert.equal(verdict.analysisPrefixSha256, null);
});

// ---------------------------------------------------------------------------
// 9. Confirmed analysis prefix: snapshot under analysis.lock pairs the real bytes
// ---------------------------------------------------------------------------

test("analysis snapshot pairing: pre-existing analysis journal is snapshotted under the shared lock", async () => {
  const h = await setup("snapshot");
  const analysisLine = JSON.stringify({ v: 1, record: "analysis", kind: "comparison", id: "an2", recorded_at: "2026-01-01T00:00:00.000Z" }) + "\n";
  fs.writeFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), analysisLine);

  await runExp(h);
  await logExp(h, { metric: 123, status: "keep", description: "snapshot pairing" });

  const record = JSON.parse(sidecarLines(h.dir)[0]);
  assert.equal(record.analysis_prefix_bytes, Buffer.byteLength(analysisLine, "utf8"));
  assert.equal(record.analysis_prefix_sha256, sha256FileBytes(path.join(autoDirOf(h.dir), "analysis.jsonl")));
});

// ---------------------------------------------------------------------------
// 10. Torn analysis tail: bytes beyond the last LF -> null prefix pair (§5.2)
// ---------------------------------------------------------------------------

test("torn analysis tail: sidecar record has null analysis_prefix_bytes and null analysis_prefix_sha256", async (t) => {
  const h = await setup("torn-tail");
  // A complete analysis line, then a torn (LF-less) fragment: the §5.2 trigger
  // for the null pair — bytes exist beyond the last-LF prefix boundary.
  const analysisPath = path.join(autoDirOf(h.dir), "analysis.jsonl");
  const completeLine = JSON.stringify({ v: 1, record: "analysis", kind: "comparison", id: "an1", recorded_at: "2026-01-01T00:00:00.000Z" }) + "\n";
  fs.writeFileSync(analysisPath, completeLine + '{"v":1,"reco');
  const tornState = requireTornTailAnalysis(analysisPath, Buffer.byteLength(completeLine, "utf8"));
  t.after(() => { try { fs.rmSync(analysisPath, { force: true }); } catch { /* ignore */ } });

  await runExp(h);
  await logExp(h, { metric: 123, status: "keep", description: "torn analysis tail" });

  const record = JSON.parse(sidecarLines(h.dir)[0]);
  // §5.2 null pairing, both fields null together for a torn analysis tail.
  assert.equal(record.analysis_prefix_bytes, null);
  assert.equal(record.analysis_prefix_sha256, null);
  // The run_started marker itself was still written (the run is not blocked).
  assert.equal(ledgerLines(h.dir).filter((l) => l.includes('"run_started"')).length, 1);

  const verdict = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(verdict.link, "proven", "an unconfirmed prefix never blocks the link itself");
  assert.equal(verdict.analysisPrefixBytes, null);
  assert.equal(verdict.analysisPrefixSha256, null);

  // The torn state is exactly what the null-pair contract keys on.
  assert.ok(tornState.fileBytes > tornState.prefixBytes, "file has bytes beyond the last-LF prefix");
});

/** Sanity: the seeded analysis.jsonl really is torn (LF-less tail) before the run. */
function requireTornTailAnalysis(file, completeLineBytes) {
  const buf = fs.readFileSync(file);
  assert.notEqual(buf[buf.length - 1], 0x0a, "seeded analysis.jsonl must end without LF");
  const lastLf = buf.lastIndexOf(0x0a);
  assert.equal(lastLf + 1, completeLineBytes, "prefix boundary equals the complete line length");
  return { fileBytes: buf.length, prefixBytes: lastLf + 1 };
}

// ---------------------------------------------------------------------------
// 11. Ledger append failure after successful markers: NO sidecar record (§5.2)
// ---------------------------------------------------------------------------

test("ledger append failure after successful markers: log fails, no sidecar record, failure text present", async (t) => {
  const h = await setup("ledger-fail");
  // run_experiment writes its markers into a healthy ledger (complete pending
  // identity); only the log_experiment ordinary-row append then fails.
  await runExp(h);
  const markersBeforeLog = ledgerLines(h.dir).filter((l) => l.includes("run_")).length;
  assert.equal(markersBeforeLog, 2, "run_started + run_result markers landed before log_experiment");

  // Failure injection at the ordinary-row append only: the ledger file becomes
  // read-only AFTER the markers (reads stay healthy for consume's own scan).
  const ledgerPath = path.join(autoDirOf(h.dir), "log.jsonl");
  fs.chmodSync(ledgerPath, 0o444);
  t.after(() => {
    try { fs.chmodSync(ledgerPath, 0o666); } catch { /* already gone */ }
  });

  const res = await logExp(h, { metric: 123, status: "keep", description: "ledger append fails" });

  // The ledger append itself failed and says so.
  assert.ok(res.content[0].text.includes("Failed to write .auto/log.jsonl"), "ledger append failure text present");
  // §5.2: no sidecar record after a failed ledger row write — the pending
  // identity was complete, so its absence comes only from the failed append.
  assert.equal(sidecarLines(h.dir).length, 0, "no run-links record when the ledger row write failed");
  // The ledger is byte-unchanged: no ordinary row, only the two markers.
  const ledgerAfter = fs.readFileSync(ledgerPath, "utf8");
  assert.equal(ledgerAfter.includes('"run":1,'), false, "no ordinary row landed");
  assert.equal(ledgerLines(h.dir).filter((l) => l.includes("run_")).length, 2);
});
