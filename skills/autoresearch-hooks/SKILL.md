---
name: autoresearch-hooks
description: Author pre/post-iteration hooks for an autoresearch session. Use when the user asks to add research fetching, Slack/webhook notifications, persistent learnings, auto-tagging, anti-thrash intervention, idea rotation, or any side effect around iterations.
---

# autoresearch-hooks

Optional scripts that run at iteration boundaries in an autoresearch session. They're transparent to the loop-running agent — their effect is a file on disk or a steer message.

```
before.sh    # fires before each iteration (prospective)
after.sh     # fires after each log_experiment (retrospective)
```

---

## Architecture: bundled observer + user hooks

There are two categories of hooks: **extension code** (the observer) and **user hooks**.

### Extension code: the observer

The observer is a `before.sh` that ships **inside the extension package** at `extensions/pi-autoresearch/observer/before.sh`. It always runs and provides five triggers: noise gate, floor detection, finalize signal, stagnation escalation, and progress milestones. It is managed by git and updated when the extension is updated.

You **cannot** edit or remove the observer — it's extension code, not user space.

### User hooks

User hooks live in user space and run **in addition to** the observer (never replace it):

| Source | Path | Scope |
|--------|------|-------|
| **Global user hook** | `~/.pi/agent/autoresearch/hooks/before.sh` | All projects |
| **Global user .d/** | `~/.pi/agent/autoresearch/hooks/before.d/*.sh` | All projects (alphabetical) |
| **Project-local hook** | `.auto/hooks/before.sh` | One project |
| **Project-local .d/** | `.auto/hooks/before.d/*.sh` | One project (alphabetical) |

Same layout applies to `after.sh` / `after.d/`.

### Execution order

```
1. Bundled observer (extension code)     ← stagnation/floor/noise/finalize
2. Global user hook                      ← ~/.pi/agent/autoresearch/hooks/
3. Global user .d/*.sh                   ← alphabetical
4. Project-local hook                    ← .auto/hooks/
5. Project-local .d/*.sh                 ← alphabetical
```

All hooks run in parallel (`Promise.all`); their stdout is concatenated with `---` separators and delivered as a single steer. A failing user hook **never blocks** the observer — errors are caught and surfaced independently.

**Key guarantee**: adding a project-local `.auto/hooks/before.sh` does NOT silence the observer. Both run.

### Migration from old auto-install

Previous versions auto-installed the observer to `~/.pi/agent/autoresearch/hooks/before.sh`. On extension load, the old managed copy (identified by `# OBSERVER_VERSION=N` marker) is automatically **deleted**. Files without the marker (user customizations) are left untouched and continue to run as global user hooks.

---

## Contract

### Stdin — `before.sh`

One JSON line. Parse with `jq`:

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
    "asi": { "hypothesis": "Built-in sort avoids overhead", "next_focus": "copy avoidance" }
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

| Field | Notes |
|-------|-------|
| `last_run` | Most recent run entry. `null` on fresh session. |
| `session.direction` | `"lower"` or `"higher"`. |
| `session.baseline_metric` | First run of current segment. `null` until one exists. |
| `session.best_metric` | Optimal metric across **kept** runs only. |
| `session.goal` | Session name from `init_experiment`. |

### Stdin — `after.sh`

Same shape, but `last_run` is replaced by `run_entry` (the run just logged), and `session` reflects state **after** the run.

### Output

- **Stdout** (up to 8 KB) — delivered to the agent as a steer message. Empty = silent.
- **Stderr + non-zero exit** — surfaced as an error steer.
- **Timeout** — 30 s hard kill.

### Preservation

`.auto/**` survives auto-revert — the entire `.auto/` folder is preserved across `git checkout` in `log_experiment`.

---

## Creating a user hook

### Decision: single file or `.d/` directory?

| Need | Use |
|------|-----|
| One hook for this project | `.auto/hooks/before.sh` |
| Multiple independent hooks for this project | `.auto/hooks/before.d/01-notify.sh`, `02-log.sh`, ... |
| One hook for ALL projects | `~/.pi/agent/autoresearch/hooks/before.sh` |
| Multiple hooks for ALL projects | `~/.pi/agent/autoresearch/hooks/before.d/*.sh` |

### Steps

1. **Read `.auto/prompt.md`** for the objective and metric. Your hook should complement the loop, not duplicate it.

2. **Pick the right stage**: `before.sh` = prospective (intervene before next run), `after.sh` = retrospective (react to a completed run).

3. **Create the script**:

```bash
# Project-local single hook
mkdir -p .auto/hooks
cat > .auto/hooks/before.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
metric="$(echo "$input" | jq -r '.last_run.metric // empty')"
[ -z "$metric" ] && exit 0
# Your logic here
echo "Steer message for the agent"
EOF
chmod +x .auto/hooks/before.sh
```

4. **Test with a mock payload**:

```bash
echo '{"event":"before","cwd":".","next_run":1,"last_run":null,"session":{"metric_name":"x","metric_unit":"ms","direction":"lower","baseline_metric":null,"best_metric":null,"run_count":0,"goal":"test"}}' \
  | .auto/hooks/before.sh
```

5. **Commit** alongside other session files.

### Multiple hooks in `.d/`

For independent concerns, split into separate files in a `.d/` directory:

```
.auto/hooks/
  before.d/
    01-slack-notify.sh    ← runs first (alphabetical)
    02-anti-thrash.sh     ← runs second
    03-idea-rotate.sh     ← runs third
```

Each file is a standalone script with the same stdin/stdout contract. They run in parallel, so don't rely on side effects from other files in the same `.d/`.

---

## Examples

Runnable reference scripts live in this skill's `examples/` directory:

- `examples/before/` — external search, anti-thrash, idea rotator, hypothesis reflection, context rotation
- `examples/after/` — learnings journal, notification on new best, auto-tag winning commits

---

## Rules of thumb

- **Silent is the default.** Only print to stdout when you have something useful. Empty stdout = no steer.
- **Guard with early exits.** `[ -z "$metric" ] && exit 0` is cheaper than nested `if`.
- **One concern per script.** Want notifications + learnings? Use `before.d/01-notify.sh` and `after.d/01-learnings.sh`.
- **No environment variables.** Everything is on stdin; extract with `jq`.
- **Parse ASI fields** — `.last_run.asi.hypothesis`, `.asi.learned`, `.asi.next_action_hint` — for context-aware logic.

---

## Observer triggers (reference)

The bundled observer provides these triggers automatically. You don't need to reimplement them in user hooks.

| Trigger | Condition | Behavior |
|---------|-----------|----------|
| 🔊 **Noise Gate** | System noise > best + 10% | Warns the run will likely discard. `"noise_gate": "hard"` in `.auto/config.json` to skip. |
| 🔬 **Floor Detection** | Streak ≥ 15 + low variance (CV < 0.15) | Recommends finalize — metric plateaued. Override: `"auto_floor_override": true`. |
| 🏁 **Finalize Signal** | Agent called `finalize_research()` at confidence > 0.5 | Recommends `/autoresearch off`. |
| 🔄 **Stagnation** | Streak ≥ 5 (every 5) | L1→BestOfN hint, L2→SpaceSearch hint, L3→valleyProbe hint. ASI-aware: skips generic advice if agent proved floor/exhaustion. |
| 🎯 **Progress** | Every 5 improvements | Trend analysis (linear/diminishing/erratic). |

### Agent-driven finalize

The `finalize_research` tool lets the agent signal optimization is complete:

```javascript
finalize_research({
  reason: "Process-creation floor reached: content is 0% of 42ms",
  evidence: "T = bash_startup(32.5ms) + cmd_overhead(9.5ms)",
  confidence: 0.95
})
```

Writes `{type: "finalize"}` to `log.jsonl`; observer detects it next iteration.
