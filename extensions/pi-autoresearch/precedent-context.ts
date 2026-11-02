/**
 * Identifier follow-up over the campaign ledger (research-precedent-search, task 1.3).
 *
 * The second pass runs after the text search of precedent-search.ts, with its
 * own budget and its own coverage status; the first pass is never changed by it.
 *
 * Identity keys of a candidate (built by candidateIdentity from the record of the first pass):
 *   run:<segment>/<run>   ledger run entry; the segment is reconstructed exactly as jsonl.ts does
 *   commit:<sha>          `commit` of a ledger run entry or of a tree node
 *   node:<id>             tree node id (tree.json pointer /nodes/<id>)
 *   doc:<path>            root-relative path of an ideas/councils file (literal reference)
 *
 * For every candidate the ledger (`.auto/log.jsonl`, else legacy `autoresearch.jsonl`)
 * is streamed once and searched for records that carry its keys:
 *   - a match is a later record (higher physical line) carrying a key; a candidate
 *     without a ledger position (tree/ideas/councils) matches any record carrying a
 *     key, and its ordering is reported as `unknown`;
 *   - a context link is a ledger record within ±10 delivered records of a match:
 *     exactly the 10 records before and the 10 after; the 11th is excluded;
 *   - a conflict is a run/commit/node key carried by two or more ledger records.
 *
 * Nothing here concludes support or contradiction. A shared identifier is not
 * proof of a relation: links are candidates for the agent to review, and the
 * classification is always `unknown`. A record without identifiers reaches the
 * agent only as context of a match, never as a match of its own.
 *
 * Scale: every ledger record gets the metric scale (metricName/metricUnit) in
 * effect in its segment. A link is marked same / different / unknown against the
 * candidate's scale. No metric delta is computed.
 *
 * Streaming and output: a ring of the last 10 records is the only history kept,
 * so memory does not grow with the ledger. Per candidate at most
 * FOLLOW_UP_MAX_LINKS matches are returned with their text, and at most
 * FOLLOW_UP_MAX_CONTEXT_LINES context records as line references only; the
 * counts stay exact. A truncated stream yields partial results with coverage
 * `truncated`, never `searched`.
 *
 * Read-only: the ledger is read through readLedgerSource (root-bound, bounded).
 */

import {
  createBudget,
  readLedgerSource,
  type PrecedentSourceRef,
  type PrecedentSourceStatus,
  type PrecedentTruncation,
  type SourceBudget,
} from "./precedent-sources.ts";

// ─── Limits ──────────────────────────────────────────────────────────────────

export const FOLLOW_UP_RADIUS = 10;
export const FOLLOW_UP_MAX_BYTES = 10 * 1048576;
export const FOLLOW_UP_MAX_ITEMS = 2000;
/** Match links returned per candidate, in ledger order. */
export const FOLLOW_UP_MAX_LINKS = 6;
/** Context line references returned per candidate, in ledger order (references only, no text). */
export const FOLLOW_UP_MAX_CONTEXT_LINES = 40;

const CONFLICT_REFS_MAX = 5;
const SNIPPET_MAX_CHARS = 100;
const SCALE_FIELD_MAX_CHARS = 64;
const ERROR_MAX_CHARS = 200;
const LEAF_MAX_DEPTH = 8;
const RUN_STATUSES: ReadonlySet<string> = new Set(["keep", "discard", "crash", "checks_failed", "budget_exceeded", "explore"]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MetricScale {
  name: string;
  unit: string;
}

/** Where a ledger record sits: its segment and the metric scale in effect there (null before any config header). */
export interface LedgerPosition {
  segment: number;
  scale: MetricScale | null;
}

/** Identifier keys and metric scale of one first-pass candidate. */
export interface CandidateIdentity {
  keys: string[];
  scale: MetricScale | null;
}

/** `not-run` means no ledger read happened because there was nothing to search for. */
export type FollowUpStatus = PrecedentSourceStatus | "not-run";

/** Why the follow-up pass stopped: its own budget/visitor/abort, or the parent's deadline. */
export type FollowUpTruncation = PrecedentTruncation | "deadline";

export type ScaleRelation = "same" | "different" | "unknown";

/** A ledger record that carries an identifier of the candidate. */
export interface FollowUpLink {
  ref: PrecedentSourceRef;
  /** Identifier keys this record carries. */
  keys: string[];
  metric?: number;
  status?: string;
  scale: MetricScale | null;
  /** Scale comparison with the candidate. No metric delta is ever computed. */
  scale_relation: ScaleRelation;
  /** Record text, labelled as untrusted data: never executed, never used as tool arguments. */
  untrusted_content: { label: "untrusted-source-text"; text: string };
}

export interface IdentifierConflict {
  identifier: string;
  /** Ledger records carrying the identifier, including the candidate's own record. */
  records: number;
  refs: PrecedentSourceRef[];
}

export interface FollowUpCandidate {
  coverage: FollowUpStatus;
  reason?: "no-identifiers";
  identifiers: string[];
  ordering: "ledger-line" | "unknown";
  conflicts: IdentifierConflict[];
  /** Later ledger records carrying an identifier of this candidate (exact count). */
  matches: number;
  links: FollowUpLink[];
  links_omitted: number;
  /** Ledger records within ±10 of a match, excluding the matches themselves (exact count). */
  context: number;
  /** Physical lines of the context records, ascending; references only, their text is read from the ledger. */
  context_lines: number[];
  context_omitted: number;
  /** Always `unknown`: identifier matches are links for review, not conclusions. */
  classification: "unknown";
}

export interface FollowUpReport {
  status: FollowUpStatus;
  reason?: "no-candidates" | "no-identifiers";
  scope: "log";
  radius: number;
  candidatesWithIdentifiers: number;
  path?: string;
  ledger?: "current" | "legacy";
  truncatedBy?: FollowUpTruncation;
  error?: string;
  bytes: number;
  items: number;
  records: number;
}

export interface FollowUpInput {
  ref: PrecedentSourceRef;
  identity: CandidateIdentity;
}

export interface FollowUpOptions {
  /** Budget of this pass only; defaults to 10 MiB / 2000 items, independent of the first pass. */
  budget?: SourceBudget;
}

export interface FollowUpResult {
  report: FollowUpReport;
  /** Index-aligned with the inputs. */
  candidates: FollowUpCandidate[];
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** Case, Unicode and separator normalization shared by keys and ledger text. */
export function normalizeIdentifier(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\\/g, "/").trim();
}

function leafStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > LEAF_MAX_DEPTH) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) leafStrings(item, depth + 1, out);
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) leafStrings(value[key], depth + 1, out);
  }
  return out;
}

function snippetOf(data: unknown): string {
  const flat = leafStrings(data).join(" | ").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > SNIPPET_MAX_CHARS ? `${chars.slice(0, SNIPPET_MAX_CHARS).join("")}...` : flat;
}

const WORD_BEFORE = /[\p{L}\p{M}\p{N}_]$/u;
/** A word character follows, or a joiner (. / -) that continues a word: "x.md.bak" continues "x.md", "n1." does not. */
const WORD_AFTER = /^(?:[\p{L}\p{M}\p{N}_]|[./-](?=[\p{L}\p{M}\p{N}_]))/u;

/**
 * Literal occurrence of an identifier with word boundaries on both sides, so
 * "n1" does not match "n10", "xn1" or "n1.5". Both arguments must be normalized.
 */
export function containsIdentifier(haystack: string, identifier: string): boolean {
  if (identifier === "") return false;
  let at = haystack.indexOf(identifier);
  while (at !== -1) {
    const before = haystack.slice(Math.max(0, at - 2), at);
    const after = haystack.slice(at + identifier.length, at + identifier.length + 2);
    if (!WORD_BEFORE.test(before) && !WORD_AFTER.test(after)) return true;
    at = haystack.indexOf(identifier, at + 1);
  }
  return false;
}

function runKey(segment: number, run: number): string {
  return `run:${segment}/${run}`;
}

function isConflictKey(key: string): boolean {
  return !key.startsWith("doc:");
}

// ─── Ledger position (mirrors jsonl.ts reconstructJsonlState) ────────────────

/**
 * Tracks segment and metric scale while a ledger is streamed in order. The
 * rules are those of reconstructJsonlState: a config header starts a new
 * segment only when it is not the first header and at least one run came before
 * it; metricName/metricUnit are taken from every config header that sets them.
 */
export class LedgerTracker {
  private segment = 0;
  private headerSeen = false;
  private runsSeen = 0;
  private metricName = "metric";
  private metricUnit = "";

  observe(data: unknown): LedgerPosition {
    if (isRecord(data)) {
      if (data.type === "config") {
        if (this.headerSeen && this.runsSeen > 0) this.segment++;
        this.headerSeen = true;
        if (typeof data.metricName === "string") this.metricName = data.metricName;
        if (typeof data.metricUnit === "string") this.metricUnit = data.metricUnit;
      } else if (typeof data.run === "number") {
        this.runsSeen++;
      }
    }
    return {
      segment: this.segment,
      scale: this.headerSeen ? { name: this.metricName, unit: this.metricUnit } : null,
    };
  }
}

/**
 * Identity keys of a first-pass record. `position` is the ledger position of a
 * log record (from LedgerTracker) and null for every other source.
 */
export function candidateIdentity(
  ref: PrecedentSourceRef,
  data: unknown,
  position: LedgerPosition | null,
): CandidateIdentity {
  const keys = new Set<string>();
  if (ref.source === "log" && position && isRecord(data) && typeof data.run === "number") {
    keys.add(normalizeIdentifier(runKey(position.segment, data.run)));
  }
  if (ref.source === "tree" && ref.pointer?.startsWith("/nodes/")) {
    const id = ref.pointer.slice("/nodes/".length);
    if (id !== "") keys.add(`node:${normalizeIdentifier(id)}`);
  }
  if ((ref.source === "log" || ref.source === "tree") && isRecord(data) && typeof data.commit === "string") {
    const commit = normalizeIdentifier(data.commit);
    if (commit !== "") keys.add(`commit:${commit}`);
  }
  if (ref.source === "ideas" || ref.source === "councils") {
    keys.add(`doc:${normalizeIdentifier(ref.path)}`);
  }
  const scale = ref.source === "log" && position ? position.scale : null;
  return { keys: [...keys].sort(), scale };
}

interface CarriedKeys {
  /** Every wanted key the record mentions: structural fields and literal text. */
  all: Set<string>;
  /** Keys the record carries structurally: its run number in its segment, or its own `commit` field. */
  structural: Set<string>;
}

/**
 * Keys of `wanted` carried by one ledger record. Run keys need the record's
 * segment. A literal mention in free text is a match, but not an ID-bearing
 * record: only structural carriers count towards identifier conflicts.
 */
function carriedKeys(
  data: unknown,
  segment: number,
  wanted: ReadonlySet<string>,
  textKeys: readonly string[],
): CarriedKeys {
  const all = new Set<string>();
  const structural = new Set<string>();
  if (!isRecord(data)) return { all, structural };
  if (typeof data.run === "number") {
    const key = normalizeIdentifier(runKey(segment, data.run));
    if (wanted.has(key)) {
      all.add(key);
      structural.add(key);
    }
  }
  if (typeof data.commit === "string") {
    const key = `commit:${normalizeIdentifier(data.commit)}`;
    if (wanted.has(key)) {
      all.add(key);
      structural.add(key);
    }
  }
  if (textKeys.length > 0) {
    const texts = leafStrings(data).map(normalizeIdentifier);
    for (const key of textKeys) {
      const identifier = key.slice(key.indexOf(":") + 1);
      if (texts.some((text) => containsIdentifier(text, identifier))) all.add(key);
    }
  }
  return { all, structural };
}

function scaleRelation(candidate: MetricScale | null, link: MetricScale | null): ScaleRelation {
  if (!candidate || !link) return "unknown";
  return candidate.name === link.name && candidate.unit === link.unit ? "same" : "different";
}

// ─── Pass ────────────────────────────────────────────────────────────────────

export function emptyFollowUpReport(status: FollowUpStatus, extra: Partial<FollowUpReport> = {}): FollowUpReport {
  return {
    status,
    scope: "log",
    radius: FOLLOW_UP_RADIUS,
    candidatesWithIdentifiers: 0,
    bytes: 0,
    items: 0,
    records: 0,
    ...extra,
  };
}

interface SeenRecord {
  ordinal: number;
  ref: PrecedentSourceRef;
  data: unknown;
  position: LedgerPosition;
}

interface CandidateState {
  keys: string[];
  scale: MetricScale | null;
  /** Physical ledger line of a ledger candidate; null when it has no ledger position. */
  line: number | null;
  lastEmitted: number;
  afterLeft: number;
  matchCount: number;
  contextCount: number;
  matchLinks: FollowUpLink[];
  contextLines: number[];
}

interface OccurrenceCount {
  count: number;
  refs: PrecedentSourceRef[];
}

function newState(input: FollowUpInput): CandidateState {
  const keys = [...new Set(input.identity.keys.map(normalizeIdentifier))].sort();
  return {
    keys,
    scale: input.identity.scale,
    line: input.ref.source === "log" && input.ref.line !== undefined ? input.ref.line : null,
    lastEmitted: 0,
    afterLeft: 0,
    matchCount: 0,
    contextCount: 0,
    matchLinks: [],
    contextLines: [],
  };
}

function addMatch(state: CandidateState, seen: SeenRecord, keys: string[]): void {
  const data = seen.data;
  state.matchCount++;
  state.lastEmitted = seen.ordinal;
  if (state.matchLinks.length >= FOLLOW_UP_MAX_LINKS) return;
  const link: FollowUpLink = {
    ref: seen.ref,
    keys,
    scale: capScale(seen.position.scale),
    scale_relation: scaleRelation(state.scale, seen.position.scale),
    untrusted_content: { label: "untrusted-source-text", text: snippetOf(data) },
  };
  if (isRecord(data)) {
    if (typeof data.metric === "number" && Number.isFinite(data.metric)) link.metric = data.metric;
    if (typeof data.status === "string" && RUN_STATUSES.has(data.status)) link.status = data.status;
  }
  state.matchLinks.push(link);
}

function addContext(state: CandidateState, seen: SeenRecord): void {
  state.contextCount++;
  state.lastEmitted = seen.ordinal;
  if (state.contextLines.length < FOLLOW_UP_MAX_CONTEXT_LINES && seen.ref.line !== undefined) {
    state.contextLines.push(seen.ref.line);
  }
}

function capScale(scale: MetricScale | null): MetricScale | null {
  if (!scale) return null;
  return {
    name: capChars(scale.name, SCALE_FIELD_MAX_CHARS),
    unit: capChars(scale.unit, SCALE_FIELD_MAX_CHARS),
  };
}

function finalizeCandidate(
  state: CandidateState,
  status: FollowUpStatus,
  occurrences: ReadonlyMap<string, OccurrenceCount>,
): FollowUpCandidate {
  const ordering = state.line === null ? "unknown" : "ledger-line";
  if (state.keys.length === 0) {
    return {
      coverage: "not-run",
      reason: "no-identifiers",
      identifiers: [],
      ordering,
      conflicts: [],
      matches: 0,
      links: [],
      links_omitted: 0,
      context: 0,
      context_lines: [],
      context_omitted: 0,
      classification: "unknown",
    };
  }
  const conflicts: IdentifierConflict[] = [];
  for (const key of state.keys) {
    if (!isConflictKey(key)) continue;
    const occurrence = occurrences.get(key);
    if (occurrence && occurrence.count >= 2) {
      conflicts.push({ identifier: key, records: occurrence.count, refs: occurrence.refs.slice() });
    }
  }
  return {
    coverage: status,
    identifiers: state.keys.slice(),
    ordering,
    conflicts,
    matches: state.matchCount,
    links: state.matchLinks.slice(),
    links_omitted: state.matchCount - state.matchLinks.length,
    context: state.contextCount,
    context_lines: state.contextLines.slice(),
    context_omitted: state.contextCount - state.contextLines.length,
    classification: "unknown",
  };
}

/**
 * Second pass: one bounded stream of the ledger, matched against the identity
 * keys of every first-pass candidate. Candidates without keys are reported as
 * `not-run` and do not start a read.
 */
export async function runFollowUpPass(
  rootReal: string | null,
  inputs: readonly FollowUpInput[],
  options: FollowUpOptions = {},
): Promise<FollowUpResult> {
  if (inputs.length === 0) {
    return { report: emptyFollowUpReport("not-run", { reason: "no-candidates" }), candidates: [] };
  }
  const states = inputs.map(newState);
  const wanted = new Set<string>();
  for (const state of states) for (const key of state.keys) wanted.add(key);
  if (wanted.size === 0) {
    return {
      report: emptyFollowUpReport("not-run", { reason: "no-identifiers" }),
      candidates: states.map((state) => finalizeCandidate(state, "not-run", new Map())),
    };
  }

  const textKeys = [...wanted].filter((key) => !key.startsWith("run:"));
  const occurrences = new Map<string, OccurrenceCount>();
  const tracker = new LedgerTracker();
  const ring: SeenRecord[] = [];
  let ordinal = 0;
  const budget = options.budget ?? createBudget({ maxBytes: FOLLOW_UP_MAX_BYTES, maxItems: FOLLOW_UP_MAX_ITEMS });

  const outcome = await readLedgerSource(
    rootReal,
    (record) => {
      ordinal++;
      const position = tracker.observe(record.data);
      const carried = carriedKeys(record.data, position.segment, wanted, textKeys);
      for (const key of carried.structural) {
        const occurrence = occurrences.get(key) ?? { count: 0, refs: [] };
        occurrence.count++;
        if (occurrence.refs.length < CONFLICT_REFS_MAX) occurrence.refs.push(record.ref);
        occurrences.set(key, occurrence);
      }
      const seen: SeenRecord = { ordinal, ref: record.ref, data: record.data, position };
      for (const state of states) {
        if (state.keys.length === 0) continue;
        const hit = state.keys.filter((key) => carried.all.has(key));
        const later = state.line === null || (record.ref.line ?? 0) > state.line;
        if (hit.length > 0 && later) {
          // The 10 records before the match (ring holds exactly those), then the match itself.
          for (const previous of ring) {
            if (previous.ordinal > state.lastEmitted) addContext(state, previous);
          }
          addMatch(state, seen, hit);
          state.afterLeft = FOLLOW_UP_RADIUS;
        } else if (state.afterLeft > 0) {
          addContext(state, seen);
          state.afterLeft--;
        }
      }
      ring.push(seen);
      if (ring.length > FOLLOW_UP_RADIUS) ring.shift();
      return true;
    },
    { budget },
  );

  const status: FollowUpStatus = outcome.status;
  const report = emptyFollowUpReport(status, {
    candidatesWithIdentifiers: states.filter((state) => state.keys.length > 0).length,
    path: outcome.path,
    ledger: outcome.ledger,
    truncatedBy: outcome.truncatedBy,
    error: outcome.error === undefined ? undefined : capChars(outcome.error, ERROR_MAX_CHARS),
    bytes: outcome.bytes,
    items: outcome.items,
    records: outcome.records,
  });
  return {
    report,
    candidates: states.map((state) => finalizeCandidate(state, status, occurrences)),
  };
}
