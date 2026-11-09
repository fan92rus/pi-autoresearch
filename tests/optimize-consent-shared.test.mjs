/**
 * Shared consent primitives (openspec: optimize-approval-hardening, step B).
 * canonicalize, unknown-field detection, control/line-break detection, the dialog body and the common
 * consent flow live in brief-consent.ts and are used by both the ordinary loop and research mode.
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/optimize-consent-shared.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as bc from "../extensions/pi-autoresearch/brief-consent.ts";
import * as ob from "../extensions/pi-autoresearch/optimize-brief.ts";

test("B1: canonicalize sorts keys recursively and keeps array order", () => {
  const out = bc.canonicalize({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }, 3] } });
  assert.equal(JSON.stringify(out), '{"a":{"c":[{"y":2,"z":1},3],"d":2},"b":1}');
});

test("B1: the optimize brief bytes are the shared canonical form", () => {
  const brief = { schema_version: 1, name: "n", metric_name: "m", direction: "higher" };
  assert.equal(ob.canonicalBriefBytes(brief), JSON.stringify(bc.canonicalize(brief), null, 2) + "\n");
});

test("B2: unknownKeys returns only the keys outside the allowed set, in input order", () => {
  assert.deepEqual(bc.unknownKeys({ a: 1, x: 2, b: 3, y: 4 }, new Set(["a", "b"])), ["x", "y"]);
  assert.deepEqual(bc.unknownKeys({ a: 1 }, new Set(["a"])), []);
});

test("B3: hasControlOrLineBreak sees every line break and control character, and nothing else", () => {
  const cases = ["a\nb", "a\rb", "a\r\nb", "a\u2028b", "a\u2029b", "a\u0085b", "a\u0000b", "a\u007fb"];
  for (const s of cases) {
    assert.equal(bc.hasControlOrLineBreak(s), true, JSON.stringify(s));
  }
  assert.equal(bc.hasControlOrLineBreak("plain text"), false);
});

test("B3: optimize refuses a control character in name even when it is not a line break", () => {
  const r = ob.validateOptimizeBrief({ name: "a\u0007b", metric_name: "m" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /single line/);
});

test("B4: askConsent without a UI asks nothing and records nothing", async () => {
  let asked = 0;
  let recorded = 0;
  const out = await bc.askConsent({
    hasUi: false,
    title: "t",
    body: "b",
    confirm: async () => ((asked += 1), true),
    record: async () => ((recorded += 1), { ok: true }),
  });
  assert.equal(out.status, "no_ui");
  assert.equal(asked, 0);
  assert.equal(recorded, 0);
});

test("B4: a refusal is recorded as false and reported as refused", async () => {
  const seen = [];
  const out = await bc.askConsent({
    hasUi: true,
    title: "t",
    body: "b",
    confirm: async () => false,
    record: async (confirmed) => (seen.push(confirmed), { ok: true }),
  });
  assert.equal(out.status, "refused");
  assert.deepEqual(seen, [false]);
});

test("B4: a confirmation passes the title and body to the dialog and records true", async () => {
  const shown = [];
  const seen = [];
  const out = await bc.askConsent({
    hasUi: true,
    title: "Title X",
    body: "Brief SHA-256: abc",
    confirm: async (title, body) => (shown.push([title, body]), true),
    record: async (confirmed) => (seen.push(confirmed), { ok: true }),
  });
  assert.equal(out.status, "recorded");
  assert.deepEqual(shown, [["Title X", "Brief SHA-256: abc"]]);
  assert.deepEqual(seen, [true]);
});

test("B4: a failed record after confirmation is reported with its own failure", async () => {
  const failure = { ok: false, reason: "brief_changed", message: "moved" };
  const out = await bc.askConsent({
    hasUi: true,
    title: "t",
    body: "b",
    confirm: async () => true,
    record: async () => failure,
  });
  assert.equal(out.status, "write_failed");
  assert.deepEqual(out.failure, failure);
});

test("B5: the consent body budget holds for every mode (shared 10-line rule)", () => {
  assert.throws(() => bc.consentDialogBody("a".repeat(64), Array.from({ length: 12 }, (_, i) => `l${i}`), "q"), /line budget/);
});

test("B6: the research dialog is assembled by consentDialogBody with its own footer (one place, same bytes)", () => {
  const brief = {
    schema_version: 1,
    goal: "g",
    plan_source: "p",
    caveat_block: "c",
    data_roles: { explore: ["e"], validate: [], confirm: [] },
    questions: [{ id: "q1", text: "t", decision_rules: [{ id: "r1", verdict: "confirmed", when: "w" }] }],
    process_metrics: ["m"],
    stop_rules: [{ id: "s1", when: "w" }],
  };
  const sha = "a".repeat(64);
  const body = bc.briefConsentSummary(brief, sha, "camp-1");
  const expected = bc.consentDialogBody(
    sha,
    [
      "Кампания: camp-1",
      "Цель: g",
      "Вопросов: 1 (q1); правил: 1",
      "Вердикты: confirmed, rejected, inconclusive, waiting_for_data",
      "Стоп-правил: 1; метрик процесса: 1",
      "Замок тестовых данных: нет",
    ],
    "Подтвердить согласование?",
    bc.CONSENT_FOOTER_RESEARCH,
  );
  assert.equal(body, expected);
  assert.ok(body.split("\n").length <= bc.CONSENT_SUMMARY_MAX_LINES);
  assert.ok(body.startsWith(`Brief SHA-256: ${sha}\n`));
});

test("B7: a research goal with many U+0085 (NEL) builds a dialog within the line budget, without throwing", () => {
  const brief = {
    schema_version: 1,
    goal: "x\u0085y\u0085z\u0085a\u0085b\u0085c\u0085d\u0085e\u0085f\u0085g",
    plan_source: "p",
    caveat_block: "c",
    data_roles: { explore: ["e"], validate: [], confirm: [] },
    questions: [{ id: "q1", text: "t", decision_rules: [{ id: "r1", verdict: "confirmed", when: "w" }] }],
    process_metrics: ["m"],
    stop_rules: [{ id: "s1", when: "w" }],
  };
  const body = bc.briefConsentSummary(brief, "a".repeat(64), "camp-1");
  assert.ok(body.split(/\r\n|[\n\r\u2028\u2029\u0085]/).length <= bc.CONSENT_SUMMARY_MAX_LINES);
  assert.ok(body.includes("Цель: x y z a b c d e f g"));
});

// Golden bytes captured from the research dialog before the shared-builder change (parent 7924514^) on the same brief.
test("B8: golden research dialog bytes for a plain brief are unchanged from the parent commit", () => {
  const brief = {
    schema_version: 1,
    goal: "Найти причину деградации",
    plan_source: "p",
    caveat_block: "c",
    data_roles: { explore: ["e"], validate: [], confirm: [] },
    questions: [{ id: "q1", text: "t", decision_rules: [{ id: "r1", verdict: "confirmed", when: "w" }] }],
    process_metrics: ["m"],
    stop_rules: [{ id: "s1", when: "w" }],
  };
  const expected = [
    "Brief SHA-256: " + "a".repeat(64),
    "Кампания: camp-1",
    "Цель: Найти причину деградации",
    "Вопросов: 1 (q1); правил: 1",
    "Вердикты: confirmed, rejected, inconclusive, waiting_for_data",
    "Стоп-правил: 1; метрик процесса: 1",
    "Замок тестовых данных: нет",
    "Подтверждение фиксирует этот SHA-256: вопросы и правила не меняются.",
    "Подтвердить согласование?",
  ].join("\n");
  assert.equal(bc.briefConsentSummary(brief, "a".repeat(64), "camp-1"), expected);
});

test("B9: a single U+0085 in the research goal is flattened (documented deviation: the parent printed 10 physical lines)", () => {
  const brief = {
    schema_version: 1,
    goal: "x\u0085y",
    plan_source: "p",
    caveat_block: "c",
    data_roles: { explore: ["e"], validate: [], confirm: [] },
    questions: [{ id: "q1", text: "t", decision_rules: [{ id: "r1", verdict: "confirmed", when: "w" }] }],
    process_metrics: ["m"],
    stop_rules: [{ id: "s1", when: "w" }],
  };
  const body = bc.briefConsentSummary(brief, "a".repeat(64), "camp-1");
  assert.ok(body.includes("Цель: x y"));
  assert.equal(body.split(/\r\n|[\n\r\u2028\u2029\u0085]/).length, 9);
});
