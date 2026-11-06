/**
 * Exhaustion hint engine for research-map (openspec/changes/research-map/design.md §12.3,
 * §12.3a, §12.3b, §12.4, §12.4a; requirements FR-06.3). Pure state over files: no
 * index.ts wiring, no writes, no process memory. Every call recomputes the state from
 * `log.jsonl`, `run-links.jsonl` and `analysis.jsonl`, so the same files give the same
 * state before and after a restart (T115).
 *
 * - Keys `(axis, prereg_id, run_epoch)` (§12.3a): comparisons whose two runs have proven
 *   and equal epochs (§5.2a, via run-links.ts classifyRunLink). Eligible elements are
 *   controlled, delta-allowed comparisons of that key.
 * - Barriers (§12.3a): unreadable analysis lines (every pair), null or mismatched epochs,
 *   unknown control or metric context (pair scope), and comparisons whose prereg cannot
 *   identify a key (axis scope). A window whose position range contains a barrier is not
 *   assessed; windows on either side of it are evaluated normally.
 * - Window stages (§12.3 steps 5–6): 2 beyond_noise_series, 1 below_threshold_within_noise,
 *   0 not_triggered. Every other outcome is a not_assessed code, never false.
 * - H_k (§12.3a): maximum stage over the complete windows of the current segment (after the
 *   last applicable barrier). Any not_assessed complete window makes H_k unknown.
 * - Hints: S_exh when H_k rises to 1 or 2 (§12.3a table). After a barrier removal, one
 *   S_exh hint when the merged segment's stage exceeds the known maxima of both
 *   pre-removal segments; an unknown maximum gives none (§12.3a «Барьеры»). Advisory
 *   S_exh_adv when the readable comparison count of an axis reaches 3 or 6: one hint per
 *   call at the highest threshold reached (§12.3b). Both wordings carry the not-confirmed
 *   disclaimer.
 * - Budgets: first 16 keys in global order and 200 eligible elements per key (§12.3a).
 *   Each key checks at most one noise reference, so a call makes at most 16 checks, below
 *   the 20 per call of §10.3.
 *
 * Fail-closed: unknown never becomes true; only not_triggered is false. Unreadable inputs
 * degrade to unknown and never throw to the caller.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseJsonlEntry } from "./jsonl.ts";
import { journalTarget } from "./research-journal.ts";
import {
  classifyRunLink,
  isRunNumber,
  loadRunLinksState,
  type FileReadState,
  type LedgerScan,
  type RunLinkVerdict,
  type RunLinksScan,
} from "./run-links.ts";

// ---------------------------------------------------------------------------
// Constants and budgets
// ---------------------------------------------------------------------------

/** Keys examined per call, in global order (§12.3a, §10.3). */
export const FIRST_KEYS_LIMIT = 16;
/** Eligible elements per key before the key becomes unknown (§12.3a). */
export const COMPARISONS_CAP = 200;
/** Noise-reference checks per call (§10.3). */
export const REF_CHECKS_PER_CALL = 20;
/** Default window size K when exhaustion_rule.k is absent (§9.3). */
export const DEFAULT_WINDOW_K = 3;
/** Advisory thresholds on the readable comparison count of one axis (§12.3b). */
export const ADVISORY_THRESHOLDS = [3, 6] as const;
/** Largest evidence file a noise reference may point to (§10.3). */
export const NOISE_REF_MAX_BYTES = 64 * 1024 * 1024;

/** Mandatory phrase of advisory wording (§12.3b). */
export const ADVISORY_DISCLAIMER = "Исчерпание направления и сопоставимость результатов не подтверждены.";
/** Mandatory phrase of S_exh wording (§12.4). */
export const EXHAUSTION_DISCLAIMER = "Исчерпание направления и полная сопоставимость результатов не подтверждены.";

const PREREG_ID_RE = /^pre-[0-9a-z]+-[0-9a-f]{8}$/;
const AXIS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const METRIC_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ANALYSIS_KINDS = ["prereg", "comparison", "attribution", "supplement"] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExhaustionKey {
  readonly axis: string;
  readonly prereg_id: string;
  readonly run_epoch: number;
}

export type ExhaustionStage = 0 | 1 | 2;

export type WindowCode = "not_triggered" | "below_threshold_within_noise" | "beyond_noise_series";

/** Codes of barriers (§12.3a «Барьеры»); each one also explains a crossing window. */
export type BarrierCode =
  | "epoch_unproven"
  | "incomplete_data"
  | "control_unknown"
  | "epoch_mismatch"
  | "metric_context_unknown"
  | "prereg_unknown";

/** Every not_assessed reason this engine can produce (§12.3, display mapping). */
export type NotAssessedCode =
  | BarrierCode
  | "window_short"
  | "no_noise_basis"
  | "noise_ref_unavailable"
  | "prereg_order_unknown"
  | "post_hoc_prereg"
  | "budget_exhausted";

export interface WindowResult {
  readonly stage: ExhaustionStage | null;
  readonly code: WindowCode | NotAssessedCode;
}

export type BarrierScope =
  | { readonly kind: "all" }
  | { readonly kind: "axis"; readonly axis: string }
  | { readonly kind: "pair"; readonly axis: string; readonly preregId: string };

export interface ExhaustionBarrier {
  /** Stable identity: analysis position, code and scope. */
  readonly id: string;
  readonly position: number;
  readonly code: BarrierCode;
  readonly scope: BarrierScope;
}

export type KeyBudgetDetail = "key_limit" | "comparison_cap";

export interface ExhaustionDisplay {
  readonly value: "true" | "false" | "unknown";
  readonly code: string | null;
  /** Budget detail of an unknown key (`key_limit` or `comparison_cap`), null otherwise. */
  readonly detail: KeyBudgetDetail | null;
}

/** History of one segment of a key: its eligible elements between two applicable barriers (§12.3a). */
export interface SegmentHistory {
  /** Position of the barrier opening the segment; -1 for the first segment of the key. */
  readonly from: number;
  /** Position of the barrier closing the segment; null for the current segment. */
  readonly to: number | null;
  /** Eligible elements in the segment. */
  readonly count: number;
  /** H of the segment: 0, 1, 2 or "unknown". */
  readonly max: ExhaustionStage | "unknown";
  readonly code: NotAssessedCode | null;
}

export interface ExhaustionKeyReport {
  readonly id: string;
  readonly key: ExhaustionKey;
  /** False when the key is unknown (budget); its other fields are then null or unknown. */
  readonly assessed: boolean;
  readonly budgetDetail: KeyBudgetDetail | null;
  readonly windowK: number | null;
  readonly threshold: number | null;
  readonly noiseBand: number | null;
  readonly eligibleCount: number | null;
  /** Eligible elements after the last applicable barrier. */
  readonly segmentCount: number | null;
  /** H_k of the current segment: 0, 1, 2 or "unknown". */
  readonly historyMax: ExhaustionStage | "unknown";
  readonly historyCode: NotAssessedCode | null;
  readonly lastWindow: WindowResult;
  /** Ids of the barriers applicable to this key (sorted by position). */
  readonly barrierIds: readonly string[];
  /** Segments between applicable barriers in position order; the last one is the current segment. */
  readonly segments: readonly SegmentHistory[];
  readonly display: ExhaustionDisplay;
}

export interface AxisCount {
  readonly axis: string;
  /** Readable comparison records with this axis (§12.3b, n_A). */
  readonly n: number;
  readonly ids: readonly string[];
}

export interface ExhaustionState {
  readonly analysis: FileReadState;
  readonly ledger: FileReadState;
  /** Unreadable (torn or invalid) analysis lines. */
  readonly unreadableLines: number;
  /** True when both the ledger and the analysis file were read without damage. */
  readonly complete: boolean;
  /** Keys sorted by (axis, prereg_id, run_epoch); keys beyond the first 16 are unknown. */
  readonly keys: readonly ExhaustionKeyReport[];
  /** Advisory counts per axis, sorted by axis; null when the analysis file is unavailable. */
  readonly axes: readonly AxisCount[] | null;
  readonly barriers: readonly ExhaustionBarrier[];
  readonly warnings: readonly string[];
}

export interface ExhaustionHint {
  readonly kind: "S_exh" | "S_exh_adv";
  readonly axis: string;
  readonly key: ExhaustionKey | null;
  readonly stage: 1 | 2 | null;
  readonly threshold: 3 | 6 | null;
  readonly n: number | null;
  readonly text: string;
}

export interface ExhaustionOptions {
  /** Test seam: replaces readFileSync for log.jsonl, run-links.jsonl and analysis.jsonl. */
  readonly fs?: { readFileSync?: (file: string, encoding: "utf8") => string };
}

export interface ExhaustionTransitionOptions {
  /** Keys touched by the added record; S_exh hints are limited to these (§12.4a). */
  readonly affectedKeys?: Iterable<ExhaustionKey>;
}

// ---------------------------------------------------------------------------
// Keys and budget helpers
// ---------------------------------------------------------------------------

export function exhaustionKeyId(key: ExhaustionKey): string {
  return `${key.axis}|${key.prereg_id}|${key.run_epoch}`;
}

/** Deterministic order (§10.3): axis and prereg_id by code units, then run_epoch as integer. */
export function compareExhaustionKeys(a: ExhaustionKey, b: ExhaustionKey): number {
  if (a.axis !== b.axis) return a.axis < b.axis ? -1 : 1;
  if (a.prereg_id !== b.prereg_id) return a.prereg_id < b.prereg_id ? -1 : 1;
  return a.run_epoch - b.run_epoch;
}

export function sortExhaustionKeys(keys: readonly ExhaustionKey[]): ExhaustionKey[] {
  return [...keys].sort(compareExhaustionKeys);
}

/** The global first 16 keys of the campaign (§12.3a «Объём»). */
export function first16Keys(keys: readonly ExhaustionKey[]): ExhaustionKey[] {
  return sortExhaustionKeys(keys).slice(0, FIRST_KEYS_LIMIT);
}

/** Affected keys that fall inside the global first 16, in the same order (§12.3a). */
export function affectedWithinFirst16(allKeys: readonly ExhaustionKey[], affected: Iterable<ExhaustionKey>): ExhaustionKey[] {
  const wanted = new Set(Array.from(affected, exhaustionKeyId));
  return first16Keys(allKeys).filter((key) => wanted.has(exhaustionKeyId(key)));
}

// ---------------------------------------------------------------------------
// Window classification (§12.3 steps 5–6) and segment maximum (§12.3a)
// ---------------------------------------------------------------------------

export interface WindowValues {
  readonly candidate: number;
  readonly baseline: number;
}

export interface WindowRule {
  readonly direction: "lower" | "higher";
  /** T: threshold_gain of exhaustion_rule. */
  readonly threshold: number;
  /** B: noise_band of the prereg. */
  readonly noiseBand: number;
}

/**
 * Stage of one complete window. For `higher` the gain is candidate − baseline, for `lower`
 * it is baseline − candidate. Ties at the boundary are not below/beyond (strict `<`).
 */
export function classifyWindow(values: readonly WindowValues[], rule: WindowRule): WindowResult {
  if (values.length === 0) return { stage: null, code: "window_short" };
  const gains = values.map((value) => (rule.direction === "higher" ? value.candidate - value.baseline : value.baseline - value.candidate));
  const below = gains.every((gain) => gain < rule.threshold);
  const beyond = gains.every((gain) => gain < rule.threshold - rule.noiseBand);
  if (beyond) return { stage: 2, code: "beyond_noise_series" };
  if (below) return { stage: 1, code: "below_threshold_within_noise" };
  return { stage: 0, code: "not_triggered" };
}

/** H_k over the stages of complete windows of one segment; any unassessed window → unknown. */
export function segmentMaximum(stages: readonly (ExhaustionStage | null)[]): ExhaustionStage | "unknown" {
  let max: ExhaustionStage = 0;
  for (const stage of stages) {
    if (stage === null) return "unknown";
    if (stage > max) max = stage;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Parsing helpers (analysis.jsonl, log.jsonl)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface PreregRule {
  readonly metricName: string;
  readonly direction: "lower" | "higher";
  readonly threshold: number;
  readonly k: number;
}

interface PreregRecord {
  readonly id: string;
  readonly axis: string | null;
  readonly hypothesisId: string | null;
  /** Null when exhaustion_rule is absent or invalid: the prereg cannot identify a key. */
  readonly rule: PreregRule | null;
  readonly noiseBand: number | null;
  readonly noiseRef: JsonObject | null;
  readonly prefixBytes: number | null;
  readonly prefixSha256: string | null;
  /** Byte offsets of the record line in analysis.jsonl (end includes the LF). */
  readonly lineStart: number;
  readonly lineEnd: number;
}

interface ComparisonRecord {
  readonly id: string;
  readonly position: number;
  readonly axis: string | null;
  readonly preregId: string | null;
  readonly baselineRun: unknown;
  readonly candidateRun: unknown;
  /** Null when the record does not declare changed_components (control unknown, §9.2 (б)). */
  readonly changedComponents: readonly string[] | null;
  readonly metricName: string | null;
}

interface UnreadableLine {
  readonly position: number;
  readonly reason: "torn" | "invalid";
}

interface AnalysisScan {
  readonly bytes: Buffer;
  readonly unreadable: readonly UnreadableLine[];
  readonly preregs: ReadonlyMap<string, readonly PreregRecord[]>;
  readonly comparisons: readonly ComparisonRecord[];
}

type AnalysisItem =
  | { readonly type: "unreadable"; readonly reason: "torn" | "invalid" }
  | { readonly type: "prereg"; readonly record: PreregRecord }
  | { readonly type: "comparison"; readonly record: ComparisonRecord }
  | { readonly type: "other" };

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON: object keys sorted, undefined members dropped (same form as research-observations). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRule(raw: unknown): PreregRule | null {
  if (!isPlainObject(raw)) return null;
  const metricName = raw.metric_name;
  const direction = raw.direction;
  const threshold = raw.threshold_gain;
  const k = raw.k === undefined ? DEFAULT_WINDOW_K : raw.k;
  if (typeof metricName !== "string" || !METRIC_NAME_RE.test(metricName)) return null;
  if (direction !== "lower" && direction !== "higher") return null;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) return null;
  if (typeof k !== "number" || !Number.isSafeInteger(k) || k < 2 || k > 10) return null;
  return { metricName, direction, threshold, k };
}

function parsePrereg(entry: JsonObject, lineStart: number, lineEnd: number): PreregRecord | null {
  const id = entry.id;
  if (typeof id !== "string" || !PREREG_ID_RE.test(id)) return null;

  let axis: string | null = null;
  if (entry.axis !== undefined) {
    if (typeof entry.axis !== "string" || !AXIS_RE.test(entry.axis)) return null;
    axis = entry.axis;
  }
  let hypothesisId: string | null = null;
  if (entry.hypothesis_id !== undefined) {
    if (typeof entry.hypothesis_id !== "string") return null;
    hypothesisId = entry.hypothesis_id;
  }
  let noiseBand: number | null = null;
  if (entry.noise_band !== undefined) {
    if (!isNonNegativeFiniteNumber(entry.noise_band)) return null;
    noiseBand = entry.noise_band;
  }
  let noiseRef: JsonObject | null = null;
  if (entry.noise_basis_ref !== undefined) {
    if (!isPlainObject(entry.noise_basis_ref)) return null;
    noiseRef = entry.noise_basis_ref;
  }
  const rule = entry.exhaustion_rule === undefined ? null : parseRule(entry.exhaustion_rule);

  // Ledger prefix (§9.3): both fields or neither. Absence means prefix_intact cannot be shown.
  let prefixBytes: number | null = null;
  let prefixSha256: string | null = null;
  const hasBytes = entry.ledger_prefix_bytes !== undefined;
  const hasSha = entry.ledger_prefix_sha256 !== undefined;
  if (hasBytes || hasSha) {
    if (!hasBytes || !hasSha) return null;
    if (!isSafeNonNegativeInteger(entry.ledger_prefix_bytes)) return null;
    if (typeof entry.ledger_prefix_sha256 !== "string" || !SHA256_HEX_RE.test(entry.ledger_prefix_sha256)) return null;
    prefixBytes = entry.ledger_prefix_bytes;
    prefixSha256 = entry.ledger_prefix_sha256;
  }

  return {
    id,
    axis,
    hypothesisId,
    rule,
    noiseBand,
    noiseRef,
    prefixBytes,
    prefixSha256,
    lineStart,
    lineEnd,
  };
}

function parseComparison(entry: JsonObject, position: number): ComparisonRecord | null {
  if (typeof entry.id !== "string") return null;
  let axis: string | null = null;
  if (entry.axis !== undefined) {
    if (typeof entry.axis !== "string" || !AXIS_RE.test(entry.axis)) return null;
    axis = entry.axis;
  }
  let preregId: string | null = null;
  if (entry.prereg_id !== undefined) {
    if (typeof entry.prereg_id !== "string") return null;
    preregId = entry.prereg_id;
  }
  let changedComponents: string[] | null = null;
  if (entry.changed_components !== undefined) {
    const value = entry.changed_components;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
    changedComponents = value as string[];
  }
  let metricName: string | null = null;
  if (entry.metric_name !== undefined) {
    if (typeof entry.metric_name !== "string" || !METRIC_NAME_RE.test(entry.metric_name)) return null;
    metricName = entry.metric_name;
  }
  if (entry.baseline_run === undefined || entry.candidate_run === undefined) return null;
  return {
    id: entry.id,
    position,
    axis,
    preregId,
    baselineRun: entry.baseline_run,
    candidateRun: entry.candidate_run,
    changedComponents,
    metricName,
  };
}

/** Validate one analysis line. Shape or content_sha256 failures are unreadable (§6.4). */
function parseAnalysisLine(entry: JsonObject, position: number, lineStart: number, lineEnd: number): AnalysisItem {
  const unreadable: AnalysisItem = { type: "unreadable", reason: "invalid" };
  if (entry.v !== 1 || entry.record !== "analysis") return unreadable;
  const kind = entry.kind;
  if (typeof kind !== "string" || !(ANALYSIS_KINDS as readonly string[]).includes(kind)) return unreadable;
  if (typeof entry.id !== "string") return unreadable;
  const { content_sha256: stored, ...withoutHash } = entry;
  if (typeof stored !== "string" || stored !== sha256Hex(canonicalJson(withoutHash))) return unreadable;

  if (kind === "prereg") {
    const record = parsePrereg(entry, lineStart, lineEnd);
    return record === null ? unreadable : { type: "prereg", record };
  }
  if (kind === "comparison") {
    const record = parseComparison(entry, position);
    return record === null ? unreadable : { type: "comparison", record };
  }
  return { type: "other" };
}

/**
 * Split analysis.jsonl into readable prereg/comparison records and unreadable lines.
 * Positions are line indexes; their order is the ledger order used for barriers (§12.3a).
 */
function scanAnalysis(text: string): AnalysisScan {
  const bytes = Buffer.from(text, "utf8");
  const unreadable: UnreadableLine[] = [];
  const preregLists = new Map<string, PreregRecord[]>();
  const comparisons: ComparisonRecord[] = [];
  let offset = 0;
  let position = 0;
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line, "utf8");
    if (line.trim() !== "") {
      const entry = parseJsonlEntry(line);
      if (entry === null) {
        unreadable.push({ position, reason: "torn" });
      } else {
        // Every parseable line must be a valid analysis record; any other line is invalid, not skipped (§6.4).
        const item = parseAnalysisLine(entry, position, offset, offset + size + 1);
        if (item.type === "unreadable") {
          unreadable.push({ position, reason: item.reason });
        } else if (item.type === "prereg") {
          const list = preregLists.get(item.record.id) ?? [];
          list.push(item.record);
          preregLists.set(item.record.id, list);
        } else if (item.type === "comparison") {
          comparisons.push(item.record);
        }
      }
    }
    offset += size + 1;
    position++;
  }
  return { bytes, unreadable, preregs: preregLists, comparisons };
}

interface LogRowContext {
  readonly segment: number;
  readonly metricName: string | null;
  readonly bestDirection: "lower" | "higher" | null;
}

/**
 * Segment and configuration header of every run row (mirrors reconstructJsonlState in
 * jsonl.ts: a config header after the first run starts a new segment). Keyed by line index.
 */
function scanLogContexts(text: string): Map<number, LogRowContext> {
  const contexts = new Map<number, LogRowContext>();
  let segment = 0;
  let headers = 0;
  let runsSeen = 0;
  let metricName: string | null = null;
  let bestDirection: "lower" | "higher" | null = null;
  let index = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      const entry = parseJsonlEntry(line);
      if (entry !== null) {
        if (entry.type === "config") {
          if (headers > 0 && runsSeen > 0) segment++;
          headers++;
          metricName = typeof entry.metricName === "string" && entry.metricName !== "" ? entry.metricName : null;
          bestDirection = entry.bestDirection === "higher" || entry.bestDirection === "lower" ? entry.bestDirection : null;
        } else if (typeof entry.run === "number") {
          runsSeen++;
          contexts.set(index, { segment, metricName, bestDirection });
        }
      }
    }
    index++;
  }
  return contexts;
}

/** Byte offset of every line start, using the same line split as the ledger scan. */
function lineStartOffsets(text: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    starts.push(offset);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return starts;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

// ---------------------------------------------------------------------------
// Noise reference check (§10.3, documentary reference only)
// ---------------------------------------------------------------------------

function isValidLines(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [first, last] = value;
  return (
    Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    (first as number) >= 1 &&
    (last as number) <= 1_000_000 &&
    (first as number) <= (last as number)
  );
}

/**
 * Existence check of `.auto/runs/<run>/output.txt` or `manifest.json` (§10.3 steps 1–3):
 * symlinks in the path, non-regular files and oversized files fail; anchor and line range
 * are checked against the file. The value itself is never extracted.
 */
function checkNoiseRef(autoDir: string, ref: JsonObject): boolean {
  const { run, artifact, lines, anchor } = ref;
  if (!isRunNumber(run)) return false;
  if (artifact !== "output" && artifact !== "manifest") return false;
  if (artifact === "manifest") {
    if (lines !== null || anchor !== null) return false;
  } else {
    if (lines !== null && !isValidLines(lines)) return false;
    if (anchor !== null && (typeof anchor !== "string" || anchor.length > 200 || /[\u0000-\u001f]/.test(anchor))) return false;
  }

  const runDir = path.join(autoDir, "runs", String(run));
  const file = path.join(runDir, artifact === "output" ? "output.txt" : "manifest.json");
  try {
    for (const component of [autoDir, path.join(autoDir, "runs"), runDir]) {
      if (fs.lstatSync(component).isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NOISE_REF_MAX_BYTES) return false;
    if (lines === null && anchor === null) return true;
    const text = fs.readFileSync(file, "utf8");
    if (typeof anchor === "string" && !text.includes(anchor)) return false;
    if (isValidLines(lines)) {
      const count = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
      if ((lines as number[])[1] > count) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Element {
  readonly position: number;
  readonly preregStatus: "pre_registered" | "post_hoc" | "unknown";
  readonly candidate: number;
  readonly baseline: number;
  readonly metricName: string;
  readonly direction: "lower" | "higher";
}

interface KeyRecord {
  readonly key: ExhaustionKey;
  readonly prereg: PreregRecord;
  readonly elements: Element[];
}

interface MetricContext {
  readonly ok: boolean;
  readonly candidate: number;
  readonly baseline: number;
  readonly metricName: string;
  readonly direction: "lower" | "higher";
}

function barrierApplies(barrier: ExhaustionBarrier, axis: string, preregId: string): boolean {
  if (barrier.scope.kind === "all") return true;
  if (barrier.scope.kind === "axis") return barrier.scope.axis === axis;
  return barrier.scope.axis === axis && barrier.scope.preregId === preregId;
}

function makeBarrier(position: number, code: BarrierCode, scope: BarrierScope): ExhaustionBarrier {
  const scopeId = scope.kind === "all" ? "all" : scope.kind === "axis" ? `axis:${scope.axis}` : `pair:${scope.axis}|${scope.preregId}`;
  return { id: `${position}:${code}:${scopeId}`, position, code, scope };
}

function unknownKeyReport(key: ExhaustionKey, id: string, detail: KeyBudgetDetail, eligibleCount: number | null): ExhaustionKeyReport {
  return {
    id,
    key,
    assessed: false,
    budgetDetail: detail,
    windowK: null,
    threshold: null,
    noiseBand: null,
    eligibleCount,
    segmentCount: null,
    historyMax: "unknown",
    historyCode: "budget_exhausted",
    lastWindow: { stage: null, code: "budget_exhausted" },
    barrierIds: [],
    segments: [],
    display: { value: "unknown", code: "budget_exhausted", detail },
  };
}

/**
 * Read the inputs of the exhaustion engine from one autoDir and evaluate them. The ledger
 * text is captured from the same read that feeds run-links.ts, so both see one file state.
 */
export function computeExhaustionState(autoDir: string, options: ExhaustionOptions = {}): ExhaustionState {
  const readText = options.fs?.readFileSync ?? ((file: string, encoding: "utf8") => fs.readFileSync(file, encoding));
  const logFile = path.join(autoDir, "log.jsonl");
  let logText: string | null = null;
  const scan: RunLinksScan = loadRunLinksState(autoDir, {
    fs: {
      readFileSync: (file, encoding) => {
        const text = readText(file, encoding);
        if (file === logFile) logText = text;
        return text;
      },
    },
  });

  const analysisFile = journalTarget(autoDir, "analysis").file;
  let analysisState: FileReadState = "ok";
  let analysisText = "";
  try {
    analysisText = readText(analysisFile, "utf8");
  } catch (error) {
    analysisState = errorCode(error) === "ENOENT" ? "missing" : "unavailable";
  }

  const warnings: string[] = [...scan.warnings];
  if (analysisState === "unavailable") {
    warnings.push("analysis_unavailable");
    return {
      analysis: analysisState,
      ledger: scan.ledgerState,
      unreadableLines: 0,
      complete: false,
      keys: [],
      axes: null,
      barriers: [],
      warnings,
    };
  }

  const analysis = scanAnalysis(analysisState === "ok" ? analysisText : "");
  const ledger: LedgerScan | null = scan.ledgerState === "ok" ? scan.ledger : null;
  const logBytes = logText !== null ? Buffer.from(logText, "utf8") : null;
  const logLineStarts = logText !== null ? lineStartOffsets(logText) : [];
  const contexts = logText !== null ? scanLogContexts(logText) : new Map<number, LogRowContext>();

  // Verdicts and rows are cached per call; classification itself is pure over the scan.
  const verdictCache = new Map<unknown, RunLinkVerdict>();
  const verdictOf = (run: unknown): RunLinkVerdict => {
    let verdict = verdictCache.get(run);
    if (verdict === undefined) {
      verdict = classifyRunLink(scan, run as number);
      verdictCache.set(run, verdict);
    }
    return verdict;
  };

  const rowsByRun = new Map<unknown, { index: number; entry: JsonObject }[]>();
  for (const row of ledger?.rows ?? []) {
    if (typeof row.entry.run !== "number") continue;
    const list = rowsByRun.get(row.entry.run) ?? [];
    list.push({ index: row.index, entry: row.entry });
    rowsByRun.set(row.entry.run, list);
  }
  const uniqueRowOf = (run: unknown): { index: number; entry: JsonObject } | null => {
    const list = rowsByRun.get(run);
    return list !== undefined && list.length === 1 ? list[0] : null;
  };
  const markerOf = (run: unknown, type: "run_started" | "run_result"): { index: number; node: unknown } | null => {
    const found = (ledger?.markers ?? []).filter((marker) => marker.type === type && marker.run_dir === run);
    if (found.length !== 1) return null;
    const row = ledger?.rows.find((candidate) => candidate.index === found[0].index);
    return { index: found[0].index, node: row?.entry.node_id };
  };

  const prefixIntactCache = new Map<PreregRecord, boolean>();
  const prefixIntact = (prereg: PreregRecord): boolean => {
    const cached = prefixIntactCache.get(prereg);
    if (cached !== undefined) return cached;
    let intact = false;
    if (logBytes !== null && prereg.prefixBytes !== null && prereg.prefixSha256 !== null && prereg.prefixBytes <= logBytes.length) {
      intact = sha256Hex(logBytes.subarray(0, prereg.prefixBytes)) === prereg.prefixSha256;
    }
    prefixIntactCache.set(prereg, intact);
    return intact;
  };

  // §9.3 prereg_status of one candidate run (only pre_registered counts as trusted).
  const preregStatusFor = (prereg: PreregRecord, run: unknown): "pre_registered" | "post_hoc" | "unknown" => {
    if (!prefixIntact(prereg)) return "unknown";
    const verdict = verdictOf(run);
    if (verdict.link !== "proven") return "unknown";
    const start = markerOf(run, "run_started");
    const startOffset = start !== null ? logLineStarts[start.index] : undefined;
    if (start === null || startOffset === undefined || prereg.prefixBytes === null) return "unknown";
    if (startOffset < prereg.prefixBytes) return "post_hoc";
    if (prereg.hypothesisId !== null && start.node !== prereg.hypothesisId) return "unknown";
    if (verdict.analysisPrefixBytes === null || verdict.analysisPrefixSha256 === null) return "unknown";
    const snapshot = verdict.analysisPrefixBytes;
    if (snapshot > analysis.bytes.length || prereg.lineEnd > snapshot) return "unknown";
    if (sha256Hex(analysis.bytes.subarray(0, snapshot)) !== verdict.analysisPrefixSha256) return "unknown";
    return "pre_registered";
  };

  const measurementChangeBetween = (runA: unknown, runB: unknown): boolean => {
    const startA = markerOf(runA, "run_started");
    const startB = markerOf(runB, "run_started");
    const resultA = markerOf(runA, "run_result");
    const resultB = markerOf(runB, "run_result");
    if (startA === null || startB === null || resultA === null || resultB === null || ledger === null) return true;
    const low = Math.min(startA.index, startB.index);
    const high = Math.max(resultA.index, resultB.index);
    return ledger.rows.some(
      (row) =>
        row.index > low &&
        row.index < high &&
        typeof row.entry.type === "string" &&
        row.entry.type.startsWith("measurement_change"),
    );
  };

  const metricContextOf = (comparison: ComparisonRecord): MetricContext => {
    const failed: MetricContext = { ok: false, candidate: NaN, baseline: NaN, metricName: "", direction: "lower" };
    const baseRow = uniqueRowOf(comparison.baselineRun);
    const candRow = uniqueRowOf(comparison.candidateRun);
    if (baseRow === null || candRow === null) return failed;
    const baseContext = contexts.get(baseRow.index);
    const candContext = contexts.get(candRow.index);
    if (baseContext === undefined || candContext === undefined) return failed;
    if (baseContext.segment !== candContext.segment) return failed;
    if (candContext.metricName === null || candContext.bestDirection === null) return failed;
    if (comparison.metricName !== null && comparison.metricName !== candContext.metricName) return failed;
    const candidate = candRow.entry.metric;
    const baseline = baseRow.entry.metric;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return failed;
    if (typeof baseline !== "number" || !Number.isFinite(baseline)) return failed;
    return {
      ok: true,
      candidate,
      baseline,
      metricName: candContext.metricName,
      direction: candContext.bestDirection,
    };
  };

  // Usable prereg: exactly one record, with exhaustion_rule, and the same axis (§12.3a).
  const usablePrereg = (preregId: string, axis: string): PreregRecord | null => {
    const list = analysis.preregs.get(preregId);
    if (list === undefined || list.length !== 1) return null;
    const prereg = list[0];
    if (prereg.rule === null || prereg.axis === null || prereg.axis !== axis) return null;
    return prereg;
  };

  const barriers: ExhaustionBarrier[] = [];
  for (const unreadableLine of analysis.unreadable) {
    barriers.push(makeBarrier(unreadableLine.position, "incomplete_data", { kind: "all" }));
  }

  const keyRecords = new Map<string, KeyRecord>();
  const axisIds = new Map<string, string[]>();
  for (const comparison of analysis.comparisons) {
    if (comparison.axis === null) continue;
    const ids = axisIds.get(comparison.axis) ?? [];
    ids.push(comparison.id);
    axisIds.set(comparison.axis, ids);

    const axis = comparison.axis;
    const prereg = comparison.preregId !== null ? usablePrereg(comparison.preregId, axis) : null;
    const baseVerdict = verdictOf(comparison.baselineRun);
    const candVerdict = verdictOf(comparison.candidateRun);
    // Cause priority (§12.3a «Барьеры»): (i) epoch_unproven, then (iv) prereg_unknown, then (iii).
    // An unproven epoch on a pair whose prereg cannot be identified stays on the axis.
    if (baseVerdict.runEpoch === null || candVerdict.runEpoch === null) {
      const scope: BarrierScope = prereg !== null ? { kind: "pair", axis, preregId: prereg.id } : { kind: "axis", axis };
      barriers.push(makeBarrier(comparison.position, "epoch_unproven", scope));
      continue;
    }
    if (prereg === null) {
      barriers.push(makeBarrier(comparison.position, "prereg_unknown", { kind: "axis", axis }));
      continue;
    }
    const pairScope: BarrierScope = { kind: "pair", axis, preregId: prereg.id };
    if (baseVerdict.runEpoch !== candVerdict.runEpoch) {
      barriers.push(makeBarrier(comparison.position, "epoch_mismatch", pairScope));
      continue;
    }

    const key: ExhaustionKey = { axis, prereg_id: prereg.id, run_epoch: baseVerdict.runEpoch };
    const id = exhaustionKeyId(key);
    let record = keyRecords.get(id);
    if (record === undefined) {
      record = { key, prereg, elements: [] };
      keyRecords.set(id, record);
    }

    // §9.2 control: declared changed components; a scale change between the runs is uncontrolled.
    const crossesScale = measurementChangeBetween(comparison.baselineRun, comparison.candidateRun);
    let control: "controlled" | "uncontrolled" | "unknown";
    if (crossesScale) control = "uncontrolled";
    else if (comparison.changedComponents === null) control = "unknown";
    else control = comparison.changedComponents.length <= 1 ? "controlled" : "uncontrolled";

    const metric = metricContextOf(comparison);
    if (control === "unknown") {
      barriers.push(makeBarrier(comparison.position, "control_unknown", pairScope));
      continue;
    }
    if (!metric.ok) {
      barriers.push(makeBarrier(comparison.position, "metric_context_unknown", pairScope));
      continue;
    }
    if (control === "uncontrolled") continue;

    record.elements.push({
      position: comparison.position,
      preregStatus: preregStatusFor(prereg, comparison.candidateRun),
      candidate: metric.candidate,
      baseline: metric.baseline,
      metricName: metric.metricName,
      direction: metric.direction,
    });
  }

  barriers.sort((a, b) => a.position - b.position);
  const allKeys = sortExhaustionKeys([...keyRecords.values()].map((record) => record.key));
  const firstKeys = new Set(first16Keys(allKeys).map(exhaustionKeyId));
  let refChecksUsed = 0;

  const keys: ExhaustionKeyReport[] = allKeys.map((key) => {
    const id = exhaustionKeyId(key);
    const record = keyRecords.get(id) as KeyRecord;
    if (!firstKeys.has(id)) return unknownKeyReport(key, id, "key_limit", null);
    if (record.elements.length > COMPARISONS_CAP) {
      return unknownKeyReport(key, id, "comparison_cap", record.elements.length);
    }

    const { prereg, elements } = record;
    const rule = prereg.rule as PreregRule;
    const keyBarriers = barriers.filter((barrier) => barrierApplies(barrier, key.axis, key.prereg_id));
    const barrierIds = keyBarriers.map((barrier) => barrier.id);

    // §12.3 step 2: noise basis. A present reference costs one check per key (§10.3). At most
    // 16 keys are assessed per call, so the 20-check budget is never reached and needs no branch.
    let refOk = false;
    if (prereg.noiseRef !== null) {
      refChecksUsed++;
      refOk = checkNoiseRef(autoDir, prereg.noiseRef);
    }
    const noise: "ok" | "no_noise_basis" | "noise_ref_unavailable" =
      prereg.noiseRef === null || prereg.noiseBand === null ? "no_noise_basis" : refOk ? "ok" : "noise_ref_unavailable";
    const noiseBand = prereg.noiseBand ?? 0;
    const K = rule.k;

    const windowAt = (end: number): WindowResult => {
      if (end < K - 1) return { stage: null, code: "window_short" };
      const window = elements.slice(end - K + 1, end + 1);
      const first = window[0];
      const last = window[window.length - 1];
      const na = (code: NotAssessedCode): WindowResult => ({ stage: null, code });
      if (window.some((element) => element.preregStatus === "unknown")) return na("prereg_order_unknown");
      if (window.some((element) => element.preregStatus === "post_hoc")) return na("post_hoc_prereg");
      if (noise !== "ok") return na(noise);
      const crossing = keyBarriers.find((barrier) => barrier.position > first.position && barrier.position < last.position);
      if (crossing !== undefined) return na(crossing.code);
      if (window.some((element) => element.metricName !== rule.metricName || element.direction !== rule.direction)) {
        return na("metric_context_unknown");
      }
      return classifyWindow(window, { direction: rule.direction, threshold: rule.threshold, noiseBand });
    };

    // H_k per segment (§12.3a): the eligible elements between consecutive applicable barriers.
    // Windows never cross a barrier, so every window lies inside its own segment.
    const historyOver = (start: number, stop: number): Pick<SegmentHistory, "max" | "code"> => {
      if (!prefixIntact(prereg)) return { max: "unknown", code: "prereg_order_unknown" };
      if (elements.slice(start, stop).some((element) => element.preregStatus === "unknown")) {
        return { max: "unknown", code: "prereg_order_unknown" };
      }
      if (stop - start < K) return { max: 0, code: null };
      const stages: (ExhaustionStage | null)[] = [];
      let code: NotAssessedCode | null = null;
      for (let end = start + K - 1; end < stop; end++) {
        const window = windowAt(end);
        stages.push(window.stage);
        if (window.stage === null && code === null) code = window.code as NotAssessedCode;
      }
      const max = segmentMaximum(stages);
      return { max, code: max === "unknown" ? code : null };
    };
    const segments: SegmentHistory[] = [];
    let segmentFrom = -1;
    let segmentStart = 0;
    for (const segmentTo of [...keyBarriers.map((barrier) => barrier.position), null]) {
      let stop = segmentStart;
      while (stop < elements.length && (segmentTo === null || elements[stop].position < segmentTo)) stop++;
      segments.push({ from: segmentFrom, to: segmentTo, count: stop - segmentStart, ...historyOver(segmentStart, stop) });
      segmentFrom = segmentTo ?? segmentFrom;
      segmentStart = stop;
    }
    const currentSegment = segments[segments.length - 1];
    const segmentCount = currentSegment.count;
    const historyMax = currentSegment.max;
    const historyCode = currentSegment.code;

    const lastWindow = windowAt(elements.length - 1);
    const report: Omit<ExhaustionKeyReport, "display"> = {
      id,
      key,
      assessed: true,
      budgetDetail: null,
      windowK: K,
      threshold: rule.threshold,
      noiseBand: prereg.noiseBand,
      eligibleCount: elements.length,
      segmentCount,
      historyMax,
      historyCode: historyMax === "unknown" ? historyCode : null,
      lastWindow,
      barrierIds,
      segments,
    };
    return { ...report, display: displayOf(report) };
  });

  const axes: AxisCount[] = [...axisIds.keys()]
    .sort()
    .map((axis) => ({ axis, n: (axisIds.get(axis) ?? []).length, ids: axisIds.get(axis) ?? [] }));

  if (analysis.unreadable.length > 0) warnings.push("analysis_unreadable_lines");

  return {
    analysis: analysisState,
    ledger: scan.ledgerState,
    unreadableLines: analysis.unreadable.length,
    complete: analysisState === "ok" && scan.ledgerState === "ok" && analysis.unreadable.length === 0,
    keys,
    axes,
    barriers,
    warnings,
  };
}

/**
 * Display mapping (§12.3, 3-state): true for H_k ∈ {1, 2}; false only for H_k = 0 after a
 * complete window; every other case is unknown with its code (`window_short` included).
 */
function displayOf(report: Omit<ExhaustionKeyReport, "display">): ExhaustionDisplay {
  if (!report.assessed) return { value: "unknown", code: "budget_exhausted", detail: report.budgetDetail };
  if (report.historyMax === "unknown") return { value: "unknown", code: report.historyCode, detail: null };
  if ((report.segmentCount ?? 0) < (report.windowK ?? DEFAULT_WINDOW_K)) return { value: "unknown", code: "window_short", detail: null };
  return report.historyMax === 0 ? { value: "false", code: null, detail: null } : { value: "true", code: null, detail: null };
}

// ---------------------------------------------------------------------------
// Transitions and hints (§12.3a table, §12.3b, §12.4)
// ---------------------------------------------------------------------------

function stageWording(report: ExhaustionKeyReport, stage: 1 | 2): string {
  const axis = report.key.axis;
  const K = report.windowK ?? DEFAULT_WINDOW_K;
  const T = report.threshold ?? 0;
  const B = report.noiseBand ?? 0;
  if (stage === 2) {
    return `Кандидат на пересмотр оси ${axis}: ${K} последних замеров, для которых контроль заявлен, ниже порога ${T} и за пределами шума ${B}. Это не вывод об исчерпании. Решение о пересмотре принимает владелец или следующий цикл обзора.`;
  }
  return `Оснований для вывода об исчерпании оси ${axis} недостаточно: ${K} замеров ниже порога ${T}, но в пределах шума ${B}. Предлагается обзор направлений (документ, не действие).`;
}

function sExhText(report: ExhaustionKeyReport, stage: 1 | 2): string {
  const { axis, prereg_id, run_epoch } = report.key;
  return [
    `Предлагается обзор направлений (S_exh): это документ, а не действие. ${EXHAUSTION_DISCLAIMER}`,
    "Для документа вызовите `direction_review`. Эксперименты не запускались.",
    `Ключ: (${axis}, ${prereg_id}, ${run_epoch}).`,
    stageWording(report, stage),
  ].join(" ");
}

function advisoryText(axis: AxisCount, threshold: number, torn: number): string {
  const parts = [
    `Предлагается обзор направлений (S_exh_adv, ось ${axis.axis}): накоплено ${axis.n} читаемых сравнений по этой оси (порог ${threshold}).`,
    "Сигнал не является доказательством исчерпания и не подтверждает метрическую дельту.",
    ADVISORY_DISCLAIMER,
    "Для документа вызовите `direction_review`. Эксперименты не запускались.",
  ];
  if (torn > 0) parts.push(`История неполная: нечитаемых строк анализа ${torn}.`);
  parts.push(`Ссылки на читаемые записи: ${axis.ids.join(", ")}.`);
  return parts.join(" ");
}

function sExhHint(report: ExhaustionKeyReport, stage: 1 | 2): ExhaustionHint {
  return {
    kind: "S_exh",
    axis: report.key.axis,
    key: report.key,
    stage,
    threshold: null,
    n: null,
    text: sExhText(report, stage),
  };
}

/** Barrier positions that the before-state had and the after-state no longer has. */
function removedBarrierPositions(previous: ExhaustionKeyReport, report: ExhaustionKeyReport): number[] {
  const remaining = new Set(report.segments.map((segment) => segment.to));
  return previous.segments
    .map((segment) => segment.to)
    .filter((position): position is number => position !== null && !remaining.has(position));
}

/**
 * Stage of the merged segment after barrier removal, when it exceeds the known maxima of both
 * segments joined by the removed barrier (§12.3a). An unknown maximum gives no hint.
 */
function raisedStageAfterRemoval(
  previous: ExhaustionKeyReport,
  report: ExhaustionKeyReport,
  removed: readonly number[],
): 1 | 2 | null {
  let raised: 1 | 2 | null = null;
  for (const position of removed) {
    const left = previous.segments.find((segment) => segment.to === position);
    const right = previous.segments.find((segment) => segment.from === position);
    const merged = report.segments.find(
      (segment) => segment.from < position && (segment.to === null || segment.to > position),
    );
    if (left === undefined || right === undefined || merged === undefined) continue;
    if (left.max === "unknown" || right.max === "unknown" || merged.max === "unknown") continue;
    if (merged.max === 0 || merged.max <= Math.max(left.max, right.max)) continue;
    const stage = merged.max as 1 | 2;
    if (raised === null || stage > raised) raised = stage;
  }
  return raised;
}

/**
 * Hints produced by one record write: S_exh stage rises and advisory count crossings.
 * `before` and `after` are computeExhaustionState results for the files before and after
 * the write. Unknown on either side yields no hint (§12.4).
 */
export function exhaustionHintsBetween(
  before: ExhaustionState,
  after: ExhaustionState,
  options: ExhaustionTransitionOptions = {},
): ExhaustionHint[] {
  const hints: ExhaustionHint[] = [];
  const affected = options.affectedKeys !== undefined ? new Set(Array.from(options.affectedKeys, exhaustionKeyId)) : null;

  for (const report of after.keys) {
    if (affected !== null && !affected.has(report.id)) continue;
    if (!report.assessed) continue;

    const previous = before.keys.find((candidate) => candidate.id === report.id);
    if (previous === undefined) {
      // A missing key is proven empty only when the whole before-state is readable and no
      // barrier of this pair or axis could hide its earlier elements (§12.4).
      const hidden = before.barriers.some((barrier) => barrierApplies(barrier, report.key.axis, report.key.prereg_id));
      if (!before.complete || hidden) continue;
      if (report.historyMax !== "unknown" && report.historyMax > 0) hints.push(sExhHint(report, report.historyMax as 1 | 2));
      continue;
    }
    if (!previous.assessed) continue;

    // Barrier removal (recovery of a proven epoch): the merged segments are compared with the
    // known maxima of both segments they joined (§12.3a «Барьеры»), not with the current segment alone.
    const removed = removedBarrierPositions(previous, report);
    if (removed.length > 0) {
      const stage = raisedStageAfterRemoval(previous, report, removed);
      if (stage !== null) hints.push(sExhHint(report, stage));
      continue;
    }

    // Stage rise within the current segment (§12.3a table): both maxima known, H_after above H_before.
    if (previous.historyMax === "unknown" || report.historyMax === "unknown" || report.historyMax === 0) continue;
    if (report.historyMax > previous.historyMax) hints.push(sExhHint(report, report.historyMax as 1 | 2));
  }

  if (before.axes !== null && after.axes !== null) {
    for (const axis of after.axes) {
      const previous = before.axes.find((candidate) => candidate.axis === axis.axis);
      const previousN = previous === undefined ? 0 : previous.n;
      // One merged advisory per call, at the highest threshold reached (§12.3b).
      const crossed = ADVISORY_THRESHOLDS.filter((threshold) => previousN < threshold && axis.n >= threshold);
      const threshold = crossed[crossed.length - 1];
      if (threshold !== undefined) {
        hints.push({
          kind: "S_exh_adv",
          axis: axis.axis,
          key: null,
          stage: null,
          threshold,
          n: axis.n,
          text: advisoryText(axis, threshold, after.unreadableLines),
        });
      }
    }
  }

  return hints;
}
