import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { killTree } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bash-shell.ts")).href
);

function fakeSpawn(emitter) {
  return () => emitter;
}

function winDeps(spawnImpl, isAlive = () => false, timeoutMs = 50) {
  return { platform: "win32", spawn: spawnImpl, isAlive, timeoutMs };
}

test("Windows taskkill spawn error returns an explicit failed outcome", async () => {
  const emitter = new EventEmitter();
  const pending = killTree(4242, winDeps(fakeSpawn(emitter)));
  emitter.emit("error", new Error("spawn ENOENT"));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "spawn_failed");
});

test("non-zero taskkill exit status is reported as command_failed", async () => {
  const emitter = new EventEmitter();
  const pending = killTree(4242, winDeps(fakeSpawn(emitter)));
  emitter.emit("close", 1, null);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "command_failed");
});

test("zero exit status with a live target is explicitly unverified", async () => {
  const emitter = new EventEmitter();
  const pending = killTree(4242, winDeps(fakeSpawn(emitter), () => true));
  emitter.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "unverified");
});

test("zero exit status with a dead target is verified killed", async () => {
  const emitter = new EventEmitter();
  const pending = killTree(4242, winDeps(fakeSpawn(emitter), () => false));
  emitter.emit("close", 0, null);
  const result = await pending;
  assert.deepEqual(result, { ok: true, verified: true, reason: "killed" });
});

test("a hung taskkill resolves with a bounded timeout outcome", async () => {
  const emitter = new EventEmitter();
  const result = await killTree(4242, winDeps(fakeSpawn(emitter), () => true, 10));
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "timeout");
});
