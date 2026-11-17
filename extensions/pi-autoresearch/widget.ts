/** TUI rendering helpers extracted from the extension entry point.
 *
 * Renderers stay pure functions of their arguments (files, ledger text, tree,
 * experiment state): no extension runtime state is read here, so tests and the
 * widget render path resolve exactly the same output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { briefChatMarkdown } from "./brief-consent.ts";
import * as researchState from "./research-state.ts";
import * as expedition from "./expedition.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import {
  currentResults,
  epochResults,
  findBaselineMetric,
  findBaselineSecondary,
  isBetter,
  priorEpochBest,
  resultEpoch,
  segmentEpoch,
} from "./ledger-metrics.ts";
import {
  formatMeasurementScale,
  measurementVerificationState,
  type MeasurementScaleStatus,
  type NoiseFloorStatus,
} from "./measurement.ts";
import type { ExperimentTree, TreeNode } from "./parallel/treeview.ts";

export interface ASI {
  [key: string]: unknown;
}

export interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed" | "budget_exceeded";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Measurement epoch (task 2.3). Absent or broken = epoch 1 (see resultEpoch). */
  epoch?: number;
  /** Ledger run number (bd 51n.1). Populated at log_experiment; ledger rows
   *  reconstructed before this field existed have runNumber undefined, so
   *  comparisons must treat undefined as "unknown, never equal a real number". */
  runNumber?: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
}

export type BriefTargetResolver = (
  workDir: string,
  ctx: ExtensionContext,
) => researchState.Result<{ dir: string; id: string }>;

/** Resolve the pinned (or single on-disk) campaign for the brief preview.
 *  Returns null when no campaign could be resolved; callers own the state so
 *  separate extension instances never share it. */
export function resolveBriefPreviewDir(
  ctx: ExtensionContext,
  resolveWorkDir: (cwd: string) => string,
  resolveTarget: BriefTargetResolver,
): string | null {
  const target = resolveTarget(resolveWorkDir(ctx.cwd), ctx);
  return target.ok ? target.dir : null;
}

export function briefTranscriptText(dir: string | null): string {
  if (dir === null) return "Бриф для показа не найден: в этой сессии не было research_brief draft.";
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(dir, researchState.BRIEF_FILE));
  } catch {
    return "Бриф для показа не найден: brief.json отсутствует.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return "brief.json не читается как JSON.";
  }
  const validation = researchState.validateBrief(parsed);
  if (!validation.ok) return "brief.json не проходит проверку.";
  return briefChatMarkdown(validation.brief, researchState.sha256Hex(bytes), path.basename(dir));
}

/** Synchronously reads expedition artifacts for the TUI. The map intentionally does not verify journal hashes.
 *  Campaign facts (phase, question progress) are re-read from files on every call: the caller reads
 *  them inside render(), so the widget is a pure function of files and never goes stale. */
export function buildExpeditionWidgetLines(
  chainDir: string,
  campaignDir: string | null,
  info: { campaignId: string | null; campaignsUsed: number; campaignsLimit: number | null; chainStatus: string },
): string[] {
  try {
    const journal = fs.readFileSync(path.join(chainDir, "chain.json"), "utf8");
    const entries = journal.split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line));
    const replay = expedition.replayExpeditionMap(entries);
    if (!replay.ok) return ["(map unavailable: journal damaged)"];
    const openQuestions: string[] = [];
    let campaignPhase: string | null = null;
    let closedQuestions = 0;
    let totalQuestions = 0;
    if (campaignDir) {
      // Independent try blocks: an unreadable brief.json must not discard the
      // open-question set from a perfectly readable log.jsonl (the ids fallback).
      let questionTexts: Map<string, string> | null = null;
      try {
        const brief = JSON.parse(fs.readFileSync(path.join(campaignDir, "brief.json"), "utf8"));
        questionTexts = new Map((Array.isArray(brief.questions) ? brief.questions : []).map((q: any) => [q.id, q.text ?? q.id]));
        totalQuestions = questionTexts.size;
      } catch { /* brief is optional; question texts fall back to ids */ }
      try {
        const log = fs.readFileSync(path.join(campaignDir, "log.jsonl"), "utf8");
        const opened = new Set<string>();
        const closed = new Set<string>();
        for (const line of log.split(/\r?\n/).filter(Boolean)) {
          const event = JSON.parse(line);
          const id = event.question_id ?? event.questionId;
          if (typeof id !== "string") continue;
          const action = event.event ?? event.type;
          if (action === "question_opened" || action === "open") opened.add(id);
          if (action === "question_closed" || action === "close") { opened.delete(id); closed.add(id); }
        }
        for (const id of opened) openQuestions.push(String(questionTexts?.get(id) ?? id));
        closedQuestions = closed.size;
      } catch { /* log is optional for rendering; map remains useful */ }
      try {
        // Sync phase read (inspectCampaign is async; the widget render must stay sync).
        const state = JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8"));
        if (typeof state.phase === "string") campaignPhase = state.phase;
      } catch { /* unreadable state degrades the phase to null */ }
    }
    return expedition.expeditionWidgetLines(replay.map, { ...info, campaignPhase, openQuestions, closedQuestions: totalQuestions > 0 ? Math.min(closedQuestions, totalQuestions) : closedQuestions, totalQuestions });
  } catch {
    return ["(map unavailable)"];
  }
}

/**
 * Epoch of each tree node (task 2.3): the epoch of its run in the ledger (runRef).
 * A node without a ledger run inherits its parent's epoch; the root defaults to 1.
 */
function treeNodeEpochs(tree: ExperimentTree, ledgerText: string): Map<string, number> {
  const runEpochs = new Map<number, number>();
  for (const run of reconstructJsonlState(ledgerText).results) runEpochs.set(run.run, run.epoch);

  const epochs = new Map<string, number>();
  const epochOf = (id: string): number => {
    const known = epochs.get(id);
    if (known !== undefined) return known;
    epochs.set(id, 1); // provisional value also terminates a parent cycle in a corrupted tree
    const node = tree.nodes[id];
    let epoch = 1;
    if (node?.runRef !== undefined && runEpochs.has(node.runRef)) {
      epoch = runEpochs.get(node.runRef) ?? 1;
    } else if (node?.parentId && tree.nodes[node.parentId]) {
      epoch = epochOf(node.parentId);
    }
    epochs.set(id, epoch);
    return epoch;
  };
  for (const id of Object.keys(tree.nodes)) epochOf(id);
  return epochs;
}

/** Tree view of the current epoch (task 2.3) with the earlier epoch's best as a cross-epoch reference. */
export interface EpochTreeView {
  /** Current epoch: the ledger's ACTIVE scale epoch (task 2.8 — the last confirmed epoch, restored after a revert). */
  epoch: number;
  /**
   * Tree restricted to the current epoch: nodes of other epochs are removed and
   * their children re-attach to the nearest in-epoch ancestor (the root stays).
   * ★ best and every delta in the tree view are computed on this tree only.
   */
  scoped: ExperimentTree;
  /** Best keep experiment of the nearest earlier epoch (reference only), or null. */
  prior: { epoch: number; node: TreeNode } | null;
}

export function epochTreeView(tree: ExperimentTree, ledgerText: string): EpochTreeView {
  const epochs = treeNodeEpochs(tree, ledgerText);
  // Task 2.8 (revert): the current epoch is the ACTIVE scale epoch from the
  // measurement fold — the last confirmed epoch, restored after a refuted
  // change. The old max(reconstruct.currentEpoch, node epochs) resurrected the
  // rejected scale: its nodes (incomparable runs) would re-scope the view onto
  // the epoch that was just reverted instead of staying outside of it.
  const epoch = measurementVerificationState(ledgerText).active_epoch;

  const ids = Object.keys(tree.nodes);
  const inScope = (id: string): boolean => id === tree.rootId || (epochs.get(id) ?? 1) === epoch;
  const kept = new Set(ids.filter(inScope));

  const nodes: Record<string, TreeNode> = {};
  for (const id of kept) nodes[id] = { ...tree.nodes[id], parentId: null, children: [] };
  for (const id of kept) {
    if (id === tree.rootId) continue;
    let parentId = tree.nodes[id].parentId;
    for (let hops = 0; parentId !== null && !kept.has(parentId) && hops <= ids.length; hops++) {
      parentId = tree.nodes[parentId]?.parentId ?? null;
    }
    if (parentId !== null && kept.has(parentId)) {
      nodes[id].parentId = parentId;
      nodes[parentId].children.push(id);
    }
  }

  // Baseline of the scoped tree (task 2.3). Epoch 1 keeps the root baseline. A later
  // epoch takes the metric of its first run in the tree: the root's epoch-1 value would
  // turn every delta of the epoch's body and node cards into a cross-epoch percentage.
  let baselineMetric = tree.baselineMetric;
  if (epoch > 1) {
    baselineMetric = 0;
    let firstRunRef = Infinity;
    for (const id of kept) {
      const node = nodes[id];
      if (id === tree.rootId || node.runRef === undefined || node.runRef >= firstRunRef) continue;
      firstRunRef = node.runRef;
      baselineMetric = node.metric;
    }
  }

  let prior: { epoch: number; node: TreeNode } | null = null;
  for (const node of Object.values(tree.nodes)) {
    const nodeEpoch = epochs.get(node.id) ?? 1;
    if (nodeEpoch >= epoch) continue;
    if ((node.nodeType !== "experiment" && node.nodeType !== "compose") || node.status !== "keep" || node.metric <= 0) continue;
    if (prior === null || nodeEpoch > prior.epoch || (nodeEpoch === prior.epoch && isBetter(node.metric, prior.node.metric, tree.direction))) {
      prior = { epoch: nodeEpoch, node };
    }
  }

  return { epoch, scoped: { ...tree, nodes, baselineMetric }, prior };
}

/** Format a number with comma-separated thousands: 15586 → "15,586" */
function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

function findBaselineRunNumber(
  results: ExperimentResult[],
  segment: number,
  epoch: number = segmentEpoch(results, segment),
): number | null {
  const index = results.findIndex((result) => result.segment === segment && resultEpoch(result) === epoch);
  return index >= 0 ? index + 1 : null;
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

// Dashboard table renderer (pure function, no UI deps). `scale` (task 2.4) is
// the dual-scale status folded from the ledger by the caller — measurement.ts
// owns the fold; null = caller did not fetch it (line absent, legacy behavior).
export function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = [],
  scale: MeasurementScaleStatus | null = null,
  floor: NoiseFloorStatus | null = null
): string[] {
  const lines: string[] = [];

  // Dual-scale line (task 2.4): both scale scores side by side, with the
  // rescore_pending / preliminary (needs_verification) marks. Shown in the
  // empty state too (minor review 2.4): a measurement_change can open its
  // epoch before the first run lands — the empty dashboard must not hide it.
  const scaleLine = (s: MeasurementScaleStatus): string => {
    const scaleColor: Parameters<typeof th.fg>[0] =
      s.rescore_pending ? "warning" : s.provisional ? "muted" : "success";
    return truncateToWidth(`  ${th.fg(scaleColor, formatMeasurementScale(s))}`, width);
  };

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    if (scale !== null) lines.push(scaleLine(scale));
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  // Current epoch (task 2.3): the highest of the runs' epochs and the ledger's
  // scale epoch — a measurement_change opens its epoch before the first run.
  // An epoch with no runs yet has no baseline of its own (shown as —). The
  // Runs-line confidence stays as computed for the last epoch with runs (2.4
  // contract: shown unless rescore_pending) until the epoch's first run lands.
  // Task 2.8 (revert): with the scale fold available, the current epoch IS the
  // ACTIVE scale epoch — after a refuted change it is restored BELOW the runs'
  // max epoch, and the old max(runsEpoch, scale.epoch) would resurrect the
  // rejected scale (its runs stamped as current, the restored epoch dimmed).
  // The epoch COUNTER for new change ids keeps max semantics inside
  // measurement.ts/jsonl.ts — this line is about which scale is in force.
  const runsEpoch = segmentEpoch(st.results, st.currentSegment);
  const epoch = scale !== null ? scale.epoch : runsEpoch;
  // «Epoch open without runs» generalizes (task 2.8): NO run of THIS epoch in
  // the current segment — the restored epoch can sit below the runs' max epoch
  // while its own runs are absent from the segment (old `epoch > runsEpoch`
  // only covered the epoch-above case and was wrong after a revert).
  const epochOpenWithoutRuns = epochResults(st.results, st.currentSegment, epoch).length === 0;

  const baseline = epochOpenWithoutRuns ? null : st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment, epoch);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics, epoch);

  // Find best kept primary metric and its run number (current epoch of the current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment || resultEpoch(r) !== epoch) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary. Confidence is SUPPRESSED while a measurer rescore is pending
  // (task 2.4) or the noise floor is stale (task 2.5): the number would mix the
  // scales / rest on an outdated floor, so an honest marker replaces it (keep
  // is never blocked — the scale/floor marks in log_experiment explain).
  const confSuppressedReason =
    scale !== null && scale.rescore_pending ? "rescore_pending"
    : floor !== null && floor.stale ? "floor_stale"
    : null;
  const confSuffix = confSuppressedReason !== null
    ? `  ${th.fg("warning", `(conf: suppressed — ${confSuppressedReason})`)}`
    : st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Dual-scale line (task 2.4): both scale scores side by side, with the
  // rescore_pending / preliminary (needs_verification) marks.
  if (scale !== null) {
    lines.push(scaleLine(scale));
  }

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  // Cross-epoch reference (task 2.3): the earlier epoch's best is shown with its
  // scale mark, but no delta is computed against it.
  const priorBest = priorEpochBest(st.results, st.currentSegment, epoch, st.bestDirection);
  if (priorBest !== null) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("muted", "Cross-epoch:")} ${th.fg("dim", `e${priorBest.epoch} best ★ ${st.metricName}: ${formatNum(priorBest.metric, st.metricUnit)} #${priorBest.runNumber} — other scale, delta not computed`)}`,
        width
      )
    );
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  const col = { idx: 3, commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = epochOpenWithoutRuns ? null : findBaselineMetric(st.results, st.currentSegment, epoch);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics,
    epoch
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment && resultEpoch(x) === epoch);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;
    // Earlier epoch of the same segment: other scale, rendered dim, never colored against the current baseline.
    const isPriorEpoch = !isOld && resultEpoch(r) < epoch;
    if (i > startIdx && resultEpoch(st.results[i - 1]) !== resultEpoch(r)) {
      lines.push(truncateToWidth(`  ${th.fg("dim", `── epoch ${resultEpoch(r)} ──`)}`, width));
    }

    const color = isOld || isPriorEpoch
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld || isPriorEpoch ? "dim" : "text";
    if (!isOld && !isPriorEpoch) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}
