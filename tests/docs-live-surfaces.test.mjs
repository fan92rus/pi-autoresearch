/**
 * Live documentation must not point owners at removed parallel-* flows.
 * Historical docs (PRD.md, TZ.md) are explicitly SUPERSEDED and are not
 * checked here; research-vectors.md is an active, owner-facing guide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const liveGuides = ["docs/research-vectors.md"];

test("active research docs do not advertise removed parallel-* flows", () => {
  for (const relative of liveGuides) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(text, /parallel-\*/, `${relative} still references removed parallel-* commands`);
  }
});
