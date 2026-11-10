/**
 * chain-briefs (openspec/changes/research-charter, task 2.x):
 * mechanical auto-approval checks for the next campaign's brief in a
 * research-charter chain, and the chain-sourced approval.json writer.
 *
 * The module is pure decision logic plus one file write. The caller (index.ts
 * integration, next wave) supplies the parent brief, the child brief bytes
 * hash, the campaign journals (the source of truth for closed questions), the
 * chain status and the already-approved brief hashes.
 *
 * Refusals are one-line messages; a refused check never writes anything.
 *
 * Run: timeout 60 node --experimental-strip-types --experimental-loader
 * ./tests/redirect-loader.mjs --test tests/chain-briefs.test.mjs
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_FILE,
  validateBrief,
  briefVerdicts,
  writeFileAtomic,
  sha256Hex,
  type Approval,
  type EvidenceGate,
  type ResearchBrief,
} from "./research-state.ts";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Status the chain must be in for a child brief to be auto-approved. */
const AWAITING_CHILD = "awaiting_child";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A question extended with the chain-finding references (next-wave schema). */
export interface ExtendedQuestion {
  id: string;
  finding_refs?: Array<{ campaign: string; question: string }>;
}

/** One closed question as recorded by a campaign journal. */
export interface ClosedQuestion {
  questionId: string;
  verdict: string;
  hasEvidence: boolean;
}

/** Journal slice of one chain campaign. */
export interface CampaignJournal {
  campaignId: string;
  closedQuestions: ClosedQuestion[];
  /** Effective verdict set of that campaign's brief (briefVerdicts); absent = the four defaults. */
  verdicts?: string[];
}

export interface ChainBriefParams {
  parentBrief: ResearchBrief;
  parentCampaignId: string;
  childBriefRaw: unknown;
  childBriefSha256: string;
  charter: { max_campaigns?: number; max_depth?: number };
  chainStatus: string;
  campaignJournals: CampaignJournal[];
  campaignCount?: number;
  newDepth?: number;
  approvedBriefHashes: string[];
}

export interface ChainBriefSnapshot {
  caveat_block: string;
  verdicts: string[];
  evidence_gate: EvidenceGate | undefined;
  campaign_id: string;
}

export type ChainBriefRefusalReason =
  | "parent_not_reported"
  | "brief_invalid"
  | "duplicate_brief"
  | "caveat_changed"
  | "verdicts_or_gate_changed"
  | "finding_missing"
  | "limit_reached"
  | "invalid_argument"
  | "approval_invalid"
  | "io_failed";

export interface ChainBriefRefusal {
  ok: false;
  reason: ChainBriefRefusalReason;
  /** One line, safe to show. */
  message: string;
}

export type ChainBriefResult =
  | ({ ok: true; duplicate?: true; childBrief: ResearchBrief; snapshot: ChainBriefSnapshot })
  | ChainBriefRefusal;

/** approval.json written by the chain (task 2.1): base approval + provenance. */
export interface ApprovalWithSource extends Approval {
  source: "charter";
  charter_sha256: string;
}

function refuse(reason: ChainBriefRefusalReason, message: string): ChainBriefRefusal {
  return { ok: false, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Escape control characters so a message stays one honest line. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

function quote(s: string): string {
  return oneLine(JSON.stringify(s));
}

/** Sorted copy: set semantics for verdict names. */
function sortedVerdicts(names: string[]): string[] {
  return [...names].sort();
}

/** Sorted unique copy: set semantics for glob lists. */
function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Evidence gate compared with arrays as sets (order- and duplicate-insensitive). */
export function sameEvidenceGate(a: EvidenceGate | undefined, b: EvidenceGate | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.gate_file !== b.gate_file || a.gate_contains !== b.gate_contains) return false;
  if (!Array.isArray(a.blocked_globs) || !Array.isArray(b.blocked_globs)) return false;
  const left = sortedUnique(a.blocked_globs);
  const right = sortedUnique(b.blocked_globs);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * True when the pair points at a question closed with evidence under a verdict
 * from that campaign's effective verdict set. The verdict check follows the
 * spec: a finding is a question closed by a verdict the campaign's brief
 * declares — a closure under an undeclared verdict is not a finding.
 */
function refMatches(
  journals: CampaignJournal[],
  campaign: string,
  question: string,
): boolean {
  const journal = journals.find((j) => j.campaignId === campaign);
  if (!journal) return false;
  const allowed = sortedVerdicts(briefVerdicts(journal));
  const closed = journal.closedQuestions.find((q) => q.questionId === question);
  return (
    closed !== undefined &&
    closed.hasEvidence === true &&
    allowed.includes(closed.verdict)
  );
}

// ─── The mechanical check (spec: «Автоподтверждение брифа цепочки») ─────────

/**
 * Runs every auto-approval check in spec order. Returns the validated child
 * brief and the parent snapshot to record in chain.json, or the named refusal.
 * A duplicate brief hash short-circuits with duplicate:true and no new data.
 *
 * campaignJournals must contain only the campaigns of THIS chain: the module
 * cannot distinguish a foreign chain's journal from this chain's, that filter
 * is the caller's duty (the caller reads the campaign list from chain.json).
 */
export function approveChainBrief(params: ChainBriefParams): ChainBriefResult {
  const p = params;
  if (!isRecord(p) || typeof p !== "object") return refuse("invalid_argument", "params must be an object");

  // 1) The chain must be waiting for the child brief (parent report recorded).
  if (p.chainStatus !== AWAITING_CHILD) {
    return refuse(
      "parent_not_reported",
      `the parent's intermediate report is not recorded (chain status ${quote(p.chainStatus)}); write the parent report first`,
    );
  }

  // 2) Standard brief schema (spec: «Бриф не проходит схему»).
  const validation = validateBrief(p.childBriefRaw);
  if (!validation.ok) {
    return refuse(
      "brief_invalid",
      `brief rejected (${validation.errors.length} problem(s)): ${validation.errors.join("; ")}`,
    );
  }
  const childBrief = validation.brief;

  // 3) Resubmission of an already-approved brief creates no second campaign.
  if (p.approvedBriefHashes.includes(p.childBriefSha256)) {
    return {
      ok: true,
      duplicate: true,
      childBrief,
      snapshot: emptySnapshot(p),
    };
  }

  // 4) The caveat block must be verbatim equal to the parent's.
  if (childBrief.caveat_block !== p.parentBrief.caveat_block) {
    return refuse("caveat_changed", "the caveat block differs from the parent campaign's caveat block");
  }

  // 5) Effective verdict sets must match (absent verdicts = default set).
  const parentSet = sortedVerdicts(briefVerdicts(p.parentBrief));
  const childSet = sortedVerdicts(briefVerdicts(childBrief));
  if (parentSet.length !== childSet.length || parentSet.some((v, i) => v !== childSet[i])) {
    return refuse(
      "verdicts_or_gate_changed",
      `the effective verdict set differs from the parent's (${parentSet.join(", ")} vs ${childSet.join(", ")})`,
    );
  }

  // 6) evidence_gate compared as an object with arrays as sets.
  if (!sameEvidenceGate(p.parentBrief.evidence_gate, childBrief.evidence_gate)) {
    return refuse("verdicts_or_gate_changed", "the evidence_gate differs from the parent campaign's evidence_gate");
  }

  // 7) Every question must reference a chain finding closed with evidence.
  const questions = childBrief.questions as Array<BriefQuestionLike>;
  for (const q of questions) {
    const extended = q as ExtendedQuestion;
    const refs = extended.finding_refs;
    if (!Array.isArray(refs) || refs.length === 0) {
      return refuse("finding_missing", `question ${quote(q.id)} has no finding_refs: every chain question must cite a closed chain finding`);
    }
    for (const ref of refs) {
      if (!isRecord(ref) || typeof ref.campaign !== "string" || typeof ref.question !== "string") {
        return refuse("finding_missing", `question ${quote(q.id)} has a malformed finding_refs entry: expected {campaign, question} strings`);
      }
      if (!refMatches(p.campaignJournals, ref.campaign, ref.question)) {
        return refuse(
          "finding_missing",
          `question ${quote(q.id)} cites ${quote(ref.campaign)}/${quote(ref.question)} which is not a question closed with evidence under a declared verdict in this chain`,
        );
      }
    }
  }

  // 8) Charter limits, when set (root has depth 0; campaign count includes the root).
  if (p.charter.max_campaigns !== undefined && typeof p.campaignCount === "number" && p.campaignCount > p.charter.max_campaigns) {
    return refuse(
      "limit_reached",
      `campaign limit reached: ${p.campaignCount} campaigns would exceed max_campaigns ${p.charter.max_campaigns}`,
    );
  }
  if (p.charter.max_depth !== undefined && typeof p.newDepth === "number" && p.newDepth > p.charter.max_depth) {
    return refuse(
      "limit_reached",
      `depth limit reached: new campaign depth ${p.newDepth} would exceed max_depth ${p.charter.max_depth}`,
    );
  }

  return {
    ok: true,
    childBrief,
    snapshot: {
      caveat_block: p.parentBrief.caveat_block,
      verdicts: parentSet,
      evidence_gate: p.parentBrief.evidence_gate,
      campaign_id: p.parentCampaignId,
    },
  };
}

type BriefQuestionLike = { id: string };

function emptySnapshot(p: ChainBriefParams): ChainBriefSnapshot {
  return {
    caveat_block: p.parentBrief.caveat_block,
    verdicts: sortedVerdicts(briefVerdicts(p.parentBrief)),
    evidence_gate: p.parentBrief.evidence_gate,
    campaign_id: p.parentCampaignId,
  };
}

// ─── Chain-sourced approval.json (task 2.1) ──────────────────────────────────

/**
 * Writes approval.json for an auto-approved chain brief: the standard Approval
 * shape plus the charter provenance (source: "charter", charter_sha256).
 * Refuses when approval.json already exists (never rewritten). The caller
 * passes both hashes it has verified.
 */
export async function writeChainApproval(
  dir: string,
  briefSha256: string,
  charterSha256: string,
): Promise<{ ok: true; approval: ApprovalWithSource } | ChainBriefRefusal> {
  if (typeof briefSha256 !== "string" || !SHA256_RE.test(briefSha256)) {
    return refuse("invalid_argument", "brief hash must be 64 lowercase hex characters");
  }
  if (typeof charterSha256 !== "string" || !SHA256_RE.test(charterSha256)) {
    return refuse("invalid_argument", "charter hash must be 64 lowercase hex characters");
  }
  if (existsSync(join(dir, APPROVAL_FILE))) {
    return refuse("approval_invalid", "the brief is already approved; approval.json is never rewritten");
  }
  const approval: ApprovalWithSource = {
    schema_version: APPROVAL_SCHEMA_VERSION,
    brief_sha256: briefSha256,
    approved_at: new Date().toISOString(),
    confirmed: true,
    source: "charter",
    charter_sha256: charterSha256,
  };
  try {
    await writeFileAtomic(join(dir, APPROVAL_FILE), JSON.stringify(approval, null, 2) + "\n");
  } catch (err) {
    return refuse("io_failed", `approval.json cannot be written (${oneLine(err instanceof Error ? err.message : String(err))}); nothing was approved`);
  }
  return { ok: true, approval };
}
