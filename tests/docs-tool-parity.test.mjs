/**
 * Docs-to-code parity for the autoresearch loop (review of skill and texts, 2026-11-10).
 *
 * The skill (skills/autoresearch-create/SKILL.md) and the README are what the agent and the
 * owner read. A tool that is registered but never named there is invisible; a removed tool
 * that is still described there sends the agent to a call that does not exist. This file
 * checks both directions for the core loop tools.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/docs-tool-parity.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi } from "./fake-pi.ts";

const ROOT = path.join(import.meta.dirname, "..");
const SKILL = fs.readFileSync(path.join(ROOT, "skills", "autoresearch-create", "SKILL.md"), "utf8");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

/** Tools the ordinary loop needs; each must be registered AND named in both docs. */
const CORE_LOOP_TOOLS = [
  "optimize_brief", "init_experiment", "run_experiment", "log_experiment",
  "propose_hypothesis", "tree_status", "record_finding", "update_finding",
  "inspect_results", "search_precedents", "assess_precedents",
  "log_measurement_change", "verify_measurement_change", "log_observation",
  "record_analysis", "direction_review", "finalize_research",
];

/** Removed from this build: must not be registered, and must not be described as callable. */
const REMOVED_TOOLS = ["explore_from", "restore_main", "compose"];

async function registeredToolNames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-parity-"));
  const { pi } = createFakePi({ dir, sessionId: "parity", realGit: false, optimizeFixture: true });
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(ROOT, "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return new Set(pi.tools.map((t) => t.name));
}

test("every core loop tool is registered by the extension", async () => {
  const names = await registeredToolNames();
  const missing = CORE_LOOP_TOOLS.filter((t) => !names.has(t));
  assert.deepStrictEqual(missing, [], `core tools not registered: ${missing.join(", ")}`);
});

test("every core loop tool is named in the skill", () => {
  const missing = CORE_LOOP_TOOLS.filter((t) => !SKILL.includes(t));
  assert.deepStrictEqual(missing, [], `skill does not name: ${missing.join(", ")}`);
});

test("every core loop tool is named in the README", () => {
  const missing = CORE_LOOP_TOOLS.filter((t) => !README.includes(t));
  assert.deepStrictEqual(missing, [], `README does not name: ${missing.join(", ")}`);
});

test("removed tools are not registered", async () => {
  const names = await registeredToolNames();
  const present = REMOVED_TOOLS.filter((t) => names.has(t));
  assert.deepStrictEqual(present, [], `removed tools still registered: ${present.join(", ")}`);
});

test("README and skill do not describe removed tools as callable", () => {
  for (const [label, text] of [["README", README], ["skill", SKILL]]) {
    for (const t of REMOVED_TOOLS) {
      assert.ok(!text.includes(`${t}(`), `${label} still calls ${t}(...)`);
    }
  }
});

test("skill states the two-phase start before any run", () => {
  const start = SKILL.indexOf("optimize_brief draft");
  const init = SKILL.indexOf("`init_experiment` with the same arguments");
  assert.ok(start > 0, "skill names the optimize_brief draft step");
  assert.ok(init > start, "init_experiment with the same arguments comes after the brief");
});

test("skill states the hypothesis step before run_experiment", () => {
  assert.ok(SKILL.includes("Hypothesis first"), "loop rule: propose_hypothesis before run_experiment");
  assert.ok(SKILL.includes("`hypothesis_id`"), "hypothesis_id is named as the link to the run");
});
