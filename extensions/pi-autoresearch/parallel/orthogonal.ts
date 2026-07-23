/**
 * Orthogonal stacking (Mode B, ТЗ §10).
 *
 * Verify that independent file-scoped optimizations combine without runtime
 * interference. Two phases:
 *   1. parallel: measure each patch in its own worktree (BENCH_MODE=quick),
 *      capture the actual file scope via `git diff --name-only`.
 *   2. stack: sort by improvement; apply each on main sequentially with a
 *      re-measure (BENCH_MODE=full) after every patch — keep if cumulative
 *      improves and nothing regresses, else revert that patch.
 *
 * File-scope orthogonality is a NECESSARY but not SUFFICIENT condition: two
 * patches touching disjoint files can still interfere at runtime (shared cache,
 * allocator, global state). Hence the per-patch re-measure in the stack phase.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RpcClient, SpawnedWorker } from "./rpc.ts";
import type { ExecFn } from "./worktree.ts";
import { provisionWorktree, cleanupWorktree, cleanupAllWorktrees, currentHead, type WorktreeHandle } from "./worktree.ts";
import { runMeasure, applyDiff, revertWorkdir } from "./remeasure.ts";
import { isBetter } from "./aggregate.ts";
import type { ParallelConfig } from "./config.ts";
import { defaultConcurrency } from "./config.ts";
import { buildWorkerTask, readWorkerResult, collectWorker } from "./bestofn.ts";
import type { BenchMode, Direction, WorkerResult } from "./types.ts";

export interface OrthogonalPatch {
  name: string;
  hypothesis: string;
  /** Declared file scope (informational). Actual scope is recomputed from the diff. */
  fileScope?: string[];
}

export interface OrthogonalOptions {
  patches: OrthogonalPatch[];
  metricName: string;
  direction: Direction;
  metricUnit?: string;
  sessionName?: string;
  agent?: string;
  modelOverride?: string;
  budgetSeconds?: number;
  concurrency?: number;
}

export interface OrthogonalResult {
  baselineMetric: number;
  perPatch: Array<{
    name: string;
    metric: number | null;
    improvement: number | null;
    status: string;
    fileScopeActual: string[];
  }>;
  independence: { orthogonal: boolean; conflicts: Array<{ a: string; b: string; sharedFiles: string[] }> };
  stackedMetric: number | null;
  applied: string[];
  rejected: Array<{ name: string; reason: string }>;
  decision: "keep" | "discard";
  reason?: string;
}

export interface OrthogonalContext {
  rpc: RpcClient;
  exec: ExecFn;
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
  repoRoot: string;
  workDir: string;
  config: ParallelConfig;
  /** Optional progress reporter for UI feedback. */
  onProgress?: (msg: string) => void;
}

/** Compute the file list touched by a diff (actual scope, not declared). Pure. */
export function diffFileScope(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    // "diff --git a/foo b/foo"
    const parts = line.split(" ");
    // take the "b/foo" target
    const target = parts[3] ?? parts[2] ?? "";
    const file = target.startsWith("b/") ? target.slice(2) : target;
    if (file) files.add(file);
  }
  return [...files].sort();
}

/** Find pairs of patches whose actual file scopes overlap. Pure. */
export function findScopeConflicts(
  scopes: Map<string, string[]>,
): Array<{ a: string; b: string; sharedFiles: string[] }> {
  const names = [...scopes.keys()];
  const conflicts: Array<{ a: string; b: string; sharedFiles: string[] }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      const sa = new Set(scopes.get(a) ?? []);
      const sb = scopes.get(b) ?? [];
      const shared = sb.filter((f) => sa.has(f));
      if (shared.length > 0) conflicts.push({ a, b, sharedFiles: shared });
    }
  }
  return conflicts;
}

/** Execute the orthogonal-stack flow. Mutates git on main only in phase 2. */
export async function runCheckOrthogonal(ctx: OrthogonalContext, opts: OrthogonalOptions): Promise<OrthogonalResult> {
  const { rpc, exec, runCmd, repoRoot, workDir, config } = ctx;
  const progress = ctx.onProgress ?? (() => {});
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;
  const concurrency = opts.concurrency ?? config.concurrency ?? defaultConcurrency();
  const benchMode: BenchMode = config.workerBenchMode;

  const baselineSha = await currentHead(exec, repoRoot);
  progress(`Baseline measure (BENCH_MODE=quick)...`);
  const pre = await runMeasure(exec, workDir, opts.metricName, "quick", budgetSeconds, runCmd);
  if (pre.timedOut || pre.metric === null) {
    return { baselineMetric: NaN, perPatch: [], independence: { orthogonal: false, conflicts: [] }, stackedMetric: null, applied: [], rejected: [], decision: "discard", reason: "baseline_over_budget" };
  }
  const baselineMetric = pre.metric;
  progress(`Baseline: ${baselineMetric}${opts.metricUnit ?? ""}`);

  // Phase 1 — parallel measurement + actual scope capture.
  const wts: WorktreeHandle[] = [];
  const results: WorkerResult[] = [];
  try {
    // clear leftovers from a crashed previous run (wt-* names are reused)
    await cleanupAllWorktrees(exec, repoRoot).catch(() => {});
    for (let i = 0; i < opts.patches.length; i++) {
      wts.push(await provisionWorktree(exec, repoRoot, i + 1, baselineSha));
    }
    progress(`Phase 1: measuring ${opts.patches.length} patches in parallel worktrees...`);
    let cursor = 0;
    const runOne = async (patch: OrthogonalPatch, index: number): Promise<void> => {
      const wt = wts[index]!;
      const model = opts.modelOverride ?? config.tiers[config.defaultTier];
      const task = buildWorkerTask({
        hypothesis: patch.hypothesis, wtPath: wt.path, baselineSha,
        metricName: opts.metricName, direction: opts.direction, metricUnit: opts.metricUnit ?? "",
        sessionName: opts.sessionName ?? "parallel-orthogonal",
        budgetSeconds, benchMode, repeats: 1,
        workerTimeoutMs: config.complexityMap[config.defaultComplexity].workerTimeoutMs,
      });
      const spawned: SpawnedWorker = await rpc.spawn({ agent: opts.agent ?? "worker", task, cwd: wt.path, model, output: path.join(wt.path, ".auto", "worker-result.json"), outputMode: "file-only", context: "fresh" });
      results[index] = await collectWorker(ctx, spawned, wt, config.complexityMap[config.defaultComplexity].workerTimeoutMs);
    };
    const workers: Promise<void>[] = [];
    const n = Math.max(1, Math.min(concurrency, opts.patches.length));
    for (let w = 0; w < n; w++) {
      workers.push((async () => { while (cursor < opts.patches.length) { const i = cursor++; await runOne(opts.patches[i]!, i); } })());
    }
    await Promise.all(workers);

    // Capture actual scopes from diffs.
    const scopes = new Map<string, string[]>();
    const perPatch: OrthogonalResult["perPatch"] = [];
    for (let i = 0; i < opts.patches.length; i++) {
      const r = results[i]!;
      const actual = diffFileScope(r.diff);
      scopes.set(opts.patches[i]!.name, actual);
      const metric = r.status === "ok" ? r.metric : null;
      const improvement = metric !== null ? (opts.direction === "lower" ? baselineMetric - metric : metric - baselineMetric) : null;
      perPatch.push({ name: opts.patches[i]!.name, metric, improvement, status: r.status, fileScopeActual: actual });
    }
    const conflicts = findScopeConflicts(scopes);
    if (conflicts.length > 0) {
      return { baselineMetric, perPatch, independence: { orthogonal: false, conflicts }, stackedMetric: null, applied: [], rejected: [], decision: "discard", reason: "not_orthogonal" };
    }

    // Phase 2 — stack: apply each patch on main, re-measure after each.
    const order = [...opts.patches.keys()].sort((a, b) => (perPatch[b]!.improvement ?? -Infinity) - (perPatch[a]!.improvement ?? -Infinity));
    let stacked = baselineMetric;
    const applied: string[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const i of order) {
      const patch = opts.patches[i]!;
      const r = results[i]!;
      if (r.status !== "ok" || !r.diff.trim()) {
        rejected.push({ name: patch.name, reason: "no_valid_diff" });
        continue;
      }
      try {
        await applyDiff(exec, workDir, r.diff);
      } catch (e) {
        rejected.push({ name: patch.name, reason: `apply_failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      const m = await runMeasure(exec, workDir, opts.metricName, "full", budgetSeconds, runCmd);
      if (m.metric === null || m.timedOut) {
        await revertWorkdir(exec, workDir);
        rejected.push({ name: patch.name, reason: "remeasure_failed_or_timeout" });
        continue;
      }
      if (isBetter(m.metric, stacked, opts.direction)) {
        stacked = m.metric;
        applied.push(patch.name);
      } else {
        await revertWorkdir(exec, workDir);
        rejected.push({ name: patch.name, reason: "regression_or_noop_on_stack" });
      }
    }
    return {
      baselineMetric, perPatch,
      independence: { orthogonal: true, conflicts: [] },
      stackedMetric: stacked,
      applied, rejected,
      decision: applied.length > 0 ? "keep" : "discard",
      reason: applied.length > 0 ? undefined : "no_patch_stacked",
    };
  } finally {
    await Promise.all(wts.map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
  }
}
