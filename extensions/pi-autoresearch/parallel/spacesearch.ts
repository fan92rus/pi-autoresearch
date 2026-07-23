/**
 * Space search (Mode C, ТЗ §11 + §11.5 М3) — stateful beam search.
 *
 * Maintains K diverse states (the beam). Each step, for each state spawn M
 * candidate workers (with diversity hints), measure (BENCH_MODE=quick), then
 * prune to the top-K globally — but with regression-lookahead: a beam may
 * regress up to `allowedRegressionSteps` before being pruned, so valley
 * crossings survive (otherwise beam degrades to greedy).
 *
 * State persists in .auto/parallel/beam.json so the agent can drive step → step.
 * finish(): cherry-pick the best state's commit chain into main, re-measure (full).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RpcClient, SpawnedWorker } from "./rpc.ts";
import type { ExecFn } from "./worktree.ts";
import { provisionWorktree, cleanupWorktree, cleanupAllWorktrees, currentHead, type WorktreeHandle } from "./worktree.ts";
import { runMeasure } from "./remeasure.ts";
import { cascadeReMeasure, type ReMeasureCandidate } from "./remeasure.ts";
import { isBetter } from "./aggregate.ts";
import type { ParallelConfig } from "./config.ts";
import { defaultConcurrency } from "./config.ts";
import { buildWorkerTask, readWorkerResult, collectWorker } from "./bestofn.ts";
import type { BenchMode, Direction } from "./types.ts";

export interface BeamState {
  commit: string;
  metric: number;
  parentCommit: string | null;
  hypothesis: string;
  depth: number;
  /** Consecutive regression steps without improvement (for lookahead pruning). */
  regressionStreak: number;
  /** Path to the worktree where this state was created (for finishBeam re-measure). */
  worktreePath?: string;
}

export interface Beam {
  beamWidth: number;
  candidatesPerState: number;
  diversityHints: string[];
  direction: Direction;
  metricName: string;
  states: BeamState[];
  step: number;
}

export interface SpaceSearchContext {
  rpc: RpcClient;
  exec: ExecFn;
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
  repoRoot: string;
  workDir: string;
  config: ParallelConfig;
  /** Optional progress reporter for UI feedback. */
  onProgress?: (msg: string) => void;
}

export interface SpaceSearchOptions {
  beamWidth?: number;
  candidatesPerState?: number;
  diversityHints?: string[];
  metricName: string;
  direction: Direction;
  metricUnit?: string;
  sessionName?: string;
  agent?: string;
  modelOverride?: string;
  budgetSeconds?: number;
  /** Allowed consecutive regression steps before pruning a beam (lookahead). */
  allowedRegressionSteps?: number;
}

const BEAM_FILE = ".auto/parallel/beam.json";

function beamPath(workDir: string): string {
  return path.join(workDir, BEAM_FILE);
}

export function loadBeam(workDir: string): Beam | null {
  try {
    const p = beamPath(workDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Beam;
  } catch {
    return null;
  }
}

export function saveBeam(workDir: string, beam: Beam): void {
  try {
    fs.mkdirSync(path.dirname(beamPath(workDir)), { recursive: true });
    fs.writeFileSync(beamPath(workDir), JSON.stringify(beam, null, 2));
  } catch { /* best-effort */ }
}

export function clearBeam(workDir: string): void {
  try { fs.rmSync(beamPath(workDir), { force: true }); } catch { /* ignore */ }
}

/** Initialize the beam from the current baseline. */
export async function initBeam(ctx: SpaceSearchContext, opts: SpaceSearchOptions): Promise<{ ok: true; beam: Beam } | { ok: false; error: string; reason?: string }> {
  const { exec, runCmd, repoRoot, workDir, config } = ctx;
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;
  const baselineSha = await currentHead(exec, repoRoot);
  const pre = await runMeasure(exec, workDir, opts.metricName, "quick", budgetSeconds, runCmd);
  if (pre.timedOut || pre.metric === null) {
    return { ok: false, error: "baseline measure failed or over budget", reason: "baseline_over_budget" };
  }
  const beam: Beam = {
    beamWidth: opts.beamWidth ?? 3,
    candidatesPerState: opts.candidatesPerState ?? 3,
    diversityHints: opts.diversityHints ?? ["inline", "cache", "algorithm"],
    direction: opts.direction,
    metricName: opts.metricName,
    states: [{ commit: baselineSha, metric: pre.metric, parentCommit: null, hypothesis: "baseline", depth: 0, regressionStreak: 0 }],
    step: 0,
  };
  saveBeam(workDir, beam);
  return { ok: true, beam };
}

/** Advance the beam one step: spawn M×K candidates, prune to top-K with lookahead. */
export async function stepBeam(ctx: SpaceSearchContext, opts: SpaceSearchOptions): Promise<{ ok: true; beam: Beam; improved: boolean; converged: boolean } | { ok: false; error: string }> {
  const { rpc, exec, repoRoot, workDir, config } = ctx;
  const progress = ctx.onProgress ?? (() => {});
  const beam = loadBeam(workDir);
  if (!beam) return { ok: false, error: "No beam. Call action=init first." };

  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;
  const benchMode: BenchMode = config.workerBenchMode;
  const allowedRegressionSteps = opts.allowedRegressionSteps ?? 1;
  const hints = beam.diversityHints;
  const M = beam.candidatesPerState;

  const bestBefore = beam.states.reduce((acc, s) => (isBetter(s.metric, acc, beam.direction) ? s.metric : acc), beam.states[0]!.metric);

  // For each state, spawn M candidates from that state's commit.
  const candidates: Array<{ parent: BeamState; state: BeamState }> = [];
  const wts: WorktreeHandle[] = [];
  let wtIdx = 0;
  try {
    // clear leftovers from a crashed previous run (wt-* names are reused)
    await cleanupAllWorktrees(exec, repoRoot).catch(() => {});
    progress(`Step ${beam.step + 1}: spawning ${beam.states.length * M} workers (${beam.states.length} states × ${M} candidates, concurrency=${config.concurrency ?? defaultConcurrency()})...`);
    const tasks: Array<Promise<void>> = [];
    for (const state of beam.states) {
      for (let j = 0; j < M; j++) {
        const idx = wtIdx++;
        wts.push(null as unknown as WorktreeHandle); // placeholder, filled in task
        const hint = hints[j % hints.length]!;
        tasks.push((async () => {
          const wt = await provisionWorktree(exec, repoRoot, idx + 1, state.commit);
          wts[idx] = wt;
          const model = opts.modelOverride ?? config.tiers[config.defaultTier];
          const task = buildWorkerTask({
            hypothesis: `Подход: ${hint}. Улучши метрику "${beam.metricName}" (направление: ${beam.direction}).`,
            wtPath: wt.path, baselineSha: state.commit,
            metricName: beam.metricName, direction: beam.direction, metricUnit: opts.metricUnit ?? "",
            sessionName: opts.sessionName ?? "parallel-spacesearch",
            budgetSeconds, benchMode, repeats: 1,
            workerTimeoutMs: config.complexityMap[config.defaultComplexity].workerTimeoutMs,
          });
          const spawned: SpawnedWorker = await rpc.spawn({ agent: opts.agent ?? "worker", task, cwd: wt.path, model, output: path.join(wt.path, ".auto", "worker-result.json"), outputMode: "file-only", context: "fresh" });
          const result = await collectWorker(ctx, spawned, wt, config.complexityMap[config.defaultComplexity].workerTimeoutMs);
          // Worker doesn't call log_experiment (no git commit). We commit its
          // changes in the worktree so HEAD advances and finishBeam can
          // cherry-pick the chain onto main.
          await exec("git", ["add", "-A"], { cwd: wt.path, timeout: 10000 }).catch(() => {});
          const diffCheck = await exec("git", ["diff", "--cached", "--quiet"], { cwd: wt.path, timeout: 5000 });
          if (diffCheck.code !== 0) {
            // There are staged changes — commit them so HEAD advances
            await exec("git", ["commit", "-m", `spacesearch-step: ${hint.slice(0, 60)}`], { cwd: wt.path, timeout: 10000 }).catch(() => {});
          }
          const newHead = (await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: wt.path, timeout: 5000 })).stdout.trim();
          if (result.status === "ok" && result.metric !== null && newHead) {
            const regressed = !isBetter(result.metric, state.metric, beam.direction);
            candidates.push({
              parent: state,
              state: { commit: newHead, metric: result.metric, parentCommit: state.commit, hypothesis: hint, depth: state.depth + 1, regressionStreak: regressed ? state.regressionStreak + 1 : 0, worktreePath: wt.path },
            });
          } else {
            // Candidate failed — cleanup its worktree immediately
            await cleanupWorktree(exec, repoRoot, wt).catch(() => {});
          }
        })());
      }
    }
    // Run with bounded concurrency.
    const concurrency = Math.min(config.concurrency ?? defaultConcurrency(), tasks.length);
    const runBatch = async (items: Promise<void>[], n: number): Promise<void> => {
      let i = 0;
      const ws: Promise<void>[] = [];
      for (let w = 0; w < Math.max(1, n); w++) ws.push((async () => { while (i < items.length) { const t = items[i++]; await t; } })());
      await Promise.all(ws);
    };
    await runBatch(tasks, concurrency);

    // Prune: keep current beam + candidates, sort by metric, take top-K with
    // regression-lookahead (drop a state only after allowedRegressionSteps).
    const pool: BeamState[] = [...beam.states, ...candidates.map((c) => c.state)];
    pool.sort((a, b) => (beam.direction === "lower" ? a.metric - b.metric : b.metric - a.metric));
    const survivors: BeamState[] = [];
    for (const s of pool) {
      if (survivors.length >= beam.beamWidth) break;
      // Prune a deeply-regressing state (lookahead exhausted) unless it's still top.
      if (s.regressionStreak > allowedRegressionSteps && survivors.length > 0) continue;
      survivors.push(s);
    }
    beam.states = survivors.length ? survivors : pool.slice(0, beam.beamWidth);
    beam.step += 1;
    saveBeam(workDir, beam);

    // Cleanup worktrees for candidates that didn't make it into the beam.
    // Worktrees for surviving states are kept for finishBeam re-measurement.
    const survivorPaths = new Set(beam.states.map((s) => s.worktreePath).filter((p): p is string => !!p));
    await Promise.all(wts.filter(Boolean).filter((wt) => !survivorPaths.has(wt.path)).map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));

    const bestAfter = beam.states.reduce((acc, s) => (isBetter(s.metric, acc, beam.direction) ? s.metric : acc), beam.states[0]!.metric);
    const improved = isBetter(bestAfter, bestBefore, beam.direction);
    return { ok: true, beam, improved, converged: !improved };
  } catch (e) {
    // On error, cleanup ALL worktrees
    await Promise.all(wts.filter(Boolean).map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
    throw e;
  }
}

/** Finish: re-measure best states in their worktrees (full), cascade to next if not confirmed, cherry-pick winner onto main. */
export async function finishBeam(ctx: SpaceSearchContext, opts: SpaceSearchOptions): Promise<{ finalMetric: number | null; decision: "keep" | "discard"; reason?: string }> {
  const { exec, runCmd, workDir, config, repoRoot } = ctx;
  const progress = ctx.onProgress ?? (() => {});
  const beam = loadBeam(workDir);
  if (!beam) return { finalMetric: null, decision: "discard", reason: "no_beam" };
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;

  // Baseline metric from the baseline state (depth 0).
  const baselineState = beam.states.find((s) => s.depth === 0) ?? beam.states[0]!;
  const baselineMetric = baselineState?.metric ?? Infinity;

  // Sort states best-first; skip states not better than baseline.
  const sortedStates = [...beam.states]
    .filter((s) => s.depth > 0 && isBetter(s.metric, baselineMetric, beam.direction))
    .sort((a, b) => (beam.direction === "lower" ? a.metric - b.metric : b.metric - a.metric));

  if (sortedStates.length === 0) {
    clearBeam(workDir);
    progress(`Finish: no state better than baseline — discarding.`);
    return { finalMetric: null, decision: "discard", reason: "no_state_better_than_baseline" };
  }

  progress(`Finish: cascade re-measure of ${sortedStates.length} candidates (BENCH_MODE=full)...`);

  const noiseFloor = 0; // TODO: compute from beam history if available
  const tempWorktrees: WorktreeHandle[] = [];

  try {
    // Resolve worktreePaths for each state (provision fresh if stale).
    const remeasureCandidates: ReMeasureCandidate[] = [];
    for (const state of sortedStates) {
      let wtPath = state.worktreePath;
      if (!wtPath || !fs.existsSync(wtPath)) {
        const wt = await provisionWorktree(exec, repoRoot, 99 + remeasureCandidates.length, state.commit);
        tempWorktrees.push(wt);
        wtPath = wt.path;
      }
      remeasureCandidates.push({ key: state.commit, quickMetric: state.metric, status: "ok", worktreePath: wtPath, diff: "" });
    }

    const cascade = await cascadeReMeasure(exec, runCmd, {
      candidates: remeasureCandidates,
      metricName: beam.metricName,
      direction: beam.direction,
      baselineMetric,
      noiseFloor,
      budgetSeconds,
    });

    if (cascade.confirmedKey === null) {
      clearBeam(workDir);
      return { finalMetric: null, decision: "discard", reason: "none_confirmed_on_remeasure" };
    }

    // Cherry-pick the confirmed winner's commit chain onto main.
    const confirmedCommit = cascade.confirmedKey as string;
    const confirmedMetric = cascade.confirmedMetric;
    const confirmedState = sortedStates.find((s) => s.commit === confirmedCommit)!;
    const chain: string[] = [];
    let cur: BeamState | null = confirmedState;
    const byCommit = new Map(beam.states.map((s) => [s.commit, s] as const));
    while (cur && cur.parentCommit) {
      chain.unshift(cur.commit);
      cur = byCommit.get(cur.parentCommit) ?? null;
    }
    for (const sha of chain) {
      const r = await exec("git", ["cherry-pick", sha], { cwd: workDir, timeout: 15000 });
      if (r.code !== 0) {
        await exec("git", ["cherry-pick", "--abort"], { cwd: workDir, timeout: 5000 }).catch(() => {});
        clearBeam(workDir);
        return { finalMetric: null, decision: "discard", reason: `cherry_pick_failed: ${sha}` };
      }
    }
    clearBeam(workDir);
    return { finalMetric: confirmedMetric, decision: "keep" };
  } finally {
    // Cleanup all temporary worktrees (surviving worktrees from stepBeam are also cleaned here).
    await Promise.all(tempWorktrees.map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
    await cleanupAllWorktrees(exec, repoRoot).catch(() => {});
  }
}

export function statusBeam(workDir: string): { step: number; states: BeamState[]; beamWidth: number } | null {
  const beam = loadBeam(workDir);
  if (!beam) return null;
  return { step: beam.step, states: beam.states, beamWidth: beam.beamWidth };
}
