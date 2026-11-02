/**
 * inspect_results — bounded reading of persisted run outputs (openspec
 * add-result-reflection, task 1.5; spec result-lens: "Инструмент
 * inspect_results", "Generic-экстракторы", "Конфигурируемые экстракторы
 * кампании", "Ограничение объёма ответа").
 *
 * Reads ONLY persisted artifacts: the ledger `.auto/log.jsonl` (run metadata
 * and the analysis config header) and the run directory `.auto/runs/<n>/`
 * (output.txt, manifest.json and the JSONL copies the manifest lists). Never
 * the original workDir artifacts. A run number is validated as a positive
 * integer before any path is built. Symlinks are checked level by level: the
 * ledger must resolve inside the realpath of workDir; `.auto/runs` must resolve
 * inside it; the run directory inside `.auto/runs`; each file inside its run
 * directory. Nothing is read before the chain of checks passes.
 *
 * Structure: selection, sampling, rendering and paging are pure (explicit
 * inputs, returns text and details). `inspectResults` is the only function
 * that touches the disk; index.ts only wires the tool behind the same mode and
 * workDir gates as record_finding.
 *
 * Response shape: a whole response (header, output-path line, content and,
 * only when there is more than one page, the footer) is at most 200 lines and
 * 8 KiB. The meta lines are subtracted from the content page, so the limit
 * holds for the rendered text itself. Pages are filled greedily: a page ends
 * early when the next line would exceed the byte budget, and the next page
 * continues from that line, so no line is ever dropped. Each long line is
 * clamped to 500 characters (the full text stays in output.txt at the reported
 * line number).
 *
 * Epoch: records without an `epoch` belong to epoch 1 (runEpoch). The current
 * epoch is the highest epoch among logged runs, so the default run is the best
 * keep of that epoch. The delta baseline is the best keep of the INSPECTED
 * run's epoch; cross-epoch deltas are never computed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_DIR, sessionFilePath } from "./paths.ts";
import { runsRootPath } from "./lens.ts";
import {
  parseAnalysisConfig,
  type AnalysisExtractor,
  type JsonPathExtractor,
  type RegexExtractor,
  type TimingExtractor,
} from "./lens-config.ts";
import { isAutoresearchRunEntry, parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import {
  DEFAULT_EPOCH,
  DELTA_RATIO_LIMIT,
  diffAgainstBest,
  extractErrorWarnLines,
  extractMetricLines,
  extractTimingLines,
  headTail,
  selectBestKeep,
  type Direction,
  type HeadTail,
  type LensRun,
  type LineHit,
} from "./lens-extractors.ts";

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** Lines of the whole response, including meta lines (spec: ≤200 строк). */
export const INSPECT_PAGE_LINES = 200;
/** Bytes of the whole response's content budget (spec: ≤8 KiB). */
export const INSPECT_PAGE_BYTES = 8 * 1024;
/** Bytes kept out of the content budget for the header, output path and footer lines. */
const META_RESERVE_BYTES = 1536;
/** Always present: the header line and the output-path line. */
const HEAD_META_LINES = 2;
/** Present only when the response has more than one page. */
const FOOTER_META_LINES = 1;
/** Longer lines are clamped; the full text stays in output.txt. */
const LINE_CHARS = 500;

const ERROR_SAMPLE = 20;
const TIMING_TOP = 10;
const HEAD_LINES = 20;
const TAIL_LINES = 20;
const REGEX_SAMPLE_DEFAULT = 20;
const TIMING_LINE_TOP_DEFAULT = 10;
const JSON_PATH_SAMPLE_DEFAULT = 20;

export const GENERIC_EXTRACTOR_NAMES = ["metric", "errors", "timing", "delta", "raw"] as const;
export type GenericExtractorName = (typeof GENERIC_EXTRACTOR_NAMES)[number];

const OUTPUT_FILE = "output.txt";
const MANIFEST_FILE = "manifest.json";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface InspectArgs {
  run?: unknown;
  extractor?: unknown;
  page?: unknown;
}

export interface ParsedInspectArgs {
  run: number | undefined;
  extractor: string | undefined;
  page: number;
}

/** A logged run without its output (ledger metadata). */
export interface RunMeta {
  run: number;
  status: string;
  metric: number | null;
  epoch?: number;
}

export type RunSelection =
  | { ok: true; meta: RunMeta; epoch: number; how: "requested" | "best_keep" }
  | { ok: false; error: string };

export type BaselinePick =
  | { kind: "run"; meta: RunMeta }
  | { kind: "none"; reason: string };

export type DeltaSource =
  | { kind: "run"; meta: RunMeta; output: string }
  | { kind: "unavailable"; reason: string };

export interface JsonlSource {
  files: { file: string; text: string }[];
  /** Why some or all JSONL artifacts are not available (missing manifest, unreadable copy, ...). */
  notes: string[];
}

export type ExtractorSelection =
  | { kind: "all" }
  | { kind: "generic"; name: GenericExtractorName }
  | { kind: "campaign"; extractor: AnalysisExtractor };

export interface InspectRender {
  meta: RunMeta;
  epoch: number;
  how: "requested" | "best_keep";
  output: string;
  /** Path shown to the agent, relative to the workDir (e.g. `.auto/runs/45/output.txt`). */
  outputPath: string;
  delta: DeltaSource;
  extractor: ExtractorSelection;
  /** analysis.extractors of the campaign, in declaration order. */
  campaign: readonly AnalysisExtractor[];
  jsonl: JsonlSource;
  direction: Direction;
  page: number;
}

export type InspectRenderResult =
  | { ok: true; text: string; details: Record<string, unknown> }
  | { ok: false; error: string };

export interface InspectResponse {
  text: string;
  details: Record<string, unknown>;
}

export interface PageSlice {
  page: number;
  pageCount: number;
  lines: string[];
  /** 1-based inclusive range of content lines shown on this page. */
  firstLine: number;
  lastLine: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clampLine(text: string): string {
  if (text.length <= LINE_CHARS) return text;
  return `${text.slice(0, LINE_CHARS)} …(+${text.length - LINE_CHARS} симв.)`;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withOutput(meta: RunMeta, output: string): LensRun {
  return { run: meta.run, status: meta.status, metric: meta.metric, epoch: meta.epoch, output };
}

function metaEpoch(meta: RunMeta): number {
  return meta.epoch ?? DEFAULT_EPOCH;
}

/** Output split into lines, same rules as lens-extractors (single trailing newline ignored, CR stripped). */
function splitOutputLines(output: string): string[] {
  if (output === "") return [];
  const parts = output.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isGenericName(name: string): name is GenericExtractorName {
  return (GENERIC_EXTRACTOR_NAMES as readonly string[]).includes(name);
}

// ──────────────────────────────────────────────────────────────────────────
// Arguments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate tool arguments. `run` accepts an integer >= 1 or a digits-only
 * string; anything else (including `../x`) is rejected before it can reach a
 * path. `page` defaults to 1.
 */
export function parseInspectArgs(args: InspectArgs): ParseResult<ParsedInspectArgs> {
  let run: number | undefined;
  if (args.run !== undefined && args.run !== null) {
    const raw = args.run;
    const numeric = typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 1) {
      return { ok: false, error: `run должен быть целым номером прогона >= 1 (получено: ${JSON.stringify(raw)})` };
    }
    run = numeric;
  }

  let extractor: string | undefined;
  if (args.extractor !== undefined && args.extractor !== null) {
    if (typeof args.extractor !== "string" || args.extractor.length === 0) {
      return { ok: false, error: `extractor должен быть непустой строкой (получено: ${JSON.stringify(args.extractor)})` };
    }
    extractor = args.extractor;
  }

  let page = 1;
  if (args.page !== undefined && args.page !== null) {
    if (typeof args.page !== "number" || !Number.isSafeInteger(args.page) || args.page < 1) {
      return { ok: false, error: `page должен быть целым числом >= 1 (получено: ${JSON.stringify(args.page)})` };
    }
    page = args.page;
  }

  return { ok: true, value: { run, extractor, page } };
}

// ──────────────────────────────────────────────────────────────────────────
// Ledger (pure: takes the raw .auto/log.jsonl text)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Run metadata from the ledger, one entry per run number (the last record
 * for a number wins). Records without a usable run number are skipped.
 */
export function ledgerRunMetas(ledgerText: string): RunMeta[] {
  const byRun = new Map<number, RunMeta>();
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!isAutoresearchRunEntry(entry)) continue;
    if (!Number.isSafeInteger(entry.run) || entry.run < 1) continue;
    const meta: RunMeta = {
      run: entry.run,
      status: typeof entry.status === "string" ? entry.status : "",
      metric: typeof entry.metric === "number" && Number.isFinite(entry.metric) ? entry.metric : null,
    };
    if (typeof entry.epoch === "number" && Number.isSafeInteger(entry.epoch) && entry.epoch >= 1) {
      meta.epoch = entry.epoch;
    }
    byRun.set(entry.run, meta);
  }
  return [...byRun.values()];
}

/** Optimization direction from the last config header (lower when absent). */
export function ledgerDirection(ledgerText: string): Direction {
  return reconstructJsonlState(ledgerText).bestDirection;
}

/**
 * The `analysis` value of the LAST config header (undefined when there is no
 * header or it carries no analysis key). Same rule as index.ts
 * readLastConfigHeaderAnalysis, which is used for the run manifest.
 */
export function ledgerAnalysisHeader(ledgerText: string): unknown {
  const lines = ledgerText.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonlEntry(lines[i]);
    if (entry && entry.type === "config") return entry.analysis;
  }
  return undefined;
}

/** Current epoch: the highest epoch among logged runs (DEFAULT_EPOCH when there are none). */
export function currentEpochOf(metas: readonly RunMeta[]): number {
  let epoch = DEFAULT_EPOCH;
  for (const meta of metas) epoch = Math.max(epoch, metaEpoch(meta));
  return epoch;
}

function describeRuns(metas: readonly RunMeta[]): string {
  if (metas.length === 0) return "нет";
  const numbers = metas.map((m) => m.run);
  return `${metas.length} шт., номера ${Math.min(...numbers)}…${Math.max(...numbers)}`;
}

/**
 * Pick the inspected run. An explicit run must be in the ledger. Without one,
 * the best keep of the current epoch is used; when there is none, the result
 * is an explicit error asking for a run number (no silent fallback).
 */
export function selectInspectRun(
  metas: readonly RunMeta[],
  requested: number | undefined,
  direction: Direction,
): RunSelection {
  if (metas.length === 0) {
    return {
      ok: false,
      error: "в леджере (.auto/log.jsonl) нет записанных прогонов, инспектировать нечего. Запустите замер через run_experiment и log_experiment.",
    };
  }
  const epoch = currentEpochOf(metas);
  if (requested !== undefined) {
    const meta = metas.find((m) => m.run === requested);
    if (!meta) {
      return { ok: false, error: `прогон ${requested} не записан в леджер (.auto/log.jsonl). Записанные прогоны: ${describeRuns(metas)}.` };
    }
    return { ok: true, meta, epoch: metaEpoch(meta), how: "requested" };
  }
  const best = selectBestKeep(metas.map((m) => withOutput(m, "")), epoch, direction);
  const meta = best === null ? undefined : metas.find((m) => m.run === best.run);
  if (!meta) {
    return {
      ok: false,
      error: `в текущей эпохе (${epoch}) нет keep-прогона, лучший прогон по умолчанию не определён. Укажите номер прогона: inspect_results с run=<n> (записанные прогоны: ${describeRuns(metas)}).`,
    };
  }
  return { ok: true, meta, epoch, how: "best_keep" };
}

/**
 * Baseline for the delta: best keep of the INSPECTED run's epoch. Keep runs
 * that exist only in other epochs are reported, not compared.
 */
export function pickBaseline(metas: readonly RunMeta[], current: RunMeta, direction: Direction): BaselinePick {
  const epoch = metaEpoch(current);
  const best = selectBestKeep(metas.map((m) => withOutput(m, "")), epoch, direction);
  const meta = best === null ? undefined : metas.find((m) => m.run === best.run);
  if (meta) return { kind: "run", meta };
  const otherEpochKeep = metas.some((m) => m.status === "keep" && metaEpoch(m) !== epoch);
  let reason = `нет keep-прогона в эпохе ${epoch}, с которым можно сравнить`;
  if (otherEpochKeep) reason += "; keep-прогоны есть только в других эпохах, поперечные дельты заблокированы";
  return { kind: "none", reason };
}

// ──────────────────────────────────────────────────────────────────────────
// Extractor selection
// ──────────────────────────────────────────────────────────────────────────

/**
 * `extractor` argument: a campaign extractor name (checked first, so campaign
 * authors' names always resolve), a generic name, or absent (= all).
 */
export function resolveExtractor(
  name: string | undefined,
  campaign: readonly AnalysisExtractor[],
): ParseResult<ExtractorSelection> {
  if (name === undefined) return { ok: true, value: { kind: "all" } };
  const extractor = campaign.find((e) => e.name === name);
  if (extractor) return { ok: true, value: { kind: "campaign", extractor } };
  if (isGenericName(name)) return { ok: true, value: { kind: "generic", name } };
  const available = [...GENERIC_EXTRACTOR_NAMES, ...campaign.map((e) => e.name)].join(", ");
  return {
    ok: false,
    error: `неизвестный экстрактор "${name}". Доступны: ${available} (без параметра: все генерик-экстракторы и экстракторы кампании).`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Sections (pure: each returns content lines)
// ──────────────────────────────────────────────────────────────────────────

function lineRef(hit: LineHit): string {
  return `  L${hit.lineNo}: ${clampLine(hit.text)}`;
}

function headTailLines(label: string, ht: HeadTail): string[] {
  const lines = [`  ${label}: строк ${ht.totalLines}`];
  for (const hit of ht.head) lines.push(lineRef(hit));
  if (ht.tail.length > 0) {
    lines.push(`  … пропущено ${ht.omitted} строк …`);
    for (const hit of ht.tail) lines.push(lineRef(hit));
  }
  return lines;
}

function sectionMetric(output: string): { lines: string[]; hit: boolean } {
  const metrics = extractMetricLines(output);
  const lines = [`## METRIC: ${metrics.length}`];
  if (metrics.length === 0) lines.push("  (METRIC-строк нет)");
  for (const m of metrics) lines.push(`  ${m.name} = ${m.value}`);
  return { lines, hit: metrics.length > 0 };
}

function sectionErrors(output: string): { lines: string[]; hit: boolean } {
  const all = extractErrorWarnLines(output);
  const shown = all.slice(0, ERROR_SAMPLE);
  const lines = [`## error/warn: всего ${all.length}, показано ${shown.length}`];
  if (shown.length === 0) lines.push("  (совпадений нет)");
  for (const hit of shown) lines.push(lineRef(hit));
  return { lines, hit: all.length > 0 };
}

function sectionTiming(output: string): { lines: string[]; hit: boolean } {
  const timing = extractTimingLines(output, TIMING_TOP);
  const lines = [`## timing top-${TIMING_TOP}: строк с таймингом ${timing.total}`];
  if (timing.top.length === 0) lines.push("  (строк с таймингом нет)");
  for (const hit of timing.top) {
    lines.push(`  ${hit.value}${hit.unit} (${hit.valueMs} мс) L${hit.lineNo}: ${clampLine(hit.text)}`);
  }
  return { lines, hit: timing.total > 0 };
}

function sectionDelta(input: InspectRender): string[] {
  const source = input.delta;
  if (source.kind === "unavailable") return [`## delta: недоступна, ${source.reason}`];
  if (source.meta.run === input.meta.run) {
    return ["## delta: прогон сам является лучшим keep эпохи, сравнивать не с чем"];
  }
  const current = withOutput(input.meta, input.output);
  const baseline = withOutput(source.meta, source.output);
  // All entries are returned here; the response paging applies to them.
  const result = diffAgainstBest(current, baseline, { pageSize: Number.MAX_SAFE_INTEGER });
  if (result.kind === "unavailable") return [`## delta: недоступна, ${result.reason}`];
  if (result.kind === "incomparable") {
    const lines = [
      `## delta vs run ${result.baselineRun}: несоизмеримые объёмы (${result.currentBytes} и ${result.baselineBytes} байт, допустимо не более ${DELTA_RATIO_LIMIT}×), head/tail обоих`,
    ];
    lines.push(...headTailLines(`текущий run ${input.meta.run}`, result.current));
    lines.push(...headTailLines(`базовый run ${result.baselineRun}`, result.baseline));
    return lines;
  }
  const added = result.entries.filter((e) => e.kind === "added");
  const removed = result.entries.filter((e) => e.kind === "removed");
  const lines = [
    `## delta vs run ${result.baselineRun} (лучший keep эпохи ${input.epoch}): +${added.length} −${removed.length}`,
  ];
  if (result.entries.length === 0) lines.push("  (различий нет)");
  for (const entry of result.entries) {
    lines.push(`  ${entry.kind === "added" ? "+" : "−"} L${entry.lineNo}: ${clampLine(entry.text)}`);
  }
  return lines;
}

function sectionRaw(output: string, title: string): string[] {
  const ht = headTail(output, HEAD_LINES, TAIL_LINES);
  const lines = [`## ${title}: строк ${ht.totalLines}`];
  for (const hit of ht.head) lines.push(lineRef(hit));
  if (ht.tail.length > 0) {
    lines.push(`  … пропущено ${ht.omitted} строк …`);
    for (const hit of ht.tail) lines.push(lineRef(hit));
  }
  return lines;
}

function resolvePath(value: unknown, segments: readonly string[]): { found: true; value: unknown } | { found: false } {
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function sectionRegex(ex: RegexExtractor, output: string): { lines: string[]; total: number } {
  const limit = ex.sample ?? REGEX_SAMPLE_DEFAULT;
  // Flag contract (lens-config): the stored pattern is compiled with no flags, exactly as validated.
  const re = new RegExp(ex.regex);
  let total = 0;
  const shown: string[] = [];
  splitOutputLines(output).forEach((text, index) => {
    const match = re.exec(text);
    if (!match) return;
    total++;
    if (shown.length >= limit) return;
    const captured = match.length > 1
      ? JSON.stringify(match.slice(1).map((group) => group ?? ""))
      : text;
    shown.push(`  L${index + 1}: ${clampLine(captured)}`);
  });
  const lines = [`## extractor ${ex.name} (regex): совпадений ${total}, показано ${shown.length}`];
  if (shown.length === 0) lines.push("  (совпадений нет)");
  lines.push(...shown);
  return { lines, total };
}

function sectionTimingLine(ex: TimingExtractor, output: string): { lines: string[]; total: number } {
  const top = ex.top ?? TIMING_LINE_TOP_DEFAULT;
  const timing = extractTimingLines(output, top);
  const lines = [`## extractor ${ex.name} (timing): строк с таймингом ${timing.total}, top-${top}`];
  if (timing.top.length === 0) lines.push("  (строк с таймингом нет)");
  for (const hit of timing.top) {
    lines.push(`  ${hit.value}${hit.unit} (${hit.valueMs} мс) L${hit.lineNo}: ${clampLine(hit.text)}`);
  }
  return { lines, total: timing.total };
}

function sectionJsonPath(ex: JsonPathExtractor, jsonl: JsonlSource): { lines: string[]; total: number } {
  const title = `## extractor ${ex.name} (json_path ${ex.jsonPath})`;
  if (jsonl.files.length === 0) {
    const why = jsonl.notes.length > 0 ? jsonl.notes.join("; ") : "нет скопированных JSONL-артефактов";
    return { lines: [`${title}: нет данных, ${why}`], total: 0 };
  }
  const limit = ex.sample ?? JSON_PATH_SAMPLE_DEFAULT;
  const segments = ex.jsonPath.split(".");
  let records = 0;
  let resolved = 0;
  let malformed = 0;
  const shown: string[] = [];
  for (const artifact of jsonl.files) {
    splitOutputLines(artifact.text).forEach((text, index) => {
      if (text.trim().length === 0) return;
      records++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        malformed++;
        return;
      }
      const found = resolvePath(parsed, segments);
      if (!found.found) return;
      resolved++;
      if (shown.length < limit) {
        shown.push(`  ${artifact.file} L${index + 1}: ${clampLine(JSON.stringify(found.value) ?? "undefined")}`);
      }
    });
  }
  const lines = [`${title}: записей ${records}, с путём ${resolved}, нечитаемых ${malformed}, показано ${shown.length}`];
  if (shown.length === 0) lines.push("  (значений по пути нет)");
  lines.push(...shown);
  return { lines, total: resolved };
}

function campaignSection(ex: AnalysisExtractor, input: InspectRender): { lines: string[]; total: number } {
  if ("regex" in ex) return sectionRegex(ex, input.output);
  if ("jsonPath" in ex) return sectionJsonPath(ex, input.jsonl);
  return sectionTimingLine(ex, input.output);
}

// ──────────────────────────────────────────────────────────────────────────
// Body, paging, rendering
// ──────────────────────────────────────────────────────────────────────────

/** All content lines for the selected extractors, before paging. */
export function buildBody(input: InspectRender): { lines: string[]; hit: boolean } {
  const selection = input.extractor;
  const wantsGeneric = (name: GenericExtractorName): boolean =>
    selection.kind === "all" || (selection.kind === "generic" && selection.name === name);

  const lines: string[] = [];
  let hit = false;
  const add = (section: { lines: string[]; hit: boolean }): void => {
    lines.push(...section.lines);
    if (section.hit) hit = true;
  };

  if (wantsGeneric("metric")) add(sectionMetric(input.output));
  if (wantsGeneric("errors")) add(sectionErrors(input.output));
  if (wantsGeneric("timing")) add(sectionTiming(input.output));
  if (wantsGeneric("delta")) lines.push(...sectionDelta(input));

  for (const ex of input.campaign) {
    if (selection.kind === "all" || (selection.kind === "campaign" && selection.extractor.name === ex.name)) {
      const section = campaignSection(ex, input);
      if (section.total > 0) hit = true;
      lines.push(...section.lines);
    }
  }

  // Raw head/tail: always when requested explicitly; in the default view only
  // when no extractor (generic or campaign) found anything.
  if (selection.kind === "generic" && selection.name === "raw") {
    lines.push(...sectionRaw(input.output, "raw head/tail"));
  } else if (selection.kind === "all" && !hit) {
    lines.push(...sectionRaw(input.output, "raw head/tail (ни один экстрактор не нашёл данных)"));
  }

  return { lines, hit };
}

function pageBoundsWithLimit(body: readonly string[], lineLimit: number): Array<[number, number]> {
  const budget = INSPECT_PAGE_BYTES - META_RESERVE_BYTES;
  const bounds: Array<[number, number]> = [];
  let start = 0;
  while (start < body.length) {
    let end = start;
    let bytes = 0;
    while (end < body.length && end - start < lineLimit) {
      const size = byteLength(body[end]) + 1;
      if (end > start && bytes + size > budget) break;
      bytes += size;
      end++;
    }
    bounds.push([start, end]);
    start = end;
  }
  return bounds.length > 0 ? bounds : [[0, 0]];
}

/**
 * Page bounds for the whole response. A body that fits on one page gets the
 * limit without a footer; otherwise every page is shortened by the footer line,
 * so each rendered page stays within INSPECT_PAGE_LINES lines in total.
 */
function pageBounds(body: readonly string[]): Array<[number, number]> {
  const single = pageBoundsWithLimit(body, INSPECT_PAGE_LINES - HEAD_META_LINES);
  if (single.length === 1) return single;
  return pageBoundsWithLimit(body, INSPECT_PAGE_LINES - HEAD_META_LINES - FOOTER_META_LINES);
}

/** Number of pages the body occupies under the line and byte limits. */
export function pageCountOf(body: readonly string[]): number {
  return pageBounds(body).length;
}

/** The requested page of the body, or null when the page is out of range. */
export function paginateBody(body: readonly string[], page: number): PageSlice | null {
  const bounds = pageBounds(body);
  if (!Number.isSafeInteger(page) || page < 1 || page > bounds.length) return null;
  const [start, end] = bounds[page - 1];
  return {
    page,
    pageCount: bounds.length,
    lines: body.slice(start, end),
    firstLine: start + 1,
    lastLine: end,
  };
}

function extractorLabel(selection: ExtractorSelection): string {
  if (selection.kind === "all") return "все";
  if (selection.kind === "generic") return selection.name;
  return selection.extractor.name;
}

/** Render one page of the inspection: header, output path, content, footer. */
export function renderInspection(input: InspectRender): InspectRenderResult {
  const { lines: body } = buildBody(input);
  const slice = paginateBody(body, input.page);
  if (slice === null) {
    return {
      ok: false,
      error: `page ${input.page} вне диапазона: ответ умещается в ${pageCountOf(body)} стр.`,
    };
  }

  const { meta } = input;
  const metricText = meta.metric !== null ? `, metric=${meta.metric}` : "";
  const howText = input.how === "best_keep" ? ` (лучший keep эпохи ${input.epoch})` : "";
  const out: string[] = [
    `🔎 inspect_results · прогон ${meta.run}${howText} · эпоха ${input.epoch} · status ${meta.status}${metricText} · экстрактор: ${extractorLabel(input.extractor)} · страница ${slice.page} из ${slice.pageCount}`,
    `   вывод: ${input.outputPath} (${byteLength(input.output)} байт)`,
    ...slice.lines,
  ];

  if (slice.pageCount > 1) {
    const nextPage = slice.page + 1;
    const extractorArg = input.extractor.kind === "all" ? "" : ` extractor=${extractorLabel(input.extractor)}`;
    if (slice.page < slice.pageCount) {
      out.push(
        `truncated: true, показаны строки ${slice.firstLine}–${slice.lastLine} из ${body.length}; следующая страница: inspect_results run=${meta.run}${extractorArg} page=${nextPage}`,
      );
    } else {
      out.push(`конец: строки ${slice.firstLine}–${slice.lastLine} из ${body.length}, truncated: false`);
    }
  }

  return {
    ok: true,
    text: out.join("\n"),
    details: {
      run: meta.run,
      epoch: input.epoch,
      how: input.how,
      status: meta.status,
      metric: meta.metric,
      extractor: extractorLabel(input.extractor),
      page: slice.page,
      pageCount: slice.pageCount,
      totalLines: body.length,
      firstLine: slice.firstLine,
      lastLine: slice.lastLine,
      truncated: slice.page < slice.pageCount,
      nextPage: slice.page < slice.pageCount ? slice.page + 1 : null,
      outputPath: input.outputPath,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Disk access (the only I/O: ledger + .auto/runs/<n>/)
// ──────────────────────────────────────────────────────────────────────────

type FileRead =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "error"; message: string };

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel.length === 0) return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** realpath of `p`, or null when `p` does not exist (a dangling symlink counts as missing). */
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    if (e !== null && typeof e === "object" && (e as { code?: unknown }).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Read `relName` from `.auto/runs/<run>/`. `run` is a validated integer, so the
 * run directory cannot escape by construction; the realpath checks cover
 * symlinks and manifest-declared names (`../../x`). Each level is checked in
 * turn and nothing is read until all of them resolve inside their parent:
 * workDir → .auto/runs → run directory → target file.
 */
function readRunFile(workDir: string, run: number, relName: string): FileRead {
  const runsRoot = runsRootPath(workDir);
  const runDir = path.join(runsRoot, String(run));
  const target = path.join(runDir, relName);
  try {
    const realWork = fs.realpathSync(workDir);
    const realRoot = realpathOrNull(runsRoot);
    if (realRoot === null) return { status: "missing" };
    if (!isInside(realWork, realRoot)) {
      return { status: "error", message: `${AUTO_DIR}/runs ведёт за пределы рабочего каталога, чтение отклонено` };
    }
    const realRunDir = realpathOrNull(runDir);
    if (realRunDir === null) return { status: "missing" };
    if (!isInside(realRoot, realRunDir)) {
      return { status: "error", message: `каталог прогона ${run} ведёт за пределы ${AUTO_DIR}/runs, чтение отклонено` };
    }
    const realTarget = realpathOrNull(target);
    if (realTarget === null) return { status: "missing" };
    if (!isInside(realRunDir, realTarget)) {
      return { status: "error", message: `${relName} лежит вне каталога прогона ${run}, чтение отклонено` };
    }
    if (!fs.statSync(realTarget).isFile()) {
      return { status: "error", message: `${relName} в каталоге прогона ${run} не является файлом` };
    }
    return { status: "ok", text: fs.readFileSync(realTarget, "utf-8") };
  } catch (e) {
    return { status: "error", message: `не удалось прочитать ${relName} прогона ${run}: ${describeError(e)}` };
  }
}

/**
 * Read the ledger. Its realpath must stay inside the realpath of workDir, so a
 * `.auto` directory or `log.jsonl` linked from outside is refused unread.
 */
function readLedgerText(workDir: string): ParseResult<string> {
  const ledgerPath = sessionFilePath(workDir, "log");
  try {
    const realLedger = realpathOrNull(ledgerPath);
    if (realLedger === null) return { ok: true, value: "" };
    const realWork = fs.realpathSync(workDir);
    if (!isInside(realWork, realLedger)) {
      return { ok: false, error: `леджер ${ledgerPath} ведёт за пределы рабочего каталога, чтение отклонено` };
    }
    return { ok: true, value: fs.readFileSync(realLedger, "utf-8") };
  } catch (e) {
    return { ok: false, error: `не удалось прочитать леджер ${ledgerPath}: ${describeError(e)}` };
  }
}

/** JSONL copies listed in the run's manifest (only the run directory is read). */
function readJsonlArtifacts(workDir: string, run: number): JsonlSource {
  const manifest = readRunFile(workDir, run, MANIFEST_FILE);
  if (manifest.status === "missing") {
    return { files: [], notes: ["манифеста нет (прогон без analysis.artifacts или записан до внедрения)"] };
  }
  if (manifest.status === "error") return { files: [], notes: [manifest.message] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return { files: [], notes: ["manifest.json не разбирается как JSON"] };
  }
  const artifacts = parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { artifacts?: unknown }).artifacts)
    ? (parsed as { artifacts: unknown[] }).artifacts
    : [];

  const source: JsonlSource = { files: [], notes: [] };
  for (const entry of artifacts) {
    if (entry === null || typeof entry !== "object") continue;
    const artifact = entry as { declared?: unknown; copied?: unknown; file?: unknown };
    if (artifact.copied !== true || typeof artifact.file !== "string" || !artifact.file.endsWith(".jsonl")) continue;
    const read = readRunFile(workDir, run, artifact.file);
    if (read.status === "ok") {
      source.files.push({ file: artifact.file, text: read.text });
    } else {
      source.notes.push(read.status === "missing" ? `${artifact.file}: не найден` : read.message);
    }
  }
  return source;
}

function resolveDelta(
  workDir: string,
  metas: readonly RunMeta[],
  current: RunMeta,
  currentOutput: string,
  direction: Direction,
): DeltaSource {
  const pick = pickBaseline(metas, current, direction);
  if (pick.kind === "none") return { kind: "unavailable", reason: pick.reason };
  if (pick.meta.run === current.run) return { kind: "run", meta: pick.meta, output: currentOutput };
  const base = readRunFile(workDir, pick.meta.run, OUTPUT_FILE);
  if (base.status === "ok") return { kind: "run", meta: pick.meta, output: base.text };
  const reason = base.status === "missing"
    ? `у базового прогона ${pick.meta.run} нет ${AUTO_DIR}/runs/${pick.meta.run}/${OUTPUT_FILE}`
    : base.message;
  return { kind: "unavailable", reason };
}

function failure(error: string): InspectResponse {
  return { text: `❌ inspect_results: ${error}`, details: { error } };
}

/**
 * Tool entry point: answer `inspect_results` for the campaign in `workDir`.
 * Never throws for missing or unusable data; every such case becomes an
 * explicit message in the returned text.
 */
export function inspectResults(workDir: string, args: InspectArgs): InspectResponse {
  const parsed = parseInspectArgs(args);
  if (!parsed.ok) return failure(parsed.error);

  const ledger = readLedgerText(workDir);
  if (!ledger.ok) return failure(ledger.error);
  const ledgerText = ledger.value;

  const analysis = parseAnalysisConfig(ledgerAnalysisHeader(ledgerText));
  if (analysis.status === "invalid") {
    return failure(`analysis в заголовке леджера невалиден:\n${analysis.errors.map((e) => `- ${e}`).join("\n")}`);
  }
  const campaign = analysis.status === "ok" ? analysis.config.extractors : [];

  const extractor = resolveExtractor(parsed.value.extractor, campaign);
  if (!extractor.ok) return failure(extractor.error);

  const metas = ledgerRunMetas(ledgerText);
  const direction = ledgerDirection(ledgerText);
  const selection = selectInspectRun(metas, parsed.value.run, direction);
  if (!selection.ok) return failure(selection.error);
  const { meta } = selection;
  const outputPath = `${AUTO_DIR}/runs/${meta.run}/${OUTPUT_FILE}`;

  const output = readRunFile(workDir, meta.run, OUTPUT_FILE);
  if (output.status === "missing") {
    return {
      text:
        `⚠️ inspect_results: вывод прогона ${meta.run} не персистирован (${outputPath} отсутствует). ` +
        "Прогон записан в леджер до внедрения .auto/runs или сохранение не удалось. " +
        "Перезапустите замер через run_experiment, чтобы получить персистированный вывод.",
      details: { run: meta.run, status: "output_missing", outputPath },
    };
  }
  if (output.status === "error") return failure(output.message);

  const sel = extractor.value;
  const needsDelta = sel.kind === "all" || (sel.kind === "generic" && sel.name === "delta");
  const needsJsonl = sel.kind === "all"
    ? campaign.some((ex) => "jsonPath" in ex)
    : sel.kind === "campaign" && "jsonPath" in sel.extractor;

  const rendered = renderInspection({
    meta,
    epoch: selection.epoch,
    how: selection.how,
    output: output.text,
    outputPath,
    delta: needsDelta
      ? resolveDelta(workDir, metas, meta, output.text, direction)
      : { kind: "unavailable", reason: "не запрошена" },
    extractor: sel,
    campaign,
    jsonl: needsJsonl ? readJsonlArtifacts(workDir, meta.run) : { files: [], notes: [] },
    direction,
    page: parsed.value.page,
  });
  return rendered.ok ? { text: rendered.text, details: rendered.details } : failure(rendered.error);
}
