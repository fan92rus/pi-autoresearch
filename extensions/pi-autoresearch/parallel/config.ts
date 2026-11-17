/**
 * Parallel-policy configuration: model tiers, complexity map, cascade.
 *
 * Loaded from .auto/config.json under the "parallel" key (legacy namespace
 * kept as campaign-policy storage; the parallel fan-out machinery was removed
 * — bd pi-autoresearch-el3.4). All fields optional.
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
  /** Campaign-policy concurrency cap (legacy parallel field; currently only
   *  surfaced by the /autoresearch config dialog). */
  concurrency?: number;
  /** Per-run_experiment measure budget in seconds. */
  budgetSeconds: number;
  /** BENCH_MODE for ordinary measurements (legacy parallel field). */
  workerBenchMode: "quick";
  /** BENCH_MODE for the winner re-measure (legacy parallel field). */
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
  // Normalize tiers: accept both {fast:"model"} and {fast:{model:"model"}} shapes
  const rawTiers = (parallel.tiers ?? {}) as Record<string, unknown>;
  const tiers = { ...DEFAULT_CONFIG.tiers };
  for (const key of Object.keys(rawTiers)) {
    const val = rawTiers[key];
    if (typeof val === "string") {
      (tiers as Record<string, string>)[key] = val;
    } else if (val && typeof val === "object" && typeof (val as Record<string, unknown>).model === "string") {
      (tiers as Record<string, string>)[key] = (val as Record<string, string>).model;
    }
  }
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

