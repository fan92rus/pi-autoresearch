import assert from "node:assert/strict";
import test from "node:test";

import { LogParams } from "../extensions/pi-autoresearch/index.ts";

function collectKeyPaths(value, targetKey, path = "$", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeyPaths(item, targetKey, `${path}[${index}]`, hits));
    return hits;
  }

  if (!value || typeof value !== "object") {
    return hits;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === targetKey) {
      hits.push(childPath);
    }
    collectKeyPaths(child, targetKey, childPath, hits);
  }

  return hits;
}

// Under the fork's hermetic test setup, @sinclair/typebox is replaced by a
// callable-proxy stub (tests/typebox-stub.mjs): schemas are functions and do
// not serialize, so the additionalProperties assertion below can only run
// against the real typebox. Skip it when the stub is active.
const serialized = JSON.stringify(LogParams);
const typeboxStubActive = typeof LogParams === "function" || serialized === undefined;

test("log_experiment schema should avoid patternProperties for Cloud Code Assist compatibility", (t) => {
  const patternPropertyPaths = collectKeyPaths(LogParams, "patternProperties");

  assert.equal(
    patternPropertyPaths.length,
    0,
    `unexpected patternProperties found in LogParams schema at: ${patternPropertyPaths.join(", ")}`,
  );

  if (typeboxStubActive) {
    t.skip("typebox stub active — schemas are callable proxies and do not serialize");
    return;
  }

  assert.match(
    serialized,
    /"additionalProperties"/,
    "expected LogParams schema to keep dynamic object support via additionalProperties",
  );
});
