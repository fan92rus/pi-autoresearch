/**
 * Agent assessment of precedent candidates: the `assess_precedents` tool
 * (research-precedent-search, task 2.2).
 *
 * assessPrecedents(workDir, input) appends an agent assessment to an existing
 * search report (`.auto/precedents/<id>.json`, same id as in task 2.1):
 *   1. Validates the input (report_id, primary_ref, action, optional claim with
 *      follow_up_ref, optional judgment texts). Invalid input changes nothing.
 *   2. Loads the report and checks that `primary_ref` matches one of its
 *      candidates exactly (source, path and line/pointer): the primary record.
 *   3. Checks report freshness with the source hashes of task 2.1
 *      (checkPrecedentReportFreshness): the freshness state is recorded in the
 *      assessment facts and echoed to the agent, never claimed fresh when it is
 *      not. A stale or unknown report is still assessable, but the output says
 *      to repeat `search_precedents` before relying on it.
 *   4. With a claim (`supports` / `contradicts`), verifies the follow-up
 *      reference against the CURRENT ledger: a bounded read must deliver a
 *      parsed record at exactly that path and physical line. Only existence and
 *      bounds are checked — not the truth of the agent's interpretation.
 *   5. Appends the assessment (facts vs judgments, see below), computes the
 *      candidate classification and writes the report back atomically.
 *
 * Classification of a candidate (computed from its claim-bearing assessments):
 *   `contradicted` only with an agent-assessed explicit refutation, `supported`
 *   only with an agent-assessed documented follow-up confirmation of validity,
 *   `conflicting` with incompatible assessed evidences, `unknown` otherwise —
 *   including every never-assessed candidate and every old keep. Absence of a
 *   found refutation is never support.
 *
 * Judgments vs facts: what the machine verified (references, freshness, time,
 * who assessed) is stored under `facts`; every evaluative text of the agent
 * (claim, action, similarity, differences, risks) is stored under `judgments`
 * with the explicit label `agent-judgment`. Source text never enters an
 * assessment: it stays in the search report under `untrusted_content`, and the
 * tool output carries no source text at all.
 *
 * The follow-up reference must cite the campaign ledger (source "log"), the
 * scope of the identifier follow-up of task 1.3; it needs a physical line of a
 * run record written AFTER the primary record of the same ledger, and it is
 * never the primary record itself. Config headers and records without a numeric
 * run are refused; order across sources or files is unknown and refused too.
 * An assessment without a claim (action only) is allowed and never changes the
 * classification.
 *
 * Read-only towards history: assessments live in the report file only; the
 * ledger, tree, ideas and councils are never written. Nothing from any source
 * or judgment text is executed or used as tool arguments.
 *
 * Non-goals (later tasks): memory adapter (2.3), council/observer delivery (3.x).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPORT_DIR_REL,
  REPORT_SCHEMA,
  checkPrecedentReportFreshness,
  type PrecedentReport,
  type ReportFreshness,
  type VersionChildOptions,
} from "./precedent-report.ts";
import { isAutoresearchConfigEntry, isAutoresearchRunEntry } from "./jsonl.ts";
import {
  createBudget,
  guardPathInsideRoot,
  readLedgerSource,
  resolveSourceRoot,
  type PrecedentSourceRef,
  type SourceReadResult,
} from "./precedent-sources.ts";

// ─── Limits and constants ────────────────────────────────────────────────────

export const ASSESS_SCHEMA = "precedent-assess/1" as const;
export const ASSESSMENTS_SCHEMA = "precedent-assessments/1" as const;
export const ASSESS_PRECEDENTS_TOOL_NAME = "assess_precedents";
/** Judgment text limit (similarity, differences, risks). */
export const ASSESS_MAX_TEXT_CHARS = 500;
export const ASSESS_MAX_REPORT_ID_CHARS = 60;
export const ASSESS_MAX_REF_PATH_CHARS = 300;
export const ASSESS_MAX_REF_POINTER_CHARS = 200;
/** Bounded ledger read behind the follow-up existence check. */
const VERIFY_MAX_BYTES = 10 * 1048576;
const VERIFY_MAX_ITEMS = 2000;
/** Search report id shape: 12 hex of the fingerprint plus 8 hex of randomness. */
const REPORT_ID_RE = /^[a-f0-9]{12}-[a-f0-9]{8}$/;
/** Control characters, DEL and lone UTF-16 surrogates: JSON would escape them into 6 bytes each. */
const JUDGMENT_FORBIDDEN_RE =
  /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const STALE_NOTE =
  "report is stale or its freshness is unknown: repeat search_precedents before relying on it";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PrecedentClaim = "supports" | "contradicts";
export type PrecedentAction = "reuse" | "adapt-and-test" | "avoid" | "insufficient-evidence";
export type PrecedentClassification = "supported" | "contradicted" | "conflicting" | "unknown";

/** Input of one assessment. `claim` and `follow_up_ref` stand or fall together. */
export interface PrecedentAssessInput {
  report_id: string;
  /** The primary record: must match a candidate of the report exactly. */
  primary_ref: PrecedentSourceRef;
  action: PrecedentAction;
  claim?: PrecedentClaim;
  /** The later record cited by `claim`: a physical line of the campaign ledger. */
  follow_up_ref?: PrecedentSourceRef;
  similarity?: string;
  differences?: string;
  risks?: string;
}

/** What the tool verified itself; no evaluative content. */
export interface PrecedentAssessmentFacts {
  report_id: string;
  /** The primary record (identifies the assessed candidate). */
  primary_ref: PrecedentSourceRef;
  /** The later record, present exactly when `judgments.claim` is present. */
  follow_up_ref?: PrecedentSourceRef;
  /** Freshness of the report at assessment time (source hashes of task 2.1). */
  freshness: ReportFreshness;
  assessed_at: string;
  /** Every claim here is agent-assessed, not machine-proved. */
  assessed_by: "agent";
}

/** The agent's evaluative content, explicitly marked as unverified judgment. */
export interface PrecedentAssessmentJudgments {
  label: "agent-judgment";
  claim?: PrecedentClaim;
  action: PrecedentAction;
  similarity?: string;
  differences?: string;
  risks?: string;
}

export interface PrecedentAssessment {
  facts: PrecedentAssessmentFacts;
  judgments: PrecedentAssessmentJudgments;
  /** Classification of the candidate after this assessment was appended. */
  classification: PrecedentClassification;
}

/** Assessments section appended to a saved report by this module. */
export interface PrecedentAssessmentsSection {
  schema: typeof ASSESSMENTS_SCHEMA;
  items: PrecedentAssessment[];
}

export type AssessedPrecedentReport = PrecedentReport & { assessments?: PrecedentAssessmentsSection };

export interface PrecedentAssessOptions {
  /** Deadline of the freshness version child; defaults to 10 s. */
  deadlineMs?: number;
  /** Monotonic clock in ms behind the freshness deadline; a seam for tests. */
  clock?: () => number;
  now?: () => Date;
  /** Seams of the freshness version child (fake spawn for tests). */
  versions?: Omit<VersionChildOptions, "deadlineMs" | "deadlineAt" | "clock">;
}

export type PrecedentAssessSuccess = {
  ok: true;
  /** The updated report as saved (or as intended, when the save failed). */
  report: AssessedPrecedentReport;
  assessment: PrecedentAssessment;
  classification: PrecedentClassification;
  freshness: ReportFreshness;
  reusable: boolean;
  /** The tool output JSON: assessment summary and statuses, no source text. */
  text: string;
  persisted: { path: string; saved: boolean };
  persistError?: string;
};

export type PrecedentAssessFailure = { ok: false; error: string };

export type PrecedentAssessResult = PrecedentAssessSuccess | PrecedentAssessFailure;

export type ParsedAssessInput = { ok: true; input: PrecedentAssessInput } | { ok: false; error: string };

// ─── Small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const chars = Array.from(text);
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}...` : text;
}

/** Exact identity of a source reference: source, path and line/pointer together. */
export function refEquals(a: PrecedentSourceRef, b: PrecedentSourceRef): boolean {
  return a.source === b.source && a.path === b.path && a.line === b.line && a.pointer === b.pointer;
}

// ─── Input ───────────────────────────────────────────────────────────────────

type RefOutcome = { ok: true; ref: PrecedentSourceRef } | { ok: false; error: string };

/** Validates one source reference object; only the canonical ref keys. */
function parseRef(raw: unknown, field: string): RefOutcome {
  if (!isRecord(raw)) return { ok: false, error: `${field} must be an object` };
  for (const key of Object.keys(raw)) {
    if (key !== "source" && key !== "path" && key !== "line" && key !== "pointer") {
      return { ok: false, error: `${field} has an unknown key: ${key}` };
    }
  }
  if (raw.source !== "log" && raw.source !== "tree" && raw.source !== "ideas" && raw.source !== "councils") {
    return { ok: false, error: `${field}.source must be one of log, tree, ideas, councils` };
  }
  if (typeof raw.path !== "string") return { ok: false, error: `${field}.path must be text` };
  const refPath = raw.path.trim();
  if (refPath === "") return { ok: false, error: `${field}.path must not be empty` };
  if (Array.from(refPath).length > ASSESS_MAX_REF_PATH_CHARS) {
    return { ok: false, error: `${field}.path must be at most ${ASSESS_MAX_REF_PATH_CHARS} characters` };
  }
  const ref: PrecedentSourceRef = { source: raw.source, path: refPath };
  if (raw.line !== undefined) {
    if (typeof raw.line !== "number" || !Number.isSafeInteger(raw.line) || raw.line < 1) {
      return { ok: false, error: `${field}.line must be a positive integer` };
    }
    ref.line = raw.line;
  }
  if (raw.pointer !== undefined) {
    if (typeof raw.pointer !== "string" || raw.pointer.trim() === "") {
      return { ok: false, error: `${field}.pointer must be non-empty text` };
    }
    if (Array.from(raw.pointer).length > ASSESS_MAX_REF_POINTER_CHARS) {
      return { ok: false, error: `${field}.pointer must be at most ${ASSESS_MAX_REF_POINTER_CHARS} characters` };
    }
    if (ref.line !== undefined) return { ok: false, error: `${field} cannot have both line and pointer` };
    ref.pointer = raw.pointer;
  }
  return { ok: true, ref };
}

/**
 * One optional judgment text: trimmed, non-empty, capped. At most 500 code
 * points of at most 4 UTF-8 bytes each keep the tool output within 8 KiB.
 */
function parseText(raw: unknown, field: string): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: `${field} must be text` };
  const text = raw.trim();
  if (text === "") return { ok: false, error: `${field} must not be empty` };
  if (Array.from(text).length > ASSESS_MAX_TEXT_CHARS) {
    return { ok: false, error: `${field} must be at most ${ASSESS_MAX_TEXT_CHARS} characters` };
  }
  if (JUDGMENT_FORBIDDEN_RE.test(text)) {
    return { ok: false, error: `${field} must not contain control characters or lone surrogates` };
  }
  return { ok: true, text };
}

/**
 * Order check of a claim. The follow-up must be a different record of the same
 * campaign ledger, written after the primary one (a later physical line). The
 * order across sources or files is unknown (spec: relations between files
 * without time are unknown), so such a claim is refused, not guessed.
 * Returns the refusal text, or null when the pair is admissible.
 */
export function followUpOrderError(primary: PrecedentSourceRef, followUp: PrecedentSourceRef): string | null {
  if (refEquals(primary, followUp)) return "follow_up_ref must be a different record than primary_ref";
  if (followUp.source !== "log" || primary.source !== "log") {
    return "follow_up_ref and primary_ref must both be campaign ledger records: order across sources is unknown";
  }
  if (primary.line === undefined) return "primary_ref must be a ledger line to order a follow-up after it";
  if (followUp.path !== primary.path) {
    return "follow_up_ref must be in the same campaign ledger as primary_ref: order across files is unknown";
  }
  if (followUp.line === undefined) return "follow_up_ref.line is required: the physical line of the later record";
  if (followUp.line <= primary.line) {
    return `follow_up_ref must be a record written after primary_ref: line ${followUp.line} is not after line ${primary.line}`;
  }
  return null;
}

/**
 * Validates raw tool arguments. Nothing is loaded, checked or written for
 * invalid input.
 */
export function parseAssessInput(raw: unknown): ParsedAssessInput {
  const fail = (error: string): ParsedAssessInput => ({ ok: false, error });
  if (!isRecord(raw)) return fail("arguments must be an object");
  for (const key of Object.keys(raw)) {
    if (
      key !== "report_id" && key !== "primary_ref" && key !== "action" && key !== "claim" &&
      key !== "follow_up_ref" && key !== "similarity" && key !== "differences" && key !== "risks"
    ) {
      return fail(`unknown argument: ${key}`);
    }
  }

  if (typeof raw.report_id !== "string") return fail("report_id is required and must be text");
  const reportId = raw.report_id.trim();
  if (reportId === "") return fail("report_id must not be empty");
  if (reportId.length > ASSESS_MAX_REPORT_ID_CHARS) {
    return fail(`report_id must be at most ${ASSESS_MAX_REPORT_ID_CHARS} characters`);
  }
  if (!REPORT_ID_RE.test(reportId)) return fail("report_id must look like <12 hex>-<8 hex>");

  if (raw.primary_ref === undefined) return fail("primary_ref is required: the primary record of the candidate");
  const primary = parseRef(raw.primary_ref, "primary_ref");
  if (!primary.ok) return fail(primary.error);

  if (raw.action === undefined) {
    return fail("action is required: one of reuse, adapt-and-test, avoid, insufficient-evidence");
  }
  if (raw.action !== "reuse" && raw.action !== "adapt-and-test" && raw.action !== "avoid" && raw.action !== "insufficient-evidence") {
    return fail("action must be one of reuse, adapt-and-test, avoid, insufficient-evidence");
  }

  let claim: PrecedentClaim | undefined;
  if (raw.claim !== undefined) {
    if (raw.claim !== "supports" && raw.claim !== "contradicts") {
      return fail('claim must be "supports" or "contradicts"');
    }
    claim = raw.claim;
  }

  let followUp: PrecedentSourceRef | undefined;
  if (raw.follow_up_ref !== undefined) {
    const parsed = parseRef(raw.follow_up_ref, "follow_up_ref");
    if (!parsed.ok) return fail(parsed.error);
    if (parsed.ref.source !== "log") {
      return fail('follow_up_ref must reference the campaign ledger (source "log")');
    }
    if (parsed.ref.pointer !== undefined) {
      return fail("follow_up_ref must be a ledger line reference (no pointer)");
    }
    if (parsed.ref.line === undefined) {
      return fail("follow_up_ref.line is required: the physical line of the later record");
    }
    followUp = parsed.ref;
  }
  if (claim !== undefined && followUp === undefined) {
    return fail("follow_up_ref is required with claim: cite the later record the claim is about");
  }
  if (followUp !== undefined && claim === undefined) {
    return fail("claim is required when follow_up_ref is set: say whether it supports or contradicts");
  }
  if (followUp !== undefined) {
    const orderError = followUpOrderError(primary.ref, followUp);
    if (orderError !== null) return fail(orderError);
  }

  const input: PrecedentAssessInput = {
    report_id: reportId,
    primary_ref: primary.ref,
    action: raw.action,
  };
  if (claim !== undefined) input.claim = claim;
  if (followUp !== undefined) input.follow_up_ref = followUp;
  for (const field of ["similarity", "differences", "risks"] as const) {
    if (raw[field] === undefined) continue;
    const text = parseText(raw[field], field);
    if (!text.ok) return fail(text.error);
    input[field] = text.text;
  }
  return { ok: true, input };
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classification of one candidate from its claim-bearing assessments: an
 * explicit assessed refutation gives `contradicted`, an assessed follow-up
 * confirmation of validity gives `supported`, both give `conflicting`; without
 * assessments — `unknown`, never `supported` by default.
 */
export function classificationFor(
  items: readonly PrecedentAssessment[],
  ref: PrecedentSourceRef,
): PrecedentClassification {
  let supports = false;
  let contradicts = false;
  for (const item of items) {
    if (!refEquals(item.facts.primary_ref, ref)) continue;
    if (item.judgments.claim === "supports") supports = true;
    if (item.judgments.claim === "contradicts") contradicts = true;
  }
  if (supports && contradicts) return "conflicting";
  if (contradicts) return "contradicted";
  if (supports) return "supported";
  return "unknown";
}

// ─── Report file ─────────────────────────────────────────────────────────────

export type LoadedReport =
  | { ok: true; report: AssessedPrecedentReport }
  | { ok: false; error: string };

/** Loads and structurally validates `.auto/precedents/<id>.json` inside the root. */
export function loadPrecedentReport(rootReal: string | null, id: string): LoadedReport {
  if (rootReal === null) return { ok: false, error: "project root not found" };
  if (!REPORT_ID_RE.test(id)) return { ok: false, error: "report_id must look like <12 hex>-<8 hex>" };
  const dirAbs = path.join(rootReal, ...REPORT_DIR_REL.split("/"));
  const guard = guardPathInsideRoot(rootReal, dirAbs);
  if (!guard.ok) return { ok: false, error: "report directory escapes the project root" };
  let text: string;
  try {
    text = fs.readFileSync(path.join(guard.real, `${id}.json`), "utf8");
  } catch {
    return { ok: false, error: `report ${id} not found under ${REPORT_DIR_REL}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `report ${id} is not valid JSON` };
  }
  if (!isRecord(parsed) || parsed.schema !== REPORT_SCHEMA) {
    return { ok: false, error: `report ${id} is not a ${REPORT_SCHEMA} report` };
  }
  if (parsed.id !== id) return { ok: false, error: `report file id does not match ${id}` };
  if (!isRecord(parsed.search) || !Array.isArray(parsed.search.candidates)) {
    return { ok: false, error: `report ${id} has no candidates section` };
  }
  if (parsed.assessments !== undefined) {
    const section = parsed.assessments;
    if (!isRecord(section) || section.schema !== ASSESSMENTS_SCHEMA || !Array.isArray(section.items)) {
      return { ok: false, error: `report ${id} has an invalid assessments section` };
    }
  }
  return { ok: true, report: parsed as AssessedPrecedentReport };
}

type SaveOutcome = { saved: true } | { saved: false; reason: string };

/**
 * Writes the updated report atomically over `.auto/precedents/<id>.json`.
 * Existing `.auto` or `.auto/precedents` entries must resolve inside the root,
 * otherwise nothing is written.
 */
function saveAssessedReport(rootReal: string, id: string, text: string): SaveOutcome {
  const autoAbs = path.join(rootReal, ".auto");
  const dirAbs = path.join(rootReal, ...REPORT_DIR_REL.split("/"));
  try {
    for (const probe of [autoAbs, dirAbs]) {
      if (!fs.existsSync(probe)) continue;
      if (!guardPathInsideRoot(rootReal, probe).ok) return { saved: false, reason: "report directory escapes the root" };
    }
    fs.mkdirSync(dirAbs, { recursive: true });
    const guard = guardPathInsideRoot(rootReal, dirAbs);
    if (!guard.ok) return { saved: false, reason: "report directory escapes the root" };
    const target = path.join(guard.real, `${id}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, target);
    return { saved: true };
  } catch (err) {
    return { saved: false, reason: errorText(err) };
  }
}

// ─── Follow-up existence check ───────────────────────────────────────────────

export type FollowUpVerification =
  | { ok: true; ledger: "current" | "legacy"; path: string }
  | { ok: false; error: string };

/**
 * Existence and bounds of the cited later record: one bounded read of the
 * current ledger must deliver a PARSED record at exactly this path and physical
 * line. The read never stops early, so its coverage status stays honest, and
 * the check says nothing about what the record means.
 */
export async function verifyFollowUpRef(
  rootReal: string | null,
  want: PrecedentSourceRef,
): Promise<FollowUpVerification> {
  if (rootReal === null) return { ok: false, error: "project root not found" };
  if (want.source !== "log" || want.line === undefined) {
    return { ok: false, error: "follow-up reference must be a physical ledger line" };
  }
  const hits: Array<"run" | "other"> = [];
  const read: SourceReadResult = await readLedgerSource(
    rootReal,
    (record) => {
      if (record.ref.line === want.line && record.ref.path === want.path) {
        const isRun = isAutoresearchRunEntry(record.data) && !isAutoresearchConfigEntry(record.data);
        hits.push(isRun ? "run" : "other");
      }
      return true;
    },
    { budget: createBudget({ maxBytes: VERIFY_MAX_BYTES, maxItems: VERIFY_MAX_ITEMS }) },
  );
  const at = `line ${want.line} of ${read.path ?? want.path}`;
  if (hits.includes("run")) return { ok: true, ledger: read.ledger ?? "current", path: read.path ?? want.path };
  if (hits.length > 0) {
    return { ok: false, error: `follow_up_ref must cite a run record: ${at} is a config header or has no numeric run` };
  }
  if (read.status === "unavailable") {
    return { ok: false, error: "campaign ledger is missing: the cited later record cannot be verified" };
  }
  if (read.status === "truncated") {
    return { ok: false, error: `the cited later record could not be verified: ledger read truncated (${read.truncatedBy})` };
  }
  if (read.status === "error") {
    return { ok: false, error: `the cited later record could not be verified: ${read.error ?? "ledger read error"}` };
  }
  return { ok: false, error: `no parsed ledger record at ${at}` };
}

// ─── Assessment ──────────────────────────────────────────────────────────────

/**
 * Appends one agent assessment to the report and returns the updated state.
 * The report file is rewritten only after every check passed; a failed save is
 * reported through `persisted`/`persistError`, like in the search report.
 */
export async function assessPrecedents(
  workDir: string,
  input: PrecedentAssessInput,
  options: PrecedentAssessOptions = {},
): Promise<PrecedentAssessResult> {
  if (!isRecord(input)) return { ok: false, error: "assessment input must be an object" };
  const rootReal = resolveSourceRoot(workDir);
  if (rootReal === null) return { ok: false, error: "project root not found" };
  const loaded = loadPrecedentReport(rootReal, input.report_id);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const report = loaded.report;

  const candidate = report.search.candidates.find((item) => refEquals(item.ref, input.primary_ref));
  if (!candidate) {
    return { ok: false, error: `primary_ref does not match any candidate of report ${report.id}` };
  }

  // Freshness from the source hashes of task 2.1, in its own bounded child.
  const { freshness, reusable } = await checkPrecedentReportFreshness(workDir, report, {
    ...options.versions,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  // A claim always cites a later record of the same ledger, and the citation must resolve now.
  const followUp = input.follow_up_ref;
  if (followUp !== undefined) {
    const orderError = followUpOrderError(input.primary_ref, followUp);
    if (orderError !== null) return { ok: false, error: orderError };
    const verification = await verifyFollowUpRef(rootReal, followUp);
    if (!verification.ok) return { ok: false, error: verification.error };
  }

  // Re-read after the last await: the read-append-write below is synchronous,
  // so a concurrent assessment of the same report can not be overwritten.
  const latest = loadPrecedentReport(rootReal, report.id);
  if (!latest.ok) return { ok: false, error: latest.error };
  const current = latest.report;
  const items: PrecedentAssessment[] = current.assessments?.items.slice() ?? [];
  const item: PrecedentAssessment = {
    facts: {
      report_id: report.id,
      primary_ref: { ...input.primary_ref },
      ...(input.follow_up_ref !== undefined ? { follow_up_ref: { ...input.follow_up_ref } } : {}),
      freshness,
      assessed_at: (options.now ?? (() => new Date()))().toISOString(),
      assessed_by: "agent",
    },
    judgments: {
      label: "agent-judgment",
      ...(input.claim !== undefined ? { claim: input.claim } : {}),
      action: input.action,
      ...(input.similarity !== undefined ? { similarity: input.similarity } : {}),
      ...(input.differences !== undefined ? { differences: input.differences } : {}),
      ...(input.risks !== undefined ? { risks: input.risks } : {}),
    },
    classification: "unknown",
  };
  items.push(item);
  item.classification = classificationFor(items, candidate.ref);

  const updated: AssessedPrecedentReport = {
    ...current,
    assessments: { schema: ASSESSMENTS_SCHEMA, items },
  };
  const relPath = `${REPORT_DIR_REL}/${report.id}.json`;
  const save = saveAssessedReport(rootReal, report.id, JSON.stringify(updated));

  const output = {
    schema: ASSESS_SCHEMA,
    report_id: report.id,
    assessment: item,
    classification: item.classification,
    classification_basis: "agent-assessed claims over the cited records; not machine-verified",
    freshness,
    reusable,
    assessments_total: items.length,
    persisted: { path: relPath, saved: save.saved },
    ...(save.saved ? {} : { persist_error: save.reason }),
    ...(freshness === "fresh" ? {} : { note: STALE_NOTE }),
  };
  return {
    ok: true,
    report: updated,
    assessment: item,
    classification: item.classification,
    freshness,
    reusable,
    text: JSON.stringify(output),
    persisted: { path: relPath, saved: save.saved },
    ...(save.saved ? {} : { persistError: save.reason }),
  };
}

// ─── Tool registration ───────────────────────────────────────────────────────

interface RegisterToolLike {
  registerTool(tool: unknown): void;
}

/**
 * Registers `assess_precedents` next to `search_precedents`: standalone, not
 * gated on autoresearch mode or an active campaign. It appends agent
 * assessments to an existing search report and never writes history sources.
 */
export function registerAssessPrecedentsTool(
  pi: RegisterToolLike,
  resolveWorkDir: (cwd: string) => string = (cwd) => cwd,
  options: PrecedentAssessOptions = {},
): void {
  pi.registerTool({
    name: ASSESS_PRECEDENTS_TOOL_NAME,
    label: "Assess precedents",
    description:
      "Записывает оценку агента для кандидата из отчёта search_precedents в тот же отчёт " +
      "(по его id). Проверяет ссылки на обе записи — первичную (кандидат отчёта) и " +
      "последующую (строка леджера), фиксирует свежесть отчёта по хешам источников и " +
      "вычисляет классификацию: supported, contradicted, conflicting или unknown " +
      "(по умолчанию unknown, включая старые keep). Решение: reuse, adapt-and-test, " +
      "avoid или insufficient-evidence. Оценочные тексты сохраняются как суждения " +
      "(agent-judgment), отдельно от проверенных фактов; исторический исход не " +
      "устанавливает действие автоматически.",
    promptSnippet: "Record an agent assessment (claim + action) of a precedent candidate in a search report",
    parameters: {
      type: "object",
      properties: {
        report_id: { type: "string", description: "id отчёта search_precedents" },
        primary_ref: {
          type: "object",
          description: "Ссылка на первичную запись: ref кандидата из отчёта (source, path, line/pointer)",
          properties: {
            source: { type: "string", enum: ["log", "tree", "ideas", "councils"] },
            path: { type: "string" },
            line: { type: "number" },
            pointer: { type: "string" },
          },
          required: ["source", "path"],
          additionalProperties: false,
        },
        claim: {
          type: "string",
          enum: ["supports", "contradicts"],
          description:
            'Утверждение агента о последующей записи: "supports" (подтверждение валидности) ' +
            'или "contradicts" (явное опровержение); требует follow_up_ref',
        },
        follow_up_ref: {
          type: "object",
          description: 'Ссылка на последующую запись: строка леджера (source "log", path, line)',
          properties: {
            source: { type: "string", enum: ["log"] },
            path: { type: "string" },
            line: { type: "number" },
          },
          required: ["source", "path", "line"],
          additionalProperties: false,
        },
        action: {
          type: "string",
          enum: ["reuse", "adapt-and-test", "avoid", "insufficient-evidence"],
          description: "Решение по кандидату",
        },
        similarity: { type: "string", description: "Причина сходства (суждение), до 500 символов" },
        differences: { type: "string", description: "Различия условий (суждение), до 500 символов" },
        risks: { type: "string", description: "Риски переноса (суждение), до 500 символов" },
      },
      required: ["report_id", "primary_ref", "action"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const parsed = parseAssessInput(params);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: `❌ ${parsed.error}` }], details: {} };
      }
      const result = await assessPrecedents(resolveWorkDir(ctx.cwd), parsed.input, options);
      if (!result.ok) {
        return { content: [{ type: "text", text: `❌ ${result.error}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          report_id: result.report.id,
          classification: result.classification,
          freshness: result.freshness,
          reusable: result.reusable,
          assessments: result.report.assessments?.items.length ?? 0,
          persisted: result.persisted,
          ...(result.persistError === undefined ? {} : { persistError: result.persistError }),
        },
      };
    },
  });
}
