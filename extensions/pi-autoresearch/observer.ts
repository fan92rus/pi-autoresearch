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

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ObserverConfig {
  /** Confidence for strong finalize recommendation. Default: 0.8 */
  finalizeStrongThreshold: number;
  /** Confidence for advisory finalize steer. Default: 0.5 */
  finalizeAdvisoryThreshold: number;
  /** Streak needed before floor detection kicks in. Default: 15 */
  floorStreakThreshold: number;
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
  /** Enable finalize recommendations inside stagnation (ASI floor/exhausted, critical level). Default: true */
  stagnationFinalizeEnabled: boolean;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  finalizeStrongThreshold: 0.8,
  finalizeAdvisoryThreshold: 0.5,
  floorStreakThreshold: 15,
  floorCvThreshold: 0.15,
  noiseGateMargin: 1.10,
  noiseSamples: 3,
  stagnationThreshold: 5,
  progressMilestone: 5,
  finalizeEnabled: true,
  floorDetectionEnabled: true,
  stagnationFinalizeEnabled: true,
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
    if (typeof obs.floor_cv_threshold === "number") cfg.floorCvThreshold = obs.floor_cv_threshold;
    if (typeof obs.noise_gate_margin === "number") cfg.noiseGateMargin = obs.noise_gate_margin;
    if (typeof obs.stagnation_threshold === "number") cfg.stagnationThreshold = obs.stagnation_threshold;
    // Boolean toggles (default true; presence of a boolean value overrides)
    if (typeof obs.finalize_enabled === "boolean") cfg.finalizeEnabled = obs.finalize_enabled;
    if (typeof obs.floor_detection_enabled === "boolean") cfg.floorDetectionEnabled = obs.floor_detection_enabled;
    if (typeof obs.stagnation_finalize_enabled === "boolean") cfg.stagnationFinalizeEnabled = obs.stagnation_finalize_enabled;
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
}

export interface ObserverState {
  streak: number;
  improvements: number;
  best: number | null;
  recent: ReconstructedRun[];
  impHistory: number[];
  recentMetrics: number[];
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
    } else {
      state.streak++;
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
function countUntriedIdeas(ideasDir: string): number {
  if (!fs.existsSync(ideasDir)) return 0;
  try {
    return fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md")).length;
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

export function checkFinalize(allEntries: Record<string, unknown>[], oc: ObserverConfig, state: ObserverState, ideasDir: string): string | null {
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
   Strongly recommended: run /autoresearch off to finalize this session.
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
  const asiProvesFloor = state.streak >= 20 && asi.floor;

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

// ─── Trigger: Parallel opportunity (proactive, before stagnation) ───────────

function checkParallelOpportunity(
  state: ObserverState,
  payload: ObserverPayload,
  cwd: string,
  oc: ObserverConfig,
): string | null {
  // Fire at streak 3 (before stagnation threshold of 5) — early nudge
  if (state.streak < 3) return null;
  if (state.streak >= oc.stagnationThreshold) return null; // stagnation handles >=5

  const ideasDir = path.join(cwd, ".auto", "ideas");
  if (!fs.existsSync(ideasDir)) return null;

  let ideas: string[];
  try {
    const files = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
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
    patternHint = "📉 DIRECTION: All recent runs DISCARDED. Your optimization approaches aren't working — change direction entirely.";
  } else if (total > 0 && keepCount === total) {
    patternHint = "⚠️  SELECTIVITY: All recent runs KEPT but none improved the metric. You may be accepting changes that don't help — be more selective.";
  } else {
    patternHint = `🔀 MIXED: Outcomes vary (crash:${crashCount} discard:${discardCount} keep:${keepCount}). Find what DIFFERS between successes and failures.`;
  }

  // ASI-aware: if agent proved floor/exhaustion, skip generic advice
  if (asi.floor || asi.exhausted) {
    if (oc.stagnationFinalizeEnabled) {
      return `🔄 STAGNATION: No metric improvement in ${state.streak} runs.

⚠️  ASI CONTEXT: Your recent log entries already contain proof that further
   optimization is impossible or exhausted. The limit appears structural.

   Best: ${bestStr}
   ${patternHint}

   RECOMMENDED: Call finalize_research() or run /autoresearch off.
   The observer will not ask you to "change direction" again — the evidence
   in your ASI fields shows there is nowhere to change TO.`;
    }
    // Finalize recommendation disabled — fall through to actionable stagnation advice.
  }

  // Progressive escalation with parallel hints
  let escalation: string;
  switch (level) {
    case 1:
      escalation = `

💡 PARALLEL HINT: Stuck on the same approach? Try BestOfN with 3 different hypotheses:
   BestOfN({ candidates: [{hypothesis:"...",complexity:"medium"}, ...], metric_name:"...", direction:"..." })
   Workers run in isolated worktrees (cheap flash model), winner is re-measured in full.`;
      break;
    case 2:
      escalation = `

⚠️  SECOND STAGNATION CYCLE. Your first reflection didn't break through.

💡 PARALLEL HINT: The landscape may be multimodal — try SpaceSearch beam search:
   SpaceSearch({ action:"init", beam_width:3, candidates_per_state:3, diversity_hints:["approach1","approach2","approach3"] })
   Then step() to explore, finish() to re-measure the winner. Beam maintains K diverse states to avoid local optima.

Or if you need to get worse before better (refactor, algorithm swap), use phases:
   startPhase({ name:"refactor", max_steps:5, hard_floor_pct:40 })`;
      break;
    case 3:
      escalation = `

🚨 THIRD STAGNATION CYCLE. Two reflections, zero progress.

💡 PARALLEL HINT: If you're in a phase and stuck at maxSteps, spawn diverse continuations:
   valleyProbe({ strategies:["strategy1","strategy2","strategy3"], baseline_metric:..., metric_name:"...", direction:"..." })
   Workers branch from the best checkpoint with different strategies.

Otherwise: ABANDON the current direction entirely. Try a radically different approach.`;
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

  return `🔄 STAGNATION: No metric improvement in ${state.streak} runs.

${patternHint}

Recent runs (none beat best ${bestStr}):
${recentFormatted}
${escalation}
${reflectQuestions}`;
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

  // 2. Parallel opportunity (actionable: concrete ideas → BestOfN/SpaceSearch)
  const parallelSteer = checkParallelOpportunity(state, payload, cwd, oc);
  if (parallelSteer) return parallelSteer;

  // 3. Stagnation (actionable: reflection + escalation hints)
  const stagnationSteer = checkStagnation(state, asi, payload, cwd, oc);
  if (stagnationSteer) return stagnationSteer;

  // 4. Floor detection (objective limit — now checks untried ideas, P1-2)
  if (oc.floorDetectionEnabled) {
    const floorSteer = checkFloor(state, asi, payload, cwd, oc);
    if (floorSteer) return floorSteer;
  }

  // 5. Progress milestone (positive reinforcement — always useful)
  const progressSteer = checkProgress(state, payload, cwd, oc);
  if (progressSteer) return progressSteer;

  // 6. Finalize (fallback — lowest priority; agent self-assessment)
  if (oc.finalizeEnabled) {
    const finalizeSteer = checkFinalize(allEntries, oc, state, ideasPath);
    if (finalizeSteer) return finalizeSteer;
  }

  return null;
}
