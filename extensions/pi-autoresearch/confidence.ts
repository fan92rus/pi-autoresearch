/**
 * Confidence of the best keep against the noise of its OWN hypothesis
 * (openspec change experiment-rigor, task 3.2) and keep status (task 4.1).
 *
 * Noise is the sample standard deviation of repeats of one hypothesis. A run belongs
 * to a hypothesis by its root key: asi.repeat_of when it is a repeat, otherwise its
 * own asi.hypothesis_node. Other ideas in the segment are not noise, so the MAD of
 * all runs is not used here.
 *
 * Shared by index.ts (the live path) and report.ts (the report), so the rule cannot
 * drift apart.
 */

export interface ConfidenceRun {
  metric: number;
  status: string;
  run?: number;
  asi?: Record<string, unknown>;
}

export interface RepeatConfidence {
  value: number;
  best: number;
  bestRun: number | null;
}

function textField(asi: Record<string, unknown> | undefined, key: string): string | null {
  const v = asi?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Root hypothesis key of a run: the original node for a repeat, else its own node. */
export function rootKeyOf(asi: Record<string, unknown> | undefined): string | null {
  return textField(asi, "repeat_of") ?? textField(asi, "hypothesis_node");
}

/** Sample standard deviation (n - 1); 0 for fewer than two values. */
export function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * `runs` are the positive-metric runs of one epoch in one segment, in order.
 * Returns null (unknown) when there is no keep better than the baseline, the best
 * keep has no hypothesis key, the hypothesis has fewer than two runs, or the spread is zero.
 */
export function repeatConfidence(
  runs: ConfidenceRun[],
  baseline: number,
  direction: "lower" | "higher",
): RepeatConfidence | null {
  let best: ConfidenceRun | null = null;
  for (const r of runs) {
    if (r.status !== "keep" || !(r.metric > 0)) continue;
    if (best === null || (direction === "lower" ? r.metric < best.metric : r.metric > best.metric)) best = r;
  }
  if (best === null || best.metric === baseline) return null;

  const key = rootKeyOf(best.asi);
  if (key === null) return null;
  const group = runs.filter((r) => rootKeyOf(r.asi) === key);
  if (group.length < 2) return null;

  const sd = sampleStdDev(group.map((r) => r.metric));
  if (!(sd > 0)) return null;

  return {
    value: Math.abs(best.metric - baseline) / sd,
    best: best.metric,
    bestRun: best.run ?? null,
  };
}

/**
 * Status of one keep (task 4.1): "confirmed" when another keep of the SAME hypothesis
 * beats the baseline, or when the spread of that hypothesis gives at least 2x for this
 * run; otherwise "preliminary". Never blocks a keep.
 */
export function keepStatus(
  runs: ConfidenceRun[],
  run: ConfidenceRun,
  baseline: number,
  direction: "lower" | "higher",
): "confirmed" | "preliminary" {
  const key = rootKeyOf(run.asi);
  if (key === null) return "preliminary";
  const better = (m: number) => (direction === "lower" ? m < baseline : m > baseline);
  const sameKeeps = runs.filter(
    (r) => r !== run && r.status === "keep" && r.metric > 0 && rootKeyOf(r.asi) === key,
  );
  if (sameKeeps.some((r) => better(r.metric))) return "confirmed";
  // Same group as repeatConfidence (all positive runs of this hypothesis), so the 2x rule and the
  // displayed confidence use one sample (review B5).
  const group = runs.filter((r) => r.metric > 0 && rootKeyOf(r.asi) === key);
  if (group.length < 2) return "preliminary";
  const sd = sampleStdDev(group.map((r) => r.metric));
  return sd > 0 && Math.abs(run.metric - baseline) / sd >= 2 ? "confirmed" : "preliminary";
}
