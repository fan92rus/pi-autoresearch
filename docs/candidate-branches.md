# Candidate branches (MVP)

Opt-in mode for sequential candidate development with checkpoints. The
ordinary `run_experiment` / `log_experiment` loop is unchanged when no
campaign is active.

## Sequence

1. `init` with a full policy. The policy is shown in a dialog and the
   campaign starts only after the **user** confirms. No UI or refusal =
   nothing is written.
2. `create` a candidate. It gets its own detached worktree from the
   campaign's current leader commit (the base at init, or the last promoted leader).
3. `run` measures the active candidate (`repeats` times, same command).
   The result is a candidate measurement, not a global keep.
4. `checkpoint` saves explicitly listed `allowed_files` as a commit and a
   ref `refs/pi-autoresearch/candidates/<id>`. Regression checkpoints are
   allowed.
5. `confirm` re-measures the leader and the selected checkpoint in clean
   ephemeral worktrees, checks the exact checkpoint, and moves the private
   leader ref `refs/pi-autoresearch/campaign-leader` by compare-and-swap only
   when the directed gain is strictly greater than `min_gain` and the
   checks pass.

Other actions: `status`, `resume`, `pause`, `select`, `close`, `disable`.
`resolve` is operator-only (see below).

## Guarantees

- The user's branch, checkout, staged/unstaged/untracked files are never
  reset, cleaned, or deleted by this mode.
- One active candidate at a time.
- A checkpoint never leaves the candidate worktree's allowed set.
- Refused transitions change no files. Exception: a checkpoint whose git commit
  step fails may leave staged changes for manual inspection (see recovery below).
- A promotion needs a repeated comparable measurement, the same metric and
  direction, equal epochs, unchanged methodology hashes, passing checks on
  the exact checkpoint, and a gain strictly above `min_gain`.
- While a campaign is active, `run_experiment` and `log_experiment` are
  blocked.

## Not promised

Protection against concurrent sessions, power loss, filesystem corruption,
external processes, or old versions of the extension. Candidate worktrees
are created under the OS temp directory (`pi-ar-candidate/`); they are not
removed automatically. Automatic cleanup is out of scope for the MVP.

## Pending operations and manual recovery

If an operation fails with an unknown outcome (an exception, or a failure
after the commit), a pending-op marker stays in `.auto/candidate/`. Every
campaign call then returns `manual_check_required`:

1. Inspect `git worktree list` and `git for-each-ref refs/pi-autoresearch`.
2. Run `candidate_branch` with `action: "resolve"`. This asks the operator
   in a dialog. If the interrupted checkpoint commit exists and is verified
   (ref points to it, its parent is the candidate's last checkpoint or, for the
   first checkpoint, any existing commit; base-match is not recorded), it is
   registered as the selected checkpoint. Otherwise the marker is cleared
   only after consent, or the marker stays with a diagnosis.

A stale campaign lock is cleared the same way (operator dialog only). The
model cannot approve either action.

## Policy fields

`metric_name`, `direction` (`higher` / `lower`), `repeats` (≥1),
`min_gain` (≥0), `benchmark_argv`, `checks_argv` (non-empty),
`benchmark_timeout_seconds`, `confirm_budget_seconds`,
`candidate_step_limit`, `candidate_time_limit_seconds`, `methodology_files` (path + SHA-256),
`change_files`. Numbers must be finite; no silent defaults. The policy is
immutable after `init`; changing it means a new campaign.

The benchmark must print one line `METRIC <metric_name>=<number>`. Duplicate
or non-finite values refuse the measurement.
