/**
 * Shared refusal text renderer (bd pi-autoresearch-161.4).
 *
 * Keeps the existing wire format byte-for-byte: `⛔ ${reason}: ${message}`.
 * A null reason interpolates as "null", exactly as the previous inline
 * template literals did; callers with no reason should not render a refusal.
 */

import type { RefusalReason } from "./research-state.ts";

/** Single-line refusal text from any module refusal shape. */
export function renderRefusal(r: { reason: string | null; message: string }): string {
  return `⛔ ${r.reason}: ${r.message}`;
}

/**
 * Maps the read-only inspectCampaign status vocabulary onto the existing
 * researchState.RefusalReason values. No new reason is introduced: "ready" is
 * not a refusal (null), and "uninitialized" uses the existing not_initialized.
 */
export function inspectionRefusalReason(status: string): RefusalReason | null {
  switch (status) {
    case "invalid_argument":
      return "invalid_argument";
    case "manual_check_required":
      return "manual_check_required";
    case "state_unreadable":
      return "state_unreadable";
    case "uninitialized":
      return "not_initialized";
    case "ready":
      return null;
    default:
      return null;
  }
}
