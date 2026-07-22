/**
 * CPU-contention detection (ТЗ §8.1).
 *
 * Parallelism is bounded by physical cores: if measure.sh is multi-threaded and
 * saturates the CPU, N worktrees contend and real speedup ≈ 0. The pre-flight
 * measures CPU load during the baseline run; if it's ~100%, concurrency is
 * auto-lowered and an advisory is emitted.
 *
 * This is not a bug — it's the law of core conservation. The point is to never
 * sell the illusion of 4× parallelism when the machine can only do ~1×.
 */

import type { ExecFn } from "./worktree.ts";

export interface CpuLoadSample {
  /** Average idle ratio across cores during the sample window (0..1). 1 = fully idle. */
  idleRatio: number;
}

/**
 * Sample CPU load by diffing /proc/stat (Linux) over a short window, or via
 * `wmic`/`Get-Counter` on Windows. Returns null when the platform/permissions
 * don't allow sampling.
 */
export async function sampleCpuLoad(exec: ExecFn, windowMs = 500): Promise<CpuLoadSample | null> {
  const isWin = process.platform === "win32";
  if (isWin) {
    try {
      // Two samples of total processor time % over the window.
      const sample = async (): Promise<number> => {
        const r = await exec("wmic", ["cpu", "get", "loadpercentage", "/value"], { timeout: 5000 });
        const m = r.stdout.match(/LoadPercentage=(\d+)/);
        return m ? Number(m[1]) : -1;
      };
      const a = await sample();
      await sleep(windowMs);
      const b = await sample();
      if (a < 0 || b < 0) return null;
      const loadPct = (a + b) / 2;
      return { idleRatio: 1 - Math.min(100, Math.max(0, loadPct)) / 100 };
    } catch {
      return null;
    }
  }
  // Linux/Unix: /proc/stat jiffies.
  try {
    const readStat = async (): Promise<[number, number] | null> => {
      const r = await exec("cat", ["/proc/stat"], { timeout: 3000 });
      const line = r.stdout.split("\n")[0] ?? "";
      const m = line.match(/cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (!m) return null;
      const user = Number(m[1]); const nice = Number(m[2]); const sys = Number(m[3]); const idle = Number(m[4]);
      const total = user + nice + sys + idle;
      return [idle, total] as [number, number];
    };
    const s1 = await readStat();
    await sleep(windowMs);
    const s2 = await readStat();
    if (!s1 || !s2) return null;
    const idleDelta = s2[0] - s1[0];
    const totalDelta = s2[1] - s1[1];
    if (totalDelta <= 0) return null;
    return { idleRatio: idleDelta / totalDelta };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decide whether to lower concurrency given a CPU sample + the requested cap.
 * Returns the effective concurrency and an optional advisory string.
 */
export function calibrateConcurrency(requested: number, sample: CpuLoadSample | null): {
  concurrency: number;
  cpuWarning?: string;
} {
  if (!sample) {
    // Couldn't sample — keep the requested cap but emit nothing.
    return { concurrency: Math.max(1, requested) };
  }
  // idleRatio near 0 → CPU saturated (e.g. a multi-threaded build on all cores).
  if (sample.idleRatio < 0.15) {
    const lowered = Math.min(requested, 2);
    return {
      concurrency: Math.max(1, lowered),
      cpuWarning: `measure.sh saturates the CPU (idle ${Math.round(sample.idleRatio * 100)}%); real parallelism is bounded by cores — concurrency lowered ${requested}→${lowered}.`,
    };
  }
  return { concurrency: Math.max(1, requested) };
}
