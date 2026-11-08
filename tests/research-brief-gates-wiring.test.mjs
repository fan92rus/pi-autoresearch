/**
 * openspec/changes/brief-verdicts-and-evidence-gate, tasks 2.1-2.3: the research
 * tools accept a brief's declared verdict names at close and refuse record on a
 * blocked test-split path until the gate file exists in the work directory.
 * Runs the REAL extension on a fake pi (same harness as research-branch-wiring).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

const TEST_FILE = "data/episodes_test_v1.jsonl";
const GATE_FILE = "gate/test-gate.json";
const GATE_MARKER = "TEST_GATE_OPEN";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-gates-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, TEST_FILE), "ep1 test\nep2 test\nep3 test\n");
  return dir;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Brief for lob-style verdict names with a test-split gate. */
function lobBrief() {
  const names = ["test-consistent", "rejected", "inconclusive", "waiting_for_data"];
  const rules = [
    { id: "Q1-tc", verdict: "test-consistent", when: "effect holds on the test split" },
    { id: "Q1-no", verdict: "rejected", when: "effect absent on the test split" },
    { id: "Q1-unk", verdict: "inconclusive", when: "noise exceeds effect" },
    { id: "Q1-wait", verdict: "waiting_for_data", when: "test split missing" },
  ];
  return {
    schema_version: 1,
    goal: "Check whether the reaction holds on the held-out episodes.",
    plan_source: "protocol.md",
    caveat_block: "Test-consistent means consistent with the test split; it is not a confirmation.",
    data_roles: { explore: ["data/episodes_train.jsonl"], validate: ["data/episodes_val.jsonl"], confirm: [] },
    verdicts: names,
    evidence_gate: { blocked_globs: ["data/episodes_test*.jsonl"], gate_file: GATE_FILE, gate_contains: GATE_MARKER },
    questions: [
      { id: "Q1", text: "Does the reaction hold on the test split?", decision_rules: rules, needs_data: null },
    ],
    process_metrics: ["episodes read"],
    stop_rules: [{ id: "S1", when: "two rejected vectors in a row" }],
  };
}

async function loadExtension(dir, label) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: `gates-${label}`, realGit: false });
  const ctx = makeCtx(dir, `gates-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1", ctx);
  return { pi, tool, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

function readLog(dir) {
  const text = fs.readFileSync(path.join(dir, ".auto", "research", "c1", "log.jsonl"), "utf8");
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

/** Drafts the brief, approves it through the owner dialog, starts the research phase. */
async function startCampaign(h) {
  const draft = await call(h, "research_brief", { action: "draft", brief: lobBrief() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  const sha = sha256Of(fs.readFileSync(path.join(h.dir, ".auto", "research", "c1", "brief.json")));
  assert.match(textOf(await call(h, "research", { action: "start", expected_sha256: sha })), /started/);
}

test("close accepts a verdict the brief declares and refuses one it does not", async () => {
  const dir = makeWorkDir("close");
  const h = await loadExtension(dir, "close");
  await startCampaign(h);
  assert.match(textOf(await call(h, "research", { action: "open", question_id: "Q1" })), /Vector Q1 opened/);
  // Evidence from a non-test path is not gated.
  fs.writeFileSync(path.join(dir, "data", "episodes_val.jsonl"), "v1\nv2\n");
  assert.match(
    textOf(await call(h, "research", { action: "record", evidence_ref: "data/episodes_val.jsonl:1-2" })),
    /Evidence recorded/,
  );
  const refused = textOf(
    await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-no", verdict: "confirmed" }),
  );
  assert.match(refused, /verdict must be one of the brief's declared verdicts: test-consistent, rejected, inconclusive, waiting_for_data/);
  assert.equal(readLog(dir).filter((e) => e.event === "close").length, 0, "refused close must not be logged");
  assert.match(
    textOf(await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-tc", verdict: "test-consistent" })),
    /closed: test-consistent by rule Q1-tc/,
  );
});

test("record on a blocked test-split path is refused until the gate file contains the marker", async () => {
  const dir = makeWorkDir("gate");
  const h = await loadExtension(dir, "gate");
  await startCampaign(h);
  assert.match(textOf(await call(h, "research", { action: "open", question_id: "Q1" })), /Vector Q1 opened/);

  const blocked = textOf(await call(h, "research", { action: "record", evidence_ref: `${TEST_FILE}:1-2` }));
  assert.match(blocked, /blocked test split \(evidence_gate\)/, blocked);
  assert.equal(readLog(dir).filter((e) => e.event === "record").length, 0, "blocked record must not be logged");

  // Gate file present but without the marker: still refused.
  fs.mkdirSync(path.join(dir, "gate"), { recursive: true });
  fs.writeFileSync(path.join(dir, GATE_FILE), "{}\n");
  assert.match(textOf(await call(h, "research", { action: "record", evidence_ref: `${TEST_FILE}:1-2` })), /blocked test split/);

  // Gate file with the marker: the record goes through.
  fs.writeFileSync(path.join(dir, GATE_FILE), `{"${GATE_MARKER}": true}\n`);
  assert.match(
    textOf(await call(h, "research", { action: "record", evidence_ref: `${TEST_FILE}:1-2` })),
    /Evidence recorded/,
  );
  assert.equal(readLog(dir).filter((e) => e.event === "record").length, 1);
});
