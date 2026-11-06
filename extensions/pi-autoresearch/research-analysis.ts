/**
 * Analysis journal for research-map (openspec/changes/research-map/design.md §6.1, §6.2, §6.4,
 * §7.4, §9.1–§9.5, §10.0–§10.3, §10.2a, §12.3a–§12.3b; decisions D-RM-14 through D-RM-17,
 * D-RM-20, D-RM-21).
 *
 * `.auto/analysis.jsonl` is an append-only JSONL journal with `record: "analysis"` and
 * `kind` ∈ {prereg, comparison, attribution, supplement}. The ONLY writer is the record-shaped
 * `recordAnalysis` execute() below, running under the dedicated `.auto/analysis.lock`
 * (research-journal.ts conventions: exclusive wx lock, token-checked release, bounded retries
 * 1 + 40×50 ms, no auto-takeover, newline guard, single writeSync, fsync before close).
 *
 * This module never writes `log.jsonl`, `observations.jsonl`, `run-links.jsonl`, findings or
 * the measurement ledger (D-RM-14); it never calls git and never runs experiments (I-13, I-14).
 *
 * Computed at read time (never stored): `prereg_status`, `run_link_*`, `epoch_check`,
 * `control`, `control_basis`, `delta_allowed`, causal `status`, `exhaustion_levels`.
 * Snapshots stored on records are labelled as such (`*_at_record`, `prereg_status_at_write`).
 *
 * Exposed for the sibling hint engine (§12.3a) without computing hints:
 * - budgets: ANALYSIS_REF_BUDGET_PER_CALL (20), ANALYSIS_KEY_ELEMENT_LIMIT (200),
 *   CAMPAIGN_KEY_LIMIT (16) + selectCampaignKeys (deterministic first-16 global keys).
 * - prefix snapshot helper for the run-links writer (§9.3/§5.2): analysisPrefixSnapshot().
 * - read-time §9.3 ordering (D-RM-15, T69–T72): classifyPreregOrder(prereg, run, …) →
 *   pre_registered / post_hoc / unknown with order_basis and a named order_reason.
 * - read-time §9.3 «Оценка ветвей»: evaluateBranches(prereg, runFacts, model, status);
 *   exhaustion_levels themselves belong to §12.3a (sibling engine) and are not produced here.
 *
 * This tool is NOT registered in index.ts by this module.
 */

import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlEntry } from "./jsonl.ts";
import {
  JOURNAL_RECORD_MAX_BYTES,
  journalTarget,
  withJournalLock,
  type JournalFs,
  type JournalOptions,
} from "./research-journal.ts";
import {
  classifyRunLink,
  isRunNumber,
  loadRunLinksState,
  RUN_EPOCH_BASES,
  RUN_LINK_STATES,
  type RunLinksScan,
} from "./run-links.ts";
import { normalizePassport, type PassportInput, type PassportRecord } from "./research-observations.ts";

// ---------------------------------------------------------------------------
// Constants (§7.4, §9.1, §9.3, §9.5, §10.2a, §10.3, §12.3a)
// ---------------------------------------------------------------------------

export const ANALYSIS_FILE_VERSION = 1;
export const ANALYSIS_RECORD_TYPE = "analysis";
export const ANALYSIS_KINDS = ["prereg", "comparison", "attribution", "supplement"] as const;
export const ANALYSIS_PURPOSES = [
  "champion_recheck",
  "component_attribution",
  "measurement_check",
  "exploration",
  "other",
] as const;
export const CONTROL_STATES = ["controlled", "uncontrolled", "unknown"] as const;
export const CONTROL_BASES = [
  "epoch_change",
  "not_declared",
  "declared_none_changed",
  "declared_one_changed",
  "declared_multiple_changed",
  "declared_absent",
] as const;
export const CONTROL_SOURCES = ["comparison", "post_hoc_supplement", "none"] as const;
export const EPOCH_CHECKS = ["same", "differs", "unproven"] as const;
export const METRIC_CONTEXT_CHECKS = ["same", "unknown"] as const;
/** §9.3 prereg ordering verdicts (D-RM-15): computed at read time, never stored. */
export const PREREG_STATUSES = ["pre_registered", "post_hoc", "unknown"] as const;
export type PreregStatus = (typeof PREREG_STATUSES)[number];
export const PREREG_ORDER_BASIS = "locked_analysis_prefix_and_ledger_offset (local files, not tamper-proof)" as const;
export const SUPPLEMENT_FIELDS = ["changed_components", "purpose_text", "noise_band", "noise_basis_ref", "subjects"] as const;
export const SUPPLEMENT_REASONS = ["not_available", "not_measured", "owner_declined"] as const;
/** Effective control display for a comparison whose declared field was supplemented with `absent` (§9.5 rule 4). */
export function controlOfAbsentDeclaration(): { control: (typeof CONTROL_STATES)[number]; control_basis: (typeof CONTROL_BASES)[number] } {
  return { control: "unknown", control_basis: "declared_absent" };
}
/** v1 output completeness is unproven (E-23): this status is the ceiling for attributions. */
export const ATTRIBUTION_STATUS_V1 = ["unknown", "unverifiable"] as const;
export const ATTRIBUTION_UNREACHABLE_STATUSES = ["evidence_bound"] as const;

/** §10.3 budgets. */
export const ANALYSIS_REF_BUDGET_PER_CALL = 20;
export const ANALYSIS_MAX_EVIDENCE_REFS = 8;
export const ANALYSIS_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const ANALYSIS_KEY_ELEMENT_LIMIT = 200;
export const CAMPAIGN_KEY_LIMIT = 16;
/** Same shape as the §5.3 provenance tolerance (§10.2 step 10 (е)). */
export const METRIC_TOLERANCE_RELATIVE = 0.005;

const DESCRIPTION_MAX_CHARS = 500;
const PURPOSE_TEXT_MAX_CHARS = 200;
const MEANING_MAX_CHARS = 200;
const CLAIM_MAX_CHARS = 300;
const ANCHOR_MAX_CHARS = 200;
const NOTE_MAX_CHARS = 200;
const CHANGED_COMPONENTS_LIMIT = 16;
const SUBJECTS_LIMIT = 2;
const BRANCHES_LIMIT = 8;
const RUN_NUMBER_MAX = 1_000_000_000;

const COMPONENT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const AXIS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const METRIC_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HYPOTHESIS_ID_RE = /^n[0-9]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const ANALYSIS_ID_RE = /^(pre|cmp|clm|sup)-[0-9a-z]+-[0-9a-f]{8}$/;
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_LINE_PREFIX = "METRIC";

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorCodeOf(error: unknown): string | null {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical JSON: sorted keys, undefined dropped. Used for `content_sha256` (§6.4). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Free-text length in code points (§8.5 style limits). */
function charLength(text: string): number {
  return [...text].length;
}

function stringField(value: unknown, maxChars: number): string | null {
  return typeof value === "string" && charLength(value) >= 1 && charLength(value) <= maxChars ? value : null;
}

function validComponents(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > CHANGED_COMPONENTS_LIMIT) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !COMPONENT_NAME_RE.test(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return value as string[];
}

function validSubjects(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > SUBJECTS_LIMIT) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !COMPONENT_NAME_RE.test(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return value as string[];
}

function validRefArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max;
}

// ---------------------------------------------------------------------------
// Passport normalization (§8.2; reuse of research-observations.ts)
// ---------------------------------------------------------------------------

/** Validated-at-input passport: shape only (§7.4 additionalProperties: false per kind). */
function normalizePassportInput(raw: unknown): PassportRecord | null {
  if (raw === undefined) return null;
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== "components")) return null;
  if (!isPlainObject(raw.components)) return null;
  const components = raw.components;
  const names = Object.keys(components);
  if (names.length > CHANGED_COMPONENTS_LIMIT) return null;
  for (const name of names) {
    if (!COMPONENT_NAME_RE.test(name)) return null;
    const component = components[name];
    if (!isPlainObject(component) || Object.keys(component).some((key) => key !== "ref" && key !== "declared_sha256")) {
      return null;
    }
    const ref = component.ref;
    if (ref !== undefined && ref !== null && typeof ref !== "string") return null;
    const sha = component.declared_sha256;
    if (sha !== undefined && sha !== null && !(typeof sha === "string" && /^[0-9a-fA-F]{64}$/.test(sha))) return null;
  }
  // research-observations.ts §8.2 normalization: declared/unknown classification with
  // note codes; no file is ever opened (I-12/D-RM-11).
  return normalizePassport(raw as PassportInput);
}

// ---------------------------------------------------------------------------
// Evidence references (§10.3) — typed refs; no paths from input (D-RM-21, I-17)
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  run: number;
  artifact: "output" | "manifest";
  lines: [number, number] | null;
  anchor: string | null;
}

export type EvidenceRefCheck =
  | { ok: true; ref: EvidenceRef }
  | { ok: false; reason: string };

/**
 * Form check only: the file is NOT opened here. `evidence_refs` (value-bearing) accepts only
 * `lines: null` and `anchor: null`; `noise_basis_ref` (documentary) may carry `lines: [a, b]`
 * and a plain-substring `anchor`.
 */
export function checkEvidenceRefForm(value: unknown, role: "evidence" | "noise"): EvidenceRefCheck {
  if (!isPlainObject(value)) return { ok: false, reason: "ref_not_object" };
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "run" && key !== "artifact" && key !== "lines" && key !== "anchor")) {
    return { ok: false, reason: "unknown_ref_field" };
  }
  if (!("run" in value) || !("artifact" in value) || !("lines" in value) || !("anchor" in value)) {
    return { ok: false, reason: "missing_ref_field" };
  }
  if (!isIntegerInRange(value.run, 1, RUN_NUMBER_MAX)) return { ok: false, reason: "invalid_run" };
  if (value.artifact !== "output" && value.artifact !== "manifest") return { ok: false, reason: "invalid_artifact" };
  const { lines, anchor } = value;
  if (role === "evidence") {
    if (lines !== null) return { ok: false, reason: "lines_must_be_null" };
    if (anchor !== null) return { ok: false, reason: "anchor_must_be_null" };
  } else {
    if (value.artifact === "manifest") {
      if (lines !== null || anchor !== null) return { ok: false, reason: "manifest_ref_needs_nulls" };
    } else if (!(lines === null || (Array.isArray(lines) && lines.length === 2 && isIntegerInRange(lines[0], 1, 1_000_000) && isIntegerInRange(lines[1], 1, 1_000_000) && lines[0] <= lines[1]))) {
      return { ok: false, reason: "invalid_lines" };
    }
    if (
      anchor !== null &&
      !(typeof anchor === "string" && anchor.length > 0 && charLength(anchor) <= ANCHOR_MAX_CHARS && !CONTROL_CHARS_RE.test(anchor))
    ) {
      return { ok: false, reason: "invalid_anchor" };
    }
  }
  return {
    ok: true,
    ref: { run: value.run, artifact: value.artifact, lines: lines === null ? null : [lines[0], lines[1]], anchor: anchor === null ? null : anchor },
  };
}

function validNoiseBasisRef(value: unknown): { ok: true; ref: EvidenceRef } | { ok: false; reason: string } {
  const checked = checkEvidenceRefForm(value, "noise");
  return checked.ok ? { ok: true, ref: checked.ref } : { ok: false, reason: checked.reason };
}

// ---------------------------------------------------------------------------
// Kind-specific input validation (§9.1, §9.3, §9.5, §10.1)
// ---------------------------------------------------------------------------

export interface PreregBranch {
  name: string;
  metric_name: string;
  op: "<" | "<=" | ">" | ">=";
  threshold: number;
  meaning: string;
}

const BRANCH_OPS = ["<", "<=", ">", ">="] as const;

export interface PreregParams {
  axis?: string;
  hypothesis_id?: string;
  branches: PreregBranch[];
  noise_band?: number;
  noise_basis_ref?: EvidenceRef;
  exhaustion_rule?: {
    metric_name: string;
    direction: "lower" | "higher";
    threshold_gain: number;
    k: number;
  };
}

export interface ComparisonParams {
  purpose: (typeof ANALYSIS_PURPOSES)[number];
  purpose_text?: string;
  baseline_run: number;
  candidate_run: number;
  metric_name?: string;
  changed_components?: string[];
  noise_band?: number;
  noise_basis_ref?: EvidenceRef;
  prereg_id?: string;
  axis?: string;
  review_requested?: boolean;
}

export interface AttributionParams {
  claim: string;
  subjects?: string[];
  comparison_id?: string;
  evidence_refs: EvidenceRef[];
}

export interface SupplementParams {
  target_id: string;
  field: (typeof SUPPLEMENT_FIELDS)[number];
  value?: unknown;
  absent?: { reason: (typeof SUPPLEMENT_REASONS)[number]; note?: string };
}

export type AnalysisParams = {
  kind: (typeof ANALYSIS_KINDS)[number];
} & (PreregParams | ComparisonParams | AttributionParams | SupplementParams) & {
    passport?: PassportInput;
  };

export type ParseAnalysisParamsOutcome =
  | { ok: true; kind: (typeof ANALYSIS_KINDS)[number]; params: Record<string, unknown> }
  | { ok: false; code: string; message: string };

function failInput(message: string): ParseAnalysisParamsOutcome {
  return { ok: false, code: "invalid_input", message };
}

/** Per-kind allowed input keys (§7.4 additionalProperties: false in each branch). */
const KIND_KEYS: Record<(typeof ANALYSIS_KINDS)[number], ReadonlySet<string>> = {
  prereg: new Set(["axis", "hypothesis_id", "branches", "noise_band", "noise_basis_ref", "exhaustion_rule", "passport"]),
  comparison: new Set([
    "purpose",
    "purpose_text",
    "baseline_run",
    "candidate_run",
    "metric_name",
    "changed_components",
    "noise_band",
    "noise_basis_ref",
    "prereg_id",
    "axis",
    "review_requested",
  ]),
  attribution: new Set(["claim", "subjects", "comparison_id", "evidence_refs"]),
  supplement: new Set(["target_id", "field", "value", "absent"]),
};

const SUPPLEMENT_FIELD_TARGETS: Record<(typeof SUPPLEMENT_FIELDS)[number], readonly (typeof ANALYSIS_KINDS)[number][]> = {
  changed_components: ["comparison"],
  purpose_text: ["comparison"],
  noise_band: ["comparison", "prereg"],
  noise_basis_ref: ["comparison", "prereg"],
  subjects: ["attribution"],
};

function optionalFiniteNonNegative(value: unknown, label: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!isFiniteNumber(value) || value < 0) return { ok: false, message: `${label} must be a number >= 0` };
  return { ok: true, value };
}

function optionalName(value: unknown, re: RegExp, label: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !re.test(value)) return { ok: false, message: `invalid ${label}` };
  return { ok: true, value };
}

function validatePrereg(raw: JsonObject): { ok: true; params: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const params: Record<string, unknown> = {};

  for (const optional of ["axis", "hypothesis_id"] as const) {
    const checked = optionalName(raw[optional], optional === "axis" ? AXIS_RE : HYPOTHESIS_ID_RE, optional);
    if (!checked.ok) return failInput(checked.message);
    if (checked.value !== undefined) params[optional] = checked.value;
  }

  const branchesRaw = raw.branches;
  if (!Array.isArray(branchesRaw) || branchesRaw.length < 1 || branchesRaw.length > BRANCHES_LIMIT) {
    return failInput(`branches must be an array of 1 to ${BRANCHES_LIMIT} entries`);
  }
  const seen = new Set<string>();
  const branches: PreregBranch[] = [];
  for (const branch of branchesRaw) {
    if (!isPlainObject(branch)) return failInput("each branch must be an object");
    if (Object.keys(branch).some((key) => key !== "name" && key !== "metric_name" && key !== "op" && key !== "threshold" && key !== "meaning")) {
      return failInput("branch holds unknown fields");
    }
    if (typeof branch.name !== "string" || !COMPONENT_NAME_RE.test(branch.name) || seen.has(branch.name)) {
      return failInput("branch.name must be unique and match ^[a-z][a-z0-9_]{0,31}$");
    }
    seen.add(branch.name);
    if (typeof branch.metric_name !== "string" || !METRIC_NAME_RE.test(branch.metric_name)) {
      return failInput("branch.metric_name must match ^[A-Za-z][A-Za-z0-9_]{0,63}$");
    }
    if (!oneOf(BRANCH_OPS, branch.op)) return failInput("branch.op must be one of <, <=, >, >=");
    if (!isFiniteNumber(branch.threshold)) return failInput("branch.threshold must be a finite number");
    const meaning = stringField(branch.meaning, MEANING_MAX_CHARS);
    if (meaning === null) return failInput(`branch.meaning must be a string of 1 to ${MEANING_MAX_CHARS} characters`);
    branches.push({ name: branch.name, metric_name: branch.metric_name, op: branch.op, threshold: branch.threshold, meaning });
  }
  params.branches = branches;

  const noise = optionalFiniteNonNegative(raw.noise_band, "noise_band");
  if (!noise.ok) return failInput(noise.message);
  if (noise.value !== undefined) params.noise_band = noise.value;

  if (raw.noise_basis_ref !== undefined) {
    const ref = validNoiseBasisRef(raw.noise_basis_ref);
    if (!ref.ok) return failInput(`noise_basis_ref: ${ref.reason}`);
    params.noise_basis_ref = ref.ref;
  }

  if (raw.exhaustion_rule !== undefined) {
    const rule = raw.exhaustion_rule;
    if (!isPlainObject(rule)) return failInput("exhaustion_rule must be an object");
    if (Object.keys(rule).some((key) => key !== "metric_name" && key !== "direction" && key !== "threshold_gain" && key !== "k")) {
      return failInput("exhaustion_rule holds unknown fields");
    }
    if (typeof rule.metric_name !== "string" || !METRIC_NAME_RE.test(rule.metric_name)) {
      return failInput("exhaustion_rule.metric_name must match ^[A-Za-z][A-Za-z0-9_]{0,63}$");
    }
    if (rule.direction !== "lower" && rule.direction !== "higher") {
      return failInput('exhaustion_rule.direction must be "lower" or "higher"');
    }
    if (!isFiniteNumber(rule.threshold_gain) || rule.threshold_gain <= 0) {
      return failInput("exhaustion_rule.threshold_gain must be a number > 0");
    }
    const k = rule.k === undefined ? 3 : rule.k;
    if (!isIntegerInRange(k, 2, 10)) return failInput("exhaustion_rule.k must be an integer from 2 to 10");
    params.exhaustion_rule = { metric_name: rule.metric_name, direction: rule.direction, threshold_gain: rule.threshold_gain, k };
  }

  return { ok: true, params };
}

function validateComparison(raw: JsonObject): { ok: true; params: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const params: Record<string, unknown> = {};

  if (!oneOf(ANALYSIS_PURPOSES, raw.purpose)) return failInput(`purpose must be one of ${ANALYSIS_PURPOSES.join(", ")}`);
  params.purpose = raw.purpose;

  if (raw.purpose_text !== undefined) {
    if (raw.purpose !== "other") return failInput("purpose_text is allowed only when purpose is other");
    const text = stringField(raw.purpose_text, PURPOSE_TEXT_MAX_CHARS);
    if (text === null) return failInput(`purpose_text must be a string of 1 to ${PURPOSE_TEXT_MAX_CHARS} characters`);
    params.purpose_text = text;
  } else if (raw.purpose === "other") {
    return failInput("purpose_text is required when purpose is other");
  }

  if (!isIntegerInRange(raw.baseline_run, 1, RUN_NUMBER_MAX)) return failInput("baseline_run must be an integer from 1 to 1000000000");
  if (!isIntegerInRange(raw.candidate_run, 1, RUN_NUMBER_MAX)) return failInput("candidate_run must be an integer from 1 to 1000000000");
  if (raw.baseline_run === raw.candidate_run) return failInput("baseline_run and candidate_run must differ");
  params.baseline_run = raw.baseline_run;
  params.candidate_run = raw.candidate_run;

  if (raw.metric_name !== undefined) {
    if (typeof raw.metric_name !== "string" || !METRIC_NAME_RE.test(raw.metric_name)) {
      return failInput("metric_name must match ^[A-Za-z][A-Za-z0-9_]{0,63}$");
    }
    params.metric_name = raw.metric_name;
  }

  if (raw.changed_components !== undefined) {
    const components = validComponents(raw.changed_components);
    if (components === null) {
      return failInput(`changed_components must be an array of up to ${CHANGED_COMPONENTS_LIMIT} unique component names`);
    }
    params.changed_components = components;
  }

  const noise = optionalFiniteNonNegative(raw.noise_band, "noise_band");
  if (!noise.ok) return failInput(noise.message);
  if (noise.value !== undefined) params.noise_band = noise.value;

  if (raw.noise_basis_ref !== undefined) {
    const ref = validNoiseBasisRef(raw.noise_basis_ref);
    if (!ref.ok) return failInput(`noise_basis_ref: ${ref.reason}`);
    params.noise_basis_ref = ref.ref;
  }

  if (raw.prereg_id !== undefined) {
    if (typeof raw.prereg_id !== "string" || !ANALYSIS_ID_RE.test(raw.prereg_id) || !raw.prereg_id.startsWith("pre-")) {
      return failInput("prereg_id must be an id of a prereg record");
    }
    params.prereg_id = raw.prereg_id;
  }

  const axis = optionalName(raw.axis, AXIS_RE, "axis");
  if (!axis.ok) return failInput(axis.message);
  if (axis.value !== undefined) params.axis = axis.value;

  if (raw.review_requested !== undefined) {
    if (raw.review_requested !== true && raw.review_requested !== false) return failInput("review_requested must be a boolean");
    if (raw.review_requested === true && params.axis === undefined) {
      return failInput("review_requested: true requires axis (§12.3b)");
    }
    params.review_requested = raw.review_requested;
  }

  return { ok: true, params };
}

function validateAttribution(raw: JsonObject): { ok: true; params: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const params: Record<string, unknown> = {};

  const claim = stringField(raw.claim, CLAIM_MAX_CHARS);
  if (claim === null) return failInput(`claim must be a string of 1 to ${CLAIM_MAX_CHARS} characters`);
  params.claim = claim;

  if (raw.subjects !== undefined) {
    const subjects = validSubjects(raw.subjects);
    if (subjects === null) return failInput(`subjects must be an array of 1 to ${SUBJECTS_LIMIT} unique component names`);
    params.subjects = subjects;
  }

  if (raw.comparison_id !== undefined) {
    if (typeof raw.comparison_id !== "string" || !ANALYSIS_ID_RE.test(raw.comparison_id) || !raw.comparison_id.startsWith("cmp-")) {
      return failInput("comparison_id must be an id of a comparison record");
    }
    params.comparison_id = raw.comparison_id;
  }

  if (raw.evidence_refs === undefined) {
    params.evidence_refs = [];
  } else {
    if (!validRefArray(raw.evidence_refs, ANALYSIS_MAX_EVIDENCE_REFS)) {
      return failInput(`evidence_refs must be an array of up to ${ANALYSIS_MAX_EVIDENCE_REFS} typed references`);
    }
    const refs: EvidenceRef[] = [];
    for (const item of raw.evidence_refs) {
      const checked = checkEvidenceRefForm(item, "evidence");
      if (!checked.ok) return { ok: false, code: "invalid_evidence", message: `evidence_refs: ${checked.reason}` };
      refs.push(checked.ref);
    }
    params.evidence_refs = refs;
  }

  return { ok: true, params };
}

function validateSupplement(raw: JsonObject): { ok: true; params: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const params: Record<string, unknown> = {};

  if (typeof raw.target_id !== "string" || !ANALYSIS_ID_RE.test(raw.target_id)) {
    return failInput("target_id must be an analysis record id");
  }
  params.target_id = raw.target_id;

  if (!oneOf(SUPPLEMENT_FIELDS, raw.field)) {
    return failInput(`field must be one of ${SUPPLEMENT_FIELDS.join(", ")}`);
  }
  params.field = raw.field;

  const hasValue = raw.value !== undefined;
  const hasAbsent = raw.absent !== undefined;
  if (hasValue === hasAbsent) {
    return failInput("exactly one of value or absent is required");
  }
  if (hasAbsent) {
    const absent = raw.absent;
    if (!isPlainObject(absent)) return failInput("absent must be an object");
    if (Object.keys(absent).some((key) => key !== "reason" && key !== "note")) return failInput("absent holds unknown fields");
    if (!oneOf(SUPPLEMENT_REASONS, absent.reason)) {
      return failInput(`absent.reason must be one of ${SUPPLEMENT_REASONS.join(", ")}`);
    }
    params.absent = absent.note === undefined ? { reason: absent.reason } : { reason: absent.reason, note: absent.note };
    if (absent.note !== undefined && stringField(absent.note, NOTE_MAX_CHARS) === null) {
      return failInput(`absent.note must be a string of 1 to ${NOTE_MAX_CHARS} characters`);
    }
  } else {
    // §9.5: the value must match the field's declared type BEFORE any lock or append;
    // an invalid value is rejected with a named code and nothing is written (fail-closed,
    // so a bad supplement can never permanently block a valid one via supplement_conflict).
    const field = raw.field as (typeof SUPPLEMENT_FIELDS)[number];
    const value = raw.value;
    let invalid: string | null = null;
    if (field === "changed_components") {
      if (validComponents(value) === null) invalid = "invalid changed_components: array of up to " + CHANGED_COMPONENTS_LIMIT + " unique component names required";
    } else if (field === "subjects") {
      if (validSubjects(value) === null) invalid = "invalid subjects: array of 1 to " + SUBJECTS_LIMIT + " unique component names required";
    } else if (field === "noise_band") {
      if (!isFiniteNumber(value) || value < 0) invalid = "invalid noise_band: a finite number >= 0 is required";
    } else if (field === "purpose_text") {
      if (stringField(value, PURPOSE_TEXT_MAX_CHARS) === null) invalid = "invalid purpose_text: a string of 1 to " + PURPOSE_TEXT_MAX_CHARS + " characters is required";
    } else if (field === "noise_basis_ref") {
      const ref = validNoiseBasisRef(value);
      if (!ref.ok) invalid = `invalid noise_basis_ref: ${ref.reason}`;
    }
    if (invalid !== null) return failInput(invalid);
    params.value = value;
  }

  return { ok: true, params };
}

/**
 * Validate the raw record_analysis input (§7.4). Unknown fields, bad shapes and wrong
 * supplement field/target combinations are rejected before any lock is taken.
 */
export function parseAnalysisParams(raw: unknown): ParseAnalysisParamsOutcome {
  if (!isPlainObject(raw)) return failInput("parameters must be an object");
  const kind = raw.kind;
  if (!oneOf(ANALYSIS_KINDS, kind)) return failInput(`kind must be one of ${ANALYSIS_KINDS.join(", ")}`);

  const allowed = KIND_KEYS[kind];
  const body: JsonObject = {};
  for (const key of Object.keys(raw)) {
    if (key === "kind") continue;
    if (key === "passport") {
      // Passport is accepted on every kind (§8.1: snapshot of the state passport).
      body.passport = raw.passport;
      continue;
    }
    if (!allowed.has(key)) return failInput(`unknown field "${key}" for kind "${kind}"`);
    body[key] = raw[key];
  }

  let inner: { ok: true; params: Record<string, unknown> } | { ok: false; code: string; message: string };
  if (kind === "prereg") inner = validatePrereg(body);
  else if (kind === "comparison") inner = validateComparison(body);
  else if (kind === "attribution") inner = validateAttribution(body);
  else inner = validateSupplement(body);
  if (!inner.ok) return inner;

  if (body.passport !== undefined) {
    const passport = normalizePassportInput(body.passport);
    if (passport === null) return failInput("passport is malformed; see log_observation passport rules (§8.2)");
    inner.params.passport = passport;
  }

  if (kind === "supplement") {
    // Field/target compatibility is checked here against the declared target kind prefix
    // (§9.5); the target's actual kind is re-checked under the lock from the journal.
    const targetKind = (inner.params.target_id as string).split("-")[0];
    const targetKindByName: Record<string, (typeof ANALYSIS_KINDS)[number]> = { pre: "prereg", cmp: "comparison", clm: "attribution", sup: "supplement" };
    const target = targetKindByName[targetKind];
    const targets = SUPPLEMENT_FIELD_TARGETS[inner.params.field as (typeof SUPPLEMENT_FIELDS)[number]];
    if (target === undefined || !targets.includes(target)) {
      return failInput(`field "${inner.params.field as string}" is not applicable to this target kind`);
    }
  }

  return { ok: true, kind, params: inner.params };
}

// ---------------------------------------------------------------------------
// Prefix snapshots (§9.3). Read-only helpers; the run-links write belongs to the writer.
// ---------------------------------------------------------------------------

export type PrefixSnapshot =
  | { state: "ok"; bytes: number; sha256: string }
  | { state: "torn_tail" }
  | { state: "missing" }
  | { state: "unavailable"; message: string };

/**
 * Byte prefix of a journal file up to and including its last LF: the number of bytes up to the
 * last `\n` (0 for an empty or missing file) and sha256 of exactly those bytes. A torn tail
 * after the last LF does not extend the prefix, but the caller decides what that means:
 * `state: "torn_tail"` is reported for `log.jsonl` prereg snapshots (§9.3 rejects the write
 * with `ledger_torn_tail`), while analysis snapshots accept a torn tail (the prefix still
 * has a defined boundary). Missing file: `{ state: "missing" }` — the boundary is defined
 * (0 bytes) and the write is allowed.
 */
export function journalPrefixSnapshot(file: string, ops: JournalFs): PrefixSnapshot {
  let size: number;
  let fd: number;
  try {
    fd = ops.openSync(file, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { state: "missing" };
    return { state: "unavailable", message: `cannot open ${file}: ${describeError(error)}` };
  }
  try {
    size = ops.fstatSync(fd).size;
    const complete = lastLfPosition(fd, size, ops, file);
    if (complete.state === "error") return { state: "unavailable", message: complete.message };
    const bytes = complete.position;
    const data = readBytes(fd, bytes, ops);
    if (data === null) return { state: "unavailable", message: `cannot read ${file}` };
    return { state: "ok", bytes, sha256: sha256Buffer(data) };
  } finally {
    try {
      ops.closeSync(fd);
    } catch {
      /* ignored: snapshot only */
    }
  }
}

function lastLfPosition(fd: number, size: number, ops: JournalFs, file: string): { state: "ok"; position: number } | { state: "error"; message: string } {
  if (size === 0) return { state: "ok", position: 0 };
  // Scan backwards in 4 KiB blocks for the last 0x0A byte.
  const block = 4096;
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - block);
    const data = readBytes(fd, end - start, ops, start);
    if (data === null) return { state: "error", message: `cannot read tail of ${file}` };
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] === 0x0a) return { state: "ok", position: start + i + 1 };
    }
    end = start;
  }
  return { state: "ok", position: 0 };
}

function readBytes(fd: number, length: number, ops: JournalFs, position = 0): Buffer | null {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = ops.readSync(fd, buffer, read, length - read, position + read);
    if (count <= 0) return null;
    read += count;
  }
  return buffer;
}

/** Whole-file read; a missing file reads as empty (a 0-byte prefix is well defined). */
function readFileBuffer(file: string, ops: JournalFs): Buffer | null {
  let fd: number;
  try {
    fd = ops.openSync(file, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return Buffer.alloc(0);
    return null;
  }
  try {
    const size = ops.fstatSync(fd).size;
    return readBytes(fd, size, ops);
  } finally {
    try {
      ops.closeSync(fd);
    } catch {
      /* ignored: read-only */
    }
  }
}

function fileEndsWithLf(file: string, ops: JournalFs): boolean | null {
  let fd: number;
  try {
    fd = ops.openSync(file, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return true; // nothing exists: nothing torn
    return null;
  }
  try {
    const size = ops.fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    const read = ops.readSync(fd, last, 0, 1, size - 1);
    if (read !== 1) return null;
    return last[0] === 0x0a;
  } finally {
    try {
      ops.closeSync(fd);
    } catch {
      /* ignored */
    }
  }
}

/**
 * §9.3 prereg helper pair: `ledger_prefix_bytes` = bytes of `log.jsonl` up to the last `\n`
 * (0 when the file is missing) and its sha256. Rejects the write when the ledger tail is torn
 * (`ledger_torn_tail`): the prefix boundary would be undefined.
 */
export function ledgerPrefixSnapshot(autoDir: string, ops: JournalFs): { ok: true; bytes: number; sha256: string } | { ok: false; reason: "ledger_torn_tail" | "unavailable"; message?: string } {
  const file = path.join(autoDir, "log.jsonl");
  const endsLf = fileEndsWithLf(file, ops);
  if (endsLf === null) return { ok: false, reason: "unavailable", message: `cannot inspect tail of ${file}` };
  if (endsLf === false) return { ok: false, reason: "ledger_torn_tail" };
  const snapshot = journalPrefixSnapshot(file, ops);
  if (snapshot.state === "ok") return { ok: true, bytes: snapshot.bytes, sha256: snapshot.sha256 };
  if (snapshot.state === "missing") return { ok: true, bytes: 0, sha256: sha256Buffer(Buffer.alloc(0)) };
  return { ok: false, reason: "unavailable", message: snapshot.message };
}

/**
 * §5.2/§9.3 analysis prefix snapshot at `run_started` time: byte length + sha256 of the
 * `.auto/analysis.jsonl` prefix at the moment of the call. Exposed for the run-links writer
 * (sibling task); this module itself never writes run-links.jsonl.
 */
export function analysisPrefixSnapshot(autoDir: string, ops: JournalFs): { bytes: number; sha256: string } {
  const target = journalTarget(autoDir, "analysis");
  const snapshot = journalPrefixSnapshot(target.file, ops);
  if (snapshot.state === "ok") return { bytes: snapshot.bytes, sha256: snapshot.sha256 };
  if (snapshot.state === "missing") return { bytes: 0, sha256: sha256Buffer(Buffer.alloc(0)) };
  // Unreadable analysis journal: fail-closed zeros, never a fabricated digest.
  return { bytes: 0, sha256: sha256Buffer(Buffer.alloc(0)) };
}

// ---------------------------------------------------------------------------
// Read-side model (§6.4)
// ---------------------------------------------------------------------------

export type StoredAnalysisRecord = JsonObject & {
  v: 1;
  record: "analysis";
  kind: (typeof ANALYSIS_KINDS)[number];
  id: string;
  recorded_at: string;
};

export interface AnalysisReadResult {
  /** Records with `v: 1`, `record: "analysis"` and a verified `content_sha256` (§6.4). */
  records: StoredAnalysisRecord[];
  /** Non-empty lines that do not parse to a JSON object. */
  torn_lines: number;
  /** Analysis-shaped rows failing the record checks, including content_sha256 mismatches. */
  invalid: number;
}

function hasAnalysisKind(entry: JsonObject): boolean {
  return entry.record === ANALYSIS_RECORD_TYPE || (typeof entry.kind === "string" && (ANALYSIS_KINDS as readonly string[]).includes(entry.kind));
}

function validateAnalysisRecord(entry: JsonObject): string | null {
  if (entry.v !== ANALYSIS_FILE_VERSION) return "bad_version";
  if (entry.record !== ANALYSIS_RECORD_TYPE) return "bad_record_type";
  if (!oneOf(ANALYSIS_KINDS, entry.kind)) return "bad_kind";
  if (typeof entry.id !== "string" || !ANALYSIS_ID_RE.test(entry.id)) return "bad_id";
  if (!isIsoTimestamp(entry.recorded_at)) return "bad_recorded_at";
  const kindPrefix = (entry.id as string).split("-")[0];
  const expectedPrefix: Record<string, string> = { prereg: "pre", comparison: "cmp", attribution: "clm", supplement: "sup" };
  if (expectedPrefix[entry.kind as string] !== kindPrefix) return "kind_id_mismatch";
  if (typeof entry.content_sha256 !== "string" || !SHA256_HEX_RE.test(entry.content_sha256)) return "bad_content_sha256";
  // §6.4: recompute over the canonical JSON without the content_sha256 field.
  const withoutHash: JsonObject = { ...entry };
  delete withoutHash.content_sha256;
  if (sha256Hex(canonicalJson(withoutHash)) !== entry.content_sha256) return "content_sha256_mismatch";
  return null;
}

/** Read analysis text: torn lines counted, hash-invalid records counted as invalid (§6.4, T44). */
export function readAnalysis(text: string): AnalysisReadResult {
  const result: AnalysisReadResult = { records: [], torn_lines: 0, invalid: 0 };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) {
      result.torn_lines++;
      continue;
    }
    if (!hasAnalysisKind(entry)) continue;
    if (validateAnalysisRecord(entry) === null) {
      result.records.push(entry as unknown as StoredAnalysisRecord);
    } else {
      result.invalid++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Computed fields (never stored): §9.2 control, §5.2a epochs, §9.3 prereg order
// ---------------------------------------------------------------------------

export interface RunFacts {
  run: number;
  link: (typeof RUN_LINK_STATES)[number];
  settled: boolean | null;
  binding: string;
  runEpoch: number | null;
  runEpochBasis: (typeof RUN_EPOCH_BASES)[number];
  /** Ledger row index of the ordinary row (§5.2 proven link), null when not proven. */
  rowIndex: number | null;
  startedOffset: number | null;
  segment: number | null;
  metric: number | null;
  ledgerEpoch: number | null;
}

interface SegmentInfo {
  index: number;
  metricName: string;
  bestDirection: "lower" | "higher";
  valid: boolean;
}

interface LedgerModel {
  scan: RunLinksScan;
  /** Memoized §5.2/§5.2a facts per run number (classifyRunLink over one scan). */
  runFacts: (run: number) => RunFacts;
  configBySegment: Map<number, SegmentInfo>;
  rowByRun: Map<number, { index: number; entry: JsonObject; line: string }>;
  warnings: string[];
}

/**
 * Ledger + run-links model shared by the read-time computations (§5.2, §9.2, §9.3).
 * Exposed so tests and callers of evaluateBranches reuse one scan of both files.
 */
export function buildLedgerModel(autoDir: string, fsOps?: Partial<JournalFs>): LedgerModel {
  const scan = loadRunLinksState(autoDir, fsOps === undefined ? {} : { fs: { readFileSync: fsOps.readFileSync } });
  const rows = scan.ledger?.rows ?? [];
  const warnings = [...scan.warnings];

  const configBySegment = new Map<number, SegmentInfo>();
  const rowByRun = new Map<number, { index: number; entry: JsonObject; line: string }>();
  let segment = -1;
  let metricName: string | null = null;
  let direction: "lower" | "higher" | null = null;
  for (const row of rows) {
    const entry = row.entry;
    if (entry.type === "config") {
      const firstHeader = configBySegment.size === 0 && segment === -1;
      if (typeof entry.metricName === "string" && entry.metricName !== "") metricName = entry.metricName;
      else metricName = null;
      direction = entry.bestDirection === "higher" ? "higher" : entry.bestDirection === "lower" ? "lower" : null;
      if (!firstHeader) segment += 1;
      else segment = 0;
      configBySegment.set(segment, {
        index: segment,
        metricName: metricName ?? "",
        bestDirection: direction ?? "lower",
        valid: metricName !== null && direction !== null,
      });
      continue;
    }
    if (typeof entry.run === "number") {
      rowByRun.set(entry.run, { index: row.index, entry, line: row.line });
    }
  }

  const verdictCache = new Map<number, RunFacts>();
  const classify = (run: number): RunFacts => {
    const cached = verdictCache.get(run);
    if (cached) return cached;
    const verdict = classifyRunLink(scan, run);
    const row = rowByRun.get(run) ?? null;
    const facts: RunFacts = {
      run,
      link: verdict.link,
      settled: verdict.settled,
      binding: verdict.binding,
      runEpoch: verdict.runEpoch,
      runEpochBasis: verdict.runEpochBasis,
      rowIndex: verdict.link === "proven" && row !== null ? row.index : null,
      startedOffset: null,
      segment: row !== null && verdict.link === "proven" ? segmentOfRow(rows, row.index) : null,
      metric: row !== null && isFiniteNumber(row.entry.metric) ? row.entry.metric : null,
      ledgerEpoch: isFiniteNumber(row?.entry.epoch) ? (row?.entry.epoch as number) : null,
    };
    verdictCache.set(run, facts);
    return facts;
  };

  return { scan, runFacts: classify, configBySegment, rowByRun, warnings };
}

function segmentOfRow(rows: { index: number; entry: JsonObject }[], rowIndex: number): number | null {
  let segment = -1;
  let seenConfig = false;
  for (const row of rows) {
    if (row.entry.type === "config") {
      if (seenConfig) segment += 1;
      else segment = 0;
      seenConfig = true;
    } else if (row.index === rowIndex) {
      return seenConfig ? segment : null;
    }
  }
  return null;
}

function scalePositions(rows: { index: number; entry: JsonObject }[]): number[] {
  return rows
    .filter((row) => {
      const type = row.entry.type;
      return typeof type === "string" && type.startsWith("measurement_change");
    })
    .map((row) => row.index);
}

export interface ComputedControl {
  control: (typeof CONTROL_STATES)[number];
  control_basis: (typeof CONTROL_BASES)[number] | null;
  control_source: (typeof CONTROL_SOURCES)[number];
  epoch_check: (typeof EPOCH_CHECKS)[number];
  measurement_change_between: boolean;
  metric_context_check: (typeof METRIC_CONTEXT_CHECKS)[number];
  metric_context_reason: string | null;
  delta_allowed: boolean;
  delta_blocked_reason: string | null;
}

/**
 * §9.2 computed control (rules in order) plus the §9.2 step 5 metric context and delta gate.
 * `changed` is the effective declaration: the comparison's own field, else the last valid
 * supplement of `changed_components` for it (source recorded in `control_source`).
 */
export function computeComparisonControl(
  comparison: StoredAnalysisRecord,
  changed: { components: string[]; absent: boolean; source: (typeof CONTROL_SOURCES)[number] } | null,
  baseline: RunFacts,
  candidate: RunFacts,
  model: LedgerModel,
): ComputedControl {
  // (§9.2 step 3) measurement_change* between the two proven rows.
  let measurement_change_between = false;
  if (baseline.rowIndex !== null && candidate.rowIndex !== null) {
    const lo = Math.min(baseline.rowIndex, candidate.rowIndex);
    const hi = Math.max(baseline.rowIndex, candidate.rowIndex);
    const scale = scalePositions(model.scan.ledger?.rows ?? []);
    measurement_change_between = scale.some((position) => position > lo && position < hi);
  }

  const provenEpochs =
    baseline.link === "proven" &&
    candidate.link === "proven" &&
    baseline.runEpochBasis === "proven" &&
    candidate.runEpochBasis === "proven" &&
    baseline.runEpoch !== null &&
    candidate.runEpoch !== null;
  const epoch_check: (typeof EPOCH_CHECKS)[number] = !provenEpochs
    ? "unproven"
    : baseline.runEpoch === candidate.runEpoch
      ? "same"
      : "differs";

  // (a) epoch facts dominate the control classification.
  let control: (typeof CONTROL_STATES)[number];
  let control_basis: (typeof CONTROL_BASES)[number];
  if (epoch_check === "differs" || measurement_change_between) {
    control = "uncontrolled";
    control_basis = "epoch_change";
  } else if (changed === null) {
    control = "unknown";
    control_basis = "not_declared";
  } else if (changed.absent) {
    // §9.5 rule 4: an explicit `absent` is not zero and not "nothing changed":
    // it stays unknown with the dedicated basis.
    control = "unknown";
    control_basis = "declared_absent";
  } else if (changed.components.length === 0) {
    control = "controlled";
    control_basis = "declared_none_changed";
  } else if (changed.components.length === 1) {
    control = "controlled";
    control_basis = "declared_one_changed";
  } else {
    control = "uncontrolled";
    control_basis = "declared_multiple_changed";
  }
  const control_source: (typeof CONTROL_SOURCES)[number] = changed === null ? "none" : changed.source;

  // (§9.2 step 5) metric context: same segment + non-empty metricName + direction + matching
  // optional metric_name + finite metric values on both sides.
  let metric_context_check: (typeof METRIC_CONTEXT_CHECKS)[number] = "same";
  let metric_context_reason: string | null = null;
  const segmentA = baseline.segment;
  const segmentB = candidate.segment;
  const metricName = comparison.metric_name;
  const configA = segmentA !== null ? model.configBySegment.get(segmentA) ?? null : null;
  const configB = segmentB !== null ? model.configBySegment.get(segmentB) ?? null : null;
  if (baseline.link !== "proven" || candidate.link !== "proven") {
    metric_context_check = "unknown";
    metric_context_reason = "run_link_unproven";
  } else if (segmentA === null || segmentB === null) {
    metric_context_check = "unknown";
    metric_context_reason = "segment_unknown";
  } else if (segmentA !== segmentB) {
    metric_context_check = "unknown";
    metric_context_reason = "segment_differs";
  } else if (configA === null || !configA.valid) {
    metric_context_check = "unknown";
    metric_context_reason = "config_header_invalid";
  } else if (metricName !== undefined && metricName !== configA.metricName) {
    metric_context_check = "unknown";
    metric_context_reason = "metric_name_mismatch";
  } else if (baseline.metric === null || candidate.metric === null) {
    metric_context_check = "unknown";
    metric_context_reason = "metric_not_finite";
  }

  // delta_allowed needs a proven shared epoch, no scale change between the rows, and a
  // fully proven metric context (FR-04.4, §9.2 step 5).
  const delta_allowed =
    epoch_check === "same" && !measurement_change_between && metric_context_check === "same" && metric_context_reason === null;
  const delta_blocked_reason = delta_allowed
    ? null
    : metric_context_reason !== null
      ? `metric_context_${metric_context_reason}`
      : epoch_check === "differs"
        ? "epoch_differs"
        : epoch_check === "unproven"
          ? "epoch_unproven"
          : measurement_change_between
            ? "measurement_change_between"
            : "metric_context_unknown";

  return {
    control,
    control_basis,
    control_source,
    epoch_check,
    measurement_change_between,
    metric_context_check,
    metric_context_reason,
    delta_allowed,
    delta_blocked_reason,
  };
}

// ---------------------------------------------------------------------------
// §9.3 prereg ordering (D-RM-15, FR-04.3) and branch evaluation, computed at read time
// ---------------------------------------------------------------------------

export interface PreregOrderVerdict {
  status: PreregStatus;
  /** Always `PREREG_ORDER_BASIS` (§9.3: shared-lock snapshot proof, not timestamps). */
  order_basis: typeof PREREG_ORDER_BASIS;
  /** Named cause when status is not `pre_registered` (T69–T72 diagnostics). */
  order_reason: string | null;
  /** §9.3: sha256 of the first `ledger_prefix_bytes` bytes matches the stored snapshot. */
  prefix_intact: boolean | null;
  /** Identified run_started marker byte offset for the linked run, when known. */
  started_offset: number | null;
}

/**
 * Pure snapshot comparison (§9.3): does the verified analysis.jsonl prefix snapshot of the
 * run's proven link describe a prefix that CONTAINS the full prereg line? The snapshot bytes
 * must cover the whole line (position + serialized length ≤ snapshot bytes) and the sha256
 * of exactly those bytes must match the snapshot digest.
 */
export function analysisSnapshotContainsLine(
  snapshot: { bytes: number; sha256: string | null },
  linePosition: number,
  lineText: string,
  currentPrefix: Buffer,
): boolean {
  if (snapshot.bytes === null || typeof snapshot.bytes !== "number" || snapshot.sha256 === null) return false;
  if (!(snapshot.bytes >= 0) || !Number.isSafeInteger(snapshot.bytes)) return false;
  const lineEnd = linePosition + Buffer.byteLength(lineText, "utf8") + 1; // + LF
  if (lineEnd > snapshot.bytes) return false;
  return sha256Buffer(currentPrefix.subarray(0, snapshot.bytes)) === snapshot.sha256;
}

/**
 * §9.3 ordering for a prereg record relative to a candidate run (D-RM-15, T69–T72):
 * - `pre_registered`: the ledger prefix is intact, the run has a proven link with an
 *   identified `run_started` marker whose byte offset `o_N ≥ ledger_prefix_bytes`, the
 *   link's verified analysis.jsonl prefix snapshot (analysis_prefix_bytes/_sha256 written
 *   at run_started under the shared analysis.lock, §5.2) provably contains the FULL prereg
 *   line, and (when declared) `hypothesis_id` matches the marker's `node_id`.
 * - `post_hoc`: prefix intact, proven link, identified marker and `o_N < ledger_prefix_bytes`
 *   (the run started before registration); the record is still stored but never drives
 *   trusted decisions (§12.3 step 1a: post_hoc_prereg).
 * - `unknown` in every other case: missing or unverifiable snapshot, torn ledger prefix,
 *   absent/ambiguous link, ambiguous marker, `hypothesis_id`/node_id mismatch. Unknown is
 *   never turned into a fact in either direction.
 * Timestamps (`recorded_at`, `started_at`) never participate (§9.3); byte offsets do.
 */
export function classifyPreregOrder(autoDir: string, prereg: StoredAnalysisRecord, run: number, ops: JournalFs): PreregOrderVerdict {
  const unknown = (reason: string, prefixIntact: boolean | null, startedOffset: number | null): PreregOrderVerdict => ({
    status: "unknown",
    order_basis: PREREG_ORDER_BASIS,
    order_reason: reason,
    prefix_intact: prefixIntact,
    started_offset: startedOffset,
  });
  if (prereg.kind !== "prereg") return unknown("not_a_prereg", null, null);
  if (!isRunNumber(run)) return unknown("invalid_run_number", null, null);
  const prefixBytes = prereg.ledger_prefix_bytes;
  const prefixSha = prereg.ledger_prefix_sha256;
  if (typeof prefixBytes !== "number" || !Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || typeof prefixSha !== "string" || !SHA256_HEX_RE.test(prefixSha)) {
    return unknown("missing_prefix_snapshot", null, null);
  }

  // §9.3: prefix_intact = sha256 of the first ledger_prefix_bytes bytes still matches.
  const ledgerBuf = readFileBuffer(path.join(autoDir, "log.jsonl"), ops);
  if (ledgerBuf === null) return unknown("ledger_unavailable", null, null);
  if (ledgerBuf.length < prefixBytes) return unknown("prefix_intact_false", false, null);
  const prefixIntact = sha256Buffer(ledgerBuf.subarray(0, prefixBytes)) === prefixSha;
  if (!prefixIntact) return unknown("prefix_intact_false", false, null);

  // §5.2: proven link with an identified run_started marker for THIS run number.
  const scan = loadRunLinksState(autoDir, { fs: { readFileSync: ops.readFileSync } });
  const verdict = classifyRunLink(scan, run);
  if (verdict.link !== "proven") return unknown(`run_link_${verdict.link}`, prefixIntact, null);

  // Locate the identified run_started line in the ledger text and its byte offset o_N.
  // Walk RAW lines (torn lines also occupy line indexes in the §5.2 scan convention), so
  // the byte offset aligns with the actual file bytes even when earlier lines are damaged.
  const ledgerText = ledgerBuf.toString("utf8");
  const startMarker = scan.ledger?.markers.filter((marker) => marker.type === "run_started" && marker.run_dir === run) ?? [];
  if (startMarker.length !== 1) return unknown("ambiguous_start_marker", prefixIntact, null);
  const startLine = (scan.ledger?.rows ?? []).find((row) => row.index === startMarker[0].index);
  if (startLine === undefined) return unknown("start_marker_not_found", prefixIntact, null);
  let startedOffset = 0;
  const ledgerLines = ledgerText.split("\n");
  for (let i = 0; i < startMarker[0].index && i < ledgerLines.length; i++) {
    startedOffset += Buffer.byteLength(ledgerLines[i], "utf8") + 1; // lines are LF-terminated
  }

  // §9.3 hypothesis gate: a declared hypothesis_id must match the marker's node_id.
  const nodeId = isPlainObject(startLine.entry) && typeof startLine.entry.node_id === "string" ? startLine.entry.node_id : null;
  const hypothesisId = typeof prereg.hypothesis_id === "string" ? prereg.hypothesis_id : null;
  if (hypothesisId !== null && (nodeId === null || nodeId !== hypothesisId)) {
    return unknown("hypothesis_id_mismatch", prefixIntact, startedOffset);
  }

  // §9.3 post_hoc branch: the run provably started BEFORE registration. No analysis snapshot
  // is needed for this direction; the record stays stored but never drives trusted decisions.
  if (startedOffset < prefixBytes) {
    return { status: "post_hoc", order_basis: PREREG_ORDER_BASIS, order_reason: "run_started_before_prefix", prefix_intact: true, started_offset: startedOffset };
  }

  // §5.2 snapshot pairing: a proven link exposes analysis_prefix_bytes/_sha256 together.
  const snapshot = { bytes: verdict.analysisPrefixBytes, sha256: verdict.analysisPrefixSha256 };
  if (snapshot.bytes === null || snapshot.sha256 === null) return unknown("analysis_snapshot_missing", prefixIntact, startedOffset);

  // Where does the prereg line sit in the current analysis.jsonl?
  const analysisBuf = readFileBuffer(journalTarget(autoDir, "analysis").file, ops);
  if (analysisBuf === null) return unknown("analysis_unavailable", prefixIntact, startedOffset);
  const analysisText = analysisBuf.toString("utf8");
  let linePosition = -1;
  let lineText: string | null = null;
  let cursor = 0;
  for (const rawLine of analysisText.split("\n")) {
    if (rawLine.trim() !== "") {
      const entry = parseJsonlEntry(rawLine);
      if (entry !== null && (entry as JsonObject).id === prereg.id) {
        linePosition = cursor;
        lineText = rawLine;
        break;
      }
    }
    cursor += Buffer.byteLength(rawLine, "utf8") + 1;
  }
  if (lineText === null || linePosition < 0) return unknown("prereg_line_not_found", prefixIntact, startedOffset);

  // The verified snapshot must contain the FULL prereg line: bytes+sha over the current file.
  if (!analysisSnapshotContainsLine(snapshot, linePosition, lineText, analysisBuf)) {
    // The run started after the ledger prefix, but the snapshot does not provably contain
    // this prereg line (missing, stale, damaged or covered only a shorter prefix): the
    // joint-lock proof is absent, so the order cannot be established (§9.3 unknown).
    return unknown("snapshot_missing_line", prefixIntact, startedOffset);
  }

  // Snapshot provably contains the prereg line and the run started after the prefix:
  // the shared analysis.lock proves the prereg was written before run_started.
  return { status: "pre_registered", order_basis: PREREG_ORDER_BASIS, order_reason: null, prefix_intact: true, started_offset: startedOffset };
}

export interface BranchEvaluation {
  name: string;
  metric_name: string;
  op: "<" | "<=" | ">" | ">=";
  threshold: number;
  /** true / false only when the metric source is unique, finite and provable; else null. */
  result: boolean | null;
  status: "assessed" | "not_assessed";
  reason: string | null;
  metric_source: "metric" | "metrics" | null;
  metric_value: number | null;
}

export interface BranchEvaluationReport {
  prereg_status: PreregStatus;
  order_basis: typeof PREREG_ORDER_BASIS;
  order_reason: string | null;
  /** Always present for a linked run with prereg_status = unknown (§9.3 fail-closed). */
  branches: BranchEvaluation[];
}

/** Strict §9.3 comparison: op over recorded numbers, never an interpretation of truth. */
function branchOpHolds(op: "<" | "<=" | ">" | ">=", value: number, threshold: number): boolean {
  if (op === "<") return value < threshold;
  if (op === "<=") return value <= threshold;
  if (op === ">") return value > threshold;
  return value >= threshold;
}

/**
 * §9.3 «Оценка ветвей»: evaluate each preregistered branch of a prereg record against the
 * linked candidate run — independently, without post-hoc reinterpretation and without any
 * choice of further action. Metric resolution per branch: the row's `metric` field only when
 * the segment's config header names exactly `branch.metric_name`; otherwise the numeric
 * `metrics[branch.metric_name]`. Both sources present and differing, a non-finite or missing
 * value, an unproven link or a non-`pre_registered` order → `unknown` branch with a reason
 * (§9.3: «иначе... результат ветви unknown с причиной»). Exhaustion levels (§12.3a) belong
 * to the sibling hint engine and are deliberately not computed here.
 */
export function evaluateBranches(
  autoDir: string,
  prereg: StoredAnalysisRecord,
  run: number,
  model: LedgerModel,
  order?: PreregOrderVerdict,
  ops: JournalFs = NODE_FS,
): BranchEvaluationReport {
  const orderVerdict = order ?? classifyPreregOrder(autoDir, prereg, run, ops);
  const report: BranchEvaluationReport = { prereg_status: orderVerdict.status, order_basis: orderVerdict.order_basis, order_reason: orderVerdict.order_reason, branches: [] };
  const branches = Array.isArray(prereg.branches) ? prereg.branches : [];
  const facts = model.runFacts(run);
  const row = model.rowByRun.get(run) ?? null;
  const proven = facts.link === "proven" && row !== null;
  for (const branch of branches) {
    if (!isPlainObject(branch) || typeof branch.name !== "string" || typeof branch.metric_name !== "string" || !oneOf(BRANCH_OPS, branch.op) || !isFiniteNumber(branch.threshold)) {
      report.branches.push({ name: typeof branch === "object" && branch !== null && typeof (branch as JsonObject).name === "string" ? (branch as JsonObject).name as string : "", metric_name: "", op: "<", threshold: 0, result: null, status: "not_assessed", reason: "branch_shape_invalid", metric_source: null, metric_value: null });
      continue;
    }
    const base: BranchEvaluation = { name: branch.name, metric_name: branch.metric_name, op: branch.op, threshold: branch.threshold, result: null, status: "not_assessed", reason: null, metric_source: null, metric_value: null };
    if (orderVerdict.status !== "pre_registered") {
      report.branches.push({ ...base, reason: orderVerdict.status === "post_hoc" ? "prereg_post_hoc" : `prereg_${orderVerdict.order_reason ?? "unknown"}` });
      continue;
    }
    if (!proven) {
      report.branches.push({ ...base, reason: "run_link_unproven" });
      continue;
    }
    const segment = facts.segment;
    const config = segment !== null ? model.configBySegment.get(segment) ?? null : null;
    const rowMetric = isFiniteNumber(row.entry.metric) ? row.entry.metric : null;
    const metricsMap = isPlainObject(row.entry.metrics) ? row.entry.metrics : null;
    const namedMetric = metricsMap !== null && isFiniteNumber(metricsMap[branch.metric_name]) ? metricsMap[branch.metric_name] as number : null;
    // metric field only when the segment header names exactly this branch metric.
    const primaryUsable = config !== null && config.valid && config.metricName === branch.metric_name && rowMetric !== null;
    if (primaryUsable && namedMetric !== null && namedMetric !== rowMetric) {
      report.branches.push({ ...base, reason: "conflicting_metric_sources" });
      continue;
    }
    let value: number | null = null;
    let source: BranchEvaluation["metric_source"] = null;
    if (primaryUsable) {
      value = rowMetric;
      source = "metric";
    } else if (namedMetric !== null) {
      value = namedMetric;
      source = "metrics";
    }
    if (value === null) {
      report.branches.push({ ...base, reason: "metric_unavailable" });
      continue;
    }
    report.branches.push({ ...base, result: branchOpHolds(branch.op, value, branch.threshold), status: "assessed", reason: null, metric_source: source, metric_value: value });
  }
  return report;
}

// ---------------------------------------------------------------------------
// §12.3a pure helpers for the sibling hint engine (no hint computation here)
// ---------------------------------------------------------------------------

/** Campaign key (§12.3a): (axis, prereg_id, run_epoch). */
export interface ExhaustionKey {
  axis: string;
  preregId: string;
  runEpoch: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic first-16 global campaign keys (§10.3 budgets, §12.3a «Объём»): order by
 * axis, then prereg_id, by Unicode code units, then run_epoch ascending as a number.
 */
export function selectCampaignKeys(keys: Iterable<ExhaustionKey>): ExhaustionKey[] {
  const sorted = [...keys].sort(
    (a, b) => compareStrings(a.axis, b.axis) || compareStrings(a.preregId, b.preregId) || a.runEpoch - b.runEpoch,
  );
  return sorted.slice(0, CAMPAIGN_KEY_LIMIT);
}

/** Eligibility budget check for one key's window elements (§12.3a «Объём»). */
export function keyElementBudgetOk(eligibleCount: number): boolean {
  return eligibleCount <= ANALYSIS_KEY_ELEMENT_LIMIT;
}

// ---------------------------------------------------------------------------
// METRIC parser + provenance snapshot (§10.2a). The v1 completeness flag does not
// exist (E-23), so L2/evidence_bound stays unreachable on purpose.
// ---------------------------------------------------------------------------

/** Same rules as index.ts parseMetricLines; returns the last accepted value per name. */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

export type SnapshotOutcome =
  | {
      state: "ok";
      snapshot: {
        run: number;
        output_sha256: string;
        output_bytes: number;
        metric_name: string;
        metric_line_no: number;
        metric_value_text: string;
        parser: "metric-last-v1";
      };
    }
  | { state: "unavailable"; reason: "output_unavailable" | "output_unsafe" | "evidence_too_large" | "no_metric_line" | "read_failed" };

function outputPath(autoDir: string, run: number): string {
  return path.join(autoDir, "runs", String(run), "output.txt");
}

/**
 * §10.2a provenance snapshot for one output reference: sha256, size, last accepted METRIC
 * `metric_name` and its 1-based line. Reads only `.auto/runs/<run>/output.txt` through fixed
 * path components (I-17); a symlink in the chain is refused before any content is read.
 */
export function buildEvidenceSnapshot(autoDir: string, run: number, metricName: string, ops: JournalFs): SnapshotOutcome {
  const runDir = path.join(autoDir, "runs", String(run));
  const file = outputPath(autoDir, run);
  for (const segment of [autoDir, path.join(autoDir, "runs"), runDir, file]) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(segment);
    } catch {
      return { state: "unavailable", reason: "output_unavailable" };
    }
    if (stats.isSymbolicLink()) return { state: "unavailable", reason: "output_unsafe" };
    if (segment === file && !stats.isFile()) return { state: "unavailable", reason: "output_unsafe" };
  }
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { state: "unavailable", reason: "output_unavailable" };
  }
  if (size > ANALYSIS_OUTPUT_MAX_BYTES) return { state: "unavailable", reason: "evidence_too_large" };

  let fd: number;
  try {
    fd = ops.openSync(file, "r");
  } catch {
    return { state: "unavailable", reason: "output_unavailable" };
  }
  try {
    const data = readBytes(fd, size, ops);
    if (data === null) return { state: "unavailable", reason: "read_failed" };
    const text = data.toString("utf8");
    const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
    let found: { lineNo: number; valueText: string } | null = null;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      if (name === metricName && !DENIED_METRIC_NAMES.has(name) && Number.isFinite(Number(match[2]))) {
        found = { lineNo: 1 + countLfsBefore(text, match.index), valueText: match[2] };
      }
    }
    if (found === null) return { state: "unavailable", reason: "no_metric_line" };
    return {
      state: "ok",
      snapshot: {
        run,
        output_sha256: sha256Buffer(data),
        output_bytes: size,
        metric_name: metricName,
        metric_line_no: found.lineNo,
        metric_value_text: found.valueText,
        parser: "metric-last-v1",
      },
    };
  } finally {
    try {
      ops.closeSync(fd);
    } catch {
      /* ignored */
    }
  }
}

function countLfsBefore(text: string, position: number): number {
  let count = 0;
  for (let i = 0; i < position; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

/** §10.2 step 8/10 budget + L0 checks for one evidence ref; never opens manifest.json. */
function checkEvidenceRef(
  autoDir: string,
  ref: EvidenceRef,
  ops: JournalFs,
  budget: { remaining: number },
): { ok: true } | { ok: false; status: "unknown" | "unverifiable"; reason: string } {
  if (budget.remaining <= 0) return { ok: false, status: "unverifiable", reason: "budget_exhausted" };
  budget.remaining -= 1;
  // L0 form: only .auto/runs/<run>/output.txt is accepted for attribution evidence;
  // manifest-only refs cannot satisfy step 7 (§10.0) and are recorded as missing output.
  if (ref.artifact !== "output") return { ok: false, status: "unknown", reason: "no_output_evidence" };
  const file = outputPath(autoDir, ref.run);
  for (const segment of [autoDir, path.join(autoDir, "runs"), path.join(autoDir, "runs", String(ref.run)), file]) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(segment);
    } catch {
      return { ok: false, status: "unknown", reason: "ref_missing" };
    }
    if (stats.isSymbolicLink()) return { ok: false, status: "unknown", reason: "symlink_component" };
    if (segment === file && !stats.isFile()) return { ok: false, status: "unknown", reason: "ref_invalid" };
  }
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { ok: false, status: "unknown", reason: "ref_missing" };
  }
  if (size > ANALYSIS_OUTPUT_MAX_BYTES) return { ok: false, status: "unverifiable", reason: "evidence_too_large" };
  return { ok: true };
}

export type AttributionStatus =
  | { status: "unknown"; reason: string }
  | { status: "unverifiable"; reason: string }
  | { status: "evidence_bound"; reason: string };

/**
 * Explicit v1 guard (E-23, design.md §10.2a): output capture completeness is unproven, so
 * L2 is never credited and `evidence_bound` is NOT reachable. This constant documents the
 * ceiling; the status computation below can only ever return `unknown` or `unverifiable`.
 */
export const ATTRIBUTION_EVIDENCE_BOUND_UNREACHABLE_V1 = true as const;

/**
 * §10.2 causal status, computed at read time. Order of checks matters: the first failure
 * defines the reason. In v1 `evidence_bound` is NOT reachable: output completeness is unproven
 * (E-23), so step 10 (0) always fails with `output_completeness_unproven` before any L2 credit.
 */
export function computeAttributionStatus(
  autoDir: string,
  attribution: StoredAnalysisRecord,
  allRecords: StoredAnalysisRecord[],
  ops: JournalFs,
  budget: { remaining: number } = { remaining: ANALYSIS_REF_BUDGET_PER_CALL },
): AttributionStatus {
  const refs = Array.isArray(attribution.evidence_refs) ? attribution.evidence_refs : [];
  // Step 1: no evidence refs at all.
  if (refs.length === 0) return { status: "unknown", reason: "no_evidence" };

  // Step 2: comparison binding.
  const comparisonId = attribution.comparison_id;
  if (typeof comparisonId !== "string") return { status: "unknown", reason: "no_comparison" };
  const comparison = allRecords.find((record) => record.kind === "comparison" && record.id === comparisonId);
  if (comparison === undefined) return { status: "unknown", reason: "no_comparison" };

  // Steps 3–4: comparability and control of the linked comparison (computed, not stored).
  const model = buildLedgerModel(autoDir, ops);
  const baseline = model.runFacts(comparison.baseline_run as number);
  const candidate = model.runFacts(comparison.candidate_run as number);
  if (baseline.link !== "proven" || candidate.link !== "proven") {
    return { status: "unknown", reason: "not_comparable" };
  }
  const supplementedComponents = effectiveComponents(allRecords, comparison);
  const control = computeComparisonControl(comparison, supplementedComponents, baseline, candidate, model);
  if (!control.delta_allowed) return { status: "unknown", reason: "not_comparable" };
  if (control.control !== "controlled") {
    if (control.control === "unknown" && control.control_basis === "declared_absent") {
      // §9.5 rule 4 / T63: an explicit `absent` declaration is unknown control, and with
      // unknown control an attribution can never be verified (§10.2 step 4, unknown_control).
      return { status: "unknown", reason: "unknown_control" };
    }
    return { status: "unknown", reason: control.control === "uncontrolled" ? "uncontrolled_comparison" : "unknown_control" };
  }
  // §10.2 step 4 tail: a supplemented control declaration is L3-only, never trusted.
  // §10.2 step 4: `control_source = post_hoc_supplement` → `post_hoc_control`, regardless of
  // the classification; the subject restriction below applies on top (step 5).
  if (control.control_source === "post_hoc_supplement") {
    return { status: "unknown", reason: "post_hoc_control" };
  }

  // Step 5: subjects. A `subjects` field missing from the attribution itself may be filled by
  // a supplement (§9.5); a supplemented subjects list is shown as declared but never yields
  // evidence_bound: unknown/post_hoc_subjects (§10.2 step 5), no upgrade regardless of order.
  let subjects = Array.isArray(attribution.subjects) ? attribution.subjects : null;
  let subjectsFromSupplement = false;
  if (subjects === null) {
    for (let i = allRecords.length - 1; i >= 0; i--) {
      const record = allRecords[i];
      if (record.kind !== "supplement" || record.target_id !== attribution.id || record.field !== "subjects") continue;
      if (record.absent !== undefined) break; // explicit absent: stays no_subjects (§9.5 rule 4)
      const supplemented = validSubjects(record.value);
      if (supplemented !== null) {
        subjects = supplemented;
        subjectsFromSupplement = true;
      }
      break;
    }
  }
  if (subjects === null || subjects.length === 0) return { status: "unknown", reason: "no_subjects" };
  if (supplementedComponents !== null && supplementedComponents.absent) return { status: "unknown", reason: "no_subjects" };
  const effective = supplementedComponents !== null ? supplementedComponents.components : [];
  for (const subject of subjects) {
    if (!effective.includes(subject)) return { status: "unknown", reason: "subject_not_changed" };
  }
  if (subjectsFromSupplement) return { status: "unknown", reason: "post_hoc_subjects" };

  // Step 6: metric binding.
  const metricName = comparison.metric_name;
  if (typeof metricName !== "string") return { status: "unknown", reason: "no_metric_binding" };

  // Step 7: identification and output evidence on BOTH sides.
  const outputRefsByRun = new Map<number, EvidenceRef[]>();
  for (const raw of refs) {
    const checked = checkEvidenceRefForm(raw, "evidence");
    if (!checked.ok) return { status: "unknown", reason: "ref_invalid" };
    if (checked.ref.artifact === "output") {
      const list = outputRefsByRun.get(checked.ref.run) ?? [];
      list.push(checked.ref);
      outputRefsByRun.set(checked.ref.run, list);
    }
  }
  for (const side of [candidate, baseline] as const) {
    if (side.link !== "proven") return { status: "unknown", reason: "run_not_identified" };
  }
  if (!outputRefsByRun.has(candidate.run)) return { status: "unknown", reason: "no_output_evidence_candidate" };
  if (!outputRefsByRun.has(baseline.run)) return { status: "unknown", reason: "no_output_evidence_baseline" };

  // Step 8/9: budget + L0 over EVERY output ref per side (§10.2 step 8, §10.3 budgets):
  // deterministic order — sides in record order (candidate first, then baseline), refs in
  // array order (§10.3: "ссылки атрибуции — в порядке массива"). The budget object may be
  // shared by the caller across phases (§10.3: one counter for the whole call); a fresh
  // call starts with the documented ANALYSIS_REF_BUDGET_PER_CALL. Exhaustion → unverifiable.
  const sides: { run: number; refs: EvidenceRef[]; label: "candidate" | "baseline" }[] = [
    { run: candidate.run, refs: outputRefsByRun.get(candidate.run) ?? [], label: "candidate" },
    { run: baseline.run, refs: outputRefsByRun.get(baseline.run) ?? [], label: "baseline" },
  ];
  for (const side of sides) {
    if (side.refs.length === 0) return { status: "unknown", reason: `no_output_evidence_${side.label}` };
    for (const ref of side.refs) {
      const checked = checkEvidenceRef(autoDir, ref, ops, budget);
      if (!checked.ok) return { status: checked.status, reason: checked.reason };
    }
  }

  // Step 10 (0): capture completeness. In v1 there is no completeness flag (E-23):
  // every fully prepared attribution stops here, so `evidence_bound` is unreachable.
  // When the owner decision E-23 introduces `.auto/runs/<N>/output.complete.json`, the
  // completeness check (persisted === true, received_bytes === output_bytes === current
  // size, sha256 matching the stored snapshot) belongs exactly here; until then this
  // function must keep returning unknown with the reason below (fail-closed).
  void ATTRIBUTION_EVIDENCE_BOUND_UNREACHABLE_V1;
  return { status: "unknown", reason: "output_completeness_unproven" };
}

function effectiveComponents(
  allRecords: StoredAnalysisRecord[],
  comparison: StoredAnalysisRecord,
): { components: string[]; absent: boolean; source: (typeof CONTROL_SOURCES)[number] } | null {
  if (Array.isArray(comparison.changed_components)) {
    return { components: comparison.changed_components as string[], absent: false, source: "comparison" };
  }
  for (let i = allRecords.length - 1; i >= 0; i--) {
    const record = allRecords[i];
    if (record.kind !== "supplement") continue;
    if (record.target_id !== comparison.id || record.field !== "changed_components") continue;
    if (record.absent !== undefined) return { components: [], absent: true, source: "post_hoc_supplement" };
    const components = validComponents(record.value);
    if (components !== null) return { components, absent: false, source: "post_hoc_supplement" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The writer (§6.1, §6.2, §7.4): the ONLY writer of analysis.jsonl
// ---------------------------------------------------------------------------

const NODE_FS: JournalFs = {
  openSync: (file, flags) => fs.openSync(file, flags),
  closeSync: (fd) => fs.closeSync(fd),
  writeSync: (fd, data) => fs.writeSync(fd, data),
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  fstatSync: (fd) => fs.fstatSync(fd),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  unlinkSync: (file) => fs.unlinkSync(file),
};

function journalFs(options: JournalOptions): JournalFs {
  return { ...NODE_FS, ...options.fs };
}

function readTextIfExists(file: string, ops: JournalFs): string {
  try {
    return ops.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return "";
    throw error;
  }
}

type LockedAppend =
  | { status: "appended"; newlineGuard: boolean; warnings: string[] }
  | { status: "fsync_failed"; message: string; warnings: string[] }
  | { status: "failed"; message: string; torn: boolean; warnings: string[] };

/** §6.1: newline guard, single writeSync, no retry of a short write, fsync before close. */
function appendRecordLocked(file: string, record: Buffer, ops: JournalFs): LockedAppend {
  const warnings: string[] = [];
  let guard: boolean;
  try {
    guard = needsNewlineGuard(file, ops);
  } catch (error) {
    return { status: "failed", message: `cannot inspect the tail of ${file}: ${describeError(error)}; nothing written`, torn: false, warnings };
  }
  const data = guard ? Buffer.concat([Buffer.from("\n", "utf8"), record]) : record;

  let fd: number;
  try {
    fd = ops.openSync(file, "a");
  } catch (error) {
    return { status: "failed", message: `cannot open ${file} for append: ${describeError(error)}; nothing written`, torn: false, warnings };
  }
  try {
    let written: number;
    try {
      written = ops.writeSync(fd, data);
    } catch (error) {
      return {
        status: "failed",
        message: `write to ${file} failed: ${describeError(error)}; bytes written unknown, a torn fragment may remain`,
        torn: true,
        warnings,
      };
    }
    if (written !== data.length) {
      return {
        status: "failed",
        message:
          `short write to ${file}: ${written} of ${data.length} bytes; not retried` +
          (written > 0 ? "; a torn fragment remains and the next append's newline guard separates it" : ""),
        torn: written > 0,
        warnings,
      };
    }
    try {
      ops.fsyncSync(fd);
    } catch (error) {
      return { status: "fsync_failed", message: `fsync of ${file} failed: ${describeError(error)}`, warnings };
    }
    return { status: "appended", newlineGuard: guard, warnings };
  } finally {
    try {
      ops.closeSync(fd);
    } catch (error) {
      warnings.push(`close_failed: ${describeError(error)}`);
    }
  }
}

function needsNewlineGuard(file: string, ops: JournalFs): boolean {
  let fd: number;
  try {
    fd = ops.openSync(file, "r");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return false;
    throw error;
  }
  try {
    const size = ops.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    const read = ops.readSync(fd, last, 0, 1, size - 1);
    if (read !== 1) throw new Error(`tail read returned ${read} bytes`);
    return last[0] !== 0x0a;
  } finally {
    ops.closeSync(fd);
  }
}

export interface AnalysisRecordComputed {
  /** §9.2 block, present for comparison records. */
  control?: ComputedControl;
  /** §10.2 causal status, present for attribution records (v1: never evidence_bound). */
  attribution_status?: AttributionStatus;
  /** Supplement timing label relative to the target record (§9.5 enum), supplement records only. */
  timing?: "post_hoc_supplement" | "before_candidate_run" | "unknown";
  /** §9.3 ordering verdict for the linked candidate run, present for prereg records. */
  prereg_status?: PreregOrderVerdict;
}

export interface RecordAnalysisSuccess {
  status: "appended";
  id: string;
  kind: (typeof ANALYSIS_KINDS)[number];
  recorded_at: string;
  /** Computed fields at write time, for information only (§7.4: recomputed at read). */
  computed: AnalysisRecordComputed;
  torn_lines: number;
  warnings: string[];
}

export interface RecordAnalysisError {
  status: "error";
  code: string;
  message: string;
}

export type RecordAnalysisResponse = RecordAnalysisSuccess | RecordAnalysisError;

export type RecordAnalysisOptions = JournalOptions;

type CriticalOutcome =
  | { kind: "error"; code: string; message: string; torn: number }
  | { kind: "write"; record: JsonObject; append: LockedAppend; torn: number };

function makeId(kind: (typeof ANALYSIS_KINDS)[number], now: Date, randomBytes: (size: number) => Buffer): string {
  const prefix = kind === "prereg" ? "pre" : kind === "comparison" ? "cmp" : kind === "attribution" ? "clm" : "sup";
  return `${prefix}-${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function findRecord(records: StoredAnalysisRecord[], id: string): StoredAnalysisRecord | null {
  return records.find((record) => record.id === id) ?? null;
}

function buildRecord(
  kind: (typeof ANALYSIS_KINDS)[number],
  params: Record<string, unknown>,
  id: string,
  recordedAt: string,
): JsonObject {
  const record: JsonObject = {
    v: ANALYSIS_FILE_VERSION,
    record: ANALYSIS_RECORD_TYPE,
    kind,
    id,
    recorded_at: recordedAt,
    ...params,
  };
  // content_sha256 is excluded from its own canonical JSON (§6.4).
  record.content_sha256 = sha256Hex(canonicalJson(record));
  return record;
}

/**
 * The only writer of `.auto/analysis.jsonl` (§7.4). Validate → lock → read target state →
 * build the record with snapshots → newline-guarded single-write append under the lock →
 * token-checked release. Returns computed fields for information only; readers recompute.
 */
export async function recordAnalysis(
  autoDir: string,
  rawParams: unknown,
  options: RecordAnalysisOptions = {},
): Promise<RecordAnalysisResponse> {
  const parsed = parseAnalysisParams(rawParams);
  if (!parsed.ok) return { status: "error", code: parsed.code, message: parsed.message };
  const kind = parsed.kind;
  const params = parsed.params;
  /** §9.5 rule 2 timing label, set inside the critical section for supplement records. */
  let timing: AnalysisRecordComputed["timing"] = undefined;

  const ops = journalFs(options);
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));
  const target = journalTarget(autoDir, "analysis");

  const locked = await withJournalLock(
    target,
    (): CriticalOutcome => {
      let text: string;
      try {
        text = readTextIfExists(target.file, ops);
      } catch (error) {
        return { kind: "error", code: "analysis_unavailable", message: `cannot read analysis.jsonl: ${describeError(error)}`, torn: 0 };
      }
      const existing = readAnalysis(text);
      const torn = existing.torn_lines;

      // ---------- prereg: ledger prefix snapshot (§9.3) ----------
      if (kind === "prereg") {
        const prefix = ledgerPrefixSnapshot(autoDir, ops);
        if (!prefix.ok) {
          if (prefix.reason === "ledger_torn_tail") {
            return { kind: "error", code: "ledger_torn_tail", message: "log.jsonl ends with an incomplete line; the ledger prefix boundary is undefined (§9.3); nothing written", torn };
          }
          return { kind: "error", code: "ledger_unavailable", message: prefix.message ?? "cannot read log.jsonl", torn };
        }
        params.ledger_prefix_bytes = prefix.bytes;
        params.ledger_prefix_sha256 = prefix.sha256;
      }

      // ---------- reference existence checks (§7.4 unknown_reference) ----------
      if (kind === "comparison" && typeof params.prereg_id === "string") {
        const prereg = findRecord(existing.records, params.prereg_id);
        if (prereg === null || prereg.kind !== "prereg") {
          return { kind: "error", code: "unknown_reference", message: `prereg_id ${params.prereg_id} not found; nothing written`, torn };
        }
      }
      if (kind === "attribution" && typeof params.comparison_id === "string") {
        const comparison = findRecord(existing.records, params.comparison_id);
        if (comparison === null || comparison.kind !== "comparison") {
          return { kind: "error", code: "unknown_reference", message: `comparison_id ${params.comparison_id} not found; nothing written`, torn };
        }
      }

      // ---------- supplement target and field rules (§9.5) ----------
      if (kind === "supplement") {
        const targetRecord = findRecord(existing.records, params.target_id as string);
        if (targetRecord === null) {
          return { kind: "error", code: "unknown_reference", message: `target_id ${String(params.target_id)} not found; nothing written`, torn };
        }
        const field = params.field as (typeof SUPPLEMENT_FIELDS)[number];
        const allowed = SUPPLEMENT_FIELD_TARGETS[field];
        if (!allowed.includes(targetRecord.kind as (typeof ANALYSIS_KINDS)[number])) {
          return { kind: "error", code: "invalid_input", message: `field "${field}" is not allowed for kind "${targetRecord.kind}"`, torn };
        }
        if (field === "subjects" && targetRecord.kind === "attribution" && Array.isArray(targetRecord.subjects)) {
          return { kind: "error", code: "field_already_recorded", message: "subjects already recorded; supplements never overwrite (§9.5); nothing written", torn };
        }
        if (field === "changed_components" && targetRecord.kind === "comparison" && Array.isArray(targetRecord.changed_components)) {
          return { kind: "error", code: "field_already_recorded", message: "changed_components already recorded; supplements never overwrite (§9.5); nothing written", torn };
        }
        if (field === "purpose_text" && targetRecord.kind === "comparison" && typeof targetRecord.purpose_text === "string") {
          return { kind: "error", code: "field_already_recorded", message: "purpose_text already recorded; supplements never overwrite (§9.5); nothing written", torn };
        }
        if ((field === "noise_band" && targetRecord.noise_band !== undefined) || (field === "noise_basis_ref" && targetRecord.noise_basis_ref !== undefined)) {
          return { kind: "error", code: "field_already_recorded", message: `${field} already recorded; supplements never overwrite (§9.5); nothing written`, torn };
        }
        // §9.5 rule 1: a second supplement for the same field is a conflict. Torn or
        // invalid records do not count: an unparseable line cannot prove a prior supplement.
        const priorSupplement = existing.records.find(
          (record) => record.kind === "supplement" && record.target_id === params.target_id && record.field === field,
        );
        if (priorSupplement !== undefined) {
          return { kind: "error", code: "supplement_conflict", message: `field "${field}" was already supplemented for ${String(params.target_id)}; nothing written`, torn };
        }
        // Timing label (§9.5 rule 2): supplements to comparison/attribution are post-hoc
        // relative to the target record by construction (the target exists ⇒ both run rows
        // existed before it). For prereg targets the candidate run's identity is not known
        // at write time; until the ordering proof (§9.3/§9.5) confirms before-candidate-run,
        // the label is honestly `unknown` — never a post_hoc claim without proof.
        timing = targetRecord.kind === "prereg" ? "unknown" : "post_hoc_supplement";
      }

      // ---------- attribution: provenance snapshots (§10.2a) ----------
      if (kind === "attribution") {
        const refs = params.evidence_refs as EvidenceRef[];
        // The metric binding comes from the linked comparison (§10.2 step 6); without it no
        // snapshot can name a metric, so all snapshots are null (`no_metric_binding`).
        const linked = typeof params.comparison_id === "string" ? findRecord(existing.records, params.comparison_id) : null;
        const metricName = linked !== null && typeof linked.metric_name === "string" ? linked.metric_name : null;
        const snapshots: (Record<string, unknown> | null)[] = [];
        let snapshotReason: string | null = null;
        for (const ref of refs) {
          if (ref.artifact !== "output" || metricName === null) {
            snapshots.push(null);
            snapshotReason = snapshotReason ?? (metricName === null ? "no_metric_binding" : "manifest_ref");
            continue;
          }
          const outcome = buildEvidenceSnapshot(autoDir, ref.run, metricName, ops);
          if (outcome.state === "ok") {
            snapshots.push(outcome.snapshot);
          } else {
            snapshots.push(null);
            snapshotReason = snapshotReason ?? outcome.reason;
          }
        }
        params.evidence_snapshot = snapshots;
        if (snapshotReason !== null) params.evidence_snapshot_reason = snapshotReason;
      }

      // ---------- build and append ----------
      const recordedAt = now().toISOString();
      const id = makeId(kind, now(), randomBytes);
      const record = buildRecord(kind, params, id, recordedAt);
      const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (line.length > JOURNAL_RECORD_MAX_BYTES) {
        return {
          kind: "error",
          code: "record_too_large",
          message: `record is ${line.length} bytes; limit is ${JOURNAL_RECORD_MAX_BYTES} bytes including LF; nothing written`,
          torn,
        };
      }
      return { kind: "write", record, append: appendRecordLocked(target.file, line, ops), torn };
    },
    options,
  );

  if (locked.status === "lock_busy") return { status: "error", code: locked.code, message: locked.message };
  if (locked.status === "lock_failed") return { status: "error", code: "analysis_lock_failed", message: locked.message };

  const outcome = locked.value;
  const releaseWarnings = locked.warnings.map((warning) => warning.code);
  if (outcome.kind === "error") return { status: "error", code: outcome.code, message: outcome.message };
  if (outcome.append.status === "failed") {
    return {
      status: "error",
      code: "record_write_failed",
      message: outcome.append.torn
        ? `${outcome.append.message}. The next append's newline guard will separate the fragment; inspect analysis.jsonl before retrying.`
        : outcome.append.message,
    };
  }

  // Information-only computed fields (readers recompute; §7.4).
  const record = outcome.record;
  const computed: AnalysisRecordComputed = {};
  if (record.kind === "comparison") {
    computed.control = computedControlForResponse(autoDir, record, ops);
  } else if (record.kind === "attribution") {
    const reread = readAnalysis(readTextIfExists(target.file, ops));
    computed.attribution_status = computeAttributionStatus(autoDir, record as StoredAnalysisRecord, reread.records, ops);
  } else if (record.kind === "prereg") {
    // §9.3 ordering is computed at read time; the response shows the current verdict for the
    // linked candidate run (usually none yet at prereg time → unknown, honest default).
    const candidateRun = typeof params.candidate_run === "number" ? params.candidate_run : null;
    computed.prereg_status =
      candidateRun !== null
        ? classifyPreregOrder(autoDir, record as StoredAnalysisRecord, candidateRun, ops)
        : { status: "unknown", order_basis: PREREG_ORDER_BASIS, order_reason: "no_candidate_run", prefix_intact: null, started_offset: null };
  } else if (record.kind === "supplement") {
    computed.timing = timing;
  }

  const warnings = [...releaseWarnings];
  if (outcome.append.status === "fsync_failed") warnings.push("fsync_failed");
  warnings.push(...outcome.append.warnings);
  return {
    status: "appended",
    id: record.id as string,
    kind: record.kind as (typeof ANALYSIS_KINDS)[number],
    recorded_at: record.recorded_at as string,
    computed,
    torn_lines: outcome.torn,
    warnings: [...new Set(warnings)],
  };
}

function computedControlForResponse(autoDir: string, comparison: JsonObject, ops: JournalFs): ComputedControl {
  const model = buildLedgerModel(autoDir, ops);
  const baseline = model.runFacts(comparison.baseline_run as number);
  const candidate = model.runFacts(comparison.candidate_run as number);
  // The write-time response reflects the comparison's own declaration; a later supplement
  // only shows up when readers recompute (§9.2).
  const changed = Array.isArray(comparison.changed_components)
    ? { components: comparison.changed_components as string[], absent: false, source: "comparison" as const }
    : null;
  return computeComparisonControl(comparison as StoredAnalysisRecord, changed, baseline, candidate, model);
}

// ---------------------------------------------------------------------------
// Tool shape (§7.4). Registration in index.ts is a separate step (S3); not done here.
// ---------------------------------------------------------------------------

export const RECORD_ANALYSIS_TOOL_NAME = "record_analysis";

export const RECORD_ANALYSIS_PARAMETERS = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { enum: [...ANALYSIS_KINDS] },
    // prereg (§9.3)
    axis: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    hypothesis_id: { type: "string", pattern: "^n[0-9]+$" },
    branches: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "metric_name", "op", "threshold", "meaning"],
        properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          metric_name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
          op: { enum: ["<", "<=", ">", ">="] },
          threshold: { type: "number" },
          meaning: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
    exhaustion_rule: {
      type: "object",
      additionalProperties: false,
      properties: {
        metric_name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
        direction: { enum: ["lower", "higher"] },
        threshold_gain: { type: "number", exclusiveMinimum: 0 },
        k: { type: "integer", minimum: 2, maximum: 10, default: 3 },
      },
    },
    // comparison (§9.1)
    purpose: { enum: [...ANALYSIS_PURPOSES] },
    purpose_text: { type: "string", minLength: 1, maxLength: 200 },
    baseline_run: { type: "integer", minimum: 1, maximum: RUN_NUMBER_MAX },
    candidate_run: { type: "integer", minimum: 1, maximum: RUN_NUMBER_MAX },
    metric_name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
    changed_components: {
      type: "array",
      minItems: 0,
      maxItems: 16,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
    },
    noise_band: { type: "number", minimum: 0 },
    noise_basis_ref: { $ref: "#/$defs/typedRef" },
    prereg_id: { type: "string", pattern: "^pre-[0-9a-z]+-[0-9a-f]{8}$" },
    review_requested: { type: "boolean" },
    // attribution (§10.1)
    claim: { type: "string", minLength: 1, maxLength: 300 },
    subjects: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
    },
    comparison_id: { type: "string", pattern: "^cmp-[0-9a-z]+-[0-9a-f]{8}$" },
    evidence_refs: { type: "array", maxItems: 8, items: { $ref: "#/$defs/typedRef" } },
    // supplement (§9.5)
    target_id: { type: "string", pattern: "^(pre|cmp|clm|sup)-[0-9a-z]+-[0-9a-f]{8}$" },
    field: { enum: [...SUPPLEMENT_FIELDS] },
    value: {},
    absent: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        reason: { enum: [...SUPPLEMENT_REASONS] },
        note: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    // state passport (§8)
    passport: { type: "object" },
  },
  $defs: {
    typedRef: {
      type: "object",
      additionalProperties: false,
      required: ["run", "artifact", "lines", "anchor"],
      properties: {
        run: { type: "integer", minimum: 1, maximum: RUN_NUMBER_MAX },
        artifact: { enum: ["output", "manifest"] },
        lines: { oneOf: [{ type: "null" }, { type: "array", minItems: 2, maxItems: 2, items: { type: "integer", minimum: 1, maximum: 1000000 } }] },
        anchor: { oneOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 200 }] },
      },
    },
  },
} as const;

/**
 * Tool-shaped object: name, label, description, parameters and an `execute` that returns the
 * text content plus structured details. Bound to one `.auto` directory; NOT registered anywhere
 * by this module.
 */
export function createRecordAnalysisTool(autoDir: string, options: RecordAnalysisOptions = {}) {
  return {
    name: RECORD_ANALYSIS_TOOL_NAME,
    label: "Record analysis",
    description:
      "Append an analysis record (kind prereg, comparison, attribution or supplement) to .auto/analysis.jsonl " +
      "under analysis.lock. Prereg captures the ledger prefix for ordering; comparison control, delta " +
      "eligibility and causal status are computed, never stored as proof. Records never change runs, " +
      "git or best.",
    parameters: RECORD_ANALYSIS_PARAMETERS,
    async execute(_toolCallId: string, params: unknown) {
      const response = await recordAnalysis(autoDir, params, options);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
        details: response,
      };
    },
  };
}
