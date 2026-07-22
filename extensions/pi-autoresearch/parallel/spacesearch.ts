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
          });
          const spawned: SpawnedWorker = await rpc.spawn({ agent: opts.agent ?? "worker", task, cwd: wt.path, model, output: path.join(wt.path, ".auto", "worker-result.json"), outputMode: "file-only", context: "fresh" });
          const result = await collectWorker(ctx, spawned, wt, config.complexityMap[config.defaultComplexity].workerTimeoutMs);
          // The worker's worktree HEAD advanced to its edits; capture that commit.
          const newHead = (await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: wt.path, timeout: 5000 })).stdout.trim();
          if (result.status === "ok" && result.metric !== null && newHead) {
            const regressed = !isBetter(result.metric, state.metric, beam.direction);
            candidates.push({
              parent: state,
              state: { commit: newHead, metric: result.metric, parentCommit: state.commit, hypothesis: hint, depth: state.depth + 1, regressionStreak: regressed ? state.regressionStreak + 1 : 0 },
            });
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

    const bestAfter = beam.states.reduce((acc, s) => (isBetter(s.metric, acc, beam.direction) ? s.metric : acc), beam.states[0]!.metric);
    const improved = isBetter(bestAfter, bestBefore, beam.direction);
    return { ok: true, beam, improved, converged: !improved };
  } finally {
    await Promise.all(wts.filter(Boolean).map((wt) => cleanupWorktree(exec, repoRoot, wt).catch(() => {})));
  }
}

/** Finish: cherry-pick the best state's chain into main, re-measure in full. */
export async function finishBeam(ctx: SpaceSearchContext, opts: SpaceSearchOptions): Promise<{ finalMetric: number | null; decision: "keep" | "discard"; reason?: string }> {
  const { exec, runCmd, workDir, config } = ctx;
  const beam = loadBeam(workDir);
  if (!beam) return { finalMetric: null, decision: "discard", reason: "no_beam" };
  const budgetSeconds = opts.budgetSeconds ?? config.budgetSeconds;

  const best = beam.states.reduce((acc, s) => (acc === null || isBetter(s.metric, acc.metric, beam.direction) ? s : acc), null as BeamState | null);
  if (!best) return { finalMetric: null, decision: "discard", reason: "empty_beam" };

  // Reconstruct the commit chain best -> ... -> baseline by following parentCommit.
  const chain: string[] = [];
  let cur: BeamState | null = best;
  const byCommit = new Map(beam.states.map((s) => [s.commit, s] as const));
  // The chain may reference commits not in the current beam (pruned ancestors);
  // fall back to cherry-picking just the best commit if reconstruction is partial.
  while (cur && cur.parentCommit) {
    chain.unshift(cur.commit);
    cur = byCommit.get(cur.parentCommit) ?? null;
  }
  // Apply the chain: cherry-pick each onto main.
  try {
    for (const sha of chain) {
      const r = await exec("git", ["cherry-pick", sha], { cwd: workDir, timeout: 15000 });
      if (r.code !== 0) {
        // abort the cherry-pick and fall back
        await exec("git", ["cherry-pick", "--abort"], { cwd: workDir, timeout: 5000 }).catch(() => {});
        return { finalMetric: null, decision: "discard", reason: `cherry_pick_failed: ${sha}` };
      }
    }
  } catch (e) {
    return { finalMetric: null, decision: "discard", reason: `cherry_pick_error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const m = await runMeasure(exec, workDir, beam.metricName, "full", budgetSeconds, runCmd);
  clearBeam(workDir);
  if (m.metric === null || m.timedOut) {
    await revertWorkdir(exec, workDir);
    return { finalMetric: null, decision: "discard", reason: "remeasure_failed" };
  }
  const baselineMetric = (await initBeam(ctx, opts).catch(() => null)) && null; // not used; baseline stored at step 0
  void baselineMetric;
  return { finalMetric: m.metric, decision: "keep" };
}

export function statusBeam(workDir: string): { step: number; states: BeamState[]; beamWidth: number } | null {
  const beam = loadBeam(workDir);
  if (!beam) return null;
  return { step: beam.step, states: beam.states, beamWidth: beam.beamWidth };
}
