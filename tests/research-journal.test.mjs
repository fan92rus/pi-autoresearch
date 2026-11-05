/**
 * Journal foundation for research-map (design.md §6.1, §6.2, §5.2, §7.4):
 * lock primitives (wx lock file, token-checked release, bounded retries, busy diagnostic)
 * and newline-guarded single-write append with short-write detection and size limit.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-journal.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  JOURNAL_LOCK_RETRY_COUNT,
  JOURNAL_LOCK_RETRY_DELAY_MS,
  JOURNAL_RECORD_MAX_BYTES,
  appendJournalLine,
  journalTarget,
  withJournalLock,
} from "../extensions/pi-autoresearch/research-journal.ts";

const execFileAsync = promisify(execFile);
const MODULE_URL = new URL("../extensions/pi-autoresearch/research-journal.ts", import.meta.url).href;

const FOREIGN = {
  token: "ab".repeat(16),
  pid: 4242,
  host: "other-host",
  acquired_at: "2026-01-01T00:00:00.000Z",
};

function makeAutoDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  return autoDir;
}

function recordingSleep() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

function writeForeignLock(lockPath, info = FOREIGN) {
  fs.writeFileSync(lockPath, JSON.stringify(info));
}

/** True when a write chunk is the payload that contains `marker` (ignores lock owner records). */
function isRecordChunk(data, marker) {
  return Buffer.from(data).toString("utf8").includes(marker);
}

function errnoError(code) {
  return Object.assign(new Error(`${code}: injected`), { code });
}

// ---------------------------------------------------------------------------
// Constants and paths
// ---------------------------------------------------------------------------

test("exported limits match design §6.1 and §6.2", () => {
  assert.equal(JOURNAL_RECORD_MAX_BYTES, 16 * 1024);
  assert.equal(JOURNAL_LOCK_RETRY_COUNT, 40);
  assert.equal(JOURNAL_LOCK_RETRY_DELAY_MS, 50);
});

test("journalTarget maps each journal to its file, lock and busy code", () => {
  const dir = path.join("x", ".auto");
  assert.deepEqual(
    { ...journalTarget(dir, "observations") },
    { name: "observations", file: path.join(dir, "observations.jsonl"), lock: path.join(dir, "observations.lock"), busyCode: "observation_lock_busy" },
  );
  assert.deepEqual(
    { ...journalTarget(dir, "analysis") },
    { name: "analysis", file: path.join(dir, "analysis.jsonl"), lock: path.join(dir, "analysis.lock"), busyCode: "analysis_lock_busy" },
  );
  assert.deepEqual(
    { ...journalTarget(dir, "run-links") },
    { name: "run-links", file: path.join(dir, "run-links.jsonl"), lock: path.join(dir, "run-links.lock"), busyCode: "run_links_lock_busy" },
  );
});

// ---------------------------------------------------------------------------
// Lock primitives
// ---------------------------------------------------------------------------

test("withJournalLock writes an owner record during the critical section and removes it afterwards", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");
  let seen = null;

  const result = await withJournalLock(
    target,
    () => {
      seen = JSON.parse(fs.readFileSync(target.lock, "utf8"));
      return 7;
    },
    { pid: 1234, host: "host-a", now: () => new Date("2026-02-03T04:05:06.007Z") },
  );

  assert.equal(result.status, "acquired");
  assert.equal(result.value, 7);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(Object.keys(seen).sort(), ["acquired_at", "host", "pid", "token"]);
  assert.match(seen.token, /^[0-9a-f]{32}$/);
  assert.equal(seen.pid, 1234);
  assert.equal(seen.host, "host-a");
  assert.equal(seen.acquired_at, "2026-02-03T04:05:06.007Z");
  assert.equal(fs.existsSync(target.lock), false);
});

test("lock token is taken from 16 random bytes and differs between acquisitions", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");
  const sizes = [];

  let seenToken = null;
  const first = await withJournalLock(
    target,
    () => {
      seenToken = JSON.parse(fs.readFileSync(target.lock, "utf8")).token;
    },
    {
      randomBytes: (size) => {
        sizes.push(size);
        return Buffer.alloc(size, 0xab);
      },
    },
  );
  assert.equal(first.status, "acquired");
  assert.deepEqual(sizes, [16]);
  assert.equal(seenToken, "ab".repeat(16));

  const tokens = [];
  for (let i = 0; i < 2; i++) {
    await withJournalLock(target, () => {
      tokens.push(JSON.parse(fs.readFileSync(target.lock, "utf8")).token);
    });
  }
  assert.match(tokens[0], /^[0-9a-f]{32}$/);
  assert.notEqual(tokens[0], tokens[1]);
});

test("a free lock is taken on the first attempt without any pause", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const { calls, sleep } = recordingSleep();

  const result = await withJournalLock(target, () => "ok", { sleep });

  assert.equal(result.status, "acquired");
  assert.deepEqual(calls, []);
});

test("a held lock is retried 40 times at 50 ms and then reported busy without writing", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  writeForeignLock(target.lock);
  const before = fs.readFileSync(target.lock, "utf8");
  const { calls, sleep } = recordingSleep();
  let ran = false;

  const result = await withJournalLock(
    target,
    () => {
      ran = true;
    },
    { sleep },
  );

  assert.equal(result.status, "lock_busy");
  assert.equal(result.code, "observation_lock_busy");
  assert.equal(ran, false, "critical section must not run while busy");
  assert.equal(calls.length, 40);
  assert.ok(calls.every((ms) => ms === 50));
  assert.equal(result.diagnostic.attempts, 41);
  assert.deepEqual(result.diagnostic.holder, { state: "present", info: FOREIGN });
  for (const needle of [
    target.lock,
    "pid=4242",
    "host=other-host",
    FOREIGN.acquired_at,
    "Nothing was written",
    "delete",
    "retrying is safe",
  ]) {
    assert.ok(result.message.includes(needle), `busy message lacks: ${needle}`);
  }
  assert.equal(fs.readFileSync(target.lock, "utf8"), before, "foreign lock must not be modified");
});

test("a lock released during the retry window is acquired on a later attempt", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  writeForeignLock(target.lock);
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
    if (calls.length === 3) fs.unlinkSync(target.lock);
  };

  const result = await withJournalLock(target, () => "ok", { sleep });

  assert.equal(result.status, "acquired");
  assert.equal(result.value, "ok");
  assert.equal(calls.length, 3);
});

test("an empty lock file is reported as empty in the busy diagnostic", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "run-links");
  fs.writeFileSync(target.lock, "");
  const { sleep } = recordingSleep();

  const result = await withJournalLock(target, () => "never", { sleep });

  assert.equal(result.status, "lock_busy");
  assert.equal(result.code, "run_links_lock_busy");
  assert.deepEqual(result.diagnostic.holder, { state: "empty" });
  assert.ok(result.message.includes("empty lock file"));
});

test("an unrecognized lock file is reported as malformed and kept", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");
  fs.writeFileSync(target.lock, '{"token":"zz"');
  const { sleep } = recordingSleep();

  const result = await withJournalLock(target, () => "never", { sleep });

  assert.equal(result.status, "lock_busy");
  assert.equal(result.diagnostic.holder.state, "malformed");
  assert.equal(fs.readFileSync(target.lock, "utf8"), '{"token":"zz"');
});

test("a stale lock from a dead process is never stolen automatically", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const stale = { token: "01".repeat(16), pid: 999999, host: os.hostname(), acquired_at: "2000-01-01T00:00:00.000Z" };
  writeForeignLock(target.lock, stale);
  const { calls, sleep } = recordingSleep();

  const result = await withJournalLock(target, () => "never", { sleep });

  assert.equal(result.status, "lock_busy");
  assert.equal(calls.length, 40);
  assert.equal(fs.existsSync(target.lock), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target.lock, "utf8")), stale);
});

test("release does not remove a lock whose token was replaced during the critical section", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");
  const replacement = JSON.stringify({ ...FOREIGN, token: "cd".repeat(16) });

  const result = await withJournalLock(target, () => {
    fs.writeFileSync(target.lock, replacement);
    return "done";
  });

  assert.equal(result.status, "acquired");
  assert.equal(result.value, "done");
  assert.deepEqual(result.warnings.map((w) => w.code), ["lock_token_mismatch"]);
  assert.equal(fs.readFileSync(target.lock, "utf8"), replacement);
});

test("release reports a lock that was removed while held", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");

  const result = await withJournalLock(target, () => {
    fs.unlinkSync(target.lock);
  });

  assert.equal(result.status, "acquired");
  assert.deepEqual(result.warnings.map((w) => w.code), ["lock_missing_at_release"]);
});

test("a failing unlink on release surfaces lock_release_failed and keeps the lock file", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");

  const result = await withJournalLock(
    target,
    () => "ok",
    {
      fs: {
        unlinkSync() {
          throw errnoError("EPERM");
        },
      },
    },
  );

  assert.equal(result.status, "acquired");
  assert.deepEqual(result.warnings.map((w) => w.code), ["lock_release_failed"]);
  assert.equal(fs.existsSync(target.lock), true);
  fs.unlinkSync(target.lock);
});

test("a throwing critical section still releases the lock and the error propagates", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");

  await assert.rejects(
    withJournalLock(target, () => {
      throw new RangeError("boom");
    }),
    RangeError,
  );
  assert.equal(fs.existsSync(target.lock), false);
});

test("a critical section that returns a promise is rejected and the lock is released", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");

  await assert.rejects(
    withJournalLock(target, async () => {
      await null;
      return "late";
    }),
    TypeError,
  );
  assert.equal(fs.existsSync(target.lock), false);
});

test("a lock file that cannot be created (missing directory) fails without retries", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(path.join(autoDir, "missing"), "analysis");
  const { calls, sleep } = recordingSleep();

  const result = await withJournalLock(target, () => "never", { sleep });

  assert.equal(result.status, "lock_failed");
  assert.match(result.message, /cannot create lock/);
  assert.deepEqual(calls, []);
});

test("a lock whose owner record fails to write is left in place and not stolen", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const failingOwnerWrite = {
    writeSync(fd, data) {
      if (Buffer.from(data).toString("utf8").startsWith('{"token"')) throw errnoError("ENOSPC");
      return fs.writeSync(fd, data);
    },
  };

  const first = await withJournalLock(target, () => "never", { fs: failingOwnerWrite });

  assert.equal(first.status, "lock_failed");
  assert.match(first.message, /left in place/);
  assert.equal(fs.readFileSync(target.lock, "utf8"), "");

  const { sleep } = recordingSleep();
  const second = await withJournalLock(target, () => "never", { sleep });
  assert.equal(second.status, "lock_busy");
  assert.deepEqual(second.diagnostic.holder, { state: "empty" });
});

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

test("appendJournalLine writes one record with exactly one writeSync and no guard on a new file", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const recordWrites = [];
  const fsOverride = {
    writeSync(fd, data) {
      if (isRecordChunk(data, '"record":"x"')) recordWrites.push(Buffer.from(data));
      return fs.writeSync(fd, data);
    },
  };

  const result = await appendJournalLine(target, '{"v":1,"record":"x"}', { fs: fsOverride });

  assert.equal(result.status, "appended");
  assert.equal(result.bytes, Buffer.byteLength('{"v":1,"record":"x"}\n'));
  assert.equal(result.newlineGuard, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(recordWrites.length, 1);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"v":1,"record":"x"}\n');
  assert.equal(fs.existsSync(target.lock), false);
});

test("appends after an LF-terminated file add no guard and keep earlier bytes", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n');

  const result = await appendJournalLine(target, '{"b":2}', {});

  assert.equal(result.status, "appended");
  assert.equal(result.newlineGuard, false);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n{"b":2}\n');
});

test("a torn tail gets a newline guard so the new record starts on its own line", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n{"b":');

  const result = await appendJournalLine(target, '{"c":3}', {});

  assert.equal(result.status, "appended");
  assert.equal(result.newlineGuard, true);
  // The torn fragment is not repaired or removed.
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n{"b":\n{"c":3}\n');
  const lines = fs.readFileSync(target.file, "utf8").split("\n").filter(Boolean);
  assert.throws(() => JSON.parse(lines[1]));
  assert.deepEqual(JSON.parse(lines[2]), { c: 3 });
});

test("a single non-LF byte counts as a torn tail; an empty file does not", async (t) => {
  const autoDir = makeAutoDir(t);
  const torn = journalTarget(autoDir, "analysis");
  fs.writeFileSync(torn.file, "x");
  const tornResult = await appendJournalLine(torn, '{"k":1}', {});
  assert.equal(tornResult.newlineGuard, true);
  assert.equal(fs.readFileSync(torn.file, "utf8"), 'x\n{"k":1}\n');

  const empty = journalTarget(autoDir, "run-links");
  fs.writeFileSync(empty.file, "");
  const emptyResult = await appendJournalLine(empty, '{"k":2}', {});
  assert.equal(emptyResult.newlineGuard, false);
  assert.equal(fs.readFileSync(empty.file, "utf8"), '{"k":2}\n');
});

test("record of exactly 16 KiB including LF is written; one byte more is refused before locking", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const { calls, sleep } = recordingSleep();
  const lockOpens = [];
  const fsOverride = {
    openSync(file, flags) {
      if (file === target.lock) lockOpens.push(flags);
      return fs.openSync(file, flags);
    },
  };

  const fits = await appendJournalLine(target, "x".repeat(JOURNAL_RECORD_MAX_BYTES - 1), { fs: fsOverride, sleep });
  assert.equal(fits.status, "appended");
  assert.equal(fits.bytes, JOURNAL_RECORD_MAX_BYTES);
  const sizeAfterFit = fs.statSync(target.file).size;
  assert.equal(sizeAfterFit, JOURNAL_RECORD_MAX_BYTES);

  const tooLarge = await appendJournalLine(target, "x".repeat(JOURNAL_RECORD_MAX_BYTES), { fs: fsOverride, sleep });
  assert.equal(tooLarge.status, "record_too_large");
  assert.equal(tooLarge.bytes, JOURNAL_RECORD_MAX_BYTES + 1);
  assert.equal(tooLarge.limit, JOURNAL_RECORD_MAX_BYTES);
  assert.equal(fs.statSync(target.file).size, sizeAfterFit, "nothing written for an oversized record");
  assert.equal(lockOpens.length, 1, "oversized record must not take the lock (only the successful append did)");
  assert.deepEqual(calls, []);
});

test("size is counted in UTF-8 bytes, not characters", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");

  // 8191 Cyrillic characters = 16382 bytes; with LF = 16383 bytes: fits.
  const fits = await appendJournalLine(target, "я".repeat(8191) + "x", {});
  assert.equal(fits.status, "appended");

  // Only 8193 characters, but 16384 bytes before LF: refused.
  const tooLarge = await appendJournalLine(target, "я".repeat(8191) + "xx", {});
  assert.equal(tooLarge.status, "record_too_large");
  assert.equal(tooLarge.bytes, 16385);
});

test("empty lines and lines containing LF are refused without touching the file", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const { calls, sleep } = recordingSleep();

  for (const line of ["", "a\nb", "\n"]) {
    const result = await appendJournalLine(target, line, { sleep });
    assert.equal(result.status, "invalid_line", JSON.stringify(line));
  }
  assert.equal(fs.existsSync(target.file), false);
  assert.equal(fs.existsSync(target.lock), false);
  assert.deepEqual(calls, []);
});

test("a short write is reported, not retried, and leaves only the written fragment", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n');
  const line = '{"r":"short"}';
  const record = Buffer.from(`${line}\n`);
  let recordWrites = 0;
  let fsyncs = 0;
  const fsOverride = {
    writeSync(fd, data) {
      if (!isRecordChunk(data, '"r":"short"')) return fs.writeSync(fd, data);
      recordWrites++;
      return fs.writeSync(fd, data.subarray(0, data.length - 5));
    },
    fsyncSync(fd) {
      fsyncs++;
      fs.fsyncSync(fd);
    },
  };

  const result = await appendJournalLine(target, line, { fs: fsOverride });

  assert.equal(result.status, "short_write");
  assert.equal(result.bytesWritten, record.length - 5);
  assert.equal(result.bytesExpected, record.length);
  assert.equal(recordWrites, 1, "no retry of the remainder");
  assert.equal(fsyncs, 0, "a short write is not fsynced as success");
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n' + record.subarray(0, record.length - 5).toString("utf8"));
  assert.equal(fs.existsSync(target.lock), false, "lock released after a short write");
});

test("a zero-byte short write leaves the file unchanged", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n');
  const fsOverride = {
    writeSync(fd, data) {
      if (isRecordChunk(data, '"z":0')) return 0;
      return fs.writeSync(fd, data);
    },
  };

  const result = await appendJournalLine(target, '{"z":0}', { fs: fsOverride });

  assert.equal(result.status, "short_write");
  assert.equal(result.bytesWritten, 0);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n');

  const next = await appendJournalLine(target, '{"z":1}', {});
  assert.equal(next.status, "appended");
  assert.equal(next.newlineGuard, false);
});

test("a throwing writeSync reports write_failed, skips fsync and releases the lock", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n');
  let fsyncs = 0;
  const fsOverride = {
    writeSync(fd, data) {
      if (isRecordChunk(data, '"w":1')) throw errnoError("EIO");
      return fs.writeSync(fd, data);
    },
    fsyncSync(fd) {
      fsyncs++;
      fs.fsyncSync(fd);
    },
  };

  const result = await appendJournalLine(target, '{"w":1}', { fs: fsOverride });

  assert.equal(result.status, "write_failed");
  assert.match(result.message, /EIO/);
  assert.equal(fsyncs, 0);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n');
  assert.equal(fs.existsSync(target.lock), false);
});

test("a failing fsync reports fsync_failed with the record already written", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const fsOverride = {
    fsyncSync() {
      throw errnoError("EIO");
    },
  };

  const result = await appendJournalLine(target, '{"f":1}', { fs: fsOverride });

  assert.equal(result.status, "fsync_failed");
  assert.equal(result.bytes, Buffer.byteLength('{"f":1}\n'));
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"f":1}\n');
  assert.equal(fs.existsSync(target.lock), false);
});

test("a failing close after a complete write surfaces close_failed and keeps appended status", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const appendFds = new Set();
  const fsOverride = {
    openSync(file, flags) {
      const fd = fs.openSync(file, flags);
      if (flags === "a") appendFds.add(fd);
      return fd;
    },
    closeSync(fd) {
      const wasAppend = appendFds.delete(fd);
      fs.closeSync(fd);
      if (wasAppend) throw errnoError("EIO");
    },
  };

  const result = await appendJournalLine(target, '{"c":1}', { fs: fsOverride });

  assert.equal(result.status, "appended");
  assert.deepEqual(result.warnings.map((w) => w.code), ["close_failed"]);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"c":1}\n');
});

test("write, fsync and close happen in order while the lock file is held", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const events = [];
  const appendFds = new Set();
  const fsOverride = {
    openSync(file, flags) {
      const fd = fs.openSync(file, flags);
      if (flags === "a") {
        appendFds.add(fd);
        events.push("open-append");
      }
      return fd;
    },
    writeSync(fd, data) {
      if (isRecordChunk(data, '"o":1')) events.push(`write(lock-held=${fs.existsSync(target.lock)})`);
      return fs.writeSync(fd, data);
    },
    fsyncSync(fd) {
      events.push("fsync");
      fs.fsyncSync(fd);
    },
    closeSync(fd) {
      if (appendFds.delete(fd)) events.push("close");
      fs.closeSync(fd);
    },
  };

  const result = await appendJournalLine(target, '{"o":1}', { fs: fsOverride });

  assert.equal(result.status, "appended");
  assert.deepEqual(events, ["open-append", "write(lock-held=true)", "fsync", "close"]);
});

test("a failing tail inspection writes nothing and releases the lock", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  fs.writeFileSync(target.file, '{"a":1}\n');
  let writes = 0;
  const fsOverride = {
    readSync() {
      throw errnoError("EIO");
    },
    writeSync(fd, data) {
      if (isRecordChunk(data, '"t":1')) writes++;
      return fs.writeSync(fd, data);
    },
  };

  const result = await appendJournalLine(target, '{"t":1}', { fs: fsOverride });

  assert.equal(result.status, "tail_check_failed");
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"a":1}\n');
  assert.equal(fs.existsSync(target.lock), false);
});

test("a busy lock makes appendJournalLine return lock_busy and write nothing", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "analysis");
  fs.writeFileSync(target.file, '{"a":1}\n');
  writeForeignLock(target.lock);
  const before = fs.readFileSync(target.file, "utf8");
  const { sleep } = recordingSleep();

  const result = await appendJournalLine(target, '{"b":2}', { sleep });

  assert.equal(result.status, "lock_busy");
  assert.equal(result.code, "analysis_lock_busy");
  assert.match(result.message, /Nothing was written/);
  assert.equal(fs.readFileSync(target.file, "utf8"), before);
  assert.equal(fs.readFileSync(target.lock, "utf8"), JSON.stringify(FOREIGN));
});

test("a release failure after a successful append is surfaced as a warning", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const fsOverride = {
    unlinkSync() {
      throw errnoError("EPERM");
    },
  };

  const result = await appendJournalLine(target, '{"u":1}', { fs: fsOverride });

  assert.equal(result.status, "appended");
  assert.deepEqual(result.warnings.map((w) => w.code), ["lock_release_failed"]);
  assert.equal(fs.readFileSync(target.file, "utf8"), '{"u":1}\n');
  fs.unlinkSync(target.lock);
});

test("concurrent appends in one process each land as one intact line", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const jobs = [];
  for (let i = 0; i < 25; i++) jobs.push(appendJournalLine(target, JSON.stringify({ v: 1, i }), {}));

  const results = await Promise.all(jobs);

  assert.deepEqual([...new Set(results.map((r) => r.status))], ["appended"]);
  const lines = fs.readFileSync(target.file, "utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 25);
  const seen = new Set(lines.map((line) => JSON.parse(line).i));
  assert.equal(seen.size, 25);
  assert.equal(fs.existsSync(target.lock), false);
});

test("separate processes appending to one journal never interleave or lose records", async (t) => {
  const autoDir = makeAutoDir(t);
  const target = journalTarget(autoDir, "observations");
  const script = [
    'const m = await import(process.env.JOURNAL_MODULE);',
    'const t = m.journalTarget(process.env.AUTO_DIR, "observations");',
    "for (let i = 0; i < 15; i++) {",
    "  const r = await m.appendJournalLine(t, JSON.stringify({ v: 1, tag: process.env.TAG, i }));",
    '  if (r.status !== "appended") { console.error(JSON.stringify(r)); process.exit(2); }',
    "}",
  ].join("\n");

  const children = ["p0", "p1", "p2"].map((tag) =>
    execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      {
        timeout: 120000,
        env: { ...process.env, JOURNAL_MODULE: MODULE_URL, AUTO_DIR: autoDir, TAG: tag },
      },
    ),
  );
  await Promise.all(children);

  const lines = fs.readFileSync(target.file, "utf8").split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, 45);
  const keys = new Set(lines.map((line) => {
    const record = JSON.parse(line);
    return `${record.tag}:${record.i}`;
  }));
  assert.equal(keys.size, 45);
  assert.equal(fs.existsSync(target.lock), false);
});
