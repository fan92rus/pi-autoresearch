/**
 * Parallel-mode configuration: model tiers, complexity map, cascade.
 *
 * Loaded from .auto/config.json under the "parallel" key. All fields optional;
 * defaults keep parallel exploration cheap (fast tier, cascade on).
 */

import type { Complexity, Tier } from "./types.ts";

export interface ComplexityConfig {
  tier: Tier;
  /** Worker wall-clock budget in ms for this complexity. */
  workerTimeoutMs: number;
  /** Measurement repeats (median-of-N). */
  repeats: number;
}

export interface ParallelConfig {
  tiers: Record<Tier, string>;
  complexityMap: Record<Complexity, ComplexityConfig>;
  cascade: boolean;
  defaultTier: Tier;
  defaultComplexity: Complexity;
  /** Parallelism cap. Default min(CPU-1, 4). */
  concurrency?: number;
  /** Per-run_experiment measure budget in seconds (workers + re-measure). */
  budgetSeconds: number;
  /** BENCH_MODE for worker measurements. */
  workerBenchMode: "quick";
  /** BENCH_MODE for the parent's winner re-measure. */
  finalBenchMode: "full";
}

export const DEFAULT_CONFIG: ParallelConfig = {
  tiers: {
    fast: "opencode-go/deepseek-v4-flash:low",
    mid: "opencode-go/deepseek-v4-flash:xhigh",
    strong: "zai-glm/glm-5.2:high",
  },
  complexityMap: {
    simple: { tier: "fast", workerTimeoutMs: 300_000, repeats: 1 },
    medium: { tier: "mid", workerTimeoutMs: 600_000, repeats: 3 },
    hard: { tier: "strong", workerTimeoutMs: 900_000, repeats: 3 },
  },
  cascade: true,
  defaultTier: "fast",
  defaultComplexity: "medium",
  budgetSeconds: 300,
  workerBenchMode: "quick",
  finalBenchMode: "full",
};

/** Merge a raw parsed config object onto defaults. Tolerant of missing keys. */
export function resolveConfig(raw: unknown): ParallelConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const obj = raw as Record<string, unknown>;
  const parallel = (obj.parallel ?? {}) as Record<string, unknown>;
  const tiers = { ...DEFAULT_CONFIG.tiers, ...((parallel.tiers ?? {}) as Partial<Record<Tier, string>>) };
  const complexityMap = {
    ...DEFAULT_CONFIG.complexityMap,
    ...((parallel.complexityMap ?? {}) as Partial<Record<Complexity, ComplexityConfig>>),
  };
  return {
    tiers,
    complexityMap,
    cascade: typeof parallel.cascade === "boolean" ? parallel.cascade : DEFAULT_CONFIG.cascade,
    defaultTier: (parallel.defaultTier as Tier) ?? DEFAULT_CONFIG.defaultTier,
    defaultComplexity: (parallel.defaultComplexity as Complexity) ?? DEFAULT_CONFIG.defaultComplexity,
    concurrency: typeof parallel.concurrency === "number" ? parallel.concurrency : undefined,
    budgetSeconds: typeof parallel.budgetSeconds === "number" ? parallel.budgetSeconds : DEFAULT_CONFIG.budgetSeconds,
    workerBenchMode: "quick",
    finalBenchMode: "full",
  };
}

/**
 * Resolve the tier model + budget + repeats for a given complexity (or the default).
 * Used to choose how to spawn each worker.
 */
export function resolveTier(cfg: ParallelConfig, complexity: Complexity | undefined): {
  model: string;
  tier: Tier;
  workerTimeoutMs: number;
  repeats: number;
} {
  const c = complexity ?? cfg.defaultComplexity;
  const cc = cfg.complexityMap[c] ?? cfg.complexityMap[cfg.defaultComplexity];
  const model = cfg.tiers[cc.tier] ?? cfg.tiers[cfg.defaultTier];
  return { model, tier: cc.tier, workerTimeoutMs: cc.workerTimeoutMs, repeats: cc.repeats };
}

/** Default concurrency: min(CPU-1, 4), floored at 1. */
export function defaultConcurrency(): number {
  const cpus = (typeof globalThis !== "undefined" && (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency)
    ?? 4;
  return Math.max(1, Math.min((cpus ?? 4) - 1, 4));
}
