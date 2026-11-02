import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  FOLLOW_UP_MAX_CONTEXT_LINES,
  FOLLOW_UP_MAX_LINKS,
  LedgerTracker,
  candidateIdentity,
  containsIdentifier,
  runFollowUpPass,
} from "../extensions/pi-autoresearch/precedent-context.ts";
import {
  SEARCH_MAX_OUTPUT_BYTES,
  searchLocalSourcesWithFollowUp,
  searchPrecedents,
} from "../extensions/pi-autoresearch/precedent-search.ts";
import { createBudget } from "../extensions/pi-autoresearch/precedent-sources.ts";

const LEDGER_REL = ".auto/log.jsonl";
const PROBLEM = "кэш ошибка";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRoot(t, prefix = "precedent-context-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, rootReal: fs.realpathSync(root) };
}

function writeRel(root, relPosix, content) {
  const abs = path.join(root, ...relPosix.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function lines(...objs) {
  return objs.map((obj) => JSON.stringify(obj) + "\n").join("");
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function outputBytes(report) {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function candidateAt(snap, line) {
  const found = snap.candidates.find((c) => c.ref.line === line);
  assert.ok(found, `candidate at line ${line} exists`);
  return found;
}

/** Fake timers: nothing fires until advance() moves the clock past the due time. */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimer(callback, ms) {
      const timer = { at: now + ms, ms, callback, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => !t.cleared && !t.fired && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.fired = true;
        due.callback();
      }
      now = target;
    },
  };
}

/** Fake child process: stdout is driven by the test; kill() is recorded. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.killCount = 0;
    this.stdin = { end: () => {}, on: () => {} };
  }

  kill() {
    this.killCount++;
    return true;
  }

  emitLine(obj) {
    this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
  }
}

function fakeDeps(clock, child) {
  return {
    spawn: () => child,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
}

/** Fake child that answers with the given snapshot as soon as its input is closed, then exits 0. */
function instantChild(snapshot) {
  const child = new FakeChild();
  child.stdin.end = () => {
    queueMicrotask(() => {
      child.emitLine({ type: "snapshot", ...snapshot });
      child.emit("close", 0);
    });
  };
  return child;
}

const FIRST_PASS_SOURCES = ["log", "tree", "ideas", "councils"].map((source) => ({
  source,
  status: "searched",
  bytes: 0,
  items: 0,
  records: 0,
}));

// ─── Ledger position and identity ────────────────────────────────────────────

test("the segment starts at a second config header only after a run; scale follows the header in effect", () => {
  const tracker = new LedgerTracker();
  assert.deepEqual(tracker.observe({ type: "note" }), { segment: 0, scale: null });
  assert.deepEqual(tracker.observe({ type: "config", metricName: "time", metricUnit: "s" }), {
    segment: 0,
    scale: { name: "time", unit: "s" },
  });
  assert.deepEqual(tracker.observe({ type: "config", metricName: "time", metricUnit: "s" }).segment, 0,
    "a header without a preceding run does not start a segment");
  assert.equal(tracker.observe({ run: 1 }).segment, 0);
  const second = tracker.observe({ type: "config", metricName: "size", metricUnit: "bytes" });
  assert.equal(second.segment, 1);
  assert.deepEqual(second.scale, { name: "size", unit: "bytes" });
  assert.deepEqual(tracker.observe({ run: 2 }), { segment: 1, scale: { name: "size", unit: "bytes" } });
});

test("identifier keys: run with segment, commit, tree node id, literal document path; none without identifiers", () => {
  const runRef = { source: "log", path: LEDGER_REL, line: 4 };
  assert.deepEqual(candidateIdentity(runRef, { run: 3, commit: "ABC1234" }, { segment: 2, scale: null }), {
    keys: ["commit:abc1234", "run:2/3"],
    scale: null,
  });
  const nodeRef = { source: "tree", path: ".auto/tree.json", pointer: "/nodes/n7" };
  assert.deepEqual(candidateIdentity(nodeRef, { commit: null }, null), { keys: ["node:n7"], scale: null });
  const ideaRef = { source: "ideas", path: ".auto/ideas/x.md" };
  assert.deepEqual(candidateIdentity(ideaRef, "text", null), { keys: ["doc:.auto/ideas/x.md"], scale: null });
  const noteRef = { source: "log", path: LEDGER_REL, line: 1 };
  assert.deepEqual(candidateIdentity(noteRef, { type: "note" }, { segment: 0, scale: null }), { keys: [], scale: null });
});

test("literal identifiers respect word boundaries", () => {
  assert.equal(containsIdentifier("разбор n1 позже", "n1"), true);
  assert.equal(containsIdentifier("проверка n10", "n1"), false);
  assert.equal(containsIdentifier("xn1 и n1x", "n1"), false);
  assert.equal(containsIdentifier("итог n1.", "n1"), true, "a sentence period ends the identifier");
  assert.equal(containsIdentifier("см. .auto/ideas/x.md.bak", ".auto/ideas/x.md"), false, "a continued file name is not a reference");
  assert.equal(containsIdentifier("см. .auto/ideas/x.md", ".auto/ideas/x.md"), true);
});

// ─── Second pass: late correction, missing identifiers ───────────────────────

test("a late correction without an identifier next to a record with one is found by the second pass", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    LEDGER_REL,
    lines(
      { type: "config", name: "s", metricName: "time", metricUnit: "s" },
      { run: 1, commit: "aaaaaaa", status: "keep", metric: 10, description: "кэш ошибка ускорил" },
      { type: "note", text: "нейтрально" },
      { run: 2, commit: "bbbbbbb", status: "discard", metric: 12, description: "откат aaaaaaa: регресс" },
      { type: "correction", text: "поправка: предыдущий keep оказался ложным" },
    ),
  );
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);

  // The first pass finds only the keep: the correction and the later run share no query term.
  assert.deepEqual(snap.candidates.map((c) => c.ref.line), [2]);
  const fu = candidateAt(snap, 2).follow_up;
  assert.equal(fu.coverage, "searched");
  assert.deepEqual(fu.identifiers, ["commit:aaaaaaa", "run:0/1"]);
  assert.equal(fu.ordering, "ledger-line");
  assert.equal(fu.matches, 1);
  assert.equal(fu.links[0].ref.line, 4);
  assert.deepEqual(fu.links[0].keys, ["commit:aaaaaaa"]);
  assert.equal(fu.links[0].status, "discard");
  assert.equal(fu.links[0].metric, 12);
  assert.equal(fu.links[0].scale_relation, "same");
  assert.deepEqual(fu.context_lines, [1, 2, 3, 5], "the correction without identifier is context of the later run");
  assert.equal(fu.classification, "unknown", "identifier match is never a conclusion");
  assert.equal(snap.followUp.status, "searched");
});

test("a candidate without identifiers is reported not-run with a reason and no matches", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, LEDGER_REL, lines({ type: "note", text: "кэш ошибка без идентификаторов" }, { type: "note", text: "commit aaaaaaa" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 1).follow_up;
  assert.equal(fu.coverage, "not-run");
  assert.equal(fu.reason, "no-identifiers");
  assert.deepEqual(fu.identifiers, []);
  assert.equal(fu.matches, 0);
  assert.deepEqual(fu.links, []);
  assert.equal(snap.followUp.status, "not-run");
  assert.equal(snap.followUp.candidatesWithIdentifiers, 0);
});

test("without any first-pass candidate the second pass does not run", async (t) => {
  const { rootReal } = makeRoot(t);
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  assert.equal(snap.followUp.status, "not-run");
  assert.equal(snap.followUp.reason, "no-candidates");
  assert.deepEqual(snap.candidates, []);
});

test("a missing ledger makes the second pass unavailable for candidates that have identifiers", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/x.md", "кэш ошибка в идее\n");
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  assert.equal(snap.followUp.status, "unavailable");
  assert.equal(snap.candidates[0].follow_up.coverage, "unavailable");
  assert.equal(snap.candidates[0].follow_up.matches, 0);
});

// ─── ±10 neighbour window (exact boundaries) ─────────────────────────────────

test("exactly the 10th record before and after a match is included; the 11th is excluded", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const ledger = [{ run: 1, commit: "ccccccc", status: "keep", description: "кэш ошибка" }];
  for (let line = 2; line <= 40; line++) {
    ledger.push(line === 20 ? { type: "note", text: "повтор ccccccc" } : { type: "note", n: line });
  }
  writeRel(root, LEDGER_REL, lines(...ledger));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 1).follow_up;

  assert.equal(fu.matches, 1);
  assert.equal(fu.links[0].ref.line, 20);
  assert.deepEqual(fu.context_lines, [...range(10, 19), ...range(21, 30)]);
  assert.equal(fu.context, 20);
  assert.equal(fu.context_omitted, 0);
  assert.ok(!fu.context_lines.includes(9), "11th record before is excluded");
  assert.ok(!fu.context_lines.includes(31), "11th record after is excluded");
});

test("overlapping windows: each record is reported once and the match itself is never context", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const ledger = [{ run: 1, commit: "ccccccc", status: "keep", description: "кэш ошибка" }];
  for (let line = 2; line <= 40; line++) {
    const hit = line === 20 || line === 25;
    ledger.push(hit ? { type: "note", text: "повтор ccccccc" } : { type: "note", n: line });
  }
  writeRel(root, LEDGER_REL, lines(...ledger));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 1).follow_up;

  assert.deepEqual(fu.links.map((l) => l.ref.line), [20, 25]);
  const expected = range(10, 35).filter((line) => line !== 20 && line !== 25);
  assert.deepEqual(fu.context_lines, expected);
  assert.equal(fu.context, expected.length);
});

test("context references are capped and the omission is counted exactly", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const ledger = [{ run: 1, commit: "ccccccc", status: "keep", description: "кэш ошибка" }];
  // Hits at lines 2, 30, 60 keep the context lists long: 3 windows of up to 20 lines each.
  for (let line = 2; line <= 80; line++) {
    const hit = line === 2 || line === 30 || line === 60;
    ledger.push(hit ? { type: "note", text: "ccccccc" } : { type: "note", n: line });
  }
  writeRel(root, LEDGER_REL, lines(...ledger));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 1).follow_up;

  assert.equal(fu.matches, 3);
  assert.equal(fu.context_lines.length, FOLLOW_UP_MAX_CONTEXT_LINES);
  assert.equal(fu.context_omitted, fu.context - FOLLOW_UP_MAX_CONTEXT_LINES);
  assert.ok(fu.context > FOLLOW_UP_MAX_CONTEXT_LINES);
  assert.deepEqual(fu.context_lines, [...fu.context_lines].sort((a, b) => a - b));
});

// ─── Conflicts, scales, other sources ────────────────────────────────────────

test("several ledger records with one identifier are reported as a conflict with all their refs", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    LEDGER_REL,
    lines(
      { type: "config", metricName: "time", metricUnit: "s" },
      { run: 1, commit: "eeeeeee", status: "keep", description: "кэш ошибка" },
      { run: 1, status: "discard", description: "повторная запись того же прогона" },
      { run: 2, commit: "eeeeeee", status: "discard", description: "тот же коммит" },
    ),
  );
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 2).follow_up;

  assert.deepEqual(
    fu.conflicts.map((c) => [c.identifier, c.records, c.refs.map((r) => r.line)]),
    [
      ["commit:eeeeeee", 2, [2, 4]],
      ["run:0/1", 2, [2, 3]],
    ],
  );
  assert.deepEqual(fu.links.map((l) => l.ref.line), [3, 4], "both later records are matches; the conflict is not resolved");
  assert.equal(fu.classification, "unknown");
});

test("a shared identifier without a conflict has no conflict entry", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, LEDGER_REL, lines({ run: 1, commit: "eeeeeee", description: "кэш ошибка" }, { type: "note", text: "про eeeeeee" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 1).follow_up;
  assert.deepEqual(fu.conflicts, []);
  assert.equal(fu.matches, 1);
});

test("incomparable scales are marked different, comparable ones same; no metric delta is computed", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    LEDGER_REL,
    lines(
      { type: "config", metricName: "time", metricUnit: "s" },
      { run: 1, commit: "1a2b3c4", status: "keep", metric: 10, description: "кэш ошибка" },
      { type: "config", metricName: "size", metricUnit: "bytes" },
      { run: 2, commit: "1a2b3c4", status: "keep", metric: 5000, description: "повтор" },
      { run: 3, commit: "1a2b3c4", status: "discard", metric: 6000, description: "повтор" },
    ),
  );
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = candidateAt(snap, 2).follow_up;

  assert.deepEqual(fu.links.map((l) => l.ref.line), [4, 5]);
  assert.equal(fu.links[0].scale_relation, "different");
  assert.deepEqual(fu.links[0].scale, { name: "size", unit: "bytes" });
  assert.equal(fu.links[1].scale_relation, "different");
  for (const link of fu.links) {
    assert.equal(Object.hasOwn(link, "delta"), false);
  }
});

test("a match in the same scale is marked same", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    LEDGER_REL,
    lines(
      { type: "config", metricName: "time", metricUnit: "s" },
      { run: 1, commit: "1a2b3c4", description: "кэш ошибка" },
      { run: 2, commit: "1a2b3c4", description: "повтор" },
    ),
  );
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  assert.equal(candidateAt(snap, 2).follow_up.links[0].scale_relation, "same");
});

test("a tree node is matched by its id and commit; its scale is unknown, its ordering is unknown", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    ".auto/tree.json",
    JSON.stringify({
      version: 1,
      rootId: "n0",
      activeNodeId: "n1",
      nextId: 2,
      baselineMetric: 1,
      direction: "lower",
      metricName: "time",
      nodes: {
        n0: { id: "n0", commit: null, hypothesis: "baseline" },
        n1: { id: "n1", commit: "hhhhhhh", hypothesis: "кэш ошибка", status: "keep", metric: 3 },
      },
    }),
  );
  writeRel(root, LEDGER_REL, lines({ type: "note", text: "проверка n10" }, { type: "note", text: "разбор n1 позже" }, { run: 5, commit: "hhhhhhh", status: "keep" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const node = snap.candidates.find((c) => c.ref.pointer === "/nodes/n1");
  assert.ok(node, "tree node is a first-pass candidate");
  const fu = node.follow_up;

  assert.deepEqual(fu.identifiers, ["commit:hhhhhhh", "node:n1"]);
  assert.equal(fu.ordering, "unknown");
  assert.deepEqual(fu.links.map((l) => l.ref.line), [2, 3], "n10 is not a match of n1");
  assert.equal(fu.links[0].scale_relation, "unknown");
  assert.deepEqual(fu.context_lines, [1]);
});

test("a document reference in the ledger is matched literally; a continued file name is not", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/x.md", "кэш ошибка в идее\n");
  writeRel(root, LEDGER_REL, lines({ type: "note", text: "см. .auto/ideas/x.md" }, { type: "note", text: "см. .auto/ideas/x.md.bak" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const fu = snap.candidates[0].follow_up;
  assert.equal(snap.candidates[0].ref.source, "ideas");
  assert.deepEqual(fu.identifiers, ["doc:.auto/ideas/x.md"]);
  assert.equal(fu.ordering, "unknown");
  assert.deepEqual(fu.links.map((l) => l.ref.line), [1]);
  assert.deepEqual(fu.conflicts, [], "a document reference is not an identifier conflict");
});

// ─── Budgets, truncation, separate coverage ──────────────────────────────────

test("a truncated first pass and a complete second pass keep their own statuses", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const first = lines({ run: 1, commit: "ddddddd", status: "keep", description: "кэш ошибка" });
  writeRel(root, LEDGER_REL, first + lines({ run: 2, commit: "ddddddd", status: "discard", description: "повтор" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM, {
    budget: createBudget({ maxBytes: byteLength(first) + 10 }),
  });

  assert.equal(snap.sources[0].status, "truncated");
  assert.equal(snap.sources[0].truncatedBy, "bytes");
  assert.deepEqual(snap.candidates.map((c) => c.ref.line), [1]);
  assert.equal(snap.followUp.status, "searched", "the second pass has its own budget");
  assert.equal(candidateAt(snap, 1).follow_up.matches, 1);
});

test("a complete first pass and a truncated second pass: the second pass reports partial coverage", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const first = lines({ run: 1, commit: "ddddddd", status: "keep", description: "кэш ошибка" });
  writeRel(root, LEDGER_REL, first + lines({ run: 2, commit: "ddddddd", status: "discard", description: "повтор" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM, {
    followUpBudget: createBudget({ maxBytes: byteLength(first) + 10 }),
  });

  assert.equal(snap.sources[0].status, "searched");
  assert.equal(snap.followUp.status, "truncated");
  assert.equal(snap.followUp.truncatedBy, "bytes");
  const fu = candidateAt(snap, 1).follow_up;
  assert.equal(fu.coverage, "truncated");
  assert.equal(fu.matches, 0, "the cut line is never parsed as evidence");
});

test("both passes truncated: each reports its own cut", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const first = lines({ run: 1, commit: "ddddddd", status: "keep", description: "кэш ошибка" });
  writeRel(root, LEDGER_REL, first + lines({ run: 2, commit: "ddddddd", status: "discard", description: "повтор" }));
  const budgetBytes = byteLength(first) + 10;
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM, {
    budget: createBudget({ maxBytes: budgetBytes }),
    followUpBudget: createBudget({ maxBytes: budgetBytes }),
  });
  assert.equal(snap.sources[0].status, "truncated");
  assert.equal(snap.followUp.status, "truncated");
  assert.equal(candidateAt(snap, 1).follow_up.coverage, "truncated");
});

test("the second pass stops at its item budget before reading the ledger", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, LEDGER_REL, lines({ run: 1, commit: "ddddddd", description: "кэш ошибка" }, { run: 2, commit: "ddddddd" }));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM, {
    followUpBudget: createBudget({ maxItems: 0 }),
  });
  assert.equal(snap.followUp.status, "truncated");
  assert.equal(snap.followUp.truncatedBy, "items");
  assert.equal(snap.followUp.records, 0);
  assert.equal(candidateAt(snap, 1).follow_up.matches, 0);
});

test("repeated runs over an unchanged ledger give identical snapshots", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const ledger = [{ run: 1, commit: "ccccccc", status: "keep", description: "кэш ошибка" }];
  for (let line = 2; line <= 30; line++) {
    ledger.push(line % 7 === 0 ? { run: line, commit: "ccccccc", status: "discard", description: "повтор" } : { type: "note", n: line });
  }
  writeRel(root, LEDGER_REL, lines(...ledger));
  const first = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const second = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  assert.deepEqual(second, first);
  assert.equal(first.candidates[0].follow_up.matches, 4);
});

test("a deadline before the second pass finishes reports it truncated by the deadline, keeping pass one", async (t) => {
  const { root } = makeRoot(t);
  const clock = fakeClock();
  const child = new FakeChild();
  const pending = searchPrecedents(root, PROBLEM, { deps: fakeDeps(clock, child) });
  child.emitLine({ type: "snapshot", done: false, sources: FIRST_PASS_SOURCES, candidates: [], matchesTotal: 0, bytesSpent: 0, itemsSpent: 0 });
  clock.advance(10000);
  const report = await pending;

  assert.equal(child.killCount, 1);
  assert.equal(report.deadline.hit, true);
  assert.equal(report.sources[0].status, "searched");
  assert.equal(report.followUp.status, "truncated");
  assert.equal(report.followUp.truncatedBy, "deadline");
});

test("a child that exits before the second pass reports the follow-up as error", async (t) => {
  const { root } = makeRoot(t);
  const clock = fakeClock();
  const child = new FakeChild();
  const pending = searchPrecedents(root, PROBLEM, { deps: fakeDeps(clock, child) });
  child.emitLine({ type: "snapshot", done: false, sources: FIRST_PASS_SOURCES, candidates: [], matchesTotal: 0, bytesSpent: 0, itemsSpent: 0 });
  child.emit("close", 1);
  const report = await pending;
  assert.equal(report.followUp.status, "error");
  assert.match(report.followUp.error, /produced no report|exited/);
});

test("the child snapshot carries the follow-up unchanged into the report", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(
    root,
    LEDGER_REL,
    lines(
      { run: 1, commit: "eeeeeee", status: "keep", description: "кэш ошибка" },
      { run: 2, commit: "eeeeeee", status: "discard", description: "повтор" },
    ),
  );
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const roundTripped = JSON.parse(JSON.stringify(snap));
  const report = await searchPrecedents(root, PROBLEM, { deps: fakeDeps(fakeClock(), instantChild(roundTripped)) });

  assert.deepEqual(report.candidates, roundTripped.candidates.slice(0, report.candidates.length));
  assert.deepEqual(report.followUp, roundTripped.followUp);
  assert.ok(outputBytes(report) <= SEARCH_MAX_OUTPUT_BYTES);
});

test("the 8 KiB output limit holds with follow-up links: candidates are dropped, the omission is reported", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const longText = "кэш ошибка ".repeat(12);
  const ledger = [];
  for (let i = 1; i <= 20; i++) ledger.push({ run: i, commit: `c${String(i).padStart(6, "0")}`, status: "keep", description: longText });
  for (let i = 1; i <= 20; i++) {
    for (let k = 0; k < FOLLOW_UP_MAX_LINKS + 1; k++) {
      ledger.push({ type: "note", text: `повтор c${String(i).padStart(6, "0")} ${"x".repeat(180)}` });
    }
  }
  writeRel(root, LEDGER_REL, lines(...ledger));
  const snap = await searchLocalSourcesWithFollowUp(rootReal, PROBLEM);
  const report = await searchPrecedents(root, PROBLEM, { deps: fakeDeps(fakeClock(), instantChild(JSON.parse(JSON.stringify(snap)))) });

  assert.ok(outputBytes(report) <= SEARCH_MAX_OUTPUT_BYTES);
  assert.equal(report.output.truncated, true);
  assert.ok(report.output.omitted > 0);
  assert.equal(report.output.matchesTotal, 20);
  for (const candidate of report.candidates) {
    assert.ok(candidate.follow_up.links.length <= FOLLOW_UP_MAX_LINKS);
  }
});

// ─── Determinism and direct API ──────────────────────────────────────────────

test("runFollowUpPass without inputs or without identifiers performs no read", async () => {
  const none = await runFollowUpPass(null, []);
  assert.equal(none.report.status, "not-run");
  assert.equal(none.report.reason, "no-candidates");

  const noKeys = await runFollowUpPass(null, [{ ref: { source: "log", path: LEDGER_REL, line: 1 }, identity: { keys: [], scale: null } }]);
  assert.equal(noKeys.report.status, "not-run");
  assert.equal(noKeys.report.reason, "no-identifiers");
  assert.equal(noKeys.candidates[0].reason, "no-identifiers");
});
