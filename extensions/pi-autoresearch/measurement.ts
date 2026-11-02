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
 * fix for 2.2); task 2.8 below refines the scale/floor folds to the ACTIVE
 * epoch (a reverted record restores the confirmed one) while the epoch COUNTER
 * for new change ids keeps the shared max semantics.
 *
 * Task 2.5 (measurement track) refines floor_stale and wires the keep verdict:
 * the noise floor is (re)calibrated on a SCALE, so this module owns the single
 * floor source — `readNoiseFloorConfig()` reads `noiseFloor` plus the epoch
 * stamp `noiseFloorEpoch` from `.auto/config.json`, and `noiseFloorStatus()`
 * folds staleness against the shared scale epoch: a floor stamped below the
 * current epoch predates the latest measurement_change and is stale. The loop
 * stamps the epoch whenever it calibrates (index.ts), and the documented
 * RE-EVALUATION MECHANISM is manual: the spec prescribes only the observer
 * nudge, so the floor stays stale until noiseFloor is re-measured on the new
 * scale and BOTH config keys are updated (`noiseFloor` + `noiseFloorEpoch`).
 * Suppression then lifts by itself (stamp == current epoch → not stale).
 * Compat (tasks.md): a config without the stamp (campaign predates 2.5 or the
 * floor was never calibrated) keeps the v1 summary mark `floor_stale = any
 * measurement_change` (conservative nudge in the brief/observer health line),
 * but does NOT activate the new keep-verdict gate (explicit mark + confidence
 * suppression) — a campaign that never used the stamp mechanism keeps its old
 * behavior.
 *
 * Task 2.8 (measurement track) closes the verification loop around a change:
 * `verifyMeasurementChange()` appends a `measurement_change_verified` record
 * (proof file in `.auto/measurement/` with the executed commands, their
 * outputs and the reproduced scores — machine-checked to match the ledger's
 * scores for the change) and `revertMeasurementChange()` appends the
 * compensating `measurement_change_reverted` (counter-rescore artifact whose
 * parsed scores DIFFER). Both are append-only; original records are never
 * rewritten. The folds refine in place: `measurementScaleStatus().epoch`
 * becomes the ACTIVE scale epoch — the last CONFIRMED epoch, restored after a
 * revert (epoch 1 baseline) — which is what new runs get stamped with, so the
 * rejected epoch's runs stay incomparable (cross-epoch, task 2.3); the epoch
 * ids themselves stay monotonic and are never reused (the counter behind
 * `measurementLedgerFacts().epoch` keeps jsonl.ts's max semantics and the
 * reverted record cannot raise it — bd pi-autoresearch-1wp.3.2 fix in
 * jsonl.ts). A verified change lifts needs_verification/provisional;
 * `measurementVerificationState()` exposes the verified/reverted fold (proof
 * and counter-rescore refs, rejected epochs) and `formatMeasurementScale()`
 * takes it as an optional second argument to render the verified/reverted
 * lines. The floor folds (floor_stale, noiseFloorStatus) compare against the
 * ACTIVE epoch: a floor calibrated on the restored scale is fresh again.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import { loadFindings, type FindingView, type FindingsState } from "./findings.ts";
import { AUTO_DIR, sessionFilePath } from "./paths.ts";

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
 *
 * `floorEpoch` (task 2.5) is the epoch stamp of the calibrated noise floor
 * (`.auto/config.json` noiseFloorEpoch) — pass `readNoiseFloorConfig(dir).epoch`.
 * Without a stamp the v1 semantics hold unchanged (any measurement_change
 * stales the floor: the config predates the stamp mechanism, the conservative
 * summary mark stays); with a stamp the floor is stale only while it predates
 * the current scale epoch (`epoch > floorEpoch`) — re-evaluation lifts it.
 * KNOWN LIMITATION (task 2.8 review M3, accepted): for an UNSTAMPED floor the
 * v1 mark never clears — after a revert the active scale is restored, but the
 * summary keeps `floor_stale: да` because the mark tracks the existence of a
 * measurement_change, not epochs. Conservative nudge only (brief/observer
 * health line); it does not gate keep and does not suppress confidence by
 * itself — those paths require a stamped config (see noiseFloorStatus).
 */
export function measurementLedgerFacts(ledgerText: string, floorEpoch?: number | null): MeasurementLedgerFacts {
  const epoch = reconstructJsonlState(ledgerText).currentEpoch;
  let changeCount = 0;
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (entry !== null && entry.type === "measurement_change") changeCount++;
  }
  // The floor was calibrated ON A SCALE (task 2.8): staleness compares the
  // stamp with the ACTIVE scale epoch — after a revert the restored scale is
  // the one an old floor was measured on, so it is fresh again. `epoch` above
  // stays the monotonic epoch counter (jsonl.ts max semantics) that feeds the
  // next change's id.
  const activeEpoch = measurementVerificationState(ledgerText).active_epoch;
  return {
    epoch,
    measurement_change_count: changeCount,
    floor_stale: changeCount > 0 && (floorEpoch == null || activeEpoch > floorEpoch),
  };
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
  // Single floor source (task 2.5): the summary's floor_stale respects the
  // floor's epoch stamp — a re-evaluated floor (stamped at the current epoch)
  // is fresh again; an unstamped config keeps the v1 mark.
  return measurementHealthFromFacts(
    measurementLedgerFacts(ledgerText, readNoiseFloorConfig(workDir).epoch),
    loaded.ok ? loaded.value : null,
  );
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
  /**
   * ACTIVE scale epoch — the scale in force, what new runs are stamped with
   * (task 2.8): the latest change's epoch, restored to the last CONFIRMED
   * epoch by a revert (baseline 1 when nothing was verified). Equals jsonl.ts
   * reconstruct's currentEpoch until a revert — the epoch COUNTER behind
   * measurementLedgerFacts().epoch stays max-semantics so ids are never reused.
   */
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
   * Lifted by a `measurement_change_verified` record; a reverted change is
   * closed instead (the restored active scale is the confirmed baseline).
   */
  provisional: boolean;
  /** Old-scale score of the latest change, parsed from its artifact (null = absent). */
  old_scale_score: number | null;
  /** New-scale score of the latest change, parsed from its artifact (null = absent). */
  new_scale_score: number | null;
}

/**
 * Verification fold of the latest measurement_change (task 2.8; spec
 * measurement-track «Верификация measurement_change»): whether the independent
 * check confirmed or refuted it, which epoch the active scale is on, and which
 * epochs were rejected by reverts (their runs are incomparable — cross-epoch,
 * task 2.3). The report and the dashboard line render from this fold.
 */
export interface MeasurementVerificationState {
  /** The latest change is independently verified (needs_verification lifted). */
  verified: boolean;
  /** The latest change was refuted (counter-rescore) and reverted. */
  reverted: boolean;
  /** Active scale epoch — the last confirmed epoch (baseline 1), see MeasurementScaleStatus.epoch. */
  active_epoch: number;
  /** Epochs rejected by reverts, ascending — their runs are incomparable. */
  rejected_epochs: number[];
  /** Proof file of the latest change's verification (null when unverified). */
  proof_ref: string | null;
  /** Counter-rescore artifact of the latest revert (null when none). */
  counter_rescore_ref: string | null;
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

interface MeasurementLedgerFold {
  scale: MeasurementScaleStatus;
  verification: MeasurementVerificationState;
}

/** Epoch a verified/reverted record refers to: its own epoch, else its change_ref ("e2"/"2"). */
function recordEpochRef(entry: Record<string, unknown>): number | null {
  if (typeof entry.epoch === "number" && Number.isSafeInteger(entry.epoch) && entry.epoch >= 1) return entry.epoch;
  if (isNonEmptyString(entry.change_ref)) return parseChangeRef(entry.change_ref);
  return null;
}

/** Highest confirmed epoch strictly below `n` (baseline 1 — the original scale needs no verification). */
function maxConfirmedBelow(confirmed: ReadonlySet<number>, n: number): number {
  let best = 1;
  for (const e of confirmed) if (e < n && e > best) best = e;
  return best;
}

/**
 * Single fold of the ledger into the dual-scale status AND the verification
 * state (one walk, so the two views cannot drift). Follows the LAST
 * `measurement_change` record (each change resets the completion/verification
 * state — a completion or verification of an older change never completes the
 * newer one; verifications of older changes still count as confirmations for
 * future reverts). Records without a usable epoch are ignored; malformed lines
 * are skipped. Never throws.
 *
 * Active epoch (task 2.8): a measurement_change activates its epoch; a
 * verified record confirms it; a reverted record restores the active scale to
 * the last confirmed epoch strictly below the rejected one (baseline 1). The
 * epoch ids stay monotonic — the counter for the NEXT change is jsonl.ts's
 * max-semantics currentEpoch (measurementLedgerFacts), which a reverted
 * record cannot raise (bd pi-autoresearch-1wp.3.2).
 */
function foldMeasurementLedger(ledgerText: string): MeasurementLedgerFold {
  let activeEpoch = 1;
  const confirmedEpochs = new Set<number>();
  const rejectedEpochs = new Set<number>();

  let change: LatestChangeFold | null = null;
  let completedForChange = false;
  let completedScores: { old: number | null; new: number | null } | null = null;
  let verifiedForChange = false;
  let proofRef: string | null = null;
  let revertedForChange = false;
  let counterRef: string | null = null;

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
      verifiedForChange = false;
      proofRef = null;
      revertedForChange = false;
      counterRef = null;
      activeEpoch = entry.epoch;
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
      continue;
    }
    if (entry.type === "measurement_change_verified") {
      const epoch = recordEpochRef(entry);
      if (epoch !== null) {
        confirmedEpochs.add(epoch);
        if (change !== null && epoch === change.epoch) {
          verifiedForChange = true;
          proofRef = typeof entry.proof_ref === "string" ? entry.proof_ref : null;
        }
      }
      continue;
    }
    if (entry.type === "measurement_change_reverted") {
      const epoch = recordEpochRef(entry);
      if (epoch !== null) {
        rejectedEpochs.add(epoch);
        activeEpoch = maxConfirmedBelow(confirmedEpochs, epoch);
        if (change !== null && epoch === change.epoch) {
          revertedForChange = true;
          counterRef = typeof entry.rescore_ref === "string" ? entry.rescore_ref : null;
        }
      }
      continue;
    }
  }

  const verification: MeasurementVerificationState = {
    verified: verifiedForChange,
    reverted: revertedForChange,
    active_epoch: activeEpoch,
    rejected_epochs: [...rejectedEpochs].sort((a, b) => a - b),
    proof_ref: proofRef,
    counter_rescore_ref: counterRef,
  };

  if (change === null) {
    return {
      scale: {
        epoch: activeEpoch,
        change_ref: null,
        rescore_pending: false,
        provisional: false,
        old_scale_score: null,
        new_scale_score: null,
      },
      verification,
    };
  }

  const pending = change.pending && !completedForChange && !revertedForChange;
  return {
    scale: {
      epoch: activeEpoch,
      change_ref: measurementChangeId(change.epoch),
      rescore_pending: pending,
      provisional: !revertedForChange && (pending || (change.needsVerification && !verifiedForChange)),
      // Refuted numbers are not the scale state: after a revert the restored
      // active scale carries no dual-scale pair.
      old_scale_score: revertedForChange ? null : (change.old ?? completedScores?.old ?? null),
      new_scale_score: revertedForChange ? null : (change.new ?? completedScores?.new ?? null),
    },
    verification,
  };
}

/**
 * Pure fold of the ledger text into the dual-scale status (task 2.4, refined
 * in place by task 2.8: active-epoch semantics and the verified/reverted
 * refinement — see foldMeasurementLedger).
 */
export function measurementScaleStatus(ledgerText: string): MeasurementScaleStatus {
  return foldMeasurementLedger(ledgerText).scale;
}

/**
 * Pure fold of the ledger text into the verification state (task 2.8): the
 * verified/reverted verdict for the latest change, the active (confirmed)
 * epoch and the rejected epochs. Same fold as measurementScaleStatus, so the
 * two views agree by construction.
 */
export function measurementVerificationState(ledgerText: string): MeasurementVerificationState {
  return foldMeasurementLedger(ledgerText).verification;
}

/**
 * Disk entry point for the dashboard and the tool responses (same ledger
 * resolution as measurementHealthSummary). Missing/unreadable ledger degrades
 * to the healthy status — never throws.
 */
export function measurementScaleStatusOfDir(workDir: string): MeasurementScaleStatus {
  return foldMeasurementLedger(readLedgerText(workDir)).scale;
}

/**
 * Disk entry point for the verification state (same ledger resolution as
 * measurementScaleStatusOfDir). Missing/unreadable ledger degrades to the
 * unverified defaults — never throws.
 */
export function measurementVerificationStateOfDir(workDir: string): MeasurementVerificationState {
  return foldMeasurementLedger(readLedgerText(workDir)).verification;
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
 *
 * `verification` (task 2.8) is the fold from measurementVerificationState —
 * pass it to render the verified mark (needs_verification снят) or the
 * reverted state (change refuted, active scale restored, rejected epoch's
 * runs incomparable). Legacy 1-argument calls keep the exact previous lines.
 */
export function formatMeasurementScale(
  status: MeasurementScaleStatus,
  verification: MeasurementVerificationState | null = null,
): string {
  if (status.change_ref === null) {
    return `Шкала: эпоха ${status.epoch} · изменений измерителя не зарегистрировано`;
  }
  const parts: string[] = [];
  if (verification !== null && verification.reverted) {
    parts.push(`изменение ${status.change_ref} опровергнуто (контр-рескор)`);
    parts.push(`активная шкала восстановлена по последней подтверждённой эпохе: ${status.epoch}`);
    if (verification.rejected_epochs.length > 0) {
      parts.push(`прогоны эпохи ${verification.rejected_epochs.join(", ")} несравнимы (cross-epoch)`);
    }
    return `Шкала: эпоха ${status.epoch} · ${parts.join(" · ")}`;
  }
  if (status.rescore_pending) {
    parts.push(`rescore_pending (${status.change_ref}: рескор не завершён — шкалы появятся после рескора)`);
  } else {
    parts.push(`old_scale_score ${formatScaleScore(status.old_scale_score)} → new_scale_score ${formatScaleScore(status.new_scale_score)}`);
  }
  if (status.provisional) {
    parts.push("шкала предварительная (needs_verification)");
  } else if (verification !== null && verification.verified) {
    parts.push("подтверждено независимой проверкой (needs_verification снят)");
  }
  return `Шкала: эпоха ${status.epoch} · ${parts.join(" · ")}`;
}

/**
 * Honest reason to suppress the confidence score (spec «рескор отложен»:
 * confidence score подавляется до завершения рескора; task 2.5: и до
 * переоценки устаревшего floor), or null when the score may be shown.
 * Suppression is a MARK, not a gate — keep is never blocked. `floorStatus`
 * (task 2.5) adds the stale-floor reason; the rescore reason stays first so
 * existing consumers keep parsing it at the head of the line.
 */
export function confidenceSuppressionReason(
  status: MeasurementScaleStatus,
  floorStatus?: NoiseFloorStatus | null,
): string | null {
  const reasons: string[] = [];
  if (status.rescore_pending) {
    reasons.push(
      `рескор изменения ${status.change_ref} не завершён (rescore_pending) — оценки старой и новой шкалы ещё не сопоставлены`,
    );
  }
  if (floorStatus !== undefined && floorStatus !== null && floorStatus.stale) {
    reasons.push(floorStaleSuppressionReason(floorStatus));
  }
  if (reasons.length === 0) return null;
  return reasons.join("; ");
}

// ──────────────────────────────────────────────────────────────────
// Noise floor status — re-evaluation after a measurer change (task 2.5;
// spec measurement-track: «Переоценка noise floor после изменения измерителя»)
// ──────────────────────────────────────────────────────────────────

/**
 * The calibrated noise floor, read from `.auto/config.json` — THE single floor
 * source: the loop's calibration write (index.ts), the keep-verdict gate and
 * the health summary all take the floor (and its epoch stamp) from here.
 * The council's own legacy reader (council.ts readNoiseFloor) reads the same
 * key with the same predicate; new consumers must go through this module.
 */
export interface NoiseFloorConfig {
  /** Calibrated floor as a fraction (0.04 = ±4%); null = not calibrated or invalid. */
  floor: number | null;
  /** Scale epoch the floor was calibrated on (`noiseFloorEpoch`); null = unstamped config. */
  epoch: number | null;
}

/** Floor facts + staleness verdict, folded against the shared active epoch. */
export interface NoiseFloorStatus {
  /**
   * Active scale epoch (task 2.8) — the scale in force: jsonl.ts reconstruct's
   * currentEpoch until a revert, the restored last-confirmed epoch after one.
   */
  epoch: number;
  /** Calibrated floor fraction; null = not calibrated or invalid. */
  floor: number | null;
  /** Epoch the floor was calibrated on; null = unstamped config (pre-2.5 campaign). */
  floor_epoch: number | null;
  /**
   * The floor predates the latest measurement_change: stamped below the current
   * scale epoch. Strictly stamp-based — an UNSTAMPED floor never activates the
   * keep-verdict gate (compat: campaigns that never used the stamp mechanism
   * keep their behavior); the health summary keeps its conservative v1 mark
   * for that case instead.
   */
  stale: boolean;
}

/** Same validity predicate as the council's readNoiseFloor (one floor, one shape). */
function validFloorOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Same validity predicate as jsonl.ts's epoch check, applied to the config stamp. */
function validFloorEpochOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Read `noiseFloor` + `noiseFloorEpoch` from the campaign config through the
 * single source path (sessionFilePath("config") — the same file writeConfig
 * and the loop's calibration write). Missing/unreadable config degrades to
 * «not calibrated» — never throws.
 */
export function readNoiseFloorConfig(workDir: string): NoiseFloorConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFilePath(workDir, "config"), "utf-8")) as Record<string, unknown>;
    return {
      floor: validFloorOrNull(raw["noiseFloor"]),
      epoch: validFloorEpochOrNull(raw["noiseFloorEpoch"]),
    };
  } catch {
    return { floor: null, epoch: null };
  }
}

/**
 * Pure fold (task 2.5, epoch refined by 2.8): floor facts + staleness against
 * the ACTIVE scale epoch (the same fold the dashboard line reads — a floor is
 * calibrated on a scale, so after a revert the restored scale is the one an
 * old floor was measured on and is fresh again). `stale` = a measurement_change
 * postdates the floor's calibration stamp (`floor_epoch !== null && epoch >
 * floor_epoch`). After re-evaluation (floor re-measured on the new scale, both
 * config keys updated) the stamp equals the current epoch and the flag — with
 * it the keep mark and the confidence suppression — lifts by itself.
 */
export function noiseFloorStatus(
  ledgerText: string,
  cfg: NoiseFloorConfig = { floor: null, epoch: null },
): NoiseFloorStatus {
  const epoch = foldMeasurementLedger(ledgerText).verification.active_epoch;
  return {
    epoch,
    floor: cfg.floor,
    floor_epoch: cfg.epoch,
    stale: cfg.epoch !== null && epoch > cfg.epoch,
  };
}

/**
 * Disk entry point (same ledger resolution as measurementHealthSummary, same
 * config read as the loop). Missing files degrade to «no floor, epoch 1» —
 * never throws.
 */
export function noiseFloorStatusOfDir(workDir: string): NoiseFloorStatus {
  let ledgerText = "";
  const ledgerPath = measurementLedgerPath(workDir);
  if (ledgerPath !== null) {
    try {
      ledgerText = fs.readFileSync(ledgerPath, "utf-8");
    } catch {
      // Unreadable ledger: epoch 1 defaults.
    }
  }
  return noiseFloorStatus(ledgerText, readNoiseFloorConfig(workDir));
}

/**
 * The explicit keep-verdict mark (spec scenario «keep без свежего floor»): the
 * record is ACCEPTED — never blocked — but the response names the stale floor
 * and the re-evaluation demand with the documented manual procedure: re-measure
 * the noise on the new scale and update BOTH config keys (`noiseFloor` and
 * `noiseFloorEpoch`); the suppression lifts once the stamp equals the current
 * epoch. (The spec prescribes no automatic re-evaluation mechanism, only the
 * observer nudge — hence the manual config update is the documented path.)
 */
export function formatFloorStale(status: NoiseFloorStatus): string {
  return (
    `Noise floor устарел (floor_stale): калиброван на эпохе ${status.floor_epoch}, текущая шкала — эпоха ${status.epoch}. ` +
    `Keep записан — не блокируется; переоцените floor на новой шкале: измерьте шум новым измерителем и обновите ` +
    `.auto/config.json (noiseFloor и noiseFloorEpoch: ${status.epoch}). До переоценки confidence подавлен.`
  );
}

/** The suppression-reason phrasing of the same fact (shorter: why the number is hidden). */
function floorStaleSuppressionReason(status: NoiseFloorStatus): string {
  return (
    `noise floor устарел (floor_stale: калиброван на эпохе ${status.floor_epoch}, шкала — эпоха ${status.epoch}) — ` +
    "переоцените floor на новой шкале (обновите noiseFloor и noiseFloorEpoch в .auto/config.json)"
  );
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

/**
 * Ledger record `type: "measurement_change_verified"` (task 2.8; spec scenario
 * «верификация подтвердила») — the appended confirmation of a measurement
 * change: the reference to the original change plus the proof file with the
 * executed commands, their outputs and the reproduced scores. Appended, never
 * rewritten: at reconstruction the change's needs_verification is lifted and
 * the scale is no longer provisional.
 */
export interface MeasurementChangeVerifiedRecord {
  type: "measurement_change_verified";
  change_ref: string;
  /** The verified change's epoch — no epoch bump: verification opens nothing. */
  epoch: number;
  /** Proof file in `.auto/measurement/` (commands, outputs, reproduced scores). */
  proof_ref: string;
  timestamp: string;
}

/**
 * Ledger record `type: "measurement_change_reverted"` (task 2.8; spec scenario
 * «верификация опровергла») — the compensating record when the re-run of the
 * rescore yields different scores: the reference to the change plus the
 * counter-rescore artifact. The active scale is restored to the last confirmed
 * epoch; the rejected epoch's runs become incomparable; epoch ids stay
 * monotonic (the rejected id is never reused).
 */
export interface MeasurementChangeRevertedRecord {
  type: "measurement_change_reverted";
  change_ref: string;
  /** The rejected change's epoch — stays in the ledger's epoch counter (ids are never reused). */
  epoch: number;
  /** Counter-rescore artifact in `.auto/measurement/` (scores differ from the change's). */
  rescore_ref: string;
  /** Finding id or the reason the change was refuted. */
  justification: string;
  timestamp: string;
}

export interface VerifyMeasurementChangeInput {
  /** Reference of the change to verify ("e2" or bare "2"). */
  change_ref?: unknown;
  /** Proof file in `.auto/measurement/`: anchor, commands, outputs, reproduced scores. */
  proof_ref?: unknown;
}

export interface RevertMeasurementChangeInput {
  /** Reference of the change to revert ("e2" or bare "2") — must be the latest change. */
  change_ref?: unknown;
  /** Counter-rescore artifact in `.auto/measurement/` (same anchor, different scores). */
  rescore_ref?: unknown;
  /** Finding id or the reason the change was refuted. */
  justification?: unknown;
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
 * A verification proof artifact (task 2.8): a FULL rescore artifact (anchor,
 * commands, BOTH scores — the reproduced numbers that confirmation is judged
 * by) plus `outputs` — the verbatim outputs of the executed commands, as a
 * non-empty string or one string per command (same length as `commands`).
 * This is the file the `measurement_change_verified` record points at; the
 * scores in it are machine-checked against the change's ledger scores, so the
 * proof cannot quietly disagree with what was confirmed.
 */
export interface ProofArtifact extends RescoreArtifact {
  /** Verbatim outputs of the executed commands (one per command, or one blob). */
  outputs: string[];
}

export function parseProofArtifact(raw: string): MeasurementResult<ProofArtifact> {
  const base = parseRescoreArtifact(raw);
  if (!base.ok) return base;

  const errors: string[] = [];
  if (base.value.old_scale_score === undefined || base.value.new_scale_score === undefined) {
    errors.push(
      "доказательство неполное — воспроизведённый рескор должен содержать обе оценки (old_scale_score и new_scale_score): их совпадение с оценками изменения и есть подтверждение",
    );
  }

  // The outputs field is dropped by parseRescoreArtifact — read it from the
  // same (already validated) JSON object.
  const obj = JSON.parse(stripCodeFence(raw)) as Record<string, unknown>;
  const outputs: string[] = [];
  const rawOutputs = obj["outputs"];
  if (isNonEmptyString(rawOutputs)) {
    outputs.push(rawOutputs.trim());
  } else if (
    Array.isArray(rawOutputs) &&
    rawOutputs.length === base.value.commands.length &&
    rawOutputs.every((o) => typeof o === "string" && o.trim().length > 0)
  ) {
    outputs.push(...(rawOutputs as string[]).map((o) => o.trim()));
  } else if (Array.isArray(rawOutputs) && rawOutputs.length !== base.value.commands.length) {
    errors.push(
      `доказательство: outputs должен содержать вывод каждой команды (commands: ${base.value.commands.length}, outputs: ${rawOutputs.length}) — по одной непустой строке на команду либо одна строка с общим выводом`,
    );
  } else {
    errors.push(
      'доказательство: поле outputs отсутствует или пусто — добавьте выводы выполненных команд, например "outputs": ["0.5598 (366 примеров)", "0.6383 (366 примеров)"] (строка или массив строк по одной на команду)',
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...base.value, outputs } };
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
  record:
    | MeasurementChangeRecord
    | MeasurementChangeCompletedRecord
    | MeasurementChangeVerifiedRecord
    | MeasurementChangeRevertedRecord,
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

/** True when a measurement_change_verified for `changeId` is already in the ledger. */
function isChangeVerified(ledgerText: string, changeId: string): boolean {
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change_verified") continue;
    if (entry.change_ref === changeId) return true;
  }
  return false;
}

/** True when a measurement_change_reverted for `changeId` is already in the ledger. */
function isChangeReverted(ledgerText: string, changeId: string): boolean {
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change_reverted") continue;
    if (entry.change_ref === changeId) return true;
  }
  return false;
}

/** Reference scores for verify/revert: the completion's scores when present, else the change's. */
function referenceScoresFor(
  ledgerText: string,
  change: MeasurementChangeRecord,
  changeId: string,
): { old_scale_score: number; new_scale_score: number; rescore_ref: string } | null {
  let completed: MeasurementChangeCompletedRecord | null = null;
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.type !== "measurement_change_completed") continue;
    if (entry.change_ref === changeId) completed = entry as unknown as MeasurementChangeCompletedRecord;
  }
  const source = completed ?? change;
  const old = finiteScoreOrNull(source.old_scale_score);
  const newScore = finiteScoreOrNull(source.new_scale_score);
  if (old === null || newScore === null || !isNonEmptyString(source.rescore_ref)) return null;
  return { old_scale_score: old, new_scale_score: newScore, rescore_ref: source.rescore_ref };
}

/** "e2" / "E2" / "2" → 2; otherwise null. */
function parseChangeRef(raw: string): number | null {
  const m = /^e?(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/**
 * Shared justification validation (task 2.1 change, task 2.8 revert): a
 * non-empty string — an existing finding id ("f7") or the reason in words.
 * Appends problems to `errors`; returns the trimmed justification or null.
 */
function validateJustification(workDir: string, raw: unknown, errors: string[]): string | null {
  if (!isNonEmptyString(raw)) {
    errors.push(
      'justification: отсутствует — укажите ссылку на measurement-находку (например "f7") или сформулируйте причину изменения',
    );
    return null;
  }
  const justification = raw.trim();
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
  return justification;
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
  const justification = validateJustification(workDir, input.justification, errors);

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

// ──────────────────────────────────────────────────────────────────
// Verification of a measurement_change (task 2.8; spec measurement-track:
// «Верификация measurement_change» — сценарии «верификация подтвердила» и
// «верификация опровергла»)
// ──────────────────────────────────────────────────────────────────

/**
 * Resolve the change a verification/revert refers to plus the guards shared by
 * both paths: the change exists, carries BOTH scores (in itself or in its
 * measurement_change_completed), and is neither verified nor reverted yet.
 * Appends problems to `errors` (findings.ts style) and returns null when the
 * caller cannot proceed.
 */
function resolveChangeForVerdict(
  workDir: string,
  raw: unknown,
  label: string,
  errors: string[],
): { changeId: string; epoch: number; scores: { old_scale_score: number; new_scale_score: number; rescore_ref: string } } | null {
  if (!isNonEmptyString(raw)) {
    errors.push(`${label}: отсутствует — укажите ссылку на исходное изменение (например "e2")`);
    return null;
  }
  const changeRefRaw = raw.trim();
  const epoch = parseChangeRef(changeRefRaw);
  if (epoch === null) {
    errors.push(`${label}: "${changeRefRaw}" не похож на ссылку на изменение — ожидается id вида "e2" (номер эпохи изменения измерителя)`);
    return null;
  }

  const ledgerText = readLedgerText(workDir);
  const changeId = measurementChangeId(epoch);
  const change = findMeasurementChangeRecord(ledgerText, epoch);
  if (change === null) {
    const known = measurementChangeEpochs(ledgerText);
    errors.push(
      `${label}: изменение ${changeId} не найдено в леджере (` +
        (known.length > 0 ? `зарегистрированы: ${known.map(measurementChangeId).join(", ")}` : "изменений измерителя не зарегистрировано") +
        ")",
    );
    return null;
  }

  const scores = referenceScoresFor(ledgerText, change, changeId);
  if (scores === null) {
    errors.push(
      `${label}: у изменения ${changeId} нет обеих оценок в леджере` +
        (change.rescore_pending === true
          ? " (рескор ещё не завершён — сначала допишите полный артефакт и завершите изменение: log_measurement_change {change_ref, rescore_ref})"
          : "") +
        " — выносить вердикт не о чем",
    );
    return null;
  }

  // Append-only idempotence: each verdict is recorded once.
  if (isChangeVerified(ledgerText, changeId)) {
    errors.push(`${label}: изменение ${changeId} уже подтверждено (measurement_change_verified в леджере) — записи не переписываются`);
  }
  if (isChangeReverted(ledgerText, changeId)) {
    errors.push(`${label}: изменение ${changeId} уже отклонено (measurement_change_reverted в леджере) — опровергнутое изменение не переигрывается`);
  }
  if (errors.length > 0) return null;
  return { changeId, epoch, scores };
}

/**
 * Exact equality of two command lists (same order, same trimmed strings) —
 * the machine check behind «те же команды/входы» (spec: a proof reproduces
 * the rescore artifact, so its commands must BE the artifact's commands).
 */
function commandsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/**
 * Read the change's reference rescore artifact and return its REPRODUCTION
 * contract: the anchor (the fixed input set) and the commands (the rescore
 * commands and their inputs, verbatim) that both a proof and a counter-rescore
 * must reproduce — a verdict with other commands is not a re-run of THIS
 * rescore (task 2.8 review: same numbers under other commands prove nothing).
 * The artifact is the reproducibility source: if it is gone (it must survive
 * in .auto/measurement/), no honest verdict is possible.
 */
function referenceAnchorFor(
  workDir: string,
  rescoreRef: string,
  changeId: string,
  label: string,
  errors: string[],
): { anchor: string; commands: string[] } | null {
  const read = readMeasurementFile(workDir, rescoreRef, label);
  if (!read.ok) {
    errors.push(
      `${label}: исходный рескор-артефакт изменения ${changeId} ("${rescoreRef}") недоступен — вердикт невозможен без источника воспроизведения:`,
      ...read.errors,
    );
    return null;
  }
  const parsed = parseRescoreArtifact(read.value.content);
  if (!parsed.ok) {
    errors.push(`${label}: исходный рескор-артефакт изменения ${changeId} ("${rescoreRef}") не читается:`, ...parsed.errors);
    return null;
  }
  return { anchor: parsed.value.anchor, commands: parsed.value.commands };
}

/**
 * Task 2.8, «верификация подтвердила»: the independent check re-ran the
 * rescore (same commands/inputs, same scores) and records the confirmation.
 * Appends a `measurement_change_verified` record pointing at the original
 * change and the proof file in `.auto/measurement/` (executed commands, their
 * outputs, reproduced scores) — the original records are never rewritten, and
 * the reconstruction lifts needs_verification. The proof's scores are
 * machine-checked against the change's ledger scores: a mismatch is a
 * REFUTATION — the call is rejected with the revert path named instead.
 */
export function verifyMeasurementChange(
  workDir: string,
  input: VerifyMeasurementChangeInput,
  now: Date = new Date(),
): MeasurementResult<MeasurementChangeVerifiedRecord> {
  const errors: string[] = [];

  const resolved = resolveChangeForVerdict(workDir, input.change_ref, "change_ref", errors);

  // ── proof_ref: required, full proof artifact in .auto/measurement/ ──
  let proofRel: string | null = null;
  let proof: ProofArtifact | null = null;
  if (!isNonEmptyString(input.proof_ref)) {
    errors.push(
      'proof_ref: отсутствует — сохраните доказательство верификации (JSON: anchor, commands, outputs, old_scale_score, new_scale_score) в .auto/measurement/ и укажите путь',
    );
  } else {
    const read = readMeasurementFile(workDir, input.proof_ref.trim(), "proof_ref:");
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const parsed = parseProofArtifact(read.value.content);
      if (!parsed.ok) {
        errors.push(`proof_ref: доказательство "${input.proof_ref.trim()}" не годится:`, ...parsed.errors);
      } else {
        proofRel = read.value.rel;
        proof = parsed.value;
      }
    }
  }

  // ── machine check: the proof must reproduce the change's recorded scores ──
  if (resolved !== null && proof !== null) {
    const reference = referenceAnchorFor(workDir, resolved.scores.rescore_ref, resolved.changeId, "proof_ref:", errors);
    if (reference !== null) {
      if (proof.anchor !== reference.anchor) {
        errors.push(
          `proof_ref: якорь доказательства ("${proof.anchor}") не совпадает с якорем рескор-артефакта изменения ${resolved.changeId} ("${reference.anchor}") — подтверждать можно только тот же якорный набор`,
        );
      }
      // Spec: «те же команды/входы дают те же оценки» — same numbers produced
      // by OTHER commands do not reproduce this rescore (task 2.8 review).
      if (!commandsEqual(proof.commands, reference.commands)) {
        errors.push(
          `proof_ref: команды доказательства не совпадают с командами рескор-артефакта изменения ${resolved.changeId} — подтверждение — воспроизведение ТЕМИ ЖЕ командами/входами ` +
            `(в артефакте изменения: ${reference.commands.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
    if (
      proof.old_scale_score !== undefined && proof.new_scale_score !== undefined &&
      (proof.old_scale_score !== resolved.scores.old_scale_score || proof.new_scale_score !== resolved.scores.new_scale_score)
    ) {
      errors.push(
        `proof_ref: оценки доказательства (${proof.old_scale_score} → ${proof.new_scale_score}) не воспроизвели оценки изменения ${resolved.changeId} ` +
          `(${resolved.scores.old_scale_score} → ${resolved.scores.new_scale_score}) — это ОПРОВЕРЖЕНИЕ: сохраните контр-рескор в .auto/measurement/ и вызовите отклонение изменения, а не подтверждение`,
      );
    }
  }

  if (errors.length > 0 || resolved === null || proofRel === null || proof === null) {
    return { ok: false, errors };
  }

  const record: MeasurementChangeVerifiedRecord = {
    type: "measurement_change_verified",
    change_ref: resolved.changeId,
    epoch: resolved.epoch,
    proof_ref: proofRel,
    timestamp: now.toISOString(),
  };
  const writeError = appendLedgerRecord(workDir, record);
  if (writeError !== null) return { ok: false, errors: [writeError] };
  return { ok: true, value: record };
}

/**
 * Task 2.8, «верификация опровергла»: the re-run of the rescore yields
 * DIFFERENT scores — the change is refuted. Appends the compensating
 * `measurement_change_reverted` record with the counter-rescore artifact and
 * the reason; original records are never rewritten. The active scale is
 * restored to the last confirmed epoch by the fold, the rejected epoch's runs
 * become incomparable (cross-epoch), and the rejected epoch id is never
 * reused (the next change opens counter + 1). Only the LATEST change can be
 * reverted: an older change is already superseded by the scale that moved on.
 *
 * KNOWN LIMITATION (task 2.8 review M4): the spec line «нарушение
 * фиксируется в отчёте» has no dedicated report surface — the refutation is
 * fixed in the ledger (`measurement_change_reverted` + counter-rescore ref)
 * and surfaces through `formatMeasurementScale` («опровергнуто», rendered in
 * the dashboard line, the tool responses and the final report's scale line).
 * A dedicated report section is future work, not a 2.8 regression.
 */
export function revertMeasurementChange(
  workDir: string,
  input: RevertMeasurementChangeInput,
  now: Date = new Date(),
): MeasurementResult<MeasurementChangeRevertedRecord> {
  const errors: string[] = [];

  const resolved = resolveChangeForVerdict(workDir, input.change_ref, "change_ref", errors);

  // Only the latest change is the active scale's subject.
  if (resolved !== null) {
    const latest = measurementChangeEpochs(readLedgerText(workDir)).at(-1) ?? null;
    if (latest !== null && latest !== resolved.epoch) {
      errors.push(
        `change_ref: изменение ${resolved.changeId} не последнее (последнее: ${measurementChangeId(latest)}) — отклонить можно только актуальное изменение шкалы`,
      );
    }
  }

  // ── counter-rescore: required, full artifact with DIFFERENT scores ──
  let counterRel: string | null = null;
  let counter: RescoreArtifact | null = null;
  if (!isNonEmptyString(input.rescore_ref)) {
    errors.push(
      'rescore_ref: отсутствует — опровержение требует контр-рескор: воспроизведите рескор того же якорного набора и сохраните артефакт (JSON: anchor, commands, old_scale_score, new_scale_score) в .auto/measurement/',
    );
  } else {
    const read = readMeasurementFile(workDir, input.rescore_ref.trim(), "rescore_ref:");
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const parsed = parseRescoreArtifact(read.value.content);
      if (!parsed.ok) {
        errors.push(`rescore_ref: контр-рескор "${input.rescore_ref.trim()}" не годится:`, ...parsed.errors);
      } else if (parsed.value.old_scale_score === undefined || parsed.value.new_scale_score === undefined) {
        errors.push(
          `rescore_ref: контр-рескор "${input.rescore_ref.trim()}" неполный — опровержение требует обе оценки (old_scale_score и new_scale_score), которые не совпали с оценками изменения`,
        );
      } else {
        counterRel = read.value.rel;
        counter = parsed.value;
      }
    }
  }

  // ── machine check: same anchor set and commands, scores that actually differ ──
  if (resolved !== null && counter !== null && counter.old_scale_score !== undefined && counter.new_scale_score !== undefined) {
    const reference = referenceAnchorFor(workDir, resolved.scores.rescore_ref, resolved.changeId, "rescore_ref:", errors);
    if (reference !== null) {
      if (counter.anchor !== reference.anchor) {
        errors.push(
          `rescore_ref: якорь контр-рескора ("${counter.anchor}") не совпадает с якорем рескор-артефакта изменения ${resolved.changeId} ("${reference.anchor}") — опровергать можно только тот же якорный набор`,
        );
      }
      // The counter-rescore is a RE-RUN of the same rescore (spec: «повторное
      // воспроизведение рескора даёт иные оценки») — other commands would
      // measure a different procedure, not refute this one (task 2.8 review).
      if (!commandsEqual(counter.commands, reference.commands)) {
        errors.push(
          `rescore_ref: команды контр-рескора не совпадают с командами рескор-артефакта изменения ${resolved.changeId} — опровержение — повторное воспроизведение ТЕМИ ЖЕ командами/входами ` +
            `(в артефакте изменения: ${reference.commands.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    }
    if (counter.old_scale_score === resolved.scores.old_scale_score && counter.new_scale_score === resolved.scores.new_scale_score) {
      errors.push(
        `rescore_ref: контр-рескор воспроизвёл те же оценки (${resolved.scores.old_scale_score} → ${resolved.scores.new_scale_score}) — опровержения нет; ` +
          "вызовите подтверждение изменения (verify) с файлом доказательства",
      );
    }
  }

  const justification = validateJustification(workDir, input.justification, errors);

  if (errors.length > 0 || resolved === null || counterRel === null || counter === null || justification === null) {
    return { ok: false, errors };
  }

  const record: MeasurementChangeRevertedRecord = {
    type: "measurement_change_reverted",
    change_ref: resolved.changeId,
    epoch: resolved.epoch,
    rescore_ref: counterRel,
    justification,
    timestamp: now.toISOString(),
  };
  const writeError = appendLedgerRecord(workDir, record);
  if (writeError !== null) return { ok: false, errors: [writeError] };
  return { ok: true, value: record };
}
