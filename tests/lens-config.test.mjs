/**
 * lens-config (openspec add-result-reflection, task 1.2):
 * parsing/validation of the `analysis` section of the campaign config
 * (.auto/config.json) and its wiring into init_experiment's config header.
 *
 * Covered here:
 *  - parseAnalysisConfig: valid configs (design.md example, defaults, unicode
 *    paths, json_path), invalid configs (broken regex = explicit errors with
 *    the offending config path, wrong types, unknown keys), error collection.
 *  - serializeAnalysisConfig: config-header shape round-trip.
 *  - init_experiment wiring: analysis section lands in the .auto/log.jsonl
 *    config header; an invalid section fails init explicitly without writing
 *    the header; no section = generic mode (header unchanged); unparseable
 *    config = generic mode + explicit warning (B3); analysis is read from
 *    ctx.cwd even when workingDir/params.cwd redirect the ledger (B1); the
 *    params.cwd branch never rewrites an unparseable config.json — workingDir
 *    applies for the session without persistence, with an explicit warning
 *    (B2, variant b uniform: unparseable never blocks, never destroys data).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/lens-config.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_COPY_LIMIT_MB,
  parseAnalysisConfig,
  serializeAnalysisConfig,
} from "../extensions/pi-autoresearch/lens-config.ts";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DESIGN_EXAMPLE = {
  artifacts: ["eval_output.json"],
  measurement_files: ["eval/scorer.py", "eval/gold.json"],
  extractors: {
    failures: { regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 10 },
    hotspots: { timing_line: true, top: 10 },
  },
  copy_limit_mb: 32,
};

const UNICODE_ARTIFACTS = {
  artifacts: ["оценки/результаты.json", "daten/ausgabe_über.txt", "eval/日本語_出力.txt"],
  measurement_files: ["eval/скрипт_оценки.py"],
};

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-lens-config-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

async function loadExtension(dir, opts = {}) {
  const { pi, tool, command, hook, ctx } = createFakePi({ dir, sessionId: "lens-config", realGit: true, execTable: opts.execTable ?? {} });
  const ctxFull = makeCtx(dir, "lens-config", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { pi, tool, command, hook, ctx: ctxFull };
}

/**
 * Prepare a temp campaign dir: git repo, optional .auto/config.json with an
 * `analysis` section, extension loaded, autoresearch mode ON.
 */
async function makeCampaign(dir, analysisSection) {
  initGitRepo(dir);
  if (analysisSection !== undefined) {
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify(analysisSection));
  }
  const session = await loadExtension(dir);
  await session.command("autoresearch").handler("on", session.ctx);
  return session;
}

async function callInit(session, params = { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" }) {
  approveOptimizeBrief(session.ctx.cwd, params);
  return session.tool("init_experiment").execute("id", params, null, null, session.ctx);
}

function readLedger(dir) {
  const p = path.join(dir, ".auto", "log.jsonl");
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function initResultText(res) {
  return res.content?.[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// parseAnalysisConfig: absent / generic mode
// ---------------------------------------------------------------------------

test("parseAnalysisConfig: undefined section = absent (generic mode)", () => {
  assert.equal(parseAnalysisConfig(undefined).status, "absent");
});

test("parseAnalysisConfig: null section is an explicit error, not silence", () => {
  const res = parseAnalysisConfig(null);
  assert.equal(res.status, "invalid");
  assert.ok(res.errors.some((e) => e.includes("analysis")), JSON.stringify(res.errors));
});

// ---------------------------------------------------------------------------
// parseAnalysisConfig: valid configs
// ---------------------------------------------------------------------------

test("parseAnalysisConfig: full design.md example parses to the normalized config", () => {
  const res = parseAnalysisConfig(DESIGN_EXAMPLE);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.config, {
    artifacts: ["eval_output.json"],
    measurementFiles: ["eval/scorer.py", "eval/gold.json"],
    extractors: [
      { name: "failures", regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 10 },
      { name: "hotspots", timingLine: true, top: 10 },
    ],
    copyLimitMb: 32,
  });
});

test("parseAnalysisConfig: defaults — empty section = empty lists + copy limit 32", () => {
  const res = parseAnalysisConfig({});
  assert.equal(res.status, "ok");
  assert.deepEqual(res.config, {
    artifacts: [],
    measurementFiles: [],
    extractors: [],
    copyLimitMb: DEFAULT_COPY_LIMIT_MB,
  });
  assert.equal(DEFAULT_COPY_LIMIT_MB, 32);
});

test("parseAnalysisConfig: missing lists default to [], explicit copy_limit_mb wins", () => {
  const res = parseAnalysisConfig({ artifacts: ["a.json"], copy_limit_mb: 64 });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.config.artifacts, ["a.json"]);
  assert.deepEqual(res.config.measurementFiles, []);
  assert.deepEqual(res.config.extractors, []);
  assert.equal(res.config.copyLimitMb, 64);
});

test("parseAnalysisConfig: unicode paths are preserved verbatim", () => {
  const res = parseAnalysisConfig(UNICODE_ARTIFACTS);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.config.artifacts, UNICODE_ARTIFACTS.artifacts);
  assert.deepEqual(res.config.measurementFiles, UNICODE_ARTIFACTS.measurement_files);
});

test("parseAnalysisConfig: json_path extractor and named-group regex are valid", () => {
  const res = parseAnalysisConfig({
    extractors: {
      pairs: { regex: "(?<gold>[а-яё]+)\\s+→\\s+(?<pred>[а-яё]+)", sample: 5 },
      records: { json_path: "results.items", sample: 20 },
    },
  });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.config.extractors, [
    { name: "pairs", regex: "(?<gold>[а-яё]+)\\s+→\\s+(?<pred>[а-яё]+)", sample: 5 },
    { name: "records", jsonPath: "results.items", sample: 20 },
  ]);
});

// ---------------------------------------------------------------------------
// parseAnalysisConfig: invalid configs — explicit errors, never silence
// ---------------------------------------------------------------------------

test("parseAnalysisConfig: broken regex is an explicit error naming the config path", () => {
  const res = parseAnalysisConfig({
    extractors: { failures: { regex: "MISMATCH\\s+gold=(", sample: 10 } },
  });
  assert.equal(res.status, "invalid");
  assert.ok(
    res.errors.some((e) => e.includes("analysis.extractors.failures.regex") && e.includes("regular expression")),
    JSON.stringify(res.errors),
  );
});

test("parseAnalysisConfig: regex must be a string", () => {
  const res = parseAnalysisConfig({ extractors: { x: { regex: 42 } } });
  assert.equal(res.status, "invalid");
  assert.ok(res.errors.some((e) => e.includes("analysis.extractors.x.regex")), JSON.stringify(res.errors));
});

test("parseAnalysisConfig: all errors are collected, not just the first", () => {
  const res = parseAnalysisConfig({
    artifacts: "eval.json",
    extractors: { failures: { regex: "(", sample: 0 } },
    copy_limit_mb: 0,
  });
  assert.equal(res.status, "invalid");
  assert.ok(res.errors.length >= 3, JSON.stringify(res.errors));
  const joined = res.errors.join("\n");
  assert.ok(joined.includes("analysis.artifacts"));
  assert.ok(joined.includes("analysis.extractors.failures.regex"));
  assert.ok(joined.includes("analysis.copy_limit_mb"));
});

test("parseAnalysisConfig: analysis must be an object", () => {
  for (const bad of ["analysis", 42, [], true]) {
    const res = parseAnalysisConfig(bad);
    assert.equal(res.status, "invalid", `input ${JSON.stringify(bad)} must be invalid`);
    assert.ok(res.errors.every((e) => e.startsWith("analysis")), JSON.stringify(res.errors));
  }
});

test("parseAnalysisConfig: artifacts must be an array of non-empty strings", () => {
  const cases = [
    { artifacts: "eval.json" },
    { artifacts: [1] },
    { artifacts: ["ok.json", ""] },
    { artifacts: [null] },
    { artifacts: [[]] },
  ];
  for (const bad of cases) {
    const res = parseAnalysisConfig(bad);
    assert.equal(res.status, "invalid", `input ${JSON.stringify(bad)} must be invalid`);
    assert.ok(res.errors.some((e) => e.startsWith("analysis.artifacts")), JSON.stringify(res.errors));
  }
});

test("parseAnalysisConfig: measurement_files must be an array of non-empty strings", () => {
  const res = parseAnalysisConfig({ measurement_files: ["eval/scorer.py", 7] });
  assert.equal(res.status, "invalid");
  assert.ok(res.errors.some((e) => e.includes("analysis.measurement_files[1]")), JSON.stringify(res.errors));
});

test("parseAnalysisConfig: extractors must be an object of objects", () => {
  const asArray = parseAnalysisConfig({ extractors: [] });
  assert.equal(asArray.status, "invalid");
  assert.ok(asArray.errors.some((e) => e.startsWith("analysis.extractors")));

  const specNotObject = parseAnalysisConfig({ extractors: { failures: "MISMATCH" } });
  assert.equal(specNotObject.status, "invalid");
  assert.ok(specNotObject.errors.some((e) => e.startsWith("analysis.extractors.failures")));

  const emptyName = parseAnalysisConfig({ extractors: { "": { regex: "x" } } });
  assert.equal(emptyName.status, "invalid");
});

test("parseAnalysisConfig: unknown extractor keys are rejected (typo = explicit error)", () => {
  const res = parseAnalysisConfig({ extractors: { failures: { rejex: "MISMATCH", sample: 10 } } });
  assert.equal(res.status, "invalid");
  assert.ok(
    res.errors.some((e) => e.includes("rejex") && e.includes("analysis.extractors.failures")),
    JSON.stringify(res.errors),
  );
});

test("parseAnalysisConfig: empty extractor declares nothing and is rejected", () => {
  const res = parseAnalysisConfig({ extractors: { nothing: {} } });
  assert.equal(res.status, "invalid");
  assert.ok(res.errors.some((e) => e.includes("analysis.extractors.nothing")), JSON.stringify(res.errors));
});

test("parseAnalysisConfig: sample/top must be integers >= 1, timing_line a boolean", () => {
  const bad = parseAnalysisConfig({
    extractors: {
      a: { regex: "x", sample: 0 },
      b: { regex: "x", sample: 1.5 },
      c: { regex: "x", sample: "10" },
      d: { timing_line: true, top: 0 },
      e: { timing_line: "yes" },
      f: { json_path: "" },
    },
  });
  assert.equal(bad.status, "invalid");
  const joined = bad.errors.join("\n");
  for (const fragment of ["a.sample", "b.sample", "c.sample", "d.top", "e.timing_line", "f.json_path"]) {
    assert.ok(joined.includes(`analysis.extractors.${fragment}`), `missing ${fragment} in ${joined}`);
  }
});

test("parseAnalysisConfig: prototype-polluting extractor names are rejected", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const res = parseAnalysisConfig({ extractors: { [name]: { regex: "x" } } });
    assert.equal(res.status, "invalid", `extractor name ${name} must be rejected`);
  }
});

test("parseAnalysisConfig: copy_limit_mb must be a positive finite number", () => {
  for (const badValue of [0, -5, "32", null, Number.POSITIVE_INFINITY]) {
    const res = parseAnalysisConfig({ copy_limit_mb: badValue });
    assert.equal(res.status, "invalid", `copy_limit_mb ${String(badValue)} must be invalid`);
    assert.ok(res.errors.some((e) => e.startsWith("analysis.copy_limit_mb")), JSON.stringify(res.errors));
  }
});

// ---------------------------------------------------------------------------
// serializeAnalysisConfig: config-header shape
// ---------------------------------------------------------------------------

test("serializeAnalysisConfig: round-trips the design example (parse → serialize → parse)", () => {
  const first = parseAnalysisConfig(DESIGN_EXAMPLE);
  assert.equal(first.status, "ok");
  const second = parseAnalysisConfig(serializeAnalysisConfig(first.config));
  assert.equal(second.status, "ok");
  assert.deepEqual(second.config, first.config);
});

test("serializeAnalysisConfig: snake_case keys, explicit copy_limit_mb, no undefined fields", () => {
  const parsed = parseAnalysisConfig({ extractors: { failures: { regex: "MISMATCH", sample: 3 } } });
  assert.equal(parsed.status, "ok");
  const raw = serializeAnalysisConfig(parsed.config);
  assert.deepEqual(Object.keys(raw).sort(), ["artifacts", "copy_limit_mb", "extractors", "measurement_files"]);
  assert.equal(raw.copy_limit_mb, 32);
  const spec = raw.extractors.failures;
  assert.deepEqual(Object.keys(spec).sort(), ["regex", "sample"]);
  assert.ok(!("timing_line" in spec));
  assert.ok(!("json_path" in spec));
});

test("serializeAnalysisConfig: unicode paths survive a full round-trip", () => {
  const first = parseAnalysisConfig(UNICODE_ARTIFACTS);
  assert.equal(first.status, "ok");
  const second = parseAnalysisConfig(serializeAnalysisConfig(first.config));
  assert.equal(second.status, "ok");
  assert.deepEqual(second.config, first.config);
});

// ---------------------------------------------------------------------------
// init_experiment wiring (index.ts only wires the calls)
// ---------------------------------------------------------------------------

test("init_experiment: valid analysis section lands normalized in the config header", async () => {
  const dir = makeTempDir("valid");
  const session = await makeCampaign(dir, {
    analysis: {
      artifacts: ["eval_output.json", "оценки/результаты.json"],
      measurement_files: ["eval/scorer.py"],
      extractors: { failures: { regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 10 } },
    },
  });

  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("✅"), `init should succeed, got: ${text}`);

  const header = readLedger(dir)[0];
  assert.equal(header.type, "config");
  const analysis = header.analysis;
  assert.ok(analysis, "config header must carry the analysis section");
  assert.deepEqual(analysis.artifacts, ["eval_output.json", "оценки/результаты.json"]);
  assert.deepEqual(analysis.measurement_files, ["eval/scorer.py"]);
  assert.deepEqual(analysis.extractors.failures, { regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 10 });
  assert.equal(analysis.copy_limit_mb, 32, "omitted copy_limit_mb is materialized as the default 32");
});

test("init_experiment: invalid regex is an explicit init error and no config header is written", async () => {
  const dir = makeTempDir("invalid-regex");
  const session = await makeCampaign(dir, {
    analysis: { extractors: { failures: { regex: "MISMATCH\\s+gold=(" } } },
  });

  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("❌"), `init must fail explicitly, got: ${text}`);
  assert.ok(text.includes("analysis.extractors.failures.regex"), `error must name the config path, got: ${text}`);

  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  assert.ok(!fs.existsSync(ledgerPath), "failed init must not write a config header");

  // After fixing the config, init works — the failure left no half-state.
  fs.writeFileSync(
    path.join(dir, ".auto", "config.json"),
    JSON.stringify({ analysis: { extractors: { failures: { regex: "MISMATCH", sample: 5 } } } }),
  );
  const retry = await callInit(session);
  assert.ok(initResultText(retry).includes("✅"), `retry after fix should succeed, got: ${initResultText(retry)}`);
  const header = readLedger(dir)[0];
  assert.equal(header.analysis.extractors.failures.sample, 5);
});

test("init_experiment: no analysis section = generic mode, header unchanged (no analysis key)", async () => {
  const dir = makeTempDir("generic");
  const session = await makeCampaign(dir); // no .auto/config.json at all

  const res = await callInit(session);
  assert.ok(initResultText(res).includes("✅"));

  const header = readLedger(dir)[0];
  assert.equal(header.type, "config");
  assert.equal(header.name, "bench");
  assert.equal(header.metricName, "ms");
  assert.equal(header.bestDirection, "lower");
  assert.ok(!("analysis" in header), "generic mode must not add an analysis key to the header");
});

test("init_experiment: empty analysis section is valid and kept explicit in the header", async () => {
  const dir = makeTempDir("empty-section");
  const session = await makeCampaign(dir, { analysis: {} });

  const res = await callInit(session);
  assert.ok(initResultText(res).includes("✅"), `got: ${initResultText(res)}`);
  const header = readLedger(dir)[0];
  assert.deepEqual(header.analysis, {
    artifacts: [],
    measurement_files: [],
    extractors: {},
    copy_limit_mb: 32,
  });
});

// ---------------------------------------------------------------------------
// Re-init flows with a changed analysis config (config.json rewritten between
// init calls). The analysis section is part of "how we measure", so changing
// it is a target change: new segment + new header, never a silent resume with
// the old rules. Same config + same analysis still resumes.
// ---------------------------------------------------------------------------

/** One full experiment cycle (propose → run → log) so state.results.length > 0,
 *  which is what activates init_experiment's resume-vs-resegment branch. */
async function runOneExperiment(session) {
  const prop = await session.tool("propose_hypothesis").execute(
    "id", { description: "hyp-analysis-config" }, null, null, session.ctx,
  );
  const hypId = prop.details?.node_id;
  const hypParams = hypId ? { hypothesis_id: hypId } : {};
  await session.tool("run_experiment").execute("id", {
    command: "node -e \"console.log('output')\"", timeout_seconds: 30, ...hypParams,
  }, null, null, session.ctx);
  await session.tool("log_experiment").execute("id", {
    metric: 0, status: "crash", description: "log-analysis-config", ...hypParams,
  }, null, null, session.ctx);
}

test("init_experiment: re-init with unchanged config+analysis resumes without a new header", async () => {
  const dir = makeTempDir("resume-same");
  const session = await makeCampaign(dir, {
    analysis: { artifacts: ["eval_output.json"], measurement_files: ["eval/scorer.py"] },
  });
  await callInit(session);
  await runOneExperiment(session);

  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("ℹ️ Session is already initialized"), `same config + same analysis must resume, got: ${text}`);
  assert.equal(res.details?.resumed, true);

  const headers = readLedger(dir).filter((e) => e.type === "config");
  assert.equal(headers.length, 1, "resume must not append a second config header");
  assert.deepEqual(headers[0].analysis.artifacts, ["eval_output.json"]);
});

test("init_experiment: re-init with a changed analysis section starts a new segment with the new header", async () => {
  const dir = makeTempDir("reinit-changed");
  const session = await makeCampaign(dir, {
    analysis: { artifacts: ["old.json"], copy_limit_mb: 16 },
  });
  await callInit(session);
  await runOneExperiment(session);

  fs.writeFileSync(
    path.join(dir, ".auto", "config.json"),
    JSON.stringify({ analysis: { artifacts: ["new.json"], copy_limit_mb: 16 } }),
  );
  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("✅"), `a changed analysis section is a config change and must re-init, got: ${text}`);

  const headers = readLedger(dir).filter((e) => e.type === "config");
  assert.equal(headers.length, 2, "changed analysis must append a new config header");
  assert.deepEqual(headers[0].analysis.artifacts, ["old.json"], "earlier header is never rewritten");
  assert.deepEqual(headers[1].analysis.artifacts, ["new.json"]);
  assert.equal(headers[1].analysis.copy_limit_mb, 16);
  assert.deepEqual(headers[0].analysis.extractors, {}, "omitted extractors materialize as an empty object");
  assert.equal(res.details?.state?.currentSegment, 1, "changed analysis must re-segment like any target change");
});

test("init_experiment: re-init with analysis removed starts a generic segment (no analysis key)", async () => {
  const dir = makeTempDir("reinit-removed");
  const session = await makeCampaign(dir, { analysis: { artifacts: ["a.json"] } });
  await callInit(session);
  await runOneExperiment(session);

  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ maxIterations: 5 }));
  const res = await callInit(session);
  assert.ok(initResultText(res).includes("✅"), `got: ${initResultText(res)}`);

  const headers = readLedger(dir).filter((e) => e.type === "config");
  assert.equal(headers.length, 2);
  assert.ok("analysis" in headers[0]);
  assert.ok(!("analysis" in headers[1]), "removing the section reverts to the generic header shape");
  assert.equal(res.details?.state?.currentSegment, 1);
});

// ---------------------------------------------------------------------------
// B3 (spec-owner decision on review): an UNPARSEABLE config.json must NOT
// block init for campaigns without a usable analysis section — repo convention
// "malformed config → defaults" (cf. readCouncilConfig in smoke.test.mjs).
// Generic mode + explicit warning. A READABLE config whose analysis section
// is present but invalid is still a hard init error (counterpart test below;
// see also the invalid-regex test above).
// ---------------------------------------------------------------------------

test("init_experiment: unparseable config.json = generic mode + explicit warning, init succeeds", async () => {
  const dir = makeTempDir("corrupt-config");
  const configPath = path.join(dir, ".auto", "config.json");
  const session = await makeCampaign(dir, { analysis: { artifacts: ["a.json"] } });
  fs.writeFileSync(configPath, "{ broken json");
  const before = fs.readFileSync(configPath);

  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("✅"), `unparseable config.json must not block init, got: ${text}`);
  assert.ok(
    text.includes("⚠️ config.json не распарсился — analysis не применена"),
    `init must carry the explicit unparseable-config warning, got: ${text}`,
  );

  const header = readLedger(dir)[0];
  assert.ok(!("analysis" in header), "unparseable config = generic mode: no analysis key in the header");
  assert.deepEqual(fs.readFileSync(configPath), before, "init must not rewrite the unparseable file");
});

test("init_experiment: readable config with a present-but-invalid analysis section still fails init (B3 counterpart)", async () => {
  const dir = makeTempDir("readable-invalid");
  const session = await makeCampaign(dir, { analysis: "not-an-object" });

  const res = await callInit(session);
  const text = initResultText(res);
  assert.ok(text.includes("❌"), `readable config with invalid analysis must fail init, got: ${text}`);
  assert.ok(text.includes("analysis"), `error must name the section, got: ${text}`);
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "log.jsonl")), "failed init must not write a config header");
});

// ---------------------------------------------------------------------------
// B1/B2 (review): the analysis config is read from ctx.cwd — NOT from the
// redirected workingDir — and validated BEFORE init's first write (the
// params.cwd block). workingDir tests use a "sub" dir as the ledger target.
// ---------------------------------------------------------------------------

test("init_experiment: analysis is read from ctx.cwd even when workingDir redirects the ledger (B1)", async () => {
  const dir = makeTempDir("b1-working-dir");
  const session = await makeCampaign(dir);
  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub, { recursive: true });
  initGitRepo(sub); // must exist (validateWorkDir); git keeps tree creation quiet
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({
    workingDir: "sub",
    analysis: { extractors: { failures: { regex: "MISMATCH\\s+gold=(" } } },
  }));

  // The session is pinned to sub by config.json workingDir: the approved brief must name sub (absolute), like the real flow.
  approveOptimizeBrief(dir, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: sub });
  const res = await session.tool("init_experiment").execute("id", { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" }, null, null, session.ctx);
  const text = initResultText(res);
  assert.ok(
    text.includes("❌"),
    `invalid analysis in ctx.cwd's config must fail init even with workingDir set, got: ${text}`,
  );
  assert.ok(text.includes("analysis.extractors.failures.regex"), `error must name the config path, got: ${text}`);
  assert.ok(!fs.existsSync(path.join(sub, ".auto", "log.jsonl")), "failed init must not create the ledger in workingDir");
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "log.jsonl")), "failed init must not create a ledger in ctx.cwd either");

  // The failure is a validation rollback, not a wedge: fixing the section in
  // ctx.cwd's config makes init succeed and write the ledger into workingDir.
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({
    workingDir: "sub",
    analysis: { extractors: { failures: { regex: "MISMATCH", sample: 2 } } },
  }));
  approveOptimizeBrief(dir, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: sub });
  const retry = await session.tool("init_experiment").execute("id", { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" }, null, null, session.ctx);
  assert.ok(initResultText(retry).includes("✅"), `fixed config should init, got: ${initResultText(retry)}`);
  const header = readLedger(sub)[0];
  assert.equal(
    header.analysis.extractors.failures.sample, 2,
    "analysis from ctx.cwd's config must land in the workingDir ledger header",
  );
});

test("init_experiment: cwd argument + unparseable config.json succeeds with warning, file untouched (B2, variant b uniform)", async () => {
  const dir = makeTempDir("b2-cwd-broken");
  const target = makeTempDir("b2-cwd-target");
  const session = await makeCampaign(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const configPath = path.join(dir, ".auto", "config.json");
  fs.writeFileSync(configPath, "{ broken json");
  const before = fs.readFileSync(configPath);

  const res = await callInit(session, {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: target,
  });
  const text = initResultText(res);
  // Variant (b) uniformly: an unparseable config never blocks init and is
  // never rewritten — cwd applies for this session, just without persistence.
  assert.ok(text.includes("✅"), `init with cwd must succeed (generic + warning), got: ${text}`);
  assert.ok(
    text.includes("workingDir не сохранён в config.json"),
    `warning must say workingDir is not persisted, got: ${text}`,
  );
  assert.ok(text.includes("файл не тронут"), `warning must say the file is untouched, got: ${text}`);
  assert.deepEqual(fs.readFileSync(configPath), before, "init must leave config.json byte-for-byte intact (no writeConfig clobber)");
  assert.ok(fs.existsSync(path.join(target, ".auto", "log.jsonl")), "ledger lands in the cwd target (_customWorkDir is set)");
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "log.jsonl")), "no ledger in ctx.cwd when cwd redirects");
  assert.deepEqual(fs.readFileSync(configPath), before, "config.json still untouched after the ledger write");
});

test("baseline keep does not clobber an unparseable config.json (noiseFloor write, BL2)", async () => {
  const dir = makeTempDir("bl2-noisefloor");
  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  // The calibration script must EXIST (findMeasureScript stat), its exec is
  // canned: key = [cmd, ...args].join(" ") in the fake-pi exec table.
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "#!/bin/sh\necho \"METRIC ms=99\"\n");
  const configPath = path.join(dir, ".auto", "config.json");
  fs.writeFileSync(configPath, "{ broken json");
  const before = fs.readFileSync(configPath);

  const session = await loadExtension(dir, {
    execTable: { ".auto/measure.sh": { code: 0, stdout: "METRIC ms=99\n", stderr: "" } },
  });
  await session.command("autoresearch").handler("on", session.ctx);
  // cwd=dir pins _customWorkDir to THIS dir: earlier tests in this file leak
  // the module-level override, which would redirect workDir and void the
  // assertion below.
  const initRes = await callInit(session, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: dir });
  assert.ok(initResultText(initRes).includes("✅"), `generic init must succeed with warning, got: ${initResultText(initRes)}`);

  // Baseline run + keep: the run MUST change a file, otherwise the keep
  // auto-commit is a no-op (clean tree) and recordTreeNode's keep branch
  // (which owns the noiseFloor calibration) never runs.
  await session.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('change.txt','x'); console.log('METRIC ms=100')"`, timeout_seconds: 30,
  }, null, null, session.ctx);
  const keep = await session.tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "baseline",
  }, null, null, session.ctx);
  assert.ok(initResultText(keep).includes("#1"), `baseline keep must land, got: ${initResultText(keep)}`);

  assert.deepEqual(
    fs.readFileSync(configPath),
    before,
    "baseline keep with a calibrated noise floor must leave the unparseable config.json byte-for-byte intact",
  );
});

test("baseline keep persists the calibrated noiseFloor into a readable config.json (BL2 positive path)", async () => {
  const dir = makeTempDir("bl2-positive");
  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "#!/bin/sh\necho \"METRIC ms=99\"\n");
  const configPath = path.join(dir, ".auto", "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ maxIterations: 7, custom_key: "keep-me" }, null, 2));

  const session = await loadExtension(dir, {
    execTable: { ".auto/measure.sh": { code: 0, stdout: "METRIC ms=99\n", stderr: "" } },
  });
  await session.command("autoresearch").handler("on", session.ctx);
  const initRes = await callInit(session, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: dir });
  assert.ok(initResultText(initRes).includes("✅"), `init must succeed, got: ${initResultText(initRes)}`);

  await session.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('change.txt','x'); console.log('METRIC ms=100')"`, timeout_seconds: 30,
  }, null, null, session.ctx);
  const keep = await session.tool("log_experiment").execute("id", {
    metric: 100, status: "keep", description: "baseline",
  }, null, null, session.ctx);
  assert.ok(initResultText(keep).includes("#1"), `baseline keep must land, got: ${initResultText(keep)}`);

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg.noiseFloor, 1, "calibrated |99-100|/100 = 0.01 fraction x baseline 100 = 1 metric unit must persist");
  assert.equal(cfg.noiseFloorUnit, "metric", "the floor must carry the metric unit marker");
  assert.equal(cfg.maxIterations, 7, "existing keys must survive the noiseFloor write");
  assert.equal(cfg.custom_key, "keep-me", "unknown user keys must survive the noiseFloor write");
});

// ---------------------------------------------------------------------------
// N2 (review): positive-path coverage for workingDir (B1 test above) and
// params.cwd — the coverage gap that hid B1/B2. Keep this test LAST in the
// file: it sets the module-level _customWorkDir override, which would leak
// into later tests (the extension module is cached per process).
// ---------------------------------------------------------------------------

test("init_experiment: params.cwd persists workingDir, keeps the analysis section, ledger lands in the target", async () => {
  const dir = makeTempDir("n2-cwd-valid");
  const target = makeTempDir("n2-cwd-target");
  initGitRepo(target);
  const session = await makeCampaign(dir, {
    analysis: { artifacts: ["eval_output.json"], extractors: { failures: { regex: "MISMATCH", sample: 3 } } },
  });

  const res = await callInit(session, {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower", cwd: target,
  });
  const text = initResultText(res);
  assert.ok(text.includes("✅"), `init with a valid cwd target should succeed, got: ${text}`);

  // The ledger lives in the requested target dir, not ctx.cwd.
  assert.ok(fs.existsSync(path.join(target, ".auto", "log.jsonl")), "ledger must be created in the cwd target");
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "log.jsonl")), "ctx.cwd must not grow a ledger");
  const header = readLedger(target)[0];
  assert.deepEqual(
    header.analysis.artifacts, ["eval_output.json"],
    "analysis is still read from ctx.cwd's config, not the target's",
  );

  // The writeConfig merge that persists workingDir must preserve the
  // author's analysis section (this is exactly what silently destroyed it
  // before validation was moved above the params.cwd block).
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "config.json"), "utf-8"));
  assert.equal(persisted.workingDir, path.resolve(target));
  assert.deepEqual(persisted.analysis.artifacts, ["eval_output.json"]);
  assert.deepEqual(persisted.analysis.extractors.failures, { regex: "MISMATCH", sample: 3 });
});
