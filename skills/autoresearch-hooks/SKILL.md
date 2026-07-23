---
name: autoresearch-hooks
description: Author pre/post-iteration hooks for an autoresearch session. Use when the user asks to add research fetching, Slack/webhook notifications, persistent learnings, auto-tagging, anti-thrash intervention, idea rotation, or any side effect around iterations.
---

# autoresearch-hooks

Create bash scripts that run at iteration boundaries in an autoresearch session — side effects like notifications, logging, research, or intervention.

## What runs automatically (don't rebuild these)

The extension includes a **built-in TypeScript observer** (in-process, zero overhead) with five triggers:

| Trigger | What it does |
|---------|-------------|
| 🔊 Noise Gate | Warns if system noise > best metric |
| 🔬 Floor Detection | Recommends finalize if metric plateaued (CV < 0.15) |
| 🏁 Finalize Signal | Detects `finalize_research()` calls |
| 🔄 Stagnation | Escalating hints at 5/10/15/20+ non-improving runs |
| 🎯 Progress | Trend analysis every 5 improvements |

**Don't reimplement these.** Build hooks for things the observer doesn't do.

---

## Step 1: Classify the request

Ask: **what should the hook DO, and WHEN?**

| User says... | Stage | Category |
|--------------|-------|----------|
| "notify me on wins" | `after` | Notification |
| "notify on crashes" | `after` | Notification |
| "log every result" | `after` | Journal |
| "tag winning commits" | `after` | Git automation |
| "search the web before each run" | `before` | Research |
| "prevent thrashing" | `before` | Intervention |
| "rotate ideas from backlog" | `before` | Idea management |
| "if 3 discards, suggest pause" | `before` | Intervention |
| "send Slack update" | `after` | Notification |

**Rule: `before` = prospective (intervene, prepare), `after` = retrospective (react, log, notify).**

If the request is both retrospective + prospective → two hooks (one `before`, one `after`), not one overloaded script.

## Step 2: Choose placement

| Scope | Path | When to use |
|-------|------|-------------|
| One project | `.auto/hooks/before.sh` | Default — project-specific logic |
| One project, multiple concerns | `.auto/hooks/before.d/01-X.sh`, `02-Y.sh` | Independent scripts run in parallel |
| All projects | `~/.pi/agent/autoresearch/hooks/before.sh` | Global customization (e.g., Slack webhook) |

**Default: project-local `.auto/hooks/`.** Only go global if the user explicitly wants it for all projects.

## Step 3: Write the hook

### Template (copy this)

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"

# ── Extract fields ──
cwd="$(jq -r '.cwd' <<<"$input")"
status="$(jq -r '.last_run.status // .run_entry.status // empty' <<<"$input")"
metric="$(jq -r '.last_run.metric // .run_entry.metric // empty' <<<"$input")"
best="$(jq -r '.session.best_metric // empty' <<<"$input")"
run_count="$(jq -r '.session.run_count // 0' <<<"$input")"

# ── Guard clause (early exit) ──
[ -z "$metric" ] && exit 0

# ── Your logic ──
# (write your side effect here)

# ── Output (optional steer message) ──
echo "Your steer message for the agent"
```

### Stdin contract

One JSON line. For `before.sh`:

```json
{
  "event": "before",
  "cwd": "/path",
  "next_run": 6,
  "last_run": { "run": 5, "status": "discard", "metric": 42.1, "description": "...", "asi": { "hypothesis": "..." } },
  "session": { "metric_name": "ms", "metric_unit": "ms", "direction": "lower", "baseline_metric": 40.7, "best_metric": 33.5, "run_count": 5, "goal": "..." }
}
```

For `after.sh`, `last_run` → `run_entry` (the run just logged).

### Output contract

- **Stdout** (up to 8 KB) → steer message. Empty = silent.
- **Non-zero exit** → error steer (visible to agent, non-blocking).
- **Timeout** → 30 s hard kill.

## Step 4: Test

**Always test before relying on the hook:**

```bash
# before.sh test
echo '{"event":"before","cwd":".","next_run":4,"last_run":{"run":3,"status":"discard","metric":50},"session":{"metric_name":"ms","metric_unit":"ms","direction":"lower","baseline_metric":45,"best_metric":40,"run_count":3,"goal":"test"}}' \
  | .auto/hooks/before.sh

# after.sh test (note: run_entry instead of last_run)
echo '{"event":"after","cwd":".","run_entry":{"run":4,"status":"keep","metric":38},"session":{"metric_name":"ms","metric_unit":"ms","direction":"lower","baseline_metric":45,"best_metric":38,"run_count":4,"goal":"test"}}' \
  | .auto/hooks/after.sh
```

If output is empty when it shouldn't be → check `set -euo pipefail` isn't killing the script on a failed `jq` extraction. Use `// empty` or `// 0` defaults in jq.

## Step 5: Commit

`.auto/**` survives auto-revert. Commit alongside measure.sh and prompt.md:

```bash
chmod +x .auto/hooks/before.sh
git add .auto/hooks/
git commit -m "chore: add stagnation alert hook"
```

---

## Patterns

### Notification (after.sh)

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
status="$(jq -r '.run_entry.status // empty' <<<"$input")"
[ "$status" != "keep" ] && exit 0

metric="$(jq -r '.run_entry.metric' <<<"$input")"
best="$(jq -r '.session.best_metric' <<<"$input")"

# Slack webhook example
# curl -s -X POST -H 'Content-type: application/json' \
#   --data "{\"text\":\"🎉 New best: $metric\"}" \
#   https://hooks.slack.com/services/XXX

echo "🎉 New best: $metric (was $best)"
```

### Anti-thrash intervention (before.sh)

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
next_run="$(jq -r '.next_run // 0' <<<"$input")"
last_status="$(jq -r '.last_run.status // empty' <<<"$input")"

# Only intervene after 3+ runs
[ "$next_run" -lt 4 ] && exit 0
[ "$last_status" != "discard" ] && exit 0

echo "⚠️ Thrash detected ($(($next_run - 1)) runs, no improvement). Consider: re-read .auto/prompt.md, check noise floor, try a fundamentally different approach."
```

### Learnings journal (after.sh)

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
cwd="$(jq -r '.cwd' <<<"$input")"
status="$(jq -r '.run_entry.status // empty' <<<"$input")"
metric="$(jq -r '.run_entry.metric // "?"' <<<"$input")"
desc="$(jq -r '.run_entry.description // "?"' <<<"$input")"
learned="$(jq -r '.run_entry.asi.learned // empty' <<<"$input")"

journal="$cwd/.auto/learnings.md"
{
  echo "- [$status] $metric: $desc"
  [ -n "$learned" ] && echo "  Learned: $learned"
} >> "$journal"
```

### Idea rotator (before.sh)

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
cwd="$(jq -r '.cwd' <<<"$input")"
streak="$(jq -r '.session.run_count // 0' <<<"$input")"

# Rotate an idea from the backlog every 3 runs
[ $((streak % 3)) -ne 0 ] && exit 0

ideas="$cwd/.auto/ideas.md"
[ ! -f "$ideas" ] && exit 0

# Pick the first unchecked idea
idea=$(grep -m1 '^- \[ \]' "$ideas" 2>/dev/null | sed 's/^- \[ \] //')
[ -z "$idea" ] && exit 0

# Mark it as tried
sed -i "0,/- \[ \] $idea/s//- [x] $idea/" "$ideas"
echo "🔄 Rotating idea from backlog: $idea"
```

---

## Rules

1. **Silent by default.** Only print to stdout when you have something useful. Empty = no steer.
2. **One concern per script.** Use `.d/` for multiple independent hooks.
3. **Guard with early exits.** `[ -z "$x" ] && exit 0`.
4. **No env vars.** Everything on stdin via `jq`.
5. **Always `chmod +x`.** Files without the executable bit are silently ignored.
6. **Use `jq -r` with defaults** (`// empty`, `// 0`) to avoid pipeline failures.
7. **Don't reimplement the observer.** Stagnation, floor, noise, finalize are already handled.

## Examples

Complete reference scripts in `examples/`:
- `examples/before/` — anti-thrash, external search, idea rotator, hypothesis reflection, context rotation
- `examples/after/` — learnings journal, notification on new best, auto-tag winning commits
