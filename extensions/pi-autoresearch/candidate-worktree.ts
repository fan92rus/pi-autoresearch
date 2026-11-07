/**
 * candidate-worktree.ts — standalone Git primitives for candidate-branch
 * campaigns (openspec/changes/candidate-branches, design §2 steps 2/4 and §4;
 * epic pi-autoresearch-3e4.4.2, task pi-autoresearch-3e4.4.2.1).
 *
 * Scope of THIS module (deliberately narrow):
 *   - createCandidateWorktree: create a system-owned, DETACHED worktree of the
 *     campaign repository from a given FULL commit sha. The source worktree is
 *     never deleted, never reset, never cleaned, never checked out; nothing is
 *     written into it (no .gitignore edits — unlike parallel/worktree.ts,
 *     whose provisionWorktree rm's the target dir and writes .gitignore and is
 *     therefore unusable here).
 *   - checkpointCandidateWorktree: commit EXACTLY the explicitly allowed files
 *     inside the candidate worktree and point a candidate-scoped ref
 *     (refs/pi-autoresearch/candidates/<candidateId>) at the checkpoint
 *     commit. Unaccounted staged/unstaged/untracked changes (anything outside
 *     the allowed set) block the checkpoint with the offending paths listed;
 *     nothing is discarded or reverted on refusal — the changes stay in the
 *     worktree exactly as they were. Symlinks and path-traversal paths are
 *     never included. The campaign leader ref and the user's branches are
 *     never touched: this module writes exactly one ref, the candidate one.
 *   - collectWorktreeChanges: read-only classification of staged / unstaged /
 *     untracked / unmerged paths, used by the checkpoint guard and available
 *     to later campaign-level checks (FR-05).
 *
 * Out of scope (later integration tasks — nothing here is provided):
 *   - campaign state, locks, candidate registration (design §2/§4 state layer),
 *   - leader ref advancement (design §2 step 6, compare-and-swap task),
 *   - any worktree DELETION: there is intentionally no remove/cleanup API and
 *     no automatic deletion anywhere ("Никакого автоматического удаления
 *     worktree в MVP", design §4). Operators close candidates manually.
 *   - transactional crash journal (dropped by owner decision, design rev.5).
 *
 * Failure posture is fail-closed: every refusal returns ok:false with a
 * single-line reason and leaves the filesystem and git metadata unchanged
 * except where explicitly documented (see the staged-state note inside
 * checkpointCandidateWorktree for the tiny status→add race window).
 *
 * All git access goes through the injected ExecFn (same shape as
 * parallel/worktree.ts, imported type-only — no runtime dependency). The
 * module never spawns processes itself and never runs a shell.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExecFn } from "./parallel/worktree.ts";

// ─── Exec helper ─────────────────────────────────────────────────────────────

/** Run git via the injected exec; throw a single-line error on non-zero exit. */
async function git(
  exec: ExecFn,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  const res = await exec("git", args, { timeout: 15000, ...opts });
  if (res.code !== 0) {
    const detail = `${res.stdout}\n${res.stderr}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    throw new Error(`git ${args.join(" ")} failed (exit ${res.code}): ${detail}`);
  }
  return res.stdout;
}

/** Normalize an exec failure into a single-line reason. */
function gitReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Case/platform-tolerant absolute-path equality. Windows paths are
 * case-insensitive and git prints forward slashes, so everything is resolved,
 * backslash-normalized and (on win32) lowercased before comparison.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p.trim()).replace(/\\/g, "/");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * True when `child` equals or lies inside `parent` (after normalization).
 * Used to keep candidate worktrees OUT of the source tree.
 */
function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p.trim()).replace(/\\/g, "/");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const pa = norm(parent);
  return c === pa || c.startsWith(pa.endsWith("/") ? pa : pa + "/");
}

/**
 * Realpath (.native — expands Windows 8.3 aliases) of the deepest EXISTING
 * ancestor of `target` (the target itself is required not to exist by the time
 * this runs, so its own entry cannot carry a symlink; an ancestor may).
 * Normalized like samePath/isInside. Throws when no ancestor resolves (root
 * missing/drive error) — callers handle it.
 * Residual: a DANGLING symlink ancestor does not resolve, so the walk skips
 * past it and containment is enforced later only by the parent-dir mkdir
 * failing (ENOENT/ENOTDIR) — fail-closed, but with a stage:"worktree" reason.
 */
function resolveExistingAncestor(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      // fs.realpathSync.native (not the JS wrapper): on Windows the JS variant
      // returns 8.3 short-name aliases verbatim (VERYLO~1 stays VERYLO~1), so a
      // caller-supplied alias path would bypass the containment check below.
      return fs.realpathSync.native(current);
    } catch {
      const up = path.dirname(current);
      if (up === current) throw new Error(`no existing ancestor resolves for ${target}`);
      current = up;
    }
  }
}

// ─── Naming rules ────────────────────────────────────────────────────────────

/** All candidate checkpoint refs live under this prefix (campaign repo-wide). */
export const CANDIDATE_REF_PREFIX = "refs/pi-autoresearch/candidates/";

/** The single ref this module may write for a candidate. */
export function candidateRefFor(candidateId: string): string {
  return CANDIDATE_REF_PREFIX + candidateId;
}

const CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A candidateId must be a single plain ref component: git-check-ref-format
 * safe AND free of "/" (no hierarchical ids), so it can never climb out of
 * refs/pi-autoresearch/candidates/. Exported for policy/tool layers that
 * want to reject ids early.
 */
export function isValidCandidateId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    CANDIDATE_ID_RE.test(id) &&
    !id.endsWith(".lock") &&
    !id.endsWith(".") &&
    !id.includes("..")
  );
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Validate the allowed-file list up front: repo-relative, forward-slash
 * normalized paths that cannot escape the worktree (no absolute paths, no
 * drive letters, no ".."/"." components, no ".git", no empty components from
 * double/trailing slashes, no control characters, no duplicates).
 * Backslashes are accepted as separators and normalized to forward slashes.
 */
export function validateAllowedFilePaths(files: readonly unknown[]): {
  ok: boolean;
  errors: string[];
  normalized: string[];
} {
  const errors: string[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(
      "allowed file list must contain at least one path; an empty allow-scope is never valid",
    );
    return { ok: false, errors, normalized };
  }
  files.forEach((raw, i) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errors.push(
        `allowed file [${i}] must be a non-empty string, got ${raw === undefined ? "undefined" : JSON.stringify(String(raw))}`,
      );
      return;
    }
    const p = raw.replaceAll("\\", "/");
    const fail = (why: string) => {
      errors.push(`allowed file ${JSON.stringify(raw)} ${why}`);
    };
    if (/[\0\r\n]/.test(raw)) {
      fail("contains control characters (NUL/CR/LF)");
      return;
    }
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
      fail("is an absolute path; only repo-relative paths are allowed");
      return;
    }
    const parts = p.split("/");
    for (const part of parts) {
      if (part.length === 0) {
        fail("has an empty path component (double or trailing slash)");
        return;
      }
      if (part === "." || part === "..") {
        fail("contains a '.' or '..' component; path traversal is not allowed");
        return;
      }
      const lower = part.toLowerCase();
      if (lower === ".git" || lower === ".git.") {
        fail("names the git metadata directory");
        return;
      }
    }
    if (seen.has(p)) {
      errors.push(`allowed file ${JSON.stringify(raw)} is duplicated`);
      return;
    }
    seen.add(p);
    normalized.push(p);
  });
  return { ok: errors.length === 0, errors, normalized };
}

// ─── Worktree identity ───────────────────────────────────────────────────────

interface WorktreeIdentity {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/** Resolve toplevel/git-dir/common-dir (absolute) for the repo containing cwd. */
async function resolveWorktreeIdentity(exec: ExecFn, cwd: string): Promise<WorktreeIdentity> {
  const run = (fmt: string) =>
    git(exec, ["rev-parse", "--path-format=absolute", fmt], { cwd });
  const [toplevel, gitDir, commonDir] = await Promise.all([
    run("--show-toplevel"),
    run("--git-dir"),
    run("--git-common-dir"),
  ]);
  return {
    toplevel: toplevel.trim(),
    gitDir: gitDir.trim(),
    commonDir: commonDir.trim(),
  };
}

// ─── Change collection (read-only) ───────────────────────────────────────────

export interface WorktreeChanges {
  /** Paths changed in the index (staged), relative to the worktree root. */
  staged: string[];
  /** Paths with unstaged worktree changes to tracked files. */
  unstaged: string[];
  /** Untracked file paths (directories expanded, untracked-files=all). */
  untracked: string[];
  /** Paths with unresolved merge conflicts. */
  unmerged: string[];
  /** Every distinct changed path — exactly the set the checkpoint guard checks. */
  all: string[];
}

export type CollectChangesResult =
  | { ok: true; changes: WorktreeChanges }
  | { ok: false; reason: string };

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

/**
 * Parse `git status --porcelain -z --untracked-files=all`.
 * Entries are NUL-separated: `XY <path>`; rename/copy entries carry a second
 * NUL-separated field with the original path. With -z, paths are raw (no
 * C-style quoting), so any byte-exact filename survives the round-trip.
 */
function parseStatusZ(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.length === 0) {
      i += 1;
      continue;
    }
    if (f.length < 4 || f[2] !== " ") {
      throw new Error(`unparseable git status entry: ${JSON.stringify(f.slice(0, 60))}`);
    }
    const x = f[0];
    const y = f[1];
    const entry: StatusEntry = { x, y, path: f.slice(3) };
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const orig = fields[i + 1];
      if (orig === undefined || orig.length === 0) {
        throw new Error(`rename/copy entry without original path: ${JSON.stringify(f.slice(0, 60))}`);
      }
      entry.origPath = orig;
      i += 2;
    } else {
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Classify every change in the worktree at `worktreePath` (read-only; runs
 * `git status --porcelain -z --untracked-files=all`). Ignored files are NOT
 * reported and do not block checkpoints: they are invisible to commits and
 * conventionally local scratch (chosen restriction, reported in the task).
 */
export async function collectWorktreeChanges(
  exec: ExecFn,
  worktreePath: string,
): Promise<CollectChangesResult> {
  let out: string;
  try {
    out = await git(exec, ["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: worktreePath,
    });
  } catch (err) {
    return { ok: false, reason: gitReason(err) };
  }
  let entries: StatusEntry[];
  try {
    entries = parseStatusZ(out);
  } catch (err) {
    return { ok: false, reason: gitReason(err) };
  }
  const changes: WorktreeChanges = {
    staged: [],
    unstaged: [],
    untracked: [],
    unmerged: [],
    all: [],
  };
  const push = (list: string[], p: string) => {
    if (!list.includes(p)) list.push(p);
    if (!changes.all.includes(p)) changes.all.push(p);
  };
  // Unmerged XY combos per git-status(1): DD, AU, UD, UA, DU, AA, UU.
  const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  for (const e of entries) {
    if (e.x === "?" && e.y === "?") {
      push(changes.untracked, e.path);
      continue;
    }
    if (UNMERGED_CODES.has(e.x + e.y)) {
      // Unmerged entries get their own category only (never staged/unstaged).
      push(changes.unmerged, e.path);
      if (e.origPath) push(changes.unmerged, e.origPath);
      continue;
    }
    if (e.x !== " " && e.x !== "?" && e.x !== "!") {
      push(changes.staged, e.path);
      if (e.origPath) push(changes.staged, e.origPath);
    }
    if (e.y !== " " && e.y !== "?" && e.y !== "!") {
      push(changes.unstaged, e.path);
      if (e.origPath) push(changes.unstaged, e.origPath);
    }
  }
  return { ok: true, changes };
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CandidateWorktreeHandle {
  /** Absolute path of the created worktree root. */
  path: string;
  /** Full commit sha the worktree was created from. */
  baseCommit: string;
  /** The candidate id this worktree belongs to (label only — registration is
   *  campaign-state work and lives elsewhere). */
  candidateId: string;
}

export interface CreateWorktreeOptions {
  /** The campaign (user) repository root. */
  repoRoot: string;
  /** FULL 40-hex commit sha to detach from. Abbreviations are refused. */
  baseCommit: string;
  /** Absolute path for the new worktree; must not exist — any existing entry
   *  is refused, never removed or overwritten. Must also be OUTSIDE the source
   *  worktree directory (enforced: creating a worktree inside the user's tree
   *  would add an untracked system directory to it, which is never done). */
  worktreePath: string;
  /** Candidate id for labeling the handle. */
  candidateId: string;
}

export type CreateWorktreeFailureStage =
  | "validate"
  | "commit"
  | "path-exists"
  | "worktree";

export type CreateWorktreeResult =
  | { ok: true; handle: CandidateWorktreeHandle }
  | { ok: false; stage: CreateWorktreeFailureStage; reason: string };

/**
 * Create a system-owned detached worktree of the repo at `repoRoot`, checked
 * out at the exact full commit `baseCommit`.
 *
 * Guarantees:
 *   - refuses (ok:false) if the target path exists — any existing entry
 *     (empty dir, file, symlink) is refused, never removed or replaced;
 *   - refuses abbreviated (non-40-hex) or unknown/non-commit shas;
 *   - runs `git worktree add --detach <path> <sha>` WITHOUT --force;
 *   - never writes into the source worktree, never resets/cleans/checks out
 *     it, never edits .gitignore, never deletes anything.
 *
 * Parent directories of the target are created (mkdir -p of the parent only,
 * mirroring parallel/worktree.ts; no file inside the user's tree is touched).
 */
export async function createCandidateWorktree(
  exec: ExecFn,
  opts: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const { repoRoot, baseCommit, worktreePath, candidateId } = opts;

  if (!isValidCandidateId(candidateId)) {
    return {
      ok: false,
      stage: "validate",
      reason: `invalid candidateId ${JSON.stringify(String(candidateId))}: a single component of [A-Za-z0-9._-], not starting with '.', without '..' and not ending with '.lock' or '.' is required`,
    };
  }
  if (typeof worktreePath !== "string" || path.resolve(worktreePath).length === 0) {
    return { ok: false, stage: "validate", reason: "worktreePath must be a non-empty path" };
  }

  let toplevel: string;
  try {
    toplevel = (await git(exec, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: repoRoot })).trim();
  } catch (err) {
    return { ok: false, stage: "validate", reason: `repoRoot is not a git repository: ${gitReason(err)}` };
  }

  if (typeof baseCommit !== "string" || !FULL_SHA_RE.test(baseCommit)) {
    return {
      ok: false,
      stage: "commit",
      reason: `baseCommit must be a FULL 40-hex commit sha, got ${JSON.stringify(String(baseCommit))}; abbreviated shas are refused`,
    };
  }
  let resolvedCommit: string;
  try {
    resolvedCommit = (
      await git(exec, ["rev-parse", "--verify", "--quiet", `${baseCommit}^{commit}`], { cwd: toplevel })
    ).trim();
  } catch (err) {
    return { ok: false, stage: "commit", reason: `baseCommit ${baseCommit} does not name an existing commit: ${gitReason(err)}` };
  }
  if (resolvedCommit.toLowerCase() !== baseCommit.toLowerCase()) {
    return {
      ok: false,
      stage: "commit",
      reason: `baseCommit ${baseCommit} resolved to ${resolvedCommit}; pass the full sha of a commit itself`,
    };
  }

  const target = path.resolve(worktreePath);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }
  if (st !== null) {
    const what = st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file";
    return {
      ok: false,
      stage: "path-exists",
      reason: `worktree path already exists (${what}): ${JSON.stringify(target)}; existing paths are never removed or replaced`,
    };
  }
  if (samePath(target, toplevel)) {
    return {
      ok: false,
      stage: "path-exists",
      reason: `worktree path equals the source worktree root (${JSON.stringify(target)}); the source tree is never reused or moved`,
    };
  }
  if (isInside(target, toplevel)) {
    return {
      ok: false,
      stage: "validate",
      reason: `worktree path ${JSON.stringify(target)} is inside the source worktree (${JSON.stringify(toplevel)}); creating it there would add an untracked directory to the user's tree, which is never done`,
    };
  }
  // Realpath-based re-check: a purely lexical comparison misses ancestors that
  // are symlinks pointing into the source tree (e.g. holder/link -> repo/landing
  // with target holder/link/wt). Resolve the deepest existing ancestor of the
  // target (the target itself must not exist at this point) and of the source
  // toplevel, and refuse when the resolved target lands inside the resolved
  // source tree. Same normalization rules as isInside/samePath.
  let resolvedTargetAncestor: string;
  let resolvedToplevel: string;
  try {
    resolvedTargetAncestor = resolveExistingAncestor(target);
    resolvedToplevel = fs.realpathSync.native(toplevel);
  } catch (err) {
    return {
      ok: false,
      stage: "validate",
      reason: `cannot resolve real paths to verify the target is outside the source tree: ${gitReason(err)}`,
    };
  }
  if (isInside(resolvedTargetAncestor, resolvedToplevel)) {
    return {
      ok: false,
      stage: "validate",
      reason: `worktree path ${JSON.stringify(target)} resolves through a symlinked ancestor into the source worktree (${JSON.stringify(resolvedTargetAncestor)} is inside ${JSON.stringify(resolvedToplevel)}); creating it there would add an untracked directory to the user's tree, which is never done`,
    };
  }

  // Parent dirs only; the target itself must stay absent for git worktree add.
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, stage: "worktree", reason: `cannot create parent directory: ${gitReason(err)}` };
  }

  try {
    await git(exec, ["worktree", "add", "--detach", target, resolvedCommit], {
      cwd: toplevel,
      timeout: 30000,
    });
  } catch (err) {
    // Fail-closed: git refused (e.g. stale registration) — surface it and do
    // NOT prune or force; manual inspection is required (design §4).
    return { ok: false, stage: "worktree", reason: gitReason(err) };
  }

  return {
    ok: true,
    handle: { path: target, baseCommit: resolvedCommit, candidateId },
  };
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

export interface CheckpointOptions {
  /** The campaign (user) repository root the candidate worktree belongs to. */
  repoRoot: string;
  /** The system-created candidate worktree root (a LINKED worktree of repoRoot
   *  — never the user's main working tree; enforced). */
  worktreePath: string;
  /** Candidate id; selects the ref refs/pi-autoresearch/candidates/<id>. */
  candidateId: string;
  /** Repo-relative files the checkpoint may include; everything else present
   *  as a change blocks the checkpoint (FR-03/05/12). */
  allowedFiles: string[];
  /** Commit message for the checkpoint commit. */
  message: string;
  /** Campaign-wide scope for commits the candidate already made in its worktree
   *  (agent-side `git commit`, invisible to the status check): every path
   *  touched by `baseRef..HEAD` must be in `scope`. The caller passes the
   *  campaign leader ref and the policy's change_files. */
  committedScope?: { baseRef: string; scope: readonly string[] };
}

export type CheckpointFailureStage =
  | "validate"
  | "guard"
  | "outside-allowed"
  | "allowed-files"
  | "empty"
  | "commit"
  | "ref";

export type CheckpointResult =
  | { ok: true; commit: string; ref: string }
  | { ok: false; stage: CheckpointFailureStage; reason: string; blockingPaths: string[] };

const failCheckpoint = (
  stage: CheckpointFailureStage,
  reason: string,
  blockingPaths: string[] = [],
): CheckpointResult => ({ ok: false, stage, reason, blockingPaths });

/**
 * Commit exactly the allowed files in the candidate worktree and move the
 * candidate ref to the new checkpoint commit.
 *
 * Guards (all fail-closed, in order):
 *   1. candidateId/message/allowedFiles validated (ref-namespace safety,
 *      traversal/absolute/.git paths rejected before any git call);
 *   2. worktreePath is the root of a LINKED worktree of repoRoot — the user's
 *      main working tree is refused outright (so checkpoint can never commit
 *      in the user's tree);
 *   3. no merge/cherry-pick/revert in progress in the worktree;
 *   4. EVERY staged/unstaged/untracked/unmerged path must be in allowedFiles,
 *      otherwise refusal listing the offenders ("outside-allowed") — the
 *      changes are preserved untouched;
 *   5. each allowed path is checked on disk: symlinks (any path component) are
 *      refused, directories and other non-regular files are refused, a missing
 *      path must at least be tracked (its deletion is then committed);
 *   6. if no allowed file actually changed — refusal ("empty"), no commit,
 *      no ref;
 *   7. stage with `git add -- <paths>` (never -A), re-verify the staged set
 *      still respects the allowed scope, commit with --no-verify (no user
 *      hooks run for system commits), verify the commit's changed paths, then
 *      `git update-ref` the candidate ref and verify it.
 *
 * The leader ref, the user's branches and every other ref are never written.
 * If step 7's re-verification or the commit fails after `git add` ran (a
 * concurrent-change race in the tiny status→add window), the function returns
 * ok:false and LEAVES the staged state for manual inspection — nothing is
 * reset, cleaned or reverted, and no ref is written.
 *
 * Ignored files (gitignore) are invisible to this check and do not block
 * (chosen restriction: they cannot enter a commit without an explicit add).
 */
export async function checkpointCandidateWorktree(
  exec: ExecFn,
  opts: CheckpointOptions,
): Promise<CheckpointResult> {
  const { repoRoot, worktreePath, candidateId, allowedFiles, message } = opts;

  // 1. Input validation — before any git access.
  if (!isValidCandidateId(candidateId)) {
    return failCheckpoint(
      "validate",
      `invalid candidateId ${JSON.stringify(String(candidateId))}: a single component of [A-Za-z0-9._-], not starting with '.', without '..' and not ending with '.lock' or '.' is required`,
    );
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return failCheckpoint("validate", "message must be a non-empty string");
  }
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return failCheckpoint("validate", "allowedFiles must contain at least one path");
  }
  const validated = validateAllowedFilePaths(allowedFiles);
  if (!validated.ok) {
    return failCheckpoint("validate", validated.errors.join("; ").slice(0, 500));
  }
  const allowedSet = new Set(validated.normalized);

  const wtPath = path.resolve(worktreePath);
  try {
    const st = fs.lstatSync(wtPath);
    if (!st.isDirectory()) {
      return failCheckpoint("guard", `worktreePath is not a directory: ${wtPath}`);
    }
  } catch {
    return failCheckpoint("guard", `worktreePath does not exist: ${wtPath}`);
  }

  // 2. Worktree identity: must be a linked worktree of repoRoot's repository.
  let wtId: WorktreeIdentity;
  let repoId: WorktreeIdentity;
  try {
    wtId = await resolveWorktreeIdentity(exec, wtPath);
    const repoToplevel = (await git(exec, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd: repoRoot })).trim();
    repoId = await resolveWorktreeIdentity(exec, repoToplevel);
  } catch (err) {
    return failCheckpoint("guard", `cannot resolve git identity: ${gitReason(err)}`);
  }
  if (!samePath(wtId.toplevel, wtPath)) {
    return failCheckpoint(
      "guard",
      `worktreePath is not a worktree root (git toplevel is ${JSON.stringify(wtId.toplevel)}); refusing`,
    );
  }
  // Main working tree iff gitDir equals the common dir (linked worktrees use
  // <commonDir>/worktrees/<name> as their private git dir).
  if (samePath(wtId.gitDir, wtId.commonDir)) {
    return failCheckpoint(
      "guard",
      `${wtId.toplevel} is a main working tree, not a system-created linked worktree; checkpoints in the user's tree are refused`,
    );
  }
  if (!samePath(wtId.commonDir, repoId.commonDir)) {
    return failCheckpoint(
      "guard",
      `worktree belongs to a different repository (common dir ${wtId.commonDir} != ${repoId.commonDir}); refusing`,
    );
  }

  // 3. No in-progress sequencer operation in this worktree.
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (fs.existsSync(path.join(wtId.gitDir, marker))) {
      return failCheckpoint(
        "guard",
        `an unfinished merge/cherry-pick/revert appears to be in progress (${marker} exists); resolve it manually first`,
      );
    }
  }

  // 3b. Commits the candidate already made in this worktree are not visible to
  //     the status check below. Every path they touched must be inside the
  //     campaign's change scope, not just this call's allowed set.
  if (opts.committedScope) {
    const scope = new Set(opts.committedScope.scope.map((p) => p.replace(/\\/g, "/")));
    let touched: string[];
    try {
      const baseSha = (await git(exec, ["rev-parse", "--verify", "--quiet", `${opts.committedScope.baseRef}^{commit}`], { cwd: wtPath })).trim();
      const out = await git(exec, ["log", "-z", "--no-renames", "--name-only", "--format=", `${baseSha}..HEAD`], { cwd: wtPath });
      touched = Array.from(new Set(out.split("\0").map((s) => s.replace(/^\n+/, "")).filter((s) => s.length > 0)));
    } catch (err) {
      return failCheckpoint("guard", `cannot read the candidate's own commits: ${gitReason(err)}`);
    }
    const committedOffenders = touched.filter((p) => !scope.has(p)).sort();
    if (committedOffenders.length > 0) {
      return failCheckpoint(
        "outside-allowed",
        `${committedOffenders.length} path(s) committed in the candidate worktree are outside the campaign change scope; nothing was committed and no ref was written`,
        committedOffenders.map((p) => `committed:${p}`),
      );
    }
  }

  // 4. Unaccounted changes block the checkpoint.
  const collected = await collectWorktreeChanges(exec, wtPath);
  if (!collected.ok) {
    return failCheckpoint("guard", `cannot read worktree status: ${collected.reason}`);
  }
  const offenders: string[] = [];
  const categoryOf = (p: string) =>
    collected.changes.untracked.includes(p)
      ? "untracked"
      : collected.changes.staged.includes(p)
        ? "staged"
        : collected.changes.unmerged.includes(p)
          ? "unmerged"
          : "unstaged";
  for (const p of collected.changes.all) {
    if (!allowedSet.has(p)) offenders.push(`${categoryOf(p)}:${p}`);
  }
  if (offenders.length > 0) {
    offenders.sort();
    return failCheckpoint(
      "outside-allowed",
      `${offenders.length} changed path(s) outside the allowed file set block this checkpoint; nothing was committed and all changes are preserved`,
      offenders,
    );
  }

  // 5. Allowed entries must be plain regular files (or tracked deletions);
  //    symlinks — including symlinked INTERMEDIATE directories — are never
  //    included (FR-12).
  for (const rel of validated.normalized) {
    const parts = rel.split("/");
    try {
      for (let i = 1; i < parts.length; i++) {
        const dirSt = fs.lstatSync(path.join(wtPath, ...parts.slice(0, i)));
        if (dirSt.isSymbolicLink()) {
          return failCheckpoint(
            "allowed-files",
            `allowed file ${JSON.stringify(rel)} goes through a symbolic link at ${parts.slice(0, i).join("/")}; symlinks are never included`,
            [rel],
          );
        }
      }
      const st = fs.lstatSync(path.join(wtPath, ...parts));
      if (st.isSymbolicLink()) {
        return failCheckpoint(
          "allowed-files",
          `allowed file ${JSON.stringify(rel)} is a symbolic link; symlinks are never included`,
          [rel],
        );
      }
      if (!st.isFile()) {
        return failCheckpoint(
          "allowed-files",
          `allowed file ${JSON.stringify(rel)} is not a regular file (${st.isDirectory() ? "directory" : "special file"}); directories are not supported as allowed paths`,
          [rel],
        );
      }
    } catch {
      // Missing on disk: allowed only if git tracks it (deletion checkpoint).
      try {
        await git(exec, ["ls-files", "--error-unmatch", "--", rel], { cwd: wtPath });
      } catch {
        return failCheckpoint(
          "allowed-files",
          `allowed file ${JSON.stringify(rel)} does not exist in the worktree and is not tracked`,
          [rel],
        );
      }
    }
  }

  // 6. Nothing to commit → refuse without writing anything.
  const changedAllowed = collected.changes.all.filter((p) => allowedSet.has(p));
  if (changedAllowed.length === 0) {
    return failCheckpoint(
      "empty",
      "no allowed file has changes; an empty checkpoint is refused and no ref is written",
    );
  }

  // 7. Stage exactly the changed allowed paths (never add -A).
  changedAllowed.sort();
  try {
    await git(exec, ["add", "--", ...changedAllowed], { cwd: wtPath });

    // Re-verify the staged scope (tiny race window: a path that became dirty
    // between the first status and this add). On violation: fail-closed, keep
    // the staged state for manual inspection, commit nothing.
    const re = await collectWorktreeChanges(exec, wtPath);
    if (!re.ok) {
      return failCheckpoint("commit", `post-add status check failed: ${re.reason}`);
    }
    const stagedOffenders = re.changes.staged
      .filter((p) => !allowedSet.has(p))
      .sort();
    if (stagedOffenders.length > 0) {
      return failCheckpoint(
        "commit",
        `staged scope violation after add (${stagedOffenders.join(", ")}); the staged state is kept for manual inspection, no commit and no ref were written`,
        stagedOffenders,
      );
    }

    await git(exec, ["commit", "--no-verify", "-m", message], { cwd: wtPath });
  } catch (err) {
    return failCheckpoint(
      "commit",
      `${gitReason(err)}; if staging already happened, the staged state is kept for manual inspection`,
    );
  }

  let commit: string;
  try {
    commit = (await git(exec, ["rev-parse", "HEAD"], { cwd: wtPath })).trim();
    // Verify the commit really touches only allowed paths (--no-verify means
    // no hooks could have smuggled extra paths; this is defense in depth).
    const committedPaths = (
      await git(exec, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", commit], {
        cwd: wtPath,
      })
    )
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const bad = committedPaths.filter((p) => !allowedSet.has(p)).sort();
    if (bad.length > 0) {
      return failCheckpoint(
        "commit",
        `checkpoint commit ${commit} contains paths outside the allowed set (${bad.join(", ")}); the candidate ref was NOT moved — manual inspection required`,
        bad,
      );
    }
  } catch (err) {
    return failCheckpoint("commit", `post-commit verification failed: ${gitReason(err)}`);
  }

  // 8. Move only the candidate ref; verify it.
  const ref = candidateRefFor(candidateId);
  try {
    await git(exec, ["update-ref", ref, commit], { cwd: wtPath });
    const refSha = (await git(exec, ["rev-parse", "--verify", "--quiet", ref], { cwd: wtPath })).trim();
    if (refSha !== commit) {
      return failCheckpoint("ref", `ref ${ref} points at ${refSha || "(unset)"}, expected ${commit}`);
    }
  } catch (err) {
    return failCheckpoint("ref", `failed to update ${ref}: ${gitReason(err)}`);
  }

  return { ok: true, commit, ref };
}
