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
 * Minimal skeleton (phase-1 scope): the summary folds the ledger text and the
 * findings store, nothing more. There is no tool here yet — phase 2
 * (measurement track, tasks 2.1–2.8: `log_measurement_change`, rescore
 * artifacts, floor re-evaluation, cross-epoch blocking) extends THIS module;
 * the four-field contract above stays.
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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlEntry } from "./jsonl.ts";
import { DEFAULT_EPOCH } from "./lens-extractors.ts";
import { loadFindings, type FindingView, type FindingsState } from "./findings.ts";

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
  /** Current scale epoch (DEFAULT_EPOCH when no entry carries an epoch). */
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
 * Fold ledger text into measurement-track facts. Every non-empty line is
 * parsed leniently (malformed lines are skipped); any entry carrying a valid
 * `epoch` (integer >= 1) counts toward the current epoch, matching the
 * task-2.2 contract «записи без epoch = эпоха 1».
 */
export function measurementLedgerFacts(ledgerText: string): MeasurementLedgerFacts {
  let epoch: number = DEFAULT_EPOCH;
  let changeCount = 0;
  for (const line of ledgerText.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseJsonlEntry(line);
    if (!entry) continue;
    if (typeof entry.epoch === "number" && Number.isSafeInteger(entry.epoch) && entry.epoch >= 1) {
      epoch = Math.max(epoch, entry.epoch);
    }
    if (entry.type === "measurement_change") changeCount++;
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
