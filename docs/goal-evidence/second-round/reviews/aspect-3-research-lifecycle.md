ЕСТЬ ТЕХДОЛГ

[category: bug] [severity: major] index.ts:4602 — `blockingCampaignIds` treats any `stopped`-phase campaign as finished even when `inspectCampaign` reports `manual_check_required`/`state_unreadable`; this contradicts `RESEARCH_PHASE_POLICY.launch.pending_op/unreadable=true` and archive refusal — require `insp.status === "ready" && !insp.pendingOp && insp.state?.phase === "stopped"` — confidence 0.9

[category: bug] [severity: major] research-state.ts:604 — `scanCampaignsSync` validates only 4 fields, so extra-field `state.json` passes the scanner but `readState`/`inspectCampaign`/archive fail closed; policy then sees a readable phase and fails open — call `stateProblem(raw, entry.name)` in the scanner — confidence 0.7

[category: bug] [severity: minor] research-state.ts:644 — policy checks `pending_op` before state validity while `archiveFinishedCampaigns` checks `readState` before `pendingOp` (index.ts:4629); corrupt+pending campaigns yield inconsistent refusal order — check the pending marker first in archive and return a typed reason — confidence 0.7

[category: tech_debt] [severity: minor] research-state.ts:630 — launch row says `stopped=false`, but autoresearch-command.ts:477 has a separate stopped-campaign launch refusal with a charter-only exception; guard/refusal semantics are duplicated — route that handler through `researchPolicyBlocks(..., "launch")` plus one explicit exception — confidence 0.6

[category: tech_debt] [severity: minor] candidate-state.ts:819 — duplicate `inspectCampaign` has no `refusal_reason` and no containment check; callers render status directly as a refusal reason while research-state.ts:181 maps it via `inspectionRefusalReason` — delegate to `researchState.inspectCampaign` and add `refusal_reason` to the interface — confidence 0.9

[category: tech_debt] [severity: minor] research-tool.ts:446 — `exitResearchMode` runs before `archiveFinishedCampaigns` and archive errors are swallowed (finalize-research-tool.ts:111-115); on `null` the loop is off while stopped campaigns still block `ordinaryLoop` — keep mode on or emit an explicit manual-check steer on archive failure — confidence 0.6

Growth points:
1. Add one table-driven test matrix for all four policy rows × {phase, pending_op, unreadable} across the three scanners and launch/archive guards.
2. Share one state validator between `scanCampaignsSync`, `readState`, `inspectCampaign`, and `archiveFinishedCampaigns`.
3. Add lifecycle tests covering report→exit→archive with pending/corrupt state and chain-final campaigns.