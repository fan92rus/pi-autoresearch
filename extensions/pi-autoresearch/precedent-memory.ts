/**
 * Memory source of `search_precedents` (research-precedent-search, task 2.3).
 *
 * The extension has no supported API for the session's memory tool (`recall`): a tool
 * listed in the LLM context is not callable from ExtensionAPI. So a memory source exists
 * only when the host passes an adapter (PrecedentReportOptions.memory). Without one the
 * report marks memory `unavailable`, is not incomplete because of it, and tells the agent
 * how to proceed (instruction). The local search is unchanged in that case.
 *
 * With an adapter:
 *   - The adapter is a module (`modulePath`, absolute) that exports `search(query, limits)`.
 *     It runs in a worker thread, so a synchronous adapter cannot block the operation: the
 *     deadline timer runs on the main thread, ends the call and terminates the worker, which
 *     stops even a busy loop. A late answer is ignored.
 *   - The call runs first, before the local search, and gets the rest of the shared budget
 *     (`maxBytes`, `maxItems`). Its spend (`spent`, the larger of what the adapter reports and
 *     the measured size of the references it returned) is taken off the operation budget, so the
 *     local search gets only the remainder and reports itself truncated when that is not enough.
 *     A call that did not answer (deadline, worker crash) is charged its whole limit: it ran
 *     unmetered. Reads inside the adapter are metered only by its own report; the adapter is host
 *     code, so this is a cooperative contract, not a sandbox.
 *   - Status: `searched` (finished, not truncated; zero results is a completed search with no
 *     matches), `truncated` (the adapter reported truncation, returned more than
 *     MEMORY_MAX_RESULTS results, spent more than its budget, or missed the deadline), `error`
 *     (throw, rejection, worker failure or malformed response). `truncated` and `error` make the
 *     whole report incomplete.
 *   - Every returned reference is accounted (`returned`) and becomes an entry. An entry is
 *     SECONDARY evidence: a named file is only checked by path containment and existence
 *     (checkPathInRoots: nothing is opened or read). `access` is `in-root` (inside the project
 *     root and present), `outside-root` (refused: containment is checked lexically, and by
 *     realpath for paths inside the root), `missing`, or `not-named` (no path: nothing to verify).
 *   - Provider text (references, snippets) is untrusted data under `untrusted_content`.
 *   - The adapter has no stable version, so a report with a configured memory source is never
 *     reported fresh (see checkPrecedentReportFreshness in precedent-report.ts).
 *
 * Non-goals: a concrete memory product adapter, memory-side writes, automatic scans of other
 * sessions or projects.
 */

import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { checkPathInRoots, toRelativePosix } from "./precedent-sources.ts";

// ─── Limits and texts ────────────────────────────────────────────────────────

/** Results accepted from one memory call; more is reported `truncated` by "results". */
export const MEMORY_MAX_RESULTS = 20;
export const MEMORY_MAX_REF_CHARS = 200;
export const MEMORY_MAX_TEXT_CHARS = 160;
export const MEMORY_MAX_NAME_CHARS = 60;
/** Longest the memory call may run inside the operation; the local search keeps the rest of the deadline. */
export const MEMORY_DEADLINE_MS = 3_000;
export const MEMORY_UNAVAILABLE_REASON = "no supported memory adapter in this runtime";
export const MEMORY_UNAVAILABLE_INSTRUCTION =
  "Адаптер памяти в этой среде не подключён: память не просмотрена и не входит в покрытие отчёта. " +
  "Если в сессии доступен инструмент памяти (например, recall), выполни поиск по этой проблеме отдельно " +
  "и используй найденное только как вторичное свидетельство со ссылками на исходные записи.";
const ERROR_MAX_CHARS = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MemoryResult {
  /** Provider reference (opaque text, untrusted). */
  ref: string;
  /** File the reference names, relative to the project root or absolute. Checked, never opened. */
  path?: string;
  /** 1-based physical line of `path`; only with `path`. */
  line?: number;
  /** Provider text of the record (untrusted). */
  text?: string;
}

/** Shared budget a memory call may spend, in the units of the local search. */
export interface MemoryBudget {
  maxBytes: number;
  maxItems: number;
}

/** What the adapter receives: its result limit, its deadline and the budget left for it. */
export interface MemoryLimits extends MemoryBudget {
  maxResults: number;
  deadlineMs: number;
}

export interface MemorySpend {
  bytes: number;
  items: number;
}

export type MemoryAdapterResponse =
  | { ok: true; results: MemoryResult[]; truncated?: boolean; spent?: MemorySpend }
  | { ok: false; error: string; spent?: MemorySpend };

/**
 * Host-supplied memory source. `modulePath` is an absolute path of an ES module that exports
 * `search(query, limits)` (sync or async, returning a MemoryAdapterResponse). The module runs in a
 * worker thread, so functions cannot be passed directly. Its name is a label for the report, not a
 * claim about the host's product.
 */
export interface PrecedentMemoryAdapter {
  name: string;
  modulePath: string;
}

export type MemoryTruncation = "deadline" | "results" | "adapter" | "budget";
export type MemoryAccess = "in-root" | "outside-root" | "missing" | "not-named";
export type MemoryStatus = "unavailable" | "searched" | "error" | "truncated";

export interface MemoryEntry {
  access: MemoryAccess;
  /** Root-relative POSIX path; only for access "in-root". */
  path?: string;
  line?: number;
  /** Memory is never primary evidence. */
  evidence: "secondary";
  untrusted_content: { label: "untrusted-source-text"; ref: string; text?: string };
}

/** The memory section of a search report. */
export interface MemorySection {
  status: MemoryStatus;
  /** Only for `unavailable`. */
  reason?: string;
  /** Only for `unavailable`: what the agent should do instead. */
  instruction?: string;
  /** Label of the configured adapter. */
  adapter?: string;
  /** Only for `error`. */
  error?: string;
  /** Only for `truncated`. */
  truncatedBy?: MemoryTruncation;
  /** References the adapter returned and the report accounts for. */
  returned: number;
  /** Accounted references not kept in `entries` because of the output limit. */
  omitted: number;
  entries: MemoryEntry[];
}

/** Outcome of one adapter call, before it is turned into a section. */
export interface MemoryCall {
  status: "searched" | "error" | "truncated";
  results: MemoryResult[];
  truncatedBy?: MemoryTruncation;
  error?: string;
  /** What the call took from the shared budget. */
  spent: MemorySpend;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSpend(value: unknown): value is MemorySpend {
  return isRecord(value) && isCount(value.bytes) && isCount(value.items);
}

function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function errorText(err: unknown): string {
  return capChars(err instanceof Error ? err.message : String(err), ERROR_MAX_CHARS);
}

function failed(error: string, spent: MemorySpend): MemoryCall {
  return { status: "error", results: [], error: capChars(error, ERROR_MAX_CHARS), spent };
}

/** A call whose answer is missing or unreadable ran unmetered: its whole budget is charged. */
function wholeBudget(budget: MemoryBudget): MemorySpend {
  return { bytes: budget.maxBytes, items: budget.maxItems };
}

// ─── Adapter call ────────────────────────────────────────────────────────────

/** One result of the adapter's response, or null when its shape is not the contract. */
function parseResult(raw: unknown): MemoryResult | null {
  if (!isRecord(raw) || typeof raw.ref !== "string" || raw.ref.trim() === "") return null;
  const result: MemoryResult = { ref: raw.ref };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim() === "") return null;
    result.path = raw.path;
  }
  if (raw.line !== undefined) {
    if (result.path === undefined || typeof raw.line !== "number" || !Number.isSafeInteger(raw.line) || raw.line < 1) {
      return null;
    }
    result.line = raw.line;
  }
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string") return null;
    result.text = raw.text;
  }
  return result;
}

/**
 * Turns the adapter's answer into a call outcome. The charge is the larger of the reported spend and
 * the measured size of the returned references. Any shape violation is an error, never a partial
 * success, and an unreadable answer is charged the whole budget.
 */
export function interpretMemoryResponse(raw: unknown, budget: MemoryBudget): MemoryCall {
  if (!isRecord(raw) || (raw.spent !== undefined && !isSpend(raw.spent))) {
    return failed("invalid memory adapter response", wholeBudget(budget));
  }
  const reported: MemorySpend = isSpend(raw.spent) ? raw.spent : { bytes: 0, items: 0 };
  if (raw.ok === false) {
    return failed(typeof raw.error === "string" ? raw.error : "memory adapter failed", reported);
  }
  if (raw.ok !== true || !Array.isArray(raw.results)) return failed("invalid memory adapter response", wholeBudget(budget));
  if (raw.truncated !== undefined && typeof raw.truncated !== "boolean") {
    return failed("invalid memory adapter response", wholeBudget(budget));
  }
  const results: MemoryResult[] = [];
  for (const item of raw.results) {
    const parsed = parseResult(item);
    if (parsed === null) return failed("invalid memory adapter result", wholeBudget(budget));
    results.push(parsed);
  }
  const measuredBytes = results.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), "utf8"), 0);
  const spent: MemorySpend = {
    bytes: Math.max(reported.bytes, measuredBytes),
    items: Math.max(reported.items, results.length),
  };
  const kept = results.slice(0, MEMORY_MAX_RESULTS);
  if (spent.bytes > budget.maxBytes || spent.items > budget.maxItems) {
    return { status: "truncated", results: kept, truncatedBy: "budget", spent };
  }
  if (results.length > MEMORY_MAX_RESULTS) return { status: "truncated", results: kept, truncatedBy: "results", spent };
  if (raw.truncated === true) return { status: "truncated", results, truncatedBy: "adapter", spent };
  return { status: "searched", results, spent };
}

/**
 * Runs in the worker: imports the adapter module, calls its `search` and posts either the answer or
 * the failure. It is a plain script (eval), so it needs no file of its own.
 */
const MEMORY_WORKER_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  "(async () => {",
  "  const mod = await import(workerData.href);",
  '  if (typeof mod.search !== "function") throw new Error("memory adapter module exports no search");',
  "  parentPort.postMessage({ answer: await mod.search(workerData.query, workerData.limits) });",
  '})().catch((err) => parentPort.postMessage({ failure: err instanceof Error ? err.message : String(err) }));',
].join("\n");

function answerOf(message: unknown, budget: MemoryBudget): MemoryCall {
  if (isRecord(message) && "answer" in message) return interpretMemoryResponse(message.answer, budget);
  if (isRecord(message) && typeof message.failure === "string") return failed(message.failure, { bytes: 0, items: 0 });
  return failed("invalid memory adapter response", wholeBudget(budget));
}

/**
 * Calls the adapter once in a worker thread under a deadline. Resolves with the first of: the
 * adapter's answer, its failure, the worker's exit, or the deadline (truncated). The deadline timer
 * is on the main thread, so it fires even when the adapter blocks its own thread; the worker is then
 * terminated. Never rejects.
 */
export function runMemorySearch(
  adapter: PrecedentMemoryAdapter,
  query: string,
  budget: MemoryBudget & { deadlineMs: number },
): Promise<MemoryCall> {
  const limits: MemoryLimits = {
    maxResults: MEMORY_MAX_RESULTS,
    deadlineMs: budget.deadlineMs,
    maxBytes: budget.maxBytes,
    maxItems: budget.maxItems,
  };
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (call: MemoryCall): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (worker !== undefined) void worker.terminate().catch(() => undefined);
      resolve(call);
    };
    timer = setTimeout(
      () => settle({ status: "truncated", results: [], truncatedBy: "deadline", spent: wholeBudget(budget) }),
      Math.max(0, budget.deadlineMs),
    );
    try {
      worker = new Worker(MEMORY_WORKER_SOURCE, {
        eval: true,
        workerData: { href: pathToFileURL(adapter.modulePath).href, query, limits },
      });
      worker.on("message", (message: unknown) => settle(answerOf(message, budget)));
      worker.on("error", (err: unknown) => settle(failed(errorText(err), wholeBudget(budget))));
      worker.on("exit", () => settle(failed("memory adapter stopped before answering", wholeBudget(budget))));
    } catch (err) {
      settle(failed(errorText(err), wholeBudget(budget)));
    }
  });
}

// ─── Entries and sections ────────────────────────────────────────────────────

/** Containment and existence of a named file, without opening it. */
function accessOf(rootReal: string | null, rawPath: string): { access: MemoryAccess; path?: string } {
  if (rootReal === null) return { access: "outside-root" };
  const checked = checkPathInRoots(rawPath, [rootReal]);
  if (checked.ok) return { access: "in-root", path: toRelativePosix(rootReal, checked.absolute) };
  return { access: checked.reason === "outside-root" ? "outside-root" : "missing" };
}

/** Provider text as one line of bounded length: control characters flattened, then capped. */
function snippetOf(text: string): string {
  const flat = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return capChars(flat, MEMORY_MAX_TEXT_CHARS);
}

function toEntry(result: MemoryResult, rootReal: string | null): MemoryEntry {
  const entry: MemoryEntry = {
    access: "not-named",
    evidence: "secondary",
    untrusted_content: { label: "untrusted-source-text", ref: capChars(result.ref, MEMORY_MAX_REF_CHARS) },
  };
  if (result.path !== undefined) {
    const access = accessOf(rootReal, result.path);
    entry.access = access.access;
    if (access.path !== undefined) entry.path = access.path;
  }
  if (result.line !== undefined) entry.line = result.line;
  if (result.text !== undefined) {
    const text = snippetOf(result.text);
    if (text !== "") entry.untrusted_content.text = text;
  }
  return entry;
}

/** Section of a configured adapter's call. */
export function memorySection(call: MemoryCall, adapterName: string, rootReal: string | null): MemorySection {
  const section: MemorySection = {
    status: call.status,
    adapter: capChars(String(adapterName), MEMORY_MAX_NAME_CHARS),
    returned: call.results.length,
    omitted: 0,
    entries: call.results.map((result) => toEntry(result, rootReal)),
  };
  if (call.error !== undefined) section.error = call.error;
  if (call.truncatedBy !== undefined) section.truncatedBy = call.truncatedBy;
  return section;
}

/** Section when no adapter is configured: `unavailable`, with the fallback instruction. */
export function unavailableMemorySection(): MemorySection {
  return {
    status: "unavailable",
    reason: MEMORY_UNAVAILABLE_REASON,
    instruction: MEMORY_UNAVAILABLE_INSTRUCTION,
    returned: 0,
    omitted: 0,
    entries: [],
  };
}

/**
 * Drops the lowest-ordered entries until `fits` accepts the section. The count of
 * accounted references stays `returned`; the dropped ones are reported as `omitted`.
 */
export function fitMemorySection(section: MemorySection, fits: (candidate: MemorySection) => boolean): MemorySection {
  let current = section;
  while (!fits(current) && current.entries.length > 0) {
    const entries = current.entries.slice(0, -1);
    current = { ...current, entries, omitted: section.returned - entries.length };
  }
  return current;
}
