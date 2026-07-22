/**
 * Pure aggregation logic for parallel modes: median, MAD, noise floor, ranking.
 *
 * Deliberately free of I/O and of the `pi` API so it can be unit-tested directly.
 * These are the same statistics pi-autoresearch already uses for confidence
 * scoring (MAD as the noise estimator), applied to best-of-N candidate ranking.
 */

import type { Direction, RankedCandidate, WorkerResult } from "./types.ts";

/** Median of a numeric array (0 for empty; the middle value, avg of the two middles for even length). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Median Absolute Deviation — a robust noise estimator.
 * Used as the noise floor: improvements smaller than MAD cannot be trusted.
 */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

/** Returns true if `candidate` is better than `baseline` in the given direction. */
export function isBetter(candidate: number, baseline: number, direction: Direction): boolean {
  return direction === "lower" ? candidate < baseline : candidate > baseline;
}

/**
 * Signed improvement in the direction of "better is positive".
 *   lower-direction: baseline - candidate   (faster → positive)
 *   higher-direction: candidate - baseline  (bigger → positive)
 */
export function signedImprovement(candidate: number, baseline: number, direction: Direction): number {
  return direction === "lower" ? baseline - candidate : candidate - baseline;
}

/**
 * Rank worker results against a baseline.
 *
 * - Only status==="ok" candidates with a real metric are rankable.
 * - `within_noise` marks candidates whose |improvement| < noiseFloor; they are
 *   excluded from winning (a "win" indistinguishable from noise is not a win).
 * - Rank order: better metric first; ties broken by larger |improvement|.
 *   Non-ok and within-noise candidates sort after all clear winners, preserving
 *   their relative order for display/logging.
 *
 * Returns the sorted array; `winnerIndex` is index 0 if it is a clear (ok, non-noise) winner,
 * otherwise null — meaning nothing beat the baseline beyond noise.
 */
export function rankCandidates(
  baseline: number,
  direction: Direction,
  results: WorkerResult[],
  noiseFloor: number,
  labels?: string[],
): { ranked: RankedCandidate[]; winnerIndex: number | null } {
  const medianMetrics = results.map((r) => (r.status === "ok" && r.metric !== null ? r.metric : null));

  const ranked: RankedCandidate[] = results.map((r, index) => {
    const med = medianMetrics[index];
    const improvement = med !== null ? signedImprovement(med, baseline, direction) : null;
    const within_noise = improvement !== null && Math.abs(improvement) < noiseFloor;
    return {
      index,
      label: labels?.[index] ?? r.notes?.slice(0, 40) ?? `Hypothesis #${index + 1}`,
      metric: r.metrics.length ? median(r.metrics) : med,
      medianMetric: med,
      status: r.status,
      improvement,
      within_noise,
      notes: r.notes,
      error: r.error,
      tier: r.tier,
    };
  });

  // Sort: clear winners first (ok, improved beyond noise), best metric first;
  // then within-noise ok candidates; then failures (stable order).
  ranked.sort((a, b) => {
    const aClear = a.status === "ok" && a.medianMetric !== null && !a.within_noise && (a.improvement ?? -Infinity) > 0;
    const bClear = b.status === "ok" && b.medianMetric !== null && !b.within_noise && (b.improvement ?? -Infinity) > 0;
    if (aClear && !bClear) return -1;
    if (!aClear && bClear) return 1;
    if (aClear && bClear) {
      // both clear winners — better metric wins
      return direction === "lower"
        ? (a.medianMetric! - b.medianMetric!)
        : (b.medianMetric! - a.medianMetric!);
    }
    // neither is a clear winner — keep stable-ish order by status then index
    const aOk = a.status === "ok" ? 0 : 1;
    const bOk = b.status === "ok" ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    return a.index - b.index;
  });

  const top = ranked[0];
  const topClear = top && top.status === "ok" && !top.within_noise && (top.improvement ?? -Infinity) > 0;
  return { ranked, winnerIndex: topClear ? top!.index : null };
}

/**
 * Compute the noise floor from all ok candidate medians.
 * Falls back to 0 (exact) when fewer than 2 ok candidates, so a single clear
 * improvement can still win — but callers should prefer re-measuring it in full.
 */
export function computeNoiseFloor(results: WorkerResult[]): number {
  const okMedians = results
    .filter((r) => r.status === "ok" && r.metric !== null)
    .map((r) => r.metric!);
  return okMedians.length >= 2 ? mad(okMedians) : 0;
}
