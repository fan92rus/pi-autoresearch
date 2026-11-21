import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

const { createCandidateExecRunner } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "candidate-campaign.ts")).href
);

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("runner did not settle after failed termination")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("unverified killTree still settles the timeout with a bounded failure", async () => {
  const child = fakeChild(4242);
  const spawn = () => child;
  const killTree = async () => ({ ok: true, verified: false, reason: "unverified" });
  const runner = createCandidateExecRunner(spawn, killTree, process.env);

  const result = await settleWithin(runner(["node", "never-exits.js"], { timeoutMs: 20 }), 1500);

  assert.equal(result.code, 124, "timeout must be reported as a failure, not a normal result");
  assert.equal(result.killed, true, "fallback kill must be attempted");
  assert.equal(result.termination, "unverified", "caller must see that termination was not verified");
  assert.match(result.stderr, /killTree unverified/, "partial output must be marked with the termination failure");
});
