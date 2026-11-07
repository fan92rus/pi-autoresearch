# Research vectors

Metric-free research campaigns for pi-autoresearch: the agent answers
pre-agreed questions autonomously instead of optimizing a number. The
ordinary `run_experiment` / `log_experiment` loop is unchanged when no
research campaign is active.

## Two-phase start

**Phase 1 — brief agreement (interactive).**

1. `research_brief draft` — create or edit the brief draft
   (`<workDir>/.auto/research/<campaign_id>/brief.json`). The brief
   holds: goal, plan source, a required verbatim caveat block, data
   roles (explore / validate / confirm), questions with text decision
   rules for every verdict (`confirmed`, `rejected`, `inconclusive`,
   `waiting_for_data`), process metrics and stop rules.
2. `research_brief propose` — the owner dialog. The dialog shows the
   brief JSON and its SHA-256 (hashed from the same bytes that are
   displayed). Only a literal `true` from `ctx.ui.confirm` approves;
   no UI or any other answer means the brief stays unapproved. The
   model cannot approve it itself: approval fields in the tool call
   are rejected.
3. The agreed brief + its hash go into the launch prompt for phase 2.

**Phase 2 — autonomous research.**

4. `research start` with `expected_sha256` from phase 1. A mismatch is
   a `brief_changed` refusal. Only one campaign may be in the research
   phase at a time.
5. `research open` — open a vector for a question id from the brief
   (one open vector at a time; closed vectors never reopen).
6. `research record` — store the conclusion with an `evidence_ref`
   (`path:lines` or `path#anchor`); the file's SHA-256 is recorded.
7. `research close` — a verdict plus the `rule_id` of that question
   with the matching verdict; `inconclusive` and `waiting_for_data`
   need a reason. The journal keeps the question and rule text.
8. `research stop` — a stop rule from the brief; after it, no new
   vectors open.
9. `research status` / `report` — question statuses, evidence hash
   checks, the caveat block verbatim. No target metric exists by
   design; available after stop as well.
10. The operator receives the report.

## Guarantees

- The brief is frozen after approval: every action re-checks its hash
  and refuses with `brief_changed` on any byte change. A new brief
  means a new campaign in its own directory; nothing is overwritten.
- Questions and rules come only from the approved brief; phase 2 never
  adds or edits them.
- Closure follows a brief rule with recorded evidence; the verdict
  must match the rule. `waiting_for_data` is used when the brief
  requires independent confirming data that does not exist (owner
  decision 5): nothing is confirmed on the old data.
- No Git operations in this mode: the tools never call git, and a
  command-position `git` in bash/powershell is blocked while a
  campaign is active (including wrappers like `env git`, `command
  git`, `bash -c '… git …'`).
- While the research phase runs, the ordinary loop (`init_experiment`,
  `run_experiment`, `log_experiment`, `propose_hypothesis`,
  `finalize_research`), `candidate_branch`, all `council_*` tools and
  the legacy `/autoresearch` flows (council, finalize, parallel-*) are
  refused. Note-taking, measurement, analysis and precedent tools
  (`inspect_results`, `tree_status`, `record_finding`,
  `update_finding`, `log_observation`, `log_measurement_change`,
  `verify_measurement_change`, `revert_measurement_change`,
  `record_analysis`, `direction_review`, `search_precedents`,
  `assess_precedents`) stay open: they write only under `.auto/`.
- Auto-continuation counts research turns as work and uses
  research-only wording; on `manual_check_required` or a stopped
  campaign nothing auto-runs.

## Agent judgment (what the system does not verify)

- Whether a rule's condition is actually met is the agent's judgment;
  the tool only checks that the rule exists in the brief for that
  question, the verdict matches and evidence is recorded.
- Evidence hashes detect later file changes (`status`/`report` mark a
  changed file as not reproducible); they do not prove reproducibility
  of the research itself.
- Data sufficiency for `waiting_for_data` is judged by the agent.

## Manual recovery

An interrupted operation leaves `pending-op.json` and blocks the
campaign (`manual_check_required`). `research resolve` is
operator-only: a dialog (`ctx.ui.confirm === true`) clears the marker;
`state.json` is never auto-repaired, and a failed or absent dialog
leaves the marker in place. A stale lock is likewise never removed
automatically.

## Not promised

- This is not an OS sandbox: the Git block works at the Pi command
  layer (tool interception). Arbitrary child processes, `/usr/bin/git`
  style paths, quoting tricks and other shell-parsing bypasses are
  documented residuals. State files under `.auto/research/` are plain
  files — protection against hand-editing them is rule-based, not
  enforced.
- Campaign phases: `briefing` (draft, not yet approved) does not
  block the ordinary loop — the block starts with the research phase
  (accepted residual). `stopped` blocks the ordinary loop and Git
  until the operator manually removes the campaign directory (no
  completion action by design; accepted residual).
- No per-question time or token limit (owner decision 3).
- No automatic computation of rule conditions; no new data collection.

## Run: `node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-state.test.mjs tests/research-branch-wiring.test.mjs`

Module and wiring suites: `tests/research-state.test.mjs` (52),
`tests/research-branch-wiring.test.mjs` (22).
