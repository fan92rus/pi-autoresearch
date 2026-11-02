/**
 * inspect_results (openspec add-result-reflection, task 1.5): bounded reading of
 * persisted run outputs. Pure core (selection, sampling, paging) plus the disk
 * entry point `inspectResults` on temp campaigns.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/lens-inspect.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import {
  INSPECT_PAGE_BYTES,
  INSPECT_PAGE_LINES,
  currentEpochOf,
  inspectResults,
  ledgerAnalysisHeader,
  ledgerRunMetas,
  paginateBody,
  parseInspectArgs,
  pickBaseline,
  renderInspection,
  resolveExtractor,
  selectInspectRun,
} from "../extensions/pi-autoresearch/lens-inspect.ts";

// Helpers ------------------------------------------------------------------

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-inspect-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a campaign: config header (with optional analysis section), run records
 * and persisted outputs. `runs` entries: {run, status, metric, epoch?}; `outputs`
 * maps run number → output text (absent = no output.txt).
 */
function writeCampaign(dir, { runs = [], outputs = {}, analysis, direction = "lower", extraHeaders = [] } = {}) {
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const header = { type: "config", name: "t", metricName: "ms", metricUnit: "ms", bestDirection: direction };
  if (analysis !== undefined) header.analysis = analysis;
  const lines = [JSON.stringify(header), ...extraHeaders.map((h) => JSON.stringify(h))];
  for (const r of runs) {
    lines.push(JSON.stringify({ commit: "abc1234", description: `run ${r.run}`, timestamp: 1, segment: 0, asi: {}, ...r }));
  }
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), lines.join("\n") + "\n");
  for (const [n, text] of Object.entries(outputs)) {
    const runDir = path.join(autoDir, "runs", n);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "output.txt"), text);
  }
  return dir;
}

function lines(count, prefix = "line") {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

function bytes(text) {
  return new TextEncoder().encode(text).length;
}

// Links are created as in precedent-sources.test.mjs; a refusal means the host
// does not permit them (Windows without developer mode), and the test skips.
const IS_WINDOWS = process.platform === "win32";

function symlinkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, IS_WINDOWS ? "junction" : "dir");
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
    return false;
  }
}

/** Minimal InspectRender input for the pure renderer. */
function renderInput(overrides = {}) {
  return {
    meta: { run: 1, status: "keep", metric: 10 },
    epoch: 1,
    how: "requested",
    output: "METRIC ms=10\n",
    outputPath: ".auto/runs/1/output.txt",
    delta: { kind: "unavailable", reason: "не запрошена" },
    extractor: { kind: "all" },
    campaign: [],
    jsonl: { files: [], notes: [] },
    direction: "lower",
    page: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test("parseInspectArgs: defaults are run=undefined, extractor=undefined, page=1", () => {
  assert.deepEqual(parseInspectArgs({}), { ok: true, value: { run: undefined, extractor: undefined, page: 1 } });
});

test("parseInspectArgs: accepts integer run, digits-only string run, extractor, page", () => {
  assert.deepEqual(parseInspectArgs({ run: 45, extractor: "errors", page: 2 }).value, { run: 45, extractor: "errors", page: 2 });
  assert.equal(parseInspectArgs({ run: "45" }).value.run, 45);
});

test("parseInspectArgs: run=../x and other non-integer runs are rejected before any path is built", () => {
  for (const bad of ["../x", "../../etc", "1.5", "-1", "0", "4 5", "", 0, -3, 1.5, NaN, true, {}]) {
    const res = parseInspectArgs({ run: bad });
    assert.equal(res.ok, false, `run=${JSON.stringify(bad)} must be rejected`);
    assert.match(res.error, /run должен быть целым номером прогона >= 1/);
  }
});

test("parseInspectArgs: page must be an integer >= 1; empty extractor rejected", () => {
  assert.equal(parseInspectArgs({ page: 0 }).ok, false);
  assert.equal(parseInspectArgs({ page: 1.5 }).ok, false);
  assert.equal(parseInspectArgs({ page: "2" }).ok, false);
  assert.equal(parseInspectArgs({ extractor: "" }).ok, false);
});

// ---------------------------------------------------------------------------
// Run selection (pure)
// ---------------------------------------------------------------------------

const LEDGER_METAS = [
  { run: 1, status: "keep", metric: 10 },
  { run: 2, status: "discard", metric: 5 },
  { run: 3, status: "keep", metric: 7 },
  { run: 4, status: "keep", metric: 7 },
];

test("selectInspectRun: default is the best keep of the current epoch (lower is better, ties to earliest run)", () => {
  const res = selectInspectRun(LEDGER_METAS, undefined, "lower");
  assert.equal(res.ok, true);
  assert.equal(res.meta.run, 3);
  assert.equal(res.how, "best_keep");
  assert.equal(res.epoch, 1);
});

test("selectInspectRun: default honours direction higher", () => {
  const res = selectInspectRun(LEDGER_METAS, undefined, "higher");
  assert.equal(res.meta.run, 1);
});

test("selectInspectRun: no keep in the current epoch is an explicit error asking for a run number", () => {
  const metas = [{ run: 1, status: "discard", metric: 3 }, { run: 2, status: "crash", metric: null }];
  const res = selectInspectRun(metas, undefined, "lower");
  assert.equal(res.ok, false);
  assert.match(res.error, /нет keep-прогона/);
  assert.match(res.error, /run=<n>/);
});

test("selectInspectRun: keep runs only in an older epoch do not satisfy the default", () => {
  const metas = [
    { run: 1, status: "keep", metric: 3, epoch: 1 },
    { run: 2, status: "discard", metric: 9, epoch: 2 },
  ];
  assert.equal(currentEpochOf(metas), 2);
  const res = selectInspectRun(metas, undefined, "lower");
  assert.equal(res.ok, false);
  assert.match(res.error, /эпохе \(2\)/);
});

test("selectInspectRun: explicit run is used as given, even outside the current epoch", () => {
  const metas = [
    { run: 1, status: "keep", metric: 3, epoch: 1 },
    { run: 2, status: "discard", metric: 9, epoch: 2 },
  ];
  const res = selectInspectRun(metas, 1, "lower");
  assert.equal(res.ok, true);
  assert.equal(res.meta.run, 1);
  assert.equal(res.how, "requested");
  assert.equal(res.epoch, 1);
});

test("selectInspectRun: a run number absent from the ledger is an explicit error", () => {
  const res = selectInspectRun(LEDGER_METAS, 99, "lower");
  assert.equal(res.ok, false);
  assert.match(res.error, /прогон 99 не записан в леджер/);
});

test("selectInspectRun: empty ledger is an explicit message, not a crash", () => {
  const res = selectInspectRun([], undefined, "lower");
  assert.equal(res.ok, false);
  assert.match(res.error, /нет записанных прогонов/);
});

test("ledgerRunMetas: last record per run wins, unusable run numbers and non-run lines are skipped", () => {
  const ledger = [
    JSON.stringify({ type: "config", name: "x" }),
    JSON.stringify({ run: 1, status: "discard", metric: 9 }),
    JSON.stringify({ run: 1, status: "keep", metric: 8, epoch: 2 }),
    JSON.stringify({ run: 0, status: "keep", metric: 1 }),
    JSON.stringify({ run: 2.5, status: "keep", metric: 1 }),
    JSON.stringify({ type: "run_started", run_dir: 3 }),
    "not json",
  ].join("\n");
  assert.deepEqual(ledgerRunMetas(ledger), [{ run: 1, status: "keep", metric: 8, epoch: 2 }]);
});

test("ledgerAnalysisHeader: uses the LAST config header, undefined when it has no analysis key", () => {
  const ledger = [
    JSON.stringify({ type: "config", analysis: { artifacts: ["a"] } }),
    JSON.stringify({ type: "config" }),
  ].join("\n");
  assert.equal(ledgerAnalysisHeader(ledger), undefined);
});

test("pickBaseline: baseline is the best keep of the INSPECTED run's epoch; other epochs are reported, not compared", () => {
  const metas = [
    { run: 1, status: "keep", metric: 1, epoch: 1 },
    { run: 2, status: "keep", metric: 5, epoch: 2 },
    { run: 3, status: "keep", metric: 4, epoch: 2 },
  ];
  const pick = pickBaseline(metas, { run: 3, status: "keep", metric: 4, epoch: 2 }, "lower");
  assert.deepEqual(pick, { kind: "run", meta: metas[2] });

  const onlyOther = [{ run: 1, status: "keep", metric: 1, epoch: 1 }, { run: 2, status: "discard", metric: 9, epoch: 2 }];
  const none = pickBaseline(onlyOther, { run: 2, status: "discard", metric: 9, epoch: 2 }, "lower");
  assert.equal(none.kind, "none");
  assert.match(none.reason, /поперечные дельты заблокированы/);
});

// ---------------------------------------------------------------------------
// Extractor selection (pure)
// ---------------------------------------------------------------------------

test("resolveExtractor: absent = all; generic names; campaign names; unknown name lists what exists", () => {
  const campaign = [{ name: "failures", regex: "MISMATCH", sample: 5 }];
  assert.deepEqual(resolveExtractor(undefined, campaign), { ok: true, value: { kind: "all" } });
  assert.deepEqual(resolveExtractor("errors", campaign), { ok: true, value: { kind: "generic", name: "errors" } });
  assert.deepEqual(resolveExtractor("failures", campaign), { ok: true, value: { kind: "campaign", extractor: campaign[0] } });
  const unknown = resolveExtractor("nope", campaign);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Доступны: metric, errors, timing, delta, raw, failures/);
});

test("resolveExtractor: a campaign extractor named like a generic one takes precedence", () => {
  const campaign = [{ name: "errors", regex: "X" }];
  assert.deepEqual(resolveExtractor("errors", campaign).value, { kind: "campaign", extractor: campaign[0] });
});

// ---------------------------------------------------------------------------
// Pagination (pure): page boundaries 200 / 201 and the 8 KiB limit
// ---------------------------------------------------------------------------

test("paginateBody: 198 content lines fit on one page (198 + header + path = 200 lines), no next page", () => {
  const body = Array.from({ length: 198 }, (_, i) => `L${i + 1}`);
  const page = paginateBody(body, 1);
  assert.equal(page.pageCount, 1);
  assert.equal(page.lines.length, 198);
  assert.equal(page.firstLine, 1);
  assert.equal(page.lastLine, 198);
  assert.equal(paginateBody(body, 2), null);
});

test("paginateBody: 199 content lines need a footer, so page 1 holds 197 lines and page 2 holds the last two", () => {
  const body = Array.from({ length: 199 }, (_, i) => `L${i + 1}`);
  const first = paginateBody(body, 1);
  assert.equal(first.pageCount, 2);
  assert.equal(first.lines.length, 197);
  assert.equal(first.lastLine, 197);
  const second = paginateBody(body, 2);
  assert.deepEqual(second.lines, ["L198", "L199"]);
  assert.equal(second.firstLine, 198);
  assert.equal(second.lastLine, 199);
  assert.equal(paginateBody(body, 3), null);
  assert.equal(paginateBody(body, 0), null);
});

test("paginateBody: byte limit ends a page early; pages cover every line once, in order, each under 8 KiB", () => {
  const body = Array.from({ length: 120 }, (_, i) => `${i + 1}:` + "я".repeat(400));
  const seen = [];
  let page = 1;
  for (;;) {
    const slice = paginateBody(body, page);
    if (slice === null) break;
    const pageBytes = slice.lines.reduce((sum, l) => sum + bytes(l) + 1, 0);
    assert.ok(pageBytes <= INSPECT_PAGE_BYTES, `page ${page} content is ${pageBytes} bytes`);
    assert.ok(slice.lines.length <= INSPECT_PAGE_LINES);
    seen.push(...slice.lines);
    page++;
  }
  assert.ok(page - 1 > 1, "byte limit must produce several pages");
  assert.deepEqual(seen, body);
});

test("renderInspection: out-of-range page is an explicit error", () => {
  const res = renderInspection(renderInput({ page: 5 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /page 5 вне диапазона/);
});

test("renderInspection: truncated response carries the truncated marker and the next page hint", () => {
  const output = Array.from({ length: 450 }, (_, i) => `ERROR item ${i + 1}`).join("\n") + "\n";
  const campaign = [{ name: "errs", regex: "^ERROR", sample: 1000 }];
  const res = renderInspection(renderInput({
    output,
    campaign,
    extractor: { kind: "campaign", extractor: campaign[0] },
    page: 1,
  }));
  assert.equal(res.ok, true);
  assert.equal(res.details.pageCount > 1, true);
  assert.equal(res.details.truncated, true);
  assert.equal(res.details.nextPage, 2);
  assert.match(res.text, /truncated: true/);
  assert.match(res.text, /page=2/);
  assert.ok(bytes(res.text) <= INSPECT_PAGE_BYTES);
});

test("renderInspection: a long-line page stays within 8 KiB including header and footer", () => {
  const output = Array.from({ length: 300 }, (_, i) => `row ${i + 1} ` + "x".repeat(1000)).join("\n") + "\n";
  const campaign = [{ name: "rows_with_a_rather_long_extractor_name_for_the_header", regex: "^row", sample: 1000 }];
  const res = renderInspection(renderInput({
    output,
    extractor: { kind: "campaign", extractor: campaign[0] },
    campaign,
    page: 1,
  }));
  assert.equal(res.ok, true);
  assert.ok(bytes(res.text) <= INSPECT_PAGE_BYTES, `response is ${bytes(res.text)} bytes`);
  assert.ok(res.text.split("\n").length <= INSPECT_PAGE_LINES, `response is ${res.text.split("\n").length} lines`);
});

test("renderInspection: the whole response (text.split) is at most 200 lines on every page, around the 200/201 boundary", () => {
  // Matches + 1 section title = body lines. 197 + 1 = 198 body lines fit on one page (200 lines total);
  // one more line needs a footer, so the boundary moves to 197 per page.
  for (const matches of [196, 197, 198, 199, 200, 201, 394, 395, 396, 397, 398, 600]) {
    const output = Array.from({ length: matches }, (_, i) => `ERR ${i + 1}`).join("\n") + "\n";
    const campaign = [{ name: "errs", regex: "^ERR", sample: 1000000 }];
    const extractor = { kind: "campaign", extractor: campaign[0] };
    const first = renderInspection(renderInput({ output, campaign, extractor, page: 1 }));
    assert.equal(first.ok, true);
    assert.equal(first.details.totalLines, matches + 1, `matches=${matches}`);
    const pageCount = first.details.pageCount;
    const numbers = [];
    for (let page = 1; page <= pageCount; page++) {
      const res = renderInspection(renderInput({ output, campaign, extractor, page }));
      assert.equal(res.ok, true, `matches=${matches} page=${page}`);
      const total = res.text.split("\n").length;
      assert.ok(total <= INSPECT_PAGE_LINES, `matches=${matches} page=${page}: ${total} lines`);
      assert.ok(bytes(res.text) <= INSPECT_PAGE_BYTES, `matches=${matches} page=${page}: ${bytes(res.text)} bytes`);
      for (const m of res.text.matchAll(/^ {2}L\d+: ERR (\d+)$/gm)) numbers.push(Number(m[1]));
      if (pageCount === 1) {
        assert.doesNotMatch(res.text, /truncated/);
      } else if (page < pageCount) {
        assert.match(res.text, new RegExp(`truncated: true.*page=${page + 1}`));
      } else {
        assert.match(res.text, /конец: .*truncated: false/);
      }
    }
    assert.deepEqual(numbers, Array.from({ length: matches }, (_, i) => i + 1), `matches=${matches}`);
  }
});

// ---------------------------------------------------------------------------
// Pure sampling through renderInspection
// ---------------------------------------------------------------------------

test("delta: lines added and removed against the baseline output, with their own line numbers", () => {
  const res = renderInspection(renderInput({
    meta: { run: 2, status: "keep", metric: 1 },
    output: "a\nc\nd\n",
    delta: { kind: "run", meta: { run: 1, status: "keep", metric: 0.5 }, output: "a\nb\nc\n" },
    extractor: { kind: "generic", name: "delta" },
    epoch: 1,
  }));
  assert.equal(res.ok, true);
  assert.match(res.text, /## delta vs run 1 \(лучший keep эпохи 1\): \+1 −1/);
  assert.match(res.text, /\+ L3: d/);
  assert.match(res.text, /− L2: b/);
});

test("delta: incomparable output sizes (more than 2x) give head/tail of both instead of line diff", () => {
  const big = Array.from({ length: 100 }, (_, i) => `big ${i}`).join("\n");
  const res = renderInspection(renderInput({
    meta: { run: 2, status: "keep", metric: 1 },
    output: "tiny\n",
    delta: { kind: "run", meta: { run: 1, status: "keep", metric: 0.5 }, output: big },
    extractor: { kind: "generic", name: "delta" },
  }));
  assert.match(res.text, /несоизмеримые объёмы/);
  assert.match(res.text, /базовый run 1: строк 100/);
});

test("delta: unavailable baseline is explained, not computed", () => {
  const res = renderInspection(renderInput({
    extractor: { kind: "generic", name: "delta" },
    delta: { kind: "unavailable", reason: "нет keep-прогона в эпохе 1" },
  }));
  assert.match(res.text, /## delta: недоступна, нет keep-прогона в эпохе 1/);
});

test("timing: normalized to ms and sorted descending (µs and s converted)", () => {
  const output = "took 2 s\nfast 900µs\nslow 15ms\nnothing here\n";
  const res = renderInspection(renderInput({ output, extractor: { kind: "generic", name: "timing" } }));
  const order = [...res.text.matchAll(/L(\d+): /g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [1, 3, 2]);
  assert.match(res.text, /2s \(2000 мс\)/);
  assert.match(res.text, /900µs \(0\.9 мс\)/);
});

test("default view: raw head/tail appears only when no extractor matched anything", () => {
  const matched = renderInspection(renderInput({ output: "METRIC ms=10\nplain\n" }));
  assert.doesNotMatch(matched.text, /raw head\/tail/);
  const nothing = renderInspection(renderInput({ output: "plain one\nplain two\n" }));
  assert.match(nothing.text, /raw head\/tail \(ни один экстрактор не нашёл данных\)/);
  assert.match(nothing.text, /L2: plain two/);
});

test("campaign regex extractor: captured groups as JSON, sample limit, total kept", () => {
  const output = "MISMATCH gold=A pred=B\nok\nMISMATCH gold=C pred=D\nMISMATCH gold=E pred=F\n";
  const campaign = [{ name: "failures", regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 2 }];
  const res = renderInspection(renderInput({
    output,
    campaign,
    extractor: { kind: "campaign", extractor: campaign[0] },
  }));
  assert.match(res.text, /## extractor failures \(regex\): совпадений 3, показано 2/);
  assert.match(res.text, /L1: \["A","B"\]/);
  assert.match(res.text, /L3: \["C","D"\]/);
  assert.doesNotMatch(res.text, /L4:/);
});

test("campaign json_path extractor: values from JSONL copies listed in the run manifest", () => {
  const campaign = [{ name: "items", jsonPath: "result.score", sample: 5 }];
  const res = renderInspection(renderInput({
    campaign,
    extractor: { kind: "campaign", extractor: campaign[0] },
    jsonl: {
      files: [{ file: "results.jsonl", text: '{"result":{"score":0.5}}\nnot json\n{"other":1}\n{"result":{"score":0.9}}\n' }],
      notes: [],
    },
  }));
  assert.match(res.text, /записей 4, с путём 2, нечитаемых 1, показано 2/);
  assert.match(res.text, /results\.jsonl L1: 0\.5/);
  assert.match(res.text, /results\.jsonl L4: 0\.9/);
});

test("campaign json_path without copies explains why there is no data", () => {
  const campaign = [{ name: "items", jsonPath: "a", sample: 5 }];
  const res = renderInspection(renderInput({
    campaign,
    extractor: { kind: "campaign", extractor: campaign[0] },
    jsonl: { files: [], notes: ["манифеста нет"] },
  }));
  assert.match(res.text, /нет данных, манифеста нет/);
});

// ---------------------------------------------------------------------------
// Disk entry point: inspectResults
// ---------------------------------------------------------------------------

test("default call: shows the best keep of the current epoch (run number, epoch, metric in the header)", () => {
  const dir = writeCampaign(makeTempDir("default"), {
    runs: [
      { run: 1, status: "keep", metric: 10 },
      { run: 2, status: "keep", metric: 6 },
      { run: 3, status: "discard", metric: 1 },
    ],
    outputs: { 1: "METRIC ms=10\n", 2: "METRIC ms=6\n", 3: "METRIC ms=1\n" },
  });
  const res = inspectResults(dir, {});
  assert.match(res.text, /^🔎 inspect_results · прогон 2 \(лучший keep эпохи 1\) · эпоха 1 · status keep, metric=6/m);
  assert.match(res.text, /вывод: \.auto\/runs\/2\/output\.txt/);
  assert.match(res.text, /METRIC: 1\n {2}ms = 6/);
  assert.equal(res.details.run, 2);
  assert.equal(res.details.truncated, false);
});

test("no keep run: explicit error, no output is read", () => {
  const dir = writeCampaign(makeTempDir("nokeep"), {
    runs: [{ run: 1, status: "discard", metric: 3 }],
    outputs: { 1: "METRIC ms=3\n" },
  });
  const res = inspectResults(dir, {});
  assert.match(res.text, /^❌ inspect_results: в текущей эпохе \(1\) нет keep-прогона/);
  assert.equal(res.details.error !== undefined, true);
  const explicit = inspectResults(dir, { run: 1 });
  assert.match(explicit.text, /прогон 1 · эпоха 1 · status discard/);
});

test("specific run: the requested run is shown, with delta against the best keep of its epoch", () => {
  const dir = writeCampaign(makeTempDir("specific"), {
    runs: [
      { run: 1, status: "keep", metric: 5 },
      { run: 2, status: "discard", metric: 9 },
    ],
    outputs: { 1: "build ok\nMETRIC ms=5\n", 2: "build ok\nMETRIC ms=9\nerror: flaky\n" },
  });
  const res = inspectResults(dir, { run: 2, extractor: "delta" });
  assert.match(res.text, /прогон 2 · эпоха 1 · status discard/);
  assert.match(res.text, /## delta vs run 1/);
  assert.match(res.text, /\+ L2: METRIC ms=9/);
  assert.equal(res.details.run, 2);
});

test("missing output.txt: honest warning with the path and the advice to re-run, not a crash", () => {
  const dir = writeCampaign(makeTempDir("nooutput"), {
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: {},
  });
  const res = inspectResults(dir, {});
  assert.match(res.text, /^⚠️ inspect_results: вывод прогона 1 не персистирован \(\.auto\/runs\/1\/output\.txt отсутствует\)/);
  assert.match(res.text, /run_experiment/);
  assert.equal(res.details.status, "output_missing");
});

test("missing run: explicit message listing what is recorded", () => {
  const dir = writeCampaign(makeTempDir("norun"), {
    runs: [{ run: 1, status: "keep", metric: 5 }, { run: 2, status: "keep", metric: 4 }],
    outputs: { 1: "x\n", 2: "y\n" },
  });
  const res = inspectResults(dir, { run: 7 });
  assert.match(res.text, /^❌ inspect_results: прогон 7 не записан в леджер/);
  assert.match(res.text, /2 шт., номера 1…2/);
});

test("empty ledger: explicit message in every shape (no file, header only)", () => {
  const noFile = makeTempDir("empty-nofile");
  assert.match(inspectResults(noFile, {}).text, /нет записанных прогонов/);

  const headerOnly = writeCampaign(makeTempDir("empty-header"), { runs: [] });
  assert.match(inspectResults(headerOnly, {}).text, /нет записанных прогонов/);
  assert.match(inspectResults(headerOnly, { run: 1 }).text, /нет записанных прогонов/);
});

test("ledger with runs but no .auto/runs directory (pre-lens campaign): output_missing with the re-run advice", () => {
  const dir = makeTempDir("prelens");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), [
    JSON.stringify({ type: "config", name: "t", bestDirection: "lower" }),
    JSON.stringify({ run: 1, status: "keep", metric: 5, commit: "abc" }),
  ].join("\n") + "\n");
  const res = inspectResults(dir, {});
  assert.equal(res.details.status, "output_missing");
  assert.match(res.text, /перезапустите замер через run_experiment/i);
});

test("analysis.extractors from the header: regex extractor shows the gold/pred pairs of the default run", () => {
  const analysis = {
    extractors: {
      failures: { regex: "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", sample: 10 },
      hotspots: { timing_line: true, top: 2 },
    },
  };
  const dir = writeCampaign(makeTempDir("analysis"), {
    analysis,
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "MISMATCH gold=заместитель pred=зампред\nparse 40 ms\nMISMATCH gold=x pred=y\n" },
  });
  const res = inspectResults(dir, {});
  assert.match(res.text, /## extractor failures \(regex\): совпадений 2, показано 2/);
  assert.match(res.text, /L1: \["заместитель","зампред"\]/);
  assert.match(res.text, /## extractor hotspots \(timing\)/);

  const only = inspectResults(dir, { extractor: "failures" });
  assert.match(only.text, /extractor failures/);
  assert.doesNotMatch(only.text, /## METRIC/);
});

test("unknown extractor name is an explicit error that lists the available names", () => {
  const dir = writeCampaign(makeTempDir("unknown-ext"), {
    analysis: { extractors: { failures: { regex: "X" } } },
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "X\n" },
  });
  const res = inspectResults(dir, { extractor: "nope" });
  assert.match(res.text, /^❌ inspect_results: неизвестный экстрактор "nope"/);
  assert.match(res.text, /failures/);
});

test("invalid analysis header is an explicit error, not silence", () => {
  const dir = writeCampaign(makeTempDir("bad-analysis"), {
    analysis: { extractors: { broken: { regex: "(" } } },
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "x\n" },
  });
  const res = inspectResults(dir, {});
  assert.match(res.text, /analysis в заголовке леджера невалиден/);
  assert.match(res.text, /analysis\.extractors\.broken\.regex/);
});

test("8 KiB limit on the real path: long lines are paged, every page under the byte limit, contents contiguous", () => {
  const output = Array.from({ length: 300 }, (_, i) => `row ${i + 1} ` + "я".repeat(900)).join("\n") + "\n";
  const analysis = { extractors: { rows: { regex: "^row", sample: 1000 } } };
  const dir = writeCampaign(makeTempDir("bytes"), {
    analysis,
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: output },
  });
  const first = inspectResults(dir, { extractor: "rows" });
  assert.ok(bytes(first.text) <= INSPECT_PAGE_BYTES, `page 1 is ${bytes(first.text)} bytes`);
  assert.equal(first.details.truncated, true);
  const pageCount = first.details.pageCount;
  assert.ok(pageCount >= 2);
  const rowNumbers = [];
  for (let page = 1; page <= pageCount; page++) {
    const res = inspectResults(dir, { extractor: "rows", page });
    assert.ok(bytes(res.text) <= INSPECT_PAGE_BYTES, `page ${page} is ${bytes(res.text)} bytes`);
    for (const m of res.text.matchAll(/^ {2}L\d+: row (\d+) /gm)) rowNumbers.push(Number(m[1]));
  }
  assert.deepEqual(rowNumbers, Array.from({ length: 300 }, (_, i) => i + 1));
});

test("page out of range on the real path is an explicit error with the page count", () => {
  const dir = writeCampaign(makeTempDir("page-range"), {
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "METRIC ms=5\n" },
  });
  const res = inspectResults(dir, { page: 3 });
  assert.match(res.text, /^❌ inspect_results: page 3 вне диапазона/);
});

test("epoch: the default run and its baseline come from the current epoch only", () => {
  const dir = writeCampaign(makeTempDir("epoch"), {
    runs: [
      { run: 1, status: "keep", metric: 1, epoch: 1 },
      { run: 2, status: "keep", metric: 9, epoch: 2 },
      { run: 3, status: "keep", metric: 8, epoch: 2 },
    ],
    outputs: { 1: "METRIC ms=1\n", 2: "METRIC ms=9\n", 3: "METRIC ms=8\n" },
  });
  // Default: best keep of epoch 2 (run 3), not run 1 (better metric, older epoch).
  const def = inspectResults(dir, { extractor: "delta" });
  assert.equal(def.details.run, 3);
  assert.equal(def.details.epoch, 2);
  assert.match(def.text, /лучший keep эпохи 2/);
  assert.match(def.text, /## delta: прогон сам является лучшим keep эпохи/);
  // Explicit run 2 (epoch 2): baseline is run 3, the best keep of ITS epoch.
  const explicit = inspectResults(dir, { run: 2, extractor: "delta" });
  assert.equal(explicit.details.epoch, 2);
  assert.match(explicit.text, /## delta vs run 3/);
  assert.doesNotMatch(explicit.text, /delta vs run 1/);
});

test("delta: baseline output missing is explained, the response still answers", () => {
  const dir = writeCampaign(makeTempDir("base-missing"), {
    runs: [
      { run: 1, status: "keep", metric: 1 },
      { run: 2, status: "discard", metric: 9 },
    ],
    outputs: { 2: "METRIC ms=9\n" },
  });
  const res = inspectResults(dir, { run: 2, extractor: "delta" });
  assert.match(res.text, /## delta: недоступна, у базового прогона 1 нет \.auto\/runs\/1\/output\.txt/);
});

test("path traversal: run=../x is rejected and nothing outside .auto/runs is read", () => {
  const dir = writeCampaign(makeTempDir("traversal-run"), {
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "METRIC ms=5\n" },
  });
  fs.writeFileSync(path.join(dir, ".auto", "x"), "SECRET-RUN-MARKER\n");
  const res = inspectResults(dir, { run: "../x" });
  assert.match(res.text, /^❌ inspect_results: run должен быть целым номером прогона >= 1/);
  assert.doesNotMatch(res.text, /SECRET-RUN-MARKER/);
});

test("path traversal: a manifest-declared JSONL copy outside the run directory is never read", () => {
  const dir = writeCampaign(makeTempDir("traversal-manifest"), {
    analysis: { extractors: { items: { json_path: "v", sample: 5 } } },
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "METRIC ms=5\n" },
  });
  fs.writeFileSync(path.join(dir, ".auto", "outside.jsonl"), '{"v":"SECRET-MANIFEST-MARKER"}\n');
  fs.writeFileSync(
    path.join(dir, ".auto", "runs", "1", "manifest.json"),
    JSON.stringify({ run: 1, output: "output.txt", measurement_files: [], artifacts: [
      { declared: "outside.jsonl", copied: true, file: "../../outside.jsonl", bytes: 1 },
    ] }),
  );
  const res = inspectResults(dir, { extractor: "items" });
  assert.doesNotMatch(res.text, /SECRET-MANIFEST-MARKER/);
  assert.match(res.text, /вне каталога прогона 1/);
});

test("json_path reads the run's own JSONL copy from the manifest (only .auto/runs/<n>/)", () => {
  const dir = writeCampaign(makeTempDir("manifest-ok"), {
    analysis: { extractors: { items: { json_path: "v", sample: 5 } } },
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "METRIC ms=5\n" },
  });
  const runDir = path.join(dir, ".auto", "runs", "1");
  fs.writeFileSync(path.join(runDir, "eval.jsonl"), '{"v":42}\n');
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify({ run: 1, output: "output.txt", measurement_files: [], artifacts: [
      { declared: "eval.jsonl", copied: true, file: "eval.jsonl", bytes: 8 },
    ] }),
  );
  const res = inspectResults(dir, { extractor: "items" });
  assert.match(res.text, /eval\.jsonl L1: 42/);
});

test("no ledger file and no analysis: default call is the empty-ledger message, never a throw", () => {
  const dir = makeTempDir("no-ledger");
  const res = inspectResults(dir, { run: 1 });
  assert.match(res.text, /нет записанных прогонов/);
  assert.equal(typeof res.details.error, "string");
});

// ---------------------------------------------------------------------------
// Symlinks: nothing outside workDir is read; ordinary directories still work
// ---------------------------------------------------------------------------

test("symlinked .auto/runs pointing outside workDir: nothing is read, explicit error", (t) => {
  const root = makeTempDir("link-runs-root");
  const outside = makeTempDir("link-runs-outside");
  fs.mkdirSync(path.join(outside, "1"), { recursive: true });
  fs.writeFileSync(path.join(outside, "1", "output.txt"), "OUTSIDE-RUNS-MARKER\nMETRIC ms=5\n");
  writeCampaign(root, { runs: [{ run: 1, status: "keep", metric: 5 }] });
  if (!symlinkDir(outside, path.join(root, ".auto", "runs"))) {
    t.skip("directory links not permitted on this host");
    return;
  }
  const res = inspectResults(root, {});
  assert.doesNotMatch(res.text, /OUTSIDE-RUNS-MARKER/);
  assert.match(res.text, /^❌ inspect_results: \.auto\/runs ведёт за пределы рабочего каталога, чтение отклонено/);
  assert.equal(typeof res.details.error, "string");
});

test("symlinked .auto/log.jsonl pointing outside workDir: the ledger is not read, explicit error", (t) => {
  const root = makeTempDir("link-log-root");
  const outside = makeTempDir("link-log-outside");
  writeCampaign(outside, { runs: [{ run: 1, status: "keep", metric: 5, description: "OUTSIDE-LEDGER-MARKER" }] });
  fs.mkdirSync(path.join(root, ".auto"), { recursive: true });
  if (!symlinkFile(path.join(outside, ".auto", "log.jsonl"), path.join(root, ".auto", "log.jsonl"))) {
    t.skip("file links not permitted on this host");
    return;
  }
  const res = inspectResults(root, {});
  assert.doesNotMatch(res.text, /OUTSIDE-LEDGER-MARKER/);
  assert.match(res.text, /^❌ inspect_results: леджер .* ведёт за пределы рабочего каталога, чтение отклонено/);
  assert.equal(typeof res.details.error, "string");
});

test("symlinked .auto directory pointing outside workDir: the ledger is refused before it is read", (t) => {
  const root = makeTempDir("link-autodir-root");
  const outside = makeTempDir("link-autodir-outside");
  writeCampaign(outside, { runs: [{ run: 1, status: "keep", metric: 5, description: "OUTSIDE-AUTODIR-MARKER" }] });
  if (!symlinkDir(path.join(outside, ".auto"), path.join(root, ".auto"))) {
    t.skip("directory links not permitted on this host");
    return;
  }
  const res = inspectResults(root, { run: 1 });
  assert.doesNotMatch(res.text, /OUTSIDE-AUTODIR-MARKER/);
  assert.match(res.text, /ведёт за пределы рабочего каталога, чтение отклонено/);
});

test("output.txt symlinked to a file outside the run directory is refused, not read", (t) => {
  const root = makeTempDir("link-output-root");
  const outsideFile = path.join(makeTempDir("link-output-outside"), "secret.txt");
  fs.writeFileSync(outsideFile, "OUTSIDE-OUTPUT-MARKER\n");
  writeCampaign(root, { runs: [{ run: 1, status: "keep", metric: 5 }] });
  const runDir = path.join(root, ".auto", "runs", "1");
  fs.mkdirSync(runDir, { recursive: true });
  if (!symlinkFile(outsideFile, path.join(runDir, "output.txt"))) {
    t.skip("file links not permitted on this host");
    return;
  }
  const res = inspectResults(root, {});
  assert.doesNotMatch(res.text, /OUTSIDE-OUTPUT-MARKER/);
  assert.match(res.text, /output\.txt лежит вне каталога прогона 1, чтение отклонено/);
});

// ---------------------------------------------------------------------------
// Tool wiring (index.ts): same mode gate as record_finding
// ---------------------------------------------------------------------------

async function loadExtensionSession(dir, sessionId = "inspect") {
  const { pi, tool, command } = createFakePi({ dir, sessionId, realGit: false });
  const ctx = makeCtx(dir, sessionId, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { tool, command, ctx };
}

test("tool wiring: inspect_results refuses when autoresearch mode is off and answers when it is on", async () => {
  const dir = writeCampaign(makeTempDir("wiring"), {
    runs: [{ run: 1, status: "keep", metric: 5 }],
    outputs: { 1: "METRIC ms=5\n" },
  });
  const session = await loadExtensionSession(dir);
  const off = await session.tool("inspect_results").execute("id", {}, null, null, session.ctx);
  assert.equal(off.content[0].text, "Autoresearch mode is OFF. Run /autoresearch on first.");

  await session.command("autoresearch").handler("on", session.ctx);
  const on = await session.tool("inspect_results").execute("id", {}, null, null, session.ctx);
  assert.match(on.content[0].text, /^🔎 inspect_results · прогон 1/);
  assert.equal(on.details.run, 1);
});
