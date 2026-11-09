/**
 * Shared consent primitives (openspec: optimize-approval-hardening, step B).
 * canonicalize, unknown-field detection, line-break detection and the common consent flow
 * live in brief-consent.ts and are used by both the ordinary loop and research mode.
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

test("B3: hasLineBreak sees every physical line break, and nothing else", () => {
  for (const s of ["a\nb", "a\rb", "a\r\nb", "a\u2028b", "a\u2029b", "a\u0085b"]) {
    assert.equal(bc.hasLineBreak(s), true, JSON.stringify(s));
  }
  assert.equal(bc.hasLineBreak("plain text"), false);
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
