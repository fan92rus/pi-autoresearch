---
name: autoresearch-hooks
description: Author pre/post-iteration hooks for an autoresearch session. Use when the user asks to add research fetching, Slack/webhook notifications, persistent learnings, auto-tagging, anti-thrash intervention, idea rotation, or any side effect around iterations.
---

# autoresearch-hooks

Optional scripts that run at iteration boundaries in an autoresearch session. Both hooks, transparent to the loop-running agent — their effect is a file on disk or a steer message.

```
.auto/hooks/
  before.sh    # fires before each iteration (prospective)
  after.sh     # fires after each log_experiment (retrospective)
```

## Hook execution: bundled observer + user hooks

The **observer** is **extension code** — it ships inside the extension package at `extensions/pi-autoresearch/observer/before.sh` and always runs. It is NOT in user space and cannot be accidentally overwritten.

**User hooks** live in user space and run **in addition** to the observer:

| Source | Path | Purpose |
|--------|------|---------|
| **Bundled observer** | `extensions/pi-autoresearch/observer/before.sh` | Stagnation, floor, noise, finalize triggers (managed by git) |
| **Global user hook** | `~/.pi/agent/autoresearch/hooks/before.sh` | User global customization (all projects) |
| **Global user .d/** | `~/.pi/agent/autoresearch/hooks/before.d/*.sh` | Multiple global hooks (alphabetical) |
| **Project-local hook** | `.auto/hooks/before.sh` | Project-specific hook |
| **Project-local .d/** | `.auto/hooks/before.d/*.sh` | Multiple project hooks (alphabetical) |

**Execution order**: bundled observer → global user → global .d/ → project-local → project-local .d/

All hooks run independently; outputs are concatenated with `---` separators. A failing user hook never blocks the observer.

### Migration from auto-install

Previous versions auto-installed the observer to `~/.pi/agent/autoresearch/hooks/before.sh`. On load, the extension detects the old managed copy (by `OBSERVER_VERSION` marker) and **deletes it**. User customizations (files without the marker) are left untouched and continue to run as global user hooks.

Both files are optional. Files without the executable bit are silently ignored.

---

## Contract

### Stdin — `before.sh`

One JSON line. Parse with `jq`. Realistic example:

```json
{
  "event": "before",
  "cwd": "/path/to/workdir",
  "next_run": 6,
  "last_run": {
    "run": 5,
    "status": "discard",
    "metric": 42.1,
    "description": "Simplified to sorted(arr) — copy cost dominates",
    "asi": {
      "hypothesis": "Built-in sort avoids Python overhead",
      "next_focus": "list copy avoidance"
    }
  },
  "session": {
    "metric_name": "total_ms",
    "metric_unit": "ms",
    "direction": "lower",
    "baseline_metric": 40.7,
    "best_metric": 33.5,
    "run_count": 5,
    "goal": "optimize sort speed"
  }
}
```

| Field                     | Notes                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| `last_run`                | The most recent run entry. `null` on a fresh session.               |
| `session.direction`       | `"lower"` or `"higher"` — which end of the scale wins.              |
| `session.baseline_metric` | First run of the current segment. `null` until one run exists.      |
| `session.best_metric`     | Optimal metric across **kept** runs only. `null` until one is kept. |
| `session.goal`            | The session name set by `init_experiment`.                          |
| `session.run_count`       | Total runs logged so far (any status).                              |

### Stdin — `after.sh`

```json
{
  "event": "after",
  "cwd": "/path/to/workdir",
  "run_entry": {
    "run": 6,
    "status": "discard",
    "metric": 38.9,
    "description": "Timsort hybrid slower on random",
    "asi": {
      "hypothesis": "Partial-sort heuristic on input distribution",
      "learned": "Overhead dominates on random arrays"
    }
  },
  "session": {
    "metric_name": "total_ms",
    "metric_unit": "ms",
    "direction": "lower",
    "baseline_metric": 40.7,
    "best_metric": 33.5,
    "run_count": 6,
    "goal": "optimize sort speed"
  }
}
```

| Field       | Notes                                                         |
| ----------- | ------------------------------------------------------------- |
| `run_entry` | The run just logged. Always present.                          |
| `session`   | Same shape as in `before.sh`, reflecting state after the run. |

### Output

- **Stdout** (up to 8 KB) — delivered to the agent as a steer message on the next turn. Empty = silent.
- **Stderr + non-zero exit** — surfaced as an error steer.
- **Timeout** — 30 s hard kill; flagged in the observability entry.

### Preservation

`.auto/**` survives the auto-revert — the entire `.auto/` folder is preserved. (Legacy `autoresearch.*` paths are still preserved too, for in-flight sessions.)

---

## Examples

Runnable reference scripts live in this skill's `examples/` directory — one file per pattern. Paths are resolved against the skill directory (parent of SKILL.md). Browse them for inspiration; they're not policy.

- `examples/before/` — external search, qmd document search, anti-thrash, idea rotator, hypothesis reflection, context rotation
- `examples/after/` — learnings journal, macOS notification on new best, auto-tag winning commits

Each example is a complete, self-contained script with named constants, short helper functions, guard clauses, and intention-revealing names. Read the header comment for its purpose, copy to `.auto/hooks/<stage>.sh`, adapt.

---

## Steps to add a hook

1. **Understand the session.** Read `.auto/prompt.md` for the objective and metric; glance at `.auto/measure.sh` for the workload. Your hook should complement the loop, not duplicate it.

2. **Clarify the user's intent.** What should happen, at which boundary? Research before / log after / notify on wins / intervene on thrash / etc.

3. **Start from an example in `examples/`** that's closest to the intent (resolve against the skill directory). If nothing fits, write from scratch following the same style (named constants, short functions, guard clauses, JSON stdin parsed with `jq`). If the request combines retrospective + prospective concerns, use both `before.sh` and `after.sh` — don't overload one.

4. **Copy, adapt, mark executable.**

   ```bash
   mkdir -p .auto/hooks
   cp "<skill-dir>/examples/before/external-search.sh" .auto/hooks/before.sh
   # ... adapt the script ...
   chmod +x .auto/hooks/before.sh
   ```

5. **Sanity-test with a piped mock** before relying on it in the loop:

   ```bash
   jq -n '
     {
       event: "before",
       cwd: ".",
       next_run: 1,
       last_run: null,
       session: {
         metric_name: "total_ms",
         metric_unit: "ms",
         direction: "lower",
         baseline_metric: null,
         best_metric: null,
         run_count: 0,
         goal: "test"
       }
     }
   ' | ./.auto/hooks/before.sh
   ```

   For `after.sh`, swap `last_run: null` for a `run_entry` object (see the schema above).

6. **Commit the hook** alongside other session files. It's preserved across reverts because it lives under `.auto/`.

---

## Rules of thumb

- **Read whatever fields the agent naturally writes** — `asi.hypothesis`, `asi.next_focus`, `asi.learned`, `description`. Don't invent a "hook input" field and instruct the agent to populate it; that breaks the transparency principle.

- **Silent is the default.** Only print to stdout when you have something useful for the agent. Empty stdout means no steer.

- **Guard with early exits.** `[ -z "$query" ] && exit 0` is cheaper and clearer than wrapping everything in `if`.

- **One concern per script.** If you want research + learnings, put them in separate files (`before.sh` and `after.sh`). Don't bundle.

- **No environment variables.** Everything is on stdin; extract `cwd` (and anything else) with `jq`. There is no `$AUTORESEARCH_WORK_DIR`.

---

## Global observer hook (v3)

A global `before.sh` observer **ships with the extension** and is **auto-installed** to `~/.pi/agent/autoresearch/hooks/before.sh` when the extension loads.

**Auto-install behavior:**

| Situation | Action |
|-----------|--------|
| Global hook doesn't exist | Install bundled hook (chmod +x) |
| Global hook exists, has `OBSERVER_VERSION=N` | Update if bundled version is newer (backup at `.bak`) |
| Global hook exists, no version marker | **Skip** — user has customized it |

The bundled source lives at `extensions/pi-autoresearch/observer/before.sh` in the pi-autoresearch repo. To customize: edit the global hook (remove the `# OBSERVER_VERSION` line to prevent auto-updates), or create a project-local `.auto/hooks/before.sh` which takes precedence.

| Trigger | Condition | Behavior |
|---------|-----------|----------|
| 🔊 **Noise Gate** (T6) | System noise > best + 10% | Warns that the experiment will likely discard. Set `"noise_gate": "hard"` in `.auto/config.json` to skip. |
| 🔬 **Floor Detection** (T1) | Streak ≥ 15 + low variance (CV < 0.15) | Recommends finalize — the metric has plateaued. Override: `"auto_floor_override": true` in config. |
| 🏁 **Finalize Signal** (T4) | Agent called `finalize_research()` with confidence > 0.5 | Echoes the agent's finalize reason and recommends `/autoresearch off`. |
| 🔄 **Stagnation** | Streak ≥ 5 (modulo 5) | Progressive escalation L1→L4 with pattern detection. |
| 🎯 **Progress** | Every 5 improvements | Trend analysis (linear/diminishing/erratic). |

### ASI-aware steers (T2)

The observer parses `asi` fields from the last 5 log entries and adapts messages:
- If ASI contains "floor/impossible/provably" → recommends finalize instead of "change direction"
- If ASI contains "profile/breakdown" → skips "profile the code" advice
- If `ideas.md` contains "PROVEN COMPLETE/FLOOR REACHED" → treated as floor evidence

### Agent-driven finalize (T4)

The `finalize_research` tool lets the agent signal that optimization is complete:

```javascript
finalize_research({
  reason: "Process-creation floor reached: content is 0% of 42ms",
  evidence: "T = bash_startup(32.5ms) + cmd_overhead(9.5ms) + content(0ms)",
  confidence: 0.95
})
```

This writes a `{type: "finalize"}` entry to `log.jsonl` and sends a steer. The observer detects it on the next iteration and recommends `/autoresearch off`.
