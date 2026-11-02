/**
 * Campaign report generator (openspec add-result-reflection, task 3.1; spec
 * campaign-report/spec.md «Генерация отчёта на finalize»).
 *
 * PURE generator: `buildReport(workDir)` reads the campaign data under
 * `workDir` — the ledger `.auto/log.jsonl`, the findings store
 * `.auto/findings.jsonl`, the run manifests `.auto/runs/<n>/manifest.json`,
 * the measurement records of the ledger + `.auto/measurement/`, the tree
 * `.auto/tree.json`, the ideas `.auto/ideas/` and `.auto/dead-ends.json` —
 * and returns the markdown report. It NEVER writes a file: persisting
 * `.auto/report.md` is task 3.2 (finalize_research hook and the
 * `/autoresearch report` command).
 *
 * Seven sections (task 3.1 / design.md, content mapped to the spec's seven):
 *   1. Прогоны и метрики — measured strengths/weaknesses of the active epoch
 *      (baseline, best keep, keep list, crashes/regressions) + the inventory
 *      of reusable artifacts (spec: «.auto/runs/, скрипты, инструменты»):
 *      persisted run artifacts (.auto/runs/ manifests), the campaign scripts
 *      (.auto/measure.sh, .auto/checks.sh — path + purpose) and the declared
 *      campaign tools (design.md Code Touch Points 2).
 *   2. Находки по темам — findings grouped by theme with estimated_impact,
 *      the needs_verification flag and the status; measurement findings with
 *      needs_verification go to the dedicated «Требуют независимой проверки»
 *      queue (every unverified status — open/revised/deferred; only verified
 *      leaves it, since findings.ts never clears the flag) with the explicit
 *      note that the check pauses nothing and needs
 *      no owner approval (a verification work queue, NOT an owner gate).
 *   3. Measurement-трек — scale epochs with scores and their verification
 *      status / rescore_pending mark, runs per epoch, rejected (incomparable)
 *      epochs, `.auto/measurement/` artifacts.
 *   4. Шум и уверенность — calibrated noise floor (with floor_stale) and the
 *      confidence score, honestly suppressed while rescore_pending or the
 *      floor is stale.
 *   5. Идеи и dead-ends — exhausted channels (families of rejected hypotheses
 *      with reasons: dead-ends.json + exhausted tree branches) and the untried
 *      ideas backlog.
 *   6. Ограничения и owner-input gates — capability/tradeoff findings at ANY
 *      status as owner decisions (the spec restricts no status), plus the
 *      honest limits of the campaign's control
 *      (undeclared/invalid analysis, unaccounted or unavailable measurer
 *      files, unreadable stores). Measurement needs_verification findings
 *      NEVER appear here (spec scenario «непроверенный аудит в отчёте»).
 *   7. Сводка — one-line digest of everything above.
 *
 * Every section is ALWAYS present; an empty one is marked explicitly («нет
 * данных»; findings: «линза не применялась»), never dropped (spec scenario
 * «отчёт полной кампании»; a campaign where the lens was never used gets the
 * «линза не применялась» mark, scenario «кампания без находок»).
 *
 * Idempotent by construction (spec «Идемпотентность и ручной вызов»): the
 * output derives ONLY from on-disk campaign data — no generation timestamp,
 * all listings explicitly sorted — so two calls on the same state return
 * byte-identical text and a rewrite never accumulates duplicates.
 *
 * Degradation: every read is best-effort like the council brief — a missing
 * or unreadable source marks its section empty or is named in «Ограничения»;
 * buildReport never throws (a fallback report keeps all seven sections).
 *
 * confidenceOf mirrors index.ts computeConfidence semantics (MAD multiple of
 * the best keep's delta over the baseline, within the active epoch and the
 * current segment only) instead of importing index.ts: report.ts must stay a
 * leaf module — task 3.2 wires index.ts → report.ts, an index import would
 * create a cycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { AUTO_DIR, sessionFilePath } from "./paths.ts";
import {
  parseJsonlEntry,
  reconstructJsonlState,
  type ReconstructedJsonlState,
} from "./jsonl.ts";
import { FINDING_THEMES, loadFindings, type FindingView } from "./findings.ts";
import {
  confidenceSuppressionReason,
  measurerControlOfDir,
  measurementChangeId,
  measurementScaleStatus,
  measurementVerificationState,
  MEASUREMENT_SUBDIR,
  noiseFloorStatus,
  readNoiseFloorConfig,
  type MeasurerControl,
  type MeasurementScaleStatus,
  type MeasurementVerificationState,
  type NoiseFloorStatus,
} from "./measurement.ts";
import { runsRootPath } from "./lens.ts";
import { loadTree, treeExists, type ExperimentTree } from "./parallel/tree.ts";

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const IDEAS_SUBDIR = "ideas";
const DEAD_ENDS_FILE = "dead-ends.json";
const RUN_MANIFEST_FILE = "manifest.json";
const RUN_OUTPUT_FILE = "output.txt";

/**
 * The declared campaign tools (design.md Code Touch Points 2) — the
 * extension-provided instruments a next campaign session reuses. Static
 * declarations: the inventory announces each with its purpose; there is no
 * on-disk artifact to hash or stat (the spec requires no hashes here).
 */
const TOOL_INVENTORY =
  "inspect_results — чтение персистированных выводов .auto/runs/; " +
  "record_finding — запись находки в .auto/findings.jsonl; " +
  "update_finding — обновление статуса находки и фиксация доказательств; " +
  "log_measurement_change — регистрация изменения измерителя; " +
  "команда /autoresearch report — промежуточный отчёт по кампании";

/** Same clip limits as the council brief's finding rendering. */
const CLIP_DESCRIPTION = 220;
const CLIP_EVIDENCE = 140;
const CLIP_IMPACT = 60;
const CLIP_LABEL = 90;
const CLIP_JUSTIFICATION = 120;
const CLIP_REASON = 120;

const MAX_CRASH_LINES = 5;
const MAX_IDEA_LINES = 12;
const MAX_MANIFEST_LINES = 20;
const MAX_KEEP_LINES = 20;

const NO_DATA = "нет данных";
const LENS_NOT_USED = "линза не применялась";

/** The spec's exact wording for the verification queue's non-owner-gate note. */
const VERIFICATION_QUEUE_NOTE =
  "Проверка не приостанавливает цикл и не требует одобрения владельца — это рабочая очередь верификации, а не owner-гейт.";

// ──────────────────────────────────────────────────────────────────────────
// Small helpers
// ──────────────────────────────────────────────────────────────────────────

/** Collapse whitespace and clip to a limit (ellipsis marks the cut). */
function clip(s: string, limit: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : one.slice(0, limit - 1) + "…";
}

/** Metric rendering: up to 4 decimals without trailing zeros, unit appended. */
function fmtMetric(value: number, unit: string): string {
  const text = String(Number(value.toFixed(4)));
  return unit ? `${text} ${unit}` : text;
}

/** Ledger-style score rendering (the JSON number as-is, «—» when absent). */
function fmtScore(score: number | null): string {
  return score === null ? "—" : String(score);
}

/** Signed percent change of `value` against `base`; null when base is 0. */
function signedPercent(value: number, base: number): string | null {
  if (!Number.isFinite(base) || base === 0) return null;
  const pct = ((value - base) / base) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function isBetter(current: number, other: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? current < other : current > other;
}

function readTextSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  const raw = readTextSafe(filePath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ──────────────────────────────────────────────────────────────────────────
// Ledger scans
// ──────────────────────────────────────────────────────────────────────────

interface EpochScores {
  old: number | null;
  new: number | null;
}

interface MeasurementChangeView {
  epoch: number;
  scores: EpochScores;
  rescorePending: boolean;
  justification: string;
  diffRef: string;
  rescoreRef: string;
}

interface MeasurementLedgerScan {
  /** All `measurement_change` records, ascending by epoch. */
  changes: MeasurementChangeView[];
  /** Epoch → scores filled by the `measurement_change_completed` record. */
  completed: Map<number, EpochScores>;
  /** Epoch → proof_ref of the `measurement_change_verified` record. */
  verified: Map<number, string | null>;
  /** Epoch → counter-rescore ref of the `measurement_change_reverted` record. */
  reverted: Map<number, string | null>;
}

/**
 * Epoch a verified/reverted/completed record refers to: its own epoch, else
 * its change_ref ("e2" or bare "2"). Records without a usable epoch are
 * ignored (same guard as measurement.ts's fold).
 */
function epochRefOf(entry: Record<string, unknown>): number | null {
  const direct = entry["epoch"];
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 1) return direct;
  const ref = str(entry["change_ref"]).trim();
  const match = /^e?(\d+)$/.exec(ref);
  if (match) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return null;
}

/**
 * Per-epoch view of the measurement track. Unlike measurement.ts's fold
 * (which tracks only the LATEST change) the report renders every epoch, so it
 * walks the ledger once itself; the verdicts agree with
 * measurementVerificationState by construction (same records, same refs).
 */
function scanMeasurementLedger(ledgerText: string): MeasurementLedgerScan {
  const scan: MeasurementLedgerScan = {
    changes: [],
    completed: new Map(),
    verified: new Map(),
    reverted: new Map(),
  };
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) continue;
    if (entry["type"] === "measurement_change") {
      const epoch = epochRefOf(entry);
      if (epoch === null) continue;
      scan.changes.push({
        epoch,
        scores: {
          old: finiteOrNull(entry["old_scale_score"]),
          new: finiteOrNull(entry["new_scale_score"]),
        },
        rescorePending: entry["rescore_pending"] === true,
        justification: str(entry["justification"]),
        diffRef: str(entry["diff_ref"]),
        rescoreRef: str(entry["rescore_ref"]),
      });
      continue;
    }
    if (entry["type"] === "measurement_change_completed") {
      const epoch = epochRefOf(entry);
      if (epoch !== null && !scan.completed.has(epoch)) {
        scan.completed.set(epoch, {
          old: finiteOrNull(entry["old_scale_score"]),
          new: finiteOrNull(entry["new_scale_score"]),
        });
      }
      continue;
    }
    if (entry["type"] === "measurement_change_verified") {
      const epoch = epochRefOf(entry);
      if (epoch !== null && !scan.verified.has(epoch)) {
        scan.verified.set(epoch, str(entry["proof_ref"]) || null);
      }
      continue;
    }
    if (entry["type"] === "measurement_change_reverted") {
      const epoch = epochRefOf(entry);
      if (epoch !== null && !scan.reverted.has(epoch)) {
        scan.reverted.set(epoch, str(entry["rescore_ref"]) || null);
      }
      continue;
    }
  }
  scan.changes.sort((a, b) => a.epoch - b.epoch);
  return scan;
}

// ──────────────────────────────────────────────────────────────────────────
// Disk reads (each degrades to an empty/markable state, never throws)
// ──────────────────────────────────────────────────────────────────────────

interface RunManifestView {
  run: number;
  manifest: Record<string, unknown>;
}

interface ScriptEntry {
  /** Display path relative to the work dir (forward slashes). */
  path: string;
  purpose: string;
  exists: boolean;
}

/**
 * One campaign script (`.auto/measure.sh` / `.auto/checks.sh`, legacy flat
 * names resolved by the same sessionFilePath rule as every session file).
 * Path + purpose + presence, no hash — the spec's inventory asks for the
 * reusable scripts' whereabouts, not their content control (that is the
 * declared measurer files' job: manifests + section 6).
 */
function campaignScript(workDir: string, kind: "measure" | "checks", purpose: string): ScriptEntry {
  const resolved = sessionFilePath(workDir, kind);
  return {
    path: path.relative(workDir, resolved).split(path.sep).join("/"),
    purpose,
    exists: fs.existsSync(resolved),
  };
}

function readRunManifests(workDir: string): { runs: RunManifestView[]; unreadable: number } {
  let names: string[];
  try {
    names = fs.readdirSync(runsRootPath(workDir));
  } catch {
    return { runs: [], unreadable: 0 };
  }
  const runs: RunManifestView[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const manifest = readJsonSafe(path.join(runsRootPath(workDir), name, RUN_MANIFEST_FILE));
    if (manifest === null) unreadable++;
    else runs.push({ run: Number(name), manifest });
  }
  runs.sort((a, b) => a.run - b.run);
  return { runs, unreadable };
}

/** Files under `.auto/measurement/`, recursive, relative to it, sorted. */
function measurementArtifacts(workDir: string): string[] {
  const root = path.join(workDir, AUTO_DIR, MEASUREMENT_SUBDIR);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

interface DeadEndView {
  nodeId: string;
  hypothesis: string;
  reason: string;
}

/**
 * Exhausted channels: entries of `.auto/dead-ends.json` (persists across
 * reverts, same shape saveDeadEnds writes) merged with exhausted branches of
 * the tree (exhausted + terminal status). The json wins per nodeId — it is
 * the durable record; tree-only branches are appended. Sorted by node id.
 */
function deadEndsOf(workDir: string, tree: ExperimentTree | null): { deadEnds: DeadEndView[]; unreadable: boolean } {
  const byNode = new Map<string, DeadEndView>();

  let unreadable = false;
  const raw = readTextSafe(path.join(workDir, AUTO_DIR, DEAD_ENDS_FILE));
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          const nodeId = str(record["nodeId"]).trim();
          if (!nodeId || byNode.has(nodeId)) continue;
          const reason = str(record["do_not_retry"]).trim() || str(record["finding"]).trim();
          byNode.set(nodeId, { nodeId, hypothesis: str(record["hypothesis"]).trim(), reason });
        }
      }
    } catch {
      unreadable = true;
    }
  }

  if (tree !== null) {
    for (const node of Object.values(tree.nodes)) {
      const terminal = node.status === "discard" || node.status === "crash" || node.status === "checks_failed";
      if (!node.exhausted || !terminal || byNode.has(node.id)) continue;
      const asi = (node.asi ?? {}) as Record<string, unknown>;
      const reason =
        str(asi["do_not_retry"]).trim() ||
        str(asi["finding"]).trim() ||
        node.hypothesisLabel ||
        node.hypothesis ||
        "(причина не записана)";
      byNode.set(node.id, { nodeId: node.id, hypothesis: node.hypothesisLabel ?? node.hypothesis, reason });
    }
  }

  const deadEnds = [...byNode.values()].sort((a, b) => {
    const na = /^n(\d+)$/.exec(a.nodeId);
    const nb = /^n(\d+)$/.exec(b.nodeId);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
  return { deadEnds, unreadable };
}

/** Untried ideas: `.auto/ideas/*.md` without YAML frontmatter (council's predicate). */
function untriedIdeaFiles(workDir: string): string[] {
  const ideasDir = path.join(workDir, AUTO_DIR, IDEAS_SUBDIR);
  let names: string[];
  try {
    names = fs.readdirSync(ideasDir);
  } catch {
    return [];
  }
  const ideas: string[] = [];
  for (const name of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!name.endsWith(".md")) continue;
    // hypothesis registration files carry frontmatter — they live in the tree
    try {
      if (fs.readFileSync(path.join(ideasDir, name), "utf-8").startsWith("---\n")) continue;
    } catch {
      continue;
    }
    ideas.push(name);
    if (ideas.length >= MAX_IDEA_LINES) break;
  }
  return ideas;
}

// ──────────────────────────────────────────────────────────────────────────
// Confidence (mirrors index.ts computeConfidence within the active epoch)
// ──────────────────────────────────────────────────────────────────────────

interface ConfidenceView {
  value: number | null;
  baseline: number | null;
  best: number | null;
  bestRun: number | null;
}

function confidenceOf(
  state: ReconstructedJsonlState,
  epoch: number,
  direction: "lower" | "higher",
): ConfidenceView {
  const none: ConfidenceView = { value: null, baseline: null, best: null, bestRun: null };
  const inEpoch = state.results.filter((r) => r.segment === state.currentSegment && r.epoch === epoch);
  const positive = inEpoch.filter((r) => r.metric > 0);
  if (positive.length < 3) return none;

  const values = positive.map((r) => r.metric);
  const median = sortedMedian(values);
  const mad = sortedMedian(values.map((v) => Math.abs(v - median)));
  if (mad === 0) return none;

  const baseline = inEpoch.length > 0 ? inEpoch[0].metric : null;
  if (baseline === null) return none;

  let best: number | null = null;
  let bestRun: number | null = null;
  for (const r of positive) {
    if (r.status !== "keep") continue;
    if (best === null || isBetter(r.metric, best, direction)) {
      best = r.metric;
      bestRun = r.run;
    }
  }
  if (best === null || best === baseline) return none;

  return { value: Math.abs(best - baseline) / mad, baseline, best, bestRun };
}

// ──────────────────────────────────────────────────────────────────────────
// Section renderers (each returns its lines; the header line is always first)
// ──────────────────────────────────────────────────────────────────────────

function impactPart(finding: FindingView): string {
  return finding.estimated_impact ? ` (${clip(finding.estimated_impact, CLIP_IMPACT)})` : "";
}

function renderRunsSection(
  state: ReconstructedJsonlState,
  activeEpoch: number,
  manifests: RunManifestView[],
  unreadableManifests: number,
  workDir: string,
): string[] {
  const lines = ["## 1. Прогоны и метрики"];
  const unit = state.metricUnit;
  const direction = state.bestDirection === "lower" ? "меньше" : "больше";
  if (state.hasConfigHeader) {
    lines.push(`Метрика: ${state.metricName}${unit ? ` [${unit}]` : ""} · лучше: ${direction}`);
  } else {
    lines.push(`Метрика: ${NO_DATA} (config-заголовок леджера отсутствует)`);
  }

  const results = state.results;
  if (results.length === 0) {
    lines.push(`Прогоны: ${NO_DATA} (прогонов нет)`);
    lines.push(`Измеренные сильные и слабые стороны: ${NO_DATA}`);
  } else {
    const byStatus = new Map<string, number>();
    for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const statusPart = ["keep", "discard", "crash", "checks_failed", "budget_exceeded", "explore"]
      .filter((s) => (byStatus.get(s) ?? 0) > 0)
      .map((s) => `${s} ${byStatus.get(s)}`)
      .join(" · ");
    lines.push(`Прогонов: ${results.length}${statusPart ? ` (${statusPart})` : ""}`);

    // Active epoch + current segment: the only window deltas may be computed
    // in (task 2.3 — cross-epoch comparisons are blocked everywhere).
    const seg = state.currentSegment;
    const epochRuns = results.filter((r) => r.segment === seg && r.epoch === activeEpoch);
    const baseline = epochRuns.length > 0 ? epochRuns[0].metric : null;
    const baselineRun = epochRuns.length > 0 ? epochRuns[0].run : null;

    let best: number | null = null;
    let bestRun: number | null = null;
    let bestDescription = "";
    let bestMetrics: Record<string, number> = {};
    for (const r of epochRuns) {
      if (r.status !== "keep" || r.metric <= 0) continue;
      if (best === null || isBetter(r.metric, best, state.bestDirection)) {
        best = r.metric;
        bestRun = r.run;
        bestDescription = r.description;
        bestMetrics = r.metrics;
      }
    }

    if (baseline === null) {
      lines.push(`Baseline: ${NO_DATA} (в активной эпохе ${activeEpoch} прогонов нет)`);
    } else {
      lines.push(
        `Baseline (эпоха ${activeEpoch}): ${fmtMetric(baseline, unit)}${baselineRun !== null ? ` (#${baselineRun})` : ""}`,
      );
    }
    if (best === null || bestRun === null) {
      lines.push(`Лучший keep: ${NO_DATA} (keep'ов в активной эпохе нет)`);
    } else {
      const pct = baseline !== null && baseline !== 0 ? signedPercent(best, baseline) : null;
      lines.push(
        `Лучший keep: ${fmtMetric(best, unit)} (#${bestRun}${pct ? `, ${pct} к baseline` : ""})` +
          (bestDescription ? ` — ${clip(bestDescription, CLIP_LABEL)}` : ""),
      );
      const secondary = Object.entries(bestMetrics);
      if (secondary.length > 0) {
        lines.push(
          `Вторичные метрики лучшего keep: ${secondary.map(([n, v]) => `${n} ${fmtMetric(v, "")}`).join(" · ")}`,
        );
      }
    }

    const keeps = epochRuns.filter((r) => r.status === "keep" && r.metric > 0);
    if (keeps.length === 0 || baseline === null) {
      lines.push(`Измеренные сильные стороны: ${NO_DATA} (keep'ов в активной эпохе нет)`);
    } else {
      lines.push(`Измеренные сильные стороны (keep'ы активной эпохи ${activeEpoch}, в порядке):`);
      for (const r of keeps.slice(0, MAX_KEEP_LINES)) {
        const pct = signedPercent(r.metric, baseline);
        lines.push(
          `- #${r.run} ${fmtMetric(r.metric, unit)}${pct ? ` (${pct} к baseline)` : ""}` +
            (r.description ? ` — ${clip(r.description, CLIP_LABEL)}` : ""),
        );
      }
    }

    const failures = results.filter((r) => r.status === "crash" || r.status === "checks_failed");
    let worst: { run: number; metric: number; description: string } | null = null;
    for (const r of epochRuns) {
      if ((r.status !== "discard" && r.status !== "checks_failed") || r.metric <= 0 || baseline === 0) continue;
      if (worst === null || isBetter(r.metric, worst.metric, state.bestDirection)) {
        worst = { run: r.run, metric: r.metric, description: r.description };
      }
    }
    if (failures.length === 0 && worst === null) {
      lines.push(`Измеренные слабые стороны: ${NO_DATA} (аварий и регрессий нет)`);
    } else {
      lines.push("Измеренные слабые стороны:");
      for (const r of failures.slice(0, MAX_CRASH_LINES)) {
        lines.push(`- #${r.run} ${r.status}${r.description ? ` — ${clip(r.description, CLIP_LABEL)}` : ""}`);
      }
      if (failures.length > MAX_CRASH_LINES) {
        lines.push(`  … и ещё ${failures.length - MAX_CRASH_LINES} аварийных/проваливших проверки прогонов`);
      }
      if (worst !== null && baseline !== null) {
        const pct = signedPercent(worst.metric, baseline);
        lines.push(
          `- худшая регрессия (эпоха ${activeEpoch}): #${worst.run} ${fmtMetric(worst.metric, unit)}` +
            `${pct ? ` (${pct} к baseline эпохи)` : ""}` +
            (worst.description ? ` — ${clip(worst.description, CLIP_LABEL)}` : ""),
        );
      }
    }
  }

  // Inventory of reusable artifacts (spec: «инвентарь переиспользуемых
  // артефактов (.auto/runs/, скрипты, инструменты)»).
  if (manifests.length === 0) {
    lines.push(
      `Инвентарь артефактов (.auto/runs/): ${NO_DATA} — манифестов прогонов нет` +
        (unreadableManifests > 0 ? ` (${unreadableManifests} не читается, см. «Ограничения»)` : ""),
    );
  } else {
    lines.push(`Инвентарь артефактов (.auto/runs/, ${manifests.length} с манифестами):`);
    const shown = manifests.slice(-MAX_MANIFEST_LINES);
    for (const { run, manifest } of shown) {
      const output = str(manifest["output"]) || RUN_OUTPUT_FILE;
      const bytes = finiteOrNull(manifest["bytes"]);
      const sha = str(manifest["sha16"]);
      const parts = [`#${run}: ${output}${bytes !== null ? ` ${bytes} Б` : ""}${sha ? ` · sha16 ${sha}` : ""}`];
      const measurers = Array.isArray(manifest["measurement_files"]) ? manifest["measurement_files"] : [];
      const measurerParts: string[] = [];
      for (const item of measurers) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const declared = str(record["path"]);
        if (!declared) continue;
        const sha16 = str(record["sha16"]);
        const missing = record["missing"] === true;
        const readError = str(record["read_error"]);
        measurerParts.push(
          declared + (sha16 ? ` (sha16 ${sha16})` : missing ? " (отсутствовал)" : readError ? ` (${readError})` : ""),
        );
      }
      if (measurerParts.length > 0) parts.push(`измеритель: ${measurerParts.join(", ")}`);
      const artifacts = Array.isArray(manifest["artifacts"]) ? manifest["artifacts"] : [];
      const artifactParts: string[] = [];
      for (const item of artifacts) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const declared = str(record["declared"]);
        if (!declared) continue;
        const bytesA = finiteOrNull(record["bytes"]);
        if (record["copied"] === true) artifactParts.push(`${declared} → скопирован${bytesA !== null ? ` (${bytesA} Б)` : ""}`);
        else if (record["size_only"] === true) artifactParts.push(`${declared} → size-only${bytesA !== null ? ` (${bytesA} Б)` : ""}`);
        else if (record["missing"] === true) artifactParts.push(`${declared} → отсутствует`);
        else if (str(record["read_error"])) artifactParts.push(`${declared} → ошибка: ${str(record["read_error"])}`);
      }
      if (artifactParts.length > 0) parts.push(`артефакты: ${artifactParts.join("; ")}`);
      lines.push(`- ${parts.join(" · ")}`);
    }
    if (manifests.length > shown.length) {
      lines.push(`  … показаны последние ${shown.length} из ${manifests.length} (по номеру прогона)`);
    }
  }

  // Scripts and declared tools (spec: «инвентарь переиспользуемых артефактов
  // (.auto/runs/, скрипты, инструменты)»). Always listed: the absence of a
  // campaign script is itself inventory information.
  const measure = campaignScript(workDir, "measure", "скрипт замера (команда run_experiment)");
  const checks = campaignScript(workDir, "checks", "скрипт проверок корректности (статус checks_failed)");
  lines.push("Скрипты и инструменты (переиспользуемая обвязка кампании):");
  lines.push(`- ${measure.path} — ${measure.purpose}: ${measure.exists ? "присутствует" : "отсутствует"}`);
  lines.push(`- ${checks.path} — ${checks.purpose}: ${checks.exists ? "присутствует" : "отсутствует"}`);
  lines.push(`- Инструменты кампании (расширение): ${TOOL_INVENTORY}`);
  return lines;
}

function renderFindingsSection(findings: FindingView[], storeOk: boolean): string[] {
  const lines = ["## 2. Находки по темам"];
  if (!storeOk) {
    lines.push(`${NO_DATA} (хранилище находок не читается — см. «Ограничения»)`);
    return lines;
  }
  if (findings.length === 0) {
    lines.push(`${LENS_NOT_USED} — находок не записано (.auto/findings.jsonl отсутствует или пуст)`);
    return lines;
  }
  for (const theme of FINDING_THEMES) {
    const group = findings.filter((f) => f.theme === theme);
    if (group.length === 0) continue;
    lines.push(`### ${theme} (${group.length})`);
    for (const f of group) {
      lines.push(
        `- ${f.id}${f.needs_verification ? " [needs_verification]" : ""}${impactPart(f)} ` +
          `${clip(f.description, CLIP_DESCRIPTION)}` +
          ` — evidence: ${clip(f.evidence_ref, CLIP_EVIDENCE)} — статус: ${f.status}`,
      );
    }
  }
  // Spec «Потребители находок в отчёте»: measurement findings with
  // needs_verification form a dedicated verification queue — never an owner
  // gate. The queue holds every flagged finding that is still UNVERIFIED:
  // open, revised and deferred (the spec restricts no status; a deferred
  // finding remains unverified and must not silently leave the queue).
  // Only verified is excluded: findings.ts never clears needs_verification
  // (append-only ledger, the flag is set-but-never-unset), so without the
  // explicit exclusion confirmed findings would clog the queue forever and it
  // would never empty.
  const queue = findings.filter(
    (f) => f.theme === "measurement" && f.needs_verification && f.status !== "verified",
  );
  if (queue.length > 0) {
    lines.push("### Требуют независимой проверки", VERIFICATION_QUEUE_NOTE);
    for (const f of queue) {
      lines.push(
        `- ${f.id}${impactPart(f)} ${clip(f.description, CLIP_DESCRIPTION)}` +
          ` — evidence: ${clip(f.evidence_ref, CLIP_EVIDENCE)} — статус: ${f.status}`,
      );
    }
  }
  return lines;
}

function renderMeasurementSection(
  scan: MeasurementLedgerScan,
  state: ReconstructedJsonlState,
  scale: MeasurementScaleStatus,
  verification: MeasurementVerificationState,
  artifacts: string[],
): string[] {
  const lines = ["## 3. Measurement-трек"];
  if (scan.changes.length === 0) {
    lines.push(`Изменений измерителя не зарегистрировано (здоровое состояние). Активная шкала: эпоха ${verification.active_epoch}.`);
  } else {
    lines.push(
      `Активная шкала: эпоха ${verification.active_epoch} · счётчик эпох: ${state.currentEpoch}.`,
    );
    for (const change of scan.changes) {
      const epoch = change.epoch;
      const completed = scan.completed.get(epoch);
      const old = change.scores.old ?? completed?.old ?? null;
      const newScore = change.scores.new ?? completed?.new ?? null;
      const counterRef = scan.reverted.get(epoch);
      const proof = scan.verified.get(epoch);

      let status: string;
      if (counterRef !== undefined) {
        status =
          `ОПРОВЕРГНУТО — откат по контр-рескору${counterRef ? ` (${counterRef})` : ""}; ` +
          `прогоны эпохи ${epoch} несравнимы с другими шкалами (cross-epoch)`;
      } else if (proof !== undefined) {
        status = `подтверждено независимой проверкой — needs_verification снят${proof ? ` (доказательство: ${proof})` : ""}`;
      } else if (change.rescorePending && completed === undefined) {
        status = "рескор не завершён (rescore_pending) — обе шкалы появятся после рескора";
      } else {
        status = "предварительная — needs_verification не снят";
      }

      const scoresPart =
        status.startsWith("рескор не завершён")
          ? ""
          : `old_scale_score ${fmtScore(old)} → new_scale_score ${fmtScore(newScore)} · `;
      const justification = change.justification
        ? ` · обоснование: ${clip(change.justification, CLIP_JUSTIFICATION)}`
        : "";
      lines.push(`- ${measurementChangeId(epoch)}: ${scoresPart}${status}${justification}`);
    }
  }

  const byEpoch = new Map<number, number>();
  for (const r of state.results) byEpoch.set(r.epoch, (byEpoch.get(r.epoch) ?? 0) + 1);
  if (byEpoch.size > 0) {
    const perEpoch = [...byEpoch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([epoch, count]) => `эпоха ${epoch} — ${count}`)
      .join(" · ");
    lines.push(`Прогоны по эпохам: ${perEpoch}.`);
  }
  if (verification.rejected_epochs.length > 0) {
    lines.push(
      `Отклонённые эпохи: ${verification.rejected_epochs.join(", ")} — их прогоны несравнимы с другими шкалами (cross-epoch).`,
    );
  }
  if (scale.rescore_pending) {
    lines.push(`Внимание: rescore_pending (${scale.change_ref}) — confidence подавлен до завершения рескора.`);
  }
  lines.push(
    artifacts.length > 0
      ? `Артефакты (.auto/measurement/): ${artifacts.join(", ")}`
      : `Артефакты (.auto/measurement/): ${NO_DATA}`,
  );
  return lines;
}

function renderNoiseSection(
  floor: NoiseFloorStatus,
  suppression: string | null,
  conf: ConfidenceView,
  unit: string,
): string[] {
  const lines = ["## 4. Шум и уверенность"];
  if (floor.floor === null) {
    lines.push("Noise floor: не калиброван (.auto/config.json: ключ noiseFloor отсутствует или некорректен)");
  } else {
    const pct = `${Number((floor.floor * 100).toFixed(2))}%`;
    lines.push(
      floor.stale
        ? `Noise floor: ±${pct} (калиброван на эпохе ${floor.floor_epoch}) — УСТАРЕЛ (floor_stale): ` +
          `активная шкала — эпоха ${floor.epoch}; переоцените floor на новой шкале ` +
          "(обновите noiseFloor и noiseFloorEpoch в .auto/config.json)"
        : `Noise floor: ±${pct} (калиброван на эпохе ${floor.floor_epoch}) — свежий`,
    );
  }
  if (suppression !== null) {
    lines.push(`Уверенность: подавлена — ${suppression}`);
  } else if (conf.value !== null && conf.baseline !== null && conf.best !== null) {
    lines.push(
      `Уверенность: ${conf.value.toFixed(1)}× — отрыв лучшего keep от baseline в единицах MAD ` +
        `(активная эпоха: baseline ${fmtMetric(conf.baseline, unit)} → лучший ${fmtMetric(conf.best, unit)})`,
    );
  } else {
    lines.push(
      `Уверенность: ${NO_DATA} (нужно ≥3 прогона в активной эпохе, ненулевой MAD и хотя бы один keep, ` +
        "отличающийся от baseline)",
    );
  }
  return lines;
}

function renderIdeasSection(deadEnds: DeadEndView[], ideas: string[]): string[] {
  const lines = ["## 5. Идеи и dead-ends"];
  lines.push("Исчерпанные каналы (семейства отклонённых гипотез):");
  if (deadEnds.length === 0) {
    lines.push(`- ${NO_DATA} (исчерпанных ветвей и dead-end'ов нет)`);
  } else {
    for (const d of deadEnds) {
      lines.push(`- ${d.nodeId} — "${clip(d.hypothesis || d.nodeId, CLIP_LABEL)}" — причина: ${clip(d.reason, CLIP_REASON)}`);
    }
  }
  if (ideas.length === 0) {
    lines.push(`Неразобранные идеи: ${NO_DATA} (.auto/ideas/ пуст или отсутствует)`);
  } else {
    lines.push(`Неразобранные идеи (${ideas.length}, .auto/ideas/):`);
    for (const idea of ideas) lines.push(`- ${idea}`);
  }
  return lines;
}

function renderGatesSection(
  findings: FindingView[],
  storeOk: boolean,
  storeErrors: string[],
  measurer: MeasurerControl,
  deadEndsUnreadable: boolean,
  unreadableManifests: number,
): string[] {
  const lines = ["## 6. Ограничения и owner-input gates"];

  // Spec «Потребители находок в отчёте»: capability/tradeoff findings are
  // owner decisions at ANY status — the spec restricts no status, and the
  // owner's decision can still be pending after verified/revised/deferred
  // bookkeeping. Measurement needs_verification findings NEVER land here.
  const gates = findings.filter(
    (f) => f.theme === "capability" || f.theme === "tradeoff",
  );
  if (gates.length === 0) {
    lines.push(`Owner-input gates: ${NO_DATA} (capability/tradeoff-находок нет)`);
  } else {
    lines.push("Owner-input gates (требуется решение владельца):");
    for (const f of gates) {
      const ask =
        f.theme === "capability"
          ? "развивать ли это направление (capability)"
          : "какую сторону развилки выбрать (tradeoff)";
      lines.push(`- ${f.id} (${f.theme})${impactPart(f)}: ${clip(f.description, CLIP_DESCRIPTION)} — требуется решение владельца: ${ask}`);
    }
  }

  const limits: string[] = [];
  if (measurer.state === "undeclared") {
    limits.push(
      "analysis.measurement_files не объявлен — изменения файлов измерителя не отслеживаются, полнота контроля не гарантирована",
    );
  } else if (measurer.state === "invalid") {
    limits.push("секция analysis конфиг-заголовка леджера не разобрана — контроль измерителя недоступен, полнота контроля не гарантирована");
  } else {
    for (const u of measurer.unaccounted) {
      limits.push(`неучтённое изменение измерителя (без measurement_change): ${u} — зарегистрируйте через log_measurement_change`);
    }
    for (const u of measurer.unavailable) {
      limits.push(`объявленный файл измерителя недоступен, его изменения не контролируются: ${u}`);
    }
  }
  if (!storeOk) {
    limits.push(`хранилище находок не читается: ${storeErrors.slice(0, 3).join(" | ")}`);
  }
  if (deadEndsUnreadable) {
    limits.push(".auto/dead-ends.json не читается — пропущен");
  }
  if (unreadableManifests > 0) {
    limits.push(`манифестов прогонов не читается: ${unreadableManifests} — пропущены в инвентаре`);
  }
  lines.push(
    limits.length > 0
      ? "Ограничения контроля и данных:"
      : `Ограничения контроля: ${NO_DATA} (нарушений контроля не обнаружено)`,
  );
  for (const limit of limits) lines.push(`- ${limit}`);
  return lines;
}

function renderSummarySection(input: {
  name: string;
  state: ReconstructedJsonlState;
  activeEpoch: number;
  scan: MeasurementLedgerScan;
  verification: MeasurementVerificationState;
  scale: MeasurementScaleStatus;
  floor: NoiseFloorStatus;
  suppression: string | null;
  conf: ConfidenceView;
  findings: FindingView[];
  storeOk: boolean;
  gates: number;
  queue: number;
  deadEnds: number;
  ideas: number;
}): string[] {
  const lines = ["## 7. Сводка"];
  const { state } = input;
  const unit = state.metricUnit;
  const direction = state.bestDirection === "lower" ? "меньше" : "больше";
  lines.push(`- Кампания: "${input.name}" · метрика ${state.metricName}${unit ? ` [${unit}]` : ""} · лучше: ${direction}`);

  if (state.results.length === 0) {
    lines.push(`- Прогоны: ${NO_DATA}`);
  } else {
    const byStatus = new Map<string, number>();
    for (const r of state.results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const statusPart = ["keep", "discard", "crash", "checks_failed", "budget_exceeded", "explore"]
      .filter((s) => (byStatus.get(s) ?? 0) > 0)
      .map((s) => `${s} ${byStatus.get(s)}`)
      .join(" · ");
    const bestPart =
      input.conf.best !== null && input.conf.baseline !== null
        ? ` · baseline ${fmtMetric(input.conf.baseline, unit)} · лучший ${fmtMetric(input.conf.best, unit)}`
        : "";
    lines.push(
      `- Прогоны: ${state.results.length}${statusPart ? ` (${statusPart})` : ""} · активная эпоха ${input.activeEpoch}${bestPart}`,
    );
  }

  if (input.scan.changes.length === 0) {
    lines.push(`- Measurement-трек: изменений нет (здоровое состояние, эпоха ${input.verification.active_epoch})`);
  } else {
    const status = input.verification.reverted
      ? "последнее изменение ОПРОВЕРГНУТО (откат шкалы)"
      : input.verification.verified
        ? "последнее изменение подтверждено независимой проверкой"
        : input.scale.rescore_pending
          ? "рескор последнего изменения не завершён (rescore_pending)"
          : "последнее изменение предварительное (needs_verification не снят)";
    lines.push(
      `- Measurement-трек: изменений ${input.scan.changes.length} · активная шкала эпоха ${input.verification.active_epoch} · ${status}`,
    );
  }

  const noisePart =
    input.floor.floor === null
      ? "floor не калиброван"
      : `floor ±${Number((input.floor.floor * 100).toFixed(2))}%${input.floor.stale ? " (floor_stale)" : " (свежий)"}`;
  const confPart =
    input.suppression !== null
      ? "уверенность подавлена"
      : input.conf.value !== null
        ? `уверенность ${input.conf.value.toFixed(1)}×`
        : `уверенность: ${NO_DATA}`;
  lines.push(`- Шум: ${noisePart} · ${confPart}`);

  if (!input.storeOk) {
    lines.push("- Находки: хранилище не читается (см. «Ограничения»)");
  } else if (input.findings.length === 0) {
    lines.push(`- Находки: ${LENS_NOT_USED}`);
  } else {
    const open = input.findings.filter((f) => f.status === "open").length;
    lines.push(
      `- Находки: всего ${input.findings.length} · открытых ${open} · ` +
        `требуют независимой проверки ${input.queue} · owner-гейтов ${input.gates}`,
    );
  }
  lines.push(`- Dead-ends: ${input.deadEnds} · неразобранные идеи: ${input.ideas}`);
  return lines;
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the campaign report for `workDir` as markdown. Pure: reads campaign
 * data, returns the text; the caller (task 3.2) persists `.auto/report.md`.
 * Never throws; idempotent on unchanged campaign data.
 */
export function buildReport(workDir: string): string {
  try {
    return buildReportUnsafe(workDir);
  } catch (e) {
    // A broken generator must not break finalize (task 3.2): degrade to a
    // report that still carries all seven sections, explicitly marked.
    const reason = e instanceof Error ? e.message : String(e);
    return [
      "# Отчёт кампании: Autoresearch",
      "",
      `> Отчёт построен не полностью — ошибка генератора: ${reason}`,
      "",
      "## 1. Прогоны и метрики",
      NO_DATA,
      "",
      "## 2. Находки по темам",
      NO_DATA,
      "",
      "## 3. Measurement-трек",
      NO_DATA,
      "",
      "## 4. Шум и уверенность",
      NO_DATA,
      "",
      "## 5. Идеи и dead-ends",
      NO_DATA,
      "",
      "## 6. Ограничения и owner-input gates",
      `- отчёт не построен: ${reason}`,
      "",
      "## 7. Сводка",
      `- отчёт не построен: ${reason}`,
      "",
    ].join("\n");
  }
}

function buildReportUnsafe(workDir: string): string {
  const ledgerText = readTextSafe(sessionFilePath(workDir, "log")) ?? "";
  const state = reconstructJsonlState(ledgerText);

  const floorCfg = readNoiseFloorConfig(workDir);
  const floor = noiseFloorStatus(ledgerText, floorCfg);
  const scale = measurementScaleStatus(ledgerText);
  const verification = measurementVerificationState(ledgerText);
  const measurer = measurerControlOfDir(workDir, ledgerText);
  const scan = scanMeasurementLedger(ledgerText);

  const loadedFindings = loadFindings(workDir);
  const storeOk = loadedFindings.ok;
  const storeErrors = loadedFindings.ok ? [] : loadedFindings.errors;
  const findings = loadedFindings.ok ? [...loadedFindings.value.findings.values()] : [];

  // The ACTIVE scale epoch (task 2.8): restored after a refuted change — the
  // epoch all in-window numbers (baseline, best, confidence) belong to.
  const activeEpoch = verification.active_epoch;
  const conf = confidenceOf(state, activeEpoch, state.bestDirection);
  const suppression = confidenceSuppressionReason(scale, floor);

  const { runs: manifests, unreadable: unreadableManifests } = readRunManifests(workDir);
  const tree = treeExists(workDir) ? loadTree(workDir) : null;
  const { deadEnds, unreadable: deadEndsUnreadable } = deadEndsOf(workDir, tree);
  const ideas = untriedIdeaFiles(workDir);
  const artifacts = measurementArtifacts(workDir);

  // Summary counters mirror the section filters above: verification queue =
  // unverified flagged measurement findings (verified excluded — the flag is
  // never cleared by findings.ts, so only that exclusion lets the queue
  // empty); owner gates = capability/tradeoff at any status.
  const queue = findings.filter(
    (f) => f.theme === "measurement" && f.needs_verification && f.status !== "verified",
  ).length;
  const gates = findings.filter(
    (f) => f.theme === "capability" || f.theme === "tradeoff",
  ).length;

  const sections: string[] = [];
  sections.push(`# Отчёт кампании: ${state.name ?? "Autoresearch"}`, "");
  sections.push(...renderRunsSection(state, activeEpoch, manifests, unreadableManifests, workDir), "");
  sections.push(...renderFindingsSection(findings, storeOk), "");
  sections.push(...renderMeasurementSection(scan, state, scale, verification, artifacts), "");
  sections.push(...renderNoiseSection(floor, suppression, conf, state.metricUnit), "");
  sections.push(...renderIdeasSection(deadEnds, ideas), "");
  sections.push(
    ...renderGatesSection(findings, storeOk, storeErrors, measurer, deadEndsUnreadable, unreadableManifests),
    "",
  );
  sections.push(
    ...renderSummarySection({
      name: state.name ?? "Autoresearch",
      state,
      activeEpoch,
      scan,
      verification,
      scale,
      floor,
      suppression,
      conf,
      findings,
      storeOk,
      gates,
      queue,
      deadEnds: deadEnds.length,
      ideas: ideas.length,
    }),
    "",
  );
  return sections.join("\n");
}
