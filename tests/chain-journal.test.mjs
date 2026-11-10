/**
 * chain-journal (openspec/changes/research-charter, tasks 3.1-3.4):
 * append-only chain journal with a prev_hash chain, an external head anchor,
 * chain statuses and the status-based action gate.
 *
 * Every test runs in its own temporary work directory. The chain directory
 * lives at <workDir>/.auto/research-chain/<id>/ — OUTSIDE the campaign root
 * (.auto/research), so archiving campaigns never moves the journal.
 *
 * chain.json is JSON Lines: one JSON object per line, exactly as serialized
 * (no internal newlines). prev_hash of the first entry is the empty string;
 * prev_hash of entry N is sha256 of the exact line text of entry N-1.
 * chain-head holds sha256 of the last line and is verified on every action.
 *
 * Run: timeout 60 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/chain-journal.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHAIN_FILE,
  CHAIN_STATUSES,
  HEAD_FILE,
  appendEntry,
  actionRefusalForStatus,
  chainRoot,
  createChain,
  headHash,
  isFinal,
  setChainStatus,
  statusOf,
  verifyChain,
} from "../extensions/pi-autoresearch/chain-journal.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Runs fn with a fresh work directory. */
async function withWorkDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "chain-journal-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Creates a chain and returns its directory. */
async function newChain(workDir, chainId = "chain-1") {
  const created = await createChain(workDir, chainId, "c1");
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.dir;
}

function assertRefusal(result, reason) {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason, result.message);
  assert.equal(/[\r\n]/.test(result.message), false, "refusal message must be one line");
}

/** Parses chain.json as JSON Lines. */
async function readLines(dir) {
  const text = await readFile(join(dir, CHAIN_FILE), "utf8");
  return text.split("\n").filter((line) => line !== "");
}

// ─── 3.1 Create, append-only, prev_hash, head ────────────────────────────────

test("createChain creates the chain directory OUTSIDE the campaign root with chain.json and chain-head", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir, "chain-1");
    assert.equal(dir, join(workDir, ".auto", "research-chain", "chain-1"));
    assert.equal(chainRoot(workDir), join(workDir, ".auto", "research-chain"));
    assert.ok(existsSync(join(dir, CHAIN_FILE)), "chain.json exists");
    assert.ok(existsSync(join(dir, HEAD_FILE)), "chain-head exists");
    // The campaign root must stay untouched by chain creation.
    assert.ok(!existsSync(join(workDir, ".auto", "research", "chain-1")), "no chain dir inside the campaign root");
  });
});

test("createChain refuses an existing chain (campaign_exists) and writes a chain_created entry", async () => {
  await withWorkDir(async (workDir) => {
    await newChain(workDir, "chain-1");
    const second = await createChain(workDir, "chain-1", "c1");
    assertRefusal(second, "campaign_exists");
    const lines = await readLines(join(workDir, ".auto", "research-chain", "chain-1"));
    assert.equal(lines.length, 1);
    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "chain_created");
    assert.equal(first.root_campaign_id, "c1");
    assert.equal(first.chain_id, "chain-1", "chain_created records the chain id");
    assert.equal(first.prev_hash, "", "the first entry has an empty prev_hash");
  });
});

test("appendEntry stores prev_hash = sha256 of the previous line and preserves earlier bytes (append-only)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    const before = await readFile(join(dir, CHAIN_FILE), "utf8");
    const first = await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "a".repeat(64) });
    assert.equal(first.ok, true, JSON.stringify(first));
    const after = await readFile(join(dir, CHAIN_FILE), "utf8");
    assert.ok(after.startsWith(before), "append never rewrites earlier bytes");
    const lines = await readLines(dir);
    assert.equal(lines.length, 2);
    const second = JSON.parse(lines[1]);
    assert.equal(second.prev_hash, sha256Hex(lines[0]), "prev_hash is the hash of the previous line text");
    const third = await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "b".repeat(64) });
    assert.equal(third.ok, true, JSON.stringify(third));
    const lines3 = await readLines(dir);
    const thirdEntry = JSON.parse(lines3[2]);
    assert.equal(thirdEntry.prev_hash, sha256Hex(lines3[1]), "the chain links every entry");
  });
});

test("headHash returns the chain-head value; appendEntry updates it to the hash of the new line", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    const lines = await readLines(dir);
    assert.equal((await headHash(dir)).head, sha256Hex(lines[lines.length - 1]));
    await appendEntry(dir, workDir, "chain-1", "brief_rejected", { reason: "caveat_changed", brief_sha256: "c".repeat(64) });
    const lines2 = await readLines(dir);
    assert.equal((await headHash(dir)).head, sha256Hex(lines2[lines2.length - 1]), "head anchors the last line");
  });
});

// ─── 3.2 Damage and absence fail closed with manual_check_required ───────────

test("a tampered chain-head fails verification with manual_check_required", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "a".repeat(64) });
    await writeFile(join(dir, HEAD_FILE), sha256Hex("foreign chain"), "utf8");
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
  });
});

test("a corrupted chain.json (invalid JSON line) fails with manual_check_required", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await writeFile(join(dir, CHAIN_FILE), "{not json}\n", "utf8");
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
  });
});

test("a missing chain.json or chain-head fails with manual_check_required", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await rm(join(dir, CHAIN_FILE));
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
    await newChain(workDir, "chain-2");
    const dir2 = join(workDir, ".auto", "research-chain", "chain-2");
    await rm(join(dir2, HEAD_FILE));
    assertRefusal(await verifyChain(workDir, "chain-2"), "manual_check_required");
  });
});

// ─── 3.3 prev_hash chain recomputation ───────────────────────────────────────

test("a healthy chain verifies; a rewritten entry (head kept) fails", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "a".repeat(64) });
    await appendEntry(dir, workDir, "chain-1", "campaign_created", { campaign_id: "chain-1-c2" });
    assert.equal((await verifyChain(workDir, "chain-1")).ok, true, "healthy chain verifies");

    const lines = await readLines(dir);
    const middle = JSON.parse(lines[1]);
    middle.brief_sha256 = "f".repeat(64); // payload forged, prev_hash and head untouched
    lines[1] = JSON.stringify(middle);
    await writeFile(join(dir, CHAIN_FILE), lines.join("\n") + "\n", "utf8");
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
  });
});

// ─── 3.4 Statuses and the action gate ────────────────────────────────────────

test("CHAIN_STATUSES lists exactly the seven spec statuses; isFinal matches the spec's final set", () => {
  assert.deepEqual([...CHAIN_STATUSES], [
    "active",
    "awaiting_child",
    "limit_reached",
    "stopped_by_owner",
    "stopped_by_rule",
    "manual_check_required",
    "completed",
  ]);
  assert.equal(isFinal("active"), false);
  assert.equal(isFinal("awaiting_child"), false);
  for (const status of ["limit_reached", "stopped_by_owner", "stopped_by_rule", "manual_check_required", "completed"]) {
    assert.equal(isFinal(status), true, `${status} is final`);
  }
});

test("statusOf returns active for a fresh chain and follows setChainStatus (status_change entries)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    assert.equal(await statusOf(workDir, "chain-1"), "active", "the initial status is active");
    await setChainStatus(workDir, "chain-1", "awaiting_child");
    assert.equal(await statusOf(workDir, "chain-1"), "awaiting_child");
    const lines = await readLines(dir);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.type, "status_change");
    assert.equal(last.status, "awaiting_child");
    await setChainStatus(workDir, "chain-1", "completed");
    assert.equal(await statusOf(workDir, "chain-1"), "completed");
  });
});

// ─── Round-2 fix tests (review blockers B1-B5, M1-M2, minors m1-m3) ──────────

test("B1/A: a tampered chain-head refuses WRITES with manual_check_required (no re-anchoring)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "a".repeat(64) });
    await writeFile(join(dir, HEAD_FILE), sha256Hex("foreign chain"), "utf8");
    assertRefusal(await setChainStatus(workDir, "chain-1", "completed"), "manual_check_required");
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "b".repeat(64) }), "manual_check_required");
    // Nothing was written: the journal and the head are unchanged.
    assert.equal(await readFile(join(dir, HEAD_FILE), "utf8"), sha256Hex("foreign chain"));
    assert.equal((await readLines(dir)).length, 2, "no new entries appended");
  });
});

test("B1/B: a rewritten middle line refuses appendEntry with manual_check_required", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "a".repeat(64) });
    const lines = await readLines(dir);
    const middle = JSON.parse(lines[1]);
    middle.brief_sha256 = "f".repeat(64);
    lines[1] = JSON.stringify(middle);
    await writeFile(join(dir, CHAIN_FILE), lines.join("\n") + "\n", "utf8");
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "brief_approved", { brief_sha256: "b".repeat(64) }), "manual_check_required");
  });
});

test("B2/C: an empty chain.json refuses writes and verification (chain_created is never erased)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await writeFile(join(dir, CHAIN_FILE), "", "utf8");
    assertRefusal(await setChainStatus(workDir, "chain-1", "active"), "manual_check_required");
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
  });
});

test("B3/D: appendEntry refuses a status_change with an unknown status; the gate fails closed", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "status_change", { status: "sleeping" }), "invalid_argument");
    assert.equal(actionRefusalForStatus("sleeping")?.reason, "invalid_argument", "unknown status refuses (fail closed)");
    assert.equal(await statusOf(workDir, "chain-1"), "active", "the unknown status was not recorded");
  });
});

test("B4/E: final statuses are sticky — no transition back to active/awaiting_child", async () => {
  await withWorkDir(async (workDir) => {
    await newChain(workDir);
    await setChainStatus(workDir, "chain-1", "stopped_by_owner");
    assertRefusal(await setChainStatus(workDir, "chain-1", "active"), "invalid_transition");
    assertRefusal(await setChainStatus(workDir, "chain-1", "awaiting_child"), "invalid_transition");
    assert.equal(await statusOf(workDir, "chain-1"), "stopped_by_owner", "the final status holds");
  });
});

test("B4/E2: manual_check_required blocks every transition except the explicit manual resolve", async () => {
  await withWorkDir(async (workDir) => {
    await newChain(workDir);
    await setChainStatus(workDir, "chain-1", "manual_check_required");
    for (const next of ["active", "awaiting_child", "completed", "stopped_by_owner"]) {
      assertRefusal(await setChainStatus(workDir, "chain-1", next), "invalid_transition");
    }
    assert.equal(await statusOf(workDir, "chain-1"), "manual_check_required");
  });
});

test("B5/F: a JSON-null line refuses with manual_check_required (no exception escapes)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await writeFile(join(dir, CHAIN_FILE), "null\n", "utf8");
    const verified = await verifyChain(workDir, "chain-1");
    assertRefusal(verified, "manual_check_required");
    await assert.rejects(
      () => statusOf(workDir, "chain-1"),
      (err) => err.code === "manual_check_required",
      "statusOf throws with code manual_check_required, not a TypeError",
    );
  });
});

test("M1/G: appendEntry refuses a payload carrying reserved keys (type/at/prev_hash)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "brief_approved", { prev_hash: "forged" }), "invalid_argument");
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "brief_approved", { at: "1970-01-01T00:00:00.000Z" }), "invalid_argument");
    assertRefusal(await appendEntry(dir, workDir, "chain-1", "brief_approved", { type: "evil" }), "invalid_argument", "type is a reserved payload key");
    assert.equal((await readLines(dir)).length, 1, "nothing was appended");
  });
});

test("M2/H: concurrent createChain calls — exactly one succeeds, the chain is never overwritten", async () => {
  await withWorkDir(async (workDir) => {
    const [a, b] = await Promise.all([createChain(workDir, "chain-h", "A"), createChain(workDir, "chain-h", "B")]);
    const okFlags = [a.ok, b.ok];
    assert.deepEqual([...okFlags].sort(), [false, true], "exactly one create succeeds");
    const winner = okFlags[0] ? "A" : "B";
    const lines = await readLines(join(workDir, ".auto", "research-chain", "chain-h"));
    const first = JSON.parse(lines[0]);
    assert.equal(first.root_campaign_id, winner, "the winner's root campaign is recorded");
    assert.equal(first.chain_id, "chain-h", "chain_created records the chain id");
    assert.equal((await verifyChain(workDir, "chain-h")).ok, true, "the surviving chain verifies");
  });
});

test("m2/K: a blank line inside the journal refuses verification", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    const lines = await readLines(dir);
    await writeFile(join(dir, CHAIN_FILE), lines.join("\n") + "\n\n", "utf8");
    assertRefusal(await verifyChain(workDir, "chain-1"), "manual_check_required");
  });
});

test("m1: headHash on a missing chain-head refuses with manual_check_required (no raw ENOENT)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    await rm(join(dir, HEAD_FILE));
    const head = await headHash(dir);
    assertRefusal(head, "manual_check_required");
  });
});

test("appendEntry refuses an unknown entry type namespace abuse? no — free types allowed, but type must be a string", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    const bad = await appendEntry(dir, workDir, "chain-1", 42, {});
    assertRefusal(bad, "invalid_argument");
  });
});

test("setChainStatus refuses unknown statuses; statusOf on a damaged chain refuses (fail closed)", async () => {
  await withWorkDir(async (workDir) => {
    const dir = await newChain(workDir);
    assertRefusal(await setChainStatus(workDir, "chain-1", "sleeping"), "invalid_argument");
    await writeFile(join(dir, HEAD_FILE), sha256Hex("foreign"), "utf8");
    await assert.rejects(
      () => statusOf(workDir, "chain-1"),
      (err) => err.code === "manual_check_required" && /manual check/i.test(err.message),
      "statusOf throws with code manual_check_required on a damaged chain",
    );
  });
});

test("actionRefusalForStatus: non-final -> null; finals refuse; allowReport frees report only on stop/limit statuses", () => {
  assert.equal(actionRefusalForStatus("active"), null);
  assert.equal(actionRefusalForStatus("awaiting_child"), null);
  for (const status of ["stopped_by_owner", "stopped_by_rule", "limit_reached", "manual_check_required", "completed"]) {
    const refusal = actionRefusalForStatus(status);
    assert.notEqual(refusal, null, `${status} refuses actions`);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.reason, "invalid_transition");
  }
  for (const status of ["stopped_by_owner", "stopped_by_rule", "limit_reached"]) {
    assert.equal(actionRefusalForStatus(status, { allowReport: true }), null, `report allowed for ${status}`);
  }
  assert.notEqual(actionRefusalForStatus("manual_check_required", { allowReport: true }), null);
  assert.notEqual(actionRefusalForStatus("completed", { allowReport: true }), null);
});
