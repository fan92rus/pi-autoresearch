#!/usr/bin/env bash
# Anti-thrash: after 3 consecutive discards, suggest a different approach
set -euo pipefail
input="$(cat)"

next_run="$(echo "$input" | jq -r '.next_run // 0')"
[ "$next_run" -lt 4 ] && exit 0

# Check if last 3 runs were discards
last3="$(echo "$input" | jq -r '
  [.session.run_count, .last_run.status // "unknown"] |
  .[1]
')"

# Simple: if streak is high, suggest pause
streak_guess=0
status="$(echo "$input" | jq -r '.last_run.status // empty')"
[ "$status" = "discard" ] && streak_guess=1

[ "$streak_guess" -eq 0 ] && exit 0

echo "⚠️ Thrash detected. Consider: (1) re-read .auto/prompt.md for forgotten constraints, (2) check if the metric is at noise floor, (3) try a radically different approach."
