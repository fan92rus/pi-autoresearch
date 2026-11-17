/**
 * ledger-metrics.ts — pure ledger segment/epoch metric semantics (bd lrx.1,
 * review 2026-11-16-core-loop §2.4).
 *
 * These helpers operate on reconstructed ledger rows (ReconstructedRun-shaped
 * data) and carry the project's most safety-critical invariant: best,
 * baseline and confidence are computed ONLY within one epoch of one segment —
 * a delta across epochs would compare two different scales (spec
 * measurement-track, «Эпохи шкалы и блокировка поперечных сравнений»).
 *
 * Consumed by index.ts (experiment state), exhaustion-hints.ts (segment
 * splitting over raw ledger text) and any future reader of the ledger.
 * Pure functions only: no fs, no pi imports.
 */

/** Structural row shape: ExperimentResult and ReconstructedRun both satisfy it. */
export interface MetricRow {
  segment: number;
  metric: number;
  status: string;
  epoch?: number;
}

/** Direction of optimization shared by run/segment/epoch comparisons. */
export type MetricDirection = "lower" | "higher";

/**
 * The single segment-splitting rule shared by jsonl.ts reconstruct and
 * exhaustion-hints.ts ledger scan (bd lrx.1): a config header starts a NEW
 * segment only if at least one run was already recorded in this segment.
 * A header with no preceding runs completes a header-less ledger; its runs
 * stay in the current segment instead of being orphaned into an empty one.
 */
export function advanceSegment(segment: number, hasResults: boolean): number {
  return hasResults ? segment + 1 : segment;
}

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Results of one segment only. */
export function currentResults<T extends MetricRow>(results: T[], segment: number): T[] {
  return results.filter((r) => r.segment === segment);
}

/**
 * Measurement epoch of a run (task 2.3). Records without a valid `epoch` belong
 * to epoch 1 — the same contract as jsonl.ts reconstruct, so a broken epoch on a
 * run joins epoch 1 and is never compared with a later epoch's best.
 */
export function resultEpoch(result: { epoch?: number }): number {
  const epoch = result.epoch;
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : 1;
}

/** Highest epoch among the segment's runs (1 when the segment has none). */
export function segmentEpoch(results: MetricRow[], segment: number): number {
  let epoch = 1;
  for (const r of currentResults(results, segment)) epoch = Math.max(epoch, resultEpoch(r));
  return epoch;
}

/**
 * Runs of one segment that belong to `epoch` (default: the segment's current
 * epoch). Best, baseline and confidence are computed ONLY over one epoch — a
 * delta across epochs would compare two different scales (spec
 * measurement-track, «Эпохи шкалы и блокировка поперечных сравнений»).
 */
export function epochResults<T extends MetricRow>(
  results: T[],
  segment: number,
  epoch: number = segmentEpoch(results, segment),
): T[] {
  return currentResults(results, segment).filter((r) => resultEpoch(r) === epoch);
}

/** First run of the epoch is its baseline (its metric IS the reference scale). */
export function findBaselineMetric(
  results: MetricRow[],
  segment: number,
  epoch: number = segmentEpoch(results, segment),
): number | null {
  const cur = epochResults(results, segment, epoch);
  return cur.length > 0 ? cur[0].metric : null;
}

/**
 * One best-scan for findBestMetric/findBestRunNumber (bd lrx.4): applies the
 * keep metric!==0 invariant (a 0 metric is never a "best") and a linear fold
 * (no Math.min/max spread → no RangeError on ~100k entries). Returns null when
 * no keep exists in the epoch.
 */
export function findBest(
  results: MetricRow[],
  segment: number,
  direction: MetricDirection,
  epoch: number,
): { metric: number; position: number } | null {
  const seg = currentResults(results, segment);
  let best: { metric: number; position: number } | null = null;
  for (let i = 0; i < seg.length; i++) {
    const r = seg[i];
    if (resultEpoch(r) !== epoch) continue;
    if (r.status !== "keep" || r.metric === 0) continue;
    if (best === null || (direction === "lower" ? r.metric < best.metric : r.metric > best.metric)) {
      best = { metric: r.metric, position: i };
    }
  }
  return best;
}

/** Best = optimal metric across kept experiments of the current epoch (min for lower, max for higher). */
export function findBestMetric(
  results: MetricRow[],
  segment: number,
  direction: MetricDirection,
  epoch: number = segmentEpoch(results, segment),
): number | null {
  return findBest(results, segment, direction, epoch)?.metric ?? null;
}

/** T5: Find the run number (1-based) where the current best metric was set. */
export function findBestRunNumber(
  results: MetricRow[],
  segment: number,
  direction: MetricDirection,
  epoch: number = segmentEpoch(results, segment),
): number {
  const best = findBest(results, segment, direction, epoch);
  return best === null ? currentResults(results, segment).length : best.position + 1;
}

/**
 * Secondary-metric baseline of the epoch: the first run's metrics, with any
 * known metric filled in from its first epoch occurrence.
 */
export function findBaselineSecondary(
  results: MetricRow[] & Array<{ metrics?: Record<string, number> }>,
  segment: number,
  knownMetrics?: Array<{ name: string }>,
  epoch: number = segmentEpoch(results, segment),
): Record<string, number> {
  const cur = epochResults(results, segment, epoch);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

/**
 * Best keep of the nearest EARLIER epoch of the segment. It is a cross-epoch
 * reference only: both values are shown, the delta is never computed. null when
 * no earlier epoch has a keep run.
 */
export function priorEpochBest(
  results: MetricRow[],
  segment: number,
  epoch: number,
  direction: MetricDirection,
): { epoch: number; metric: number; runNumber: number } | null {
  let best: { epoch: number; metric: number; runNumber: number } | null = null;
  const seg = currentResults(results, segment);
  for (let i = 0; i < seg.length; i++) {
    const r = seg[i];
    const e = resultEpoch(r);
    if (e >= epoch || r.status !== "keep" || r.metric <= 0) continue;
    if (best === null || e > best.epoch || (e === best.epoch && isBetter(r.metric, best.metric, direction))) {
      best = { epoch: e, metric: r.metric, runNumber: i + 1 };
    }
  }
  return best;
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Noise is the sample standard deviation of repeats of the best keep's own
 * hypothesis (experiment-rigor 3.2). Returns `|best_delta| / sd`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there is no keep better than baseline, the hypothesis has
 * fewer than two runs, or the spread is 0. The segment MAD is a diagnostic only.
 *
 * repeatConfidence is injected to keep this module free of confidence.ts
 * imports (dependency direction: ledger-metrics is the lowest layer).
 */
export function computeConfidence(
  results: MetricRow[] & Array<{ metrics?: Record<string, number> }>,
  segment: number,
  direction: MetricDirection,
  repeatConfidence: (
    runs: MetricRow[],
    baseline: number,
    direction: MetricDirection,
  ) => { value: number } | null,
  epoch: number = segmentEpoch(results, segment),
): number | null {
  // Within one epoch only (task 2.3): the noise and baseline of another scale
  // would make the noise-floor multiple meaningless. Noise = repeats of the
  // best keep's own hypothesis (experiment-rigor 3.2, shared rule in
  // confidence.ts).
  const cur = epochResults(results, segment, epoch).filter((r) => r.metric > 0);
  const baseline = findBaselineMetric(results, segment, epoch);
  if (baseline === null) return null;
  const rc = repeatConfidence(cur, baseline, direction);
  return rc === null ? null : rc.value;
}
