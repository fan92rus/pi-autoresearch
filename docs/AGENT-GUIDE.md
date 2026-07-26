# Agent Guide: Experiment Tree

> **For the AI agent.** This guide explains the experiment tree tools and how to use them effectively during autoresearch sessions.

---

## What is the Experiment Tree?

The experiment tree is a **structured memory of your optimization exploration**. Instead of a flat list of experiments, each experiment is recorded as a **node** in a parent→child tree:

```
n0  100µs  baseline
├── n1  92µs  ●  "AST cache"          keep   -8µs
│    └── n2  88µs  ●  "LRU eviction"  keep   -4µs  ← YOU ARE HERE
└── n3  81µs  ●  "lookup table"       keep  -19µs ★ BEST
```

**Key benefits:**
- **Never repeat a failed hypothesis** — SimHash detects duplicates before you run
- **Backtrack from dead ends** — `explore_from` jumps to any past node
- **Compose orthogonal wins** — `compose` merges improvements from different branches
- **See your exploration map** — `tree_status` shows the full tree + UCB1 suggestions

The tree is stored in `.auto/tree.json` and is **fully optional** — if it doesn't exist, all experiments work normally (flat log in `log.jsonl`).

---

## Tools Reference

### `tree_status(detail?)`

**When to use:** Call this when you're stuck, after every 3-4 experiments, or when you see a stagnation/tree-exhausted message.

```ts
tree_status()                  // Tree diagram + UCB1 suggestions
tree_status({ detail: "ucb1" }) // UCB1 ranking only (compact)
tree_status({ detail: "full" }) // Tree + all node details
```

**What it shows:**
- ASCII tree diagram with status icons (● keep, ○ discard, ◆ compose, ★ best, ← active, ☒ exhausted)
- UCB1 ranking of expandable nodes (exploitation + exploration balance)
- Exhausted branches marked with ☒

**UCB1 interpretation:**
- High UCB1 = promising node to expand (either good past results or underexplored)
- The top suggestion includes a ready-to-use `explore_from("nX")` call

---

### `explore_from(node_id)`

**When to use:** When `tree_status` suggests a better node, or your current branch is exhausted (3+ discards).

```ts
explore_from({ node_id: "n3" })
```

**What it does:**
1. Checks out the node's git commit (detached HEAD)
2. Saves your current branch for later restoration
3. Sets the node as the new active point

**After explore_from:**
- Run experiments normally — each `log_experiment` creates a child of the new active node
- When done, call `restore_main()` to return to the main branch

**Constraints:**
- Cannot explore from ghost nodes (discard/crash — no commit)
- Creates a detached HEAD — always `restore_main()` when done

---

### `restore_main()`

**When to use:** After `explore_from` when you're done exploring that branch.

```ts
restore_main()
```

**What it does:**
- Returns to the main branch (where you started)
- Sets active node to the last keep-node on main
- Clears the saved branch state

**Always call this before switching to a different explore_from target or ending the session.**

---

### `compose(node_a, node_b)`

**When to use:** When `tree_status` shows two keep-nodes on different branches that touch different files.

```ts
compose({ node_a: "n1", node_b: "n3" })
```

**What it does:**
1. Finds the Lowest Common Ancestor (merge-base) of both commits
2. Checks file-scope orthogonality (changes must touch different files)
3. Applies both diffs to the working directory

**After compose:**
- The working directory now has both sets of changes
- Run `run_experiment` to benchmark the combined result
- Log with `log_experiment(status="keep", asi={composed_from: ["n1", "n3"]})` to record as a compose node

**Constraints:**
- Phase 1: orthogonal only (different files). Same-file conflicts return an error.
- Cannot compose ghost nodes (discard/crash)

---

### `run_experiment({ hypothesis: "..." })`

**When to use:** ALWAYS pass `hypothesis` when calling `run_experiment`.

```ts
run_experiment({
  command: "bash .auto/measure.sh",
  timeout_seconds: 120,
  hypothesis: "Replace switch/case dispatch with lookup table for O(1) access",
})
```

**What the hypothesis does:**
- **Pre-run repeat detection:** Before the experiment runs, the system computes a SimHash of your hypothesis and compares it against sibling experiments (children of the current active node)
- If a match is found (distance ≤ 3 bits), you'll see a warning:

```
⚠️ POSSIBLE REPEAT: hypothesis "Increase cache capacity to 256"
  matches n3 "bigger cache size" (discard — noise)
  SimHash distance=1 (likely).
  If this is a genuinely different idea — proceed. Otherwise consider a new approach.
```

**This is advisory — you can proceed if it's genuinely different.** The warning helps you avoid wasting time on already-tried ideas.

---

## The Exploration Workflow

### Phase 1: Descent (normal optimization)

```
1. init_experiment → tree root (n0) created
2. run_experiment(hypothesis="...") → measure
3. log_experiment(keep) → node n1 created, child of n0
4. repeat → n1→n2→n3... (linear descent)
```

Each `log_experiment(keep)` creates a child node and advances the active position. This is the normal hill-climbing flow — no tree tools needed.

### Phase 2: Dead-end detection

When you see:
- `🌲 tree: branch at n2 marked exhausted` in log_experiment output
- `🔄 STAGNATION` with `🌳 TREE STATUS: Current branch is EXHAUSTED`
- 3+ consecutive discards at the same node

**Stop experimenting. Call `tree_status()` to see the map.**

### Phase 3: Backtracking

```ts
// See where to go next
tree_status()

// UCB1 suggests: explore_from("n6") (UCB1=0.81, underexplored)
explore_from({ node_id: "n6" })

// Now experiment from n6 — new children branch off from n6
run_experiment({ hypothesis: "...", timeout_seconds: 120 })
log_experiment({ status: "keep", metric: 75 })

// Return to main when done
restore_main()
```

### Phase 4: Composition

When two branches show independent improvements:

```ts
// Check the tree — n1 (AST cache, parser.ts) and n6 (lookup table, dispatch.ts)
tree_status()

// They touch different files → orthogonal
compose({ node_a: "n1", node_b: "n6" })

// Benchmark the combined result
run_experiment({ command: "bash .auto/measure.sh", timeout_seconds: 120 })

// Record as compose node
log_experiment({
  status: "keep",
  metric: 72,
  description: "compose(n1,n6)",
  asi: { composed_from: ["n1", "n6"] }
})
```

---

## Tree Node Structure

Every experiment creates a node with:

| Field | Description |
|-------|-------------|
| `id` | Unique ID (n0, n1, ...) |
| `parentId` | Parent node (null for root) |
| `commit` | Git SHA (null for discard/crash = ghost) |
| `metric` | Metric value at this node |
| `hypothesis` | Your description from log_experiment |
| `status` | keep / discard / crash / checks_failed |
| `simhashFull` | SimHash fingerprint for repeat detection |
| `nodeType` | baseline / experiment / compose |
| `exhausted` | True if branch has 3+ consecutive discards |

---

## UCB1 Ranking Explained

UCB1 balances **exploitation** (nodes whose children showed improvement) and **exploration** (nodes with few children — unexplored).

Formula: `UCB1 = exploitation + C × √(ln(N) / (1 + children))`

| Reason | Meaning |
|--------|---------|
| `unexplored` | 0 children — completely fresh territory |
| `promising branch (avg +X%)` | Children showed good improvement |
| `underexplored` | Few children relative to total experiments |
| `neutral` | Neither particularly good nor bad |

**C constant** defaults to 0.5. Configurable via `.auto/config.json` → `parallel.ucb1C`.

---

## Best Practices

### DO ✅

- **Always pass `hypothesis`** to `run_experiment` — enables repeat detection
- **Call `tree_status()` proactively** when stuck or after 3-4 experiments
- **Use `explore_from`** when UCB1 suggests a better node or your branch is exhausted
- **Always `restore_main()`** after `explore_from` — prevents stale detached HEAD
- **Use `compose`** when two branches show orthogonal improvements
- **Record `composed_from` in ASI** when logging compose results

### DON'T ❌

- **Don't ignore exhaustion warnings** — if a branch is exhausted, backtrack
- **Don't compose non-orthogonal changes** — Phase 1 only supports different files
- **Don't forget `restore_main()`** — leaving detached HEAD causes confusion
- **Don't re-try hypotheses** flagged by SimHash unless genuinely different
- **Don't call `explore_from` on ghost nodes** (discard/crash) — they have no commit

---

## Observer Integration

The observer automatically provides tree-aware steers:

### Stagnation with tree hint

```
🔄 STAGNATION: No metric improvement in 5 runs.
...
🌳 TREE STATUS: Current branch is EXHAUSTED.
   Exhausted nodes: n2
   UCB1 suggests: explore_from("n6") (UCB1=0.81, underexplored)
   Call tree_status() for full map, or explore_from("n6") to backtrack.
```

### Composition opportunity

```
🔗 COMPOSITION OPPORTUNITY: Tree has 3 keep-nodes on different branches.

💡 Try combining orthogonal improvements:
   compose("n1", "n6")
   n1: "AST cache" (92µs)
   n6: "lookup table" (81µs)

   If the changes touch different files, compose() will merge them — stacking improvements.
   Call tree_status() to see the full tree and find the best pair.
```

---

## Git Integration

The tree uses git under the hood:

- **`refs/exp/<nodeId>`** — each keep-node's commit is protected from GC
- **`explore_from`** checks out a specific commit (detached HEAD)
- **`compose`** finds merge-base and applies orthogonal file changes via `git checkout <commit> -- <file>`

The tree is **non-destructive** — backtracking doesn't delete old branches. All keep-nodes remain accessible via their refs.

---

## Migration & Compatibility

- **Zero migration:** Existing sessions without `.auto/tree.json` work unchanged
- **log.jsonl unchanged:** The flat log remains as the source of truth for the observer and dashboard
- **tree.json is an overlay:** Created automatically on `init_experiment`, adds structure on top of the flat log
- **BestOfN/SpaceSearch:** Not yet integrated with the tree (Phase 2). They work independently.

---

## Quick Reference

| Situation | Tool |
|-----------|------|
| Stuck, need to see the map | `tree_status()` |
| Branch exhausted, need to backtrack | `explore_from("nX")` → experiment → `restore_main()` |
| Two branches show orthogonal wins | `compose("nA", "nB")` → benchmark → `log_experiment` |
| Want to check if hypothesis was tried | Pass `hypothesis` to `run_experiment` |
| Observer says "explore_from suggested" | `tree_status()` → pick node → `explore_from` |
