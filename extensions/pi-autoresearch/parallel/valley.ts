/**
 * Valley probes (ТЗ §11.5 М2).
 *
 * When a phase is stuck (hit maxSteps without improvement), don't give up —
 * spawn parallel worktrees from the BEST checkpoint with different continuation
 * strategies. This reuses the BestOfN worktree + fan-out machinery; the only
 * difference is the baseline is the checkpoint commit, not the round base.
 *
 * Returns the winning continuation's diff (for the caller to apply on main) or
 * null if no probe escaped the valley.
 */

import * as path from "node:path";
import type { RpcClient, SpawnedWorker } from "./rpc.ts";
import type { ExecFn } from "./worktree.ts";
import { provisionWorktree, cleanupWorktree, type WorktreeHandle } from "./worktree.ts";
import { rankCandidates, computeNoiseFloor } from "./aggregate.ts";
import { readWorkerResult, collectWorker } from "./bestofn.ts";
import type { ParallelConfig } from "./config.ts";
import { defaultConcurrency } from "./config.ts";
import { buildWorkerTask } from "./bestofn.ts";
import type { BenchMode, Direction, RankedCandidate, WorkerResult } from "./types.ts";

export interface ValleyProbeContext {
  rpc: RpcClient;
  exec: ExecFn;
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
  repoRoot: string;
  workDir: string;
  config: ParallelConfig;
}

export interface ValleyProbeOptions {
  /** Commit to probe from (the phase's best checkpoint, or its phase base). */
  fromCommit: string;
  /** Baseline metric at that commit (to judge whether a probe escaped). */
  baselineMetric: number;
  strategies: string[];
  metricName: string;
  direction: Direction;
  metricUnit?: string;
  sessionName?: string;
  agent?: string;
  modelOverride?: string;
  budgetSeconds?: number;
  concurrency?: number;
}

export interface ValleyProbeResult {
  escaped: boolean;
  winner: RankedCandidate | null;
  winnerDiff: string;
  winnerMetric: number | null;
  ranked: RankedCandidate[];
  results: WorkerResult[];
}

/**
 * Fan out continuation strategies from `fromCommit`. Each worker runs in a
 * worktree seeded at that commit, applies its strategy, measures. The caller is
 * responsible for applying the winning diff on main + re-measuring (selection
 * bias) + log_experiment — same contract as BestOfN.
 */
export async function runValleyProbe(ctx: ValleyProbeContext, opts: ValleyProbeOptions): Promise<ValleyProbeResult> {
  const { rpc, exec, repoRoot, config } = ctx;
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;
  const benchMode: BenchMode = config.workerBenchMode;
  const concurrency = opts.concurrency ?? config.concurrency ?? defaultConcurrency();
  const wts: WorktreeHandle[] = [];
  const results: WorkerResult[] = new Array(opts.strategies.length);
  try {
    for (let i = 0; i < opts.strategies.length; i++) {
      wts.push(await provisionWorktree(exec, repoRoot, i + 1, opts.fromCommit));
    }
    let cursor = 0;
    const runOne = async (strategy: string, index: number): Promise<void> => {
      const wt = wts[index]!;
      const model = opts.modelOverride ?? config.tiers[config.defaultTier];
      const task = buildWorkerTask({
        hypothesis: `Стратегия продолжения из долины: ${strategy}. Изучи текущее состояние кода (оно уже применено в worktree) и найди путь к улучшению метрики "${opts.metricName}".`,
        wtPath: wt.path, baselineSha: opts.fromCommit,
        metricName: opts.metricName, direction: opts.direction, metricUnit: opts.metricUnit ?? "",
        sessionName: opts.sessionName ?? "parallel-valley",
        budgetSeconds, benchMode, repeats: 1,
      });
      const spawned: SpawnedWorker = await rpc.spawn({ agent: opts.agent ?? "worker", task, cwd: wt.path, model, output: path.join(wt.path, ".auto", "worker-result.json"), outputMode: "file-only", context: "fresh" });
      results[index] = await collectWorker(ctx, spawned, wt, config.complexityMap[config.defaultComplexity].workerTimeoutMs);
    };
    const workers: Promise<void>[] = [];
    const n = Math.max(1, Math.min(concurrency, opts.strategies.length));
    for (let w = 0; w < n; w++) {
      workers.push((async () => { while (cursor < opts.strategies.length) { const i = cursor++; await runOne(opts.strategies[i]!, i); } })());
    }
    await Promise.all(workers);

    const noiseFloor = computeNoiseFloor(results);
    const { ranked, winnerIndex } = rankCandidates(opts.baselineMetric, opts.direction, results, noiseFloor, opts.strategies);
    const winner = winnerIndex !== null ? ranked.find((r) => r.index === winnerIndex) ?? null : null;
    const winnerResult = winner ? results[winner.index] : null;
    return {
      escaped: winner !== null,
      winner: winner ?? null,
      winnerDiff: winnerResult?.diff ?? "",
      winnerMetric: winner?.medianMetric ?? null,
      ranked,
      results,
    };
  } finally {
    await Promise.all(wts.map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
  }
}
