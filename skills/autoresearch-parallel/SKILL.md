---
name: autoresearch-parallel
description: Run pi-autoresearch in parallel modes — best-of-N hypothesis testing, orthogonal patch stacking, beam space-search, valley probes, and multi-step phases via worker subagents fanned out over the shared event bus. Use when the optimization has multiple candidate hypotheses to try at once, or when a single sequential loop is too slow / gets stuck in local optima.
---

# Autoresearch — Parallel Modes

Five complementary modes that fan out worker subagents in isolated git worktrees, then aggregate and re-measure the winner. The parent agent is the **sole** git mutator and log writer; workers only edit code in their worktree and write a result file.

## When to use which

| Mode | Tool | When |
|------|------|------|
| **A: Best-of-N** | `BestOfN({ candidates, ... })` | N distinct hypothesis texts; try all at once, keep the best. MVP. |
| **B: Orthogonal stack** | `CheckOrthogonal({ patches })` | Independent file-scoped optimizations (Dockerfile + Makefile + webpack) that combine. |
| **C: Space search** | `SpaceSearch({ action, ... })` | Multimodal landscape; maintain K diverse states (beam) so the search doesn't get stuck. |
| **D: Phases** | `startPhase` / `commitPhase` / `abortPhase` | Multi-step optimization where you must get *worse* before getting better (refactor, algorithm swap). |
| **E: Valley probe** | `valleyProbe({ strategies })` | Phase stuck in a valley — spawn parallel continuations from the best checkpoint. |

## Shared cascade re-measure (selection-bias correction)

All three exploration modes (Best-of-N, SpaceSearch finish, valleyProbe) share the **same** re-measurement engine (`cascadeReMeasure` in `remeasure.ts`). After workers produce quick-mode results:

1. **Rank** candidates best-first by median quick metric.
2. **Skip** any candidate whose quick metric is **not better than baseline** — don't waste a full run on an obvious loser.
3. **Cascade**: re-measure #1 in its worktree (`BENCH_MODE=full`). If it confirms (beats baseline beyond noise floor) → winner. If not, try #2, #3, ...
4. **Apply**: only after a candidate confirms in its worktree, apply its changes to main (diff for Best-of-N/valley; cherry-pick for SpaceSearch).

**Key invariant**: the main working directory is **never touched during measurement**. The winner's diff/commits are applied only after confirmation. No apply→measure→revert on main.

## Best-of-N (Mode A)

1. **Formulate N hypotheses as TEXT.** Write each as a concrete instruction the worker will implement. Tag `complexity` (`simple`/`medium`/`hard`) so the right model tier and budget are used.
2. **Ensure `measure.sh` supports `BENCH_MODE`.** Workers run `BENCH_MODE=quick` (fast subset); cascade re-measures in `BENCH_MODE=full`. Add:
   ```bash
   MODE="${BENCH_MODE:-full}"
   case "$MODE" in
     smoke) ITER=1 ;;
     quick) ITER=10 ;;
     full)  ITER=100 ;;
   esac
   echo "METRIC <name>=<value>"
   ```
3. **Call `BestOfN`** — the tool:
   - Pre-flight baseline (`quick`) — aborts with a steer if baseline exceeds `budget_seconds`.
   - Provisions N worktrees at the baseline commit.
   - Spawns N workers (cheap tier first; **cascade**-escalates failures to stronger tier).
   - Ranks by median, filters noise (MAD noise floor).
   - **Cascade re-measures** ranked candidates in their worktrees (`full`) — first confirmation wins.
   - Applies winner's diff to main only after confirmation.
4. **`log_experiment(decision, finalMetric)`** — `keep` auto-commits; `discard` auto-reverts.

## Phases (Mode D)

A greedy `edit → measure → keep/revert` loop kills any optimization that must get *worse* before it gets better (architectural refactor, algorithm swap, instrumentation, precomputation). Phases solve this:

- **`startPhase({ name, rationale, max_steps, max_regression_pct, hard_floor_pct })`** — start a transaction. Inside a phase, auto-revert is OFF; only the **final** metric is validated at `commitPhase`.
- **`commitPhase({ final_metric, description })`** — measure the final metric. If better than baseline → `git commit` the whole chain. If worse → revert to phaseBase (or best-checkpoint).
- **`abortPhase({ reason })`** — revert to phaseBase/best-checkpoint immediately, no validation.

**Safety guardrails:**
- **Hard floor** (default 40%): auto-abort if a step regresses more than `hard_floor_pct` from baseline.
- **maxSteps** (default 5): auto-abort if too many steps without improvement.
- **best-checkpoint**: each improving step snapshots HEAD; `abortPhase` reverts to the best checkpoint, not necessarily phaseBase.
- **checks.sh** still runs (if present) — invariant violations are caught.

## Space search (Mode C)

Beam search across the optimization landscape. Maintains K diverse states so the search doesn't get stuck in a local optimum.

**Flow: `init` → `step` (×N) → `finish`**

1. **`SpaceSearch({ action: "init", beam_width, candidates_per_state, diversity_hints })`** — provisions baseline worktree, measures baseline. `beam_width` states × `candidates_per_state` candidates per step.
2. **`SpaceSearch({ action: "step", diversity_hints })`** — for each surviving state, spawn `candidates_per_state` workers (each gets a hint from `diversity_hints`). Prune to top-K by metric, with **regression-lookahead**: a state is dropped only after `allowed_regression_steps` consecutive regressions.
3. **`SpaceSearch({ action: "finish" })`** — cascade re-measure best states in worktrees (`full`), cherry-pick confirmed winner's commit chain onto main.
4. **`SpaceSearch({ action: "status" })`** — inspect beam state without stepping.

**Key params:**
- `diversity_hints` — text labels cycled across candidates (e.g., `["brute", "hash", "sorted"]`), ensuring different approaches are explored.
- `allowed_regression_steps` (default 2) — how many consecutive regressions before pruning a state. Lets the beam temporarily worsen to escape valleys.

## Valley probe (Mode E)

When a phase is stuck (reached `maxSteps` without improvement), spawn parallel continuations from the best checkpoint with different strategies. Reuses the Best-of-N machinery.

**`valleyProbe({ strategies, baseline_metric, metric_name, direction })`**:
- Provisions worktrees from the best checkpoint commit.
- Each worker gets a different continuation strategy from `strategies[]`.
- Cascade re-measures ranked candidates in worktrees.
- Returns the confirmed winner as a diff (for `applyDiff` + re-measure on main) or reports no escape.

Use when a phase went deep into a valley and you need diverse strategies to find the way out.

## Orthogonal stack (Mode B)

Stack independent file-scoped optimizations that combine additively (e.g., Dockerfile + Makefile + webpack config).

**`CheckOrthogonal({ patches })`**:
- Each patch has `name`, `hypothesis`, and `file_scope` (list of files it touches).
- **File-scope intersection check**: if two patches touch the same file, the tool refuses — merge them or drop one.
- Stacks patches one by one: apply → re-measure → keep/discard → next.
- Each patch is independently validated, so a failure in one doesn't block others.

## Model strategy (cheap by default)

Parallel exploration is **cheap by default**: workers use the `fast` tier (a flash model), not the expensive parent model. Final cascade re-measurement is free (just `measure.sh`, no LLM).

- **Complexity tagging** drives tier + budget + repeats: `simple`→fast:low/1 repeat, `medium`→mid/3, `hard`→strong/3.
- **Cascade** is ON by default: a candidate that fails on the cheap tier is retried on a stronger tier. `budget_exceeded` is **not** escalated (fix `measure.sh` instead).

Override globally in `.auto/config.json`:
```json
"parallel": {
  "tiers": { "fast": "...:low", "mid": "...:xhigh", "strong": "...:high" },
  "complexityMap": { "simple": {...}, "medium": {...}, "hard": {...} },
  "cascade": true, "defaultTier": "fast", "budgetSeconds": 300
}
```

**Or use the interactive configurator** — run `/autoresearch config` for a TUI dialog with presets (Budget / Balanced / Premium), individual model overrides, concurrency, and budget. No need to edit JSON manually.

## Time budget — three layers

| Layer | Param | Default | Exceeding it → |
|-------|-------|---------|----------------|
| measure | `budget_seconds` | 300s | one `measure.sh` run killed, `budget_exceeded` + steer to speed up |
| worker | per-complexity `workerTimeoutMs` | 5–15min | interrupt RPC, `worker_timeout` |
| round | (implicit) | — | bounded by slowest worker |

**Pre-flight guard:** if the baseline measurement itself exceeds `budget_seconds`, the round does NOT start — fix `measure.sh` first (add `BENCH_MODE=quick`).

## Critical rules

- **Workers never call `log_experiment`** — only the parent writes the canonical log and mutates main.
- **Workers never call `BestOfN`/`SpaceSearch`/`subagent`** — anti-recursion (enforced in the worker allowlist).
- **Selection-bias correction is mandatory** — the winner is cascade re-measured in `full` in its worktree before `keep`; never trust the single `quick` measurement.
- **Main workdir is never touched during measurement** — only after cascade confirmation.
- **`budget_exceeded` is a steer, not a failure to escalate** — fix `measure.sh`, don't throw a stronger model at a slow script.
