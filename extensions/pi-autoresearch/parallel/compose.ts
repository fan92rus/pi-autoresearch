/**
 * Composition: merge orthogonal improvements from different tree branches.
 *
 * Given two tree nodes (from different branches), extract their diffs relative
 * to their Lowest Common Ancestor (LCA), check that the diffs touch different
 * files (orthogonal), then apply both patches.
 *
 * Phase 1: orthogonal only. Same-file conflicts return an error with the
 * conflicting file list. Manual LLM merge is Phase 2.
 */

import type { ExperimentTree, TreeNode } from "./tree.ts";

/** ExecFn type matching pi.exec / worktree.ts ExecFn. */
type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface FileScopeCheck {
  orthogonal: boolean;
  sharedFiles: string[];
  filesA: string[];
  filesB: string[];
}

export interface ComposeResult {
  success: boolean;
  conflict: boolean;
  sharedFiles: string[];
  lcaCommit: string | null;
  appliedCommit: string | null;
  error: string | null;
}

/**
 * Check if two file sets are orthogonal (no shared files).
 */
export function checkFileScopeConflict(filesA: string[], filesB: string[]): FileScopeCheck {
  const setA = new Set(filesA);
  const shared = filesB.filter((f) => setA.has(f));
  return {
    orthogonal: shared.length === 0,
    sharedFiles: shared,
    filesA,
    filesB,
  };
}

/**
 * Find the Lowest Common Ancestor of two commits.
 */
export async function findLCA(
  exec: ExecFn,
  workDir: string,
  commitA: string,
  commitB: string,
): Promise<string | null> {
  try {
    const r = await exec("git", ["merge-base", commitA, commitB], {
      cwd: workDir,
      timeout: 10000,
    });
    if (r.code !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Apply two orthogonal diffs onto the working directory.
 *
 * Steps:
 *  1. Find LCA (merge-base) of nodeA.commit and nodeB.commit
 *  2. Extract changed files for each node relative to LCA
 *  3. Check file-scope orthogonality (fail on overlap)
 *  4. For each file: git checkout <commit> -- <file> (file-level merge)
 *  5. Return success — caller benchmarks + commits
 *
 * Returns ComposeResult. On conflict, lists shared files.
 */
export async function composeDiffs(
  exec: ExecFn,
  workDir: string,
  repoRoot: string,
  tree: ExperimentTree,
  nodeA: TreeNode,
  nodeB: TreeNode,
): Promise<ComposeResult> {
  if (!nodeA.commit || !nodeB.commit) {
    return {
      success: false,
      conflict: false,
      sharedFiles: [],
      lcaCommit: null,
      appliedCommit: null,
      error: "One or both nodes are ghost nodes (no commit). Cannot compose.",
    };
  }

  // Find LCA
  const lca = await findLCA(exec, workDir, nodeA.commit, nodeB.commit);
  if (!lca) {
    return {
      success: false,
      conflict: false,
      sharedFiles: [],
      lcaCommit: null,
      appliedCommit: null,
      error: "Could not find merge-base (LCA) for the two commits.",
    };
  }

  // Extract changed files for both nodes
  const filesA = await extractChangedFilesViaLCA(exec, workDir, lca, nodeA.commit);
  const filesB = await extractChangedFilesViaLCA(exec, workDir, lca, nodeB.commit);

  // Check orthogonality
  const scope = checkFileScopeConflict(filesA, filesB);
  if (!scope.orthogonal) {
    return {
      success: false,
      conflict: true,
      sharedFiles: scope.sharedFiles,
      lcaCommit: lca,
      appliedCommit: null,
      error: `File-scope conflict: both nodes modify ${scope.sharedFiles.join(", ")}. Phase 1 only supports orthogonal composition (different files).`,
    };
  }

  // Apply patches using file-level checkout (works because files are orthogonal)
  // For each file in filesA: git checkout <nodeA.commit> -- <file>
  // For each file in filesB: git checkout <nodeB.commit> -- <file>
  try {
    for (const file of filesA) {
      await exec("git", ["checkout", nodeA.commit, "--", file], {
        cwd: workDir,
        timeout: 10000,
      });
    }
    for (const file of filesB) {
      await exec("git", ["checkout", nodeB.commit, "--", file], {
        cwd: workDir,
        timeout: 10000,
      });
    }

    return {
      success: true,
      conflict: false,
      sharedFiles: [],
      lcaCommit: lca,
      appliedCommit: null, // Caller commits after benchmarking
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      conflict: false,
      sharedFiles: scope.sharedFiles,
      lcaCommit: lca,
      appliedCommit: null,
      error: `Failed to apply patches: ${msg}`,
    };
  }
}

/**
 * Extract changed files between LCA and a specific commit.
 */
async function extractChangedFilesViaLCA(
  exec: ExecFn,
  workDir: string,
  lca: string,
  commit: string,
): Promise<string[]> {
  const r = await exec("git", ["diff", "--name-only", lca, commit], {
    cwd: workDir,
    timeout: 10000,
  });
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean);
}
