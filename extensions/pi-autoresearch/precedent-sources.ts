/**
 * Read-only adapters for local precedent sources (research-precedent-search).
 *
 * Task 1.1 foundation: bounded, streaming, read-only access to the four local
 * sources a precedent search may consult:
 *   - log      — campaign ledger, `.auto/log.jsonl` with legacy fallback to
 *                `autoresearch.jsonl`, selected exactly like council buildBrief
 *   - tree     — hypothesis tree, `.auto/tree.json`
 *   - ideas    — idea notes, `.auto/ideas/**`
 *   - councils — past council archives, `.auto/councils/**`
 *
 * Guarantees:
 *   - READ-ONLY: nothing here writes, renames or deletes. History is data.
 *   - STREAMING: JSONL is read line by line via chunked reads; a line is only
 *     parsed once it is complete. A line cut short by the byte budget is never
 *     parsed and never counted as evidence. Directory entries are enumerated
 *     with a limit instead of being collected wholesale.
 *   - BOUNDED: callers share one SourceBudget counting bytes read and
 *     files/directory entries visited. Adapters stop and report `truncated`
 *     when the budget runs out, when the consumer's visitor returns false, or
 *     when the optional AbortSignal fires. Bytes and items are charged before
 *     the data is processed. Without options the default local limits apply
 *     (10 MiB, 2000 items per adapter call).
 *   - ROOT-BOUND: every opened path is validated against the canonical root
 *     (fs.realpathSync) both lexically and after symlink resolution. Directory
 *     listings and file streams of ideas/councils are additionally confined to
 *     their own subtree: a link that resolves elsewhere under the root is not
 *     read. A source whose own path escapes the root is refused with status
 *     `error`; escaped entries inside an otherwise readable source are skipped
 *     and counted in `outsideRoot`. checkPathInRoots applies the same rules to
 *     path strings found inside records, without opening them.
 *
 * Coverage statuses (spec: searched / unavailable / error / truncated):
 *   - unavailable  — optional source (tree/ideas/councils) missing, or both
 *     ledger candidates missing; checked before any budget
 *   - error        — source exists but could not be read safely or fully
 *     (escapes the root, unreadable, malformed lines, corrupt JSON)
 *   - truncated    — stopped by the byte/item budget, the visitor or an abort
 *   - searched     — every reachable entry of the source was streamed without
 *     errors
 *
 * Non-goals (later tasks): token search and candidate ranking (1.2), the
 * subprocess budget runner and wall-clock deadline (1.2), follow-up identifier
 * search (1.3), report writing and any tool registration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseJsonlEntry, type JsonlEntry } from "./jsonl.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PrecedentSourceId = "log" | "tree" | "ideas" | "councils";

/** Pointer to evidence inside a source: file path relative to the root (POSIX), plus a line (JSONL/text) or JSON pointer (tree.json). */
export interface PrecedentSourceRef {
  source: PrecedentSourceId;
  /** Path relative to the search root, always with forward slashes. */
  path: string;
  /** 1-based physical line number, for line-oriented sources. */
  line?: number;
  /** JSON pointer into tree.json (`"/"` for the tree meta, `"/nodes/<id>"` for nodes). */
  pointer?: string;
}

/** Ledger entries, tree nodes/meta, or raw markdown text of ideas/council files. */
export type PrecedentRecordData = JsonlEntry | string;

export interface PrecedentRecord {
  ref: PrecedentSourceRef;
  data: PrecedentRecordData;
}

export type PrecedentSourceStatus = "searched" | "unavailable" | "error" | "truncated";

/** Why a source stopped before completing. */
export type PrecedentTruncation = "bytes" | "items" | "visitor" | "abort";

/** Streaming consumer. Return false to stop the source early (reported as truncated by "visitor"). */
export type PrecedentRecordVisitor = (record: PrecedentRecord) => boolean | void;

/** Shared, mutable budget across the sources of one search run (or one pass). */
export interface SourceBudget {
  readonly maxBytes: number;
  readonly maxItems: number;
  bytesSpent(): number;
  itemsSpent(): number;
  remainingBytes(): number;
  remainingItems(): number;
  canSpendBytes(n: number): boolean;
  canSpendItems(n: number): boolean;
  spendBytes(n: number): void;
  spendItems(n: number): void;
  isExhausted(): boolean;
}

export interface SourceReadOptions {
  /**
   * Shared budget of the search run. When omitted, the default local limits
   * apply (10 MiB, 2000 items) for this adapter call.
   */
  budget?: SourceBudget;
  /**
   * Optional separate budget for one pass (e.g. a follow-up pass). Every read
   * is charged to both `budget` and `passBudget`; it stops when either runs out.
   */
  passBudget?: SourceBudget;
  /** Cancellation. The read stops with `truncatedBy: "abort"` once the signal is observed. */
  signal?: AbortSignal;
  /** Ledger only: first 1-based physical line to deliver. Earlier lines are still read (bytes charged) but not parsed. */
  startLine?: number;
}

export interface SourceReadResult {
  source: PrecedentSourceId;
  status: PrecedentSourceStatus;
  /** Root-relative POSIX path of the backing file/dir, when it exists. */
  path?: string;
  /** Which ledger candidate answered (log source only). */
  ledger?: "current" | "legacy";
  /** Bytes of source data actually read (charged to the budget). */
  bytes: number;
  /** Files and directory entries visited (charged to the budget). */
  items: number;
  /** Records delivered to the visitor. */
  records: number;
  /** Ledger only: complete lines that failed to parse (skipped, not evidence). */
  malformedLines?: number;
  /** Entries refused because their real path escapes the allowed root (for ideas/councils: their own subtree). */
  outsideRoot?: number;
  /** Entries inside the root that could not be listed/verified/read. */
  readErrors?: number;
  truncatedBy?: PrecedentTruncation;
  error?: string;
}

export interface PrecedentSourceAdapter {
  id: PrecedentSourceId;
  read(rootReal: string | null, visit: PrecedentRecordVisitor, options?: SourceReadOptions): Promise<SourceReadResult>;
}

/** Result of validating one absolute candidate path against a canonical root. */
export type PathGuardResult =
  | { ok: true; real: string }
  | { ok: false; reason: "outside-root" | "missing" | "inaccessible" };

/** Result of validating a path string found inside a record, without opening it. */
export type ReferenceCheckResult =
  | { ok: true; absolute: string; root: string }
  | { ok: false; reason: "invalid" | "outside-root" | "missing" };

export interface LedgerCandidate {
  kind: "current" | "legacy";
  abs: string;
}

const DEFAULT_MAX_BYTES = 10 * 1048576;
const DEFAULT_MAX_ITEMS = 2000;

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Create a shared budget. Omitted limits are unbounded; the search layer passes the global budget. */
export function createBudget(options: { maxBytes?: number; maxItems?: number } = {}): SourceBudget {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  let bytes = 0;
  let items = 0;
  return {
    maxBytes,
    maxItems,
    bytesSpent: () => bytes,
    itemsSpent: () => items,
    remainingBytes: () => maxBytes - bytes,
    remainingItems: () => maxItems - items,
    canSpendBytes: (n) => bytes + n <= maxBytes,
    canSpendItems: (n) => items + n <= maxItems,
    spendBytes: (n) => { bytes += n; },
    spendItems: (n) => { items += n; },
    isExhausted: () => maxBytes - bytes <= 0 || maxItems - items <= 0,
  };
}

/** Charges every spend to both budgets; a spend is allowed only when both allow it. */
function combineBudgets(shared: SourceBudget, pass: SourceBudget): SourceBudget {
  return {
    maxBytes: Math.min(shared.maxBytes, pass.maxBytes),
    maxItems: Math.min(shared.maxItems, pass.maxItems),
    // Totals are reported from the shared (run-wide) budget.
    bytesSpent: () => shared.bytesSpent(),
    itemsSpent: () => shared.itemsSpent(),
    remainingBytes: () => Math.min(shared.remainingBytes(), pass.remainingBytes()),
    remainingItems: () => Math.min(shared.remainingItems(), pass.remainingItems()),
    canSpendBytes: (n) => shared.canSpendBytes(n) && pass.canSpendBytes(n),
    canSpendItems: (n) => shared.canSpendItems(n) && pass.canSpendItems(n),
    spendBytes: (n) => { shared.spendBytes(n); pass.spendBytes(n); },
    spendItems: (n) => { shared.spendItems(n); pass.spendItems(n); },
    isExhausted: () => shared.isExhausted() || pass.isExhausted(),
  };
}

/** Why a source must stop before reading anything, or null to proceed. */
type StopReason = "abort" | "bytes" | "items";

function stopReason(budget: SourceBudget, signal?: AbortSignal): StopReason | null {
  if (signal?.aborted) return "abort";
  if (!budget.isExhausted()) return null;
  return budget.remainingItems() <= 0 ? "items" : "bytes";
}

// ─── Counters (per-source local mirror of what was charged to the budget) ────

interface SourceCounters {
  bytes: number;
  items: number;
  records: number;
  malformedLines: number;
  outsideRoot: number;
  readErrors: number;
  lastError?: string;
}

function newCounters(): SourceCounters {
  return { bytes: 0, items: 0, records: 0, malformedLines: 0, outsideRoot: 0, readErrors: 0 };
}

function spendBytes(budget: SourceBudget, counters: SourceCounters, n: number): void {
  budget.spendBytes(n);
  counters.bytes += n;
}

function countersFields(counters: SourceCounters): Pick<SourceReadResult, "bytes" | "items" | "records"> {
  return { bytes: counters.bytes, items: counters.items, records: counters.records };
}

function unavailableResult(source: PrecedentSourceId): SourceReadResult {
  return { source, status: "unavailable", bytes: 0, items: 0, records: 0 };
}

function truncatedResult(
  source: PrecedentSourceId,
  truncatedBy: PrecedentTruncation,
  counters: SourceCounters,
  extra: Partial<SourceReadResult> = {},
): SourceReadResult {
  return { source, status: "truncated", truncatedBy, ...countersFields(counters), ...extra };
}

function errorResult(
  source: PrecedentSourceId,
  counters: SourceCounters,
  extra: Partial<SourceReadResult> = {},
): SourceReadResult {
  return { source, status: "error", ...countersFields(counters), ...extra };
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/** Canonical search root, or null when the directory does not exist. */
export function resolveSourceRoot(workDir: string): string | null {
  try {
    return fs.realpathSync(workDir);
  } catch {
    return null;
  }
}

/**
 * Pure containment check. `path.relative` compares case-insensitively on
 * win32, so Windows roots match regardless of casing; POSIX stays
 * case-sensitive. Only a first segment that is exactly ".." escapes: names such
 * as "..notes.md" are ordinary entries inside the root.
 */
export function isPathWithinRoot(rootReal: string, candidate: string): boolean {
  const rel = path.relative(rootReal, candidate);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  return !path.isAbsolute(rel);
}

/** Root-relative path with forward slashes, safe to embed in source_ref. */
export function toRelativePosix(rootReal: string, absPath: string): string {
  return path.relative(rootReal, absPath).split(path.sep).join("/");
}

/**
 * Validate one absolute path against the canonical root:
 * lexical containment first, then realpath so symlinks (and Windows junctions)
 * resolving outside the root are refused. Read-only; opens nothing but metadata.
 */
export function guardPathInsideRoot(rootReal: string, absPath: string): PathGuardResult {
  if (!isPathWithinRoot(rootReal, absPath)) return { ok: false, reason: "outside-root" };
  let real: string;
  try {
    real = fs.realpathSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "inaccessible" };
  }
  if (!isPathWithinRoot(rootReal, real)) return { ok: false, reason: "outside-root" };
  return { ok: true, real };
}

/**
 * Validate a path string found inside a record against the canonical roots,
 * WITHOUT opening the target. Backslashes are always treated as separators:
 * records may come from Windows campaigns and be replayed on POSIX and vice
 * versa. Absolute references must land inside a root; symlinked entries whose
 * real path escapes are refused. Non-existent paths inside a root are
 * `missing` (evidence unavailable), not a security refusal.
 */
export function checkPathInRoots(rawReference: string, canonicalRoots: readonly string[]): ReferenceCheckResult {
  const normalized = rawReference.trim().replace(/\\/g, "/");
  if (!normalized) return { ok: false, reason: "invalid" };
  let sawInside = false;
  for (const root of canonicalRoots) {
    const candidate = path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(root, normalized);
    if (!isPathWithinRoot(root, candidate)) continue;
    sawInside = true;
    let real: string | null = null;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      real = null;
    }
    if (real === null) continue;
    // The path exists but its real path resolves outside this root (symlink
    // escape): a definitive refusal — do not fall through to other roots.
    if (!isPathWithinRoot(root, real)) return { ok: false, reason: "outside-root" };
    return { ok: true, absolute: real, root };
  }
  return { ok: false, reason: sawInside ? "missing" : "outside-root" };
}

// ─── Deterministic ordering ──────────────────────────────────────────────────

/**
 * Natural comparison over digit/non-digit runs: "n2" < "n10", "1" < "2" < "10".
 * Pure codepoint ordering — no locale, deterministic across machines.
 */
export function compareNatural(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? [];
  const rb = b.match(/\d+|\D+/g) ?? [];
  const len = Math.min(ra.length, rb.length);
  for (let i = 0; i < len; i++) {
    const sa = ra[i] ?? "";
    const sb = rb[i] ?? "";
    let c: number;
    if (/^\d/.test(sa) && /^\d/.test(sb)) {
      const na = Number(sa);
      const nb = Number(sb);
      c = na === nb ? sa.length - sb.length : na - nb;
    } else {
      c = sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    if (c !== 0) return c;
  }
  return ra.length - rb.length;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Streaming primitives ────────────────────────────────────────────────────

const UTF8_BOM = "\uFEFF";

interface StreamOutcome {
  /** true when every line of the file was delivered (or the file was read to EOF). */
  complete: boolean;
  /** Set when the stream was cut before EOF. */
  cutBy?: "bytes" | "visitor" | "abort";
  error?: string;
}

/**
 * Stream a file as bytes, charging the shared budget BEFORE processing each
 * chunk. Splits complete "\n"-terminated lines and hands each (with its
 * 1-based physical line number) to onLine; onLine returning false stops the
 * read. A line still pending when the budget or the signal cuts the stream is
 * never parsed — a partial JSONL line is not evidence. At clean EOF a pending
 * tail line is complete and is delivered. A UTF-8 byte-order mark at the start
 * of the file is not part of the first line.
 */
async function streamJsonlLines(
  absReal: string,
  budget: SourceBudget,
  counters: SourceCounters,
  onLine: (line: string, lineNo: number) => boolean,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let lineNo = 0;
  let cutBy: StreamOutcome["cutBy"];
  const deliver = (raw: string): boolean => {
    lineNo++;
    const line = lineNo === 1 && raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
    return onLine(line, lineNo);
  };
  try {
    const stream = fs.createReadStream(absReal);
    for await (const chunk of stream) {
      if (signal?.aborted) { cutBy = "abort"; break; }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = budget.remainingBytes();
      if (remaining <= 0) { cutBy = "bytes"; break; }
      let piece = buf;
      if (buf.length > remaining) {
        piece = buf.subarray(0, remaining);
        cutBy = "bytes";
      }
      carry += decoder.write(piece);
      spendBytes(budget, counters, piece.length);
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (signal?.aborted) { cutBy = "abort"; break; }
        if (!deliver(line)) { cutBy = "visitor"; break; }
        nl = carry.indexOf("\n");
      }
      if (cutBy) break;
    }
    if (!cutBy) {
      const tail = carry + decoder.end();
      if (tail.length > 0) {
        if (signal?.aborted) cutBy = "abort";
        else if (!deliver(tail)) cutBy = "visitor";
      }
    }
  } catch (err) {
    return { complete: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { complete: cutBy === undefined, cutBy };
}

interface TextReadOutcome {
  /** null when nothing usable was read (cut or error). */
  text: string | null;
  complete: boolean;
  cutBy?: "bytes" | "abort";
  error?: string;
}

/** Stream a whole file as text under the byte budget; a cut file yields no text at all. */
async function readTextFileBounded(
  absReal: string,
  budget: SourceBudget,
  counters: SourceCounters,
  signal?: AbortSignal,
): Promise<TextReadOutcome> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  try {
    const stream = fs.createReadStream(absReal);
    for await (const chunk of stream) {
      if (signal?.aborted) return { text: null, complete: false, cutBy: "abort" };
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = budget.remainingBytes();
      if (remaining <= 0) return { text: null, complete: false, cutBy: "bytes" };
      if (buf.length > remaining) {
        // A partially read markdown/JSON file is not evidence — drop it whole.
        spendBytes(budget, counters, remaining);
        return { text: null, complete: false, cutBy: "bytes" };
      }
      text += decoder.write(buf);
      spendBytes(budget, counters, buf.length);
    }
    text += decoder.end();
  } catch (err) {
    return { text: null, complete: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { text, complete: true };
}

const MAX_LIST_DEPTH = 8;

interface BoundedListing {
  /** Root-relative POSIX file paths, deterministically sorted. */
  files: string[];
  /** false when the item budget, depth cap or signal cut enumeration (partial, FS-order subset). */
  complete: boolean;
  /** true when the signal cut enumeration. */
  aborted: boolean;
}

function statOrNull(abs: string): fs.Stats | null {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

/** Key for "already walked" bookkeeping; Windows paths compare case-insensitively. */
function dirKey(real: string): string {
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Enumerate regular files under startReal recursively. Every directory entry
 * costs one item from the shared budget, charged before use; enumeration stops
 * at the budget instead of collecting the whole tree. Each entry is verified
 * against startReal (the source subtree), so a link leading out of it is never
 * listed or read. Only regular files are collected: FIFOs, devices and sockets
 * are counted as read errors and never opened. A directory already walked
 * (link cycle or second link to it) is skipped. Entries of one directory are
 * processed in name order, and the collected paths are sorted, so a full pass
 * is deterministic whatever the filesystem order.
 */
async function listFilesBounded(
  startReal: string,
  relPrefix: string,
  budget: SourceBudget,
  counters: SourceCounters,
  signal?: AbortSignal,
): Promise<BoundedListing> {
  const files: string[] = [];
  const visited = new Set<string>([dirKey(startReal)]);
  let complete = true;
  let aborted = false;
  const isAborted = (): boolean => signal?.aborted === true;

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (!complete) return;
    if (depth > MAX_LIST_DEPTH) { complete = false; return; }
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(absDir);
    } catch (err) {
      counters.readErrors++;
      counters.lastError = `${relDir}: cannot list (${err instanceof Error ? err.message : String(err)})`;
      return;
    }
    // Phase 1: read this directory's entries, each charged before it is kept.
    const entries: fs.Dirent[] = [];
    try {
      for (;;) {
        if (isAborted()) { aborted = true; complete = false; break; }
        const dirent = await dir.read();
        if (dirent === null) break;
        if (!budget.canSpendItems(1)) { complete = false; break; }
        budget.spendItems(1);
        counters.items++;
        entries.push(dirent);
      }
    } catch (err) {
      counters.readErrors++;
      counters.lastError = `${relDir}: cannot list (${err instanceof Error ? err.message : String(err)})`;
    } finally {
      try { dir.closeSync(); } catch { /* already closed */ }
    }
    // Phase 2: process in name order, so which of several links to one directory is walked first is fixed.
    entries.sort((a, b) => compareNatural(a.name, b.name));
    for (const dirent of entries) {
      if (isAborted()) { aborted = true; complete = false; break; }
      const name = dirent.name;
      const rel = `${relDir}/${name}`;
      const abs = path.join(absDir, name);
      let isDir = dirent.isDirectory();
      if (!isDir) {
        const st = statOrNull(abs);
        if (st === null) {
          counters.readErrors++;
          counters.lastError = `${rel}: cannot stat`;
          continue;
        }
        if (st.isDirectory()) {
          isDir = true;
        } else if (st.isFile()) {
          files.push(rel);
          continue;
        } else {
          counters.readErrors++;
          counters.lastError = `${rel}: not a regular file`;
          continue;
        }
      }
      const guard = guardPathInsideRoot(startReal, abs);
      if (!guard.ok) {
        if (guard.reason === "outside-root") { counters.outsideRoot++; continue; }
        counters.readErrors++;
        counters.lastError = `${rel}: cannot verify directory`;
        continue;
      }
      const key = dirKey(guard.real);
      if (visited.has(key)) continue;
      visited.add(key);
      await walk(guard.real, rel, depth + 1);
    }
  };

  await walk(startReal, relPrefix, 0);
  files.sort(compareNatural);
  return { files, complete, aborted };
}

interface FilesStreamOutcome {
  truncatedBy?: "bytes" | "visitor" | "abort";
}

/**
 * Guard, read and deliver each listed file as one whole-text record. A file is
 * read only if its real path lies inside subtreeReal (the source directory).
 */
async function streamFilesAsRecords(
  rootReal: string,
  subtreeReal: string,
  files: readonly string[],
  source: PrecedentSourceId,
  budget: SourceBudget,
  counters: SourceCounters,
  visit: PrecedentRecordVisitor,
  signal?: AbortSignal,
): Promise<FilesStreamOutcome> {
  for (const rel of files) {
    if (signal?.aborted) return { truncatedBy: "abort" };
    const guard = guardPathInsideRoot(subtreeReal, path.join(rootReal, rel));
    if (!guard.ok) {
      if (guard.reason === "outside-root") { counters.outsideRoot++; continue; }
      counters.readErrors++;
      counters.lastError = `${rel}: cannot verify file`;
      continue;
    }
    const read = await readTextFileBounded(guard.real, budget, counters, signal);
    if (read.error) {
      counters.readErrors++;
      counters.lastError = `${rel}: ${read.error}`;
      continue;
    }
    if (read.text === null) return { truncatedBy: read.cutBy ?? "bytes" };
    counters.records++;
    if (visit({ ref: { source, path: rel }, data: read.text }) === false) return { truncatedBy: "visitor" };
  }
  return {};
}

// ─── Ledger selection (mirrors council buildBrief exactly) ───────────────────

const LEDGER_CURRENT_REL = ".auto/log.jsonl";
const LEDGER_LEGACY_REL = "autoresearch.jsonl";
const TREE_REL = ".auto/tree.json";
const IDEAS_REL = ".auto/ideas";
const COUNCILS_REL = ".auto/councils";

/**
 * Ledger path selection, same semantics as council.ts buildBrief:
 * `.auto/log.jsonl` when it exists, otherwise legacy `autoresearch.jsonl`,
 * otherwise null. A `.auto/config.json` without `.auto/log.jsonl` therefore
 * still reads the legacy ledger (mixed legacy campaign).
 */
export function resolveLedgerCandidate(rootReal: string): LedgerCandidate | null {
  const current = path.join(rootReal, LEDGER_CURRENT_REL);
  if (fs.existsSync(current)) return { kind: "current", abs: current };
  const legacy = path.join(rootReal, LEDGER_LEGACY_REL);
  if (fs.existsSync(legacy)) return { kind: "legacy", abs: legacy };
  return null;
}

// ─── Adapters ────────────────────────────────────────────────────────────────

function defaultBudget(options: SourceReadOptions): SourceBudget {
  const base = options.budget ?? createBudget({ maxBytes: DEFAULT_MAX_BYTES, maxItems: DEFAULT_MAX_ITEMS });
  return options.passBudget ? combineBudgets(base, options.passBudget) : base;
}

/** Ledger adapter: streaming JSONL over the current/legacy candidate. */
export async function readLedgerSource(
  rootReal: string | null,
  visit: PrecedentRecordVisitor,
  options: SourceReadOptions = {},
): Promise<SourceReadResult> {
  const source: PrecedentSourceId = "log";
  const budget = defaultBudget(options);
  const counters = newCounters();
  const startLine = options.startLine ?? 1;
  if (rootReal === null) return unavailableResult(source);

  const candidate = resolveLedgerCandidate(rootReal);
  if (!candidate) return unavailableResult(source);

  const relPath = toRelativePosix(rootReal, candidate.abs);
  const guard = guardPathInsideRoot(rootReal, candidate.abs);
  if (!guard.ok) {
    if (guard.reason === "missing") return unavailableResult(source);
    return errorResult(source, counters, {
      path: relPath,
      ledger: candidate.kind,
      error: `ledger path escapes the allowed root: ${relPath}`,
    });
  }
  const stop = stopReason(budget, options.signal);
  if (stop) return truncatedResult(source, stop, counters, { path: relPath, ledger: candidate.kind });
  if (!budget.canSpendItems(1)) return truncatedResult(source, "items", counters, { path: relPath, ledger: candidate.kind });
  budget.spendItems(1);
  counters.items = 1;

  const outcome = await streamJsonlLines(
    guard.real,
    budget,
    counters,
    (line, lineNo) => {
      if (lineNo < startLine || !line.trim()) return true;
      const entry = parseJsonlEntry(line);
      if (!entry) {
        counters.malformedLines++;
        return true;
      }
      counters.records++;
      return visit({ ref: { source, path: relPath, line: lineNo }, data: entry }) !== false;
    },
    options.signal,
  );

  if (outcome.error) {
    return errorResult(source, counters, { path: relPath, ledger: candidate.kind, error: outcome.error });
  }
  if (outcome.cutBy) {
    return truncatedResult(source, outcome.cutBy, counters, {
      path: relPath,
      ledger: candidate.kind,
      malformedLines: counters.malformedLines,
    });
  }
  if (counters.malformedLines > 0) {
    // Damaged lines are skipped, but a ledger with unparseable lines is not fully searched.
    const error = counters.records === 0
      ? `ledger is wholly malformed: ${counters.malformedLines} line(s) failed to parse`
      : `ledger has ${counters.malformedLines} malformed line(s) that failed to parse; coverage is incomplete`;
    return errorResult(source, counters, {
      path: relPath,
      ledger: candidate.kind,
      malformedLines: counters.malformedLines,
      error,
    });
  }
  return {
    source,
    status: "searched",
    path: relPath,
    ledger: candidate.kind,
    ...countersFields(counters),
    malformedLines: counters.malformedLines,
  };
}

/** Tree adapter: bounded whole-file read of .auto/tree.json, meta + nodes as records. */
export async function readTreeSource(
  rootReal: string | null,
  visit: PrecedentRecordVisitor,
  options: SourceReadOptions = {},
): Promise<SourceReadResult> {
  const source: PrecedentSourceId = "tree";
  const budget = defaultBudget(options);
  const counters = newCounters();
  if (rootReal === null) return unavailableResult(source);

  const absPath = path.join(rootReal, TREE_REL);
  const guard = guardPathInsideRoot(rootReal, absPath);
  if (!guard.ok) {
    if (guard.reason === "missing") return unavailableResult(source);
    return errorResult(source, counters, { path: TREE_REL, error: "tree.json path escapes the allowed root" });
  }
  const stop = stopReason(budget, options.signal);
  if (stop) return truncatedResult(source, stop, counters, { path: TREE_REL });
  if (!budget.canSpendItems(1)) return truncatedResult(source, "items", counters, { path: TREE_REL });
  budget.spendItems(1);
  counters.items = 1;

  const read = await readTextFileBounded(guard.real, budget, counters, options.signal);
  if (read.error) return errorResult(source, counters, { path: TREE_REL, error: read.error });
  if (read.text === null) return truncatedResult(source, read.cutBy ?? "bytes", counters, { path: TREE_REL });

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return errorResult(source, counters, { path: TREE_REL, error: "tree.json is not valid JSON" });
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.nodes)) {
    return errorResult(source, counters, { path: TREE_REL, error: "tree.json has an unexpected structure" });
  }
  const tree = parsed as Record<string, unknown> & { nodes: Record<string, unknown> };

  const meta: Record<string, unknown> = {};
  for (const key of ["version", "rootId", "activeNodeId", "baselineMetric", "direction", "metricName"] as const) {
    if (tree[key] !== undefined) meta[key] = tree[key];
  }
  counters.records++;
  if (visit({ ref: { source, path: TREE_REL, pointer: "/" }, data: meta }) === false) {
    return truncatedResult(source, "visitor", counters, { path: TREE_REL });
  }

  let malformedNodes = 0;
  for (const id of Object.keys(tree.nodes).sort(compareNatural)) {
    if (options.signal?.aborted) return truncatedResult(source, "abort", counters, { path: TREE_REL });
    const node = tree.nodes[id];
    if (!isObjectRecord(node)) { malformedNodes++; continue; }
    counters.records++;
    const cont = visit({ ref: { source, path: TREE_REL, pointer: `/nodes/${id}` }, data: node });
    if (cont === false) return truncatedResult(source, "visitor", counters, { path: TREE_REL });
  }
  if (malformedNodes > 0) {
    return errorResult(source, counters, {
      path: TREE_REL,
      error: `tree.json contains ${malformedNodes} malformed node(s)`,
    });
  }
  return { source, status: "searched", path: TREE_REL, ...countersFields(counters) };
}

/**
 * Shared adapter for the two directory sources (ideas, councils): recursive,
 * bounded enumeration of regular files confined to the directory's subtree,
 * each streamed as one whole-text record.
 */
async function readFileTreeSource(
  source: "ideas" | "councils",
  relDir: string,
  rootReal: string | null,
  visit: PrecedentRecordVisitor,
  options: SourceReadOptions,
): Promise<SourceReadResult> {
  const budget = defaultBudget(options);
  const counters = newCounters();
  if (rootReal === null) return unavailableResult(source);

  const guard = guardPathInsideRoot(rootReal, path.join(rootReal, relDir));
  if (!guard.ok) {
    if (guard.reason === "missing") return unavailableResult(source);
    const error = guard.reason === "outside-root"
      ? `${source} directory path escapes the allowed root`
      : `${source} directory cannot be verified`;
    return errorResult(source, counters, { path: relDir, error });
  }
  const stop = stopReason(budget, options.signal);
  if (stop) return truncatedResult(source, stop, counters, { path: relDir });

  const listing = await listFilesBounded(guard.real, relDir, budget, counters, options.signal);
  const streamed = await streamFilesAsRecords(
    rootReal,
    guard.real,
    listing.files,
    source,
    budget,
    counters,
    visit,
    options.signal,
  );

  if (streamed.truncatedBy || !listing.complete) {
    const by = streamed.truncatedBy ?? (listing.aborted ? "abort" : "items");
    return truncatedResult(source, by, counters, {
      path: relDir,
      outsideRoot: counters.outsideRoot,
      readErrors: counters.readErrors,
    });
  }
  if (counters.readErrors > 0) {
    return errorResult(source, counters, {
      path: relDir,
      outsideRoot: counters.outsideRoot,
      readErrors: counters.readErrors,
      error: counters.lastError ?? `${counters.readErrors} ${source} file(s) could not be read`,
    });
  }
  return {
    source,
    status: "searched",
    path: relDir,
    ...countersFields(counters),
    outsideRoot: counters.outsideRoot,
    readErrors: counters.readErrors,
  };
}

/** Ideas adapter: streamed markdown files under .auto/ideas (recursive, bounded). */
export function readIdeasSource(
  rootReal: string | null,
  visit: PrecedentRecordVisitor,
  options: SourceReadOptions = {},
): Promise<SourceReadResult> {
  return readFileTreeSource("ideas", IDEAS_REL, rootReal, visit, options);
}

/** Councils adapter: streamed archive files under .auto/councils (recursive, bounded). */
export function readCouncilSource(
  rootReal: string | null,
  visit: PrecedentRecordVisitor,
  options: SourceReadOptions = {},
): Promise<SourceReadResult> {
  return readFileTreeSource("councils", COUNCILS_REL, rootReal, visit, options);
}

/** Local adapters in fixed order; the search layer (task 1.2) drives them with one shared budget. */
export const LOCAL_PRECEDENT_SOURCES: readonly PrecedentSourceAdapter[] = [
  { id: "log", read: readLedgerSource },
  { id: "tree", read: readTreeSource },
  { id: "ideas", read: readIdeasSource },
  { id: "councils", read: readCouncilSource },
];
