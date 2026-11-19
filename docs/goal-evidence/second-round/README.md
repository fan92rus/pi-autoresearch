# Second-round tech-debt review — `pi-autoresearch`

HEAD under review: `ef7ec54`. All eight reviews were run with fresh context on the exact model `opencode-go/hy4-flash-free`, read-only, no full-suite runs. Original reviewer outputs are archived in `reviews/`.

Torpedoed first attempt: two initial children exceeded the 20-minute workflow budget (one burned time in self-review via `advisor`); both were relaunched with a 6-minute budget, max 10 tool calls, and an explicit ban on `advisor`/`subagent`. Total launches: 10, never more than two live agents at once.

## Results by aspect

| Aspect | Area | Result | Key finding | Tasks |
|---|---|---|---|---|
| 1 | core loop / resume / `--continue` | 5 findings, 3 major | Stale drift nudge survives a productive turn; persisted `off` marker ignored on fresh-session auto-activation; `off` races with in-flight awaits | `tj0.1` |
| 2 | mode switching / TUI | 8 findings, 3 major | Duplicate design-phase finalize; stale expedition chain after `stopAutoresearchLoop`; ordinary launch mutates mode before campaign guards | `tj0.2`, `tj0.12` |
| 3 | research lifecycle / policy | 6 findings, 2 major | `stopped` campaign with unreadable/manual-check state treated as finished; shallow `scanCampaignsSync` validation | `tj0.3`, `tj0.8` |
| 4 | expedition / map / brief | 7 findings, 1 high | `replayExpeditionMap` loses `why`, `campaign`, `refs`, review metadata on pivot/reopen; draft unlinked before owner dialog | `tj0.4`, `tj0.5` |
| 5 | candidate / worktrees | 9 findings, 4 major | Ephemeral worktree leak on exception; cleanup failure swallowed; confirm preconditions not rechecked under lock | `tj0.6`, `tj0.7`, `tj0.8` |
| 6 | council / findings / ledger | 4 findings, 2 medium | Global run counter skips segment numbers on consecutive headers; `council.max_councils` bypassed by manual convene | `tj0.8`, `tj0.9` |
| 7 | extracted modules / DI | 8 findings, 2 medium | Module-level `export let` hooks; source-text pins to `index.ts`; mixed snapshot/getter DI conventions | `tj0.10`, `tj0.12`, `tj0.13` |
| 8 | tests / docs / config | 10 findings, 4 high | Dead parallel config fields and promises; removed parallel flows still in PRD/TZ/user docs; timing-sensitive tests | `tj0.11`, `tj0.12` |

No runtime import cycles were confirmed; extracted tool modules contain no module-level mutable containers; public re-exports resolve. These checks are explicitly recorded in `reviews/aspect-7-di-modules.md`.

## Grouped follow-up tasks

Top-level epic: `pi-autoresearch-tj0`. Tasks are attached to stage epics:

- `pi-autoresearch-tj0.14` — E9.1, critical correctness and data-loss fixes: `tj0.1`–`tj0.7`
- `pi-autoresearch-tj0.15` — E9.2, shared contracts, DI and test-harness hardening: `tj0.8`–`tj0.12`
- `pi-autoresearch-tj0.16` — E9.3, further index.ts size reduction: `tj0.13`

- **P1 (7):** `tj0.1` resume/off race, `tj0.2` mode transitions, `tj0.3` research policy fail-open, `tj0.4` expedition replay data loss, `tj0.5` draft/chain publication, `tj0.6` candidate worktree leak, `tj0.7` confirm TOCTOU.
- **P2 (5):** `tj0.8` one inspection/refusal vocabulary, `tj0.9` ledger segment counter and council cap, `tj0.10` getter-only DI and instance-scoped state, `tj0.11` dead parallel config/docs, `tj0.12` behavioral tests instead of source-text/timing pins.
- **P3 (1):** `tj0.13` extract remaining dashboard/HTTP block from `index.ts`.

Cross-aspect duplicates were merged into single tasks: `inspectCampaign`/`refusal_reason` appears in aspects 3/5/7/8 and is tracked in `tj0.8`; mode/TUI test gaps are tracked in `tj0.12`; source-text pins are tracked in `tj0.12`.

Each stage epic has a verifiable close condition in its acceptance criteria.

### tj0.2 upgrade note

`expedition_brief propose` now records `mode_finalized` in the durable publication journal before appending the mode-switch finalize. Partial publications produced by the rejected intermediate code (`1324007`/`9ea6a79`) may be legacy schema-v1 journals without this field; `readPublication` coerces a missing field to `false`. Retrying such an old partial journal from an active optimization can append one extra finalize. New partial publications are exactly-once; historical journals are deliberately not migrated — treat one as a manual-check case if duplicate finalize matters.

## Remediation status

All 13 follow-ups (`tj0.1`–`tj0.13`) are CLOSED with real bd VERDICT comments. Each landed through an isolated worktree, a fresh refuting reviewer with ГОДЕН and 0 blockers after any rework, targeted tests from both worker and reviewer, a full `npm test` after merge, a Conventional Commit and a push.

Final code HEAD `62746c4`: `index.ts` 5,484 lines (from 6,004 at the start of E9, −520; from 12,158 at the original baseline, −6,674 / −54.9%). Final full suite: 2,031 tests / 2,022 pass / 5 fail / 4 skipped. The five failures are the known baseline families: the starter-widget pin reproduced at the pre-change base, the prompt-size budget pin, and three cross-process journal flakes. No new deterministic regression remains.

Known residual risks are documented in the individual bd comments: legacy expedition publication journals can duplicate a mode-switch finalize on retry (tj0.2), manual `council_convene` remains intentionally uncapped (tj0.9), and `manualResolvePendingOp` remains two deliberately distinct contracts (tj0.10). Each was judged in scope-acceptable by fresh review.

No unrelated code was changed as part of the original review round; all subsequent edits belong to the remediation tasks above.
