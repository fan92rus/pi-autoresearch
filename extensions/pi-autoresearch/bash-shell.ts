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
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    // Use taskkill on Windows to kill the process tree.
    // /F = force, /T = kill child processes (tree), /PID = target
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // Ignore errors if taskkill fails
    }
  } else {
    // Unix: SIGKILL the process group (negative PID).
    // SIGKILL (not SIGTERM) — cannot be caught/ignored, guarantees death.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}
