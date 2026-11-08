/**
 * Research-map tasks 5.2 and 5.3 — acceptance and install/rollback scenarios
 * on local synthetic fixtures (design.md §5.2, §5.3, §11.1a, §12.2, §12.4,
 * §13.2; tests T3, T36, T12, T39, T55, T82, T92; tasks.md 5.2/5.3).
 *
 * Everything here runs on anonymized SYNTHETIC fixtures created in temp dirs
 * (or the synthetic legacy fixture under tests/fixtures/research-map/). No
 * dependency on D:/tmp/lobprobe or any historical campaign; historical data is
 * never treated as proof of search efficiency.
 *
 * Run: timeout 300 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-map-acceptance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createHarness } from "./fake-pi.ts";
import { reconstructJsonlState } from "../extensions/pi-autoresearch/jsonl.ts";
import { computeState } from "../extensions/pi-autoresearch/observer.ts";
import { readObservations } from "../extensions/pi-autoresearch/research-observations.ts";
import { runLinkOf } from "../extensions/pi-autoresearch/run-links.ts";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "research-map", "legacy-campaign");
const REPO_ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function autoDirOf(dir) {
  return path.join(dir, ".auto");
}

function latestReview(dir) {
  const reviewsDir = path.join(autoDirOf(dir), "reviews");
  const files = fs.readdirSync(reviewsDir).filter((f) => f.startsWith("direction-") && f.endsWith(".md"));
  assert.equal(files.length, 1, "exactly one review document");
  return { name: files[files.length - 1], text: fs.readFileSync(path.join(reviewsDir, files[files.length - 1]), "utf8") };
}

function firstJsonLine(text) {
  return JSON.parse(text.split("\n")[0]);
}

async function setupHarness(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-rm-accept-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await createHarness({ dir, sessionId: `rm-accept-${label}`, realGit: false, optimizeFixture: true });
  await h.command("autoresearch").handler("on", h.ctx);
  await h.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "F1", metric_unit: "", direction: "higher",
  }, null, null, h.ctx);
  return { ...h, dir };
}

function runExp(h, metric = 0.5, hypothesisId = undefined) {
  return h.tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC F1=${metric}')"`, timeout_seconds: 10,
    ...(hypothesisId !== undefined ? { hypothesis_id: hypothesisId } : {}),
  }, null, null, h.ctx);
}

function logExp(h, params) {
  return h.tool("log_experiment").execute("id", params, null, null, h.ctx);
}

/** One ordinary proven run: propose → run_experiment → log_experiment(keep). */
async function seedOneRun(h, { status = "keep", metric = 0.5, hypothesis = false } = {}) {
  let hypothesisId;
  if (hypothesis) {
    const prop = await h.tool("propose_hypothesis").execute("id", { description: "acceptance hypothesis" }, null, null, h.ctx);
    hypothesisId = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  }
  await runExp(h, metric, hypothesisId);
  const logged = await logExp(h, { metric, status, description: "acceptance run", metrics: { F1: metric } });
  return logged;
}

// ---------------------------------------------------------------------------
// A. Ordinary run counted as keep, not failed: observations do not become runs
//    (§5.3, §11.1a; tasks 5.2 acceptance assertion 1)
// ---------------------------------------------------------------------------

test("5.2/A: a synthetic campaign with preparation/diagnostic/technical_failure observations keeps ordinary keep/discard/best unchanged; no observation is counted as a run", async (t) => {
  const h = await setupHarness("obs-mix");
  await seedOneRun(h, { status: "keep", metric: 0.5 });
  // A second ordinary run, discard — proves keep/discard semantics untouched.
  await seedOneRun(h, { status: "discard", metric: 0.6, hypothesis: true });

  const ledgerBeforeObs = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  const stateBefore = reconstructJsonlState(ledgerBeforeObs);
  const observerBefore = computeState(stateBefore.results, "higher");
  const keepCountBefore = stateBefore.results.filter((r) => r.status === "keep").length;
  const discardCountBefore = stateBefore.results.filter((r) => r.status === "discard").length;
  const failedBefore = stateBefore.results.filter((r) => r.status === "crash" || r.status === "checks_failed" || r.status === "budget_exceeded").length;

  // Three observations: success (preparation), success (diagnostic), technical_failure.
  for (const [outcome, description] of [
    ["success", "synthetic preparation step"],
    ["success", "synthetic diagnostic check"],
    ["technical_failure", "synthetic diagnostic probe failed"],
  ]) {
    const res = await h.tool("log_observation").execute("id", { outcome, description }, null, null, h.ctx);
    assert.equal(firstJsonLine(res.content[0].text).status, "appended", `${description} appended`);
  }

  const ledgerAfterObs = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  assert.equal(ledgerAfterObs, ledgerBeforeObs, "observations never touch log.jsonl bytes");
  const stateAfter = reconstructJsonlState(ledgerAfterObs);
  const observerAfter = computeState(stateAfter.results, "higher");
  // No ordinary run is counted as failed (or as anything) because of observations.
  assert.equal(stateAfter.results.length, stateBefore.results.length, "no run rows added by observations");
  assert.equal(stateAfter.results.filter((r) => r.status === "keep").length, keepCountBefore);
  assert.equal(stateAfter.results.filter((r) => r.status === "discard").length, discardCountBefore);
  assert.equal(
    stateAfter.results.filter((r) => r.status === "crash" || r.status === "checks_failed" || r.status === "budget_exceeded").length,
    failedBefore,
    "no observation becomes a failed run",
  );
  // Ordinary keep/discard/best unchanged.
  assert.deepEqual(observerAfter.best, observerBefore.best);
  assert.equal(observerAfter.best, 0.5, "best stays the keep run's metric");
  assert.equal(observerAfter.runsSinceBestImprovement, observerBefore.runsSinceBestImprovement);
  // Observations live in their own file with all three outcomes readable.
  const observations = readObservations(fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8"));
  assert.equal(observations.records.length, 3);
  assert.deepEqual(observations.records.map((r) => r.outcome).sort(), ["success", "success", "technical_failure"].sort());
  // The ledger contains no observation rows (observations live in separate files).
  for (const line of ledgerAfterObs.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    assert.notEqual(entry.record, "observation", "no observation row inside log.jsonl");
  }
});

// ---------------------------------------------------------------------------
// B. Observation with metric 0 on a legacy ledger: best/streak of the old
//    campaign unchanged (T3/T36 semantics over the synthetic fixture)
// ---------------------------------------------------------------------------

test("5.2/B: an observation with outcome success and metric 0 over the synthetic legacy fixture leaves best/streak and ledger bytes unchanged", (t) => {
  // Pure-module check on the fixture copy: reconstruction before/after an
  // appended (never written by these tests) observation row is identical.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-map-accept-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const log = path.join(autoDir, "log.jsonl");
  fs.copyFileSync(path.join(FIXTURE_DIR, "log.jsonl"), log);
  const before = reconstructJsonlState(fs.readFileSync(log, "utf8"));
  const observerBefore = computeState(before.results, "lower");

  // Simulated observation side effect: only observations.jsonl appears.
  fs.writeFileSync(path.join(autoDir, "observations.jsonl"), JSON.stringify({
    v: 1, record: "observation", obs_id: "obs-accept-00000001", recorded_at: "2026-01-10T09:30:00.000Z",
    segment_at_record: 0, epoch_at_record: 1, run_segment: null, run_epoch: null, run_epoch_basis: "not_linked",
    observed_run: 4, observed_run_dir: ".auto/runs/4", run_started_at: "2026-01-10T09:15:00.000Z", run_settled: true,
    binding: "verified", run_link: "absent", activity_type: "intermediate", outcome: "success",
    description: "synthetic preparation", metric_provenance: "manual", metric: 0,
  }) + "\n");

  const after = reconstructJsonlState(fs.readFileSync(log, "utf8"));
  const observerAfter = computeState(after.results, "lower");
  assert.deepEqual(after, before);
  assert.deepEqual(observerAfter.best, observerBefore.best);
  assert.equal(observerAfter.runsSinceBestImprovement, observerBefore.runsSinceBestImprovement);
  // The 0-metric observation would not change best even if misread as a run;
  // prove the file boundary instead: old reader sees only 4 run rows.
  assert.equal(after.results.length, 4);
  // Fixture is illustrative: these are synthetic numbers, not evidence of search efficiency.
  const readme = fs.readFileSync(path.join(FIXTURE_DIR, "..", "README.md"), "utf8");
  assert.match(readme, /illustrative/);
});

// ---------------------------------------------------------------------------
// C. Run with run-links proven (T39 shape) on the synthetic harness campaign
// ---------------------------------------------------------------------------

test("5.2/C: run_experiment + log_experiment produce a proven run-link (unique markers + sidecar record), not ambiguous", async (t) => {
  const h = await setupHarness("proven-link");
  await seedOneRun(h, { status: "keep", metric: 0.5 });

  const scanVerdict = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(scanVerdict.link, "proven", `expected proven, got ${scanVerdict.link} (${scanVerdict.warnings.join(", ") || "no warnings"})`);
  assert.equal(scanVerdict.binding, "verified");
  assert.equal(scanVerdict.settled, true);
  assert.match(scanVerdict.executionId, /^[0-9a-f]{32}$/);

  // Negative control: the same ledger WITHOUT the sidecar is ambiguous, never proven (T39).
  const sidecar = path.join(autoDirOf(h.dir), "run-links.jsonl");
  const sidecarText = fs.readFileSync(sidecar, "utf8");
  fs.unlinkSync(sidecar);
  const withoutSidecar = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(withoutSidecar.link, "ambiguous", "no sidecar record → ambiguous (§5.2)");

  // Duplicated sidecar record → ambiguous (T39 negative): two records for one
  // run make the journal corrupt, which fails closed to ambiguous with a warning.
  fs.writeFileSync(sidecar, sidecarText + sidecarText);
  const duplicated = runLinkOf(autoDirOf(h.dir), 1);
  assert.equal(duplicated.link, "ambiguous");
  assert.ok(duplicated.warnings.includes("run_links_corrupt"), `corrupt-journal warning, got: ${duplicated.warnings.join(", ")}`);

  // Restore the single record → proven again (bytes of the sidecar unchanged).
  fs.writeFileSync(sidecar, sidecarText);
  assert.equal(runLinkOf(autoDirOf(h.dir), 1).link, "proven");
});

// ---------------------------------------------------------------------------
// D. Analysis prereg record: ledger untouched, prereg ordering computed honestly
// ---------------------------------------------------------------------------

test("5.2/D: record_analysis prereg writes exactly one analysis record; log.jsonl bytes and reconstruction unchanged", async (t) => {
  const h = await setupHarness("prereg");
  await seedOneRun(h, { status: "keep", metric: 0.5 });

  const ledgerBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  const obsBefore = fs.existsSync(path.join(autoDirOf(h.dir), "observations.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8")
    : "";

  const res = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "acceptaxis",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "champion branch" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 3 },
    noise_band: 0.002,
  }, null, null, h.ctx);
  const parsed = firstJsonLine(res.content[0].text);
  assert.equal(parsed.status, "appended");
  assert.match(parsed.id, /^pre-/);
  assert.equal(parsed.computed.prereg_status.status, "unknown", "no candidate run yet → honest unknown");
  assert.equal(parsed.computed.prereg_status.order_reason, "no_candidate_run");

  const ledgerAfter = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  assert.equal(ledgerAfter, ledgerBefore, "prereg never changes the ledger");
  assert.equal(fs.existsSync(path.join(autoDirOf(h.dir), "observations.jsonl")), obsBefore !== "", "prereg never writes observations");
  const analysisText = fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8");
  const lines = analysisText.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1, "exactly one analysis record");
  assert.equal(JSON.parse(lines[0]).kind, "prereg");
});

// ---------------------------------------------------------------------------
// E. direction_review invocation: exactly ONE document, zero run/log tools (T82)
// ---------------------------------------------------------------------------

test("5.2/E: direction_review on the synthetic campaign writes exactly one document and calls no run/log tools (T82)", async (t) => {
  const h = await setupHarness("review");
  await seedOneRun(h, { status: "keep", metric: 0.5 });
  await h.tool("log_observation").execute("id", { outcome: "success", description: "synthetic preparation" }, null, null, h.ctx);
  await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "acceptaxis",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "champion branch" }],
  }, null, null, h.ctx);

  const ledgerBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  const obsBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8");
  const analysisBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8");
  const execCallsBefore = h.pi.execCalls.length;
  const sentBefore = h.pi.sentMessages.length;
  const entriesBefore = h.pi.entries.length;

  const res = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  assert.match(res.content[0].text, /Direction review written/);
  assert.match(res.content[0].text, /No experiments were run/);

  // Exactly one document, fixed sections present.
  const review = latestReview(h.dir);
  assert.match(review.name, /^direction-\d{4}-\d{2}-\d{2}T/);
  for (const section of ["## Факты", "## Неизвестно", "## Признаки", "## Альтернативы", "## Что не доказано", "## Рекомендации (не действия)"]) {
    assert.ok(review.text.includes(section), `fixed section present: ${section}`);
  }

  // Zero side effects on journals and zero run/log tool invocations.
  assert.equal(fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8"), ledgerBefore, "ledger untouched");
  assert.equal(fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8"), obsBefore);
  assert.equal(fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8"), analysisBefore);
  const newExecCalls = h.pi.execCalls.slice(execCallsBefore);
  assert.equal(newExecCalls.length, 0, "direction_review spawns no processes (no run_experiment/log_experiment exec)");
  assert.equal(h.pi.sentMessages.length, sentBefore, "no follow-up messages (no run/log tool invocation)");
  assert.equal(h.pi.entries.length, entriesBefore, "no loop entries appended");
});

// ---------------------------------------------------------------------------
// F. Historical data is not proof: the scenario files carry the illustrative label
// ---------------------------------------------------------------------------

test("5.2/F: scenarios run on synthetic fixtures only; no lobprobe dependency; historical data labelled illustrative", () => {
  assert.equal(process.cwd().toLowerCase().includes("lobprobe"), false, "test process never runs inside lobprobe");
  for (const entry of fs.readdirSync(FIXTURE_DIR)) {
    assert.notEqual(entry.toLowerCase(), "tree.json", "fixture carries no tree.json");
  }
  const readme = fs.readFileSync(path.join(FIXTURE_DIR, "..", "README.md"), "utf8");
  assert.match(readme, /SYNTHETIC/);
  assert.match(readme, /NOT historical campaign data/);
  assert.match(readme, /proof of search efficiency/);
});

// ===========================================================================
// Task 5.3 — install / rollback equivalence on a temp copy of the legacy
// fixture (design.md §13.2, §13.1; tests T55, T1, T15; requirements §2a:
// ReconstructedRun/reconstructJsonlState/runFrom/statusFrom unchanged).
//
// Scenario: (a) a NEW-version campaign writes sidecars (observations.jsonl /
// run-links.jsonl / analysis.jsonl + an activity_type ledger row); (b) the
// OLD reader — reconstructJsonlState pinned from the pre-change commit
// 9d9dffc^ via `git show <rev>:<path>` into a temp file, never a checkout —
// reads the SAME log.jsonl and must produce results identical to the new
// reader; (c) rollback = deleting the sidecar files leaves log.jsonl
// byte-identical and old-reader results identical. Also verified: log.jsonl
// contains no observation rows after the new tools ran (the old reader cannot
// mistake an observation for a run).
// ===========================================================================

const OLD_READER_CACHE = path.join(os.tmpdir(), "research-map-old-jsonl-pinned.ts");

/** Byte-identical legacy ledger text. */
const LEGACY_LOG_53 = fs.readFileSync(path.join(FIXTURE_DIR, "log.jsonl"), "utf8");

function sha256Text(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function makeTempCampaign53(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-map-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  return { root, autoDir, log: path.join(autoDir, "log.jsonl") };
}

/**
 * Old reader pinned from git history: `git show 9d9dffc^:extensions/pi-autoresearch/jsonl.ts`
 * piped into a temp .ts module (read-only extraction — the worktree is never
 * checked out or modified). The test process already runs with
 * `--experimental-strip-types`, which is exactly how the current jsonl.ts is
 * loaded, so the pinned file is imported under the same contract. If git or
 * the pinned file is unavailable, tests using the reader skip with an
 * explicit reason.
 */
async function loadOldReader(t) {
  let source;
  try {
    const { stdout } = await execFileAsync("git", ["show", "9d9dffc^:extensions/pi-autoresearch/jsonl.ts"], { encoding: "utf8", cwd: REPO_ROOT });
    source = stdout;
  } catch (e) {
    t.skip(`git show 9d9dffc^:extensions/pi-autoresearch/jsonl.ts unavailable (${e.message.split("\n")[0]}); old reader cannot be pinned`);
    return null;
  }
  fs.writeFileSync(OLD_READER_CACHE, source);
  try {
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(OLD_READER_CACHE).href + `?ts=${Date.now()}`);
    return mod.reconstructJsonlState;
  } catch (e) {
    t.skip(`pinned old reader failed to import: ${e.message}`);
    return null;
  }
}

/** Sidecars a new-version campaign writes next to the legacy ledger (§13.2 list). */
function simulateNewVersionWrites(autoDir) {
  const startedLine = LEGACY_LOG_53.split("\n").find((l) => l.includes('"run_started"') && l.includes('"run_dir":4'));
  const resultLine = LEGACY_LOG_53.split("\n").find((l) => l.includes('"run_result"') && l.includes('"run_dir":4'));
  const ordinaryLine = LEGACY_LOG_53.split("\n").find((l) => l.includes('"run":4'));
  const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

  fs.writeFileSync(path.join(autoDir, "observations.jsonl"), JSON.stringify({
    v: 1, record: "observation", obs_id: "obs-rb-00000001", recorded_at: "2026-01-10T09:40:00.000Z",
    segment_at_record: 0, epoch_at_record: 1, run_segment: null, run_epoch: null, run_epoch_basis: "not_linked",
    observed_run: 4, observed_run_dir: ".auto/runs/4", run_started_at: "2026-01-10T09:15:00.000Z", run_settled: true,
    binding: "verified", run_link: "absent", activity_type: "intermediate", outcome: "technical_failure",
    description: "synthetic diagnostic probe failed", metric_provenance: "none",
  }) + "\n");
  fs.writeFileSync(path.join(autoDir, "run-links.jsonl"), JSON.stringify({
    v: 1, execution_id: "b".repeat(32), run_dir: 4,
    started_sha256: sha(startedLine), result_sha256: sha(resultLine), log_sha256: sha(ordinaryLine),
    analysis_prefix_bytes: null, analysis_prefix_sha256: null,
  }) + "\n");
  const canonical = (v) => {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v !== null && typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  };
  const analysisBase = {
    v: 1, record: "analysis", kind: "comparison", id: "cmp-rb-00000001",
    recorded_at: "2026-01-10T09:45:00.000Z", purpose: "exploration", baseline_run: 1,
    candidate_run: 4, metric_name: "latency_ms", changed_components: [],
  };
  fs.writeFileSync(path.join(autoDir, "analysis.jsonl"), JSON.stringify({
    ...analysisBase, content_sha256: sha(canonical(analysisBase)),
  }) + "\n");
  // A new-version ledger row carrying the optional activity_type key.
  const labelledRow = JSON.stringify({
    run: 5, commit: "f1x9a2f", metric: 118.9, metrics: { latency_ms: 118.9 }, status: "keep",
    description: "labelled verification run", timestamp: 1768036800000, segment: 0, confidence: 0.65,
    activity_type: "verification",
  });
  fs.appendFileSync(path.join(autoDir, "log.jsonl"), labelledRow + "\n");
  return { labelledRow };
}

const SIDECAR_FILES_53 = ["observations.jsonl", "run-links.jsonl", "analysis.jsonl"];
const SIDECAR_LOCKS_53 = ["observations.lock", "analysis.lock", "run-links.lock"];

test("5.3/T55 install: new reader and pinned old reader agree on the upgraded campaign; old reader ignores the activity_type key", async (t) => {
  const oldReader = await loadOldReader(t);
  if (oldReader === null) return;

  const project = makeTempCampaign53(t);
  fs.writeFileSync(project.log, LEGACY_LOG_53);
  const legacyOld = oldReader(LEGACY_LOG_53);
  const legacyNew = reconstructJsonlState(LEGACY_LOG_53);
  assert.deepEqual(legacyNew, legacyOld, "new and old readers agree on the untouched legacy ledger");

  // Install: the new version appends sidecars and a labelled ledger row.
  const { labelledRow } = simulateNewVersionWrites(project.autoDir);
  const upgradedText = fs.readFileSync(project.log, "utf8");
  assert.ok(upgradedText.includes('"activity_type":"verification"'), "upgrade adds the labelled row");

  const upgradedOld = oldReader(upgradedText);
  const upgradedNew = reconstructJsonlState(upgradedText);
  // Old reader on new data == new reader on new data (T55 §13.1: named keys only).
  assert.deepEqual(upgradedNew, upgradedOld);
  assert.equal(upgradedOld.results.length, 5, "the labelled row is a run; the label itself is dropped");
  for (const run of upgradedOld.results) assert.equal("activity_type" in run, false);

  // Best/streak semantics of the legacy part survive the upgrade: the first
  // four runs reconstruct identically before and after.
  assert.deepEqual(
    upgradedOld.results.slice(0, 4).map((r) => [r.run, r.metric, r.status]),
    legacyOld.results.map((r) => [r.run, r.metric, r.status]),
  );
  assert.ok(labelledRow.includes("verification"));
});

test("5.3/T55 rollback: deleting the new sidecar files leaves log.jsonl byte-identical and the old reader's results identical", async (t) => {
  const oldReader = await loadOldReader(t);
  if (oldReader === null) return;

  const project = makeTempCampaign53(t);
  fs.writeFileSync(project.log, LEGACY_LOG_53);
  simulateNewVersionWrites(project.autoDir);
  const upgradedBytes = sha256File(project.log);
  const upgradedOld = oldReader(fs.readFileSync(project.log, "utf8"));

  // Rollback (§13.2): remove only the new sidecar files; the ledger is
  // append-only history, so the labelled row stays and must still read
  // identically.
  for (const file of [...SIDECAR_FILES_53, ...SIDECAR_LOCKS_53]) {
    const p = path.join(project.autoDir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert.equal(sha256File(project.log), upgradedBytes, "rollback does not rewrite the ledger");
  const rolledBackOld = oldReader(fs.readFileSync(project.log, "utf8"));
  assert.deepEqual(rolledBackOld, upgradedOld, "old reader results identical after sidecar deletion");

  // Same result with the NEW reader after rollback.
  assert.deepEqual(reconstructJsonlState(fs.readFileSync(project.log, "utf8")), rolledBackOld);
});

test("5.3: after the new tools ran, log.jsonl contains no observation rows — the old reader cannot mistake an observation for a run", async (t) => {
  const oldReader = await loadOldReader(t);
  if (oldReader === null) return;

  const project = makeTempCampaign53(t);
  fs.writeFileSync(project.log, LEGACY_LOG_53);
  simulateNewVersionWrites(project.autoDir);

  const text = fs.readFileSync(project.log, "utf8");
  let observationRows = 0;
  let runRows = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (entry.record === "observation" || (entry.outcome !== undefined && entry.run === undefined)) observationRows++;
    if (typeof entry.run === "number") runRows++;
  }
  assert.equal(observationRows, 0, "no observation rows inside log.jsonl");
  assert.equal(runRows, 5, "exactly the legacy runs plus the labelled row");

  // The old reader reconstructs exactly those 5 runs — none of the observation
  // sidecar content leaked into its result set.
  const state = oldReader(text);
  assert.equal(state.results.length, 5);
  for (const run of state.results) {
    assert.notEqual(run.description, "synthetic diagnostic probe failed", "no observation description became a run");
  }

  // And the observation itself is intact in its own file.
  const obs = fs.readFileSync(path.join(project.autoDir, "observations.jsonl"), "utf8");
  assert.equal(JSON.parse(obs).record, "observation");
});

test("5.3/T1/T15: pinned old reader and current reader agree on the raw legacy fixture copy", async (t) => {
  const oldReader = await loadOldReader(t);
  if (oldReader === null) return;
  const project = makeTempCampaign53(t);
  fs.copyFileSync(path.join(FIXTURE_DIR, "log.jsonl"), project.log);
  assert.equal(sha256File(project.log), sha256Text(LEGACY_LOG_53), "temp copy is byte-identical to the fixture");
  assert.deepEqual(
    reconstructJsonlState(fs.readFileSync(project.log, "utf8")),
    oldReader(fs.readFileSync(project.log, "utf8")),
  );
});
