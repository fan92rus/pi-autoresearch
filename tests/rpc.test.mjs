import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpawnReply, replyEventFor, buildRequest, RpcClientError } from "../extensions/pi-autoresearch/parallel/rpc.ts";
import { parseMetricLines, applyDiff } from "../extensions/pi-autoresearch/parallel/remeasure.ts";

test("replyEventFor", () => {
  assert.equal(replyEventFor("abc-123"), "subagents:rpc:v1:reply:abc-123");
});

test("buildRequest envelope", () => {
  const r = buildRequest("spawn", { agent: "worker" });
  assert.equal(r.version, 1);
  assert.equal(r.method, "spawn");
  assert.ok(typeof r.requestId === "string" && r.requestId.length > 0);
  assert.deepEqual(r.params, { agent: "worker" });
});

test("parseSpawnReply extracts runId from success details", () => {
  const reply = { version: 1, requestId: "r1", success: true, data: { details: { runId: "run-xyz", asyncDir: "/tmp/a" } } };
  assert.deepEqual(parseSpawnReply(reply), { runId: "run-xyz", asyncDir: "/tmp/a" });
});

test("parseSpawnReply throws on error reply", () => {
  const reply = { version: 1, requestId: "r1", success: false, error: { code: "invalid_params", message: "bad" } };
  assert.throws(() => parseSpawnReply(reply), RpcClientError);
});

test("parseSpawnReply throws when runId missing", () => {
  const reply = { version: 1, requestId: "r1", success: true, data: { details: {} } };
  assert.throws(() => parseSpawnReply(reply), /missing runId/);
});

test("parseSpawnReply throws on non-object", () => {
  assert.throws(() => parseSpawnReply(null), /not an object/);
  assert.throws(() => parseSpawnReply("nope"), /not an object/);
});

test("parseMetricLines", () => {
  const out = [
    "building...",
    "METRIC total_ms=15200",
    "METRIC compile_ms=4200",
    "METRIC bad=notanumber",   // ignored
    "METRIC =",                 // ignored
    "METRIC total_ms=16000",    // last wins
    "done",
  ].join("\n");
  const m = parseMetricLines(out);
  assert.equal(m.get("total_ms"), 16000);
  assert.equal(m.get("compile_ms"), 4200);
  assert.equal(m.has("bad"), false);
  assert.equal(m.size, 2);
});

test("parseMetricLines empty", () => {
  assert.equal(parseMetricLines("no metrics here").size, 0);
  assert.equal(parseMetricLines("").size, 0);
});

test("applyDiff throws on non-zero exit code", async () => {
  // E2E bug #9: applyDiff used to silently swallow git apply failures (non-zero exit).
  // Now it must throw so reMeasureWinner reports "apply_failed" instead of
  // running the benchmark on unchanged code and producing a meaningless "regression".
  const failingExec = async () => ({ code: 1, stdout: "", stderr: "error: patch failed" });
  await assert.rejects(
    () => applyDiff(failingExec, "/tmp/fake-workdir", "diff --git a/f b/f\n--- a/f\n+++ b/f\n"),
    /git apply failed/,
  );
});

test("applyDiff succeeds on zero exit code", async () => {
  const okExec = async () => ({ code: 0, stdout: "", stderr: "" });
  // Should not throw — the temp file write + mkdir are mocked implicitly
  // (the exec mock returns 0, and the finally block best-effort rms the temp).
  // We need a real tmp dir for the mkdir/writeFile to succeed:
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = path.join(os.tmpdir(), `applyDiff-test-${Date.now()}`);
  const fs = await import("node:fs");
  fs.mkdirSync(path.join(tmpDir, ".auto", "parallel"), { recursive: true });
  try {
    await applyDiff(okExec, tmpDir, "diff --git a/f b/f\n--- a/f\n+++ b/f\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
