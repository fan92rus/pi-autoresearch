/**
 * Measurement track — health summary (openspec add-result-reflection).
 *
 * SINGLE data source for the "Measurement health" line (spec findings/spec.md,
 * "Секции находок в брифе совета"): the council brief (council.ts, task 1.8)
 * and the observer's periodic messages (observer.ts, task 1.7) both consume the
 * same `MeasurementHealthSummary` produced by `measurementHealthSummary()`:
 *
 *   epoch                   — current scale epoch (highest `epoch` among ledger
 *                             entries; entries without `epoch` = epoch 1)
 *   floor_stale             — the calibrated noise floor is outdated
 *   open_measurement_count  — open findings with theme "measurement"
 *   top_impact              — largest `estimated_impact` among them
 *
 * Phase 2 (measurement track) extends THIS module: task 2.1 adds the
 * `log_measurement_change` accounting implemented below (`logMeasurementChange()`
 * + the rescore-artifact helpers); later tasks 2.2–2.8 (rescore artifacts in
 * the observer, floor re-evaluation, cross-epoch blocking) extend it further.
 * The four-field contract above stays.
 *
 * floor_stale v1 semantics: any `measurement_change` record stales the noise
 * floor calibrated before it (the floor was measured on the old scale). There
 * is no floor re-evaluation record type yet, so the flag clears only when no
 * measurement_change exists; task 2.5 refines this in place.
 *
 * Healthy state: no `measurement_change` records in the ledger → the healthy
 * annotation «изменений измерителя не зарегистрировано (здоровое состояние)».
 * Since a change always bumps the epoch (task 2.1) and stales the floor, that
 * state is exactly `epoch <= 1 && !floor_stale`; the annotation is additional
 * — the four summary fields are rendered in full either way.
 *
 * Never throws: a missing/unreadable ledger or findings file degrades to the
 * healthy defaults, so old campaigns (no `.auto/findings.jsonl`, no
 * measurement records) keep working unchanged.
 *
 * Task 2.1 (measurement track) extends THIS module with the
 * `log_measurement_change` accounting: `logMeasurementChange()` validates the
 * diff and the reproducible rescore artifact (both must be regular files
 * inside `.auto/measurement/` — the only place that survives reverts), parses
 * `old_scale_score` / `new_scale_score` FROM the artifact (they are never
 * accepted as arguments), and appends a `measurement_change` ledger record
 * with the next scale epoch and `needs_verification: true`. A pending rescore
 * (`rescore_pending: true`) still requires an artifact, but one that carries
 * only the anchor and the commands; the scores may be missing and the new
 * scale stays provisional. `logMeasurementChange({ change_ref, rescore_ref })`
 * later completes such a record: a `measurement_change_completed` line in the
 * SAME epoch (no re-bump), scores again parsed from the full artifact; the
 * original record is never rewritten. The four-field health summary above is
 * untouched and keeps its contract.
 *
 * Task 2.4 (measurement track) adds the dual-scale view on top of the records:
 * `measurementScaleStatus()` folds the latest change (both scores, rescore
 * pending, provisional-until-verified), `formatMeasurementScale()` renders the
 * dashboard line the widget and the tool responses share, and
 * `confidenceSuppressionReason()` is the honest confidence gate — suppressed
 * while a rescore is pending, keep never blocked. The epoch of every fold here
 * comes from jsonl.ts's `reconstructJsonlState().currentEpoch` — the SINGLE
 * currentEpoch source shared with index/dashboard and lens-inspect (review
 * fix for 2.2), so a reverted record and a broken epoch behave identically
 * everywhere.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import { loadFindings, type FindingView, type FindingsState } from "./findings.ts";
import { AUTO_DIR } from "./paths.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** The four spec fields consumed by the council brief and the observer. */
export interface MeasurementHealthSummary {
  /** Current scale epoch: highest `epoch` among ledger entries (absent = 1). */
  epoch: number;
  /** The calibrated noise floor predates the latest measurement_change. */
  floor_stale: boolean;
  /** Open findings with theme "measurement". */
  open_measurement_count: number;
  /** Largest `estimated_impact` among those findings (null when none). */
  top_impact: string | null;
}

/** Measurement-track facts folded from the raw ledger text. */
export interface MeasurementLedgerFacts {
  /** Current scale epoch (jsonl.ts reconstruct's currentEpoch — 1 when no entry carries an epoch). */
  epoch: number;
  /** Number of `measurement_change` records in the ledger. */
  measurement_change_count: number;
  /** v1: true iff at least one measurement_change exists (see module docs). */
  floor_stale: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Ledger fold (pure)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fold ledger text into measurement-track facts. The epoch is NOT re-derived
 * here: it comes from jsonl.ts's `reconstructJsonlState().currentEpoch` — the
 * single currentEpoch source that index, the dashboard, lens-inspect and this
 * module all read (review fix for 2.2), so run records and measurement_change*
 * records advance the epoch identically everywhere and the task-2.2 contract
 * «записи без epoch = эпоха 1» holds once, not per consumer. Only the change
 * count is folded locally (it feeds floor_stale; malformed lines are skipped).
 */
export function measurementLedgerFacts(ledgerText: string): MeasurementLedgerFacts {
  const epoch = reconstructJsonlState(ledgerText).currentEpoch;
  let changeCount = 0;
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (entry !== null && entry.type === "measurement_change") changeCount++;
  }
  return { epoch, measurement_change_count: changeCount, floor_stale: changeCount > 0 };
}

// ──────────────────────────────────────────────────────────────────────────
// Summary (pure)
// ──────────────────────────────────────────────────────────────────────────

/** First percentage in an impact string ("~14% всех ошибок" → 14); null when none. */
function impactPercentValue(impact: string): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(impact);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Largest `estimated_impact` among the given findings: the string whose
 * percentage parses highest wins; unparseable strings keep their file order
 * (deterministic); null when no finding carries an impact.
 */
function topImpact(findings: readonly FindingView[]): string | null {
  let top: { text: string; value: number | null } | null = null;
  for (const finding of findings) {
    const impact = finding.estimated_impact;
    if (impact === undefined) continue;
    const value = impactPercentValue(impact);
    if (top === null || (value !== null && (top.value === null || value > top.value))) {
      top = { text: impact, value };
    }
  }
  return top === null ? null : top.text;
}

/**
 * Combine ledger facts and the findings store into the four-field summary.
 * `findings` may be null (unreadable store) → counts degrade to 0.
 */
export function measurementHealthFromFacts(
  facts: MeasurementLedgerFacts,
  findings: FindingsState | null,
): MeasurementHealthSummary {
  const open: FindingView[] = [];
  if (findings !== null) {
    for (const finding of findings.findings.values()) {
      if (finding.theme === "measurement" && finding.status === "open") open.push(finding);
    }
  }
  return {
    epoch: facts.epoch,
    floor_stale: facts.floor_stale,
    open_measurement_count: open.length,
    top_impact: topImpact(open),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Disk entry point (the single source both consumers call)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Ledger path for the campaign in `workDir`: `.auto/log.jsonl` when it exists,
 * else the legacy flat `autoresearch.jsonl` in the project root, else null.
 * This is the same resolution council.ts (brief) and observer.ts (periodic
 * messages) use, so all three read the same ledger in mixed layouts (e.g.
 * `.auto/config.json` present next to a legacy `autoresearch.jsonl`).
 */
export function measurementLedgerPath(workDir: string): string | null {
  const jsonlPath = path.join(workDir, ".auto", "log.jsonl");
  const legacyPath = path.join(workDir, "autoresearch.jsonl");
  return fs.existsSync(jsonlPath) ? jsonlPath : fs.existsSync(legacyPath) ? legacyPath : null;
}

/**
 * Read the campaign's ledger (see measurementLedgerPath) and findings store
 * from `workDir` and return the measurement health summary.
 * Missing or unreadable files degrade to the healthy defaults — never throws.
 */
export function measurementHealthSummary(workDir: string): MeasurementHealthSummary {
  let ledgerText = "";
  const ledgerPath = measurementLedgerPath(workDir);
  if (ledgerPath !== null) {
    try {
      ledgerText = fs.readFileSync(ledgerPath, "utf-8");
    } catch {
      // Unreadable ledger: healthy defaults.
    }
  }
  const loaded = loadFindings(workDir);
  return measurementHealthFromFacts(measurementLedgerFacts(ledgerText), loaded.ok ? loaded.value : null);
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────

/**
 * One-line "Measurement health: …" rendering of the summary. All four spec
 * fields are always rendered with their names (`epoch`, `floor_stale`,
 * `open_measurement_count`, `top_impact` — spec findings: the line contains
 * the whole summary, the same field set the council brief consumes). The
 * healthy state (no measurement_change registered — see module docs) adds the
 * annotation «изменений измерителя не зарегистрировано (здоровое состояние)»
 * in front of the fields; it never replaces them.
 */
export function formatMeasurementHealth(summary: MeasurementHealthSummary): string {
  const parts: string[] = [];
  if (summary.epoch <= 1 && !summary.floor_stale) {
    parts.push("изменений измерителя не зарегистрировано (здоровое состояние)");
  }
  parts.push(`epoch ${summary.epoch}`);
  parts.push(summary.floor_stale ? "floor_stale: да" : "floor_stale: нет");
  parts.push(
    `открытых measurement-находок: ${summary.open_measurement_count}` +
    ` (open_measurement_count: ${summary.open_measurement_count})`,
  );
  parts.push(`top_impact: ${summary.top_impact ?? "—"}`);
  return `Measurement health: ${parts.join("; ")}`;
}

// ──────────────────────────────────────────────────────────────────
// Scale status — dual-scale accounting (task 2.4; spec measurement-track:
// «Обязательный учёт обеих шкал», сценарии «обе шкалы известны» и
// «рескор отложен»)
// ──────────────────────────────────────────────────────────────────

/**
 * Dual-scale state of the campaign, folded from the ledger. Consumed by the
 * dashboard (index.ts renderDashboardLines), the log_experiment response and
 * the log_measurement_change tool response — one fold, one rendering, so the
 * marks cannot drift between the surfaces.
 */
export interface MeasurementScaleStatus {
  /** Current scale epoch — jsonl.ts reconstruct's currentEpoch (single source). */
  epoch: number;
  /** Reference of the latest measurement_change ("e2"); null = no changes yet. */
  change_ref: string | null;
  /**
   * The latest change is pending and not completed yet: the new scale has no
   * scores, and the confidence score stays suppressed until the rescore lands.
   */
  rescore_pending: boolean;
  /**
   * The new scale is not yet independently verified (needs_verification, or
   * the rescore is pending) — honest «предварительная» mark for the dashboard.
   * Task 2.8's verified/reverted records will refine this fold in place.
   */
  provisional: boolean;
  /** Old-scale score of the latest change, parsed from its artifact (null = absent). */
  old_scale_score: number | null;
  /** New-scale score of the latest change, parsed from its artifact (null = absent). */
  new_scale_score: number | null;
}

function finiteScoreOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface LatestChangeFold {
  epoch: number;
  pending: boolean;
  needsVerification: boolean;
  old: number | null;
  new: number | null;
}

/**
 * Pure fold of the ledger text into the dual-scale status. Follows the LAST
 * `measurement_change` record (each change resets the completion state — a
 * completion of an older change never completes the newer one); a
 * `measurement_change_completed` for it resolves the pending flag and fills
 * whichever score the change record itself lacks. Records without a usable
 * epoch are ignored; malformed lines are skipped. Never throws.
 */
export function measurementScaleStatus(ledgerText: string): MeasurementScaleStatus {
  // Single currentEpoch source (review fix for 2.2): jsonl.ts reconstruct.
  const epoch = reconstructJsonlState(ledgerText).currentEpoch;

  let change: LatestChangeFold | null = null;
  let completedForChange = false;
  let completedScores: { old: number | null; new: number | null } | null = null;

  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) continue;
    if (entry.type === "measurement_change" && typeof entry.epoch === "number" && entry.epoch >= 1) {
      change = {
        epoch: entry.epoch,
        pending: entry.rescore_pending === true,
        needsVerification: entry.needs_verification === true,
        old: finiteScoreOrNull(entry.old_scale_score),
        new: finiteScoreOrNull(entry.new_scale_score),
      };
      completedForChange = false;
      completedScores = null;
      continue;
    }
    if (
      entry.type === "measurement_change_completed" && change !== null &&
      entry.change_ref === measurementChangeId(change.epoch)
    ) {
      completedForChange = true;
      completedScores = {
        old: finiteScoreOrNull(entry.old_scale_score),
        new: finiteScoreOrNull(entry.new_scale_score),
      };
    }
  }

  if (change === null) {
    return {
      epoch,
      change_ref: null,
      rescore_pending: false,
      provisional: false,
      old_scale_score: null,
      new_scale_score: null,
    };
  }

  const pending = change.pending && !completedForChange;
  return {
    epoch,
    change_ref: measurementChangeId(change.epoch),
    rescore_pending: pending,
    provisional: pending || change.needsVerification,
    old_scale_score: change.old ?? completedScores?.old ?? null,
    new_scale_score: change.new ?? completedScores?.new ?? null,
  };
}

/**
 * Disk entry point for the dashboard and the tool responses (same ledger
 * resolution as measurementHealthSummary). Missing/unreadable ledger degrades
 * to the healthy status — never throws.
 */
export function measurementScaleStatusOfDir(workDir: string): MeasurementScaleStatus {
  return measurementScaleStatus(readLedgerText(workDir));
}

/** Render a score as ledger text: the JSON number as-is, «—» when absent. */
function formatScaleScore(score: number | null): string {
  return score === null ? "—" : String(score);
}

/**
 * One-line dashboard rendering of the dual-scale state («Шкала: …»), shared by
 * the widget dashboard, the log_experiment response and the
 * log_measurement_change response. With known scores both numbers are shown
 * side by side («дашборд показывает оба числа рядом»); a pending rescore shows
 * the honest pending mark instead, and an unverified scale is marked
 * предварительная. The healthy state names its absence of changes.
 */
export function formatMeasurementScale(status: MeasurementScaleStatus): string {
  if (status.change_ref === null) {
    return `Шкала: эпоха ${status.epoch} · изменений измерителя не зарегистрировано`;
  }
  const parts: string[] = [];
  if (status.rescore_pending) {
    parts.push(`rescore_pending (${status.change_ref}: рескор не завершён — шкалы появятся после рескора)`);
  } else {
    parts.push(`old_scale_score ${formatScaleScore(status.old_scale_score)} → new_scale_score ${formatScaleScore(status.new_scale_score)}`);
  }
  if (status.provisional) {
    parts.push("шкала предварительная (needs_verification)");
  }
  return `Шкала: эпоха ${status.epoch} · ${parts.join(" · ")}`;
}

/**
 * Honest reason to suppress the confidence score (spec «рескор отложен»:
 * confidence score подавляется до завершения рескора), or null when the score
 * may be shown. Suppression is a MARK, not a gate — keep is never blocked.
 */
export function confidenceSuppressionReason(status: MeasurementScaleStatus): string | null {
  if (!status.rescore_pending) return null;
  return `рескор изменения ${status.change_ref} не завершён (rescore_pending) — оценки старой и новой шкалы ещё не сопоставлены`;
}

// ──────────────────────────────────────────────────────────────────
// Measurement change — tool logic (task 2.1; spec measurement-track)
// ──────────────────────────────────────────────────────────────────

/** Result shape shared by the measurement-track APIs (mirrors findings.ts). */
export type MeasurementResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Diffs and rescore artifacts live here — the only place that survives reverts. */
export const MEASUREMENT_SUBDIR = "measurement";

/** Absolute path of `.auto/measurement/` for the campaign in `workDir`. */
export function measurementDirPath(workDir: string): string {
  return path.join(workDir, AUTO_DIR, MEASUREMENT_SUBDIR);
}

/** `e<epoch>` — the stable reference of a measurement change (design.md schema). */
export function measurementChangeId(epoch: number): string {
  return `e${epoch}`;
}

/** A reproducible rescore artifact, parsed from its file — never from agent text. */
export interface RescoreArtifact {
  /** Fixed anchor set id (anchor run / dataset), e.g. "run 45 window dev366". */
  anchor: string;
  /** The rescore commands and their inputs, verbatim. */
  commands: string[];
  /** Result under the OLD measurer; required unless the rescore is pending. */
  old_scale_score?: number;
  /** Result under the NEW measurer; required unless the rescore is pending. */
  new_scale_score?: number;
}

/** Ledger record `type: "measurement_change"` (openspec design.md data schema). */
export interface MeasurementChangeRecord {
  type: "measurement_change";
  /** The new scale epoch — always one above the highest epoch in the ledger. */
  epoch: number;
  diff_ref: string;
  rescore_ref: string;
  justification: string;
  old_scale_score?: number;
  new_scale_score?: number;
  /** Set when the rescore has not run yet: the new scale is provisional. */
  rescore_pending?: true;
  /** Every change starts unverified (task 2.8 verifies later). */
  needs_verification: true;
  timestamp: string;
}

/**
 * Ledger record `type: "measurement_change_completed"` — fills a pending
 * change with the scores from the FULL artifact, in the SAME epoch (no bump);
 * the original `measurement_change` record is never rewritten.
 */
export interface MeasurementChangeCompletedRecord {
  type: "measurement_change_completed";
  change_ref: string;
  epoch: number;
  rescore_ref: string;
  old_scale_score: number;
  new_scale_score: number;
  timestamp: string;
}

export interface LogMeasurementChangeInput {
  /** New change: path to the diff, inside `.auto/measurement/`. */
  diff_ref?: unknown;
  /** New change and completion: path to the rescore artifact, inside `.auto/measurement/`. */
  rescore_ref?: unknown;
  /** New change: an existing finding id ("f7") or the reason in words. */
  justification?: unknown;
  /** New change: the rescore has not run yet (artifact still required, scores may be missing). */
  rescore_pending?: unknown;
  /** Completion: reference of the pending change ("e2" or bare "2"). */
  change_ref?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** Drop a leading/trailing markdown code fence so fenced JSON still parses. */
function stripCodeFence(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length > 0 && lines[0].trimStart().startsWith("```")) lines.shift();
  if (lines.length > 0 && lines[lines.length - 1].trim() === "```") lines.pop();
  return lines.join("\n").trim();
}

/**
 * Parse rescore artifact text. Contract: a JSON object with a non-empty
 * `anchor`, a non-empty array of command strings in `commands`, and optional
 * finite-number `old_scale_score` / `new_scale_score`. A markdown code fence
 * around the JSON is tolerated (agents write .md files). Scores MUST be JSON
 * numbers — the whole point of the artifact is that the ledger numbers are
 * machine-parsed, reproducible values, not agent-claimed text.
 */
export function parseRescoreArtifact(raw: string): MeasurementResult<RescoreArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return {
      ok: false,
      errors: [
        "рескор-артефакт не читается как JSON.",
        'Ожидается объект вида {"anchor": "run 45 window dev366", "commands": ["python rescore.py --gold v15", "python rescore.py --gold v16"], "old_scale_score": 0.5598, "new_scale_score": 0.6383} (допустима markdown-обёртка ```).',
      ],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [`рескор-артефакт должен быть JSON-объектом, получено ${describeType(parsed)}`] };
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const artifact: RescoreArtifact = { anchor: "", commands: [] };

  if (isNonEmptyString(obj["anchor"])) {
    artifact.anchor = obj["anchor"].trim();
  } else {
    errors.push(
      'рескор-артефакт: поле anchor отсутствует или пусто — укажите идентификатор фиксированного якорного набора (anchor-прогон/датасет), например "anchor": "run 45 window dev366"',
    );
  }

  const commands = obj["commands"];
  if (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every((c) => typeof c === "string" && c.trim().length > 0)
  ) {
    artifact.commands = (commands as string[]).map((c) => c.trim());
  } else {
    errors.push(
      'рескор-артефакт: поле commands отсутствует, пусто или содержит не-строки — перечислите команды и входы рескора, например "commands": ["python rescore.py --gold v15"]',
    );
  }

  for (const field of ["old_scale_score", "new_scale_score"] as const) {
    const value = obj[field];
    if (value === undefined) continue; // absence is the caller's concern (pending allows it)
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`рескор-артефакт: поле ${field} должно быть конечным числом, получено ${JSON.stringify(value) ?? describeType(value)}`);
      continue;
    }
    artifact[field] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: artifact };
}

/**
 * Read a measurement-track file (diff or rescore artifact): the path must be
 * lexically inside `.auto/measurement/` under workDir, and after symlink
 * resolution the REAL path must be inside the REAL `.auto/measurement/`
 * directory — a link from inside the directory to any file outside of it (even
 * elsewhere in workDir) points at content a revert may delete. The REAL
 * `.auto/measurement/` directory itself must also live inside the REAL
 * `.auto/`: a junction on the directory would relocate every artifact out of
 * the revert-safe zone at once. Only `.auto/` survives reverts. Returns the
 * workDir-relative path and the file content; rejections name `field`.
 */
function readMeasurementFile(
  workDir: string,
  raw: string,
  field: string,
): MeasurementResult<{ rel: string; content: string }> {
  const fail = (message: string): MeasurementResult<never> => ({ ok: false, errors: [`${field} ${message}`] });

  const root = path.resolve(workDir);
  const abs = path.resolve(root, raw);
  if (!isInside(root, abs)) return fail(`"${raw}": путь вне workDir (${root})`);

  const rel = path.relative(root, abs);
  const dirPrefix = path.join(AUTO_DIR, MEASUREMENT_SUBDIR) + path.sep;
  if (!rel.startsWith(dirPrefix)) {
    return fail(
      `"${raw}": путь должен находиться в ${AUTO_DIR}/${MEASUREMENT_SUBDIR}/ — диффы и рескор-артефакты переживают revert только в .auto/`,
    );
  }

  let realFile: string;
  let realMeasDir: string;
  let realAutoDir: string;
  try {
    realFile = fs.realpathSync(abs);
  } catch {
    return fail(`"${raw}": файл не найден`);
  }
  // Containment is decided against the REAL `.auto/measurement/` directory
  // (both sides through realpathSync): realpath(workDir) containment alone
  // would admit a symlink from inside the directory to any other file in
  // workDir — a file outside `.auto/` that a revert can remove.
  try {
    realMeasDir = fs.realpathSync(path.join(root, AUTO_DIR, MEASUREMENT_SUBDIR));
    realAutoDir = fs.realpathSync(path.join(root, AUTO_DIR));
  } catch {
    return fail(`"${raw}": каталог ${AUTO_DIR}/${MEASUREMENT_SUBDIR}/ не найден`);
  }
  // The `.auto/measurement/` directory ITSELF may be a junction/symlink to a
  // directory outside `.auto/` (elsewhere in workDir or beyond it): realpath()
  // then resolves it to the target directory, and the file-vs-directory
  // containment check below passes. The REAL directory must live inside the
  // REAL `.auto/` — only `.auto/` survives reverts. (realpath(.auto) itself
  // leading outside workDir means the whole workDir was substituted — out of
  // scope here.)
  if (!isInside(realAutoDir, realMeasDir)) {
    return fail(
      `"${raw}": каталог ${AUTO_DIR}/${MEASUREMENT_SUBDIR}/ ведёт вне ${AUTO_DIR}/ (symlink): путь ведёт вне ${AUTO_DIR}/${MEASUREMENT_SUBDIR}/`,
    );
  }
  if (!isInside(realMeasDir, realFile)) {
    return fail(
      `"${raw}": путь ведёт вне ${AUTO_DIR}/${MEASUREMENT_SUBDIR}/ (symlink) — диффы и рескор-артефакты переживают revert только в .auto/`,
    );
  }

  let content: string;
  try {
    if (!fs.statSync(realFile).isFile()) return fail(`"${raw}": путь не является файлом`);
    content = fs.readFileSync(realFile, "utf-8");
  } catch (e) {
    return fail(`"${raw}": файл не читается (${e instanceof Error ? e.message : String(e)})`);
  }
  // Ledger paths are stored portable (design.md schema: ".auto/measurement/…"),
  // even when path.relative produced platform separators.
  return { ok: true, value: { rel: rel.split(path.sep).join("/"), content } };
}

// ──────────────────────────────────────────────────────────────────
// Ledger read/append (same resolution as measurementHealthSummary)
// ──────────────────────────────────────────────────────────────────

/** Read the active ledger text ("" when absent or unreadable). */
function readLedgerText(workDir: string): string {
  const ledgerPath = measurementLedgerPath(workDir);
  if (ledgerPath === null) return "";
  try {
    return fs.readFileSync(ledgerPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Append a record to the active ledger, creating `.auto/log.jsonl` (the
 * current layout) when the campaign has no ledger yet — the same path index.ts
 * writes run entries to. Returns an error message instead of throwing.
 */
function appendLedgerRecord(
  workDir: string,
  record: MeasurementChangeRecord | MeasurementChangeCompletedRecord,
): string | null {
  const file = measurementLedgerPath(workDir) ?? path.join(workDir, AUTO_DIR, "log.jsonl");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
    return null;
  } catch (e) {
    return `не удалось дописать запись в ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Latest `measurement_change` record for `epoch`, or null. */
function findMeasurementChangeRecord(ledgerText: string, epoch: number): MeasurementChangeRecord | null {
  let found: MeasurementChangeRecord | null = null;
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change") continue;
    if (entry.epoch === epoch) found = entry as unknown as MeasurementChangeRecord;
  }
  return found;
}

/** Sorted epochs of all measurement_change records (for "not found" hints). */
function measurementChangeEpochs(ledgerText: string): number[] {
  const epochs = new Set<number>();
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change") continue;
    if (typeof entry.epoch === "number") epochs.add(entry.epoch);
  }
  return [...epochs].sort((a, b) => a - b);
}

/** True when a measurement_change_completed for `changeId` is already in the ledger. */
function isChangeCompleted(ledgerText: string, changeId: string): boolean {
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change_completed") continue;
    if (entry.change_ref === changeId) return true;
  }
  return false;
}

/** "e2" / "E2" / "2" → 2; otherwise null. */
function parseChangeRef(raw: string): number | null {
  const m = /^e?(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

// ──────────────────────────────────────────────────────────────────
// log_measurement_change (task 2.1)
// ──────────────────────────────────────────────────────────────────

function newMeasurementChange(
  workDir: string,
  input: LogMeasurementChangeInput,
  now: Date,
): MeasurementResult<MeasurementChangeRecord> {
  const errors: string[] = [];

  // ── diff_ref: required, existing non-empty file in .auto/measurement/ ──
  let diffRef: string | null = null;
  if (!isNonEmptyString(input.diff_ref)) {
    errors.push(
      "diff_ref: отсутствует — изменение измерителя без диффа отклонено. " +
        "Зафиксируйте дифф в .auto/measurement/ (например `git diff > .auto/measurement/e2_gold_v16.diff`) и укажите путь",
    );
  } else {
    const read = readMeasurementFile(workDir, input.diff_ref.trim(), "diff_ref:");
    if (read.ok) {
      if (read.value.content.trim().length === 0) {
        errors.push(`diff_ref: "${input.diff_ref.trim()}" пуст — дифф должен содержать само изменение`);
      } else {
        diffRef = read.value.rel;
      }
    } else {
      errors.push(...read.errors);
    }
  }

  // ── rescore_pending: optional boolean (checked before the artifact, its value gates the score requirement) ──
  let pending = false;
  if (input.rescore_pending !== undefined) {
    if (typeof input.rescore_pending !== "boolean") {
      errors.push(`rescore_pending: ожидается boolean, получено ${describeType(input.rescore_pending)}`);
    } else {
      pending = input.rescore_pending;
    }
  }

  // ── rescore_ref: required, parsable artifact; scores required unless pending ──
  let rescoreRef: string | null = null;
  let artifact: RescoreArtifact | null = null;
  if (!isNonEmptyString(input.rescore_ref)) {
    errors.push(
      "rescore_ref: отсутствует — запись без воспроизводимого рескор-артефакта отклонена. " +
        'Сохраните артефакт (JSON: anchor, commands, old_scale_score, new_scale_score) в .auto/measurement/ и укажите путь',
    );
  } else {
    const read = readMeasurementFile(workDir, input.rescore_ref.trim(), "rescore_ref:");
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      rescoreRef = read.value.rel;
      const parsed = parseRescoreArtifact(read.value.content);
      if (!parsed.ok) {
        errors.push(`rescore_ref: артефакт "${input.rescore_ref.trim()}" не годится:`, ...parsed.errors);
      } else {
        artifact = parsed.value;
        const missing: string[] = [];
        if (artifact.old_scale_score === undefined) missing.push("old_scale_score");
        if (artifact.new_scale_score === undefined) missing.push("new_scale_score");
        if (missing.length > 0) {
          if (!pending) {
            errors.push(
              `rescore_ref: в артефакте "${input.rescore_ref.trim()}" нет ${missing.join(" и ")} — выполните рескор якорного набора старым и новым измерителем и запишите обе оценки в артефакт, ` +
                "либо вызовите с rescore_pending: true (тогда оценки в артефакте могут отсутствовать, а новая шкала останется предварительной)",
            );
          }
        } else {
          // Полный артефакт — источник истины: pending-флаг не нужен, оценки идут в запись.
          pending = false;
        }
      }
    }
  }

  // ── justification: an existing finding id ("f7") or the reason in words ──
  let justification: string | null = null;
  if (!isNonEmptyString(input.justification)) {
    errors.push(
      'justification: отсутствует — укажите ссылку на measurement-находку (например "f7") или сформулируйте причину изменения',
    );
  } else {
    justification = input.justification.trim();
    if (/^f\d+$/.test(justification)) {
      const loaded = loadFindings(workDir);
      // The store's own corruption errors are findings.ts' domain — the id
      // check is enforced only when the store is readable.
      if (loaded.ok && !loaded.value.findings.has(justification)) {
        errors.push(
          `justification: "${justification}" — находка с таким id не найдена в .auto/findings.jsonl; укажите существующий id или опишите причину словами`,
        );
      }
    }
  }

  if (errors.length > 0 || diffRef === null || rescoreRef === null || artifact === null || justification === null) {
    return { ok: false, errors };
  }

  // A change always bumps the scale epoch: records without `epoch` are epoch 1
  // (task-2.2 contract), so the first change in a campaign opens epoch 2.
  const epoch = measurementLedgerFacts(readLedgerText(workDir)).epoch + 1;
  const record: MeasurementChangeRecord = {
    type: "measurement_change",
    epoch,
    diff_ref: diffRef,
    rescore_ref: rescoreRef,
    justification,
    needs_verification: true,
    timestamp: now.toISOString(),
  };
  if (artifact.old_scale_score !== undefined) record.old_scale_score = artifact.old_scale_score;
  if (artifact.new_scale_score !== undefined) record.new_scale_score = artifact.new_scale_score;
  if (pending) record.rescore_pending = true;

  const writeError = appendLedgerRecord(workDir, record);
  if (writeError !== null) return { ok: false, errors: [writeError] };
  return { ok: true, value: record };
}

function completeMeasurementChange(
  workDir: string,
  input: LogMeasurementChangeInput,
  changeRefRaw: string,
  now: Date,
): MeasurementResult<MeasurementChangeCompletedRecord> {
  const errors: string[] = [];

  const epoch = parseChangeRef(changeRefRaw);
  if (epoch === null) {
    errors.push(`change_ref: "${changeRefRaw}" не похож на ссылку на изменение — ожидается id вида "e2" (номер эпохи изменения измерителя)`);
  }

  // ── rescore_ref: required FULL artifact (both scores) ──
  let rescoreRef: string | null = null;
  let scores: { old_scale_score: number; new_scale_score: number } | null = null;
  if (!isNonEmptyString(input.rescore_ref)) {
    errors.push(
      "rescore_ref: отсутствует — завершение pending-изменения требует полный рескор-артефакт (обе оценки)",
    );
  } else {
    const read = readMeasurementFile(workDir, input.rescore_ref.trim(), "rescore_ref:");
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const parsed = parseRescoreArtifact(read.value.content);
      if (!parsed.ok) {
        errors.push(`rescore_ref: артефакт "${input.rescore_ref.trim()}" не годится:`, ...parsed.errors);
      } else if (parsed.value.old_scale_score === undefined || parsed.value.new_scale_score === undefined) {
        errors.push(
          `rescore_ref: артефакт "${input.rescore_ref.trim()}" неполный — завершение pending требует обе оценки (old_scale_score и new_scale_score); при незавершённом рескоре завершение не вызывается`,
        );
      } else {
        rescoreRef = read.value.rel;
        scores = { old_scale_score: parsed.value.old_scale_score, new_scale_score: parsed.value.new_scale_score };
      }
    }
  }

  if (epoch !== null) {
    const ledgerText = readLedgerText(workDir);
    const changeId = measurementChangeId(epoch);
    const change = findMeasurementChangeRecord(ledgerText, epoch);
    if (change === null) {
      const known = measurementChangeEpochs(ledgerText);
      errors.push(
        `change_ref: изменение ${changeId} не найдено в леджере (` +
          (known.length > 0 ? `зарегистрированы: ${known.map(measurementChangeId).join(", ")}` : "изменений измерителя не зарегистрировано") +
          ")",
      );
    } else if (change.rescore_pending !== true) {
      errors.push(`change_ref: изменение ${changeId} не в pending — оценки уже записаны, завершение не требуется`);
    } else if (isChangeCompleted(ledgerText, changeId)) {
      errors.push(`change_ref: изменение ${changeId} уже завершено (measurement_change_completed в леджере) — записи не переписываются`);
    }
  }

  if (errors.length > 0 || epoch === null || rescoreRef === null || scores === null) {
    return { ok: false, errors };
  }

  const record: MeasurementChangeCompletedRecord = {
    type: "measurement_change_completed",
    change_ref: measurementChangeId(epoch),
    epoch,
    rescore_ref: rescoreRef,
    old_scale_score: scores.old_scale_score,
    new_scale_score: scores.new_scale_score,
    timestamp: now.toISOString(),
  };
  const writeError = appendLedgerRecord(workDir, record);
  if (writeError !== null) return { ok: false, errors: [writeError] };
  return { ok: true, value: record };
}

/**
 * Task 2.1 entry point (index.ts wires the `log_measurement_change` tool to
 * this). Two modes by input shape:
 *  - new change: { diff_ref, rescore_ref, justification, rescore_pending? } →
 *    appends `measurement_change` with the next scale epoch and
 *    `needs_verification: true`;
 *  - completion: { change_ref, rescore_ref } → appends
 *    `measurement_change_completed` in the SAME epoch (no bump).
 * Scores are NEVER accepted as arguments: they are parsed from the rescore
 * artifact, so the ledger numbers are as reproducible as the artifact itself.
 * Rejections collect every problem at once (findings.ts style).
 */
export function logMeasurementChange(
  workDir: string,
  input: LogMeasurementChangeInput,
  now: Date = new Date(),
): MeasurementResult<MeasurementChangeRecord | MeasurementChangeCompletedRecord> {
  if (input.change_ref !== undefined) {
    if (!isNonEmptyString(input.change_ref)) {
      return {
        ok: false,
        errors: [`change_ref: ожидается строка-ссылка на исходное изменение (например "e2"), получено ${describeType(input.change_ref)}`],
      };
    }
    return completeMeasurementChange(workDir, input, input.change_ref.trim(), now);
  }
  return newMeasurementChange(workDir, input, now);
}
