/**
 * chain-journal.ts — append-only journal of a research-charter chain:
 * chain directory outside the campaign root, a JSON Lines journal with a
 * prev_hash chain, an external head anchor (chain-head), chain statuses and
 * the status-based action gate.
 *
 * Scope: openspec/changes/research-charter spec — requirements «Журнал
 * цепочки» and «Статусы цепочки», tasks 3.1-3.4 (bd pi-autoresearch-5ys).
 *
 * Deliberately standalone: no imports from the extension UI, no Git. It
 * imports writeFileAtomic from research-state.ts and keeps a local sha256Hex
 * copy; the file formats:
 *
 *   <workDir>/.auto/research-chain/<chainId>/chain.json   JSON Lines, one
 *         entry per line, exactly as serialized (no internal newlines).
 *   <workDir>/.auto/research-chain/<chainId>/chain-head   sha256 of the last
 *         line; verified on every chain action (fail closed).
 *   <workDir>/.auto/research-chain/<chainId>/lock         exclusive lock,
 *         same wx-create scheme as research-state.ts (never stolen).
 *
 * prev_hash of the first entry is the empty string; prev_hash of entry N is
 * sha256 of the exact line text of entry N-1. Any damage — an unreadable or
 * missing file, an invalid JSON line, a broken prev_hash link, a head
 * mismatch, a blank line or a journal not rooted by chain_created — refuses
 * every action (read AND write) with manual_check_required. Nothing is
 * repaired or retried automatically (fail closed, like research-state.ts).
 */

import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./research-state.ts";

// ─── Paths and file names ────────────────────────────────────────────────────

/** Root that holds every chain of a work directory — OUTSIDE .auto/research. */
export function chainRoot(workDir: string): string {
  return join(workDir, ".auto", "research-chain");
}

export const CHAIN_FILE = "chain.json";
export const HEAD_FILE = "chain-head";
export const LOCK_FILE = "lock";
/** Durable marker written when a chain action finds the chain damaged or its
 *  charter changed (spec 3.2/3.3). It lives beside chain.json, not inside it,
 *  so it can be written without a verifiable journal. verifyChain refuses while
 *  it exists, which keeps the status manual_check_required (fail closed). */
export const MANUAL_FILE = "manual-check";

/** Bounded retries while the chain lock is held (see research-journal.ts). */
export const CHAIN_LOCK_RETRY_COUNT = 40;
export const CHAIN_LOCK_RETRY_DELAY_MS = 50;

/** Directory of one chain. Refuses ids that could escape the root. */
export function chainDir(workDir: string, chainId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(chainId)) return null;
  return join(chainRoot(workDir), chainId);
}

// ─── Result/Refusal (same shape as research-state.ts) ────────────────────────

export interface Refusal {
  ok: false;
  reason: string;
  /** One line, safe to show; control characters are escaped. */
  message: string;
}

export type Result<T> = ({ ok: true } & T) | Refusal;

function refuse(reason: string, message: string): Refusal {
  return { ok: false, reason, message };
}

/** Escape control characters so a message stays one honest line. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Quote a user-controlled identifier for a message. */
function quote(s: string): string {
  return oneLine(JSON.stringify(s));
}

function errorText(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entries ─────────────────────────────────────────────────────────────────

export interface ChainEntry {
  type: string;
  /** ISO timestamp of the write. */
  at: string;
  /** sha256 of the previous line's exact text; empty string for the first line. */
  prev_hash: string;
  /** Free-form payload; the caller passes the fields it needs. */
  [key: string]: unknown;
}

/** Serialize an entry to its journal line (sorted-free: insertion order kept). */
function entryLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

// ─── Lock (same scheme as research-journal.ts: wx create, never stolen) ─────

interface LockHandle {
  path: string;
  fd: number;
  token: string;
}

async function acquireChainLock(dir: string): Promise<Result<{ lock: LockHandle }>> {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt <= CHAIN_LOCK_RETRY_COUNT; attempt++) {
    if (attempt > 0) await sleep(CHAIN_LOCK_RETRY_DELAY_MS);
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      const code = errorCode(err);
      // EEXIST: held. EPERM/EBUSY: Windows reports a pending delete this way.
      if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") continue;
      return refuse("operation_failed", `cannot create lock ${quote(path)} (${errorText(err)})`);
    }
    // The lock file is ours from here on (created exclusively). Write the owner record
    // through the same handle, then keep it open until release.
    const token = randomBytes(16).toString("hex");
    const payload = Buffer.from(
      JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() }),
      "utf8",
    );
    try {
      const written = writeSync(fd, payload);
      if (written !== payload.length) {
        closeSync(fd);
        return refuse("operation_failed", `short lock write ${written} of ${payload.length} bytes; the lock is left in place`);
      }
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // ignored
      }
      return refuse("operation_failed", `cannot write lock ${quote(path)} (${errorText(err)}); it is left in place`);
    }
    return { ok: true, lock: { path, fd, token } };
  }
  return refuse(
    "lock_busy",
    `chain lock ${quote(path)} is held after ${CHAIN_LOCK_RETRY_COUNT + 1} attempts; nothing was written; retrying is safe`,
  );
}

/** Ownership-checked release: remove the lock only when its token is ours. */
function releaseChainLock(lock: LockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // ignored: the fd may already be closed by the caller's error path
  }
  let raw: string;
  try {
    raw = readFileSync(lock.path, "utf8");
  } catch {
    return; // missing or unreadable: leave it; a stale lock refuses future actions
  }
  try {
    const info: unknown = JSON.parse(raw);
    if (
      typeof info === "object" &&
      info !== null &&
      (info as { token?: unknown }).token === lock.token
    ) {
      unlinkSync(lock.path);
    }
  } catch {
    // unrecognized content: leave the lock in place (no stealing)
  }
}

// ─── Create / append / verify ────────────────────────────────────────────────

/**
 * Verifies the chain for WRITE actions (B1): the write path runs the same
 * full verification as the read path (verifyChain) before anything is
 * written; the body lines of the verified journal are returned for the
 * append. Refuses with manual_check_required before any write when the
 * journal or head is damaged/missing. One verification path, no divergence.
 */
async function requireChain(
  dir: string,
  workDir: string,
  chainId: string,
): Promise<Result<{ body: string[]; head: string }>> {
  const verified = await verifyChain(workDir, chainId);
  if (!verified.ok) return verified;
  const text = await readFile(join(dir, CHAIN_FILE), "utf8");
  const lines = text.split("\n");
  const trailing = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return { ok: true, body: lines.slice(0, trailing), head: verified.head };
}

async function writeHead(dir: string, head: string): Promise<void> {
  await writeFileAtomic(join(dir, HEAD_FILE), head + "\n");
}

/**
 * Creates the chain directory with the first `chain_created` entry. Refuses
 * an existing chain (campaign_exists) so earlier chains are never overwritten.
 * Race safety (M2): the journal file is created with wx-exclusive semantics,
 * so of two concurrent createChain calls exactly one writes it; the loser
 * gets campaign_exists.
 */
export async function createChain(
  workDir: string,
  chainId: string,
  rootCampaignId: string,
): Promise<Result<{ dir: string }>> {
  const dir = chainDir(workDir, chainId);
  if (dir === null) return refuse("invalid_argument", "chain id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return refuse("operation_failed", `cannot create chain directory ${quote(dir)} (${errorText(err)})`);
  }
  const first: ChainEntry = {
    type: "chain_created",
    at: new Date().toISOString(),
    prev_hash: "",
    chain_id: chainId,
    root_campaign_id: rootCampaignId,
  };
  const line = entryLine(first);
  // Exclusive create: concurrent creators race on this wx write; the loser
  // gets EEXIST and refuses, so an existing chain is never overwritten.
  let fd: number;
  try {
    fd = openSync(join(dir, CHAIN_FILE), "wx");
  } catch (err) {
    if (errorCode(err) === "EEXIST") return refuse("campaign_exists", `chain ${quote(chainId)} already exists`);
    return refuse("operation_failed", `cannot create ${quote(CHAIN_FILE)} (${errorText(err)})`);
  }
  try {
    const bytes = Buffer.from(line + "\n", "utf8");
    const written = writeSync(fd, bytes);
    if (written !== bytes.length) {
      return refuse("operation_failed", `short journal write ${written} of ${bytes.length} bytes; manual check required`);
    }
    try {
      fsyncSync(fd);
    } catch {
      // fsync failure is not fatal on all platforms; the data is written
    }
  } finally {
    closeSync(fd);
  }
  await writeHead(dir, sha256Hex(line));
  return { ok: true, dir };
}
/**
 * Appends one entry under the chain lock after full verification (B1): a
 * damaged journal/head refuses with manual_check_required before the write.
 * The entry is built as {type, at, prev_hash, ...payload}; payload keys
 * `type`, `at` and `prev_hash` are refused outright (M1) so a caller can never
 * override the journal's structural fields. The write goes through
 * writeFileAtomic with the full new text whose prefix is byte-identical to
 * the old text (rewrite-with-identical-prefix; the prefix-identity test is
 * the guard), crash-safe via rename. chain-head is updated to the hash of the
 * new line.
 */
export async function appendEntry(
  dir: string,
  workDir: string,
  chainId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<Result<{ entry: ChainEntry; head: string }>> {
  if (typeof type !== "string" || type === "") {
    return refuse("invalid_argument", "entry type must be a non-empty string");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return refuse("invalid_argument", "payload must be an object");
  }
  const reserved = ["type", "at", "prev_hash"].filter((key) => key in payload);
  if (reserved.length > 0) {
    return refuse("invalid_argument", `payload has reserved journal fields: ${reserved.map(quote).join(", ")}`);
  }
  if (type === "status_change") {
    const status = payload.status;
    if (typeof status !== "string" || !(CHAIN_STATUSES as readonly string[]).includes(status)) {
      return refuse(
        "invalid_argument",
        `status_change requires a known chain status; known: ${CHAIN_STATUSES.join(", ")}`,
      );
    }
  }
  // Cheap pre-check outside the lock gives fast feedback; the authoritative
  // verification runs under the lock below, so a chain damaged while this
  // caller waits for the lock still refuses.
  const precheck = await requireChain(dir, workDir, chainId);
  if (!precheck.ok) return precheck;
  const lock = await acquireChainLock(dir);
  if (!lock.ok) return lock;
  try {
    // Authoritative verification UNDER the lock: the chain may have been
    // damaged or re-anchored between the pre-check and acquiring the lock.
    const verified = await verifyChain(workDir, chainId);
    if (!verified.ok) return verified;
    const text = await readFile(join(dir, CHAIN_FILE), "utf8");
    const lines = text.split("\n");
    // Drop only the trailing newline artifact; any empty line inside the
    // journal is damage (m2) and refuses.
    const trailing = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const body = lines.slice(0, trailing);
    if (body.some((l) => l === "")) {
      return refuse("manual_check_required", "chain journal contains a blank line; chain actions are blocked until manual check");
    }
    const prevHash = body.length > 0 ? sha256Hex(body[body.length - 1]) : "";
    const entry: ChainEntry = {
      type,
      at: new Date().toISOString(),
      prev_hash: prevHash,
      ...payload,
    };
    const line = entryLine(entry);
    const newText = (text.endsWith("\n") || text === "" ? text : text + "\n") + line + "\n";
    await writeFileAtomic(join(dir, CHAIN_FILE), newText);
    const head = sha256Hex(line);
    await writeHead(dir, head);
    return { ok: true, entry, head };
  } finally {
    releaseChainLock(lock.lock);
  }
}

export interface VerifiedChain {
  ok: true;
  head: string;
  entries: ChainEntry[];
}

/**
 * Recomputes the prev_hash chain and compares it with chain-head. Any problem
 * — a missing/unreadable file, an invalid JSON line, a broken link, a head
 * mismatch — refuses with manual_check_required (fail closed).
 */
/**
 * Records manual_check_required durably beside the journal. Writes the marker
 * without verifying the journal (it may be the damaged part). Idempotent.
 */
export async function markManualCheckRequired(workDir: string, chainId: string, reason: string): Promise<Result<{ head: string }>> {
  const dir = chainDir(workDir, chainId);
  if (dir === null) return refuse("invalid_argument", "chain id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  try {
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, MANUAL_FILE), oneLine(reason) + "\n");
  } catch (err) {
    return refuse("manual_check_required", `manual-check marker not written: ${errorText(err)}`);
  }
  return { ok: true, head: "" };
}

export async function verifyChain(workDir: string, chainId: string): Promise<Result<VerifiedChain>> {
  const dir = chainDir(workDir, chainId);
  if (dir === null) return refuse("invalid_argument", "chain id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  try {
    const marker = await readFile(join(dir, MANUAL_FILE), "utf8");
    return refuse("manual_check_required", `chain is in manual_check_required (${oneLine(marker)}); chain actions are blocked until manual check`);
  } catch {
    // no marker: continue with the normal verification
  }
  let text: string;
  try {
    text = await readFile(join(dir, CHAIN_FILE), "utf8");
  } catch (err) {
    return refuse(
      "manual_check_required",
      `chain journal ${quote(join(dir, CHAIN_FILE))} is missing or unreadable (${errorText(err)}); chain actions are blocked until manual check`,
    );
  }
  let head: string;
  try {
    head = (await readFile(join(dir, HEAD_FILE), "utf8")).trim();
  } catch (err) {
    return refuse(
      "manual_check_required",
      `chain head ${quote(join(dir, HEAD_FILE))} is missing or unreadable (${errorText(err)}); chain actions are blocked until manual check`,
    );
  }
  const lines = text.split("\n");
  // Drop only the trailing newline artifact; any other empty line is damage (m2).
  const trailing = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const body = lines.slice(0, trailing);
  if (body.length === 0) {
    return refuse("manual_check_required", "chain journal is empty; chain actions are blocked until manual check");
  }
  if (body.some((l) => l === "")) {
    return refuse("manual_check_required", "chain journal contains a blank line; chain actions are blocked until manual check");
  }
  const entries: ChainEntry[] = [];
  let prev = "";
  for (let i = 0; i < body.length; i++) {
    let entry: unknown;
    try {
      entry = JSON.parse(body[i]);
    } catch {
      return refuse(
        "manual_check_required",
        `chain journal line ${i + 1} is not valid JSON; chain actions are blocked until manual check`,
      );
    }
    // B5: a parsed null/array/primitive is damage, not a crash.
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return refuse(
        "manual_check_required",
        `chain journal line ${i + 1} is not a JSON object; chain actions are blocked until manual check`,
      );
    }
    const e = entry as { prev_hash?: unknown };
    if (e.prev_hash !== prev) {
      return refuse(
        "manual_check_required",
        `chain journal line ${i + 1} has a broken prev_hash link; chain actions are blocked until manual check`,
      );
    }
    entries.push(entry as ChainEntry);
    prev = sha256Hex(body[i]);
  }
  // B2: the journal must be rooted by a chain_created entry; an empty or
  // re-rooted journal is damage and never re-initialized by writes.
  if (entries[0].type !== "chain_created") {
    return refuse("manual_check_required", "chain journal does not start with a chain_created entry; chain actions are blocked until manual check");
  }
  const actualHead = sha256Hex(body[body.length - 1]);
  if (actualHead !== head) {
    return refuse(
      "manual_check_required",
      `chain head mismatch (stored ${head.slice(0, 12)}, computed ${actualHead.slice(0, 12)}); chain actions are blocked until manual check`,
    );
  }
  return { ok: true, head: actualHead, entries };
}

/**
 * The value stored in chain-head. Refusal-shaped result when the file is
 * missing/unreadable (m1) — never a raw ENOENT.
 */
export async function headHash(dir: string): Promise<Result<{ head: string }>> {
  let text: string;
  try {
    text = await readFile(join(dir, HEAD_FILE), "utf8");
  } catch (err) {
    return refuse(
      "manual_check_required",
      `chain head ${quote(join(dir, HEAD_FILE))} is missing or unreadable (${errorText(err)}); chain actions are blocked until manual check`,
    );
  }
  return { ok: true, head: text.trim() };
}

// ─── Statuses and the action gate ────────────────────────────────────────────

export const CHAIN_STATUSES = [
  "active",
  "awaiting_child",
  "limit_reached",
  "stopped_by_owner",
  "stopped_by_rule",
  "manual_check_required",
  "completed",
] as const;

export type ChainStatus = (typeof CHAIN_STATUSES)[number];

const FINAL_STATUSES: readonly string[] = [
  "limit_reached",
  "stopped_by_owner",
  "stopped_by_rule",
  "manual_check_required",
  "completed",
];

export function isFinal(status: string): boolean {
  return (FINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Reads the chain status: the last status_change entry after verification.
 * Throws an Error with code manual_check_required on a damaged chain (fail
 * closed); callers match on err.code.
 */
export async function statusOf(workDir: string, chainId: string): Promise<string> {
  const verified = await verifyChain(workDir, chainId);
  if (!verified.ok) {
    const err = new Error(verified.message) as Error & { code?: string };
    err.code = verified.reason; // "manual_check_required" — callers match on this
    throw err;
  }
  let status = "active";
  for (const entry of verified.entries) {
    if (entry.type === "status_change" && typeof entry.status === "string" && isKnownStatus(entry.status)) {
      status = entry.status;
    }
  }
  return status;
}

function isKnownStatus(status: string): boolean {
  return (CHAIN_STATUSES as readonly string[]).includes(status);
}

/**
 * Append a status_change entry after full chain verification. Refuses
 * unknown statuses (B3) and non-sticky transitions (B4): no transition from
 * a final status to active/awaiting_child, and manual_check_required never
 * resolves through setChainStatus (a future manualResolve is the only path
 * out). Returns the new head on success.
 */
export async function setChainStatus(workDir: string, chainId: string, status: string): Promise<Result<{ head: string }>> {
  if (!isKnownStatus(status)) {
    return refuse("invalid_argument", `unknown chain status ${quote(status)}; known: ${CHAIN_STATUSES.join(", ")}`);
  }
  const dir = chainDir(workDir, chainId);
  if (dir === null) return refuse("invalid_argument", "chain id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  let current: string;
  try {
    current = await statusOf(workDir, chainId);
  } catch (err) {
    if (errorCode(err) === "manual_check_required") {
      return refuse("manual_check_required", (err as Error).message);
    }
    throw err;
  }
  if (isFinal(current)) {
    return refuse(
      "invalid_transition",
      `the chain is in the final status ${quote(current)}; transitions are refused until manual resolution`,
    );
  }
  const appended = await appendEntry(dir, workDir, chainId, "status_change", { status });
  if (!appended.ok) return appended;
  return { ok: true, head: appended.head };
}

/**
 * The status-based gate for chain actions: a final status refuses every
 * action; `allowReport` frees the final report of a chain stopped while a
 * campaign was still active (stopped_by_owner / stopped_by_rule /
 * limit_reached — see «Режим исследования в цепочке»).
 */
export function actionRefusalForStatus(status: string, opts?: { allowReport?: boolean }): Refusal | null {
  // B3: fail closed — an unknown status is damage and refuses every action.
  if (!isKnownStatus(status)) {
    return refuse("invalid_argument", `unknown chain status ${quote(status)}; known: ${CHAIN_STATUSES.join(", ")}`);
  }
  if (!isFinal(status)) return null;
  if (opts?.allowReport === true && status !== "manual_check_required" && status !== "completed") return null;
  return refuse("invalid_transition", `the chain is in the final status ${quote(status)}; chain actions refuse`);
}
