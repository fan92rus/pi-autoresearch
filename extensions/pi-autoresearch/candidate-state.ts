/**
 * candidate-state.ts — standalone campaign state for candidate branches:
 * on-disk state, one active candidate, one exclusive lock, pending-operation
 * marker and candidate budgets.
 *
 * Scope: openspec/changes/candidate-branches design.md §2, §4, §5 (state
 * machine, lock, pending operation, budgets); epic pi-autoresearch-3e4.4.3,
 * task pi-autoresearch-3e4.4.3.1.
 *
 * Deliberately standalone: no imports from the extension, no Git calls, no
 * measurement. The caller passes the campaign state directory (for example
 * <repo>/.auto/candidate) and any Git work as callbacks; the callbacks run
 * inside the pending-operation marker. The policy is validated by
 * candidate-policy.ts before it reaches initCampaign; this module checks only
 * the budget fields it reads.
 *
 * What this module guarantees (design §4, MVP):
 *   - Refusals are decided under the lock before any write, so a refused
 *     transition leaves every file as it was.
 *   - One exclusive lock per campaign (lock.json, created with the wx flag).
 *     A busy or unreadable lock refuses the operation. There is no automatic
 *     unlock: manualClearLock requires the explicit operator token.
 *   - A pending-operation marker is written before the work and the state
 *     write, and removed only after both succeed. While it exists every
 *     operation refuses with manual_check_required. Nothing is deleted or
 *     retried automatically; manualResolvePendingOp requires the operator
 *     token.
 *   - State writes are atomic (temporary file + rename). Leftover temporary
 *     files are ignored by readers.
 *   - At most one active candidate. Candidate step and time budgets refuse
 *     new runs when exhausted; checkpoint records are never deleted.
 *   - disable blocks every later campaign operation; state, checkpoints and
 *     refs stay in place.
 *   - The policy is written once at init. No API rewrites it.
 *
 * Not promised: protection against concurrent old versions, power loss,
 * filesystem corruption, or external Git commands (design §1).
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

export const CANDIDATE_STATE_SCHEMA_VERSION = 1;
export const STATE_FILE = "state.json";
export const LOCK_FILE = "lock.json";
export const PENDING_OP_FILE = "pending-op.json";

/**
 * Explicit operator confirmation token. The operator passes it only after
 * checking that no process is running and that Git refs and worktrees match
 * the state files. No boolean flag is accepted in its place.
 */
export const OPERATOR_CONFIRMATION = "operator-manual-check-done";

/** Accepted candidate and checkpoint identifiers. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ─── Types ───────────────────────────────────────────────────────────────────

export type CandidateStatus = "active" | "paused" | "closed";

export interface CandidateRecord {
  id: string;
  status: CandidateStatus;
  /** Runs started by this candidate (counted before the run starts). */
  steps_used: number;
  /** Measured wall-clock seconds spent by this candidate's runs. */
  time_used_seconds: number;
  /** Checkpoint ids saved by this candidate, in save order. Never removed. */
  checkpoints: string[];
  /** Selected checkpoint id (one of `checkpoints`) or null. */
  selected_checkpoint: string | null;
}

/** The budget fields this module reads; other policy fields are stored as-is. */
export interface CampaignBudgetPolicy {
  /** Step limit per candidate; integer >= 1. */
  candidate_step_limit: number;
  /** Wall-clock limit per candidate in seconds; finite > 0. */
  candidate_time_limit_seconds: number;
  [field: string]: unknown;
}

export interface CampaignState {
  schema_version: number;
  created_at: string;
  disabled: boolean;
  /** Campaign policy, copied at init and never rewritten. */
  policy: CampaignBudgetPolicy;
  candidates: CandidateRecord[];
}

export interface PendingOp {
  name: string;
  started_at: string;
}

export type RefusalReason =
  | "invalid_argument"
  | "not_initialized"
  | "already_initialized"
  | "state_unreadable"
  | "lock_busy"
  | "lock_unreadable"
  | "manual_check_required"
  | "campaign_disabled"
  | "second_active_candidate"
  | "duplicate_candidate"
  | "unknown_candidate"
  | "candidate_not_active"
  | "candidate_closed"
  | "checkpoint_not_owned"
  | "duplicate_checkpoint"
  | "budget_exhausted"
  | "invalid_transition"
  | "operation_failed";

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  /** One line, safe to show; control characters are escaped. */
  message: string;
}

export interface StateOk {
  ok: true;
  state: CampaignState;
}

export type CandidateStateResult = StateOk | Refusal;

export interface ManualOk {
  ok: true;
  message: string;
}

export interface CampaignInspection {
  status: "uninitialized" | "ready" | "disabled" | "state_unreadable" | "manual_check_required";
  state: CampaignState | null;
  pendingOp: PendingOp | null;
  lockPresent: boolean;
  message: string;
}

type Decision = { ok: true; next: CampaignState } | Refusal;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function refuse(reason: RefusalReason, message: string): Refusal {
  return { ok: false, reason, message };
}

function isRefusal(v: CandidateRecord | Refusal): v is Refusal {
  return "ok" in v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
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

function disabledRefusal(): Refusal {
  return refuse("campaign_disabled", "campaign is disabled; no operation can change it");
}

function checkId(kind: string, id: unknown): Refusal | null {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return refuse("invalid_argument", `${kind} id must match ${String(ID_RE)} (letters, digits, '.', '_', '-'; 1-64 chars)`);
  }
  return null;
}

function budgetProblem(p: Record<string, unknown>): string | null {
  const steps = p.candidate_step_limit;
  const time = p.candidate_time_limit_seconds;
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
    return "candidate_step_limit must be an integer >= 1";
  }
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) {
    return "candidate_time_limit_seconds must be a finite number > 0";
  }
  return null;
}

/** Returns a problem description, or null when the parsed state is well-formed. */
function stateProblem(v: unknown): string | null {
  if (!isRecord(v)) return "state is not an object";
  if (v.schema_version !== CANDIDATE_STATE_SCHEMA_VERSION) {
    return `unsupported schema_version ${oneLine(JSON.stringify(v.schema_version) ?? "undefined")}`;
  }
  if (typeof v.created_at !== "string") return "created_at must be a string";
  if (typeof v.disabled !== "boolean") return "disabled must be a boolean";
  if (!isRecord(v.policy)) return "policy must be an object";
  const policyIssue = budgetProblem(v.policy);
  if (policyIssue) return `policy: ${policyIssue}`;
  if (!Array.isArray(v.candidates)) return "candidates must be an array";

  const candidateIds = new Set<string>();
  const checkpointIds = new Set<string>();
  let activeCount = 0;
  for (const raw of v.candidates) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      return "a candidate has a missing or invalid id";
    }
    const id = raw.id;
    if (candidateIds.has(id)) return `duplicate candidate id ${quote(id)}`;
    candidateIds.add(id);
    if (raw.status !== "active" && raw.status !== "paused" && raw.status !== "closed") {
      return `candidate ${quote(id)} has an invalid status`;
    }
    if (raw.status === "active") activeCount++;
    if (!isNonNegativeNumber(raw.steps_used) || !isNonNegativeNumber(raw.time_used_seconds)) {
      return `candidate ${quote(id)} has invalid usage counters`;
    }
    if (!Array.isArray(raw.checkpoints) || !raw.checkpoints.every((c) => typeof c === "string")) {
      return `candidate ${quote(id)} has invalid checkpoints`;
    }
    const owned = raw.checkpoints as string[];
    for (const cp of owned) {
      if (checkpointIds.has(cp)) return `duplicate checkpoint id ${quote(cp)}`;
      checkpointIds.add(cp);
    }
    if (raw.selected_checkpoint !== null) {
      if (typeof raw.selected_checkpoint !== "string" || !owned.includes(raw.selected_checkpoint)) {
        return `candidate ${quote(id)} selects a checkpoint it does not own`;
      }
    }
  }
  if (activeCount > 1) return "more than one active candidate";
  return null;
}

function findCandidate(s: CampaignState, id: string): CandidateRecord | Refusal {
  const found = s.candidates.find((c) => c.id === id);
  return found ?? refuse("unknown_candidate", `candidate ${quote(id)} does not exist`);
}

function activeCandidate(s: CampaignState): CandidateRecord | undefined {
  return s.candidates.find((c) => c.status === "active");
}

function replaceCandidate(s: CampaignState, next: CandidateRecord): CampaignState {
  return { ...s, candidates: s.candidates.map((c) => (c.id === next.id ? next : c)) };
}

// ─── Files: state, lock, pending-operation marker ────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

/** Reads and validates state.json. Any problem is a refusal; nothing is repaired. */
async function readStateFile(dir: string): Promise<StateOk | Refusal> {
  let text: string;
  try {
    text = await readFile(join(dir, STATE_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return refuse("not_initialized", "campaign is not initialized");
    return refuse("state_unreadable", `state.json cannot be read (${errorText(err)}); nothing was changed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("state_unreadable", "state.json is not valid JSON; nothing was changed");
  }
  const problem = stateProblem(parsed);
  if (problem) return refuse("state_unreadable", `state.json failed validation: ${problem}; nothing was changed`);
  return { ok: true, state: parsed as CampaignState };
}

/** Atomic state write: temporary file, fsync, then rename over state.json. */
async function writeStateAtomic(dir: string, state: CampaignState): Promise<void> {
  const target = join(dir, STATE_FILE);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle: FileHandle = await open(tmp, "wx");
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n");
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await handle.close();
  await rename(tmp, target);
}

/**
 * Reads the pending-operation marker. Presence alone blocks operations, so an
 * unreadable marker is reported as a pending operation, never as absent.
 */
async function readPendingOp(dir: string): Promise<PendingOp | null> {
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
  } finally {
    await handle.close();
  }
}

async function clearPendingOp(dir: string): Promise<void> {
  await unlink(join(dir, PENDING_OP_FILE));
}

function pendingRefusal(op: PendingOp): Refusal {
  return refuse(
    "manual_check_required",
    `operation ${quote(op.name)} (started ${oneLine(op.started_at) || "at unknown time"}) did not complete; ` +
      "nothing new was started. Check Git refs and worktrees by hand, then resolve with manualResolvePendingOp",
  );
}

function operationFailed(opName: string, err: unknown): Refusal {
  return refuse(
    "operation_failed",
    `operation ${quote(opName)} failed (${errorText(err)}); its outcome is unknown. ` +
      "The pending-op marker may remain, so operations refuse with manual_check_required until the operator resolves it",
  );
}

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
    if (errorCode(err) === "ENOENT") return refuse("not_initialized", "campaign directory does not exist");
    if (errorCode(err) !== "EEXIST") throw err;
    const record = await readLockRecord(path);
    return record
      ? refuse(
          "lock_busy",
          `campaign lock is held by pid ${record.pid} since ${record.acquired_at}; the operation was not started. ` +
            "If that process is not running, clear the lock with manualClearLock",
        )
      : refuse(
          "lock_unreadable",
          "campaign lock exists but is unreadable; the operation was not started. " +
            "Verify no process is running, then clear the lock with manualClearLock",
        );
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw err;
  }
  await handle.close();
  return null;
}

async function releaseLock(dir: string): Promise<void> {
  // A failed unlink keeps the lock in place, which fails closed for later operations.
  await unlink(join(dir, LOCK_FILE)).catch(() => undefined);
}

/** Runs fn under the campaign lock. The lock is never taken automatically over. */
async function locked<R>(dir: string, fn: () => Promise<R>): Promise<R | Refusal> {
  const refusal = await acquireLock(dir);
  if (refusal) return refusal;
  try {
    return await fn();
  } finally {
    await releaseLock(dir);
  }
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * One locked state transition. `decide` runs on the current state and either
 * refuses (no file is touched) or returns the next state. `work` runs between
 * the pending-operation marker and the state write; if it throws, the marker
 * stays and the state is not changed.
 */
async function transition(
  dir: string,
  opName: string,
  decide: (s: CampaignState) => Decision,
  work?: () => Promise<void>,
): Promise<CandidateStateResult> {
  return locked(dir, async (): Promise<CandidateStateResult> => {
    const pending = await readPendingOp(dir);
    if (pending) return pendingRefusal(pending);
    const loaded = await readStateFile(dir);
    if (!loaded.ok) return loaded;
    const decision = decide(loaded.state);
    if (!decision.ok) return decision;
    try {
      await writePendingOp(dir, opName);
      if (work) await work();
      if (decision.next !== loaded.state) await writeStateAtomic(dir, decision.next);
      await clearPendingOp(dir);
    } catch (err) {
      return operationFailed(opName, err);
    }
    return { ok: true, state: decision.next };
  });
}

/** Creates the campaign state with its fixed budget policy. Refuses to overwrite. */
export async function initCampaign(dir: string, policy: CampaignBudgetPolicy): Promise<CandidateStateResult> {
  if (!isRecord(policy)) return refuse("invalid_argument", "policy must be an object");
  const policyIssue = budgetProblem(policy);
  if (policyIssue) return refuse("invalid_argument", `policy ${policyIssue}`);
  await mkdir(dir, { recursive: true });
  return locked(dir, async (): Promise<CandidateStateResult> => {
    const pending = await readPendingOp(dir);
    if (pending) return pendingRefusal(pending);
    if (await exists(join(dir, STATE_FILE))) {
      return refuse(
        "already_initialized",
        "campaign state already exists; the policy is fixed for the campaign and cannot be rewritten",
      );
    }
    const state: CampaignState = {
      schema_version: CANDIDATE_STATE_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      disabled: false,
      policy: JSON.parse(JSON.stringify(policy)) as CampaignBudgetPolicy,
      candidates: [],
    };
    try {
      await writeStateAtomic(dir, state);
    } catch (err) {
      return operationFailed("init", err);
    }
    return { ok: true, state };
  });
}

/** Adds a candidate and makes it the single active one. */
export async function createCandidate(dir: string, candidateId: string): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId);
  if (idError) return idError;
  return transition(dir, `create ${candidateId}`, (s) => {
    if (s.disabled) return disabledRefusal();
    if (s.candidates.some((c) => c.id === candidateId)) {
      return refuse("duplicate_candidate", `candidate ${quote(candidateId)} already exists`);
    }
    const other = activeCandidate(s);
    if (other) {
      return refuse("second_active_candidate", `candidate ${quote(other.id)} is active; pause it before creating ${quote(candidateId)}`);
    }
    const created: CandidateRecord = {
      id: candidateId,
      status: "active",
      steps_used: 0,
      time_used_seconds: 0,
      checkpoints: [],
      selected_checkpoint: null,
    };
    return { ok: true, next: { ...s, candidates: [...s.candidates, created] } };
  });
}

export async function pauseCandidate(dir: string, candidateId: string): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId);
  if (idError) return idError;
  return transition(dir, `pause ${candidateId}`, (s) => {
    if (s.disabled) return disabledRefusal();
    const c = findCandidate(s, candidateId);
    if (isRefusal(c)) return c;
    if (c.status !== "active") {
      return refuse("candidate_not_active", `candidate ${quote(candidateId)} is ${c.status}; only the active candidate can be paused`);
    }
    return { ok: true, next: replaceCandidate(s, { ...c, status: "paused" }) };
  });
}

/** Makes a paused candidate active again; the single-active rule still applies. */
export async function resumeCandidate(
  dir: string,
  candidateId: string,
  work?: () => Promise<void>,
): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId);
  if (idError) return idError;
  return transition(
    dir,
    `resume ${candidateId}`,
    (s) => {
      if (s.disabled) return disabledRefusal();
      const c = findCandidate(s, candidateId);
      if (isRefusal(c)) return c;
      if (c.status === "closed") return refuse("candidate_closed", `candidate ${quote(candidateId)} is closed and cannot be resumed`);
      if (c.status === "active") return refuse("invalid_transition", `candidate ${quote(candidateId)} is already active`);
      const other = activeCandidate(s);
      if (other) {
        return refuse("second_active_candidate", `candidate ${quote(other.id)} is active; pause it before resuming ${quote(candidateId)}`);
      }
      return { ok: true, next: replaceCandidate(s, { ...c, status: "active" }) };
    },
    work,
  );
}

/** Saves a checkpoint of the active candidate and makes it the selected one. */
export async function recordCheckpoint(
  dir: string,
  candidateId: string,
  checkpointId: string,
  work?: () => Promise<void>,
): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId) ?? checkId("checkpoint", checkpointId);
  if (idError) return idError;
  return transition(
    dir,
    `checkpoint ${candidateId} ${checkpointId}`,
    (s) => {
      if (s.disabled) return disabledRefusal();
      const c = findCandidate(s, candidateId);
      if (isRefusal(c)) return c;
      if (c.status !== "active") {
        return refuse("candidate_not_active", `candidate ${quote(candidateId)} is ${c.status}; only the active candidate saves checkpoints`);
      }
      if (s.candidates.some((x) => x.checkpoints.includes(checkpointId))) {
        return refuse("duplicate_checkpoint", `checkpoint ${quote(checkpointId)} already exists`);
      }
      const updated: CandidateRecord = {
        ...c,
        checkpoints: [...c.checkpoints, checkpointId],
        selected_checkpoint: checkpointId,
      };
      return { ok: true, next: replaceCandidate(s, updated) };
    },
    work,
  );
}

/** Selects one of the candidate's own checkpoints. Nothing is deleted. */
export async function selectCheckpoint(
  dir: string,
  candidateId: string,
  checkpointId: string,
  work?: () => Promise<void>,
): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId) ?? checkId("checkpoint", checkpointId);
  if (idError) return idError;
  return transition(
    dir,
    `select ${candidateId} ${checkpointId}`,
    (s) => {
      if (s.disabled) return disabledRefusal();
      const c = findCandidate(s, candidateId);
      if (isRefusal(c)) return c;
      if (c.status === "closed") return refuse("candidate_closed", `candidate ${quote(candidateId)} is closed`);
      if (!c.checkpoints.includes(checkpointId)) {
        return refuse("checkpoint_not_owned", `checkpoint ${quote(checkpointId)} is not saved by candidate ${quote(candidateId)}`);
      }
      return { ok: true, next: replaceCandidate(s, { ...c, selected_checkpoint: checkpointId }) };
    },
    work,
  );
}

/** Closes a candidate. Its checkpoints stay. */
export async function closeCandidate(dir: string, candidateId: string): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId);
  if (idError) return idError;
  return transition(dir, `close ${candidateId}`, (s) => {
    if (s.disabled) return disabledRefusal();
    const c = findCandidate(s, candidateId);
    if (isRefusal(c)) return c;
    if (c.status === "closed") return refuse("candidate_closed", `candidate ${quote(candidateId)} is already closed`);
    return { ok: true, next: replaceCandidate(s, { ...c, status: "closed" }) };
  });
}

/** Disables the campaign. State files and checkpoint records are kept. */
export async function disableCampaign(dir: string): Promise<CandidateStateResult> {
  return transition(dir, "disable", (s) => {
    if (s.disabled) return refuse("invalid_transition", "campaign is already disabled");
    return { ok: true, next: { ...s, disabled: true } };
  });
}

/**
 * Runs one candidate measurement under the lock and the pending marker. The
 * step budget is counted before the run starts; `measure` reports its wall
 * time, which is added afterwards. An exhausted step or time budget refuses
 * the run before anything is written. The measurement's own result stays in
 * the caller's closure.
 */
export async function runCandidateMeasurement(
  dir: string,
  candidateId: string,
  measure: () => Promise<{ seconds: number }>,
): Promise<CandidateStateResult> {
  const idError = checkId("candidate", candidateId);
  if (idError) return idError;
  return locked(dir, async (): Promise<CandidateStateResult> => {
    const pending = await readPendingOp(dir);
    if (pending) return pendingRefusal(pending);
    const loaded = await readStateFile(dir);
    if (!loaded.ok) return loaded;
    const s = loaded.state;
    if (s.disabled) return disabledRefusal();
    const c = findCandidate(s, candidateId);
    if (isRefusal(c)) return c;
    if (c.status !== "active") {
      return refuse("candidate_not_active", `candidate ${quote(candidateId)} is ${c.status}; only the active candidate can run`);
    }
    const stepLimit = s.policy.candidate_step_limit;
    const timeLimit = s.policy.candidate_time_limit_seconds;
    if (c.steps_used >= stepLimit) {
      return refuse("budget_exhausted", `step limit ${stepLimit} reached for candidate ${quote(candidateId)}; new runs are refused, checkpoints are kept`);
    }
    if (c.time_used_seconds >= timeLimit) {
      return refuse("budget_exhausted", `time limit ${timeLimit}s reached for candidate ${quote(candidateId)}; new runs are refused, checkpoints are kept`);
    }
    const started = replaceCandidate(s, { ...c, steps_used: c.steps_used + 1 });
    try {
      await writePendingOp(dir, `run ${candidateId}`);
      await writeStateAtomic(dir, started);
      const { seconds } = await measure();
      if (!isNonNegativeNumber(seconds)) throw new Error("measure() must return finite non-negative seconds");
      const finished = replaceCandidate(s, { ...c, steps_used: c.steps_used + 1, time_used_seconds: c.time_used_seconds + seconds });
      await writeStateAtomic(dir, finished);
      await clearPendingOp(dir);
      return { ok: true, state: finished };
    } catch (err) {
      return operationFailed(`run ${candidateId}`, err);
    }
  });
}

/**
 * Runs caller-provided Git work under the lock and the pending marker, with no
 * state change. The marker stays if the work fails, so an interrupted Git
 * operation is reported for manual checking, not retried.
 */
export async function beginOperation(
  dir: string,
  name: string,
  work: () => Promise<void>,
): Promise<CandidateStateResult> {
  if (typeof name !== "string" || name.length === 0 || name.length > 120) {
    return refuse("invalid_argument", "operation name must be a non-empty string of at most 120 characters");
  }
  return transition(dir, name, (s) => (s.disabled ? disabledRefusal() : { ok: true, next: s }), work);
}

// ─── Inspection and operator actions ─────────────────────────────────────────

/** Read-only status. Takes no lock and writes nothing. */
export async function inspectCampaign(dir: string): Promise<CampaignInspection> {
  const pendingOp = await readPendingOp(dir);
  const lockPresent = await exists(join(dir, LOCK_FILE));
  const loaded = await readStateFile(dir);
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
  return {
    status: loaded.state.disabled ? "disabled" : "ready",
    state: loaded.state,
    pendingOp: null,
    lockPresent,
    message: loaded.state.disabled ? "campaign is disabled" : "campaign is ready",
  };
}

function requireOperatorToken(token: unknown): Refusal | null {
  if (token !== OPERATOR_CONFIRMATION) {
    return refuse("invalid_argument", "this operator action needs the explicit operator confirmation token");
  }
  return null;
}

/** Removes the lock after an operator has verified no process is running. */
export async function manualClearLock(dir: string, confirmation: string): Promise<ManualOk | Refusal> {
  const tokenError = requireOperatorToken(confirmation);
  if (tokenError) return tokenError;
  const removed = await unlink(join(dir, LOCK_FILE)).then(
    () => true,
    (err: unknown) => {
      if (errorCode(err) === "ENOENT") return false;
      throw err;
    },
  );
  return { ok: true, message: removed ? "lock removed by operator" : "no lock was present" };
}

/**
 * Clears the pending-operation marker after an operator has checked Git refs
 * and worktrees by hand. The state file is left exactly as last written.
 */
export async function manualResolvePendingOp(dir: string, confirmation: string): Promise<ManualOk | Refusal> {
  const tokenError = requireOperatorToken(confirmation);
  if (tokenError) return tokenError;
  return locked(dir, async (): Promise<ManualOk | Refusal> => {
    const pending = await readPendingOp(dir);
    if (!pending) return refuse("invalid_transition", "no pending operation to resolve");
    await clearPendingOp(dir);
    return {
      ok: true,
      message: `pending operation ${quote(pending.name)} resolved by operator; state.json was left as last written`,
    };
  });
}
