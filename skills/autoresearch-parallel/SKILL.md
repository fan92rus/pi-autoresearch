---
name: autoresearch-parallel
description: Run pi-autoresearch in parallel modes — best-of-N hypothesis testing, orthogonal patch stacking, and beam space-search via worker subagents fanned out over the shared event bus. Use when the optimization has multiple candidate hypotheses to try at once, or when a single sequential loop is too slow / gets stuck in local optima.
---

# Autoresearch — Parallel Modes

Three parallel modes that fan out worker subagents in isolated git worktrees, then aggregate and re-measure the winner. The parent agent is the **sole** git mutator and log writer; workers only edit code in their worktree and write a result file.

## When to use which

| Mode | Command | When |
|------|---------|------|
| **A: Best-of-N** | `/autoresearch parallel-best-of-n <N> <goal>` | You have N distinct hypothesis texts; try them all at once, keep the best (re-measured to remove selection bias). MVP. |
| **B: Orthogonal stack** | `/autoresearch parallel-stack <subsystems...>` | Independent file-scoped optimizations (Dockerfile + Makefile + webpack) that combine. Phase 6. |
| **C: Space search** | `/autoresearch parallel-search <goal>` | Multimodal landscape; maintain K diverse states (beam) so the search doesn't get stuck in a local optimum. Phase 7. |

## Tools

- **`BestOfN({ candidates, metric_name, direction, ... })`** — fan out N workers (each realizes one hypothesis in its worktree, measures with `BENCH_MODE=quick`), rank by median, **re-measure the winner on main with `BENCH_MODE=full`** (selection-bias correction), return `keep`/`discard`.
- **`CheckOrthogonal({ patches })`** — (Phase 6) verify file-scope orthogonality, stack with per-patch re-measure.
- **`SpaceSearch({ action, beam_width })`** — (Phase 7) stateful beam: `init` → `step` (×K states × M candidates) → `finish`.

After `BestOfN` returns, call `log_experiment` with the returned `finalMetric` and the decision (`keep`/`discard`).

## The Best-of-N flow (Mode A)

1. **Formulate N hypotheses as TEXT.** You (the agent) understand the code — write each hypothesis as a concrete instruction the worker will implement, and **tag complexity** (`simple`/`medium`/`hard`) so the right model tier and budget are used.
2. **Ensure `measure.sh` supports `BENCH_MODE`.** Workers run `BENCH_MODE=quick` (a fast subset); the parent re-measures the winner in `BENCH_MODE=full`. If `measure.sh` has no `BENCH_MODE` case, it runs as `full` and may blow the budget (pre-flight will refuse to start). Add:
   ```bash
   MODE="${BENCH_MODE:-full}"
   case "$MODE" in
     smoke) ITER=1 ;;
     quick) ITER=10 ;;
     full)  ITER=100 ;;
   esac
   echo "METRIC <name>=<value>"
   ```
3. **Call `BestOfN`** with the candidates. The tool:
   - runs a pre-flight baseline (`BENCH_MODE=quick`) — aborts with a steer if the baseline already exceeds `budget_seconds`;
   - provisions N worktrees at the baseline commit;
   - spawns N workers via the pi-subagents RPC (cheap tier first; **cascade**-escalates failures to a stronger tier);
   - ranks by median, filters noise (MAD noise floor);
   - re-measures the winner on main (`full`) — only the confirmed metric is kept.
4. **`log_experiment(decision, finalMetric, description)`** — `keep` auto-commits the applied winner diff; `discard` auto-reverts.

## Model strategy (cheap by default)

Parallel exploration is **cheap by default**: workers use the `fast` tier (a flash model), not the expensive parent model. Final re-measurement is free (it's just `measure.sh`, no LLM).

- **Complexity tagging** drives tier + budget + repeats: `simple`→fast:low/1 repeat, `medium`→mid/3, `hard`→strong/3. Tag when you formulate — it's nearly free and you're the best judge.
- **Cascade** is ON by default: a candidate that fails (`apply_failed`/`crash`/`worker_timeout`) on the cheap tier is retried on a stronger tier. `budget_exceeded` is **not** escalated (it's a measure.sh problem — fix the script).

Override per-call: `model: "provider/model:thinking"`, or globally in `.auto/config.json`:
```json
"parallel": {
  "tiers": { "fast": "...:low", "mid": "...:xhigh", "strong": "...:high" },
  "complexityMap": { "simple": {...}, "medium": {...}, "hard": {...} },
  "cascade": true, "defaultTier": "fast", "budgetSeconds": 300
}
```

## Time budget — three layers

| Layer | Param | Default | Exceeding it → |
|-------|-------|---------|----------------|
| measure | `budget_seconds` | 300s | one `measure.sh` run killed, `budget_exceeded` status + steer to speed up the script |
| worker | (per-complexity `workerTimeoutMs`) | 5–15min | interrupt RPC, `worker_timeout` |
| round | (implicit) | — | whole BestOfN bounded by slowest worker |

**Pre-flight guard:** if the baseline measurement itself exceeds `budget_seconds`, the round does NOT start — fix `measure.sh` first (add `BENCH_MODE=quick`).

## Phases & valley exploration (multi-step optimizations)

A greedy `edit → measure → keep/revert` loop kills any optimization that must get *worse* before it gets better (architectural refactor, algorithm swap, instrumentation). For those:

- **Phases** (`startPhase`/`commitPhase`/`abortPhase`) — a transaction: inside a phase, auto-revert is off; only the **final** metric is validated. Hard floor (40%) auto-aborts if a step dives too deep. *(Phase 5.)*
- **Valley probes** — when a phase is stuck, spawn parallel worktrees from the best checkpoint with different continuation strategies (reuses the BestOfN machinery). *(Phase 8.)*
- **checks.sh guardrail** — validate invariants (memory, tests) so a speed win that blows memory is caught, not silently kept.

## Critical rules

- **Workers never call `log_experiment`** — only the parent writes the canonical log and mutates main.
- **Workers never call `BestOfN`/`subagent`** — anti-recursion (enforced in the worker allowlist).
- **Selection-bias correction is mandatory** — the winner is re-measured in `full` on main before `keep`; never trust the single `quick` measurement.
- **`budget_exceeded` is a steer, not a failure to escalate** — fix `measure.sh`, don't throw a stronger model at a slow script.
