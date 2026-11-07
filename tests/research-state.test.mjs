/**
 * research-state (openspec/changes/research-vectors, task pi-autoresearch-2bi.1.1):
 * per-campaign paths, atomic state writes, exclusive lock, pending-operation
 * marker, brief structure validation and SHA-256 brief checks.
 *
 * Every test runs in its own temporary work directory. Refusals are checked
 * against a byte-level snapshot of the campaign directory, so a refused
 * operation must leave every file untouched.
 *
 * approval.json is written by the consent step (task 2bi.1.4), which is not
 * part of this module. Tests that need an approved brief write the file
 * directly in the documented shape to exercise the read side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as R from "../extensions/pi-autoresearch/research-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Runs fn with a fresh work directory; the campaign directory is not created yet. */
async function withWorkDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "research-state-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Creates a campaign and returns its directory. */
async function newCampaign(workDir, id = "c1") {
  const created = await R.createCampaign(workDir, id);
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.dir;
}

/** Byte-level snapshot of every file in a directory (names sorted). */
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
  assert.equal(result.reason, reason, result.message);
  assert.equal(/[\r\n]/.test(result.message), false, "refusal message must be one line");
}

function validBrief(overrides = {}) {
  return {
    schema_version: 1,
    goal: "Decide whether the cache change affects tail latency.",
    plan_source: "docs/plan.md",
    caveat_block: "Results describe this protocol only; no generalisation is claimed.",
    data_roles: { explore: ["bench-2026-01.csv"], validate: ["bench-2026-02.csv"], confirm: [] },
    questions: [
      {
        id: "Q1",
        text: "Does the cache reduce p95 latency?",
        decision_rules: [
          { id: "Q1-yes", verdict: "confirmed", when: "p95 drops by at least 10% on validate data" },
          { id: "Q1-no", verdict: "rejected", when: "p95 does not drop on validate data" },
          { id: "Q1-unknown", verdict: "inconclusive", when: "run-to-run noise exceeds the effect" },
          { id: "Q1-wait", verdict: "waiting_for_data", when: "validate data is missing" },
        ],
        needs_data: "bench-2026-02.csv",
      },
    ],
    process_metrics: ["number of runs"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
    ...overrides,
  };
}

/** Writes a draft brief through the module API and asserts it was accepted. */
async function draftBrief(dir, brief = validBrief()) {
  const drafted = await R.writeBriefDraft(dir, brief);
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  return drafted;
}

/** Test-only approval fixture in the documented approval.json shape. */
async function approve(dir, sha256) {
  const approval = { schema_version: 1, brief_sha256: sha256, approved_at: "2026-01-01T00:00:00.000Z", confirmed: true };
  await writeFile(join(dir, R.APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n");
}

/** Replaces the first occurrence of `from` in the brief file with `to`. */
async function editBriefFile(dir, from, to) {
  const path = join(dir, R.BRIEF_FILE);
  const text = await readFile(path, "utf8");
  assert.ok(text.includes(from), `fixture text not found: ${from}`);
  await writeFile(path, text.replace(from, to));
}

/** A state update that only bumps nothing: it returns the state unchanged. */
const noopDecide = (s) => ({ ok: true, next: s });

// ─── Paths and campaigns (per-campaign directories) ─────────────────────────

test("resolveCampaignDir places each campaign under .auto/research/<id>", () => {
  const r = R.resolveCampaignDir("/work", "camp-1");
  assert.equal(r.ok, true);
  assert.equal(r.dir, join("/work", ".auto", "research", "camp-1"));
  assert.equal(R.researchRoot("/work"), join("/work", ".auto", "research"));
});

test("resolveCampaignDir refuses ids that could escape the research root", () => {
  for (const bad of ["", "..", ".hidden", "a/b", "a\\b", "x y", "-lead", "a".repeat(65), 42, null]) {
    assertRefusal(R.resolveCampaignDir("/work", bad), "invalid_argument");
  }
  assertRefusal(R.resolveCampaignDir("", "c1"), "invalid_argument");
});

test("createCampaign creates a briefing-phase state in its own directory", async () => {
  await withWorkDir(async (root) => {
    const created = await R.createCampaign(root, "c1");
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.dir, join(root, ".auto", "research", "c1"));
    assert.equal(created.state.phase, "briefing");
    assert.equal(created.state.campaign_id, "c1");
    const read = await R.readState(created.dir);
    assert.equal(read.ok, true);
    assert.deepEqual(read.state, created.state);
  });
});

test("a second campaign gets its own directory and leaves the first untouched", async () => {
  await withWorkDir(async (root) => {
    const first = await newCampaign(root, "c1");
    await draftBrief(first);
    const before = await snapshot(first);

    const second = await newCampaign(root, "c2");
    assert.notEqual(second, first);
    assert.deepEqual(await snapshot(first), before, "earlier campaign records must be kept");
    assert.equal((await R.readState(second)).ok, true);
  });
});

test("createCampaign refuses an existing id and does not overwrite it", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await draftBrief(dir);
    const before = await snapshot(dir);

    assertRefusal(await R.createCampaign(root, "c1"), "campaign_exists");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("createCampaign refuses invalid ids without creating anything", async () => {
  await withWorkDir(async (root) => {
    assertRefusal(await R.createCampaign(root, "../escape"), "invalid_argument");
    assert.equal(existsSync(join(root, ".auto")), false);
  });
});

// ─── Atomic writes ───────────────────────────────────────────────────────────

test("writeFileAtomic replaces the target and leaves no temporary file", async () => {
  await withWorkDir(async (root) => {
    const target = join(root, "file.json");
    await R.writeFileAtomic(target, "one\n");
    await R.writeFileAtomic(target, "two\n");
    assert.equal(await readFile(target, "utf8"), "two\n");
    assert.deepEqual((await readdir(root)).sort(), ["file.json"]);
  });
});

test("writeFileAtomic failure keeps the previous content and removes its temporary file", async () => {
  await withWorkDir(async (root) => {
    const target = join(root, "file.json");
    await R.writeFileAtomic(target, "kept\n");
    // A directory in the target path makes rename fail after the temporary file is written.
    const blocked = join(root, "blocked");
    await mkdir(blocked);
    await assert.rejects(R.writeFileAtomic(blocked, "x"));
    assert.equal(await readFile(target, "utf8"), "kept\n");
    assert.deepEqual((await readdir(root)).sort(), ["blocked", "file.json"]);
  });
});

test("state primitives refuse a directory outside the research root without touching files", async () => {
  await withWorkDir(async (root) => {
    const created = await newCampaign(root, "c1");
    const outsideParent = join(root, "outside");
    await mkdir(outsideParent, { recursive: true });
    const outside = join(outsideParent, "c1");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, R.STATE_FILE), await readFile(join(created, R.STATE_FILE), "utf8"));
    const before = await snapshot(outside);

    assertRefusal(await R.readState(outside), "invalid_argument");
    assertRefusal(await R.updateState(outside, "try", noopDecide), "invalid_argument");
    assertRefusal(await R.writeBriefDraft(outside, validBrief()), "invalid_argument");
    assert.equal((await R.inspectCampaign(outside)).status, "invalid_argument");
    assert.deepEqual(await snapshot(outside), before, "files outside the research root must be unchanged");
  });
});

test("a leftover temporary file from a crashed writer is ignored by readState", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await writeFile(join(dir, `${R.STATE_FILE}.4242.abcdef012345.tmp`), "{ not json");
    const read = await R.readState(dir);
    assert.equal(read.ok, true, JSON.stringify(read));
  });
});

// ─── State: fail-closed reads ────────────────────────────────────────────────

test("readState reports a missing state as not_initialized", async () => {
  await withWorkDir(async (root) => {
    const dir = join(root, ".auto", "research", "absent");
    await mkdir(dir, { recursive: true });
    assertRefusal(await R.readState(dir), "not_initialized");
  });
});

test("corrupt or invalid state.json refuses every state update and changes nothing", async () => {
  const corruptions = {
    "not JSON": "{ broken",
    "wrong schema_version": JSON.stringify({ schema_version: 2, campaign_id: "c1", created_at: "x", phase: "briefing" }),
    "unknown phase": JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: "x", phase: "running" }),
    "missing field": JSON.stringify({ schema_version: 1, campaign_id: "c1", phase: "briefing" }),
    "extra field": JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: "x", phase: "briefing", extra: 1 }),
    "copied from another campaign": JSON.stringify({ schema_version: 1, campaign_id: "other", created_at: "x", phase: "briefing" }),
    "array root": "[]",
  };
  for (const [label, text] of Object.entries(corruptions)) {
    await withWorkDir(async (root) => {
      const dir = await newCampaign(root, "c1");
      await writeFile(join(dir, R.STATE_FILE), text);
      const before = await snapshot(dir);

      assertRefusal(await R.readState(dir), "state_unreadable");
      assertRefusal(await R.updateState(dir, "try", noopDecide), "state_unreadable");
      assert.deepEqual(await snapshot(dir), before, `${label}: files must be unchanged`);
      assert.equal((await R.inspectCampaign(dir)).status, "state_unreadable", label);
    });
  }
});

// ─── State: locked updates ───────────────────────────────────────────────────

test("updateState writes the new state atomically and removes the pending marker", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const result = await R.updateState(dir, "move to research", (s) => ({ ok: true, next: { ...s, phase: "research" } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state.phase, "research");
    assert.equal((await R.readState(dir)).state.phase, "research");
    assert.equal(existsSync(join(dir, R.PENDING_OP_FILE)), false);
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), false, "lock must be released");
  });
});

test("a refused decision leaves every file as it was", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const before = await snapshot(dir);
    const result = await R.updateState(dir, "refused", () => ({
      ok: false,
      reason: "invalid_transition",
      message: "no",
    }));
    assertRefusal(result, "invalid_transition");
    assert.deepEqual(await snapshot(dir), before);
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), false);
  });
});

test("updateState rejects a next state that fails validation", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const before = await snapshot(dir);
    const result = await R.updateState(dir, "bad", (s) => ({ ok: true, next: { ...s, phase: "unknown" } }));
    assertRefusal(result, "invalid_transition");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("a busy lock refuses the update without touching state", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await writeFile(join(dir, R.LOCK_FILE), JSON.stringify({ pid: process.pid, acquired_at: "2026-01-01T00:00:00.000Z" }));
    const before = await snapshot(dir);
    assertRefusal(await R.updateState(dir, "try", noopDecide), "lock_busy");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("a stale lock from a dead process is never removed automatically", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await writeFile(join(dir, R.LOCK_FILE), JSON.stringify({ pid: 999999, acquired_at: "2020-01-01T00:00:00.000Z" }));
    for (let i = 0; i < 2; i++) {
      assertRefusal(await R.updateState(dir, "try", noopDecide), "lock_busy");
    }
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), true, "lock must stay until an operator removes it");
    assertRefusal(await R.withCampaignLock(dir, async () => 1), "lock_busy");
  });
});

test("an unreadable lock refuses with lock_unreadable and is kept", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await writeFile(join(dir, R.LOCK_FILE), "not json");
    assertRefusal(await R.updateState(dir, "try", noopDecide), "lock_unreadable");
    assert.equal(await readFile(join(dir, R.LOCK_FILE), "utf8"), "not json");
  });
});

test("withCampaignLock releases the lock after success and after a throw", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    assert.equal(await R.withCampaignLock(dir, async () => 7), 7);
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), false);
    await assert.rejects(R.withCampaignLock(dir, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), false);
  });
});

test("concurrent updates never both run inside the lock", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    let inside = 0;
    let maxInside = 0;
    const slowWork = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inside--;
    };
    const run = (label) =>
      R.updateState(dir, label, (s) => ({ ok: true, next: s }), slowWork);
    const results = await Promise.all([run("a"), run("b"), run("c")]);
    assert.equal(maxInside, 1, "two operations were inside the lock at once");
    for (const r of results) {
      assert.ok(r.ok || r.reason === "lock_busy", JSON.stringify(r));
    }
    assert.ok(results.some((r) => r.ok), "at least one operation must succeed");
  });
});

// ─── Pending-operation marker ────────────────────────────────────────────────

test("the pending marker exists while work runs and is removed after success", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    let seen = null;
    const result = await R.updateState(
      dir,
      "research open Q1",
      (s) => ({ ok: true, next: { ...s, phase: "research" } }),
      async () => {
        seen = JSON.parse(await readFile(join(dir, R.PENDING_OP_FILE), "utf8"));
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(seen.name, "research open Q1");
    assert.equal(existsSync(join(dir, R.PENDING_OP_FILE)), false);
  });
});

test("a failed work step keeps the marker, keeps the state, and blocks later updates", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const stateBefore = await readFile(join(dir, R.STATE_FILE), "utf8");
    const failed = await R.updateState(
      dir,
      "risky",
      (s) => ({ ok: true, next: { ...s, phase: "research" } }),
      async () => {
        throw new Error("disk went away");
      },
    );
    assertRefusal(failed, "operation_failed");
    assert.equal(await readFile(join(dir, R.STATE_FILE), "utf8"), stateBefore, "state must not change");
    assert.equal(existsSync(join(dir, R.PENDING_OP_FILE)), true, "marker must stay");
    assert.equal(existsSync(join(dir, R.LOCK_FILE)), false, "lock must still be released");

    const later = await R.updateState(dir, "after", noopDecide);
    assertRefusal(later, "manual_check_required");
    assert.match(later.message, /risky/);
    assert.equal(existsSync(join(dir, R.PENDING_OP_FILE)), true, "marker is never removed automatically");
    assert.equal((await R.inspectCampaign(dir)).status, "manual_check_required");
  });
});

test("an existing pending marker refuses every update with manual_check_required", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await writeFile(join(dir, R.PENDING_OP_FILE), JSON.stringify({ name: "old", started_at: "2026-01-01T00:00:00.000Z" }));
    const before = await snapshot(dir);
    assertRefusal(await R.updateState(dir, "new", noopDecide), "manual_check_required");
    assertRefusal(await R.writeBriefDraft(dir, validBrief()), "manual_check_required");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("an unreadable pending marker is treated as pending, not as absent", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await mkdir(join(dir, R.PENDING_OP_FILE));
    assertRefusal(await R.updateState(dir, "new", noopDecide), "manual_check_required");
    const inspection = await R.inspectCampaign(dir);
    assert.equal(inspection.status, "manual_check_required");
    assert.ok(inspection.pendingOp);
  });
});

test("inspectCampaign reports uninitialized, ready and lock presence without writing", async () => {
  await withWorkDir(async (root) => {
    const dir = join(root, ".auto", "research", "c1");
    await mkdir(dir, { recursive: true });
    assert.equal((await R.inspectCampaign(dir)).status, "uninitialized");

    await writeFile(join(dir, R.STATE_FILE), JSON.stringify({ schema_version: 1, campaign_id: "c1", created_at: "x", phase: "briefing" }));
    await writeFile(join(dir, R.LOCK_FILE), JSON.stringify({ pid: 1, acquired_at: "x" }));
    const before = await snapshot(dir);
    const inspection = await R.inspectCampaign(dir);
    assert.equal(inspection.status, "ready");
    assert.equal(inspection.lockPresent, true);
    assert.deepEqual(await snapshot(dir), before);
  });
});

// ─── Brief structure ─────────────────────────────────────────────────────────

test("validateBrief accepts a complete brief", () => {
  const v = R.validateBrief(validBrief());
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("validateBrief rejects non-object roots", () => {
  for (const raw of [null, [], "text", 3]) {
    const v = R.validateBrief(raw);
    assert.equal(v.ok, false);
  }
});

test("validateBrief rejects a brief without caveat_block or with an empty one", () => {
  const missing = validBrief();
  delete missing.caveat_block;
  assert.equal(R.validateBrief(missing).ok, false);
  const empty = R.validateBrief(validBrief({ caveat_block: "   " }));
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join("\n"), /caveat_block/);
});

test("validateBrief rejects unknown top-level and nested fields, including approval flags", () => {
  for (const extra of ["approved", "confirmed", "operator_confirmation"]) {
    const v = R.validateBrief({ ...validBrief(), [extra]: true });
    assert.equal(v.ok, false, extra);
    assert.match(v.errors.join("\n"), new RegExp(extra));
  }
  const nested = validBrief();
  nested.questions[0].decision_rules[0].extra = 1;
  assert.equal(R.validateBrief(nested).ok, false);
});

test("validateBrief rejects a missing data_roles key and non-string role entries", () => {
  const missingRole = validBrief({ data_roles: { explore: [], validate: [] } });
  assert.equal(R.validateBrief(missingRole).ok, false);
  const badEntry = validBrief({ data_roles: { explore: [""], validate: [], confirm: [] } });
  assert.equal(R.validateBrief(badEntry).ok, false);
});

test("validateBrief requires at least one question", () => {
  assert.equal(R.validateBrief(validBrief({ questions: [] })).ok, false);
});

test("validateBrief rejects duplicate question ids and duplicate rule ids across questions", () => {
  const dupQuestion = validBrief();
  dupQuestion.questions.push(structuredClone(dupQuestion.questions[0]));
  const dq = R.validateBrief(dupQuestion);
  assert.equal(dq.ok, false);
  assert.match(dq.errors.join("\n"), /duplicates/);

  const second = structuredClone(validBrief().questions[0]);
  second.id = "Q2";
  const dupRule = validBrief();
  dupRule.questions.push(second);
  const dr = R.validateBrief(dupRule);
  assert.equal(dr.ok, false, "rule ids must be unique across questions");
});

test("validateBrief rejects a question missing a rule for any verdict", () => {
  for (const verdict of R.VERDICTS) {
    const b = validBrief();
    b.questions[0].decision_rules = b.questions[0].decision_rules.filter((r) => r.verdict !== verdict);
    const v = R.validateBrief(b);
    assert.equal(v.ok, false, `missing ${verdict} must be rejected`);
    assert.match(v.errors.join("\n"), new RegExp(verdict));
  }
});

test("validateBrief rejects an unknown verdict and an empty rule condition", () => {
  const badVerdict = validBrief();
  badVerdict.questions[0].decision_rules[0].verdict = "maybe";
  assert.equal(R.validateBrief(badVerdict).ok, false);
  const emptyWhen = validBrief();
  emptyWhen.questions[0].decision_rules[1].when = "";
  assert.equal(R.validateBrief(emptyWhen).ok, false);
});

test("validateBrief checks needs_data as null or non-empty text and stop-rule ids", () => {
  const nullOk = validBrief();
  nullOk.questions[0].needs_data = null;
  assert.equal(R.validateBrief(nullOk).ok, true);
  const emptyData = validBrief();
  emptyData.questions[0].needs_data = "";
  assert.equal(R.validateBrief(emptyData).ok, false);
  const badStop = validBrief({ stop_rules: [{ id: "bad id", when: "x" }] });
  assert.equal(R.validateBrief(badStop).ok, false);
});

test("validateBrief rejects a wrong schema_version and non-string process metrics", () => {
  assert.equal(R.validateBrief(validBrief({ schema_version: 2 })).ok, false);
  assert.equal(R.validateBrief(validBrief({ process_metrics: [1] })).ok, false);
});

test("writeBriefDraft refuses an invalid brief and writes nothing", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const before = await snapshot(dir);
    const bad = validBrief();
    delete bad.caveat_block;
    assertRefusal(await R.writeBriefDraft(dir, bad), "brief_invalid");
    assert.equal(existsSync(join(dir, R.BRIEF_FILE)), false);
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("writeBriefDraft writes canonical JSON and returns the hash of its bytes", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    const bytes = await readFile(join(dir, R.BRIEF_FILE));
    assert.equal(drafted.sha256, R.sha256Hex(bytes));
    const checked = await R.briefSha256(dir);
    assert.equal(checked.sha256, drafted.sha256);
  });
});

test("a draft may be replaced while the brief is not approved", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const first = await draftBrief(dir);
    const second = await draftBrief(dir, validBrief({ goal: "A different goal." }));
    assert.notEqual(first.sha256, second.sha256);
    assert.equal((await R.briefSha256(dir)).sha256, second.sha256);
  });
});

// ─── SHA-256 ─────────────────────────────────────────────────────────────────

test("sha256Hex matches the standard test vector", () => {
  assert.equal(R.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(R.sha256Hex(Buffer.from("abc")), R.sha256Hex("abc"));
});

test("brief hash is stable across repeated reads and changes on any byte edit", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await draftBrief(dir);
    const h1 = (await R.briefSha256(dir)).sha256;
    const h2 = (await R.briefSha256(dir)).sha256;
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);

    await editBriefFile(dir, "p95 drops", "p95 drops ");
    assert.notEqual((await R.briefSha256(dir)).sha256, h1, "a whitespace-only edit must change the hash");
  });
});

test("briefSha256 refuses a missing brief", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    assertRefusal(await R.briefSha256(dir), "brief_missing");
  });
});

// ─── Approval and brief immutability ─────────────────────────────────────────

test("checkBriefApproval without approval.json refuses with not_approved", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    await draftBrief(dir);
    assertRefusal(await R.checkBriefApproval(dir), "not_approved");
  });
});

test("checkBriefApproval accepts the approved brief and returns its hash", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    await approve(dir, drafted.sha256);
    const ok = await R.checkBriefApproval(dir, drafted.sha256);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.sha256, drafted.sha256);
    assert.equal(ok.brief.questions[0].id, "Q1");
  });
});

test("an edit after approval is brief_changed and blocks every state update", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    await approve(dir, drafted.sha256);
    await editBriefFile(dir, "Does the cache", "Does the new cache");
    const before = await snapshot(dir);

    assertRefusal(await R.checkBriefApproval(dir), "brief_changed");
    assertRefusal(await R.updateState(dir, "research", (s) => ({ ok: true, next: { ...s, phase: "research" } })), "brief_changed");
    assertRefusal(await R.writeBriefDraft(dir, validBrief({ goal: "x" })), "brief_approved");
    assert.deepEqual(await snapshot(dir), before, "a refused action must change nothing");
  });
});

test("a wrong expected hash is brief_changed even when the brief matches its approval", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    await approve(dir, drafted.sha256);
    assertRefusal(await R.checkBriefApproval(dir, "0".repeat(64)), "brief_changed");
    assertRefusal(await R.checkBriefApproval(dir, "not-a-hash"), "invalid_argument");
  });
});

test("a missing brief after approval is brief_changed", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    await approve(dir, drafted.sha256);
    await rm(join(dir, R.BRIEF_FILE));
    assertRefusal(await R.checkBriefApproval(dir), "brief_changed");
  });
});

test("writeBriefDraft refuses once approval.json exists and leaves the brief unchanged", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const drafted = await draftBrief(dir);
    await approve(dir, drafted.sha256);
    const before = await snapshot(dir);
    assertRefusal(await R.writeBriefDraft(dir, validBrief({ goal: "new" })), "brief_approved");
    assert.deepEqual(await snapshot(dir), before);
  });
});

test("approval.json with a bad shape is approval_invalid", async () => {
  const shapes = {
    "not JSON": "{ nope",
    "confirmed false": { schema_version: 1, brief_sha256: "a".repeat(64), approved_at: "x", confirmed: false },
    "confirmed string": { schema_version: 1, brief_sha256: "a".repeat(64), approved_at: "x", confirmed: "true" },
    "extra field": { schema_version: 1, brief_sha256: "a".repeat(64), approved_at: "x", confirmed: true, approved: true },
    "bad hash": { schema_version: 1, brief_sha256: "ABC", approved_at: "x", confirmed: true },
  };
  for (const body of Object.values(shapes)) {
    await withWorkDir(async (root) => {
      const dir = await newCampaign(root, "c1");
      await draftBrief(dir);
      await writeFile(join(dir, R.APPROVAL_FILE), typeof body === "string" ? body : JSON.stringify(body));
      assertRefusal(await R.checkBriefApproval(dir), "approval_invalid");
      assertRefusal(await R.updateState(dir, "try", noopDecide), "approval_invalid");
    });
  }
});

test("an approved brief whose bytes are structurally invalid is brief_invalid", async () => {
  await withWorkDir(async (root) => {
    const dir = await newCampaign(root, "c1");
    const text = JSON.stringify({ schema_version: 1, goal: "only goal" }) + "\n";
    await writeFile(join(dir, R.BRIEF_FILE), text);
    await approve(dir, R.sha256Hex(text));
    assertRefusal(await R.checkBriefApproval(dir), "brief_invalid");
  });
});
