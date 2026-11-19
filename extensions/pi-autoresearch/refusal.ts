/**
 * Shared refusal text renderer and campaign inspection/refusal vocabulary
 * (bd pi-autoresearch-161.4, bd tj0.8).
 *
 * Keeps the existing wire format byte-for-byte: `⛔ ${reason}: ${message}`.
 * A null reason interpolates as "null", exactly as the previous inline
 * template literals did; callers with no reason should not render a refusal.
 */

/** Every read-only inspectCampaign status of BOTH campaign modules. */
export type CampaignInspectionStatus =
  | "uninitialized"
  | "ready"
  | "disabled"
  | "state_unreadable"
  | "manual_check_required"
  | "invalid_argument";

/** Reasons shared by the candidate and research RefusalReason unions. */
export type InspectionRefusalReason =
  | "invalid_argument"
  | "not_initialized"
  | "state_unreadable"
  | "manual_check_required";

/** Single-line refusal text from any module refusal shape. */
export function renderRefusal(r: { reason: string | null; message: string }): string {
  return `⛔ ${r.reason}: ${r.message}`;
}

/**
 * The ONE inspection->refusal adapter. Research uses uninitialized/ready/
 * state_unreadable/manual_check_required/invalid_argument; candidate adds
 * disabled. No new reason is introduced: "ready" is not a refusal (null),
 * "uninitialized" uses the existing not_initialized, and candidate "disabled"
 * maps conservatively to manual_check_required (an operator must decide; the
 * reason exists in BOTH vocabularies).
 */
const INSPECTION_REFUSALS: Readonly<Record<CampaignInspectionStatus, InspectionRefusalReason | null>> = {
  invalid_argument: "invalid_argument",
  uninitialized: "not_initialized",
  state_unreadable: "state_unreadable",
  manual_check_required: "manual_check_required",
  disabled: "manual_check_required",
  ready: null,
};

export function inspectionRefusalReason(status: string): InspectionRefusalReason | null {
  return Object.prototype.hasOwnProperty.call(INSPECTION_REFUSALS, status)
    ? INSPECTION_REFUSALS[status as CampaignInspectionStatus]
    : null;
}

/** Every existing refusal literal of the candidate and research vocabularies. */
const KNOWN_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  // candidate-state.ts
  "invalid_argument", "not_initialized", "already_initialized", "state_unreadable",
  "lock_busy", "lock_unreadable", "manual_check_required", "campaign_disabled",
  "second_active_candidate", "duplicate_candidate", "unknown_candidate",
  "candidate_not_active", "candidate_closed", "checkpoint_not_owned",
  "duplicate_checkpoint", "budget_exhausted", "invalid_transition", "operation_failed",
  // research-state.ts
  "evidence_gate_blocked", "campaign_missing", "campaign_exists", "brief_invalid",
  "brief_unreadable", "brief_missing", "brief_changed", "brief_approved",
  "not_approved", "approval_invalid", "io_failed",
]);

/**
 * Canonical reason for tool details without touching reason/message text.
 * Tool-local reasons outside both unions (worktree, expedition, policy, ...)
 * degrade to the existing conservative operation_failed rather than inventing
 * a new literal or leaking a raw inspection status such as "disabled".
 */
export function canonicalRefusalReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const inspection = inspectionRefusalReason(reason);
  if (inspection !== null) return inspection;
  return KNOWN_REFUSAL_REASONS.has(reason) ? reason : "operation_failed";
}

/** Refusal details for adapters whose existing `reason` field is kept as-is. */
export function refusalDetails(reason: string | null | undefined): { refusal_reason: string } {
  return { refusal_reason: canonicalRefusalReason(reason) ?? "operation_failed" };
}
