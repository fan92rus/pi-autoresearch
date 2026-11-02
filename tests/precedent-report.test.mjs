import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createBudget, resolveSourceRoot } from "../extensions/pi-autoresearch/precedent-sources.ts";
import {
  REPORT_SCHEMA,
  checkPrecedentReportFreshness,
  computeFingerprint,
  evaluateFreshness,
  parseSearchInput,
  registerSearchPrecedentsTool,
  runVersionChild,
  searchPrecedentReport,
  snapshotSourceVersions,
} from "../extensions/pi-autoresearch/precedent-report.ts";

const MAX_OUTPUT_BYTES = 8 * 1024;
const MiB = 1048576;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "precedent-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeRel(root, relPosix, content) {
  const abs = path.join(root, ...relPosix.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function ledgerLine(obj) {
  return JSON.stringify(obj) + "\n";
}

function standardLedger(...records) {
  return [
    ledgerLine({ type: "config", name: "ledger", metricName: "latency", metricUnit: "ms" }),
    ...records.map((r) => ledgerLine(r)),
  ].join("");
}

/** A ledger of exactly `size` bytes: a config line, then one record line whose text is `text` plus padding. */
function ledgerOfSize(size, text = "") {
  const head = ledgerLine({ type: "config", name: "ledger", metricName: "latency", metricUnit: "ms" });
  const record = (description) => ledgerLine({ run: 2, status: "keep", metric: 100, description });
  const padding = size - Buffer.byteLength(head) - Buffer.byteLength(record(`${text} `));
  assert.ok(padding >= 0, `size ${size} is too small for the ledger header and the text`);
  return head + record(`${text} ${"p".repeat(padding)}`);
}

function unrelatedLedger() {
  return standardLedger({ run: 1, status: "keep", metric: 120, description: "ускорение парсера" });
}

function input(problem, extra = {}) {
  const parsed = parseSearchInput({ problem, ...extra });
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  return parsed.input;
}

/** Fake timers: nothing fires until advance() moves the clock past the due time. */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now() {
      return now;
    },
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

/** Fake child that never answers; kill() is recorded. */
class SilentChild extends EventEmitter {
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
}

function captureTool() {
  const tools = [];
  registerSearchPrecedentsTool({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 1);
  return tools[0];
}

const SLOW_SPAWN_MS = 250;
const DEADLINE_SLACK_MS = 200;

/** Blocks the calling thread, standing in for a slow process creation (e.g. a scanner holding the image). */
function blockFor(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Spawn seam: creation takes SLOW_SPAWN_MS, then a real process that never answers (it sleeps until killed). */
function hungSpawn(children) {
  return () => {
    blockFor(SLOW_SPAWN_MS);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    children.push(child);
    return child;
  };
}

/** Spawn seam: a fake version child that answers at once with the real snapshot of `root`. */
function instantVersionSpawn(root) {
  return () => {
    const child = new SilentChild();
    child.stdin.end = () => {
      const snapshot = snapshotSourceVersions(resolveSourceRoot(root));
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "versions", ...snapshot })}
`));
      child.emit("close", 0);
    };
    return child;
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Waits for a real child to exit, at most `ms` (returns at once when it has already exited). */
async function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, ms))]);
}

// ─── Input validation ────────────────────────────────────────────────────────

test("input: valid problem with keywords and finding_ref is accepted, bad input is refused", () => {
  const ok = parseSearchInput({ problem: "  дрейф сенсора  ", keywords: ["термо"], finding_ref: "finding:F-1" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input, { problem: "дрейф сенсора", keywords: ["термо"], finding_ref: "finding:F-1" });

  const refused = [
    [null, "arguments must be an object"],
    [{}, "problem is required"],
    [{ problem: "   " }, "problem must not be empty"],
    [{ problem: "!!! ???" }, "no searchable terms"],
    [{ problem: "x".repeat(501) }, "problem must be at most 500"],
    [{ problem: "дрейф", keywords: "термо" }, "keywords must be an array"],
    [{ problem: "дрейф", keywords: ["a", "b", "c", "d", "e", "f"] }, "keywords: at most 5"],
    [{ problem: "дрейф", keywords: ["   "] }, "must not contain empty strings"],
    [{ problem: "дрейф", finding_ref: "" }, "finding_ref must not be empty"],
    [{ problem: "дрейф", finding_ref: "f".repeat(201) }, "finding_ref must be at most 200"],
    [{ problem: "дрейф", extra: 1 }, "unknown argument: extra"],
  ];
  for (const [raw, message] of refused) {
    const result = parseSearchInput(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.ok(result.error.includes(message), `${result.error} should mention ${message}`);
  }
});

// ─── Report without findings ─────────────────────────────────────────────────

test("report without findings: complete search with no matches, file written under .auto/precedents", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());

  const result = await searchPrecedentReport(root, input("термодрейф сенсора"));
  const { report } = result;

  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.search.outcome, "no-matches");
  assert.equal(report.search.complete, true);
  assert.deepEqual(report.search.candidates, []);
  assert.equal(report.search.output.matchesTotal, 0);
  assert.equal(report.search.memory.status, "unavailable");
  assert.equal(report.persisted.saved, true);
  assert.equal(result.persistError, undefined);

  const logCoverage = report.search.sources.find((s) => s.source === "log");
  assert.equal(logCoverage.status, "searched");
  const treeCoverage = report.search.sources.find((s) => s.source === "tree");
  assert.equal(treeCoverage.status, "unavailable");

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, report.persisted.path), "utf8"));
  assert.equal(onDisk.id, report.id);
  assert.equal(onDisk.fingerprint.value, report.fingerprint.value);
  assert.equal(result.text, JSON.stringify(report));
});

// ─── finding_ref ─────────────────────────────────────────────────────────────

test("finding_ref is stored in the report and does not change the ledger or the source versions", async (t) => {
  const root = makeRoot(t);
  const ledgerPath = path.join(root, ".auto", "log.jsonl");
  writeRel(root, ".auto/log.jsonl", standardLedger({ run: 2, status: "discard", metric: 150, description: "парсер медленный на больших файлах" }));
  const before = fs.readFileSync(ledgerPath);

  const withRef = await searchPrecedentReport(root, input("парсер медленный", { finding_ref: "finding:F-7" }));
  const withoutRef = await searchPrecedentReport(root, input("парсер медленный"));

  assert.equal(withRef.report.query.finding_ref, "finding:F-7");
  assert.equal(withoutRef.report.query.finding_ref, undefined);
  assert.equal(withRef.report.search.outcome, "matches");
  assert.equal(withRef.report.search.candidates.length, 1);
  assert.equal(withRef.report.search.candidates[0].ref.line, 2);

  // The reference is part of the query identity; the sources are unchanged.
  assert.notEqual(withRef.report.fingerprint.query, withoutRef.report.fingerprint.query);
  assert.equal(withRef.report.fingerprint.sources, withoutRef.report.fingerprint.sources);

  const persisted = JSON.parse(fs.readFileSync(path.join(root, withRef.report.persisted.path), "utf8"));
  assert.equal(persisted.query.finding_ref, "finding:F-7");
  assert.deepEqual(fs.readFileSync(ledgerPath), before);
});

// ─── Fingerprint ─────────────────────────────────────────────────────────────

test("fingerprint is stable when the same input is repeated over unchanged sources", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  writeRel(root, ".auto/tree.json", JSON.stringify({ version: 1, nodes: { h1: { id: "h1", status: "keep" } } }));
  writeRel(root, ".auto/ideas/a.md", "# idea\nкэш для парсера\n");

  const first = await searchPrecedentReport(root, input("Дрейф Сенсора", { keywords: ["термо"] }));
  const second = await searchPrecedentReport(root, input("  дрейф   сенсора ", { keywords: ["Термо"] }));

  assert.equal(first.report.fingerprint.value, second.report.fingerprint.value);
  assert.equal(first.report.fingerprint.query, second.report.fingerprint.query);
  assert.equal(first.report.fingerprint.sources, second.report.fingerprint.sources);
  assert.equal(first.report.fingerprint.sources_complete, true);
  assert.equal(first.report.fingerprint.segment, 0);
  assert.notEqual(first.report.id, second.report.id, "each search writes its own report");

  const rootReal = resolveSourceRoot(root);
  const snapA = snapshotSourceVersions(rootReal);
  const snapB = snapshotSourceVersions(rootReal);
  assert.deepEqual(snapA.sources, snapB.sources);
  assert.equal(
    computeFingerprint(input("дрейф сенсора"), snapA).value,
    computeFingerprint(input("дрейф сенсора"), snapB).value,
  );
});

test("fingerprint changes when a source changes; freshness becomes stale and fresh again on a stable root", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  writeRel(root, ".auto/ideas/a.md", "идея один\n");
  const first = await searchPrecedentReport(root, input("дрейф сенсора"));

  const untouched = await checkPrecedentReportFreshness(root, first.report);
  assert.deepEqual(untouched, { freshness: "fresh", reusable: true });

  // A change inside an idea file.
  writeRel(root, ".auto/ideas/a.md", "идея два\n");
  const edited = await checkPrecedentReportFreshness(root, first.report);
  assert.equal(edited.freshness, "stale");
  assert.equal(edited.reusable, false);
  const afterEdit = snapshotSourceVersions(resolveSourceRoot(root));
  assert.notEqual(computeFingerprint(first.report.query, afterEdit).value, first.report.fingerprint.value);

  // A change of the ledger alone also makes the report stale.
  writeRel(root, ".auto/ideas/a.md", "идея один\n");
  fs.appendFileSync(path.join(root, ".auto", "log.jsonl"), ledgerLine({ run: 2, status: "keep", metric: 110 }));
  const ledgerEdit = await checkPrecedentReportFreshness(root, first.report);
  assert.equal(ledgerEdit.freshness, "stale");
});

test("directory listing is part of the source version: adding or removing a file changes the fingerprint", (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  writeRel(root, ".auto/councils/1/entries/x.md", "совет один\n");
  const rootReal = resolveSourceRoot(root);
  const base = snapshotSourceVersions(rootReal);
  const councils = base.sources.find((s) => s.source === "councils");
  assert.equal(councils.state, "hashed");
  assert.equal(councils.files, 1);

  writeRel(root, ".auto/councils/1/entries/y.md", "совет два\n");
  const added = snapshotSourceVersions(rootReal);
  assert.equal(added.sources.find((s) => s.source === "councils").files, 2);
  assert.notEqual(added.sources.find((s) => s.source === "councils").sha256, councils.sha256);
  assert.notEqual(computeFingerprint(input("совет"), added).sources, computeFingerprint(input("совет"), base).sources);

  fs.rmSync(path.join(root, ".auto", "councils", "1", "entries", "y.md"));
  const removed = snapshotSourceVersions(rootReal);
  assert.equal(removed.sources.find((s) => s.source === "councils").sha256, councils.sha256);
});

test("legacy layout: the ledger version names the legacy file", (t) => {
  const root = makeRoot(t);
  writeRel(root, "autoresearch.jsonl", unrelatedLedger());
  const snapshot = snapshotSourceVersions(resolveSourceRoot(root));
  const log = snapshot.sources[0];
  assert.equal(log.source, "log");
  assert.equal(log.path, "autoresearch.jsonl");
  assert.equal(log.ledger, "legacy");
  assert.equal(log.state, "hashed");
  assert.equal(snapshot.segment, 0);
});

test("budget too small for a source: the version is unknown, freshness is unknown, never fresh", (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const snapshot = snapshotSourceVersions(resolveSourceRoot(root), createBudget({ maxBytes: 10, maxItems: 2000 }));
  const log = snapshot.sources[0];
  assert.equal(log.state, "unknown");
  assert.equal(log.reason, "bytes");
  assert.equal(snapshot.segment, null);

  const fingerprint = computeFingerprint(input("дрейф сенсора"), snapshot);
  assert.equal(fingerprint.sources_complete, false);
  assert.equal(evaluateFreshness(fingerprint, fingerprint), "unknown");
});

// ─── Output limit ────────────────────────────────────────────────────────────

test("output stays within 8 KiB and 20 candidates even with many long matches", async (t) => {
  const root = makeRoot(t);
  const long = "дрейф сенсора при нагреве ".repeat(12);
  const records = [];
  for (let run = 1; run <= 300; run++) {
    records.push({ run, status: "discard", metric: run, description: `${long} запуск ${run}` });
  }
  writeRel(root, ".auto/log.jsonl", standardLedger(...records));

  const result = await searchPrecedentReport(root, input("дрейф сенсора при нагреве", { keywords: ["запуск"] }));
  const { report } = result;

  assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES, `report is ${Buffer.byteLength(result.text)} bytes`);
  assert.equal(JSON.parse(result.text).id, report.id);
  assert.equal(report.search.outcome, "matches");
  assert.ok(report.search.candidates.length > 0);
  assert.ok(report.search.candidates.length <= 20);
  assert.equal(report.search.output.matchesTotal, 300);
  assert.equal(report.search.output.truncated, true);
  assert.equal(report.search.output.omitted, 300 - report.search.candidates.length);
});

test("tool output of a maximal problem with keywords stays within 8 KiB", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", standardLedger({ run: 1, status: "keep", description: "слово ".repeat(40) }));
  const tool = captureTool();
  const problem = "слово ".repeat(80).slice(0, 500);
  const keywords = ["a1", "b2", "c3", "d4", "e5"];
  const result = await tool.execute("call-1", { problem, keywords, finding_ref: "f".repeat(200) }, undefined, undefined, { cwd: root });
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= MAX_OUTPUT_BYTES);
  assert.equal(JSON.parse(result.content[0].text).query.finding_ref, "f".repeat(200));
});

// ─── Standalone ──────────────────────────────────────────────────────────────

test("standalone: the tool works without any campaign and reports missing ledger as incomplete", async (t) => {
  const root = makeRoot(t);
  const tool = captureTool();
  assert.equal(tool.name, "search_precedents");
  assert.deepEqual(tool.parameters.required, ["problem"]);
  assert.equal(tool.parameters.additionalProperties, false);

  const result = await tool.execute("call-2", { problem: "дрейф сенсора" }, undefined, undefined, { cwd: root });
  const report = JSON.parse(result.content[0].text);

  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.search.outcome, "incomplete");
  assert.equal(report.search.complete, false);
  assert.equal(report.search.sources.find((s) => s.source === "log").status, "unavailable");
  assert.equal(report.persisted.saved, true);
  assert.equal(result.details.id, report.id);
  assert.equal(result.details.outcome, "incomplete");
  assert.ok(fs.existsSync(path.join(root, report.persisted.path)));
});

test("standalone: invalid arguments return an error and write nothing", async (t) => {
  const root = makeRoot(t);
  const tool = captureTool();
  const result = await tool.execute("call-3", { problem: "!!!" }, undefined, undefined, { cwd: root });
  assert.ok(result.content[0].text.startsWith("❌"));
  assert.equal(fs.existsSync(path.join(root, ".auto")), false);
});

// ─── Version process deadline and failures ───────────────────────────────────

test("version process: deadline kills the child and reports no snapshot", async (t) => {
  const root = makeRoot(t);
  const clock = fakeClock();
  const child = new SilentChild();
  const pending = runVersionChild(root, {
    clock: () => clock.now(),
    deps: {
      spawn: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  });
  clock.advance(9_999);
  assert.equal(child.killCount, 0);
  clock.advance(1);
  const run = await pending;
  assert.equal(run.deadlineHit, true);
  assert.equal(run.snapshot, null);
  assert.equal(child.killCount, 1);
});

test("version process failure: the report keeps every source unknown and never reports freshness", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const result = await searchPrecedentReport(root, input("дрейф сенсора"), {
    versions: {
      deps: {
        spawn: () => {
          throw new Error("spawn is disabled in this test");
        },
      },
    },
  });
  const { report } = result;
  assert.equal(report.fingerprint.sources_complete, false);
  assert.ok(report.versions.every((v) => v.state === "unknown"));
  assert.match(report.versions[0].reason, /spawn is disabled/);
  assert.equal(report.search.outcome, "no-matches");
  const fresh = await checkPrecedentReportFreshness(root, report);
  assert.deepEqual(fresh, { freshness: "unknown", reusable: false });
});

test("hung version child: the operation ends at its 300 ms deadline and the child is killed", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const children = [];
  const started = performance.now();
  const { report } = await searchPrecedentReport(root, input("дрейф сенсора"), {
    deadlineMs: 300,
    versions: { deps: { spawn: hungSpawn(children) } },
  });
  const elapsed = performance.now() - started;

  assert.ok(elapsed <= 300 + DEADLINE_SLACK_MS, `operation took ${elapsed.toFixed(0)} ms, limit ${300 + DEADLINE_SLACK_MS} ms`);
  assert.equal(children.length, 1);
  await waitForExit(children[0], 2000);
  assert.equal(isAlive(children[0].pid), false, "the hung version child is dead");
  assert.ok(report.versions.every((v) => v.state === "unknown" && v.reason === "deadline"));
  assert.equal(report.search.deadline.hit, true);
  assert.equal(report.search.outcome, "incomplete");
  assert.equal(report.search.complete, false);
});

test("hung search child: the operation ends at its 300 ms deadline and the child is killed", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const children = [];
  const started = performance.now();
  const { report } = await searchPrecedentReport(root, input("дрейф сенсора"), {
    deadlineMs: 300,
    versions: { deps: { spawn: instantVersionSpawn(root) } },
    search: { deps: { spawn: hungSpawn(children) } },
  });
  const elapsed = performance.now() - started;

  assert.ok(elapsed <= 300 + DEADLINE_SLACK_MS, `operation took ${elapsed.toFixed(0)} ms, limit ${300 + DEADLINE_SLACK_MS} ms`);
  assert.equal(children.length, 1);
  await waitForExit(children[0], 2000);
  assert.equal(isAlive(children[0].pid), false, "the hung search child is dead");
  assert.equal(report.search.deadline.hit, true);
  assert.equal(report.search.outcome, "incomplete");
  assert.equal(report.search.sources.find((s) => s.source === "log").truncatedBy, "deadline");
});

// ─── Shared budget and deadline of the whole operation ───────────────────────

test("shared budget: versioning and search together read at most 10 MiB (files on the boundary)", async (t) => {
  const root = makeRoot(t);
  // The version pass hashes the 5 MiB ledger and the 4 MiB + 1 byte idea; the search gets the 1 MiB - 1 left.
  writeRel(root, ".auto/log.jsonl", ledgerOfSize(5 * MiB));
  writeRel(root, ".auto/ideas/big.md", "x".repeat(4 * MiB + 1));

  const { report } = await searchPrecedentReport(root, input("дрейф сенсора"));

  assert.equal(report.versions.find((v) => v.source === "log").state, "hashed");
  assert.equal(report.versions.find((v) => v.source === "ideas").state, "hashed");
  assert.equal(report.search.budget.bytesSpent, 10 * MiB, "versioning and search are charged to one budget");
  assert.equal(report.search.sources.find((s) => s.source === "log").status, "truncated");
  assert.equal(report.search.sources.find((s) => s.source === "log").truncatedBy, "bytes");
  assert.equal(report.search.outcome, "incomplete");
});

test("shared budget: versioning and search together visit at most 2000 items", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  // Version: the ledger (1) + the ideas directory (1) + 1000 entries = 1002 items.
  // The search gets 998 items: the ledger (1), then 997 of the 1000 entries.
  for (let i = 0; i < 1000; i++) writeRel(root, `.auto/ideas/n${i}.md`, "идея\n");

  const { report } = await searchPrecedentReport(root, input("дрейф сенсора"));

  assert.equal(report.search.budget.itemsSpent, 2000);
  assert.equal(report.search.sources.find((s) => s.source === "ideas").status, "truncated");
  assert.equal(report.search.sources.find((s) => s.source === "ideas").truncatedBy, "items");
  assert.equal(report.search.outcome, "incomplete");
});

test("shared deadline: a slow versioning pass leaves only the rest of the 10 s to the search", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const clock = fakeClock();

  // The version child answers only after 9 s of fake time.
  const versionChild = new SilentChild();
  versionChild.stdin.end = () => {
    clock.setTimer(() => {
      const snapshot = snapshotSourceVersions(resolveSourceRoot(root));
      versionChild.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "versions", ...snapshot })}\n`));
      versionChild.emit("close", 0);
    }, 9_000);
  };
  // The search child never answers: it can only end at its deadline.
  const searchChild = new SilentChild();
  let searchTimerMs = null;
  const pending = searchPrecedentReport(root, input("дрейф сенсора"), {
    clock: () => clock.now(),
    versions: {
      deps: { spawn: () => versionChild, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    },
    search: {
      deps: {
        spawn: () => searchChild,
        setTimer: (callback, ms) => {
          searchTimerMs = ms;
          return clock.setTimer(callback, ms);
        },
        clearTimer: clock.clearTimer,
      },
    },
  });

  clock.advance(9_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(searchTimerMs, 1_000, "the search deadline is what is left of the 10 s");
  assert.equal(searchChild.killCount, 0);

  clock.advance(1_000);
  const { report } = await pending;

  assert.equal(searchChild.killCount, 1);
  assert.equal(clock.now(), 10_000, "the whole operation ends at the 10 s deadline");
  assert.equal(report.search.deadline.ms, 10_000);
  assert.equal(report.search.deadline.hit, true);
  assert.equal(report.search.sources.find((s) => s.source === "log").truncatedBy, "deadline");
  assert.equal(report.search.outcome, "incomplete");
  assert.equal(report.versions.find((v) => v.source === "log").state, "hashed");
});

test("shared deadline: spawn time of a slow version child is charged to the 10 s (fake clock)", async (t) => {
  const root = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", unrelatedLedger());
  const clock = fakeClock();
  const versionChild = new SilentChild();
  const searchChild = new SilentChild();
  const pending = searchPrecedentReport(root, input("дрейф сенсора"), {
    clock: () => clock.now(),
    versions: {
      deps: {
        // Creating the version child takes 9 s; the version pass never answers.
        spawn: () => {
          clock.advance(9_000);
          return versionChild;
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    },
    search: {
      deps: { spawn: () => searchChild, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    },
  });

  clock.advance(999);
  assert.equal(versionChild.killCount, 0);
  clock.advance(1);
  assert.equal(versionChild.killCount, 1, "the version child is killed at the 10 s deadline, not 10 s after its spawn");
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(0);
  const { report } = await pending;

  assert.equal(clock.now(), 10_000, "the whole operation ends at the 10 s deadline");
  assert.equal(report.search.deadline.hit, true);
  assert.equal(report.search.outcome, "incomplete");
  assert.ok(report.versions.every((v) => v.state === "unknown" && v.reason === "deadline"));
});

test("shared budget exhausted: the search is incomplete, not a success, and freshness stays unknown", async (t) => {
  const root = makeRoot(t);
  // The 6 MiB ledger holds the match; the 5 MiB idea does not fit the 4 MiB left after the ledger.
  writeRel(root, ".auto/log.jsonl", ledgerOfSize(6 * MiB, "дрейф сенсора"));
  writeRel(root, ".auto/ideas/big.md", "x".repeat(5 * MiB));

  const result = await searchPrecedentReport(root, input("дрейф сенсора"));
  const { report } = result;

  assert.equal(report.versions.find((v) => v.source === "ideas").state, "unknown");
  assert.equal(report.versions.find((v) => v.source === "ideas").reason, "bytes");
  assert.equal(report.fingerprint.sources_complete, false);
  assert.equal(report.search.outcome, "incomplete", "an exhausted budget is never reported as a complete search");
  assert.equal(report.search.complete, false);
  assert.equal(report.search.sources.find((s) => s.source === "log").status, "truncated");
  assert.equal(report.search.sources.find((s) => s.source === "log").truncatedBy, "bytes");
  assert.deepEqual(report.search.candidates, [], "the match behind the budget is not reported");
  assert.ok(report.search.budget.bytesSpent <= 10 * MiB);

  const fresh = await checkPrecedentReportFreshness(root, report);
  assert.deepEqual(fresh, { freshness: "unknown", reusable: false });
  assert.equal(JSON.parse(result.text).search.outcome, "incomplete");
});

// ─── Registration ────────────────────────────────────────────────────────────

test("registration: the tool is registered once with its public name", () => {
  const names = [];
  registerSearchPrecedentsTool({ registerTool: (tool) => names.push(tool.name) });
  assert.deepEqual(names, ["search_precedents"]);
});
