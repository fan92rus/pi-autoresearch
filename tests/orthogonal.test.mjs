import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFileScope, findScopeConflicts } from "../extensions/pi-autoresearch/parallel/orthogonal.ts";

test("diffFileScope parses b/ targets", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 123..456 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "diff --git a/README.md b/README.md",
  ].join("\n");
  assert.deepEqual(diffFileScope(diff), ["README.md", "src/foo.ts"]);
});

test("diffFileScope handles no-diff and renames", () => {
  assert.deepEqual(diffFileScope(""), []);
  assert.deepEqual(diffFileScope("nothing here"), []);
});

test("findScopeConflicts detects overlapping file scopes", () => {
  const scopes = new Map([
    ["A", ["src/a.ts", "src/b.ts"]],
    ["B", ["src/b.ts", "src/c.ts"]],   // shares src/b.ts with A
    ["C", ["src/d.ts"]],               // disjoint
  ]);
  const conflicts = findScopeConflicts(scopes);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].a, "A");
  assert.equal(conflicts[0].b, "B");
  assert.deepEqual(conflicts[0].sharedFiles, ["src/b.ts"]);
});

test("findScopeConflicts: disjoint scopes → no conflicts", () => {
  const scopes = new Map([
    ["A", ["Dockerfile"]],
    ["B", ["Makefile"]],
    ["C", ["webpack.config.js"]],
  ]);
  assert.equal(findScopeConflicts(scopes).length, 0);
});

test("findScopeConflicts: three-way overlap", () => {
  const scopes = new Map([
    ["A", ["x.ts", "shared.ts"]],
    ["B", ["shared.ts"]],
    ["C", ["shared.ts", "y.ts"]],
  ]);
  const conflicts = findScopeConflicts(scopes);
  assert.equal(conflicts.length, 3); // A-B, A-C, B-C
});
