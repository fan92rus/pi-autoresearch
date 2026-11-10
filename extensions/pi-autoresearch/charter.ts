/**
 * charter.ts — research-charter foundation: charter file validation, owner
 * consent binding, workdir containment and the model-call parameter allowlist.
 *
 * Scope: openspec/changes/research-charter spec, requirements "Хартия
 * подтверждается владельцем", "Хартия вне рабочей директории агента" and
 * "Состав хартии"; task pi-autoresearch-0lq (items 1.1–1.5).
 *
 * Deliberately standalone: no imports from the extension runtime, no UI, no
 * chain journal, no tool wiring. The dialog is rendered by the calling layer;
 * this module provides the dialog text and validates the decision.
 *
 * Trust model (review round 2):
 *   - modelParams carry what the model may say: exactly {charter_path}.
 *     Every other model field — expected_sha256, hasUI, ownerConfirmed,
 *     approved, confirmed, charter_sha256, operator_confirmation, anything
 *     else — refuses with invalid_argument and names the field.
 *   - trusted carries what only the calling layer (the wrapper arguments or
 *     the dialog result) may supply: expectedSha256 (headless, from the
 *     owner's launch argument), hasUI, ownerConfirmed and shownSha256 (the
 *     hash the dialog displayed). The interactive confirmation is bound to
 *     shownSha256: if the file no longer matches it, the acceptance refuses
 *     with charter_changed even though ownerConfirmed is true.
 *
 * What this module guarantees:
 *   - A charter whose realpath is inside the work directory refuses with
 *     charter_inside_workdir; realpath resolves symlinks/junctions and the
 *     comparison folds name case on Windows.
 *   - Confirmation re-hashes the file from disk: when the bytes no longer
 *     match the hash that was shown (or passed as expectedSha256), the
 *     confirmation refuses with charter_changed (precedent: writeApproval in
 *     research-state.ts).
 *   - Charter content is a JSON object with an allowlisted field set only:
 *     max_campaigns (integer >= 1), max_depth (integer >= 0), stop_rules
 *     (array of non-empty strings). Unknown fields refuse (charter_invalid).
 *     No limits means the chain is unlimited (owner decision 2026-11-10).
 *
 * Not promised: mechanical verification of stop-rule conditions (self-reported
 * by the agent per spec), protection against files edited by hand outside the
 * module, headless wrapper flag parsing (that layer lives in scripts/).
 */

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { sha256Hex } from "./research-state.ts";

// ─── Constants and types ─────────────────────────────────────────────────────

export const CHARTER_SCHEMA_VERSION = 1;

/** Allowlisted charter fields: absent is valid (no limits -> unlimited chain). */
const CHARTER_KEYS = ["max_campaigns", "max_depth", "stop_rules"];

/** The one field the model may pass; everything else is owner-side data. */
const MODEL_KEYS = ["charter_path"];

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface Charter {
  /** Maximum campaigns in the chain including the root (integer >= 1). */
  max_campaigns?: number;
  /** Maximum campaign depth from the root; root has depth 0 (integer >= 0). */
  max_depth?: number;
  /** Chain stop rules; conditions are self-reported by the agent. */
  stop_rules?: string[];
}

/** What the model may pass: exactly charter_path, nothing else. */
export interface CharterModelParams {
  charter_path?: string;
  [key: string]: unknown;
}

/** What only the calling layer may supply (wrapper args / dialog result). */
export interface TrustedCharterConsent {
  /** Owner's expected hash from the launch arguments (headless path). */
  expectedSha256?: string;
  /** A dialog channel exists (interactive path). */
  hasUI?: boolean;
  /** The owner answered the dialog with a strict true. */
  ownerConfirmed?: boolean;
  /** The hash the dialog showed the owner; binds consent to bytes. */
  shownSha256?: string;
}

/** Refusal reasons this module produces. */
export type CharterRefusalReason =
  | "invalid_argument"
  | "charter_inside_workdir"
  | "charter_changed"
  | "charter_invalid"
  | "charter_unreadable";

export interface CharterRefusal {
  ok: false;
  reason: CharterRefusalReason;
  /** One line, safe to show; control characters are escaped. */
  message: string;
}

export type CharterResult<T> = ({ ok: true } & T) | CharterRefusal;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function refuse(reason: CharterRefusalReason, message: string): CharterRefusal {
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

function errorText(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

function isIntegerAtLeast(v: unknown, min: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

/**
 * Realpath with a fallback to the resolved input path when the file does not
 * exist (ENOENT) — the containment check must work for missing files too.
 */
async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
      return resolve(path);
    }
    throw err;
  }
}

/** Folds name case on Windows so containment comparison is case-insensitive. */
function foldCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// ─── Charter content validation (item 1.5) ───────────────────────────────────

export type CharterValidation = { ok: true; charter: Charter } | { ok: false; errors: string[] };

/**
 * Validates the charter content against the allowlisted field set. An empty
 * object is valid: no limits, the chain is unlimited (owner decision
 * 2026-11-10).
 */
export function validateCharter(raw: unknown): CharterValidation {
  if (!isRecord(raw)) return { ok: false, errors: ["charter must be a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!CHARTER_KEYS.includes(key)) errors.push(`charter has unknown field ${quote(key)}`);
  }
  if (raw.max_campaigns !== undefined && !isIntegerAtLeast(raw.max_campaigns, 1)) {
    errors.push("charter.max_campaigns must be an integer >= 1");
  }
  if (raw.max_depth !== undefined && !isIntegerAtLeast(raw.max_depth, 0)) {
    errors.push("charter.max_depth must be an integer >= 0");
  }
  if (raw.stop_rules !== undefined) {
    const rules = raw.stop_rules;
    if (!Array.isArray(rules)) {
      errors.push("charter.stop_rules must be an array of non-empty strings");
    } else {
      rules.forEach((rule, i) => {
        if (typeof rule !== "string" || rule.trim() === "") {
          errors.push(`charter.stop_rules[${i}] must be a non-empty string`);
        }
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors: errors.map(oneLine) };
  return { ok: true, charter: raw as Charter };
}

// ─── Workdir containment (item 1.2) ──────────────────────────────────────────

/**
 * True when the charter's realpath lies inside the work directory (following
 * symlinks/junctions, folding name case on Windows). Refuses nothing itself;
 * acceptCharter turns `true` into the charter_inside_workdir refusal.
 */
export async function charterInsideWorkdir(charterPath: string, workDir: string): Promise<boolean> {
  const [realCharter, realWork] = await Promise.all([realPathOrSelf(charterPath), realPathOrSelf(workDir)]);
  const c = foldCase(realCharter);
  const w = foldCase(realWork);
  if (c === w) return true;
  const prefix = w.endsWith(sep) ? w : w + sep;
  return c.startsWith(prefix);
}

// ─── Model-call allowlist (item 1.1) ─────────────────────────────────────────

/**
 * Validates the parameters the model passed to the charter action. The model
 * allowlist is exactly {charter_path}; any other field — expected_sha256,
 * hasUI, ownerConfirmed, approved, confirmed, charter_sha256,
 * operator_confirmation, or anything else — refuses with invalid_argument
 * and names the field (spec: the model must not pass consents or owner-side
 * data). charter_path must be a non-empty string when present.
 */
export function validateCharterCall(params: Record<string, unknown> | undefined | null): CharterResult<{}> {
  if (params === undefined || params === null) {
    return { ok: true };
  }
  if (!isRecord(params)) return refuse("invalid_argument", "charter call parameters must be an object");
  const unknown = Object.keys(params).filter((key) => !MODEL_KEYS.includes(key));
  if (unknown.length > 0) {
    return refuse(
      "invalid_argument",
      `charter call has unknown field ${quote(unknown[0])}: the model passes only charter_path; approvals and owner-side data come from the calling layer, never from the model`,
    );
  }
  if (params.charter_path !== undefined && (typeof params.charter_path !== "string" || (params.charter_path as string).trim() === "")) {
    return refuse("invalid_argument", "charter_path must be a non-empty string");
  }
  return { ok: true };
}

// ─── Dialog text (item 1.3) ──────────────────────────────────────────────────

/**
 * Builds the confirmation dialog text: the first line is always
 * `Charter SHA-256: <hex>`, followed by a human-readable summary of the
 * charter fields (limits, stop rules, or the unlimited default).
 */
export function charterDialogText(charter: Charter, sha256: string): string {
  const lines: string[] = [`Charter SHA-256: ${sha256}`];
  const hasLimits = charter.max_campaigns !== undefined || charter.max_depth !== undefined;
  if (charter.max_campaigns !== undefined) {
    lines.push(`max_campaigns: ${charter.max_campaigns} (campaigns in the chain, including the root)`);
  }
  if (charter.max_depth !== undefined) {
    lines.push(`max_depth: ${charter.max_depth} (campaign depth from the root; root = 0)`);
  }
  if (!hasLimits) lines.push("limits: none — the chain is unlimited");
  if (charter.stop_rules !== undefined && charter.stop_rules.length > 0) {
    lines.push("stop_rules:");
    for (const rule of charter.stop_rules) lines.push(`  - ${rule}`);
  } else {
    lines.push("stop_rules: none");
  }
  return lines.join("\n");
}

// ─── Confirmation (items 1.3, 1.4) ───────────────────────────────────────────

/**
 * Re-hashes the charter file and compares it with the hash that was shown (or
 * passed as expected_sha256). A mismatch refuses with charter_changed — the
 * file changed between being shown and being confirmed. Valid content is a
 * precondition of a fixed charter.
 */
export async function confirmCharter(
  charterPath: string,
  shownSha256: string,
): Promise<CharterResult<{ charter: Charter; sha256: string }>> {
  if (typeof shownSha256 !== "string" || !SHA256_RE.test(shownSha256)) {
    return refuse("invalid_argument", "the shown charter hash must be 64 lowercase hex characters");
  }
  let text: string;
  try {
    text = await readFile(charterPath, "utf8");
  } catch (err) {
    return refuse("charter_unreadable", `charter file cannot be read (${errorText(err)})`);
  }
  const actual = sha256Hex(text);
  if (actual !== shownSha256) {
    return refuse(
      "charter_changed",
      `charter file changed after it was shown (shown ${shownSha256.slice(0, 12)}, now ${actual.slice(0, 12)}); show the charter again before confirming`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("charter_invalid", "charter file is not valid JSON");
  }
  const validation = validateCharter(parsed);
  if (!validation.ok) {
    return refuse("charter_invalid", `charter file failed validation (${validation.errors.length} problem(s)): ${validation.errors.join("; ")}`);
  }
  return { ok: true, charter: validation.charter, sha256: actual };
}

// ─── Full acceptance sequence (items 1.1–1.5) ────────────────────────────────

/**
 * Accepts a charter: validates the model parameters, refuses a charter inside
 * the work directory, re-hashes the file, and applies the owner decision.
 *
 * modelParams carry only what the model may say ({charter_path}); trusted
 * carries the calling layer's data: expectedSha256 (headless, from the
 * owner's launch argument) or the interactive triple hasUI/ownerConfirmed/
 * shownSha256. The interactive confirmation is bound to shownSha256: the
 * current file hash must equal it, otherwise the acceptance refuses with
 * charter_changed even though ownerConfirmed is true. An interactive consent
 * without shownSha256 refuses — an unbound consent is not evidence.
 * Nothing is written in any refused case.
 */
export async function acceptCharter(
  charterPath: string,
  workDir: string,
  modelParams: CharterModelParams,
  trusted: TrustedCharterConsent,
): Promise<CharterResult<{ charter: Charter; sha256: string }>> {
  const callCheck = validateCharterCall(modelParams);
  if (!callCheck.ok) return callCheck;
  if (typeof charterPath !== "string" || charterPath.trim() === "") {
    return refuse("invalid_argument", "charter_path must be a non-empty string");
  }
  if (typeof workDir !== "string" || workDir.trim() === "") {
    return refuse("invalid_argument", "work directory must be a non-empty string");
  }
  if (!isRecord(trusted)) {
    return refuse("invalid_argument", "trusted consent data must be an object supplied by the calling layer");
  }
  // Headless and interactive consent channels are mutually exclusive: mixing
  // them lets a stale expectedSha256 bypass the shownSha256 binding (or record
  // consent despite ownerConfirmed: false).
  const interactiveKeys = ["hasUI", "ownerConfirmed", "shownSha256"] as const;
  if (trusted.expectedSha256 !== undefined && interactiveKeys.some((k) => trusted[k] !== undefined)) {
    return refuse("invalid_argument", "expectedSha256 (headless) and the interactive consent fields are mutually exclusive; pass one channel only");
  }
  if (typeof modelParams.charter_path === "string" && modelParams.charter_path !== charterPath) {
    return refuse("invalid_argument", "modelParams.charter_path does not match the charter path being accepted");
  }

  let inside: boolean;
  try {
    inside = await charterInsideWorkdir(charterPath, workDir);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return refuse("charter_unreadable", `charter path cannot be resolved (${oneLine(text)})`);
  }
  if (inside) {
    return refuse("charter_inside_workdir", `charter file ${quote(charterPath)} is inside the work directory; the charter must live outside it`);
  }

  // Headless path: the owner-supplied launch argument is the source of truth.
  if (trusted.expectedSha256 !== undefined) {
    if (typeof trusted.expectedSha256 !== "string" || !SHA256_RE.test(trusted.expectedSha256)) {
      return refuse("invalid_argument", "the owner's expected charter hash must be 64 lowercase hex characters");
    }
    return confirmCharter(charterPath, trusted.expectedSha256);
  }

  // Interactive path: the owner must confirm through a dialog channel, and
  // the consent must be bound to the hash the dialog showed.
  if (trusted.hasUI !== true) {
    return refuse("invalid_argument", "interactive charter confirmation requires a UI; headless runs must pass the owner's expected hash");
  }
  if (trusted.ownerConfirmed !== true) {
    return refuse("invalid_argument", "the owner has not confirmed the charter: no dialog consent was recorded");
  }
  if (typeof trusted.shownSha256 !== "string" || !SHA256_RE.test(trusted.shownSha256)) {
    return refuse("invalid_argument", "interactive confirmation requires the shown charter hash (64 lowercase hex characters)");
  }
  return confirmCharter(charterPath, trusted.shownSha256);
}
