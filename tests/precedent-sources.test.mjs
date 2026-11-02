import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  LOCAL_PRECEDENT_SOURCES,
  checkPathInRoots,
  compareNatural,
  createBudget,
  guardPathInsideRoot,
  isPathWithinRoot,
  readCouncilSource,
  readIdeasSource,
  readLedgerSource,
  readTreeSource,
  resolveLedgerCandidate,
  resolveSourceRoot,
  toRelativePosix,
} from "../extensions/pi-autoresearch/precedent-sources.ts";

const IS_WINDOWS = process.platform === "win32";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRoot(t, prefix = "precedent-sources-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, rootReal: fs.realpathSync(root) };
}

function makeOutsideDir(t, prefix = "precedent-outside-") {
  // Sibling temp dir: outside the canonical root by construction.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function writeRel(root, relPosix, content) {
  const abs = path.join(root, ...relPosix.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function collector() {
  const records = [];
  const visit = (record) => {
    records.push(record);
    return true;
  };
  return { records, visit };
}

function symlinkDir(target, linkPath) {
  const type = IS_WINDOWS ? "junction" : "dir";
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

function symlinkFile(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    // Windows without developer mode / admin refuses file symlinks.
    return false;
  }
}

function ledgerLine(obj) {
  return JSON.stringify(obj) + "\n";
}

// ─── Ledger selection: current / legacy / mixed / missing ────────────────────

test("ledger prefers .auto/log.jsonl over legacy autoresearch.jsonl", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", ledgerLine({ run: 1, description: "from-current" }));
  writeRel(root, "autoresearch.jsonl", ledgerLine({ run: 1, description: "from-legacy" }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.ledger, "current");
  // Forward slashes even on Windows — source_ref must be stable.
  assert.equal(result.path, ".auto/log.jsonl");
  assert.deepEqual(records.map((r) => r.data.description), ["from-current"]);
  assert.deepEqual(records.map((r) => r.ref.source), ["log"]);
});

test("ledger falls back to legacy autoresearch.jsonl when current is missing", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, "autoresearch.jsonl", ledgerLine({ run: 4, description: "legacy-only" }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.ledger, "legacy");
  assert.equal(result.path, "autoresearch.jsonl");
  assert.equal(records.length, 1);
  assert.equal(records[0].data.description, "legacy-only");
  assert.equal(records[0].ref.line, 1);
});

test("mixed legacy layout (.auto/config.json + legacy ledger) still reads autoresearch.jsonl", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/config.json", '{"metricName":"total_ms"}');
  writeRel(root, "autoresearch.jsonl", ledgerLine({ run: 1, description: "mixed-layout" }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.ledger, "legacy");
  assert.equal(result.status, "searched");
  assert.equal(records[0].data.description, "mixed-layout");
});

test("missing ledger (neither path) reports unavailable", async (t) => {
  const { rootReal } = makeRoot(t);
  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "unavailable");
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

test("missing root and null root report unavailable for every source", async (t) => {
  const { root } = makeRoot(t);
  assert.equal(resolveSourceRoot(path.join(root, "does-not-exist")), null);
  const { visit } = collector();

  for (const read of [readLedgerSource, readTreeSource, readIdeasSource, readCouncilSource]) {
    const result = await read(null, visit);
    assert.equal(result.status, "unavailable", `null root must be unavailable for ${read.name}`);
  }
});

test("resolveLedgerCandidate mirrors buildBrief: current, then legacy, then null", (t) => {
  const { root, rootReal } = makeRoot(t);
  assert.equal(resolveLedgerCandidate(rootReal), null);

  writeRel(root, "autoresearch.jsonl", ledgerLine({ run: 1 }));
  assert.equal(resolveLedgerCandidate(rootReal).kind, "legacy");

  writeRel(root, ".auto/log.jsonl", ledgerLine({ run: 1 }));
  assert.equal(resolveLedgerCandidate(rootReal).kind, "current");
});

// ─── Ledger corruption ───────────────────────────────────────────────────────

test("broken JSONL lines are skipped and counted, good lines keep their line numbers, and the ledger is not searched", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const content = [
    '{"run":1,"description":"good one"}',
    "not-json{",
    "[1,2]",
    "",
    '"just a string"',
    '{"run":2,"description":"good two"}',
    "",
  ].join("\n");
  writeRel(root, ".auto/log.jsonl", content);

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  // Good records are still delivered, but damaged lines make coverage incomplete.
  assert.equal(result.status, "error");
  assert.match(result.error, /3 malformed line\(s\)/);
  assert.equal(result.malformedLines, 3);
  assert.equal(result.records, 2);
  assert.deepEqual(records.map((r) => r.ref.line), [1, 6]);
  assert.deepEqual(records.map((r) => r.data.run), [1, 2]);
});

test("wholly malformed ledger reports error, not a silent empty success", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", "garbage line\nmore garbage\n");

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.equal(result.malformedLines, 2);
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

test("empty ledger is searched with zero records", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", "");

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);
  assert.equal(result.status, "searched");
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

// ─── Streaming and budgets ───────────────────────────────────────────────────

test("byte budget cuts the ledger between complete lines; a partial line is never evidence", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const l1 = ledgerLine({ run: 1, description: "alpha keep" });
  const l2 = ledgerLine({ run: 2, description: "beta discard" });
  const l3 = ledgerLine({ run: 3, description: "gamma keep" });
  writeRel(root, ".auto/log.jsonl", l1 + l2 + l3);

  // Budget ends mid-line 3: line 3 must not be parsed (a wrong implementation
  // would parse the fragment, fail, and report malformedLines: 1).
  const cut = l1.length + l2.length + Math.floor(l3.length / 2);
  const budget = createBudget({ maxBytes: cut, maxItems: 100 });

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit, { budget });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.bytes, cut);
  assert.equal(result.malformedLines, 0);
  assert.deepEqual(records.map((r) => r.ref.line), [1, 2]);
  assert.deepEqual(records.map((r) => r.data.run), [1, 2]);
});

test("exhausted item budget stops the ledger before reading", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", ledgerLine({ run: 1, description: "never read" }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit, { budget: createBudget({ maxItems: 0 }) });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "items");
  assert.equal(result.records, 0);
  assert.equal(result.bytes, 0);
  assert.equal(records.length, 0);
});

test("visitor can stop the ledger stream early", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const content = Array.from({ length: 10 }, (_, i) => ledgerLine({ run: i + 1 })).join("");
  writeRel(root, ".auto/log.jsonl", content);

  let seen = 0;
  const visit = () => {
    seen++;
    return seen < 3; // stop after the third record
  };
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "visitor");
  assert.equal(result.records, 3);
});

test("large ledger streams fully: every line delivered, exact byte count, searched", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const content = Array.from({ length: 500 }, (_, i) => ledgerLine({ run: i + 1, description: `row ${i}` })).join("");
  writeRel(root, ".auto/log.jsonl", content);

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.records, 500);
  assert.equal(result.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(records[499].ref.line, 500);
  assert.equal(records[499].data.run, 500);
});

test("budget is shared across sources: ledger consumes the bytes, tree reports truncated", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const ledgerContent = ledgerLine({ run: 1, description: "consumes the budget" });
  writeRel(root, ".auto/log.jsonl", ledgerContent);
  writeRel(root, ".auto/tree.json", JSON.stringify({ version: 1, nodes: { n1: { id: "n1" } } }));

  const budget = createBudget({ maxBytes: Buffer.byteLength(ledgerContent), maxItems: 1000 });
  const { visit } = collector();

  const ledgerResult = await readLedgerSource(rootReal, visit, { budget });
  assert.equal(ledgerResult.status, "searched");

  const treeResult = await readTreeSource(rootReal, visit, { budget });
  assert.equal(treeResult.status, "truncated");
  assert.equal(treeResult.records, 0);
});

// ─── Tree ────────────────────────────────────────────────────────────────────

test("missing tree.json reports unavailable without failing the ledger", async (t) => {
  const { rootReal } = makeRoot(t);
  const { visit } = collector();
  const result = await readTreeSource(rootReal, visit);
  assert.equal(result.status, "unavailable");
});

test("corrupt or structurally invalid tree.json reports error", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const { visit } = collector();

  writeRel(root, ".auto/tree.json", "{ this is not json");
  const corrupt = await readTreeSource(rootReal, visit);
  assert.equal(corrupt.status, "error");
  assert.match(corrupt.error, /not valid JSON/);

  writeRel(root, ".auto/tree.json", '{"nodes": 3, "version": 1}');
  const invalid = await readTreeSource(rootReal, visit);
  assert.equal(invalid.status, "error");
  assert.match(invalid.error, /unexpected structure/);
});

test("tree nodes stream in deterministic id order with pointers and meta first", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const tree = {
    version: 1,
    rootId: "n1",
    activeNodeId: "n2",
    baselineMetric: 100,
    direction: "lower",
    metricName: "score_ms",
    nodes: {
      n2: { id: "n2", status: "keep", metric: 80, hypothesis: "second", commit: "bbb2222" },
      n10: { id: "n10", status: "discard", metric: 95, hypothesis: "tenth" },
      n1: { id: "n1", status: "baseline", metric: 100, hypothesis: "first" },
    },
  };
  // Inserted out of order in the JSON on purpose.
  writeRel(root, ".auto/tree.json", JSON.stringify(tree));

  const { records, visit } = collector();
  const result = await readTreeSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.deepEqual(records.map((r) => r.ref.pointer), ["/", "/nodes/n1", "/nodes/n2", "/nodes/n10"]);
  assert.equal(records[0].data.metricName, "score_ms");
  assert.equal(records[0].data.direction, "lower");
  assert.equal(records[1].data.id, "n1");
  assert.equal(records[2].data.status, "keep");
  assert.equal(records[3].data.id, "n10");
});

test("tree byte budget truncates before parsing partial JSON", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/tree.json", JSON.stringify({ version: 1, rootId: "n1", nodes: { n1: { id: "n1" } } }));

  const { records, visit } = collector();
  const result = await readTreeSource(rootReal, visit, { budget: createBudget({ maxBytes: 10, maxItems: 10 }) });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

// ─── Ideas ───────────────────────────────────────────────────────────────────

test("missing ideas directory reports unavailable", async (t) => {
  const { rootReal } = makeRoot(t);
  const { visit } = collector();
  const result = await readIdeasSource(rootReal, visit);
  assert.equal(result.status, "unavailable");
});

test("ideas stream sorted deterministically, subdirectories included, frontmatter files included", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/b.md", "bravo idea");
  writeRel(root, ".auto/ideas/10.md", "ten idea");
  writeRel(root, ".auto/ideas/a.md", "alpha idea");
  writeRel(root, ".auto/ideas/hypo.md", "---\nphase: hypothesis\n---\nregistered hypothesis");
  writeRel(root, ".auto/ideas/sub/s.md", "nested idea");

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.deepEqual(
    records.map((r) => r.ref.path),
    [
      ".auto/ideas/10.md",
      ".auto/ideas/a.md",
      ".auto/ideas/b.md",
      ".auto/ideas/hypo.md",
      ".auto/ideas/sub/s.md",
    ],
  );
  assert.equal(records[0].data, "ten idea");
  assert.equal(records[0].ref.source, "ideas");
  assert.equal(records[3].data.startsWith("---\n"), true);
  assert.equal(records[4].data, "nested idea");
});

test("ideas enumeration stops at the item budget", async (t) => {
  const { root, rootReal } = makeRoot(t);
  for (const name of ["a.md", "b.md", "c.md"]) writeRel(root, `.auto/ideas/${name}`, "x".repeat(20));

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit, { budget: createBudget({ maxItems: 2, maxBytes: 1e6 }) });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "items");
  assert.equal(result.items, 2);
  assert.equal(result.records, 2);
  assert.equal(records.length, 2);
});

test("ideas byte budget cuts between files; a partially read file is not delivered", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  writeRel(root, ".auto/ideas/a.md", first);
  writeRel(root, ".auto/ideas/b.md", second);

  const cut = Buffer.byteLength(first) + Math.floor(Buffer.byteLength(second) / 2);
  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit, { budget: createBudget({ maxBytes: cut, maxItems: 100 }) });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.bytes, cut);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/a.md"]);
  assert.equal(records[0].data, first);
});

// ─── Councils ────────────────────────────────────────────────────────────────

test("missing councils directory reports unavailable", async (t) => {
  const { rootReal } = makeRoot(t);
  const { visit } = collector();
  const result = await readCouncilSource(rootReal, visit);
  assert.equal(result.status, "unavailable");
});

test("councils iterate in numeric order (1, 2, 10) with brief and entries, state.json last", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/councils/1/00-brief.md", "# brief 1");
  writeRel(root, ".auto/councils/1/entries/0001-AnalystA.md", "slate one");
  writeRel(root, ".auto/councils/2/00-brief.md", "# brief 2");
  writeRel(root, ".auto/councils/10/00-brief.md", "# brief 10");
  writeRel(root, ".auto/councils/10/entries/0001-Chair.md", "slate ten");
  writeRel(root, ".auto/councils/state.json", '{"councilsRun":10,"lastCouncilRun":30}');

  const { records, visit } = collector();
  const result = await readCouncilSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.deepEqual(
    records.map((r) => r.ref.path),
    [
      ".auto/councils/1/00-brief.md",
      ".auto/councils/1/entries/0001-AnalystA.md",
      ".auto/councils/2/00-brief.md",
      ".auto/councils/10/00-brief.md",
      ".auto/councils/10/entries/0001-Chair.md",
      ".auto/councils/state.json",
    ],
  );
  assert.equal(records[0].data, "# brief 1");
});

// ─── Symlinks escaping the root ──────────────────────────────────────────────

test("ledger behind a directory link escaping the root is refused, never read", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  fs.mkdirSync(path.join(outside, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(outside, ".auto", "log.jsonl"), ledgerLine({ run: 777, description: "outside data" }), "utf8");

  if (!symlinkDir(path.join(outside, ".auto"), path.join(root, ".auto"))) {
    t.skip("directory links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.match(result.error, /escapes the allowed root/);
  // existsSync follows the link, so the candidate is "current" — but refused.
  assert.equal(result.ledger, "current");
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

test("ledger file symlink escaping the root is refused", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  const outsideLedger = path.join(outside, "log.jsonl");
  fs.writeFileSync(outsideLedger, ledgerLine({ run: 555, description: "outside file" }), "utf8");

  writeRel(root, ".auto/placeholder.txt", "keep .auto real");
  if (!symlinkFile(outsideLedger, path.join(root, ".auto", "log.jsonl"))) {
    t.skip("file symlinks not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.match(result.error, /escapes the allowed root/);
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

test("a council directory linked outside the root is skipped; other councils still stream", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  const outsideCouncil = path.join(outside, "c2");
  fs.mkdirSync(path.join(outsideCouncil, "entries"), { recursive: true });
  fs.writeFileSync(path.join(outsideCouncil, "entries", "0001-X.md"), "outside slate", "utf8");

  writeRel(root, ".auto/councils/1/00-brief.md", "# brief 1");
  if (!symlinkDir(outsideCouncil, path.join(root, ".auto", "councils", "2"))) {
    t.skip("directory links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readCouncilSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.outsideRoot, 1);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/councils/1/00-brief.md"]);
  assert.equal(records.some((r) => r.data === "outside slate"), false);
});

test("councils root linked outside the root is refused entirely", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  fs.mkdirSync(path.join(outside, "councils", "1"), { recursive: true });
  fs.writeFileSync(path.join(outside, "councils", "1", "00-brief.md"), "# outside brief", "utf8");

  writeRel(root, ".auto/placeholder.txt", "keep .auto real");
  if (!symlinkDir(path.join(outside, "councils"), path.join(root, ".auto", "councils"))) {
    t.skip("directory links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readCouncilSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.match(result.error, /escapes the allowed root/);
  assert.equal(result.records, 0);
  assert.equal(records.length, 0);
});

test("ideas directory linked outside the root is refused entirely", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  fs.writeFileSync(path.join(outside, "leak.md"), "outside idea", "utf8");

  writeRel(root, ".auto/placeholder.txt", "keep .auto real");
  if (!symlinkDir(outside, path.join(root, ".auto", "ideas"))) {
    t.skip("directory links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.match(result.error, /escapes the allowed root/);
  assert.equal(records.length, 0);
});

// ─── References found inside records (never opened by the search) ───────────

test("references escaping the root are rejected: POSIX and Windows traversal styles", (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, "notes/case.md", "evidence");

  // POSIX-style traversal.
  assert.deepEqual(checkPathInRoots("../escape.md", [rootReal]), { ok: false, reason: "outside-root" });
  // Windows-style traversal must be rejected on every platform (records may
  // come from a Windows campaign and be replayed on POSIX and vice versa).
  assert.deepEqual(checkPathInRoots("..\\escape.md", [rootReal]), { ok: false, reason: "outside-root" });
  // Absolute host path outside the root.
  assert.deepEqual(checkPathInRoots(path.join(rootReal, "..", "elsewhere.md"), [rootReal]), {
    ok: false,
    reason: "outside-root",
  });
  // Drive-absolute POSIX path outside the root (resolves outside on both platforms).
  assert.deepEqual(checkPathInRoots("/etc/hosts", [rootReal]), { ok: false, reason: "outside-root" });
  assert.equal(fs.existsSync(path.join(root, "escape.md")), false);
});

test("references inside the root resolve to the real path; missing ones are reported, not refused", (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, "notes/case.md", "evidence");

  const ok = checkPathInRoots("notes/case.md", [rootReal]);
  assert.equal(ok.ok, true);
  assert.equal(ok.absolute, fs.realpathSync(path.join(root, "notes", "case.md")));
  assert.equal(ok.root, rootReal);

  const dot = checkPathInRoots("./notes/case.md", [rootReal]);
  assert.equal(dot.ok, true);

  const ghost = checkPathInRoots("notes/ghost.md", [rootReal]);
  assert.deepEqual(ghost, { ok: false, reason: "missing" });

  assert.deepEqual(checkPathInRoots("", [rootReal]), { ok: false, reason: "invalid" });
  assert.deepEqual(checkPathInRoots("   ", [rootReal]), { ok: false, reason: "invalid" });
});

test("a reference pointing at a symlink that escapes the root is rejected", (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  const secret = path.join(outside, "secret.md");
  fs.writeFileSync(secret, "must not open", "utf8");

  // No real file under the link path: symlink creation must actually succeed.
  if (!symlinkFile(secret, path.join(root, "linked.md"))) {
    t.skip("file symlinks not permitted on this host");
    return;
  }

  const result = checkPathInRoots("linked.md", [rootReal]);
  assert.deepEqual(result, { ok: false, reason: "outside-root" });
});

// ─── Path guard primitives ───────────────────────────────────────────────────

test("isPathWithinRoot accepts containment and rejects traversal on this platform", (t) => {
  const { root, rootReal } = makeRoot(t);
  const sibling = makeOutsideDir(t);

  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "a", "b.md")), true);
  assert.equal(isPathWithinRoot(rootReal, rootReal), true);
  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "..", "b.md")), false);
  assert.equal(isPathWithinRoot(rootReal, sibling), false);

  // Windows root matching is case-insensitive; POSIX is case-sensitive.
  if (IS_WINDOWS) {
    assert.equal(isPathWithinRoot(rootReal, rootReal.toUpperCase()), true);
  } else {
    assert.equal(isPathWithinRoot(rootReal, rootReal.toUpperCase()), false);
  }
  assert.equal(fs.existsSync(path.join(root, "b.md")), false);
});

test("guardPathInsideRoot refuses a symlink escaping the root and reports missing files", (t) => {
  const { root, rootReal } = makeRoot(t);
  const outside = makeOutsideDir(t);
  fs.writeFileSync(path.join(outside, "secret.md"), "outside", "utf8");

  writeRel(root, "inside.md", "inside");
  const linked = symlinkFile(path.join(outside, "secret.md"), path.join(root, "link.md"));
  if (!linked) {
    t.skip("file symlinks not permitted on this host");
  } else {
    const guard = guardPathInsideRoot(rootReal, path.join(root, "link.md"));
    assert.deepEqual(guard, { ok: false, reason: "outside-root" });
  }

  assert.deepEqual(guardPathInsideRoot(rootReal, path.join(rootReal, "ghost.md")), { ok: false, reason: "missing" });
  assert.equal(guardPathInsideRoot(rootReal, path.join(rootReal, "inside.md")).ok, true);
});

test("toRelativePosix always emits forward slashes", (t) => {
  const { rootReal } = makeRoot(t);
  assert.equal(toRelativePosix(rootReal, path.join(rootReal, ".auto", "log.jsonl")), ".auto/log.jsonl");
  assert.equal(toRelativePosix(rootReal, path.join(rootReal, "ideas", "sub", "s.md")), "ideas/sub/s.md");
});

test("compareNatural orders numerically and deterministically", (t) => {
  const names = ["n10", "n2", "1", "10", "2", "n1"];
  assert.deepEqual([...names].sort(compareNatural), ["1", "2", "10", "n1", "n2", "n10"]);
  // Pure codepoint tie-breaks, independent of locale. Equal numeric values
  // fall back to a length comparison — deterministic on every machine.
  assert.equal(compareNatural("01", "1"), 1);
});

// ─── Review fixes: BOM, malformed ledger, subtree confinement, cycles, budgets, abort, seams ───

test("a UTF-8 BOM at the start of the ledger does not corrupt the first (config) record", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const config = { type: "config", name: "bom-session", metricName: "total_ms" };
  writeRel(root, ".auto/log.jsonl", "\uFEFF" + ledgerLine(config) + ledgerLine({ run: 1, description: "after bom" }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.malformedLines, 0);
  assert.equal(result.records, 2);
  assert.equal(records[0].ref.line, 1);
  assert.equal(records[0].data.type, "config");
  assert.equal(records[0].data.name, "bom-session");
  assert.equal(records[1].data.description, "after bom");
});

test("a BOM after the first line is data, not stripped: that line is malformed and the ledger is not searched", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", ledgerLine({ run: 1 }) + "\uFEFF" + ledgerLine({ run: 2 }));

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.equal(result.malformedLines, 1);
  assert.deepEqual(records.map((r) => r.ref.line), [1]);
});

test("ideas and councils never read files linked from outside their own subtree, even when inside the root", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, "secret.md", "TOP-SECRET-ROOT-FILE");
  writeRel(root, ".auto/ideas/ok.md", "ok idea");
  writeRel(root, ".auto/councils/1/00-brief.md", "# brief 1");
  const linked = [
    symlinkFile(path.join(root, "secret.md"), path.join(root, ".auto", "ideas", "leak.md")),
    symlinkFile(path.join(root, "secret.md"), path.join(root, ".auto", "councils", "1", "leak.md")),
    symlinkDir(rootReal, path.join(root, ".auto", "ideas", "up")),
  ];
  if (!linked.every(Boolean)) {
    t.skip("links not permitted on this host");
    return;
  }

  const ideas = collector();
  const ideasResult = await readIdeasSource(rootReal, ideas.visit);
  assert.equal(ideasResult.status, "searched");
  assert.equal(ideasResult.outsideRoot, 2); // leak.md (file link) and up (directory link to the root)
  assert.deepEqual(ideas.records.map((r) => r.ref.path), [".auto/ideas/ok.md"]);

  const councils = collector();
  const councilResult = await readCouncilSource(rootReal, councils.visit);
  assert.equal(councilResult.status, "searched");
  assert.equal(councilResult.outsideRoot, 1);
  assert.deepEqual(councils.records.map((r) => r.ref.path), [".auto/councils/1/00-brief.md"]);

  for (const record of [...ideas.records, ...councils.records]) {
    assert.equal(String(record.data).includes("TOP-SECRET"), false);
  }
});

test("a link that stays inside the ideas subtree is still read (negative control for subtree confinement)", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/ok.md", "ok idea");
  if (!symlinkFile(path.join(root, ".auto", "ideas", "ok.md"), path.join(root, ".auto", "ideas", "alias.md"))) {
    t.skip("file links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.outsideRoot, 0);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/alias.md", ".auto/ideas/ok.md"]);
  assert.deepEqual(records.map((r) => r.data), ["ok idea", "ok idea"]);
});

test("a directory cycle inside the ideas subtree is walked once: no duplicates, no false truncation", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/a.md", "alpha idea");
  writeRel(root, ".auto/ideas/sub/b.md", "bravo idea");
  if (!symlinkDir(path.join(root, ".auto", "ideas"), path.join(root, ".auto", "ideas", "sub", "loop"))) {
    t.skip("directory links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "searched");
  assert.equal(result.truncatedBy, undefined);
  assert.equal(result.outsideRoot, 0);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/a.md", ".auto/ideas/sub/b.md"]);
  // a.md, sub, b.md, loop: the loop entry is charged once and never re-entered.
  assert.equal(result.items, 4);
});

test("default budget without options: a 60 MiB idea is cut at 10 MiB and reported truncated", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/huge.md", Buffer.alloc(60 * 1048576, 0x61));

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.bytes, 10485760);
  assert.equal(records.length, 0);
});

test("an exhausted budget reports a missing optional source as unavailable, a present one as truncated", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const exhausted = () => createBudget({ maxItems: 0 });
  assert.equal((await readTreeSource(rootReal, collector().visit, { budget: exhausted() })).status, "unavailable");
  assert.equal((await readIdeasSource(rootReal, collector().visit, { budget: exhausted() })).status, "unavailable");
  assert.equal((await readCouncilSource(rootReal, collector().visit, { budget: exhausted() })).status, "unavailable");
  assert.equal((await readLedgerSource(rootReal, collector().visit, { budget: exhausted() })).status, "unavailable");

  writeRel(root, ".auto/tree.json", JSON.stringify({ version: 1, nodes: {} }));
  const present = await readTreeSource(rootReal, collector().visit, { budget: exhausted() });
  assert.equal(present.status, "truncated");
  assert.equal(present.truncatedBy, "items");
});

test("isPathWithinRoot treats names starting with '..' inside the root as inside", (t) => {
  const { rootReal } = makeRoot(t);
  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "..notes.md")), true);
  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "...")), true);
  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "..")), false);
  assert.equal(isPathWithinRoot(rootReal, path.join(rootReal, "..", "..notes.md")), false);
});

test("an existing '..notes.md' reference inside the root resolves; real traversal is still refused", (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, "..notes.md", "dotted name");

  const ok = checkPathInRoots("..notes.md", [rootReal]);
  assert.equal(ok.ok, true);
  assert.equal(ok.absolute, fs.realpathSync(path.join(root, "..notes.md")));
  assert.deepEqual(checkPathInRoots("..", [rootReal]), { ok: false, reason: "outside-root" });
  assert.deepEqual(checkPathInRoots("../..notes.md", [rootReal]), { ok: false, reason: "outside-root" });
});

test("an already aborted signal stops every adapter with truncatedBy 'abort' and reads nothing", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", ledgerLine({ run: 1 }));
  writeRel(root, ".auto/tree.json", JSON.stringify({ version: 1, nodes: { n1: { id: "n1" } } }));
  writeRel(root, ".auto/ideas/a.md", "alpha");
  writeRel(root, ".auto/councils/1/00-brief.md", "brief");
  const controller = new AbortController();
  controller.abort();

  for (const read of [readLedgerSource, readTreeSource, readIdeasSource, readCouncilSource]) {
    const { records, visit } = collector();
    const result = await read(rootReal, visit, { signal: controller.signal });
    assert.equal(result.status, "truncated", read.name);
    assert.equal(result.truncatedBy, "abort", read.name);
    assert.equal(result.records, 0, read.name);
    assert.equal(records.length, 0, read.name);
  }
});

test("abort raised by the visitor stops the ledger mid-stream", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/log.jsonl", Array.from({ length: 5 }, (_, i) => ledgerLine({ run: i + 1 })).join(""));
  const controller = new AbortController();
  const { records, visit } = collector();
  const aborting = (record) => {
    visit(record);
    if (records.length === 2) controller.abort();
    return true;
  };

  const result = await readLedgerSource(rootReal, aborting, { signal: controller.signal });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "abort");
  assert.deepEqual(records.map((r) => r.ref.line), [1, 2]);
});

test("abort raised during ideas delivery stops before the next file", async (t) => {
  const { root, rootReal } = makeRoot(t);
  for (const name of ["a.md", "b.md", "c.md"]) writeRel(root, `.auto/ideas/${name}`, "x".repeat(20));
  const controller = new AbortController();
  const { records, visit } = collector();
  const aborting = (record) => {
    visit(record);
    controller.abort();
    return true;
  };

  const result = await readIdeasSource(rootReal, aborting, { signal: controller.signal });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "abort");
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/a.md"]);
});

test("abort observed during ideas enumeration stops the walk before reading files", async (t) => {
  const { root, rootReal } = makeRoot(t);
  for (const name of ["a.md", "b.md", "c.md", "d.md"]) writeRel(root, `.auto/ideas/${name}`, "x");
  // Reports aborted from its third check on: check 1 is the pre-read stop check, check 2 the first entry.
  let checks = 0;
  const signal = { get aborted() { checks++; return checks > 2; } };
  const { records, visit } = collector();

  const result = await readIdeasSource(rootReal, visit, { signal });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "abort");
  assert.equal(result.items < 4, true);
  assert.equal(records.length, 0);
});

test("a dangling link in ideas is a read error, not a silent skip", async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/ok.md", "ok");
  if (!symlinkFile(path.join(root, "missing-target.md"), path.join(root, ".auto", "ideas", "dangling.md"))) {
    t.skip("file links not permitted on this host");
    return;
  }

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.equal(result.readErrors, 1);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/ok.md"]);
});

test("a FIFO in ideas is counted as a read error and never opened", { skip: IS_WINDOWS ? "mkfifo is POSIX-only" : false, timeout: 15000 }, async (t) => {
  const { root, rootReal } = makeRoot(t);
  writeRel(root, ".auto/ideas/ok.md", "ok");
  const fifo = path.join(root, ".auto", "ideas", "pipe");
  if (spawnSync("mkfifo", [fifo]).status !== 0) {
    t.skip("mkfifo unavailable");
    return;
  }

  const { records, visit } = collector();
  const result = await readIdeasSource(rootReal, visit);

  assert.equal(result.status, "error");
  assert.equal(result.readErrors, 1);
  assert.deepEqual(records.map((r) => r.ref.path), [".auto/ideas/ok.md"]);
});

test("passBudget caps one pass while the shared budget records the run total", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const l1 = ledgerLine({ run: 1, description: "alpha" });
  const l2 = ledgerLine({ run: 2, description: "beta" });
  writeRel(root, ".auto/log.jsonl", l1 + l2);
  const shared = createBudget({ maxBytes: 1e6, maxItems: 100 });
  const pass = createBudget({ maxBytes: Buffer.byteLength(l1), maxItems: 100 });

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit, { budget: shared, passBudget: pass });

  assert.equal(result.status, "truncated");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.bytes, Buffer.byteLength(l1));
  assert.deepEqual(records.map((r) => r.ref.line), [1]);
  assert.equal(shared.bytesSpent(), Buffer.byteLength(l1));
  assert.equal(pass.bytesSpent(), Buffer.byteLength(l1));
});

test("startLine delivers from the given physical line; earlier lines are read but not parsed", async (t) => {
  const { root, rootReal } = makeRoot(t);
  const l1 = ledgerLine({ run: 1 });
  const l3 = ledgerLine({ run: 3 });
  const l4 = ledgerLine({ run: 4 });
  const content = l1 + "garbage\n" + l3 + l4;
  writeRel(root, ".auto/log.jsonl", content);

  const { records, visit } = collector();
  const result = await readLedgerSource(rootReal, visit, { startLine: 3 });

  assert.equal(result.status, "searched");
  assert.equal(result.malformedLines, 0);
  assert.equal(result.bytes, Buffer.byteLength(content));
  assert.deepEqual(records.map((r) => r.ref.line), [3, 4]);
  assert.deepEqual(records.map((r) => r.data.run), [3, 4]);
});

test("LOCAL_PRECEDENT_SOURCES exposes the four local adapters in fixed order", () => {
  assert.deepEqual(LOCAL_PRECEDENT_SOURCES.map((adapter) => adapter.id), ["log", "tree", "ideas", "councils"]);
  for (const adapter of LOCAL_PRECEDENT_SOURCES) assert.equal(typeof adapter.read, "function");
});
