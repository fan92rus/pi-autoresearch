// Two-phase start for the ordinary optimization loop (openspec: optimize-two-phase-start).
// Phase 1: optimize_brief draft writes a canonical brief to .auto/optimize/brief.json; propose
// shows it to the owner and records approval.json with the SHA-256 of the brief bytes.
// Phase 2 is init_experiment, which refuses unless the approval matches the brief and its
// arguments. This module holds the pure rules and the small file I/O they need.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { consentDialogBody, CONSENT_SUMMARY_MAX_LINES } from "./brief-consent.ts";
import { sha256Hex } from "./research-state.ts";

export const OPTIMIZE_DIR_SEGMENTS = [".auto", "optimize"] as const;
export const OPTIMIZE_BRIEF_FILE = "brief.json";
export const OPTIMIZE_APPROVAL_FILE = "approval.json";
/** Same budget as the research consent dialog (shared in brief-consent.ts). */
export const OPTIMIZE_CONSENT_MAX_LINES = CONSENT_SUMMARY_MAX_LINES;

/** Whitespace, format characters, combining marks and blank glyphs: a path made only of these looks empty in the dialog. */
const INVISIBLE_PATH_CHARS = /[\s\p{Cf}\p{Mn}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/** True when a path would display as empty (the same rule for the brief and for init_experiment's cwd). */
export function isBlankPath(p: string): boolean {
  return p.replace(INVISIBLE_PATH_CHARS, "").length === 0;
}

const BRIEF_KEYS = new Set(["schema_version", "name", "metric_name", "metric_unit", "direction", "cwd"]);
const DIRECTIONS = new Set(["lower", "higher"]);

/** The brief as the owner approves it. Optional fields keep the init_experiment defaults. */
export interface OptimizeBrief {
  schema_version: 1;
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: "lower" | "higher";
  cwd?: string;
}

export type BriefValidation = { ok: true; brief: OptimizeBrief } | { ok: false; errors: string[] };

/** Recursively sorts object keys; arrays keep their order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Validates an untrusted brief object. Unknown fields are refused, never dropped. */
export function validateOptimizeBrief(input: unknown): BriefValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["brief must be a JSON object"] };
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!BRIEF_KEYS.has(key)) errors.push(`unknown field "${key}" (allowed: ${[...BRIEF_KEYS].join(", ")})`);
  }
  if (obj.schema_version !== undefined && obj.schema_version !== 1) errors.push("schema_version must be 1");
  for (const key of ["name", "metric_name"] as const) {
    const v = obj[key];
    if (typeof v !== "string" || v.trim() === "") errors.push(`${key} must be a non-empty string`);
  }
  if (obj.metric_unit !== undefined && typeof obj.metric_unit !== "string") errors.push("metric_unit must be a string");
  if (obj.direction !== undefined && (typeof obj.direction !== "string" || !DIRECTIONS.has(obj.direction))) {
    errors.push('direction must be "lower" or "higher"');
  }
  if (obj.cwd !== undefined && (typeof obj.cwd !== "string" || isBlankPath(obj.cwd))) {
    errors.push("cwd must be a non-empty string");
  }
  // Every string field is one physical line: a newline would break the dialog budget and the markdown list.
  for (const key of ["name", "metric_name", "metric_unit", "cwd"] as const) {
    const v = obj[key];
    if (typeof v === "string" && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) errors.push(`${key} must be a single line (no control characters)`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const brief: OptimizeBrief = {
    schema_version: 1,
    name: obj.name as string,
    metric_name: obj.metric_name as string,
    ...(obj.metric_unit !== undefined ? { metric_unit: obj.metric_unit as string } : {}),
    ...(obj.direction !== undefined ? { direction: obj.direction as "lower" | "higher" } : {}),
    ...(obj.cwd !== undefined ? { cwd: obj.cwd as string } : {}),
  };
  return { ok: true, brief };
}

/** The direction the session runs with: the brief default is "lower", as in init_experiment. */
export function effectiveDirection(brief: OptimizeBrief): "lower" | "higher" {
  return brief.direction ?? "lower";
}

/** Canonical bytes: sorted keys, schema_version 1, two-space indent, trailing newline. */
export function canonicalBriefBytes(brief: OptimizeBrief): string {
  return JSON.stringify(canonicalize(brief), null, 2) + "\n";
}

export function optimizeDirOf(baseDir: string): string {
  return path.join(baseDir, ...OPTIMIZE_DIR_SEGMENTS);
}

export type DraftResult = { ok: true; sha256: string } | { ok: false; errors: string[] };

/**
 * Atomic text write: a temporary file (wx), fsync, then rename over the target. A failure keeps the
 * previous target content and removes the temporary file. `rename` is injectable for the failure test.
 */
export function writeTextAtomicSync(
  target: string,
  text: string,
  rename: (from: string, to: string) => void = fs.renameSync,
): void {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(fd, text, "utf-8");
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    rename(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Validates and writes brief.json in canonical form. Nothing is written when validation fails. */
export function writeOptimizeBriefDraft(dir: string, input: unknown): DraftResult {
  const validation = validateOptimizeBrief(input);
  if (!validation.ok) return validation;
  const bytes = canonicalBriefBytes(validation.brief);
  fs.mkdirSync(dir, { recursive: true });
  writeTextAtomicSync(path.join(dir, OPTIMIZE_BRIEF_FILE), bytes);
  return { ok: true, sha256: sha256Hex(bytes) };
}

export type ReadBriefResult =
  | { ok: true; brief: OptimizeBrief; sha256: string }
  | { ok: false; reason: "brief_missing" | "brief_invalid"; message: string };

/** Reads brief.json and hashes the same bytes. */
export function readOptimizeBrief(dir: string): ReadBriefResult {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(dir, OPTIMIZE_BRIEF_FILE));
  } catch {
    return { ok: false, reason: "brief_missing", message: "no brief draft: call optimize_brief draft first" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return { ok: false, reason: "brief_invalid", message: "brief.json is not valid JSON" };
  }
  const validation = validateOptimizeBrief(parsed);
  if (!validation.ok) return { ok: false, reason: "brief_invalid", message: validation.errors.join("; ") };
  return { ok: true, brief: validation.brief, sha256: sha256Hex(bytes) };
}

export interface OptimizeApproval {
  schema_version: 1;
  confirmed: boolean;
  brief_sha256: string;
  decided_at: string;
}

const APPROVAL_KEYS = new Set(["schema_version", "confirmed", "brief_sha256", "decided_at"]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Strict rules shared in spirit with research approval: exact fields, typed values, lowercase hex hash. */
export function approvalProblem(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "approval is not an object";
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!APPROVAL_KEYS.has(key)) return `unknown field "${key}"`;
  }
  if (o.schema_version !== 1) return "schema_version must be 1";
  if (typeof o.brief_sha256 !== "string" || !SHA256_HEX_RE.test(o.brief_sha256)) {
    return "brief_sha256 must be 64 lowercase hex characters";
  }
  if (typeof o.confirmed !== "boolean") return "confirmed must be a boolean";
  if (typeof o.decided_at !== "string" || o.decided_at === "") return "decided_at must be a non-empty string";
  return null;
}

export type ApprovalWrite = { ok: true } | { ok: false; message: string };

/**
 * Records the owner's decision. A refusal is recorded too (confirmed false, brief not re-checked).
 * A confirmation is written only when brief.json on disk still has the hash the owner was shown.
 */
export function writeOptimizeApproval(dir: string, confirmed: boolean, sha256: string): ApprovalWrite {
  if (confirmed) {
    const current = readOptimizeBrief(dir);
    if (!current.ok || current.sha256 !== sha256) {
      return { ok: false, message: "brief.json changed while it was shown for confirmation; show the brief again with optimize_brief propose" };
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const approval: OptimizeApproval = {
    schema_version: 1,
    confirmed,
    brief_sha256: sha256,
    decided_at: new Date().toISOString(),
  };
  writeTextAtomicSync(path.join(dir, OPTIMIZE_APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n");
  return { ok: true };
}

export type ApprovalResult =
  | { ok: true; approval: OptimizeApproval }
  | { ok: false; reason: "not_approved" | "approval_invalid"; message: string };

export function readOptimizeApproval(dir: string): ApprovalResult {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, OPTIMIZE_APPROVAL_FILE), "utf-8");
  } catch {
    return { ok: false, reason: "not_approved", message: "brief is not approved yet" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "approval_invalid", message: "approval.json is not valid JSON" };
  }
  const problem = approvalProblem(parsed);
  if (problem) return { ok: false, reason: "approval_invalid", message: `approval.json failed validation: ${problem}` };
  return { ok: true, approval: parsed as OptimizeApproval };
}

/** Phase 2 gate: an approved brief whose bytes still match the approval. */
export function approvedBriefFor(dir: string): { ok: true; brief: OptimizeBrief; sha256: string } | { ok: false; reason: string; message: string } {
  const brief = readOptimizeBrief(dir);
  if (!brief.ok) return { ok: false, reason: brief.reason, message: brief.message };
  const approval = readOptimizeApproval(dir);
  if (!approval.ok) return { ok: false, reason: approval.reason, message: approval.message };
  if (approval.approval.confirmed !== true) {
    return { ok: false, reason: "not_approved", message: "the owner refused this brief: draft a new one and propose it again" };
  }
  if (approval.approval.brief_sha256 !== brief.sha256) {
    return { ok: false, reason: "stale_approval", message: "brief.json changed after approval: run optimize_brief propose again" };
  }
  return { ok: true, brief: brief.brief, sha256: brief.sha256 };
}

/** The init_experiment arguments must equal the approved brief (defaults applied on both sides). */
export function initArgsMismatch(
  brief: OptimizeBrief,
  args: { name: string; metric_name: string; metric_unit?: string; direction?: string; cwd?: string },
): string[] {
  const diffs: string[] = [];
  if (args.name !== brief.name) diffs.push(`name: brief "${brief.name}", init "${args.name}"`);
  if (args.metric_name !== brief.metric_name) diffs.push(`metric_name: brief "${brief.metric_name}", init "${args.metric_name}"`);
  const unit = args.metric_unit ?? "";
  if (unit !== (brief.metric_unit ?? "")) diffs.push(`metric_unit: brief "${brief.metric_unit ?? ""}", init "${unit}"`);
  const dir = args.direction ?? "lower";
  if (dir !== (brief.direction ?? "lower")) diffs.push(`direction: brief "${brief.direction ?? "lower"}", init "${dir}"`);
  // Compared as resolved paths, the same way init_experiment resolves params.cwd.
  const sameCwd =
    (args.cwd === undefined && brief.cwd === undefined) ||
    (args.cwd !== undefined && brief.cwd !== undefined && path.resolve(args.cwd) === path.resolve(brief.cwd));
  if (!sameCwd) diffs.push(`cwd: brief "${brief.cwd ?? ""}", init "${args.cwd ?? ""}"`);
  return diffs;
}

/** Full brief as readable Markdown for the transcript row (not JSON). */
export function optimizeBriefMarkdown(brief: OptimizeBrief, sha256: string): string {
  return [
    "## Бриф оптимизации — на согласование",
    "",
    `SHA-256 брифа: \`${sha256}\``,
    "",
    `**Название сессии.** ${brief.name}`,
    `**Метрика.** ${brief.metric_name}${brief.metric_unit ? ` (${brief.metric_unit})` : ""}`,
    `**Направление.** ${brief.direction ?? "lower"} — ${(brief.direction ?? "lower") === "lower" ? "меньше лучше" : "больше лучше"}`,
    `**Рабочий каталог.** ${brief.cwd ?? "по умолчанию (каталог сессии)"}`,
  ].join("\n");
}

/** Consent dialog body for the ordinary loop, built by the shared consentDialogBody. */
export function optimizeConsentSummary(brief: OptimizeBrief, sha256: string): string {
  return consentDialogBody(
    sha256,
    [
      `Название: ${brief.name}`,
      `Метрика: ${brief.metric_name}${brief.metric_unit ? ` (${brief.metric_unit})` : ""}; направление: ${brief.direction ?? "lower"}`,
      `Каталог: ${brief.cwd ?? "по умолчанию"}`,
    ],
    "Подтвердить согласование?",
  );
}
