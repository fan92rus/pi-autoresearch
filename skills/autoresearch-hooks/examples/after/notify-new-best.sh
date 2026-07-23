#!/usr/bin/env bash
# Notify on new best metric (cross-platform: terminal bell + log entry)
set -euo pipefail
input="$(cat)"

status="$(echo "$input" | jq -r '.run_entry.status // empty')"
[ "$status" != "keep" ] && exit 0

metric="$(echo "$input" | jq -r '.run_entry.metric')"
best="$(echo "$input" | jq -r '.session.best_metric')"
desc="$(echo "$input" | jq -r '.run_entry.description // "?"')"

# Append to learnings journal
journal="$(echo "$input" | jq -r '.cwd')/.auto/learnings.md"
echo "- **NEW BEST** $metric (was $best): $desc" >> "$journal"

echo "🎉 New best: $metric (improved from $best)"
