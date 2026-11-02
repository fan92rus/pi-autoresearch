/**
 * Result lens — run-artifact persistence (openspec add-result-reflection,
 * tasks 1.1 and 1.3).
 *
 * Every run_experiment keeps its complete combined output in
 * `.auto/runs/<n>/output.txt`, independent of what is returned to the LLM
 * (tail-truncated) and of how the process ended (exit, crash, timeout, abort).
 * Run directories are allocated with a number above every existing one and
 * created exclusively, so earlier outputs are never overwritten.
 *
 * Task 1.3 adds the per-run manifest: declared artifacts (`analysis.artifacts`)
 * are copied into the run directory after the run settles, and manifest.json
 * records paths, sizes, sha16, missing entries and size-only entries (over
 * `copy_limit_mb`). Declared measurement files (`analysis.measurement_files`)
 * are hashed into the same manifest (hash-control input for task 2.7).
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
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

// ──────────────────────────────────────────────────────────────────────────
// Run manifest (openspec add-result-reflection, task 1.3)
// ──────────────────────────────────────────────────────────────────────────

const RUN_MANIFEST_FILE = "manifest.json";
/** Run-dir files an artifact copy must never clobber. */
const RESERVED_RUN_FILE_NAMES = [RUN_OUTPUT_FILE, RUN_MANIFEST_FILE];
const HASH_CHUNK_BYTES = 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

/**
 * The declared-artifact configuration a run manifest needs. Structurally
 * satisfied by lens-config's AnalysisConfig (the extra `extractors` field is
 * simply not consumed here), so lens.ts stays decoupled from the parser.
 */
export interface RunManifestInput {
  /** Declared artifact paths (analysis.artifacts), verbatim. */
  artifacts: string[];
  /** Declared measurer files (analysis.measurement_files), verbatim. */
  measurementFiles: string[];
  /** Per-artifact copy ceiling in MB (analysis.copy_limit_mb). */
  copyLimitMb: number;
}

export interface RunManifestArtifact {
  /** The declared path, verbatim. */
  declared: string;
  copied: boolean;
  /** Copy location relative to the run directory (when copied). */
  file?: string;
  /** Size in bytes: of the copy (copied) or of the original (size_only). */
  bytes?: number;
  /** First 16 hex chars of the copy's sha256 (when copied). */
  sha16?: string;
  /** Declared but absent after the run. */
  missing?: boolean;
  /** Bigger than copy_limit_mb: not copied, size recorded only (spec: "путь-ссылка … с пометкой size-only"). */
  size_only?: boolean;
  /** Why the copy itself failed (never fatal — spec: «прогон не считается упавшим»). */
  read_error?: string;
}

export interface RunManifestMeasurementFile {
  /** The declared path, verbatim. */
  path: string;
  /** First 16 hex chars of sha256 — the hash-control input for task 2.7. */
  sha16?: string;
  missing?: boolean;
  read_error?: string;
}

/**
 * One manifest per run: output hash + declared-artifact copies + declared
 * measurement-file hashes. Shape follows design.md "Data Schemas"
 * (.auto/runs/<n>/manifest.json).
 */
export interface RunManifest {
  run: number;
  output: string;
  bytes?: number;
  sha16?: string;
  measurement_files: RunManifestMeasurementFile[];
  artifacts: RunManifestArtifact[];
}

function manifestErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sha16Digest(hash: ReturnType<typeof createHash>): string {
  return hash.digest("hex").slice(0, 16);
}

/** Stream a file through sha256; returns byte count and the 16-hex-char digest. */
function hashFile16(filePath: string): { bytes: number; sha16: string } {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
    return { bytes, sha16: sha16Digest(hash) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy source → dest while hashing. Exclusive destination creation: two
 * declared paths normalizing onto the same run-dir location must not
 * silently overwrite each other — the second surfaces as a read_error
 * entry instead (repo principle: explicit, never silent).
 */
function copyFileHashed(sourcePath: string, destPath: string): { bytes: number; sha16: string } {
  const hash = createHash("sha256");
  const source = fs.openSync(sourcePath, "r");
  try {
    // "wx" failing with EEXIST throws here, before the rollback scope below:
    // the file at destPath then belongs to another artifact and must survive.
    const dest = fs.openSync(destPath, "wx");
    let bytes = 0;
    try {
      const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
      for (;;) {
        const read = fs.readSync(source, chunk, 0, chunk.length, null);
        if (read === 0) break;
        hash.update(chunk.subarray(0, read));
        let written = 0;
        while (written < read) {
          written += fs.writeSync(dest, chunk, written, read - written);
        }
        bytes += read;
      }
      fs.closeSync(dest);
    } catch (e) {
      try {
        fs.closeSync(dest);
      } catch { /* keep the original error */ }
      // A failed copy must not leave a half-written artifact in the run dir:
      // remove the file this call created.
      fs.rmSync(destPath, { force: true });
      throw e;
    }
    return { bytes, sha16: sha16Digest(hash) };
  } finally {
    try {
      fs.closeSync(source);
    } catch { /* nothing to add */ }
  }
}

/**
 * Where inside the run dir a declared artifact is copied. Declared paths
 * inside the campaign dir keep their relative structure (subdir artifacts
 * stay subdirs, no basename collisions); absolute or parent-relative
 * declarations are trusted for READING, but copies never escape the run
 * dir — those keep only their basename. Returns null for the reserved
 * run-dir names (output.txt, manifest.json), which a copy must never
 * clobber.
 */
function copyTargetRelativePath(workDir: string, sourcePath: string): string | null {
  const rel = path.relative(workDir, sourcePath);
  const escapesWorkDir = rel.length === 0 || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  const target = escapesWorkDir ? path.basename(sourcePath) : path.normalize(rel);
  // Manifest paths are platform-neutral forward-slash (matching the verbatim
  // `declared` path and JSON convention); node's path.join accepts them on
  // every platform.
  const targetRel = target.split(path.sep).join("/");
  // The WHOLE relative target is compared, case-insensitively (reserved names
  // are lowercase): on case-insensitive filesystems (NTFS, default macOS)
  // "MANIFEST.json" or "Output.TXT" at the run-dir root would clobber the
  // reserved file, while a nested "results/manifest.json" clobbers nothing.
  if (RESERVED_RUN_FILE_NAMES.includes(targetRel.toLowerCase())) return null;
  return targetRel;
}

/** Copy one declared artifact; every failure mode becomes a manifest field. */
function copyDeclaredArtifact(
  workDir: string,
  runDir: string,
  declared: string,
  copyLimitMb: number,
): RunManifestArtifact {
  const info: RunManifestArtifact = { declared, copied: false };
  const limitBytes = copyLimitMb * BYTES_PER_MB;
  try {
    const sourcePath = path.resolve(workDir, declared);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch {
      info.missing = true;
      return info;
    }
    if (!stats.isFile()) {
      info.read_error = `declared artifact is not a regular file: ${declared}`;
      return info;
    }
    if (stats.size > limitBytes) {
      // Spec "артефакт превышает лимит размера": only the path-reference
      // lands in the manifest, with the size and the size-only mark; the
      // file itself stays outside .auto/runs.
      info.size_only = true;
      info.missing = false;
      info.bytes = stats.size;
      return info;
    }
    const targetRel = copyTargetRelativePath(workDir, sourcePath);
    if (targetRel === null) {
      info.read_error = `copy target is a reserved run-dir name: ${declared}`;
      return info;
    }
    const targetPath = path.join(runDir, targetRel);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const hashed = copyFileHashed(sourcePath, targetPath);
    info.copied = true;
    info.file = targetRel;
    info.bytes = hashed.bytes;
    info.sha16 = hashed.sha16;
    return info;
  } catch (e) {
    info.read_error = manifestErrorMessage(e);
    return info;
  }
}

/** Hash one declared measurement file; failures become manifest fields. */
function measureDeclaredFile(workDir: string, declared: string): RunManifestMeasurementFile {
  const info: RunManifestMeasurementFile = { path: declared };
  try {
    const sourcePath = path.resolve(workDir, declared);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(sourcePath);
    } catch {
      info.missing = true;
      return info;
    }
    if (!stats.isFile()) {
      info.read_error = `declared measurement file is not a regular file: ${declared}`;
      return info;
    }
    info.sha16 = hashFile16(sourcePath).sha16;
    return info;
  } catch (e) {
    info.read_error = manifestErrorMessage(e);
    return info;
  }
}

/**
 * Copy declared artifacts into the run directory and write manifest.json
 * next to output.txt (openspec add-result-reflection, task 1.3; schema in
 * design.md "Data Schemas").
 *
 * Called when the run settles (exit, crash, timeout, abort), after the
 * output sink is closed, so output.txt is complete when it is hashed and
 * artifacts created by the run already exist on disk.
 *
 * Spec-literal scope: the manifest exists to carry declared artifacts
 * (result-lens) and measurement-file hashes (measurement-track). With
 * neither declared there is nothing to pin — no manifest is written at all
 * (generic campaigns keep `.auto/runs/<n>/` output-only).
 *
 * Failure policy (spec result-lens): missing, oversized or failing
 * artifacts are recorded in the manifest (`missing` / `size_only` /
 * `read_error`) and the run itself never fails because of them; any
 * unexpected error here degrades to "no manifest" (null) instead of
 * throwing.
 */
export function writeRunManifest(
  workDir: string,
  runArtifacts: RunArtifacts,
  analysis: RunManifestInput,
): RunManifest | null {
  if (analysis.artifacts.length === 0 && analysis.measurementFiles.length === 0) return null;
  try {
    const manifest: RunManifest = {
      run: runArtifacts.runNumber,
      output: RUN_OUTPUT_FILE,
      measurement_files: [],
      artifacts: [],
    };
    try {
      const hashed = hashFile16(runArtifacts.outputPath);
      manifest.bytes = hashed.bytes;
      manifest.sha16 = hashed.sha16;
    } catch { /* unreadable output — the declared-list sections still get written */ }
    for (const declared of analysis.measurementFiles) {
      manifest.measurement_files.push(measureDeclaredFile(workDir, declared));
    }
    for (const declared of analysis.artifacts) {
      manifest.artifacts.push(copyDeclaredArtifact(workDir, runArtifacts.dir, declared, analysis.copyLimitMb));
    }
    fs.writeFileSync(path.join(runArtifacts.dir, RUN_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } catch {
    return null;
  }
}
