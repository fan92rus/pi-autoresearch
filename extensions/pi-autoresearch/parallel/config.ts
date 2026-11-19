/**
 * Legacy parallel-policy configuration: model tiers plus inert policy storage.
 *
 * Loaded from .auto/config.json under the "parallel" key (legacy namespace
 * kept as campaign-policy storage; the parallel fan-out machinery was removed
 * — bd pi-autoresearch-el3.4). All fields optional in the raw config.
 */

import type { Tier } from "./types.ts";

export interface ParallelConfig {
  tiers: Record<Tier, string>;
  /**
   * Legacy-inactive policy field: the config UI still stores and displays it,
   * but no runtime behavior reads it. No workers are launched.
   */
  concurrency?: number;
  /**
   * Legacy-inactive policy field: the config UI still stores and displays it.
   * No runtime reader and no measurement enforcement are attached to it.
   */
  budgetSeconds: number;
}

export const DEFAULT_CONFIG: ParallelConfig = {
  tiers: {
    fast: "opencode-go/deepseek-v4-flash:low",
    mid: "opencode-go/deepseek-v4-flash:xhigh",
    strong: "zai-glm/glm-5.2:high",
  },
  budgetSeconds: 300,
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
  return {
    tiers,
    concurrency: typeof parallel.concurrency === "number" ? parallel.concurrency : undefined,
    budgetSeconds: typeof parallel.budgetSeconds === "number" ? parallel.budgetSeconds : DEFAULT_CONFIG.budgetSeconds,
  };
}
