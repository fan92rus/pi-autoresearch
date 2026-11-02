/**
 * Generic result extractors for the result-lens (OpenSpec add-result-reflection, task 1.4).
 *
 * Pure module: every function takes explicit data (run records with their captured
 * output) and returns plain values. No filesystem access, no tool registration.
 *
 * Extractors (domain-independent, no campaign configuration needed):
 *  - METRIC lines        → extractMetricLines (same rules as index.ts parseMetricLines)
 *  - error/fail/warn     → extractErrorWarnLines (case-insensitive substring)
 *  - timing top-N        → extractTimingLines (ms/µs/us/s normalized to ms)
 *  - delta vs baseline   → diffAgainstBest (line-wise, paged, volume-ratio guarded)
 *  - raw head/tail       → headTail (fallback when nothing else matched)
 *
 * Composite: extractGenericSample combines the above for one run.
 */

export type Direction = "lower" | "higher";

export type TimingUnit = "ms" | "µs" | "us" | "s";

/** Minimal run record needed by the extractors. `epoch` absent means epoch 1. */
export interface LensRun {
  run: number;
  status: string;
  epoch?: number;
  metric?: number | null;
  output: string;
}

export interface MetricSample {
  name: string;
  value: number;
}

export interface LineHit {
  lineNo: number;
  text: string;
}

export interface TimingHit extends LineHit {
  /** Numeric value as written in the line (in `unit`). */
  value: number;
  unit: TimingUnit;
  /** Value normalized to milliseconds. */
  valueMs: number;
}

export interface HeadTail {
  totalLines: number;
  head: LineHit[];
  tail: LineHit[];
  omitted: number;
}

export interface DeltaEntry {
  /** "added": line only in the inspected run; "removed": line only in the baseline. */
  kind: "added" | "removed";
  /** 1-based line number in the output the line belongs to. */
  lineNo: number;
  text: string;
}

export type DeltaResult =
  | {
      kind: "delta";
      baselineRun: number;
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
      entries: DeltaEntry[];
    }
  | { kind: "unavailable"; reason: string }
  | {
      kind: "incomparable";
      baselineRun: number;
      currentBytes: number;
      baselineBytes: number;
      current: HeadTail;
      baseline: HeadTail;
    };

export interface RawFallback extends HeadTail {
  kind: "raw_head_tail";
}

export interface GenericSample {
  run: number;
  epoch: number;
  metrics: MetricSample[];
  errors: { total: number; shown: LineHit[] };
  timing: { total: number; top: TimingHit[] };
  delta: DeltaResult;
  fallback: RawFallback | null;
}

export interface DeltaOptions {
  /** 1-based page of delta entries. Default 1. */
  page?: number;
  /** Delta entries per page. Default DELTA_PAGE_SIZE. */
  pageSize?: number;
  /** Head/tail sizes used when the delta is incomparable. Default 20 / 20. */
  headLines?: number;
  tailLines?: number;
}

export interface SampleOptions extends DeltaOptions {
  direction: Direction;
  /** Timing lines returned (sorted by normalized value). Default 10. */
  timingTop?: number;
  /** Error/warn lines returned; total is always reported. Default 20. */
  errorLimit?: number;
}

export const DEFAULT_EPOCH = 1;
export const DELTA_PAGE_SIZE = 200;
/** Delta is computed only when the larger output is at most this many times the smaller one. */
export const DELTA_RATIO_LIMIT = 2;

const DEFAULT_TIMING_TOP = 10;
const DEFAULT_ERROR_LIMIT = 20;
const DEFAULT_HEAD_LINES = 20;
const DEFAULT_TAIL_LINES = 20;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Epoch of a run; records without an epoch belong to epoch 1 (legacy ledgers). */
export function runEpoch(run: LensRun): number {
  return run.epoch ?? DEFAULT_EPOCH;
}

function assertInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

function assertSampleOptions(opts: DeltaOptions & { timingTop?: number; errorLimit?: number }): void {
  if (opts.page !== undefined) assertInt("page", opts.page, 1);
  if (opts.pageSize !== undefined) assertInt("pageSize", opts.pageSize, 1);
  if (opts.headLines !== undefined) assertInt("headLines", opts.headLines, 0);
  if (opts.tailLines !== undefined) assertInt("tailLines", opts.tailLines, 0);
  if (opts.timingTop !== undefined) assertInt("timingTop", opts.timingTop, 0);
  if (opts.errorLimit !== undefined) assertInt("errorLimit", opts.errorLimit, 0);
}

/**
 * Split output into lines. A single trailing newline does not create an extra line;
 * a trailing CR (CRLF endings) is removed from each line.
 */
function splitLines(output: string): string[] {
  if (output === "") return [];
  const parts = output.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// METRIC extractor
// ---------------------------------------------------------------------------

/** Metric names that could cause prototype pollution if used as object keys. */
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * METRIC lines: `METRIC name=value`, one per line.
 * Same rules as index.ts parseMetricLines: names are word chars, dots or µ;
 * values must be finite numbers; denied names are skipped; duplicate names keep the
 * position of their first occurrence and the value of their last occurrence.
 */
export function extractMetricLines(output: string): MetricSample[] {
  const metrics = new Map<string, number>();
  for (const match of output.matchAll(/^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm)) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return [...metrics].map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------
// error / fail / warn extractor
// ---------------------------------------------------------------------------

const ERROR_WARN_PATTERN = /error|fail|warn/i;

/** Lines containing `error`, `fail` or `warn` (case-insensitive substring), in line order. */
export function extractErrorWarnLines(output: string): LineHit[] {
  const hits: LineHit[] = [];
  splitLines(output).forEach((text, index) => {
    if (ERROR_WARN_PATTERN.test(text)) hits.push({ lineNo: index + 1, text });
  });
  return hits;
}

// ---------------------------------------------------------------------------
// timing extractor
// ---------------------------------------------------------------------------

/**
 * A number followed by a timing unit on a word boundary: `12ms`, `1.5 s`, `900µs`.
 * The number must not be preceded by a word char or dot (rejects `x12ms`, `1.5.3s`);
 * the unit must not be followed by a word char (rejects `10 seconds`, `10 mss`).
 */
const TIMING_PATTERN = /(?<![\w.])(\d+(?:\.\d+)?)[ \t]*(ms|µs|us|s)(?!\w)/;

function toMilliseconds(value: number, unit: TimingUnit): number {
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    default:
      return value / 1000;
  }
}

/**
 * Timing lines. Each line contributes its first timing token. Returns the total number of
 * timing lines and the top-N by normalized value (descending); equal values keep line order.
 */
export function extractTimingLines(output: string, top: number): { total: number; top: TimingHit[] } {
  assertInt("top", top, 0);
  const hits: TimingHit[] = [];
  splitLines(output).forEach((text, index) => {
    const match = TIMING_PATTERN.exec(text);
    if (!match) return;
    const value = Number(match[1]);
    const unit = match[2] as TimingUnit;
    hits.push({ lineNo: index + 1, text, value, unit, valueMs: toMilliseconds(value, unit) });
  });
  const ordered = [...hits].sort((a, b) => b.valueMs - a.valueMs || a.lineNo - b.lineNo);
  return { total: hits.length, top: ordered.slice(0, top) };
}

// ---------------------------------------------------------------------------
// baseline selection
// ---------------------------------------------------------------------------

/**
 * Best keep run of the given epoch by metric (lower or higher is better per `direction`).
 * Only status "keep" with a finite metric qualifies. Ties go to the earliest run number,
 * so the result does not depend on the order of `runs`. Returns null when none qualifies.
 */
export function selectBestKeep(runs: readonly LensRun[], epoch: number, direction: Direction): LensRun | null {
  if (direction !== "lower" && direction !== "higher") {
    throw new RangeError(`direction must be "lower" or "higher", got ${String(direction)}`);
  }
  let best: LensRun | null = null;
  let bestMetric = 0;
  for (const run of runs) {
    if (run.status !== "keep" || runEpoch(run) !== epoch) continue;
    const metric = run.metric;
    if (typeof metric !== "number" || !Number.isFinite(metric)) continue;
    if (best === null) {
      best = run;
      bestMetric = metric;
      continue;
    }
    const better = direction === "lower" ? metric < bestMetric : metric > bestMetric;
    const tieEarlier = metric === bestMetric && run.run < best.run;
    if (better || tieEarlier) {
      best = run;
      bestMetric = metric;
    }
  }
  return best;
}

function noComparableBaselineReason(runs: readonly LensRun[], epoch: number): string {
  const reason = `no comparable baseline: no keep run in epoch ${epoch}`;
  const otherEpochKeep = runs.some((run) => run.status === "keep" && runEpoch(run) !== epoch);
  return otherEpochKeep ? `${reason}; keep runs exist only in other epochs and cross-epoch deltas are blocked` : reason;
}

// ---------------------------------------------------------------------------
// delta against baseline
// ---------------------------------------------------------------------------

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/**
 * Indices of lines that have no counterpart in the other output (multiset semantics:
 * the first occurrences up to the other side's count are matched in order).
 */
function unmatchedIndices(lines: readonly string[], otherCounts: Map<string, number>): number[] {
  const remaining = new Map(otherCounts);
  const unmatched: number[] = [];
  lines.forEach((line, index) => {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
    } else {
      unmatched.push(index);
    }
  });
  return unmatched;
}

/**
 * Line-wise difference between the inspected run and the baseline (best keep of the same epoch).
 * Lines are compared with trailing whitespace ignored. Entries are ordered: all "added" lines
 * (by their line number in the inspected output), then all "removed" lines (by baseline line number).
 *
 * If the outputs differ in size by more than DELTA_RATIO_LIMIT, no line diff is produced;
 * both outputs are returned as head/tail samples with kind "incomparable".
 */
export function diffAgainstBest(current: LensRun, baseline: LensRun, opts: DeltaOptions = {}): DeltaResult {
  assertSampleOptions(opts);
  const headLines = opts.headLines ?? DEFAULT_HEAD_LINES;
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES;

  const currentBytes = byteLength(current.output);
  const baselineBytes = byteLength(baseline.output);
  if (Math.max(currentBytes, baselineBytes) > DELTA_RATIO_LIMIT * Math.min(currentBytes, baselineBytes)) {
    return {
      kind: "incomparable",
      baselineRun: baseline.run,
      currentBytes,
      baselineBytes,
      current: headTail(current.output, headLines, tailLines),
      baseline: headTail(baseline.output, headLines, tailLines),
    };
  }

  const currentLines = splitLines(current.output);
  const baselineLines = splitLines(baseline.output);
  const currentKeys = currentLines.map((line) => line.trimEnd());
  const baselineKeys = baselineLines.map((line) => line.trimEnd());

  const added: DeltaEntry[] = unmatchedIndices(currentKeys, countLines(baselineKeys)).map((index) => ({
    kind: "added",
    lineNo: index + 1,
    text: currentLines[index],
  }));
  const removed: DeltaEntry[] = unmatchedIndices(baselineKeys, countLines(currentKeys)).map((index) => ({
    kind: "removed",
    lineNo: index + 1,
    text: baselineLines[index],
  }));
  const all = [...added, ...removed];

  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? DELTA_PAGE_SIZE;
  return {
    kind: "delta",
    baselineRun: baseline.run,
    page,
    pageSize,
    pageCount: Math.ceil(all.length / pageSize),
    total: all.length,
    entries: all.slice((page - 1) * pageSize, page * pageSize),
  };
}

// ---------------------------------------------------------------------------
// raw head/tail
// ---------------------------------------------------------------------------

/**
 * First `head` and last `tail` lines of an output with the count of omitted lines between them.
 * An output no longer than head + tail is returned entirely in `head` (tail empty, omitted 0).
 */
export function headTail(output: string, head: number, tail: number): HeadTail {
  assertInt("head", head, 0);
  assertInt("tail", tail, 0);
  const lines = splitLines(output);
  const hit = (index: number): LineHit => ({ lineNo: index + 1, text: lines[index] });

  if (lines.length <= head + tail) {
    return {
      totalLines: lines.length,
      head: lines.map((_, index) => hit(index)),
      tail: [],
      omitted: 0,
    };
  }
  const tailStart = lines.length - tail;
  const headHits: LineHit[] = [];
  for (let index = 0; index < head; index++) headHits.push(hit(index));
  const tailHits: LineHit[] = [];
  for (let index = tailStart; index < lines.length; index++) tailHits.push(hit(index));
  return {
    totalLines: lines.length,
    head: headHits,
    tail: tailHits,
    omitted: lines.length - head - tail,
  };
}

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------

/**
 * Generic sample for one run: METRIC lines, error/warn lines, timing top-N, delta against the
 * best keep of the run's epoch, and a raw head/tail fallback when no extractor matched anything.
 * The delta is independent of the fallback: it is reported (or explained) in every case.
 */
export function extractGenericSample(current: LensRun, runs: readonly LensRun[], options: SampleOptions): GenericSample {
  assertSampleOptions(options);
  const timingTop = options.timingTop ?? DEFAULT_TIMING_TOP;
  const errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
  const headLines = options.headLines ?? DEFAULT_HEAD_LINES;
  const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
  const epoch = runEpoch(current);

  const metrics = extractMetricLines(current.output);
  const errors = extractErrorWarnLines(current.output);
  const timing = extractTimingLines(current.output, timingTop);

  const baseline = selectBestKeep(runs, epoch, options.direction);
  const delta: DeltaResult = baseline
    ? diffAgainstBest(current, baseline, options)
    : { kind: "unavailable", reason: noComparableBaselineReason(runs, epoch) };

  const nothingMatched = metrics.length === 0 && errors.length === 0 && timing.total === 0;
  const fallback: RawFallback | null = nothingMatched
    ? { kind: "raw_head_tail", ...headTail(current.output, headLines, tailLines) }
    : null;

  return {
    run: current.run,
    epoch,
    metrics,
    errors: { total: errors.length, shown: errors.slice(0, errorLimit) },
    timing,
    delta,
    fallback,
  };
}
