/**
 * candidate-measure tests (openspec/changes/candidate-branches, task
 * pi-autoresearch-3e4.4.3.2): measurement parsing, repeated measurement,
 * the promotion gate and CAS leader promotion.
 *
 * Most tests substitute a fake ExecRunner (deterministic, fast). Two
 * integration tests drive a REAL git repository in a temporary directory
 * for the compare-and-swap update-ref path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as M from "../extensions/pi-autoresearch/candidate-measure.ts";

const execFileP = promisify(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const METH = [{ path: "docs/methodology.md", sha256: "d".repeat(64) }];

function policyDefaults() {
  return {
    policyMetricName: "p95_ms",
    policyDirection: "higher",
    policyMinGain: 0.5,
    policyMethodology: METH,
    currentMethodology: METH,
    leaderCommit: SHA_A,
    candidateCommit: SHA_B,
    leaderEpoch: "epoch-1",
    candidateEpoch: "epoch-1",
    checks: { dir: "D:/nonexistent-checks-dir", argv: ["node", "checks.js"], timeoutMs: 5000 },
  };
}

/** Fake runner that answers any command with code 0. */
function okRunner(stdout = "") {
  return async () => ({ code: 0, stdout, stderr: "" });
}

/**
 * Runner for the promotion gate: rev-parse HEAD answers with SHA_B (the
 * candidateCommit used in policyDefaults), checks and anything else pass.
 */
function gateRunner(headSha = SHA_B) {
  return async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${headSha}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** Runner that fails only the checks command (non-zero exit); rev-parse answers SHA_B. */
function failingChecksRunner() {
  return async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${SHA_B}\n`, stderr: "" };
    if (cmd[1] === "checks.js") return { code: 1, stdout: "", stderr: "1 failing" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** Runner whose benchmark prints a METRIC line with the given value. */
function benchmarkRunner(value) {
  return async (cmd) => {
    if (cmd[1] === "checks.js") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: `METRIC p95_ms=${value}\n`, stderr: "" };
  };
}

/** Single-line refusal assertions shared by every refusal case. */
function assertRefusal(result, reason) {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  // Same class as the module's oneLine(): no raw control/separator chars.
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(result.message), false, `refusal message must be one line: ${JSON.stringify(result.message)}`);
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "candidate-measure-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Real-git helper: run git in dir, returning stdout; throws on failure. */
async function git(dir, args) {
  const res = await execFileP("git", args, { cwd: dir });
  return res.stdout;
}

// ─── runMeasurement: METRIC parsing ─────────────────────────────────────────

test("runMeasurement parses a finite value from the METRIC line", async () => {
  const res = await M.runMeasurement(benchmarkRunner(15200), {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 10000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.value, 15200);
});

test("runMeasurement accepts the value in any float spelling and ignores other metric lines", async () => {
  const runner = async () => ({
    code: 0,
    stdout: "noise\nMETRIC other_ms=1\nMETRIC p95_ms=15.25e1\nmore noise\n",
    stderr: "",
  });
  const res = await M.runMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 10000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.value, 152.5);
});

test("runMeasurement refuses when the metric line is missing", async () => {
  const res = await M.runMeasurement(okRunner("all output, no metric\n"), {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 10000,
  });
  assertRefusal(res, "metric_missing");
});

test("runMeasurement refuses on duplicate METRIC lines for the same metric", async () => {
  const runner = okRunner("METRIC p95_ms=1\nMETRIC p95_ms=2\n");
  const res = await M.runMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 10000,
  });
  assertRefusal(res, "metric_duplicate");
});

test("runMeasurement refuses NaN, Infinity and non-numeric values", async () => {
  for (const token of ["NaN", "Infinity", "-Infinity", "0x10", "abc", "1,5"]) {
    const res = await M.runMeasurement(okRunner(`METRIC p95_ms=${token}\n`), {
      dir: "D:/bench",
      metricName: "p95_ms",
      argv: ["node", "bench.js"],
      timeoutMs: 10000,
    });
    assertRefusal(res, "metric_not_finite");
  }
});

test("runMeasurement refuses on non-zero benchmark exit and on killed (timeout)", async () => {
  const failRunner = async () => ({ code: 3, stdout: "", stderr: "boom\nboom\n" });
  assertRefusal(
    await M.runMeasurement(failRunner, { dir: "D:/bench", metricName: "p95_ms", argv: ["node", "bench.js"], timeoutMs: 1000 }),
    "exec_failed",
  );
  const killedRunner = async () => ({ code: 1, stdout: "METRIC p95_ms=5\n", stderr: "", killed: true });
  assertRefusal(
    await M.runMeasurement(killedRunner, { dir: "D:/bench", metricName: "p95_ms", argv: ["node", "bench.js"], timeoutMs: 1000 }),
    "timeout",
  );
});

test("runMeasurement validates its arguments", async () => {
  const r = okRunner();
  assertRefusal(await M.runMeasurement(r, { dir: "", metricName: "m", argv: ["x"], timeoutMs: 100 }), "invalid_argument");
  assertRefusal(await M.runMeasurement(r, { dir: "d", metricName: "m", argv: [], timeoutMs: 100 }), "invalid_argument");
  assertRefusal(await M.runMeasurement(r, { dir: "d", metricName: "m", argv: ["  "], timeoutMs: 100 }), "invalid_argument");
  assertRefusal(await M.runMeasurement(r, { dir: "d", metricName: "m", argv: ["x"], timeoutMs: 0 }), "invalid_argument");
  assertRefusal(await M.runMeasurement(r, { dir: "d", metricName: "", argv: ["x"], timeoutMs: 100 }), "invalid_argument");
});

// ─── runRepeatedMeasurement ──────────────────────────────────────────────────

test("runRepeatedMeasurement averages identical repeats", async () => {
  let call = 0;
  const runner = async () => {
    call += 1;
    return { code: 0, stdout: `METRIC p95_ms=${10 + call}\n`, stderr: "" };
  };
  const res = await M.runRepeatedMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
    repeats: 3,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.values, [11, 12, 13]);
  assert.equal(res.average, 12);
});

test("runRepeatedMeasurement refuses with repeats < 1 and non-integer repeats", async () => {
  const r = okRunner("METRIC p95_ms=1\n");
  assertRefusal(
    await M.runRepeatedMeasurement(r, { dir: "d", metricName: "m", argv: ["x"], timeoutMs: 100, repeats: 0 }),
    "invalid_argument",
  );
  assertRefusal(
    await M.runRepeatedMeasurement(r, { dir: "d", metricName: "m", argv: ["x"], timeoutMs: 100, repeats: 2.5 }),
    "invalid_argument",
  );
});

test("a failing repeat mid-run refuses without a partial average", async () => {
  let call = 0;
  const runner = async (cmd) => {
    call += 1;
    if (call === 2) return { code: 1, stdout: "", stderr: "flaky failure" };
    return { code: 0, stdout: "METRIC p95_ms=10\n", stderr: "" };
  };
  const res = await M.runRepeatedMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
    repeats: 3,
  });
  assertRefusal(res, "exec_failed");
  assert.equal(call, 2, "must stop at the first failed repeat");
});

test("a mid-run timeout refuses with the timeout reason", async () => {
  let call = 0;
  const runner = async () => {
    call += 1;
    if (call === 2) return { code: 1, stdout: "", stderr: "", killed: true };
    return { code: 0, stdout: "METRIC p95_ms=10\n", stderr: "" };
  };
  const res = await M.runRepeatedMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
    repeats: 3,
  });
  assertRefusal(res, "timeout");
});

test("an exhausted confirm budget refuses further repeats", async () => {
  let call = 0;
  const runner = async () => {
    call += 1;
    return { code: 0, stdout: "METRIC p95_ms=10\n", stderr: "" };
  };
  // Deterministic clock: each repeat "takes" 1000 ms of budget.
  let t = 0;
  const res = await M.runRepeatedMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
    repeats: 3,
    budgetMs: 1500,
    now: () => (t += 1000),
  });
  assertRefusal(res, "budget_exhausted");
  assert.ok(call < 3, `budget should stop before all repeats ran, got ${call}`);
});

// ─── compareForPromotion ─────────────────────────────────────────────────────

function sides(leaderAvg, candidateAvg, over = {}) {
  return {
    leaderMeasurement: { metricName: "p95_ms", direction: "higher", average: leaderAvg, ...over.leader },
    candidateMeasurement: { metricName: "p95_ms", direction: "higher", average: candidateAvg, ...over.candidate },
  };
}

test("happy path: gain strictly above min_gain passes the gate and reports values", async () => {
  const input = {
    ...policyDefaults(),
    runner: gateRunner(),
    ...sides(100, 101),
  };
  const res = await M.compareForPromotion(input);
  assert.equal(res.ok, true);
  assert.equal(res.gain, 1);
  assert.equal(res.leaderAverage, 100);
  assert.equal(res.candidateAverage, 101);
});

test("gain exactly equal to min_gain refuses (strict inequality)", async () => {
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 100.5) };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "gain_below_threshold");
  assert.ok(res.message.includes("0.5"), "message should name the gain");
});

test("gain below min_gain refuses", async () => {
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 100.1) };
  assertRefusal(await M.compareForPromotion(input), "gain_below_threshold");
});

test("direction lower: the candidate with the smaller value wins", async () => {
  const input = {
    ...policyDefaults(),
    policyDirection: "lower",
    runner: gateRunner(),
    leaderMeasurement: { metricName: "p95_ms", direction: "lower", average: 100 },
    candidateMeasurement: { metricName: "p95_ms", direction: "lower", average: 90 },
  };
  const res = await M.compareForPromotion(input);
  assert.equal(res.ok, true);
  assert.equal(res.gain, 10);
});

test("direction lower: the candidate with the larger value refuses", async () => {
  const input = {
    ...policyDefaults(),
    policyDirection: "lower",
    runner: gateRunner(),
    leaderMeasurement: { metricName: "p95_ms", direction: "lower", average: 100 },
    candidateMeasurement: { metricName: "p95_ms", direction: "lower", average: 110 },
  };
  assertRefusal(await M.compareForPromotion(input), "gain_below_threshold");
});

test("metric mismatch on either side refuses", async () => {
  const base = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 101) };
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      leaderMeasurement: { metricName: "other", direction: "higher", average: 100 },
    }),
    "metric_mismatch",
  );
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      candidateMeasurement: { metricName: "other", direction: "higher", average: 101 },
    }),
    "metric_mismatch",
  );
});

test("direction mismatch on either side refuses", async () => {
  const base = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 101) };
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      leaderMeasurement: { metricName: "p95_ms", direction: "lower", average: 100 },
    }),
    "direction_mismatch",
  );
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      candidateMeasurement: { metricName: "p95_ms", direction: "lower", average: 101 },
    }),
    "direction_mismatch",
  );
});

test("epoch mismatch refuses as incomparable context", async () => {
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 101), candidateEpoch: "epoch-2" };
  assertRefusal(await M.compareForPromotion(input), "incomparable_context");
});

test("methodology set or hash changes refuse", async () => {
  const base = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 101) };
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      currentMethodology: [{ path: "docs/methodology.md", sha256: "e".repeat(64) }],
    }),
    "methodology_changed",
  );
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      currentMethodology: [
        { path: "docs/methodology.md", sha256: "d".repeat(64) },
        { path: "docs/extra.md", sha256: "e".repeat(64) },
      ],
    }),
    "methodology_changed",
  );
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      currentMethodology: [{ path: "docs/renamed.md", sha256: "d".repeat(64) }],
    }),
    "methodology_changed",
  );
});

test("failed checks refuse with checks_failed before the gain is evaluated", async () => {
  const gainBelow = { ...policyDefaults(), runner: failingChecksRunner(), ...sides(100, 99) };
  assertRefusal(await M.compareForPromotion(gainBelow), "checks_failed");
});

test("checks infra failure (throw / timeout) refuses with checks_error", async () => {
  const throwing = async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${SHA_B}\n`, stderr: "" };
    if (cmd[1] === "checks.js") throw new Error("spawn gone\nsecond line");
    return { code: 0, stdout: "", stderr: "" };
  };
  const input = { ...policyDefaults(), runner: throwing, ...sides(100, 101) };
  assertRefusal(await M.compareForPromotion(input), "checks_error");
  assert.equal(/[\r\n]/.test((await M.compareForPromotion(input)).message), false);
});

test("gate arguments are validated before any runner call", async () => {
  const runnerCalls = [];
  const runner = async (cmd) => {
    runnerCalls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const good = () => ({ ...policyDefaults(), runner, ...sides(100, 101) });
  const cases = [
    { ...good(), policyMetricName: "" },
    { ...good(), policyDirection: "up" },
    { ...good(), policyMinGain: -1 },
    { ...good(), policyMinGain: Number.NaN },
    { ...good(), leaderCommit: "" },
    { ...good(), candidateCommit: "" },
    { ...good(), leaderEpoch: "" },
    { ...good(), leaderMeasurement: { metricName: "p95_ms", direction: "higher", average: Number.NaN } },
    { ...good(), candidateMeasurement: { metricName: "p95_ms", direction: "higher", average: Infinity } },
    { ...good(), policyMethodology: [] },
    { ...good(), currentMethodology: [] },
    { ...good(), checks: { dir: "d", argv: [], timeoutMs: 5 } },
  ];
  for (const input of cases) {
    assertRefusal(await M.compareForPromotion(input), "invalid_argument");
  }
  assert.equal(runnerCalls.length, 0, "invalid gate input must never reach the runner");
});

test("a promoted message containing a newline stays single-line (control chars escaped)", async () => {
  const messyChecks = async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${SHA_B}\n`, stderr: "" };
    if (cmd[1] === "checks.js") return { code: 2, stdout: "", stderr: "line1\nFAKE\r\u001b[31mline" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const input = { ...policyDefaults(), runner: messyChecks, ...sides(100, 101) };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "checks_failed");
  assert.equal(res.message.includes("FAKE"), true, "content stays honest (escaped, inline)");
});

// ─── Fix-round regressions (review B1/B2/M1/M2/M3/M4) ────────────────────────

test("B1: decimal-exact equality (1.1 - 1.0 at min 0.1) refuses gain_below_threshold", async () => {
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(1.0, 1.1) };
  input.policyMinGain = 0.1;
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "gain_below_threshold");
});

test("B1: decimal-exact equality (0.8 - 0.7 and 2.4 - 2.3 at min 0.1) refuses", async () => {
  const a = { ...policyDefaults(), runner: gateRunner(), ...sides(0.7, 0.8), policyMinGain: 0.1 };
  assertRefusal(await M.compareForPromotion(a), "gain_below_threshold");
  const b = { ...policyDefaults(), runner: gateRunner(), ...sides(2.3, 2.4), policyMinGain: 0.1 };
  assertRefusal(await M.compareForPromotion(b), "gain_below_threshold");
});

test("B1: a genuine gain survives ULP tolerance (1.15 - 1.0 at min 0.1 promotes)", async () => {
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(1.0, 1.15), policyMinGain: 0.1 };
  const res = await M.compareForPromotion(input);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(Math.abs(res.gain - 0.15) < 1e-12, true, `gain ${res.gain} must be 0.15 within float error`);
});

test("B1: large-magnitude decimal-exact equality (1000.35 - 1000.3 at min 0.05) refuses", async () => {
  // At magnitudes >= 1e3 the subtraction error exceeds 12 significant digits,
  // so gain rounding cannot help; the ULP-scaled tolerance must refuse.
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(1000.3, 1000.35), policyMinGain: 0.05 };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "gain_below_threshold");
});

test("B1: decimal-exact equality sweep over leader magnitudes 1e2..1e6 refuses", async () => {
  for (const [leader, min] of [[100.3, 0.05], [1000.3, 0.05], [10000.3, 0.05], [100000.3, 0.5], [1000000.3, 5]]) {
    const input = { ...policyDefaults(), runner: gateRunner(), ...sides(leader, leader + min), policyMinGain: min };
    const res = await M.compareForPromotion(input);
    assertRefusal(res, "gain_below_threshold");
  }
});

test("B1: subnormal-magnitude decimal-exact equality refuses (MIN_VALUE tolerance floor)", async () => {
  // EPSILON * 1e-321 underflows to 0; the MIN_VALUE floor must keep the gate closed.
  const input = { ...policyDefaults(), runner: gateRunner(), ...sides(1e-321, 2e-321), policyMinGain: 1e-321 };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "gain_below_threshold");
});

test("B1: a genuine large-magnitude gain still promotes", async () => {
  // 0.5 at magnitude 1e5 is decimal-EXACT equality with min 0.5 -> must refuse.
  const exact = { ...policyDefaults(), runner: gateRunner(), ...sides(100000, 100000.5), policyMinGain: 0.5 };
  assertRefusal(await M.compareForPromotion(exact), "gain_below_threshold");
  // 0.7 is genuinely larger than min 0.5 by more than ULP tolerance -> promotes.
  const genuine = { ...policyDefaults(), runner: gateRunner(), ...sides(100000, 100000.7), policyMinGain: 0.5 };
  const res = await M.compareForPromotion(genuine);
  assert.equal(res.ok, true, `a genuine gain of 0.7 at magnitude 1e5 must promote: ${JSON.stringify(res)}`);
  assert.equal(res.gain > 0.5, true);
});

test("B2: checks worktree HEAD differs from candidateCommit -> checkpoint_mismatch, checks never run", async () => {
  const calls = [];
  const runner = async (cmd) => {
    calls.push([...cmd]);
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${SHA_C}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const input = { ...policyDefaults(), runner, ...sides(100, 101) };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "checkpoint_mismatch");
  assert.equal(calls.some((c) => c[1] === "checks.js"), false, "checks argv must never run after a checkpoint mismatch");
});

test("B2: rev-parse non-zero exit -> checkpoint_mismatch; matching HEAD keeps the happy path", async () => {
  const revFail = async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const bad = { ...policyDefaults(), runner: revFail, ...sides(100, 101) };
  assertRefusal(await M.compareForPromotion(bad), "checkpoint_mismatch");

  const good = { ...policyDefaults(), runner: gateRunner(SHA_B), ...sides(100, 101) };
  const res = await M.compareForPromotion(good);
  assert.equal(res.ok, true);
});

test("M1: newline inside a METRIC line no longer parses (metric_missing)", async () => {
  let seen = 0;
  const runner = async () => {
    seen += 1;
    return { code: 0, stdout: "METRIC\np95_ms=5\n", stderr: "" };
  };
  const res = await M.runMeasurement(runner, {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
  });
  assertRefusal(res, "metric_missing");
  assert.equal(seen, 1);
  // CRLF line endings still parse.
  const crlf = await M.runMeasurement(async () => ({ code: 0, stdout: "METRIC p95_ms=5\r\n", stderr: "" }), {
    dir: "D:/bench",
    metricName: "p95_ms",
    argv: ["node", "bench.js"],
    timeoutMs: 1000,
  });
  assert.equal(crlf.ok, true);
  assert.equal(crlf.value, 5);
});

test("M2: U+2028 and C1 controls in refusal output are escaped to one line", async () => {
  const messy = async (cmd) => {
    if (cmd[1] === "rev-parse") return { code: 0, stdout: `${SHA_B}\n`, stderr: "" };
    if (cmd[1] === "checks.js") return { code: 2, stdout: "", stderr: "sep\u2028line\u0085and\u009bbell" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const input = { ...policyDefaults(), runner: messy, ...sides(100, 101) };
  const res = await M.compareForPromotion(input);
  assertRefusal(res, "checks_failed");
  assert.equal(res.message.includes("sep"), true, "content stays honest (escaped, inline)");
});

test("M3: CAS-mismatch stderr maps to leader_moved; other failures map to update_failed", async () => {
  const cas = async () => ({ code: 128, stdout: "", stderr: "fatal: update_ref failed for ref 'refs/pi-autoresearch/leader': cannot lock ref 'refs/pi-autoresearch/leader': is at de286e30 but expected 11111111" });
  const moved = await M.promoteLeader(cas, {
    runner: cas,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(moved, "leader_moved");

  const notRepo = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" });
  const failed = await M.promoteLeader(notRepo, {
    runner: notRepo,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(failed, "update_failed");

  const badRef = async () => ({ code: 128, stdout: "", stderr: "fatal: update_ref failed for ref 'refs/x.lock': refusing to update ref with bad name 'refs/x.lock'" });
  const refused = await M.promoteLeader(badRef, {
    runner: badRef,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(refused, "update_failed");
});

test("M3: a real-git CAS mismatch still classifies leader_moved and leaves the ref unchanged", async () => {
  await withDir(async (dir) => {
    await git(dir, ["init", "-q"]);
    await git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "c1"]);
    const c1 = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["update-ref", "refs/pi-autoresearch/leader", c1]);

    const runner = realRunner(dir);
    const res = await M.promoteLeader(runner, {
      runner,
      repoDir: dir,
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: "1".repeat(40), // wrong expected
      newSha: c1,
    });
    assertRefusal(res, "leader_moved");
    const leader = (await git(dir, ["rev-parse", "refs/pi-autoresearch/leader"])).trim();
    assert.equal(leader, c1, "leader ref must still point at c1");
  });
});

test("M4: duplicate methodology paths refuse with invalid_argument on either list", async () => {
  const base = { ...policyDefaults(), runner: gateRunner(), ...sides(100, 101) };
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      policyMethodology: [{ path: "docs/methodology.md", sha256: "d".repeat(64) }, { path: "docs/methodology.md", sha256: "e".repeat(64) }],
    }),
    "invalid_argument",
  );
  assertRefusal(
    await M.compareForPromotion({
      ...base,
      currentMethodology: [{ path: "docs/methodology.md", sha256: "d".repeat(64) }, { path: "docs/methodology.md", sha256: "e".repeat(64) }],
    }),
    "invalid_argument",
  );
});

// ─── promoteLeader (fake runner) ─────────────────────────────────────────────

test("promoteLeader invokes exactly git update-ref ref new old with 15s timeout", async () => {
  const calls = [];
  const runner = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = await M.promoteLeader(runner, {
    runner,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res, { ok: true, promoted: true, from: SHA_A, to: SHA_B });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].cmd, ["git", "update-ref", "refs/pi-autoresearch/leader", SHA_B, SHA_A]);
  assert.equal(calls[0].opts.cwd, "D:/repo");
  assert.equal(calls[0].opts.timeoutMs, 15000);
});

test("promoteLeader CAS mismatch (non-zero exit) refuses leader_moved", async () => {
  // Real git wording on a CAS mismatch (probed live): "is at <sha> but expected <sha>".
  const runner = async () => ({ code: 1, stdout: "", stderr: "fatal: update_ref failed for ref 'refs/pi-autoresearch/leader': cannot lock ref 'refs/pi-autoresearch/leader': is at de286e3066ba796ab383ce9a99dd8ab1e88d1e5e but expected 1111111111111111111111111111111111111111" });
  const res = await M.promoteLeader(runner, {
    runner,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(res, "leader_moved");
  assert.ok(res.message.includes("unchanged"), "message must state the leader was left unchanged");
});

test("promoteLeader runner throw and timeout refuse as uncertain", async () => {
  const throwing = async () => {
    throw new Error("git binary vanished\nwith\nnewlines");
  };
  const res1 = await M.promoteLeader(throwing, {
    runner: throwing,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(res1, "uncertain");
  assert.equal(res1.message.includes("manually"), true, "uncertain must demand manual verification");

  const killed = async () => ({ code: 1, stdout: "", stderr: "", killed: true });
  const res2 = await M.promoteLeader(killed, {
    runner: killed,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/leader",
    expectedSha: SHA_A,
    newSha: SHA_B,
  });
  assertRefusal(res2, "uncertain");
});

test("promoteLeader validates ref name and shas", async () => {
  const runner = okRunner();
  const badRefs = ["", "leader", "refs..x", "refs/x@{y", "refs/ x", "-refs/x", "refs/x/", "refs/..x/", "refs/x y", "refs/х"]; // non-ascii last
  for (const ref of badRefs) {
    assertRefusal(
      await M.promoteLeader(runner, {
        runner,
        repoDir: "D:/repo",
        leaderRef: ref,
        expectedSha: SHA_A,
        newSha: SHA_B,
      }),
      "invalid_argument",
    );
  }
  assertRefusal(
    await M.promoteLeader(runner, {
      runner,
      repoDir: "D:/repo",
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: "nothex",
      newSha: SHA_B,
    }),
    "invalid_argument",
  );
  assertRefusal(
    await M.promoteLeader(runner, {
      runner,
      repoDir: "D:/repo",
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: SHA_A,
      newSha: "z".repeat(40),
    }),
    "invalid_argument",
  );
  assertRefusal(
    await M.promoteLeader(runner, {
      runner,
      repoDir: "D:/repo",
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: SHA_A,
      newSha: SHA_C + "extra",
    }),
    "invalid_argument",
  );
});

test("promoteLeader accepts a 64-char sha (SHA-256 repos) and valid nested refs", async () => {
  const calls = [];
  const runner = async (cmd, opts) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const sha64 = "f".repeat(64);
  const res = await M.promoteLeader(runner, {
    runner,
    repoDir: "D:/repo",
    leaderRef: "refs/pi-autoresearch/campaign-1/leader",
    expectedSha: sha64,
    newSha: "0".repeat(64),
  });
  assert.equal(res.ok, true);
  assert.equal(calls[0][2], "refs/pi-autoresearch/campaign-1/leader");
});

// ─── promoteLeader (real git integration) ────────────────────────────────────

/** Real ExecRunner over child_process.execFile (repo integration shape). */
function realRunner(dir) {
  return async (cmd, opts) => {
    try {
      const res = await execFileP(cmd[0], cmd.slice(1), { cwd: opts?.cwd ?? dir, timeout: opts?.timeoutMs ?? 15000 });
      return { code: 0, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
      const e = err;
      if (e.killed) return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "", killed: true };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };
}

test("promoteLeader CAS success on a real git repo", async () => {
  await withDir(async (dir) => {
    await git(dir, ["init", "-q"]);
    await git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "c1"]);
    const c1 = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "c2"]);
    const c2 = (await git(dir, ["rev-parse", "HEAD"])).trim();

    // Pre-create the leader ref at c1.
    await git(dir, ["update-ref", "refs/pi-autoresearch/leader", c1]);

    const runner = realRunner(dir);
    const res2 = await M.promoteLeader(runner, {
      runner,
      repoDir: dir,
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: c1,
      newSha: c2,
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.promoted, true);
    const leader = (await git(dir, ["rev-parse", "refs/pi-autoresearch/leader"])).trim();
    assert.equal(leader, c2, "leader ref must now point at c2");
  });
});

test("promoteLeader CAS mismatch on a real git repo leaves the leader unchanged", async () => {
  await withDir(async (dir) => {
    await git(dir, ["init", "-q"]);
    await git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "c1"]);
    const c1 = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "c2"]);
    const c2 = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["update-ref", "refs/pi-autoresearch/leader", c1]);

    const runner = realRunner(dir);
    const res = await M.promoteLeader(runner, {
      runner,
      repoDir: dir,
      leaderRef: "refs/pi-autoresearch/leader",
      expectedSha: c2, // wrong expected value — the ref actually points at c1
      newSha: c1,
    });
    assertRefusal(res, "leader_moved");
    const leader = (await git(dir, ["rev-parse", "refs/pi-autoresearch/leader"])).trim();
    assert.equal(leader, c1, "leader ref must still point at c1");
  });
});

test("runChecks exit 0 passes; non-zero and killed refuse", async () => {
  assert.deepEqual(await M.runChecks(okRunner(), { dir: "d", argv: ["node", "checks.js"], timeoutMs: 100 }), { ok: true });
  assertRefusal(
    await M.runChecks(failingChecksRunner(), { dir: "d", argv: ["node", "checks.js"], timeoutMs: 100 }),
    "checks_failed",
  );
  const killed = async () => ({ code: 1, stdout: "", stderr: "", killed: true });
  assertRefusal(await M.runChecks(killed, { dir: "d", argv: ["node", "checks.js"], timeoutMs: 100 }), "timeout");
});
