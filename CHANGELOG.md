# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added — Observer Intelligence & Persistence

- **Pattern classification in stagnation**: replaces generic "change direction" with domain-agnostic result-pattern detection (convergence, repetition, no-info, divergence) based on ASI findings and metric variance.
- **Profiling gate**: warns when recent experiments have no profiling data in ASI (optimizing blind).
- **Noise floor calibration**: auto-runs measure.sh once after baseline to measure variance; warns when keep improvements are within noise floor.
- **Cross-session dead-end memory**: saves do_not_retry entries to `.auto/dead-ends.json` on `/autoresearch off`; loads and displays at `init_experiment` with 30-day expiry.
- **`finalize_recommendations` config setting**: master switch (default: true) to disable ALL finalize/floor recommendations. When false, agent keeps trying without stop suggestions.

### Changed

- **Two-signal floor detection**: floor now requires BOTH consecutive discard streak AND no best improvement in N total experiments (default 12). Prevents false floor on productive branches.
- **Floor streak threshold**: lowered from 15 to 8 based on real-world testing.
- **Removed hard block on exhausted branches**: `propose_hypothesis` no longer blocks when a branch has 6+ failures. Instead shows informational warning with all failed children, their do_not_retry findings, and UCB1 alternatives.
- **Removed `exhausted` node field usage**: `isExpandable` in ucb1.ts no longer checks `node.exhausted`. Treeview no longer shows ☒ marker.
- **`checkExhausted`** replaced by `countFailedChildren`/`getFailedChildren` in tree.ts.

### Added — Hypothesis-First Workflow

- **propose_hypothesis** tool: register hypotheses in the tree BEFORE running experiments. SimHash duplicate detection at registration time.
- **hypothesis_id** parameter in run_experiment and log_experiment: links experiments to pre-registered hypothesis nodes.
- New node statuses: `untested`, `running`, `duplicate` for hypothesis lifecycle.
- New node type: `hypothesis` (transitions to `experiment` on first log).
- `.auto/ideas/<nodeId>.md` files: persistent hypothesis descriptions with YAML frontmatter.
- Baseline exception: first experiment after init_experiment may omit hypothesis_id.

### Changed

- SimHash repeat detection moved from run_experiment to propose_hypothesis (registration time).
- `finalizeExistingNode()` replaces `recordTreeNode` for hypothesis-linked experiments.
- `treeDist()` and `simhashThreshold()` extracted to tree.ts (shared between tools).
- System prompt updated with Hypothesis-First Workflow instructions.

### Breaking

- **BestOfN/SpaceSearch/valleyProbe workers**: run_experiment now requires hypothesis_id for non-baseline runs. Workers that call run_experiment without hypothesis_id will get an error after the baseline run. Phase 2 will integrate parallel tools with propose_hypothesis.

## [1.7.0] - 2026-07-26

### Added — Experiment Tree

- **Experiment tree** (`.auto/tree.json`): every experiment is now recorded as a node in a parent→child tree of hypotheses, giving the agent a structured map of its exploration.
- **`tree_status()`** tool: renders the tree as ASCII art with UCB1 ranking of expandable nodes, exhaustion markers, and best-path highlighting.
- **`explore_from(node_id)`** tool: backtrack to any keep-node in the tree (creates detached HEAD). The agent can jump to a different branch when the current one is exhausted.
- **`restore_main()`** tool: return to the main branch after `explore_from`.
- **`compose(node_a, node_b)`** tool: merge orthogonal improvements from two different tree branches (Phase 1: different files only).
- **Pre-run SimHash repeat detection**: pass a `hypothesis` parameter to `run_experiment` to get a warning if a similar hypothesis was already tried at the current tree position.
- **UCB1 node ranking**: balances exploitation (proven improvements) and exploration (underexplored nodes) to suggest where to expand next.
- **Tree-aware observer**: stagnation steers now include tree status + UCB1 backtrack suggestions; new composition-opportunity trigger detects when two branches could be merged.
- **`/autoresearch tree`** command: toggle between list view and tree view in the dashboard widget.
- **Tree TUI widget**: the dashboard widget can render the ASCII tree view in real-time.
- **Compose node type**: experiments created after `compose()` are tagged with `nodeType: "compose"` and `composedFrom` metadata.
- **`refs/exp/*` git refs**: each keep-node's commit is protected from GC, enabling backtracking to any past experiment.
- Documentation: [Agent Guide](docs/AGENT-GUIDE.md) and [User Guide](docs/USER-GUIDE.md).

### Changed

- `init_experiment` now creates the tree root node (n0) + `refs/exp/n0`.
- `log_experiment` now creates tree child nodes automatically (keep → child + ref, discard/crash → ghost node with hypothesis preserved).
- The system prompt now includes experiment tree guidance.
- The observer trigger order now includes composition opportunity (priority 2, before parallel opportunity).

### Fixed

- `killTree` now works on Windows (uses `taskkill /F /T /PID` instead of Unix-only process-group kill).
- `timeout_seconds` is now a **required** parameter (minimum: 1) — the agent can no longer accidentally run 30-minute experiments.
- `budget_seconds > timeout_seconds` now returns an explicit error instead of being silently ignored.
- Removed unused exports (`extractChangedFiles`) and imports (`findLCA`, `checkFileScopeConflict`, `treeFilePath`, `isExpandable`, `getUcb1C`) from index.ts — dead code cleanup.

## [1.6.1] - 2026-07-02

### Fixed

- Redirected `workingDir` logs no longer auto-activate autoresearch in unrelated pi sessions.
- `/autoresearch off` now persists across `/tree`, compaction, and reloads: a manual off is recorded as a session activation decision and is no longer overridden just because `log.jsonl` still exists.

## [1.6.0] - 2026-06-08

### Changed

- Autoresearch now stores session files under the `.auto/` subfolder by default, with legacy file fallback for existing sessions.
- The dashboard widget is now always expanded — the full results table renders inline above the editor at all times. Removed the collapsed one-liner mode and the `Ctrl+Shift+T` expand/collapse toggle (and its `shortcuts.toggleDashboard` config key). Fullscreen (`Ctrl+Shift+F`) remains the only dashboard toggle.
- Migrated Pi package imports and dependencies from the `@mariozechner` npm scope to `@earendil-works`.

## [1.5.0] - 2026-06-04

### Changed

- The `init_experiment`, `run_experiment`, and `log_experiment` tools are now revealed to the agent only while autoresearch mode is active, instead of being callable in every session. Outside autoresearch mode the tools are absent from the LLM's schema and system prompt, so the agent can no longer self-start a research loop — entry is via `/autoresearch` or resuming a session with an existing `autoresearch.jsonl`.

## [1.4.0] - 2026-05-06

### Added

- Configurable dashboard keyboard shortcuts. Users can now override or disable the toggle and fullscreen shortcuts with a profile-aware `<agent-dir>/extensions/pi-autoresearch.json` config file, helping autoresearch coexist with other pi extensions that bind the same keys.
- Shortcut resolution tests covering defaults, overrides, disabled shortcuts, partial configs, malformed configs, and extension registration.

### Changed

- Dashboard hints and README documentation now reflect the effective shortcuts from config.

## [1.3.0] - 2026-04-29

### Added

- Deterministic compaction summary. When pi compacts context, autoresearch now bypasses the LLM summarization and injects a lossless markdown summary built from persisted state (experiment rules, ideas backlog, and last 50 runs with ASI fields). This eliminates information loss across compaction boundaries.
- Recent-run deltas in the compaction summary use the full segment baseline, not just the first visible run in the window — percentages stay accurate even for long sessions.
- New test coverage for compaction summary assembly, empty state, re-init segments, 50-run cap, and hidden-baseline delta correctness.

### Fixed

- Post-turn auto-resume no longer tells the agent "don't re-read files" when no compaction happened. Split into two resume messages: a generic one for normal turns and a compaction-specific one that correctly references the summary.

## [1.2.0] - 2026-04-28

### Changed

- Long-running loops now ride pi's auto-compaction instead of stopping. When pi summarizes older messages on context overflow, autoresearch detects the resulting idle and re-prompts the agent to re-read `autoresearch.md`, the tail of `autoresearch.jsonl`, `autoresearch.ideas.md`, and `git log` before continuing.

### Fixed

- Manual `/compact` mid-iteration no longer leaves the loop stuck. `session_compact` now schedules a fresh resume even when no `agent_end` fired for the interrupted turn (so no `pendingResumeMessage` was waiting to be rescheduled). Same fix covers split-turn auto-compactions.
- Compaction during agent setup (before the first `log_experiment`) now resumes. The post-turn gate still requires an experiment this turn to avoid resuming on plain chat replies, but the post-compaction gate is permissive — compaction itself is evidence the loop should continue.
- Rapid back-to-back compactions all resume. Dropped the 5-minute auto-resume cooldown that was sized for a different threat model (chat-only `agent_end` loops); the experiment-this-turn gate plus `MAX_AUTORESUME_TURNS = 20` already cover the looping cases the cooldown was guarding against.

### Removed

- Removed the next-iteration token-cost prediction and its `isContextExhausted` guard — pi's auto-compaction handles overflow, so autoresearch no longer needs to estimate or stop early.
- Removed the `iterationTokens` field from `ExperimentResult` and `autoresearch.jsonl`. Existing log files remain readable; the field is simply ignored. The `token-budget.sh` hook example, which relied on it, has been dropped.
- Removed the never-shipped `autoCompactResume` config option (it was opt-in for an earlier draft of this change).

## [1.1.1] - 2026-04-28

### Added

- Published to the npm registry. Install with `pi install npm:pi-autoresearch`.
- Releases now publish automatically from GitHub Actions via npm trusted publisher (OIDC) with provenance attestation.

## [1.1.0] - 2026-04-24

### Added

- Added optional `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh` lifecycle hooks for prospective and retrospective iteration automation.
- Added the `autoresearch-hooks` skill plus example hook scripts for research fetching, learnings capture, notifications, anti-thrash, and idea rotation.

## [1.0.1] - 2026-04-22

### Fixed

- Updated the default dashboard shortcuts to `Ctrl+Shift+T` (toggle) and `Ctrl+Shift+F` (fullscreen).
- Avoided the shortcut conflict with Pi's built-in `Ctrl+X` binding introduced in newer Pi releases.

## [1.0.0] - 2026-04-20

### Added

- Initial stable release of `pi-autoresearch`.
