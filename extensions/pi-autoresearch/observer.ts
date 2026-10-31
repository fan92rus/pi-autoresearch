/**
 * observer.ts — Built-in autoresearch observer (TypeScript port of observer/before.sh).
 *
 * Runs as extension code (not a bash hook) before each iteration.
 * Provides 5 triggers in priority order: finalize, noise gate, floor detection,
 * stagnation escalation, progress milestone.
 *
 * Returns a steer string (or null for silence) that is merged with user hook output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { parseJsonlEntry, reconstructJsonlState, type ReconstructedRun } from "./jsonl.ts";
import { treeExists, loadTree, getPath, failedStreakSinceLastKeep } from "./parallel/tree.ts";
import { checkCouncilTrigger } from "./council.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ObserverConfig {
  /** Confidence for strong finalize recommendation. Default: 0.8 */
  finalizeStrongThreshold: number;
  /** Confidence for advisory finalize steer. Default: 0.5 */
  finalizeAdvisoryThreshold: number;
  /** Streak needed before floor detection kicks in. Default: 8 */
  floorStreakThreshold: number;
  /** Total experiments without best improvement for floor detection. Default: 12 */
  floorNoImproveThreshold: number;
  /** Coefficient of variation below which metric is considered plateaued. Default: 0.15 */
  floorCvThreshold: number;
  /** Noise gate: noise must exceed best * margin to trigger. Default: 1.10 */
  noiseGateMargin: number;
  /** Number of bash samples for noise estimation. Default: 3 */
  noiseSamples: number;
  /** Non-improving runs per stagnation cycle. Default: 5 */
  stagnationThreshold: number;
  /** Improvements per progress milestone. Default: 5 */
  progressMilestone: number;

  // ── Trigger toggles (all default: true). Disable a whole recommendation mechanism. ──
  /** Enable the finalize trigger (fires when agent calls finalize_research). Default: true */
  finalizeEnabled: boolean;
  /** Enable floor detection trigger (variance plateau + ASI proof). Default: true */
  floorDetectionEnabled: boolean;
  /** Enable ALL finalize/floor recommendations. When false, agent keeps trying without stop suggestions. Default: true */
  finalizeRecommendations: boolean;
  /** Enable finalize recommendations inside stagnation (ASI floor/exhausted, critical level). Default: true */
  stagnationFinalizeEnabled: boolean;
  /** Enable parallel tool suggestions (BestOfN, CheckOrthogonal, SpaceSearch). Default: false (tools disabled) */
  parallelEnabled: boolean;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  finalizeStrongThreshold: 0.8,
  finalizeAdvisoryThreshold: 0.5,
  floorStreakThreshold: 8,
  floorNoImproveThreshold: 12,
  floorCvThreshold: 0.15,
  noiseGateMargin: 1.10,
  noiseSamples: 3,
  stagnationThreshold: 5,
  progressMilestone: 5,
  reflectionIntervalRuns: 10,
  finalizeEnabled: true,
  floorDetectionEnabled: true,
  finalizeRecommendations: true,
  stagnationFinalizeEnabled: true,
  parallelEnabled: false,
};

function readObserverConfig(cwd: string): ObserverConfig {
  try {
    const configPath = path.join(cwd, ".auto", "config.json");
    if (!fs.existsSync(configPath)) return { ...DEFAULT_OBSERVER_CONFIG };
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const obs = (config.observer ?? config) as Record<string, unknown>;
    const cfg = { ...DEFAULT_OBSERVER_CONFIG };
    if (typeof obs.finalize_strong_threshold === "number") cfg.finalizeStrongThreshold = obs.finalize_strong_threshold;
    if (typeof obs.finalize_advisory_threshold === "number") cfg.finalizeAdvisoryThreshold = obs.finalize_advisory_threshold;
    if (typeof obs.floor_streak_threshold === "number") cfg.floorStreakThreshold = obs.floor_streak_threshold;
    if (typeof obs.floor_no_improve_threshold === "number") cfg.floorNoImproveThreshold = obs.floor_no_improve_threshold;
    if (typeof obs.floor_cv_threshold === "number") cfg.floorCvThreshold = obs.floor_cv_threshold;
    if (typeof obs.noise_gate_margin === "number") cfg.noiseGateMargin = obs.noise_gate_margin;
    if (typeof obs.stagnation_threshold === "number") cfg.stagnationThreshold = obs.stagnation_threshold;
    if (typeof obs.reflection_interval_runs === "number" && obs.reflection_interval_runs > 0) cfg.reflectionIntervalRuns = obs.reflection_interval_runs;
    // Boolean toggles (default true; presence of a boolean value overrides)
    if (typeof obs.finalize_enabled === "boolean") cfg.finalizeEnabled = obs.finalize_enabled;
    if (typeof obs.floor_detection_enabled === "boolean") cfg.floorDetectionEnabled = obs.floor_detection_enabled;
    if (typeof obs.finalize_recommendations === "boolean") cfg.finalizeRecommendations = obs.finalize_recommendations;
    if (typeof obs.stagnation_finalize_enabled === "boolean") cfg.stagnationFinalizeEnabled = obs.stagnation_finalize_enabled;
    if (typeof obs.parallel_enabled === "boolean") cfg.parallelEnabled = obs.parallel_enabled;
    return cfg;
  } catch {
    return { ...DEFAULT_OBSERVER_CONFIG };
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ObserverPayload {
  cwd: string;
  direction: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  baselineMetric: number | null;
  bestMetric: number | null;
  runCount: number;
  goal: string;
  /** True when an `advisor` tool is registered in the session (pi-advisor plugin). Hints become advisor-addressed instead of self-reflection. */
  advisorAvailable?: boolean;
}

export interface ObserverState {
  streak: number;
  improvements: number;
  best: number | null;
  recent: ReconstructedRun[];
  impHistory: number[];
  recentMetrics: number[];
  /** Total experiments (keep+discard) since best metric last improved. */
  runsSinceBestImprovement: number;
}

interface AsiFlags {
  floor: boolean;
  profiled: boolean;
  noise: boolean;
  exhausted: boolean;
}

// ─── ASI parsing ─────────────────────────────────────────────────────────────

const ASI_PATTERNS = {
  floor: /floor|impossible|provably|0%|irreducible|exhausted|structural.*limit|theoretical.*limit|cannot.*influence|optimally|optimal/i,
  profiled: /profil|measured|benchmarked|breakdown|spawnSync|execSync|hrtime|timing/i,
  noise: /noise|outlier|variance|startup.*cost|process.*creation/i,
  exhausted: /exhaust|tried.*all|no.*untried|provably.*complete|optimization.*complete/i,
};

function parseAsiFlags(runs: ReconstructedRun[], ideasDir: string): AsiFlags {
  const recent = runs.slice(-5);
  const text = recent
    .map((r) => {
      const asi = r.asi as Record<string, string | undefined> | undefined;
      return [asi?.learned, asi?.hypothesis, asi?.proof, asi?.rollback_reason, asi?.next_action_hint]
        .filter(Boolean)
        .join(" ");
    })
    .join(" ");

  let floor = ASI_PATTERNS.floor.test(text);
  const profiled = ASI_PATTERNS.profiled.test(text);
  const noise = ASI_PATTERNS.noise.test(text);
  let exhausted = ASI_PATTERNS.exhausted.test(text);

  // Fallback: scan all idea files in .auto/ideas/ for marker words
  if ((!floor || !exhausted) && fs.existsSync(ideasDir)) {
    try {
      const files = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
      const combined = files.map((f) => {
        try { return fs.readFileSync(path.join(ideasDir, f), "utf-8"); } catch { return ""; }
      }).join("\n");
      if (!floor && /PROVEN COMPLETE|MATHEMATICALLY IMPOSSIBLE|FLOOR REACHED|PROVABLY/i.test(combined)) {
        floor = true;
      }
      if (!exhausted && /EXHAUST|NO.*UNTRIED/i.test(combined)) {
        exhausted = true;
      }
    } catch { /* ignore */ }
  }

  return { floor, profiled, noise, exhausted };
}

// ─── State computation ───────────────────────────────────────────────────────

export function computeState(runs: ReconstructedRun[], direction: "lower" | "higher"): ObserverState {
  const state: ObserverState = {
    streak: 0,
    improvements: 0,
    best: null,
    recent: [],
    impHistory: [],
    recentMetrics: [],
    runsSinceBestImprovement: 0,
  };

  for (const r of runs) {
    const isKeep = r.status === "keep" && r.metric !== 0;
    const isBetter =
      isKeep &&
      (state.best === null ||
        (direction === "lower" && r.metric < state.best) ||
        (direction === "higher" && r.metric > state.best));

    if (isBetter) {
      state.best = r.metric;
      state.streak = 0;
      state.improvements++;
      state.impHistory.push(r.metric);
      state.recentMetrics.push(r.metric);
      state.recent = [];
      state.runsSinceBestImprovement = 0;
    } else {
      state.streak++;
      state.runsSinceBestImprovement++;
      state.recent.push(r);
      if (r.metric !== 0) state.recentMetrics.push(r.metric);
    }
  }

  return state;
}

// ─── Statistics helpers ──────────────────────────────────────────────────────

function coefficientOfVariation(values: number[]): { cv: number; mean: number; std: number; n: number } | null {
  const n = values.length;
  if (n < 5) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { cv: std / mean, mean, std, n };
}

// ─── Helper: count untried ideas in .auto/ideas/ ────────────────────────────
// Shared by checkFinalize and checkFloor.
// Each .md file in the ideas directory = one untried idea.
// EXCLUDES hypothesis registration files (created by propose_hypothesis) which
// have YAML frontmatter (---\nid: ...\nstatus: ...\n---) — those are tracked
// in tree.json, not manual optimization ideas.
function isHypothesisFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.startsWith("---\n") && /^id:\s*n\d+/m.test(content);
  } catch {
    return false;
  }
}

function countUntriedIdeas(ideasDir: string): number {
  if (!fs.existsSync(ideasDir)) return 0;
  try {
    return fs.readdirSync(ideasDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !isHypothesisFile(path.join(ideasDir, f)))
      .length;
  } catch {
    return 0;
  }
}

// ─── Helper: mark an idea as tried by removing its file ─────────────────────
// ideaId can be a filename (with or without .md extension).
// Returns true if the file was found and deleted.
export function markIdeaTried(ideasDir: string, ideaId: string): boolean {
  if (!fs.existsSync(ideasDir)) return false;
  const filename = ideaId.endsWith(".md") ? ideaId : ideaId + ".md";
  const filePath = path.join(ideasDir, filename);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ─── Trigger: Finalize ───────────────────────────────────────────────────────

export function checkFinalize(allEntries: Record<string, unknown>[], oc: ObserverConfig, state: ObserverState, ideasDir: string, payload?: ObserverPayload): string | null {
  const finalizeEntries = allEntries.filter((e) => e.type === "finalize");
  if (finalizeEntries.length === 0) return null;

  const last = finalizeEntries[finalizeEntries.length - 1];
  const confidence = typeof last.confidence === "number" ? last.confidence : 0;
  const reason = typeof last.reason === "string" ? last.reason : "no reason given";
  const confPct = Math.round(confidence * 100);

  // ── Stale detection: did the agent find improvements AFTER the finalize entry? ──
  const lastIndex = allEntries.lastIndexOf(last);
  const entriesAfter = allEntries.slice(lastIndex + 1);
  const runEntriesAfter = entriesAfter.filter((e) => typeof e.run === "number");
  const improvementsAfter = runEntriesAfter.filter((e) => e.status === "keep" && typeof e.metric === "number" && e.metric !== 0);

  if (improvementsAfter.length > 0) {
    // Agent proved itself wrong by finding improvements — don't re-fire the finalize signal.
    return null;
  }

  // ── Anti-nagging: agent continued working without finding improvements. ──
  // The finalize_research tool already sent an immediate steer when called.
  // If the agent continued (≥1 run after), it knows about the finalize signal.
  // Don't nag every iteration — actionable triggers (parallel, stagnation)
  // take over steering via the new priority order.
  if (runEntriesAfter.length >= 1) {
    return null;
  }

  // ── Below only fires when runEntriesAfter === 0 (just called, no runs since) ──

  // Untried ideas → one-line nudge instead of full block.
  const untriedIdeas = countUntriedIdeas(ideasDir);
  if (untriedIdeas >= 2) {
    return `🏁 Finalize signal (${confPct}%) is pending, but ${untriedIdeas} untried ideas remain in .auto/ideas/. Try the ideas first, or run /autoresearch off to finalize.`;
  }

  if (confidence > oc.finalizeStrongThreshold) {
    return `🏁 FINALIZE SIGNAL (confidence ${confPct}%): Agent signaled optimization is complete.
   Reason: ${reason}

   The agent has explicitly recorded a finalize entry with high confidence.
   Strongly recommended: run /autoresearch off to finalize this session.` +
      (payload?.advisorAvailable
        ? `\n   Before that, consult advisor({ stage: "final-check" }) with your proof claims — let it challenge the conclusion.\n   ${ADVISOR_ARGUE}`
        : "") + `
   To override: delete the finalize entry from .auto/log.jsonl, set observer.finalize_enabled=false in .auto/config.json, or lower the threshold in /autoresearch config.`;
  }

  if (confidence > oc.finalizeAdvisoryThreshold) {
    return `🏁 FINALIZE SIGNAL (confidence ${confPct}%): Agent signaled possible completion.
   Reason: ${reason}

   Consider whether further optimization is worth the cost.
   Run /autoresearch off if you agree, or continue if you disagree.`;
  }

  return null;
}

// ─── Trigger: Noise gate ─────────────────────────────────────────────────────

function checkNoiseGate(payload: ObserverPayload, cwd: string, oc: ObserverConfig): string | null {
  if (!payload.bestMetric || payload.direction !== "lower") return null;
  if (!fs.existsSync(path.join(cwd, ".auto", "measure.sh"))) return null;

  // Check config for override
  let noiseMode = "warn";
  try {
    const configPath = path.join(cwd, ".auto", "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (typeof config.noise_gate === "string") noiseMode = config.noise_gate;
    }
  } catch { /* ignore */ }

  if (noiseMode === "off") return null;

  // Time minimal bash invocations to estimate system noise floor
  const samples: number[] = [];
  for (let i = 0; i < oc.noiseSamples; i++) {
    try {
      const t0 = performance.now();
      execSync("true", { shell: true, timeout: 5000, stdio: "ignore" });
      const t1 = performance.now();
      samples.push(Math.round(t1 - t0));
    } catch { /* ignore */ }
  }

  if (samples.length < 2) return null;
  const noiseMin = Math.min(...samples);

  if (noiseMin <= 0) return null;
  if (noiseMin <= payload.bestMetric * oc.noiseGateMargin) return null;

  const deltaPct = ((noiseMin - payload.bestMetric) / payload.bestMetric * 100).toFixed(1);
  const unit = payload.metricUnit;

  if (noiseMode === "hard") {
    return `🔇 NOISE GATE (hard): System noise floor (${noiseMin}ms) exceeds best (${payload.bestMetric}${unit}) by ${deltaPct}%.
   Current conditions cannot produce an improvement. Experiment SKIPPED.

   Options:
   → Wait for system load to decrease and retry
   → Set "noise_gate": "off" in .auto/config.json to disable
   → Run /autoresearch off and finalize`;
  }

  return `🔇 NOISE WARNING: System noise floor (${noiseMin}ms) exceeds best (${payload.bestMetric}${unit}) by ${deltaPct}%.
   This experiment will almost certainly be a discard.

   To suppress: set "noise_gate": "off" in .auto/config.json
   To hard-block: set "noise_gate": "hard" in .auto/config.json`;
}

// ─── Trigger: Floor detection ────────────────────────────────────────────────

export function checkFloor(
  state: ObserverState,
  asi: AsiFlags,
  payload: ObserverPayload,
  cwd: string,
  oc: ObserverConfig,
): string | null {
  if (state.streak < oc.floorStreakThreshold) return null;

  // Two-signal floor: need BOTH consecutive discards AND no best improvement recently
  // This prevents false floor when agent is trying wrong hypotheses on a productive branch
  const asiProvesFloor = state.streak >= 20 && asi.floor;
  if (!asiProvesFloor && state.runsSinceBestImprovement < oc.floorNoImproveThreshold) {
    // Streak of bad luck, but best is still improving — don't claim floor yet
    return null;
  }

  const recent = state.recentMetrics.slice(-10).filter((v) => v !== 0);
  const stats = coefficientOfVariation(recent);

  // Check override
  let floorOverride = false;
  try {
    const configPath = path.join(cwd, ".auto", "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      floorOverride = config.auto_floor_override === true;
    }
  } catch { /* ignore */ }

  const isFloor = !floorOverride && stats !== null && stats.cv < oc.floorCvThreshold;

  if (!isFloor && !asiProvesFloor) return null;

  // ── Untried-ideas guard: don't claim "floor reached" if ideas remain. ──
  // Consistent with checkFinalize: if there are ≥2 untried ideas in .auto/ideas/,
  // the search space isn't exhausted. Downgrade to a nudge.
  const triggerReason = isFloor ? "variance" : "asi_proof";
  const unit = payload.metricUnit;
  const bestStr = state.best !== null ? `${state.best}${unit}` : `?${unit}`;
  const ideasDir = path.join(cwd, ".auto", "ideas");
  const untriedIdeas = countUntriedIdeas(ideasDir);
  if (untriedIdeas >= 2) {
    const meanStr = stats ? `~${stats.mean.toFixed(2)}${unit}` : `?${unit}`;
    return `🔬 Possible floor at ${meanStr}, but ${untriedIdeas} untried ideas remain in .auto/ideas/. Try them before concluding the limit is structural.`;
  }

  const lines: string[] = [
    `🔬 FLOOR DETECTED: Optimization has reached its structural limit (trigger: ${triggerReason}).`,
  ];

  if (triggerReason === "variance" && stats) {
    lines.push(`   Metric stable at ~${stats.mean.toFixed(2)}${unit} ± ${stats.std.toFixed(2)}${unit} (CV=${stats.cv.toFixed(4)}, n=${stats.n}) across ${state.streak} non-improving runs.`);
  } else {
    lines.push(`   Agent ASI/idea files contain proof that further optimization is impossible.`);
  }

  if (asi.profiled) {
    lines.push(`   Profiling data confirms the limit is structural, not algorithmic.`);
  }

  lines.push("");
  lines.push(`   Evidence:`);
  lines.push(`   - Best: ${bestStr}`);
  lines.push(`   - Streak: ${state.streak} non-improving runs`);

  if (triggerReason === "variance" && stats) {
    lines.push(`   - Recent median: ${stats.mean.toFixed(2)}${unit} ± ${stats.std.toFixed(2)}${unit}`);
  }

  if (fs.existsSync(ideasDir) && countUntriedIdeas(ideasDir) === 0) {
    lines.push(`   - All ideas in ${ideasDir}/ have been tried`);
  }

  lines.push("");
  lines.push(`   RECOMMENDED ACTION:`);
  lines.push(`   → Run /autoresearch off and finalize`);
  lines.push(`   → Or call finalize_research(reason="...", confidence=0.9)`);
  lines.push(`   → Or start a fresh segment with a different metric/target`);
  lines.push("");
  lines.push(`   To override: set "observer": {"floor_detection_enabled": false} in .auto/config.json, or "auto_floor_override": true (variance only)`);

  return lines.join("\n");
}

// ─── Trigger: Composition opportunity (tree-aware) ─────────────────────────

function checkParallelOpportunity(
  state: ObserverState,
  payload: ObserverPayload,
  cwd: string,
  oc: ObserverConfig,
): string | null {
  // Skip if parallel tools are disabled
  if (!oc.parallelEnabled) return null;
  // Fire at streak 3 (before stagnation threshold of 5) — early nudge
  if (state.streak < 3) return null;
  if (state.streak >= oc.stagnationThreshold) return null; // stagnation handles >=5

  const ideasDir = path.join(cwd, ".auto", "ideas");
  if (!fs.existsSync(ideasDir)) return null;

  let ideas: string[];
  try {
    const files = fs.readdirSync(ideasDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !isHypothesisFile(path.join(ideasDir, f)));
    ideas = files.map((f) => {
      try { return fs.readFileSync(path.join(ideasDir, f), "utf-8"); } catch { return ""; }
    }).filter((c) => c.trim().length > 10);
  } catch {
    return null;
  }

  if (ideas.length < 2) return null;

  // Check that agent hasn't already used parallel tools recently
  const recentLog = state.recent.slice(-5);
  const usedParallel = recentLog.some(function (r) {
    const desc = String((r as Record<string, unknown>).description ?? "");
    return /BestOfN|SpaceSearch|CheckOrthogonal|valleyProbe|startPhase/i.test(desc);
  });
  if (usedParallel) return null;

  // ── Classify the ideas to pick the RIGHT tool ──
  const ideasLower = ideas.join(" ").toLowerCase();

  // Pattern: refactor / rewrite / replace algorithm → needs Phases
  const isRefactor = /refactor|rewrite|replace.*algorithm|restructur|rip out|swap.*engine|change.*approach/i.test(ideasLower);

  // Pattern: ideas target different files/modules → CheckOrthogonal
  const fileRefs = ideas.filter(function (l) { return /\.(ts|js|go|py|rs|c|cpp|java|rb|sh)\b/i.test(l) || /file|module|function|class\s/i.test(l); });
  const isIndependent = fileRefs.length >= 2 && ideas.length >= 2;

  // Pattern: fundamentally different strategies → SpaceSearch
  const strategyKeywords = /strategy|approach|algorithm|technique|method|data structure|cache|batch|stream|lazy|eager|memoiz|precomput/i;
  const strategyIdeas = ideas.filter(function (l) { return strategyKeywords.test(l); });
  const isMultimodal = strategyIdeas.length >= 3;

  const prefix = `⚡ PARALLEL OPPORTUNITY: ${ideas.length} untried ideas, ${state.streak} non-improving runs.`;
  const metric = payload.metricName;
  const dir = payload.direction;

  // ── Refactor path → Phases (temporary regression expected) ──
  if (isRefactor) {
    return [
      prefix,
      `   Your ideas involve refactoring/rewriting — this often needs to get WORSE before better.`,
      `   Use Phases to allow temporary regression without auto-revert:`,
      `   startPhase({ name:"refactor", rationale:"${ideas[0]!.slice(0, 60)}", max_steps:5 })`,
      `   Then iterate with status:"explore" (no auto-revert).`,
      `   If stuck in a valley → valleyProbe({ strategies:["alt1","alt2","alt3"], ... })`,
    ].join("\n");
  }

  // ── Independent files → CheckOrthogonal (stack them) ──
  if (isIndependent && !isMultimodal) {
    return [
      prefix,
      `   Your ideas target different files/modules — they can be stacked independently.`,
      `   CheckOrthogonal tests + stacks them in one pass:`,
      `   CheckOrthogonal({ patches: [`,
      ideas.slice(0, 3).map(function (idea) {
        const short = idea.length > 60 ? idea.slice(0, 57) + "..." : idea;
        return `     {name:"opt", hypothesis:"${short}"}`;
      }).join(",\n"),
      `   ], metric_name:"${metric}", direction:"${dir}" })`,
    ].join("\n");
  }

  // ── Multimodal landscape → SpaceSearch beam ──
  if (isMultimodal) {
    const hints = strategyIdeas.slice(0, 3).map(function (idea) {
      const short = idea.length > 50 ? idea.slice(0, 47) + "..." : idea;
      return `"${short}"`;
    }).join(", ");
    return [
      prefix,
      `   Multiple fundamentally different strategies detected — beam search explores them in parallel.`,
      `   SpaceSearch({ action:"init", beam_width:3, candidates_per_state:3,`,
      `     diversity_hints:[${hints}], metric_name:"${metric}", direction:"${dir}" })`,
      `   Then: SpaceSearch({ action:"step" }) to expand, SpaceSearch({ action:"finish" }) to apply best chain.`,
    ].join("\n");
  }

  // ── Default: variations of same concept → BestOfN ──
  const top3 = ideas.slice(0, 3);
  const candidates = top3.map(function (idea, i) {
    const short = idea.length > 60 ? idea.slice(0, 57) + "..." : idea;
    return `    {hypothesis:"${short}", complexity:"${i === 0 ? "simple" : "medium"}"}`;
  }).join(",\n");

  return [
    prefix,
    `   Stop testing sequentially — try them ALL AT ONCE with BestOfN:`,
    `   BestOfN({ candidates: [`,
    candidates,
    `   ], metric_name:"${metric}", direction:"${dir}" })`,
  ].join("\n");
}


/**
 * Classify the pattern of recent discard results.
 * Domain-agnostic: uses RESULT patterns (convergence, repetition, no-info, divergence),
 * not hypothesis keywords.
 */
function classifyStagnationPattern(state: ObserverState): { category: string; hint: string } {
  const recent = state.recent.slice(-5);
  if (recent.length < 3) return { category: "insufficient", hint: "" };

  // no-info: discards without ASI findings
  const noInfoCount = recent.filter((r) => {
    const a = r.asi as Record<string, string | undefined> | undefined;
    return !a?.finding && !a?.do_not_retry && !a?.learned;
  }).length;
  if (noInfoCount >= 3) {
    return {
      category: "no_info",
      hint: "NO LEARNING: Recent discards have NO findings/do_not_retry in ASI. Each discard without a finding is a WASTED experiment. Record what you learned.",
    };
  }

  // repetition: overlapping do_not_retry entries
  const doNotRetryTexts = recent
    .map((r) => { const a = r.asi as Record<string, string | undefined> | undefined; return a?.do_not_retry || ""; })
    .filter((t) => t.length > 0);
  if (doNotRetryTexts.length >= 3) {
    const allWords = doNotRetryTexts.flatMap((t) => t.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
    const wordCounts = new Map<string, number>();
    for (const w of allWords) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    const repeatedWords = [...wordCounts.entries()].filter(([_, c]) => c >= 3).map(([w]) => w);
    if (repeatedWords.length >= 2) {
      return {
        category: "repetition",
        hint: "REPETITION: Recent discards share do_not_retry themes: " + repeatedWords.slice(0, 5).join(", ") + ". You have learned this lesson already. Try FUNDAMENTALLY different.",
      };
    }
  }

  // convergence/divergence: metric variance patterns
  const metrics = recent.map((r) => r.metric).filter((m) => m > 0);
  if (metrics.length >= 4) {
    const cv = coefficientOfVariation(metrics);
    if (cv && cv.cv < 0.05) {
      return { category: "convergence", hint: "CONVERGENCE: Metrics tightly clustered (CV=" + cv.cv.toFixed(3) + "). Performance floor for this approach." };
    }
    if (cv && cv.cv > 0.5) {
      return { category: "divergence", hint: "ERRATIC: High variance (CV=" + cv.cv.toFixed(3) + "). Benchmark noisy - verify with multiple runs." };
    }
  }

  return { category: "mixed", hint: "" };
}


/**
 * Profiling gate: warn when recent experiments have no profiling data.
 */
function checkProfilingGate(state: ObserverState, asi: AsiFlags): string | null {
  if (asi.profiled) return null;
  if (state.streak < 3 || state.streak % 3 !== 0) return null;
  return "PROFILING GATE: No profiling data in recent experiments. You are optimizing BLIND. Profile first (node --prof, console.time, cProfile, pprof), record findings in hypothesis.";
}

// ─── Trigger: Time-limit struggles ─────────────────────────────────────────────

/** 3+ consecutive finished runs died on time (crash / budget_exceeded): the
 *  harness does not fit the project time cap — adapt the workload, not the cap.
 *  run_experiment logs hard-timeout kills as 'crash', so a bug-streak can also
 *  match; the hint tells the agent to ignore it in that case. */
function checkTimeLimitStruggles(state: ObserverState): string | null {
  const decided = state.recent.filter((r) => r.status !== "explore");
  const tail = decided.slice(-3);
  if (tail.length < 3) return null;
  // Death signature: hard-timeout kills are logged as 'crash', budget kills as
  // 'budget_exceeded' (both preserved by reconstructJsonlState); checks_failed
  // counts too — checks usually time out because the benchmark hogged the box.
  if (!tail.every((r) => r.status === "crash" || r.status === "budget_exceeded" || r.status === "checks_failed")) return null;
  return (
    "⏱ TIME LIMIT: the last 3 runs all died on time (crash/budget_exceeded). " +
    "The cap is fixed — adapt the experiment so a single run fits: smaller fixture/corpus, fewer iterations, " +
    "a BENCH_MODE=quick subset in measure.sh, warm-up outside the timed region. " +
    "Do not raise timeout_seconds beyond experiment_max_minutes (when the project set one). " +
    "If these are plain bugs rather than time kills, fix them first and ignore this hint."
  );
}

// ─── Trigger: Stagnation ───────────────────────────────────────────────────────

function checkStagnation(
  state: ObserverState,
  asi: AsiFlags,
  payload: ObserverPayload,
  cwd: string,
  oc: ObserverConfig,
): string | null {
  if (state.streak < oc.stagnationThreshold) return null;
  if (state.streak % oc.stagnationThreshold !== 0) return null;

  const level = Math.floor(state.streak / oc.stagnationThreshold);
  const unit = payload.metricUnit;
  const bestStr = state.best !== null ? `${state.best}${unit}` : `?${unit}`;
  const ideasPath = path.join(cwd, ".auto", "ideas");

  // Status pattern detection
  const recentRuns = state.recent.slice(-oc.stagnationThreshold);
  const statuses = recentRuns.map((r) => r.status);
  const crashCount = statuses.filter((s) => s === "crash" || s === "checks_failed").length;
  const discardCount = statuses.filter((s) => s === "discard").length;
  const keepCount = statuses.filter((s) => s === "keep").length;
  const total = statuses.length;

  let patternHint: string;
  if (total > 0 && crashCount === total) {
    patternHint = "🔧 TECHNICAL: All recent runs CRASHED. Your code is breaking — fix stability before optimizing further.";
  } else if (total > 0 && discardCount === total) {
    // Use result-pattern classification instead of generic "change direction"
    const pattern = classifyStagnationPattern(state);
    patternHint = pattern.hint || "DIRECTION: All recent runs DISCARDED. Change direction entirely.";
  } else if (total > 0 && keepCount === total) {
    patternHint = "⚠️  SELECTIVITY: All recent runs KEPT but none improved the metric. You may be accepting changes that don't help — be more selective.";
  } else {
    patternHint = `🔀 MIXED: Outcomes vary (crash:${crashCount} discard:${discardCount} keep:${keepCount}). Find what DIFFERS between successes and failures.`;
  }

  // ASI-aware: if agent proved floor/exhaustion, skip generic advice
  if (asi.floor || asi.exhausted) {
    if (oc.stagnationFinalizeEnabled && oc.finalizeRecommendations) {
      return `🔄 STAGNATION: No metric improvement in ${state.streak} runs.

⚠️  ASI CONTEXT: Your recent log entries already contain proof that further
   optimization is impossible or exhausted. The limit appears structural.

   Best: ${bestStr}
   ${patternHint}

   RECOMMENDED: Call finalize_research() or run /autoresearch off.
   The observer will not ask you to "change direction" again — the evidence
   in your ASI fields shows there is nowhere to change TO.` +
      (payload.advisorAvailable
        ? `\n\n📞 ADVISOR: Before finalizing, consult advisor({ stage: "final-check" }) with your proof claims (ASI floor/exhaustion evidence) — let it challenge the conclusion.\n${ADVISOR_ARGUE}`
        : "");
    }
    // Finalize recommendation disabled — fall through to actionable stagnation advice.
  }

  // Progressive escalation with parallel hints
  let escalation: string;
  switch (level) {
    case 1:
      escalation = oc.parallelEnabled ? `

💡 PARALLEL HINT: Stuck on the same approach? Try BestOfN with 3 different hypotheses:
   BestOfN({ candidates: [{hypothesis:"...",complexity:"medium"}, ...], metric_name:"...", direction:"..." })
   Workers run in isolated worktrees (cheap flash model), winner is re-measured in full.` : `

💡 TREE HINT: Stuck on the same approach? Call tree_status() and try a fundamentally different hypothesis.`;
      break;
    case 2:
      escalation = oc.parallelEnabled ? `

⚠️  SECOND STAGNATION CYCLE. Your first reflection didn't break through.

💡 PARALLEL HINT: The landscape may be multimodal — try SpaceSearch beam search:
   SpaceSearch({ action:"init", beam_width:3, candidates_per_state:3, diversity_hints:["approach1","approach2","approach3"] })
   Then step() to explore, finish() to re-measure the winner. Beam maintains K diverse states to avoid local optima.

Or if you need to get worse before better (refactor, algorithm swap), use phases:
   startPhase({ name:"refactor", max_steps:5, hard_floor_pct:40 })` : `

⚠️  SECOND STAGNATION CYCLE. Your first reflection didn't break through.

💡 Call tree_status() for the full hypothesis list and try a fundamentally different optimization direction.`;
      break;
    case 3:
      escalation = oc.parallelEnabled ? `

🚨 THIRD STAGNATION CYCLE. Two reflections, zero progress.

💡 PARALLEL HINT: If you're in a phase and stuck at maxSteps, spawn diverse continuations:
   valleyProbe({ strategies:["strategy1","strategy2","strategy3"], baseline_metric:..., metric_name:"...", direction:"..." })
   Workers branch from the best checkpoint with different strategies.

Otherwise: ABANDON the current direction entirely. Try a radically different approach.` : `

🚨 THIRD STAGNATION CYCLE. Two reflections, zero progress.

💡 ABANDON the current approach entirely — discard it and try a radically different optimization category.`;
      break;
    default:
      escalation = `

💀 CRITICAL: ${state.streak} non-improving runs (${level} stagnation cycles). The session appears EXHAUSTED.` +
        (oc.stagnationFinalizeEnabled
          ? " Consider /autoresearch off and finalize, or call finalize_research() to signal completion."
          : " Try a radically different approach, or start a new segment with a different metric/target.");
      break;
  }

  // ASI-adapted reflect questions
  let reflectQuestions: string;
  if (asi.profiled) {
    reflectQuestions = `REFLECT:
1. Your profiling (per ASI) shows where time is spent. Is the bottleneck ADDRESSABLE from the code you're allowed to change?
2. Are there orthogonal dimensions you haven't explored (memory, I/O, caching, precomputation)?
3. Would a completely different algorithm or data structure help, even if more complex?` +
      (oc.stagnationFinalizeEnabled ? "\n4. Consider calling finalize_research() if the limit is structural." : "");
  } else {
    reflectQuestions = `REFLECT:
1. What PATTERN do these runs share? What common assumption are they all making?
2. Are you optimizing the right thing? Profile the code — where is time actually spent?
3. Is the current approach fundamentally limited? What structural change would unlock new gains?
4. What haven't you tried that is DIFFERENT (not a variation)?

Write your analysis to ${ideasPath}, then try the most fundamentally different approach.`;
  }

  // Format recent runs
  const recentFormatted = recentRuns
    .map((r) => {
      const metric = r.metric !== 0 ? `(${r.metric})` : "(failed)";
      const desc = r.description || "(no desc)";
      return `  • ${r.status} — "${desc}" ${metric}`;
    })
    .join("\n");

  // Tree-aware stagnation: suggest backtrack if tree exists
  let treeHint = "";
  try {
    if (treeExists(cwd)) {
      const tree = loadTree(cwd);
      if (tree) {
        const activeNode = tree.nodes[tree.activeNodeId];
        const activeFailCount = activeNode ? failedStreakSinceLastKeep(tree, activeNode.id) : 0;
        
        if (activeFailCount >= 6) {
          treeHint = `\n🌳 TREE STATUS: ${activeFailCount} consecutive failed hypotheses since last keep.\n`;
          treeHint += `   Call tree_status() for the hypothesis list and try a fundamentally different direction.`;
        }
      }
    }
  } catch {
    // Tree hint is best-effort
  }

  // Advisor-aware: when the pi-advisor plugin is present, route the strategic
  // review to the stronger model instead of self-reflection only.
  const advisorHint = payload.advisorAvailable
    ? `\n\n📞 ADVISOR: Consult advisor({ stage: "recovery" }) with: best-so-far ${bestStr}, the failure pattern above, and your untried ideas — ask for a strategic direction check.\n${ADVISOR_ARGUE}`
    : "";

  // The council is also self-service: the agent may convene it at any time,
  // with no limits, so the stagnation steer always mentions that door.
  const councilHint = `\n🏛 COUNCIL: If self-reflection is not enough, convene a hypothesis council yourself — no limits, any time: council_convene({ note: "why you are stuck and what to focus on" }). It is autonomous and BLOCKING: the tool spawns the analysts, runs the cross-examination and the chair itself, and returns a vetted experiment slate.`;

  return `🔄 STAGNATION: No metric improvement in ${state.streak} runs.

${patternHint}

Recent runs (none beat best ${bestStr}):
${recentFormatted}
${escalation}
${treeHint}
${councilHint}
${reflectQuestions}${advisorHint}`;
}

// ─── Trigger: Reflection checkpoint ─────────────────────────────────────
// Every N decided runs of the segment: a structured strategic pause.
// Different from checkProgress (milestone-framed, keeps-only): this fires on
// the run COUNT regardless of outcome, so flat/grinding campaigns still get
// a periodic step-back. Checked after floor/stagnation so alarm triggers
// keep priority; before progress so the 5-run milestone doesn't shadow it.
// ─── Advisor argue protocol (Anthropic reconciliation pattern, adapted) ─────
// Advice gets weight; ledger evidence wins; a contested point is settled by a
// discriminating experiment, never by rhetoric. pi-advisor gotcha (source:
// advisor-messages.ts skips toolResult entries): the advisor CANNOT see its own
// past verdicts, so the executor must quote the disputed advice verbatim when
// re-consulting.
const ADVISOR_ARGUE =
  `If your ledger evidence contradicts the advice: quote the disputed advice verbatim in your message and re-consult ONCE ("Ledger shows X, you suggest Y — which constraint breaks the tie?"). Still contested → settle it with a discriminating experiment, not words, and record the outcome in ASI (learned / next_action_hint).`;

function checkReflection(state: ObserverState, payload: ObserverPayload, oc: ObserverConfig): string | null {
  const decidedRuns = state.improvements + state.streak;
  if (decidedRuns <= 0 || decidedRuns % oc.reflectionIntervalRuns !== 0) return null;

  const lines = [
    `🪞 REFLECTION CHECKPOINT (${decidedRuns} decided runs this segment). Pause: no experiment until you have answered.`,
    `1. What worked — which hypothesis family produced the keeps?`,
    `2. What do the last ~5 discards share? (tree_status detail=full for the list)`,
    `3. What will you try next — and why is it NOT a repeat of an existing discard?`,
  ];
  if (payload.advisorAvailable) {
    lines.push(
      `Then consult advisor({ stage: "recovery" }) with these 3 answers, the best-so-far metric and your untried ideas — ask it to challenge the plan before you spend the next 10 runs.`,
    );
    lines.push(ADVISOR_ARGUE);
  } else {
    lines.push(`Answer in 3 short lines, then continue with the strongest candidate.`);
  }
  return lines.join("\n");
}

// ─── Trigger: Progress milestone ─────────────────────────────────────────────

function checkProgress(state: ObserverState, payload: ObserverPayload, cwd: string, oc: ObserverConfig): string | null {
  if (state.streak !== 0) return null;
  if (state.improvements <= 0) return null;
  if (state.improvements % oc.progressMilestone !== 0) return null;

  const unit = payload.metricUnit;
  const progression = state.impHistory.join(" → ");
  const ideasPath = path.join(cwd, ".auto", "ideas");

  // Compute trend from deltas
  const deltas: number[] = [];
  for (let i = 0; i < state.impHistory.length - 1; i++) {
    deltas.push(state.impHistory[i + 1] - state.impHistory[i]);
  }

  let trendMsg = "";
  if (deltas.length >= 2) {
    const absDeltas = deltas.map(Math.abs);
    const ratio = absDeltas[0] !== 0 ? absDeltas[absDeltas.length - 1] / absDeltas[0] : 0;
    const mean = absDeltas.reduce((a, b) => a + b, 0) / absDeltas.length;
    const variance = absDeltas.reduce((sum, v) => sum + (v - mean) ** 2, 0) / absDeltas.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

    const deltasStr = deltas.map((d) => d.toFixed(1)).join(",");

    if (cv > 0.8) trendMsg = `📉 Deltas: ${deltasStr}${unit} — ⚡ ERRATIC: high variance in gains. Results may be noise-dominated; verify with multiple runs.`;
    else if (ratio < 0.3) trendMsg = `📉 Deltas: ${deltasStr}${unit} — DIMINISHING RETURNS: gains shrinking rapidly. You're near the performance floor.`;
    else if (ratio < 0.7) trendMsg = `📉 Deltas: ${deltasStr}${unit} — Moderately diminishing: gains getting smaller. Consider whether further effort is worth it.`;
    else trendMsg = `📊 Deltas: ${deltasStr}${unit} — LINEAR progress: consistent gains. Keep going if unexplored directions remain.`;
  }

  return `🎯 MILESTONE: ${state.improvements} improvements made.
   Progression: ${progression}${unit}
   ${trendMsg}

STEP BACK and think strategically:
1. OVERFITTING CHECK: Are these gains real or specific to this benchmark? Would they generalize?
2. ORTHOGONAL DIRECTIONS: Is there a completely different optimization axis unexplored?
3. TRADE-OFFS: What are you sacrificing (memory, complexity, readability) for performance?
4. THE BIG PICTURE: If you started over knowing what you know now, what would you do differently?

Write your strategic assessment to ${ideasPath}.`;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the built-in observer. Returns a steer string (or null for silence).
 * This is extension code — it runs in-process, no bash/jq spawn overhead.
 */
export function runObserver(payload: ObserverPayload): string | null {
  const { cwd, direction } = payload;

  // Read observer config from .auto/config.json (project-level)
  const oc = readObserverConfig(cwd);

  // Resolve log file
  const jsonlPath = path.join(cwd, ".auto", "log.jsonl");
  const legacyPath = path.join(cwd, "autoresearch.jsonl");
  const logPath = fs.existsSync(jsonlPath) ? jsonlPath : fs.existsSync(legacyPath) ? legacyPath : null;
  if (!logPath) return null;

  // Read all entries
  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }

  const allEntries: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonlEntry(line);
    if (entry) allEntries.push(entry);
  }

  // Reconstruct state ONCE from log.jsonl (P1-1: was reconstructed twice before)
  const reconstructed = reconstructJsonlState(content);
  const segRuns = reconstructed.results.filter((r) => r.segment === reconstructed.currentSegment);
  const state = computeState(segRuns, direction);
  const ideasPath = path.join(cwd, ".auto", "ideas");
  const asi = parseAsiFlags(segRuns, ideasPath);

  // ── Trigger order: actionable first, finalize as fallback (P0-1) ──
  // Rationale: concrete advice (BestOfN, reflection) is more useful than an
  // abstract "stop" recommendation. Finalize is the lowest-priority fallback
  // — it only fires if nothing else has actionable guidance.

  // 1. Noise gate (system noise — continuing is pointless)
  const noiseSteer = checkNoiseGate(payload, cwd, oc);
  if (noiseSteer) return noiseSteer;

  // 3. Parallel opportunity (actionable: concrete ideas → BestOfN/SpaceSearch)
  const parallelSteer = checkParallelOpportunity(state, payload, cwd, oc);
  if (parallelSteer) return parallelSteer;

  // 3ab. Time-limit struggles (harness does not fit the project cap — adapt it;
  //      more urgent than the profiling advice: dying runs cannot be optimized)
  const timeLimitSteer = checkTimeLimitStruggles(state);
  if (timeLimitSteer) return timeLimitSteer;

  // 3b. Profiling gate (warn when optimizing blind)
  const profilingSteer = checkProfilingGate(state, asi);
  if (profilingSteer) return profilingSteer;

  // 3c. Stagnation council (multi-model hypothesis council; replaces the plain
  // stagnation hint when it fires — the campaign is stalled badly enough to
  // convene analysts). Checked before stagnation so they don't both fire.
  const councilSteer = checkCouncilTrigger(state.runsSinceBestImprovement, payload.runCount, cwd, {
    metricName: payload.metricName,
    metricUnit: payload.metricUnit,
    direction: payload.direction,
    baselineMetric: payload.baselineMetric,
    bestMetric: payload.bestMetric,
    goal: payload.goal,
  });
  if (councilSteer) return councilSteer;

  // 4. Stagnation (actionable: reflection + escalation hints)
  const stagnationSteer = checkStagnation(state, asi, payload, cwd, oc);
  if (stagnationSteer) return stagnationSteer;

  // 5. Floor detection (objective limit — now checks untried ideas, P1-2)
  if (oc.floorDetectionEnabled && oc.finalizeRecommendations) {
    const floorSteer = checkFloor(state, asi, payload, cwd, oc);
    if (floorSteer) return floorSteer;
  }

  // 5b. Reflection checkpoint (periodic structured review; advisor-aware)
  const reflectionSteer = checkReflection(state, payload, oc);
  if (reflectionSteer) return reflectionSteer;

  // 6. Progress milestone (positive reinforcement — always useful)
  const progressSteer = checkProgress(state, payload, cwd, oc);
  if (progressSteer) return progressSteer;

  // 7. Finalize (fallback — lowest priority; agent self-assessment)
  if (oc.finalizeEnabled && oc.finalizeRecommendations) {
    const finalizeSteer = checkFinalize(allEntries, oc, state, ideasPath, payload);
    if (finalizeSteer) return finalizeSteer;
  }

  return null;
}
