/**
 * Worktree provisioning for parallel modes.
 *
 * We manage worktrees ourselves (git worktree add --detach) rather than relying
 * on pi-subagents' worktree:true flag, because:
 *  - we control the baseline commit (fixed SHA for the whole round),
 *  - we need .auto/ (measure.sh, checks.sh, prompt.md) copied in — it is
 *    gitignored in main and absent from a fresh worktree,
 *  - we don't depend on pi-subagents' clean-git-state precondition.
 *
 * Workers run with cwd = the worktree path; their .auto/ (resolved from cwd) is
 * worktree-local and scratch — cleanup removes it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Minimal exec surface (matches pi.exec return shape). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export interface WorktreeHandle {
  /** Absolute path to the worktree root. */
  path: string;
  /** 1-based index, used for naming/labeling. */
  index: number;
}

const PARALLEL_DIR = ".auto/parallel";

/** Resolve the repo root by walking up from `cwd` looking for a .git entry. */
export function resolveRepoRoot(cwd: string, existsSync: (p: string) => boolean = fs.existsSync): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the given cwd if no .git found.
  return path.resolve(cwd);
}

/** Run a git command via the provided exec function; throws on non-zero exit. */
export async function gitExec(
  exec: ExecFn,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  const res = await exec("git", args, opts);
  if (res.code !== 0) {
    const err = (res.stdout + res.stderr).trim().slice(0, 500);
    throw new Error(`git ${args.join(" ")} failed (exit ${res.code}): ${err}`);
  }
  return res;
}

/** Read the short HEAD sha of the repo at `repoRoot`. */
export async function currentHead(exec: ExecFn, repoRoot: string): Promise<string> {
  const res = await gitExec(exec, ["rev-parse", "--short=7", "HEAD"], { cwd: repoRoot, timeout: 5000 });
  return res.stdout.trim();
}

/**
 * Create an isolated worktree at `baselineSha`, copy .auto/ session files in.
 * Returns a handle to the worktree. Caller MUST pass it to cleanupWorktrees().
 */
export async function provisionWorktree(
  exec: ExecFn,
  repoRoot: string,
  index: number,
  baselineSha: string,
  copyFiles: string[] = [".auto/measure.sh", ".auto/checks.sh", ".auto/prompt.md", ".auto/config.json"],
): Promise<WorktreeHandle> {
  const wtPath = path.join(repoRoot, PARALLEL_DIR, `wt-${index}`);
  // Ensure the parent dir exists (git worktree add needs it absent, but parent present).
  await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });
  // Remove a stale worktree at the same path (best-effort).
  try { await fs.promises.rm(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }

  await gitExec(exec, ["worktree", "add", "--detach", "--force", wtPath, baselineSha], {
    cwd: repoRoot,
    timeout: 30000,
  });

  // Copy session files the worker needs (they are gitignored in main).
  for (const rel of copyFiles) {
    const src = path.join(repoRoot, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(wtPath, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
    }
  }
  // Ensure the worktree has its own .auto/ for worker scratch output.
  await fs.promises.mkdir(path.join(wtPath, ".auto"), { recursive: true });

  return { path: wtPath, index };
}

/** Remove a worktree and its scratch .auto/. Safe to call in finally{}. */
export async function cleanupWorktree(exec: ExecFn, repoRoot: string, handle: WorktreeHandle): Promise<void> {
  // `git worktree remove --force` also deletes the directory.
  try {
    await gitExec(exec, ["worktree", "remove", "--force", handle.path], {
      cwd: repoRoot,
      timeout: 30000,
    });
  } catch {
    // If git refuses (e.g. worker left files), prune then try rm directly.
    try { await gitExec(exec, ["worktree", "prune"], { cwd: repoRoot, timeout: 10000 }); } catch { /* ignore */ }
    try { await fs.promises.rm(handle.path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Remove all worktrees under .auto/parallel (housekeeping on startup/errors). */
export async function cleanupAllWorktrees(exec: ExecFn, repoRoot: string): Promise<void> {
  const dir = path.join(repoRoot, PARALLEL_DIR);
  let entries: string[] = [];
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith("wt-")) continue;
    const wtPath = path.join(dir, name);
    try {
      await gitExec(exec, ["worktree", "remove", "--force", wtPath], { cwd: repoRoot, timeout: 15000 });
    } catch {
      try { await fs.promises.rm(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
