/**
 * bd pi-autoresearch-tj0.7: confirm captures the leader SHA, measurement epoch
 * and methodology hashes before candidateState.beginOperation takes the
 * campaign lock. Another writer can move those preconditions in that window.
 *
 * These tests make the race deterministic: the SECOND read of a precondition
 * is confirm's re-validation inside the locked callback, and a racing writer
 * changes one field exactly at that instant. The old code never reads twice,
 * so it promotes with the stale capture and every race test fails. A control
 * test (no racing writer) proves the harness itself can still promote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { executeCandidateBranchAction } from "../extensions/pi-autoresearch/candidate-campaign.ts";
import * as candidateState from "../extensions/pi-autoresearch/candidate-state.ts";

const LEADER_REF = "refs/pi-autoresearch/campaign-leader";
const LEADER = "1".repeat(40);
const CHECKPOINT = "2".repeat(40);
const MOVED_LEADER = "3".repeat(40);
const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);
const EPOCH_V1 = "epoch-1";
const EPOCH_V2 = "epoch-2";
const METHOD_PATH = "METHOD.md";
const CHANGED_LABEL = { leader: "leader ref", epoch: "measurement epoch", methodology: "methodology hashes" };

function campaignPolicy() {
  return {
    metric_name: "p95_ms",
    direction: "higher",
    repeats: 1,
    min_gain: 0.1,
    benchmark_argv: ["node", "-e", "console.log('METRIC p95_ms=1')"],
    checks_argv: ["node", "-e", "process.exit(0)"],
    benchmark_timeout_seconds: 30,
    confirm_budget_seconds: 120,
    candidate_step_limit: 5,
    candidate_time_limit_seconds: 600,
    methodology_files: [{ path: METHOD_PATH, sha256: HASH_V1 }],
  };
}

async function setupCampaign() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-confirm-pre-"));
  const workDir = path.join(root, "repo");
  const campDir = path.join(workDir, ".auto", "candidate");
  const init = await candidateState.initCampaign(campDir, campaignPolicy());
  assert.equal(init.ok, true, `init failed: ${JSON.stringify(init)}`);
  const created = await candidateState.createCandidate(campDir, "cand-a");
  assert.equal(created.ok, true, `create failed: ${JSON.stringify(created)}`);
  const cp = await candidateState.recordCheckpoint(campDir, "cand-a", CHECKPOINT);
  assert.equal(cp.ok, true, `checkpoint failed: ${JSON.stringify(cp)}`);
  return { root, workDir, campDir };
}

/**
 * Runs confirm with injected precondition readers. `raceField` names the
 * field a simulated concurrent writer changes on its second read (the locked
 * re-validation); null runs the control with no writer.
 */
async function runConfirm({ raceField = null } = {}) {
  const { root, workDir, campDir } = await setupCampaign();
  const world = { leader: LEADER, epoch: EPOCH_V1, methodHash: HASH_V1 };
  const reads = { leader: 0, epoch: 0, methodology: 0 };
  // A locked re-validation runs after beginOperation has taken the lock and
  // written the pending-op marker. Recording that at the second read proves
  // the check is inside the operation, not in the pre-capture window.
  const lockedSecondRead = { leader: false, epoch: false, methodology: false };
  const execCalls = [];
  let mutations = 0;

  const onSecondRead = (field, mutate) => {
    reads[field] += 1;
    if (reads[field] === 2) {
      lockedSecondRead[field] = fs.existsSync(path.join(campDir, candidateState.PENDING_OP_FILE))
        && fs.existsSync(path.join(campDir, candidateState.LOCK_FILE));
    }
    if (raceField === field && reads[field] === 2) {
      mutate();
      mutations += 1;
    }
  };

  const deps = {
    campaignDirOf: () => campDir,
    fullShaOf: async (_workDir, ref) => {
      assert.equal(ref, LEADER_REF, "confirm must read the campaign leader ref");
      onSecondRead("leader", () => { world.leader = MOVED_LEADER; });
      return world.leader;
    },
    LEADER_REF,
    activeCandidateOf: (state) => state?.candidates.find((c) => c.status === "active") ?? null,
    getRuntime: (ctx) => (ctx.confirmTestRuntime ??= {}),
    candidateGitExec: async () => ({ code: 0, stdout: "", stderr: "" }),
    hashMethodologyBlob: async () => HASH_V1,
    requestCandidatePolicyConsent: async () => ({ ok: false }),
    gitOut: async () => "",
    candidateWtRootOf: () => path.join(root, "wts"),
    measurementScaleStatusOfDir: () => {
      onSecondRead("epoch", () => { world.epoch = EPOCH_V2; });
      return { epoch: world.epoch };
    },
    hashMethodologyAtCommit: async () => {
      onSecondRead("methodology", () => { world.methodHash = HASH_V2; });
      return { ok: true, hashes: [{ path: METHOD_PATH, sha256: world.methodHash }] };
    },
    candidateExecRunner: async (argv) => {
      execCalls.push(argv.slice());
      // compareForPromotion re-proves the checks worktree HEAD (the checkpoint).
      if (argv[0] === "git" && argv[1] === "rev-parse" && argv[3] === "HEAD") {
        return { code: 0, stdout: `${CHECKPOINT}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    measureSideInEphemeral: async (_ctx, _workDir, label) => ({
      ok: true,
      average: label === "leader" ? 100 : 120,
      wtPath: path.join(root, `ephemeral-${label}`),
    }),
    removeEphemeralWorktree: async () => ({ removed: true }),
    cancelSubagentDeferral: () => {},
  };

  try {
    const result = await executeCandidateBranchAction({ action: "confirm" }, {}, workDir, deps);
    const promotions = execCalls.filter((argv) => argv[1] === "update-ref");
    // Snapshot before the finally block removes root — otherwise the marker
    // assertions below inspect a deleted directory and are always true.
    return {
      result, reads, mutations, promotions, campDir, lockedSecondRead,
      pendingMarkerPresent: fs.existsSync(path.join(campDir, candidateState.PENDING_OP_FILE)),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function textOf(result) {
  return result?.content?.[0]?.text ?? "";
}

test("control: unchanged preconditions still promote exactly once", async () => {
  const { result, reads, mutations, promotions, campDir, lockedSecondRead, pendingMarkerPresent } = await runConfirm();
  assert.equal(mutations, 0, "control must not simulate a racing writer");
  assert.deepEqual(reads, { leader: 2, epoch: 2, methodology: 2 },
    "even an unchanged campaign must be re-validated under the lock");
  assert.deepEqual(lockedSecondRead, { leader: true, epoch: true, methodology: true },
    "the second read of every precondition must happen under the campaign lock");
  assert.match(textOf(result), /PROMOTED/, `control must promote: ${textOf(result)}`);
  assert.equal(promotions.length, 1, "control must issue exactly one CAS promotion");
  assert.equal(pendingMarkerPresent, false, "no pending op after a successful confirm");
});

for (const field of ["leader", "epoch", "methodology"]) {
  test(`confirm refuses when ${field} changes between capture and the locked callback`, async () => {
    const { result, reads, mutations, promotions, campDir, lockedSecondRead, pendingMarkerPresent } = await runConfirm({ raceField: field });
    assert.equal(result?.details?.reason, "preconditions_changed",
      `expected a specific refusal (old code promotes with stale values), got ${JSON.stringify(result?.details)}`);
    assert.match(textOf(result), /⛔ preconditions_changed:/, `unexpected reply: ${textOf(result)}`);
    assert.match(textOf(result), /nothing was promoted/, `refusal message was lost: ${textOf(result)}`);
    assert.match(textOf(result), new RegExp(CHANGED_LABEL[field]), `refusal must name the changed precondition: ${textOf(result)}`);
    assert.equal(result?.details?.promoted, false, "a precondition refusal must not report a promotion");
    assert.equal(/PROMOTED/.test(textOf(result)), false, "no stale precondition may be promoted");
    assert.deepEqual(promotions, [], "no CAS promotion may be attempted after a precondition change");
    assert.equal(mutations, 1, `the racing writer must fire once for ${field}`);
    assert.deepEqual(reads, { leader: 2, epoch: 2, methodology: 2 },
      "confirm must re-read all three preconditions inside the locked callback");
    assert.deepEqual(lockedSecondRead, { leader: true, epoch: true, methodology: true },
      "confirm must re-read all three preconditions under the campaign lock");
    assert.equal(pendingMarkerPresent, false,
      "a known precondition refusal must clear the pending-op marker");
  });
}
