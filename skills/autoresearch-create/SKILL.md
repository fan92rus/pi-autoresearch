---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs command, times it, captures output. If the project sets `experiment_max_minutes` in `.auto/config.json`, `timeout_seconds` must fit that cap — bigger values are rejected with a reminder to adapt the experiment (smaller fixture, fewer iterations, a BENCH_MODE=quick subset), never to raise the timeout.
- **`log_experiment`** — records result. `keep` auto-commits. `discard`/`crash`/`checks_failed` auto-reverts code changes (autoresearch files preserved). Always include secondary `metrics` dict. Optional `activity_type` (`measurement` | `intermediate` | `verification` | `attribution`) labels what the run did; it is stored in the ledger only and never changes status, keep/discard, git, best or the epoch. Omit it when no label applies. Dashboard: ctrl+shift+t.
- **`log_observation`** — records a preparation, diagnostic or infrastructure event about a run (warm-up pass, measurer check, OOM during teacher generation) as a separate observation. It is not a run: it never touches git, best, streak or `log.jsonl`. Outcome is `success` | `technical_failure` | `unknown`.
- **`record_analysis`** — appends an analysis record to `.auto/analysis.jsonl`: `prereg` (before the candidate run), `comparison`, `attribution` or `supplement`. Records never change runs, git or best.
- **`direction_review`** — takes no arguments and writes one document to `.auto/reviews/direction-<UTC>.md`. It runs no experiment, chooses no direction and performs no automatic action.
- **`council_write_entry` / `council_read_index` / `council_read_entry` / `council_check_consensus`** — blackboard for stagnation councils (the analysts' workspace). When the observer convenes a STAGNATION COUNCIL — or whenever you feel stuck — call `council_convene({ note })` (below); it runs the whole council itself and returns the finished slate. Register every slate experiment via `propose_hypothesis` and run it through the normal loop. You may write only objective-facts entries yourself (`phase: "facts"`) — never judge hypotheses.
- **`council_convene({ note })`** — convene a council yourself at any time, with no limits (no threshold/cooldown/cap), when you feel stuck. ONE-STEP: the tool convenes the whole council itself (analysts, fileless dispute, chair), blocks for several minutes, validates the slate (3–5 EXP, EXPECTED_GAIN ≥ 2× noise floor, KILL_WHEN), persists it to the blackboard and returns it. Then register and execute the slate experiments. Put where you are stuck and what to focus on into `note` — it lands verbatim in the brief the analysts read.

## Session files

All session files live in a single `.auto/` subfolder at the working directory root. This keeps everything in one place — easy to preserve across reverts, gitignore, and clean up.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Experiment prompt / playbook (heart of the session) |
| `.auto/measure.sh` | Benchmark script — emits `METRIC name=value` lines |
| `.auto/log.jsonl` | Append-only result log (written by the tools) |
| `.auto/observations.jsonl` | Observations about preparation and diagnostic events (written by `log_observation`) |
| `.auto/analysis.jsonl` | Analysis records: prereg, comparison, attribution, supplement (written by `record_analysis`) |
| `.auto/run-links.jsonl` | Confirmed links between ledger rows and run directories (written by `log_experiment`; do not edit by hand) |
| `.auto/reviews/` | Direction-review documents (written by `direction_review`) |
| `.auto/ideas/` | Ideas backlog — one `.md` file per idea (optional) |
| `.auto/checks.sh` | Correctness checks (optional) |
| `.auto/config.json` | Session config (optional) |
| `.auto/hooks/{before,after}.sh` | Lifecycle hooks (optional) |

> Always create files in the `.auto/` layout. Legacy flat `autoresearch.*` files are still read for in-flight sessions, but new sessions should use `.auto/`.

## Setup

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. `git checkout -b autoresearch/<goal>-<date>`
3. Read the source files. Understand the workload deeply before writing anything.
4. `mkdir -p .auto`, then write `.auto/prompt.md` and `.auto/measure.sh` (see below). Commit both.
5. `init_experiment` → run baseline → `log_experiment` → start looping immediately.

### `.auto/prompt.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, architectural
insights, and discarded ideas: why they failed and what would justify revisiting them.>
```

Update `.auto/prompt.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `.auto/measure.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `init_experiment`'s `metric_name`) and any secondary metrics. Parsed automatically by `run_experiment`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent-supplied ASI via `log_experiment`

Use `log_experiment`'s `asi` parameter to annotate each run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs — you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `.auto/log.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `.auto/config.json` (optional)

JSON config file that lives in `.auto/` under the pi session's working directory (`ctx.cwd`). Supported fields:

- **`maxIterations`** (number) — maximum experiments before auto-stopping.
- **`workingDir`** (string) — override the directory for all autoresearch operations: file I/O (`.auto/log.jsonl`, `.auto/prompt.md`, `.auto/measure.sh`, `.auto/checks.sh`, `.auto/ideas/`), command execution, and git operations. Supports absolute paths or relative paths (resolved against `ctx.cwd`). The config file itself always stays under `ctx.cwd`. Fails if the directory doesn't exist.

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

### `.auto/checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:
- Runs automatically after every **passing** benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it clearly — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Benchmark only via `run_experiment`.** A bash-run benchmark does not exist: it never enters the ledger, corrupts the noise floor, and its edits are lost on the next revert. Log EVERY run via `log_experiment` immediately — an unlogged run is wasted compute. Log the parsed METRIC value, not a hand-copied number (deviations are flagged as manual provenance).
- **Annotate every run with `asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Not every event is a run.** Preparation, diagnostic or infrastructure events (warm-up pass, measurer check, environment failure before a candidate starts) go to `log_observation`. Do not record them as fake `crash` or `explore` rows in `log_experiment`. Runs are candidate measurements.
- **Watch the confidence score.** After 3+ runs, `log_experiment` reports a confidence score (best improvement as a multiple of the session noise floor). ≥2.0× means the improvement is likely real. <1.0× means it's within noise — consider re-running to confirm before keeping. The score is advisory — it never auto-discards.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `.auto/prompt.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## When to go parallel

A sequential `edit → measure → keep/revert` loop is the default. Switch to parallel modes when you hit these triggers:

| Trigger | Mode | Why |
|---------|------|-----|
| **2+ distinct hypotheses** to try | Best-of-N | Test all at once instead of sequentially |
| **Stuck** — 5+ discards in a row, same approach | Best-of-N | Break out of the local optimum with diverse ideas |
| **Must get worse before better** (refactor, algorithm swap) | Phases | Disable auto-revert; validate only the final metric |
| **Phase stuck in a valley** (maxSteps hit) | valleyProbe | Spawn diverse continuations from best checkpoint |
| **Multimodal landscape** — many local optima | SpaceSearch | Beam search maintains K diverse states |
| **Independent file-scoped optimizations** | CheckOrthogonal | Stack patches that don't overlap |

See `skill://autoresearch-parallel` for detailed flows and tool usage.

**Rule of thumb**: if you're about to try 3+ variations of the same idea, use Best-of-N instead of sequential runs. It's cheaper (flash-model workers) and faster (parallel worktrees).

## Research map (observations, analysis, direction review)

Full contract and data formats: `docs/research-map.md` in the pi-autoresearch repository.

- **Observations.** `log_observation({outcome, description, ...})` — `linked_run` defaults to `"last"`, the last run marker of the shared ledger. With concurrent sessions, or when the last run is not yours, pass an integer `linked_run`. `activity_type` is `intermediate` (default) or `attribution`. Reuse an `idempotency_key` when retrying the same call. Read `binding` in the response: without a proven run link the observation has no trusted epoch.
- **Passport.** Optional `passport.components` (`weights`, `prompt`, `dataset`, `measurer`, `code_ref`) holds your declarations: `ref` (a relative project path) and `declared_sha256`. A supplied component is stored as `declared` with `verified: false`. The system never reads or hashes those files. Leave a component out when you do not know it: it stays `unknown`, and you must not infer it from other fields.
- **Pre-registration.** Call `record_analysis({kind: "prereg", ...})` BEFORE the candidate run. A prereg written after results is post-hoc; the ordering is checked against the ledger and the analysis file, not against timestamps. A `prereg` with `exhaustion_rule` needs `noise_band` and `noise_basis_ref` for the exhaustion signal to be assessed.
- **Comparisons and claims.** `comparison` declares `purpose`, `baseline_run`, `candidate_run` and `changed_components`. Control is a declaration, not proof. `attribution` states a `claim` with `evidence_refs` (typed `{run, artifact, lines, anchor}` references under `.auto/runs/<N>/`; file paths are rejected). Its status starts `unknown` and is computed on read.
- **Supplements.** `supplement` fills a missing field of an earlier record or declares it `absent` with a reason. It never overwrites. `absent` is not zero and not "nothing changed".
- **Hints.** A response may end with a `💡` line that proposes `direction_review` (S_stag, S_ser, S_exh or S_exh_adv). A hint is advisory: it never says a direction is exhausted and never runs an experiment. Every hint carries its disclaimer, verbatim: for S_stag, S_ser and S_exh «Исчерпание направления и полная сопоставимость результатов не подтверждены.» (exhaustion of the direction and full comparability of results are not confirmed); for S_exh_adv «Исчерпание направления и сопоставимость результатов не подтверждены.» (exhaustion and comparability are not confirmed). Quote the disclaimer when you cite a hint. `unknown` is not failure and not `false`.
- **Direction review.** Call `direction_review` when a hint appears or when you want a strategy overview. Read the document; it lists facts, unknowns, signals, alternatives and what is not proven. It recommends nothing you must do.
- **Ambiguous links.** A run link that is `ambiguous` (for example, after a torn or unreadable line in `run-links.jsonl`) fails closed: no epoch, no delta, no trusted exhaustion for that run. Do not repair `run-links.jsonl` by hand. Report it to the owner; archiving the file is an owner decision. The `run_links_corrupt` code is produced by the reader but not yet printed in tool responses, so check the file when a run that should be proven shows as unknown.
- **Privacy.** A `keep` commit runs `git add -A`, so `.auto/` (observations, analysis, run-links, reviews) enters git history. Never put secrets, tokens or private data in `description`, `asi`, `metrics`, `claim`, `meaning`, `purpose_text` or `absent.note`.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **write them as individual `.md` files in `.auto/ideas/`** (e.g. `.auto/ideas/cache-ast.md`). Don't let good ideas get lost.

On resume (context limit, crash), check `.auto/ideas/` — remove tried files, experiment with the rest. When all paths are exhausted, write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.

## Candidate-branch mode (opt-in)

When the user chooses the candidate-branches campaign, write the following
section into the new campaign's `.auto/prompt.md` INSTEAD of the experiment
loop section above (never overwrite an existing user `.auto/prompt.md`):

```markdown
## Candidate Branch Campaign
- Work only through candidate_branch: init → create → run → checkpoint →
  confirm. Ordinary run_experiment/log_experiment are blocked in this mode.
- Policy parameters require the USER's explicit dialog consent; without it,
  init fails. Never pass or simulate consent.
- run measures the candidate; it is NOT a global keep.
- checkpoint saves only allowed_files from the campaign's change_files.
- confirm re-measures leader and candidate; the leader ref moves only on a
  strict gain above min_gain with passing checks.
- If a call returns manual_check_required or the lock is stale: STOP. Report
  the pending operation and wait for the operator (resolve is dialog-only).
- One active candidate at a time. This is sequential candidate development,
  not parallel search.
```

While a campaign is already active, the system prompt carries these rules
automatically (candidate mode replaces the experiment-loop section); do not
call `run_experiment` or `log_experiment` (they are blocked), and never pass
or simulate policy consent. If an operation is pending or a lock is stale,
stop and report `manual_check_required`; only the operator's dialog
(`resolve`) clears it. Details and limits: `docs/candidate-branches.md`.

Without an active campaign, this skill's loop instructions above apply
unchanged.
