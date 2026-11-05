/**
 * Observation journal for research-map (openspec/changes/research-map/design.md §5.2, §5.3,
 * §6.3, §6.4, §7.1, §7.3, §8.2; decisions D-RM-01, D-RM-02, D-RM-04, D-RM-05).
 *
 * An observation records a preparation or diagnostic step (for example teacher generation).
 * It is NOT a run: it never enters `log.jsonl`, never changes best/streak/epoch, never calls git,
 * never touches the working tree and never reads `runtime.lastRunNumber`.
 *
 * - Storage: `<autoDir>/observations.jsonl`, one JSON object per line with `v: 1`,
 *   `record: "observation"`. Observation rows carry no `run`, `status`, `type`, `commit`,
 *   `epoch` or `segment` keys, so `reconstructJsonlState` never reads them as runs.
 * - Writes take `observations.lock` through research-journal.ts (same lock conventions: exclusive
 *   `wx` file, token-checked release, bounded retries, no automatic takeover). The dedup check and
 *   the append run in one synchronous critical section, so concurrent writers with one
 *   idempotency key cannot both append.
 * - Binding to a run (§5.2) is computed from `log.jsonl` markers on every call. `run_link`
 *   `proven` needs the run-links journal (task 2.2) and is therefore never produced here: an
 *   existing ordinary ledger row for the run gives `ambiguous`, no row gives `absent`.
 *
 * Tool-shaped entry points: `logObservation` (pure function over an autoDir) and
 * `createLogObservationTool`. The tool is NOT registered in index.ts by this module.
 */

import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import {
  JOURNAL_RECORD_MAX_BYTES,
  journalTarget,
  withJournalLock,
  type JournalFs,
  type JournalOptions,
} from "./research-journal.ts";

export const OBSERVATION_FILE_VERSION = 1;
export const OBSERVATION_RECORD_TYPE = "observation";
export const OBSERVATION_OUTCOMES = ["success", "technical_failure", "unknown"] as const;
export const OBSERVATION_ACTIVITY_TYPES = ["intermediate", "attribution"] as const;
export const METRIC_PROVENANCES = ["none", "output_match", "wallclock", "manual"] as const;
export const RUN_LINK_STATES = ["proven", "absent", "ambiguous"] as const;
export const BINDING_STATES = ["verified", "unverified", "unsettled"] as const;
export const RUN_EPOCH_BASES = [
  "proven",
  "not_linked",
  "no_marker",
  "unverified_binding",
  "scale_changed_in_window",
  "scale_changed_after_run",
  "epoch_conflict",
  "ledger_torn_tail",
] as const;

export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number];
export type ObservationActivityType = (typeof OBSERVATION_ACTIVITY_TYPES)[number];
export type MetricProvenance = (typeof METRIC_PROVENANCES)[number];
export type RunLinkState = (typeof RUN_LINK_STATES)[number];
export type BindingState = (typeof BINDING_STATES)[number];
export type RunEpochBasis = (typeof RUN_EPOCH_BASES)[number];

/** Keys that identify a run or a status in the main ledger. Never valid in an observation (I-5, T4). */
export const FORBIDDEN_OBSERVATION_KEYS = ["run", "status", "type", "commit", "epoch", "segment"] as const;

const RECORD_MAX_BYTES = JOURNAL_RECORD_MAX_BYTES;
const DESCRIPTION_MAX_CHARS = 500;
const METRICS_LIMIT = 16;
const COMPONENTS_LIMIT = 16;
const COMPONENT_REF_MAX_CHARS = 512;
const PASSPORT_MAX_BYTES = 4 * 1024;
const RUN_NUMBER_MAX = 1_000_000_000;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const WALLCLOCK_TOLERANCE_SECONDS = 2;
const OUTPUT_TOLERANCE_RELATIVE = 0.005;
const METRIC_LINE_PREFIX = "METRIC";
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const COMPONENT_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SHA256_ANY_CASE_RE = /^[0-9a-fA-F]{64}$/;
const OBS_ID_RE = /^obs-[0-9a-z]+-[0-9a-f]{8}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

const PARAMETER_KEYS = new Set([
  "linked_run",
  "activity_type",
  "outcome",
  "description",
  "metric",
  "metrics",
  "asi",
  "passport",
  "idempotency_key",
]);

/** Every property of the §7.1 record schema. Anything else is rejected (additionalProperties: false). */
const RECORD_KEYS = new Set([
  "v",
  "record",
  "obs_id",
  "recorded_at",
  "idempotency_key",
  "input_sha256",
  "segment_at_record",
  "epoch_at_record",
  "run_segment",
  "run_epoch",
  "run_epoch_basis",
  "observed_run",
  "observed_run_dir",
  "run_started_at",
  "run_settled",
  "binding",
  "run_link",
  "activity_type",
  "outcome",
  "description",
  "metric",
  "metrics",
  "metric_provenance",
  "asi",
  "passport",
]);

const RECORD_REQUIRED_KEYS = [
  "v",
  "record",
  "obs_id",
  "recorded_at",
  "segment_at_record",
  "epoch_at_record",
  "run_segment",
  "run_epoch",
  "run_epoch_basis",
  "observed_run",
  "observed_run_dir",
  "run_started_at",
  "run_settled",
  "binding",
  "run_link",
  "activity_type",
  "outcome",
  "description",
  "metric_provenance",
];

const NOTE_CODES = [null, "not_provided", "invalid_ref", "non_local_ref", "denied_by_policy"] as const;

/** Parameters of `log_observation` (§7.3). Validated by `parseLogObservationParams`. */
export interface PassportComponentInput {
  ref?: string | null;
  declared_sha256?: string | null;
}

export interface PassportInput {
  components: Record<string, PassportComponentInput>;
}

export interface LogObservationParams {
  linked_run?: "last" | number;
  activity_type?: ObservationActivityType;
  outcome: ObservationOutcome;
  description: string;
  metric?: number;
  metrics?: Record<string, number>;
  asi?: Record<string, unknown>;
  passport?: PassportInput;
  idempotency_key?: string;
}

export interface NormalizedObservationParams {
  linked_run: "last" | number;
  activity_type: ObservationActivityType;
  outcome: ObservationOutcome;
  description: string;
  metric?: number;
  metrics?: Record<string, number>;
  asi?: Record<string, unknown>;
  passport?: PassportInput;
  idempotency_key?: string;
}

export type ComponentState = "declared" | "unknown";
export type ComponentNote = (typeof NOTE_CODES)[number];

export interface PassportComponentRecord {
  state: ComponentState;
  ref: string | null;
  declared_sha256: string | null;
  verified: false;
  note: ComponentNote;
}

export interface PassportRecord {
  v: 1;
  components: Record<string, PassportComponentRecord>;
}

/** A stored observation (§7.1). Optional keys are absent when not applicable. */
export interface ObservationRecord {
  v: 1;
  record: "observation";
  obs_id: string;
  recorded_at: string;
  idempotency_key?: string;
  input_sha256?: string;
  segment_at_record: number;
  epoch_at_record: number;
  run_segment: number | null;
  run_epoch: number | null;
  run_epoch_basis: RunEpochBasis;
  observed_run: number;
  observed_run_dir: string;
  run_started_at: string | null;
  run_settled: boolean | null;
  binding: BindingState;
  run_link: RunLinkState;
  activity_type: ObservationActivityType;
  outcome: ObservationOutcome;
  description: string;
  metric_provenance: MetricProvenance;
  metric?: number;
  metrics?: Record<string, number>;
  asi?: Record<string, unknown>;
  passport?: PassportRecord;
}

export interface ObservationReadResult {
  records: ObservationRecord[];
  /** Non-empty lines that are not JSON objects (torn fragments, garbage). */
  torn_lines: number;
  /** Observation-shaped rows that fail the §7.1 checks (including rows carrying forbidden keys). */
  invalid: number;
}

export interface LogObservationSuccess {
  status: "appended" | "already_recorded";
  obs_id: string;
  observed_run: number;
  observed_run_dir: string;
  run_started_at: string | null;
  run_settled: boolean | null;
  binding: BindingState;
  run_link: RunLinkState;
  run_segment: number | null;
  run_epoch: number | null;
  run_epoch_basis: RunEpochBasis;
  epoch_at_record: number;
  metric_provenance: MetricProvenance;
  torn_lines: number;
  dedup: "key" | "none";
  warnings: string[];
}

export interface LogObservationError {
  status: "error";
  code: string;
  message: string;
}

export type LogObservationResponse = LogObservationSuccess | LogObservationError;

/** Test and integration hooks: the journal options (fs, sleep, clock, random bytes, owner) are reused. */
export type LogObservationOptions = JournalOptions;

// ---------------------------------------------------------------------------
// Helpers
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

/** A run number in the range the run directories use (I-17: 1…10^9). */
function isRunNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value <= RUN_NUMBER_MAX;
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

/** Canonical JSON: object keys sorted, undefined members dropped. Used only for input hashing. */
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

// ---------------------------------------------------------------------------
// Input validation (§7.3)
// ---------------------------------------------------------------------------

export type ParseObservationParamsOutcome =
  | { ok: true; value: NormalizedObservationParams }
  | { ok: false; message: string };

/**
 * Validate the raw `log_observation` input. Unknown keys (including `run`, `status`, `commit`,
 * `type`, `epoch`, `segment`, `observed_run`) are rejected. Nothing is written by this function.
 */
export function parseLogObservationParams(raw: unknown): ParseObservationParamsOutcome {
  const fail = (message: string): ParseObservationParamsOutcome => ({ ok: false, message });
  if (!isPlainObject(raw)) return fail("parameters must be an object");
  for (const key of Object.keys(raw)) {
    if (!PARAMETER_KEYS.has(key)) return fail(`unknown parameter "${key}"`);
  }

  const linkedRaw: unknown = raw.linked_run === undefined ? "last" : raw.linked_run;
  if (!(linkedRaw === "last" || isRunNumber(linkedRaw))) {
    return fail('linked_run must be "last" or an integer from 1 to 1000000000');
  }

  const activityRaw: unknown = raw.activity_type === undefined ? "intermediate" : raw.activity_type;
  if (!oneOf(OBSERVATION_ACTIVITY_TYPES, activityRaw)) {
    return fail("activity_type must be intermediate or attribution");
  }

  if (!oneOf(OBSERVATION_OUTCOMES, raw.outcome)) {
    return fail("outcome must be success, technical_failure or unknown");
  }

  const description = raw.description;
  const descriptionLength = typeof description === "string" ? [...description].length : 0;
  if (typeof description !== "string" || descriptionLength < 1 || descriptionLength > DESCRIPTION_MAX_CHARS) {
    return fail(`description must be a string of 1 to ${DESCRIPTION_MAX_CHARS} characters`);
  }

  const value: NormalizedObservationParams = {
    linked_run: linkedRaw as "last" | number,
    activity_type: activityRaw,
    outcome: raw.outcome,
    description,
  };

  if (raw.metric !== undefined) {
    if (!isFiniteNumber(raw.metric)) return fail("metric must be a finite number; omit the key when nothing was measured");
    value.metric = raw.metric;
  }

  if (raw.metrics !== undefined) {
    if (
      !isPlainObject(raw.metrics) ||
      Object.keys(raw.metrics).length > METRICS_LIMIT ||
      !Object.values(raw.metrics).every(isFiniteNumber)
    ) {
      return fail(`metrics must be an object of at most ${METRICS_LIMIT} finite numbers`);
    }
    value.metrics = raw.metrics as Record<string, number>;
  }

  if (raw.asi !== undefined) {
    if (!isPlainObject(raw.asi)) return fail("asi must be an object");
    value.asi = raw.asi;
  }

  if (raw.passport !== undefined) {
    const passport = raw.passport;
    if (!isPlainObject(passport) || Object.keys(passport).some((key) => key !== "components")) {
      return fail("passport must be an object whose only key is components");
    }
    if (!isPlainObject(passport.components)) return fail("passport.components must be an object");
    const components = passport.components;
    const names = Object.keys(components);
    if (names.length > COMPONENTS_LIMIT) return fail(`passport allows at most ${COMPONENTS_LIMIT} components`);
    for (const name of names) {
      if (!COMPONENT_NAME_RE.test(name)) return fail(`invalid passport component name "${name}"`);
      const component = components[name];
      if (!isPlainObject(component) || Object.keys(component).some((key) => key !== "ref" && key !== "declared_sha256")) {
        return fail(`passport component "${name}" may hold only ref and declared_sha256`);
      }
      if (component.ref !== undefined && component.ref !== null && typeof component.ref !== "string") {
        return fail(`passport component "${name}".ref must be a string or null`);
      }
      const sha = component.declared_sha256;
      if (sha !== undefined && sha !== null && !(typeof sha === "string" && SHA256_ANY_CASE_RE.test(sha))) {
        return fail(`passport component "${name}".declared_sha256 must be 64 hex characters`);
      }
    }
    value.passport = passport as unknown as PassportInput;
  }

  if (raw.idempotency_key !== undefined) {
    if (typeof raw.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(raw.idempotency_key)) {
      return fail("idempotency_key must match ^[A-Za-z0-9._-]{1,64}$");
    }
    value.idempotency_key = raw.idempotency_key;
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Passport normalization (§8.2). No file is opened here (I-12).
// ---------------------------------------------------------------------------

type RefCheck = { ok: true; ref: string } | { ok: false; note: Exclude<ComponentNote, null> };

function isDeniedSegment(segment: string): boolean {
  // Hygiene only (§8.2 step 4): not a security boundary.
  const name = segment.toLowerCase().replace(/[. ]+$/, "");
  return (
    name === ".auto" ||
    name === ".git" ||
    name === "node_modules" ||
    name.startsWith(".env") ||
    name === "id_rsa" ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  );
}

/** §8.2 steps 2–4 for a declared `ref` string. */
function checkComponentRef(raw: string): RefCheck {
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || slashed.includes("://") || /^[A-Za-z]:/.test(slashed)) {
    return { ok: false, note: "non_local_ref" };
  }
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  const ref = segments.join("/");
  if (
    segments.length === 0 ||
    segments.includes("..") ||
    ref.includes(":") ||
    CONTROL_CHARS_RE.test(ref) ||
    ref.length > COMPONENT_REF_MAX_CHARS
  ) {
    return { ok: false, note: "invalid_ref" };
  }
  if (segments.some(isDeniedSegment)) return { ok: false, note: "denied_by_policy" };
  return { ok: true, ref };
}

function unknownComponent(note: Exclude<ComponentNote, null>): PassportComponentRecord {
  return { state: "unknown", ref: null, declared_sha256: null, verified: false, note };
}

function declaredComponent(ref: string | null, declaredSha256: string | null): PassportComponentRecord {
  return { state: "declared", ref, declared_sha256: declaredSha256, verified: false, note: null };
}

function normalizeComponent(input: PassportComponentInput): PassportComponentRecord {
  const sha = typeof input.declared_sha256 === "string" ? input.declared_sha256.toLowerCase() : null;
  if (typeof input.ref !== "string") {
    // Step 1: no ref. A valid hash alone is still a declaration.
    return sha === null ? unknownComponent("not_provided") : declaredComponent(null, sha);
  }
  const checked = checkComponentRef(input.ref);
  // A rejected ref makes the whole component unknown, including the hash (§8.2 step 1).
  if (!checked.ok) return unknownComponent(checked.note);
  return declaredComponent(checked.ref, sha);
}

/** Normalize a validated passport input into the stored form (§7.1 `passport`). */
export function normalizePassport(input: PassportInput): PassportRecord {
  const components: Record<string, PassportComponentRecord> = {};
  for (const name of Object.keys(input.components).sort()) {
    components[name] = normalizeComponent(input.components[name]);
  }
  return { v: 1, components };
}

// ---------------------------------------------------------------------------
// Reading observations (§6.4) and the hand-written §7.1 check
// ---------------------------------------------------------------------------

function validatePassportRecord(passport: unknown): boolean {
  if (!isPlainObject(passport)) return false;
  if (Object.keys(passport).some((key) => key !== "v" && key !== "components")) return false;
  if (passport.v !== 1 || !isPlainObject(passport.components)) return false;
  const components = passport.components;
  const names = Object.keys(components);
  if (names.length > COMPONENTS_LIMIT) return false;
  for (const name of names) {
    if (!COMPONENT_NAME_RE.test(name)) return false;
    const component = components[name];
    if (!isPlainObject(component)) return false;
    const keys = Object.keys(component);
    if (keys.length !== 5 || ["state", "ref", "declared_sha256", "verified", "note"].some((key) => !keys.includes(key))) {
      return false;
    }
    const ref = component.ref;
    const sha = component.declared_sha256;
    if (component.verified !== false) return false;
    if (!NOTE_CODES.includes(component.note as ComponentNote)) return false;
    if (ref !== null && (typeof ref !== "string" || ref.length > COMPONENT_REF_MAX_CHARS)) return false;
    if (sha !== null && !(typeof sha === "string" && SHA256_HEX_RE.test(sha))) return false;
    if (component.state === "declared") {
      if (component.note !== null) return false;
      if (ref === null && sha === null) return false;
    } else if (component.state === "unknown") {
      if (ref !== null || sha !== null || component.note === null) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Hand-written subset of the §7.1 JSON Schema (the repository has no JSON Schema validator, R14).
 * Returns null when the record is valid, otherwise a short reason code.
 */
export function validateObservationRecord(entry: JsonObject): string | null {
  for (const key of FORBIDDEN_OBSERVATION_KEYS) {
    if (key in entry) return `forbidden_key:${key}`;
  }
  for (const key of Object.keys(entry)) {
    if (!RECORD_KEYS.has(key)) return `unknown_key:${key}`;
  }
  for (const key of RECORD_REQUIRED_KEYS) {
    if (!(key in entry)) return `missing:${key}`;
  }
  if (entry.v !== OBSERVATION_FILE_VERSION) return "bad_version";
  if (entry.record !== OBSERVATION_RECORD_TYPE) return "bad_record_type";
  if (typeof entry.obs_id !== "string" || !OBS_ID_RE.test(entry.obs_id)) return "bad_obs_id";
  if (!isIsoTimestamp(entry.recorded_at)) return "bad_recorded_at";
  if (!isNonNegativeInteger(entry.segment_at_record)) return "bad_segment_at_record";
  if (!isPositiveInteger(entry.epoch_at_record)) return "bad_epoch_at_record";
  if (!(entry.run_segment === null || isNonNegativeInteger(entry.run_segment))) return "bad_run_segment";
  if (!(entry.run_epoch === null || isPositiveInteger(entry.run_epoch))) return "bad_run_epoch";
  if (!oneOf(RUN_EPOCH_BASES, entry.run_epoch_basis)) return "bad_run_epoch_basis";
  if (!isRunNumber(entry.observed_run)) return "bad_observed_run";
  if (entry.observed_run_dir !== `.auto/runs/${entry.observed_run}`) return "bad_observed_run_dir";
  if (!(entry.run_started_at === null || isIsoTimestamp(entry.run_started_at))) return "bad_run_started_at";
  if (!(entry.run_settled === null || typeof entry.run_settled === "boolean")) return "bad_run_settled";
  if (!oneOf(BINDING_STATES, entry.binding)) return "bad_binding";
  if (!oneOf(RUN_LINK_STATES, entry.run_link)) return "bad_run_link";
  if (!oneOf(OBSERVATION_ACTIVITY_TYPES, entry.activity_type)) return "bad_activity_type";
  if (!oneOf(OBSERVATION_OUTCOMES, entry.outcome)) return "bad_outcome";
  if (typeof entry.description !== "string") return "bad_description";
  const descriptionLength = [...entry.description].length;
  if (descriptionLength < 1 || descriptionLength > DESCRIPTION_MAX_CHARS) return "bad_description";
  if (!oneOf(METRIC_PROVENANCES, entry.metric_provenance)) return "bad_metric_provenance";

  if (entry.metric_provenance === "none") {
    if ("metric" in entry) return "metric_present_without_provenance";
  } else if (!isFiniteNumber(entry.metric)) {
    return "metric_missing_for_provenance";
  }
  if ("metric" in entry && !isFiniteNumber(entry.metric)) return "bad_metric";
  if ("metrics" in entry) {
    if (!isPlainObject(entry.metrics)) return "bad_metrics";
    if (Object.keys(entry.metrics).length > METRICS_LIMIT || !Object.values(entry.metrics).every(isFiniteNumber)) {
      return "bad_metrics";
    }
  }
  if ("asi" in entry && !isPlainObject(entry.asi)) return "bad_asi";
  if ("passport" in entry && !validatePassportRecord(entry.passport)) return "bad_passport";
  if ("idempotency_key" in entry) {
    if (typeof entry.idempotency_key !== "string" || !IDEMPOTENCY_KEY_RE.test(entry.idempotency_key)) {
      return "bad_idempotency_key";
    }
    if (!("input_sha256" in entry)) return "missing:input_sha256";
  }
  if ("input_sha256" in entry && !(typeof entry.input_sha256 === "string" && SHA256_HEX_RE.test(entry.input_sha256))) {
    return "bad_input_sha256";
  }

  // §7.1 allOf rules.
  if (entry.run_link === "absent" || entry.run_link === "ambiguous") {
    if (entry.run_epoch !== null || entry.run_segment !== null) return "link_fields_not_null";
  }
  if (entry.run_link === "proven") {
    if (entry.binding !== "verified" || !isNonNegativeInteger(entry.run_segment)) return "proven_requires_verified";
  }
  if (entry.run_epoch_basis === "proven") {
    if (!isPositiveInteger(entry.run_epoch)) return "proven_epoch_missing";
  } else if (entry.run_epoch !== null) {
    return "epoch_without_basis";
  }
  return null;
}

/**
 * Read `observations.jsonl` text. Lines that are not JSON objects count as torn. Object rows that
 * are observation-shaped (record = observation, or any forbidden key) are checked; failing rows
 * count as invalid and are never returned as valid observations.
 */
export function readObservations(text: string): ObservationReadResult {
  const result: ObservationReadResult = { records: [], torn_lines: 0, invalid: 0 };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) {
      result.torn_lines++;
      continue;
    }
    const observationShaped = entry.record === OBSERVATION_RECORD_TYPE || FORBIDDEN_OBSERVATION_KEYS.some((key) => key in entry);
    if (!observationShaped) continue;
    if (validateObservationRecord(entry) === null) {
      result.records.push(entry as unknown as ObservationRecord);
    } else {
      result.invalid++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ledger scan and run binding (§5.2, §5.2a)
// ---------------------------------------------------------------------------

interface LedgerMarker {
  index: number;
  type: "run_started" | "run_result";
  run_dir: unknown;
  started_at: unknown;
  duration_seconds: unknown;
}

interface LedgerRow {
  index: number;
  entry: JsonObject;
}

interface LedgerScan {
  rows: LedgerRow[];
  markers: LedgerMarker[];
  /** Indexes of non-empty lines that are not JSON objects. */
  torn: number[];
}

function isMarkerType(type: unknown): type is "run_started" | "run_result" {
  return type === "run_started" || type === "run_result";
}

function scanLedger(text: string): LedgerScan {
  const scan: LedgerScan = { rows: [], markers: [], torn: [] };
  let index = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseJsonlEntry(line);
    if (entry === null) {
      scan.torn.push(index);
    } else {
      scan.rows.push({ index, entry });
      if (isMarkerType(entry.type)) {
        scan.markers.push({
          index,
          type: entry.type,
          run_dir: entry.run_dir,
          started_at: entry.started_at,
          duration_seconds: entry.duration_seconds,
        });
      }
    }
    index++;
  }
  return scan;
}

type LedgerRead = { state: "missing" } | { state: "unavailable"; message: string } | { state: "ok"; text: string };

function readLedger(autoDir: string): LedgerRead {
  try {
    return { state: "ok", text: fs.readFileSync(path.join(autoDir, "log.jsonl"), "utf8") };
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { state: "missing" };
    return { state: "unavailable", message: `cannot read log.jsonl: ${describeError(error)}` };
  }
}

function runDirectoryExists(autoDir: string, run: number): boolean {
  try {
    return fs.statSync(path.join(autoDir, "runs", String(run))).isDirectory();
  } catch {
    return false;
  }
}

/** True when exactly one run_started and one run_result carry this run number and the same started_at. */
function markerPairVerified(markers: LedgerMarker[], run: number): boolean {
  const starts = markers.filter((m) => m.type === "run_started" && m.run_dir === run);
  const results = markers.filter((m) => m.type === "run_result" && m.run_dir === run);
  return (
    starts.length === 1 &&
    results.length === 1 &&
    typeof starts[0].started_at === "string" &&
    starts[0].started_at === results[0].started_at
  );
}

function isScaleRow(entry: JsonObject): boolean {
  return typeof entry.type === "string" && entry.type.startsWith("measurement_change");
}

interface LinkResolution {
  observed_run: number;
  observed_run_dir: string;
  run_started_at: string | null;
  run_settled: boolean | null;
  binding: BindingState;
  run_link: RunLinkState;
  run_epoch_basis: RunEpochBasis;
  duration_seconds: number | null;
  warnings: string[];
}

type LinkOutcome = { ok: true; link: LinkResolution } | { ok: false; code: string; message: string };

const TORN_LAST_MESSAGE =
  "log.jsonl contains an incomplete line after the last run marker. Linking 'last' is disabled so the " +
  "observation is not attached to an older finished run. Pass linked_run explicitly (the link will be " +
  "unverified) or repair the line by hand. Nothing was written; log.jsonl was not changed.";

/** §5.2: bind the observation to a run from ledger markers only (no process memory). */
function resolveRunLink(autoDir: string, linked: "last" | number, scan: LedgerScan): LinkOutcome {
  const lastMarker = scan.markers.length > 0 ? scan.markers[scan.markers.length - 1] : null;
  const tornAfterLast = scan.torn.some((index) => lastMarker === null || index > lastMarker.index);
  const linkError = (code: string, message: string): LinkOutcome => ({ ok: false, code, message });

  let run: number;
  if (linked === "last") {
    if (lastMarker === null) return linkError("no_settled_run", "log.jsonl has no run markers; there is no run to observe.");
    if (tornAfterLast) return linkError("ledger_torn_tail", TORN_LAST_MESSAGE);
    if (lastMarker.type === "run_started") {
      return linkError("dangling_run", `run ${String(lastMarker.run_dir)} started but has no run_result; pass linked_run explicitly to observe it as unsettled.`);
    }
    if (!isRunNumber(lastMarker.run_dir)) {
      return linkError("run_without_artifacts", "the last run_result has no valid run_dir.");
    }
    run = lastMarker.run_dir;
    if (!runDirectoryExists(autoDir, run)) {
      return linkError("artifacts_missing", `.auto/runs/${run}/ does not exist.`);
    }
  } else {
    run = linked;
    if (!runDirectoryExists(autoDir, run)) {
      return linkError("artifacts_missing", `.auto/runs/${run}/ does not exist.`);
    }
  }

  const starts = scan.markers.filter((m) => m.type === "run_started" && m.run_dir === run);
  const results = scan.markers.filter((m) => m.type === "run_result" && m.run_dir === run);
  const startMarker = starts.length > 0 ? starts[starts.length - 1] : null;
  const resultMarker = results.length > 0 ? results[results.length - 1] : null;

  let runSettled: boolean | null;
  let binding: BindingState;
  let runStartedAt: string | null;
  if (resultMarker !== null && (startMarker === null || resultMarker.index > startMarker.index)) {
    runSettled = true;
    binding = markerPairVerified(scan.markers, run) ? "verified" : "unverified";
    const source = linked === "last" || startMarker === null ? resultMarker : startMarker;
    runStartedAt = typeof source.started_at === "string" ? source.started_at : null;
  } else if (startMarker !== null) {
    runSettled = false;
    binding = "unsettled";
    runStartedAt = typeof startMarker.started_at === "string" ? startMarker.started_at : null;
  } else {
    runSettled = null;
    binding = "unverified";
    runStartedAt = null;
  }

  // Explicit N with an incomplete tail: binding at most unverified (§5.2).
  if (linked !== "last" && tornAfterLast && binding === "verified") binding = "unverified";

  // run_link: a torn line may hide an ordinary row for this run, so any torn line → ambiguous.
  // Proven links need the run-links journal (task 2.2); without it an existing row is ambiguous.
  const ordinaryRows = scan.rows.filter((row) => !isMarkerType(row.entry.type) && row.entry.run === run).length;
  const runLink: RunLinkState = scan.torn.length > 0 || ordinaryRows > 0 ? "ambiguous" : "absent";

  // §5.2a rule B. Any unsettled or unmarked run has no provable epoch.
  let basis: RunEpochBasis;
  if (runSettled !== true || startMarker === null || resultMarker === null) {
    basis = "no_marker";
  } else if (binding !== "verified") {
    basis = "unverified_binding";
  } else if (scan.rows.some((row) => row.index > startMarker.index && isScaleRow(row.entry))) {
    basis = "scale_changed_after_run";
  } else if (scan.torn.some((index) => index > startMarker.index)) {
    basis = "ledger_torn_tail";
  } else {
    // run_link is never "proven" in this module (see above), so the epoch is not proven.
    basis = "not_linked";
  }

  const warnings: string[] = [];
  if (binding === "unsettled") warnings.push("binding_unsettled");
  if (binding === "unverified") warnings.push("binding_unverified");
  if (scan.torn.length > 0) warnings.push("ledger_torn_tail");
  if (ordinaryRows > 0) warnings.push("run_number_shared");

  const durationRaw = runSettled === true && resultMarker !== null ? resultMarker.duration_seconds : undefined;
  return {
    ok: true,
    link: {
      observed_run: run,
      observed_run_dir: `.auto/runs/${run}`,
      run_started_at: runStartedAt,
      run_settled: runSettled,
      binding,
      run_link: runLink,
      run_epoch_basis: basis,
      duration_seconds: isFiniteNumber(durationRaw) ? durationRaw : null,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Metric provenance (§5.3 step 4, §10.2a parser rules)
// ---------------------------------------------------------------------------

/** Same rules as index.ts `parseMetricLines`: last accepted value per name. */
function parseMetricLines(output: string): Map<string, number> {
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

type OutputRead =
  | { state: "ok"; text: string }
  | { state: "failed"; warning: "output_unavailable" | "output_unsafe" | "output_too_large" };

/**
 * Read `.auto/runs/<N>/output.txt` only through fixed components. A symlink in the chain or a
 * non-regular file is refused before any content is read. The check is an lstat, not a handle
 * (Windows has no O_NOFOLLOW, D-RM-13), so this is a best-effort guard.
 */
function readRunOutput(autoDir: string, run: number): OutputRead {
  const runDir = path.join(autoDir, "runs", String(run));
  const file = path.join(runDir, "output.txt");
  for (const segment of [autoDir, path.join(autoDir, "runs"), runDir, file]) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(segment);
    } catch {
      return { state: "failed", warning: "output_unavailable" };
    }
    if (stats.isSymbolicLink()) return { state: "failed", warning: "output_unsafe" };
    if (segment === file) {
      if (!stats.isFile()) return { state: "failed", warning: "output_unsafe" };
      if (stats.size > OUTPUT_MAX_BYTES) return { state: "failed", warning: "output_too_large" };
    }
  }
  try {
    return { state: "ok", text: fs.readFileSync(file, "utf8") };
  } catch {
    return { state: "failed", warning: "output_unavailable" };
  }
}

interface ProvenanceResult {
  provenance: MetricProvenance;
  warnings: string[];
}

/** Provenance of a supplied metric, rebuilt from durable sources (never from process memory). */
function metricProvenanceOf(
  autoDir: string,
  metric: number | undefined,
  link: LinkResolution,
  metricName: string,
): ProvenanceResult {
  if (metric === undefined) return { provenance: "none", warnings: [] };
  const output = readRunOutput(autoDir, link.observed_run);
  if (output.state !== "ok") return { provenance: "manual", warnings: [output.warning] };

  const primary = parseMetricLines(output.text).get(metricName);
  if (primary !== undefined) {
    const tolerance = Math.max(1e-9, Math.abs(primary) * OUTPUT_TOLERANCE_RELATIVE);
    return { provenance: Math.abs(metric - primary) <= tolerance ? "output_match" : "manual", warnings: [] };
  }
  if (link.duration_seconds !== null) {
    const matches = Math.abs(metric - link.duration_seconds) <= WALLCLOCK_TOLERANCE_SECONDS;
    return { provenance: matches ? "wallclock" : "manual", warnings: [] };
  }
  return { provenance: "manual", warnings: [] };
}

// ---------------------------------------------------------------------------
// Identity hash (§6.3)
// ---------------------------------------------------------------------------

function inputIdentity(
  params: NormalizedObservationParams,
  link: LinkResolution,
  passport: PassportRecord | null,
): unknown {
  return {
    outcome: params.outcome,
    activity_type: params.activity_type,
    description: params.description,
    metric: params.metric,
    metrics: params.metrics,
    asi: params.asi,
    linked_run: params.linked_run,
    observed_run: link.observed_run,
    run_started_at: link.run_started_at,
    passport_identity:
      passport === null
        ? null
        : Object.keys(passport.components)
            .sort()
            .map((name) => {
              const component = passport.components[name];
              return [name, component.state, component.ref, component.declared_sha256, component.note];
            }),
  };
}

// ---------------------------------------------------------------------------
// Journal I/O under the lock (research-journal.ts exports lock and append guards only partly;
// the dedup check and the append must share one critical section, so the writer is local)
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

type LockedAppend =
  | { status: "appended"; newlineGuard: boolean; warnings: string[] }
  | { status: "fsync_failed"; message: string; warnings: string[] }
  | { status: "failed"; message: string; torn: boolean; warnings: string[] };

/** Runs under the observations lock. One writeSync, no retry of a short write, fsync before close. */
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

// ---------------------------------------------------------------------------
// logObservation (§5.3)
// ---------------------------------------------------------------------------

function errorResponse(code: string, message: string): LogObservationError {
  return { status: "error", code, message };
}

function successFromRecord(
  record: ObservationRecord,
  status: "appended" | "already_recorded",
  torn: number,
  dedup: "key" | "none",
  warnings: string[],
): LogObservationSuccess {
  return {
    status,
    obs_id: record.obs_id,
    observed_run: record.observed_run,
    observed_run_dir: record.observed_run_dir,
    run_started_at: record.run_started_at,
    run_settled: record.run_settled,
    binding: record.binding,
    run_link: record.run_link,
    run_segment: record.run_segment,
    run_epoch: record.run_epoch,
    run_epoch_basis: record.run_epoch_basis,
    epoch_at_record: record.epoch_at_record,
    metric_provenance: record.metric_provenance,
    torn_lines: torn,
    dedup,
    warnings,
  };
}

type CriticalOutcome =
  | { kind: "error"; code: string; message: string; torn: number }
  | { kind: "already"; record: ObservationRecord; torn: number }
  | { kind: "write"; record: ObservationRecord; append: LockedAppend; torn: number };

/**
 * Append one observation about a run. Synchronous steps after the lock: read, dedup, append.
 * Never runs git, never writes `log.jsonl`, never reads `runtime.lastRunNumber`.
 */
export async function logObservation(
  autoDir: string,
  rawParams: unknown,
  options: LogObservationOptions = {},
): Promise<LogObservationResponse> {
  const parsed = parseLogObservationParams(rawParams);
  if (!parsed.ok) return errorResponse("invalid_input", parsed.message);
  const params = parsed.value;

  const ledger = readLedger(autoDir);
  if (ledger.state === "missing") return errorResponse("no_settled_run", "log.jsonl does not exist; there is no run to observe.");
  if (ledger.state === "unavailable") return errorResponse("ledger_unavailable", ledger.message);

  const scan = scanLedger(ledger.text);
  const resolved = resolveRunLink(autoDir, params.linked_run, scan);
  if (!resolved.ok) return errorResponse(resolved.code, resolved.message);
  const link = resolved.link;

  const passport = params.passport === undefined ? null : normalizePassport(params.passport);
  if (passport !== null && Buffer.byteLength(JSON.stringify(passport), "utf8") > PASSPORT_MAX_BYTES) {
    return errorResponse("passport_too_large", `passport serialization exceeds ${PASSPORT_MAX_BYTES} bytes; nothing written`);
  }

  const state = reconstructJsonlState(ledger.text);
  const provenance = metricProvenanceOf(autoDir, params.metric, link, state.metricName);
  const inputSha256 = sha256Hex(canonicalJson(inputIdentity(params, link, passport)));

  const ops = journalFs(options);
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));
  const recordedAt = now();
  const record: ObservationRecord = {
    v: 1,
    record: OBSERVATION_RECORD_TYPE,
    obs_id: `obs-${recordedAt.getTime().toString(36)}-${randomBytes(4).toString("hex")}`,
    recorded_at: recordedAt.toISOString(),
    ...(params.idempotency_key !== undefined ? { idempotency_key: params.idempotency_key } : {}),
    input_sha256: inputSha256,
    segment_at_record: state.currentSegment,
    epoch_at_record: state.currentEpoch,
    run_segment: null,
    run_epoch: null,
    run_epoch_basis: link.run_epoch_basis,
    observed_run: link.observed_run,
    observed_run_dir: link.observed_run_dir,
    run_started_at: link.run_started_at,
    run_settled: link.run_settled,
    binding: link.binding,
    run_link: link.run_link,
    activity_type: params.activity_type,
    outcome: params.outcome,
    description: params.description,
    metric_provenance: provenance.provenance,
    ...(params.metric !== undefined ? { metric: params.metric } : {}),
    ...(params.metrics !== undefined ? { metrics: params.metrics } : {}),
    ...(params.asi !== undefined ? { asi: params.asi } : {}),
    ...(passport !== null ? { passport } : {}),
  };
  const selfCheck = validateObservationRecord(record as unknown as JsonObject);
  if (selfCheck !== null) return errorResponse("invalid_input", `constructed record failed the schema check: ${selfCheck}`);

  const target = journalTarget(autoDir, "observations");
  const locked = await withJournalLock(
    target,
    (): CriticalOutcome => {
      let text: string;
      try {
        text = readTextIfExists(target.file, ops);
      } catch (error) {
        return { kind: "error", code: "observations_unavailable", message: `cannot read observations.jsonl: ${describeError(error)}`, torn: 0 };
      }
      const existing = readObservations(text);
      const torn = existing.torn_lines;
      if (params.idempotency_key !== undefined) {
        const key = params.idempotency_key;
        const stored = text
          .split("\n")
          .map((line) => (line.trim() === "" ? null : parseJsonlEntry(line)))
          .find((entry) => entry !== null && entry.record === OBSERVATION_RECORD_TYPE && entry.idempotency_key === key);
        if (stored !== undefined && stored !== null) {
          if (stored.input_sha256 === inputSha256) {
            return { kind: "already", record: stored as unknown as ObservationRecord, torn };
          }
          return {
            kind: "error",
            code: "idempotency_conflict",
            message: `idempotency_key "${key}" was already used with different input; nothing written`,
            torn,
          };
        }
      }
      const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (line.length > RECORD_MAX_BYTES) {
        return {
          kind: "error",
          code: "record_too_large",
          message: `record is ${line.length} bytes; limit is ${RECORD_MAX_BYTES} bytes including LF; nothing written`,
          torn,
        };
      }
      return { kind: "write", record, append: appendRecordLocked(target.file, line, ops), torn };
    },
    options,
  );

  if (locked.status === "lock_busy") return errorResponse(locked.code, locked.message);
  if (locked.status === "lock_failed") return errorResponse("observation_lock_failed", locked.message);

  const releaseWarnings = locked.warnings.map((warning) => warning.code);
  const outcome = locked.value;
  const dedup: "key" | "none" = params.idempotency_key !== undefined ? "key" : "none";
  const warnings = [...link.warnings, ...provenance.warnings, ...releaseWarnings];
  if (link.run_epoch_basis !== "proven") warnings.push("run_epoch_unknown");

  if (outcome.kind === "error") return errorResponse(outcome.code, outcome.message);
  if (outcome.kind === "already") {
    return successFromRecord(outcome.record, "already_recorded", outcome.torn, dedup, releaseWarnings);
  }
  if (outcome.append.status === "failed") {
    return errorResponse(
      "record_write_failed",
      outcome.append.torn
        ? `${outcome.append.message}. Retrying with the same idempotency_key is safe.`
        : outcome.append.message,
    );
  }
  if (outcome.append.status === "fsync_failed") warnings.push("fsync_failed");
  warnings.push(...outcome.append.warnings);
  return successFromRecord(outcome.record, "appended", outcome.torn, dedup, [...new Set(warnings)]);
}

// ---------------------------------------------------------------------------
// Tool shape (§7.3). Registration in index.ts is a separate step (S3).
// ---------------------------------------------------------------------------

/** JSON schema of the tool input (§7.3). Declares the agent input only; system fields are absent. */
export const LOG_OBSERVATION_PARAMETERS = {
  type: "object",
  required: ["outcome", "description"],
  additionalProperties: false,
  properties: {
    linked_run: { oneOf: [{ const: "last" }, { type: "integer", minimum: 1 }], default: "last" },
    activity_type: { enum: ["intermediate", "attribution"], default: "intermediate" },
    outcome: { enum: ["success", "technical_failure", "unknown"] },
    description: { type: "string", minLength: 1, maxLength: 500 },
    metric: { type: "number" },
    metrics: { type: "object", additionalProperties: { type: "number" }, maxProperties: 16 },
    asi: { type: "object" },
    passport: {
      type: "object",
      additionalProperties: false,
      required: ["components"],
      properties: {
        components: {
          type: "object",
          maxProperties: 16,
          propertyNames: { pattern: "^[a-z][a-z0-9_]{0,31}$" },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              ref: { type: ["string", "null"] },
              declared_sha256: { type: ["string", "null"], pattern: "^[0-9a-fA-F]{64}$" },
            },
          },
        },
      },
    },
    idempotency_key: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
  },
} as const;

export const LOG_OBSERVATION_TOOL_NAME = "log_observation";

/**
 * Tool-shaped object: name, label, description, parameters and an `execute` that returns the
 * text content plus structured details. Bound to one `.auto` directory; not registered anywhere.
 */
export function createLogObservationTool(autoDir: string, options: LogObservationOptions = {}) {
  return {
    name: LOG_OBSERVATION_TOOL_NAME,
    label: "Log observation",
    description:
      "Record a preparation or diagnostic step as a separate observation. It is not a run: it does not " +
      "change git, the working tree, best, streak or the run ledger. Outcome is success, technical_failure or unknown.",
    parameters: LOG_OBSERVATION_PARAMETERS,
    async execute(_toolCallId: string, params: unknown) {
      const response = await logObservation(autoDir, params, options);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
        details: response,
      };
    },
  };
}
