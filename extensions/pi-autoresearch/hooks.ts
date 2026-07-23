import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { hasAutoresearchConfigHeader } from "./jsonl.ts";
import { hookScriptPath, globalHookPath } from "./paths.ts";
import { runObserver } from "./observer.ts";

const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated: hook stdout exceeded 8KB]";

/**
 * Resolve the bash shell path for the current platform.
 * On Windows, finds Git Bash at known locations (avoiding WSL bash).
 * Mirrors the logic in pi-coding-agent's utils/shell.ts getShellConfig().
 */
function getBashForSpawn(): string {
  if (process.platform === "win32") {
    const candidates: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Fallback: search bash.exe on PATH via 'where'
    try {
      const { spawnSync } = require("node:child_process");
      const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && fs.existsSync(firstMatch)) {
          return firstMatch;
        }
      }
    } catch {
      // Ignore
    }
  }

  return "bash";
}


const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80; // continuation byte: 10xxxxxx
const UTF8_LEAD = 0xc0; // multi-byte leader: 11xxxxxx

/** Trim at the last newline, falling back to the last complete UTF-8 character. */
function truncateAtBoundary(buf: Buffer): Buffer {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

export type HookStage = "before" | "after";

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const notFired: HookResult = {
  fired: false,
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

/** Run a single hook script, capturing stdout/stderr with truncation. */
async function runSingleScript(script: string, payload: HookPayload): Promise<HookResult> {
  const t0 = Date.now();
  return new Promise<HookResult>((resolve) => {
    const child = spawn(getBashForSpawn(), [script], { cwd: payload.cwd, timeout: TIMEOUT_MS, windowsHide: true });

    let stdout = "";
    let stdoutBytes = 0;
    let stdoutFull = false;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutFull) return;
      const remaining = STDOUT_MAX_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
        return;
      }
      const kept = truncateAtBoundary(chunk.subarray(0, remaining));
      stdout += kept.toString("utf8") + TRUNCATION_MARKER;
      stdoutFull = true;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (exitCode: number | null, extraErr = "") => {
      const combinedStderr = extraErr ? (stderr ? `${stderr}\n${extraErr}` : extraErr) : stderr;
      resolve({
        fired: true,
        stdout,
        stderr: combinedStderr,
        exitCode,
        timedOut: child.killed,
        durationMs: Date.now() - t0,
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Merge two hook results: concatenate stdout, aggregate errors. */
function mergeResults(global: HookResult, local: HookResult): HookResult {
  if (!global.fired) return local;
  if (!local.fired) return global;
  // Both fired — concatenate stdout with separator if both have output.
  const g = global.stdout.trim();
  const l = local.stdout.trim();
  const stdout = g && l ? `${g}\n---\n${l}` : (g || l);
  return {
    fired: true,
    stdout,
    stderr: [global.stderr, local.stderr].filter(Boolean).join("\n"),
    // Non-zero from either = non-zero merged (local failures don't block global steers)
    exitCode: (global.exitCode !== 0 || local.exitCode !== 0) ? (local.exitCode ?? global.exitCode) : 0,
    timedOut: global.timedOut || local.timedOut,
    durationMs: global.durationMs + local.durationMs,
  };
}

/** Collect executable *.sh files from a .d directory, sorted alphabetically. */
function collectHookDir(dirPath: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath)
      .filter(f => f.endsWith(".sh"))
      .sort();
  } catch {
    return [];
  }
  return entries
    .map(f => path.join(dirPath, f))
    .filter(f => isExecutableFile(f));
}

/**
 * Run hooks: built-in TypeScript observer FIRST, then user bash hooks in parallel.
 * The observer is extension code (in-process, no spawn overhead).
 * User hooks (global + project-local + .d/) run in addition to the observer.
 */
export async function runHook(payload: HookPayload): Promise<HookResult> {
  if (payload.event !== "before") {
    // For after.sh: no built-in observer, just run user hooks.
    const globalScript = globalHookPath(payload.event);
    const globalDir = path.join(path.dirname(globalScript), `${payload.event}.d`);
    const localScript = hookScriptPath(payload.cwd, payload.event);
    const localDir = path.join(path.dirname(localScript), `${payload.event}.d`);

    const tasks: Promise<HookResult>[] = [];
    if (isExecutableFile(globalScript)) tasks.push(runSingleScript(globalScript, payload));
    for (const script of collectHookDir(globalDir)) tasks.push(runSingleScript(script, payload));
    if (localScript !== globalScript && isExecutableFile(localScript)) tasks.push(runSingleScript(localScript, payload));
    for (const script of collectHookDir(localDir)) tasks.push(runSingleScript(script, payload));

    if (tasks.length === 0) return notFired;
    const results = await Promise.all(tasks);
    return results.reduce(mergeResults);
  }

  // before.sh: run built-in observer (TypeScript, in-process) first.
  const observerResult = runBundledObserver(payload);

  // Collect user bash hooks.
  const globalScript = globalHookPath(payload.event);
  const globalDir = path.join(path.dirname(globalScript), `${payload.event}.d`);
  const localScript = hookScriptPath(payload.cwd, payload.event);
  const localDir = path.join(path.dirname(localScript), `${payload.event}.d`);

  const tasks: Promise<HookResult>[] = [];
  if (isExecutableFile(globalScript)) tasks.push(runSingleScript(globalScript, payload));
  for (const script of collectHookDir(globalDir)) tasks.push(runSingleScript(script, payload));
  if (localScript !== globalScript && isExecutableFile(localScript)) tasks.push(runSingleScript(localScript, payload));
  for (const script of collectHookDir(localDir)) tasks.push(runSingleScript(script, payload));

  if (tasks.length === 0) return observerResult;

  // Merge observer output with user hook outputs.
  const userResults = await Promise.all(tasks);
  const userMerged = userResults.reduce(mergeResults);
  return mergeResults(observerResult, userMerged);
}

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join("\n");
  }
  return result.stdout.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    timed_out: result.timedOut,
  };
}

function hasConfigHeader(jsonlPath: string): boolean {
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    return hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf-8"));
  } catch {
    return false;
  }
}

export function appendHookLogEntryIfConfigured(
  jsonlPath: string,
  stage: HookStage,
  result: HookResult,
): boolean {
  if (!result.fired) return false;
  if (!hasConfigHeader(jsonlPath)) return false;

  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(hookLogEntry(stage, result)) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ─── Bundled observer (TypeScript, in-process) ───────────────────────────────
// The observer is now native extension code (observer.ts), not a bash script.
// It runs in-process (no spawn overhead) and provides stagnation/floor/noise/finalize triggers.

/** Run the built-in TypeScript observer and wrap its output as a HookResult. */
function runBundledObserver(payload: HookPayload): HookResult {
  const t0 = Date.now();
  try {
    const steer = runObserver({
      cwd: payload.cwd,
      direction: payload.session.direction,
      metricName: payload.session.metric_name,
      metricUnit: payload.session.metric_unit,
      baselineMetric: payload.session.baseline_metric,
      bestMetric: payload.session.best_metric,
      runCount: payload.session.run_count,
      goal: payload.session.goal,
    });
    return {
      fired: steer !== null,
      stdout: steer ?? "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      fired: false,
      stdout: "",
      stderr: `observer error: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - t0,
    };
  }
}

// ─── Migration (remove old auto-installed hook) ─────────────────────────────

const OBSERVER_VERSION_RE = /^#\s*OBSERVER_VERSION=(\d+)/m;

/**
 * One-time migration: remove the old auto-installed hook from user space.
 * Previous versions auto-installed the observer to ~/.pi/agent/autoresearch/hooks/before.sh.
 * Now the observer is TypeScript extension code. If the old file still exists, we
 * remove it — whether it has the OBSERVER_VERSION marker or not — because it's
 * superseded by the bundled observer and would cause duplicate steers.
 * Exception: if the file is NOT recognizable as our observer (no v3/v4 header),
 * it's a user customization and we leave it.
 */
export function migrateAutoInstalledHook(): { removed: boolean; reason?: string } {
  const globalPath = globalHookPath("before");
  if (!fs.existsSync(globalPath)) return { removed: false, reason: "not_found" };
  try {
    const content = fs.readFileSync(globalPath, "utf-8");
    const isOurs = OBSERVER_VERSION_RE.test(content) || /GLOBAL AUTORESEARCH OBSERVER/.test(content);
    if (!isOurs) return { removed: false, reason: "user_customized" };
    fs.unlinkSync(globalPath);
    return { removed: true };
  } catch {
    return { removed: false, reason: "delete_failed" };
  }
}
