/**
 * candidate-policy (openspec/changes/candidate-branches, task
 * pi-autoresearch-3e4.4.1.1):
 * standalone validation of the candidate-branch campaign policy and explicit
 * human consent through a passed-in UI.
 *
 * Covered here:
 *  - validateCandidatePolicy: a complete valid policy passes and is deeply
 *    frozen (immutable for the campaign); invalid and missing values for
 *    every field are rejected with field-naming errors, nothing is silently
 *    substituted or defaulted; unknown top-level fields are rejected (an
 *    agent cannot smuggle a consent flag into the policy object); empty
 *    argv arrays are rejected for both benchmark and checks (design §3:
 *    promotion requires successful checks for the exact checkpoint, so an
 *    empty checks_argv is never a valid "no checks" choice);
 *    methodology_files must pin at least one file with a 64-char hex sha256;
 *    change_files must not contain methodology paths; arrays are checked
 *    element-wise with indices.
 *  - formatCandidatePolicy: renders every field for the user dialog; every
 *    user-controlled string value (metric_name, each argv element, each
 *    methodology path, each change file) is JSON-quoted individually, so
 *    values containing commas (e.g. "a,b"), LF, CR, ESC or tabs are shown
 *    exactly as visible escapes, without argv distortion and without
 *    control-character injection into the dialog text; each rendered string
 *    JSON-parses back to the exact original value. Validation diagnostics
 *    that embed user strings (unknown field names, duplicates) and consent
 *    failure reasons embedding UI error messages stay honest single lines:
 *    control characters there are escaped, never injected.
 *  - confirmCandidatePolicy / requestCandidatePolicyConsent: consent comes
 *    only from the real user via the passed-in UI confirm dialog returning
 *    `true`; refusal (false), missing UI, missing confirm method, thrown or
 *    rejected UI errors, cancellation (undefined) and any non-boolean
 *    answer (including truthy strings like "yes") all block with
 *    ok:false; a boolean `confirmed` field inside the raw policy is a
 *    validation error, not consent — there is no flag parameter anywhere in
 *    the API; an invalid policy blocks before the user is asked (the dialog
 *    must not open); the dialog is presented the exact formatted policy.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/candidate-policy.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateCandidatePolicy,
  formatCandidatePolicy,
  confirmCandidatePolicy,
  requestCandidatePolicyConsent,
} from "../extensions/pi-autoresearch/candidate-policy.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A complete, valid policy proposal (design.md §3 field set). */
function validPolicyRaw() {
  return {
    metric_name: "p95_latency_ms",
    direction: "lower",
    repeats: 3,
    min_gain: 5,
    benchmark_argv: ["node", "bench.js", "--runs", "10"],
    checks_argv: ["node", "check.js"],
    benchmark_timeout_seconds: 30,
    confirm_budget_seconds: 600,
    candidate_step_limit: 20,
    candidate_time_limit_seconds: 3600,
    methodology_files: [{ path: "docs/methodology.md", sha256: SHA_A }],
    change_files: ["src/algorithm.ts", "src/algorithm.test.ts"],
  };
}

/** Fake UI: records the dialog, returns a canned answer. */
function makeUi(answer, opts) {
  const calls = [];
  const ui = {
    confirm: async (title, message) => {
      calls.push({ title, message });
      if (opts?.throwInConfirm) throw opts.throwInConfirm;
      return answer;
    },
  };
  return { ui, calls };
}

// ─── validateCandidatePolicy: valid policy ───────────────────────────────────

test("valid complete policy passes validation", () => {
  const result = validateCandidatePolicy(validPolicyRaw());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.policy);
  assert.equal(result.policy.metric_name, "p95_latency_ms");
  assert.equal(result.policy.direction, "lower");
  assert.equal(result.policy.repeats, 3);
  assert.equal(result.policy.min_gain, 5);
  assert.deepEqual(result.policy.benchmark_argv, ["node", "bench.js", "--runs", "10"]);
  assert.deepEqual(result.policy.checks_argv, ["node", "check.js"]);
  assert.equal(result.policy.benchmark_timeout_seconds, 30);
  assert.equal(result.policy.confirm_budget_seconds, 600);
  assert.equal(result.policy.candidate_step_limit, 20);
  assert.equal(result.policy.candidate_time_limit_seconds, 3600);
  assert.deepEqual(result.policy.methodology_files, [
    { path: "docs/methodology.md", sha256: SHA_A },
  ]);
  assert.deepEqual(result.policy.change_files, ["src/algorithm.ts", "src/algorithm.test.ts"]);
});

test("validated policy is deeply frozen (immutable for the campaign)", () => {
  const result = validateCandidatePolicy(validPolicyRaw());
  assert.ok(result.policy);
  const policy = result.policy;
  assert.throws(() => {
    policy.metric_name = "other";
  });
  assert.throws(() => {
    policy.benchmark_argv.push("extra");
  });
  assert.throws(() => {
    policy.methodology_files[0].sha256 = SHA_B;
  });
  assert.throws(() => {
    policy.methodology_files.push({
      path: "x.md",
      sha256: SHA_B,
    });
  });
  assert.throws(() => {
    policy.change_files.push("src/other.ts");
  });
});

test("min_gain of 0 is allowed (>= 0), promotion still requires strictly greater", () => {
  const raw = validPolicyRaw();
  raw.min_gain = 0;
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, true);
  assert.ok(result.policy);
  assert.equal(result.policy.min_gain, 0);
});

test("empty checks_argv is rejected: successful checks are required for the exact checkpoint", () => {
  const raw = validPolicyRaw();
  raw.checks_argv = [];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.equal(result.policy, undefined);
  assert.ok(
    result.errors.some((e) => e.includes('"checks_argv"') && e.includes("at least 1 entry")),
    `errors: ${JSON.stringify(result.errors)}`,
  );
});

test("benchmark_argv empty array is rejected the same way", () => {
  const raw = validPolicyRaw();
  raw.benchmark_argv = [];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"benchmark_argv"')));
});

// ─── validateCandidatePolicy: missing values (never silently substituted) ────

test("every missing field is reported by name, nothing is defaulted", () => {
  const result = validateCandidatePolicy({});
  assert.equal(result.ok, false);
  for (const field of [
    "metric_name",
    "direction",
    "repeats",
    "min_gain",
    "benchmark_argv",
    "checks_argv",
    "benchmark_timeout_seconds",
    "confirm_budget_seconds",
    "candidate_step_limit",
    "candidate_time_limit_seconds",
    "methodology_files",
    "change_files",
  ]) {
    assert.ok(
      result.errors.some((e) => e.includes(`"${field}"`) && e.includes("required")),
      `expected a missing-field error for "${field}", errors: ${JSON.stringify(result.errors)}`,
    );
  }
  assert.equal(result.policy, undefined);
});

test("null, array and scalar policy inputs are rejected as not-an-object", () => {
  for (const input of [null, undefined, [], "policy", 42, true]) {
    const result = validateCandidatePolicy(input);
    assert.equal(result.ok, false, `input ${JSON.stringify(input)} must fail`);
    assert.ok(result.errors.length > 0);
    assert.equal(result.policy, undefined);
  }
});

// ─── validateCandidatePolicy: invalid values ────────────────────────────────

test("metric_name must be a non-empty string", () => {
  for (const bad of [null, "", "   ", 42, [], {}]) {
    const raw = validPolicyRaw();
    raw.metric_name = bad;
    const result = validateCandidatePolicy(raw);
    assert.equal(result.ok, false, `metric_name=${JSON.stringify(bad)} must fail`);
    assert.ok(
      result.errors.some((e) => e.includes('"metric_name"')),
      `errors: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("direction must be exactly higher or lower", () => {
  for (const bad of ["Higher", "HIGHER", "up", "desc", "", null, 1, true]) {
    const raw = validPolicyRaw();
    raw.direction = bad;
    const result = validateCandidatePolicy(raw);
    assert.equal(result.ok, false, `direction=${JSON.stringify(bad)} must fail`);
    assert.ok(result.errors.some((e) => e.includes('"direction"')));
  }
});

test("repeats must be an integer >= 1", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, "3", null, true]) {
    const raw = validPolicyRaw();
    raw.repeats = bad;
    const result = validateCandidatePolicy(raw);
    assert.equal(result.ok, false, `repeats=${JSON.stringify(bad)} must fail`);
    assert.ok(result.errors.some((e) => e.includes('"repeats"')));
  }
  const good = validPolicyRaw();
  good.repeats = 1;
  assert.equal(validateCandidatePolicy(good).ok, true);
});

test("min_gain must be a finite number >= 0", () => {
  for (const bad of [-0.5, -1, NaN, Infinity, -Infinity, "5", null, true]) {
    const raw = validPolicyRaw();
    raw.min_gain = bad;
    const result = validateCandidatePolicy(raw);
    assert.equal(result.ok, false, `min_gain=${JSON.stringify(bad)} must fail`);
    assert.ok(result.errors.some((e) => e.includes('"min_gain"')));
  }
});

test("benchmark_argv must be a non-empty array of non-empty strings", () => {
  const raw = validPolicyRaw();
  raw.benchmark_argv = [];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"benchmark_argv"')));

  const raw2 = validPolicyRaw();
  raw2.benchmark_argv = ["node", "", "  "];
  const result2 = validateCandidatePolicy(raw2);
  assert.equal(result2.ok, false);
  assert.ok(result2.errors.some((e) => e.includes('"benchmark_argv[1]"')));

  const raw3 = validPolicyRaw();
  raw3.benchmark_argv = "node bench.js";
  const result3 = validateCandidatePolicy(raw3);
  assert.equal(result3.ok, false);
  assert.ok(result3.errors.some((e) => e.includes('"benchmark_argv"')));
});

test("checks_argv element problems are named with their index", () => {
  const raw = validPolicyRaw();
  raw.checks_argv = ["node", null];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"checks_argv[1]"')));
});

test("time and budget limits must be finite positive numbers", () => {
  for (const field of [
    "benchmark_timeout_seconds",
    "confirm_budget_seconds",
    "candidate_time_limit_seconds",
  ]) {
    for (const bad of [0, -1, -0.001, NaN, Infinity, "30", null, true]) {
      const raw = validPolicyRaw();
      raw[field] = bad;
      const result = validateCandidatePolicy(raw);
      assert.equal(
        result.ok,
        false,
        `${field}=${JSON.stringify(bad)} must fail`,
      );
      assert.ok(result.errors.some((e) => e.includes(`"${field}"`)));
    }
    const raw = validPolicyRaw();
    raw[field] = 0.5;
    assert.equal(validateCandidatePolicy(raw).ok, true, `${field}=0.5 is a valid positive limit`);
  }
});

test("candidate_step_limit must be an integer >= 1", () => {
  for (const bad of [0, -3, 2.5, NaN, Infinity, "10", null, true]) {
    const raw = validPolicyRaw();
    raw.candidate_step_limit = bad;
    const result = validateCandidatePolicy(raw);
    assert.equal(result.ok, false, `step limit=${JSON.stringify(bad)} must fail`);
    assert.ok(result.errors.some((e) => e.includes('"candidate_step_limit"')));
  }
});

test("methodology_files must pin at least one file with path and 64-hex sha256", () => {
  const empty = validPolicyRaw();
  empty.methodology_files = [];
  const r1 = validateCandidatePolicy(empty);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('"methodology_files"')));

  const badSha = validPolicyRaw();
  badSha.methodology_files = [{ path: "m.md", sha256: "deadbeef" }];
  const r2 = validateCandidatePolicy(badSha);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('"methodology_files[0].sha256"')));

  const missingSha = validPolicyRaw();
  missingSha.methodology_files = [{ path: "m.md" }];
  const r3 = validateCandidatePolicy(missingSha);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes('"methodology_files[0].sha256"') && e.includes("required")));

  const missingPath = validPolicyRaw();
  missingPath.methodology_files = [{ sha256: SHA_A }];
  const r4 = validateCandidatePolicy(missingPath);
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => e.includes('"methodology_files[0].path"') && e.includes("required")));

  const notObject = validPolicyRaw();
  notObject.methodology_files = ["docs/m.md"];
  const r5 = validateCandidatePolicy(notObject);
  assert.equal(r5.ok, false);
  assert.ok(r5.errors.some((e) => e.includes('"methodology_files[0]"')));

  const upperHex = validPolicyRaw();
  upperHex.methodology_files = [{ path: "m.md", sha256: SHA_A.toUpperCase() }];
  const r6 = validateCandidatePolicy(upperHex);
  assert.equal(r6.ok, true);
  assert.ok(r6.policy);
  assert.equal(r6.policy.methodology_files[0].sha256, SHA_A.toUpperCase());
});

test("methodology_files entries accept exactly path and sha256, no extra keys", () => {
  const raw = validPolicyRaw();
  raw.methodology_files = [
    { path: "m.md", sha256: SHA_A, size: 123 },
  ];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"methodology_files[0]"') && e.includes('unknown field "size"')));
});

test("duplicate methodology paths and duplicate change_files are rejected", () => {
  const dupMethod = validPolicyRaw();
  dupMethod.methodology_files = [
    { path: "m.md", sha256: SHA_A },
    { path: "m.md", sha256: SHA_B },
  ];
  const r1 = validateCandidatePolicy(dupMethod);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('"methodology_files"') && e.includes("duplicate")));

  const dupChange = validPolicyRaw();
  dupChange.change_files = ["src/a.ts", "src/a.ts"];
  const r2 = validateCandidatePolicy(dupChange);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('"change_files"') && e.includes("duplicate")));
});

test("change_files must not include methodology files (candidate never edits methodology)", () => {
  const raw = validPolicyRaw();
  raw.methodology_files = [{ path: "docs/methodology.md", sha256: SHA_A }];
  raw.change_files = ["docs/methodology.md", "src/x.ts"];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('"change_files"') && e.includes("docs/methodology.md")),
  );
});

test("overlapping methodology paths cannot inject control characters into errors", () => {
  const raw = validPolicyRaw();
  const injected = "docs/file\nFORGED\r\u001b.md";
  raw.methodology_files = [{ path: injected, sha256: SHA_A }];
  raw.change_files = [injected];
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  const error = result.errors.find((e) => e.includes("must not contain methodology file"));
  assert.ok(error);
  assert.ok(error.includes(JSON.stringify(injected)));
  assert.doesNotMatch(error, /[\x00-\x1f\x7f]/);
});

test("unknown top-level fields are rejected — an agent cannot smuggle a consent flag", () => {
  const raw = validPolicyRaw();
  raw.confirmed = true;
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes('unknown field "confirmed"')),
    `errors: ${JSON.stringify(result.errors)}`,
  );
  assert.equal(result.policy, undefined);
});

test("all problems are collected, not just the first one", () => {
  const raw = {
    metric_name: "",
    direction: "sideways",
    repeats: 0,
  };
  const result = validateCandidatePolicy(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 10, `expected many errors, got ${JSON.stringify(result.errors)}`);
  assert.ok(result.errors.some((e) => e.includes('"metric_name"')));
  assert.ok(result.errors.some((e) => e.includes('"direction"')));
  assert.ok(result.errors.some((e) => e.includes('"repeats"')));
  assert.ok(result.errors.some((e) => e.includes('"methodology_files"')));
});

// ─── formatCandidatePolicy ───────────────────────────────────────────────────

test("formatCandidatePolicy renders every field for the confirmation dialog", () => {
  const raw = validPolicyRaw();
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const text = formatCandidatePolicy(validation.policy);
  for (const expected of [
    "metric_name: \"p95_latency_ms\"",
    "direction: lower",
    "repeats: 3",
    "min_gain: 5",
    JSON.stringify(["node", "bench.js", "--runs", "10"]).replace(/,/g, ", "),
    JSON.stringify(["node", "check.js"]).replace(/,/g, ", "),
    "benchmark_timeout_seconds: 30",
    "confirm_budget_seconds: 600",
    "candidate_step_limit: 20",
    "candidate_time_limit_seconds: 3600",
    "docs/methodology.md",
    SHA_A,
    "sha256",
    '"src/algorithm.ts", "src/algorithm.test.ts"',
  ]) {
    assert.ok(text.includes(expected), `expected "${expected}" in formatted policy:\n${text}`);
  }
});

test("formatCandidatePolicy JSON-quotes each argv value: commas and control characters preserved exactly", () => {
  const raw = validPolicyRaw();
  raw.benchmark_argv = ["node", "a,b", "line1\nline2\ttabbed", 'quo"te', "back\\slash"];
  raw.checks_argv = ["node", "a,b"];
  raw.change_files = ["src/dir,with,commas/file.ts", "src/new\nline.txt"];
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const text = formatCandidatePolicy(validation.policy);

  // The exact value "a,b" must appear quoted as one argument — a
  // JSON.stringify(whole-array)+comma-replacement renderer would show the
  // distorted "a, b" instead.
  assert.ok(
    text.includes('["node", "a,b"]'),
    `checks_argv must render as ["node", "a,b"] without comma distortion:\n${text}`,
  );
  assert.ok(text.includes('"line1\\nline2\\ttabbed"'));
  assert.ok(text.includes('"quo\\"te"'));
  assert.ok(text.includes('"back\\\\slash"'));
  assert.ok(text.includes('"src/dir,with,commas/file.ts"'));
  assert.ok(text.includes('"src/new\\nline.txt"'));

  // No raw control characters may leak into the dialog text: every control
  // character (newline, tab, CR) must appear only as a JSON escape, so the
  // dialog cannot be visually forged by injected line breaks.
  for (const line of text.split("\n")) {
    for (const ch of line) {
      const code = ch.charCodeAt(0);
      assert.ok(
        code >= 0x20,
        `raw control character U+${code.toString(16).padStart(4, "0")} leaked into dialog line: ${JSON.stringify(line)}`,
      );
    }
  }
});

/**
 * End-to-end distortion regression through the actual dialog: for the exact
 * argv ["node", "a,b"] the user must see the element "a,b", and the
 * distorted rendering "a, b" must not appear anywhere in the message.
 */
test("the confirmation dialog shows the exact argv value 'a,b' without comma distortion", async () => {
  const raw = validPolicyRaw();
  raw.checks_argv = ["node", "a,b"];
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const { ui, calls } = makeUi(true);
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, true);
  const message = calls[0].message;
  assert.ok(message.includes('"a,b"'), `exact value "a,b" must be shown:\n${message}`);
  assert.ok(
    !message.includes('"a, b"'),
    `distorted value "a, b" must not appear in the dialog:\n${message}`,
  );
});

// ─── formatCandidatePolicy: LF/CR/ESC injection regression (issue ───────────
// ─── pi-autoresearch-3e4.4.1.4, Reviewer B1) ────────────────────────────────

/**
 * Reviewer B1 regression: metric_name and methodology_files[].path were
 * interpolated without JSON quoting, so an LF or CR inside the value forged
 * extra lines in the confirmation dialog. Every user-controlled string is
 * now JSON-quoted; the check below is structural, not sample-based: every
 * line of the rendered policy must contain no raw control character.
 */
test("formatCandidatePolicy quotes metric_name and methodology path: LF/CR/ESC render as escapes, no forged lines", () => {
  const raw = validPolicyRaw();
  raw.metric_name = "p95\nFAKE: direction: higher\r\n";
  raw.methodology_files = [
    { path: "docs/good.md\n- FAKE methodology entry (sha256 deadbeef)", sha256: SHA_A },
    { path: "docs/esc\u001b[31mred.md", sha256: SHA_B },
  ];
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const text = formatCandidatePolicy(validation.policy);

  // No raw control character anywhere in the rendered policy: LF, CR and
  // ESC must appear only as backslash escapes, so nothing can forge extra
  // dialog lines or fake ANSI sequences.
  for (const line of text.split("\n")) {
    for (const ch of line) {
      const code = ch.charCodeAt(0);
      assert.ok(
        code >= 0x20 && code !== 0x7f,
        `raw control character U+${code.toString(16).padStart(4, "0")} leaked into dialog line: ${JSON.stringify(line)}`,
      );
    }
  }

  // The field structure is intact: exactly one metric_name line, and the
  // forged "FAKE" text is visible only inside the quoted value, not as its
  // own line.
  assert.equal(
    text.split("\n").filter((l) => l.startsWith("metric_name: ")).length,
    1,
    `exactly one metric_name line expected:\n${text}`,
  );
  assert.ok(text.includes("metric_name: \"p95\\nFAKE: direction: higher\\r\\n\""));
  assert.ok(
    text.includes(
      "  - \"docs/good.md\\n- FAKE methodology entry (sha256 deadbeef)\" (sha256: " + SHA_A + ")",
    ),
  );
  assert.ok(text.includes("\"docs/esc\\u001b[31mred.md\""));

  // Exact recovery: JSON.parse of each quoted rendering reproduces the
  // original value byte-for-byte.
  const metricLine = text.split("\n").find((l) => l.startsWith("metric_name: "));
  assert.equal(JSON.parse(metricLine.slice("metric_name: ".length)), raw.metric_name);
  const pathLines = text.split("\n").filter((l) => l.startsWith("  - "));
  assert.equal(pathLines.length, 2);
  const entryRe = /^  - ("(?:[^"\\]|\\.)*") \(sha256: ([0-9a-fA-F]{64})\)$/;
  const m = pathLines[0].match(entryRe);
  assert.ok(m, `methodology line must be parseable: ${JSON.stringify(pathLines[0])}`);
  assert.equal(JSON.parse(m[1]), raw.methodology_files[0].path);
  assert.equal(m[2], SHA_A);
  const m2 = pathLines[1].match(entryRe);
  assert.ok(m2, `methodology line must be parseable: ${JSON.stringify(pathLines[1])}`);
  assert.equal(JSON.parse(m2[1]), raw.methodology_files[1].path);
});

/**
 * Round-trip property over nasty values: for each user-controlled string the
 * quoted rendering must JSON-parse back to the exact original — LF, CR, ESC,
 * quotes, backslashes, tabs included — and the full rendered policy must
 * stay free of raw control characters. Methodology paths and change_files
 * are kept disjoint: methodology paths are prefixed with "docs/", since the
 * same path in both lists is a validation error by design (the candidate
 * must never edit methodology files).
 */
test("formatCandidatePolicy round-trips every user string exactly through JSON quoting", () => {
  const nasty = [
    "plain.md",
    "line1\nline2",
    "cr\rhere",
    "crlf\r\nend",
    "esc\u001b[31mred",
    'quo"te\\back\ttab',
    "a,b",
    "unicode ✓ ok",
  ];
  const raw = validPolicyRaw();
  raw.metric_name = nasty[4];
  raw.benchmark_argv = ["node", ...nasty.slice(1)];
  raw.checks_argv = [nasty[0]];
  raw.change_files = nasty;
  raw.methodology_files = nasty.map((p, i) => ({
    path: "docs/" + p,
    sha256: i % 2 === 0 ? SHA_A : SHA_B,
  }));
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const text = formatCandidatePolicy(validation.policy);

  // No raw control character in the whole rendered policy.
  for (const line of text.split("\n")) {
    for (const ch of line) {
      const code = ch.charCodeAt(0);
      assert.ok(
        code >= 0x20 && code !== 0x7f,
        `raw control character U+${code.toString(16).padStart(4, "0")} leaked: ${JSON.stringify(line)}`,
      );
    }
  }

  // Every quoted rendering parses back to the exact original value.
  const metricRe = /^metric_name: ("(?:[^"\\]|\\.)*")$/m;
  assert.equal(JSON.parse(text.match(metricRe)[1]), raw.metric_name);
  assert.deepEqual(
    JSON.parse(text.match(/^benchmark_argv: (\[.*\])$/m)[1]),
    raw.benchmark_argv,
  );
  assert.deepEqual(
    JSON.parse(text.match(/^checks_argv: (\[.*\])$/m)[1]),
    raw.checks_argv,
  );
  assert.deepEqual(
    JSON.parse(text.match(/^change_files: (\[.*\])$/m)[1]),
    raw.change_files,
  );
  const pathLines = text.split("\n").filter((l) => l.startsWith("  - "));
  assert.equal(pathLines.length, nasty.length);
  const entryRe = /^  - ("(?:[^"\\]|\\.)*") \(sha256: ([0-9a-fA-F]{64})\)$/;
  for (let i = 0; i < nasty.length; i++) {
    const m = pathLines[i].match(entryRe);
    assert.ok(m, `methodology line ${i} must be parseable: ${JSON.stringify(pathLines[i])}`);
    assert.equal(JSON.parse(m[1]), "docs/" + nasty[i]);
    assert.equal(m[2], i % 2 === 0 ? SHA_A : SHA_B);
  }
});

/**
 * The dialog itself must stay un-forgeable: with LF/CR bombs in the metric
 * and the methodology path, the confirm() message contains only the quoted
 * renderings — no raw LF/CR from policy values — and starts with exactly
 * the formatted policy followed by the fixed consent question.
 */
test("the confirmation dialog message with LF/CR bombs stays structurally intact", async () => {
  const raw = validPolicyRaw();
  raw.metric_name = "m\nline2\rfake: line3";
  raw.methodology_files = [{ path: "p\nq.md", sha256: SHA_A }];
  const validation = validateCandidatePolicy(raw);
  assert.ok(validation.policy);
  const { ui, calls } = makeUi(true);
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, true);
  const message = calls[0].message;
  const formatted = formatCandidatePolicy(validation.policy);
  // The message is the exact formatted policy plus the fixed consent
  // question — nothing else, so no value can forge dialog structure.
  assert.ok(message.startsWith(formatted));
  assert.ok(message.endsWith("Refusal, cancellation, a closed dialog or an error blocks the campaign."));
  assert.ok(message.includes("metric_name: \"m\\nline2\\rfake: line3\""));
  assert.ok(message.includes("\"p\\nq.md\""));
});

// ─── validation diagnostics: honest single lines under LF/CR injection ──────

test("validation errors embed user strings escaped: LF/CR/ESC cannot forge diagnostic lines", () => {
  // Unknown top-level field name containing LF/CR/ESC.
  const raw = validPolicyRaw();
  raw["evi\nl\r\u001b[31md"] = true;
  const r1 = validateCandidatePolicy(raw);
  assert.equal(r1.ok, false);
  const unknownErr = r1.errors.find((e) => e.includes("unknown field"));
  assert.ok(unknownErr, `expected an unknown-field error: ${JSON.stringify(r1.errors)}`);
  assert.equal(unknownErr.split("\n").length, 1, `unknown-field error must be a single line: ${JSON.stringify(unknownErr)}`);
  assert.equal(unknownErr.split("\r").length, 1);
  assert.ok(unknownErr.includes("unknown field \"evi\\nl\\r\\u001b[31md\""));
  assert.equal(
    JSON.parse(unknownErr.match(/unknown field ("(?:[^"\\]|\\.)*")/)[1]),
    "evi\nl\r\u001b[31md",
  );

  // Duplicate change_files entry containing LF.
  const raw2 = validPolicyRaw();
  raw2.change_files = ["a\nb.ts", "a\nb.ts"];
  const r2 = validateCandidatePolicy(raw2);
  assert.equal(r2.ok, false);
  const dupErr = r2.errors.find((e) => e.includes("duplicate"));
  assert.ok(dupErr, `expected a duplicate error: ${JSON.stringify(r2.errors)}`);
  assert.ok(dupErr.includes('"a\\nb.ts"'), `duplicate entry must be escaped: ${JSON.stringify(dupErr)}`);
  assert.equal(dupErr.split("\n").length, 1, "duplicate error must be a single line");
  assert.equal(
    JSON.parse(dupErr.match(/duplicate entry ("(?:[^"\\]|\\.)*")/)[1]),
    "a\nb.ts",
  );

  // Duplicate methodology path containing CR+ESC.
  const raw3 = validPolicyRaw();
  raw3.methodology_files = [
    { path: "m\r\u001bx.md", sha256: SHA_A },
    { path: "m\r\u001bx.md", sha256: SHA_B },
  ];
  const r3 = validateCandidatePolicy(raw3);
  assert.equal(r3.ok, false);
  const dupPathErr = r3.errors.find((e) => e.includes("duplicate"));
  assert.ok(dupPathErr, `expected a duplicate-path error: ${JSON.stringify(r3.errors)}`);
  assert.ok(dupPathErr.includes('"m\\r\\u001bx.md"'), `duplicate path must be escaped: ${JSON.stringify(dupPathErr)}`);
  assert.equal(dupPathErr.split("\n").length, 1);
  assert.equal(
    JSON.parse(dupPathErr.match(/duplicate path ("(?:[^"\\]|\\.)*")/)[1]),
    "m\r\u001bx.md",
  );

  // Unknown methodology_files entry key containing LF.
  const raw4 = validPolicyRaw();
  raw4.methodology_files = [{ path: "m.md", sha256: SHA_A, "ba\nd": 1 }];
  const r4 = validateCandidatePolicy(raw4);
  assert.equal(r4.ok, false);
  const keyErr = r4.errors.find((e) => e.includes("unknown field"));
  assert.ok(keyErr, `expected an unknown-entry-field error: ${JSON.stringify(r4.errors)}`);
  assert.ok(keyErr.includes("unknown field \"ba\\nd\""), `entry key must be escaped: ${JSON.stringify(keyErr)}`);
  assert.equal(keyErr.split("\n").length, 1);
  assert.equal(
    JSON.parse(keyErr.match(/unknown field ("(?:[^"\\]|\\.)*")/)[1]),
    "ba\nd",
  );
});

/**
 * A UI error message containing LF/CR/ESC/NUL must not forge extra lines in
 * the single-line consent reason: control characters are escaped, and the
 * exact original message text stays recoverable inside the reason.
 */
test("consent failure reason stays single-line when the UI error contains LF/CR", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui } = makeUi(true, {
    throwInConfirm: new Error("boom\nfake reason line\r\u001b[31mRED"),
  });
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /does not start/i);
  assert.equal(
    result.reason.split("\n").length,
    1,
    `reason must be a single line: ${JSON.stringify(result.reason)}`,
  );
  assert.equal(result.reason.split("\r").length, 1);
  // The full original message is present, escaped and recoverable.
  assert.ok(result.reason.includes("boom\\nfake reason line\\r\\u001b[31mRED"));
});

// ─── confirmCandidatePolicy / requestCandidatePolicyConsent ─────────────────

test("user confirmation via UI returns the validated policy", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui, calls } = makeUi(true);
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.deepEqual(result, { ok: true, policy: validation.policy });
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /confirm/i);
  assert.match(calls[0].message, /p95_latency_ms/);
  assert.match(calls[0].message, /immutable/i);
});

test("the dialog presents the exact formatted full policy", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui, calls } = makeUi(true);
  await confirmCandidatePolicy(ui, validation.policy);
  assert.ok(calls[0].message.includes(formatCandidatePolicy(validation.policy)));
});

test("user refusal blocks with ok:false and does not start", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui, calls } = makeUi(false);
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /refus/i);
  assert.equal(calls.length, 1);
});

test("missing UI blocks — no dialog, no consent path", async () => {
  for (const ui of [null, undefined]) {
    const validation = validateCandidatePolicy(validPolicyRaw());
    assert.ok(validation.policy);
    const result = await confirmCandidatePolicy(ui, validation.policy);
    assert.equal(result.ok, false);
    assert.equal(result.stage, "consent");
    assert.match(result.reason, /no interactive UI/i);
  }
});

test("UI without a confirm method blocks", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const result = await confirmCandidatePolicy({ notify: () => {} }, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /no interactive UI/i);
});

test("UI confirm throwing an error blocks with the error detail", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui } = makeUi(true, { throwInConfirm: new Error("dialog closed") });
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /dialog closed/);
  assert.match(result.reason, /does not start/i);
});

test("UI confirm rejecting blocks the same way as throwing", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const ui = {
    confirm: async () => {
      throw new Error("ui crashed");
    },
  };
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /ui crashed/);
});

test("cancellation (undefined answer) blocks without coercion", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const { ui } = makeUi(undefined);
  const result = await confirmCandidatePolicy(ui, validation.policy);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /non-boolean answer/i);
  assert.match(result.reason, /cancelled/i);
});

test("truthy non-boolean answers (\"yes\", 1) are NOT consent", async () => {
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  for (const answer of ["yes", 1, {}, "true"]) {
    const { ui } = makeUi(answer);
    const result = await confirmCandidatePolicy(ui, validation.policy);
    assert.equal(result.ok, false, `answer=${JSON.stringify(answer)} must not be consent`);
    assert.equal(result.stage, "consent");
    assert.match(result.reason, /non-boolean answer/i);
  }
});

test("requestCandidatePolicyConsent: valid raw policy + UI true = consent", async () => {
  const { ui, calls } = makeUi(true);
  const result = await requestCandidatePolicyConsent(ui, validPolicyRaw());
  assert.equal(result.ok, true);
  assert.ok(result.policy);
  assert.equal(result.policy.metric_name, "p95_latency_ms");
  assert.equal(calls.length, 1);
});

test("requestCandidatePolicyConsent: invalid raw policy blocks before the user is asked", async () => {
  const raw = validPolicyRaw();
  delete raw.repeats;
  const { ui, calls } = makeUi(true);
  const result = await requestCandidatePolicyConsent(ui, raw);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "validation");
  assert.ok(result.errors.some((e) => e.includes('"repeats"')));
  assert.equal(calls.length, 0, "the confirmation dialog must not open for an invalid policy");
});

test("requestCandidatePolicyConsent with missing UI blocks even for a valid policy", async () => {
  const result = await requestCandidatePolicyConsent(null, validPolicyRaw());
  assert.equal(result.ok, false);
  assert.equal(result.stage, "consent");
  assert.match(result.reason, /no interactive UI/i);
});

test("a boolean confirmed field inside the raw policy is a validation error, not consent", async () => {
  const raw = validPolicyRaw();
  raw.confirmed = true;
  const { ui, calls } = makeUi(true);
  const result = await requestCandidatePolicyConsent(ui, raw);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "validation");
  assert.ok(result.errors.some((e) => e.includes('unknown field "confirmed"')));
  assert.equal(calls.length, 0);
});

test("an agent-supplied flag has no effect: the API has no consent parameter at all", async () => {
  // The only argument carrying intent is the policy object; any extra flag
  // on it is rejected as an unknown field, and confirmCandidatePolicy
  // re-validates so a mutated/frozen bypass cannot sneak through.
  const validation = validateCandidatePolicy(validPolicyRaw());
  assert.ok(validation.policy);
  const smuggled = {
    ...validation.policy,
    user_agreed: true,
  };
  const result = await confirmCandidatePolicy({ confirm: async () => false }, smuggled);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "validation");
  assert.ok(result.errors.some((e) => e.includes('unknown field "user_agreed"')));
});

// Review round (m1): change_files shape and case-insensitive methodology overlap.
test("change_files: traversal, absolute, dot-trailing and .git entries are refused at init", () => {
  for (const bad of ["../x", "/abs/x", "src/../src/method.md", "src/method.md.", ".git/config", "a//b"]) {
    const r = validateCandidatePolicy({ ...validPolicyRaw(), change_files: [bad] });
    assert.equal(r.ok, false, `change_files entry ${JSON.stringify(bad)} must be refused`);
  }
});

test("change_files: NTFS alternate-stream and 8.3 short-name spellings are refused", () => {
  for (const bad of ["METHOD.md::$DATA", "METHOD~1.MD", "src/foo~2.ts"]) {
    const r = validateCandidatePolicy({ ...validPolicyRaw(), change_files: [bad] });
    assert.equal(r.ok, false, `change_files entry ${JSON.stringify(bad)} must be refused`);
  }
});

test("change_files: a methodology file in another case is refused (Windows case-insensitive)", () => {
  const r = validateCandidatePolicy({
    ...validPolicyRaw(),
    methodology_files: [{ path: "src/method.md", sha256: "a".repeat(64) }],
    change_files: ["SRC/METHOD.md"],
  });
  assert.equal(r.ok, false, "a methodology file in another case must not be editable by the candidate");
});
