/**
 * Cross-platform shell resolution for spawning bash scripts.
 *
 * Windows pitfall: bare spawn("bash", ...) lets CreateProcess resolve
 * bash.exe — and its search order checks System32 BEFORE PATH, so it finds
 * C:\Windows\System32\bash.exe, the WSL launcher, not Git Bash. Everything
 * that runs bash on Windows must go through getBashSpawnOptions().
 */
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

/**
 * Resolve the bash shell path and spawn options for the current platform.
 * On Windows, finds Git Bash at known locations (avoiding WSL bash).
 * Mirrors the logic in pi-coding-agent's utils/shell.ts getShellConfig().
 */
export function getBashSpawnOptions(): { shell: string; spawnArgs: string[]; detached: boolean } {
  if (process.platform === "win32") {
    // Try Git Bash in known locations first (like pi's getShellConfig)
    const candidates: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { shell: candidate, spawnArgs: ["-c"], detached: false };
      }
    }

    // Fallback: search bash.exe on PATH via 'where' (avoids WSL bash if Git Bash is first)
    try {
      const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && fs.existsSync(firstMatch)) {
          return { shell: firstMatch, spawnArgs: ["-c"], detached: false };
        }
      }
    } catch {
      // Ignore — fall through to bare "bash"
    }
  }

  // Unix or fallback: use bare "bash" (PATH lookup works fine on Unix)
  return { shell: "bash", spawnArgs: ["-c"], detached: true };
}

/**
 * Kill a process and all its children (cross-platform).
 * Mirrors pi core's killProcessTree (utils/shell.ts):
 *   - Windows: taskkill /F /T /PID (kills the entire process tree)
 *   - Unix:    SIGKILL on the process group (negative PID), then just the PID
 *
 * NOTE: The previous Unix-only SIGTERM implementation did NOT kill the tree on
 * Windows — process.kill(-pid) is unsupported there, and the fallback only
 * killed the immediate bash child, leaving the benchmark (go test, python, ...)
 * running as an orphan indefinitely.
 */
export type KillTreeReason =
  | "killed"
  | "already_gone"
  | "spawn_failed"
  | "command_failed"
  | "timeout"
  | "unverified";

export interface KillTreeOutcome {
  ok: boolean;
  verified: boolean;
  reason: KillTreeReason;
}

interface KillTreeDeps {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  isAlive: (pid: number) => boolean;
  timeoutMs: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const killTreeDefaults: KillTreeDeps = {
  platform: process.platform,
  spawn,
  isAlive: processIsAlive,
  timeoutMs: 2000,
};

export async function killTree(pid: number, deps: Partial<KillTreeDeps> = {}): Promise<KillTreeOutcome> {
  const d = { ...killTreeDefaults, ...deps };

  if (d.platform === "win32") {
    // Use taskkill on Windows to kill the process tree.
    // /F = force, /T = kill child processes (tree), /PID = target
    let child: ReturnType<typeof spawn>;
    try {
      child = d.spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      return { ok: false, verified: false, reason: "spawn_failed" };
    }

    return await new Promise<KillTreeOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: KillTreeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish({ ok: false, verified: false, reason: "timeout" }),
        d.timeoutMs,
      );
      child.once("error", () => finish({ ok: false, verified: false, reason: "spawn_failed" }));
      child.once("close", (code) => {
        if (code !== 0) {
          finish({ ok: false, verified: false, reason: "command_failed" });
          return;
        }
        const alive = d.isAlive(pid);
        finish(
          alive
            ? { ok: true, verified: false, reason: "unverified" }
            : { ok: true, verified: true, reason: "killed" },
        );
      });
    });
  }

  // Unix: SIGKILL the process group (negative PID).
  // SIGKILL (not SIGTERM) — cannot be caught/ignored, guarantees death.
  let alreadyGone = false;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alreadyGone = true;
    }
  }
  if (alreadyGone) return { ok: true, verified: true, reason: "already_gone" };
  const alive = d.isAlive(pid);
  return alive
    ? { ok: true, verified: false, reason: "unverified" }
    : { ok: true, verified: true, reason: "killed" };
}
