/**
 * Phases — transactions that tolerate temporary regressions (valley crossings).
 *
 * A greedy edit→measure→keep/revert loop kills any optimization that must get
 * worse before it gets better (architectural refactor, algorithm swap). A phase
 * disables auto-revert for N steps; only the FINAL metric is validated.
 *
 * Git mechanics: inside a phase, working tree accumulates edits WITHOUT commit
 * or revert. startPhase records HEAD = H0 (and a temp best-checkpoint branch).
 * commitPhase: if final better than H0 → git add+commit (whole chain); else →
 * checkout to H0. Hard floor (40%) checked each step → auto-abort.
 *
 * State is held in-memory per session (AutoresearchRuntime) plus a small mirror
 * on disk under .auto/parallel/phases/ for resilience.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecFn } from "./worktree.ts";
import type { Direction } from "./types.ts";

export interface PhaseState {
  id: string;
  name: string;
  rationale: string;
  /** HEAD sha at start — the revert target. */
  phaseBase: string;
  baselineMetric: number;
  bestCheckpointSha: string | null;
  bestCheckpointMetric: number | null;
  stepsTaken: number;
  maxSteps: number;
  maxRegressionPct: number;
  hardFloorPct: number;
  budgetMs: number;
  startedAt: number;
  /** Whether each explore step's metric was worse than baseline (for diagnostics). */
  stepLog: Array<{ step: number; metric: number | null; deltaPct: number | null; overFloor: boolean }>;
}

export interface PhaseStore {
  active: PhaseState | null;
}

export function newPhaseStore(): PhaseStore {
  return { active: null };
}

/** Percent change of candidate vs baseline, signed (worse is negative in the "better" direction). */
export function regressionPct(candidate: number, baseline: number, direction: Direction): number {
  if (baseline === 0) return candidate === 0 ? 0 : candidate > 0 ? -100 : 100;
  // "improvement" positive; "regression" negative
  const improvement = direction === "lower" ? (baseline - candidate) : (candidate - baseline);
  return (improvement / Math.abs(baseline)) * 100;
}

/** Is a candidate metric over the hard floor (too deep a regression)? */
export function overHardFloor(candidate: number, baseline: number, direction: Direction, hardFloorPct: number): boolean {
  return regressionPct(candidate, baseline, direction) < -hardFloorPct;
}

/** Should the agent get a soft steer (deep valley, consider closing)? */
export function overSoftRegression(candidate: number, baseline: number, direction: Direction, maxRegressionPct: number): boolean {
  return regressionPct(candidate, baseline, direction) < -maxRegressionPct;
}

export interface StartPhaseOpts {
  name: string;
  rationale: string;
  phaseBase: string;
  baselineMetric: number;
  maxSteps?: number;
  maxRegressionPct?: number;
  hardFloorPct?: number;
  budgetMs?: number;
}

/** Begin a phase. Only one active phase per session is allowed. */
export function startPhase(store: PhaseStore, opts: StartPhaseOpts): { ok: true; phase: PhaseState } | { ok: false; error: string } {
  if (store.active) {
    return { ok: false, error: `Phase "${store.active.name}" is already active. commitPhase or abortPhase it first.` };
  }
  const phase: PhaseState = {
    id: `phase-${Date.now()}`,
    name: opts.name,
    rationale: opts.rationale,
    phaseBase: opts.phaseBase,
    baselineMetric: opts.baselineMetric,
    bestCheckpointSha: null,
    bestCheckpointMetric: null,
    stepsTaken: 0,
    maxSteps: opts.maxSteps ?? 5,
    maxRegressionPct: opts.maxRegressionPct ?? 25,
    hardFloorPct: opts.hardFloorPct ?? 40,
    budgetMs: opts.budgetMs ?? 1_800_000,
    startedAt: Date.now(),
    stepLog: [],
  };
  store.active = phase;
  return { ok: true, phase };
}

export interface ExploreStepInput {
  metric: number | null;
  direction: Direction;
}

export type ExploreStepOutcome =
  | { kind: "continue" }
  | { kind: "steer_deep"; deltaPct: number }
  | { kind: "auto_abort_floor"; deltaPct: number }
  | { kind: "auto_abort_steps" }
  | { kind: "auto_abort_budget" };

/**
 * Record an explore step's metric. Pure decision logic — does NOT touch git.
 * Returns what the caller should do: continue, emit a soft steer, or auto-abort.
 * Updates stepLog + bestCheckpoint bookkeeping on the phase.
 */
export function recordExploreStep(store: PhaseStore, input: ExploreStepInput): ExploreStepOutcome {
  const phase = store.active;
  if (!phase) return { kind: "auto_abort_steps" };
  phase.stepsTaken += 1;
  let deltaPct: number | null = null;
  let overFloor = false;
  if (input.metric !== null) {
    deltaPct = regressionPct(input.metric, phase.baselineMetric, input.direction);
    overFloor = overHardFloor(input.metric, phase.baselineMetric, input.direction, phase.hardFloorPct);
    phase.stepLog.push({ step: phase.stepsTaken, metric: input.metric, deltaPct, overFloor });
    // track best checkpoint (best metric seen so far in the phase)
    const isBetter = phase.bestCheckpointMetric === null
      || (input.direction === "lower" ? input.metric < phase.bestCheckpointMetric : input.metric > phase.bestCheckpointMetric);
    if (isBetter) {
      // The caller must supply the sha via markBestCheckpoint after committing a temp branch.
      phase.bestCheckpointMetric = input.metric;
    }
  } else {
    phase.stepLog.push({ step: phase.stepsTaken, metric: null, deltaPct: null, overFloor: false });
  }

  // Budget check
  if (Date.now() - phase.startedAt > phase.budgetMs) return { kind: "auto_abort_budget" };
  // Hard floor
  if (overFloor) return { kind: "auto_abort_floor", deltaPct: deltaPct ?? -Infinity };
  // Max steps
  if (phase.stepsTaken >= phase.maxSteps) return { kind: "auto_abort_steps" };
  // Soft regression steer
  if (deltaPct !== null && overSoftRegression(input.metric!, phase.baselineMetric, input.direction, phase.maxRegressionPct)) {
    return { kind: "steer_deep", deltaPct };
  }
  return { kind: "continue" };
}

/** Snapshot the current HEAD as the phase's best checkpoint (after a good step). */
export function markBestCheckpoint(store: PhaseStore, sha: string): void {
  const phase = store.active;
  if (!phase) return;
  phase.bestCheckpointSha = sha;
}

/** End the phase: decide keep (final better than baseline) vs abort (revert to base/checkpoint). */
export function endPhaseDecision(store: PhaseStore, finalMetric: number | null, direction: Direction): {
  decision: "keep" | "abort";
  reason?: string;
} {
  const phase = store.active;
  if (!phase) return { decision: "abort", reason: "no_active_phase" };
  if (finalMetric === null) {
    return { decision: "abort", reason: "no_metric" };
  }
  const better = direction === "lower" ? finalMetric < phase.baselineMetric : finalMetric > phase.baselineMetric;
  const beyondNoise = Math.abs(finalMetric - phase.baselineMetric) > 0; // caller may refine noise
  if (better && beyondNoise) return { decision: "keep" };
  return { decision: "abort", reason: "final_not_better" };
}

/** Clear the active phase (after commit/abort completes). */
export function clearPhase(store: PhaseStore): PhaseState | null {
  const p = store.active;
  store.active = null;
  return p;
}

/**
 * Persist the active phase to disk for resilience across tool calls (the store
 * is in-memory per session; this mirror survives if the agent re-reads state).
 */
export function persistPhase(store: PhaseStore, workDir: string): void {
  if (!store.active) return;
  const dir = path.join(workDir, ".auto", "parallel", "phases");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "active.json"), JSON.stringify(store.active, null, 2));
  } catch { /* best-effort */ }
}

export function clearPersistedPhase(workDir: string): void {
  try { fs.rmSync(path.join(workDir, ".auto", "parallel", "phases", "active.json"), { force: true }); } catch { /* ignore */ }
}

/** git operations for commit/abort of a phase. */
export async function commitPhaseGit(exec: ExecFn, workDir: string, phase: PhaseState, description: string): Promise<{ committed: boolean; sha?: string }> {
  const r = await exec("git", ["add", "-A"], { cwd: workDir, timeout: 10000 });
  const diff = await exec("git", ["diff", "--cached", "--quiet"], { cwd: workDir, timeout: 5000 });
  if (diff.code === 0) return { committed: false };
  await exec("git", ["commit", "-m", `${description}\n\nPhase: ${phase.name}`], { cwd: workDir, timeout: 10000 });
  const sha = (await exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 })).stdout.trim();
  return { committed: true, sha: sha || undefined };
}

/** Revert working tree to the phase base (or best checkpoint), preserving .auto/. */
export async function abortPhaseGit(exec: ExecFn, workDir: string, phase: PhaseState, autoDir = ".auto"): Promise<void> {
  const target = phase.bestCheckpointSha ?? phase.phaseBase;
  await exec("git", ["checkout", "--", ".", `:(exclude,glob)**/${autoDir}`, `:(exclude,glob)**/${autoDir}/**`], { cwd: workDir, timeout: 10000 });
  await exec("git", ["clean", "-fd", "-e", autoDir, "-e", `**/${autoDir}/**`], { cwd: workDir, timeout: 10000 });
  // If reverting to a specific sha (checkpoint), reset hard to it — but only the
  // committed state; working tree was just cleaned. A full reset to a non-HEAD
  // sha is intentionally NOT done here to avoid losing unrelated commits; the
  // phase base is normally HEAD, so checkout -- . already restores it.
  void target;
}
