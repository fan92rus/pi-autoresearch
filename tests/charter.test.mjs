/**
 * charter (openspec/changes/research-charter, tasks 1.1–1.5, bd pi-autoresearch-0lq):
 * charter file validation, owner consent binding, workdir containment and the
 * model-call parameter allowlist.
 *
 * Every test runs in its own temporary work directory. Refused operations must
 * not write anything: refusals are checked against a byte-level snapshot of
 * the work directory.
 *
 * Run: timeout 60 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/charter.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as C from "../extensions/pi-autoresearch/charter.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Runs fn with a fresh work directory. */
async function withWorkDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "charter-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Writes a valid charter file and returns its path and hash. */
async function writeCharter(workDir, name, content = { max_campaigns: 5, max_depth: 4 }) {
  const path = join(workDir, name);
  const text = JSON.stringify(content, null, 2) + "\n";
  await writeFile(path, text, "utf8");
  return { path, text, sha256: sha256Hex(text) };
}

/** Byte-level snapshot of every file in a directory tree (relative names sorted). */
async function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name);
    try {
      out[name] = await readFile(full, "utf8");
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

function assertRefusal(result, reason) {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason, result.message);
  assert.equal(/[\r\n]/.test(result.message), false, "refusal message must be one line");
}

// ─── 1.1 Model-call parameter allowlist ──────────────────────────────────────

test("1.1 validateCharterCall accepts exactly charter_path (the model allowlist)", () => {
  const ok = C.validateCharterCall({ charter_path: "charter.json" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("1.1 owner-side data in model params is rejected (trusted/model split)", () => {
  const ownerFields = [
    ["expected_sha256", "a".repeat(64)],
    ["hasUI", true],
    ["ownerConfirmed", true],
    ["confirmed", true],
    ["approved", true],
    ["charter_sha256", "a".repeat(64)],
    ["operator_confirmation", "x"],
  ];
  for (const [field, value] of ownerFields) {
    const result = C.validateCharterCall({ charter_path: "charter.json", [field]: value });
    assertRefusal(result, "invalid_argument");
    assert.ok(result.message.includes(field), `refusal must name the field: ${result.message}`);
  }
});

test("1.1 consent fields from the model are rejected (approved, confirmed, charter_sha256, operator_confirmation)", () => {
  for (const field of ["approved", "confirmed", "charter_sha256", "operator_confirmation"]) {
    const result = C.validateCharterCall({ charter_path: "charter.json", [field]: true });
    assertRefusal(result, "invalid_argument");
    assert.ok(result.message.includes(field), `refusal must name the field: ${result.message}`);
  }
});

test("1.1 any unknown call field is rejected (allowlist, not denylist)", () => {
  for (const field of ["operator_token", "constructor", "__proto__", "trust_me"]) {
    const result = C.validateCharterCall({ charter_path: "charter.json", [field]: "x" });
    assertRefusal(result, "invalid_argument");
    assert.ok(result.message.includes(JSON.stringify(field)), `refusal must name the field: ${result.message}`);
  }
});

test("1.1 a charter without an owner-supplied hash or dialog consent is not accepted", async () => {
  await withWorkDir(async (workDir) => {
    const { path } = await writeCharter(join(workDir, ".."), `nohash-charter-${process.pid}.json`);
    try {
      // No dialog channel: refuse.
      const noUi = await C.acceptCharter(path, workDir, {}, { hasUI: false });
      assertRefusal(noUi, "invalid_argument");
      // Dialog channel without an explicit owner confirmation: refuse.
      const unconfirmed = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: false });
      assertRefusal(unconfirmed, "invalid_argument");
      // Dialog consent without the recorded shown hash: refuse — the calling
      // layer must bind the consent to the hash it displayed.
      const unbound = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: true });
      assertRefusal(unbound, "invalid_argument");
    } finally {
      await rm(path, { force: true });
    }
  });
});

// ─── 1.2 Workdir containment ─────────────────────────────────────────────────

test("1.2 a charter inside the work directory refuses with charter_inside_workdir", async () => {
  await withWorkDir(async (workDir) => {
    const { path } = await writeCharter(workDir, "charter.json");
    const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: sha256Hex(await readFile(path, "utf8")) });
    assertRefusal(result, "charter_inside_workdir");
  });
});

test("1.2 a symlink outside the work directory pointing into it is detected via realpath", { skip: process.platform !== "win32" && process.platform !== "linux" }, async () => {
  await withWorkDir(async (workDir) => {
    const { path } = await writeCharter(workDir, "charter.json");
    const linkPath = join(workDir, "..", `charter-link-${Date.now()}-${process.pid}`);
    let linked = false;
    try {
      await symlink(path, linkPath, "file");
      linked = true;
    } catch (err) {
      // Windows without developer/admin rights refuses symlink creation: skip.
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        linked = false;
      } else {
        throw err;
      }
    }
    try {
      if (!linked) return; // treated as skip: privileges unavailable
      const result = await C.acceptCharter(linkPath, workDir, {}, { expectedSha256: sha256Hex(await readFile(path, "utf8")) });
      assertRefusal(result, "charter_inside_workdir");
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});

test("1.2 Windows name case is folded when comparing containment", { skip: process.platform !== "win32" }, async () => {
  await withWorkDir(async (workDir) => {
    // Same directory addressed with a different drive-letter / path case.
    const flipped = workDir.slice(0, 1).toLowerCase() === workDir.slice(0, 1)
      ? workDir.slice(0, 1).toUpperCase() + workDir.slice(1)
      : workDir.slice(0, 1).toLowerCase() + workDir.slice(1);
    const { path } = await writeCharter(workDir, "charter.json");
    const result = await C.acceptCharter(path, flipped, {}, { expectedSha256: sha256Hex(await readFile(path, "utf8")) });
    assertRefusal(result, "charter_inside_workdir");
  });
});

test("1.2 a charter outside the work directory is accepted (headless, matching hash)", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path, sha256 } = await writeCharter(parent, `outside-charter-${process.pid}.json`);
    try {
      const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: sha256 });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.sha256, sha256);
      assert.equal(result.charter.max_campaigns, 5);
    } finally {
      await rm(path, { force: true });
    }
  });
});

// ─── 1.3 Dialog text and owner refusal ───────────────────────────────────────

test("1.3 dialog text starts with Charter SHA-256 and shows the charter fields", () => {
  const charter = { max_campaigns: 5, max_depth: 4, stop_rules: ["two rejected vectors in a row"] };
  const text = C.charterDialogText(charter, "b".repeat(64));
  const lines = text.split("\n");
  assert.equal(lines[0], `Charter SHA-256: ${"b".repeat(64)}`);
  assert.ok(text.includes("max_campaigns"), "dialog must show max_campaigns");
  assert.ok(text.includes("max_depth"), "dialog must show max_depth");
  assert.ok(text.includes("two rejected vectors in a row"), "dialog must show stop rules");
});

test("1.3 dialog text for a charter without limits says the chain is unlimited", () => {
  const text = C.charterDialogText({}, "c".repeat(64));
  assert.equal(text.split("\n")[0], `Charter SHA-256: ${"c".repeat(64)}`);
  assert.ok(/unlimited|без лимитов/i.test(text), `dialog must state the unlimited default: ${text}`);
});

test("1.3 confirmation without a UI refuses and writes nothing", async () => {
  await withWorkDir(async (workDir) => {
    const { path } = await writeCharter(join(workDir, ".."), `noui-charter-${process.pid}.json`);
    try {
      const before = await snapshot(workDir);
      const result = await C.acceptCharter(path, workDir, {}, { hasUI: false });
      assertRefusal(result, "invalid_argument");
      assert.deepEqual(await snapshot(workDir), before, "a refused acceptance must not write anything");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.3 an owner refusal does not fix the charter", async () => {
  await withWorkDir(async (workDir) => {
    const { path } = await writeCharter(join(workDir, ".."), `refused-charter-${process.pid}.json`);
    try {
      const before = await snapshot(workDir);
      const result = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: false });
      assertRefusal(result, "invalid_argument");
      assert.deepEqual(await snapshot(workDir), before, "an owner refusal must not write anything");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.3 interactive acceptCharter accepts when the owner confirmed and the file still matches the shown hash", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path, sha256 } = await writeCharter(parent, `interactive-charter-${process.pid}.json`);
    try {
      const result = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: true, shownSha256: sha256 });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.sha256, sha256);
      assert.equal(result.charter.max_campaigns, 5);
    } finally {
      await rm(path, { force: true });
    }
  });
});

// ─── 1.4 Re-hash at confirmation ─────────────────────────────────────────────

test("1.4 confirmCharter refuses with charter_changed when the file changed after it was shown", async () => {
  await withWorkDir(async (workDir) => {
    const { path, sha256 } = await writeCharter(workDir, "charter.json");
    // The file changes between being shown to the owner and the confirmation.
    await writeFile(path, JSON.stringify({ max_campaigns: 99 }), "utf8");
    const result = await C.confirmCharter(path, sha256);
    assertRefusal(result, "charter_changed");
  });
});

test("1.4 interactive acceptCharter refuses with charter_changed when the file was swapped after the dialog (B1)", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path, sha256: shown } = await writeCharter(parent, `swap-charter-${process.pid}.json`);
    try {
      // The owner saw hash `shown`; the file is then replaced with a DIFFERENT
      // valid charter before the confirmation call.
      await writeFile(path, JSON.stringify({ max_campaigns: 99, max_depth: 0 }) + "\n", "utf8");
      const result = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: true, shownSha256: shown });
      assertRefusal(result, "charter_changed");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.4 acceptCharter refuses with charter_changed when the file no longer matches the owner hash", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path } = await writeCharter(parent, `changed-charter-${process.pid}.json`);
    try {
      const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: "0".repeat(64) });
      assertRefusal(result, "charter_changed");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.4 a malformed owner hash is an invalid argument", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path } = await writeCharter(parent, `badhash-charter-${process.pid}.json`);
    try {
      for (const bad of ["XYZ", "A".repeat(64), "abc"]) {
        const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: bad });
        assertRefusal(result, "invalid_argument");
      }
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.4 a malformed shown hash is an invalid argument", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const { path } = await writeCharter(parent, `badshown-charter-${process.pid}.json`);
    try {
      const result = await C.acceptCharter(path, workDir, {}, { hasUI: true, ownerConfirmed: true, shownSha256: "NOT-A-HASH" });
      assertRefusal(result, "invalid_argument");
    } finally {
      await rm(path, { force: true });
    }
  });
});

// ─── 1.5 Charter content validation ──────────────────────────────────────────

test("1.5 an empty charter is valid: no limits, unlimited chain", () => {
  const v = C.validateCharter({});
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("1.5 valid limits and stop rules are accepted", () => {
  assert.equal(C.validateCharter({ max_campaigns: 1 }).ok, true);
  assert.equal(C.validateCharter({ max_depth: 0 }).ok, true);
  assert.equal(C.validateCharter({ max_campaigns: 5, max_depth: 4 }).ok, true);
  const withRules = C.validateCharter({ stop_rules: ["two rejected vectors without new data"] });
  assert.equal(withRules.ok, true, JSON.stringify(withRules));
});

test("1.5 invalid limits are rejected", () => {
  // max_campaigns must be an integer >= 1; max_depth an integer >= 0.
  for (const bad of [0, -1, 1.5, "5", null, true]) {
    const v = C.validateCharter({ max_campaigns: bad });
    assert.equal(v.ok, false, `max_campaigns ${JSON.stringify(bad)} must be rejected`);
  }
  for (const bad of [-1, 1.5, "5", null, true]) {
    const d = C.validateCharter({ max_depth: bad });
    assert.equal(d.ok, false, `max_depth ${JSON.stringify(bad)} must be rejected`);
  }
});

test("1.5 stop_rules must be an array of strings", () => {
  assert.equal(C.validateCharter({ stop_rules: [] }).ok, true, "an empty rule list is a valid list");
  for (const bad of ["x", [1], [null], [[]]]) {
    const v = C.validateCharter({ stop_rules: bad });
    assert.equal(v.ok, false, `stop_rules ${JSON.stringify(bad)} must be rejected`);
  }
});

test("1.5 a charter with an unknown field is rejected (allowlist)", () => {
  for (const field of ["verdicts", "evidence_gate", "caveat_block", "schema_version", "rules"]) {
    const v = C.validateCharter({ [field]: "x" });
    assert.equal(v.ok, false, `unknown charter field ${field} must be rejected`);
    assert.ok(v.errors.some((e) => e.includes(field)), `errors must name the field: ${v.errors.join("; ")}`);
  }
});

test("1.5 a charter that is not a JSON object is rejected", () => {
  for (const bad of [null, "x", 5, [], true]) {
    const v = C.validateCharter(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
  }
});

test("1.5 acceptCharter refuses a charter file with invalid content", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const path = join(parent, `invalid-charter-${process.pid}.json`);
    const text = JSON.stringify({ max_campaigns: 0 }) + "\n";
    await writeFile(path, text, "utf8");
    try {
      const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: sha256Hex(text) });
      assertRefusal(result, "charter_invalid");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("1.5 a missing charter file refuses with charter_unreadable", async () => {
  await withWorkDir(async (workDir) => {
    const path = join(workDir, "..", `missing-charter-${process.pid}.json`);
    const result = await C.acceptCharter(path, workDir, {}, { expectedSha256: "a".repeat(64) });
    assertRefusal(result, "charter_unreadable");
  });
});

test("1.5 a non-string charter_path in model params is an invalid argument", async () => {
  for (const bad of [123, {}, ["x"], true]) {
    const result = C.validateCharterCall({ charter_path: bad });
    assertRefusal(result, "invalid_argument");
  }
});

test("round2 BLK-1 mixing headless and interactive trusted fields is an invalid argument", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const path = join(parent, `mix-charter-${process.pid}.json`);
    const text = JSON.stringify({ max_campaigns: 3 }) + "\n";
    await writeFile(path, text, "utf8");
    try {
      // Pattern 1: owner saw H1 (shownSha256), file replaced with F2 (text),
      // a stale expectedSha256 H2 must not bypass the shownSha256 binding.
      const stale = await C.acceptCharter(path, workDir, {}, {
        expectedSha256: sha256Hex(text),
        hasUI: true,
        ownerConfirmed: true,
        shownSha256: "b".repeat(64),
      });
      assertRefusal(stale, "invalid_argument");
      // Pattern 2: expectedSha256 combined with an explicit owner refusal.
      const refused = await C.acceptCharter(path, workDir, {}, {
        expectedSha256: sha256Hex(text),
        hasUI: true,
        ownerConfirmed: false,
      });
      assertRefusal(refused, "invalid_argument");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("round2 MIN-1 modelParams.charter_path must match the accepted path", async () => {
  await withWorkDir(async (workDir) => {
    const parent = join(workDir, "..");
    const path = join(parent, `match-charter-${process.pid}.json`);
    const text = JSON.stringify({}) + "\n";
    await writeFile(path, text, "utf8");
    try {
      const result = await C.acceptCharter(path, workDir, { charter_path: join(parent, "other.json") }, {
        expectedSha256: sha256Hex(text),
      });
      assertRefusal(result, "invalid_argument");
    } finally {
      await rm(path, { force: true });
    }
  });
});

test("round2 MIN-2 an unresolvable charter path refuses instead of throwing", async () => {
  await withWorkDir(async (workDir) => {
    const result = await C.acceptCharter("bad\0path.json", workDir, {}, { expectedSha256: "a".repeat(64) });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(["charter_unreadable", "invalid_argument"].includes(result.reason), result.message);
  });
});
