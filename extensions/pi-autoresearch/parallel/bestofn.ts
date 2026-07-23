/**
 * Best-of-N orchestrator (Mode A).
 *
 * Flow (mirrors ТЗ §9):
 *  0. pre-flight: baseline measure (BENCH_MODE=quick) must fit the budget.
 *  1. provision N worktrees at the baseline commit.
 *  2. fan-out: spawn N worker subagents via RPC (cascade-aware: cheap tier first,
 *     escalate failed candidates to the next tier).
 *  3. collect worker-result.json from each worktree.
 *  4. aggregate: median, noise floor (MAD), rank.
 *  5. selection-bias correction: re-measure the winner on main in BENCH_MODE=full.
 *  6. cleanup worktrees; return { winnerIndex, ranked, finalMetric, decision }.
 *
 * The parent is the sole git mutator and log writer; workers only edit code in
 * their worktree and write a result file — never log_experiment, never touch main.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RpcClient, SpawnedWorker } from "./rpc.ts";
import type { ExecFn } from "./worktree.ts";
import { provisionWorktree, cleanupWorktree, cleanupAllWorktrees, currentHead, resolveRepoRoot, type WorktreeHandle } from "./worktree.ts";
import { median, computeNoiseFloor, rankCandidates, isBetter } from "./aggregate.ts";
import { runMeasure, applyDiff, parseMetricLines } from "./remeasure.ts";
import { sampleCpuLoad, calibrateConcurrency } from "./cpu.ts";
import type { ParallelConfig } from "./config.ts";
import { resolveTier, defaultConcurrency } from "./config.ts";
import type { BenchMode, BestOfNResult, Candidate, Direction, RankedCandidate, Tier, WorkerResult, WorkerStatus } from "./types.ts";

/** Options accepted by the BestOfN tool. */
export interface BestOfNOptions {
  candidates: Candidate[];
  metricName: string;
  direction: Direction;
  metricUnit?: string;
  sessionName?: string;
  agent?: string;
  /** Override model/tier for ALL candidates (cascade still applies on top). */
  modelOverride?: string;
  cascade?: boolean;
  budgetSeconds?: number;
  workerTimeoutMs?: number;
  repeats?: number;
  concurrency?: number;
}

/** Context the orchestrator needs from the extension (injected, not imported). */
export interface OrchestratorContext {
  rpc: RpcClient;
  exec: ExecFn;
  /** A bash-capable runner (resolves Git Bash on Windows). */
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
  repoRoot: string;
  workDir: string;
  config: ParallelConfig;
}

const ESCALATION_ORDER: Tier[] = ["fast", "mid", "strong"];

/** Build the worker task string from a candidate + session context. Pure. */
export function buildWorkerTask(opts: {
  hypothesis: string;
  wtPath: string;
  baselineSha: string;
  metricName: string;
  direction: Direction;
  metricUnit: string;
  sessionName: string;
  budgetSeconds: number;
  benchMode: BenchMode;
  repeats: number;
}): string {
  const { hypothesis, wtPath, baselineSha, metricName, direction, metricUnit, sessionName, budgetSeconds, benchMode, repeats } = opts;
  return [
    `Работай в worktree: ${wtPath}. Baseline commit: ${baselineSha}.`,
    `Гипотеза (реализуй её в коде): ${hypothesis}`,
    `Целевая метрика: ${metricName} (${direction}). Единица: ${metricUnit || "(без единицы)"}.`,
    ``,
    `ШАГИ:`,
    `1. init_experiment(name="${sessionName}", metric_name="${metricName}", metric_unit="${metricUnit || ""}", direction="${direction}") — включает autoresearchMode и открывает run_experiment.`,
    `2. Изучи код в worktree. Реализуй гипотезу правками (read/edit/bash). Не трогай .auto/.`,
    `3. Вызови run_experiment(command="bash .auto/measure.sh", budget_seconds=${budgetSeconds}, bench_mode="${benchMode}") — повтори ${repeats} раз. При budget_exceeded — НЕ логируй, запиши status:"budget_exceeded" в файл результата.`,
    `4. Сформируй diff: git diff ${baselineSha} -- . ':(exclude).auto'`,
    `5. Запиши результат в ${path.join(wtPath, ".auto", "worker-result.json")}:`,
    `   { "diff": "<unified diff>", "metric": <median>, "metrics": [...], "status": "ok"|"budget_exceeded"|"apply_failed"|"crash", "notes": "...", "error"?: "..." }`,
    `6. Заверши работу. НЕ вызывай log_experiment. НЕ мутируй main. НЕ делай git commit.`,
  ].join("\n");
}

/** Read + validate the worker-result.json from a worktree. Tolerant of absence/corruption. */
export function readWorkerResult(wtPath: string): WorkerResult {
  const file = path.join(wtPath, ".auto", "worker-result.json");
  const fallback = (status: WorkerStatus, error: string): WorkerResult => ({ diff: "", metric: null, metrics: [], status, error });
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return fallback("crash", `worker-result.json not found at ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fallback("crash", `worker-result.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const obj = parsed as Partial<WorkerResult>;
  return {
    diff: typeof obj.diff === "string" ? obj.diff : "",
    metric: typeof obj.metric === "number" ? obj.metric : null,
    metrics: Array.isArray(obj.metrics) ? obj.metrics.filter((m): m is number => typeof m === "number") : [],
    status: (["ok", "budget_exceeded", "apply_failed", "worker_timeout", "crash"].includes(obj.status as string) ? obj.status : "crash") as WorkerStatus,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    error: typeof obj.error === "string" ? obj.error : undefined,
    tier: typeof obj.tier === "string" ? obj.tier : undefined,
  };
}

/**
 * Await a worker's completion by polling for worker-result.json, with an overall
 * timeout. On timeout, interrupt the run and return a worker_timeout result.
 */
export async function collectWorker(
  ctx: OrchestratorContext,
  spawned: SpawnedWorker,
  wt: WorktreeHandle,
  workerTimeoutMs: number,
  pollIntervalMs = 2000,
): Promise<WorkerResult> {
  const resultFile = path.join(wt.path, ".auto", "worker-result.json");
  const deadline = Date.now() + workerTimeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      return readWorkerResult(wt.path);
    }
    await sleep(pollIntervalMs);
  }
  // Timed out — interrupt and mark.
  await ctx.rpc.interrupt(spawned.runId).catch(() => {});
  return { diff: "", metric: null, metrics: [], status: "worker_timeout", error: `worker ${spawned.runId} exceeded ${workerTimeoutMs}ms` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run an async mapper over items with a concurrency cap. */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i]!, i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Execute the full Best-of-N flow. Mutates git only on main at step 5 (apply /
 * revert of the winner); all worker activity is isolated in worktrees.
 */
export async function runBestOfN(ctx: OrchestratorContext, opts: BestOfNOptions): Promise<BestOfNResult> {
  const { rpc, exec, runCmd, repoRoot, workDir, config } = ctx;
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;
  const cascade = opts.cascade ?? config.cascade;

  // 0. pre-flight baseline measure (BENCH_MODE=quick) must fit the budget.
  // Sample CPU load concurrently to calibrate concurrency.
  const baselineSha = await currentHead(exec, repoRoot);
  const cpuSampleP = sampleCpuLoad(exec, 500);
  const pre = await runMeasure(exec, workDir, opts.metricName, "quick", budgetSeconds, runCmd);
  const cpuSample = await cpuSampleP.catch(() => null);
  if (pre.timedOut || pre.metric === null) {
    return {
      baselineMetric: NaN,
      winnerIndex: null,
      ranked: [],
      finalMetric: null,
      decision: "discard",
      reason: "baseline_over_budget",
    };
  }
  const baselineMetric = pre.metric;

  // Calibrate concurrency against measured CPU load.
  const requestedConcurrency = opts.concurrency ?? config.concurrency ?? defaultConcurrency();
  const { concurrency: calibratedConcurrency, cpuWarning } = calibrateConcurrency(requestedConcurrency, cpuSample);
  const concurrency = calibratedConcurrency;

  // 0b. clear any worktrees left behind by a crashed/killed previous run so they
  //     don't collide with fresh provisioning (wt-1/2/3 names are reused).
  await cleanupAllWorktrees(exec, repoRoot).catch(() => {});

  // 1. provision worktrees
  const wts: WorktreeHandle[] = [];
  try {
    for (let i = 0; i < opts.candidates.length; i++) {
      wts.push(await provisionWorktree(exec, repoRoot, i + 1, baselineSha));
    }

    // 2+3. fan-out + collect, cascade-aware.
    const tierFor = (c: Candidate) => resolveTier(config, c.complexity);
    const escalateFrom = (tier: Tier): Tier[] => {
      const start = ESCALATION_ORDER.indexOf(tier);
      return cascade ? ESCALATION_ORDER.slice(start < 0 ? 0 : start) : [tier];
    };

    // First tier pass: all candidates at their base tier.
    let pending = opts.candidates.map((c, index) => ({ candidate: c, index }));
    const finalResults: WorkerResult[] = new Array(opts.candidates.length);

    for (let tierRound = 0; tierRound < ESCALATION_ORDER.length && pending.length > 0; tierRound++) {
      // Determine which tier this round uses. With cascade, each candidate has
      // its own tier list; we process the round-th tier of each pending candidate.
      const roundFn = async (item: { candidate: Candidate; index: number }): Promise<void> => {
        const tierList = escalateFrom(tierFor(item.candidate).tier);
        const tierName = tierList[Math.min(tierRound, tierList.length - 1)]!;
        const t = config.complexityMap[tierName] ?? config.complexityMap[config.defaultComplexity];
        const model = opts.modelOverride ?? config.tiers[tierName];
        const repeats = opts.repeats ?? t.repeats;
        const workerTimeoutMs = opts.workerTimeoutMs ?? t.workerTimeoutMs;

        const wt = wts[item.index]!;
        const task = buildWorkerTask({
          hypothesis: item.candidate.hypothesis,
          wtPath: wt.path, baselineSha,
          metricName: opts.metricName, direction: opts.direction, metricUnit: opts.metricUnit ?? "",
          sessionName: opts.sessionName ?? "parallel-bestofn",
          budgetSeconds, benchMode: config.workerBenchMode, repeats,
        });
        const spawned = await rpc.spawn({
          agent: opts.agent ?? "worker",
          task, cwd: wt.path, model,
          output: path.join(wt.path, ".auto", "worker-result.json"),
          outputMode: "file-only",
          context: "fresh",
        }, Math.max(30_000, workerTimeoutMs + 60_000));
        const result = await collectWorker(ctx, spawned, wt, workerTimeoutMs);
        result.tier = tierName;
        finalResults[item.index] = result;
      };
      await mapWithConcurrency(pending, concurrency, roundFn);

      // Keep candidates whose result is terminal-ok or non-escalatable; carry the
      // rest (apply_failed/crash/worker_timeout) to the next tier round.
      pending = pending.filter((item) => {
        const r = finalResults[item.index];
        if (!r) return true;
        const escalateStatus: WorkerStatus[] = cascade ? ["apply_failed", "crash", "worker_timeout"] : [];
        return escalateStatus.includes(r.status);
      });
    }
    // Any candidate still missing a result (shouldn't happen) → crash.
    for (let i = 0; i < finalResults.length; i++) {
      if (!finalResults[i]) finalResults[i] = { diff: "", metric: null, metrics: [], status: "crash", error: "no_result" };
    }

    // 4. aggregate
    const noiseFloor = computeNoiseFloor(finalResults);
    const labels = opts.candidates.map((c, i) => c.label ?? `Hypothesis #${i + 1}`);
    const { ranked, winnerIndex } = rankCandidates(baselineMetric, opts.direction, finalResults, noiseFloor, labels);

    if (winnerIndex === null) {
      const reason = finalResults.some((r) => r.status === "ok") ? "all_within_noise_or_regressed" : "all_failed";
      return { baselineMetric, winnerIndex: null, ranked, finalMetric: null, decision: "discard", reason };
    }

    // 5. selection-bias correction: cascade re-measure in worktrees (full mode).
    //    Re-measure candidates best-first IN THEIR WORKTREES; the FIRST that
    //    confirms a genuine improvement (above noise floor) wins. Main workdir
    //    is never touched during measurement. If #1 fails, try #2, #3...
    const remeasure: Array<{ index: number; decision: "keep" | "discard" | "skip"; finalMetric: number | null; reason?: string }> = [];
    let confirmedIndex: number | null = null;
    let confirmedMetric: number | null = null;
    let confirmedSummary: string | undefined;
    for (const candidate of ranked) {
      const result = finalResults[candidate.index]!;
      if (candidate.status !== "ok" || !result.diff.trim()) {
        remeasure.push({ index: candidate.index, decision: "skip", finalMetric: null, reason: "no_valid_diff" });
        continue;
      }
      // Skip candidates whose quick metric is not better than baseline.
      if (candidate.medianMetric !== null && !isBetter(candidate.medianMetric, baselineMetric, opts.direction)) {
        remeasure.push({ index: candidate.index, decision: "skip", finalMetric: null, reason: "not_better_than_baseline" });
        continue;
      }
      const wt = wts[candidate.index];
      if (!wt) {
        remeasure.push({ index: candidate.index, decision: "skip", finalMetric: null, reason: "worktree_gone" });
        continue;
      }
      // Re-measure in the worktree (full mode) — main workdir stays clean.
      const m = await runMeasure(exec, wt.path, opts.metricName, "full", budgetSeconds, runCmd);
      if (m.metric === null || m.timedOut) {
        remeasure.push({ index: candidate.index, decision: "discard", finalMetric: null, reason: "measure_failed" });
        continue;
      }
      const better = opts.direction === "lower" ? m.metric < baselineMetric : m.metric > baselineMetric;
      const beyondNoise = Math.abs(m.metric - baselineMetric) > noiseFloor;
      if (better && beyondNoise) {
        confirmedIndex = candidate.index;
        confirmedMetric = m.metric;
        confirmedSummary = truncateDiffSummary(result.diff);
        remeasure.push({ index: candidate.index, decision: "keep", finalMetric: m.metric });
        break; // first survivor wins — stop testing further candidates
      }
      remeasure.push({ index: candidate.index, decision: "discard", finalMetric: m.metric, reason: beyondNoise ? "regression" : "within_noise" });
    }

    // If a winner was confirmed in a worktree, apply its diff to main now.
    if (confirmedIndex !== null) {
      const winnerResult = finalResults[confirmedIndex]!;
      try {
        await applyDiff(exec, workDir, winnerResult.diff);
      } catch {
        // apply failed — winner stays in worktree only
        confirmedIndex = null;
        confirmedMetric = null;
      }
    }

    return {
      baselineMetric,
      winnerIndex: confirmedIndex,
      ranked,
      finalMetric: confirmedMetric,
      decision: confirmedIndex !== null ? "keep" : "discard",
      reason: confirmedIndex !== null ? undefined : "none_confirmed_on_remeasure",
      appliedDiffSummary: confirmedSummary,
      cpuWarning,
      remeasure,
    };
  } finally {
    // 6. cleanup worktrees (best-effort, never throws out of finally).
    await Promise.all(wts.map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
  }
}

function truncateDiffSummary(diff: string): string {
  const files = diff.split("\n").filter((l) => l.startsWith("diff --git")).slice(0, 10);
  return files.length ? `${files.length} file(s): ` + files.map((l) => l.replace("diff --git ", "")).join(", ") : "(no files)";
}

// Re-export for the tool layer.
export { isBetter, median };
export type { RankedCandidate };
export { parseMetricLines };
