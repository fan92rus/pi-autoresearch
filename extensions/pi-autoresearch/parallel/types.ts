/**
 * Shared types for pi-autoresearch parallel modes (best-of-N, stack, space-search).
 *
 * These describe the data flowing between the parent agent (which calls the
 * parallel tools) and the worker subagents (which run in isolated worktrees).
 */

/** Optimization direction. */
export type Direction = "lower" | "higher";

/** BENCH_MODE convention: workers measure with a fast subset, parent re-measures the winner in full. */
export type BenchMode = "quick" | "full" | "smoke";

/** Model tier name (resolved from .auto/config.json parallel.tiers). */
export type Tier = "fast" | "mid" | "strong";

/** Agent-assessed complexity of a hypothesis; maps to a tier + budget + repeats. */
export type Complexity = "simple" | "medium" | "hard";

/** A candidate hypothesis — plain text the worker implements in code. */
export interface Candidate {
  /** Free-text hypothesis the worker realizes as code edits. */
  hypothesis: string;
  /** Optional label for logging; defaults to `Hypothesis #<index>`. */
  label?: string;
  /** Agent-assessed complexity tag (drives tier/budget/repeats). Optional; defaults to config. */
  complexity?: Complexity;
}

/** Status of a single worker's outcome. */
export type WorkerStatus =
  | "ok"                // measured successfully
  | "budget_exceeded"   // measure.sh over budget (do not escalate the model — fix measure.sh)
  | "apply_failed"      // edits did not apply / did not compile
  | "worker_timeout"    // wall-clock worker budget exceeded
  | "crash";            // worker process crashed / unexpected error

/** Structured result a worker writes to .auto/worker-result.json. */
export interface WorkerResult {
  /** Unified diff relative to the baseline commit (excludes .auto/). */
  diff: string;
  /** Median of the repeated measurements (null when status != ok). */
  metric: number | null;
  /** All repeated measurements, for noise estimation. */
  metrics: number[];
  status: WorkerStatus;
  /** What the worker did, briefly. */
  notes?: string;
  /** Error text when status indicates failure. */
  error?: string;
  /** Which tier/model produced this result (for cascade logging). */
  tier?: string;
}

/** A candidate + its measured result, after aggregation. */
export interface RankedCandidate {
  index: number;
  label: string;
  metric: number | null;
  medianMetric: number | null;
  status: WorkerStatus;
  /** Improvement vs baseline (signed, in the direction of "better is positive"). */
  improvement: number | null;
  /** True if |improvement| < noise floor — cannot be distinguished from noise. */
  within_noise: boolean;
  notes?: string;
  error?: string;
  tier?: string;
}

/** Result returned by the BestOfN tool. */
export interface BestOfNResult {
  baselineMetric: number;
  winnerIndex: number | null;
  ranked: RankedCandidate[];
  /** Final metric after re-measuring the winner on main (BENCH_MODE=full). null if none kept. */
  finalMetric: number | null;
  decision: "keep" | "discard";
  reason?: string;
  appliedDiffSummary?: string;
  /** Advisory: parallelism was limited by CPU contention. */
  cpuWarning?: string;
  /** Per-candidate selection-bias re-measure results (cascade). */
  remeasure?: Array<{ index: number; decision: "keep" | "discard" | "skip"; finalMetric: number | null; reason?: string }>;
}
