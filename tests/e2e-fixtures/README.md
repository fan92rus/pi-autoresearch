# E2E Test Fixtures for Parallel Modes

These fixtures set up test projects for manual E2E validation of parallel modes
that require live pi-subagents RPC (cannot be unit-tested).

## Usage

```bash
# 1. Create a test project from a fixture
bash tests/e2e-fixtures/setup-orthogonal.sh /path/to/test-project

# 2. Enter the project and init git
cd /path/to/test-project
git init && git add -A && git commit -m "initial"

# 3. Start pi, enable autoresearch, run the parallel tool
#    /autoresearch on
#    CheckOrthogonal(patches=[...])
```

## Fixtures

| Fixture | Tests | Setup |
|---------|-------|-------|
| `setup-orthogonal.sh` | CheckOrthogonal (Mode B) | Two independent JS files with optimizable functions |
| `setup-spacesearch.sh` | SpaceSearch (Mode C) | Multimodal landscape with 3 strategies (brute/hash/sorted) |
| `setup-budget.sh` | Budget enforcement | measure.sh with variable sleep |
| `setup-checks-failed.sh` | checks_failed handling | Strict correctness check that optimization can break |
