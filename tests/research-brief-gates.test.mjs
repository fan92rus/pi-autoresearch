/**
 * openspec/changes/brief-verdicts-and-evidence-gate, tasks 1.1-1.3:
 * brief-declared verdict names, the evidence_gate fields and the glob matcher.
 * Brief shape and refusals come from research-state.ts; the record-time gate
 * is exercised through the extension in research-brief-gates-wiring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as R from "../extensions/pi-autoresearch/research-state.ts";

const DEFAULTS = ["confirmed", "rejected", "inconclusive", "waiting_for_data"];

/** Brief whose verdict names are declared by the brief itself (lob-style). */
function customBrief(overrides = {}) {
  const names = ["test-consistent", "rejected", "inconclusive", "waiting_for_data"];
  return {
    schema_version: 1,
    goal: "Check whether the order-book reaction holds on validate data.",
    plan_source: "protocol.md",
    caveat_block: "Test-consistent means consistent with the test split; no confirmation is claimed.",
    data_roles: { explore: ["ep_a.jsonl"], validate: ["ep_v.jsonl"], confirm: [] },
    verdicts: names,
    questions: [
      {
        id: "Q1",
        text: "Does the reaction appear on validate data?",
        decision_rules: [
          { id: "Q1-tc", verdict: "test-consistent", when: "effect holds on validate data" },
          { id: "Q1-no", verdict: "rejected", when: "effect absent on validate data" },
          { id: "Q1-unk", verdict: "inconclusive", when: "noise exceeds effect" },
          { id: "Q1-wait", verdict: "waiting_for_data", when: "validate data missing" },
        ],
        needs_data: null,
      },
    ],
    process_metrics: ["runs"],
    stop_rules: [{ id: "S1", when: "two rejected vectors in a row" }],
    ...overrides,
  };
}

/** Brief with no verdicts field: must behave exactly like the current schema. */
function defaultBrief(overrides = {}) {
  const brief = customBrief(overrides);
  delete brief.verdicts;
  brief.questions[0].decision_rules = [
    { id: "Q1-yes", verdict: "confirmed", when: "holds" },
    { id: "Q1-no", verdict: "rejected", when: "absent" },
    { id: "Q1-unk", verdict: "inconclusive", when: "noise" },
    { id: "Q1-wait", verdict: "waiting_for_data", when: "missing" },
  ];
  return brief;
}

function errorsOf(brief) {
  const result = R.validateBrief(brief);
  assert.equal(result.ok, false, "brief must be refused");
  return result.errors.join("\n");
}

// ─── 1.1 verdicts declared by the brief ──────────────────────────────────────

test("a brief declaring its own verdict names is accepted", () => {
  const result = R.validateBrief(customBrief());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(R.briefVerdicts(result.brief), ["test-consistent", "rejected", "inconclusive", "waiting_for_data"]);
});

test("a brief without verdicts keeps the default four names", () => {
  const result = R.validateBrief(defaultBrief());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(R.briefVerdicts(result.brief), DEFAULTS);
  assert.deepEqual(R.briefVerdicts({}), DEFAULTS);
});

test("a rule using a verdict the brief does not declare is refused", () => {
  const brief = customBrief();
  brief.questions[0].decision_rules.push({ id: "Q1-yes", verdict: "confirmed", when: "holds" });
  const text = errorsOf(brief);
  assert.match(text, /verdict "confirmed" is not declared in brief\.verdicts/);
});

test("a declared verdict without a rule on a question is refused", () => {
  const brief = customBrief();
  brief.questions[0].decision_rules = brief.questions[0].decision_rules.filter((r) => r.verdict !== "test-consistent");
  assert.match(errorsOf(brief), /has no decision rule with verdict "test-consistent"/);
});

test("the defaults are still required when the brief omits verdicts", () => {
  const brief = defaultBrief();
  brief.questions[0].decision_rules = brief.questions[0].decision_rules.filter((r) => r.verdict !== "waiting_for_data");
  assert.match(errorsOf(brief), /has no decision rule with verdict "waiting_for_data"/);
});

test("verdicts must be a non-empty list of unique well-formed names", () => {
  assert.match(errorsOf(customBrief({ verdicts: [] })), /brief\.verdicts must be a non-empty array/);
  assert.match(errorsOf(customBrief({ verdicts: "test-consistent" })), /brief\.verdicts must be a non-empty array/);
  assert.match(errorsOf(customBrief({ verdicts: ["Bad Name", "rejected"] })), /brief\.verdicts\[0\] must match/);
  assert.match(errorsOf(customBrief({ verdicts: ["rejected", "rejected"] })), /brief\.verdicts\[1\] duplicates "rejected"/);
});

test("an unknown brief field is still refused", () => {
  assert.match(errorsOf(customBrief({ notes: "x" })), /brief has unknown field "notes"/);
});

// ─── 1.3 evidence_gate fields ────────────────────────────────────────────────

const GATE = { blocked_globs: ["data/episodes_test*.jsonl"], gate_file: "gate/tg.json", gate_contains: "TEST_GATE_OPEN" };

test("a valid evidence_gate is accepted and absence means no gate", () => {
  const accepted = R.validateBrief(customBrief({ evidence_gate: GATE }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.brief.evidence_gate, GATE);
  assert.equal(R.validateBrief(customBrief()).brief.evidence_gate, undefined);
});

test("evidence_gate.gate_file must stay inside the work directory", () => {
  for (const gate_file of ["../outside.json", "/etc/gate.json", "C:/gate.json", "a/../../b.json", "\\\\srv\\gate"]) {
    assert.match(
      errorsOf(customBrief({ evidence_gate: { ...GATE, gate_file } })),
      /gate_file must be a relative path inside the work directory/,
      gate_file,
    );
  }
});

test("evidence_gate needs non-empty blocked_globs and gate_contains", () => {
  assert.match(errorsOf(customBrief({ evidence_gate: { ...GATE, blocked_globs: [] } })), /blocked_globs must be a non-empty array/);
  assert.match(errorsOf(customBrief({ evidence_gate: { ...GATE, blocked_globs: [""] } })), /blocked_globs must be a non-empty array/);
  assert.match(errorsOf(customBrief({ evidence_gate: { ...GATE, gate_contains: " " } })), /gate_contains must be a non-empty string/);
});

test("evidence_gate rejects unknown and missing fields", () => {
  assert.match(errorsOf(customBrief({ evidence_gate: { ...GATE, extra: 1 } })), /evidence_gate has unknown field "extra"/);
  const { gate_contains, ...partial } = GATE;
  assert.match(errorsOf(customBrief({ evidence_gate: partial })), /evidence_gate is missing field "gate_contains"/);
  assert.match(errorsOf(customBrief({ evidence_gate: "yes" })), /brief\.evidence_gate must be an object/);
});

// ─── 1.3 glob matcher ────────────────────────────────────────────────────────

test("matchesGlob: * stays inside one path segment", () => {
  assert.equal(R.matchesGlob("data/episodes_test_v1.jsonl", "data/episodes_test*.jsonl"), true);
  assert.equal(R.matchesGlob("data/episodes_test_v1.json", "data/episodes_test*.jsonl"), false);
  assert.equal(R.matchesGlob("data/sub/episodes_test_v1.jsonl", "data/episodes_test*.jsonl"), false);
  assert.equal(R.matchesGlob("data/x.jsonl", "data/*.jsonl"), true);
  assert.equal(R.matchesGlob("data/a/x.jsonl", "data/*.jsonl"), false);
});

test("matchesGlob: ** spans zero or more whole segments", () => {
  assert.equal(R.matchesGlob("holdout/x.jsonl", "**/x.jsonl"), true);
  assert.equal(R.matchesGlob("a/b/c/x.jsonl", "**/x.jsonl"), true);
  assert.equal(R.matchesGlob("x.jsonl", "**/x.jsonl"), true);
  assert.equal(R.matchesGlob("a/b/test/c.jsonl", "a/**/test/*.jsonl"), true);
  assert.equal(R.matchesGlob("a/test/c.jsonl", "a/**/test/*.jsonl"), true);
  assert.equal(R.matchesGlob("a/b/testing.jsonl", "a/**/test/*.jsonl"), false);
});

test("matchesGlob normalizes backslashes and a leading ./", () => {
  assert.equal(R.matchesGlob("data\\episodes_test_v1.jsonl", "data/episodes_test*.jsonl"), true);
  assert.equal(R.matchesGlob("./data/episodes_test_v1.jsonl", "data/episodes_test*.jsonl"), true);
});

test("matchesGlob treats regex metacharacters in globs literally", () => {
  assert.equal(R.matchesGlob("data/a+b(1).jsonl", "data/a+b(1).jsonl"), true);
  assert.equal(R.matchesGlob("data/aab1.jsonl", "data/a+b(1).jsonl"), false);
});

test("the module still exports the default verdict list and the Verdict-typed VERDICTS alias", () => {
  assert.deepEqual([...R.DEFAULT_VERDICTS], DEFAULTS);
  assert.deepEqual([...R.VERDICTS], DEFAULTS);
});
