/**
 * candidate-state (openspec/changes/candidate-branches, task
 * pi-autoresearch-3e4.4.3.1): standalone campaign state, one active candidate,
 * exclusive lock, pending-operation marker, budgets and operator actions.
 *
 * Every test runs in its own temporary directory. Refusals are checked
 * against a byte-level snapshot of the campaign directory, so a refused
 * transition must leave every file untouched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as S from "../extensions/pi-autoresearch/candidate-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A budget policy with the fields this module reads, plus a non-budget field. */
function policy(overrides = {}) {
  return {
    metric_name: "p95_latency_ms",
    candidate_step_limit: 3,
    candidate_time_limit_seconds: 100,
    benchmark_argv: ["node", "bench.js"],
    ...overrides,
  };
}

/** Runs fn with a fresh campaign directory path (not yet created). */
async function withDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "candidate-state-"));
  try {
    await fn(join(root, "candidate"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Byte-level snapshot of every file in the campaign directory. */
async function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of (await readdir(dir)).sort()) {
    out[name] = await readFile(join(dir, name), "utf8");
  }
  return out;
}

function assertRefusal(result, reason) {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason);
  assert.equal(/[\r\n]/.test(result.message), false, "refusal message must be one line");
}

function candidateOf(state, id) {
  return state.candidates.find((c) => c.id === id);
}

async function initOk(dir, overrides) {
  const r = await S.initCampaign(dir, policy(overrides));
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

// ─── Init and policy immutability ────────────────────────────────────────────

test("init writes a state file and refuses to overwrite it (policy is fixed)", async () => {
  await withDir(async (dir) => {
    const first = await initOk(dir);
    assert.equal(first.state.schema_version, 1);
    assert.equal(first.state.disabled, false);
    assert.deepEqual(first.state.candidates, []);

    const before = await snapshot(dir);
    const second = await S.initCampaign(dir, policy({ candidate_step_limit: 99 }));
    assertRefusal(second, "already_initialized");
    assert.deepEqual(await snapshot(dir), before, "second init must not rewrite state or policy");
  });
});

test("init rejects invalid budget fields before creating anything", async () => {
  const bad = [
    { candidate_step_limit: 0 },
    { candidate_step_limit: 1.5 },
    { candidate_step_limit: Number.NaN },
    { candidate_time_limit_seconds: 0 },
    { candidate_time_limit_seconds: -1 },
    { candidate_time_limit_seconds: Number.POSITIVE_INFINITY },
    { candidate_time_limit_seconds: "10" },
  ];
  for (const overrides of bad) {
    await withDir(async (dir) => {
      const r = await S.initCampaign(dir, policy(overrides));
      assertRefusal(r, "invalid_argument");
      assert.equal(existsSync(dir), false, `no directory expected for ${JSON.stringify(overrides)}`);
    });
  }
});

test("init stores a copy of the policy: later caller mutation does not change state", async () => {
  await withDir(async (dir) => {
    const p = policy();
    await S.initCampaign(dir, p);
    p.candidate_step_limit = 1000;
    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.state.policy.candidate_step_limit, 3);
  });
});

test("operations on an uninitialized directory refuse and create nothing", async () => {
  await withDir(async (dir) => {
    assertRefusal(await S.createCandidate(dir, "cand-a"), "not_initialized");
    assert.equal(existsSync(dir), false);
    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "uninitialized");
  });
});

// ─── Normal cycle and state machine ──────────────────────────────────────────

test("standard cycle: create, checkpoint, pause, resume, select, close (checkpoints survive)", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    assert.equal((await S.createCandidate(dir, "cand-a")).ok, true);
    assert.equal((await S.recordCheckpoint(dir, "cand-a", "cp1")).ok, true);
    assert.equal((await S.pauseCandidate(dir, "cand-a")).ok, true);

    assert.equal((await S.createCandidate(dir, "cand-b")).ok, true);
    // A regressive checkpoint on the second candidate is allowed.
    assert.equal((await S.recordCheckpoint(dir, "cand-b", "cp2")).ok, true);
    assert.equal((await S.pauseCandidate(dir, "cand-b")).ok, true);

    assert.equal((await S.resumeCandidate(dir, "cand-a")).ok, true);
    assert.equal((await S.selectCheckpoint(dir, "cand-a", "cp1")).ok, true);
    assert.equal((await S.closeCandidate(dir, "cand-a")).ok, true);

    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "ready");
    assert.equal(insp.lockPresent, false, "lock must be released after every operation");
    assert.equal(insp.pendingOp, null);
    const a = candidateOf(insp.state, "cand-a");
    const b = candidateOf(insp.state, "cand-b");
    assert.equal(a.status, "closed");
    assert.deepEqual(a.checkpoints, ["cp1"], "closing must not delete checkpoints");
    assert.equal(a.selected_checkpoint, "cp1");
    assert.equal(b.status, "paused");
    assert.deepEqual(b.checkpoints, ["cp2"]);
  });
});

test("a second active candidate is refused and no file changes", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    const before = await snapshot(dir);
    assertRefusal(await S.createCandidate(dir, "cand-b"), "second_active_candidate");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("resuming a candidate while another is active is refused and no file changes", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.pauseCandidate(dir, "cand-a");
    await S.createCandidate(dir, "cand-b");
    const before = await snapshot(dir);
    assertRefusal(await S.resumeCandidate(dir, "cand-a"), "second_active_candidate");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("forbidden transitions on closed and inactive candidates are refused without changes", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");
    await S.closeCandidate(dir, "cand-a");
    const before = await snapshot(dir);

    assertRefusal(await S.resumeCandidate(dir, "cand-a"), "candidate_closed");
    assertRefusal(await S.closeCandidate(dir, "cand-a"), "candidate_closed");
    assertRefusal(await S.selectCheckpoint(dir, "cand-a", "cp1"), "candidate_closed");
    assertRefusal(await S.recordCheckpoint(dir, "cand-a", "cp2"), "candidate_not_active");
    assertRefusal(await S.pauseCandidate(dir, "cand-a"), "candidate_not_active");
    assertRefusal(await S.pauseCandidate(dir, "cand-missing"), "unknown_candidate");
    assertRefusal(await S.createCandidate(dir, "cand-a"), "duplicate_candidate");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("select refuses another candidate's checkpoint; checkpoint ids stay unique campaign-wide", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");
    await S.pauseCandidate(dir, "cand-a");
    await S.createCandidate(dir, "cand-b");
    await S.pauseCandidate(dir, "cand-b");

    const before = await snapshot(dir);
    assertRefusal(await S.selectCheckpoint(dir, "cand-b", "cp1"), "checkpoint_not_owned");
    assert.deepEqual(await snapshot(dir), before);

    // The same checkpoint id cannot be saved by a second candidate.
    await S.resumeCandidate(dir, "cand-b");
    assertRefusal(await S.recordCheckpoint(dir, "cand-b", "cp1"), "duplicate_checkpoint");
  });
});

test("invalid candidate and checkpoint ids are refused before any file access", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    const before = await snapshot(dir);
    assertRefusal(await S.createCandidate(dir, "../escape"), "invalid_argument");
    assertRefusal(await S.createCandidate(dir, "bad\nid"), "invalid_argument");
    assertRefusal(await S.createCandidate(dir, ""), "invalid_argument");
    await S.createCandidate(dir, "cand-a");
    const after = await snapshot(dir);
    assertRefusal(await S.recordCheckpoint(dir, "cand-a", "cp 1"), "invalid_argument");
    assert.deepEqual(await snapshot(dir), after);
    assert.notDeepEqual(before, after, "the valid create is expected to change state");
  });
});

// ─── Lock ────────────────────────────────────────────────────────────────────

test("a busy lock refuses the operation and the lock file is left as it was", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await writeFile(
      join(dir, "lock.json"),
      JSON.stringify({ pid: 999999, acquired_at: "2026-01-01T00:00:00.000Z" }),
    );
    const before = await snapshot(dir);
    assertRefusal(await S.createCandidate(dir, "cand-a"), "lock_busy");
    assert.deepEqual(await snapshot(dir), before);
    assert.equal(existsSync(join(dir, "lock.json")), true, "a busy lock must not be taken over");
  });
});

test("an unreadable lock refuses the operation; only the operator can clear it", async () => {
  for (const content of ["garbage{", ""]) {
    await withDir(async (dir) => {
      await initOk(dir);
      await writeFile(join(dir, "lock.json"), content);
      const before = await snapshot(dir);
      assertRefusal(await S.createCandidate(dir, "cand-a"), "lock_unreadable");
      assert.deepEqual(await snapshot(dir), before);

      // Without the token nothing is cleared.
      assertRefusal(await S.manualClearLock(dir, "yes"), "invalid_argument");
      assertRefusal(await S.manualClearLock(dir, true), "invalid_argument");
      assert.equal(existsSync(join(dir, "lock.json")), true);

      const cleared = await S.manualClearLock(dir, S.OPERATOR_CONFIRMATION);
      assert.equal(cleared.ok, true);
      assert.equal(existsSync(join(dir, "lock.json")), false);
      assert.equal((await S.createCandidate(dir, "cand-a")).ok, true);
    });
  }
});

test("the lock is released after a successful operation and after a refusal", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    assert.equal(existsSync(join(dir, "lock.json")), false);
    assertRefusal(await S.createCandidate(dir, "cand-b"), "second_active_candidate");
    assert.equal(existsSync(join(dir, "lock.json")), false);
  });
});

test("manualClearLock is a no-op when no lock is present", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    const r = await S.manualClearLock(dir, S.OPERATOR_CONFIRMATION);
    assert.equal(r.ok, true);
    assert.equal(r.message, "no lock was present");
  });
});

// ─── Pending operation marker ────────────────────────────────────────────────

test("interrupted switch leaves a marker: every later operation needs a manual check", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");
    await S.pauseCandidate(dir, "cand-a");
    const stateBefore = await readFile(join(dir, "state.json"), "utf8");

    // Simulate a failing Git switch: the state write must not happen.
    const failed = await S.resumeCandidate(dir, "cand-a", async () => {
      throw new Error("git worktree add failed");
    });
    assertRefusal(failed, "operation_failed");
    assert.equal(failed.message.includes("git worktree add failed"), true);
    assert.equal(await readFile(join(dir, "state.json"), "utf8"), stateBefore, "state must not change on a failed switch");
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "marker must stay after an unknown outcome");

    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "manual_check_required");
    assert.equal(insp.pendingOp.name, "resume cand-a");
    assert.equal(insp.lockPresent, false);

    const before = await snapshot(dir);
    assertRefusal(await S.createCandidate(dir, "cand-b"), "manual_check_required");
    assertRefusal(await S.pauseCandidate(dir, "cand-a"), "manual_check_required");
    assertRefusal(await S.resumeCandidate(dir, "cand-a"), "manual_check_required");
    assertRefusal(await S.recordCheckpoint(dir, "cand-a", "cp2"), "manual_check_required");
    assertRefusal(await S.disableCampaign(dir), "manual_check_required");
    assertRefusal(
      await S.runCandidateMeasurement(dir, "cand-a", async () => {
        throw new Error("must not run");
      }),
      "manual_check_required",
    );
    assert.deepEqual(await snapshot(dir), before, "blocked operations must not touch any file");

    assertRefusal(await S.manualResolvePendingOp(dir, "yes"), "invalid_argument");
    assert.equal(existsSync(join(dir, "pending-op.json")), true);

    const resolved = await S.manualResolvePendingOp(dir, S.OPERATOR_CONFIRMATION);
    assert.equal(resolved.ok, true);
    assert.equal(existsSync(join(dir, "pending-op.json")), false);
    assert.equal((await S.resumeCandidate(dir, "cand-a")).ok, true);
  });
});

test("pending-op refusal stays single-line even when the marker's started_at is corrupted with newlines", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.pauseCandidate(dir, "cand-a");

    // Simulate a tampered/corrupted marker: a raw LF plus forged text inside started_at.
    const tampered = JSON.stringify({ name: "resume cand-a", started_at: "2026-01-01T00:00:00Z\nINJECTED-LINE\r\u001b[31mred" });
    await writeFile(join(dir, "pending-op.json"), tampered, "utf8");

    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "manual_check_required");
    const refusal = insp.pendingOp ? insp.pendingOp.started_at : "";
    assert.equal(refusal.includes("\n"), true, "tampered marker itself keeps the raw newline (read side)");

    const blocked = await S.createCandidate(dir, "cand-b");
    assertRefusal(blocked, "manual_check_required");
    // The message must be one line: no raw control characters survive into the shown text.
    assert.equal(/[\n\r\u0000-\u001f\u007f]/.test(blocked.message), false, "refusal message must contain no raw control chars");
    // The injected text must not appear as its own line; it stays escaped inline.
    assert.equal(blocked.message.includes("INJECTED-LINE"), true, "escaped content stays honest and inline");
    // Tampering must not resolve anything: files unchanged.
    assert.equal(existsSync(join(dir, "pending-op.json")), true);
  });
});

test("manualResolvePendingOp refuses when no operation is pending", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    assertRefusal(await S.manualResolvePendingOp(dir, S.OPERATOR_CONFIRMATION), "invalid_transition");
  });
});

test("beginOperation holds the marker while work runs and clears it on success", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    let nested;
    let nestedDisable;
    const r = await S.beginOperation(dir, "git checkout", async () => {
      const insp = await S.inspectCampaign(dir);
      assert.equal(insp.status, "manual_check_required");
      assert.equal(insp.pendingOp.name, "git checkout");
      assert.equal(insp.lockPresent, true);
      // Any operation started from inside the work sees the held lock.
      nested = await S.pauseCandidate(dir, "cand-a");
      nestedDisable = await S.disableCampaign(dir);
    });
    assert.equal(r.ok, true);
    assertRefusal(nested, "lock_busy");
    assertRefusal(nestedDisable, "lock_busy");

    const after = await S.inspectCampaign(dir);
    assert.equal(after.status, "ready");
    assert.equal(after.pendingOp, null);
    assert.equal(after.state.disabled, false, "a refused disable must not change state");
  });
});

test("beginOperation with failing work keeps the marker and changes no state", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    const before = await snapshot(dir);
    const r = await S.beginOperation(dir, "git reset", async () => {
      throw new Error("boom");
    });
    assertRefusal(r, "operation_failed");
    const after = await snapshot(dir);
    assert.equal(after["state.json"], before["state.json"]);
    assert.equal(existsSync(join(dir, "pending-op.json")), true);
  });
});

// ─── Budgets and runs ────────────────────────────────────────────────────────

test("step budget refuses new runs when exhausted; checkpoints stay available", async () => {
  await withDir(async (dir) => {
    await initOk(dir, { candidate_step_limit: 2, candidate_time_limit_seconds: 100 });
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");

    let calls = 0;
    const measure = async () => {
      calls++;
      return { seconds: 1 };
    };
    assert.equal((await S.runCandidateMeasurement(dir, "cand-a", measure)).ok, true);
    assert.equal((await S.runCandidateMeasurement(dir, "cand-a", measure)).ok, true);
    assert.equal(calls, 2);

    const before = await snapshot(dir);
    assertRefusal(await S.runCandidateMeasurement(dir, "cand-a", measure), "budget_exhausted");
    assert.equal(calls, 2, "a refused run must not start measurement");
    assert.deepEqual(await snapshot(dir), before);

    // The checkpoint is still usable after the budget ran out.
    assert.equal((await S.selectCheckpoint(dir, "cand-a", "cp1")).ok, true);
    const insp = await S.inspectCampaign(dir);
    assert.deepEqual(candidateOf(insp.state, "cand-a").checkpoints, ["cp1"]);
    assert.equal(candidateOf(insp.state, "cand-a").steps_used, 2);
  });
});

test("time budget refuses new runs once the measured seconds reach the limit", async () => {
  await withDir(async (dir) => {
    await initOk(dir, { candidate_step_limit: 10, candidate_time_limit_seconds: 5 });
    await S.createCandidate(dir, "cand-a");
    assert.equal((await S.runCandidateMeasurement(dir, "cand-a", async () => ({ seconds: 5 }))).ok, true);
    assertRefusal(
      await S.runCandidateMeasurement(dir, "cand-a", async () => ({ seconds: 1 })),
      "budget_exhausted",
    );
    const insp = await S.inspectCampaign(dir);
    assert.equal(candidateOf(insp.state, "cand-a").time_used_seconds, 5);
    assert.equal(candidateOf(insp.state, "cand-a").steps_used, 1);
  });
});

test("a paused candidate cannot run and its measurement is never started", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.pauseCandidate(dir, "cand-a");
    let called = false;
    assertRefusal(
      await S.runCandidateMeasurement(dir, "cand-a", async () => {
        called = true;
        return { seconds: 1 };
      }),
      "candidate_not_active",
    );
    assert.equal(called, false);
  });
});

test("a failing measurement keeps the marker and the already-counted step", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    const r = await S.runCandidateMeasurement(dir, "cand-a", async () => {
      throw new Error("bench crashed");
    });
    assertRefusal(r, "operation_failed");
    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "manual_check_required");
    assert.equal(insp.pendingOp.name, "run cand-a");
    assert.equal(candidateOf(insp.state, "cand-a").steps_used, 1);
    assert.equal(candidateOf(insp.state, "cand-a").time_used_seconds, 0);
  });
});

test("a measurement returning invalid seconds fails closed with the marker kept", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    assertRefusal(
      await S.runCandidateMeasurement(dir, "cand-a", async () => ({ seconds: Number.NaN })),
      "operation_failed",
    );
    assert.equal(existsSync(join(dir, "pending-op.json")), true);
  });
});

// ─── Disable ─────────────────────────────────────────────────────────────────

test("disable blocks later operations, keeps refs and checkpoints, and is not repeatable", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");

    const r = await S.disableCampaign(dir);
    assert.equal(r.ok, true);
    assert.equal(r.state.disabled, true);

    const before = await snapshot(dir);
    assertRefusal(await S.createCandidate(dir, "cand-b"), "campaign_disabled");
    assertRefusal(await S.pauseCandidate(dir, "cand-a"), "campaign_disabled");
    assertRefusal(
      await S.runCandidateMeasurement(dir, "cand-a", async () => ({ seconds: 1 })),
      "campaign_disabled",
    );
    assertRefusal(await S.disableCampaign(dir), "invalid_transition");
    assert.deepEqual(await snapshot(dir), before);

    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "disabled");
    assert.deepEqual(candidateOf(insp.state, "cand-a").checkpoints, ["cp1"]);
  });
});

// ─── Atomic writes and corrupt state ─────────────────────────────────────────

test("a leftover temporary file from a crashed write is ignored; the old state stays readable", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    // Simulate a crash between writing the temp file and renaming it.
    await writeFile(join(dir, "state.json.4242.deadbeef.tmp"), '{"schema_version":1,"created_at"');

    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "ready");
    assert.equal(candidateOf(insp.state, "cand-a").status, "active");

    await S.pauseCandidate(dir, "cand-a");
    assert.equal((await S.createCandidate(dir, "cand-b")).ok, true);
    const after = await S.inspectCampaign(dir);
    assert.deepEqual(after.state.candidates.map((c) => c.id), ["cand-a", "cand-b"]);
  });
});

test("corrupt or invalid state refuses every operation and changes no file", async () => {
  const corrupt = [
    "{not json",
    JSON.stringify({ schema_version: 2 }),
    JSON.stringify({
      schema_version: 1,
      created_at: "t",
      disabled: false,
      policy: policy(),
      candidates: [
        { id: "a", status: "active", steps_used: 0, time_used_seconds: 0, checkpoints: [], selected_checkpoint: null },
        { id: "b", status: "active", steps_used: 0, time_used_seconds: 0, checkpoints: [], selected_checkpoint: null },
      ],
    }),
  ];
  for (const content of corrupt) {
    await withDir(async (dir) => {
      await initOk(dir);
      await writeFile(join(dir, "state.json"), content);
      const before = await snapshot(dir);
      assertRefusal(await S.createCandidate(dir, "cand-x"), "state_unreadable");
      assertRefusal(await S.disableCampaign(dir), "state_unreadable");
      assert.deepEqual(await snapshot(dir), before);
      const insp = await S.inspectCampaign(dir);
      assert.equal(insp.status, "state_unreadable");
    });
  }
});

test("inspectCampaign writes nothing and reports the lock state", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    const before = await snapshot(dir);
    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "ready");
    assert.equal(insp.lockPresent, false);
    assert.deepEqual(await snapshot(dir), before);
  });
});

// ─── checkpointUnderMarker (one-marker checkpoint primitive) ─────────────────

test("checkpointUnderMarker: work result lands in state under one marker, marker cleared on success", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    const r = await S.checkpointUnderMarker(dir, "cand-a", async () => ({ checkpointId: "abc123" }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state.candidates[0].checkpoints.includes("abc123"), true);
    assert.equal(r.state.candidates[0].selected_checkpoint, "abc123");
    assert.equal(existsSync(join(dir, "pending-op.json")), false, "marker must be cleared on success");
  });
});

test("checkpointUnderMarker: work throw after side effects keeps the marker => manual_check_required", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    const stateBefore = await readFile(join(dir, "state.json"), "utf8");
    // Simulate the crash window: the git work "succeeded" (side effects done
    // by the caller) but work() throws before returning the checkpoint id.
    const r = await S.checkpointUnderMarker(dir, "cand-a", async () => {
      await writeFile(join(dir, "side-effect.txt"), "git commit landed");
      throw new Error("state write exploded mid-flight");
    });
    assertRefusal(r, "operation_failed");
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "marker must remain after a work throw");
    assert.equal(existsSync(join(dir, "side-effect.txt")), true, "side effects are not rolled back (fail-closed)");
    // Every later operation reports manual_check_required, not state_unreadable.
    assertRefusal(await S.createCandidate(dir, "cand-b"), "manual_check_required");
    assertRefusal(await S.recordCheckpoint(dir, "cand-a", "cp2"), "manual_check_required");
    // Operator resolution clears the marker; state is untouched.
    assert.equal(await readFile(join(dir, "state.json"), "utf8"), stateBefore, "state bytes must be unchanged");
    const resolved = await S.manualResolvePendingOp(dir, S.OPERATOR_CONFIRMATION);
    assert.equal(resolved.ok, true);
    assert.equal(existsSync(join(dir, "pending-op.json")), false);
    // Campaign is consistent again: the checkpoint id from the failed call is
    // NOT in state (the row was never written) — the operator decides.
    const insp = await S.inspectCampaign(dir);
    assert.equal(insp.status, "ready");
  });
});

test("checkpointUnderMarker: refusal after successful work keeps the marker (duplicate id)", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    const first = await S.checkpointUnderMarker(dir, "cand-a", async () => ({ checkpointId: "dup1" }));
    assert.equal(first.ok, true);
    const r = await S.checkpointUnderMarker(dir, "cand-a", async () => ({ checkpointId: "dup1" }));
    assertRefusal(r, "duplicate_checkpoint");
    // The refusal was discovered AFTER work ran (post-decide) — marker stays.
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "post-work refusal must keep the marker (fail-closed)");
    await S.manualResolvePendingOp(dir, S.OPERATOR_CONFIRMATION);
  });
});

test("checkpointUnderMarker: pre-flight refusal (not active) touches nothing", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.pauseCandidate(dir, "cand-a");
    const before = await snapshot(dir);
    const r = await S.checkpointUnderMarker(dir, "cand-a", async () => {
      throw new Error("work must not run");
    });
    assertRefusal(r, "candidate_not_active");
    assert.deepEqual(await snapshot(dir), before, "pre-flight refusal must not touch any file");
  });
});

// ─── registerOrphanCheckpoint (review F4) ────────────────────────────────────

async function crashedMarker(dir) {
  // Create a candidate, then leave a checkpoint marker as if the commit+ref
  // succeeded and the state write never happened.
  await initOk(dir);
  await S.createCandidate(dir, "cand-a");
  await writeFile(join(dir, "pending-op.json"), JSON.stringify({ name: "checkpoint cand-a", started_at: new Date().toISOString() }), "utf8");
}

const SHA_X = "a".repeat(40);
const SHA_Y = "b".repeat(40);

test("registerOrphanCheckpoint: wrong pending-op name refuses and changes nothing", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await writeFile(join(dir, "pending-op.json"), JSON.stringify({ name: "resume cand-a", started_at: "x" }), "utf8");
    const before = await snapshot(dir);
    assertRefusal(await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {}), "invalid_transition");
    assert.deepEqual(await snapshot(dir), before, "bytes must not change");
  });
});

test("registerOrphanCheckpoint: disabled campaign refuses and keeps the marker", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    st.disabled = true;
    await writeFile(join(dir, "state.json"), JSON.stringify(st, null, 2), "utf8");
    assertRefusal(await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {}), "campaign_disabled");
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "marker must stay");
  });
});

test("registerOrphanCheckpoint: non-active candidate refuses and keeps the marker", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    st.candidates[0].status = "paused";
    await writeFile(join(dir, "state.json"), JSON.stringify(st, null, 2), "utf8");
    assertRefusal(await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {}), "candidate_not_active");
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "marker must stay");
  });
});

test("registerOrphanCheckpoint: verify refusal returns the refusal and keeps the marker and state bytes", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    const before = await snapshot(dir);
    const res = await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {
      throw new S.CleanRefusal("operation_failed", "ref moved");
    });
    assert.equal(res.ok, false);
    assert.deepEqual(await snapshot(dir), before, "bytes must not change on verify refusal");
  });
});

test("registerOrphanCheckpoint: success registers the checkpoint, selects it and clears the marker", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    const res = await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {});
    assert.equal(res.ok, true, JSON.stringify(res));
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    assert.deepEqual(st.candidates[0].checkpoints, [SHA_X]);
    assert.equal(st.candidates[0].selected_checkpoint, SHA_X);
    assert.equal(existsSync(join(dir, "pending-op.json")), false, "marker must be cleared");
    assert.equal((await S.inspectCampaign(dir)).status, "ready");
  });
});

test("registerOrphanCheckpoint: duplicate checkpoint refuses without calling verify", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    assert.equal((await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => {})).ok, true);
    await writeFile(join(dir, "pending-op.json"), JSON.stringify({ name: "checkpoint cand-a", started_at: "x" }), "utf8");
    let called = false;
    assertRefusal(
      await S.registerOrphanCheckpoint(dir, "cand-a", SHA_X, async () => { called = true; }),
      "duplicate_checkpoint",
    );
    assert.equal(called, false, "verify must not run for a duplicate");
    assert.equal(existsSync(join(dir, "pending-op.json")), true, "marker must stay");
  });
});

test("registerOrphanCheckpoint: malformed sha is refused as invalid argument", async () => {
  await withDir(async (dir) => {
    await crashedMarker(dir);
    const res = await S.registerOrphanCheckpoint(dir, "cand-a", "not-a-sha!", async () => {});
    assert.equal(res.ok, false);
  });
});

test("pause switches the active candidate after a clean pause; forbidden resume of a closed candidate refuses", async () => {
  await withDir(async (dir) => {
    await initOk(dir);
    await S.createCandidate(dir, "cand-a");
    await S.recordCheckpoint(dir, "cand-a", "cp1");
    // pause: switches the active candidate without touching checkpoint bytes.
    const paused = await S.pauseCandidate(dir, "cand-a");
    assert.equal(paused.ok, true, JSON.stringify(paused));
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    const a = st.candidates.find((c) => c.id === "cand-a");
    assert.equal(a.status, "paused");
    assert.deepEqual(a.checkpoints, ["cp1"], "checkpoints survive a pause");
    await S.createCandidate(dir, "cand-b");
    assert.equal((await S.resumeCandidate(dir, "cand-a")).ok, false, "resume while another is active must refuse");
  });
});
