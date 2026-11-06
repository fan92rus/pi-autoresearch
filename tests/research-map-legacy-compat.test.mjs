/**
 * Research-map task 1.3 — legacy campaign reconstruction, byte identity and
 * old-format reader stability (design.md §13.1, §13.2; tests T1, T15, T55,
 * T59 regression contracts).
 *
 * Fixture: tests/fixtures/research-map/legacy-campaign/log.jsonl — a SYNTHETIC
 * old-format ledger (no `activity_type`, metric `0` legacy crash values,
 * keep/discard/crash rows, run_started/run_result markers, no sidecars, no
 * tree.json). The fixture is illustrative; nothing in this file treats it as
 * evidence of search efficiency.
 *
 * Run: timeout 120 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-map-legacy-compat.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { readObservations } from "../extensions/pi-autoresearch/research-observations.ts";
import { readAnalysis } from "../extensions/pi-autoresearch/research-analysis.ts";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "research-map", "legacy-campaign");
const LEGACY_LOG = fs.readFileSync(path.join(FIXTURE_DIR, "log.jsonl"), "utf8");

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function lineByFragment(text, fragment) {
  return text.split("\n").find((line) => line.includes(fragment));
}

/** Copy the fixture campaign into a fresh temp `.auto/` dir. */
function makeTempCampaign(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-map-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  return { root, autoDir, log: path.join(autoDir, "log.jsonl") };
}

/** Hand-computed expectations for the fixture (declared once, asserted everywhere). */
const EXPECTED = {
  name: "legacy-demo",
  metricName: "latency_ms",
  bestDirection: "lower",
  currentEpoch: 1,
  runs: [
    { run: 1, metric: 120.5, status: "keep" },
    { run: 2, metric: 0, status: "crash" },
    { run: 3, metric: 131.0, status: "discard" },
    { run: 4, metric: 117.25, status: "keep" },
  ],
  bestMetric: 117.25,
  bestRun: 4,
};

// ---------------------------------------------------------------------------
// Fixture sanity: the fixture is the old format, illustrative only
// ---------------------------------------------------------------------------

test("fixture is legacy-format: no activity_type, no sidecars, no tree.json, labelled illustrative", () => {
  assert.ok(fs.existsSync(path.join(FIXTURE_DIR, "log.jsonl")));
  const rows = LEGACY_LOG.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  assert.equal(rows.some((r) => "activity_type" in r), false, "legacy rows carry no activity_type");
  assert.equal(rows.filter((r) => r.type === "run_started").length, 4, "run_started markers present");
  assert.equal(rows.filter((r) => r.type === "run_result").length, 4, "run_result markers present");
  assert.equal(rows.filter((r) => typeof r.run === "number").length, 4, "four ordinary rows");
  for (const key of ["observations.jsonl", "run-links.jsonl", "analysis.jsonl", "tree.json"]) {
    assert.equal(fs.existsSync(path.join(FIXTURE_DIR, key)), false, `${key} absent from the legacy fixture`);
  }
  const readme = fs.readFileSync(path.join(path.dirname(FIXTURE_DIR), "README.md"), "utf8");
  assert.match(readme, /SYNTHETIC/, "fixture must be labelled synthetic");
  assert.match(readme, /illustrative/, "fixture must be labelled illustrative, not proof of efficiency");
});

// ---------------------------------------------------------------------------
// T1: reconstruction of the legacy ledger matches hand-computed values
// ---------------------------------------------------------------------------

test("T1: legacy fixture reconstructs the hand-computed runs/best/streak", () => {
  const state = reconstructJsonlState(LEGACY_LOG);
  assert.equal(state.name, EXPECTED.name);
  assert.equal(state.metricName, EXPECTED.metricName);
  assert.equal(state.bestDirection, EXPECTED.bestDirection);
  assert.equal(state.currentEpoch, EXPECTED.currentEpoch);
  assert.equal(state.results.length, EXPECTED.runs.length);
  for (const [i, expected] of EXPECTED.runs.entries()) {
    const run = state.results[i];
    assert.equal(run.run, expected.run);
    assert.equal(run.metric, expected.metric);
    assert.equal(run.status, expected.status);
  }
  // Old-format crash value: metric 0 on the crash row is a legacy metric, never
  // reinterpreted (D-RM-04) and never a semantic failure (§11.1a).
  assert.equal(state.results[1].metric, 0);
  // best = best kept metric, run 4; the crash row (metric 0) never becomes best.
  const kept = state.results.filter((r) => r.status === "keep").map((r) => r.metric);
  assert.equal(Math.min(...kept), EXPECTED.bestMetric);
  const bestRun = state.results.find((r) => r.metric === EXPECTED.bestMetric && r.status === "keep");
  assert.equal(bestRun.run, EXPECTED.bestRun);
});

// ---------------------------------------------------------------------------
// T1: sidecars appearing next to the legacy ledger change nothing for the old reader
// ---------------------------------------------------------------------------

test("T1: reconstruction is identical before and after sidecar files appear next to the legacy ledger", (t) => {
  const project = makeTempCampaign(t);
  fs.writeFileSync(project.log, LEGACY_LOG);
  const before = reconstructJsonlState(fs.readFileSync(project.log, "utf8"));

  // A "new-version" campaign writes three sidecars next to the unchanged ledger.
  const startedLine = lineByFragment(LEGACY_LOG, '"run_started"');
  const resultLine = lineByFragment(LEGACY_LOG, '"run_result"');
  const ordinaryLine = lineByFragment(LEGACY_LOG, '"run":1,');
  const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
  fs.writeFileSync(path.join(project.autoDir, "observations.jsonl"), JSON.stringify({
    v: 1, record: "observation", obs_id: "obs-demo-00000001", recorded_at: "2026-01-10T09:20:00.000Z",
    segment_at_record: 0, epoch_at_record: 1, run_segment: null, run_epoch: null, run_epoch_basis: "not_linked",
    observed_run: 4, observed_run_dir: ".auto/runs/4", run_started_at: "2026-01-10T09:15:00.000Z", run_settled: true,
    binding: "verified", run_link: "absent", activity_type: "intermediate", outcome: "success",
    description: "synthetic diagnostic step", metric_provenance: "none",
  }) + "\n");
  fs.writeFileSync(path.join(project.autoDir, "run-links.jsonl"), JSON.stringify({
    v: 1, execution_id: "a".repeat(32), run_dir: 1,
    started_sha256: sha(startedLine), result_sha256: sha(resultLine), log_sha256: sha(ordinaryLine),
    analysis_prefix_bytes: null, analysis_prefix_sha256: null,
  }) + "\n");
  // §6.4: content_sha256 over the canonical JSON (sorted keys) without the hash itself.
  const canonical = (v) => {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v !== null && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  };
  const analysisBase = {
    v: 1, record: "analysis", kind: "comparison", id: "cmp-demo-00000001",
    recorded_at: "2026-01-10T09:25:00.000Z", purpose: "exploration", baseline_run: 1,
    candidate_run: 4, metric_name: "latency_ms", changed_components: [],
  };
  fs.writeFileSync(path.join(project.autoDir, "analysis.jsonl"), JSON.stringify({
    ...analysisBase, content_sha256: sha(canonical(analysisBase)),
  }) + "\n");

  // The OLD reader (reconstruct over log.jsonl alone) sees exactly the same state.
  const after = reconstructJsonlState(fs.readFileSync(project.log, "utf8"));
  assert.deepEqual(after, before);
  assert.equal(sha256File(project.log), sha256Text(LEGACY_LOG), "ledger bytes untouched by sidecar presence");

  // The sidecars parse cleanly with the new readers (so the fixture really is new-format compatible).
  const observations = readObservations(fs.readFileSync(path.join(project.autoDir, "observations.jsonl"), "utf8"));
  assert.equal(observations.records.length, 1);
  assert.equal(observations.torn_lines, 0);
  assert.equal(observations.invalid, 0);
  const analysis = readAnalysis(fs.readFileSync(path.join(project.autoDir, "analysis.jsonl"), "utf8"));
  assert.equal(analysis.records.length, 1);
  assert.equal(analysis.torn_lines, 0);
  assert.equal(analysis.invalid, 0);
});

// ---------------------------------------------------------------------------
// T15: the old ledger round-trips through a byte-copy in a fresh temp dir
// ---------------------------------------------------------------------------

test("T15: a byte-copy of the legacy campaign reconstructs identically in a fresh temp dir", (t) => {
  const source = makeTempCampaign(t);
  fs.writeFileSync(source.log, LEGACY_LOG);

  const copy = makeTempCampaign(t);
  fs.copyFileSync(source.log, copy.log);
  assert.equal(sha256File(copy.log), sha256File(source.log));

  const fromSource = reconstructJsonlState(fs.readFileSync(source.log, "utf8"));
  const fromCopy = reconstructJsonlState(fs.readFileSync(copy.log, "utf8"));
  assert.deepEqual(fromCopy, fromSource);
  assert.equal(fromCopy.results.length, 4);
});

// ---------------------------------------------------------------------------
// T59 contract regression: reconstruction exposes only the named keys the
// report/measure stack reads — nothing new leaks into ReconstructedRun.
// ---------------------------------------------------------------------------

test("T59: reconstruction output shape is unchanged for legacy rows (named keys only)", () => {
  const state = reconstructJsonlState(LEGACY_LOG);
  const allowed = new Set([
    "run", "commit", "metric", "metrics", "status", "description", "timestamp", "segment", "epoch", "confidence", "asi",
  ]);
  for (const run of state.results) {
    for (const key of Object.keys(run)) assert.ok(allowed.has(key), `unexpected reconstructed key ${key}`);
  }
  assert.equal(state.results.length, 4);
});

// ---------------------------------------------------------------------------
// T55 (rollback direction): an old reader over a ledger carrying the NEW
// activity_type key ignores it; deleting the sidecars changes nothing.
// ---------------------------------------------------------------------------

test("T55: old-code reconstruction ignores activity_type; sidecar deletion leaves results and ledger bytes identical", (t) => {
  const project = makeTempCampaign(t);
  const withLabel = LEGACY_LOG + JSON.stringify({
    run: 5, commit: "f1x9a2f", metric: 118.9, metrics: { latency_ms: 118.9 }, status: "keep",
    description: "labelled run", timestamp: 1768036800000, segment: 0, confidence: 0.65, activity_type: "verification",
  }) + "\n";
  fs.writeFileSync(project.log, withLabel);
  fs.writeFileSync(path.join(project.autoDir, "observations.jsonl"), "torn-fragment-without-newline");

  const withSidecars = reconstructJsonlState(fs.readFileSync(project.log, "utf8"));
  assert.equal(withSidecars.results.length, 5);
  assert.equal(withSidecars.results[4].run, 5);
  assert.equal("activity_type" in withSidecars.results[4], false, "runFrom exposes only named keys; label is ignored");

  // Rollback: delete the new files → same reconstruction, ledger untouched.
  fs.unlinkSync(path.join(project.autoDir, "observations.jsonl"));
  const afterRollback = reconstructJsonlState(fs.readFileSync(project.log, "utf8"));
  assert.deepEqual(afterRollback, withSidecars);
  assert.equal(sha256File(project.log), sha256Text(withLabel));
});
