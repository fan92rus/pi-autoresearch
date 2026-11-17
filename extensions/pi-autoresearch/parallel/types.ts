/**
 * Shared types for pi-autoresearch campaign policy (legacy "parallel" config
 * namespace, kept for tree/expedition aggregation).
 *
 * The parallel fan-out machinery (BestOfN/SpaceSearch workers, worker-result
 * plumbing) was removed — bd pi-autoresearch-el3.4; the worker-facing types
 * (Candidate/WorkerStatus/WorkerResult/RankedCandidate/BestOfNResult) are gone.
 */

/** Optimization direction. */
export type Direction = "lower" | "higher";

/** Model tier name (resolved from .auto/config.json parallel.tiers). */
export type Tier = "fast" | "mid" | "strong";

/** Agent-assessed complexity of a hypothesis; maps to a tier + budget + repeats. */
export type Complexity = "simple" | "medium" | "hard";
