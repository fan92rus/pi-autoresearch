#!/usr/bin/env bash
# CI pre-flight check: import all .ts files to catch parse errors that
# node --check misses (the pi extension loader uses a different parser).
#
# Usage: bash tests/check-parse.sh
# Exit: 0 = all files parse, 1 = at least one file failed
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extensions/pi-autoresearch"

# Find all .ts files under the extension directory
mapfile -t FILES < <(find "$EXT_DIR" -name '*.ts' -type f | sort)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No .ts files found in $EXT_DIR"
  exit 1
fi

echo "Checking ${#FILES[@]} .ts files for parse errors..."
echo ""

FAILED=0
PASSED=0

for f in "${FILES[@]}"; do
  rel="${f#$REPO_ROOT/}"

  # Use --experimental-strip-types to parse + type-strip, then import.
  # Capture output; the node script exits 1 only on SyntaxError (parse errors).
  output="$(node --experimental-strip-types -e "
    try {
      await import('file:///$f');
    } catch(e) {
      // Ignore module-not-found / import resolution errors.
      // Only flag SyntaxError / parse errors.
      if (e instanceof SyntaxError || /Unexpected token|expected|ParseError/i.test(e.message || '')) {
        console.error(e.message);
        process.exit(1);
      }
    }
  " 2>&1)"

  if [ $? -eq 0 ]; then
    echo "  ✅ $rel"
    PASSED=$((PASSED + 1))
  else
    echo "  ❌ $rel"
    echo "     ${output}"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "💡 Parse errors will prevent the pi extension from loading."
  exit 1
fi

exit 0
