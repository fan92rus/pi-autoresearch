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

interface ObserverState {
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

function parseAsiFlags(runs: ReconstructedRun[], ideasPath: string): AsiFlags {
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

  // Fallback: check ideas.md for marker words
  if (!floor && fs.existsSync(ideasPath)) {
    try {
      const ideas = fs.readFileSync(ideasPath, "utf-8");
      if (/PROVEN COMPLETE|MATHEMATICALLY IMPOSSIBLE|FLOOR REACHED|PROVABLY/i.test(ideas)) {
        floor = true;
      }
      if (/EXHAUST|NO.*UNTRIED/i.test(ideas)) {
        exhausted = true;
      }
    } catch { /* ignore */ }
  }

  return { floor, profiled, noise, exhausted };
}

// ─── State computation ───────────────────────────────────────────────────────

function computeState(runs: ReconstructedRun[], direction: "lower" | "higher"): ObserverState {
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

// ─── Trigger: Finalize ───────────────────────────────────────────────────────

function checkFinalize(allEntries: Record<string, unknown>[], oc: ObserverConfig): string | null {
  const finalizeEntries = allEntries.filter((e) => e.type === "finalize");
  if (finalizeEntries.length === 0) return null;

  const last = finalizeEntries[finalizeEntries.length - 1];
  const confidence = typeof last.confidence === "number" ? last.confidence : 0;
  const reason = typeof last.reason === "string" ? last.reason : "no reason given";
  const confPct = Math.round(confidence * 100);

  if (confidence > oc.finalizeStrongThreshold) {
    return `🏁 FINALIZE SIGNAL (confidence ${confPct}%): Agent signaled optimization is complete.
   Reason: ${reason}

   The agent has explicitly recorded a finalize entry with high confidence.
   Strongly recommended: run /autoresearch off to finalize this session.
   To override: delete the finalize entry from .auto/log.jsonl or lower the threshold in /autoresearch config.`;
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

function checkFloor(
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

  const triggerReason = isFloor ? "variance" : "asi_proof";
  const unit = payload.metricUnit;
  const bestStr = state.best !== null ? `${state.best}${unit}` : `?${unit}`;
  const ideasPath = path.join(cwd, ".auto", "ideas.md");

  const lines: string[] = [
    `🔬 FLOOR DETECTED: Optimization has reached its structural limit (trigger: ${triggerReason}).`,
  ];

  if (triggerReason === "variance" && stats) {
    lines.push(`   Metric stable at ~${stats.mean.toFixed(2)}${unit} ± ${stats.std.toFixed(2)}${unit} (CV=${stats.cv.toFixed(4)}, n=${stats.n}) across ${state.streak} non-improving runs.`);
  } else {
    lines.push(`   Agent ASI/ideas.md contains proof that further optimization is impossible.`);
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

  if (fs.existsSync(ideasPath)) {
    lines.push(`   - Reflections in ${ideasPath}`);
  }

  lines.push("");
  lines.push(`   RECOMMENDED ACTION:`);
  lines.push(`   → Run /autoresearch off and finalize`);
  lines.push(`   → Or call finalize_research(reason="...", confidence=0.9)`);
  lines.push(`   → Or start a fresh segment with a different metric/target`);
  lines.push("");
  lines.push(`   To override: set "auto_floor_override": true in .auto/config.json`);

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

  const ideasPath = path.join(cwd, ".auto", "ideas.md");
  if (!fs.existsSync(ideasPath)) return null;

  let ideas: string[];
  try {
    const content = fs.readFileSync(ideasPath, "utf-8");
    // Extract bullet-point lines (- or *) that are not strikethrough
    ideas = content
      .split("\n")
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return /^[\-*]\s+/.test(l) && !/~~/.test(l) && l.length > 10; })
      .map(function (l) { return l.replace(/^[\-*]\s+/, ""); });
  } catch {
    return null;
  }

  // Need at least 2 untried ideas to make BestOfN worthwhile
  if (ideas.length < 2) return null;

  // Check that agent hasn't already used parallel tools recently
  const recentLog = state.recent.slice(-5);
  const usedParallel = recentLog.some(function (r) {
    const desc = String((r as Record<string, unknown>).description ?? "");
    return /BestOfN|SpaceSearch|CheckOrthogonal|valleyProbe/i.test(desc);
  });
  if (usedParallel) return null;

  // Build a BestOfN suggestion with up to 3 ideas from ideas.md
  const top3 = ideas.slice(0, 3);
  const candidates = top3.map(function (idea, i) {
    const short = idea.length > 60 ? idea.slice(0, 57) + "..." : idea;
    return `    {hypothesis:"${short}", complexity:"${i === 0 ? "simple" : "medium"}"}`;
  }).join(",\n");

  return [
    `⚡ PARALLEL OPPORTUNITY: You have ${ideas.length} untried ideas in .auto/ideas.md and ${state.streak} non-improving runs.`,
    `   Stop testing sequentially — try them ALL AT ONCE with BestOfN:`,
    `   BestOfN({ candidates: [`,
    candidates,
    `   ], metric_name:"${payload.metricName}", direction:"${payload.direction}" })`,
    `   BestOfN spawns isolated worktrees, measures each, re-measures the best, returns keep/discard.`,
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
  const ideasPath = path.join(cwd, ".auto", "ideas.md");

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
    return `🔄 STAGNATION: No metric improvement in ${state.streak} runs.

⚠️  ASI CONTEXT: Your recent log entries already contain proof that further
   optimization is impossible or exhausted. The limit appears structural.

   Best: ${bestStr}
   ${patternHint}

   RECOMMENDED: Call finalize_research() or run /autoresearch off.
   The observer will not ask you to "change direction" again — the evidence
   in your ASI fields shows there is nowhere to change TO.`;
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

💀 CRITICAL: ${state.streak} non-improving runs (${level} stagnation cycles). The session appears EXHAUSTED. Consider /autoresearch off and finalize, or call finalize_research() to signal completion.`;
      break;
  }

  // ASI-adapted reflect questions
  let reflectQuestions: string;
  if (asi.profiled) {
    reflectQuestions = `REFLECT:
1. Your profiling (per ASI) shows where time is spent. Is the bottleneck ADDRESSABLE from the code you're allowed to change?
2. Are there orthogonal dimensions you haven't explored (memory, I/O, caching, precomputation)?
3. Would a completely different algorithm or data structure help, even if more complex?
4. Consider calling finalize_research() if the limit is structural.`;
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
  const ideasPath = path.join(cwd, ".auto", "ideas.md");

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

  // Parse all raw entries (for finalize detection)
  const finalizeSteer = checkFinalize(allEntries, oc);
  if (finalizeSteer) return finalizeSteer;

  // Noise gate (can run independently of log state)
  const noiseSteer = checkNoiseGate(payload, cwd, oc);
  if (noiseSteer) return noiseSteer;

  // Reconstruct state from log.jsonl
  const reconstructed = reconstructJsonlState(content);
  const segRuns = reconstructed.results.filter((r) => r.segment === reconstructed.currentSegment);

  const state = computeState(segRuns, direction);
  const ideasPath = path.join(cwd, ".auto", "ideas.md");
  const asi = parseAsiFlags(segRuns, ideasPath);

  // Floor detection
  const floorSteer = checkFloor(state, asi, payload, cwd, oc);
  if (floorSteer) return floorSteer;

  // Parallel opportunity (proactive — fires at streak 3, before stagnation)
  const parallelSteer = checkParallelOpportunity(state, payload, cwd, oc);
  if (parallelSteer) return parallelSteer;

  // Stagnation
  const stagnationSteer = checkStagnation(state, asi, payload, cwd, oc);
  if (stagnationSteer) return stagnationSteer;

  // Progress milestone
  const progressSteer = checkProgress(state, payload, cwd, oc);
  if (progressSteer) return progressSteer;

  return null;
}
