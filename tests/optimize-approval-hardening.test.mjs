/**
 * Approval hardening for the ordinary optimization loop (openspec: optimize-approval-hardening, step A).
 * Strict approval.json rules, atomic writes, and the brief-unchanged-since-shown check after the dialog.
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/optimize-approval-hardening.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as ob from "../extensions/pi-autoresearch/optimize-brief.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

const HEX = "a".repeat(64);

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-harden-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function briefArgs(overrides = {}) {
  return { name: "liquid speed", metric_name: "total_us", metric_unit: "us", direction: "lower", ...overrides };
}

function validApproval(overrides = {}) {
  return { schema_version: 1, confirmed: true, brief_sha256: HEX, decided_at: "2026-11-09T10:00:00.000Z", ...overrides };
}

function writeApprovalRaw(dir, content) {
  fs.mkdirSync(path.join(dir, ".auto", "optimize"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "optimize", "approval.json"), content, "utf-8");
  return path.join(dir, ".auto", "optimize");
}

// ── A1: strict approval.json ─────────────────────────────────────────

test("A1: a well-formed approval is accepted", () => {
  const dir = makeWorkDir("ok");
  const od = writeApprovalRaw(dir, JSON.stringify(validApproval()));
  const r = ob.readOptimizeApproval(od);
  assert.equal(r.ok, true);
});

test("A1: confirmed as the string \"true\" is not an approval", () => {
  const dir = makeWorkDir("str");
  const od = writeApprovalRaw(dir, JSON.stringify(validApproval({ confirmed: "true" })));
  const r = ob.readOptimizeApproval(od);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_invalid");
});

test("A1: an extra field makes approval.json invalid", () => {
  const dir = makeWorkDir("extra");
  const od = writeApprovalRaw(dir, JSON.stringify(validApproval({ approved_by: "model" })));
  const r = ob.readOptimizeApproval(od);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_invalid");
  assert.match(r.message, /approved_by/);
});

test("A1: a brief hash that is not 64 lowercase hex is invalid", () => {
  for (const bad of ["a".repeat(63), "A".repeat(64), "g".repeat(64), ""]) {
    const dir = makeWorkDir("hex");
    const od = writeApprovalRaw(dir, JSON.stringify(validApproval({ brief_sha256: bad })));
    const r = ob.readOptimizeApproval(od);
    assert.equal(r.ok, false, `hash ${JSON.stringify(bad)} must be refused`);
    assert.equal(r.reason, "approval_invalid");
  }
});

test("A1: a wrong or missing schema_version is invalid", () => {
  for (const v of [2, "1", undefined]) {
    const dir = makeWorkDir("schema");
    const body = validApproval({ schema_version: v });
    if (v === undefined) delete body.schema_version;
    const od = writeApprovalRaw(dir, JSON.stringify(body));
    const r = ob.readOptimizeApproval(od);
    assert.equal(r.ok, false, `schema_version ${v} must be refused`);
    assert.equal(r.reason, "approval_invalid");
  }
});

test("A1: decided_at must be an ISO 8601 timestamp, not any text", () => {
  for (const v of ["x", "   ", "2026-13-45T99:00:00Z", "yesterday"]) {
    const dir = makeWorkDir("iso");
    const od = writeApprovalRaw(dir, JSON.stringify(validApproval({ decided_at: v })));
    const r = ob.readOptimizeApproval(od);
    assert.equal(r.ok, false, `decided_at ${JSON.stringify(v)} must be refused`);
    assert.equal(r.reason, "approval_invalid");
  }
});

test("A1: decided_at must be a non-empty string", () => {
  for (const v of ["", 0, undefined]) {
    const dir = makeWorkDir("decided");
    const body = validApproval({ decided_at: v });
    if (v === undefined) delete body.decided_at;
    const od = writeApprovalRaw(dir, JSON.stringify(body));
    const r = ob.readOptimizeApproval(od);
    assert.equal(r.ok, false, `decided_at ${JSON.stringify(v)} must be refused`);
    assert.equal(r.reason, "approval_invalid");
  }
});

test("A1: a half-written (invalid JSON) approval.json is approval_invalid, not approved", () => {
  const dir = makeWorkDir("torn");
  const od = writeApprovalRaw(dir, '{"schema_version": 1, "confirmed": tr');
  const r = ob.readOptimizeApproval(od);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "approval_invalid");
});

test("A1: an invalid approval.json blocks the start gate with approval_invalid", () => {
  const dir = makeWorkDir("gate");
  const od = writeApprovalRaw(dir, JSON.stringify(validApproval({ confirmed: "yes" })));
  ob.writeOptimizeBriefDraft(od, briefArgs());
  const gate = ob.approvedBriefFor(od);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "approval_invalid");
});

// ── A2: atomic writes ────────────────────────────────────────────────

test("A2: a failed rename keeps the previous file content and leaves no temporary file", () => {
  const dir = makeWorkDir("atomic");
  const target = path.join(dir, "approval.json");
  fs.writeFileSync(target, "OLD", "utf-8");
  assert.throws(
    () =>
      ob.writeTextAtomicSync(target, "NEW", () => {
        throw new Error("simulated rename failure");
      }),
    /simulated rename failure/,
  );
  assert.equal(fs.readFileSync(target, "utf-8"), "OLD");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("A2: a successful draft write leaves no temporary file and the bytes match the hash", () => {
  const dir = makeWorkDir("draftatomic");
  const od = ob.optimizeDirOf(dir);
  const res = ob.writeOptimizeBriefDraft(od, briefArgs());
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readdirSync(od).filter((f) => f.endsWith(".tmp")), []);
  const bytes = fs.readFileSync(path.join(od, ob.OPTIMIZE_BRIEF_FILE));
  assert.equal(sha256Hex(bytes), res.sha256);
});

// ── A3: approval is bound to the brief the owner saw ─────────────────

test("A3: an approval for a brief changed on disk after it was shown is refused and not written", () => {
  const dir = makeWorkDir("bound");
  const od = ob.optimizeDirOf(dir);
  const draft = ob.writeOptimizeBriefDraft(od, briefArgs());
  fs.writeFileSync(path.join(od, ob.OPTIMIZE_BRIEF_FILE), ob.canonicalBriefBytes({ schema_version: 1, name: "changed", metric_name: "total_us" }), "utf-8");
  const r = ob.writeOptimizeApproval(od, true, draft.sha256);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(od, ob.OPTIMIZE_APPROVAL_FILE)), false);
});

test("A3: a refusal is recorded even when the brief moved, and never confirms", () => {
  const dir = makeWorkDir("refusebound");
  const od = ob.optimizeDirOf(dir);
  const draft = ob.writeOptimizeBriefDraft(od, briefArgs());
  const r = ob.writeOptimizeApproval(od, false, draft.sha256);
  assert.equal(r.ok, true);
  const a = JSON.parse(fs.readFileSync(path.join(od, ob.OPTIMIZE_APPROVAL_FILE), "utf-8"));
  assert.equal(a.confirmed, false);
});

test("A3 wiring: the brief changed while the owner dialog is open is not approved", async () => {
  const dir = makeWorkDir("wiring");
  const { pi, tool, command } = createFakePi({ dir, sessionId: "harden-wiring", realGit: false });
  const ctx = makeCtx(dir, "harden-wiring", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  const od = ob.optimizeDirOf(dir);
  const call = (params) => tool("optimize_brief").execute("t-" + Math.random().toString(36).slice(2), params, undefined, undefined, ctx);
  await call({ action: "draft", brief: briefArgs() });
  ctx.ui.confirm = async () => {
    fs.writeFileSync(path.join(od, ob.OPTIMIZE_BRIEF_FILE), ob.canonicalBriefBytes({ schema_version: 1, name: "swapped", metric_name: "total_us" }), "utf-8");
    return true;
  };
  const res = await call({ action: "propose" });
  assert.match(res?.content?.[0]?.text ?? "", /changed while it was shown/);
  assert.equal(fs.existsSync(path.join(od, ob.OPTIMIZE_APPROVAL_FILE)), false);
});
