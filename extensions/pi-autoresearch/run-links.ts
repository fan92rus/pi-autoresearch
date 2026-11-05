/**
 * Run-links identity core for research-map (openspec/changes/research-map/design.md
 * §5.1, §5.2, §5.2a; decisions D-RM-05, D-RM-09). Standalone read-side core:
 * no index.ts wiring, no writes into log.jsonl, no changes to run semantics.
 *
 * - execution_id: 128 random bits rendered as 32 lowercase hex (createExecutionId).
 * - Pending identity lifecycle (§5.2): one pending object per session slot, driven by
 *   pure state transitions (beginRunIdentity / recordPendingMarker / consumeRunIdentity /
 *   resetRunIdentities). An overlapping run_experiment evicts the unconsumed pending and
 *   poisons the new identity; the poison flag is never cleared. Consumption clears the
 *   slot regardless of success and emits the confirmed link only for the really consumed
 *   run number, a complete object (both marker lines recorded) and an unpoisoned identity.
 * - Marker hashing: sha256 over the exact UTF-8 bytes of the run_started, run_result and
 *   ordinary ledger lines without the trailing LF (sha256Line).
 * - Sidecar `.auto/run-links.jsonl`: append-only records
 *   {v:1, execution_id, run_dir, started_sha256, result_sha256, log_sha256,
 *   analysis_prefix_bytes, analysis_prefix_sha256} with no additional fields, written
 *   through research-journal.ts (run-links.lock, newline guard, short-write detection,
 *   fsync). The prefix pair is two nulls when the analysis snapshot was not confirmed.
 * - Read-side classification (§5.2): proven / absent / ambiguous, FAIL-CLOSED and
 *   recomputed from file contents on every call. proven needs one valid sidecar record,
 *   exactly one ledger row with run = N, exactly one complete ledger line per each of the
 *   three hashes, run_dir/run and started_at correspondence, order start < result < row,
 *   binding = verified and no torn line from the start marker through the result marker.
 *   An unreadable or damaged sidecar line makes every run with an ordinary ledger row
 *   ambiguous; a missing row under an intact ledger is absent; a torn ledger tail is
 *   ambiguous. No process memory, no healthy defaults as proof.
 * - run_epoch per §5.2a rule B (default): proven only for proven links, from the
 *   measurement_change* family positions relative to the run lines and the active scale
 *   at read time (measurementScaleStatus over the same ledger text). Any scale-family row
 *   after the run_started position → run_epoch null (scale_changed_after_run).
 *
 * Pure functions over file contents: absent/unreadable inputs degrade to unknown
 * verdicts and never throw to the caller.
 */

import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { parseJsonlEntry } from "./jsonl.ts";
import { measurementScaleStatus } from "./measurement.ts";
import {
  appendJournalLine,
  journalTarget,
  type JournalAppendResult,
  type JournalOptions,
} from "./research-journal.ts";

// ---------------------------------------------------------------------------
// Constants and small validators
// ---------------------------------------------------------------------------

export const RUN_LINK_STATES = ["proven", "absent", "ambiguous"] as const;
export const BINDING_STATES = ["verified", "unverified", "unsettled"] as const;
export const RUN_EPOCH_BASES = [
  "proven",
  "not_linked",
  "no_marker",
  "unverified_binding",
  "scale_changed_in_window",
  "scale_changed_after_run",
  "epoch_conflict",
  "ledger_torn_tail",
] as const;

export type RunLinkState = (typeof RUN_LINK_STATES)[number];
export type BindingState = (typeof BINDING_STATES)[number];
export type RunEpochBasis = (typeof RUN_EPOCH_BASES)[number];

export const EXECUTION_ID_RE = /^[0-9a-f]{32}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
/** Run directory numbers minted by the lens stay in 1…10^9 (§5.2). */
export const RUN_NUMBER_MAX = 1_000_000_000;

export function isRunNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= RUN_NUMBER_MAX;
}

// ---------------------------------------------------------------------------
// execution_id and marker-line hashing (§5.2)
// ---------------------------------------------------------------------------

/** 128 random bits as 32 lowercase hex characters. */
export function createExecutionId(randomBytes: (size: number) => Buffer = cryptoRandomBytes): string {
  return randomBytes(16).toString("hex");
}

export function isValidExecutionId(value: unknown): value is string {
  return typeof value === "string" && EXECUTION_ID_RE.test(value);
}

/** sha256 over the exact UTF-8 bytes of one serialized ledger line, without the trailing LF. */
export function sha256Line(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pending identity lifecycle (§5.2) — pure transitions over one session slot
// ---------------------------------------------------------------------------

/** One unfinished run_experiment call: number + exact marker lines + ambiguity flag. */
export interface PendingRunIdentity {
  readonly executionId: string;
  /** Run number minted for this call (runtime.lastRunNumber source); null when unknown. */
  readonly run: number | null;
  /** Exact serialized run_started ledger line (no LF); null when the write failed. */
  readonly startedLine: string | null;
  /** Exact serialized run_result ledger line (no LF); null when the write failed. */
  readonly resultLine: string | null;
  readonly startedRecorded: boolean;
  readonly resultRecorded: boolean;
  /** Sticky: once a marker write failed, a later re-record can never heal it (§5.2). */
  readonly startedFailed: boolean;
  readonly resultFailed: boolean;
  readonly analysisPrefixBytes: number | null;
  readonly analysisPrefixSha256: string | null;
  /** Set by an overlapping run_experiment; never cleared (§5.2). */
  readonly poisoned: boolean;
}

export interface RunLinksRuntime {
  readonly pending: PendingRunIdentity | null;
}

export function emptyRunLinksRuntime(): RunLinksRuntime {
  return { pending: null };
}

export interface BeginRunParams {
  executionId: string;
  run: number | null;
  analysisPrefixBytes?: number | null;
  analysisPrefixSha256?: string | null;
}

/**
 * A new run_experiment starts. When a previous call of this session has been allocated a
 * number and has not been consumed yet, its pending object is evicted (dropped entirely —
 * a late completion never resurrects it) and the new identity starts poisoned: neither
 * overlapping call may create a proven link (§5.2 conservative intersection rule).
 */
export function beginRunIdentity(state: RunLinksRuntime, params: BeginRunParams): RunLinksRuntime {
  if (!isValidExecutionId(params.executionId)) {
    throw new RangeError("execution_id must be 32 lowercase hex characters");
  }
  if (params.run !== null && !isRunNumber(params.run)) {
    throw new RangeError("run must be a safe integer from 1 to 1000000000 or null");
  }
  const prefixBytes = params.analysisPrefixBytes ?? null;
  const prefixSha = params.analysisPrefixSha256 ?? null;
  if ((prefixBytes === null) !== (prefixSha === null)) {
    throw new RangeError("analysis prefix requires both bytes and sha256 (or neither)");
  }
  const poisoned = state.pending !== null;
  return {
    pending: {
      executionId: params.executionId,
      run: params.run,
      startedLine: null,
      resultLine: null,
      startedRecorded: false,
      resultRecorded: false,
      startedFailed: false,
      resultFailed: false,
      analysisPrefixBytes: prefixBytes,
      analysisPrefixSha256: prefixSha,
      poisoned,
    },
  };
}

export type PendingMarkerKind = "started" | "result";

/**
 * Record the exact marker line written (or failed: line = null) for a pending call.
 * A call whose identity was evicted or is unknown is ignored: a late completion never
 * resurrects an old pending object and never changes the current one (§5.2).
 * A marker write failure is sticky: once recorded for the pending slot, a later
 * successful re-record of the same marker never restores recorded=true.
 */
export function recordPendingMarker(
  state: RunLinksRuntime,
  kind: PendingMarkerKind,
  executionId: string,
  line: string | null,
): RunLinksRuntime {
  const pending = state.pending;
  if (pending === null || pending.executionId !== executionId) return state;
  if (kind === "started") {
    // A marker write failure is sticky: a later successful re-record must not make a
    // failed identity consumable (§5.2), so recorded stays false once a failure happened.
    const startedFailed = pending.startedFailed || line === null;
    return {
      pending: { ...pending, startedLine: line, startedRecorded: line !== null && !startedFailed, startedFailed },
    };
  }
  const resultFailed = pending.resultFailed || line === null;
  return { pending: { ...pending, resultLine: line, resultRecorded: line !== null && !resultFailed, resultFailed } };
}

export type ConsumeFailureReason = "no_pending" | "run_mismatch" | "poisoned" | "incomplete";

export type ConsumedRunIdentity =
  | { state: RunLinksRuntime; link: ConfirmedRunLink; reason: null }
  | { state: RunLinksRuntime; link: null; reason: ConsumeFailureReason };

/**
 * log_experiment consumes the pending object together with the run number it really
 * logged. The slot is cleared regardless of the outcome (§5.2). The confirmed link is
 * returned only when the number matches the really consumed lastRunNumber (never a
 * computed fallback), the identity is not poisoned and both marker lines were recorded.
 * A failed marker write makes the identity incomplete; no link is produced for it.
 */
export function consumeRunIdentity(state: RunLinksRuntime, runNumber: number, logLine: string): ConsumedRunIdentity {
  const cleared: RunLinksRuntime = { pending: null };
  const pending = state.pending;
  if (pending === null) return { state: cleared, link: null, reason: "no_pending" };
  if (pending.run === null || pending.run !== runNumber || !isRunNumber(runNumber)) {
    return { state: cleared, link: null, reason: "run_mismatch" };
  }
  if (pending.poisoned) return { state: cleared, link: null, reason: "poisoned" };
  if (!pending.startedRecorded || !pending.resultRecorded || pending.startedLine === null || pending.resultLine === null) {
    return { state: cleared, link: null, reason: "incomplete" };
  }
  return {
    state: cleared,
    reason: null,
    link: {
      executionId: pending.executionId,
      run: pending.run,
      startedSha256: sha256Line(pending.startedLine),
      resultSha256: sha256Line(pending.resultLine),
      logSha256: sha256Line(logLine),
      analysisPrefixBytes: pending.analysisPrefixBytes,
      analysisPrefixSha256: pending.analysisPrefixSha256,
    },
  };
}

/** init_experiment and restart reset the pending state (§5.2). */
export function resetRunIdentities(_state: RunLinksRuntime): RunLinksRuntime {
  return { pending: null };
}

// ---------------------------------------------------------------------------
// Sidecar record (§5.2): shape, serialization, append
// ---------------------------------------------------------------------------

export interface ConfirmedRunLink {
  readonly executionId: string;
  readonly run: number;
  readonly startedSha256: string;
  readonly resultSha256: string;
  readonly logSha256: string;
  readonly analysisPrefixBytes: number | null;
  readonly analysisPrefixSha256: string | null;
}

/** One stored `.auto/run-links.jsonl` record (§5.2 format: no additional fields). */
export interface RunLinkRecord {
  readonly v: 1;
  readonly execution_id: string;
  readonly run_dir: number;
  readonly started_sha256: string;
  readonly result_sha256: string;
  readonly log_sha256: string;
  readonly analysis_prefix_bytes: number | null;
  readonly analysis_prefix_sha256: string | null;
}

const RECORD_KEYS = [
  "v",
  "execution_id",
  "run_dir",
  "started_sha256",
  "result_sha256",
  "log_sha256",
  "analysis_prefix_bytes",
  "analysis_prefix_sha256",
] as const;

/** Validate the stored record shape. Anything else makes the journal unfit for proven. */
export function parseRunLinkRecord(entry: unknown): RunLinkRecord | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || RECORD_KEYS.some((key) => !(key in record))) return null;
  if (record.v !== 1) return null;
  if (!isValidExecutionId(record.execution_id)) return null;
  if (!isRunNumber(record.run_dir)) return null;
  for (const hash of [record.started_sha256, record.result_sha256, record.log_sha256]) {
    if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) return null;
  }
  const bytes = record.analysis_prefix_bytes;
  const sha = record.analysis_prefix_sha256;
  if ((bytes === null) !== (sha === null)) return null;
  if (bytes !== null && !(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0)) return null;
  if (sha !== null && !(typeof sha === "string" && SHA256_HEX_RE.test(sha))) return null;
  return record as unknown as RunLinkRecord;
}

/** Exact wire line (without LF) in the §5.2 field order. */
export function serializeRunLinkRecord(link: ConfirmedRunLink): string {
  return JSON.stringify({
    v: 1,
    execution_id: link.executionId,
    run_dir: link.run,
    started_sha256: link.startedSha256,
    result_sha256: link.resultSha256,
    log_sha256: link.logSha256,
    analysis_prefix_bytes: link.analysisPrefixBytes,
    analysis_prefix_sha256: link.analysisPrefixSha256,
  });
}

export function isValidConfirmedLink(link: unknown): link is ConfirmedRunLink {
  if (link === null || typeof link !== "object") return false;
  const candidate = link as Record<string, unknown>;
  if (!isValidExecutionId(candidate.executionId)) return false;
  if (!isRunNumber(candidate.run)) return false;
  for (const hash of [candidate.startedSha256, candidate.resultSha256, candidate.logSha256]) {
    if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) return false;
  }
  const bytes = candidate.analysisPrefixBytes;
  const sha = candidate.analysisPrefixSha256;
  // The prefix pair must be paired or absent, exactly like parseRunLinkRecord (§5.2):
  // an unpaired prefix would be appended but then rejected by the reader, corrupting the
  // whole journal.
  if ((bytes === null) !== (sha === null)) return false;
  const bytesOk = bytes === null || (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0);
  const shaOk = sha === null || (typeof sha === "string" && SHA256_HEX_RE.test(sha));
  return bytesOk && shaOk;
}

/**
 * Best-effort append of one confirmed link record to `.auto/run-links.jsonl` under
 * `run-links.lock` (research-journal protocol: newline guard, single write, no retry of
 * a short write, fsync). A failure never affects the outcome of the main tool.
 */
export function appendRunLinkRecord(
  autoDir: string,
  link: ConfirmedRunLink,
  options: JournalOptions = {},
): Promise<JournalAppendResult> {
  if (!isValidConfirmedLink(link)) {
    return Promise.resolve<JournalAppendResult>({
      status: "invalid_line",
      message: "confirmed run link does not match the §5.2 record shape; nothing written",
    });
  }
  return appendJournalLine(journalTarget(autoDir, "run-links"), serializeRunLinkRecord(link), options);
}

// ---------------------------------------------------------------------------
// Ledger scan and sidecar journal read (§5.2, §6.4-style parsing)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface LedgerMarker {
  index: number;
  type: "run_started" | "run_result";
  run_dir: unknown;
  started_at: unknown;
}

interface LedgerRow {
  index: number;
  entry: JsonObject;
  /** Exact line text (no LF); hashed for sidecar matching. */
  line: string;
}

export interface LedgerScan {
  rows: LedgerRow[];
  markers: LedgerMarker[];
  /** Indexes of non-empty lines that do not parse to a JSON object. */
  torn: number[];
}

function isMarkerEntry(entry: JsonObject): entry is JsonObject & { type: "run_started" | "run_result" } {
  return entry.type === "run_started" || entry.type === "run_result";
}

/** All measurement_change* subtypes count as scale rows in rule B (§5.2a). */
function isScaleFamilyRow(entry: JsonObject): boolean {
  return typeof entry.type === "string" && entry.type.startsWith("measurement_change");
}

export function scanLedgerForLinks(text: string): LedgerScan {
  const scan: LedgerScan = { rows: [], markers: [], torn: [] };
  let index = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      const entry = parseJsonlEntry(line);
      if (entry === null) {
        scan.torn.push(index);
      } else {
        scan.rows.push({ index, entry, line });
        if (isMarkerEntry(entry)) {
          scan.markers.push({ index, type: entry.type, run_dir: entry.run_dir, started_at: entry.started_at });
        }
      }
    }
    index++;
  }
  return scan;
}

export type RunLinksJournalRead =
  | { state: "ok"; records: RunLinkRecord[] }
  | { state: "corrupt"; reason: string; torn_lines: number; invalid_lines: number };

/**
 * Read the run-links journal text. A torn line, a wrong-shaped record or a repeated
 * execution_id makes the whole journal unfit for confirming links (§5.2) — the journal
 * is never repaired or rewritten here.
 */
export function readRunLinksJournal(text: string): RunLinksJournalRead {
  const records: RunLinkRecord[] = [];
  const seenIds = new Set<string>();
  let torn = 0;
  let invalid = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) {
      torn++;
      continue;
    }
    const record = parseRunLinkRecord(entry);
    if (record === null) {
      invalid++;
      continue;
    }
    if (seenIds.has(record.execution_id)) {
      return {
        state: "corrupt",
        reason: `duplicate execution_id ${record.execution_id}`,
        torn_lines: torn,
        invalid_lines: invalid,
      };
    }
    seenIds.add(record.execution_id);
    records.push(record);
  }
  // §5.2/§6.1: any torn or wrong-shaped line makes every link ambiguous until the
  // owner archives the file — the journal is accepted as a whole or not at all.
  if (torn > 0 || invalid > 0) {
    return { state: "corrupt", reason: `${torn} torn and ${invalid} malformed line(s)`, torn_lines: torn, invalid_lines: invalid };
  }
  return { state: "ok", records };
}

// ---------------------------------------------------------------------------
// Loading both files (fail-closed, never throws to the caller)
// ---------------------------------------------------------------------------

/** The subset of node:fs used here; tests inject replacements through options.fs. */
export interface RunLinksFs {
  readFileSync(file: string, encoding: "utf8"): string;
}

export interface RunLinksOptions {
  fs?: Partial<RunLinksFs>;
}

const NODE_FS: RunLinksFs = {
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
};

export type FileReadState = "ok" | "missing" | "unavailable";

export interface RunLinksScan {
  readonly autoDir: string;
  readonly ledgerState: FileReadState;
  readonly sidecarState: FileReadState | "corrupt";
  readonly ledger: LedgerScan | null;
  readonly records: RunLinkRecord[];
  /** Active scale epoch at read time (§5.2a rule B); null when the ledger is not readable. */
  readonly activeEpoch: number | null;
  /** Report-level warnings (ledger_missing, ledger_unavailable, run_links_corrupt, run_links_unavailable). */
  readonly warnings: string[];
}

function readTextFile(file: string, ops: RunLinksFs): { state: FileReadState; text: string } {
  try {
    return { state: "ok", text: ops.readFileSync(file, "utf8") };
  } catch (error) {
    const enoent = typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
    return { state: enoent ? "missing" : "unavailable", text: "" };
  }
}

export function loadRunLinksState(autoDir: string, options: RunLinksOptions = {}): RunLinksScan {
  const ops: RunLinksFs = { ...NODE_FS, ...options.fs };
  const warnings: string[] = [];

  const ledger = readTextFile(path.join(autoDir, "log.jsonl"), ops);
  let ledgerState: FileReadState = ledger.state;
  let ledgerScan: LedgerScan | null = null;
  let activeEpoch: number | null = null;
  if (ledgerState === "ok") {
    // Rule B reads the active scale from the SAME ledger text: a healthy default must
    // never serve as proof when the file cannot be read (§5.2).
    ledgerScan = scanLedgerForLinks(ledger.text);
    activeEpoch = measurementScaleStatus(ledger.text).epoch;
  } else {
    warnings.push(ledgerState === "missing" ? "ledger_missing" : "ledger_unavailable");
  }

  const sidecar = readTextFile(journalTarget(autoDir, "run-links").file, ops);
  let sidecarState: FileReadState | "corrupt" = sidecar.state;
  let records: RunLinkRecord[] = [];
  if (sidecar.state === "unavailable") {
    warnings.push("run_links_unavailable");
  } else if (sidecar.state === "ok") {
    const read = readRunLinksJournal(sidecar.text);
    if (read.state === "ok") {
      records = read.records;
    } else {
      sidecarState = "corrupt";
      warnings.push("run_links_corrupt");
    }
  }
  // A missing sidecar is the normal legacy state (T130): no warning.

  return { autoDir, ledgerState, sidecarState, ledger: ledgerScan, records, activeEpoch, warnings };
}

// ---------------------------------------------------------------------------
// Classification (§5.2): proven / absent / ambiguous + §5.2a rule B epoch
// ---------------------------------------------------------------------------

export interface RunLinkVerdict {
  readonly run: number;
  readonly link: RunLinkState;
  readonly settled: boolean | null;
  readonly binding: BindingState;
  readonly runEpoch: number | null;
  readonly runEpochBasis: RunEpochBasis;
  /** execution_id of the confirming record when proven, else null. */
  readonly executionId: string | null;
  readonly analysisPrefixBytes: number | null;
  readonly analysisPrefixSha256: string | null;
  readonly warnings: string[];
}

interface BindingOutcome {
  settled: boolean | null;
  binding: BindingState;
  start: LedgerMarker | null;
  result: LedgerMarker | null;
}

/** §5.2 binding from the run markers of one number (verified/unverified/unsettled). */
function computeBinding(markers: LedgerMarker[], run: number): BindingOutcome {
  const starts = markers.filter((m) => m.type === "run_started" && m.run_dir === run);
  const results = markers.filter((m) => m.type === "run_result" && m.run_dir === run);
  const start = starts.length > 0 ? starts[starts.length - 1] : null;
  const result = results.length > 0 ? results[results.length - 1] : null;

  if (start !== null && result !== null) {
    if (result.index > start.index) {
      const sameStartedAt = typeof start.started_at === "string" && start.started_at === result.started_at;
      const pairUnique = starts.length === 1 && results.length === 1;
      return { settled: true, binding: pairUnique && sameStartedAt ? "verified" : "unverified", start, result };
    }
    return { settled: false, binding: "unsettled", start, result };
  }
  if (result !== null) return { settled: true, binding: "unverified", start, result };
  if (start !== null) return { settled: false, binding: "unsettled", start, result };
  return { settled: null, binding: "unverified", start: null, result: null };
}

interface LinkContext {
  scan: RunLinksScan;
  ledger: LedgerScan;
  /** ledger line hash → row indexes (complete lines only). */
  hashIndex: Map<string, number[]>;
  recordsByRun: Map<number, RunLinkRecord[]>;
  /** True when a torn line follows the last marker (or any torn line with no markers). */
  tornAfter: boolean;
}

function prepareContext(scan: RunLinksScan): LinkContext {
  const ledger = scan.ledger ?? { rows: [], markers: [], torn: [] };
  const hashIndex = new Map<string, number[]>();
  for (const row of ledger.rows) {
    const hash = sha256Line(row.line);
    const indexes = hashIndex.get(hash);
    if (indexes === undefined) hashIndex.set(hash, [row.index]);
    else indexes.push(row.index);
  }
  const recordsByRun = new Map<number, RunLinkRecord[]>();
  for (const record of scan.records) {
    const list = recordsByRun.get(record.run_dir);
    if (list === undefined) recordsByRun.set(record.run_dir, [record]);
    else list.push(record);
  }
  const lastMarker = ledger.markers.length > 0 ? ledger.markers[ledger.markers.length - 1] : null;
  const tornAfter = ledger.torn.some((index) => lastMarker === null || index > lastMarker.index);
  return { scan, ledger, hashIndex, recordsByRun, tornAfter };
}

function baseVerdict(run: number): {
  run: number;
  settled: boolean | null;
  binding: BindingState;
  runEpoch: number | null;
  executionId: string | null;
  analysisPrefixBytes: number | null;
  analysisPrefixSha256: string | null;
} {
  return {
    run,
    settled: null,
    binding: "unverified",
    runEpoch: null,
    executionId: null,
    analysisPrefixBytes: null,
    analysisPrefixSha256: null,
  };
}

/** §5.2 proven proof for one number against the current ledger lines and sidecar records. */
function proveLink(
  ctx: LinkContext,
  run: number,
  record: RunLinkRecord,
  runRow: LedgerRow,
  binding: BindingOutcome,
): { proven: boolean; executionId: string | null; prefixBytes: number | null; prefixSha: string | null } {
  const fail = { proven: false, executionId: null, prefixBytes: null, prefixSha: null };
  const startMatches = ctx.hashIndex.get(record.started_sha256) ?? [];
  const resultMatches = ctx.hashIndex.get(record.result_sha256) ?? [];
  const logMatches = ctx.hashIndex.get(record.log_sha256) ?? [];

  // Exactly one complete line per hash, and it must be the right marker of this run.
  if (startMatches.length !== 1) return fail;
  const startRow = ctx.ledger.rows.find((row) => row.index === startMatches[0]);
  if (startRow === undefined || startRow.entry.type !== "run_started" || startRow.entry.run_dir !== run) return fail;

  if (resultMatches.length !== 1) return fail;
  const resultRow = ctx.ledger.rows.find((row) => row.index === resultMatches[0]);
  if (resultRow === undefined || resultRow.entry.type !== "run_result" || resultRow.entry.run_dir !== run) return fail;

  if (logMatches.length !== 1 || logMatches[0] !== runRow.index) return fail;

  // started_at correspondence of both markers (§5.2).
  if (
    typeof startRow.entry.started_at !== "string" ||
    typeof resultRow.entry.started_at !== "string" ||
    startRow.entry.started_at !== resultRow.entry.started_at
  ) {
    return fail;
  }

  // Order start < result < ordinary row, binding verified, no torn line in the window.
  if (!(startRow.index < resultRow.index && resultRow.index < runRow.index)) return fail;
  if (binding.binding !== "verified") return fail;
  if (ctx.ledger.torn.some((index) => index >= startRow.index && index <= resultRow.index)) return fail;

  return { proven: true, executionId: record.execution_id, prefixBytes: record.analysis_prefix_bytes, prefixSha: record.analysis_prefix_sha256 };
}

function classifyWithContext(ctx: LinkContext, run: number): RunLinkVerdict {
  if (!isRunNumber(run)) {
    return { ...baseVerdict(run), link: "ambiguous", runEpochBasis: "no_marker", warnings: ["invalid_run_number"] };
  }

  // Unreadable or missing ledger: no links and no proven epochs (§5.2) — never a healthy default.
  if (ctx.scan.ledgerState !== "ok" || ctx.scan.ledger === null) {
    return {
      ...baseVerdict(run),
      link: "ambiguous",
      runEpochBasis: "no_marker",
      warnings: [...ctx.scan.warnings],
    };
  }

  const { rows, markers, torn } = ctx.ledger;
  const { tornAfter } = ctx;
  const warnings: string[] = [];
  if (ctx.tornAfter) warnings.push("ledger_torn_tail");

  const runRows = rows.filter((row) => row.entry.run === run);
  const binding = computeBinding(markers, run);

  let link: RunLinkState;
  let executionId: string | null = null;
  let prefixBytes: number | null = null;
  let prefixSha: string | null = null;

  if (runRows.length === 0) {
    // absent claims there is no ordinary row: only under an undamaged ledger (§5.2).
    // A torn line anywhere could hide a row for this run → fail closed to ambiguous.
    link = torn.length === 0 ? "absent" : "ambiguous";
  } else if (runRows.length > 1) {
    link = "ambiguous";
    if (markers.some((m) => m.run_dir === run)) warnings.push("run_number_shared");
  } else if (tornAfter) {
    // An ambiguous tail (tornAfter) makes every existing-row link ambiguous (§5.2).
    link = "ambiguous";
  } else if (ctx.scan.sidecarState !== "ok") {
    // An existing row without a usable journal is ambiguous, never absent (§5.2).
    link = "ambiguous";
    if (ctx.scan.sidecarState === "corrupt") warnings.push("run_links_corrupt");
    if (ctx.scan.sidecarState === "unavailable") warnings.push("run_links_unavailable");
  } else {
    const records = ctx.recordsByRun.get(run) ?? [];
    if (records.length === 0) {
      link = "ambiguous";
    } else if (records.length > 1) {
      link = "ambiguous";
      warnings.push("run_link_conflict");
    } else {
      const proof = proveLink(ctx, run, records[0], runRows[0], binding);
      link = proof.proven ? "proven" : "ambiguous";
      executionId = proof.executionId;
      prefixBytes = proof.prefixBytes;
      prefixSha = proof.prefixSha;
    }
  }

  // §5.2a rule B epoch. The scale at read time is only proof under a proven link.
  // Basis order per §5.2a: no_marker → unverified_binding → scale_changed_after_run →
  // epoch_conflict (needs the proven L-row) → ledger_torn_tail (torn after R_N or in
  // the window, i.e. at/after the start position) → not_linked → proven.
  const activeEpoch = ctx.scan.activeEpoch;
  let runEpochBasis: RunEpochBasis;
  let runEpoch: number | null = null;
  if (binding.start === null || binding.result === null) {
    runEpochBasis = "no_marker";
  } else if (binding.binding !== "verified") {
    runEpochBasis = "unverified_binding";
  } else if (rows.some((row) => row.index > binding.start!.index && isScaleFamilyRow(row.entry))) {
    runEpochBasis = "scale_changed_after_run";
  } else if (link === "proven") {
    const ledgerEpoch = runRows[0].entry.epoch;
    if (
      typeof ledgerEpoch === "number" &&
      Number.isSafeInteger(ledgerEpoch) &&
      ledgerEpoch >= 1 &&
      ledgerEpoch === activeEpoch &&
      !torn.some((index) => index >= binding.start!.index)
    ) {
      runEpochBasis = "proven";
      runEpoch = activeEpoch;
    } else {
      runEpochBasis = torn.some((index) => index >= binding.start!.index) ? "ledger_torn_tail" : "epoch_conflict";
    }
  } else if (torn.some((index) => index >= binding.start!.index)) {
    // A torn line after R_N or in the window blocks the epoch even without a proven link.
    runEpochBasis = "ledger_torn_tail";
  } else {
    runEpochBasis = "not_linked";
  }

  return {
    run,
    link,
    settled: binding.settled,
    binding: binding.binding,
    runEpoch,
    runEpochBasis,
    executionId,
    analysisPrefixBytes: prefixBytes,
    analysisPrefixSha256: prefixSha,
    warnings,
  };
}

/** Classify one run number (§5.2 runLinkOf). Pure over the loaded file state. */
export function classifyRunLink(scan: RunLinksScan, run: number): RunLinkVerdict {
  return classifyWithContext(prepareContext(scan), run);
}

/** runLinkOf(autoDir, N): load both files and classify (§5.2). Never throws. */
export function runLinkOf(autoDir: string, run: number, options: RunLinksOptions = {}): RunLinkVerdict {
  return classifyRunLink(loadRunLinksState(autoDir, options), run);
}

/** Classify every number appearing in ledger rows, markers or sidecar records. */
export function classifyAllRunLinks(scan: RunLinksScan): Map<number, RunLinkVerdict> {
  const ctx = prepareContext(scan);
  const numbers = new Set<number>();
  for (const row of ctx.ledger.rows) {
    if (typeof row.entry.run === "number") numbers.add(row.entry.run);
  }
  for (const marker of ctx.ledger.markers) {
    if (isRunNumber(marker.run_dir)) numbers.add(marker.run_dir);
  }
  for (const record of scan.records) numbers.add(record.run_dir);
  const verdicts = new Map<number, RunLinkVerdict>();
  for (const number of numbers) verdicts.set(number, classifyWithContext(ctx, number));
  return verdicts;
}
