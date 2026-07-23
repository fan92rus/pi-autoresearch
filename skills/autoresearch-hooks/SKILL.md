---
name: autoresearch-hooks
description: Author pre/post-iteration hooks for an autoresearch session. Use when the user asks to add research fetching, Slack/webhook notifications, persistent learnings, auto-tagging, anti-thrash intervention, idea rotation, or any side effect around iterations.
---

# autoresearch-hooks

Optional bash scripts that run at iteration boundaries in an autoresearch session. They're transparent to the loop-running agent — their effect is a file on disk or a steer message.

## What runs automatically (you don't need to build these)

The extension includes a **built-in TypeScript observer** that runs in-process before each iteration. It provides five triggers automatically:

| Trigger | Condition | Behavior |
|---------|-----------|----------|
| 🔊 **Noise Gate** | System noise > best + 10% | Warns the run will likely discard. `"noise_gate": "hard"` in `.auto/config.json` to skip. |
| 🔬 **Floor Detection** | Streak ≥ 15 + low variance (CV < 0.15) | Recommends finalize — metric plateaued. Override: `"auto_floor_override": true`. |
| 🏁 **Finalize Signal** | Agent called `finalize_research()` at confidence > 0.5 | Recommends `/autoresearch off`. |
| 🔄 **Stagnation** | Streak ≥ 5 (every 5) | L1→BestOfN hint, L2→SpaceSearch hint, L3→valleyProbe hint. ASI-aware. |
| 🎯 **Progress** | Every 5 improvements | Trend analysis (linear/diminishing/erratic). |

You **cannot** remove or edit these — they're extension code. User hooks add behavior on top.

---

## User hooks

User hooks are **bash scripts** in user space that run **in addition to** the built-in observer:

| Source | Path | Scope |
|--------|------|-------|
| **Global hook** | `~/.pi/agent/autoresearch/hooks/before.sh` | All projects |
| **Global .d/** | `~/.pi/agent/autoresearch/hooks/before.d/*.sh` | All projects (alphabetical) |
| **Project hook** | `.auto/hooks/before.sh` | One project |
| **Project .d/** | `.auto/hooks/before.d/*.sh` | One project (alphabetical) |

Same layout for `after.sh` / `after.d/`.

### Execution order

```
1. Built-in observer (TypeScript, in-process)   ← stagnation/floor/noise/finalize
2. Global user hook                              ← ~/.pi/agent/autoresearch/hooks/
3. Global .d/*.sh                                ← alphabetical
4. Project-local hook                            ← .auto/hooks/
5. Project-local .d/*.sh                         ← alphabetical
```

All hooks run independently; stdout is concatenated with `---` separators. A failing user hook **never blocks** the observer.

### Single file or `.d/` directory?

| Need | Use |
|------|-----|
| One hook for this project | `.auto/hooks/before.sh` |
| Multiple independent hooks | `.auto/hooks/before.d/01-notify.sh`, `02-log.sh`, ... |
| One hook for ALL projects | `~/.pi/agent/autoresearch/hooks/before.sh` |
| Multiple hooks for ALL projects | `~/.pi/agent/autoresearch/hooks/before.d/*.sh` |

---

## Contract

### Stdin

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
    "description": "tried X",
    "asi": { "hypothesis": "tested Y" }
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

For `after.sh`, `last_run` is replaced by `run_entry` (the run just logged).

### Output

- **Stdout** (up to 8 KB) — delivered to the agent as a steer message. Empty = silent.
- **Stderr + non-zero exit** — surfaced as an error steer.
- **Timeout** — 30 s hard kill.

---

## Creating a user hook

1. **Read `.auto/prompt.md`** for the objective. Your hook should complement the loop.

2. **Create the script**:

```bash
mkdir -p .auto/hooks
cat > .auto/hooks/before.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
next_run="$(echo "$input" | jq -r '.next_run // 0')"
[ "$next_run" -lt 4 ] && exit 0
echo "⚠️ Consider a different approach after $next_run runs"
EOF
chmod +x .auto/hooks/before.sh
```

3. **Test with a mock payload**:

```bash
echo '{"event":"before","cwd":".","next_run":4,"last_run":null,"session":{"metric_name":"x","metric_unit":"ms","direction":"lower","baseline_metric":null,"best_metric":null,"run_count":3,"goal":"test"}}' \
  | .auto/hooks/before.sh
```

4. **Commit** alongside other session files.

---

## Rules of thumb

- **Silent is the default.** Empty stdout = no steer. Only print when you have something useful.
- **Guard with early exits.** `[ -z "$metric" ] && exit 0`.
- **One concern per script.** Want notifications + learnings? Use `before.d/01-notify.sh` and `after.d/01-learnings.sh`.
- **No environment variables.** Everything is on stdin; extract with `jq`.

---

## Examples

Runnable reference scripts live in `examples/`:

- `examples/before/` — anti-thrash, external search, idea rotator, hypothesis reflection, context rotation
- `examples/after/` — learnings journal, notification on new best, auto-tag winning commits
