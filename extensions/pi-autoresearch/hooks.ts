import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hasAutoresearchConfigHeader } from "./jsonl.ts";
import { hookScriptPath, globalHookPath } from "./paths.ts";

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
 * Run hooks in order: bundled observer → global user → project-local → project-local .d/.
 * The observer is extension code (always runs, managed by git).
 * User hooks add behavior on top — they never replace the observer.
 */
export async function runHook(payload: HookPayload): Promise<HookResult> {
  const observerScript = bundledHookPath(payload.event);
  const globalScript = globalHookPath(payload.event);
  const globalDir = path.join(path.dirname(globalScript), `${payload.event}.d`);
  const localScript = hookScriptPath(payload.cwd, payload.event);
  const localDir = path.join(path.dirname(localScript), `${payload.event}.d`);

  const tasks: Promise<HookResult>[] = [];

  // 1. Bundled observer hook (extension code, managed by git).
  if (isExecutableFile(observerScript)) {
    tasks.push(runSingleScript(observerScript, payload));
  }

  // 2. Global user hook (~/.pi/agent/autoresearch/hooks/before.sh) — only if NOT a managed leftover.
  if (isExecutableFile(globalScript) && !isManagedHook(globalScript)) {
    tasks.push(runSingleScript(globalScript, payload));
  }

  // 3. Global user hooks dir (~/.pi/agent/autoresearch/hooks/before.d/*.sh).
  for (const script of collectHookDir(globalDir)) {
    tasks.push(runSingleScript(script, payload));
  }

  // 4. Project-local hook (.auto/hooks/before.sh).
  if (localScript !== globalScript && isExecutableFile(localScript)) {
    tasks.push(runSingleScript(localScript, payload));
  }

  // 5. Project-local hooks dir (.auto/hooks/before.d/*.sh).
  for (script of collectHookDir(localDir)) {
    tasks.push(runSingleScript(script, payload));
  }

  if (tasks.length === 0) return notFired;
  const results = await Promise.all(tasks);
  return results.reduce(mergeResults);
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

// ─── Bundled observer hook path ─────────────────────────────────────────────
// The observer ships inside the extension package (not in user space).
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Path to the bundled observer hook inside the extension directory. */
export function bundledHookPath(stage: HookStage): string {
  return path.join(EXTENSION_DIR, "observer", `${stage}.sh`);
}

const OBSERVER_VERSION_RE = /^#\s*OBSERVER_VERSION=(\d+)/m;

/** Returns true if a file contains the OBSERVER_VERSION marker (our managed hook). */
function isManagedHook(filePath: string): boolean {
  try {
    return OBSERVER_VERSION_RE.test(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
}

/**
 * One-time migration: remove the old auto-installed hook from user space.
 * Previous versions auto-installed the observer to ~/.pi/agent/autoresearch/hooks/before.sh.
 * Now the observer runs from the extension dir. If the old file still has our
 * OBSERVER_VERSION marker, it's a leftover — delete it so it doesn't run twice.
 * If it has no marker (user customized it), leave it — it runs as a user hook.
 */
export function migrateAutoInstalledHook(): { removed: boolean; reason?: string } {
  const globalPath = globalHookPath("before");
  if (!fs.existsSync(globalPath)) return { removed: false, reason: "not_found" };
  if (!isManagedHook(globalPath)) return { removed: false, reason: "user_customized" };
  try {
    fs.unlinkSync(globalPath);
    return { removed: true };
  } catch (e) {
    return { removed: false, reason: "delete_failed" };
  }
}
