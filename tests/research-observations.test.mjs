/**
 * Observation journal module for research-map (openspec/changes/research-map/design.md §5.2,
 * §5.3, §6.3, §6.4, §7.1, §7.3, §8.2; tests T2–T11 and the binding/passport/provenance rules).
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-observations.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

import {
  createLogObservationTool,
  logObservation,
  normalizePassport,
  parseLogObservationParams,
  readObservations,
  validateObservationRecord,
} from "../extensions/pi-autoresearch/research-observations.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";

const execFileAsync = promisify(execFile);
const MODULE_PATH = new URL("../extensions/pi-autoresearch/research-observations.ts", import.meta.url);
const MODULE_URL = MODULE_PATH.href;

const CONFIG_LINE = JSON.stringify({ type: "config", name: "t", metricName: "metric", metricUnit: "", bestDirection: "lower" });
const STARTED_1 = "2026-11-05T10:12:41.007Z";
const STARTED_2 = "2026-11-05T11:00:00.000Z";

function startMarker(run, startedAt) {
  return JSON.stringify({ type: "run_started", run_dir: run, node_id: "n1", command: "bench", started_at: startedAt });
}

function resultMarker(run, startedAt, duration = 37.2) {
  return JSON.stringify({
    type: "run_result",
    run_dir: run,
    started_at: startedAt,
    node_id: "n1",
    exit_code: 0,
    killed: false,
    duration_seconds: duration,
  });
}

/** Ledger with one settled run 1 (verified pair). */
function baseLedger() {
  return [CONFIG_LINE, startMarker(1, STARTED_1), resultMarker(1, STARTED_1), ""].join("\n");
}

function makeProject(t, { ledger = baseLedger(), runs = [1] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-observations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  if (ledger !== null) fs.writeFileSync(path.join(autoDir, "log.jsonl"), ledger);
  for (const run of runs) fs.mkdirSync(path.join(autoDir, "runs", String(run)), { recursive: true });
  return { root, autoDir, log: path.join(autoDir, "log.jsonl"), observations: path.join(autoDir, "observations.jsonl"), lock: path.join(autoDir, "observations.lock") };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function linesOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  assert.equal(lines.pop(), "", "file must end with LF");
  return lines;
}

function params(overrides = {}) {
  return { outcome: "success", description: "teacher generation", linked_run: 1, ...overrides };
}

function recordingSleep() {
  const calls = [];
  return { calls, sleep: async (ms) => { calls.push(ms); } };
}

function foreignLock(lockPath, info) {
  fs.writeFileSync(lockPath, JSON.stringify(info));
}

const FOREIGN = { token: "ab".repeat(16), pid: 4242, host: "other-host", acquired_at: "2026-01-01T00:00:00.000Z" };

// ---------------------------------------------------------------------------
// T4: forbidden run-shaped keys
// ---------------------------------------------------------------------------

test("T4: run/status/type/commit/epoch/segment and observed_run are rejected on input and nothing is written", async (t) => {
  const project = makeProject(t);
  for (const key of ["run", "status", "type", "commit", "epoch", "segment", "observed_run"]) {
    const response = await logObservation(project.autoDir, params({ [key]: 1 }));
    assert.equal(response.status, "error", key);
    assert.equal(response.code, "invalid_input", key);
  }
  assert.equal(fs.existsSync(project.observations), false);
});

test("T4: an observation row carrying a forbidden key is invalid and is never reconstructed as a run", async (t) => {
  const project = makeProject(t);
  const written = await logObservation(project.autoDir, params());
  assert.equal(written.status, "appended");
  const row = JSON.parse(linesOf(project.observations)[0]);
  const tampered = JSON.stringify({ ...row, run: 3 });

  const read = readObservations(`${tampered}\n`);
  assert.equal(read.records.length, 0);
  assert.equal(read.invalid, 1);

  const before = reconstructJsonlState(baseLedger());
  const after = reconstructJsonlState(`${baseLedger()}${JSON.stringify(row)}\n`);
  assert.deepEqual(after, before);
  assert.equal(after.results.length, 0);
  assert.equal(reconstructJsonlState(JSON.stringify(row)).results.length, 0);
});

// ---------------------------------------------------------------------------
// T1, T2, T3, T14: no effect on the ledger, git or best; no lastRunNumber
// ---------------------------------------------------------------------------

test("T2/T3: log.jsonl bytes and the reconstructed state are unchanged by a success observation with metric 0", async (t) => {
  const project = makeProject(t);
  const ledgerHash = sha256File(project.log);
  const before = reconstructJsonlState(fs.readFileSync(project.log, "utf8"));

  const response = await logObservation(project.autoDir, params({ outcome: "success", metric: 0 }));

  assert.equal(response.status, "appended");
  assert.equal(sha256File(project.log), ledgerHash);
  assert.deepEqual(reconstructJsonlState(fs.readFileSync(project.log, "utf8")), before);
});

test("T2/T14: the module source has no child process calls and never reads runtime.lastRunNumber", () => {
  const code = fs
    .readFileSync(MODULE_PATH, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
    })
    .join("\n");
  assert.equal(/child_process|execFile|(^|[^.\w])spawn\(|(^|[^.\w])exec\(/.test(code), false);
  assert.equal(code.includes("lastRunNumber"), false);
  assert.equal(code.includes("runtime"), false);
});

// ---------------------------------------------------------------------------
// T5, D-RM-04: absence of a metric versus a valid zero
// ---------------------------------------------------------------------------

test("T5: no metric → no metric key and provenance none; metric 0 → key present with value 0", async (t) => {
  const project = makeProject(t);

  const absent = await logObservation(project.autoDir, params({ description: "no measurement" }));
  const zero = await logObservation(project.autoDir, params({ description: "measured zero", metric: 0 }));

  assert.equal(absent.status, "appended");
  assert.equal(absent.metric_provenance, "none");
  assert.equal(zero.status, "appended");
  assert.equal(zero.metric_provenance, "manual");
  const [first, second] = linesOf(project.observations).map((line) => JSON.parse(line));
  assert.equal("metric" in first, false);
  assert.equal(first.metric_provenance, "none");
  assert.equal("metric" in second, true);
  assert.equal(second.metric, 0);
});

test("T5: a record with provenance none must not carry a metric, and a provenance other than none requires one", () => {
  const base = {
    v: 1,
    record: "observation",
    obs_id: "obs-abc-0123abcd",
    recorded_at: "2026-11-05T10:14:03.512Z",
    segment_at_record: 0,
    epoch_at_record: 1,
    run_segment: null,
    run_epoch: null,
    run_epoch_basis: "not_linked",
    observed_run: 3,
    observed_run_dir: ".auto/runs/3",
    run_started_at: STARTED_1,
    run_settled: true,
    binding: "verified",
    run_link: "absent",
    activity_type: "intermediate",
    outcome: "technical_failure",
    description: "teacher generation: CUDA OOM",
    metric_provenance: "none",
  };
  assert.equal(validateObservationRecord(base), null);
  assert.equal(validateObservationRecord({ ...base, metric: 0 }), "metric_present_without_provenance");
  assert.equal(validateObservationRecord({ ...base, metric_provenance: "manual" }), "metric_missing_for_provenance");
  assert.equal(validateObservationRecord({ ...base, metric_provenance: "manual", metric: 0 }), null);
});

// ---------------------------------------------------------------------------
// T6, T7, T32: idempotency
// ---------------------------------------------------------------------------

test("T6: the same key with the same input gives already_recorded; a different input gives a conflict and no write", async (t) => {
  const project = makeProject(t);
  const first = await logObservation(project.autoDir, params({ idempotency_key: "tg-run1-a" }));
  assert.equal(first.status, "appended");
  assert.equal(first.dedup, "key");
  const bytes = fs.readFileSync(project.observations);

  const repeat = await logObservation(project.autoDir, params({ idempotency_key: "tg-run1-a" }));
  assert.equal(repeat.status, "already_recorded");
  assert.equal(repeat.obs_id, first.obs_id);
  assert.equal(linesOf(project.observations).length, 1);

  const conflict = await logObservation(project.autoDir, params({ idempotency_key: "tg-run1-a", description: "other text" }));
  assert.equal(conflict.status, "error");
  assert.equal(conflict.code, "idempotency_conflict");
  assert.deepEqual(fs.readFileSync(project.observations), bytes);
});

test("T32: the same key used later (clock moved on) is still already_recorded", async (t) => {
  const project = makeProject(t);
  const first = await logObservation(project.autoDir, params({ idempotency_key: "late-1" }));
  const later = await logObservation(project.autoDir, params({ idempotency_key: "late-1" }), {
    now: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  assert.equal(later.status, "already_recorded");
  assert.equal(later.obs_id, first.obs_id);
  assert.equal(linesOf(project.observations).length, 1);
});

test("T7: two calls without a key write two lines and report dedup none", async (t) => {
  const project = makeProject(t);
  const a = await logObservation(project.autoDir, params());
  const b = await logObservation(project.autoDir, params());
  assert.equal(a.status, "appended");
  assert.equal(b.status, "appended");
  assert.equal(a.dedup, "none");
  assert.notEqual(a.obs_id, b.obs_id);
  assert.equal(linesOf(project.observations).length, 2);
});

// ---------------------------------------------------------------------------
// T8, T9: torn tail, fault injection, retry after interruption
// ---------------------------------------------------------------------------

test("T8: a file ending in a fragment without LF gets a newline guard; the fragment stays its own line", async (t) => {
  const project = makeProject(t);
  const seeded = await logObservation(project.autoDir, params({ description: "seed" }));
  assert.equal(seeded.status, "appended");
  const fragment = '{"v":1,"record":"observation","obs_id":"obs-x';
  fs.appendFileSync(project.observations, fragment);

  const response = await logObservation(project.autoDir, params({ description: "after torn tail" }));

  assert.equal(response.status, "appended");
  assert.equal(response.torn_lines, 1);
  const lines = fs.readFileSync(project.observations, "utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], fragment);
  assert.equal(JSON.parse(lines[2]).obs_id, response.obs_id);
  const read = readObservations(fs.readFileSync(project.observations, "utf8"));
  assert.equal(read.records.length, 2);
  assert.equal(read.torn_lines, 1);
});

test("T9: a crash after half of the record is written; retrying with the same key leaves exactly one valid line", async (t) => {
  const project = makeProject(t);
  const realFs = fs;
  let injected = false;
  const faulty = {
    writeSync(fd, data) {
      if (!injected && Buffer.from(data).toString("utf8").includes("half-written")) {
        injected = true;
        return realFs.writeSync(fd, data.subarray(0, Math.floor(data.length / 2)));
      }
      return realFs.writeSync(fd, data);
    },
  };

  const failed = await logObservation(project.autoDir, params({ description: "half-written", idempotency_key: "crash-1" }), { fs: faulty });
  assert.equal(failed.status, "error");
  assert.equal(failed.code, "record_write_failed");
  assert.match(failed.message, /torn fragment/);

  const retried = await logObservation(project.autoDir, params({ description: "half-written", idempotency_key: "crash-1" }));
  assert.equal(retried.status, "appended");
  assert.equal(retried.torn_lines, 1);

  const read = readObservations(fs.readFileSync(project.observations, "utf8"));
  const withKey = read.records.filter((record) => record.idempotency_key === "crash-1");
  assert.equal(withKey.length, 1);
  assert.equal(withKey[0].obs_id, retried.obs_id);
  assert.equal(fs.existsSync(project.lock), false);
});

test("T9: a failure after the full write but before fsync keeps one line; the retry reports already_recorded", async (t) => {
  const project = makeProject(t);
  const faulty = {
    fsyncSync() {
      // The lock file is never fsynced, so every fsync here belongs to the observations append.
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    },
  };

  const first = await logObservation(project.autoDir, params({ idempotency_key: "fsync-1" }), { fs: faulty });
  assert.equal(first.status, "appended");
  assert.ok(first.warnings.includes("fsync_failed"));

  const retry = await logObservation(project.autoDir, params({ idempotency_key: "fsync-1" }));
  assert.equal(retry.status, "already_recorded");
  assert.equal(retry.obs_id, first.obs_id);
  assert.equal(linesOf(project.observations).length, 1);
});

// ---------------------------------------------------------------------------
// T10, T11, T23: locking (no automatic takeover, bounded wait, manual unlock)
// ---------------------------------------------------------------------------

test("T10: eight concurrent calls with distinct keys in one process all land as intact lines", async (t) => {
  const project = makeProject(t);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => logObservation(project.autoDir, params({ description: `parallel ${i}`, idempotency_key: `p-${i}` }))),
  );
  assert.deepEqual([...new Set(results.map((r) => r.status))], ["appended"]);
  const lines = linesOf(project.observations);
  assert.equal(lines.length, 8);
  assert.equal(new Set(lines.map((line) => JSON.parse(line).idempotency_key)).size, 8);
  assert.equal(fs.existsSync(project.lock), false);
});

test("T10/T23: a held lock gives observation_lock_busy within the retry budget, writes nothing and keeps the holder", async (t) => {
  const project = makeProject(t);
  foreignLock(project.lock, FOREIGN);
  const lockBytes = fs.readFileSync(project.lock);
  const { calls, sleep } = recordingSleep();

  const response = await logObservation(project.autoDir, params(), { sleep });

  assert.equal(response.status, "error");
  assert.equal(response.code, "observation_lock_busy");
  assert.match(response.message, /Manual unlock/);
  assert.equal(calls.length, 40);
  assert.equal(calls.reduce((sum, ms) => sum + ms, 0) <= 2500, true);
  assert.equal(fs.existsSync(project.observations), false);
  assert.deepEqual(fs.readFileSync(project.lock), lockBytes);
});

test("T11: a stale lock from a dead process is never taken over; writing resumes only after manual deletion", async (t) => {
  const project = makeProject(t);
  foreignLock(project.lock, { token: "cd".repeat(16), pid: 999999, host: "gone-host", acquired_at: "2020-01-01T00:00:00.000Z" });
  const lockBytes = fs.readFileSync(project.lock);
  const { sleep } = recordingSleep();

  const blocked = await logObservation(project.autoDir, params(), { sleep });
  assert.equal(blocked.code, "observation_lock_busy");
  assert.deepEqual(fs.readFileSync(project.lock), lockBytes);
  assert.equal(fs.existsSync(project.observations), false);

  fs.unlinkSync(project.lock);
  const written = await logObservation(project.autoDir, params());
  assert.equal(written.status, "appended");
  assert.equal(linesOf(project.observations).length, 1);
});

test("T10: separate processes appending through the module never interleave or lose records", async (t) => {
  const project = makeProject(t);
  const script = [
    "const m = await import(process.env.OBS_MODULE);",
    "for (let i = 0; i < 10; i++) {",
    "  const r = await m.logObservation(process.env.AUTO_DIR, { outcome: 'success', description: 'parallel', linked_run: 1, idempotency_key: `${process.env.TAG}-${i}` });",
    "  if (r.status !== 'appended') { console.error(JSON.stringify(r)); process.exit(2); }",
    "}",
  ].join("\n");

  await Promise.all(
    ["p0", "p1", "p2"].map((tag) =>
      execFileAsync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
        timeout: 120000,
        env: { ...process.env, OBS_MODULE: MODULE_URL, AUTO_DIR: project.autoDir, TAG: tag },
      }),
    ),
  );

  const lines = linesOf(project.observations);
  assert.equal(lines.length, 30);
  const keys = new Set(lines.map((line) => JSON.parse(line).idempotency_key));
  assert.equal(keys.size, 30);
  assert.equal(fs.existsSync(project.lock), false);
});

// ---------------------------------------------------------------------------
// Binding to a run (§5.2, D-RM-05)
// ---------------------------------------------------------------------------

test("binding: 'last' on a settled run is verified, takes the run's started_at and never reads memory", async (t) => {
  const project = makeProject(t);
  const response = await logObservation(project.autoDir, { outcome: "success", description: "prep" });

  assert.equal(response.status, "appended");
  assert.equal(response.observed_run, 1);
  assert.equal(response.observed_run_dir, ".auto/runs/1");
  assert.equal(response.run_started_at, STARTED_1);
  assert.equal(response.run_settled, true);
  assert.equal(response.binding, "verified");
  assert.equal(response.run_link, "absent");
  assert.equal(response.run_epoch, null);
  assert.equal(response.run_segment, null);
  assert.equal(response.run_epoch_basis, "not_linked");
  assert.deepEqual(response.warnings, ["run_epoch_unknown"]);
  const [row] = linesOf(project.observations).map((line) => JSON.parse(line));
  assert.equal(row.observed_run, 1);
  assert.equal(row.activity_type, "intermediate");
});

test("binding: 'last' on a dangling run is refused; an explicit N gives binding unsettled and writes the record", async (t) => {
  const ledger = [CONFIG_LINE, startMarker(1, STARTED_1), resultMarker(1, STARTED_1), startMarker(2, STARTED_2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1, 2] });

  const refused = await logObservation(project.autoDir, { outcome: "unknown", description: "recheck" });
  assert.equal(refused.code, "dangling_run");
  assert.equal(fs.existsSync(project.observations), false);

  const explicit = await logObservation(project.autoDir, { outcome: "unknown", description: "recheck", linked_run: 2 });
  assert.equal(explicit.status, "appended");
  assert.equal(explicit.binding, "unsettled");
  assert.equal(explicit.run_settled, false);
  assert.equal(explicit.run_started_at, STARTED_2);
  assert.ok(explicit.warnings.includes("binding_unsettled"));
  assert.equal(explicit.run_epoch_basis, "no_marker");
});

test("binding: no run markers gives no_settled_run; a missing log.jsonl gives no_settled_run and no write", async (t) => {
  const withoutMarkers = makeProject(t, { ledger: `${CONFIG_LINE}\n`, runs: [] });
  const none = await logObservation(withoutMarkers.autoDir, { outcome: "success", description: "x" });
  assert.equal(none.code, "no_settled_run");

  const missingLedger = makeProject(t, { ledger: null, runs: [1] });
  const absent = await logObservation(missingLedger.autoDir, { outcome: "success", description: "x", linked_run: 1 });
  assert.equal(absent.code, "no_settled_run");
  assert.equal(fs.existsSync(missingLedger.observations), false);
});

test("binding (T40): an incomplete line after the last marker refuses 'last' without touching log.jsonl; explicit N is unverified and ambiguous", async (t) => {
  const project = makeProject(t);
  fs.appendFileSync(project.log, '{"type":"exp');
  const ledgerBytes = fs.readFileSync(project.log);

  const refused = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(refused.code, "ledger_torn_tail");
  assert.match(refused.message, /Nothing was written/);
  assert.deepEqual(fs.readFileSync(project.log), ledgerBytes);
  assert.equal(fs.existsSync(project.observations), false);

  const explicit = await logObservation(project.autoDir, { outcome: "success", description: "x", linked_run: 1 });
  assert.equal(explicit.status, "appended");
  assert.equal(explicit.binding, "unverified");
  assert.equal(explicit.run_link, "ambiguous");
  assert.equal(explicit.run_epoch, null);
  assert.ok(explicit.warnings.includes("ledger_torn_tail"));
  assert.deepEqual(fs.readFileSync(project.log), ledgerBytes);
});

test("binding: an incomplete line before the last marker keeps 'last' working and makes the link ambiguous", async (t) => {
  const ledger = [CONFIG_LINE, "garbage{", startMarker(1, STARTED_1), resultMarker(1, STARTED_1), ""].join("\n");
  const project = makeProject(t, { ledger });
  const response = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(response.status, "appended");
  assert.equal(response.torn_lines, 0);
  assert.equal(response.run_link, "ambiguous");
  assert.ok(response.warnings.includes("ledger_torn_tail"));
});

test("binding: a duplicated run_started makes the pair unverified", async (t) => {
  const ledger = [CONFIG_LINE, startMarker(1, STARTED_1), startMarker(1, STARTED_1), resultMarker(1, STARTED_1), ""].join("\n");
  const project = makeProject(t, { ledger });
  const response = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(response.binding, "unverified");
  assert.equal(response.run_settled, true);
  assert.ok(response.warnings.includes("binding_unverified"));
});

test("binding (§5.2a): a measurement_change after the run started gives run_epoch_basis scale_changed_after_run", async (t) => {
  const ledger = [
    CONFIG_LINE,
    startMarker(1, STARTED_1),
    JSON.stringify({ type: "measurement_change", epoch: 2, id: "mc-1" }),
    resultMarker(1, STARTED_1),
    "",
  ].join("\n");
  const project = makeProject(t, { ledger });
  const response = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(response.run_epoch_basis, "scale_changed_after_run");
  assert.equal(response.run_epoch, null);
});

test("link: an ordinary ledger row for the run makes run_link ambiguous and reports run_number_shared", async (t) => {
  const ordinary = JSON.stringify({ run: 1, commit: "abc1234", metric: 1, metrics: {}, status: "keep", description: "ran", timestamp: 1, segment: 0 });
  const ledger = [CONFIG_LINE, startMarker(1, STARTED_1), resultMarker(1, STARTED_1), ordinary, ""].join("\n");
  const project = makeProject(t, { ledger });
  const response = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(response.run_link, "ambiguous");
  assert.equal(response.run_epoch, null);
  assert.ok(response.warnings.includes("run_number_shared"));
});

test("binding: missing run directory gives artifacts_missing for both modes", async (t) => {
  const project = makeProject(t, { runs: [] });
  const last = await logObservation(project.autoDir, { outcome: "success", description: "x" });
  assert.equal(last.code, "artifacts_missing");
  const explicit = await logObservation(project.autoDir, { outcome: "success", description: "x", linked_run: 7 });
  assert.equal(explicit.code, "artifacts_missing");
  assert.equal(fs.existsSync(project.observations), false);
});

// ---------------------------------------------------------------------------
// Metric provenance (§5.3 step 4; §10.2a parser rules)
// ---------------------------------------------------------------------------

function writeOutput(project, run, text) {
  fs.writeFileSync(path.join(project.autoDir, "runs", String(run), "output.txt"), text);
}

test("provenance: METRIC match within 0.5% gives output_match; a larger difference gives manual", async (t) => {
  const project = makeProject(t);
  writeOutput(project, 1, "warmup\nMETRIC metric=10\nMETRIC other=3\n");

  const matched = await logObservation(project.autoDir, params({ metric: 10.04 }));
  const differs = await logObservation(project.autoDir, params({ metric: 10.1 }));

  assert.equal(matched.metric_provenance, "output_match");
  assert.equal(differs.metric_provenance, "manual");
});

test("provenance: no METRIC line and a metric near the wall clock gives wallclock; otherwise manual", async (t) => {
  const project = makeProject(t);
  writeOutput(project, 1, "no metric here\n");

  const near = await logObservation(project.autoDir, params({ metric: 37 }));
  const far = await logObservation(project.autoDir, params({ metric: 45 }));

  assert.equal(near.metric_provenance, "wallclock");
  assert.equal(far.metric_provenance, "manual");
});

test("provenance: a missing output.txt gives manual with output_unavailable", async (t) => {
  const project = makeProject(t);
  const response = await logObservation(project.autoDir, params({ metric: 1 }));
  assert.equal(response.metric_provenance, "manual");
  assert.ok(response.warnings.includes("output_unavailable"));
});

test("provenance: a symlinked output.txt is refused as unsafe and its content is not used", async (t) => {
  const project = makeProject(t);
  const target = path.join(project.root, "elsewhere.txt");
  fs.writeFileSync(target, "METRIC metric=10\n");
  try {
    fs.symlinkSync(target, path.join(project.autoDir, "runs", "1", "output.txt"));
  } catch (error) {
    t.skip(`symlink creation not permitted here: ${error.code}`);
    return;
  }
  const response = await logObservation(project.autoDir, params({ metric: 10 }));
  assert.equal(response.metric_provenance, "manual");
  assert.ok(response.warnings.includes("output_unsafe"));
});

// ---------------------------------------------------------------------------
// Passport (§8.2): normalization, limits, no file access (I-12, T16, T26)
// ---------------------------------------------------------------------------

function refOf(ref, sha) {
  const component = sha === undefined ? { ref } : { ref, declared_sha256: sha };
  return normalizePassport({ components: { weights: component } }).components.weights;
}

test("T16: reference shapes are classified by the §8.2 steps", () => {
  assert.deepEqual(refOf("models/teacher-v3.safetensors"), {
    state: "declared",
    ref: "models/teacher-v3.safetensors",
    declared_sha256: null,
    verified: false,
    note: null,
  });
  assert.equal(refOf("/absolute/weights.bin").note, "non_local_ref");
  assert.equal(refOf("\\\\server\\share\\weights.bin").note, "non_local_ref");
  assert.equal(refOf("C:x").note, "non_local_ref");
  assert.equal(refOf("x:stream").note, "non_local_ref");
  assert.equal(refOf("https://example.com/w.bin").note, "non_local_ref");
  assert.equal(refOf("a/../b").note, "invalid_ref");
  assert.equal(refOf("bad\u0001name").note, "invalid_ref");
  assert.equal(refOf("x".repeat(513)).note, "invalid_ref");
  assert.equal(refOf("./.env").note, "denied_by_policy");
  assert.equal(refOf(".ENV.").note, "denied_by_policy");
  assert.equal(refOf(".env.local").note, "denied_by_policy");
  assert.equal(refOf("a/.auto/x.bin").note, "denied_by_policy");
  assert.equal(refOf("keys/server.pem").note, "denied_by_policy");
  assert.deepEqual(refOf("userinfo@host/file.bin").state, "declared");
});

test("T16: a valid hash is lowercased; a rejected ref drops the hash too; a hash alone is declared", () => {
  const upper = "AB".repeat(32);
  assert.deepEqual(refOf(undefined, upper), {
    state: "declared",
    ref: null,
    declared_sha256: upper.toLowerCase(),
    verified: false,
    note: null,
  });
  const rejected = refOf("C:x", upper.toLowerCase());
  assert.equal(rejected.state, "unknown");
  assert.equal(rejected.declared_sha256, null);
  assert.equal(rejected.note, "non_local_ref");
  assert.deepEqual(refOf(undefined, undefined), { state: "unknown", ref: null, declared_sha256: null, verified: false, note: "not_provided" });
});

test("T16: input limits — 65-character hash, 17 components, bad component name are rejected; 9 components are accepted", () => {
  const sixtyFive = { passport: { components: { weights: { declared_sha256: "a".repeat(65) } } } };
  assert.equal(parseLogObservationParams({ ...params(), ...sixtyFive }).ok, false);

  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, { ref: "a.bin" }]));
  assert.equal(parseLogObservationParams({ ...params(), passport: { components: many } }).ok, false);

  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, { ref: "a.bin" }]));
  assert.equal(parseLogObservationParams({ ...params(), passport: { components: nine } }).ok, true);

  assert.equal(parseLogObservationParams({ ...params(), passport: { components: { Weights: { ref: "a" } } } }).ok, false);
});

test("passport: serialization above 4 KiB is refused before anything is written", async (t) => {
  const project = makeProject(t);
  const components = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`c${i}`, { ref: "a".repeat(500) }]));
  const response = await logObservation(project.autoDir, params({ passport: { components } }));
  assert.equal(response.code, "passport_too_large");
  assert.equal(fs.existsSync(project.observations), false);
});

test("T26: writing an observation never opens or stats passport references", async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(path.join(project.root, "weights.bin"), "payload");
  const cjsFs = createRequire(import.meta.url)("node:fs");
  const names = ["openSync", "statSync", "lstatSync", "readFileSync", "realpathSync", "readSync", "fstatSync", "existsSync", "accessSync"];
  const originals = Object.fromEntries(names.map((name) => [name, cjsFs[name]]));
  const touched = [];
  for (const name of names) {
    cjsFs[name] = (first, ...rest) => {
      touched.push(String(first));
      return originals[name](first, ...rest);
    };
  }
  syncBuiltinESMExports();
  let response;
  try {
    response = await logObservation(project.autoDir, params({
      passport: {
        components: {
          weights: { ref: "weights.bin" },
          prompt: { ref: "./.env" },
        },
      },
    }));
  } finally {
    for (const name of names) cjsFs[name] = originals[name];
    syncBuiltinESMExports();
  }

  assert.equal(response.status, "appended");
  assert.ok(touched.some((p) => p.endsWith("log.jsonl")), "spy must observe the ledger read");
  assert.equal(touched.some((p) => p.includes("weights.bin") || p.includes(".env")), false, touched.join("\n"));
  const [row] = linesOf(project.observations).map((line) => JSON.parse(line));
  assert.equal(row.passport.components.prompt.note, "denied_by_policy");
  assert.equal(row.passport.components.prompt.ref, null);
});

// ---------------------------------------------------------------------------
// Input validation (§7.3) and the reader (§6.4, §7.1)
// ---------------------------------------------------------------------------

test("input: outcome and description are required; enums and ranges are enforced", () => {
  const invalid = [
    {},
    { outcome: "success" },
    { outcome: "keep", description: "x" },
    { outcome: "success", description: "" },
    { outcome: "success", description: "x".repeat(501) },
    { outcome: "success", description: "x", activity_type: "unknown" },
    { outcome: "success", description: "x", activity_type: "verification" },
    { outcome: "success", description: "x", metric: null },
    { outcome: "success", description: "x", metric: Number.NaN },
    { outcome: "success", description: "x", linked_run: 0 },
    { outcome: "success", description: "x", linked_run: "1" },
    { outcome: "success", description: "x", linked_run: 1.5 },
    { outcome: "success", description: "x", linked_run: 1_000_000_001 },
    { outcome: "success", description: "x", idempotency_key: "has space" },
    { outcome: "success", description: "x", metrics: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`m${i}`, 1])) },
    { outcome: "success", description: "x", asi: [] },
    { outcome: "success", description: "x", observed_run: 3 },
  ];
  for (const raw of invalid) {
    assert.equal(parseLogObservationParams(raw).ok, false, JSON.stringify(raw));
  }
  const defaults = parseLogObservationParams({ outcome: "technical_failure", description: "CUDA OOM" });
  assert.equal(defaults.ok, true);
  assert.equal(defaults.value.linked_run, "last");
  assert.equal(defaults.value.activity_type, "intermediate");
});

test("reader: a row without activity_type, or with a foreign value, is invalid and not used", () => {
  const row = {
    v: 1,
    record: "observation",
    obs_id: "obs-abc-0123abcd",
    recorded_at: "2026-11-05T10:14:03.512Z",
    segment_at_record: 0,
    epoch_at_record: 1,
    run_segment: null,
    run_epoch: null,
    run_epoch_basis: "not_linked",
    observed_run: 3,
    observed_run_dir: ".auto/runs/3",
    run_started_at: STARTED_1,
    run_settled: true,
    binding: "verified",
    run_link: "absent",
    activity_type: "intermediate",
    outcome: "success",
    description: "ok",
    metric_provenance: "none",
  };
  const { activity_type: _omitted, ...withoutActivity } = row;
  const text = [JSON.stringify(row), JSON.stringify(withoutActivity), JSON.stringify({ ...row, activity_type: "verification" }), ""].join("\n");
  const read = readObservations(text);
  assert.equal(read.records.length, 1);
  assert.equal(read.invalid, 2);
});

test("reader: torn lines are counted; non-observation rows are ignored", () => {
  const read = readObservations(`${JSON.stringify({ v: 2, note: "other journal" })}\n{"v":1,"rec\n\n`);
  assert.equal(read.records.length, 0);
  assert.equal(read.invalid, 0);
  assert.equal(read.torn_lines, 1);
});

test("reader: observed_run_dir must match observed_run and binding fields must be consistent", () => {
  const base = {
    v: 1,
    record: "observation",
    obs_id: "obs-abc-0123abcd",
    recorded_at: "2026-11-05T10:14:03.512Z",
    segment_at_record: 0,
    epoch_at_record: 1,
    run_segment: null,
    run_epoch: null,
    run_epoch_basis: "not_linked",
    observed_run: 3,
    observed_run_dir: ".auto/runs/3",
    run_started_at: STARTED_1,
    run_settled: true,
    binding: "verified",
    run_link: "absent",
    activity_type: "attribution",
    outcome: "unknown",
    description: "ok",
    metric_provenance: "none",
  };
  assert.equal(validateObservationRecord(base), null);
  assert.equal(validateObservationRecord({ ...base, observed_run_dir: ".auto/runs/4" }), "bad_observed_run_dir");
  assert.equal(validateObservationRecord({ ...base, run_link: "proven" }), "proven_requires_verified");
  assert.equal(validateObservationRecord({ ...base, run_epoch: 1 }), "link_fields_not_null");
  assert.equal(
    validateObservationRecord({ ...base, run_link: "proven", run_segment: 0, run_epoch: 1, run_epoch_basis: "not_linked" }),
    "epoch_without_basis",
  );
  assert.equal(validateObservationRecord({ ...base, outcome: "keep" }), "bad_outcome");
});

// ---------------------------------------------------------------------------
// Tool shape (§7.3). Not registered in index.ts by this module.
// ---------------------------------------------------------------------------

test("tool: execute returns text and details; the schema forbids run-shaped keys", async (t) => {
  const project = makeProject(t);
  const tool = createLogObservationTool(project.autoDir);
  assert.equal(tool.name, "log_observation");
  assert.equal(tool.parameters.additionalProperties, false);
  for (const key of ["run", "status", "commit", "type", "epoch", "segment", "observed_run"]) {
    assert.equal(key in tool.parameters.properties, false, key);
  }

  const result = await tool.execute("call-1", { outcome: "success", description: "prep", linked_run: 1 });
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, "appended");
  assert.deepEqual(result.details, parsed);

  const rejected = await tool.execute("call-2", { outcome: "success", description: "prep", run: 9 });
  assert.equal(rejected.details.status, "error");
  assert.equal(rejected.details.code, "invalid_input");
});
