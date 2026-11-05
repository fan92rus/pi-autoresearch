/**
 * Append-only journal primitives for research-map (openspec/changes/research-map/design.md
 * §5.2, §6.1, §6.2, §7.4). Standalone foundation: no tool wiring, no reading and no
 * repair of existing journals.
 *
 * - withJournalLock: exclusive lock file (fs.openSync flag "wx") holding a random token,
 *   bounded asynchronous retries (1 immediate attempt + 40 retries × 50 ms), a synchronous
 *   critical section (no await inside) and a token-checked release.
 * - appendJournalLine: newline-guarded single-write append performed under the lock,
 *   with short-write detection (no retry), a 16 KiB record limit and fsync before close.
 *
 * Nothing here steals a lock. A held or stale lock is reported with manual unlock
 * instructions; the caller decides what to do. A failed or short append is never
 * retried or completed by this module.
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Maximum record size in UTF-8 bytes, including the trailing LF. */
export const JOURNAL_RECORD_MAX_BYTES = 16 * 1024;
/** Retries after the first immediate lock attempt. */
export const JOURNAL_LOCK_RETRY_COUNT = 40;
/** Pause between lock attempts, outside the critical section. */
export const JOURNAL_LOCK_RETRY_DELAY_MS = 50;

export type JournalName = "observations" | "analysis" | "run-links";

export interface JournalTarget {
  readonly name: JournalName;
  /** `<autoDir>/<name>.jsonl` */
  readonly file: string;
  /** `<autoDir>/<name>.lock` */
  readonly lock: string;
  /** Result code reported when the lock stays busy. */
  readonly busyCode: string;
}

const BUSY_CODES: Record<JournalName, string> = {
  observations: "observation_lock_busy",
  analysis: "analysis_lock_busy",
  "run-links": "run_links_lock_busy",
};

/** Build the file and lock paths of one of the three research-map journals. */
export function journalTarget(autoDir: string, name: JournalName): JournalTarget {
  return {
    name,
    file: path.join(autoDir, `${name}.jsonl`),
    lock: path.join(autoDir, `${name}.lock`),
    busyCode: BUSY_CODES[name],
  };
}

/** The subset of node:fs used here. Tests inject replacements through JournalOptions.fs. */
export interface JournalFs {
  openSync(file: string, flags: string): number;
  closeSync(fd: number): void;
  writeSync(fd: number, data: Buffer | string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  fstatSync(fd: number): { size: number };
  fsyncSync(fd: number): void;
  readFileSync(file: string, encoding: "utf8"): string;
  unlinkSync(file: string): void;
}

export interface JournalOptions {
  /** Partial override of the filesystem calls (fault injection). */
  fs?: Partial<JournalFs>;
  /** Pause used between lock attempts. Default: setTimeout-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Source of the 16 lock-token bytes. */
  randomBytes?: (size: number) => Buffer;
  /** Owner pid written into the lock file. */
  pid?: number;
  /** Owner host written into the lock file. */
  host?: string;
  /** Clock for `acquired_at`. */
  now?: () => Date;
}

export interface JournalLockInfo {
  token: string;
  pid: number;
  host: string;
  acquired_at: string;
}

export type JournalLockHolder =
  | { state: "present"; info: JournalLockInfo }
  | { state: "empty" }
  | { state: "malformed"; excerpt: string }
  | { state: "missing" }
  | { state: "unreadable"; error: string };

export interface JournalLockBusyDiagnostic {
  lockPath: string;
  /** Total attempts made, including the first immediate one. */
  attempts: number;
  holder: JournalLockHolder;
  /** Human-readable text: holder, nothing-written note, manual unlock steps. */
  message: string;
}

export type JournalWarningCode =
  | "lock_release_failed"
  | "lock_token_mismatch"
  | "lock_missing_at_release"
  | "close_failed";

export interface JournalWarning {
  code: JournalWarningCode;
  message: string;
}

export type JournalLockResult<T> =
  | { status: "acquired"; value: T; warnings: JournalWarning[] }
  | { status: "lock_busy"; code: string; diagnostic: JournalLockBusyDiagnostic; message: string }
  | { status: "lock_failed"; message: string };

export type JournalAppendResult =
  /** Full record written and fsynced. `newlineGuard` = a LF was prepended after a torn tail. */
  | { status: "appended"; bytes: number; newlineGuard: boolean; warnings: JournalWarning[] }
  /** Full record written but fsync failed: the record is not confirmed durable. */
  | { status: "fsync_failed"; bytes: number; message: string; warnings: JournalWarning[] }
  /** Partial write. Not retried; `bytesWritten > 0` leaves a torn fragment in the file. */
  | { status: "short_write"; bytesWritten: number; bytesExpected: number; message: string; warnings: JournalWarning[] }
  /** writeSync threw. Bytes written are unknown; a torn fragment may remain. */
  | { status: "write_failed"; message: string; warnings: JournalWarning[] }
  /** The tail could not be inspected; nothing was written. */
  | { status: "tail_check_failed"; message: string; warnings: JournalWarning[] }
  | { status: "record_too_large"; bytes: number; limit: number; message: string }
  | { status: "invalid_line"; message: string }
  | { status: "lock_busy"; code: string; diagnostic: JournalLockBusyDiagnostic; message: string }
  | { status: "lock_failed"; message: string };

interface ResolvedOptions {
  fs: JournalFs;
  sleep: (ms: number) => Promise<void>;
  randomBytes: (size: number) => Buffer;
  pid: number;
  host: string;
  now: () => Date;
}

const NODE_FS: JournalFs = {
  openSync: (file, flags) => fs.openSync(file, flags),
  closeSync: (fd) => fs.closeSync(fd),
  writeSync: (fd, data) => fs.writeSync(fd, data),
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  fstatSync: (fd) => fs.fstatSync(fd),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  unlinkSync: (file) => fs.unlinkSync(file),
};

const NEWLINE = Buffer.from("\n", "utf8");

function resolveOptions(options: JournalOptions): ResolvedOptions {
  return {
    fs: { ...NODE_FS, ...options.fs },
    sleep: options.sleep ?? ((ms) => delay(ms)),
    randomBytes: options.randomBytes ?? ((size) => cryptoRandomBytes(size)),
    pid: options.pid ?? process.pid,
    host: options.host ?? os.hostname(),
    now: options.now ?? (() => new Date()),
  };
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Parse lock-file content; null when it is not a complete owner record. */
function parseLockInfo(raw: string): JournalLockInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.token !== "string" ||
      typeof record.pid !== "number" ||
      typeof record.host !== "string" ||
      typeof record.acquired_at !== "string"
    ) {
      return null;
    }
    return { token: record.token, pid: record.pid, host: record.host, acquired_at: record.acquired_at };
  } catch {
    return null;
  }
}

function diagnoseHolder(lockPath: string, ops: ResolvedOptions): JournalLockHolder {
  let raw: string;
  try {
    raw = ops.fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing" };
    return { state: "unreadable", error: describeError(error) };
  }
  if (raw.trim() === "") return { state: "empty" };
  const info = parseLockInfo(raw);
  if (info) return { state: "present", info };
  return { state: "malformed", excerpt: raw.slice(0, 200) };
}

function describeHolder(holder: JournalLockHolder): string {
  switch (holder.state) {
    case "present":
      return `pid=${holder.info.pid}, host=${holder.info.host}, acquired_at=${holder.info.acquired_at}`;
    case "empty":
      return "empty lock file";
    case "malformed":
      return `unrecognized lock file content: ${JSON.stringify(holder.excerpt)}`;
    case "missing":
      return "lock file disappeared before diagnosis";
    case "unreadable":
      return `lock file unreadable: ${holder.error}`;
  }
}

function busyDiagnostic(target: JournalTarget, ops: ResolvedOptions): JournalLockBusyDiagnostic {
  const holder = diagnoseHolder(target.lock, ops);
  const attempts = JOURNAL_LOCK_RETRY_COUNT + 1;
  const message =
    `${target.busyCode}: journal lock ${target.lock} is held after ${attempts} attempts ` +
    `(${describeHolder(holder)}). Nothing was written; retrying is safe. ` +
    `Manual unlock: if no other pi processes are running in this directory, delete ${target.lock} and retry.`;
  return { lockPath: target.lock, attempts, holder, message };
}

type AcquireOutcome =
  | { status: "acquired"; token: string }
  | { status: "busy"; diagnostic: JournalLockBusyDiagnostic }
  | { status: "failed"; message: string };

async function acquireLock(target: JournalTarget, ops: ResolvedOptions): Promise<AcquireOutcome> {
  for (let attempt = 0; attempt <= JOURNAL_LOCK_RETRY_COUNT; attempt++) {
    if (attempt > 0) await ops.sleep(JOURNAL_LOCK_RETRY_DELAY_MS);

    let fd: number;
    try {
      fd = ops.fs.openSync(target.lock, "wx");
    } catch (error) {
      const code = errorCode(error);
      // EEXIST: held. EPERM/EBUSY: Windows reports a pending delete of the previous holder this way.
      if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") continue;
      return { status: "failed", message: `cannot create lock ${target.lock}: ${describeError(error)}` };
    }

    // The lock file is ours from here on (created exclusively). Write the owner record.
    const token = ops.randomBytes(16).toString("hex");
    const payload = Buffer.from(
      JSON.stringify({ token, pid: ops.pid, host: ops.host, acquired_at: ops.now().toISOString() }),
      "utf8",
    );
    let initError: string | null = null;
    try {
      const written = ops.fs.writeSync(fd, payload);
      if (written !== payload.length) initError = `short write ${written} of ${payload.length} bytes`;
    } catch (error) {
      initError = describeError(error);
    } finally {
      // The owner record is already in place; a close error does not invalidate the lock.
      try {
        ops.fs.closeSync(fd);
      } catch {
        /* ignored: see comment above */
      }
    }
    if (initError !== null) {
      // Left in place on purpose: no stealing. The next holder sees an empty or partial lock
      // and the busy diagnostic asks for a manual unlock.
      return {
        status: "failed",
        message:
          `lock ${target.lock} was created but its owner record could not be written (${initError}); ` +
          `it is left in place. If no other pi processes are running in this directory, delete it manually and retry.`,
      };
    }
    return { status: "acquired", token };
  }
  return { status: "busy", diagnostic: busyDiagnostic(target, ops) };
}

/** Ownership-checked release: remove the lock only when its token is ours. Never throws. */
function releaseLock(lockPath: string, token: string, ops: ResolvedOptions, warnings: JournalWarning[]): void {
  let raw: string;
  try {
    raw = ops.fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      warnings.push({ code: "lock_missing_at_release", message: `lock ${lockPath} was removed while held` });
    } else {
      warnings.push({ code: "lock_release_failed", message: `cannot read lock ${lockPath} for release: ${describeError(error)}` });
    }
    return;
  }

  const info = parseLockInfo(raw);
  if (info === null || info.token !== token) {
    warnings.push({
      code: "lock_token_mismatch",
      message: `lock ${lockPath} is not held by this call (token mismatch or unrecognized content); left in place`,
    });
    return;
  }

  try {
    ops.fs.unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      warnings.push({ code: "lock_missing_at_release", message: `lock ${lockPath} was removed while held` });
    } else {
      warnings.push({ code: "lock_release_failed", message: `cannot remove lock ${lockPath}: ${describeError(error)}` });
    }
  }
}

/**
 * Acquire the journal lock (bounded async retries), run `critical` synchronously, then release
 * the lock with a token check. The release runs even when `critical` throws; the error is then
 * rethrown. A `critical` that returns a thenable is a programming error: the lock is released and
 * a TypeError is thrown.
 */
export async function withJournalLock<T>(
  target: JournalTarget,
  critical: () => T,
  options: JournalOptions = {},
): Promise<JournalLockResult<T>> {
  const ops = resolveOptions(options);
  const acquired = await acquireLock(target, ops);
  if (acquired.status === "busy") {
    return { status: "lock_busy", code: target.busyCode, diagnostic: acquired.diagnostic, message: acquired.diagnostic.message };
  }
  if (acquired.status === "failed") return { status: "lock_failed", message: acquired.message };

  const warnings: JournalWarning[] = [];
  let value: T;
  try {
    value = critical();
    if (isThenable(value)) {
      // Swallow the late rejection of the misused promise; the TypeError below is the report.
      Promise.resolve(value).catch(() => undefined);
      throw new TypeError(`journal critical section for ${target.lock} must be synchronous`);
    }
  } finally {
    releaseLock(target.lock, acquired.token, ops, warnings);
  }
  return { status: "acquired", value, warnings };
}

/** True when the file exists, is non-empty and its last byte is not LF. Missing file: false. */
function needsNewlineGuard(file: string, ops: ResolvedOptions): boolean {
  let fd: number;
  try {
    fd = ops.fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    const size = ops.fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    const read = ops.fs.readSync(fd, last, 0, 1, size - 1);
    if (read !== 1) throw new Error(`tail read returned ${read} bytes`);
    return last[0] !== 0x0a;
  } finally {
    ops.fs.closeSync(fd);
  }
}

/** Outcomes produced under the lock (every one carries warnings). */
type WriteOutcome = Extract<JournalAppendResult, { warnings: JournalWarning[] }>;

/** Runs under the lock. Returns a final append outcome; `warnings` may gain entries from close. */
function writeRecordLocked(file: string, record: Buffer, ops: ResolvedOptions): WriteOutcome {
  const warnings: JournalWarning[] = [];

  let guard: boolean;
  try {
    guard = needsNewlineGuard(file, ops);
  } catch (error) {
    return { status: "tail_check_failed", message: `cannot inspect tail of ${file}: ${describeError(error)}; nothing written`, warnings };
  }

  const data = guard ? Buffer.concat([NEWLINE, record]) : record;

  let fd: number;
  try {
    fd = ops.fs.openSync(file, "a");
  } catch (error) {
    return { status: "write_failed", message: `cannot open ${file} for append: ${describeError(error)}; nothing written`, warnings };
  }

  // `warnings` is shared by reference with the returned object, so a close failure in `finally`
  // still reaches the caller.
  try {
    let written: number;
    try {
      written = ops.fs.writeSync(fd, data);
    } catch (error) {
      return {
        status: "write_failed",
        message: `write to ${file} failed: ${describeError(error)}; bytes written unknown, a torn fragment may remain`,
        warnings,
      };
    }
    if (written !== data.length) {
      return {
        status: "short_write",
        bytesWritten: written,
        bytesExpected: data.length,
        message:
          `short write to ${file}: ${written} of ${data.length} bytes; not retried` +
          (written > 0 ? ", a torn fragment remains and the next append's newline guard will separate it" : ""),
        warnings,
      };
    }
    try {
      ops.fs.fsyncSync(fd);
    } catch (error) {
      return {
        status: "fsync_failed",
        bytes: data.length,
        message: `fsync of ${file} failed: ${describeError(error)}; the record is written but not confirmed durable`,
        warnings,
      };
    }
    return { status: "appended", bytes: data.length, newlineGuard: guard, warnings };
  } finally {
    try {
      ops.fs.closeSync(fd);
    } catch (error) {
      warnings.push({ code: "close_failed", message: `close of ${file} failed: ${describeError(error)}` });
    }
  }
}

/**
 * Append one JSON line (without its trailing LF) to a journal under its lock.
 *
 * Order: size and content checks (no lock taken on failure), lock, tail check with newline
 * guard, one writeSync, fsync, close, token-checked release. The record limit applies to
 * the line plus its LF; a guard LF added after a torn tail is not counted against it.
 */
export async function appendJournalLine(
  target: JournalTarget,
  line: string,
  options: JournalOptions = {},
): Promise<JournalAppendResult> {
  if (line.length === 0 || line.includes("\n")) {
    return { status: "invalid_line", message: "journal line must be non-empty and contain no LF" };
  }
  const record = Buffer.from(`${line}\n`, "utf8");
  if (record.length > JOURNAL_RECORD_MAX_BYTES) {
    return {
      status: "record_too_large",
      bytes: record.length,
      limit: JOURNAL_RECORD_MAX_BYTES,
      message: `record is ${record.length} bytes; limit is ${JOURNAL_RECORD_MAX_BYTES} bytes including LF; nothing written`,
    };
  }

  const ops = resolveOptions(options);
  const locked = await withJournalLock(target, () => writeRecordLocked(target.file, record, ops), options);
  if (locked.status === "lock_busy") {
    return { status: "lock_busy", code: locked.code, diagnostic: locked.diagnostic, message: locked.message };
  }
  if (locked.status === "lock_failed") return { status: "lock_failed", message: locked.message };
  return { ...locked.value, warnings: [...locked.value.warnings, ...locked.warnings] };
}
