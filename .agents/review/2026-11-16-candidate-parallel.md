# Candidate and parallel campaign review

Read-only review of `candidate-*`, `parallel/*`, and their integration in `index.ts`. Findings are maintainability/business-logic risks confirmed from the checked code. This is not a claim that every edge case is currently exploitable; the listed gaps deserve targeted tests or explicit owner decisions.

## Fail-open / fail-closed asymmetry

1. **[High] Unsaved-work checks fail open when `git status` fails.** `extensions/pi-autoresearch/index.ts:8635-8647` (create) only refuses when `collectWorktreeChanges()` succeeds and returns changes; a `!activeChanges.ok` result falls through. The analogous pause/close check at `:8828-8840` and resume/select checks later also test only `changes.ok && changes.length`. A missing, corrupted, or inaccessible worktree can therefore be treated as clean and permit a state transition that strands work. Refuse on inspection failure with a distinct `worktree_unreadable` reason; test nonzero/throwing status for every transition.

2. **[High] Candidate creation is an unjournaled two-resource transaction.** `index.ts:8649-8661` creates the Git worktree, then persists the candidate row. If state persistence fails, the tool intentionally leaves an orphan worktree; there is no automatic recovery path, while retry refuses because the target exists. This is fail-closed (it avoids deleting unknown work), but operationally dead-ends the candidate id. Use a `pending-op` marker covering create, or add an operator-only orphan adoption/removal flow (the existing resolve supports orphan checkpoint registration, not orphan worktree registration). Add a crash/failure test between `worktree add` and state create.

3. **[Medium] `disable` leaves a previously active candidate as active in the state file.** `candidate-state.ts:739-751` only sets `disabled:true`; the inspection/status schema allows disabled plus active. Re-init archives the old state, but status and manual inspection can show `[ACTIVE]` even though campaign operations are forbidden. Either make status model this explicitly (`disabled` candidate status/marker) or explain and test the intended retained-active invariant; don't silently reinterpret it in readers.

4. **[Medium] The clean-worktree guard intentionally ignores ignored files, which can hide candidate inputs from checkpoint scope.** `candidate-worktree.ts:313-316, 683-715` documents that `git status --untracked-files=all` misses ignored files. `change_files`/`allowedFiles` can be manually selected and checkpoint uses explicit `git add`, so this is not an automatic accidental commit, but ignored generated/config files can affect benchmark results without ever appearing in status or review. Clearly surface this limitation at consent/checkpoint, or require an explicit policy flag / explicit status scan for ignored files.

## Duplication / legacy parallel surface

5. **[High] The legacy parallel UI advertises controls for modes whose tools were removed.** `parallel/config-ui.ts:40-56, 240-247` keeps `parallel-best-of-n`, `parallel-stack`, `parallel-search` autocomplete entries and describes concurrency as “future” policy; `index.ts:11642-11659` still accepts those commands, cleans old worktrees, enables autoresearch and dispatches `/skill:autoresearch-parallel`. `openspec/changes/archive/2026-11-09-candidate-branches/design.md:1-5, 43-45` explicitly says `PARALLEL_TOOLS_ENABLED=false`, disabled legacy phases are not an implementation, and removed tools must not be presented as working. Remove/rename these entries and the command path to clearly label unsupported legacy, or restore only after a tested implementation exists. Retain config migration separately if needed.

6. **[Medium] Parallel config has dead API and weak nested validation.** `parallel/config.ts:54-87, 90-105`: `resolveTier` and `defaultConcurrency` are only referenced in `config.ts` (repository search found no consumer); `config-ui.ts:15` imports `DEFAULT_CONFIG` but never uses it. `resolveConfig` shallow-merges `complexityMap` without validating tier, timeout, repeats, and accepts arbitrary `defaultTier/defaultComplexity` casts; malformed persisted JSON can yield undefined fields at `resolveTier`. Delete unused helpers/imports if parallel execution stays removed; otherwise validate/freeze the resolved config and add malformed-config tests before re-enabling consumers.

7. **[Medium] Worktree provisioning/cleanup is duplicated with incompatible safety contracts.** `parallel/worktree.ts:77-115,125-155` force-removes stale paths, edits `.gitignore`, and cleanup swallows failure; `candidate-worktree.ts:423-545` refuses existing targets, preserves source tree and has no deletion API. This split is intentional per candidate MVP, but the two implementations share only an `ExecFn` type imported from the legacy parallel module (`candidate-worktree.ts:42-49`). Extract neutral Git argv/identity helpers into a safety-neutral module, while keeping separate policy wrappers; do not unify removal semantics. If parallel is removed, move `ExecFn` too so candidate code has no dependency on a legacy namespace.

8. **[Medium] `parallel/worktree.ts` cleanup can report success while leaving registered worktrees.** `:125-155` ignores both `git worktree remove`/`prune` and filesystem removal errors; `cleanupAllWorktrees` may `rm` a path while leaving Git metadata registered. At least return a per-path cleanup result, re-run `git worktree list --porcelain` and report unresolved registrations; don't silently claim housekeeping succeeded. The startup caller at `index.ts:11648-11650` also swallows all cleanup errors.

## Candidate flow complexity / contracts

9. **[Medium] Candidate integration is a second large state machine embedded in the 12k-line extension entrypoint.** `index.ts:8174-8430` defines path policy, two process runners, methodology hashing, campaign scans, and refusals; `:8432-9060+` dispatches all tool actions, with multi-stage `init/create/checkpoint/confirm/resolve` transactions. This duplicates the boundary code that `candidate-state`, `candidate-worktree`, and `candidate-measure` are designed to isolate. Move the candidate service/orchestration to `candidate-campaign.ts` with injected `{fs, git/argv runner, clock, ui consent}` and keep `index.ts` to tool schema/gating/presentation. First extract pure adapters/scan functions, then confirm, then mutation actions; keep current state and Git tests as contract tests.

10. **[Medium] Process execution adapter is ad hoc and can hang on descendants.** `index.ts:8195-8259` has a candidate-specific `spawn` runner with timeout and `killTree`, while `parallel/worktree.ts` uses injected `pi.exec` (`:54-64`) and the main experiment path has its own shell runner. This makes timeout, output caps, kill semantics, cwd/environment and error mapping inconsistent; candidate stdout/stderr also accumulate unboundedly in memory. Extract a shared argv-only process adapter with explicit max output, timeout, abort signal, and tested process-tree kill; preserve separate shell-based benchmark behavior where required.

11. **[Medium] Ephemeral confirm cleanup errors are silently swallowed and not surfaced in status.** `index.ts:8419-8426` retries normal remove with `--force` then ignores failure; `:8957-8958` also ignores removal result. The comment claims leftovers are reported via status, but status (`:8460-8487`) only reports state, leader, and last measurement; it does not list worktree inventory. Make cleanup return a result; persist/return a warning and report namespaced `tmp-confirm-*` worktrees in status. Add failed-remove test.

12. **[Medium] Config UI uses permissive prefix parsers, silently accepting malformed input.** `parallel/config-ui.ts:270` uses `parseInt("3junk", 10) === 3`; `:307` does the same for budget, and `:463` uses `parseFloat` for observer thresholds. UI constraints are bypassed by trailing garbage. Parse complete numeric strings (`Number` plus integer/range checks) and keep validation shared with config resolution.

## Top 10 prioritization

| # | Risk | Location | Short recommendation |
|---|---|---|---|
| 1 | High | `index.ts:8635-8647`, `:8828-8840`, resume/select guards | Treat status inspection failure as refusal, not clean worktree. |
| 2 | High | `index.ts:8649-8661` | Journal create across worktree + state write; support safe orphan recovery. |
| 3 | High | `parallel/config-ui.ts:40-56`; `index.ts:11642-11659` | Remove or explicitly label commands that target removed parallel tools. |
| 4 | Medium | `parallel/worktree.ts:125-155` | Surface failed cleanup and verify Git registration. |
| 5 | Medium | `index.ts:8419-8426,8957-8958` | Report ephemeral worktree cleanup failures and expose leftovers in status. |
| 6 | Medium | `index.ts:8174-9060+` | Extract candidate orchestration from the god-file into a service module. |
| 7 | Medium | `index.ts:8195-8259` | Standardize argv runner timeout/output/kill semantics. |
| 8 | Medium | `parallel/config.ts:54-105` | Validate nested configuration; remove dead helpers/imports if legacy modes remain off. |
| 9 | Medium | `candidate-worktree.ts:313-316`; policy/checkpoint path | Explicitly surface ignored-file blind spot or add a scoped ignored-file audit. |
| 10 | Medium | `parallel/worktree.ts`; `candidate-worktree.ts:42-49` | Extract neutral Git primitives, retain distinct safety policies. |

## Method / limits

Read candidate state, worktree, measurement, policy, parallel config/UI/worktree, relevant candidate integration, and archived candidate MVP design/spec. No files in the repository were modified, and no tests or Git commands were run. The current legacy parallel command behavior is inferred from checked dispatch/config code; whether skills still ship in the installation should be verified separately before deleting any skill artifacts.
