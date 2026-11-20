/** Anti-gaming regression guard for the v2 hardening scorer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scorer = fs.readFileSync(path.join(repo, ".auto", "measure.sh"), "utf8");
const ledgerPath = path.join(repo, ".auto", "defect-ledger.jsonl");

test("v2 scorer credits only explicitly kept defect rows", () => {
  assert.match(
    scorer,
    /r\.status==="keep"\s*&&\s*r\.mutation_red===true\s*&&\s*r\.guard_restored===true/,
    "measure.sh must require an explicit keep status before crediting a mutation-proven defect",
  );
  const rows = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.length > 0, "defect ledger must be present");
  assert.ok(rows.every((r) => r.status === "keep"), "every surviving defect row must be explicitly kept");
});

test("v2 scorer detects changes to its own files", () => {
  assert.match(scorer, /SCORER_CHANGED=.*\.auto\/measure\.sh/);
  assert.match(scorer, /SCORER_CHANGED=.*\.auto\/config\.json/);
});
