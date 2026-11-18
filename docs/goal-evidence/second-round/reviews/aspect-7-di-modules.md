ЕСТЬ ТЕХДОЛГ

Correct: no runtime import cycles (research-state.ts:45 ↔ refusal.ts:9 is `import type` only); extracted tool modules contain no module-level `let`/mutable containers (only immutable Sets in research-alias-tools.ts:23-26); all checked re-exports resolve (SETTLED_WINDOW_MS; widget trio; ledger trio); overlayTui precedent is applied to mutable lets (`overlayTui` 3615/3660, `briefPreviewDir` 5147, `optimizeBriefDir` 5123).

Findings:
1. [module-state] [medium] extensions/pi-autoresearch/index.ts:317-332 — seven `export let` test hooks are module-level mutable bindings rebound on every `autoresearchExtension(pi)`; repeated fake-pi instances in one process get last-writer-wins hooks (see tests/fake-pi.ts:328) — minimum fix: export getter functions backed by a per-instance registry — confidence: high.
2. [test-anchoring] [medium] tests/expedition-web.test.mjs:210-212 — hardcodes 6 textual `broadcastDashboardUpdate(` occurrences in index.ts; E6 moved finalization broadcasting to finalize-research-tool.ts (getter at index.ts:4448), so relocation alone can break this test — minimum fix: assert behavior or scan index.ts plus extracted tool modules — confidence: medium (test not executed: full suite forbidden by budget).
3. [DI-consistency] [low] index.ts:5109-5126 — briefToolDeps passes `campaignBlocksOrdinaryLoop`, `resolveWorkDir`, `getRuntime`, etc. as plain snapshots while adjacent fields use getters; currently const arrows, but a future `let` silently freezes the value — minimum fix: getters for every collaborator in BriefToolsDeps — confidence: high.
4. [DI-consistency] [low] index.ts:3600-3661 — run/log tool deps mix snapshots (`getRuntime`, `buildSessionSnapshot`, `resolveWorkDir`) with getter-backed `overlayTui`/`campaignBlockedResponse` — minimum fix: one getter-only deps convention for all tool factories — confidence: high.
5. [duplicate-helper] [low] council-delegation.ts:176 / council-tools.ts:172 (`parseVerdicts`); candidate-state.ts:876 / research-state.ts:1145 (`manualResolvePendingOp`) — same-named helpers in separate modules invite drift — minimum fix: shared module + re-export facade — confidence: medium (bodies not diffed).
6. [duplicate-DI] [low] index.ts:5687,5722 — `pi` is supplied both as a dep field and as the curried argument to `createAutoresearchCommand` — minimum fix: keep one channel — confidence: medium.
7. [module-state] [low] dashboard-web.ts:246-249 — module-level `view/campaigns/lastHint/lastFetchFailed` shared by all extension instances/tests — minimum fix: instance-scoped payload state — confidence: medium.
8. [scale] [info] index.ts — still 5722 lines after E6; extraction left large registration/glue body — minimum fix: extract HTTP dashboard/server block — confidence: high.

3 development points:
1. Retire the seven `export let` hooks in favor of per-instance getter accessors; update tests to call them.
2. Enforce getter-only (thunk) DI contracts across all tool factories and remove the duplicated `pi` channel.
3. Replace source-location-text tests with behavioral/wiring checks and consolidate duplicated helpers behind the index.ts re-export facade.