/**
 * Versioned precedent report and the `search_precedents` tool (research-precedent-search, task 2.1).
 *
 * searchPrecedentReport(workDir, input):
 *   1. Validates the input (problem, optional keywords, optional finding_ref). Invalid input
 *      starts no search and writes no file.
 *   2. Takes a source-version snapshot in a child process. Versioning and search share ONE budget
 *      (10 MiB, 2000 items) and ONE deadline (10 s) for the whole operation; versioning spends
 *      first. Every ledger/tree/ideas/councils file that is read fully gets a SHA-256 of its
 *      bytes; a directory gets a digest of its file listing with the hash of every file in it.
 *      The ledger segment is taken from the same bytes. A started version child that yields no
 *      snapshot is charged the whole budget (it may have read anything before it was stopped).
 *   3. Fingerprint = hash of (normalized query terms + finding_ref, segment, sources digest).
 *      The same input over unchanged sources gives the same fingerprint; a change of any
 *      source changes it. Snapshots that could not be hashed fully mark the fingerprint
 *      `sources_complete: false`, and freshness is then `unknown`.
 *   4. Runs the search (precedent-search.ts, through this module's budgeted child) with the
 *      budget and the deadline left after step 2, and with the output budget left after the
 *      envelope, so the returned report JSON stays within 8 KiB.
 *   5. Writes `.auto/precedents/<id>.json` atomically (inside the project root only).
 *
 * Standalone: nothing here requires an active campaign or autoresearch mode. Without a
 * ledger the search reports `incomplete`, as the spec requires. The optional finding_ref
 * is an opaque link stored in the report; findings are neither read nor changed here.
 *
 * Output is data, not instructions: candidate text stays under `untrusted_content` (see
 * precedent-search.ts); nothing from the report is executed or used as tool arguments.
 *
 * Memory (task 2.3, precedent-memory.ts): an optional host adapter runs first, in a worker thread
 * under its own cap of the deadline, and its spend comes off the shared budget before the local
 * search. Without one, memory is `unavailable` (with the fallback instruction) and the report stays
 * complete; a configured adapter that failed or was truncated makes it incomplete. A configured memory
 * source has no stable version, so the report is never fresh.
 *
 * Non-goals (later tasks): council/observer wiring (3.x).
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseJsonlEntry } from "./jsonl.ts";
import { LedgerTracker } from "./precedent-context.ts";
import {
  MEMORY_DEADLINE_MS,
  fitMemorySection,
  memorySection,
  runMemorySearch,
  unavailableMemorySection,
  type MemorySection,
  type PrecedentMemoryAdapter,
} from "./precedent-memory.ts";
import {
  SEARCH_DEADLINE_MS,
  SEARCH_MAX_BYTES,
  SEARCH_MAX_ITEMS,
  SEARCH_MAX_OUTPUT_BYTES,
  extractTerms,
  searchLocalSourcesWithFollowUp,
  searchPrecedents,
  type PrecedentSearchOptions,
  type PrecedentSearchOutcome,
  type PrecedentSearchReport,
  type SearchChildDeps,
  type SearchChildProcess,
} from "./precedent-search.ts";
import {
  createBudget,
  guardPathInsideRoot,
  resolveLedgerCandidate,
  resolveSourceRoot,
  toRelativePosix,
  type SourceBudget,
} from "./precedent-sources.ts";

// ─── Limits and constants ────────────────────────────────────────────────────

export const REPORT_SCHEMA = "precedent-report/1" as const;
export const REPORT_DIR_REL = ".auto/precedents";
export const SEARCH_PRECEDENTS_TOOL_NAME = "search_precedents";
/** Tool-level input limits, stricter than the search limits so the envelope always fits the output budget. */
export const REPORT_MAX_PROBLEM_CHARS = 500;
export const REPORT_MAX_KEYWORDS = 5;
export const REPORT_MAX_KEYWORD_CHARS = 40;
export const REPORT_MAX_FINDING_REF_CHARS = 200;

const VERSION_CHILD_FLAG = "--precedent-version-child";
const SEARCH_CHILD_FLAG = "--precedent-report-search-child";
const BUDGET_BYTES_FLAG = "--budget-bytes=";
const BUDGET_ITEMS_FLAG = "--budget-items=";
const CHILD_NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] as const;
const MODULE_PATH = fileURLToPath(import.meta.url);
const MAX_DIR_DEPTH = 8;
const ERROR_MAX_CHARS = 200;
const SEARCH_BUDGET_LIMITS: BudgetLimits = { maxBytes: SEARCH_MAX_BYTES, maxItems: SEARCH_MAX_ITEMS };
const LEDGER_REL = ".auto/log.jsonl";
const TREE_REL = ".auto/tree.json";
const IDEAS_REL = ".auto/ideas";
const COUNCILS_REL = ".auto/councils";

// ─── Types ───────────────────────────────────────────────────────────────────

export type VersionedSourceId = "log" | "tree" | "ideas" | "councils";
export type VersionState = "hashed" | "absent" | "unknown";

export interface SourceVersion {
  source: VersionedSourceId;
  /** Root-relative POSIX path (file, or directory for ideas/councils). */
  path: string;
  state: VersionState;
  ledger?: "current" | "legacy";
  /** SHA-256 of a file's bytes; for a directory, SHA-256 of its listing with the hash of every file. */
  sha256?: string;
  /** Files under a directory source. */
  files?: number;
  /** Why the state is `unknown` (budget, read error, escape from the root, deadline, ...). */
  reason?: string;
}

export interface SourceVersionSnapshot {
  sources: SourceVersion[];
  /** Segment of the current ledger (null when there is no ledger or it is unknown). */
  segment: number | null;
  bytesSpent: number;
  itemsSpent: number;
}

export interface PrecedentFingerprint {
  /** Identity of the report: query, segment and sources digest together. */
  value: string;
  query: string;
  sources: string;
  segment: number | null;
  /** false when some source could not be hashed fully: freshness is then `unknown`. */
  sources_complete: boolean;
}

export interface PrecedentInput {
  problem: string;
  keywords: string[];
  finding_ref?: string;
}

/** The search report with the memory section of task 2.3 (its own `memory` field is always unavailable). */
export type PrecedentReportSearch = Omit<PrecedentSearchReport, "memory"> & { memory: MemorySection };

export interface PrecedentReport {
  schema: typeof REPORT_SCHEMA;
  id: string;
  created_at: string;
  query: PrecedentInput;
  fingerprint: PrecedentFingerprint;
  versions: SourceVersion[];
  search: PrecedentReportSearch;
  persisted: { path: string; saved: boolean };
}

export type ReportFreshness = "fresh" | "stale" | "unknown";

export interface BudgetLimits {
  maxBytes: number;
  maxItems: number;
}

export interface VersionChildOptions {
  /** Wall-clock deadline of the version process, counted from the call; defaults to 10 s. Ignored when `deadlineAt` is set. */
  deadlineMs?: number;
  /** Absolute deadline on `clock` (the operation deadline); set by searchPrecedentReport. */
  deadlineAt?: number;
  /** Monotonic clock in ms behind the deadline; defaults to performance.now(). */
  clock?: () => number;
  /** Child executable; defaults to process.execPath. */
  command?: string;
  /** Child arguments; defaults to running this module in version-child mode. */
  args?: readonly string[];
  /** Shared budget the version pass may spend; defaults to 10 MiB / 2000 items. */
  budget?: BudgetLimits;
  /** Process/timer seams for tests. */
  deps?: Partial<SearchChildDeps>;
}

export interface VersionChildRun {
  snapshot: SourceVersionSnapshot | null;
  deadlineHit: boolean;
  error?: string;
  /** false only when the child could not be spawned at all (nothing was read). */
  started: boolean;
}

export interface PrecedentReportOptions {
  /** Wall-clock deadline of the whole operation (versioning and search); defaults to 10 s. */
  deadlineMs?: number;
  /** Monotonic clock in ms behind the shared deadline; a seam for tests. */
  clock?: () => number;
  versions?: Omit<VersionChildOptions, "deadlineMs" | "deadlineAt" | "clock" | "budget">;
  search?: Omit<PrecedentSearchOptions, "deadlineMs" | "maxOutputBytes" | "args">;
  /** Host memory adapter (task 2.3). Absent: memory is `unavailable`. */
  memory?: PrecedentMemoryAdapter;
  now?: () => Date;
}

export interface PrecedentReportResult {
  report: PrecedentReport;
  /** The report as JSON: the tool output, at most 8 KiB. */
  text: string;
  /** Why the report file was not written, when `report.persisted.saved` is false. */
  persistError?: string;
}

export type ParsedSearchInput = { ok: true; input: PrecedentInput } | { ok: false; error: string };

// ─── Small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const chars = Array.from(text);
  return chars.length > ERROR_MAX_CHARS ? chars.slice(0, ERROR_MAX_CHARS).join("") : text;
}

function toBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
}

function isBudgetLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function defaultBudget(): SourceBudget {
  return createBudget({ maxBytes: SEARCH_MAX_BYTES, maxItems: SEARCH_MAX_ITEMS });
}

/** Charges one item (a directory entry or a top-level file) before it is processed. */
function chargeItem(budget: SourceBudget): boolean {
  if (!budget.canSpendItems(1)) return false;
  budget.spendItems(1);
  return true;
}

// ─── Input ───────────────────────────────────────────────────────────────────

/** Query text the search runs on: the problem followed by the optional keywords. */
export function queryText(input: Pick<PrecedentInput, "problem" | "keywords">): string {
  return [input.problem, ...input.keywords].join("\n");
}

/** Validates raw tool arguments. Nothing is searched or written for invalid input. */
export function parseSearchInput(raw: unknown): ParsedSearchInput {
  const fail = (error: string): ParsedSearchInput => ({ ok: false, error });
  if (!isRecord(raw)) return fail("arguments must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "problem" && key !== "keywords" && key !== "finding_ref") return fail(`unknown argument: ${key}`);
  }
  if (typeof raw.problem !== "string") return fail("problem is required and must be text");
  const problem = raw.problem.trim();
  if (problem === "") return fail("problem must not be empty");
  if (Array.from(problem).length > REPORT_MAX_PROBLEM_CHARS) {
    return fail(`problem must be at most ${REPORT_MAX_PROBLEM_CHARS} characters`);
  }

  let keywords: string[] = [];
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords)) return fail("keywords must be an array of strings");
    if (raw.keywords.length > REPORT_MAX_KEYWORDS) return fail(`keywords: at most ${REPORT_MAX_KEYWORDS} items`);
    for (const item of raw.keywords) {
      if (typeof item !== "string") return fail("keywords must be an array of strings");
      const keyword = item.trim();
      if (keyword === "") return fail("keywords must not contain empty strings");
      if (Array.from(keyword).length > REPORT_MAX_KEYWORD_CHARS) {
        return fail(`each keyword must be at most ${REPORT_MAX_KEYWORD_CHARS} characters`);
      }
      keywords.push(keyword);
    }
  }

  const input: PrecedentInput = { problem, keywords };
  if (raw.finding_ref !== undefined) {
    if (typeof raw.finding_ref !== "string") return fail("finding_ref must be text");
    const ref = raw.finding_ref.trim();
    if (ref === "") return fail("finding_ref must not be empty");
    if (Array.from(ref).length > REPORT_MAX_FINDING_REF_CHARS) {
      return fail(`finding_ref must be at most ${REPORT_MAX_FINDING_REF_CHARS} characters`);
    }
    input.finding_ref = ref;
  }
  if (extractTerms(queryText(input)).length === 0) return fail("problem has no searchable terms");
  return { ok: true, input };
}

// ─── Source versions ─────────────────────────────────────────────────────────

type FileOutcome = { ok: true; sha256: string; data: Buffer } | { ok: false; reason: string };

/**
 * Reads a whole regular file once, charging its size BEFORE reading. A file that does
 * not fit the remaining byte budget is not read at all and yields `bytes`.
 */
function hashFileBounded(absReal: string, budget: SourceBudget): FileOutcome {
  let size: number;
  try {
    size = fs.statSync(absReal).size;
  } catch {
    return { ok: false, reason: "read-error" };
  }
  if (!budget.canSpendBytes(size)) return { ok: false, reason: "bytes" };
  let data: Buffer;
  try {
    data = fs.readFileSync(absReal);
  } catch {
    return { ok: false, reason: "read-error" };
  }
  if (data.length !== size) return { ok: false, reason: "changed-during-read" };
  budget.spendBytes(size);
  return { ok: true, sha256: sha256Hex(data), data };
}

/** Segment of the ledger, reconstructed exactly as the search and jsonl.ts do (malformed lines skipped). */
function ledgerSegment(data: Buffer): number {
  const tracker = new LedgerTracker();
  let segment = 0;
  for (const line of data.toString("utf8").split("\n")) {
    const entry = line.trim() === "" ? null : parseJsonlEntry(line);
    if (entry) segment = tracker.observe(entry).segment;
  }
  return segment;
}

function unknownVersion(
  base: Pick<SourceVersion, "source" | "path" | "ledger">,
  reason: string,
): SourceVersion {
  return { ...base, state: "unknown", reason };
}

function absentVersion(base: Pick<SourceVersion, "source" | "path">): SourceVersion {
  return { ...base, state: "absent" };
}

function ledgerVersion(rootReal: string, budget: SourceBudget): { version: SourceVersion; segment: number | null } {
  const candidate = resolveLedgerCandidate(rootReal);
  if (!candidate) return { version: absentVersion({ source: "log", path: LEDGER_REL }), segment: null };
  const base = { source: "log" as const, path: toRelativePosix(rootReal, candidate.abs), ledger: candidate.kind };
  const guard = guardPathInsideRoot(rootReal, candidate.abs);
  if (!guard.ok) return { version: unknownVersion(base, guard.reason), segment: null };
  if (!chargeItem(budget)) return { version: unknownVersion(base, "items"), segment: null };
  const file = hashFileBounded(guard.real, budget);
  if (!file.ok) return { version: unknownVersion(base, file.reason), segment: null };
  return { version: { ...base, state: "hashed", sha256: file.sha256 }, segment: ledgerSegment(file.data) };
}

function treeVersion(rootReal: string, budget: SourceBudget): SourceVersion {
  const base = { source: "tree" as const, path: TREE_REL };
  const guard = guardPathInsideRoot(rootReal, path.join(rootReal, TREE_REL));
  if (!guard.ok) return guard.reason === "missing" ? absentVersion(base) : unknownVersion(base, guard.reason);
  if (!chargeItem(budget)) return unknownVersion(base, "items");
  const file = hashFileBounded(guard.real, budget);
  if (!file.ok) return unknownVersion(base, file.reason);
  return { ...base, state: "hashed", sha256: file.sha256 };
}

type DirectoryDigest = { ok: true; sha256: string; files: number } | { ok: false; reason: string };

/**
 * Listing digest of a directory subtree: every entry (directory or file) with its
 * relative path, and the SHA-256 of every file. Entries are visited in name order;
 * each entry is charged to the item budget, every file to the byte budget.
 * Any entry that escapes the subtree or cannot be read makes the digest unknown.
 */
function digestDirectory(subtreeReal: string, budget: SourceBudget): DirectoryDigest {
  const lines: string[] = [];
  let files = 0;
  let failure: string | undefined;

  const walk = (dirAbs: string, relDir: string, depth: number): boolean => {
    if (depth > MAX_DIR_DEPTH) {
      failure = "depth";
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      failure = "read-error";
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!chargeItem(budget)) {
        failure = "items";
        return false;
      }
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const guard = guardPathInsideRoot(subtreeReal, path.join(dirAbs, entry.name));
      if (!guard.ok) {
        failure = guard.reason;
        return false;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(guard.real);
      } catch {
        failure = "read-error";
        return false;
      }
      if (stat.isDirectory()) {
        lines.push(`d\t${rel}`);
        if (!walk(guard.real, rel, depth + 1)) return false;
      } else if (stat.isFile()) {
        const file = hashFileBounded(guard.real, budget);
        if (!file.ok) {
          failure = file.reason;
          return false;
        }
        files++;
        lines.push(`f\t${rel}\t${file.sha256}`);
      } else {
        failure = "unsupported-entry";
        return false;
      }
    }
    return true;
  };

  if (!walk(subtreeReal, "", 0)) return { ok: false, reason: failure ?? "read-error" };
  return { ok: true, sha256: sha256Hex(lines.join("\n")), files };
}

function directoryVersion(source: "ideas" | "councils", relDir: string, rootReal: string, budget: SourceBudget): SourceVersion {
  const base = { source, path: relDir };
  const guard = guardPathInsideRoot(rootReal, path.join(rootReal, relDir));
  if (!guard.ok) return guard.reason === "missing" ? absentVersion(base) : unknownVersion(base, guard.reason);
  if (!chargeItem(budget)) return unknownVersion(base, "items");
  const digest = digestDirectory(guard.real, budget);
  if (!digest.ok) return unknownVersion(base, digest.reason);
  return { ...base, state: "hashed", sha256: digest.sha256, files: digest.files };
}

const SOURCE_BASES: readonly { source: VersionedSourceId; path: string }[] = [
  { source: "log", path: LEDGER_REL },
  { source: "tree", path: TREE_REL },
  { source: "ideas", path: IDEAS_REL },
  { source: "councils", path: COUNCILS_REL },
];

/** Snapshot in which every source is unknown for the given reason. */
export function unknownSnapshot(reason: string): SourceVersionSnapshot {
  return {
    sources: SOURCE_BASES.map((base) => unknownVersion(base, reason)),
    segment: null,
    bytesSpent: 0,
    itemsSpent: 0,
  };
}

/**
 * Versions of the local sources the search reads: log (current or legacy ledger),
 * tree, ideas and councils, in the order of LOCAL_PRECEDENT_SOURCES. Pure over the
 * filesystem, bounded by the shared budget; the search budget defaults to the
 * same 10 MiB / 2000 items.
 */
export function snapshotSourceVersions(rootReal: string | null, budget: SourceBudget = defaultBudget()): SourceVersionSnapshot {
  if (rootReal === null) return unknownSnapshot("root-missing");
  const ledger = ledgerVersion(rootReal, budget);
  const sources = [
    ledger.version,
    treeVersion(rootReal, budget),
    directoryVersion("ideas", IDEAS_REL, rootReal, budget),
    directoryVersion("councils", COUNCILS_REL, rootReal, budget),
  ];
  return { sources, segment: ledger.segment, bytesSpent: budget.bytesSpent(), itemsSpent: budget.itemsSpent() };
}

// ─── Fingerprint and freshness ───────────────────────────────────────────────

/** Digest of the source list; reasons are excluded so only the content identity counts. */
function sourcesDigest(sources: readonly SourceVersion[]): string {
  return sha256Hex(
    JSON.stringify(sources.map((s) => [s.source, s.path, s.state, s.ledger ?? null, s.sha256 ?? null, s.files ?? null])),
  );
}

/** Normalized query: unique sorted terms of problem + keywords, plus finding_ref. */
function queryDigest(input: PrecedentInput): string {
  const terms = [...new Set(extractTerms(queryText(input)))].sort();
  return sha256Hex(JSON.stringify({ terms, finding_ref: input.finding_ref ?? null }));
}

export function computeFingerprint(input: PrecedentInput, snapshot: SourceVersionSnapshot): PrecedentFingerprint {
  const query = queryDigest(input);
  const sources = sourcesDigest(snapshot.sources);
  const segment = snapshot.segment;
  return {
    value: sha256Hex(JSON.stringify([REPORT_SCHEMA, query, sources, segment])),
    query,
    sources,
    segment,
    sources_complete: snapshot.sources.every((s) => s.state !== "unknown"),
  };
}

/** Stored fingerprint against the current one. Unknown on either side is never reported as fresh or stale. */
export function evaluateFreshness(stored: PrecedentFingerprint, current: PrecedentFingerprint): ReportFreshness {
  if (!stored.sources_complete || !current.sources_complete) return "unknown";
  return stored.value === current.value ? "fresh" : "stale";
}

// ─── Child process deadlines ─────────────────────────────────────────────────

const defaultClock = (): number => performance.now();

/**
 * Milliseconds left until the absolute deadline, never negative. It is read at the moment a
 * timer is armed, after the spawn, so the time the spawn took is charged to the deadline.
 */
function msUntil(deadlineAt: number, clock: () => number): number {
  return Math.max(0, Math.ceil(deadlineAt - clock()));
}

/**
 * Kills a child that reached the deadline. SIGKILL cannot be caught or deferred (on Windows
 * the signal is TerminateProcess), so the child counts as finished at once: no grace period
 * is waited for, and the operation does not run past its deadline to see the exit.
 */
function forceKill(child: SearchChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

/** The search child is run by precedent-search.ts, which kills with its default signal; this makes that kill a SIGKILL. */
function forceKillable(child: SearchChildProcess): SearchChildProcess {
  const kill = child.kill.bind(child);
  child.kill = () => kill("SIGKILL");
  return child;
}

/**
 * Seams of the search child under the operation deadline: the child is spawned as given and
 * is killed with SIGKILL, and its timer ends at the absolute deadline, measured after the spawn.
 */
function searchChildDeps(
  deps: Partial<SearchChildDeps> | undefined,
  deadlineAt: number,
  clock: () => number,
): Partial<SearchChildDeps> {
  const spawn = deps?.spawn ?? defaultSpawn;
  const setTimer = deps?.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  return {
    ...deps,
    spawn: (command, args, options) => forceKillable(spawn(command, args, options)),
    setTimer: (callback) => setTimer(callback, msUntil(deadlineAt, clock)),
  };
}

// ─── Version child process ───────────────────────────────────────────────────

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "ignore"]; windowsHide: boolean },
): SearchChildProcess {
  return nodeSpawn(command, [...args], options) as unknown as SearchChildProcess;
}

function parseVersionLine(output: string): SourceVersionSnapshot | null {
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "versions") continue;
    if (!Array.isArray(parsed.sources) || typeof parsed.bytesSpent !== "number" || typeof parsed.itemsSpent !== "number") {
      return null;
    }
    const segment = typeof parsed.segment === "number" ? parsed.segment : null;
    return {
      sources: parsed.sources as SourceVersion[],
      segment,
      bytesSpent: parsed.bytesSpent,
      itemsSpent: parsed.itemsSpent,
    };
  }
  return null;
}

/**
 * Takes the source-version snapshot in a separate process under the deadline.
 * On the deadline the process is killed and the run carries no snapshot; the
 * caller then reports every source as unknown.
 */
export function runVersionChild(workDir: string, options: VersionChildOptions = {}): Promise<VersionChildRun> {
  const clock = options.clock ?? defaultClock;
  const deadlineAt = options.deadlineAt ?? clock() + (options.deadlineMs ?? SEARCH_DEADLINE_MS);
  const deps: SearchChildDeps = {
    spawn: defaultSpawn,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...options.deps,
  };
  const command = options.command ?? process.execPath;
  const args = options.args ?? [...CHILD_NODE_FLAGS, MODULE_PATH, VERSION_CHILD_FLAG];
  const budget = options.budget ?? SEARCH_BUDGET_LIMITS;

  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    let output = "";
    let timer: unknown;
    const decoder = new StringDecoder("utf8");

    const settle = (run: Omit<VersionChildRun, "started">): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve({ ...run, started });
    };

    let child: SearchChildProcess;
    try {
      child = deps.spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      settle({ snapshot: null, deadlineHit: false, error: errorText(err) });
      return;
    }
    started = true;

    timer = deps.setTimer(() => {
      forceKill(child);
      settle({ snapshot: null, deadlineHit: true });
    }, msUntil(deadlineAt, clock));

    child.stdout.on("data", (chunk) => {
      output += decoder.write(toBuffer(chunk));
    });
    child.on("error", (err) => settle({ snapshot: null, deadlineHit: false, error: errorText(err) }));
    child.on("close", (code) => {
      output += decoder.end();
      const snapshot = parseVersionLine(output);
      settle(
        snapshot
          ? { snapshot, deadlineHit: false }
          : { snapshot: null, deadlineHit: false, error: `version process ended without a snapshot (code ${code})` },
      );
    });
    child.stdin.on?.("error", () => {
      // The child may exit before reading its input; the close/deadline path reports it.
    });
    child.stdin.end(JSON.stringify({ workDir, maxBytes: budget.maxBytes, maxItems: budget.maxItems }));
  });
}

function snapshotOrUnknown(run: VersionChildRun): SourceVersionSnapshot {
  if (run.snapshot) return run.snapshot;
  return unknownSnapshot(run.deadlineHit ? "deadline" : (run.error ?? "version process failed"));
}

// ─── Persistence ─────────────────────────────────────────────────────────────

type PersistOutcome = { saved: true } | { saved: false; reason: string };

/**
 * Writes the report atomically to `.auto/precedents/<id>.json`. Existing `.auto`
 * or `.auto/precedents` entries must resolve inside the root, otherwise nothing is
 * created or written.
 */
function persistReport(rootReal: string | null, id: string, text: string): PersistOutcome {
  if (rootReal === null) return { saved: false, reason: "root-missing" };
  const autoAbs = path.join(rootReal, ".auto");
  const dirAbs = path.join(rootReal, ...REPORT_DIR_REL.split("/"));
  try {
    for (const probe of [autoAbs, dirAbs]) {
      if (!fs.existsSync(probe)) continue;
      if (!guardPathInsideRoot(rootReal, probe).ok) return { saved: false, reason: "report directory escapes the root" };
    }
    fs.mkdirSync(dirAbs, { recursive: true });
    const guard = guardPathInsideRoot(rootReal, dirAbs);
    if (!guard.ok) return { saved: false, reason: "report directory escapes the root" };
    const target = path.join(guard.real, `${id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, target);
    return { saved: true };
  } catch (err) {
    return { saved: false, reason: errorText(err) };
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

/**
 * Searches the local sources for `input` and returns the versioned report. The
 * report is written to `.auto/precedents/<id>.json` when possible; the returned
 * `text` is the same JSON without any further change.
 */
/**
 * What the version pass took from the shared budget. A snapshot reports its exact spend; a child
 * that never started took nothing; a started child without a snapshot (deadline, crash, error) may
 * have read up to the whole budget before it was stopped, so the whole budget is charged. The
 * search then gets none of it and reports itself truncated, never complete.
 */
function versionSpend(run: VersionChildRun, limits: BudgetLimits): { bytes: number; items: number } {
  if (run.snapshot) return { bytes: run.snapshot.bytesSpent, items: run.snapshot.itemsSpent };
  if (!run.started) return { bytes: 0, items: 0 };
  return { bytes: limits.maxBytes, items: limits.maxItems };
}

/**
 * Widest growth the operation totals can add to the search JSON over the search-only numbers:
 * one byte per extra digit of the largest totals and of the deadline, plus one for the `hit` flag.
 * It is reserved in the search output limit so the final report still fits 8 KiB.
 */
function totalsGrowthBytes(deadlineMs: number): number {
  const digits = (value: number): number => String(Math.trunc(value)).length;
  return (digits(SEARCH_MAX_BYTES) - 1) + (digits(SEARCH_MAX_ITEMS) - 1) + (digits(deadlineMs) - 1) + 1;
}

/** The report with its first `keep` candidates; `output` counts them as assembleReport does. */
function keepCandidates(search: PrecedentReportSearch, keep: number): PrecedentReportSearch {
  const matchesTotal = search.output.matchesTotal;
  return {
    ...search,
    candidates: search.candidates.slice(0, keep),
    output: { matchesTotal, returned: keep, omitted: matchesTotal - keep, truncated: matchesTotal - keep > 0 },
  };
}

/** Arguments of the budgeted search child: the remaining limits travel on the command line. */
function searchChildArgs(limits: BudgetLimits): string[] {
  return [
    ...CHILD_NODE_FLAGS,
    MODULE_PATH,
    SEARCH_CHILD_FLAG,
    `${BUDGET_BYTES_FLAG}${limits.maxBytes}`,
    `${BUDGET_ITEMS_FLAG}${limits.maxItems}`,
  ];
}

export async function searchPrecedentReport(
  workDir: string,
  input: PrecedentInput,
  options: PrecedentReportOptions = {},
): Promise<PrecedentReportResult> {
  // One absolute deadline for the whole operation: versioning and search both end at deadlineAt.
  const deadlineMs = options.deadlineMs ?? SEARCH_DEADLINE_MS;
  const clock = options.clock ?? defaultClock;
  const startedAt = clock();
  const deadlineAt = startedAt + deadlineMs;
  const remainingMs = (): number => msUntil(deadlineAt, clock);

  // One budget for the whole operation: versioning spends first, the search gets the rest.
  const versionRun = await runVersionChild(workDir, {
    ...options.versions,
    clock,
    deadlineAt,
    budget: SEARCH_BUDGET_LIMITS,
  });
  const versionSpent = versionSpend(versionRun, SEARCH_BUDGET_LIMITS);
  const snapshot = snapshotOrUnknown(versionRun);
  const fingerprint = computeFingerprint(input, snapshot);
  const id = `${fingerprint.value.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
  const relPath = `${REPORT_DIR_REL}/${id}.json`;

  const query: PrecedentInput = { problem: input.problem, keywords: input.keywords.slice() };
  if (input.finding_ref !== undefined) query.finding_ref = input.finding_ref;
  const head = {
    schema: REPORT_SCHEMA,
    id,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    query,
    fingerprint,
    versions: snapshot.sources,
  };

  // Search output budget: the report is `head` + `persisted` + `search` (last key). Its JSON
  // is the head size plus the search JSON, so the search may use the rest of the 8 KiB.
  const persistedFalse = { path: relPath, saved: false };
  const overhead = Buffer.byteLength(JSON.stringify({ ...head, persisted: persistedFalse, search: null }), "utf8") - "null".length;
  const rootReal = resolveSourceRoot(workDir);
  // The memory call runs first, under its own cap of the deadline. Its spend comes off the shared budget
  // before the local search takes the remainder, so the two never spend the same bytes or items twice.
  const adapter = options.memory;
  const call =
    adapter === undefined
      ? null
      : await runMemorySearch(adapter, queryText(input), {
          deadlineMs: Math.min(remainingMs(), MEMORY_DEADLINE_MS),
          maxBytes: SEARCH_MAX_BYTES - versionSpent.bytes,
          maxItems: SEARCH_MAX_ITEMS - versionSpent.items,
        });
  const memorySpent = call?.spent ?? { bytes: 0, items: 0 };
  const memoryInitial =
    call !== null && adapter !== undefined ? memorySection(call, adapter.name, rootReal) : unavailableMemorySection();

  const searchLimits: BudgetLimits = {
    maxBytes: Math.max(0, SEARCH_MAX_BYTES - versionSpent.bytes - memorySpent.bytes),
    maxItems: Math.max(0, SEARCH_MAX_ITEMS - versionSpent.items - memorySpent.items),
  };
  const searched = await searchPrecedents(workDir, queryText(input), {
    ...options.search,
    args: searchChildArgs(searchLimits),
    deadlineMs: remainingMs(),
    deps: searchChildDeps(options.search?.deps, deadlineAt, clock),
    maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES - overhead - totalsGrowthBytes(deadlineMs),
  });

  // The report shows the shared operation totals (version, memory and search spend) and the operation
  // deadline. Memory decides completeness: a configured source that failed or was truncated is incomplete.
  const budget = {
    maxBytes: SEARCH_MAX_BYTES,
    maxItems: SEARCH_MAX_ITEMS,
    bytesSpent: versionSpent.bytes + memorySpent.bytes + searched.budget.bytesSpent,
    itemsSpent: versionSpent.items + memorySpent.items + searched.budget.itemsSpent,
  };
  const searchWith = (memory: MemorySection): PrecedentReportSearch => {
    if (searched.outcome === "invalid-query") return { ...searched, memory, budget };
    const complete = searched.complete && (memory.status === "unavailable" || memory.status === "searched");
    const outcome: PrecedentSearchOutcome = !complete
      ? "incomplete"
      : searched.output.matchesTotal > 0 || memory.returned > 0
        ? "matches"
        : "no-matches";
    return {
      ...searched,
      outcome,
      complete,
      memory,
      budget,
      deadline: { ms: deadlineMs, hit: searched.deadline.hit || versionRun.deadlineHit },
    };
  };
  // Output fit (8 KiB): memory entries go first (secondary evidence), then the lowest-ranked local candidates.
  const fitsOutput = (candidate: PrecedentReportSearch): boolean =>
    Buffer.byteLength(JSON.stringify({ ...head, persisted: persistedFalse, search: candidate }), "utf8") <= SEARCH_MAX_OUTPUT_BYTES;
  let search = searchWith(fitMemorySection(memoryInitial, (memory) => fitsOutput(searchWith(memory))));
  while (!fitsOutput(search) && search.candidates.length > 0) {
    search = keepCandidates(search, search.candidates.length - 1);
  }

  const draft = (saved: boolean): PrecedentReport => ({ ...head, persisted: { path: relPath, saved }, search });
  let report = draft(true);
  let text = JSON.stringify(report);
  const persist = persistReport(rootReal, id, text);
  let persistError: string | undefined;
  if (!persist.saved) {
    persistError = persist.reason;
    report = draft(false);
    text = JSON.stringify(report);
  }
  return persistError === undefined ? { report, text } : { report, text, persistError };
}

/**
 * Freshness of a stored report against the current sources, with one bounded
 * version snapshot. `reusable` requires a fresh fingerprint and a complete search.
 */
export async function checkPrecedentReportFreshness(
  workDir: string,
  report: PrecedentReport,
  options: VersionChildOptions = {},
): Promise<{ freshness: ReportFreshness; reusable: boolean }> {
  const current = computeFingerprint(report.query, snapshotOrUnknown(await runVersionChild(workDir, options)));
  // A configured memory source has no stable version to compare, and a failed or truncated one leaves the
  // coverage incomplete (task 2.3): either way the freshness is unknown, whatever the local sources say.
  const freshness: ReportFreshness =
    report.search.memory.status === "unavailable" ? evaluateFreshness(report.fingerprint, current) : "unknown";
  return { freshness, reusable: freshness === "fresh" && report.search.complete };
}

// ─── Tool registration ───────────────────────────────────────────────────────

interface RegisterToolLike {
  registerTool(tool: unknown): void;
}

/**
 * Registers `search_precedents`. Not gated on autoresearch mode or an active campaign:
 * it reads only the local `.auto/` sources that exist and reports the rest as unavailable.
 */
export function registerSearchPrecedentsTool(
  pi: RegisterToolLike,
  resolveWorkDir: (cwd: string) => string = (cwd) => cwd,
  options: PrecedentReportOptions = {},
): void {
  pi.registerTool({
    name: SEARCH_PRECEDENTS_TOOL_NAME,
    label: "Search precedents",
    description:
      "Ищет прошлые решения и неудачи по текстовому описанию проблемы в локальных записях проекта " +
      "(леджер, дерево гипотез, идеи, советы). Работает без активной кампании. Результаты — кандидаты " +
      "для проверки, а не доказательства: каждый содержит ссылку на источник и текст как недоверенные данные. " +
      "Отчёт содержит fingerprint, статус покрытия каждого источника и не более 20 кандидатов в пределах 8 KiB.",
    promptSnippet: "Search local campaign history for precedents to a problem (candidates, not evidence)",
    parameters: {
      type: "object",
      properties: {
        problem: { type: "string", description: `Описание проблемы, до ${REPORT_MAX_PROBLEM_CHARS} символов` },
        keywords: {
          type: "array",
          items: { type: "string" },
          maxItems: REPORT_MAX_KEYWORDS,
          description: `Необязательные дополнительные ключевые слова, до ${REPORT_MAX_KEYWORDS} штук`,
        },
        finding_ref: {
          type: "string",
          description: "Необязательная ссылка на находку; сохраняется в отчёте как есть, не проверяется",
        },
      },
      required: ["problem"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const parsed = parseSearchInput(params);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: `❌ ${parsed.error}` }], details: {} };
      }
      const result = await searchPrecedentReport(resolveWorkDir(ctx.cwd), parsed.input, options);
      const { report } = result;
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          id: report.id,
          outcome: report.search.outcome,
          complete: report.search.complete,
          memory: report.search.memory.status,
          fingerprint: report.fingerprint.value,
          persisted: report.persisted,
          ...(result.persistError === undefined ? {} : { persistError: result.persistError }),
        },
      };
    },
  });
}

// ─── Version child entry ─────────────────────────────────────────────────────

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(toBuffer(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runVersionChildMain(): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readStdinText());
    if (
      !isRecord(parsed) ||
      typeof parsed.workDir !== "string" ||
      !isBudgetLimit(parsed.maxBytes) ||
      !isBudgetLimit(parsed.maxItems)
    ) {
      throw new Error("invalid version input");
    }
    const budget = createBudget({ maxBytes: parsed.maxBytes, maxItems: parsed.maxItems });
    const snapshot = snapshotSourceVersions(resolveSourceRoot(parsed.workDir), budget);
    process.stdout.write(`${JSON.stringify({ type: "versions", ...snapshot })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ type: "error", message: errorText(err) })}\n`);
    process.exitCode = 1;
  }
}

// ─── Search child entry (budgeted) ───────────────────────────────────────────

/** Reads one non-negative integer budget limit from the command line. */
function budgetFlag(argv: readonly string[], prefix: string): number {
  const arg = argv.find((item) => item.startsWith(prefix));
  const value = arg === undefined ? Number.NaN : Number(arg.slice(prefix.length));
  if (!isBudgetLimit(value)) throw new Error("invalid search budget");
  return value;
}

/**
 * Runs the local search with the remaining budget of the operation. Emits the same snapshot lines
 * as the precedent-search child, so searchPrecedents parses them unchanged; the follow-up pass
 * draws on the same budget object.
 */
async function runSearchChildMain(argv: readonly string[]): Promise<void> {
  const emit = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  try {
    const limits: BudgetLimits = {
      maxBytes: budgetFlag(argv, BUDGET_BYTES_FLAG),
      maxItems: budgetFlag(argv, BUDGET_ITEMS_FLAG),
    };
    const parsed: unknown = JSON.parse(await readStdinText());
    if (!isRecord(parsed) || typeof parsed.workDir !== "string" || typeof parsed.problem !== "string") {
      throw new Error("invalid precedent search input");
    }
    const budget = createBudget(limits);
    await searchLocalSourcesWithFollowUp(resolveSourceRoot(parsed.workDir), parsed.problem, {
      budget,
      followUpBudget: budget,
      onSnapshot: (snap) => emit({ type: "snapshot", ...snap }),
    });
  } catch (err) {
    emit({ type: "error", message: errorText(err) });
    process.exitCode = 1;
  }
}

if (process.argv.includes(VERSION_CHILD_FLAG)) {
  void runVersionChildMain();
}
if (process.argv.includes(SEARCH_CHILD_FLAG)) {
  void runSearchChildMain(process.argv);
}
