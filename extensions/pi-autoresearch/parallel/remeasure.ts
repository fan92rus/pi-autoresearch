/**
 * Re-measurement on the main worktree: apply a diff, run measure.sh, parse the
 * METRIC line, optionally revert. Used for selection-bias correction (the winner
 * is re-measured in BENCH_MODE=full on main before being kept).
 *
 * Kept separate from the worker path so the parent never needs autoresearchMode
 * or the gated run_experiment tool — it just runs measure.sh via exec and parses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecFn } from "./worktree.ts";
import type { BenchMode, Direction } from "./types.ts";

const METRIC_LINE_PREFIX = "METRIC";

/** Parse "METRIC name=value" lines from output into a Map. */
export function parseMetricLines(output: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(METRIC_LINE_PREFIX)) continue;
    const rest = trimmed.slice(METRIC_LINE_PREFIX.length).trim();
    const eq = rest.indexOf("=");
    if (eq <= 0) continue;
    const name = rest.slice(0, eq).trim();
    const value = Number(rest.slice(eq + 1).trim());
    if (name && Number.isFinite(value)) map.set(name, value); // last wins
  }
  return map;
}

export interface ReMeasureResult {
  metric: number | null;
  durationSeconds: number;
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

/** Run measure.sh in `workDir` with the given BENCH_MODE; parse the named metric. */
export async function runMeasure(
  exec: ExecFn,
  workDir: string,
  metricName: string,
  benchMode: BenchMode,
  budgetSeconds: number,
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<ExecResult>,
): Promise<ReMeasureResult> {
  // measure.sh path mirrors pi-autoresearch's .auto/measure.sh convention.
  const measureSh = path.join(workDir, ".auto", "measure.sh");
  const t0 = Date.now();
  const env = { ...process.env, BENCH_MODE: benchMode };
  // Use the provided runCmd (a bash-capable runner) so Git Bash / WSL handling
  // matches the main extension on Windows.
  const res = await runCmd("bash", [measureSh], { cwd: workDir, timeout: budgetSeconds * 1000, env });
  const durationSeconds = (Date.now() - t0) / 1000;
  const output = res.stdout + "\n" + res.stderr;
  const metrics = parseMetricLines(output);
  const metric = metrics.get(metricName) ?? null;
  return {
    metric,
    durationSeconds,
    timedOut: !!res.killed,
    exitCode: res.code ?? null,
    output,
  };
}

/** Apply a unified diff in `workDir` via `git apply`. Throws on failure. */
export async function applyDiff(exec: ExecFn, workDir: string, diff: string): Promise<void> {
  // Write diff to a temp file then git apply, to avoid shell-quoting issues.
  const tmp = path.join(workDir, ".auto", "parallel", `apply-${Date.now()}.diff`);
  await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
  await fs.promises.writeFile(tmp, diff, "utf-8");
  try {
    await exec("git", ["apply", "--whitespace=nowarn", tmp], { cwd: workDir, timeout: 15000 });
  } finally {
    try { await fs.promises.rm(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** Revert working-tree changes in `workDir`, preserving .auto/. */
export async function revertWorkdir(exec: ExecFn, workDir: string, autoDirName = ".auto"): Promise<void> {
  // Mirrors log_experiment's revert, excluding .auto/.
  await exec("git", ["checkout", "--", ".", `:(exclude,glob)**/${autoDirName}`, `:(exclude,glob)**/${autoDirName}/**`], { cwd: workDir, timeout: 10000 });
  await exec("git", ["clean", "-fd", "-e", autoDirName, "-e", `**/${autoDirName}/**`], { cwd: workDir, timeout: 10000 });
}

/**
 * Selection-bias correction: apply the winning diff on main, re-measure in full,
 * decide keep (leave applied) vs discard (revert). Returns the final metric.
 */
export async function reMeasureWinner(
  exec: ExecFn,
  workDir: string,
  metricName: string,
  direction: Direction,
  baselineMetric: number,
  noiseFloor: number,
  winnerDiff: string,
  budgetSeconds: number,
  runCmd: (cmd: string, args: string[], opts: unknown) => Promise<ExecResult>,
): Promise<{ finalMetric: number | null; decision: "keep" | "discard"; reason?: string }> {
  if (!winnerDiff.trim()) {
    return { finalMetric: null, decision: "discard", reason: "empty_diff" };
  }
  try {
    await applyDiff(exec, workDir, winnerDiff);
  } catch (e) {
    // apply failed — nothing to revert, baseline intact
    return { finalMetric: null, decision: "discard", reason: `apply_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const measured = await runMeasure(exec, workDir, metricName, "full", budgetSeconds, runCmd);
  if (measured.metric === null || measured.timedOut) {
    await revertWorkdir(exec, workDir);
    return { finalMetric: null, decision: "discard", reason: measured.timedOut ? "remeasure_timeout" : "no_metric_parsed" };
  }
  const better = direction === "lower" ? measured.metric < baselineMetric : measured.metric > baselineMetric;
  const beyondNoise = Math.abs(measured.metric - baselineMetric) > noiseFloor;
  if (better && beyondNoise) {
    // Keep: diff stays applied; the parent then log_experiment(keep).
    return { finalMetric: measured.metric, decision: "keep" };
  }
  await revertWorkdir(exec, workDir);
  return {
    finalMetric: measured.metric,
    decision: "discard",
    reason: better ? "within_noise_on_remeasure" : "regression_on_remeasure",
  };
}
