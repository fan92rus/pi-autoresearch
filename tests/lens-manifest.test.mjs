/**
 * Result-lens run manifest (openspec add-result-reflection, task 1.3):
 * declared artifacts (analysis.artifacts) are copied into .auto/runs/<n>/
 * after the run settles, and manifest.json records paths, sizes, sha16,
 * missing entries and size-only entries (over copy_limit_mb). Declared
 * measurement files (analysis.measurement_files) are hashed into the same
 * manifest (hash control input for task 2.7). Failures are never fatal:
 * a missing/failing artifact becomes a manifest entry, and without a
 * declared list no manifest is written at all.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/lens-manifest.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import cjsFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

import { allocateRunArtifacts, writeRunManifest } from "../extensions/pi-autoresearch/lens.ts";
import { sessionFilePath } from "../extensions/pi-autoresearch/paths.ts";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import { approveOptimizeBrief } from "./optimize-approve-helper.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-lens-manifest-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

/**
 * Campaign dir with an optional `analysis` section in .auto/config.json
 * (written before init_experiment, which validates it into the ledger header),
 * extension loaded, autoresearch mode ON, experiment initialized.
 */
async function startCampaign(dir, analysisSection) {
  initGitRepo(dir);
  if (analysisSection !== undefined) {
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ analysis: analysisSection }));
  }
  const { pi, tool, command } = createFakePi({ dir, sessionId: "lens-manifest", realGit: true });
  const ctx = makeCtx(dir, "lens-manifest", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("on", ctx);
  approveOptimizeBrief(ctx.cwd, { name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower" });
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  return { pi, tool, command, ctx };
}

async function runOnce(tool, ctx, command, signal = null) {
  return tool("run_experiment").execute("id", { command, timeout_seconds: 30 }, signal, null, ctx);
}

const runDirOf = (dir, n) => path.join(dir, ".auto", "runs", String(n));
const manifestPathOf = (dir, n) => path.join(runDirOf(dir, n), "manifest.json");

function readManifest(dir, n) {
  return JSON.parse(fs.readFileSync(manifestPathOf(dir, n), "utf-8"));
}

function sha16(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Declared artifacts: copied / missing / over the limit
// ---------------------------------------------------------------------------

test("declared artifact created by the run: copied into the run dir and listed in manifest.json", async () => {
  const dir = makeTempDir("copied");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["eval_output.json"] });

  const res = await runOnce(tool, ctx,
    `node -e "require('fs').writeFileSync('eval_output.json', 'metrics ok')"`);

  assert.strictEqual(res.details.exitCode, 0, "a healthy artifact copy must not affect the run");

  const copyPath = path.join(runDirOf(dir, 1), "eval_output.json");
  assert.ok(fs.existsSync(copyPath), `copy must exist at ${copyPath}`);
  assert.strictEqual(fs.readFileSync(copyPath, "utf-8"), "metrics ok");

  const m = readManifest(dir, 1);
  assert.strictEqual(m.run, 1);
  assert.strictEqual(m.output, "output.txt");
  // Output hash: full persisted output is pinned alongside the artifacts.
  const outputContent = fs.readFileSync(path.join(runDirOf(dir, 1), "output.txt"), "utf-8");
  assert.strictEqual(m.bytes, Buffer.byteLength(outputContent));
  assert.strictEqual(m.sha16, sha16(outputContent));
  assert.deepStrictEqual(m.measurement_files, [], "nothing declared → empty list, not a missing entry");

  assert.deepStrictEqual(m.artifacts, [{
    declared: "eval_output.json",
    copied: true,
    file: "eval_output.json",
    bytes: Buffer.byteLength("metrics ok"),
    sha16: sha16("metrics ok"),
  }]);
});

test("declared artifact absent after the run: missing entry in the manifest, run not failed", async () => {
  const dir = makeTempDir("missing");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["absent.json"] });

  const res = await runOnce(tool, ctx, `node -e "console.log('fine')"`);
  assert.strictEqual(res.details.exitCode, 0, "a missing artifact must not fail the run");
  assert.strictEqual(res.details.passed, true);

  assert.ok(!fs.existsSync(path.join(runDirOf(dir, 1), "absent.json")), "no copy of an absent artifact");
  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, [
    { declared: "absent.json", copied: false, missing: true },
  ]);
});

test("artifact over copy_limit_mb: not copied, size-only entry with the original size", async () => {
  const dir = makeTempDir("size-only");
  const { tool, ctx } = await startCampaign(dir, {
    artifacts: ["small.bin", "big.bin"],
    copy_limit_mb: 0.001, // ≈1048.576 bytes
  });

  await runOnce(tool, ctx,
    `node -e "const fs=require('fs');fs.writeFileSync('small.bin','x'.repeat(1048));fs.writeFileSync('big.bin','y'.repeat(4096))"`);

  // 1048 bytes ≤ limit → copied; 4096 bytes > limit → size-only, no copy.
  assert.ok(fs.existsSync(path.join(runDirOf(dir, 1), "small.bin")), "at-the-limit artifact is copied");
  assert.ok(!fs.existsSync(path.join(runDirOf(dir, 1), "big.bin")), "over-limit artifact must NOT be copied");

  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, [
    {
      declared: "small.bin",
      copied: true,
      file: "small.bin",
      bytes: 1048,
      sha16: sha16("x".repeat(1048)),
    },
    {
      declared: "big.bin",
      copied: false,
      missing: false,
      size_only: true,
      bytes: 4096,
    },
  ]);
});

test("no analysis section: generic campaign keeps .auto/runs output-only, no manifest.json", async () => {
  const dir = makeTempDir("generic");
  const { tool, ctx } = await startCampaign(dir, undefined);

  await runOnce(tool, ctx, `node -e "console.log('plain')"`);
  assert.ok(fs.existsSync(path.join(runDirOf(dir, 1), "output.txt")), "output persistence (task 1.1) still works");
  assert.ok(!fs.existsSync(manifestPathOf(dir, 1)), "no declared list → no manifest at all");
});

// ---------------------------------------------------------------------------
// measurement_files: hashes pinned into the same manifest (input for task 2.7)
// ---------------------------------------------------------------------------

test("measurement_files without artifacts: manifest still written, hashes pinned", async () => {
  const dir = makeTempDir("mf-only");
  const { tool, ctx } = await startCampaign(dir, { measurement_files: ["eval/scorer.py"] });
  fs.mkdirSync(path.join(dir, "eval"), { recursive: true });
  const scorer = "def score(): return 1";
  fs.writeFileSync(path.join(dir, "eval", "scorer.py"), scorer);

  const res = await runOnce(tool, ctx, `node -e "console.log('measured')"`);
  assert.strictEqual(res.details.exitCode, 0);
  // measurement-track spec: hashes of declared measurer files land in the
  // manifest of every run — the manifest exists even with zero artifacts.
  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, []);
  assert.deepStrictEqual(m.measurement_files, [
    { path: "eval/scorer.py", sha16: sha16(scorer) },
  ]);
  assert.ok(!fs.existsSync(path.join(runDirOf(dir, 1), "eval")), "measurement files are hashed, not copied");
});

test("declared measurement file unavailable: missing entry, run unaffected", async () => {
  const dir = makeTempDir("mf-missing");
  const { tool, ctx } = await startCampaign(dir, { measurement_files: ["eval/absent.py"] });

  const res = await runOnce(tool, ctx, `node -e "console.log('ok')"`);
  assert.strictEqual(res.details.passed, true);
  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.measurement_files, [
    { path: "eval/absent.py", missing: true },
  ]);
});

// ---------------------------------------------------------------------------
// Errors are recorded, never fatal
// ---------------------------------------------------------------------------

test("artifact copy error (declared path is a directory): read_error entry, run passes, run dir clean", async () => {
  const dir = makeTempDir("read-error");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["eval"] });
  fs.mkdirSync(path.join(dir, "eval"), { recursive: true });
  fs.writeFileSync(path.join(dir, "eval", "inner.txt"), "not copyable as a file");

  const res = await runOnce(tool, ctx, `node -e "console.log('still fine')"`);
  assert.strictEqual(res.details.exitCode, 0, "a single artifact failure must not fail the run");
  assert.strictEqual(res.details.passed, true);

  const m = readManifest(dir, 1);
  assert.strictEqual(m.artifacts.length, 1);
  assert.strictEqual(m.artifacts[0].declared, "eval");
  assert.strictEqual(m.artifacts[0].copied, false);
  assert.match(m.artifacts[0].read_error, /not a regular file/);
  assert.deepStrictEqual(
    fs.readdirSync(runDirOf(dir, 1)).sort(),
    ["manifest.json", "output.txt"],
    "a failed copy leaves no partial residue in the run dir",
  );
});

test("aborted run: the manifest is written from the partial state too (abort settles through the same finally)", async () => {
  const dir = makeTempDir("abort");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["aborted.json"] });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2000);
  await assert.rejects(
    runOnce(tool, ctx, `node -e "require('fs').writeFileSync('aborted.json','A'); setTimeout(()=>{}, 60000)"`, controller.signal),
    /aborted/,
  );

  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, [{
    declared: "aborted.json",
    copied: true,
    file: "aborted.json",
    bytes: 1,
    sha16: sha16("A"),
  }]);
  assert.ok(fs.existsSync(path.join(runDirOf(dir, 1), "output.txt")), "partial output persisted (task 1.1)");
});

test("crashed run: artifacts that existed before the crash are still copied and hashed", async () => {
  const dir = makeTempDir("crash");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["partial.json"] });

  const res = await runOnce(tool, ctx,
    `node -e "require('fs').writeFileSync('partial.json','P'); console.log('boom'); process.exit(3)"`);
  assert.strictEqual(res.details.exitCode, 3);

  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, [{
    declared: "partial.json",
    copied: true,
    file: "partial.json",
    bytes: 1,
    sha16: sha16("P"),
  }]);
  const outputContent = fs.readFileSync(path.join(runDirOf(dir, 1), "output.txt"), "utf-8");
  assert.strictEqual(m.sha16, sha16(outputContent), "partial output is hashed too");
});

test("artifact in a subdirectory: copy preserves the relative path inside the run dir", async () => {
  const dir = makeTempDir("subdir");
  const { tool, ctx } = await startCampaign(dir, { artifacts: ["out/results.json", "out/nested/deep.json"] });

  await runOnce(tool, ctx,
    `node -e "const fs=require('fs');fs.mkdirSync('out/nested',{recursive:true});fs.writeFileSync('out/results.json','r1');fs.writeFileSync('out/nested/deep.json','d1')"`);

  assert.strictEqual(fs.readFileSync(path.join(runDirOf(dir, 1), "out", "results.json"), "utf-8"), "r1");
  assert.strictEqual(fs.readFileSync(path.join(runDirOf(dir, 1), "out", "nested", "deep.json"), "utf-8"), "d1");
  const m = readManifest(dir, 1);
  assert.deepStrictEqual(m.artifacts, [
    { declared: "out/results.json", copied: true, file: "out/results.json", bytes: 2, sha16: sha16("r1") },
    { declared: "out/nested/deep.json", copied: true, file: "out/nested/deep.json", bytes: 2, sha16: sha16("d1") },
  ]);
});

test("invalid analysis header in the ledger: run passes, manifest skipped, warning reported", async () => {
  const dir = makeTempDir("bad-header");
  const { tool, ctx, command } = await startCampaign(dir, { artifacts: ["eval.json"] });

  // Corrupt the persisted init-time header (hand-edited ledger): analysis is no longer an object.
  const logPath = sessionFilePath(dir, "log");
  const corrupted = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((line) => {
    const entry = JSON.parse(line);
    if (entry.type === "config") entry.analysis = "not-an-object";
    return JSON.stringify(entry);
  });
  fs.writeFileSync(logPath, corrupted.join("\n") + "\n");

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let res;
  try {
    res = await runOnce(tool, ctx, `node -e "require('fs').writeFileSync('eval.json','x')"`);
  } finally {
    console.warn = realWarn;
  }

  assert.strictEqual(res.details.exitCode, 0, "an invalid header must not fail the run");
  assert.ok(fs.existsSync(path.join(runDirOf(dir, 1), "output.txt")), "output persistence (task 1.1) unaffected");
  assert.ok(!fs.existsSync(manifestPathOf(dir, 1)), "no manifest without a valid declared list");
  assert.ok(
    warnings.some((w) => w === "[autoresearch] run manifest skipped: invalid analysis header in ledger"),
    `expected the skip warning, got: ${JSON.stringify(warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// writeRunManifest unit contract (no run_experiment)
// ---------------------------------------------------------------------------

test("writeRunManifest: nothing declared → null, no manifest.json written", () => {
  const dir = makeTempDir("unit-empty");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "run output");

  const res = writeRunManifest(dir, ra, { artifacts: [], measurementFiles: [], copyLimitMb: 32 });
  assert.strictEqual(res, null);
  assert.ok(!fs.existsSync(path.join(ra.dir, "manifest.json")));
});

test("writeRunManifest: copies never escape the run dir, even for absolute or parent-relative declarations", () => {
  const parent = makeTempDir("unit-escape");
  const dir = path.join(parent, "camp");
  fs.mkdirSync(dir);
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "out");
  fs.writeFileSync(path.join(parent, "outside.txt"), "secret");

  const res = writeRunManifest(dir, ra, {
    artifacts: ["../outside.txt", path.join(parent, "outside.txt")],
    measurementFiles: [],
    copyLimitMb: 32,
  });
  assert.ok(res !== null);
  assert.deepStrictEqual(
    res.artifacts.map((a) => [a.copied, a.file, a.bytes]),
    [[true, "outside.txt", 6], [false, undefined, undefined]],
    "first declaration copies; the second normalizes onto the same run-dir file and is refused (exclusive copy, never a silent overwrite)",
  );
  assert.match(res.artifacts[1].read_error, /already exists/);
  assert.strictEqual(fs.readFileSync(path.join(ra.dir, "outside.txt"), "utf-8"), "secret");
  assert.ok(!fs.existsSync(path.join(dir, "outside.txt")), "workDir root untouched");
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "outside.txt")), "nothing written outside .auto/runs/<n>/");
});

test("writeRunManifest: reserved run-dir names are refused, output.txt never clobbered", () => {
  const dir = makeTempDir("unit-reserved");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "RUN OUTPUT");
  fs.writeFileSync(path.join(dir, "output.txt"), "ORIGINAL");

  const res = writeRunManifest(dir, ra, { artifacts: ["output.txt"], measurementFiles: [], copyLimitMb: 32 });
  assert.ok(res !== null);
  assert.strictEqual(res.artifacts[0].copied, false);
  assert.match(res.artifacts[0].read_error, /reserved/);
  assert.strictEqual(fs.readFileSync(ra.outputPath, "utf-8"), "RUN OUTPUT", "the run output survives a name collision");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ra.dir, "manifest.json"), "utf-8")).run, ra.runNumber);
});

test("writeRunManifest: a directory declared as measurement file is a read_error, manifest still returned", () => {
  const dir = makeTempDir("unit-mf-dir");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "out");

  const res = writeRunManifest(dir, ra, {
    artifacts: [],
    measurementFiles: [path.join(".auto", "runs")],
    copyLimitMb: 32,
  });
  assert.ok(res !== null);
  assert.strictEqual(res.measurement_files[0].path, path.join(".auto", "runs"));
  assert.match(res.measurement_files[0].read_error, /not a regular file/);
  assert.strictEqual(res.measurement_files[0].sha16, undefined);
});

test("writeRunManifest: a nested results/manifest.json is an ordinary artifact, copied and hashed", () => {
  const dir = makeTempDir("unit-nested-reserved");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "out");
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  const content = '{"metric": 1}';
  fs.writeFileSync(path.join(dir, "results", "manifest.json"), content);

  const res = writeRunManifest(dir, ra, { artifacts: ["results/manifest.json"], measurementFiles: [], copyLimitMb: 32 });
  assert.ok(res !== null);
  assert.deepStrictEqual(res.artifacts, [{
    declared: "results/manifest.json",
    copied: true,
    file: "results/manifest.json",
    bytes: Buffer.byteLength(content),
    sha16: sha16(content),
  }]);
  assert.strictEqual(fs.readFileSync(path.join(ra.dir, "results", "manifest.json"), "utf-8"), content);
  // The run-dir manifest.json itself is still the JSON manifest, not the copy.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ra.dir, "manifest.json"), "utf-8")).run, ra.runNumber);
});

test("writeRunManifest: reserved names are refused case-insensitively at the run-dir root (MANIFEST.json, Output.TXT)", () => {
  const dir = makeTempDir("unit-reserved-case");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "RUN OUTPUT");
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), "DECLARED");
  fs.writeFileSync(path.join(dir, "Output.TXT"), "DECLARED");

  const res = writeRunManifest(dir, ra, {
    artifacts: ["MANIFEST.json", "Output.TXT"],
    measurementFiles: [],
    copyLimitMb: 32,
  });
  assert.ok(res !== null);
  for (const entry of res.artifacts) {
    assert.strictEqual(entry.copied, false, `${entry.declared} must not be copied`);
    assert.match(entry.read_error, /reserved/i);
  }
  assert.strictEqual(fs.readFileSync(ra.outputPath, "utf-8"), "RUN OUTPUT", "output.txt survives");
  const manifest = JSON.parse(fs.readFileSync(path.join(ra.dir, "manifest.json"), "utf-8"));
  assert.strictEqual(manifest.run, ra.runNumber, "manifest.json stays the JSON manifest");
  assert.strictEqual(manifest.output, "output.txt");
});

test("writeRunManifest: a copy that fails mid-write leaves no half-written destination behind", () => {
  const dir = makeTempDir("unit-partial");
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "out");
  fs.writeFileSync(path.join(dir, "big.txt"), "0123456789");

  // Simulate a disk-full failure on the first write of the copy.
  const realWriteSync = cjsFs.writeSync;
  cjsFs.writeSync = () => {
    throw Object.assign(new Error("ENOSPC: simulated disk full"), { code: "ENOSPC" });
  };
  syncBuiltinESMExports();
  let res;
  try {
    res = writeRunManifest(dir, ra, { artifacts: ["big.txt"], measurementFiles: [], copyLimitMb: 32 });
  } finally {
    cjsFs.writeSync = realWriteSync;
    syncBuiltinESMExports();
  }

  assert.ok(res !== null);
  assert.strictEqual(res.artifacts[0].copied, false);
  assert.match(res.artifacts[0].read_error, /ENOSPC/);
  assert.deepStrictEqual(
    fs.readdirSync(ra.dir).sort(),
    ["manifest.json", "output.txt"],
    "the half-written big.txt is removed; only the reserved run-dir files remain",
  );
});

test("writeRunManifest: a clash (EEXIST) never deletes the file another artifact already copied", () => {
  const parent = makeTempDir("unit-clash");
  const dir = path.join(parent, "camp");
  fs.mkdirSync(dir);
  const ra = allocateRunArtifacts(dir, 1);
  fs.writeFileSync(ra.outputPath, "out");
  fs.writeFileSync(path.join(parent, "same.txt"), "first");

  const res = writeRunManifest(dir, ra, {
    artifacts: ["../same.txt", path.join(parent, "same.txt")],
    measurementFiles: [],
    copyLimitMb: 32,
  });
  assert.ok(res !== null);
  assert.strictEqual(res.artifacts[0].copied, true);
  assert.strictEqual(res.artifacts[1].copied, false);
  assert.strictEqual(fs.readFileSync(path.join(ra.dir, "same.txt"), "utf-8"), "first", "the first copy survives the clash");
});
