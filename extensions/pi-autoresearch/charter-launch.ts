/**
 * charter-launch.ts — canonical charter drafts and the filesystem half of a
 * first interactive chain launch.
 *
 * Scope: openspec/changes/charter-interactive-launch, two-phase formation and
 * commit-then-launch requirements.
 *
 * Trust model: callers validate the draft and supply the already selected
 * charter path; model parameters never carry owner approval or hashes.
 *
 * What this module guarantees: canonical bytes are written exclusively,
 * re-read and hash-checked before a chain journal is created; failures roll
 * back files created by this operation on a best-effort basis.
 *
 * Not promised: UI/runtime state, owner consent, kickoff delivery, or path
 * containment. The caller MUST supply a charterPath outside workDir.
 */
import { writeFile, readFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateCharter, charterDialogText, type Charter, type CharterResult, type CharterRefusal } from "./charter.ts";
import { sha256Hex } from "./research-state.ts";
import { createChain } from "./chain-journal.ts";

export interface CharterDraft { charter: Charter; shownSha256: string }
export interface CharterFirstLaunch { path: string; sha256: string; chainId: string; rootCampaignId: string }

type LaunchReason = "invalid_argument" | "charter_dialog_closed" | "chain_active" | "charter_invalid" | "charter_draft_missing" | "charter_path_taken" | "charter_changed" | "operation_failed";
type LaunchRefusal = { ok: false; reason: LaunchReason | string; message: string };
export type Refusal = CharterRefusal | LaunchRefusal;
export type Result<T> = ({ ok: true } & T) | Refusal;

function refuse(reason: LaunchReason | string, message: string): LaunchRefusal { return { ok: false, reason, message: oneLine(message) }; }
function oneLine(s: string): string { return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")); }
function quote(s: string): string { return oneLine(JSON.stringify(s)); }
function errorText(err: unknown): string { return oneLine(err instanceof Error ? err.message : String(err)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorCode(err: unknown): string | undefined { return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined; }

export function serializeCharter(charter: Charter): string { return JSON.stringify(charter, null, 2) + "\n"; }

/** Accepts (mode, params), where mode is draft or propose. */
export function validateCharterLaunchCall(mode: "draft" | "propose", params?: unknown): CharterResult<{}>;
export function validateCharterLaunchCall(params: unknown, mode: "draft" | "propose"): CharterResult<{}>;
export function validateCharterLaunchCall(first: unknown, second?: unknown): CharterResult<{}> {
  const mode = first === "draft" || first === "propose" ? first : second;
  const params = first === "draft" || first === "propose" ? second : first;
  if (mode !== "draft" && mode !== "propose") return refuse("invalid_argument", "charter launch mode must be draft or propose");
  if (params === undefined && mode === "propose") return { ok: true };
  if (!isRecord(params)) return refuse("invalid_argument", "charter launch parameters must be an object");
  const allowed = mode === "draft" ? ["charter"] : [];
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length) return refuse("invalid_argument", `charter launch has unknown field ${quote(unknown[0])}`);
  if (mode === "draft" && !Object.hasOwn(params, "charter")) return refuse("invalid_argument", "draft requires charter");
  return { ok: true };
}

export function validateDraftCharter(raw: unknown): CharterResult<{ charter: Charter }> {
  const result = validateCharter(raw);
  if (!result.ok) return refuse("charter_invalid", result.errors.join("; "));
  return { ok: true, charter: result.charter };
}

export interface LaunchFromDraftOptions {
  charter: Charter; workDir: string; rootId: string; charterPath: string;
  writeFileExclusive?: (path: string, bytes: string) => Promise<void>;
  readFileUtf8?: (path: string) => Promise<string>;
  removeFile?: (path: string) => Promise<void>;
  createChainJournal?: (workDir: string, chainId: string, rootId: string) => Promise<{ ok: boolean; reason?: string; message?: string }>;
}

export async function launchFromDraft(opts: LaunchFromDraftOptions): Promise<Result<{ firstLaunch: CharterFirstLaunch } | { alreadyLaunched: CharterFirstLaunch }>> {
  const bytes = serializeCharter(opts.charter);
  const sha = sha256Hex(bytes);
  const remove = opts.removeFile ?? (async (path: string) => unlink(path));
  try {
    if (opts.writeFileExclusive) await opts.writeFileExclusive(opts.charterPath, bytes);
    else await writeFile(opts.charterPath, bytes, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (errorCode(err) === "EEXIST") return refuse("charter_path_taken", `charter path ${quote(opts.charterPath)} already exists`);
    return refuse("operation_failed", `cannot write charter (${errorText(err)})`);
  }
  let reread: string;
  try { reread = await (opts.readFileUtf8 ?? (async (path) => readFile(path, "utf8")))(opts.charterPath); }
  catch (err) {
    try { await remove(opts.charterPath); } catch { /* best effort rollback */ }
    return refuse("charter_changed", `charter could not be verified (${errorText(err)})`);
  }
  if (sha256Hex(reread) !== sha) {
    try { await remove(opts.charterPath); } catch { /* best effort rollback */ }
    return refuse("charter_changed", "charter bytes changed after writing");
  }
  const chainId = opts.rootId + "-chain";
  const create = opts.createChainJournal ?? createChain;
  const chain = await create(opts.workDir, chainId, opts.rootId);
  if (!chain.ok) {
    try { await remove(opts.charterPath); } catch { /* best effort rollback */ }
    // campaign_exists means the journal predates this launch; never remove another session's chain.
    if (chain.reason !== "campaign_exists") {
      try { await rm(join(opts.workDir, ".auto", "research-chain", chainId), { recursive: true, force: true }); } catch { /* best effort rollback */ }
    }
    return refuse(chain.reason ?? "operation_failed", chain.message ?? "chain journal creation failed");
  }
  return { ok: true, firstLaunch: { path: opts.charterPath, sha256: sha, chainId, rootCampaignId: opts.rootId } };
}

export function charterLaunchDialogText(charter: Charter, sha256: string): string { return charterDialogText(charter, sha256); }
