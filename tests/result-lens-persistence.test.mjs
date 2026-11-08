/**
 * result-lens persistence (openspec add-result-reflection, task 1.1):
 * every run_experiment keeps its full output in .auto/runs/<n>/output.txt,
 * including truncated, crashed, timed-out and aborted runs; run numbers are
 * monotonic and never overwrite earlier outputs.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/result-lens-persistence.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-lens-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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

async function loadExtension(dir, sessionId = "lens") {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId, realGit: true, optimizeFixture: true });
  const ctx = makeCtx(dir, sessionId, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { pi, tool, command, hook, ctx };
}

async function startCampaign(dir) {
  initGitRepo(dir);
  const session = await loadExtension(dir);
  await session.command("autoresearch").handler("on", session.ctx);
  await session.tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, session.ctx);
  return session;
}

const runOutputPath = (dir, n) => path.join(dir, ".auto", "runs", String(n), "output.txt");

/** Map of `runs/<n>/output.txt` relative paths → contents, for before/after comparison. */
function readRunsSnapshot(dir) {
  const root = path.join(dir, ".auto", "runs");
  const snapshot = {};
  if (!fs.existsSync(root)) return snapshot;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name, "output.txt");
    if (fs.existsSync(p)) snapshot[`${name}/output.txt`] = fs.readFileSync(p, "utf-8");
  }
  return snapshot;
}

function readLedger(dir) {
  const p = path.join(dir, ".auto", "log.jsonl");
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function runAndLog(tool, ctx, marker, description) {
  // propose first: once the tree root has children, run_experiment requires a
  // hypothesis_id (baseline exception only applies to the very first run).
  const prop = await tool("propose_hypothesis").execute("id", {
    description: `hyp-${marker}`,
  }, null, null, ctx);
  const hypId = prop.details?.node_id;
  const runRes = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('${marker}-output')"`, timeout_seconds: 30,
    ...(hypId ? { hypothesis_id: hypId } : {}),
  }, null, null, ctx);
  await tool("log_experiment").execute("id", {
    metric: 0, status: "crash", description,
    ...(hypId ? { hypothesis_id: hypId } : {}),
  }, null, null, ctx);
  return runRes;
}

/**
 * The result-lens contract: a ledger entry's `run` number must be the number of
 * the artifact directory holding THAT run's output (.auto/runs/<run>/output.txt),
 * so inspect_results(run=N) reads the right file.
 */
async function assertLedgerBinding(dir, markers) {
  const entries = readLedger(dir).filter((e) => typeof e.run === "number");
  for (const marker of markers) {
    const entry = entries.find((e) => e.description === `log-${marker}`);
    assert.ok(entry, `ledger entry for ${marker} must exist`);
    const artifact = runOutputPath(dir, entry.run);
    assert.ok(
      fs.existsSync(artifact),
      `ledger run ${entry.run} (${marker}) must have artifacts at ${artifact}`,
    );
    const saved = fs.readFileSync(artifact, "utf-8");
    assert.ok(
      saved.includes(`${marker}-output`),
      `dir ${entry.run} must hold ${marker}'s output, got: ${JSON.stringify(saved.slice(0, 200))}`,
    );
  }
}

test("truncated run: full output lands in .auto/runs/1/output.txt and the response points to it", async () => {
  const dir = makeTempDir("truncated");
  const { tool, ctx } = await startCampaign(dir);

  const res = await tool("run_experiment").execute("id", {
    command: `node -e "for(let i=0;i<600;i++)console.log('line '+i)"`, timeout_seconds: 30,
  }, null, null, ctx);

  const outPath = runOutputPath(dir, 1);
  assert.ok(fs.existsSync(outPath), `expected ${outPath}`);
  const saved = fs.readFileSync(outPath, "utf-8");
  assert.ok(saved.includes("line 0\n"), "first line must be persisted, not only the tail");
  assert.ok(saved.includes("line 599"), "last line must be persisted");
  assert.strictEqual(saved.split("\n").filter((l) => l.startsWith("line ")).length, 600, "all 600 lines persisted");

  const text = res.content[0].text;
  assert.ok(!text.includes("line 0\n"), "LLM response must stay truncated");
  assert.ok(text.includes(outPath), `response must contain the output path, got: ${text.slice(-300)}`);
  assert.strictEqual(res.details.fullOutputPath, outPath);
});

test("crashed run keeps the partial output printed before the crash", async () => {
  const dir = makeTempDir("crash");
  const { tool, ctx } = await startCampaign(dir);

  const res = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('partial before crash'); process.exit(3)"`, timeout_seconds: 30,
  }, null, null, ctx);

  assert.strictEqual(res.details.exitCode, 3);
  assert.ok(res.content[0].text.includes("FAILED (exit code 3)"));
  const saved = fs.readFileSync(runOutputPath(dir, 1), "utf-8");
  assert.ok(saved.includes("partial before crash"), `crash output lost: ${saved}`);
});

test("timed-out run keeps the output printed before the kill", async () => {
  const dir = makeTempDir("timeout");
  const { tool, ctx } = await startCampaign(dir);

  const res = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('before hang'); setTimeout(()=>{}, 60000)"`, timeout_seconds: 3,
  }, null, null, ctx);

  assert.strictEqual(res.details.timedOut, true);
  const saved = fs.readFileSync(runOutputPath(dir, 1), "utf-8");
  assert.ok(saved.includes("before hang"), `timeout output lost: ${saved}`);
});

test("aborted run keeps the output printed before the abort", async () => {
  const dir = makeTempDir("abort");
  const { tool, ctx } = await startCampaign(dir);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 2000);
  await assert.rejects(
    tool("run_experiment").execute("id", {
      command: `node -e "console.log('before abort'); setTimeout(()=>{}, 60000)"`, timeout_seconds: 30,
    }, controller.signal, null, ctx),
    /aborted/,
  );

  const saved = fs.readFileSync(runOutputPath(dir, 1), "utf-8");
  assert.ok(saved.includes("before abort"), `abort output lost: ${saved}`);
});

test("run numbers are monotonic and never overwrite earlier outputs", async () => {
  const dir = makeTempDir("monotonic");
  const { tool, ctx } = await startCampaign(dir);

  for (const label of ["alpha", "beta", "gamma"]) {
    await tool("run_experiment").execute("id", {
      command: `node -e "console.log('${label}-output')"`, timeout_seconds: 30,
    }, null, null, ctx);
  }
  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 1), "utf-8").trim(), "alpha-output");
  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 2), "utf-8").trim(), "beta-output");
  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 3), "utf-8").trim(), "gamma-output");

  // A run directory left behind by an earlier run (e.g. one never logged) must
  // not be reused: the next run takes the number after the highest existing one.
  fs.mkdirSync(path.dirname(runOutputPath(dir, 7)), { recursive: true });
  fs.writeFileSync(runOutputPath(dir, 7), "OLD-RUN-7");
  const res = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('delta-output')"`, timeout_seconds: 30,
  }, null, null, ctx);

  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 7), "utf-8"), "OLD-RUN-7", "earlier output must not be overwritten");
  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 8), "utf-8").trim(), "delta-output");
  assert.ok(res.content[0].text.includes(runOutputPath(dir, 8)));
});

test("run_experiment keeps parsing METRIC lines (backward compatible result)", async () => {
  const dir = makeTempDir("compat");
  const { tool, ctx } = await startCampaign(dir);

  const res = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC ms=42')"`, timeout_seconds: 30,
  }, null, null, ctx);

  assert.strictEqual(res.details.parsedPrimary, 42);
  assert.strictEqual(res.details.passed, true);
  assert.ok(fs.readFileSync(runOutputPath(dir, 1), "utf-8").includes("METRIC ms=42"));
});

test("old campaign without .auto/runs: ledger run number maps to the artifact directory of the same run", async () => {
  const dir = makeTempDir("old-campaign");
  const { tool, ctx } = await startCampaign(dir);

  // Campaign history from before result-lens persistence: a ledger with two
  // logged runs and NO .auto/runs journal at all.
  fs.rmSync(path.join(dir, ".auto", "runs"), { recursive: true, force: true });
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  fs.appendFileSync(ledgerPath,
    JSON.stringify({ run: 1, commit: "", metric: 10, status: "keep", description: "pre-lens A", timestamp: 1 }) + "\n");
  fs.appendFileSync(ledgerPath,
    JSON.stringify({ run: 2, commit: "", metric: 9, status: "keep", description: "pre-lens B", timestamp: 2 }) + "\n");

  const resumedRun = await runAndLog(tool, ctx, "resumed", "log-resumed");

  const resumedEntry = readLedger(dir).find((e) => e.description === "log-resumed");
  assert.ok(resumedEntry, "resumed run must be logged");
  assert.strictEqual(resumedEntry.run, 3, "ledger numbering continues after the two pre-lens runs");
  await assertLedgerBinding(dir, ["resumed"]);
  assert.ok(
    resumedRun.content[0].text.includes(runOutputPath(dir, 3)),
    `response must point at the ledger-numbered dir, got: ${resumedRun.content[0].text.slice(-300)}`,
  );
});

test("unlogged run: the next logged run binds its ledger number to its own artifact directory", async () => {
  const dir = makeTempDir("unlogged");
  const { tool, ctx } = await startCampaign(dir);

  await runAndLog(tool, ctx, "alpha", "log-alpha");

  // Run beta is never logged: the session dies between run_experiment and
  // log_experiment, leaving only the artifact directory behind.
  const orphanProp = await tool("propose_hypothesis").execute("id", {
    description: "hyp-orphan",
  }, null, null, ctx);
  await tool("run_experiment").execute("id", {
    command: `node -e "console.log('orphan-output')"`, timeout_seconds: 30,
    hypothesis_id: orphanProp.details?.node_id,
  }, null, null, ctx);

  // Locate the orphan's artifact dir by content (numbering is what's under test).
  const runsRoot = path.join(dir, ".auto", "runs");
  const orphanDirName = fs.readdirSync(runsRoot).find((d) => {
    const p = path.join(runsRoot, d, "output.txt");
    return fs.existsSync(p) && fs.readFileSync(p, "utf-8").includes("orphan-output");
  });
  assert.ok(orphanDirName, "orphan artifact dir must exist");

  // The campaign resumes: gamma must not inherit the orphan's ledger slot.
  await runAndLog(tool, ctx, "gamma", "log-gamma");

  const entries = readLedger(dir).filter((e) => typeof e.run === "number");
  assert.strictEqual(
    entries.find((e) => e.description === "log-orphan"),
    undefined,
    "the orphan run has no ledger entry",
  );
  await assertLedgerBinding(dir, ["alpha", "gamma"]);
  assert.ok(
    fs.readFileSync(path.join(runsRoot, orphanDirName, "output.txt"), "utf-8").includes("orphan-output"),
    "orphan artifacts must not be overwritten or rebound",
  );
});

test("session restart: numbering continues with existing .auto/runs, earlier files untouched, ledger binding intact", async () => {
  const dir = makeTempDir("restart");
  const s1 = await startCampaign(dir);

  // Session 1: one logged run, then a run that never gets logged (session dies).
  await runAndLog(s1.tool, s1.ctx, "alpha", "log-alpha");
  const betaProp = await s1.tool("propose_hypothesis").execute("id", { description: "hyp-beta" }, null, null, s1.ctx);
  await s1.tool("run_experiment").execute("id", {
    command: `node -e "console.log('beta-output')"`, timeout_seconds: 30,
    hypothesis_id: betaProp.details?.node_id,
  }, null, null, s1.ctx);
  const snapshot = readRunsSnapshot(dir);
  assert.ok(Object.keys(snapshot).length >= 2, "two run outputs must exist before the restart");

  // Session 2: a new session id forces state reconstruction from .auto/log.jsonl.
  const ctx2 = makeCtx(dir, "sess-restart", s1.pi);
  await s1.hook("session_start")({}, ctx2);
  await runAndLog(s1.tool, ctx2, "gamma", "log-gamma");

  // Earlier artifact files are byte-identical after the restart.
  const after = readRunsSnapshot(dir);
  for (const [name, content] of Object.entries(snapshot)) {
    assert.strictEqual(after[name], content, `file .auto/runs/${name} must survive the restart unchanged`);
  }

  // Ledger binding holds across the restart boundary: alpha was logged in
  // session 1, gamma in session 2 — and neither inherits the unlogged run's slot.
  const entries = readLedger(dir).filter((e) => typeof e.run === "number");
  assert.deepStrictEqual(entries.map((e) => e.run), [1, 3], "runs 1 and 3 logged; 2 stays the unlogged gap");
  await assertLedgerBinding(dir, ["alpha", "gamma"]);
});

test("log_experiment fallback numbering without run_experiment: consecutive logs get distinct increasing runs", async () => {
  const dir = makeTempDir("fallback");
  const { tool, ctx } = await startCampaign(dir);

  // No run_experiment in this session: log_experiment falls back to ledger
  // numbering. Two consecutive logs must not collide (regression: a count-
  // based fallback once minted the same number twice).
  const prop = await tool("propose_hypothesis").execute("id", { description: "hyp-fallback" }, null, null, ctx);
  const hypId = prop.details?.node_id;
  await tool("log_experiment").execute("id", {
    metric: 1, status: "discard", description: "log-first",
    ...(hypId ? { hypothesis_id: hypId } : {}),
  }, null, null, ctx);
  await tool("log_experiment").execute("id", {
    metric: 2, status: "discard", description: "log-second-no-run",
    ...(hypId ? { hypothesis_id: hypId } : {}),
  }, null, null, ctx);

  const entries = readLedger(dir).filter((e) => typeof e.run === "number");
  assert.deepStrictEqual(
    entries.map((e) => e.run),
    [1, 2],
    "fallback numbers must be 1-based, unique and increasing",
  );
});

test("ledger with run-number gaps: fallback continues above the highest logged run (max, not count)", async () => {
  const dir = makeTempDir("gap-fallback");
  const { tool, ctx } = await startCampaign(dir);

  // A ledger with gaps (runs 1 and 5 logged, 2-4 lost to crashes): a count-
  // based fallback would mint 3 and collide with the existing run 5.
  fs.rmSync(path.join(dir, ".auto", "runs"), { recursive: true, force: true });
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  fs.appendFileSync(ledgerPath,
    JSON.stringify({ run: 1, commit: "", metric: 10, status: "keep", description: "gap A", timestamp: 1 }) + "\n");
  fs.appendFileSync(ledgerPath,
    JSON.stringify({ run: 5, commit: "", metric: 9, status: "keep", description: "gap B", timestamp: 2 }) + "\n");

  const prop = await tool("propose_hypothesis").execute("id", { description: "hyp-gap" }, null, null, ctx);
  await tool("log_experiment").execute("id", {
    metric: 3, status: "discard", description: "log-after-gap",
    ...(prop.details?.node_id ? { hypothesis_id: prop.details.node_id } : {}),
  }, null, null, ctx);

  const entry = readLedger(dir).find((e) => e.description === "log-after-gap");
  assert.ok(entry, "entry after the gap must be logged");
  assert.strictEqual(entry.run, 6, "fallback must stay above the highest ledger run, not the entry count");
});

test("orphan artifact directories push the fallback number above them", async () => {
  const dir = makeTempDir("orphan-fallback");
  const { tool, ctx } = await startCampaign(dir);

  // A run directory left by an unlogged run: a later log without its own
  // run_experiment must not bind its number to the orphan's directory.
  fs.mkdirSync(path.join(dir, ".auto", "runs", "2"), { recursive: true });
  fs.writeFileSync(runOutputPath(dir, 2), "orphan-output");

  const prop = await tool("propose_hypothesis").execute("id", { description: "hyp-orphan-fallback" }, null, null, ctx);
  await tool("log_experiment").execute("id", {
    metric: 1, status: "discard", description: "log-after-orphan",
    ...(prop.details?.node_id ? { hypothesis_id: prop.details.node_id } : {}),
  }, null, null, ctx);

  const entry = readLedger(dir).find((e) => e.description === "log-after-orphan");
  assert.ok(entry);
  assert.strictEqual(entry.run, 3, "fallback must stay above the highest orphan directory");
  assert.strictEqual(fs.readFileSync(runOutputPath(dir, 2), "utf-8"), "orphan-output", "orphan content untouched");
});

test("degraded persistence: when .auto/runs cannot be created the run still executes", async () => {
  const dir = makeTempDir("degraded");
  const { tool, ctx } = await startCampaign(dir);

  // `.auto/runs` occupied by a regular file: allocation failure must degrade,
  // not kill the experiment (spec result-lens: missing artifacts are logged,
  // never fatal).
  fs.rmSync(path.join(dir, ".auto", "runs"), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, ".auto", "runs"), "not a directory");

  const res = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('degraded-output')"`, timeout_seconds: 30,
  }, null, null, ctx);

  assert.ok(res.content[0].text.includes("degraded-output"), "the run itself must complete");
  assert.ok(res.content[0].text.includes("run artifacts unavailable"), "degradation must be surfaced honestly");

  // The ledger still works: fallback numbering stays consistent without dirs.
  const prop = await tool("propose_hypothesis").execute("id", { description: "hyp-degraded" }, null, null, ctx);
  await tool("log_experiment").execute("id", {
    metric: 1, status: "discard", description: "log-degraded",
    ...(prop.details?.node_id ? { hypothesis_id: prop.details.node_id } : {}),
  }, null, null, ctx);
  const entry = readLedger(dir).find((e) => e.description === "log-degraded");
  assert.ok(entry, "ledger entry must exist");
  assert.strictEqual(entry.run, 1, "fallback numbering works without artifact directories");
});

test("re-init into a new segment: run numbering continues, earlier artifacts untouched", async () => {
  const dir = makeTempDir("reinit");
  const { tool, command, ctx } = await startCampaign(dir);
  await runAndLog(tool, ctx, "alpha", "log-alpha");
  const snapshot = readRunsSnapshot(dir);

  // A genuinely different target re-segments (same-config init would just resume).
  await tool("init_experiment").execute("id", {
    name: "bench-v2", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  await runAndLog(tool, ctx, "gamma", "log-gamma");

  const entries = readLedger(dir).filter((e) => typeof e.run === "number");
  assert.deepStrictEqual(entries.map((e) => e.run), [1, 2], "numbering continues across the re-init");
  assert.ok(entries[1].segment > entries[0].segment, "the new run lands in the new segment");
  const after = readRunsSnapshot(dir);
  for (const [name, content] of Object.entries(snapshot)) {
    assert.strictEqual(after[name], content, `file .auto/runs/${name} must survive re-init unchanged`);
  }
  await assertLedgerBinding(dir, ["alpha", "gamma"]);
});
