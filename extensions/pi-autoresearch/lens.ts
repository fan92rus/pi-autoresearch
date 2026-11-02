/**
 * Result lens — run-artifact persistence (openspec add-result-reflection, task 1.1).
 *
 * Every run_experiment keeps its complete combined output in
 * `.auto/runs/<n>/output.txt`, independent of what is returned to the LLM
 * (tail-truncated) and of how the process ended (exit, crash, timeout, abort).
 * Run directories are allocated with a number above every existing one and
 * created exclusively, so earlier outputs are never overwritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_DIR } from "./paths.ts";

const RUNS_DIR = "runs";
const RUN_OUTPUT_FILE = "output.txt";

export interface RunArtifacts {
  runNumber: number;
  dir: string;
  outputPath: string;
}

export interface RunOutputSink {
  /** Append a chunk of raw output. A write failure is recorded in `error`, never thrown. */
  write(chunk: Buffer): void;
  /** Close the file. Idempotent. */
  close(): void;
  /** Message of the first failed write, or null when the output is complete so far. */
  readonly error: string | null;
}

export function runsRootPath(workDir: string): string {
  return path.join(workDir, AUTO_DIR, RUNS_DIR);
}

/** Highest numeric run directory already present under `root` (0 when none). */
function highestExistingRunNumber(root: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let highest = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    highest = Math.max(highest, Number(name));
  }
  return highest;
}

/**
 * Allocate `.auto/runs/<n>/` where n is never below `minRunNumber` (the next
 * ledger run number) and one above the highest existing run directory. Both
 * bounds matter: the ledger can outgrow the dirs (campaigns from before
 * `.auto/runs` existed) and can lag them (runs that were never logged). The
 * directory is created exclusively (no recursive flag), so a number taken
 * concurrently is skipped rather than reused.
 */
/**
 * Highest numeric run directory under `workDir/.auto/runs` (0 when none).
 * Exported so ledger fallback numbering can stay above orphan directories
 * left by runs that were never logged.
 */
export function highestRunDirNumber(workDir: string): number {
  return highestExistingRunNumber(runsRootPath(workDir));
}

export function allocateRunArtifacts(workDir: string, minRunNumber = 1): RunArtifacts {
  const root = runsRootPath(workDir);
  fs.mkdirSync(root, { recursive: true });
  let runNumber = Math.max(minRunNumber, highestExistingRunNumber(root) + 1);
  for (;;) {
    const dir = path.join(root, String(runNumber));
    try {
      fs.mkdirSync(dir);
      return { runNumber, dir, outputPath: path.join(dir, RUN_OUTPUT_FILE) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      runNumber++;
    }
  }
}

/**
 * Open `outputPath` for exclusive creation and append raw output to it
 * synchronously, so every byte received before a crash, timeout or abort is
 * already on disk when the run settles.
 */
/**
 * Sink used when artifact persistence is unavailable (e.g. `.auto/runs` is
 * not a directory): the run proceeds, its output is simply not persisted and
 * the reason surfaces through `error`. Spec: missing artifacts are logged,
 * never fatal.
 */
export function disabledRunOutputSink(reason: string): RunOutputSink {
  return {
    write(): void {},
    close(): void {},
    get error(): string | null {
      return reason;
    },
  };
}

export function openRunOutputSink(outputPath: string): RunOutputSink {
  const fd = fs.openSync(outputPath, "wx");
  let closed = false;
  let error: string | null = null;
  return {
    write(chunk: Buffer): void {
      if (closed || error !== null) return;
      try {
        fs.writeSync(fd, chunk);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch (e) {
        if (error === null) error = e instanceof Error ? e.message : String(e);
      }
    },
    get error() {
      return error;
    },
  };
}
