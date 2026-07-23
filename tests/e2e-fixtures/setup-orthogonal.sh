#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# E2E Fixture: CheckOrthogonal (Mode B)
#
# Sets up a project with TWO independent optimizable files:
#   parse.js  — for-loop sum optimizable to closed-form (file_scope: ["parse.js"])
#   render.js — string concatenation optimizable to array.join (file_scope: ["render.js"])
#
# Expected: CheckOrthogonal detects no scope conflict, stacks both patches,
#   total improvement ≈ Σ individual improvements.
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DEST="${1:-./_e2e_orthogonal}"
mkdir -p "$DEST/.auto"

# ── parse.js: O(n) loop → O(1) formula ────────────────────────────────────
cat > "$DEST/parse.js" << 'JSEOF'
// Parse module — sum 1..N via loop (O(n), optimizable to closed-form)
function sumRange(n) {
  let s = 0;
  for (let i = 1; i <= n; i++) {
    s += i;
  }
  return s;
}

module.exports = { sumRange };
JSEOF

# ── render.js: string += → array.push + join ──────────────────────────────
cat > "$DEST/render.js" << 'JSEOF'
// Render module — build HTML via string concatenation (O(n²), optimizable to array join)
function renderList(items) {
  let html = "<ul>";
  for (let i = 0; i < items.length; i++) {
    html += "<li>" + items[i] + "</li>";
  }
  html += "</ul>";
  return html;
}

module.exports = { renderList };
JSEOF

# ── app.js: uses both modules ─────────────────────────────────────────────
cat > "$DEST/app.js" << 'JSEOF'
const { sumRange } = require("./parse");
const { renderList } = require("./render");

const N = 10000;
const items = [];
for (let i = 1; i <= N; i++) items.push("item" + i);

const sum = sumRange(N);
const html = renderList(items);

// Output: sum and html length (for correctness check)
console.log(sum);
console.log(html.length);
JSEOF

# ── measure.sh: times app.js execution ────────────────────────────────────
cat > "$DEST/.auto/measure.sh" << 'SHEOF'
#!/usr/bin/env bash
# Times app.js via Node hrtime (median of 5 reps, 1 for BENCH_MODE=smoke)
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

# ── checks.sh: correctness validation ─────────────────────────────────────
cat > "$DEST/.auto/checks.sh" << 'SHEOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."
out=$(node app.js 2>/dev/null)
sum=$(echo "$out" | head -1)
len=$(echo "$out" | tail -1)

# sumRange(10000) = 50005000
[ "$sum" = "50005000" ] || { echo "FAIL: sum=$sum expected 50005000"; exit 1; }

# renderList length should be consistent (each <li>itemN</li> = ~17 chars)
[ "$len" -gt 100000 ] || { echo "FAIL: html length=$len too short"; exit 1; }

echo "OK: correctness verified (sum=$sum, html_len=$len)"
SHEOF
chmod +x "$DEST/.auto/checks.sh"

# ── prompt.md: optimization goal ──────────────────────────────────────────
cat > "$DEST/.auto/prompt.md" << 'MDEOF'
# Optimization Goal

Reduce `latency_ms` of `app.js` by optimizing `parse.js` and `render.js`.

## Constraints
- Only modify `parse.js` and `render.js`
- Do NOT modify `measure.sh`, `checks.sh`, `app.js`
- Correctness must pass: sum=50005000, html length > 100000
- Respect BENCH_MODE env var
MDEOF

# ── config.json ───────────────────────────────────────────────────────────
cat > "$DEST/.auto/config.json" << 'JSONEOF'
{
  "parallel": {
    "concurrency": 2,
    "budgetSeconds": 60,
    "cascade": true,
    "tiers": {
      "fast": { "model": "opencode-go/deepseek-v4-flash" },
      "mid": { "model": "opencode-go/deepseek-v4-flash" },
      "strong": { "model": "zai-glm/glm-5.2" }
    }
  }
}
JSONEOF

# ── gitignore ─────────────────────────────────────────────────────────────
echo ".auto/parallel/" > "$DEST/.gitignore"
echo "node_modules/" >> "$DEST/.gitignore"

echo "✅ E2E fixture created at $DEST"
echo "   Next: cd $DEST && git init && git add -A && git commit -m initial"
echo "   Then in pi: /autoresearch on"
echo "   CheckOrthogonal(patches=[{name:'parse-formula',hypothesis:'Optimize parse.js sumRange to closed-form n*(n+1)/2',fileScope:['parse.js']},{name:'render-join',hypothesis:'Optimize render.js to use array.push + join instead of string concat',fileScope:['render.js']}])"
