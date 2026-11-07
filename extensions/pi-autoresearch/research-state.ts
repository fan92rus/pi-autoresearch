/**
 * research-state.ts — standalone foundation for the research-vectors campaign:
 * per-campaign paths, atomic state writes, exclusive lock, pending-operation
 * marker, brief structure validation and SHA-256 brief checks.
 *
 * Scope: openspec/changes/research-vectors design.md §3, §4, §9 and the
 * spec requirements for two-phase start, brief immutability, fail-closed
 * state and manual check; epic pi-autoresearch-2bi.1, task
 * pi-autoresearch-2bi.1.1.
 *
 * Deliberately standalone: no imports from the extension, no UI, no Git, no
 * tool wiring. approval.json is read here but is written only by the consent
 * step (task 2bi.1.4), which is outside this module.
 *
 * What this module guarantees:
 *   - Each campaign lives in its own directory <workDir>/.auto/research/<id>/.
 *     createCampaign refuses an existing directory, so earlier campaigns are
 *     never overwritten.
 *   - State writes are atomic (temporary file, fsync, rename). Leftover
 *     temporary files are ignored by readers.
 *   - One exclusive lock per campaign (lock.json, created with the wx flag).
 *     A busy or unreadable lock refuses the operation. Nothing removes a lock
 *     automatically.
 *   - A pending-operation marker is written before the work and the state
 *     write, and removed only after both succeed. While it exists every state
 *     update refuses with manual_check_required. Nothing is retried or removed
 *     automatically.
 *   - state.json that is unreadable or fails validation refuses every state
 *     update (fail-closed); nothing is repaired.
 *   - brief.json is validated structurally (fixed field set, unique ids,
 *     every question has a rule for each verdict) and identified by the
 *     SHA-256 of its bytes. When approval.json exists, every state update
 *     re-checks the brief hash and refuses with brief_changed on mismatch.
 *
 * Not promised: judgment of rule conditions (design §6), protection against
 * files edited by hand (design §5), durability beyond rename atomicity, power
 * loss, filesystem corruption, or external processes.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

export const RESEARCH_STATE_SCHEMA_VERSION = 1;
export const BRIEF_SCHEMA_VERSION = 1;
export const APPROVAL_SCHEMA_VERSION = 1;
export const BRIEF_FILE = "brief.json";
export const APPROVAL_FILE = "approval.json";
export const STATE_FILE = "state.json";
export const LOCK_FILE = "lock.json";
export const PENDING_OP_FILE = "pending-op.json";

export const VERDICTS = ["confirmed", "rejected", "inconclusive", "waiting_for_data"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Explicit operator token required by manualResolvePendingOp (spec: manual recovery). */
export const OPERATOR_CONFIRMATION = "operator-manual-check-done";

export const CAMPAIGN_PHASES = ["briefing", "research", "stopped"] as const;
export type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

/** Accepted campaign, question, rule and stop-rule identifiers. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const BRIEF_KEYS = [
  "schema_version",
  "goal",
  "plan_source",
  "caveat_block",
  "data_roles",
  "questions",
  "process_metrics",
  "stop_rules",
];
const DATA_ROLE_KEYS = ["explore", "validate", "confirm"];
const QUESTION_KEYS = ["id", "text", "decision_rules", "needs_data"];
const RULE_KEYS = ["id", "verdict", "when"];
const STOP_KEYS = ["id", "when"];
const STATE_KEYS = ["schema_version", "campaign_id", "created_at", "phase"];
const APPROVAL_KEYS = ["schema_version", "brief_sha256", "approved_at", "confirmed"];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CampaignState {
  schema_version: number;
  /** Must equal the campaign directory name. */
  campaign_id: string;
  created_at: string;
  phase: CampaignPhase;
}

export interface DecisionRule {
  id: string;
  verdict: Verdict;
  when: string;
}

export interface BriefQuestion {
  id: string;
  text: string;
  decision_rules: DecisionRule[];
  needs_data: string | null;
}

export interface StopRule {
  id: string;
  when: string;
}

export interface ResearchBrief {
  schema_version: number;
  goal: string;
  plan_source: string;
  caveat_block: string;
  data_roles: { explore: string[]; validate: string[]; confirm: string[] };
  questions: BriefQuestion[];
  process_metrics: string[];
  stop_rules: StopRule[];
}

export interface Approval {
  schema_version: number;
  brief_sha256: string;
  approved_at: string;
  confirmed: true;
}

export interface PendingOp {
  name: string;
  started_at: string;
}

export type RefusalReason =
  | "invalid_argument"
  | "campaign_missing"
  | "campaign_exists"
  | "not_initialized"
  | "state_unreadable"
  | "brief_invalid"
  | "brief_unreadable"
  | "brief_missing"
  | "brief_changed"
  | "brief_approved"
  | "not_approved"
  | "approval_invalid"
  | "lock_busy"
  | "lock_unreadable"
  | "manual_check_required"
  | "invalid_transition"
  | "operation_failed"
  | "io_failed";

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  /** One line, safe to show; control characters are escaped. */
  message: string;
}

export type Result<T> = ({ ok: true } & T) | Refusal;

export type StateDecision = Result<{ next: CampaignState }>;

export interface CampaignInspection {
  status: "uninitialized" | "ready" | "manual_check_required" | "state_unreadable" | "invalid_argument";
  state: CampaignState | null;
  pendingOp: PendingOp | null;
  lockPresent: boolean;
  message: string;
}

export type BriefValidation = { ok: true; brief: ResearchBrief } | { ok: false; errors: string[] };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function refuse(reason: RefusalReason, message: string): Refusal {
  return { ok: false, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Escape control characters so a message stays one honest line. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Quote a user-controlled identifier for a message. */
function quote(s: string): string {
  return oneLine(JSON.stringify(s));
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

function errorText(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

/** True when the path exists or its state cannot be determined (fail-closed). */
async function fileMayExist(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    return errorCode(err) !== "ENOENT";
  }
}

/** Returns the field-set problems of an object: unknown and missing keys. */
function fieldSetProblems(obj: Record<string, unknown>, keys: readonly string[], where: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) problems.push(`${where} has unknown field ${quote(key)}`);
  }
  for (const key of keys) {
    if (!(key in obj)) problems.push(`${where} is missing field ${quote(key)}`);
  }
  return problems;
}

function requireText(v: unknown, where: string, errors: string[]): void {
  if (typeof v !== "string" || v.trim() === "") errors.push(`${where} must be a non-empty string`);
}

function requireStringList(v: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${where} must be an array of strings`);
    return;
  }
  v.forEach((item, i) => {
    if (typeof item !== "string" || item.trim() === "") errors.push(`${where}[${i}] must be a non-empty string`);
  });
}

function requireId(v: unknown, where: string, ids: Map<string, string>, errors: string[]): void {
  if (typeof v !== "string" || !ID_RE.test(v)) {
    errors.push(
      `${where} must start with a letter or digit and contain only letters, digits, '.', '_', '-' (1-64 chars)`,
    );
    return;
  }
  const previous = ids.get(v);
  if (previous) errors.push(`${where} ${quote(v)} duplicates the id at ${previous}`);
  else ids.set(v, where);
}

// ─── Paths and campaigns ─────────────────────────────────────────────────────

/** Root that holds every research campaign of a work directory. */
export function researchRoot(workDir: string): string {
  return join(workDir, ".auto", "research");
}

/** Directory of one campaign. Refuses ids that could escape the root. */
export function resolveCampaignDir(workDir: string, campaignId: string): Result<{ dir: string }> {
  if (typeof workDir !== "string" || workDir.length === 0) {
    return refuse("invalid_argument", "work directory must be a non-empty string");
  }
  if (typeof campaignId !== "string" || !ID_RE.test(campaignId)) {
    return refuse(
      "invalid_argument",
      "campaign id must start with a letter or digit and contain only letters, digits, '.', '_', '-' (1-64 chars)",
    );
  }
  return { ok: true, dir: join(researchRoot(workDir), campaignId) };
}

/**
 * Refusal when dir is not a valid campaign directory: it must end with
 * <root>/<campaignId> where root is a researchRoot of some ancestor. This
 * keeps every mutating primitive inside .auto/research/<id>/ (design §3).
 */
function requireCampaignContained(dir: string): Refusal | null {
  if (typeof dir !== "string" || dir.length === 0) {
    return refuse("invalid_argument", "campaign directory must be a non-empty string");
  }
  const id = basename(dir);
  if (!ID_RE.test(id)) {
    return refuse(
      "invalid_argument",
      "campaign id must start with a letter or digit and contain only letters, digits, '.', '_', '-' (1-64 chars)",
    );
  }
  if (basename(dirname(dir)) !== "research") {
    return refuse(
      "invalid_argument",
      `campaign directory must be <workDir>/.auto/research/<campaign id>; got a directory under ${quote(basename(dirname(dir)))}`,
    );
  }
  if (basename(dirname(dirname(dir))) !== ".auto") {
    return refuse(
      "invalid_argument",
      `campaign directory must be <workDir>/.auto/research/<campaign id>; got a directory under ${quote(basename(dirname(dirname(dir))))}`,
    );
  }
  return null;
}

function stateText(state: CampaignState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/**
 * Creates a new campaign directory and its initial state (phase "briefing").
 * An existing campaign directory is refused and left untouched.
 */
export async function createCampaign(
  workDir: string,
  campaignId: string,
): Promise<Result<{ dir: string; state: CampaignState }>> {
  const resolved = resolveCampaignDir(workDir, campaignId);
  if (!resolved.ok) return resolved;
  const dir = resolved.dir;
  try {
    await mkdir(researchRoot(workDir), { recursive: true });
  } catch (err) {
    return refuse("io_failed", `research root cannot be created (${errorText(err)}); nothing was created`);
  }
  try {
    await mkdir(dir);
  } catch (err) {
    if (errorCode(err) === "EEXIST") {
      return refuse(
        "campaign_exists",
        `campaign ${quote(campaignId)} already exists; a new campaign needs a new id and earlier records are kept`,
      );
    }
    return refuse("io_failed", `campaign directory cannot be created (${errorText(err)}); nothing was created`);
  }
  const state: CampaignState = {
    schema_version: RESEARCH_STATE_SCHEMA_VERSION,
    campaign_id: campaignId,
    created_at: new Date().toISOString(),
    phase: "briefing",
  };
  try {
    await writeFileAtomic(join(dir, STATE_FILE), stateText(state));
  } catch (err) {
    // The directory was created by this call, so removing it cannot touch earlier campaigns.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return operationFailed("create campaign", err);
  }
  return { ok: true, dir, state };
}

// ─── Atomic writes ───────────────────────────────────────────────────────────

/**
 * Atomic file write: temporary file (wx), fsync, then rename over the target.
 * On failure the target keeps its previous content and the temporary file is
 * removed. Leftover temporary files are never read.
 */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle: FileHandle = await open(tmp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ─── Lock and pending-operation marker ───────────────────────────────────────

interface LockRecord {
  pid: number;
  acquired_at: string;
}

async function readLockRecord(path: string): Promise<LockRecord | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(v) && typeof v.pid === "number" && typeof v.acquired_at === "string") {
      return { pid: v.pid, acquired_at: v.acquired_at };
    }
  } catch {
    // unreadable: fail closed below
  }
  return null;
}

/** Exclusive lock via wx create. Returns a refusal when it cannot be taken. */
async function acquireLock(dir: string): Promise<Refusal | null> {
  const path = join(dir, LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return refuse("campaign_missing", "campaign directory does not exist");
    if (code !== "EEXIST") {
      return refuse("io_failed", `lock cannot be created (${errorText(err)}); the operation was not started`);
    }
    const record = await readLockRecord(path);
    return record
      ? refuse(
          "lock_busy",
          `campaign lock is held by pid ${record.pid} since ${record.acquired_at}; the operation was not started. ` +
            "The lock is never removed automatically",
        )
      : refuse(
          "lock_unreadable",
          "campaign lock exists but is unreadable; the operation was not started. " +
            "The lock is never removed automatically",
        );
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    return refuse("io_failed", `lock cannot be written (${errorText(err)}); the operation was not started`);
  }
  return null;
}

async function releaseLock(dir: string): Promise<void> {
  // A failed unlink keeps the lock in place, which fails closed for later operations.
  await unlink(join(dir, LOCK_FILE)).catch(() => undefined);
}

/** Runs fn under the campaign lock. The lock is released afterwards, never taken over. */
export async function withCampaignLock<R>(dir: string, fn: () => Promise<R>): Promise<R | Refusal> {
  const refusal = await acquireLock(dir);
  if (refusal) return refusal;
  try {
    return await fn();
  } finally {
    await releaseLock(dir);
  }
}

/**
 * Reads the pending-operation marker. Presence alone blocks operations, so an
 * unreadable marker is reported as a pending operation, never as absent.
 */
export async function readPendingOp(dir: string): Promise<PendingOp | null> {
  let text: string;
  try {
    text = await readFile(join(dir, PENDING_OP_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    return { name: "unreadable pending-op marker", started_at: "" };
  }
  try {
    const v: unknown = JSON.parse(text);
    if (isRecord(v) && typeof v.name === "string" && typeof v.started_at === "string") {
      return { name: v.name, started_at: v.started_at };
    }
  } catch {
    // fall through: present but unreadable
  }
  return { name: "unreadable pending-op marker", started_at: "" };
}

async function writePendingOp(dir: string, name: string): Promise<void> {
  const op: PendingOp = { name, started_at: new Date().toISOString() };
  const handle = await open(join(dir, PENDING_OP_FILE), "wx");
  try {
    await handle.writeFile(JSON.stringify(op));
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

async function clearPendingOp(dir: string): Promise<void> {
  await unlink(join(dir, PENDING_OP_FILE));
}

function pendingRefusal(op: PendingOp): Refusal {
  return refuse(
    "manual_check_required",
    `operation ${quote(op.name)} (started ${oneLine(op.started_at) || "at unknown time"}) did not complete; ` +
      "nothing new was started. Check the campaign files by hand; the marker is not removed automatically",
  );
}

function operationFailed(opName: string, err: unknown): Refusal {
  return refuse(
    "operation_failed",
    `operation ${quote(opName)} failed (${errorText(err)}); its outcome is unknown. ` +
      "pending-op.json may remain, so later state updates refuse with manual_check_required",
  );
}

// ─── State ───────────────────────────────────────────────────────────────────

/** Returns the first problem of a parsed state, or null when it is well-formed. */
function stateProblem(v: unknown, expectedId: string): string | null {
  if (!isRecord(v)) return "state is not an object";
  const fields = fieldSetProblems(v, STATE_KEYS, "state");
  if (fields.length > 0) return fields[0];
  if (v.schema_version !== RESEARCH_STATE_SCHEMA_VERSION) {
    return `unsupported schema_version ${oneLine(JSON.stringify(v.schema_version) ?? "undefined")}`;
  }
  if (typeof v.campaign_id !== "string" || !ID_RE.test(v.campaign_id)) return "campaign_id is invalid";
  if (v.campaign_id !== expectedId) return "campaign_id does not match the campaign directory";
  if (typeof v.created_at !== "string" || v.created_at === "") return "created_at must be a non-empty string";
  if (typeof v.phase !== "string" || !(CAMPAIGN_PHASES as readonly string[]).includes(v.phase)) {
    return "phase is not a known campaign phase";
  }
  return null;
}

/** Reads and validates state.json. Any problem is a refusal; nothing is repaired.
 * The directory must be a campaign directory under the research root of its
 * own campaign id; a path outside that root is refused without touching files. */
export async function readState(dir: string): Promise<Result<{ state: CampaignState }>> {
  const contained = requireCampaignContained(dir);
  if (contained) return contained;
  let text: string;
  try {
    text = await readFile(join(dir, STATE_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return refuse("not_initialized", "campaign state does not exist");
    return refuse("state_unreadable", `state.json cannot be read (${errorText(err)}); nothing was changed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("state_unreadable", "state.json is not valid JSON; nothing was changed");
  }
  const problem = stateProblem(parsed, basename(dir));
  if (problem) return refuse("state_unreadable", `state.json failed validation: ${problem}; nothing was changed`);
  return { ok: true, state: parsed as CampaignState };
}

/**
 * One locked state update. Order: lock, pending-operation check, state read
 * (fail-closed), approved-brief check, decision, marker, optional work, state
 * write, marker removal. A refusal touches no file. If work or the state write
 * throws, the marker stays and the update reports operation_failed.
 */
export async function updateState(
  dir: string,
  opName: string,
  decide: (s: CampaignState) => StateDecision,
  work?: () => Promise<void>,
): Promise<Result<{ state: CampaignState }>> {
  const contained = requireCampaignContained(dir);
  if (contained) return contained;
  return withCampaignLock(dir, async (): Promise<Result<{ state: CampaignState }>> => {
    const pending = await readPendingOp(dir);
    if (pending) return pendingRefusal(pending);
    const loaded = await readState(dir);
    if (!loaded.ok) return loaded;
    const guard = await approvedBriefGuard(dir);
    if (guard) return guard;
    const decision = decide(loaded.state);
    if (!decision.ok) return decision;
    const problem = stateProblem(decision.next, basename(dir));
    if (problem) return refuse("invalid_transition", `new state rejected: ${problem}; nothing was changed`);
    try {
      await writePendingOp(dir, opName);
      if (work) await work();
      if (decision.next !== loaded.state) await writeFileAtomic(join(dir, STATE_FILE), stateText(decision.next));
      await clearPendingOp(dir);
    } catch (err) {
      return operationFailed(opName, err);
    }
    return { ok: true, state: decision.next };
  });
}

/** Read-only status. Takes no lock and writes nothing. */
export async function inspectCampaign(dir: string): Promise<CampaignInspection> {
  const contained = requireCampaignContained(dir);
  if (contained) {
    return {
      status: "invalid_argument",
      state: null,
      pendingOp: null,
      lockPresent: false,
      message: contained.message,
    };
  }
  const pendingOp = await readPendingOp(dir);
  const lockPresent = await fileMayExist(join(dir, LOCK_FILE));
  const loaded = await readState(dir);
  const state = loaded.ok ? loaded.state : null;
  if (pendingOp) {
    return {
      status: "manual_check_required",
      state,
      pendingOp,
      lockPresent,
      message: pendingRefusal(pendingOp).message,
    };
  }
  if (!loaded.ok) {
    return {
      status: loaded.reason === "not_initialized" ? "uninitialized" : "state_unreadable",
      state: null,
      pendingOp: null,
      lockPresent,
      message: loaded.message,
    };
  }
  return { status: "ready", state, pendingOp: null, lockPresent, message: "campaign state is readable" };
}

// ─── Brief structure ─────────────────────────────────────────────────────────

/**
 * Validates the brief structure and returns every problem found. Rules:
 * exact field sets (unknown fields such as "approved" are rejected), non-empty
 * goal, plan_source and caveat_block, at least one question, unique ids across
 * questions, rules and stop rules, and at least one rule per verdict for every
 * question. Rule conditions are text; their truth is not checked here.
 */
export function validateBrief(raw: unknown): BriefValidation {
  if (!isRecord(raw)) return { ok: false, errors: ["brief must be a JSON object"] };
  const errors: string[] = [];
  const ids = new Map<string, string>();

  errors.push(...fieldSetProblems(raw, BRIEF_KEYS, "brief"));
  if (raw.schema_version !== BRIEF_SCHEMA_VERSION) {
    errors.push(`brief.schema_version must be ${BRIEF_SCHEMA_VERSION}`);
  }
  requireText(raw.goal, "brief.goal", errors);
  requireText(raw.plan_source, "brief.plan_source", errors);
  requireText(raw.caveat_block, "brief.caveat_block (required, copied verbatim into the report)", errors);

  if (isRecord(raw.data_roles)) {
    errors.push(...fieldSetProblems(raw.data_roles, DATA_ROLE_KEYS, "brief.data_roles"));
    for (const key of DATA_ROLE_KEYS) {
      requireStringList(raw.data_roles[key], `brief.data_roles.${key}`, errors);
    }
  } else {
    errors.push("brief.data_roles must be an object with explore, validate and confirm");
  }

  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    errors.push("brief.questions must be a non-empty array");
  } else {
    raw.questions.forEach((q, i) => validateQuestion(q, `brief.questions[${i}]`, ids, errors));
  }

  requireStringList(raw.process_metrics, "brief.process_metrics", errors);

  if (!Array.isArray(raw.stop_rules)) {
    errors.push("brief.stop_rules must be an array");
  } else {
    raw.stop_rules.forEach((s, i) => validateStopRule(s, `brief.stop_rules[${i}]`, ids, errors));
  }

  if (errors.length > 0) return { ok: false, errors: errors.map(oneLine) };
  return { ok: true, brief: raw as unknown as ResearchBrief };
}

function validateQuestion(q: unknown, where: string, ids: Map<string, string>, errors: string[]): void {
  if (!isRecord(q)) {
    errors.push(`${where} must be an object`);
    return;
  }
  errors.push(...fieldSetProblems(q, QUESTION_KEYS, where));
  requireId(q.id, `${where}.id`, ids, errors);
  requireText(q.text, `${where}.text`, errors);
  if (q.needs_data !== null && (typeof q.needs_data !== "string" || q.needs_data.trim() === "")) {
    errors.push(`${where}.needs_data must be null or a non-empty string`);
  }
  if (!Array.isArray(q.decision_rules)) {
    errors.push(`${where}.decision_rules must be an array`);
    return;
  }
  const verdicts = new Set<string>();
  q.decision_rules.forEach((r, i) => {
    const rw = `${where}.decision_rules[${i}]`;
    if (!isRecord(r)) {
      errors.push(`${rw} must be an object`);
      return;
    }
    errors.push(...fieldSetProblems(r, RULE_KEYS, rw));
    requireId(r.id, `${rw}.id`, ids, errors);
    if (typeof r.verdict === "string" && (VERDICTS as readonly string[]).includes(r.verdict)) {
      verdicts.add(r.verdict);
    } else {
      errors.push(`${rw}.verdict must be one of ${VERDICTS.join(", ")}`);
    }
    requireText(r.when, `${rw}.when`, errors);
  });
  for (const verdict of VERDICTS) {
    if (!verdicts.has(verdict)) errors.push(`${where} has no decision rule with verdict "${verdict}"`);
  }
}

function validateStopRule(s: unknown, where: string, ids: Map<string, string>, errors: string[]): void {
  if (!isRecord(s)) {
    errors.push(`${where} must be an object`);
    return;
  }
  errors.push(...fieldSetProblems(s, STOP_KEYS, where));
  requireId(s.id, `${where}.id`, ids, errors);
  requireText(s.when, `${where}.when`, errors);
}

function parseBriefBytes(bytes: Buffer): Result<{ brief: ResearchBrief }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse("brief_invalid", "brief.json is not valid JSON; the campaign is blocked for manual check");
  }
  const validation = validateBrief(parsed);
  if (!validation.ok) {
    return refuse(
      "brief_invalid",
      `brief.json failed validation (${validation.errors.length} problem(s)): ${validation.errors.join("; ")}`,
    );
  }
  return { ok: true, brief: validation.brief };
}

// ─── SHA-256 and approval ────────────────────────────────────────────────────

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBriefBytes(dir: string): Promise<Result<{ bytes: Buffer }>> {
  try {
    return { ok: true, bytes: await readFile(join(dir, BRIEF_FILE)) };
  } catch (err) {
    if (errorCode(err) === "ENOENT") return refuse("brief_missing", "brief.json does not exist");
    return refuse("brief_unreadable", `brief.json cannot be read (${errorText(err)})`);
  }
}

/** SHA-256 of the current bytes of brief.json. Identical bytes give an identical hash. */
export async function briefSha256(dir: string): Promise<Result<{ sha256: string }>> {
  const read = await readBriefBytes(dir);
  if (!read.ok) return read;
  return { ok: true, sha256: sha256Hex(read.bytes) };
}

/**
 * Writes a validated brief draft while the brief is not approved. Refuses
 * with brief_approved once approval.json exists, so an approved brief is never
 * rewritten. The write is atomic and runs under the campaign lock.
 */
export async function writeBriefDraft(dir: string, raw: unknown): Promise<Result<{ sha256: string }>> {
  const validation = validateBrief(raw);
  if (!validation.ok) {
    return refuse("brief_invalid", `brief rejected (${validation.errors.length} problem(s)): ${validation.errors.join("; ")}`);
  }
  const text = JSON.stringify(validation.brief, null, 2) + "\n";
  return withCampaignLock(dir, async (): Promise<Result<{ sha256: string }>> => {
    const pending = await readPendingOp(dir);
    if (pending) return pendingRefusal(pending);
    const loaded = await readState(dir);
    if (!loaded.ok) return loaded;
    if (await fileMayExist(join(dir, APPROVAL_FILE))) {
      return refuse("brief_approved", "the brief is approved and cannot be changed; a changed brief means a new campaign");
    }
    try {
      await writeFileAtomic(join(dir, BRIEF_FILE), text);
    } catch (err) {
      return refuse("io_failed", `brief.json cannot be written (${errorText(err)}); the previous content is kept`);
    }
    return { ok: true, sha256: sha256Hex(text) };
  });
}

function approvalProblem(v: unknown): string | null {
  if (!isRecord(v)) return "approval is not an object";
  const fields = fieldSetProblems(v, APPROVAL_KEYS, "approval");
  if (fields.length > 0) return fields[0];
  if (v.schema_version !== APPROVAL_SCHEMA_VERSION) return "unsupported approval schema_version";
  if (typeof v.brief_sha256 !== "string" || !SHA256_RE.test(v.brief_sha256)) {
    return "brief_sha256 must be 64 lowercase hex characters";
  }
  if (typeof v.approved_at !== "string" || v.approved_at === "") return "approved_at must be a non-empty string";
  if (v.confirmed !== true) return "confirmed must be literally true";
  return null;
}

/** Reads approval.json. Absent means not approved; any problem is approval_invalid. */
export async function readApproval(dir: string): Promise<Result<{ approval: Approval }>> {
  let text: string;
  try {
    text = await readFile(join(dir, APPROVAL_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return refuse("not_approved", "the brief is not approved: approval.json does not exist");
    return refuse("approval_invalid", `approval.json cannot be read (${errorText(err)}); the campaign is blocked`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("approval_invalid", "approval.json is not valid JSON; the campaign is blocked");
  }
  const problem = approvalProblem(parsed);
  if (problem) return refuse("approval_invalid", `approval.json failed validation: ${problem}; the campaign is blocked`);
  return { ok: true, approval: parsed as Approval };
}

/**
 * Checks that brief.json is the approved brief: the approval hash matches the
 * current bytes, the optional expected hash matches too, and the structure is
 * valid. Any mismatch is brief_changed; nothing is written.
 */
export async function checkBriefApproval(
  dir: string,
  expectedSha256?: string,
): Promise<Result<{ sha256: string; brief: ResearchBrief }>> {
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256))) {
    return refuse("invalid_argument", "expected brief hash must be 64 lowercase hex characters");
  }
  const approval = await readApproval(dir);
  if (!approval.ok) return approval;
  const read = await readBriefBytes(dir);
  if (!read.ok) {
    if (read.reason === "brief_missing") {
      return refuse("brief_changed", "brief.json is missing after approval; all actions are blocked until manual check");
    }
    return read;
  }
  const actual = sha256Hex(read.bytes);
  if (actual !== approval.approval.brief_sha256) {
    return refuse(
      "brief_changed",
      `brief.json changed after approval (approved ${approval.approval.brief_sha256.slice(0, 12)}, ` +
        `now ${actual.slice(0, 12)}); all actions are blocked until manual check`,
    );
  }
  if (expectedSha256 !== undefined && expectedSha256 !== actual) {
    return refuse("brief_changed", "the expected brief hash does not match the approved brief; the start is refused");
  }
  const parsed = parseBriefBytes(read.bytes);
  if (!parsed.ok) return parsed;
  return { ok: true, sha256: actual, brief: parsed.brief };
}

/** Blocks state updates once a brief is approved and no longer matches. */
async function approvedBriefGuard(dir: string): Promise<Refusal | null> {
  if (!(await fileMayExist(join(dir, APPROVAL_FILE)))) return null;
  const checked = await checkBriefApproval(dir);
  return checked.ok ? null : checked;
}

/**
 * Operator-consented removal of a pending-operation marker (spec: manual
 * recovery). The model cannot clear the marker itself: it must go through the
 * tool layer, which asks the human via a dialog and passes the explicit
 * operator token here. The lock is respected; a missing marker is a refusal.
 */
export async function manualResolvePendingOp(dir: string, confirmation: string): Promise<Result<{ message: string }>> {
  const contained = requireCampaignContained(dir);
  if (contained) return contained;
  if (confirmation !== OPERATOR_CONFIRMATION) {
    return refuse("invalid_argument", "manual resolution requires the operator confirmation token");
  }
  return withCampaignLock(dir, async (): Promise<Result<{ message: string }>> => {
    const pending = await readPendingOp(dir);
    if (!pending) return refuse("invalid_transition", "no pending operation to resolve");
    await clearPendingOp(dir);
    return {
      ok: true,
      message: `pending operation ${quote(pending.name)} resolved by operator; the marker is cleared, state.json is untouched`,
    };
  });
}

/**
 * Writes approval.json after the OWNER's dialog consent (ctx.ui.confirm ===
 * true). The caller passes the current brief hash it showed the user; the
 * function re-hashes brief.json from disk and refuses when the hash no longer
 * matches what was confirmed. An existing approval is never rewritten: a new
 * approval means a new campaign.
 */
export async function writeApproval(
  dir: string,
  confirmedBriefSha256: string,
): Promise<Result<{ approval: Approval }>> {
  const contained = requireCampaignContained(dir);
  if (contained) return contained;
  if (typeof confirmedBriefSha256 !== "string" || !SHA256_RE.test(confirmedBriefSha256)) {
    return refuse("invalid_argument", "confirmed brief hash must be 64 lowercase hex characters");
  }
  return withCampaignLock(dir, async (): Promise<Result<{ approval }>> => {
    if (await fileMayExist(join(dir, APPROVAL_FILE))) {
      return refuse("approval_invalid", "the brief is already approved; approval.json is never rewritten");
    }
    const current = await briefSha256(dir);
    if (!current.ok) return current;
    if (current.sha256 !== confirmedBriefSha256) {
      return refuse(
        "brief_changed",
        `the brief changed while it was shown for confirmation (confirmed ${confirmedBriefSha256.slice(0, 12)}, now ${current.sha256.slice(0, 12)}); show the brief again before consenting`,
      );
    }
    const approval: Approval = {
      schema_version: APPROVAL_SCHEMA_VERSION,
      brief_sha256: current.sha256,
      approved_at: new Date().toISOString(),
      confirmed: true,
    };
    try {
      await writeFileAtomic(join(dir, APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n");
    } catch (err) {
      return refuse("io_failed", `approval.json cannot be written (${errorText(err)}); nothing was approved`);
    }
    return { ok: true, approval };
  });
}
