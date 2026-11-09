// Two-phase start for the ordinary optimization loop (openspec: optimize-two-phase-start).
// Phase 1: optimize_brief draft writes a canonical brief to .auto/optimize/brief.json; propose
// shows it to the owner and records approval.json with the SHA-256 of the brief bytes.
// Phase 2 is init_experiment, which refuses unless the approval matches the brief and its
// arguments. This module holds the pure rules and the small file I/O they need.

import * as fs from "node:fs";
import * as path from "node:path";
import { consentDialogBody, CONSENT_SUMMARY_MAX_LINES } from "./brief-consent.ts";
import { sha256Hex } from "./research-state.ts";

export const OPTIMIZE_DIR_SEGMENTS = [".auto", "optimize"] as const;
export const OPTIMIZE_BRIEF_FILE = "brief.json";
export const OPTIMIZE_APPROVAL_FILE = "approval.json";
/** Same budget as the research consent dialog (shared in brief-consent.ts). */
export const OPTIMIZE_CONSENT_MAX_LINES = CONSENT_SUMMARY_MAX_LINES;

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
  if (obj.cwd !== undefined && (typeof obj.cwd !== "string" || !/[^\s\p{Cf}]/u.test(obj.cwd))) {
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

/** Validates and writes brief.json in canonical form. Nothing is written when validation fails. */
export function writeOptimizeBriefDraft(dir: string, input: unknown): DraftResult {
  const validation = validateOptimizeBrief(input);
  if (!validation.ok) return validation;
  const bytes = canonicalBriefBytes(validation.brief);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OPTIMIZE_BRIEF_FILE), bytes, "utf-8");
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

/** Records the owner's decision. A refusal is recorded too, so it is visible in the state dir. */
export function writeOptimizeApproval(dir: string, confirmed: boolean, sha256: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const approval: OptimizeApproval = {
    schema_version: 1,
    confirmed,
    brief_sha256: sha256,
    decided_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, OPTIMIZE_APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n", "utf-8");
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
  try {
    const parsed = JSON.parse(raw) as Partial<OptimizeApproval>;
    if (typeof parsed.confirmed !== "boolean" || typeof parsed.brief_sha256 !== "string") {
      return { ok: false, reason: "approval_invalid", message: "approval.json has no confirmed flag or hash" };
    }
    return { ok: true, approval: parsed as OptimizeApproval };
  } catch {
    return { ok: false, reason: "approval_invalid", message: "approval.json is not valid JSON" };
  }
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
