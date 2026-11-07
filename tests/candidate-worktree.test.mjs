/**
 * candidate-worktree (openspec/changes/candidate-branches, task
 * pi-autoresearch-3e4.4.2.1): standalone Git primitives for candidate
 * campaigns — system-owned detached worktrees from an exact full commit,
 * explicit-scope checkpoints with candidate-scoped refs, and the
 * never-touch-the-user's-tree guarantees (design §2 steps 2/4, §4;
 * FR-01, FR-03, FR-05, FR-06, FR-12).
 *
 * All git operations run in throwaway temp repositories; the host repository
 * is never modified. Tests are path-resolution based, so they run unchanged
 * on Windows and Linux. Symlink tests use fs.symlinkSync; on platforms where
 * symlink creation fails (restricted Windows without developer mode), those
 * specific tests skip with an explicit message.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/candidate-worktree.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

import {
  createCandidateWorktree,
  checkpointCandidateWorktree,
  collectWorktreeChanges,
  validateAllowedFilePaths,
  isValidCandidateId,
  candidateRefFor,
  CANDIDATE_REF_PREFIX,
} from "../extensions/pi-autoresearch/candidate-worktree.ts";

// ─── Node exec implementation of ExecFn (no shell) ──────────────────────────

function nodeExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr, code: 124, killed: true });
    }, opts.timeout ?? 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: 127 });
    });
  });
}
const exec = nodeExec;

// ─── Temp repo helpers ──────────────────────────────────────────────────────

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-ar-cwt-${label}-`));
}

function gitSync(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
}

/** Init a repo with local identity and host-independent settings. */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  gitSync(["init", "-q"], dir);
  gitSync(["config", "user.email", "test@test.com"], dir);
  gitSync(["config", "user.name", "Test"], dir);
  gitSync(["config", "core.autocrlf", "false"], dir);
  gitSync(["config", "commit.gpgsign", "false"], dir);
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readBytes(p) {
  return fs.readFileSync(p);
}

/** Repo-relative byte snapshot (skips .git), used for byte-identity checks. */
function snapshotDir(root) {
  const out = {};
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else if (e.isFile() || e.isSymbolicLink()) out[relPath] = readBytes(abs);
    }
  };
  walk(root, "");
  return out;
}

/** Index state (mode, sha, stage per path) — must stay unchanged on refusals. */
function indexSnapshot(repo) {
  const out = {};
  for (const line of gitSync(["ls-files", "-s"], repo).split("\n")) {
    if (line.trim().length === 0) continue;
    const [meta, p] = line.split("\t");
    out[p] = meta.trim();
  }
  return out;
}

/** Base repo with a committed tree: main.txt, src/algo.ts, docs/methodology.md. */
function makeBaseRepo(label) {
  const repo = makeTempDir(label);
  initRepo(repo);
  writeFile(path.join(repo, "main.txt"), "main\n");
  writeFile(path.join(repo, "src", "algo.ts"), "export const a = 1;\n");
  writeFile(path.join(repo, "docs", "methodology.md"), "# methodology\n");
  gitSync(["add", "main.txt", "src/algo.ts", "docs/methodology.md"], repo);
  gitSync(["commit", "-q", "-m", "init"], repo);
  const commit = gitSync(["rev-parse", "HEAD"], repo).trim();
  return { repo, commit };
}

/** Make the repo dirty: one staged, one unstaged, two untracked changes. */
function makeDirty(repo) {
  writeFile(path.join(repo, "main.txt"), "main CHANGED staged\n");
  gitSync(["add", "main.txt"], repo);
  writeFile(path.join(repo, "src", "algo.ts"), "export const a = 2;\n");
  writeFile(path.join(repo, "untracked.txt"), "brand new\n");
  writeFile(path.join(repo, "sub", "dir", "nested.txt"), "nested untracked\n");
}

const canSymlink = (() => {
  try {
    const dir = makeTempDir("slprobe");
    fs.symlinkSync("target", path.join(dir, "link"), "file");
    return fs.lstatSync(path.join(dir, "link")).isSymbolicLink();
  } catch {
    return false;
  }
})();

function symlinkSkipReason() {
  return `platform cannot create symlinks (Windows without symlink privilege); symlink guarantee is enforced by lstat checks and covered on capable platforms`;
}

// ─── Shared fixtures ────────────────────────────────────────────────────────

/** Campaign repo + one created candidate worktree at a path outside the repo. */
async function makeCampaignWithWorktree(label) {
  const { repo, commit } = makeBaseRepo(label);
  const wtPath = path.join(makeTempDir(`${label}-wt`), "wt");
  const created = await createCandidateWorktree(exec, {
    repoRoot: repo,
    baseCommit: commit,
    worktreePath: wtPath,
    candidateId: "c1",
  });
  assert.equal(created.ok, true, `fixture worktree creation failed: ${created.ok ? "" : created.reason}`);
  return { repo, commit, wtPath, handle: created.handle };
}

// ═══ validateAllowedFilePaths / candidate ids ═══════════════════════════════

test("validateAllowedFilePaths accepts relative paths and normalizes backslashes", () => {
  const r = validateAllowedFilePaths(["src/a.ts", "src\\b.ts", "plain.txt"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.normalized, ["src/a.ts", "src/b.ts", "plain.txt"]);
});

test("validateAllowedFilePaths rejects traversal, absolute, .git, dup, junk", () => {
  const bad = [
    ["traversal", "../outside.txt"],
    ["nested traversal", "a/../../b.txt"],
    ["absolute posix", "/abs/path.txt"],
    ["absolute win", "C:\\x.txt"],
    ["git dir", ".git/config"],
    ["empty component", "a//b.txt"],
    ["trailing slash", "dir/"],
    ["duplicate", null], // handled below with a two-element list
    ["non-string", 42],
    ["empty string", ""],
    ["control chars", "a\nb.txt"],
  ];
  for (const [label, p] of bad) {
    const input = p === null ? ["a.txt", "a.txt"] : [p];
    const r = validateAllowedFilePaths(input);
    assert.equal(r.ok, false, `expected rejection: ${label}`);
    assert.ok(r.errors.length > 0, `expected errors: ${label}`);
  }
  assert.equal(validateAllowedFilePaths([]).ok, false, "empty list rejected");
});

test("isValidCandidateId accepts plain ids and rejects namespace escapes", () => {
  for (const good of ["cand-1", "cand_2", "C.3", "a".repeat(100)]) {
    assert.equal(isValidCandidateId(good), true, `accept ${good}`);
  }
  for (const badId of [".hidden", "a/b", "a..b", "end.", "x.lock", 42, "", null, "..", "-x"]) {
    assert.equal(isValidCandidateId(badId), false, `reject ${JSON.stringify(badId)}`);
  }
  assert.equal(candidateRefFor("c1"), `${CANDIDATE_REF_PREFIX}c1`);
  assert.equal(CANDIDATE_REF_PREFIX, "refs/pi-autoresearch/candidates/");
});

// ═══ createCandidateWorktree ════════════════════════════════════════════════

test("create: makes a detached worktree at the exact full commit", async () => {
  const { repo, commit } = makeBaseRepo("create");
  const wtPath = path.join(makeTempDir("create-wt"), "wt");
  const r = await createCandidateWorktree(exec, {
    repoRoot: repo,
    baseCommit: commit,
    worktreePath: wtPath,
    candidateId: "c1",
  });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.handle.baseCommit, commit);
  assert.equal(path.resolve(r.handle.path), path.resolve(wtPath));

  // Detached HEAD exactly at the base commit.
  const head = gitSync(["rev-parse", "HEAD"], wtPath).trim();
  assert.equal(head, commit);
  // Files materialized from the commit.
  assert.equal(fs.readFileSync(path.join(wtPath, "main.txt"), "utf8"), "main\n");
  // No branch checkout: HEAD is detached (symbolic-ref fails).
  let detached = false;
  try {
    gitSync(["symbolic-ref", "--quiet", "HEAD"], wtPath);
  } catch {
    detached = true;
  }
  assert.equal(detached, true, "HEAD must be detached in the candidate worktree");
});

test("create: two worktrees from the same commit coexist", async () => {
  const { repo, commit } = makeBaseRepo("two");
  const wtA = path.join(makeTempDir("two-wt-a"), "wt-a");
  const wtB = path.join(makeTempDir("two-wt-b"), "wt-b");
  const ra = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: wtA, candidateId: "ca" });
  const rb = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: wtB, candidateId: "cb" });
  assert.equal(ra.ok, true, ra.reason ?? "");
  assert.equal(rb.ok, true, rb.reason ?? "");
  assert.equal(gitSync(["rev-parse", "HEAD"], wtA).trim(), commit);
  assert.equal(gitSync(["rev-parse", "HEAD"], wtB).trim(), commit);
});

test("create: dirty original is untouched by worktree creation", async () => {
  const { repo, commit } = makeBaseRepo("dirty-create");
  makeDirty(repo);
  const beforeFiles = snapshotDir(repo);
  const beforeIndex = indexSnapshot(repo);

  const wtPath = path.join(makeTempDir("dirty-create-wt"), "wt");
  const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: wtPath, candidateId: "c1" });
  assert.equal(r.ok, true, r.reason ?? "");

  // Original files byte-identical, index identical, still dirty in the same way.
  assert.deepEqual(snapshotDir(repo), beforeFiles);
  assert.deepEqual(indexSnapshot(repo), beforeIndex);
  const changes = await collectWorktreeChanges(exec, repo);
  assert.equal(changes.ok, true);
  assert.deepEqual(changes.changes.staged.sort(), ["main.txt"]);
  assert.deepEqual(changes.changes.unstaged.sort(), ["src/algo.ts"]);
  assert.deepEqual(changes.changes.untracked.sort(), ["sub/dir/nested.txt", "untracked.txt"]);
});

test("create: refuses an existing path (empty dir, file, symlink)", async () => {
  const { repo, commit } = makeBaseRepo("occupied");
  const holder = makeTempDir("occupied-holder");

  // existing empty directory
  const dirPath = path.join(holder, "taken-dir");
  fs.mkdirSync(dirPath);
  const r1 = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: dirPath, candidateId: "c1" });
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, "path-exists");
  assert.match(r1.reason, /already exists/);

  // existing file
  const filePath = path.join(holder, "taken-file");
  fs.writeFileSync(filePath, "x");
  const r2 = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: filePath, candidateId: "c1" });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "path-exists");

  // holder contents unchanged (nothing was removed or replaced)
  assert.deepEqual(fs.readdirSync(holder).sort(), ["taken-dir", "taken-file"]);
  assert.equal(fs.readFileSync(filePath, "utf8"), "x");
});

test("create: refuses abbreviated and unknown commits", async () => {
  const { repo, commit } = makeBaseRepo("abbrev");
  const holder = makeTempDir("abbrev-wt");
  const shortSha = commit.slice(0, 7);
  const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: shortSha, worktreePath: path.join(holder, "wt"), candidateId: "c1" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "commit");
  assert.match(r.reason, /FULL 40-hex/);

  const bogus = "0".repeat(39) + "1";
  const r2 = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: bogus, worktreePath: path.join(holder, "wt2"), candidateId: "c1" });
  assert.equal(r2.ok, false);
  assert.ok(r2.stage === "commit" || r2.stage === "validate");
  assert.match(r2.reason, /does not name an existing commit|not a git|full/i);
});

test("create: refuses a non-repository repoRoot and bad candidate ids", async () => {
  const plain = makeTempDir("norepo");
  const r = await createCandidateWorktree(exec, { repoRoot: plain, baseCommit: "a".repeat(40), worktreePath: path.join(makeTempDir("norepo-wt"), "wt"), candidateId: "c1" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "validate");
  assert.match(r.reason, /not a git repository/);

  const { repo, commit } = makeBaseRepo("badid");
  const r2 = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: path.join(makeTempDir("badid-wt"), "wt"), candidateId: "../escape" });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "validate");
  assert.match(r2.reason, /invalid candidateId/);
});

test("create: failure leaves no directory behind at the target path", async () => {
  const { repo } = makeBaseRepo("noleftovers");
  const target = path.join(makeTempDir("noleftovers-wt"), "wt");
  const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: "b".repeat(40), worktreePath: target, candidateId: "c1" });
  assert.equal(r.ok, false);
  let exists = true;
  try {
    fs.lstatSync(target);
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "failed creation must not leave a directory at the target");
});

// ═══ dirty-tree preservation across checkpoint refusals (FR-05) ═════════════

test("checkpoint: refuses unaccounted staged/unstaged/untracked, preserves them byte-exact", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("guard");

  // Candidate worktree gets allowed + forbidden changes.
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 42;\n"); // allowed, unstaged
  writeFile(path.join(wtPath, "main.txt"), "main edited\n"); // NOT allowed, unstaged
  writeFile(path.join(wtPath, "extra.txt"), "surprise\n"); // NOT allowed, untracked
  gitSync(["add", "extra.txt"], wtPath); // NOT allowed, staged

  const beforeFiles = snapshotDir(wtPath);
  const beforeIndex = indexSnapshot(wtPath);

  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "checkpoint 1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "outside-allowed");
  assert.ok(r.blockingPaths.includes("staged:extra.txt"), `got: ${r.blockingPaths.join(", ")}`);
  assert.ok(r.blockingPaths.includes("unstaged:main.txt"), `got: ${r.blockingPaths.join(", ")}`);
  assert.equal(r.blockingPaths.length, 2);

  // Nothing changed: files byte-identical, index identical.
  assert.deepEqual(snapshotDir(wtPath), beforeFiles);
  assert.deepEqual(indexSnapshot(wtPath), beforeIndex);
  // No ref was written.
  let refMissing = false;
  try {
    gitSync(["rev-parse", "--verify", "--quiet", candidateRefFor("c1")], repo);
  } catch {
    refMissing = true;
  }
  assert.equal(refMissing, true, "no candidate ref may be written on refusal");
});

test("checkpoint: dirty ORIGINAL repo keeps staged/unstaged/untracked byte-exact and index unchanged", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("orig-dirty");
  makeDirty(repo);
  const beforeFiles = snapshotDir(repo);
  const beforeIndex = indexSnapshot(repo);

  // A clean, fully-allowed checkpoint in the candidate worktree.
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 7;\n");
  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "checkpoint while original dirty",
  });
  assert.equal(r.ok, true, r.reason ?? "");

  // The original repo is untouched.
  assert.deepEqual(snapshotDir(repo), beforeFiles);
  assert.deepEqual(indexSnapshot(repo), beforeIndex);
  const changes = await collectWorktreeChanges(exec, repo);
  assert.equal(changes.ok, true);
  assert.deepEqual(changes.changes.staged.sort(), ["main.txt"]);
  assert.deepEqual(changes.changes.unstaged.sort(), ["src/algo.ts"]);
  assert.deepEqual(changes.changes.untracked.sort(), ["sub/dir/nested.txt", "untracked.txt"]);
  // And its HEAD is unchanged.
  assert.equal(gitSync(["rev-parse", "HEAD"], repo).trim(), commit);
});

// ═══ checkpoint happy paths ═════════════════════════════════════════════════

test("checkpoint: commits exactly the allowed files and sets the candidate ref", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("happy");

  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 42;\n");

  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "checkpoint good",
  });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.ref, "refs/pi-autoresearch/candidates/c1");
  assert.equal(gitSync(["rev-parse", r.ref], repo).trim(), r.commit);

  // Parent is the base commit; only the allowed file changed in the checkpoint.
  assert.equal(gitSync(["rev-parse", `${r.commit}^`], repo).trim(), commit);
  const touched = gitSync(["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", r.commit], repo).split("\n").filter(Boolean);
  assert.deepEqual(touched, ["src/algo.ts"]);

  // A non-allowed untracked file blocks any checkpoint; keep it for a separate
  // refusal test below. Here the tree is clean after the checkpoint.
  const after = await collectWorktreeChanges(exec, wtPath);
  assert.equal(after.ok, true);
  assert.deepEqual(after.changes.all, []);
});

// Separate assertion of the "untracked file stays untracked" guarantee:
test("checkpoint: non-allowed untracked file survives a refused checkpoint untouched", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("untracked-survives");
  writeFile(path.join(wtPath, "untracked.txt"), "not allowed\n");
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 42;\n");

  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "blocked" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "outside-allowed");
  assert.deepEqual(r.blockingPaths, ["untracked:untracked.txt"]);
  assert.equal(fs.readFileSync(path.join(wtPath, "untracked.txt"), "utf8"), "not allowed\n");
  const changes = await collectWorktreeChanges(exec, wtPath);
  assert.deepEqual(changes.changes.untracked, ["untracked.txt"]);
});

test("checkpoint: REGRESSION checkpoint is stored and selectable; leader untouched", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("regress");

  // First (better) checkpoint.
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 99;\n");
  const r1 = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "better" });
  assert.equal(r1.ok, true, r1.reason ?? "");
  const goodCommit = r1.commit;

  // Second checkpoint is a REGRESSION (worse content) — must still be stored.
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 1;\n");
  const r2 = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "regression checkpoint" });
  assert.equal(r2.ok, true, r2.reason ?? "");
  assert.notEqual(r2.commit, goodCommit);
  assert.equal(gitSync(["rev-parse", candidateRefFor("c1")], repo).trim(), r2.commit);

  // The regression checkpoint content is recoverable from the ref.
  const content = gitSync(["show", `${candidateRefFor("c1")}:src/algo.ts`], repo).trim();
  assert.equal(content, "export const a = 1;");

  // Both checkpoint commits remain reachable; the campaign base commit and
  // the user's branch are untouched.
  assert.equal(gitSync(["rev-parse", "HEAD"], repo).trim(), commit);
  const branch = gitSync(["symbolic-ref", "--short", "HEAD"], repo).trim();
  assert.equal(gitSync(["rev-parse", branch], repo).trim(), commit);
  // First checkpoint still resolvable (not garbage-collected, still a commit).
  assert.equal(gitSync(["cat-file", "-t", goodCommit], repo).trim(), "commit");
});

test("checkpoint: two candidates each get their own ref", async () => {
  const { repo, commit } = makeBaseRepo("twocand");
  const wtA = path.join(makeTempDir("twocand-wt-a"), "wt-a");
  const wtB = path.join(makeTempDir("twocand-wt-b"), "wt-b");
  await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: wtA, candidateId: "ca" });
  await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: wtB, candidateId: "cb" });

  writeFile(path.join(wtA, "src", "algo.ts"), "export const a = 10;\n");
  writeFile(path.join(wtB, "src", "algo.ts"), "export const a = 20;\n");

  const ra = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtA, candidateId: "ca", allowedFiles: ["src/algo.ts"], message: "A" });
  const rb = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtB, candidateId: "cb", allowedFiles: ["src/algo.ts"], message: "B" });
  assert.equal(ra.ok, true, ra.reason ?? "");
  assert.equal(rb.ok, true, rb.reason ?? "");
  assert.notEqual(ra.commit, rb.commit);
  assert.equal(gitSync(["rev-parse", candidateRefFor("ca")], repo).trim(), ra.commit);
  assert.equal(gitSync(["rev-parse", candidateRefFor("cb")], repo).trim(), rb.commit);
  assert.equal(gitSync(["show", `${candidateRefFor("ca")}:src/algo.ts`], repo).trim(), "export const a = 10;");
  assert.equal(gitSync(["show", `${candidateRefFor("cb")}:src/algo.ts`], repo).trim(), "export const a = 20;");
});

test("checkpoint: multiple allowed files in subdirectories commit together", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("multi");
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 5;\n");
  writeFile(path.join(wtPath, "src", "util.ts"), "export const u = 1;\n");
  gitSync(["add", "src/util.ts"], wtPath); // staged allowed file also commits

  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts", "src/util.ts"], message: "multi" });
  assert.equal(r.ok, true, r.reason ?? "");
  const touched = gitSync(["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", r.commit], repo).split("\n").filter(Boolean).sort();
  assert.deepEqual(touched, ["src/algo.ts", "src/util.ts"]);
});

test("checkpoint: deletion of an allowed tracked file commits as a deletion", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("delete");
  fs.rmSync(path.join(wtPath, "src", "algo.ts"));
  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "remove algo" });
  assert.equal(r.ok, true, r.reason ?? "");
  const touched = gitSync(["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", r.commit], repo).split("\n").filter(Boolean);
  assert.deepEqual(touched, ["src/algo.ts"]);
});

test("checkpoint: empty (no changes in allowed files) is refused without writing refs", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("empty");
  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "empty" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "empty");
  let refMissing = false;
  try {
    gitSync(["rev-parse", "--verify", "--quiet", candidateRefFor("c1")], repo);
  } catch {
    refMissing = true;
  }
  assert.equal(refMissing, true);
});

// ═══ checkpoint guards: identity, traversal, symlinks ═══════════════════════

test("checkpoint: refuses to run in the USER'S main working tree", async () => {
  const { repo, commit } = makeBaseRepo("main-tree");
  writeFile(path.join(repo, "src", "algo.ts"), "export const a = 3;\n");
  const beforeFiles = snapshotDir(repo);
  const beforeIndex = indexSnapshot(repo);

  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: repo, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "sneaky" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "guard");
  assert.match(r.reason, /main working tree/);
  assert.deepEqual(snapshotDir(repo), beforeFiles);
  assert.deepEqual(indexSnapshot(repo), beforeIndex);
});

test("checkpoint: refuses a worktree of a different repository", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("crossrepo");
  const other = makeBaseRepo("otherrepo");

  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 8;\n");
  const r = await checkpointCandidateWorktree(exec, { repoRoot: other.repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "cross" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "guard");
  assert.match(r.reason, /different repository/);
});

test("checkpoint: validation rejects traversal/absolute/.git/dup allowed files before git runs", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("ckpt-validate");
  for (const bad of [["../x.txt"], ["/abs.txt"], ["a/../../b"], [".git/config"], ["a.txt", "a.txt"], []]) {
    const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: bad, message: "m" });
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(r.stage, "validate");
  }
  const r2 = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "../bad", allowedFiles: ["src/algo.ts"], message: "m" });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "validate");
  assert.match(r2.reason, /invalid candidateId/);
  const r3 = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "  " });
  assert.equal(r3.ok, false);
  assert.equal(r3.stage, "validate");
});

test("checkpoint: missing non-tracked allowed file is refused", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("missing");
  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/never-created.ts"], message: "m" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "allowed-files");
  assert.match(r.reason, /does not exist/);
});

// Windows variant: `..` inside a path cannot traverse because of validation,
// but verify the guard also rejects a pre-existing outside symlink when the
// platform allows symlinks at all.
if (canSymlink) {
  test("checkpoint: symlinked allowed file is refused (FR-12)", async () => {
    const { repo, commit, wtPath } = await makeCampaignWithWorktree("symlink-file");
    // A symlink inside the worktree pointing OUTSIDE it (to the original repo).
    const outsideTarget = path.join(repo, "secret.txt");
    fs.writeFileSync(outsideTarget, "outside\n");
    fs.symlinkSync(outsideTarget, path.join(wtPath, "algo-link.ts"), "file");

    const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["algo-link.ts"], message: "sneaky symlink" });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "allowed-files");
    assert.match(r.reason, /symbolic link/);
    // Nothing committed.
    assert.equal(gitSync(["rev-parse", "HEAD"], wtPath).trim(), commit);
  });

  test("checkpoint: allowed path through a symlinked directory is refused", async () => {
    const { repo, commit, wtPath } = await makeCampaignWithWorktree("symlink-dir");
    // `src-link` points outside; allowed file "src-link/algo.ts" must be refused.
    fs.rmSync(path.join(wtPath, "src"), { recursive: true, force: true });
    fs.symlinkSync(path.join(repo, "src"), path.join(wtPath, "src"), "dir");

    const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts"], message: "sneaky dir link" });
    // The symlinked directory itself shows up as an untracked "outside" path
    // and/or trips the symlink lstat guard — both are valid fail-closed refusals.
    assert.equal(r.ok, false);
    assert.ok(r.stage === "outside-allowed" || r.stage === "allowed-files", `stage: ${r.stage}`);
    assert.match(r.reason, /outside the allowed file set|symbolic link/);
    assert.equal(gitSync(["rev-parse", "HEAD"], wtPath).trim(), commit);
  });

  test("create: refuses a symlink occupying the target path", async () => {
    const { repo, commit } = makeBaseRepo("symlink-target");
    const holder = makeTempDir("symlink-target-holder");
    const linkPath = path.join(holder, "wt");
    fs.symlinkSync(repo, linkPath, "dir");
    const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: linkPath, candidateId: "c1" });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "path-exists");
    // The symlink itself still resolves to the original repo — untouched.
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(repo));
  });
} else {
  test("symlink tests skipped: platform cannot create symlinks", () => {
    assert.ok(true, symlinkSkipReason());
  });
}

test("create: refuses a target path inside the source worktree directory tree", async () => {
  const { repo, commit } = makeBaseRepo("inside");
  const innerTarget = path.join(repo, "candidate-wt");
  const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: innerTarget, candidateId: "c1" });
  // The path does not exist yet, so git itself will create it there; the module
  // documents (and here we verify) that the target must be outside the source
  // tree — enforced by refusing to proceed when the target resolves under the
  // source toplevel.
  assert.equal(r.ok, false, "creating a candidate worktree inside the user's tree must be refused");
  let exists = true;
  try {
    fs.lstatSync(innerTarget);
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "no directory may be left in the user's tree");
});

if (canSymlink) {
  test("create: refuses a target through a symlinked ancestor that resolves into the source tree", async () => {
    const { repo, commit } = makeBaseRepo("symlink-inside");
    // holder/<link> -> <repo>/landing; the requested target goes THROUGH the link.
    const holder = makeTempDir("symlink-holder");
    const landing = path.join(repo, "landing");
    fs.mkdirSync(landing);
    fs.symlinkSync(landing, path.join(holder, "link"), "dir");
    const target = path.join(holder, "link", "wt");

    const beforeWtList = gitSync(["worktree", "list", "--porcelain"], repo).trim();
    const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: target, candidateId: "c1" });
    assert.equal(r.ok, false, "a target resolving through a symlink into the user's tree must be refused");
    assert.equal(r.stage, "validate");
    assert.match(r.reason, /symlink/i);

    // The user's tree must be untouched: no new worktree registration, no new
    // untracked entries beyond the fixture's own landing dir.
    const afterWtList = gitSync(["worktree", "list", "--porcelain"], repo).trim();
    assert.equal(afterWtList, beforeWtList, "git worktree list must not gain an entry inside the user's repo");
    const status = gitSync(["status", "--porcelain", "--untracked-files=all"], repo);
    assert.equal(status.includes("landing/wt"), false, "no worktree pointer may appear inside the user's tree");
    assert.equal(fs.existsSync(target), false, "the target must not be created");
    // The link itself must survive untouched (nothing removed or replaced).
    assert.equal(fs.lstatSync(path.join(holder, "link")).isSymbolicLink(), true);
  });

  test("create: equal resolved path (target resolving exactly to the source toplevel) is refused", async () => {
    const { repo, commit } = makeBaseRepo("symlink-equal");
    const holder = makeTempDir("symlink-equal-holder");
    fs.symlinkSync(repo, path.join(holder, "repo-link"), "dir");
    const target = path.join(holder, "repo-link", "nowhere");
    const r = await createCandidateWorktree(exec, { repoRoot: repo, baseCommit: commit, worktreePath: target, candidateId: "c1" });
    assert.equal(r.ok, false, "a target resolving exactly into the source toplevel must be refused");
  });
}

// Windows: an 8.3 short-name alias (VERYLO~1) bypasses the JS fs.realpathSync
// (which returns the alias verbatim) but is expanded by fs.realpathSync.native.
// Without .native, a caller-supplied alias path would create a worktree INSIDE
// the user's source tree. Regression for review finding B-NEW-1.
test("create: refuses a target through a Windows 8.3 short-name alias resolving into the source tree", async (t) => {
  const { repo, commit } = makeBaseRepo("short83");
  const holder = makeTempDir("short83-holder");
  const longName = "verylongdirectoryname_for_83_alias_probe";
  const longDir = path.join(holder, longName);
  fs.mkdirSync(longDir, { recursive: true });

  // Discover the volume's 8.3 alias for longDir via cmd /c dir /x.
  let short = null;
  try {
    const out = execFileSync("cmd", ["/c", "dir", "/x", "/ad", "/-c", holder], { encoding: "utf8", windowsHide: true });
    const line = out.split("\n").find((l) => l.includes(longName));
    if (line) {
      const alias = line.trim().split(/\s+/).find((t) => /~\d/.test(t));
      if (alias) short = alias;
    }
  } catch {}
  if (!short) {
    // Volumes with 8.3 generation disabled: real skip, not a silent pass.
    t.skip("no 8.3 short-name alias on this volume; containment via .native realpath is exercised by symlink/junction tests");
    return;
  }

  const inner = path.join(longDir, "repo83");
  fs.mkdirSync(inner, { recursive: true });
  gitSync(["init", "-q"], inner);
  gitSync(["config", "user.email", "t@x"], inner);
  gitSync(["config", "user.name", "t"], inner);
  fs.writeFileSync(path.join(inner, "seed.txt"), "s\n");
  gitSync(["add", "seed.txt"], inner);
  gitSync(["commit", "-q", "-m", "seed"], inner);
  const sha = gitSync(["rev-parse", "HEAD"], inner).trim();

  const target2 = path.join(holder, short, "repo83", "landing", "wt");
  const beforeWtList = gitSync(["worktree", "list", "--porcelain"], inner).trim();
  const r = await createCandidateWorktree(exec, { repoRoot: inner, baseCommit: sha, worktreePath: target2, candidateId: "c83" });
  assert.equal(r.ok, false, "a target through an 8.3 alias into the source tree must be refused");
  assert.equal(r.stage, "validate");
  assert.match(r.reason, /symlinked ancestor|inside/i);

  const afterWtList = gitSync(["worktree", "list", "--porcelain"], inner).trim();
  assert.equal(afterWtList, beforeWtList, "worktree list must not gain an entry inside the user's repo");
  assert.equal(fs.existsSync(path.join(inner, "landing")), false, "no landing directory may be created in the user's repo");
  const status = gitSync(["status", "--porcelain", "--untracked-files=all"], inner);
  assert.equal(status.trim(), "", "user's repo status must stay clean");
  // Temp dirs under os.tmpdir() are intentionally left for inspection on failure;
  // the repo test harness has no auto-cleanup hook (see makeTempDir above).
});

// ═══ collectWorktreeChanges unit checks ═════════════════════════════════════

test("collect: classifies staged/unstaged/untracked; clean tree yields empty", async () => {
  const { repo } = makeBaseRepo("collect");
  const clean = await collectWorktreeChanges(exec, repo);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.changes.all, []);

  makeDirty(repo);
  const dirty = await collectWorktreeChanges(exec, repo);
  assert.equal(dirty.ok, true);
  assert.deepEqual(dirty.changes.staged.sort(), ["main.txt"]);
  assert.deepEqual(dirty.changes.unstaged.sort(), ["src/algo.ts"]);
  assert.deepEqual(dirty.changes.untracked.sort(), ["sub/dir/nested.txt", "untracked.txt"]);
  assert.deepEqual(dirty.changes.all.sort(), ["main.txt", "src/algo.ts", "sub/dir/nested.txt", "untracked.txt"]);
});

test("collect: renamed tracked file reports both paths as changed", async () => {
  const { repo } = makeBaseRepo("rename");
  gitSync(["mv", "main.txt", "renamed.txt"], repo);
  const r = await collectWorktreeChanges(exec, repo);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes.staged.sort(), ["main.txt", "renamed.txt"]);
  assert.deepEqual(r.changes.all.sort(), ["main.txt", "renamed.txt"]);
});

test("collect: non-git directory fails with ok:false", async () => {
  const plain = makeTempDir("collect-plain");
  const r = await collectWorktreeChanges(exec, plain);
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

// ═══ ignored files do not block (documented restriction) ════════════════════

test("ignored files do not block a checkpoint", async () => {
  const { repo, wtPath } = await makeCampaignWithWorktree("ignored");
  fs.writeFileSync(path.join(wtPath, ".gitignore"), "scratch.log\n");
  gitSync(["add", ".gitignore"], wtPath);
  writeFile(path.join(wtPath, "scratch.log"), "noise\n");
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 6;\n");

  const r = await checkpointCandidateWorktree(exec, { repoRoot: repo, worktreePath: wtPath, candidateId: "c1", allowedFiles: ["src/algo.ts", ".gitignore"], message: "with ignored" });
  assert.equal(r.ok, true, r.reason ?? "");
});

// ═══ committedScope: commits the agent made itself inside the candidate worktree ═══

test("checkpoint refuses when the candidate's own commit touched a path outside the campaign scope", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("committed-scope");
  // The agent commits an out-of-scope file itself (invisible to the status check).
  writeFile(path.join(wtPath, "src", "other.ts"), "o-OUT-OF-SCOPE\n");
  gitSync(["add", "--", "src/other.ts"], wtPath);
  gitSync(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "agent"], wtPath);
  // Then a legitimate in-scope edit.
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 2;\n");
  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "scoped",
    committedScope: { baseRef: commit, scope: ["src/algo.ts"] },
  });
  assert.equal(r.ok, false, "a committed out-of-scope path must block the checkpoint");
  assert.equal(r.stage, "outside-allowed");
  assert.match(r.reason, /committed in the candidate worktree/i);
  const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/pi-autoresearch/candidates/c1"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(ref.status, 0, "no candidate ref may be written");
});

test("checkpoint refuses when the candidate's own commit renames a methodology file into scope", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("committed-rename");
  // docs/methodology.md is tracked at the base commit; the candidate renames it into an allowed path.
  gitSync(["mv", "docs/methodology.md", "src/moved.md"], wtPath);
  gitSync(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "rename-into-scope"], wtPath);
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 5;\n");
  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "rename probe",
    committedScope: { baseRef: commit, scope: ["src/algo.ts", "src/moved.md"] },
  });
  assert.equal(r.ok, false, "a rename that removes a methodology path must block the checkpoint");
  assert.equal(r.stage, "outside-allowed");
  assert.match(r.reason, /committed in the candidate worktree/i);
  const ref = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/pi-autoresearch/candidates/c1"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(ref.status, 0, "no candidate ref may be written");
});


test("checkpoint accepts a candidate commit whose paths are all inside the campaign scope", async () => {
  const { repo, commit, wtPath } = await makeCampaignWithWorktree("committed-scope-ok");
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 3;\n");
  gitSync(["add", "--", "src/algo.ts"], wtPath);
  gitSync(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "agent-in-scope"], wtPath);
  writeFile(path.join(wtPath, "src", "algo.ts"), "export const a = 4;\n");
  const r = await checkpointCandidateWorktree(exec, {
    repoRoot: repo,
    worktreePath: wtPath,
    candidateId: "c1",
    allowedFiles: ["src/algo.ts"],
    message: "scoped ok",
    committedScope: { baseRef: commit, scope: ["src/algo.ts"] },
  });
  assert.equal(r.ok, true, `in-scope committed history must pass: ${r.ok ? "" : r.reason}`);
});
