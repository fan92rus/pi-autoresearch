import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELTA_PAGE_SIZE,
  DELTA_RATIO_LIMIT,
  diffAgainstBest,
  extractErrorWarnLines,
  extractGenericSample,
  extractMetricLines,
  extractTimingLines,
  headTail,
  runEpoch,
  selectBestKeep,
} from "../extensions/pi-autoresearch/lens-extractors.ts";

// Helpers ------------------------------------------------------------------

function run(n, status, metric, output = "", epoch = undefined) {
  const r = { run: n, status, metric, output };
  if (epoch !== undefined) r.epoch = epoch;
  return r;
}

function linesOf(count, prefix = "line") {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

const OPTS = { direction: "lower" };

// ---------------------------------------------------------------------------
// runEpoch
// ---------------------------------------------------------------------------

test("runEpoch: missing epoch is epoch 1 (legacy ledger compatibility)", () => {
  assert.equal(runEpoch({ run: 1, status: "keep", output: "" }), 1);
  assert.equal(runEpoch({ run: 1, status: "keep", output: "", epoch: 2 }), 2);
});

// ---------------------------------------------------------------------------
// METRIC extractor (mirrors index.ts parseMetricLines)
// ---------------------------------------------------------------------------

test("METRIC: parses name=value lines and ignores other lines", () => {
  const out = "building...\nMETRIC total_µs=15200\nnoise\nMETRIC compile_µs=4200\n";
  assert.deepEqual(extractMetricLines(out), [
    { name: "total_µs", value: 15200 },
    { name: "compile_µs", value: 4200 },
  ]);
});

test("METRIC: domain-independent names (no timing assumptions)", () => {
  const out = "METRIC f1_score=0.93\nMETRIC dpo.ta-acc=0.5\nMETRIC recall=1";
  // dash is not a valid name char: that line is rejected, the rest kept
  assert.deepEqual(extractMetricLines(out), [
    { name: "f1_score", value: 0.93 },
    { name: "recall", value: 1 },
  ]);
});

test("METRIC: duplicate names keep first-occurrence position and last value", () => {
  const out = "METRIC a=1\nMETRIC b=2\nMETRIC a=3";
  assert.deepEqual(extractMetricLines(out), [
    { name: "a", value: 3 },
    { name: "b", value: 2 },
  ]);
});

test("METRIC: rejects prototype-pollution names", () => {
  const out = "METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\nMETRIC ok=4";
  assert.deepEqual(extractMetricLines(out), [{ name: "ok", value: 4 }]);
});

test("METRIC: negative cases — non-finite, malformed, misplaced lines are rejected", () => {
  const out = [
    "METRIC x=Infinity",
    "METRIC x=NaN",
    "METRIC x",
    "METRIC =5",
    "METRIC a=b=c",
    "METRIC a=1 extra",
    " METRIC lead=1",
    "xMETRIC pre=1",
    "metric lower=1",
  ].join("\n");
  assert.deepEqual(extractMetricLines(out), []);
});

test("METRIC: CRLF line endings are accepted", () => {
  assert.deepEqual(extractMetricLines("METRIC a=1\r\nMETRIC b=2\r\n"), [
    { name: "a", value: 1 },
    { name: "b", value: 2 },
  ]);
});

test("METRIC: empty output yields no metrics", () => {
  assert.deepEqual(extractMetricLines(""), []);
});

// ---------------------------------------------------------------------------
// error/fail/warn extractor
// ---------------------------------------------------------------------------

test("error/warn: case-insensitive substring match, in line order, 1-based numbers", () => {
  const out = ["ok", "ERROR: boom", "all fine", "Warning: slow", "test FAILED", "done"].join("\n");
  assert.deepEqual(extractErrorWarnLines(out), [
    { lineNo: 2, text: "ERROR: boom" },
    { lineNo: 4, text: "Warning: slow" },
    { lineNo: 5, text: "test FAILED" },
  ]);
});

test("error/warn: negative — lines without the substrings are not reported", () => {
  assert.deepEqual(extractErrorWarnLines("all good\nok\nMETRIC a=1\nsuccess"), []);
});

test("error/warn: CRLF stripped from reported text", () => {
  assert.deepEqual(extractErrorWarnLines("fine\r\nerror here\r\n"), [{ lineNo: 2, text: "error here" }]);
});

// ---------------------------------------------------------------------------
// timing extractor
// ---------------------------------------------------------------------------

test("timing: ms/µs/us/s normalized to milliseconds", () => {
  const out = ["a 1500µs", "b 2s", "c 3ms", "d 0.5s", "e 900us"].join("\n");
  const { total, top } = extractTimingLines(out, 10);
  assert.equal(total, 5);
  assert.deepEqual(
    top.map((h) => [h.lineNo, h.unit, h.valueMs]),
    [
      [2, "s", 2000],
      [4, "s", 500],
      [3, "ms", 3],
      [1, "µs", 1.5],
      [5, "us", 0.9],
    ],
  );
});

test("timing: top-N sorted by normalized value descending, limited to N", () => {
  const out = ["x 10ms", "x 2s", "x 5ms", "x 1ms"].join("\n");
  const { total, top } = extractTimingLines(out, 2);
  assert.equal(total, 4);
  assert.deepEqual(top.map((h) => h.valueMs), [2000, 10]);
});

test("timing: equal values tie-break by line number ascending (stable)", () => {
  const out = ["a 5ms", "b 5ms", "c 5ms"].join("\n");
  assert.deepEqual(extractTimingLines(out, 10).top.map((h) => h.lineNo), [1, 2, 3]);
});

test("timing: top 0 returns no entries but still counts matches", () => {
  const out = "a 5ms\nb 2s";
  assert.deepEqual(extractTimingLines(out, 0), { total: 2, top: [] });
});

test("timing: space between number and unit is allowed", () => {
  assert.equal(extractTimingLines("took 12 ms", 5).top[0].valueMs, 12);
});

test("timing: negative — unit must end on a word boundary and number must start one", () => {
  const out = [
    "took 10 seconds",
    "count 10 items",
    "x12ms",
    "version 1.5.3s",
    "METRIC total_ms=15",
    "10 mss",
    "ms",
  ].join("\n");
  assert.deepEqual(extractTimingLines(out, 10), { total: 0, top: [] });
});

test("timing: punctuation after unit still matches", () => {
  assert.equal(extractTimingLines("done in 3 s.", 5).total, 1);
});

test("timing: one entry per line, first token wins", () => {
  const out = "compile 120ms run 3s";
  const { total, top } = extractTimingLines(out, 5);
  assert.equal(total, 1);
  assert.equal(top[0].valueMs, 120);
});

// ---------------------------------------------------------------------------
// best keep selection (epochs, direction, ties)
// ---------------------------------------------------------------------------

test("selectBestKeep: lower direction picks minimum metric among keep runs of the epoch", () => {
  const runs = [run(1, "keep", 10), run(2, "keep", 5), run(3, "discard", 1), run(4, "keep", 7)];
  assert.equal(selectBestKeep(runs, 1, "lower").run, 2);
});

test("selectBestKeep: higher direction picks maximum", () => {
  const runs = [run(1, "keep", 10), run(2, "keep", 50), run(3, "keep", 7)];
  assert.equal(selectBestKeep(runs, 1, "higher").run, 2);
});

test("selectBestKeep: ties resolved by earliest run number regardless of input order", () => {
  const a = [run(3, "keep", 5), run(1, "keep", 5), run(2, "keep", 5)];
  const b = [run(2, "keep", 5), run(3, "keep", 5), run(1, "keep", 5)];
  assert.equal(selectBestKeep(a, 1, "lower").run, 1);
  assert.equal(selectBestKeep(b, 1, "lower").run, 1);
});

test("selectBestKeep: other-epoch keeps are never the baseline", () => {
  const runs = [run(1, "keep", 1, "", 1), run(2, "keep", 9, "", 2)];
  assert.equal(selectBestKeep(runs, 2, "lower").run, 2);
  assert.equal(selectBestKeep(runs, 3, "lower"), null);
});

test("selectBestKeep: legacy runs without epoch belong to epoch 1", () => {
  const runs = [run(1, "keep", 4), run(2, "keep", 3, "", 2)];
  assert.equal(selectBestKeep(runs, 1, "lower").run, 1);
  assert.equal(selectBestKeep(runs, 2, "lower").run, 2);
});

test("selectBestKeep: negative — no keep, null metric, non-finite metric are skipped", () => {
  const runs = [run(1, "discard", 0), run(2, "crash", null), run(3, "keep", null), run(4, "keep", NaN)];
  assert.equal(selectBestKeep(runs, 1, "lower"), null);
  assert.equal(selectBestKeep([], 1, "lower"), null);
});

// ---------------------------------------------------------------------------
// line-wise delta against baseline
// ---------------------------------------------------------------------------

test("delta: identical outputs produce no differing lines", () => {
  const cur = run(5, "keep", 1, "a\nb\nc");
  const base = run(2, "keep", 1, "a\nb\nc");
  const d = diffAgainstBest(cur, base, {});
  assert.equal(d.kind, "delta");
  assert.equal(d.total, 0);
  assert.deepEqual(d.entries, []);
  assert.equal(d.baselineRun, 2);
});

test("delta: added and removed lines carry line numbers from their own output", () => {
  const cur = run(5, "keep", 1, "a\nNEW\nc");
  const base = run(2, "keep", 1, "a\nb\nc");
  const d = diffAgainstBest(cur, base, {});
  assert.deepEqual(d.entries, [
    { kind: "added", lineNo: 2, text: "NEW" },
    { kind: "removed", lineNo: 2, text: "b" },
  ]);
  assert.equal(d.total, 2);
});

test("delta: multiset semantics — duplicate line counts matter", () => {
  // sizes kept within the 2x ratio so the line diff is computed
  const cur = run(5, "keep", 1, "x\nx\nx");
  const base = run(2, "keep", 1, "x\ny");
  const d = diffAgainstBest(cur, base, {});
  assert.deepEqual(d.entries, [
    { kind: "added", lineNo: 2, text: "x" },
    { kind: "added", lineNo: 3, text: "x" },
    { kind: "removed", lineNo: 2, text: "y" },
  ]);
});

test("delta: trailing whitespace, CR and final newline are not differences", () => {
  const cur = run(5, "keep", 1, "a  \r\nb\n");
  const base = run(2, "keep", 1, "a\nb\n");
  assert.equal(diffAgainstBest(cur, base, {}).total, 0);
});

test("delta: blank-line-only difference is a difference", () => {
  const cur = run(5, "keep", 1, "a\n\nb");
  const base = run(2, "keep", 1, "a\nb");
  const d = diffAgainstBest(cur, base, {});
  assert.deepEqual(d.entries, [{ kind: "added", lineNo: 2, text: "" }]);
});

test("delta: page size boundary — exactly 200 differing lines fit one page, 201 need two", () => {
  assert.equal(DELTA_PAGE_SIZE, 200);
  // shared padding line keeps the byte ratio within 2x; only the appended lines differ
  const shared = "c".repeat(2000);
  const base = run(2, "keep", 1, shared);
  const withExtra = (n) => run(5, "keep", 1, `${shared}\n${linesOf(n, "n")}`);

  const d200 = diffAgainstBest(withExtra(200), base, {});
  assert.equal(d200.kind, "delta");
  assert.equal(d200.total, 200);
  assert.equal(d200.pageCount, 1);
  assert.equal(d200.entries.length, 200);

  const d201 = diffAgainstBest(withExtra(201), base, {});
  assert.equal(d201.total, 201);
  assert.equal(d201.pageCount, 2);
  assert.equal(d201.entries.length, 200);
  const p2 = diffAgainstBest(withExtra(201), base, { page: 2 });
  assert.equal(p2.entries.length, 1);
  assert.equal(p2.entries[0].lineNo, 202);
});

test("delta: page beyond the last page is empty, not an error", () => {
  const d = diffAgainstBest(run(5, "keep", 1, "x"), run(2, "keep", 1, "y"), { page: 9 });
  assert.equal(d.kind, "delta");
  assert.deepEqual(d.entries, []);
  assert.equal(d.total, 2);
  assert.equal(d.pageCount, 1);
});

test("delta: ratio exactly 2x is comparable, above 2x is incomparable (head/tail of both)", () => {
  assert.equal(DELTA_RATIO_LIMIT, 2);
  const base = run(2, "keep", 1, "a".repeat(100));
  const exact = run(5, "keep", 1, "b".repeat(200));
  assert.equal(diffAgainstBest(exact, base, {}).kind, "delta");

  const over = run(5, "keep", 1, "b".repeat(201));
  const d = diffAgainstBest(over, base, {});
  assert.equal(d.kind, "incomparable");
  assert.equal(d.currentBytes, 201);
  assert.equal(d.baselineBytes, 100);
  assert.equal(d.baselineRun, 2);
  assert.ok(d.current && d.baseline);
});

test("delta: incomparable when one side is empty and the other is not; both empty is comparable", () => {
  assert.equal(diffAgainstBest(run(5, "keep", 1, "x"), run(2, "keep", 1, ""), {}).kind, "incomparable");
  assert.equal(diffAgainstBest(run(5, "keep", 1, ""), run(2, "keep", 1, "x"), {}).kind, "incomparable");
  assert.equal(diffAgainstBest(run(5, "keep", 1, ""), run(2, "keep", 1, ""), {}).kind, "delta");
});

test("delta: ratio is measured in bytes (UTF-8), not UTF-16 units", () => {
  // "µ" is 2 bytes in UTF-8: 50 × 'µ' = 100 bytes, vs 'a' × 40 = 40 bytes → 2.5x → incomparable
  const base = run(2, "keep", 1, "a".repeat(40));
  const cur = run(5, "keep", 1, "µ".repeat(50));
  assert.equal(diffAgainstBest(cur, base, {}).kind, "incomparable");
});

// ---------------------------------------------------------------------------
// head/tail sample
// ---------------------------------------------------------------------------

test("headTail: short output is returned whole with nothing omitted", () => {
  const h = headTail("a\nb\nc", 2, 2);
  assert.equal(h.totalLines, 3);
  assert.equal(h.omitted, 0);
  assert.deepEqual(h.head.map((l) => l.text), ["a", "b", "c"]);
  assert.deepEqual(h.tail, []);
});

test("headTail: long output keeps head and tail with correct omitted count", () => {
  const h = headTail(linesOf(10), 2, 3);
  assert.equal(h.totalLines, 10);
  assert.deepEqual(h.head.map((l) => l.lineNo), [1, 2]);
  assert.deepEqual(h.tail.map((l) => l.lineNo), [8, 9, 10]);
  assert.equal(h.omitted, 5);
});

test("headTail: tail 0 gives no tail (not the whole output)", () => {
  const h = headTail(linesOf(10), 3, 0);
  assert.deepEqual(h.tail, []);
  assert.equal(h.omitted, 7);
});

test("headTail: empty output and trailing newline do not invent lines", () => {
  assert.equal(headTail("", 5, 5).totalLines, 0);
  assert.equal(headTail("a\nb\n", 5, 5).totalLines, 2);
});

test("headTail: rejects negative or non-integer sizes", () => {
  assert.throws(() => headTail("a", -1, 0), RangeError);
  assert.throws(() => headTail("a", 1.5, 0), RangeError);
});

// ---------------------------------------------------------------------------
// composite generic sample
// ---------------------------------------------------------------------------

test("sample: perf domain without config — top timing, metrics, and delta vs best keep", () => {
  // lower is better: run 1 (90) is the baseline, run 2 (100) is the inspected run
  const baseline = run(1, "keep", 90, "METRIC total_µs=90000\nparse 5ms\nrender 2s\nfine");
  const current = run(2, "keep", 100, "METRIC total_µs=100000\nparse 5ms\nrender 1.2s\nextra line");
  const s = extractGenericSample(current, [baseline, current], { ...OPTS, timingTop: 2 });
  assert.equal(s.run, 2);
  assert.equal(s.epoch, 1);
  assert.deepEqual(s.metrics, [{ name: "total_µs", value: 100000 }]);
  assert.equal(s.timing.total, 2);
  assert.deepEqual(s.timing.top.map((h) => h.valueMs), [1200, 5]);
  assert.equal(s.delta.kind, "delta");
  assert.equal(s.delta.baselineRun, 1);
  // removed: METRIC 90000, render 2s, fine; added: METRIC 100000, render 1.2s, extra line
  assert.equal(s.delta.total, 6);
  assert.equal(s.fallback, null);
});

test("sample: error lines are capped by errorLimit but total is reported", () => {
  const out = Array.from({ length: 30 }, (_, i) => `error ${i + 1}`).join("\n");
  const s = extractGenericSample(run(2, "crash", null, out), [], { ...OPTS, errorLimit: 5 });
  assert.equal(s.errors.total, 30);
  assert.equal(s.errors.shown.length, 5);
  assert.equal(s.errors.shown[0].lineNo, 1);
});

test("sample: no keep in current epoch → delta unavailable with explanation", () => {
  const runs = [run(1, "keep", 1, "x", 1), run(2, "discard", 5, "y", 2)];
  const s = extractGenericSample(runs[1], runs, { ...OPTS });
  assert.equal(s.delta.kind, "unavailable");
  assert.match(s.delta.reason, /epoch 2/);
});

test("sample: keep only in another epoch → cross-epoch baseline is blocked and explained", () => {
  const runs = [run(1, "keep", 1, "x", 1), run(2, "keep", 5, "y", 2)];
  const s = extractGenericSample(run(9, "discard", 9, "q", 3), runs, { ...OPTS });
  assert.equal(s.epoch, 3);
  assert.equal(s.delta.kind, "unavailable");
  assert.match(s.delta.reason, /epoch 3/);
  assert.match(s.delta.reason, /cross-epoch/);
});

test("sample: incomparable volume → delta kind incomparable, no line diff", () => {
  const base = run(1, "keep", 1, "a\nb");
  const cur = run(2, "keep", 1, linesOf(500));
  const s = extractGenericSample(cur, [base, cur], { ...OPTS });
  assert.equal(s.delta.kind, "incomparable");
});

test("sample: no extractor data → raw head/tail fallback with marker", () => {
  const out = linesOf(50, "plain");
  const s = extractGenericSample(run(2, "keep", 1, out), [], { ...OPTS, headLines: 3, tailLines: 2 });
  assert.equal(s.metrics.length, 0);
  assert.equal(s.errors.total, 0);
  assert.equal(s.timing.total, 0);
  assert.ok(s.fallback);
  assert.equal(s.fallback.kind, "raw_head_tail");
  assert.equal(s.fallback.totalLines, 50);
  assert.deepEqual(s.fallback.head.map((l) => l.lineNo), [1, 2, 3]);
  assert.deepEqual(s.fallback.tail.map((l) => l.lineNo), [49, 50]);
  assert.equal(s.fallback.omitted, 45);
});

test("sample: any single extractor hit suppresses the raw fallback", () => {
  assert.equal(extractGenericSample(run(2, "keep", 1, "Error: x"), [], OPTS).fallback, null);
  assert.equal(extractGenericSample(run(2, "keep", 1, "took 3ms"), [], OPTS).fallback, null);
  assert.equal(extractGenericSample(run(2, "keep", 1, "METRIC a=1"), [], OPTS).fallback, null);
});

test("sample: empty output → fallback with zero lines (no crash)", () => {
  const s = extractGenericSample(run(2, "crash", null, ""), [], OPTS);
  assert.equal(s.fallback.totalLines, 0);
  assert.deepEqual(s.fallback.head, []);
});

test("sample: domain-neutral output with no matches still produces a bounded fallback", () => {
  const s = extractGenericSample(run(2, "keep", 1, "score 0.93\nrecall 0.80"), [], OPTS);
  assert.equal(s.fallback.kind, "raw_head_tail");
});

test("sample: deterministic — same inputs give identical output, input order irrelevant", () => {
  const a = run(1, "keep", 5, "METRIC m=5\nerror a\n3ms");
  const b = run(2, "keep", 5, "METRIC m=5\nerror b\n3ms");
  const c = run(3, "keep", 6, "METRIC m=6\nerror c");
  const s1 = extractGenericSample(c, [a, b, c], OPTS);
  const s2 = extractGenericSample(c, [c, b, a], OPTS);
  assert.deepEqual(s1, s2);
  assert.deepEqual(extractGenericSample(c, [a, b, c], OPTS), s1);
  assert.equal(s1.delta.baselineRun, 1);
});

test("sample: invalid options are rejected", () => {
  const r = run(2, "keep", 1, "x");
  assert.throws(() => extractGenericSample(r, [], { direction: "lower", timingTop: -1 }), RangeError);
  assert.throws(() => extractGenericSample(r, [], { direction: "lower", page: 0 }), RangeError);
  assert.throws(() => extractGenericSample(r, [], { direction: "lower", pageSize: 0 }), RangeError);
});
