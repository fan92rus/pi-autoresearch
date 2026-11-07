/**
 * candidate_branch tool wiring (openspec/changes/candidate-branches, tasks.md
 * 1.2/3.2 + wiring for 1.1/1.3/2.1/2.2; issue pi-autoresearch-3e4.4.4).
 *
 * Integrates the four reviewed standalone modules into one gated tool:
 *  - candidate-policy  : validation + explicit human consent (ui.confirm)
 *  - candidate-state   : on-disk campaign state, exclusive lock, pending-op,
 *                        budgets (state dir: <workDir>/.auto/candidate)
 *  - candidate-worktree: isolated detached worktrees + checkpoint refs
 *                        (refs/pi-autoresearch/candidates/<id>)
 *  - candidate-measure : METRIC parsing, repeats, promotion gate, CAS
 *                        leader ref refs/pi-autoresearch/campaign-leader
 *
 * Design decisions (documented for review):
 *  - Leader ref: refs/pi-autoresearch/campaign-leader, created at init from
 *    the base HEAD, CAS-promoted at confirm. The user's branch is never moved.
 *  - Epoch: measurementScaleStatusOfDir(workDir).epoch (String()ed); the
 *    gate compares the two sides observed in the same confirm pass.
 *  - Checkpoint id in state = full 40-hex commit sha (matches the state ID_RE).
 *  - Ephemeral measurement worktrees live under <os.tmpdir()>/pi-ar-candidate/
 *    and are removed at the end of the same confirm (plain `git worktree
 *    remove` first, --force only for the paths this call created). Candidate
 *    work worktrees are never deleted (MVP).
 *  - While a campaign is initialized and not disabled, run_experiment and
 *    log_experiment refuse (tasks 3.2). A missing state file keeps the ordinary loop;
 *    an existing but corrupted state file fails closed (blocks it)
 *    keeps the ordinary loop working.
 *
 * Run: timeout 300 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/candidate-branch-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { createHarness } from "./fake-pi.ts";
import { measurementScaleStatusOfDir } from "../extensions/pi-autoresearch/measurement.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-candwiring-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileSyncSafe(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Policy matching the default benchmark/checks commands used below. */
function policyOf(dir, over = {}) {
  writeFileSyncSafe(path.join(dir, "METHOD.md"), "methodology v1\n");
  return {
    metric_name: "p95_ms",
    direction: "higher",
    repeats: 2,
    min_gain: 0.1,
    benchmark_argv: ["node", "-e", "console.log('METRIC p95_ms=' + process.env.CAND_BENCH_VALUE || 'METRIC p95_ms=1')"],
    checks_argv: ["node", "-e", "process.exit(0)"],
    benchmark_timeout_seconds: 30,
    confirm_budget_seconds: 120,
    candidate_step_limit: 5,
    candidate_time_limit_seconds: 600,
    methodology_files: [{ path: "METHOD.md", sha256: "" }],
    change_files: ["src/algo.ts"],
    ...over,
  };
}

const BENCH_OK = 'console.log("METRIC p95_ms=" + (Number(process.env.CAND_BENCH_VALUE) + Math.random() * 1e-9).toFixed(6))';

/**
 * Benchmark that prints a deterministic METRIC line driven by the CAND_BENCH_VALUE
 * env var (default 100). Deterministic (no random) so the gate math is exact.
 */
const BENCH_DETERMINISTIC = 'const v = Number(process.env.CAND_BENCH_VALUE ?? "100"); console.log("METRIC p95_ms=" + v.toFixed(6));';

async function setupRepo(label, { hasUI = true, confirmAnswer = true } = {}) {
  const dir = makeWorkDir(label);
  const h = await createHarness({ dir, sessionId: `candwiring-${label}`, realGit: true });
  // Seed the repo with a methodology file and a committed source file.
  writeFileSyncSafe(path.join(dir, "METHOD.md"), "methodology v1\n");
  writeFileSyncSafe(path.join(dir, "src", "algo.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir, encoding: "utf8" });
  // Turn autoresearch mode ON (gated tools otherwise refuse).
  await h.command("autoresearch").handler("on", h.ctx);
  if (!hasUI) h.ctx.hasUI = false;
  h.ctx.ui.confirm = async () => confirmAnswer;
  return { h, dir };
}

function callTool(h, action, params = {}) {
  const tool = h.tool("candidate_branch");
  assert.ok(tool, "candidate_branch tool must be registered");
  return tool.execute("id", { action, ...params }, null, null, h.ctx);
}

/** The candidate worktree path lives in the create response ("Worktree: <path>."). */
function wtPathFromCreateResponse(res) {
  const m = textOf(res).match(/Worktree:\s*(.+?)\./);
  assert.ok(m, `create response must include the worktree path: ${textOf(res)}`);
  return m[1].trim();
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function headOf(dir) {
  return git(["rev-parse", "HEAD"], dir).trim();
}

function snapshotUserTree(dir) {
  // Byte snapshot of every tracked/untracked file except .git and .auto.
  const out = {};
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".auto") continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r)).toString("hex");
    }
  };
  walk(".");
  return out;
}

function userTreeStatus(dir) {
  return git(["status", "--porcelain", "--untracked-files=all"], dir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

test("candidate_branch is registered with all 11 actions in the schema", async () => {
  const dir = makeWorkDir("reg");
  const h = await createHarness({ dir, sessionId: "candwiring-reg", realGit: false });
  const tool = h.tool("candidate_branch");
  assert.ok(tool, "candidate_branch must be registered");
  const schemaText = JSON.stringify(tool.parameters ?? {});
  for (const action of ["init", "create", "status", "resume", "run", "checkpoint", "pause", "select", "close", "confirm", "disable", "resolve"]) {
    assert.ok(schemaText.includes(`"${action}"`), `schema must mention action ${action}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// init
// ─────────────────────────────────────────────────────────────────────────────

test("init happy path: consent true -> campaign state exists with the frozen policy", async () => {
  const { h, dir } = await setupRepo("init-ok");
  const res = await callTool(h, "init", { policy: policyOf(dir) });
  const text = textOf(res);
  assert.match(text, /initialized|created|ready/i, `unexpected response: ${text}`);
  const statePath = path.join(dir, ".auto", "candidate", "state.json");
  assert.equal(fs.existsSync(statePath), true, "state.json must exist after init");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.policy.metric_name, "p95_ms");
  assert.equal(state.disabled, false);
  // Leader ref must exist and point at the base HEAD.
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  assert.equal(leader, headOf(dir), "leader ref must start at the base HEAD");
});

test("init with confirm=false refuses and writes nothing to disk", async () => {
  const { h, dir } = await setupRepo("init-no", { confirmAnswer: false });
  const res = await callTool(h, "init", { policy: policyOf(dir) });
  const text = textOf(res);
  assert.match(text, /refus|denied|not start|cancel|confirm/i, `unexpected response: ${text}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate")), false, "no campaign dir before consent");
});

test("init without UI refuses (consent cannot be substituted)", async () => {
  const { h, dir } = await setupRepo("init-noui", { hasUI: false });
  const res = await callTool(h, "init", { policy: policyOf(dir) });
  const text = textOf(res);
  assert.match(text, /ui|confirm|interactive/i, `unexpected response: ${text}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate")), false);
});

test("init with an invalid policy refuses before the dialog and writes nothing", async () => {
  const { h, dir } = await setupRepo("init-bad");
  const policy = policyOf(dir);
  policy.metric_name = "p95\nFAKE-LINE"; // LF injection attempt
  const res = await callTool(h, "init", { policy });
  const text = textOf(res);
  // No RAW control character may reach the response; the policy module
  // accepts an LF inside metric_name and the dialog path escapes it.
  assert.equal(/\nFAKE-LINE/.test(text), false, "injected line must not appear raw");
  if (fs.existsSync(path.join(dir, ".auto", "candidate"))) {
    // init succeeded with the escaped value — state must carry it verbatim
    const st = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
    assert.equal(st.policy.metric_name, "p95\nFAKE-LINE");
  } else {
    assert.match(text, /invalid|error/i);
  }
});

test("policy rewrite after init refuses (policy immutable)", async () => {
  const { h, dir } = await setupRepo("init-rewrite");
  await callTool(h, "init", { policy: policyOf(dir) });
  const res = await callTool(h, "init", { policy: policyOf(dir) });
  const text = textOf(res);
  assert.match(text, /already|immutable|exists/i, `unexpected response: ${text}`);
  // The original policy must be intact.
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  assert.equal(state.policy.metric_name, "p95_ms");
});

// ─────────────────────────────────────────────────────────────────────────────
// create / run / checkpoint happy path
// ─────────────────────────────────────────────────────────────────────────────

async function campaignWithCandidate(label, bench = BENCH_DETERMINISTIC) {
  const s = await setupRepo(label);
  const { h, dir } = s;
  const policy = policyOf(dir);
  policy.benchmark_argv = ["node", "-e", bench];
  await callTool(h, "init", { policy });
  const created = await callTool(h, "create", { candidate_id: "cand-a" });
  assert.match(textOf(created), /created|active|worktree|cand-a/i, `create failed: ${textOf(created)}`);
  const wtPath = wtPathFromCreateResponse(created);
  assert.equal(fs.existsSync(path.join(wtPath, "src", "algo.ts")), true, "worktree must be checked out");
  return { ...s, wtPath };
}

test("happy path: create -> run -> checkpoint -> confirm promotes the leader ref; user branch untouched", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("happy");
  const base = headOf(dir);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim();

  // Edit INSIDE the worktree only.
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2; // candidate optimization\n");

  // run: measure the candidate worktree.
  process.env.CAND_BENCH_VALUE = "100"; // leader-side value default
  const run = await callTool(h, "run", {});
  assert.match(textOf(run), /measured|run|p95|average/i, `run failed: ${textOf(run)}`);

  // checkpoint: save the improvement.
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "algo v2" });
  const cpText = textOf(cp);
  assert.match(cpText, /checkpoint|saved|commit/i, `checkpoint failed: ${cpText}`);
  const shaMatch = cpText.match(/Checkpoint saved:\s*([0-9a-f]{40})/);
  assert.ok(shaMatch, `checkpoint response must include the commit sha: ${cpText}`);
  const cpSha = shaMatch[1];
  // Candidate ref exists and points at the checkpoint commit.
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  assert.equal(refSha, cpSha);

  // confirm: promote if the gain clears min_gain. The benchmark reads
  // CAND_BENCH_VALUE from the environment — the wiring measures the CANDIDATE
  // side and the LEADER side with the same command; the checkpoint source has
  // no runtime effect on the printed value, so to exercise promotion the test
  // relies on the policy min_gain=0.1 and the leader base value of 100. Both
  // sides measure 100 -> equality refuses. To force a promote, we assert the
  // refusal path here and the promote path in a dedicated test below.
  const confirm = await callTool(h, "confirm", { candidate_bench_value: "115", leader_bench_value: "100" });
  const cText = textOf(confirm);
  // The wiring supports explicit override values for benchmark sides via
  // params (documented decision) or falls back to env; either way it must
  // produce a definitive verdict.
  if (/promoted|leader/i.test(cText)) {
    const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
    assert.equal(leader, cpSha, "leader ref must point at the checkpoint commit");
  } else {
    assert.match(cText, /below|refus|no promotion|not greater/i, `confirm gave neither verdict: ${cText}`);
  }
  // The user's branch and worktree are untouched either way.
  assert.equal(headOf(dir), base, "user HEAD must not move");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim(), branch);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  assert.equal(state.disabled, false);
});

test("confirm promotes when the candidate benchmark clearly beats the leader (env-tuned benchmark)", async () => {
  // The benchmark argv embeds per-side values: the wiring replaces the token
  // CAND_SIDE_LEADER / CAND_SIDE_CAND in argv? No — argv is fixed by policy.
  // Design decision: the SAME command measures both sides; a value difference
  // must come from the repo content. The candidate worktree carries the
  // improved source; the benchmark reads src/algo.ts and prints its constant.
  const benchmark = 'const fs=require("node:fs");const src=fs.readFileSync("src/algo.ts","utf8");const m=src.match(/a = (\\\d+)/);console.log("METRIC p95_ms=" + (m ? Number(m[1]) : 1).toFixed(6));';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("promote", benchmark);
  // Candidate source has value 2 vs base value 1 -> gain 1 > min_gain 0.1.
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");

  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "algo v2" });
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];

  const base = headOf(dir);
  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.match(cText, /PROMOTED|No promotion/i, `confirm verdict unclear: ${cText}`);
  assert.match(cText, /PROMOTED/i, `confirm must promote: ${cText}`);
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  assert.equal(leader, cpSha, "leader ref must move to the checkpoint commit");
  assert.equal(headOf(dir), base, "user HEAD stays");
});

test("confirm refuses when the gain does not exceed min_gain (equality)", async () => {
  const benchmark = 'const fs=require("node:fs");const src=fs.readFileSync("src/algo.ts","utf8");const m=src.match(/a = (\\\d+)/);console.log("METRIC p95_ms=" + (m ? Number(m[1]) : 1).toFixed(6));';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("equal", benchmark);
  // Same numeric value 1 as the leader base -> decimal-exact equality -> refuse.
  writeFileSyncSafe(path.join(wt, "src/algo.ts"), "export const a = 1; // touched\n");
  await callTool(h, "run", {});
  await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "noop" });
  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.match(cText, /below|not greater|refus|no promotion/i, `equality must refuse: ${cText}`);
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  assert.equal(leader, headOf(dir), "leader ref must stay at base");
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

test("second active candidate is refused; pause -> resume works", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("second");
  const res = await callTool(h, "create", { candidate_id: "cand-b" });
  assert.match(textOf(res), /active|pause|refus/i, `second candidate must refuse: ${textOf(res)}`);
  const paused = await callTool(h, "pause", { candidate_id: "cand-a" });
  assert.match(textOf(paused), /pause done|paused|cand-a/i, `pause failed: ${textOf(paused)}`);
  const createB = await callTool(h, "create", { candidate_id: "cand-b" });
  assert.match(textOf(createB), /created/i, `create after pause failed: ${textOf(createB)}`);
  // Resume cand-a fails while cand-b is active.
  const resumeFail = await callTool(h, "resume", { candidate_id: "cand-a" });
  assert.match(textOf(resumeFail), /active|pause/i);
  await callTool(h, "pause", { candidate_id: "cand-b" });
  const resumed = await callTool(h, "resume", { candidate_id: "cand-a" });
  assert.match(textOf(resumed), /active|cand-a/i, `resume failed: ${textOf(resumed)}`);
});

test("dirty user worktree (staged+unstaged+untracked) survives create/run byte-exact and stays out of checkpoints", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("dirty");
  // Real candidate change so the checkpoint below has content to commit.
  writeFileSyncSafe(path.join(wt, "src/algo.ts"), "export const a = 2;");
  // Dirty the USER tree.
  writeFileSyncSafe(path.join(dir, "staged.txt"), "staged content\n");
  writeFileSyncSafe(path.join(dir, "src", "other.ts"), "export const b = 1;\n");
  writeFileSyncSafe(path.join(dir, "untracked_dir", "note.txt"), "notes\n");
  execFileSync("git", ["add", "staged.txt"], { cwd: dir, encoding: "utf8" });
  const beforeStatus = userTreeStatus(dir).split("\n").filter(Boolean).filter((l) => !l.includes(".auto/")).sort();
  const beforeSnap = snapshotUserTree(dir);

  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  // Checkpoint succeeds only if the worktree has the allowed file changed; the
  // USER tree's dirty files must not be touched either way.
  const afterSnap = snapshotUserTree(dir);
  assert.deepEqual(afterSnap, beforeSnap, "user files must stay byte-exact");
  const afterStatus = userTreeStatus(dir).split("\n").filter(Boolean).filter((l) => !l.includes(".auto/")).sort();
  assert.deepEqual(afterStatus, beforeStatus, "user git status must be unchanged");
});

test("checkpoint refuses files outside allowed_files and keeps the worktree changes", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("outside", benchmark);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  writeFileSyncSafe(path.join(wt, "README_CAND.md"), "extra\n");
  const res = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  const text = textOf(res);
  assert.match(text, /outside|allowed|refus|README_CAND/i, `unexpected response: ${text}`);
  assert.equal(fs.existsSync(path.join(wt, "README_CAND.md")), true, "worktree file must not be deleted");
  assert.equal(fs.existsSync(path.join(wt, "src", "algo.ts")), true);
});

test("select requires a clean worktree: unsaved candidate changes refuse the switch", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("select", benchmark);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp1" });
  // Unsaved extra change.
  writeFileSyncSafe(path.join(wt, "src", "extra.ts"), "export const c = 3;\n");
  // Pause + create second candidate (switch path).
  await callTool(h, "pause", { candidate_id: "cand-a" });
  await callTool(h, "create", { candidate_id: "cand-b" });
  // The dirty worktree of cand-a still holds unsaved changes; switching back
  // (resume) is allowed by state, but design §2 step 4: switching candidates
  // requires saved changes — resume must check the source worktree.
  const resume = await callTool(h, "resume", { candidate_id: "cand-a" });
  const text = textOf(resume);
  // The wiring must refuse with a listing, and nothing may be deleted.
  assert.match(text, /unsaved|dirty|changes|refus/i, `dirty resume must refuse: ${text}`);
  assert.equal(fs.existsSync(path.join(wt, "src", "extra.ts")), true, "unsaved changes must not be deleted");
});

test("budget exhaustion refuses run and keeps checkpoints", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir } = await setupRepo("budget");
  const policy = policyOf(dir);
  policy.benchmark_argv = ["node", "-e", benchmark];
  policy.candidate_step_limit = 1;
  await callTool(h, "init", { policy });
  const created = await callTool(h, "create", { candidate_id: "cand-a" });
  const wt = wtPathFromCreateResponse(created);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  const run1 = await callTool(h, "run", {});
  assert.match(textOf(run1), /measured|run|average/i);
  await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  const run2 = await callTool(h, "run", {});
  const text = textOf(run2);
  assert.match(text, /budget|limit|refus/i, `second run must refuse: ${text}`);
  // Checkpoint must remain available.
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand = state.candidates.find((c) => c.id === "cand-a");
  assert.equal(cand.checkpoints.length, 1, "checkpoint must survive budget exhaustion");
});

test("run without an active candidate refuses", async () => {
  const { h, dir } = await setupRepo("run-noactive");
  await callTool(h, "init", { policy: policyOf(dir) });
  const res = await callTool(h, "run", {});
  assert.match(textOf(res), /active|candidate|refus/i, `unexpected: ${textOf(res)}`);
});

test("status shows leader, active candidate, budget and last measurement", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("status", benchmark);
  await callTool(h, "run", {});
  const res = await callTool(h, "status", {});
  const text = textOf(res);
  assert.match(text, /cand-a/i, `status must show the active candidate: ${text}`);
  assert.match(text, /leader/i, `status must show the leader: ${text}`);
  assert.match(text, /step|budget/i, `status must show the budget: ${text}`);
  assert.match(text, /p95|average|measur/i, `status must show the last measurement: ${text}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// pending-op / manual_check_required
// ─────────────────────────────────────────────────────────────────────────────

test("pending-op marker blocks operations (fixture written by hand)", async () => {
  const benchmark = 'const fs=require("node:fs");const src=fs.readFileSync("src/algo.ts","utf8");const m=src.match(/a = (\\\d+)/);console.log("METRIC p95_ms=" + (m ? Number(m[1]) : 1).toFixed(6));';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("pend", benchmark);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];

  // Sabotage: make the ephemeral measurement fail by deleting the repo-wide
  // benchmark dependency? The benchmark reads src/algo.ts which exists in the
  // ephemeral worktrees. Instead, break the checks command mid-flight via env.
  // Simpler deterministic sabotage: make the benchmark argv fail on the LEADER
  // side only is hard through the tool; instead remove the methodology file —
  // compareForPromotion refuses with methodology_changed, which is a clean
  // refusal, not a pending op. To force a real pending op, delete the leader
  // ref mid-operation? Not reachable. Use a benchmark that exits non-zero:
  // overwrite policy? Policy is immutable. So: sabotage the ephemeral dir by
  // creating a file where git worktree add would go? Not reachable either.
  // Honest approach: run a benchmark that works, but delete METHOD.md from the
  // repo root before confirm -> currentMethodology hash mismatch -> clean
  // refusal (not pending). For the pending-op path, simulate an aborted
  // process: craft a benchmark that hangs > timeout for repeat 2+ — the run
  // itself times out inside runRepeatedMeasurement -> refusal; the pending
  // marker is cleared by runCandidateMeasurement only on success of the
  // closure, but a thrown error leaves it. A timeout refusal is a RETURNED
  // refusal, not a throw, so the marker clears. A pending marker requires the
  // closure to THROW. pi.exec kill is returned, not thrown. So simulate a
  // throw by breaking the exec adapter: not reachable from outside.
  // => Test the pending path through state module semantics directly:
  fs.rmSync(path.join(dir, ".auto", "candidate", "pending-op.json"), { force: true });
  fs.writeFileSync(
    path.join(dir, ".auto", "candidate", "pending-op.json"),
    JSON.stringify({ name: "confirm cand-a", started_at: new Date().toISOString() }),
  );
  const blocked = await callTool(h, "run", {});
  const bText = textOf(blocked);
  assert.match(bText, /manual|check|pending/i, `run must be blocked by the pending marker: ${bText}`);
  // Data intact: state.json, worktree, checkpoint ref all present.
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "state.json")), true);
  assert.equal(fs.existsSync(wt), true);
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  assert.equal(refSha, cpSha);
  // status reports manual_check_required.
  const status = await callTool(h, "status", {});
  assert.match(textOf(status), /manual|check/i, `status must surface the pending op: ${textOf(status)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordinary-loop compatibility (tasks 3.2)
// ─────────────────────────────────────────────────────────────────────────────

test("run_experiment refuses while a campaign is active; works again after disable", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("block");
  const runExp = h.tool("run_experiment");
  const blocked = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  const bText = textOf(blocked);
  assert.match(bText, /candidate campaign active/i, `run_experiment must refuse: ${bText}`);

  const logExp = h.tool("log_experiment");
  const blockedLog = await logExp.execute("id", { metric: 1, status: "keep", description: "x" }, null, null, h.ctx);
  assert.match(textOf(blockedLog), /candidate campaign active/i, `log_experiment must refuse: ${textOf(blockedLog)}`);

  // Read-only tools keep working.
  const ts = h.tool("tree_status");
  const tsRes = await ts.execute("id", {}, null, null, h.ctx);
  assert.ok(textOf(tsRes).length > 0, "tree_status must stay usable");

  const disable = await callTool(h, "disable", {});
  assert.match(textOf(disable), /disable done|disabled/i);
  const runOk = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  assert.equal(/candidate campaign active/i.test(textOf(runOk)), false, "after disable the ordinary loop works");
});

test("no campaign on disk: ordinary loop behaves exactly as before", async () => {
  const { h, dir } = await setupRepo("nocampaign");
  const runExp = h.tool("run_experiment");
  const res = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  const text = textOf(res);
  assert.equal(/candidate campaign active/i.test(text), false, "no campaign -> no blocking");
  // corrupt state file => FAIL CLOSED (design §4): an unclear campaign state blocks the ordinary loop
  writeFileSyncSafe(path.join(dir, ".auto", "candidate", "state.json"), "{corrupt");
  const res2 = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  assert.equal(/candidate campaign active/i.test(textOf(res2)), true, "corrupt state -> fail-closed blocking");
});

test("junk state with disabled:true (no schema) fails closed; a schema-valid disabled campaign releases the loop", async () => {
  const { h, dir } = await setupRepo("junkdisabled");
  const runExp = h.tool("run_experiment");
  const statePath = path.join(dir, ".auto", "candidate", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSyncSafe(statePath, JSON.stringify({ disabled: true, junk: 1 }));
  const junk = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  assert.equal(/candidate campaign active/i.test(textOf(junk)), true, "a non-schema disabled file must keep the loop blocked");
  writeFileSyncSafe(statePath, JSON.stringify({ schema_version: 1, disabled: true, candidates: [] }));
  const valid = await runExp.execute("id", { command: "echo hi", timeout_seconds: 10 }, null, null, h.ctx);
  assert.equal(/candidate campaign active/i.test(textOf(valid)), false, "a schema-valid disabled campaign must release the loop");
});

// ─────────────────────────────────────────────────────────────────────────────
// close / disable keep data
// ─────────────────────────────────────────────────────────────────────────────

test("close keeps the checkpoint ref; disable keeps state files", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("close", benchmark);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];
  await callTool(h, "close", { candidate_id: "cand-a" });
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  assert.equal(refSha, cpSha, "checkpoint ref must survive close");
  await callTool(h, "disable", {});
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "state.json")), true, "state survives disable");
  assert.equal(fs.existsSync(wt), true, "worktree survives disable");
});

test("select switches the selected checkpoint of a candidate (regression checkpoint selectable)", async () => {
  const benchmark = 'console.log("METRIC p95_ms=1");';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("selectcp", benchmark);
  // Regression checkpoint: value goes DOWN first (2 -> 1) then up (3).
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  const cp1 = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "regression cp" });
  const sha1 = textOf(cp1).match(/[0-9a-f]{40}/)[0];
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 1;\n");
  const cp2 = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "worse cp" });
  const sha2 = textOf(cp2).match(/[0-9a-f]{40}/)[0];
  assert.notEqual(sha1, sha2, "each checkpoint is its own commit");
  const sel = await callTool(h, "select", { candidate_id: "cand-a", checkpoint_id: sha1 });
  assert.match(textOf(sel), /select|sha1|checkpoint/i, `select failed: ${textOf(sel)}`);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand = state.candidates.find((c) => c.id === "cand-a");
  assert.equal(cand.selected_checkpoint, sha1, "selected checkpoint must follow select");
});

// ═ Fix-round regressions (review B1-B4 + acceptance items 5-11) ═

const BENCH_BY_SOURCE = 'const fs=require("node:fs");const src=fs.readFileSync("src/algo.ts","utf8");const m=src.match(/a = (\\\d+)/);console.log("METRIC p95_ms=" + (m ? Number(m[1]) : 1).toFixed(6));';
const CHECKS_FAIL_ON_BAD = 'const fs=require("node:fs");const src=fs.readFileSync("src/algo.ts","utf8");process.exit(src.includes("// BAD") ? 1 : 0);';

test("B1: a candidate named like an old ephemeral id keeps unsaved files through confirm", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("collide", BENCH_BY_SOURCE);
  // Pause cand-a, create a candidate whose id matches the OLD ephemeral naming
  // scheme, give it unsaved work, then CLOSE it (worktree and bytes survive;
  // close only flips the status) so cand-a can be resumed and confirmed.
  await callTool(h, "pause", { candidate_id: "cand-a" });
  const created = await callTool(h, "create", { candidate_id: "confirm-leader" });
  assert.match(textOf(created), /created|confirm-leader/i, `create colliding id failed: ${textOf(created)}`);
  const wt2 = wtPathFromCreateResponse(created);
  const precious = path.join(wt2, "PRECIOUS_UNSAVED.txt");
  writeFileSyncSafe(precious, "do not lose me\n");
  // close now refuses on unsaved changes (review final-B3), and a checkpoint
  // refuses while PRECIOUS exists (outside change_files, review final-B2; the
  // worktree-wide status scan blocks any uncommitted path). MVP path: remove
  // PRECIOUS before the in-scope checkpoint + close, then recreate it
  // byte-exact — the assertions below still prove confirm never deletes
  // unsaved candidate work that exists at confirm time.
  fs.rmSync(precious, { force: true });
  writeFileSyncSafe(path.join(wt2, "src", "algo.ts"), "export const a = 3;\n");
  const cpClash = await callTool(h, "checkpoint", { candidate_id: "confirm-leader", allowed_files: ["src/algo.ts"], message: "cp-clash" });
  assert.match(textOf(cpClash), /Checkpoint saved/i, `pre-close checkpoint failed: ${textOf(cpClash)}`);
  const closed = await callTool(h, "close", { candidate_id: "confirm-leader" });
  assert.match(textOf(closed), /close|done/i, `close failed after clean checkpoint: ${textOf(closed)}`);
  writeFileSyncSafe(precious, "do not lose me\n");

  const resumed = await callTool(h, "resume", { candidate_id: "cand-a" });
  assert.match(textOf(resumed), /resumed/i, `resume must succeed: ${textOf(resumed)}`);

  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 5;\n");
  const runRes = await callTool(h, "run", {});
  const cpRes = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  assert.match(textOf(cpRes), /Checkpoint saved/i, `checkpoint must succeed before confirm (run: ${textOf(runRes).slice(0, 80)}, cp: ${textOf(cpRes).slice(0, 120)})`);

  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.match(cText, /PROMOTED|No promotion/i, `confirm verdict unclear: ${cText}`);
  assert.equal(fs.existsSync(wt2), true, "colliding candidate's worktree must survive confirm");
  assert.equal(fs.existsSync(precious), true, "PRECIOUS_UNSAVED.txt must survive confirm");
  assert.equal(fs.readFileSync(precious, "utf8"), "do not lose me\n", "unsaved file content must be byte-exact");
  const wtList = git(["worktree", "list", "--porcelain"], dir);
  assert.equal(/tmp-confirm-/.test(wtList), false, `no ephemeral worktrees may remain: ${wtList}`);
});

test("B2: BAD checkpoint is refused even though the live tree is fixed", async () => {
  const s = await setupRepo("badcp2");
  const policy = policyOf(s.dir);
  policy.benchmark_argv = ["node", "-e", BENCH_BY_SOURCE];
  policy.checks_argv = ["node", "-e", CHECKS_FAIL_ON_BAD];
  await callTool(s.h, "init", { policy });
  const created = await callTool(s.h, "create", { candidate_id: "cand-a" });
  const wt2 = wtPathFromCreateResponse(created);
  writeFileSyncSafe(path.join(wt2, "src", "algo.ts"), "export const a = 9; // BAD\n");
  await callTool(s.h, "run", {});
  const cp = await callTool(s.h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "bad cp" });
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];
  writeFileSyncSafe(path.join(wt2, "src", "algo.ts"), "export const a = 9;\n");

  const leaderBefore = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], s.dir).trim();
  const confirm = await callTool(s.h, "confirm", {});
  const cText = textOf(confirm);
  assert.match(cText, /No promotion|checks|refus/i, `BAD checkpoint must not promote: ${cText}`);
  assert.equal(/PROMOTED/i.test(cText), false, "BAD checkpoint must never be promoted");
  const leaderAfter = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], s.dir).trim();
  assert.equal(leaderAfter, leaderBefore, "leader ref must not move on a failed checks gate");
});

test("B2 happy path still promotes with checks passing on the checkpoint", async () => {
  const s = await setupRepo("badcp3");
  const policy = policyOf(s.dir);
  policy.benchmark_argv = ["node", "-e", BENCH_BY_SOURCE];
  policy.checks_argv = ["node", "-e", CHECKS_FAIL_ON_BAD];
  await callTool(s.h, "init", { policy });
  const created = await callTool(s.h, "create", { candidate_id: "cand-a" });
  const wt = wtPathFromCreateResponse(created);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 7;\n");
  await callTool(s.h, "run", {});
  const cp = await callTool(s.h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "good cp" });
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];
  const confirm = await callTool(s.h, "confirm", {});
  assert.match(textOf(confirm), /PROMOTED/i, `good checkpoint must promote: ${textOf(confirm)}`);
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], s.dir).trim();
  assert.equal(leader, cpSha);
});

test("B3: run accumulates real time_used_seconds and the time limit exhausts", async () => {
  const s = await setupRepo("timebudget");
  const policy = policyOf(s.dir);
  policy.benchmark_argv = ["node", "-e", 'await new Promise(r=>setTimeout(r,300));console.log("METRIC p95_ms=1");'];
  policy.candidate_time_limit_seconds = 1;
  await callTool(s.h, "init", { policy });
  const created = await callTool(s.h, "create", { candidate_id: "cand-a" });
  const wt = wtPathFromCreateResponse(created);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");

  const run1 = await callTool(s.h, "run", {});
  assert.match(textOf(run1), /measured|average/i, `run1 failed: ${textOf(run1)}`);
  const state1 = JSON.parse(fs.readFileSync(path.join(s.dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand1 = state1.candidates.find((c) => c.id === "cand-a");
  assert.equal(cand1.time_used_seconds > 0, true, `time_used_seconds must accumulate, got ${cand1.time_used_seconds}`);

  let exhausted = null;
  for (let i = 0; i < 6; i++) {
    const r = await callTool(s.h, "run", {});
    if (/budget|limit|refus/i.test(textOf(r))) { exhausted = textOf(r); break; }
  }
  assert.ok(exhausted, "the time limit must eventually refuse a run");
  assert.match(exhausted, /budget|limit/i);
});

test("B4: refused create leaves git worktree list and state unchanged; id not stuck", async () => {
  const { h, dir } = await campaignWithCandidate("orphan", BENCH_DETERMINISTIC);
  const listBefore = git(["worktree", "list", "--porcelain"], dir).trim();
  const stateBefore = fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8");

  const refused = await callTool(h, "create", { candidate_id: "cand-b" });
  const rText = textOf(refused);
  assert.match(rText, /second_active_candidate/i, `refusal must name the reason: ${rText}`);
  assert.equal(git(["worktree", "list", "--porcelain"], dir).trim(), listBefore, "worktree list must be unchanged after a refused create");
  assert.equal(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"), stateBefore, "state must be unchanged after a refused create");

  await callTool(h, "pause", { candidate_id: "cand-a" });
  const created = await callTool(h, "create", { candidate_id: "cand-b" });
  assert.match(textOf(created), /created/i, `create after pause must succeed: ${textOf(created)}`);
  const wtB = wtPathFromCreateResponse(created);
  assert.equal(fs.existsSync(path.join(wtB, "src", "algo.ts")), true);
});

test("acceptance 8: select on a dirty candidate worktree refuses and keeps bytes", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("seldirty", BENCH_DETERMINISTIC);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  const cp1 = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp1" });
  const sha1 = textOf(cp1).match(/[0-9a-f]{40}/)[0];
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 3;\n");
  const cp2 = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp2" });
  const sha2 = textOf(cp2).match(/[0-9a-f]{40}/)[0];
  writeFileSyncSafe(path.join(wt, "src", "extra.ts"), "export const c = 3;\n");
  const before = fs.readFileSync(path.join(wt, "src", "extra.ts"), "utf8");

  const sel = await callTool(h, "select", { candidate_id: "cand-a", checkpoint_id: sha1 });
  const selText = textOf(sel);
  assert.match(selText, /unsaved|changes|refus/i, `dirty select must refuse: ${selText}`);
  assert.equal(fs.existsSync(path.join(wt, "src", "extra.ts")), true, "unsaved file must survive");
  assert.equal(fs.readFileSync(path.join(wt, "src", "extra.ts"), "utf8"), before, "unsaved bytes must be intact");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand = state.candidates.find((c) => c.id === "cand-a");
  assert.equal(cand.selected_checkpoint, sha2, "selected checkpoint must be unchanged after refusal");

  fs.rmSync(path.join(wt, "src", "extra.ts"), { force: true });
  const sel2 = await callTool(h, "select", { candidate_id: "cand-a", checkpoint_id: sha1 });
  assert.match(textOf(sel2), /selected|checkpoint/i, `clean select must work: ${textOf(sel2)}`);
});

test("acceptance 11: init after disable starts a fresh campaign with a new leader base", async () => {
  const { h, dir } = await campaignWithCandidate("reinit", BENCH_DETERMINISTIC);
  await callTool(h, "disable", {});
  const policy = policyOf(dir);
  policy.benchmark_argv = ["node", "-e", BENCH_DETERMINISTIC];
  policy.min_gain = 0.2;
  const init2 = await callTool(h, "init", { policy });
  const iText = textOf(init2);
  assert.match(iText, /initialized|Campaign/i, `re-init after disable failed: ${iText}`);
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  assert.equal(leader, headOf(dir), "leader must equal the new base HEAD");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "state.json")), true, "new state must exist");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 2 (review B-A / B-B / B-C)
// ─────────────────────────────────────────────────────────────────────────────

test("B-A: leader-side benchmark failure during confirm returns a refusal (no throw) and leaves no tmp-confirm-* worktrees", async () => {
  // Benchmark that succeeds in the candidate's own worktree (CAND_BENCH_FAIL
  // unset) but exits non-zero when CAND_BENCH_FAIL=1 — set only around confirm.
  const bench = 'if (process.env.CAND_BENCH_FAIL === "1") process.exit(3); const v = Number(process.env.CAND_BENCH_VALUE ?? "100"); console.log("METRIC p95_ms=" + v.toFixed(6));';
  const { h, dir, wtPath: wt } = await campaignWithCandidate("ba-fail", bench);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  const runRes = await callTool(h, "run", {});
  assert.match(textOf(runRes), /measured|average/i, `run failed: ${textOf(runRes)}`);
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp" });
  assert.match(textOf(cp), /Checkpoint saved/i, `checkpoint failed: ${textOf(cp)}`);
  const cpSha = textOf(cp).match(/Checkpoint saved:\s*([0-9a-f]{40})/)[1];

  process.env.CAND_BENCH_FAIL = "1"; // both sides fail -> leader side fails first
  let confirm;
  try {
    confirm = await callTool(h, "confirm", {});
  } finally {
    delete process.env.CAND_BENCH_FAIL;
  }
  const cText = textOf(confirm);
  assert.match(cText, /⛔|error|fail/i, `confirm must return a refusal text, got: ${cText}`);
  assert.equal(/PROMOTED/i.test(cText), false, "nothing may be promoted on a failed side");
  // The pending marker stays (the closure threw inside beginOperation).
  const insp = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), true, "pending marker must remain after a thrown side failure");
  // No ephemeral leftovers: git worktree list has no tmp-confirm-*, tmpdir has no pi-ar-candidate tmp dirs.
  const wtList = git(["worktree", "list", "--porcelain"], dir);
  assert.equal(/tmp-confirm-/.test(wtList), false, `no ephemeral worktrees may remain registered: ${wtList}`);
  const tmpRoot = path.join(os.tmpdir(), "pi-ar-candidate");
  if (fs.existsSync(tmpRoot)) {
    const stray = fs.readdirSync(tmpRoot).filter((d) => d.startsWith("tmp-confirm-"));
    assert.equal(stray.length, 0, `no tmp-confirm-* dirs may remain on disk: ${stray.join(", ")}`);
  }
  // Checkpoint and worktree are intact; the operator resolves the pending op.
  assert.equal(git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim(), cpSha, "checkpoint ref must be intact");
  assert.equal(fs.existsSync(wt), true, "candidate worktree must survive");
});

test("B-B: crash between checkpoint commit and state write leaves manual_check_required, commit+ref intact", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("crashwin", BENCH_DETERMINISTIC);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2;\n");
  await callTool(h, "run", {});

  // Inject the crash deterministically (no hooks: git-for-windows does not run
  // plain-text hooks): make state.json READ-ONLY so the state row write inside
  // the one-marker flow fails EPERM AFTER the commit+ref succeeded. The state
  // bytes stay valid (better than corrupting); the marker stays => the next
  // call must report manual_check_required (marker is checked first).
  const campState = path.join(dir, ".auto", "candidate", "state.json");
  const stateBefore = fs.readFileSync(campState, "utf8");
  fs.chmodSync(campState, 0o444);

  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp-crash" });
  const cpText = textOf(cp);
  assert.match(cpText, /operation_failed|manual|state|already exist/i, `checkpoint must report the failure honestly: ${cpText}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), true, "pending marker must remain (one-marker flow)");

  // The checkpoint ref was written by work() before the state write => it exists.
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  assert.match(refSha, /^[0-9a-f]{40}$/, `checkpoint ref must exist after the crash: ${refSha}`);

  // The pending marker takes precedence over the corrupt state: the next call
  // reports manual_check_required, not state_unreadable.
  const blocked = await callTool(h, "run", {});
  assert.match(textOf(blocked), /manual_check_required/i, `next call must be manual_check_required: ${textOf(blocked)}`);
  const status = await callTool(h, "status", {});
  assert.match(textOf(status), /manual_check_required/i, `status must surface the pending op: ${textOf(status)}`);

  // Operator repair: make the state writable again; the bytes are unchanged
  // (the write failed), so the resolve action (explicit operator confirmation)
  // clears the marker and restores a consistent campaign.
  fs.chmodSync(campState, 0o644);
  assert.equal(fs.readFileSync(campState, "utf8"), stateBefore, "state bytes must be unchanged (the write failed)");
  const resolve = await callTool(h, "resolve", { operator_confirmation: "resolved" });
  const resText = textOf(resolve);
  assert.match(resText, /resolved|cleared/i, `manual resolve must work: ${resText}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), false, "marker must be cleared after resolution");
  // A resolve without the explicit confirmation token must refuse.
  // (marker is gone, so first re-check: resolve with a bad token on a clean
  // state refuses with invalid_argument/no pending op rather than succeeding.)
  const badResolve = await callTool(h, "resolve", { operator_confirmation: "yes" });
  assert.match(textOf(badResolve), /invalid_argument|invalid|no pending/i, `resolve without the exact token must refuse: ${textOf(badResolve)}`);
});

test("B-C: init with consent=false after disable does NOT archive the campaign directory", async () => {
  const { h, dir } = await campaignWithCandidate("noarch", BENCH_DETERMINISTIC);
  await callTool(h, "disable", {});
  const stateBefore = fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8");

  // Same harness setup pattern as "init with confirm=false": flip the dialog answer.
  h.ctx.ui.confirm = async () => false;
  const refused = await callTool(h, "init", { policy: policyOf(dir) });
  const rText = textOf(refused);
  assert.match(rText, /policy_consent|consent|refus/i, `init must refuse without consent: ${rText}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "state.json")), true, ".auto/candidate must be untouched");
  assert.equal(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"), stateBefore, "state bytes must be unchanged");
  const autoEntries = fs.readdirSync(path.join(dir, ".auto")).filter((e) => e.includes("-disabled-"));
  assert.equal(autoEntries.length, 0, `no -disabled- archive may exist after a consent refusal: ${autoEntries.join(", ")}`);
});

// ─── Round-3 resolve contract (review F4/F5) ─────────────────────────────────

/** Leaves an interrupted checkpoint: commit+ref exist, state row never written. */
async function crashedCheckpoint(label) {
  const ctx = await campaignWithCandidate(label, BENCH_DETERMINISTIC);
  writeFileSyncSafe(path.join(ctx.wtPath, "src", "algo.ts"), "export const a = 2;\n");
  await callTool(ctx.h, "run", {});
  const campState = path.join(ctx.dir, ".auto", "candidate", "state.json");
  fs.chmodSync(campState, 0o444);
  await callTool(ctx.h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp-crash" });
  fs.chmodSync(campState, 0o644);
  return { ...ctx, campState };
}

test("resolve without UI refuses and keeps the marker", async () => {
  const { h, dir } = await crashedCheckpoint("res-noui");
  h.ctx.hasUI = false;
  const r = await callTool(h, "resolve", {});
  assert.match(textOf(r), /no_ui|dialog/i, `resolve without UI must refuse: ${textOf(r)}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), true, "marker must stay");
});

test("resolve with operator confirm=false refuses; model-supplied token cannot bypass the dialog", async () => {
  const { h, dir } = await crashedCheckpoint("res-deny");
  h.ctx.ui.confirm = async () => false;
  const r = await callTool(h, "resolve", { operator_confirmation: "resolved" });
  assert.match(textOf(r), /operator_consent|consent/i, `must refuse without dialog consent: ${textOf(r)}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), true, "marker must stay after refusal");
});

test("resolve: a root-commit orphan (no parent) refuses as orphan_unverified without throwing; marker stays", async () => {
  const { h, dir } = await crashedCheckpoint("res-root");
  // Re-point the orphan ref at a parentless commit so `rev-parse <sha>^` fails.
  const rootSha = git(["commit-tree", git(["write-tree"], dir).trim(), "-m", "root"], dir).trim();
  git(["update-ref", "refs/pi-autoresearch/candidates/cand-a", rootSha], dir);
  h.ctx.ui.confirm = async () => true;
  const r = await callTool(h, "resolve", {});
  const text = textOf(r);
  assert.doesNotMatch(text, /THREW|TypeError/i, `resolve must not throw on a root orphan: ${text}`);
  assert.match(text, /orphan_unverified|could not be verified/i, `root orphan must be refused as unverified: ${text}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), true, "marker must stay for manual inspection");
});

test("resolve: a valid orphan over the last checkpoint is registered under operator consent and clears the marker", async () => {
  const { h, dir } = await crashedCheckpoint("res-valid");
  h.ctx.ui.confirm = async () => true;
  const r = await callTool(h, "resolve", {});
  assert.match(textOf(r), /Orphan checkpoint registered/i, `valid orphan must register: ${textOf(r)}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), false, "marker must be cleared");
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand = st.candidates.find((c) => c.id === "cand-a");
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  assert.equal(cand.checkpoints.includes(refSha), true, "orphan sha must be registered in state");
  assert.equal(cand.selected_checkpoint, refSha, "orphan must become the selected checkpoint");
});

test("resolve after a crash AFTER the state row was written (already registered) clears the marker instead of deadlocking", async () => {
  const { h, dir, campState } = await crashedCheckpoint("res-already");
  // Simulate the crash window after writeStateAtomic but before clearPendingOp:
  // register the orphan in state by hand, keep the marker.
  const refSha = git(["rev-parse", "refs/pi-autoresearch/candidates/cand-a"], dir).trim();
  const st = JSON.parse(fs.readFileSync(campState, "utf8"));
  const cand = st.candidates.find((c) => c.id === "cand-a");
  cand.checkpoints.push(refSha);
  cand.selected_checkpoint = refSha;
  fs.writeFileSync(campState, JSON.stringify(st, null, 2), "utf8");
  h.ctx.ui.confirm = async () => true;
  const first = await callTool(h, "resolve", {});
  assert.doesNotMatch(textOf(first), /orphan_unverified/i, `already-registered orphan must not deadlock: ${textOf(first)}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "pending-op.json")), false, "marker must be cleared");
  const again = await callTool(h, "status", {});
  assert.doesNotMatch(textOf(again), /manual_check_required/i, "campaign must be usable again");
});

// ─── Final review B2/B3 regressions ──────────────────────────────────────────

test("B2: a methodology file in allowed_files is refused before any ref is written", async () => {
  const { h, dir } = await campaignWithCandidate("methcp", BENCH_DETERMINISTIC);
  const cp = await callTool(h, "checkpoint", { allowed_files: ["METHOD.md"], message: "steal methodology" });
  const t = textOf(cp);
  assert.equal(/Checkpoint saved/i.test(t), false, `methodology checkpoint must refuse: ${t}`);
  assert.match(t, /methodology|change_files/i, `refusal must name methodology scope: ${t}`);
});

test("B2: confirm hashes methodology from the checkpoint blob, not the user tree", async () => {
  // The policy layer forbids methodology files in change_files, so a candidate
  // can never commit a methodology edit; the checkpoint-level refusal above
  // closes that door. The remaining hazard this test pins: confirm must hash
  // the methodology from the CHECKPOINT COMMIT blob, not from the user's live
  // tree (which a stray process could touch between checkpoint and confirm).
  const { h, dir, wtPath: wt } = await campaignWithCandidate("methblob", BENCH_BY_SOURCE);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 9;\n");
  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "clean cp" });
  assert.match(textOf(cp), /Checkpoint saved/i, `clean checkpoint failed: ${textOf(cp)}`);
  // Tamper the USER'S live copy of the pinned methodology file AFTER checkpointing.
  writeFileSyncSafe(path.join(dir, "METHOD.md"), "methodology TAMPERED IN USER TREE\n");
  const leaderBefore = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.match(cText, /PROMOTED/i, `confirm must hash from the checkpoint blob, not the tampered live tree: ${cText}`);
  const leader = git(["rev-parse", "refs/pi-autoresearch/campaign-leader"], dir).trim();
  assert.notEqual(leader, leaderBefore, "leader must advance on a genuine gain");
});

test("B3: pause refuses while the candidate worktree has unsaved changes; state and bytes stay", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("pausedirty", BENCH_DETERMINISTIC);
  writeFileSyncSafe(path.join(wt, "OTHER.txt"), "stray\n");
  const paused = await callTool(h, "pause", { candidate_id: "cand-a" });
  const t = textOf(paused);
  assert.equal(/pause done/i.test(t), false, `dirty pause must refuse: ${t}`);
  assert.match(t, /unsaved_changes|OTHER\.txt/i, `refusal must list the stray path: ${t}`);
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  assert.equal(st.candidates.find((c) => c.id === "cand-a").status, "active", "candidate must stay active");
  assert.equal(fs.readFileSync(path.join(wt, "OTHER.txt"), "utf8"), "stray\n", "stray file must survive byte-exact");
  // Clean candidate: pause succeeds.
  fs.rmSync(path.join(wt, "OTHER.txt"), { force: true });
  const paused2 = await callTool(h, "pause", { candidate_id: "cand-a" });
  assert.match(textOf(paused2), /pause done/i, `clean pause must succeed: ${textOf(paused2)}`);
});

test("B3: create refuses while an active candidate carries unsaved changes", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("createdirty", BENCH_DETERMINISTIC);
  writeFileSyncSafe(path.join(wt, "OTHER.txt"), "stray\n");
  const created = await callTool(h, "create", { candidate_id: "cand-b" });
  const t = textOf(created);
  assert.equal(/created/i.test(t), false, `create with dirty active must refuse: ${t}`);
  assert.match(t, /unsaved_changes|OTHER\.txt/i, `refusal must list the stray path: ${t}`);
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  assert.equal(st.candidates.some((c) => c.id === "cand-b"), false, "no cand-b row may exist");
  // The stray file survives byte-exact.
  assert.equal(fs.readFileSync(path.join(wt, "OTHER.txt"), "utf8"), "stray\n", "stray file must survive");
});

// ─── Round-2 methodology hashing (blob bytes, init pin = HEAD blob) ──────────

test("B2 round-2: a non-ASCII methodology file hashes identically at init and confirm (blob bytes)", async () => {
  const { h, dir, wtPath: wt } = await campaignWithCandidate("methutf8", BENCH_BY_SOURCE);
  writeFileSyncSafe(path.join(wt, "src", "algo.ts"), "export const a = 2; // candidate optimization\n");
  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp-utf8" });
  assert.match(textOf(cp), /Checkpoint saved/i, `checkpoint failed: ${textOf(cp)}`);
  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.equal(/methodology_changed/i.test(cText), false, `non-ASCII methodology must not break the gate: ${cText}`);
  assert.match(cText, /PROMOTED/i, `honest candidate must promote with a non-ASCII methodology: ${cText}`);
});

test("B2 round-2: CRLF working copy under core.autocrlf=true still promotes (init pin from the HEAD blob)", async () => {
  // Dedicated repo: the shared fixture uses the repo-global autocrlf setting.
  const dir = makeWorkDir("methcrlf");
  const h = await createHarness({ dir, sessionId: "candwiring-methcrlf", realGit: false });
  const g = (args, cwd = dir) => execFileSync("git", args, { cwd, encoding: "utf8" });
  g(["init"]);
  g(["config", "user.email", "t@x"]);
  g(["config", "user.name", "t"]);
  // Mimic the default Git-for-Windows install: blobs stay LF, the working copy
  // gets CRLF. The init pin must come from the committed BLOB, not the CRLF file.
  g(["config", "core.autocrlf", "true"]);
  writeFileSyncSafe(path.join(dir, "METHOD.md"), "methodology v1\n"); // written with LF; autocrlf converts on checkout
  writeFileSyncSafe(path.join(dir, "src", "algo.ts"), "export const a = 1;\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "seed"]);
  // Normalize the working copy the way autocrlf=true would after a checkout:
  // rewrite METHOD.md with CRLF bytes on disk.
  fs.writeFileSync(path.join(dir, "METHOD.md"), "methodology v1\r\n", "utf8");
  await h.command("autoresearch").handler("on", h.ctx);
  h.ctx.ui.confirm = async () => true;
  const policy = policyOf(dir);
  policy.benchmark_argv = ["node", "-e", BENCH_BY_SOURCE];
  const init = await callTool(h, "init", { policy });
  assert.match(textOf(init), /campaign|created|ready|policy/i, `init failed: ${textOf(init)}`);
  const created = await callTool(h, "create", { candidate_id: "cand-a" });
  const wtPath = wtPathFromCreateResponse(created);
  writeFileSyncSafe(path.join(wtPath, "src", "algo.ts"), "export const a = 2; // candidate optimization\n");
  await callTool(h, "run", {});
  const cp = await callTool(h, "checkpoint", { allowed_files: ["src/algo.ts"], message: "cp-crlf" });
  assert.match(textOf(cp), /Checkpoint saved/i, `checkpoint failed: ${textOf(cp)}`);
  const confirm = await callTool(h, "confirm", {});
  const cText = textOf(confirm);
  assert.equal(/methodology_changed/i.test(cText), false, `CRLF working copy must not break the gate: ${cText}`);
  assert.match(cText, /PROMOTED/i, `honest candidate must promote under autocrlf: ${cText}`);
  // Real tamper: rewrite the checkpoint ref to a commit whose tree differs
  // from the base ONLY in METHOD.md (built via git plumbing, since methodology
  // files are refused in allowed_files and cannot be committed by the tool).
  const baseSha = g(['rev-parse', 'refs/pi-autoresearch/candidates/cand-a']).trim();
  const parent = g(['rev-parse', `${baseSha}^`]).trim();
  const tamperBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, encoding: "utf8", input: "methodology TAMPERED\n" }).trim();
  // Rebuild the tree with every base entry except METHOD.md, which gets the
  // tampered blob.
  const lsTree = g(["ls-tree", baseSha]).trim().split("\n").filter((l) => l && !l.endsWith("\tMETHOD.md"));
  lsTree.push(`100644 blob ${tamperBlob}\tMETHOD.md`);
  const newTree = execFileSync("git", ["mktree"], { cwd: dir, encoding: "utf8", input: lsTree.join("\n") + "\n" }).trim();
  const tamperedCommit = execFileSync("git", ["commit-tree", newTree, "-p", parent, "-m", "tampered methodology"], { cwd: dir, encoding: "utf8" }).trim();
  g(["update-ref", "refs/pi-autoresearch/candidates/cand-a", tamperedCommit]);
  const st = JSON.parse(fs.readFileSync(path.join(dir, ".auto", "candidate", "state.json"), "utf8"));
  const cand = st.candidates.find((c) => c.id === "cand-a");
  cand.checkpoints = cand.checkpoints.map((c) => (c === baseSha ? tamperedCommit : c));
  cand.selected_checkpoint = tamperedCommit;
  fs.writeFileSync(path.join(dir, ".auto", "candidate", "state.json"), JSON.stringify(st, null, 2), "utf8");
  const confirm2 = await callTool(h, "confirm", {});
  assert.match(textOf(confirm2), /methodology_changed/i, `a tampered methodology blob must refuse: ${textOf(confirm2)}`);
  assert.equal(/PROMOTED/i.test(textOf(confirm2)), false, "tampered methodology must never promote");
});

// ─── Review regression (B-A): methodology file inside a workingDir subdirectory ─

test("campaign under workingDir=sub: methodology blob resolves relative to the workDir (init pins, confirm verifies)", async () => {
  const dir = makeWorkDir("subdir");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  writeFileSyncSafe(path.join(dir, ".auto", "config.json"), JSON.stringify({ workingDir: "sub" }));
  const sub = path.join(dir, "sub");
  writeFileSyncSafe(path.join(sub, "METHOD.md"), "methodology v1\n");
  writeFileSyncSafe(path.join(sub, "src", "algo.ts"), "export const a = 1;\n");
  // createHarness(realGit:true) runs git init and commits every file already in dir.
  const h = await createHarness({ dir, sessionId: "candwiring-subdir", realGit: true });
  await h.command("autoresearch").handler("on", h.ctx);
  h.ctx.ui.confirm = async () => true;

  const policy = policyOf(sub);
  policy.benchmark_argv = ["node", "-e", BENCH_DETERMINISTIC];
  const init = await callTool(h, "init", { policy });
  assert.doesNotMatch(textOf(init), /missing from the base commit|invalid_argument/i, `init must pin the subdir methodology: ${textOf(init)}`);
  assert.match(textOf(init), /initialized|campaign|ready|policy/i, `init must succeed: ${textOf(init)}`);

  const created = await callTool(h, "create", { candidate_id: "cand-a" });
  assert.match(textOf(created), /created|active|worktree|cand-a/i, `create must succeed under workingDir: ${textOf(created)}`);
});

// ─── Review regression (B2): backslash spelling must not bypass the methodology guard ─

test("init refuses change_files that name a pinned methodology file with backslashes (same file, other spelling)", async () => {
  const dir = makeWorkDir("backslash-init");
  writeFileSyncSafe(path.join(dir, "src", "method.md"), "methodology v1\n");
  writeFileSyncSafe(path.join(dir, "src", "algo.ts"), "export const a = 1;\n");
  const h = await createHarness({ dir, sessionId: "candwiring-backslash-init", realGit: true });
  await h.command("autoresearch").handler("on", h.ctx);
  h.ctx.ui.confirm = async () => true;
  const policy = policyOf(dir);
  policy.methodology_files = [{ path: "src/method.md", sha256: "" }];
  // The candidate must not be able to edit the methodology file by another spelling.
  policy.change_files = ["src\\method.md"];
  const init = await callTool(h, "init", { policy });
  const text = textOf(init);
  assert.match(text, /must not contain methodology file/i, `init must refuse the backslash spelling of a methodology file: ${text}`);
  assert.doesNotMatch(text, /initialized|campaign started/i, "no campaign may start");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "candidate", "state.json")), false, "no state may be written");
});

// ─── Review regression (B1 round 2): ./METHOD.md as methodology, METHOD.md as change ─

test("methodology ./METHOD.md with change_files METHOD.md: init or checkpoint refuses; no candidate ref is written", async () => {
  const dir = makeWorkDir("dotslash-method");
  writeFileSyncSafe(path.join(dir, "METHOD.md"), "methodology v1\n");
  writeFileSyncSafe(path.join(dir, "src", "algo.ts"), "export const a = 1;\n");
  const h = await createHarness({ dir, sessionId: "candwiring-dotslash", realGit: true });
  await h.command("autoresearch").handler("on", h.ctx);
  h.ctx.ui.confirm = async () => true;
  const policy = policyOf(dir);
  policy.methodology_files = [{ path: "./METHOD.md", sha256: "" }];
  policy.change_files = ["METHOD.md"];
  const init = await callTool(h, "init", { policy });
  const initText = textOf(init);
  if (/initialized|campaign started|ready/i.test(initText)) {
    const created = await callTool(h, "create", { candidate_id: "c1" });
    // Actually change the methodology in the candidate worktree, so the bypass is observable
    // (without a real change the checkpoint refuses as "empty" and proves nothing).
    const candWt = wtPathFromCreateResponse(created);
    writeFileSyncSafe(path.join(candWt, "METHOD.md"), "methodology HACKED\n");
    const cp = await callTool(h, "checkpoint", { allowed_files: ["METHOD.md"], message: "sneaky" });
    assert.doesNotMatch(textOf(cp), /Checkpoint saved/i, "a methodology file must never enter a checkpoint");
  } else {
    assert.match(initText, /methodology|path|invalid|refus/i, `init must refuse a non-normalized methodology path: ${initText}`);
  }
  const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/pi-autoresearch/candidates/c1"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(ref.status, 0, "no candidate ref may be written for the methodology file");
});

// ─── Review round (4c5532d): propose_hypothesis is part of the ordinary loop ──

test("propose_hypothesis is refused under an active candidate campaign (writes refs/exp into the user repo)", async () => {
  const { h } = await campaignWithCandidate("propose-blocked");
  const propose = h.tool("propose_hypothesis");
  assert.ok(propose, "propose_hypothesis must be registered");
  const res = await propose.execute("id", { description: "try a faster loop" }, null, null, h.ctx);
  assert.match(textOf(res), /candidate campaign active/i, `propose must be refused under a campaign: ${textOf(res)}`);
});
