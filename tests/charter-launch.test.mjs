/**
 * charter-launch unit tests: two-phase charter draft and chain launch.
 *
 * Run: timeout 60 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/charter-launch.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "../extensions/pi-autoresearch/charter-launch.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

async function withWorkDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "charter-launch-"));
  const workDir = join(root, "work");
  const external = join(root, "external");
  await (await import("node:fs/promises")).mkdir(workDir);
  await (await import("node:fs/promises")).mkdir(external);
  try { await fn({ root, workDir, external, charterPath: join(external, "charter.json") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of (await readdir(dir)).sort()) {
    const full = join(dir, name);
    try { out[name] = await readFile(full); } catch { out[name] = "<dir>"; }
  }
  return out;
}
function refusal(result, reason) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, reason, result.message);
  assert.equal(/[\r\n]/.test(result.message), false);
}

test("serializeCharter emits canonical JSON plus newline with deterministic hash", () => {
  const charter = { max_campaigns: 3, stop_rules: ["two failures"] };
  const bytes = L.serializeCharter(charter);
  assert.equal(bytes, JSON.stringify(charter, null, 2) + "\n");
  assert.equal(sha256Hex(bytes), sha256Hex(L.serializeCharter(charter)));
});

test("draft/propose call parameters use strict allowlists", () => {
  assert.equal(L.validateCharterLaunchCall("draft", { charter: {} }).ok, true);
  for (const field of ["approved", "confirmed", "owner_confirmed", "expected_sha256", "charter_sha256"]) {
    const r = L.validateCharterLaunchCall("draft", { charter: {}, [field]: true });
    refusal(r, "invalid_argument"); assert.ok(r.message.includes(field));
  }
  assert.equal(L.validateCharterLaunchCall("propose", {}).ok, true);
  assert.equal(L.validateCharterLaunchCall("propose", undefined).ok, true);
  refusal(L.validateCharterLaunchCall("propose", { anything: true }), "invalid_argument");
});

test("validateDraftCharter accepts valid drafts and reports all charter errors", () => {
  for (const charter of [{}, { max_campaigns: 3, stop_rules: ["x"] }]) assert.equal(L.validateDraftCharter(charter).ok, true);
  for (const charter of [{ unknown: true }, { max_campaigns: 0 }, { stop_rules: [""] }, { stop_rules: ["change verdict"] }]) {
    const r = L.validateDraftCharter(charter); refusal(r, "charter_invalid"); assert.ok(r.message.length > 0);
  }
  assert.ok(L.validateDraftCharter({ unknown: true }).message.includes("unknown field"));
});

test("launchFromDraft writes exact bytes, verifies them, then creates one journal", async () => {
  await withWorkDir(async ({ workDir, charterPath }) => {
    const charter = { max_campaigns: 3 }; const rootId = "root-1"; const calls = [];
    let reread;
    const result = await L.launchFromDraft({ charter, workDir, rootId, charterPath,
      readFileUtf8: async (path) => { reread = await readFile(path, "utf8"); return reread; },
      createChainJournal: async (...args) => { calls.push(args); return { ok: true }; },
    });
    const sha = sha256Hex(L.serializeCharter(charter));
    assert.equal(result.ok, true); assert.deepEqual(await readFile(charterPath, "utf8"), L.serializeCharter(charter));
    assert.equal(reread, L.serializeCharter(charter));
    assert.deepEqual(result.firstLaunch, { path: charterPath, sha256: sha, chainId: rootId + "-chain", rootCampaignId: rootId });
    assert.deepEqual(calls, [[workDir, rootId + "-chain", rootId]]);
  });
});

test("existing charter path is preserved and chain creation is skipped", async () => {
  await withWorkDir(async ({ root, workDir, charterPath }) => {
    await writeFile(charterPath, "existing"); const before = await snapshot(root); let called = false;
    const r = await L.launchFromDraft({ charter: {}, workDir, rootId: "root", charterPath, createChainJournal: async () => { called = true; return { ok: true }; } });
    refusal(r, "charter_path_taken"); assert.equal(called, false); assert.deepEqual(await snapshot(root), before);
  });
});

test("changed charter bytes are removed before any chain creation", async () => {
  await withWorkDir(async ({ workDir, charterPath }) => {
    let called = false;
    const r = await L.launchFromDraft({ charter: {}, workDir, rootId: "root", charterPath,
      writeFileExclusive: async (path) => writeFile(path, "mutated", { flag: "wx" }),
      createChainJournal: async () => { called = true; return { ok: true }; },
    });
    refusal(r, "charter_changed"); assert.equal(existsSync(charterPath), false); assert.equal(called, false);
  });
});

test("rollback keeps an existing foreign chain directory on campaign_exists", async () => {
  await withWorkDir(async ({ workDir, charterPath }) => {
    const chainId = "root-chain"; const chainDir = join(workDir, ".auto", "research-chain", chainId);
    const journalPath = join(chainDir, "chain.json");
    await (await import("node:fs/promises")).mkdir(chainDir, { recursive: true });
    await writeFile(journalPath, "PRE-EXISTING");
    const r = await L.launchFromDraft({ charter: {}, workDir, rootId: "root", charterPath,
      createChainJournal: async () => ({ ok: false, reason: "campaign_exists", message: "already exists" }),
    });
    refusal(r, "campaign_exists");
    assert.equal(existsSync(journalPath), true);
    assert.equal(await readFile(journalPath, "utf8"), "PRE-EXISTING");
    assert.equal(existsSync(charterPath), false);
  });
});

test("rollback removes the chain directory created by this operation", async () => {
  await withWorkDir(async ({ workDir, charterPath }) => {
    const chainId = "root-chain"; const chainDir = join(workDir, ".auto", "research-chain", chainId);
    const r = await L.launchFromDraft({ charter: {}, workDir, rootId: "root", charterPath,
      createChainJournal: async () => { await (await import("node:fs/promises")).mkdir(chainDir, { recursive: true }); return { ok: false, reason: "operation_failed", message: "no" }; },
    });
    refusal(r, "operation_failed");
    assert.equal(existsSync(chainDir), false);
    assert.equal(existsSync(charterPath), false);
  });
});

test("non-EEXIST exclusive-write error returns operation_failed without creating files", async () => {
  await withWorkDir(async ({ root, workDir, charterPath }) => {
    const before = await snapshot(root);
    const r = await L.launchFromDraft({ charter: {}, workDir, rootId: "root", charterPath, writeFileExclusive: async () => { throw new Error("disk unavailable"); } });
    refusal(r, "operation_failed"); assert.deepEqual(await snapshot(root), before);
  });
});
