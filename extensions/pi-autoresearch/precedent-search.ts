/**
 * Bounded Unicode precedent search over local sources (research-precedent-search, task 1.2).
 *
 * Pipeline:
 *   searchPrecedents(workDir, problem)
 *     1. Normalizes the problem (NFKC, case folding, ё → е) and extracts its
 *        unique terms (letter/mark/number runs). Empty, term-less or overlong
 *        problems are refused without starting any search.
 *     2. Runs the search in a SEPARATE node process (this file in child mode).
 *        The parent enforces a wall-clock deadline (10 s): at the deadline the
 *        child is killed, the report keeps the snapshots received so far, and
 *        every source the child did not finish is reported `truncated`
 *        (truncatedBy "deadline"). The child streams a cumulative snapshot after
 *        every source; a half-written line is never parsed.
 *     3. The child reads the local adapters of precedent-sources.ts in fixed
 *        order with ONE shared budget (10 MiB read, 2000 items) and keeps only
 *        the top 20 candidates, ranked by distinct matched terms, then path,
 *        line and pointer (compareNatural — deterministic).
 *     4. The parent fits the report into 8 KiB by dropping the lowest-ranked
 *        candidates; `output.truncated` reports the omission.
 *
 *   5. Identifier follow-up (task 1.3, precedent-context.ts): the child then
 *      searches the ledger once more by the identifiers of the kept candidates
 *      (run+segment, commit, tree node id, literal ideas/councils path). It has
 *      its own budget (10 MiB / 2000 items) and its own coverage in `followUp`;
 *      it contributes context links with ±10 neighbouring ledger records and
 *      conflicts, never a conclusion (classification stays `unknown`).
 *
 * Coverage: `complete` is true only when the ledger (log) was searched and each
 * optional source (tree/ideas/councils) was searched or is absent. The follow-up
 * pass is reported separately and does not change `complete` or `outcome`.
 * Memory has no supported adapter in this module and is always `unavailable`;
 * it is not counted as searched. Candidates are matches, not evidence: each
 * carries its source reference and the record text as `untrusted_content`.
 *
 * Read-only: the child only reads; nothing is written, moved or executed from
 * the record text. Non-goals (later tasks): report persistence and tool
 * registration (2.x).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  candidateIdentity,
  emptyFollowUpReport,
  LedgerTracker,
  runFollowUpPass,
  type CandidateIdentity,
  type FollowUpCandidate,
  type FollowUpReport,
} from "./precedent-context.ts";
import {
  LOCAL_PRECEDENT_SOURCES,
  compareNatural,
  createBudget,
  resolveSourceRoot,
  type PrecedentRecordData,
  type PrecedentSourceId,
  type PrecedentSourceRef,
  type PrecedentSourceStatus,
  type PrecedentTruncation,
  type SourceBudget,
  type SourceReadResult,
} from "./precedent-sources.ts";

// ─── Limits ──────────────────────────────────────────────────────────────────

export const SEARCH_DEADLINE_MS = 10_000;
export const SEARCH_MAX_BYTES = 10 * 1048576;
export const SEARCH_MAX_ITEMS = 2000;
export const SEARCH_MAX_CANDIDATES = 20;
export const SEARCH_MAX_OUTPUT_BYTES = 8 * 1024;
export const SEARCH_MAX_PROBLEM_CHARS = 1000;

const SNIPPET_MAX_CHARS = 160;
const FIELD_MAX_CHARS = 512;
const ERROR_MAX_CHARS = 200;
const TEXT_MAX_DEPTH = 8;
const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;
const SCHEMA = "precedent-search/1";
const CHILD_FLAG = "--precedent-search-child";
const CHILD_NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] as const;
const MODULE_PATH = fileURLToPath(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchTruncation = PrecedentTruncation | "deadline";

export interface SearchSourceReport {
  source: PrecedentSourceId;
  status: PrecedentSourceStatus;
  path?: string;
  ledger?: "current" | "legacy";
  truncatedBy?: SearchTruncation;
  error?: string;
  bytes: number;
  items: number;
  records: number;
  malformedLines?: number;
  outsideRoot?: number;
  readErrors?: number;
}

export interface PrecedentCandidate {
  ref: PrecedentSourceRef;
  /** Number of distinct query terms found in the record. */
  score: number;
  matched_terms: string[];
  /** Record text, labelled as untrusted data: never executed, never used as tool arguments. */
  untrusted_content: { label: "untrusted-source-text"; text: string };
  /** Identifier follow-up of this candidate (task 1.3); present only in snapshots of searchLocalSourcesWithFollowUp. */
  follow_up?: FollowUpCandidate;
}

/**
 * Cumulative state of one local search run. `done` is true only after the last
 * pass: the text search alone (searchLocalSources) ends with done = true too.
 */
export interface LocalSearchSnapshot {
  done: boolean;
  sources: SearchSourceReport[];
  candidates: PrecedentCandidate[];
  matchesTotal: number;
  bytesSpent: number;
  itemsSpent: number;
  /** Identifier follow-up report; present only after searchLocalSourcesWithFollowUp. */
  followUp?: FollowUpReport;
}

export interface LocalSearchOptions {
  /** Shared budget; defaults to 10 MiB / 2000 items. */
  budget?: SourceBudget;
  /** Candidates kept after ranking; defaults to 20. */
  maxCandidates?: number;
  /** Called after every source (and once more at the end with done = true). */
  onSnapshot?: (snapshot: LocalSearchSnapshot) => void;
}

export interface LocalSearchWithFollowUpOptions extends LocalSearchOptions {
  /** Budget of the identifier follow-up pass; defaults to its own 10 MiB / 2000 items. */
  followUpBudget?: SourceBudget;
}

export interface SearchChildProcess {
  stdin: { end(data?: string): unknown; on?(event: "error", listener: () => void): unknown };
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  kill(signal?: string): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

export interface SearchChildDeps {
  spawn: (
    command: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "ignore"]; windowsHide: boolean },
  ) => SearchChildProcess;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface PrecedentSearchOptions {
  /** Wall-clock deadline for the child process; defaults to 10 s. */
  deadlineMs?: number;
  /** Child executable; defaults to process.execPath. */
  command?: string;
  /** Child arguments; defaults to running this module in child mode. */
  args?: readonly string[];
  /** Final report byte limit; defaults to 8 KiB. */
  maxOutputBytes?: number;
  /** Process/timer seams for tests (fake clocks and fake processes). */
  deps?: Partial<SearchChildDeps>;
}

export interface SearchChildRun {
  /** Last snapshot received from the child, or null. */
  snapshot: LocalSearchSnapshot | null;
  /** The deadline fired and the child was killed. */
  deadlineHit: boolean;
  /** Set when the child failed before finishing (spawn error, crash, no output). */
  error?: string;
}

export type PrecedentSearchOutcome = "matches" | "no-matches" | "incomplete" | "invalid-query";

export interface PrecedentSearchReport {
  schema: typeof SCHEMA;
  query: { terms: string[]; invalidReason?: "empty" | "no-terms" | "too-long" };
  outcome: PrecedentSearchOutcome;
  complete: boolean;
  deadline: { ms: number; hit: boolean };
  budget: { maxBytes: number; maxItems: number; bytesSpent: number; itemsSpent: number };
  sources: SearchSourceReport[];
  /** Identifier follow-up over the ledger (task 1.3): own status and budget, separate from `sources`. */
  followUp: FollowUpReport;
  memory: { status: "unavailable"; reason: string };
  candidates: PrecedentCandidate[];
  /** Candidate-count accounting; the byte limit itself is a constant and is not echoed (keeps size a function of content). */
  output: { matchesTotal: number; returned: number; omitted: number; truncated: boolean };
}

export type PrecedentSearchReportBase = Omit<PrecedentSearchReport, "candidates" | "output">;

// ─── Normalization and terms ─────────────────────────────────────────────────

/** NFKC, locale-independent lowercase, NFKC again (lowercasing can denormalize), ё → е. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/ё/g, "е");
}

/** Unique normalized terms in order of first appearance. */
export function extractTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const match of normalizeSearchText(text).matchAll(TOKEN_RE)) seen.add(match[0]);
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** Physical lines of a record's text: a whole file/markdown string, or every string/number leaf of a JSON record. */
function collectTextLines(data: PrecedentRecordData): string[] {
  const lines: string[] = [];
  const addText = (text: string): void => {
    for (const line of text.split(/\r?\n/)) lines.push(line);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > TEXT_MAX_DEPTH) return;
    if (typeof value === "string") addText(value);
    else if (typeof value === "number" && Number.isFinite(value)) lines.push(String(value));
    else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) walk(value[key], depth + 1);
    }
  };
  walk(data, 0);
  return lines;
}

function makeSnippet(line: string): string {
  const flat = line.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > SNIPPET_MAX_CHARS ? `${chars.slice(0, SNIPPET_MAX_CHARS).join("")}...` : flat;
}

/** Matches one record against the query terms; null when no term is found. */
function matchRecord(
  data: PrecedentRecordData,
  queryTerms: readonly string[],
): { matched: string[]; snippet: string } | null {
  const wanted = new Set(queryTerms);
  const found = new Set<string>();
  let snippetLine: string | null = null;
  for (const line of collectTextLines(data)) {
    let lineHit = false;
    for (const term of extractTerms(line)) {
      if (!wanted.has(term)) continue;
      found.add(term);
      lineHit = true;
    }
    if (lineHit && snippetLine === null) snippetLine = line;
  }
  if (found.size === 0 || snippetLine === null) return null;
  return { matched: queryTerms.filter((term) => found.has(term)), snippet: makeSnippet(snippetLine) };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/** More distinct matched terms first; then path, source, line and pointer in natural order. */
export function compareCandidates(a: PrecedentCandidate, b: PrecedentCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const byPath = compareNatural(a.ref.path, b.ref.path);
  if (byPath !== 0) return byPath;
  const bySource = compareNatural(a.ref.source, b.ref.source);
  if (bySource !== 0) return bySource;
  const byLine = (a.ref.line ?? 0) - (b.ref.line ?? 0);
  if (byLine !== 0) return byLine;
  return compareNatural(a.ref.pointer ?? "", b.ref.pointer ?? "");
}

/**
 * Identity keys of each matched record, kept outside the candidate objects so
 * the candidate shape of the text search stays unchanged.
 */
const candidateIdentities = new WeakMap<PrecedentCandidate, CandidateIdentity>();

function identityOf(candidate: PrecedentCandidate): CandidateIdentity {
  return candidateIdentities.get(candidate) ?? { keys: [], scale: null };
}

/** Keeps the best `limit` candidates and counts every match. */
class TopCandidates {
  private readonly kept: PrecedentCandidate[] = [];
  private readonly limit: number;
  total = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  add(candidate: PrecedentCandidate): void {
    this.total++;
    if (this.limit <= 0) return;
    if (this.kept.length === this.limit && compareCandidates(candidate, this.kept[this.limit - 1]) >= 0) return;
    let index = this.kept.length;
    while (index > 0 && compareCandidates(candidate, this.kept[index - 1]) < 0) index--;
    this.kept.splice(index, 0, candidate);
    if (this.kept.length > this.limit) this.kept.length = this.limit;
  }

  items(): PrecedentCandidate[] {
    return this.kept.slice();
  }
}

// ─── Local search (in-process core; the child process runs exactly this) ─────

function toSourceReport(result: SourceReadResult): SearchSourceReport {
  const report: SearchSourceReport = {
    source: result.source,
    status: result.status,
    bytes: result.bytes,
    items: result.items,
    records: result.records,
  };
  if (result.path !== undefined) report.path = capChars(result.path, FIELD_MAX_CHARS);
  if (result.ledger !== undefined) report.ledger = result.ledger;
  if (result.truncatedBy !== undefined) report.truncatedBy = result.truncatedBy;
  if (result.error !== undefined) report.error = capChars(result.error, ERROR_MAX_CHARS);
  if (result.malformedLines !== undefined) report.malformedLines = result.malformedLines;
  if (result.outsideRoot !== undefined) report.outsideRoot = result.outsideRoot;
  if (result.readErrors !== undefined) report.readErrors = result.readErrors;
  return report;
}

/**
 * Searches the local adapters in fixed order with one shared budget. Pure
 * over the filesystem: no spawning, no timers. Query terms must be non-empty;
 * callers refuse empty queries before reaching here.
 */
export async function searchLocalSources(
  rootReal: string | null,
  problem: string,
  options: LocalSearchOptions = {},
): Promise<LocalSearchSnapshot> {
  const queryTerms = extractTerms(problem);
  const budget = options.budget ?? createBudget({ maxBytes: SEARCH_MAX_BYTES, maxItems: SEARCH_MAX_ITEMS });
  const top = new TopCandidates(options.maxCandidates ?? SEARCH_MAX_CANDIDATES);
  const reports: SearchSourceReport[] = [];

  const snapshot = (): LocalSearchSnapshot => ({
    done: reports.length === LOCAL_PRECEDENT_SOURCES.length,
    sources: reports.slice(),
    candidates: top.items(),
    matchesTotal: top.total,
    bytesSpent: budget.bytesSpent(),
    itemsSpent: budget.itemsSpent(),
  });

  // Visits every ledger record in order, so each candidate learns its segment and scale.
  const ledger = new LedgerTracker();
  for (const adapter of LOCAL_PRECEDENT_SOURCES) {
    const result = await adapter.read(
      rootReal,
      (record) => {
        const position = record.ref.source === "log" ? ledger.observe(record.data) : null;
        const match = matchRecord(record.data, queryTerms);
        if (match) {
          const candidate: PrecedentCandidate = {
            ref: record.ref,
            score: match.matched.length,
            matched_terms: match.matched,
            untrusted_content: { label: "untrusted-source-text", text: match.snippet },
          };
          candidateIdentities.set(candidate, candidateIdentity(record.ref, record.data, position));
          top.add(candidate);
        }
        return true;
      },
      { budget },
    );
    reports.push(toSourceReport(result));
    options.onSnapshot?.(snapshot());
  }
  return snapshot();
}

/**
 * Both passes of the local search. Pass 1 is searchLocalSources (text search);
 * pass 2 searches the ledger by the identifiers of the pass-1 candidates with its
 * own budget and coverage. Intermediate snapshots carry done = false; the last
 * one carries done = true, `followUp` and every candidate's `follow_up`.
 */
export async function searchLocalSourcesWithFollowUp(
  rootReal: string | null,
  problem: string,
  options: LocalSearchWithFollowUpOptions = {},
): Promise<LocalSearchSnapshot> {
  const first = await searchLocalSources(rootReal, problem, {
    budget: options.budget,
    maxCandidates: options.maxCandidates,
    onSnapshot: (snap) => options.onSnapshot?.({ ...snap, done: false }),
  });
  const followUp = await runFollowUpPass(
    rootReal,
    first.candidates.map((candidate) => ({ ref: candidate.ref, identity: identityOf(candidate) })),
    { budget: options.followUpBudget },
  );
  const final: LocalSearchSnapshot = {
    done: true,
    sources: first.sources,
    candidates: first.candidates.map((candidate, index) => ({ ...candidate, follow_up: followUp.candidates[index] })),
    matchesTotal: first.matchesTotal,
    bytesSpent: first.bytesSpent,
    itemsSpent: first.itemsSpent,
    followUp: followUp.report,
  };
  options.onSnapshot?.(final);
  return final;
}

// ─── Child process ───────────────────────────────────────────────────────────

function toBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
}

function parseSnapshotLine(line: string): LocalSearchSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "snapshot") return null;
  if (typeof parsed.done !== "boolean" || !Array.isArray(parsed.sources) || !Array.isArray(parsed.candidates)) return null;
  if (typeof parsed.matchesTotal !== "number") return null;
  return parsed as unknown as LocalSearchSnapshot;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "ignore"]; windowsHide: boolean },
): SearchChildProcess {
  return nodeSpawn(command, [...args], options) as unknown as SearchChildProcess;
}

function errorText(err: unknown): string {
  return capChars(err instanceof Error ? err.message : String(err), ERROR_MAX_CHARS);
}

/**
 * Runs the search in a child process under a wall-clock deadline. Resolves on
 * the first of: the final snapshot, child failure, or the deadline (the child
 * is killed and the last snapshot is kept). Snapshots are read line by line;
 * an unterminated last line is ignored.
 */
export function runSearchChild(
  workDir: string,
  problem: string,
  options: PrecedentSearchOptions = {},
): Promise<SearchChildRun> {
  const deadlineMs = options.deadlineMs ?? SEARCH_DEADLINE_MS;
  const deps: SearchChildDeps = {
    spawn: defaultSpawn,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...options.deps,
  };
  const command = options.command ?? process.execPath;
  const args = options.args ?? [...CHILD_NODE_FLAGS, MODULE_PATH, CHILD_FLAG];

  return new Promise((resolve) => {
    let settled = false;
    let latest: LocalSearchSnapshot | null = null;
    let timer: unknown;
    let pending = "";
    const decoder = new StringDecoder("utf8");

    const settle = (run: SearchChildRun): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve(run);
    };

    let child: SearchChildProcess;
    try {
      child = deps.spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      settle({ snapshot: null, deadlineHit: false, error: errorText(err) });
      return;
    }

    timer = deps.setTimer(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      settle({ snapshot: latest, deadlineHit: true });
    }, deadlineMs);

    child.stdout.on("data", (chunk) => {
      pending += decoder.write(toBuffer(chunk));
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        const snap = parseSnapshotLine(line);
        if (!snap) continue;
        latest = snap;
        if (snap.done) settle({ snapshot: snap, deadlineHit: false });
      }
    });
    child.on("error", (err) => settle({ snapshot: latest, deadlineHit: false, error: errorText(err) }));
    child.on("close", (code) =>
      settle({ snapshot: latest, deadlineHit: false, error: `search process exited before completion (code ${code})` }),
    );
    child.stdin.on?.("error", () => {
      // The child may exit before reading its input; the close/deadline path reports it.
    });
    child.stdin.end(JSON.stringify({ workDir, problem }));
  });
}

// ─── Report assembly and output limit ────────────────────────────────────────

function missingSourceReport(source: PrecedentSourceId, run: SearchChildRun): SearchSourceReport {
  if (run.deadlineHit) {
    return { source, status: "truncated", truncatedBy: "deadline", bytes: 0, items: 0, records: 0 };
  }
  return {
    source,
    status: "error",
    error: run.error ?? "search process ended without a report for this source",
    bytes: 0,
    items: 0,
    records: 0,
  };
}

function isComplete(reports: readonly SearchSourceReport[]): boolean {
  return reports.every((report) => {
    if (report.source === "log") return report.status === "searched";
    return report.status === "searched" || report.status === "unavailable";
  });
}

function reportBytes(report: PrecedentSearchReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * Renders the report with the largest prefix of `candidates` whose serialized
 * form fits `maxBytes`. Candidates are already ranked, so the omitted ones are
 * the lowest-ranked. Falls back to zero candidates if even the base is over.
 */
export function assembleReport(
  base: PrecedentSearchReportBase,
  candidates: readonly PrecedentCandidate[],
  matchesTotal: number,
  maxBytes: number,
): PrecedentSearchReport {
  const render = (keep: number): PrecedentSearchReport => ({
    ...base,
    candidates: candidates.slice(0, keep),
    output: {
      matchesTotal,
      returned: keep,
      omitted: matchesTotal - keep,
      truncated: matchesTotal - keep > 0,
    },
  });
  for (let keep = candidates.length; keep > 0; keep--) {
    const report = render(keep);
    if (reportBytes(report) <= maxBytes) return report;
  }
  return render(0);
}

function invalidBase(reason: "empty" | "no-terms" | "too-long", deadlineMs: number): PrecedentSearchReportBase {
  return {
    schema: SCHEMA,
    query: { terms: [], invalidReason: reason },
    outcome: "invalid-query",
    complete: false,
    deadline: { ms: deadlineMs, hit: false },
    budget: { maxBytes: SEARCH_MAX_BYTES, maxItems: SEARCH_MAX_ITEMS, bytesSpent: 0, itemsSpent: 0 },
    sources: [],
    followUp: emptyFollowUpReport("not-run", { reason: "no-candidates" }),
    memory: { status: "unavailable", reason: "no supported memory adapter in this runtime" },
  };
}

/**
 * Follow-up report when the child delivered no final snapshot: the pass did not
 * finish before the deadline, or the child failed.
 */
function missingFollowUpReport(run: SearchChildRun): FollowUpReport {
  if (run.deadlineHit) return emptyFollowUpReport("truncated", { truncatedBy: "deadline" });
  return emptyFollowUpReport("error", { error: run.error ?? "identifier follow-up produced no report" });
}

/**
 * Searches local precedent sources for `problem` in a child process under the
 * deadline and returns a bounded report. Empty, term-less or overlong problems
 * return `invalid-query` without spawning anything.
 */
export async function searchPrecedents(
  workDir: string,
  problem: string,
  options: PrecedentSearchOptions = {},
): Promise<PrecedentSearchReport> {
  const maxOutputBytes = options.maxOutputBytes ?? SEARCH_MAX_OUTPUT_BYTES;
  const deadlineMs = options.deadlineMs ?? SEARCH_DEADLINE_MS;

  if (problem.length > SEARCH_MAX_PROBLEM_CHARS) {
    return assembleReport(invalidBase("too-long", deadlineMs), [], 0, maxOutputBytes);
  }
  if (problem.trim() === "") {
    return assembleReport(invalidBase("empty", deadlineMs), [], 0, maxOutputBytes);
  }
  const terms = extractTerms(problem);
  if (terms.length === 0) {
    return assembleReport(invalidBase("no-terms", deadlineMs), [], 0, maxOutputBytes);
  }

  const run = await runSearchChild(workDir, problem, options);
  const snapshot = run.snapshot;
  const sources = LOCAL_PRECEDENT_SOURCES.map((adapter) => {
    return snapshot?.sources.find((report) => report.source === adapter.id) ?? missingSourceReport(adapter.id, run);
  });
  const complete = isComplete(sources);
  const matchesTotal = snapshot?.matchesTotal ?? 0;
  const base: PrecedentSearchReportBase = {
    schema: SCHEMA,
    query: { terms },
    outcome: !complete ? "incomplete" : matchesTotal > 0 ? "matches" : "no-matches",
    complete,
    deadline: { ms: deadlineMs, hit: run.deadlineHit },
    budget: {
      maxBytes: SEARCH_MAX_BYTES,
      maxItems: SEARCH_MAX_ITEMS,
      bytesSpent: snapshot?.bytesSpent ?? 0,
      itemsSpent: snapshot?.itemsSpent ?? 0,
    },
    sources,
    followUp: snapshot?.followUp ?? missingFollowUpReport(run),
    memory: { status: "unavailable", reason: "no supported memory adapter in this runtime" },
  };
  return assembleReport(base, snapshot?.candidates.slice(0, SEARCH_MAX_CANDIDATES) ?? [], matchesTotal, maxOutputBytes);
}

// ─── Child-process entry ─────────────────────────────────────────────────────

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(toBuffer(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseChildInput(raw: string): { workDir: string; problem: string } {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.workDir !== "string" || typeof parsed.problem !== "string") {
    throw new Error("invalid precedent search input");
  }
  return { workDir: parsed.workDir, problem: parsed.problem };
}

async function runChildMain(): Promise<void> {
  const emit = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  try {
    const input = parseChildInput(await readAllStdin());
    const rootReal = resolveSourceRoot(input.workDir);
    await searchLocalSourcesWithFollowUp(rootReal, input.problem, {
      onSnapshot: (snap) => emit({ type: "snapshot", ...snap }),
    });
  } catch (err) {
    emit({ type: "error", message: errorText(err) });
    process.exitCode = 1;
  }
}

if (process.argv.includes(CHILD_FLAG)) {
  void runChildMain();
}
