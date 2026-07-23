#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# E2E Fixture: SpaceSearch (Mode C) — multimodal landscape
#
# Sets up a project with THREE lookup strategies, each a local optimum at
# different data sizes:
#   brute.js   — O(n²) — optimum at small N
#   hash.js    — O(n)  — optimum at medium N
#   sorted.js  — O(n log n) — global optimum
#
# config.js selects the strategy. SpaceSearch should explore different
# strategies and find the global optimum.
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DEST="${1:-./_e2e_spacesearch}"
mkdir -p "$DEST/.auto"

# ── config.js: strategy selector ──────────────────────────────────────────
cat > "$DEST/config.js" << 'JSEOF'
// Strategy selector — change STRATEGY to "brute" | "hash" | "sorted"
const STRATEGY = "brute";

module.exports = { STRATEGY };
JSEOF

# ── data.js: generates lookup data ────────────────────────────────────────
cat > "$DEST/data.js" << 'JSEOF'
// Generates N items and M lookups
function generateData(n, m) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: i, value: Math.random() });
  const lookups = [];
  for (let i = 0; i < m; i++) lookups.push(Math.floor(Math.random() * n));
  return { items, lookups };
}

module.exports = { generateData };
JSEOF

# ── app.js: the benchmark ─────────────────────────────────────────────────
cat > "$DEST/app.js" << 'JSEOF'
const { STRATEGY } = require("./config");
const { generateData } = require("./data");

const N = 5000;  // items
const M = 2000;  // lookups
const { items, lookups } = generateData(N, M);

let results;

if (STRATEGY === "brute") {
  // O(n*m) brute force — slow at large N
  results = lookups.map(target => {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === target) return items[i].value;
    }
    return null;
  });
} else if (STRATEGY === "hash") {
  // O(n + m) hash map — fast lookup
  const map = new Map();
  for (const item of items) map.set(item.id, item.value);
  results = lookups.map(target => map.get(target) ?? null);
} else if (STRATEGY === "sorted") {
  // O(n log n + m log n) sorted + binary search
  items.sort((a, b) => a.id - b.id);
  results = lookups.map(target => {
    let lo = 0, hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].id === target) return items[mid].value;
      if (items[mid].id < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  });
}

// Verify all lookups succeeded
const failed = results.filter(r => r === null).length;
console.log(failed === 0 ? "OK" : "FAIL:" + failed);
JSEOF

# ── measure.sh ────────────────────────────────────────────────────────────
cat > "$DEST/.auto/measure.sh" << 'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."

REPS=5
[ "${BENCH_MODE:-}" = "smoke" ] && REPS=1
[ "${BENCH_MODE:-}" = "quick" ] && REPS=3

node -e "
const { execSync } = require('child_process');
const reps = $REPS;
const times = [];
for (let i = 0; i < reps; i++) {
  const t0 = process.hrtime.bigint();
  try { execSync('node app.js', { stdio: 'ignore' }); } catch {}
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log('METRIC latency_ms=' + median.toFixed(3));
"
SHEOF
chmod +x "$DEST/.auto/measure.sh"

# ── checks.sh ─────────────────────────────────────────────────────────────
cat > "$DEST/.auto/checks.sh" << 'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."
out=$(node app.js 2>/dev/null)
[ "$out" = "OK" ] || { echo "FAIL: $out"; exit 1; }
echo "OK: all lookups succeeded"
SHEOF
chmod +x "$DEST/.auto/checks.sh"

# ── prompt.md ─────────────────────────────────────────────────────────────
cat > "$DEST/.auto/prompt.md" << 'MDEOF'
# Optimization Goal

Reduce `latency_ms` of `app.js` by selecting the best lookup strategy.

The STRATEGY in `config.js` can be "brute", "hash", or "sorted". Each is a
local optimum at different data sizes. Find the global optimum.

## Constraints
- Only modify `config.js` (strategy selection)
- Do NOT modify `measure.sh`, `checks.sh`, `app.js`, `data.js`
- Correctness must pass: all lookups must succeed
- Respect BENCH_MODE env var

## SpaceSearch hints
Use SpaceSearch to explore strategies:
1. init with beamWidth=3, candidatesPerState=3
2. step with diversityHints=["brute","hash","sorted"]
3. finish to re-measure winner
MDEOF

echo ".auto/parallel/" > "$DEST/.gitignore"
echo "node_modules/" >> "$DEST/.gitignore"

echo "✅ E2E fixture created at $DEST"
echo "   Next: cd $DEST && git init && git add -A && git commit -m initial"
echo "   Then in pi: /autoresearch on"
echo "   SpaceSearch(action='init', beamWidth=3, candidatesPerState=3, diversityHints=['try hash strategy','try sorted strategy','try brute strategy'])"
