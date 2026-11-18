/**
 * log_experiment tool (extracted from index.ts, byte-identical tool body).
 * The tool definition, renderer, refusal text, guard order, schema, ledger writes,
 * git/tree operations and metrics are unchanged. Extension-local collaborators
 * arrive through a wide `deps` object; late-declared helpers and mutable UI
 * state are passed as getters so they are read at call time (no TDZ).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_DIR, ensureParentDir, sessionFilePath } from "./paths.ts";
import { computeState, markIdeaTried } from "./observer.ts";
import { keepStatus } from "./confidence.ts";
import { highestRunDirNumber } from "./lens.ts";
import { appendRunLinkRecord, consumeRunIdentity, resetRunIdentities, runLinkOf, type RunLinkVerdict } from "./run-links.ts";
import {
  currentResults, epochResults, findBaselineMetric, findBaselineSecondary, findBestRunNumber,
  isBetter, priorEpochBest, resultEpoch, segmentEpoch,
} from "./ledger-metrics.ts";
import {
  confidenceSuppressionReason, formatFloorStale, formatMeasurementScale,
  measurementScaleStatusOfDir, noiseFloorStatusOfDir,
} from "./measurement.ts";
import { formatNum, type ASI, type ExperimentResult, type ExperimentState } from "./widget.ts";
import { treeExists, loadTree, findRunningNode } from "./parallel/tree.ts";
import { inferMetricUnit, parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import { readAnalysis } from "./research-analysis.ts";
import {
  computeExhaustionState, exhaustionHintsBetween, ADVISORY_DISCLAIMER, ADVISORY_THRESHOLDS,
  EXHAUSTION_DISCLAIMER, type ExhaustionHint, type ExhaustionState,
} from "./exhaustion-hints.ts";
import { readObservations, type ObservationRecord } from "./research-observations.ts";
import { journalTarget } from "./research-journal.ts";

type LogExperimentTool = Parameters<ExtensionAPI["registerTool"]>[0];
type LogDetails = {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
  metricProvenance?: string;
};

const autoresearchJsonlPath = (dir: string) => sessionFilePath(dir, "log");

/** Extension-local collaborators injected by index.ts. */
export interface LogExperimentToolDeps {
  pi: ExtensionAPI;
  LogParams: any;
  ACTIVITY_TYPES: readonly string[];
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  buildSessionSnapshot: (state: ExperimentState) => unknown;
  broadcastDashboardUpdate: (workDir: string) => void;
  campaignBlockedResponse: () => { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
  campaignBlocksOrdinaryLoop: (workDir: string) => Promise<boolean>;
  cloneExperimentState: (state: ExperimentState) => ExperimentState;
  computeConfidence: (results: ExperimentResult[], segment: number, direction: "lower" | "higher", epoch?: number) => number | null;
  execBashScript: (args: string[], opts?: Record<string, unknown>) => Promise<unknown>;
  finalizeExistingNode: (execFn: unknown, workDir: string, nodeId: string, experiment: ExperimentResult, asi: ASI | null) => Promise<string | null>;
  fireHook: (payload: unknown, ctx?: unknown) => Promise<string | null>;
  getRuntime: (ctx: ExtensionContext) => any;
  optimizeNotStartedGate: (ctx: ExtensionContext) => unknown;
  overlayTui: { requestRender: () => void } | null;
  readLedgerMaxRun: (workDir: string) => number;
  recordAutoresearchActivation: (workDir: string, active: boolean) => void;
  recordTreeNode: (execFn: unknown, workDir: string, payload: unknown) => Promise<string | null>;
  researchBlockedResponse: () => { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
  researchBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  resolveWorkDir: (cwd: string) => string;
  runLinkNotConsumedWarning: (runtime: any) => string;
  setAutoresearchMode: (ctx: ExtensionContext, enabled: boolean) => void;
  updateWidget: (ctx: ExtensionContext) => void;
  validateWorkDir: (cwd: string) => string | null;
}

  // =======================================================================
  // research-map: shared helpers (§8.1 passport view, §12.4 hint delivery)
  // =======================================================================

  /** Component names of the §8.1 minimum passport. */
  export const PASSPORT_COMPONENTS = ["weights", "prompt", "dataset", "measurer", "code_ref"] as const;

  /**
   * §8.1/D-RM-06 passport view for an ordinary run. Components come ONLY from
   * passport-bearing observations of the run, and only while the CURRENTLY
   * recomputed link of the run (§5.2 runLinkOf, passed in as `verdict`) is
   * proven — stored run_link snapshots are never trusted (§8.1: the link and
   * epoch are recomputed at every read). The run id comes from the ledger, the
   * run epoch from the verdict (proven basis only, else unknown). Unknown
   * fields stay unknown; refs are declared, never verified; no file reads for
   * refs (I-12). Pure over its inputs.
   */
  export function runPassportView(
    verdict: RunLinkVerdict,
    observations: readonly ObservationRecord[],
    runNumber: number,
  ): {
    run: number;
    run_epoch: number | null;
    run_epoch_basis: RunLinkVerdict["runEpochBasis"];
    components: Record<string, { state: "declared" | "unknown"; ref: string | null; declared_sha256: string | null; verified: false; note: string | null; conflict?: "passport_conflict" }>;
  } {
    const components: Record<string, { state: "declared" | "unknown"; ref: string | null; declared_sha256: string | null; verified: false; note: string | null; conflict?: "passport_conflict" }> = {};
    const eligible = verdict.link === "proven"
      ? observations.filter((record) => record.observed_run === runNumber && record.passport !== undefined)
      : [];
    for (const name of PASSPORT_COMPONENTS) {
      // §8.1: incompatible declarations are never guessed away. Collect the
      // distinct declared (ref, declared_sha256) pairs over ALL eligible
      // observations; the component resolves only when they agree.
      const pairs = new Set<string>();
      let single: { ref: string | null; declared_sha256: string | null } | null = null;
      for (const record of eligible) {
        const component = record.passport!.components[name];
        if (component === undefined || component.state !== "declared") continue;
        const key = `${JSON.stringify(component.ref)}\u0000${JSON.stringify(component.declared_sha256)}`;
        pairs.add(key);
        if (pairs.size === 1) single = { ref: component.ref, declared_sha256: component.declared_sha256 };
      }
      if (pairs.size === 0) {
        components[name] = { state: "unknown", ref: null, declared_sha256: null, verified: false, note: "not_provided" };
      } else if (pairs.size === 1 && single !== null) {
        components[name] = { state: "declared", ref: single.ref, declared_sha256: single.declared_sha256, verified: false, note: null };
      } else {
        // §8.2 note enum is closed (not_provided | invalid_ref | non_local_ref
        // | denied_by_policy), so the conflict stays note:"not_provided"; the
        // incompatible-declaration case is carried by a separate VIEW-ONLY key
        // on this response component (never written to stored records).
        // OPEN QUESTION for the spec owner: §8.2 does not yet define this
        // response-view key.
        components[name] = { state: "unknown", ref: null, declared_sha256: null, verified: false, note: "not_provided", conflict: "passport_conflict" };
      }
    }
    return {
      run: runNumber,
      run_epoch: verdict.runEpoch,
      run_epoch_basis: verdict.runEpochBasis,
      components,
    };
  }

  /**
   * One merged hint line per response (§12.3b): ALL causes join into ONE line —
   * each cause segment keeps its own code (already inside its text), and the
   * shared disclaimer(s) close the line exactly once. Dropping hints[1..] would
   * lose one-shot transitions (S_stag / S_ser fire only on the crossing), so
   * no cause is ever discarded.
   */
  export function formatExhaustionHintLine(hints: readonly ExhaustionHint[]): string | null {
    if (hints.length === 0) return null;
    const causes = hints.map((hint) =>
      hint.text
        .split(EXHAUSTION_DISCLAIMER).join(" ")
        .split(ADVISORY_DISCLAIMER).join(" ")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
    // Trusted causes carry the exhaustion disclaimer, advisory causes the
    // advisory one (§12.3b) — each appended once, at the end of the line.
    const shared: string[] = [];
    if (hints.some((hint) => hint.kind !== "S_exh_adv")) shared.push(EXHAUSTION_DISCLAIMER);
    if (hints.some((hint) => hint.kind === "S_exh_adv")) shared.push(ADVISORY_DISCLAIMER);
    return `\n💡 ${causes.join(" | ")} ${shared.join(" ")}`;
  }

  /**
   * §12.4 log_experiment hint: S_stag / S_ser transitions plus trusted S_exh
   * rises (12.4a lifecycle). Computed from the files before and after the
   * ledger row; nothing is persisted. At most one hint line (§12.3b).
   * `before` is the pre-append snapshot from researchMapPreState (null when
   * the pre-state could not be read: an unknown value never yields a hint).
   * A torn before-state (§5.2: a non-empty line parseJsonlEntry cannot parse —
   * unterminated fragment or complete-but-invalid line alike) makes the
   * pre-append state unknown (§12.4a), and §12.4 forbids a hint when either
   * value is unknown → no hint of any kind (M-a fix).
   */
  function researchMapLogHint(
    workDir: string,
    before: { exhaustion: ExhaustionState | null; stagAfter: boolean; serAfter: boolean; torn: boolean } | null,
  ): string | null {
    if (before === null || before.torn) return null;
    const autoDir = path.join(workDir, AUTO_DIR);
    try {
      const after = computeExhaustionState(autoDir);
      const hints: ExhaustionHint[] = [];
      // S_exh trusted stage rises (before = the pre-append file state).
      if (before.exhaustion !== null) {
        hints.push(...exhaustionHintsBetween(before.exhaustion, after));
      }
      // S_stag / S_ser over the current segment (§12.4: same counters as
      // computeState). A torn/incomplete ledger tail makes the states unknown
      // (12.4a: «неполная строка после последнего маркера → unknown») — no hint.
      if (!ledgerTailTorn(workDir)) {
        try {
          const ledgerText = fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8");
          const reconstructed = reconstructJsonlState(ledgerText);
          // Legacy phase rows (status "explore") are excluded for compatibility;
          // the current log_experiment schema cannot write them.
          const segRuns = reconstructed.results.filter((r) => r.segment === reconstructed.currentSegment && r.status !== "explore");
          const stateAfter = computeState(segRuns, reconstructed.bestDirection);
          const trailingAfter = trailingBestImprovements(segRuns, reconstructed.bestDirection);
          if (before.stagAfter === false && stateAfter.runsSinceBestImprovement >= K_STAG_RUNS) {
            hints.push({
              kind: "S_stag",
              axis: "",
              key: null,
              stage: null,
              threshold: null,
              n: stateAfter.runsSinceBestImprovement,
              text:
                `Предлагается обзор направлений (S_stag): это документ, а не действие. ${EXHAUSTION_DISCLAIMER} ` +
                "Для документа вызовите `direction_review`. Эксперименты не запускались.",
            });
          }
          if (before.serAfter === false && trailingAfter >= K_SER_RUNS) {
            hints.push({
              kind: "S_ser",
              axis: "",
              key: null,
              stage: null,
              threshold: null,
              n: stateAfter.streak,
              text:
                `Предлагается обзор направлений (S_ser): это документ, а не действие. ${EXHAUSTION_DISCLAIMER} ` +
                "Для документа вызовите `direction_review`. Эксперименты не запускались.",
            });
          }
        } catch { /* ledger read failed: S_stag/S_ser stay unknown — no hint */ }
      }
      return formatExhaustionHintLine(hints);
    } catch { /* engine failure never fails the log */ }
    return null;
  }

  /**
   * §12.4 trigger thresholds (DRAFT DQ-01; K_SER counts best-improving runs).
   * Legacy ledger rows with status "explore" are excluded from S_stag and S_ser
   * counters for backward compatibility; the status is no longer writable.
   */
  export const K_STAG_RUNS = 8;
  export const K_SER_RUNS = 3;

  /**
   * §12.4 S_ser value: trailing consecutive best-improving runs of the segment
   * (DQ-05). Uses computeState's isBetter criterion (keep, metric ≠ 0, strictly
   * better than the running best) — NOT computeState.streak, which counts
   * non-improvements.
   */
  export function trailingBestImprovements(runs: { status: string; metric: number }[], direction: "lower" | "higher"): number {
    let best: number | null = null;
    const flags: boolean[] = [];
    for (const r of runs) {
      // Owner decision: explore rows are invisible to the counter — they
      // neither increment nor reset it (see K_STAG_RUNS comment).
      if (r.status === "explore") continue;
      const isKeep = r.status === "keep" && r.metric !== 0;
      const isBetter = isKeep && (best === null || (direction === "lower" ? r.metric < best : r.metric > best));
      flags.push(isBetter);
      if (isBetter) best = r.metric;
    }
    let trailing = 0;
    for (let i = flags.length - 1; i >= 0 && flags[i]; i--) trailing++;
    return trailing;
  }

  /**
   * Snapshot of the pre-append ledger for the next log's transition check.
   * A torn tail (§5.2: a non-empty line parseJsonlEntry cannot parse — the
   * spec does not distinguish an unterminated fragment from a
   * complete-but-invalid line; both are torn) makes S_stag/S_ser unknown
   * (§12.4a/T93) and therefore yields NO hint at all (§12.4: any unknown →
   * no hint). The torn flag is carried on the snapshot so researchMapLogHint
   * can refuse to fire over a torn before-state (M-a fix).
   */
  function researchMapPreState(workDir: string): { exhaustion: ExhaustionState | null; stagAfter: boolean; serAfter: boolean; torn: boolean } | null {
    try {
      const ledgerText = fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8");
      const reconstructed = reconstructJsonlState(ledgerText);
      // Owner decision: explore rows are excluded from the S_stag/S_ser
      // counters entirely (neither increment nor reset) — see K_STAG_RUNS.
      const segRuns = reconstructed.results.filter((r) => r.segment === reconstructed.currentSegment && r.status !== "explore");
      const state = computeState(segRuns, reconstructed.bestDirection);
      let exhaustion: ExhaustionState | null = null;
      try {
        exhaustion = computeExhaustionState(path.join(workDir, AUTO_DIR));
      } catch { /* exhaustion stays unknown; S_stag/S_ser still checked */ }
      return {
        exhaustion,
        stagAfter: state.runsSinceBestImprovement >= K_STAG_RUNS,
        serAfter: trailingBestImprovements(segRuns, reconstructed.bestDirection) >= K_SER_RUNS,
        torn: ledgerTailTorn(workDir),
      };
    } catch {
      return null;
    }
  }

  /**
   * §12.3b/§12.4 statement trigger: `review_requested: true` on a comparison
   * proposes a cautious direction review, only when the record is the FIRST
   * valid statement of its axis in the current analysis segment. The decision
   * is deterministic from readAnalysis alone: any torn/invalid line makes the
   * segment unknown → no hint (§12.3b conservative reading). Returns null
   * when no statement hint is due.
   */
  export function reviewRequestedStatementHint(
    autoDir: string,
    params: unknown,
    details: Record<string, unknown>,
  ): ExhaustionHint | null {
    const p = (params ?? {}) as { kind?: unknown; axis?: unknown; review_requested?: unknown };
    if (p.review_requested !== true || p.kind !== "comparison" || typeof p.axis !== "string") return null;
    if (details.kind !== "comparison" || typeof details.id !== "string") return null;
    try {
      const text = fs.readFileSync(journalTarget(autoDir, "analysis").file, "utf8");
      const read = readAnalysis(text);
      // Torn/invalid history → unknown segment → never a hint.
      if (read.torn_lines > 0 || read.invalid > 0) return null;
      const axis = p.axis;
      const earlierStatement = read.records.some((record) =>
        record.id !== details.id &&
        record.kind === "comparison" &&
        record.axis === axis &&
        record.review_requested === true,
      );
      if (earlierStatement) return null;
      const n = read.records.filter((record) => record.kind === "comparison" && record.axis === axis).length;
      return {
        kind: "S_exh_adv",
        axis,
        key: null,
        stage: null,
        threshold: null,
        n,
        text:
          `Предлагается обзор направлений (S_exh_adv, ось ${axis}): заявление review_requested по записи ${details.id}. ` +
          "Сигнал не является доказательством исчерпания и не подтверждает метрическую дельту. " +
          `${ADVISORY_DISCLAIMER} Для документа вызовите \`direction_review\`. Эксперименты не запускались.`,
      };
    } catch { /* unreadable analysis → unknown → no hint */ }
    return null;
  }

  /**
   * True when the last non-empty ledger line is not a JSON object (incomplete
   * tail, §12.4 unknown for S_stag/S_ser). Missing ledger is not torn.
   */
  function ledgerTailTorn(workDir: string): boolean {
    try {
      const lines = fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8").split("\n").filter((l) => l.trim() !== "");
      const last = lines[lines.length - 1];
      return last !== undefined && parseJsonlEntry(last) === null;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // log_observation tool (§7.3) and record_analysis tool (§7.4): registered
  // wrappers around the module factories, bound to the session .auto directory.
  // -----------------------------------------------------------------------


export function createLogExperimentTool(deps: LogExperimentToolDeps): LogExperimentTool {
  const { LogParams } = deps;

  return {
    name: "log_experiment",
    label: "Log Experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment. Blocked while a candidate campaign is active (use candidate_branch).",
    promptSnippet:
      "Log experiment result (commit, metric, status, description)",
    promptGuidelines: [
      "Always call log_experiment after run_experiment to record the result.",
      "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
      "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
      "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
      "If you discover complex but promising optimizations you won't pursue immediately, write them as files in .auto/ideas/ (one .md per idea). Don't let good ideas get lost.",
      "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
      "When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.",
    ],
    parameters: LogParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        pi, ACTIVITY_TYPES, assertModeActive, buildSessionSnapshot, broadcastDashboardUpdate, campaignBlockedResponse, campaignBlocksOrdinaryLoop, cloneExperimentState, computeConfidence, execBashScript, finalizeExistingNode, fireHook, getRuntime, optimizeNotStartedGate, overlayTui, readLedgerMaxRun, recordAutoresearchActivation, recordTreeNode, researchBlockedResponse, researchBlocksOrdinaryLoop, resolveWorkDir, runLinkNotConsumedWarning, setAutoresearchMode, updateWidget, validateWorkDir,
      } = deps;
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      // Candidate-branch campaign guard (tasks 3.2): before any side effect.
      if (validateWorkDir(ctx.cwd) === null && (await campaignBlocksOrdinaryLoop(resolveWorkDir(ctx.cwd)))) {
        return campaignBlockedResponse();
      }
      if (await researchBlocksOrdinaryLoop(resolveWorkDir(ctx.cwd), ctx)) return researchBlockedResponse();
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      const optimizeLogGate = optimizeNotStartedGate(ctx);
      if (optimizeLogGate) return optimizeLogGate as any;
      // Input validation for the optional activity label (D-RM-03): rejected before
      // any side effect, so the ledger, git and the pending run number stay untouched.
      if (params.activity_type !== undefined && !(ACTIVITY_TYPES as readonly string[]).includes(params.activity_type)) {
        return {
          content: [{ type: "text", text: `❌ Invalid activity_type "${String(params.activity_type)}". Allowed: ${ACTIVITY_TYPES.join(", ")}. Omit the parameter when no label applies.${runLinkNotConsumedWarning(runtime)}` }],
          details: {},
        };
      }

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const secondaryMetrics = params.metrics ?? {};

      // §12.4 hint trigger: the file state BEFORE this ledger row. The hint is
      // delivered in the RESPONSE only on a permitted transition; nothing is
      // persisted (no hint state file, no observer involvement).
      const preResearchMap = researchMapPreState(workDir);

      // Honest-metric provenance (goal-x pattern: agent claims are untrusted,
      // the run_experiment measurement is the evidence). Only statuses that
      // carry a real measurement are checked; crash/budget are exempt.
      const provenanceChecked = params.status === "keep" || params.status === "discard" || params.status === "checks_failed";
      let metricProvenance: string | undefined;
      let provenanceNote = "";
      if (provenanceChecked) {
        const measurement = runtime.lastMeasurement;
        if (!measurement) {
          metricProvenance = "unmeasured";
          provenanceNote = "\n⚠ METRIC PROVENANCE: no run_experiment measurement found this session — this value is agent-claimed, NOT measured. Re-run via run_experiment; unmeasured keeps are not trustworthy.";
        } else if (measurement.primary !== null) {
          const tolerance = Math.max(1e-9, Math.abs(measurement.primary) * 0.005);
          if (Math.abs(params.metric - measurement.primary) <= tolerance) {
            metricProvenance = "measured";
          } else {
            metricProvenance = "manual";
            provenanceNote = `\n⚠ METRIC PROVENANCE: logged ${params.metric} differs from the measured ${measurement.primary} (${state.metricName}). The measured value is the evidence — this entry is flagged manual; use the parsed METRIC value run_experiment gave you.`;
          }
        } else {
          // Run happened but no METRIC line was parsed; wall-clock fallback.
          if (Math.abs(params.metric - measurement.wallClockSeconds) <= 2) {
            metricProvenance = "wallclock";
          } else {
            metricProvenance = "manual";
            provenanceNote = `\n⚠ METRIC PROVENANCE: run_experiment parsed no METRIC line and ${params.metric} ≠ wall-clock ${measurement.wallClockSeconds.toFixed(1)}s — value is agent-claimed, flagged manual. Print 'METRIC ${state.metricName}=<value>' from the benchmark.`;
          }
        }
      }

      // Gate: prevent "keep" when last run's checks failed
      if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
        return {
          content: [{
            type: "text",
            text: `❌ Cannot keep — .auto/checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
          }],
          details: {},
        };
      }

      // Validate secondary metrics consistency (after first experiment establishes them)
      let droppedMissing: string[] = [];
      if (state.secondaryMetrics.length > 0) {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        // Metrics the harness stopped producing are recorded, not rejected:
        // the agent must never invent values for them (that is exactly the
        // manual-provenance failure mode).
        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          droppedMissing = missing;
        }

        // Check for new metrics not yet tracked
        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !params.force) {
          return {
            content: [{
              type: "text",
              text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
            }],
            details: {},
          };
        }
      }

      // ASI: agent-supplied free-form diagnostics + honest provenance for
      // previously-tracked metrics the harness no longer produces.
      // The node this run belongs to: the explicit hypothesis_id, or else the running node
      // that log finalization will close (review B6). Group key and finalization both read
      // this one value, so a repeat logged without hypothesis_id still joins its group.
      let linkNodeId: string | null = typeof params.hypothesis_id === "string" && params.hypothesis_id.length > 0 ? params.hypothesis_id : null;
      if (!linkNodeId && treeExists(workDir)) {
        const tree = loadTree(workDir);
        const running = tree ? findRunningNode(tree) : null;
        if (running) linkNodeId = running.id;
      }
      const asiRecord: ASI = { ...((params.asi ?? {}) as ASI) };
      // The group keys are owned by the harness: an agent-supplied asi must not join a
      // repeat group or name a node it did not run (review B5-m3).
      delete asiRecord.hypothesis_node;
      delete asiRecord.repeat_of;
      // experiment-rigor 3.2: the hypothesis node this run belongs to, so repeats of the
      // same node (asi.repeat_of) can be grouped for the noise estimate.
      if (linkNodeId) {
        asiRecord.hypothesis_node = linkNodeId;
        // A run of a repeat node carries its original's id, so it joins that group.
        try {
          const linkedNode = treeExists(workDir) ? loadTree(workDir).nodes[linkNodeId] : undefined;
          if (linkedNode?.repeatOf) asiRecord.repeat_of = linkedNode.repeatOf;
        } catch {
          // unreadable tree: the run keeps its own node key
        }
      }
      if (droppedMissing.length > 0) {
        asiRecord.secondary_metrics_not_measured = droppedMissing.join(", ");
      }
      const mergedASI = Object.keys(asiRecord).length > 0 ? asiRecord : undefined;

      // The run number minted by run_experiment — the same number as its
      // .auto/runs/<n> artifact directory, so inspect_results(run=N) reads
      // THIS run's output. Falls back to above-both numbering only when a
      // log has no preceding run_experiment in this session: the ledger max
      // (gaps, pre-lens history) and the highest orphan run directory both
      // matter, so a fallback entry never collides with an earlier number.
      // Consumed on use: a second log without a new run must not re-bind it.
      const runNumber =
        runtime.lastRunNumber ??
        Math.max(readLedgerMaxRun(workDir), highestRunDirNumber(workDir)) + 1;
      runtime.lastRunNumber = null;
      // Fallback numbering (no in-session run_experiment): a computed fallback
      // number never proves a link (§5.2) — consume the pending slot without
      // binding, so a stale identity cannot attach to a guessed number.
      if (runtime.runLinks.pending !== null && runtime.runLinks.pending.run !== runNumber) {
        runtime.runLinks = resetRunIdentities(runtime.runLinks);
      }

      // Measurement epoch of this run (task 2.3): every run logged now carries the
      // ledger's current scale epoch, so a later measurement_change never leaves it
      // to the epoch-1 default. Read once; the dual-scale block below reuses it.
      // The floor status (task 2.5) comes from the same single sources (ledger
      // epoch via measurement.ts, floor + stamp from .auto/config.json) and feeds
      // the keep-verdict mark, the confidence gate and the noise-floor warning.
      const scaleStatus = measurementScaleStatusOfDir(workDir);
      const runEpoch = scaleStatus.epoch;
      const floorStatus = noiseFloorStatusOfDir(workDir);

      const experiment: ExperimentResult = {
        commit: (params.commit ?? "").slice(0, 7),
        metric: params.metric,
        metrics: secondaryMetrics,
        status: params.status,
        description: params.description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        epoch: runEpoch,
        // Ledger run number (bd 51n.1): the prev-best noise-floor filter
        // excludes THIS run by it; without the field the filter was a no-op
        // (undefined !== undefined === false) and prevBest included the run
        // being logged.
        runNumber,
        confidence: null,
        asi: mergedASI,
      };

      state.results.push(experiment);
      runtime.experimentsThisSession++;

      // Register any new secondary metric names. Unit inference is the SAME
      // rule jsonl.ts's reconstruction uses (bd lrx.2): one implementation,
      // otherwise the reconstructed state and the live state drift apart.
      for (const name of Object.keys(secondaryMetrics)) {
        if (!state.secondaryMetrics.find((m) => m.name === name)) {
          state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
        }
      }

      // Baseline = first run of the ACTIVE epoch in the current segment (task
      // 2.8: the epoch is passed EXPLICITLY — the default segmentEpoch() max
      // would pick the rejected epoch's first run after a revert).
      state.bestMetric = findBaselineMetric(state.results, state.currentSegment, runEpoch);

      // Compute confidence score (best improvement as multiple of noise floor)
      state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection, runEpoch);
      experiment.confidence = state.confidence;

      // experiment-rigor 4.3: a keep is confirmed or preliminary; it is never refused.
      let keepTag = "";
      if (experiment.status === "keep") {
        const keepBaseline = findBaselineMetric(state.results, state.currentSegment, runEpoch);
        const keepRuns = epochResults(state.results, state.currentSegment, runEpoch).filter((r) => r.metric > 0);
        const ks = keepBaseline === null
          ? "preliminary"
          : keepStatus(keepRuns, experiment, keepBaseline, state.bestDirection);
        // Derived, not stored: the ledger row stays byte-identical (run-links invariant).
        // Readers recompute the status with keepStatus (report.ts).
        keepTag = ` (${ks})`;
      }

      // Build response text
      const segmentCount = currentResults(state.results, state.currentSegment).length;
      let text = `Logged #${runNumber}: ${experiment.status}${keepTag} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        // Delta only against the baseline of THIS epoch (task 2.3): a single run of a new epoch has nothing to compare with yet.
        const epochRunCount = epochResults(state.results, state.currentSegment, runEpoch).length;
        if (epochRunCount > 1 && params.status === "keep" && params.metric > 0) {
          const delta = params.metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? "+" : "";
          text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }
      const priorBest = priorEpochBest(state.results, state.currentSegment, runEpoch, state.bestDirection);
      if (priorBest !== null) {
        text += `\nCross-epoch: e${priorBest.epoch} best ${formatNum(priorBest.metric, state.metricUnit)} (run #${priorBest.runNumber}) is on another scale than epoch ${runEpoch} \u2014 delta not computed`;
      }

      if (droppedMissing.length > 0) {
        text += `\nℹ️ Not provided this run: ${droppedMissing.join(", ")}. Either omitted by mistake or the harness no longer outputs them — check the last run_experiment output. Recorded in ASI as secondary_metrics_not_measured. Do NOT invent values for them.`;
      }

      // Show secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics, runEpoch);
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? "";
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = baselines[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? "+" : "";
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join("  ")}`;
      }

      // Show ASI summary
      if (mergedASI) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(mergedASI)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(" | ")}`;
        }
      }

      // Dual-scale accounting (task 2.4): the LEDGER decides the scale state.
      // A measurer change adds the scale line (both scores, provisional mark);
      // while its rescore is pending the confidence score is SUPPRESSED with an
      // honest reason — keep is never blocked, the mark just says the numbers
      // are not comparable yet.
      if (scaleStatus.change_ref !== null) {
        text += `\n📏 ${formatMeasurementScale(scaleStatus)}`;
      }
      // Floor re-evaluation (task 2.5, spec scenario «keep без свежего floor»):
      // a stamped floor older than the current scale epoch is stale — the keep
      // verdict carries the EXPLICIT mark (keep is accepted, never blocked) and
      // the confidence score below stays suppressed until the floor is
      // re-measured on the new scale (noiseFloor + noiseFloorEpoch updated).
      if (params.status === "keep" && floorStatus.stale) {
        text += `\n⚠️ ${formatFloorStale(floorStatus)}`;
      }
      const confidenceSuppression = confidenceSuppressionReason(scaleStatus, floorStatus);

      // Noise floor warning for keep: check if improvement is within calibrated noise.
      // bd 51n.1: this is an INDEPENDENT check — it used to live inside the
      // confidence branch and never ran when confidence was null (no repeat
      // group), which made it dead code for most logs. The floor status comes
      // from the single source (noiseFloorStatusOfDir); prev-best excludes the
      // run being logged BY OBJECT IDENTITY (experiment IS the last pushed
      // entry of state.results) — the old r.runNumber !== experiment.runNumber
      // filter was a no-op (undefined !== undefined === false).
      if (params.status === "keep") {
        try {
          const nf = floorStatus.floor;
          if (nf !== null && state.results.length >= 2) {
            const prevBest = state.results
              .filter((r) => r.segment === state.currentSegment && resultEpoch(r) === runEpoch && r.status === "keep" && r !== experiment)
              .reduce((best, r) => {
                if (state.bestDirection === "lower") return best === null || r.metric < best ? r.metric : best;
                return best === null || r.metric > best ? r.metric : best;
              }, null as number | null);
            if (prevBest !== null) {
              const improvement = state.bestDirection === "lower"
                ? (prevBest - params.metric) / prevBest
                : (params.metric - prevBest) / prevBest;
              if (improvement > 0 && improvement < nf) {
                text += `\n⚠️ NOISE FLOOR: Improvement (${(improvement * 100).toFixed(1)}%) is WITHIN noise floor (±${(nf * 100).toFixed(1)}%). Likely not real.`;
              }
            }
          }
        } catch { /* best-effort */ }
      }

      // Show confidence score (T5: context-aware — different message for keep vs discard)
      if (confidenceSuppression !== null) {
        text +=
          `\n⚠️ Confidence suppressed: ${confidenceSuppression}. ` +
          `This ${params.status} is recorded — the number stays hidden until the scale state is resolved.`;
        if (scaleStatus.rescore_pending) {
          text += ` Finish the rescore with log_measurement_change {change_ref: "${scaleStatus.change_ref}", rescore_ref: <full artifact>}.`;
        }
      } else if (state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        const isKeep = params.status === "keep";
        // Find the run number where the current best was set
        const bestRunNum = findBestRunNumber(state.results, state.currentSegment, state.bestDirection, runEpoch);


        if (isKeep) {
          // This run IS the improvement — confidence refers to THIS run
          if (state.confidence >= 2.0) {
            text += `\n📊 Confidence: ${confStr}× noise floor — this improvement is likely real`;
          } else if (state.confidence >= 1.0) {
            text += `\n📊 Confidence: ${confStr}× noise floor — this improvement is above noise but marginal`;
          } else {
            text += `\n⚠️ Confidence: ${confStr}× noise floor — this improvement is within noise. Consider re-running to confirm before keeping.`;
          }
        } else {
          // This run is discard/crash — confidence refers to the SESSION BEST, not this run
          text += `\n📊 Best (#${bestRunNum}): ${confStr}× noise floor (set at run #${bestRunNum})`;
          if (state.bestMetric !== null && params.metric !== 0) {
            const deltaPct = state.bestDirection === "lower"
              ? ((params.metric - state.bestMetric) / state.bestMetric * 100)
              : ((state.bestMetric - params.metric) / state.bestMetric * 100);
            if (deltaPct > 0) {
              text += `\n📊 This run: ${formatNum(params.metric, state.metricUnit)} (+${deltaPct.toFixed(1)}% vs best ${formatNum(state.bestMetric, state.metricUnit)}) — worse, not an improvement`;
            } else if (deltaPct > -1) {
              text += `\n📊 This run: ${formatNum(params.metric, state.metricUnit)} (~equal to best ${formatNum(state.bestMetric, state.metricUnit)}) — within noise`;
            } else {
              text += `\n📊 This run: ${formatNum(params.metric, state.metricUnit)} — see metric above`;
            }
          }
        }
      }

      if (provenanceNote) {
        text += provenanceNote;
      }

      text += `\n(${segmentCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      // Auto-commit only on keep — discards/crashes get reverted anyway
      if (params.status === "keep") {
        try {
          const resultData: Record<string, unknown> = {
            status: params.status,
            [state.metricName || "metric"]: params.metric,
            ...secondaryMetrics,
          };
          const trailerJson = JSON.stringify(resultData);
          const commitMsg = `${params.description}\n\nResult: ${trailerJson}`;

          const execOpts = { cwd: workDir, timeout: 10000 };
          const addResult = await pi.exec("git", ["add", "-A"], execOpts);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(`git add failed (exit ${addResult.code}): ${addErr.slice(0, 200)}`);
          }

          const diffResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = await pi.exec("git", ["commit", "-m", commitMsg], execOpts);
            const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
            if (gitResult.code === 0) {
              const firstLine = gitOutput.split("\n")[0] || "";
              text += `\n📝 Git: committed — ${firstLine}`;

              try {
                const shaResult = await pi.exec("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeout: 5000 });
                const newSha = (shaResult.stdout || "").trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {
                // Keep the original commit hash if rev-parse fails
              }
            } else {
              text += `\n⚠️ Git commit failed (exit ${gitResult.code}): ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      const jsonlEntry: Record<string, unknown> = {
        run: runNumber,
        ...experiment,
      };
      // The ledger row contract is byte-stable (run-links-wiring "bytes unchanged",
      // §5.1): runNumber is the in-memory twin of the `run` key, never a ledger key.
      delete jsonlEntry.runNumber;
      if (!mergedASI) delete jsonlEntry.asi;
      // Optional label: written only when supplied, so an absent parameter leaves the row unchanged.
      if (params.activity_type !== undefined) jsonlEntry.activity_type = params.activity_type;
      if (metricProvenance && metricProvenance !== "measured") {
        jsonlEntry.mprov = metricProvenance;
        // Re-injection flag (goal-x [AUDITOR REJECTION] pattern): every resume
        // reminds the agent until an honest (measured) log lands.
        runtime.lastLogFlag = `${metricProvenance} metric provenance`;
      } else if (metricProvenance === "measured") {
        runtime.lastLogFlag = null;
      }
      const jsonlLine = JSON.stringify(jsonlEntry);

      // Run-links sidecar (§5.2): consume the pending identity atomically with
      // the run number being logged, and with the EXACT serialized line
      // (sha256Line over the same buffer). Consumption itself does not write the
      // sidecar: on any failure reason (no_pending / run_mismatch / poisoned /
      // incomplete) nothing is written to the sidecar; the response carries a
      // warning and the ledger append below is byte-identical to the
      // pre-research-map behavior. The sidecar record is appended only AFTER the
      // ordinary ledger row write succeeds (§5.2: "после успешной записи обычной
      // строки леджера") — a failed ledger append writes NO sidecar record, so a
      // log_sha256 can never reference a line that never landed. Best-effort: a
      // sidecar write failure never fails the log.
      let runLinkWarning: string | null = null;
      let consumedLink: ReturnType<typeof consumeRunIdentity> | null = null;
      try {
        consumedLink = consumeRunIdentity(runtime.runLinks, runNumber, jsonlLine);
        runtime.runLinks = consumedLink.state;
        if (consumedLink.reason === "no_pending") {
          runLinkWarning = "⚠ Run link not recorded: no pending run identity for this session (research-map §5.2). The ledger row is unaffected; this run cannot be confirmed as proven later.";
        } else if (consumedLink.reason === "run_mismatch") {
          runLinkWarning = "⚠ Run link not recorded: pending identity belongs to another run number. The ledger row is unaffected; this run cannot be confirmed as proven later.";
        } else if (consumedLink.reason === "poisoned") {
          runLinkWarning = "⚠ Run link not recorded: run_experiment calls overlapped in this session, so neither can be proven (research-map §5.2). The ledger row is unaffected.";
        } else if (consumedLink.reason === "incomplete") {
          runLinkWarning = "⚠ Run link not recorded: a run_started/run_result marker write failed for this run. The ledger row is unaffected; this run cannot be confirmed as proven later.";
        }
      } catch (e) {
        runLinkWarning = `⚠ Run link not recorded: ${e instanceof Error ? e.message : String(e)}. The ledger row is unaffected.`;
      }

      let ledgerRowAppended = false;
      try {
        const jsonlPath = autoresearchJsonlPath(workDir);
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, jsonlLine + "\n");
        ledgerRowAppended = true;
        broadcastDashboardUpdate(workDir);
      } catch (e) {
        text += `\n⚠️ Failed to write .auto/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Sidecar AFTER the ledger row (§5.2): only a confirmed link from a
      // successful append above, never for a failed ledger row write.
      if (ledgerRowAppended && consumedLink !== null && consumedLink.link !== null) {
        const appended = await appendRunLinkRecord(path.join(workDir, AUTO_DIR), consumedLink.link);
        if (appended.status !== "appended") {
          runLinkWarning = `⚠ Run link not recorded (run-links sidecar append failed: ${appended.status}). The ledger row is unaffected; this run cannot be confirmed as proven later.`;
        }
      }
      if (runLinkWarning) {
        text += `\n${runLinkWarning}`;
      }

      // §12.4 direction-review hint (E-22): computed from files after the ledger
      // row and the sidecar attempt; at most one line (§12.3b); never on a plain
      // success without a transition; delivered in this response string only.
      try {
        const hintLine = preResearchMap !== null
          ? researchMapLogHint(workDir, preResearchMap)
          : null;
        if (hintLine !== null) text += hintLine;
      } catch { /* hint never fails the log */ }

      // ── Experiment tree: update or create node ──
      // New flow: if hypothesis_id is provided, or a running node exists in tree,
      // finalize the existing hypothesis node. Old flow: for baseline runs
      // without hypothesis_id and no running node, fall back to recordTreeNode.
      const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
        pi.exec(cmd, args, opts);

      // Resolve which node to finalize: explicit hypothesis_id, or last running node.
      const resolveNodeId: string | null = linkNodeId;

      if (resolveNodeId) {
        // ── New flow: finalize existing hypothesis node ──
        const treeWarn = await finalizeExistingNode(
          execFn,
          workDir,
          resolveNodeId,
          experiment,
          mergedASI ?? null,
        );
        if (treeWarn) text += treeWarn;
      } else {
        // ── Old flow: baseline or no hypothesis (create new node) ──
        const treeWarn = await recordTreeNode(
          execFn,
          workDir,
          { experiment, asi: mergedASI ?? null, runNumber: state.results.length },
        );
        if (treeWarn) text += treeWarn;
      }

      // ── Auto-remove tried idea file from .auto/ideas/ ──
      // If ASI contains idea_id (string or array), delete the matching file
      // so countUntriedIdeas stays accurate.
      if (mergedASI) {
        const ideasDir = path.join(workDir, ".auto", "ideas");
        const rawId = (mergedASI as Record<string, unknown>).idea_id;
        const ids: string[] = [];
        if (typeof rawId === "string") ids.push(rawId);
        else if (Array.isArray(rawId)) {
          for (const x of rawId) if (typeof x === "string") ids.push(x);
        }
        for (const id of ids) {
          if (markIdeaTried(ideasDir, id)) {
            text += `\n💡 Idea ${id} removed from .auto/ideas/`;
          }
        }
      }

      // bd 51n.14 (dedup + fail-closed flag): the two revert branches carried the
      // same script verbatim; a fix to the exclude patterns had to be applied
      // twice. One shared revert; a failure sets runtime.lastRevertFailure so
      // the loop keeps re-warning — the tree is DIRTY and the next baseline
      // would be measured on mutated code.
      const revertFor = async (_status: string): Promise<string | null> => {
        try {
          const revertScript = `
            git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
            git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
          `;
          await execBashScript(["-c", revertScript], { cwd: workDir, timeout: 10000 });
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      if (params.status !== "keep" && params.status !== "budget_exceeded") {
        const revertError = await revertFor(params.status);
        if (revertError === null) {
          runtime.lastRevertFailure = null;
          text += `
📝 Git: reverted changes (${params.status}) — autoresearch files preserved`;
        } else {
          runtime.lastRevertFailure = `${params.status}: ${revertError}`;
          text += `
⚠️ Git revert failed (${params.status}): ${revertError}. The tree stays DIRTY — the next baseline is unreliable until a manual revert succeeds.`;
        }
      }

      // budget_exceeded: revert like crash, but emit a dedicated steer so the
      // loop does not keep burning budget on a too-slow measure.sh.
      if (params.status === "budget_exceeded") {
        const revertError = await revertFor("budget_exceeded");
        if (revertError === null) {
          runtime.lastRevertFailure = null;
          text += `
📝 Git: reverted changes (budget_exceeded) — autoresearch files preserved`;
        } else {
          runtime.lastRevertFailure = `budget_exceeded: ${revertError}`;
          text += `
⚠️ Git revert failed (budget_exceeded): ${revertError}. The tree stays DIRTY — the next baseline is unreliable until a manual revert succeeds.`;
        }
      pi.sendUserMessage(
          `⏰ Experiment exceeded the time budget. DO NOT continue the loop with this slow measure.sh.\nOptions: 1) add a BENCH_MODE=quick subset to measure.sh; 2) cache prebuilt setup steps; 3) cut fixture/iter count. Rewrite measure.sh, then re-run.`,
          { deliverAs: "steer" }
        );
      }

      const afterSteer = await fireHook({
        event: "after",
        cwd: workDir,
        run_entry: jsonlEntry,
        session: buildSessionSnapshot(state),
      }, ctx);
      if (afterSteer) pi.sendUserMessage(afterSteer, { deliverAs: "steer" });

      const wallClockSeconds = runtime.lastRunDuration;
      runtime.runningExperiment = null;
      runtime.lastRunChecks = null;
      runtime.lastRunDuration = null;

      const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        recordAutoresearchActivation(workDir, false);
        setAutoresearchMode(ctx, false);
        ctx.abort();
      } else if (runtime.autoresearchMode) {
        text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
        const beforeSteer = await fireHook({
          event: "before",
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: jsonlEntry,
          session: buildSessionSnapshot(state),
        }, ctx);
        if (beforeSteer) pi.sendUserMessage(beforeSteer, { deliverAs: "steer" });
      }

      updateWidget(ctx);

      // Refresh fullscreen overlay if open
      if (overlayTui) overlayTui.requestRender();

      return {
        content: [{ type: "text", text }],
        details: {
          experiment: { ...experiment, metrics: { ...experiment.metrics } },
          state: cloneExperimentState(state),
          wallClockSeconds,
          metricProvenance,
        } as LogDetails,
      };
    },

    renderCall(args, theme) {
      const fg = theme?.fg ? (c: string, v: string) => theme.fg(c, v) : (_c: string, v: string) => v;
      let text = fg("toolTitle", theme?.bold ? theme.bold("log_experiment ") : "log_experiment ");
      const status = String(args?.status ?? "");
      const color =
        status === "keep"
          ? "success"
          : status === "crash" || status === "checks_failed"
            ? "error"
            : "warning";
      text += fg(color, status);
      text += " " + fg("dim", String(args?.description ?? ""));
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as LogDetails | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      const { experiment: exp, state: s } = d;
      const color =
        exp.status === "keep"
          ? "success"
          : exp.status === "crash" || exp.status === "checks_failed"
            ? "error"
            : "warning";
      const icon =
        exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

      let text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `#${s.results.length}`);

      // Show wall-clock and primary metric together
      const metricParts: string[] = [];
      if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
        metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
      }
      if (exp.metric > 0) {
        metricParts.push(`${s.metricName}: ${formatNum(exp.metric, s.metricUnit)}`);
      }
      if (metricParts.length > 0) {
        text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
      }

      text += " " + theme.fg("muted", exp.description);

      // Show best metric for context (overall best, not just this run)
      if (s.bestMetric !== null) {
        // Find the actual best kept metric in the current segment
        let best = s.bestMetric;
        const bestEpoch = segmentEpoch(s.results, s.currentSegment);
        for (const r of s.results) {
          if (r.segment === s.currentSegment && resultEpoch(r) === bestEpoch && r.status === "keep" && r.metric > 0) {
            if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
          }
        }
        text +=
          theme.fg("dim", " │ ") +
          theme.fg("warning", `★ best: ${formatNum(best, s.metricUnit)}`);
      }

      // Show secondary metrics inline
      if (Object.keys(exp.metrics).length > 0) {
        const parts: string[] = [];
        for (const [name, value] of Object.entries(exp.metrics)) {
          const def = s.secondaryMetrics.find((m) => m.name === name);
          parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
        }
        text += theme.fg("dim", `  ${parts.join(" ")}`);
      }

      const revisitsRun = exp.asi?.revisits_run;
      if (typeof revisitsRun === "number" && Number.isInteger(revisitsRun) && revisitsRun > 0) {
        text += "\n" + theme.fg("accent", `↻ Revisiting #${revisitsRun}`);
      }

      return new Text(text, 0, 0);
    },
  };
}
