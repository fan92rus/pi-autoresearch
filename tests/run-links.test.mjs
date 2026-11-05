/**
 * Run-links identity core for research-map (design.md §5.1–5.2a; tests T39, T129–T132,
 * T139–T142 and the §5.2 pending lifecycle / fail-closed classification rules).
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/run-links.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendRunLinkRecord,
  beginRunIdentity,
  classifyAllRunLinks,
  classifyRunLink,
  consumeRunIdentity,
  createExecutionId,
  EXECUTION_ID_RE,
  isValidConfirmedLink,
  isValidExecutionId,
  loadRunLinksState,
  parseRunLinkRecord,
  recordPendingMarker,
  resetRunIdentities,
  RUN_LINK_STATES,
  RUN_EPOCH_BASES,
  runLinkOf,
  serializeRunLinkRecord,
  sha256Line,
  emptyRunLinksRuntime,
} from "../extensions/pi-autoresearch/run-links.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG_LINE = JSON.stringify({ type: "config", name: "t", metricName: "metric", metricUnit: "", bestDirection: "lower" });
const STARTED_AT = "2026-11-05T10:12:41.007Z";
const STARTED_AT_2 = "2026-11-05T11:00:00.000Z";
const EXEC_A = "a".repeat(32);
const EXEC_B = "b".repeat(32);

function startLine(run, startedAt = STARTED_AT, command = "bench") {
  return JSON.stringify({ type: "run_started", run_dir: run, node_id: "n1", command, started_at: startedAt });
}

function resultLine(run, startedAt = STARTED_AT, exitCode = 0, duration = 37.2) {
  return JSON.stringify({
    type: "run_result",
    run_dir: run,
    started_at: startedAt,
    node_id: "n1",
    exit_code: exitCode,
    killed: false,
    duration_seconds: duration,
  });
}

function ordinaryRow(run, metric = 0.5, epoch = 1) {
  return JSON.stringify({ run, commit: "abc1234", metric, metrics: { metric }, status: "keep", description: "d", timestamp: 1, segment: 0, epoch, confidence: null });
}

function scaleLine(epoch = 2) {
  return JSON.stringify({ type: "measurement_change", change_ref: `e${epoch}`, epoch, needs_verification: true, justification: "rescore" });
}

/** Ledger with one settled run 1. */
function baseLedger() {
  return [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), ""].join("\n");
}

function makeProject(t, { ledger = baseLedger(), runs = [1], sidecar = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  if (ledger !== null) fs.writeFileSync(path.join(autoDir, "log.jsonl"), ledger);
  for (const run of runs) fs.mkdirSync(path.join(autoDir, "runs", String(run)), { recursive: true });
  if (sidecar !== null) fs.writeFileSync(path.join(autoDir, "run-links.jsonl"), sidecar);
  return {
    root,
    autoDir,
    log: path.join(autoDir, "log.jsonl"),
    sidecar: path.join(autoDir, "run-links.jsonl"),
    sidecarLockPath: path.join(autoDir, "run-links.lock"),
  };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Build a valid confirmed link + sidecar record for the (single) run in a ledger text. */
function confirmedLinkFor(ledgerText, run, executionId = EXEC_A) {
  const lines = ledgerText.split("\n").filter((l) => l.trim() !== "");
  const started = lines.find((l) => l.includes('"run_started"') && l.includes(`"run_dir":${run}`));
  const result = lines.find((l) => l.includes('"run_result"') && l.includes(`"run_dir":${run}`));
  const ordinary = lines.find((l) => l.includes(`"run":${run},`) && !l.includes("run_dir"));
  assert.ok(started && result && ordinary, "fixture ledger must contain all three lines");
  return {
    executionId,
    run,
    startedSha256: sha256Line(started),
    resultSha256: sha256Line(result),
    logSha256: sha256Line(ordinary),
    analysisPrefixBytes: null,
    analysisPrefixSha256: null,
  };
}

async function writeLink(project, ledgerText, run, executionId = EXEC_A) {
  const link = confirmedLinkFor(ledgerText, run, executionId);
  const appended = await appendRunLinkRecord(project.autoDir, link);
  assert.equal(appended.status, "appended");
  return link;
}

// ---------------------------------------------------------------------------
// execution_id and hashing primitives
// ---------------------------------------------------------------------------

test("createExecutionId returns 32 lowercase hex from 16 random bytes", () => {
  const fixed = Buffer.alloc(16, 0xcd);
  assert.equal(createExecutionId(() => fixed), "cd".repeat(16));
  const real = createExecutionId();
  assert.match(real, EXECUTION_ID_RE);
  assert.notEqual(real, createExecutionId());
  assert.equal(isValidExecutionId(real), true);
  assert.equal(isValidExecutionId("A".repeat(32)), false, "uppercase is invalid");
  assert.equal(isValidExecutionId("ab".repeat(16) + "x"), false);
  assert.equal(isValidExecutionId(null), false);
});

test("sha256Line hashes exact UTF-8 bytes without the trailing LF", () => {
  assert.equal(sha256Line("x"), createHash("sha256").update("x", "utf8").digest("hex"));
  assert.notEqual(sha256Line("x"), createHash("sha256").update("x\n", "utf8").digest("hex"));
  // Cyrillic exercises the UTF-8 byte path.
  assert.equal(sha256Line("ы"), createHash("sha256").update(Buffer.from("ы", "utf8")).digest("hex"));
});

test("state enums match design §5.2 and §5.2a", () => {
  assert.deepEqual([...RUN_LINK_STATES], ["proven", "absent", "ambiguous"]);
  assert.deepEqual([...RUN_EPOCH_BASES], [
    "proven",
    "not_linked",
    "no_marker",
    "unverified_binding",
    "scale_changed_in_window",
    "scale_changed_after_run",
    "epoch_conflict",
    "ledger_torn_tail",
  ]);
});

// ---------------------------------------------------------------------------
// Sidecar record shape (§5.2 format)
// ---------------------------------------------------------------------------

test("parseRunLinkRecord accepts exactly the §5.2 shape and rejects anything else", () => {
  const valid = JSON.parse(serializeRunLinkRecord({
    executionId: EXEC_A,
    run: 3,
    startedSha256: "1".repeat(64),
    resultSha256: "2".repeat(64),
    logSha256: "3".repeat(64),
    analysisPrefixBytes: null,
    analysisPrefixSha256: null,
  }));
  assert.equal(parseRunLinkRecord(valid) !== null, true);
  assert.deepEqual(parseRunLinkRecord(valid), {
    v: 1,
    execution_id: EXEC_A,
    run_dir: 3,
    started_sha256: "1".repeat(64),
    result_sha256: "2".repeat(64),
    log_sha256: "3".repeat(64),
    analysis_prefix_bytes: null,
    analysis_prefix_sha256: null,
  });

  const prefixPair = { ...valid, analysis_prefix_bytes: 128, analysis_prefix_sha256: "4".repeat(64) };
  assert.equal(parseRunLinkRecord(prefixPair) !== null, true);
  // Extra field, missing field, bad v, bad id, bad run_dir, bad hash, half prefix, negative prefix.
  assert.equal(parseRunLinkRecord({ ...valid, extra: 1 }), null);
  assert.equal(parseRunLinkRecord({ v: 1, execution_id: EXEC_A }), null);
  assert.equal(parseRunLinkRecord({ ...valid, v: 2 }), null);
  assert.equal(parseRunLinkRecord({ ...valid, execution_id: "zz" }), null);
  assert.equal(parseRunLinkRecord({ ...valid, run_dir: 0 }), null);
  assert.equal(parseRunLinkRecord({ ...valid, run_dir: 1.5 }), null);
  assert.equal(parseRunLinkRecord({ ...valid, log_sha256: "3".repeat(63) }), null);
  assert.equal(parseRunLinkRecord({ ...valid, analysis_prefix_bytes: 8 }), null);
  assert.equal(parseRunLinkRecord({ ...valid, analysis_prefix_bytes: -1, analysis_prefix_sha256: "4".repeat(64) }), null);
});

test("isValidConfirmedLink gates the append path", () => {
  const good = {
    executionId: EXEC_A,
    run: 1,
    startedSha256: "1".repeat(64),
    resultSha256: "2".repeat(64),
    logSha256: "3".repeat(64),
    analysisPrefixBytes: null,
    analysisPrefixSha256: null,
  };
  assert.equal(isValidConfirmedLink(good), true);
  assert.equal(isValidConfirmedLink({ ...good, executionId: "nope" }), false);
  assert.equal(isValidConfirmedLink({ ...good, run: 2 ** 53 }), false);
  assert.equal(isValidConfirmedLink(null), false);
  // B1: an unpaired prefix (bytes without sha256) must be rejected exactly like
  // parseRunLinkRecord rejects the half prefix on the reader side.
  assert.equal(isValidConfirmedLink({ ...good, analysisPrefixBytes: 12, analysisPrefixSha256: null }), false);
  assert.equal(isValidConfirmedLink({ ...good, analysisPrefixBytes: null, analysisPrefixSha256: "4".repeat(64) }), false);
});

test("appendRunLinkRecord refuses an unpaired analysis prefix (invalid_line, no sidecar file)", async (t) => {
  const project = makeProject(t);
  const bad = { ...confirmedLinkFor(baseLedger(), 1), analysisPrefixBytes: 12, analysisPrefixSha256: null };

  const result = await appendRunLinkRecord(project.autoDir, bad);

  assert.equal(result.status, "invalid_line");
  assert.equal(fs.existsSync(project.sidecar), false);
});

// ---------------------------------------------------------------------------
// Pending identity lifecycle (§5.2)
// ---------------------------------------------------------------------------

function seededPending(runtime, { run = 1, id = EXEC_A } = {}) {
  const begun = beginRunIdentity(runtime, { executionId: id, run });
  const withStart = recordPendingMarker(begun, "started", id, startLine(run));
  return recordPendingMarker(withStart, "result", id, resultLine(run));
}

test("beginRunIdentity validates its input", () => {
  assert.throws(() => beginRunIdentity(emptyRunLinksRuntime(), { executionId: "short", run: 1 }), RangeError);
  assert.throws(() => beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 0 }), RangeError);
  assert.throws(
    () => beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 1, analysisPrefixBytes: 5 }),
    RangeError,
  );
});

test("a failed started record stays sticky across a successful re-record → consume yields incomplete (M1)", () => {
  const begun = beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 5 });
  const startFailed = recordPendingMarker(begun, "started", EXEC_A, null);

  // A later successful re-record of the same marker must not heal the failure:
  // recorded stays false (sticky), so the identity can never become consumable.
  const healed = recordPendingMarker(startFailed, "started", EXEC_A, startLine(5));
  assert.equal(healed.pending.startedRecorded, false, "a successful re-record must not clear a failed marker");
  assert.equal(healed.pending.startedFailed, true);
  assert.equal(healed.pending.startedLine, startLine(5));

  // Even with both lines recorded afterwards, consumption fails as incomplete.
  const healedFull = recordPendingMarker(healed, "result", EXEC_A, resultLine(5));
  const consumed = consumeRunIdentity(healedFull, 5, ordinaryRow(5));
  assert.equal(consumed.link, null);
  assert.equal(consumed.reason, "incomplete");
  assert.equal(consumed.state.pending, null, "the slot is cleared regardless of the outcome");
});

test("consumeRunIdentity yields the confirmed link for a complete unpoisoned pending and clears the slot", () => {
  const begun = beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 4, analysisPrefixBytes: 12, analysisPrefixSha256: "4".repeat(64) });
  const withStart = recordPendingMarker(begun, "started", EXEC_A, startLine(4));
  const withResult = recordPendingMarker(withStart, "result", EXEC_A, resultLine(4));
  const logRow = ordinaryRow(4);

  const consumed = consumeRunIdentity(withResult, 4, logRow);
  assert.equal(consumed.reason, null);
  assert.equal(consumed.state.pending, null);
  assert.deepEqual(consumed.link, {
    executionId: EXEC_A,
    run: 4,
    startedSha256: sha256Line(startLine(4)),
    resultSha256: sha256Line(resultLine(4)),
    logSha256: sha256Line(logRow),
    analysisPrefixBytes: 12,
    analysisPrefixSha256: "4".repeat(64),
  });
});

test("consumeRunIdentity fails closed and always clears the slot", () => {
  // No pending at all.
  assert.deepEqual(consumeRunIdentity(emptyRunLinksRuntime(), 1, "x").reason, "no_pending");

  const full = seededPending(emptyRunLinksRuntime(), { run: 5 });
  // Number mismatch: log_experiment consumed a computed fallback, not the pending run.
  assert.deepEqual(consumeRunIdentity(full, 6, ordinaryRow(6)).reason, "run_mismatch");
  assert.equal(consumeRunIdentity(full, 6, "x").state.pending, null);

  // Incomplete: a marker write failed.
  const begun = beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 5 });
  const startFailed = recordPendingMarker(begun, "started", EXEC_A, null);
  const withResult = recordPendingMarker(startFailed, "result", EXEC_A, resultLine(5));
  assert.deepEqual(consumeRunIdentity(withResult, 5, "x").reason, "incomplete");

  const resultFailed = recordPendingMarker(recordPendingMarker(begun, "started", EXEC_A, startLine(5)), "result", EXEC_A, null);
  assert.deepEqual(consumeRunIdentity(resultFailed, 5, "x").reason, "incomplete");

  // Unknown execution_id: a late completion of an evicted call is ignored.
  const untouched = recordPendingMarker(emptyRunLinksRuntime(), "started", EXEC_B, startLine(1));
  assert.equal(untouched.pending, null);
});

test("an overlapping run_experiment evicts the pending and poisons only the new identity (T140 shape)", () => {
  // A allocated N=5, B allocated N=6 before A was logged: B's begin evicts A.
  const a = beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 5 });
  const b = beginRunIdentity(a, { executionId: EXEC_B, run: 6 });
  assert.notEqual(b.pending, null);
  assert.equal(b.pending.poisoned, true, "overlapping identity starts poisoned");
  assert.equal(b.pending.run, 6);

  // B completes first and is consumed: poisoned → no link, slot cleared.
  const bDone = recordPendingMarker(recordPendingMarker(b, "started", EXEC_B, startLine(6)), "result", EXEC_B, resultLine(6));
  const bConsumed = consumeRunIdentity(bDone, 6, ordinaryRow(6));
  assert.equal(bConsumed.reason, "poisoned");
  assert.equal(bConsumed.link, null);
  assert.equal(bConsumed.state.pending, null);

  // A's late completion: in production the runtime slot was replaced by B and cleared after
  // B was consumed, so recording A's markers against the CURRENT slot is ignored and the
  // late consume finds no pending — A never resurrects and never changes C.
  const aLate = recordPendingMarker(
    recordPendingMarker(bConsumed.state, "started", EXEC_A, startLine(5)),
    "result",
    EXEC_A,
    resultLine(5),
  );
  assert.equal(aLate.pending, null, "a stale marker for an evicted identity cannot resurrect the pending");
  assert.equal(consumeRunIdentity(aLate, 5, ordinaryRow(5)).reason, "no_pending");

  // After both are done and B was consumed, a sequential C gets a fresh unpoisoned identity.
  const c = beginRunIdentity(bConsumed.state, { executionId: "c".repeat(32), run: 7 });
  assert.equal(c.pending.poisoned, false);
  const cDone = recordPendingMarker(recordPendingMarker(c, "started", "c".repeat(32), startLine(7)), "result", "c".repeat(32), resultLine(7));
  const cConsumed = consumeRunIdentity(cDone, 7, ordinaryRow(7));
  assert.equal(cConsumed.reason, null);
  assert.equal(cConsumed.link.executionId, "c".repeat(32));
});

test("resetRunIdentities clears the pending (init_experiment / restart)", () => {
  const full = seededPending(emptyRunLinksRuntime());
  const reset = resetRunIdentities(full);
  assert.equal(reset.pending, null);
  assert.deepEqual(consumeRunIdentity(reset, 1, "x").reason, "no_pending");
});

test("beginRunIdentity without overlap stays unpoisoned and a second sequential run is clean", () => {
  const first = beginRunIdentity(emptyRunLinksRuntime(), { executionId: EXEC_A, run: 1 });
  assert.equal(first.pending.poisoned, false);
  const firstDone = recordPendingMarker(recordPendingMarker(first, "started", EXEC_A, startLine(1)), "result", EXEC_A, resultLine(1));
  const consumed = consumeRunIdentity(firstDone, 1, ordinaryRow(1));
  assert.equal(consumed.reason, null);
  const second = beginRunIdentity(consumed.state, { executionId: EXEC_B, run: 2 });
  assert.equal(second.pending.poisoned, false, "sequential identity is not poisoned");
});

// ---------------------------------------------------------------------------
// Sidecar append (best-effort, journal protocol)
// ---------------------------------------------------------------------------

test("appendRunLinkRecord writes the exact §5.2 line and removes the lock", async (t) => {
  const project = makeProject(t);
  const link = confirmedLinkFor(baseLedger(), 1);

  const result = await appendRunLinkRecord(project.autoDir, link);

  assert.equal(result.status, "appended");
  const lines = fs.readFileSync(project.sidecar, "utf8").split("\n");
  assert.deepEqual(lines, [serializeRunLinkRecord(link), ""]);
  assert.equal(fs.existsSync(project.sidecarLockPath), false);
});

test("appendRunLinkRecord appends after an existing torn tail with a newline guard", async (t) => {
  const project = makeProject(t, { sidecar: '{"v":1,"trunc' });
  const link = confirmedLinkFor(baseLedger(), 1);

  const result = await appendRunLinkRecord(project.autoDir, link);

  assert.equal(result.status, "appended");
  assert.equal(result.newlineGuard, true);
  const lines = fs.readFileSync(project.sidecar, "utf8").split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]), JSON.parse(serializeRunLinkRecord(link)));
  // T141 first half: appending a complete line after a torn tail must not restore trust —
  // the journal stays corrupt and the link stays ambiguous (§5.2: all-or-nothing).
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
  assert.ok(verdict.warnings.includes("run_links_corrupt"));
});

test("appendRunLinkRecord refuses an invalid link without touching the journal", async (t) => {
  const project = makeProject(t);
  const bad = { ...confirmedLinkFor(baseLedger(), 1), executionId: "xyz" };

  const result = await appendRunLinkRecord(project.autoDir, bad);

  assert.equal(result.status, "invalid_line");
  assert.equal(fs.existsSync(project.sidecar), false);
});

// ---------------------------------------------------------------------------
// Ledger + sidecar reading: fail-closed states
// ---------------------------------------------------------------------------

test("loadRunLinksState reports missing/unavailable/corrupt states and never throws", async (t) => {
  const project = makeProject(t, { ledger: null, runs: [] });
  const missing = loadRunLinksState(project.autoDir);
  assert.equal(missing.ledgerState, "missing");
  assert.equal(missing.sidecarState, "missing");
  assert.deepEqual(missing.warnings, ["ledger_missing"]);
  assert.equal(missing.activeEpoch, null);

  const brokenFs = {
    readFileSync(file) {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    },
  };
  const unavailable = loadRunLinksState(project.autoDir, { fs: brokenFs });
  assert.equal(unavailable.ledgerState, "unavailable");
  assert.equal(unavailable.sidecarState, "unavailable");
  assert.deepEqual(unavailable.warnings, ["ledger_unavailable", "run_links_unavailable"]);
});

test("a duplicate execution_id makes the journal corrupt (§5.2)", async (t) => {
  const project = makeProject(t, { ledger: null, runs: [] });
  const record = {
    v: 1,
    execution_id: EXEC_A,
    run_dir: 1,
    started_sha256: "1".repeat(64),
    result_sha256: "2".repeat(64),
    log_sha256: "3".repeat(64),
    analysis_prefix_bytes: null,
    analysis_prefix_sha256: null,
  };
  fs.writeFileSync(project.sidecar, `${JSON.stringify(record)}\n${JSON.stringify({ ...record, run_dir: 2 })}\n`);

  const scan = loadRunLinksState(project.autoDir);
  assert.equal(scan.sidecarState, "corrupt");
  assert.deepEqual(scan.warnings, ["ledger_missing", "run_links_corrupt"]);
});

// ---------------------------------------------------------------------------
// Classification: proven
// ---------------------------------------------------------------------------

test("a complete proven chain classifies proven with epoch proven (rule B)", async (t) => {
  const project = makeProject(t);
  await writeLink(project, baseLedger(), 1);

  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.settled, true);
  assert.equal(verdict.binding, "verified");
  assert.equal(verdict.executionId, EXEC_A);
  assert.equal(verdict.runEpoch, 1);
  assert.equal(verdict.runEpochBasis, "proven");
  assert.deepEqual(verdict.warnings, []);
});

test("proven carries the analysis prefix pair from the sidecar record", async (t) => {
  const project = makeProject(t);
  const link = confirmedLinkFor(baseLedger(), 1);
  const withPrefix = { ...link, analysisPrefixBytes: 256, analysisPrefixSha256: "4".repeat(64) };
  const appended = await appendRunLinkRecord(project.autoDir, withPrefix);
  assert.equal(appended.status, "appended");

  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.analysisPrefixBytes, 256);
  assert.equal(verdict.analysisPrefixSha256, "4".repeat(64));
});

test("T39-style: unique markers + ordinary row + correct link record → proven; broken variants → ambiguous", async (t) => {
  // Positive control.
  const good = makeProject(t, { ledger: baseLedger() });
  await writeLink(good, baseLedger(), 1, EXEC_A);
  assert.equal(runLinkOf(good.autoDir, 1).link, "proven");

  // Same lines, duplicated hash in the record: two ledger lines share the started hash only
  // if the line text repeats — emulate by pointing started hash at the result line.
  const dupHash = makeProject(t, { ledger: baseLedger() });
  const dupLink = confirmedLinkFor(baseLedger(), 1);
  const startedHashMatchesTwoLines = sha256Line(resultLine(1)); // only one line, control stays valid
  const broken = { ...dupLink, startedSha256: startedHashMatchesTwoLines, resultSha256: startedHashMatchesTwoLines };
  await appendRunLinkRecord(dupHash.autoDir, broken);
  assert.equal(runLinkOf(dupHash.autoDir, 1).link, "ambiguous", "result hash no longer matches a run_result line");

  // Conflicting execution_id: two records for the same run.
  const conflict = makeProject(t, { ledger: baseLedger() });
  const link = confirmedLinkFor(baseLedger(), 1);
  await appendRunLinkRecord(conflict.autoDir, link);
  await appendRunLinkRecord(conflict.autoDir, { ...link, executionId: EXEC_B, logSha256: sha256Line(ordinaryRow(1, 0.9)) });
  const conflictVerdict = runLinkOf(conflict.autoDir, 1);
  assert.equal(conflictVerdict.link, "ambiguous");
  assert.ok(conflictVerdict.warnings.includes("run_link_conflict"));

  // Wrong order: record hashes taken from a ledger where result precedes start.
  const reversedLedger = [CONFIG_LINE, resultLine(1), startLine(1), ordinaryRow(1), ""].join("\n");
  const reversed = makeProject(t, { ledger: reversedLedger });
  await writeLink(reversed, reversedLedger, 1);
  const reversedVerdict = runLinkOf(reversed.autoDir, 1);
  assert.equal(reversedVerdict.link, "ambiguous", "start must precede result");
  // The epoch is blocked too (the marker pair is out of order → unsettled).
  assert.equal(reversedVerdict.runEpochBasis, "unverified_binding");
});

test("T39 duplicate-line hash: two byte-identical run_started lines → ambiguous, unverified_binding (probe P8)", async (t) => {
  // The same run_started line text appears twice: the started hash matches TWO complete
  // ledger lines, so the one-hash-one-line proof rule breaks — unlike the dupHash case
  // above, the hashes are correct but the line itself is duplicated.
  const dupLedger = [CONFIG_LINE, startLine(1), startLine(1), resultLine(1), ordinaryRow(1), ""].join("\n");
  const project = makeProject(t, { ledger: dupLedger });
  await appendRunLinkRecord(project.autoDir, confirmedLinkFor(dupLedger, 1));

  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous", "two identical run_started lines cannot prove the link");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "unverified_binding");
});

// ---------------------------------------------------------------------------
// Classification: absent (T129/T130 legacy shape)
// ---------------------------------------------------------------------------

test("a settled run with an ordinary row but no sidecar record is ambiguous, never absent (T129/T130)", async (t) => {
  const project = makeProject(t); // baseLedger has an ordinary row for run 1, no sidecar
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.binding, "verified");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "not_linked");
});

test("absent only for a run without an ordinary row under an undamaged ledger (§5.2)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1] });
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "absent");
  assert.equal(verdict.settled, true);
  assert.equal(verdict.binding, "verified");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "not_linked");
});

test("an empty/missing sidecar with a run that has no row is absent (legacy logs, T130)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(2, STARTED_AT_2), resultLine(2, STARTED_AT_2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [2], sidecar: "" });
  assert.equal(runLinkOf(project.autoDir, 2).link, "absent");
});

// ---------------------------------------------------------------------------
// Classification: torn ledger tail (fail-closed)
// ---------------------------------------------------------------------------

test("a torn line after the last marker makes an existing row ambiguous (T129/T131 damaged lines)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), '{"v":1,"trunc'].join("\n");
  const project = makeProject(t, { ledger });
  await writeLink(project, baseLedger(), 1); // hashes from the intact ledger

  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
  assert.ok(verdict.warnings.includes("ledger_torn_tail"));
});

test("a torn line turns even a run without an ordinary row into ambiguous (absent needs an intact ledger)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), '{"broken"', ""].join("\n");
  const project = makeProject(t, { ledger });
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
  // The torn line after R_N also names the epoch basis (§5.2a).
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "ledger_torn_tail");
});

test("a torn line before the last marker still allows proven when the window is clean (§5.2)", async (t) => {
  // Torn config-ish garbage line early in the file, then the complete run 1 window.
  // §5.2 tornAfter counts only torn lines after the LAST marker, so this is not tornAfter.
  const ledger = [CONFIG_LINE, '{"old":', startLine(1), resultLine(1), ordinaryRow(1), ""].join("\n");
  const project = makeProject(t, { ledger });
  await writeLink(project, ledger, 1);
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "proven");
  assert.deepEqual(verdict.warnings, []);
});

// ---------------------------------------------------------------------------
// Classification: unreadable sidecar (fail-closed to ambiguous)
// ---------------------------------------------------------------------------

test("an unreadable sidecar line makes every run with an ordinary row ambiguous; rowless runs stay absent (T139)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), startLine(2, STARTED_AT_2), resultLine(2, STARTED_AT_2), ""].join("\n");
  const tornSidecar = `${JSON.stringify({
    v: 1,
    execution_id: EXEC_A,
    run_dir: 1,
    started_sha256: sha256Line(startLine(1)),
    result_sha256: sha256Line(resultLine(1)),
    log_sha256: sha256Line(ordinaryRow(1)),
    analysis_prefix_bytes: null,
    analysis_prefix_sha256: null,
  })}\n{"v":1,"exec`;

  const project = makeProject(t, { ledger, runs: [1, 2], sidecar: tornSidecar });
  const scan = loadRunLinksState(project.autoDir);
  assert.equal(scan.sidecarState, "corrupt");
  assert.deepEqual(scan.warnings, ["run_links_corrupt"]);

  const withRow = classifyRunLink(scan, 1);
  assert.equal(withRow.link, "ambiguous");
  const withoutRow = classifyRunLink(scan, 2);
  assert.equal(withoutRow.link, "absent", "no ordinary row under an intact ledger stays absent");
});

test("a sidecar with a wrong-shaped record corrupts the journal and fails closed (T139)", async (t) => {
  const project = makeProject(t, { sidecar: `${JSON.stringify({ v: 1, execution_id: EXEC_A })}\n` });
  const scan = loadRunLinksState(project.autoDir);
  assert.equal(scan.sidecarState, "corrupt");
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
});

test("a sidecar read error (non-ENOENT) is unavailable and ambiguous for existing rows", async (t) => {
  const project = makeProject(t);
  const scan = loadRunLinksState(project.autoDir, {
    fs: {
      readFileSync(file, encoding) {
        if (file.endsWith("run-links.jsonl")) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return fs.readFileSync(file, encoding);
      },
    },
  });
  assert.equal(scan.sidecarState, "unavailable");
  assert.equal(runLinkOf(project.autoDir, 1, {
    fs: {
      readFileSync(file, encoding) {
        if (file.endsWith("run-links.jsonl")) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return fs.readFileSync(file, encoding);
      },
    },
  }).link, "ambiguous");
});

// ---------------------------------------------------------------------------
// Classification: concurrent sessions, fallback numbers (T129)
// ---------------------------------------------------------------------------

test("T129: interleaved sessions — only the run with its own valid link record can be proven", async (t) => {
  // Session A: runs 1 and 3; session B: run 2 (interleaved in one ledger).
  const ledger = [
    CONFIG_LINE,
    startLine(1),
    resultLine(1),
    ordinaryRow(1),
    startLine(2, STARTED_AT_2),
    resultLine(2, STARTED_AT_2),
    ordinaryRow(2, 0.6),
    startLine(3, "2026-11-05T12:00:00.000Z"),
    resultLine(3, "2026-11-05T12:00:00.000Z"),
    ordinaryRow(3, 0.7),
    "",
  ].join("\n");
  const project = makeProject(t, { ledger, runs: [1, 2, 3] });
  // Only run 1 gets a correct sidecar record; run 3's record points at wrong hashes.
  await writeLink(project, ledger, 1, EXEC_A);
  const wrong = { ...confirmedLinkFor(ledger, 3, EXEC_B), logSha256: sha256Line(ordinaryRow(2)) };
  await appendRunLinkRecord(project.autoDir, wrong);

  assert.equal(runLinkOf(project.autoDir, 1).link, "proven");
  assert.equal(runLinkOf(project.autoDir, 2).link, "ambiguous", "no record → ambiguous");
  assert.equal(runLinkOf(project.autoDir, 3).link, "ambiguous", "record does not match the ledger → ambiguous");
});

test("T129: a fallback ordinary row sharing a marker number warns run_number_shared and stays ambiguous", async (t) => {
  // Two ordinary rows with run: 4 (e.g. explore fallback plus a logged row) → ambiguous.
  const ledger = [CONFIG_LINE, startLine(4), resultLine(4), ordinaryRow(4), ordinaryRow(4, 0.9), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [4] });
  const verdict = runLinkOf(project.autoDir, 4);
  assert.equal(verdict.link, "ambiguous");
  assert.ok(verdict.warnings.includes("run_number_shared"));
});

test("an explore row for run 4 before run_result of run 4 → ambiguous + run_number_shared (T39 explore shape)", async (t) => {
  // The explore row appears BETWEEN markers: run_started, explore row, run_result.
  const exploreRow = JSON.stringify({ run: 4, commit: "", metric: 0, status: "explore", description: "probe", timestamp: 2, segment: 0, epoch: 1, confidence: null });
  const ledger = [CONFIG_LINE, startLine(4), exploreRow, resultLine(4), ordinaryRow(4), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [4] });
  const verdict = runLinkOf(project.autoDir, 4);
  assert.equal(verdict.link, "ambiguous");
  assert.ok(verdict.warnings.includes("run_number_shared"));
  assert.equal(verdict.runEpoch, null);
  // The marker pair itself is unique and verified; the shared number is what breaks the link.
  assert.equal(verdict.binding, "verified");
  assert.equal(verdict.runEpochBasis, "not_linked");
});

// ---------------------------------------------------------------------------
// Classification: restart, missing markers, unsettled (T131/T132)
// ---------------------------------------------------------------------------

test("T132: a restarted process (only the log_experiment row survives) → ambiguous, not proven", async (t) => {
  // Markers were absorbed/absent; only the ordinary row exists.
  const ledger = [CONFIG_LINE, ordinaryRow(3), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3] });
  const verdict = runLinkOf(project.autoDir, 3);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.settled, null);
  assert.equal(verdict.runEpochBasis, "no_marker");
});

test("T132: a second run before the first is logged does not inherit identity — markers of run 5 vs row run 6", async (t) => {
  const ledger = [CONFIG_LINE, startLine(5), resultLine(5), startLine(6, STARTED_AT_2), resultLine(6, STARTED_AT_2), ordinaryRow(6, 0.8), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [5, 6] });
  // A sidecar record created for run 6 with correct hashes proves run 6; run 5 (no row) is absent.
  await writeLink(project, ledger, 6);
  assert.equal(runLinkOf(project.autoDir, 6).link, "proven");
  assert.equal(runLinkOf(project.autoDir, 5).link, "absent");
  assert.equal(runLinkOf(project.autoDir, 5).executionId, null, "run 5 must not inherit run 6 identity");
});

test("unsettled run (run_started without run_result) → binding unsettled, no proven epoch", async (t) => {
  const ledger = [CONFIG_LINE, startLine(7), ordinaryRow(7), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [7] });
  const verdict = runLinkOf(project.autoDir, 7);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.settled, false);
  assert.equal(verdict.binding, "unsettled");
  assert.equal(verdict.runEpochBasis, "no_marker");
});

test("dangling last marker does not prevent an explicit earlier run from classifying", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), startLine(2, STARTED_AT_2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1, 2] });
  await writeLink(project, [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), ""].join("\n"), 1);
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "proven");
});

// ---------------------------------------------------------------------------
// §5.2a rule B: run_epoch
// ---------------------------------------------------------------------------

test("T17/T65: scale change after the run → run_epoch null, scale_changed_after_run (rule B default)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(3), resultLine(3), scaleLine(2), ordinaryRow(3, 0.5, 2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3] });
  await writeLink(project, ledger, 3);
  const verdict = runLinkOf(project.autoDir, 3);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "scale_changed_after_run");
});

test("scale change strictly between run_started and run_result also blocks (T66 shape)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(3), scaleLine(2), resultLine(3), ordinaryRow(3, 0.5, 2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3] });
  await writeLink(project, ledger, 3);
  const verdict = runLinkOf(project.autoDir, 3);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.runEpoch, null);
  // Rule B has one code for any family row after position i.
  assert.equal(verdict.runEpochBasis, "scale_changed_after_run");
});

test("any measurement_change* subtype after the run blocks the epoch (all subtypes read)", async (t) => {
  for (const subtype of ["measurement_change_completed", "measurement_change_verified", "measurement_change_reverted"]) {
    const ledger = [CONFIG_LINE, startLine(3), resultLine(3), JSON.stringify({ type: subtype, change_ref: "e2", epoch: 2 }), ordinaryRow(3), ""].join("\n");
    const project = makeProject(t, { ledger, runs: [3] });
    await writeLink(project, ledger, 3);
    const verdict = runLinkOf(project.autoDir, 3);
    assert.equal(verdict.link, "proven", subtype);
    assert.equal(verdict.runEpochBasis, "scale_changed_after_run", subtype);
    assert.equal(verdict.runEpoch, null, subtype);
  }
});

test("the L-row epoch field conflicting with the active scale → epoch_conflict (T67 shape)", async (t) => {
  // Run executed under epoch 1, then a scale change to 2 happened BEFORE the row was logged
  // — but rule B requires no scale row after i, so craft the conflict directly: active
  // scale is 2 via a change BEFORE the run, the row claims epoch 1.
  const ledger = [CONFIG_LINE, scaleLine(2), startLine(3), resultLine(3), ordinaryRow(3, 0.5, 1), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3] });
  await writeLink(project, ledger, 3);
  const verdict = runLinkOf(project.autoDir, 3);
  assert.equal(verdict.link, "proven");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "epoch_conflict");
});

test("T68 control: runs before any scale change with matching epochs stay proven epoch 1", async (t) => {
  const ledger = [CONFIG_LINE, startLine(3), resultLine(3), ordinaryRow(3), startLine(4, STARTED_AT_2), resultLine(4, STARTED_AT_2), ordinaryRow(4), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3, 4] });
  await writeLink(project, ledger, 3, EXEC_A);
  await writeLink(project, ledger, 4, EXEC_B);
  for (const run of [3, 4]) {
    const verdict = runLinkOf(project.autoDir, run);
    assert.equal(verdict.link, "proven");
    assert.equal(verdict.runEpoch, 1);
    assert.equal(verdict.runEpochBasis, "proven");
  }
});

test("a proven link with a torn line after R_N loses the epoch but keeps... ambiguous (fail-closed)", async (t) => {
  // A torn line between the result marker and the ordinary row makes the whole link ambiguous
  // (the proof window start..result is clean, but the log hash line sits after the torn line
  // and any torn line at/after the start poisons the proven link check).
  const ledger = [CONFIG_LINE, startLine(3), resultLine(3), '{"torn"', ordinaryRow(3), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [3] });
  await writeLink(project, [CONFIG_LINE, startLine(3), resultLine(3), ordinaryRow(3), ""].join("\n"), 3);
  const verdict = runLinkOf(project.autoDir, 3);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.runEpoch, null);
});

test("unproven links never produce a run_epoch (not_linked basis)", async (t) => {
  const ledger = [CONFIG_LINE, startLine(2, STARTED_AT_2), resultLine(2, STARTED_AT_2), ordinaryRow(2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [2] });
  const verdict = runLinkOf(project.autoDir, 2);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.runEpoch, null);
  assert.equal(verdict.runEpochBasis, "not_linked");
  assert.equal(verdict.executionId, null);
  assert.equal(verdict.analysisPrefixBytes, null);
});

test("a run_started without run_dir (marker write raced artifacts) blocks the epoch (no_marker)", async (t) => {
  const ledger = [CONFIG_LINE, JSON.stringify({ type: "run_started", node_id: "n1", command: "c", started_at: STARTED_AT }), resultLine(1), ordinaryRow(1), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1] });
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.runEpochBasis, "no_marker");
  assert.equal(verdict.runEpoch, null);
});

// ---------------------------------------------------------------------------
// Ledger missing/unreadable: no healthy defaults as proof (T135 shape)
// ---------------------------------------------------------------------------

test("a missing ledger → ambiguous for any run, warnings include ledger_missing", async (t) => {
  const project = makeProject(t, { ledger: null, runs: [1] });
  const verdict = runLinkOf(project.autoDir, 1);
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.runEpochBasis, "no_marker");
  assert.ok(verdict.warnings.includes("ledger_missing"));
});

test("an unreadable ledger → ambiguous, never a healthy-default epoch (§5.2)", async (t) => {
  const project = makeProject(t);
  const brokenFs = {
    readFileSync(file) {
      if (file.endsWith("log.jsonl")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  const scan = loadRunLinksState(project.autoDir, { fs: brokenFs });
  assert.equal(scan.ledgerState, "unavailable");
  assert.equal(scan.activeEpoch, null);
  const verdict = classifyRunLink(scan, 1);
  assert.equal(verdict.link, "ambiguous");
  assert.ok(verdict.warnings.includes("ledger_unavailable"));
});

// ---------------------------------------------------------------------------
// classifyAllRunLinks + runLinkOf never throwing
// ---------------------------------------------------------------------------

test("classifyAllRunLinks classifies every number in rows, markers and records", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), startLine(2, STARTED_AT_2), resultLine(2, STARTED_AT_2), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1, 2] });
  await writeLink(project, ledger, 1);

  const all = classifyAllRunLinks(loadRunLinksState(project.autoDir));
  assert.equal(all.get(1).link, "proven");
  assert.equal(all.get(2).link, "absent");
  assert.equal(all.size, 2);
});

test("runLinkOf never throws on a hostile filesystem", async (t) => {
  const project = makeProject(t);
  const explode = {
    readFileSync() {
      throw new Error("disk on fire");
    },
  };
  const verdict = runLinkOf(project.autoDir, 1, { fs: explode });
  assert.equal(verdict.link, "ambiguous");
  assert.equal(verdict.runEpoch, null);
});

// ---------------------------------------------------------------------------
// T131: write failures of the three ledger records or the sidecar
// ---------------------------------------------------------------------------

test("T131: a sidecar append failure leaves the main decision untouched — an existing row stays ambiguous", async (t) => {
  const project = makeProject(t);
  const link = confirmedLinkFor(baseLedger(), 1);
  const failed = await appendRunLinkRecord(project.autoDir, link, {
    fs: {
      writeSync(fd, data) {
        if (Buffer.from(data).toString("utf8").includes(EXEC_A)) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return fs.writeSync(fd, data);
      },
    },
  });
  assert.equal(failed.status, "write_failed");
  // The ordinary row exists, the sidecar does not → ambiguous (never proven).
  assert.equal(runLinkOf(project.autoDir, 1).link, "ambiguous");
});

test("T131/T142: a short sidecar write leaves a torn fragment → journal corrupt → ambiguous", async (t) => {
  const project = makeProject(t);
  const link = confirmedLinkFor(baseLedger(), 1);
  const line = serializeRunLinkRecord(link);
  const result = await appendRunLinkRecord(project.autoDir, link, {
    fs: {
      writeSync(fd, data) {
        const text = Buffer.from(data).toString("utf8");
        if (text.includes(EXEC_A)) return fs.writeSync(fd, data.subarray(0, Math.floor(text.length / 2)));
        return fs.writeSync(fd, data);
      },
    },
  });
  assert.equal(result.status, "short_write");
  const scan = loadRunLinksState(project.autoDir);
  assert.equal(scan.sidecarState, "corrupt");
  assert.equal(runLinkOf(project.autoDir, 1).link, "ambiguous", "partial evidence must not prove");
});

test("T142: a zero-byte short write leaves no fragment and the journal stays usable", async (t) => {
  const project = makeProject(t, { ledger: null, runs: [] });
  const record = {
    v: 1,
    execution_id: EXEC_A,
    run_dir: 1,
    started_sha256: "1".repeat(64),
    result_sha256: "2".repeat(64),
    log_sha256: "3".repeat(64),
    analysis_prefix_bytes: null,
    analysis_prefix_sha256: null,
  };
  const link = {
    executionId: EXEC_A,
    run: 1,
    startedSha256: "1".repeat(64),
    resultSha256: "2".repeat(64),
    logSha256: "3".repeat(64),
    analysisPrefixBytes: null,
    analysisPrefixSha256: null,
  };
  const zero = await appendRunLinkRecord(project.autoDir, link, {
    fs: {
      writeSync(fd, data) {
        if (Buffer.from(data).toString("utf8").includes(EXEC_A)) return 0;
        return fs.writeSync(fd, data);
      },
    },
  });
  assert.equal(zero.status, "short_write");
  assert.equal(fs.existsSync(project.sidecar) ? fs.readFileSync(project.sidecar, "utf8") : "", "", "zero bytes → no fragment in the file");
  const good = await appendRunLinkRecord(project.autoDir, link);
  assert.equal(good.status, "appended");
  assert.equal(good.newlineGuard, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(project.sidecar, "utf8").trim()), record);
});

// ---------------------------------------------------------------------------
// T139: archive-and-restart scenario (manual recovery)
// ---------------------------------------------------------------------------

test("T139: a torn sidecar line followed by a valid record → both links ambiguous with a journal warning", async (t) => {
  const ledger = [CONFIG_LINE, startLine(1), resultLine(1), ordinaryRow(1), startLine(2, STARTED_AT_2), resultLine(2, STARTED_AT_2), ordinaryRow(2, 0.6), ""].join("\n");
  const project = makeProject(t, { ledger, runs: [1, 2] });
  await writeLink(project, ledger, 1, EXEC_A);
  const validSecond = confirmedLinkFor(ledger, 2, EXEC_B);
  // Append a valid record, then emulate a torn write of a third one.
  await appendRunLinkRecord(project.autoDir, validSecond);
  fs.appendFileSync(project.sidecar, '{"v":1,"execution_id":"c');

  const scan = loadRunLinksState(project.autoDir);
  assert.equal(scan.sidecarState, "corrupt");
  const one = runLinkOf(project.autoDir, 1);
  const two = runLinkOf(project.autoDir, 2);
  assert.equal(one.link, "ambiguous");
  assert.equal(two.link, "ambiguous");
  assert.ok(one.warnings.includes("run_links_corrupt"));
  assert.ok(two.warnings.includes("run_links_corrupt"));

  // Manual archive: owner moves the damaged file away and starts an empty journal.
  fs.renameSync(project.sidecar, `${project.sidecar}.damaged`);
  fs.writeFileSync(project.sidecar, "");
  const fresh = loadRunLinksState(project.autoDir);
  assert.equal(fresh.sidecarState, "ok");
  assert.equal(runLinkOf(project.autoDir, 2).link, "ambiguous", "old links are not recovered by archiving");
});

test("in-place record editing is out of the trust model: the reader only verifies current bytes (T141 note)", async (t) => {
  const project = makeProject(t);
  await writeLink(project, baseLedger(), 1);
  // Tamper the ledger ordinary row in place: hashes no longer match → ambiguous.
  const lines = fs.readFileSync(project.log, "utf8").split("\n");
  const index = lines.findIndex((l) => l.includes('"run":1,'));
  lines[index] = ordinaryRow(1, 0.99);
  fs.writeFileSync(project.log, lines.join("\n"));
  assert.equal(runLinkOf(project.autoDir, 1).link, "ambiguous");
});

test("an invalid run number input classifies ambiguous without throwing", (t) => {
  const project = makeProject(t, { ledger: null, runs: [] });
  const scan = loadRunLinksState(project.autoDir);
  assert.equal(classifyRunLink(scan, 0).link, "ambiguous");
  assert.equal(classifyRunLink(scan, -1).link, "ambiguous");
  assert.equal(classifyRunLink(scan, 1.5).link, "ambiguous");
  assert.equal(classifyRunLink(scan, 2 ** 53).link, "ambiguous");
});
