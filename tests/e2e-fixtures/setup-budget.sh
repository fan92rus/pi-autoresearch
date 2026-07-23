#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# E2E Fixture: Budget Enforcement + checks_failed
#
# Tests two scenarios:
#   1. Budget: measure.sh with variable sleep → budget_exceeded enforcement
#   2. checks_failed: optimization that breaks correctness → revert + continue
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DEST="${1:-./_e2e_budget}"
mkdir -p "$DEST/.auto"

# ── app.sh: simple computation ────────────────────────────────────────────
cat > "$DEST/app.sh" << 'SHEOF'
#!/usr/bin/env bash
# Sum 1..1000
s=0
for i in $(seq 1 1000); do s=$((s + i)); done
echo "$s"
SHEOF
chmod +x "$DEST/app.sh"

# ── measure.sh: variable sleep to test budget ─────────────────────────────
cat > "$DEST/.auto/measure.sh" << 'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."

# Variable delay: smoke=fast, quick=medium, full=slow
case "${BENCH_MODE:-}" in
  smoke) SLEEP=0.01 ;;
  quick) SLEEP=0.5 ;;
  *)     SLEEP=2 ;;
esac

# Run the benchmark
REPS=5
[ "${BENCH_MODE:-}" = "smoke" ] && REPS=1

node -e "
const { execSync } = require('child_process');
const reps = $REPS;
const sleep = $SLEEP;
const times = [];
for (let i = 0; i < reps; i++) {
  const t0 = process.hrtime.bigint();
  try { execSync('bash app.sh', { stdio: 'ignore' }); } catch {}
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log('METRIC latency_ms=' + median.toFixed(3));
"
SHEOF
chmod +x "$DEST/.auto/measure.sh"

# ── checks.sh: strict correctness ─────────────────────────────────────────
cat > "$DEST/.auto/checks.sh" << 'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."
out=$(bash app.sh 2>/dev/null)
# sum 1..1000 = 500500
[ "$out" = "500500" ] || { echo "FAIL: got '$out' expected '500500'"; exit 1; }
echo "OK: app.sh correct"
SHEOF
chmod +x "$DEST/.auto/checks.sh"

cat > "$DEST/.auto/prompt.md" << 'MDEOF'
# Optimization Goal

Reduce `latency_ms` of `app.sh`.

## Test scenarios

### Budget enforcement
Run with budget_seconds=1 to trigger budget_exceeded.
The measure.sh in full mode takes ~2s per rep × 5 reps = ~10s.
With budget_seconds=1, it should be killed and flagged budget_exceeded.

### checks_failed
If an optimization changes the output (e.g. removes the loop and just echoes
a constant), checks.sh should catch it and flag as checks_failed.

## Constraints
- Do NOT modify measure.sh, checks.sh
- Respect BENCH_MODE env var
MDEOF

echo ".auto/parallel/" > "$DEST/.gitignore"

echo "✅ E2E fixture created at $DEST"
echo ""
echo "   Budget test:"
echo "     cd $DEST && git init && git add -A && git commit -m initial"
echo "     /autoresearch on"
echo "     run_experiment(command='bash .auto/measure.sh', budget_seconds=1)"
echo ""
echo "   checks_failed test:"
echo "     # Optimize app.sh to output wrong value → checks_failed"
echo "     # Then optimize to closed-form echo \$((1000*1001/2)) → keep"
