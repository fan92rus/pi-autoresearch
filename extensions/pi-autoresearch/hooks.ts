import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

export async function runHook(payload: HookPayload): Promise<HookResult> {
  // Project-local hook takes precedence; global hook is a fallback.
  const localScript = hookScriptPath(payload.cwd, payload.event);
  const script = isExecutableFile(localScript) ? localScript : globalHookPath(payload.event);
  if (!isExecutableFile(script)) return notFired;

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

// ─── Auto-install global observer hook ──────────────────────────────────────

const OBSERVER_VERSION_RE = /^#\s*OBSERVER_VERSION=(\d+)/m;

/** Extract the OBSERVER_VERSION=N marker from a hook script. Returns null if not found (user customization). */
function extractObserverVersion(content: string): number | null {
  const m = content.match(OBSERVER_VERSION_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Ensure the global observer hook is installed and up-to-date.
 *
 *  - If the global hook doesn't exist → install it.
 *  - If it exists and has a version marker → update if the bundled version is newer.
 *  - If it exists but has no version marker → skip (user has customized it).
 *
 *  Returns a summary of what happened.
 */
export async function ensureGlobalHook(bundledHookPath: string): Promise<{
  installed: boolean;
  updated: boolean;
  skipped: boolean;
  reason?: string;
}> {
  const destPath = globalHookPath("before");

  // Read bundled hook
  let sourceContent: string;
  try {
    sourceContent = await fs.promises.readFile(bundledHookPath, "utf-8");
  } catch {
    return { installed: false, updated: false, skipped: true, reason: "bundled_hook_not_found" };
  }
  const sourceVersion = extractObserverVersion(sourceContent);
  if (sourceVersion === null) {
    return { installed: false, updated: false, skipped: true, reason: "bundled_hook_no_version" };
  }

  // Ensure dest directory exists
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  // Check existing hook
  let destContent: string | null = null;
  try {
    destContent = await fs.promises.readFile(destPath, "utf-8");
  } catch {
    // File doesn't exist — install fresh
  }

  if (destContent === null) {
    // Fresh install
    await fs.promises.writeFile(destPath, sourceContent, "utf-8");
    await fs.promises.chmod(destPath, 0o755);
    return { installed: true, updated: false, skipped: false };
  }

  const destVersion = extractObserverVersion(destContent);

  // If dest has no version marker → user customization, skip
  if (destVersion === null) {
    return { installed: false, updated: false, skipped: true, reason: "user_customized" };
  }

  // Update if bundled version is newer
  if (sourceVersion > destVersion) {
    // Backup old version
    const backupPath = destPath + ".bak";
    try { await fs.promises.copyFile(destPath, backupPath); } catch { /* ignore */ }
    await fs.promises.writeFile(destPath, sourceContent, "utf-8");
    await fs.promises.chmod(destPath, 0o755);
    return { installed: false, updated: true, skipped: false };
  }

  return { installed: false, updated: false, skipped: true, reason: "up_to_date" };
}
