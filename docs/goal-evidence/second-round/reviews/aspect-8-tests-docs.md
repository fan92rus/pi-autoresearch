ЕСТЬ ТЕХДОЛГ

[config] [high] extensions/pi-autoresearch/parallel/config.ts:19-52 — 7 fields have zero runtime consumers; `concurrency` appears only in help text — remove dead fields from ParallelConfig/DEFAULT_CONFIG/resolveConfig or wire them — high
[config-ui] [high] extensions/pi-autoresearch/parallel/config-ui.ts:248-298 — Concurrency/Budget dialogs promise parallel workers and `budget_exceeded`, but no runtime reads these fields — reword as inactive legacy policy or implement the behavior — high
[config-ui] [medium] extensions/pi-autoresearch/parallel/config-ui.ts:78,90,592 — "parallel mode" labels and `(parallel mode is off)` suffixes contradict the removal guard — rename via `interactiveParallelConfig`/`L` strings to "legacy policy" — high
[docs] [high] docs/PRD.md:12,33-38,57-70; docs/TZ.md:685,813 — removed `/autoresearch parallel-*` flows remain active goals/acceptance criteria — mark superseded by el3.4/candidate_branch — high
[docs] [medium] docs/USER-GUIDE.md:181-191,282; docs/AGENT-GUIDE.md:237 — `parallel.ucb1C` has zero code matches; BestOfN/SpaceSearch are removed — delete the config snippet and stale limitation row — high
[tests] [medium] tests/config-ui-scope-split.test.mjs:58-71; tests/research-expedition-widget.test.mjs:58-61 — exact source-text pins to `index.ts` survived E6 extraction; refactors break them without behavior change — replace with import-based assertions — medium
[flakes] [medium] tests/candidate-branch-wiring.test.mjs:684-706 — 300 ms sleep plus 1 s limit and 6 retries; targeted 4-file run hit the 55 s timeout — inject a fake clock or make the limit deterministic — high
[flakes] [medium] tests/candidate-prompt.test.mjs:123 — fixed 1100 ms wait around an 800 ms settled window is load-sensitive — wait on the observable settle event — medium
[command UX] [low] extensions/pi-autoresearch/commands.ts:3-26; parallel/config-ui.ts:40-58 — two completion lists; 13 names currently match, but only help parity is tested — derive `AUTORESEARCH_SUBCOMMANDS` from `SUBCOMMANDS` or add a parity test — high
[uiMode] [medium] extensions/pi-autoresearch/autoresearch-command.ts:610,636; index.ts:2443 — `/autoresearch research --charter` creates a chain but forces `uiMode="optimization"` with no expedition flag; no test covers this path — derive mode from chain intent or add a mode-switch test — medium

1. Delete the dead parallel policy end-to-end: config fields, config dialog promises, labels, and stale docs; add a grep guard for removed names.
2. Make timing tests deterministic with an injected clock/events and isolate the slow candidate-wiring file from quick suites.
3. Replace source-string pins with behavioral tests and unify the two subcommand lists.