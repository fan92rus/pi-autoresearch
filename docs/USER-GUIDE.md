# Decision Tree: User Guide

> The Experiment Tree gives you (and the AI agent) a **visual map of optimization exploration** — see what was tried, what worked, what failed, and where to backtrack.

---

## What is it?

During an autoresearch session, the agent runs dozens of experiments — each one a hypothesis ("try AST caching", "switch to a lookup table", "precompute hashes"). Without the tree, these are just a flat chronological list.

The **Experiment Tree** organizes them into a **parent→child hierarchy**:

```
n0  100µs  baseline
├── n1  92µs  ●  "AST cache"          keep   -8µs
│    ├── n2  88µs  ●  "LRU eviction"  keep   -4µs
│    │    ├── n3  88µs  ○  "bigger"   discard
│    │    └── n4  89µs  ○  "precomp"  discard
│    └── n5  90µs  ●  "hash table"    keep   -2µs
├── n6  81µs  ●  "lookup table"       keep  -19µs
│    └── n7  78µs  ●  "precompute"    keep   -3µs
└── n8  72µs  ◆  "compose(n1,n7)"    keep  -28µs ★ BEST
```

This lets the agent:
- **See the full exploration map** — not just the latest result, but every branch tried
- **Backtrack from dead ends** — if "AST cache → LRU eviction" hit a wall, the agent can jump back to baseline and try a different direction
- **Compose orthogonal wins** — if one branch optimized parsing and another optimized dispatching, the agent can merge them
- **Avoid repeating failed ideas** — before running an experiment, the system checks if a similar hypothesis was already tried

---

## Enabling the tree

The tree is **enabled by default** — it activates automatically when you start a session with `/autoresearch` or `init_experiment`. No setup needed.

The tree data is stored in `.auto/tree.json` alongside the existing `.auto/log.jsonl`.

---

## Viewing the tree

### In the terminal (TUI)

Toggle between the list view (default dashboard) and the tree view:

```
/autoresearch tree
```

This switches the dashboard widget to show the ASCII tree. Run the command again to switch back to the list view.

### Via the agent

Ask the agent to show the tree:

```
tree_status()
```

The agent can call `tree_status()` and will see:
- The ASCII tree diagram
- UCB1 suggestions (which nodes are most promising to expand)
- Exhausted branches highlighted

You can also ask in natural language: *"show me the experiment tree"* or *"what's the tree status?"*

---

## Understanding the tree

### Node icons

| Icon | Meaning |
|------|---------|
| ◯ | Baseline (starting point) |
| ● | Keep — experiment succeeded, code committed |
| ○ | Discard — experiment failed or was within noise |
| ✕ | Crash — code error, automatically reverted |
| ⚠ | Checks failed — benchmark passed but correctness checks didn't |
| ◆ | Compose — merged from two different branches |

### Markers

| Marker | Meaning |
|--------|---------|
| ★ BEST | Node with the best metric value |
| ← HERE | Currently active node (where new experiments attach) |
| ☒ | Branch exhausted (3+ consecutive discards) |

### Delta values

Each node shows the improvement relative to baseline:
- `+8.0 (8%)` — improved by 8 units (8% of baseline)
- `-2.0 (-2%)` — regressed by 2 units

The direction (higher/lower is better) is set during `init_experiment`.

---

## How the agent uses the tree

### Normal exploration (automatic)

When the agent runs experiments, each one becomes a child of the current node. This is the default hill-climbing flow — no user intervention needed:

```
n0 → n1 → n2 → n3 (each is a keep, descending one path)
```

### Backtracking (when stuck)

When the agent hits a dead end (3+ discards on the same branch), the observer suggests backtracking:

```
🔄 STAGNATION: No metric improvement in 5 runs.
🌳 TREE STATUS: Current branch is EXHAUSTED.
   UCB1 suggests: explore_from("n6") (UCB1=0.81, underexplored)
```

The agent then:
1. Calls `tree_status()` to see the full map
2. Calls `explore_from("n6")` to jump to a different branch
3. Runs new experiments from n6
4. Calls `restore_main()` when done

This all happens autonomously — you just see the agent "change direction" intelligently.

### Composition (merging branches)

When two independent branches show improvements on different files, the observer suggests merging them:

```
🔗 COMPOSITION OPPORTUNITY: Tree has 3 keep-nodes on different branches.
💡 Try combining orthogonal improvements:
   compose("n1", "n6")
```

The agent merges the changes, benchmarks the combined result, and records a compose node (◆).

---

## Repeat detection

When you pass a `hypothesis` to `run_experiment`, the system checks if a similar hypothesis was already tried at the current position in the tree:

```
⚠️ POSSIBLE REPEAT: hypothesis "Increase cache capacity to 256"
  matches n3 "bigger cache size" (discard — noise)
  SimHash distance=1 (likely).
```

This uses **SimHash** — a fast text-similarity fingerprint. It catches:
- Exact rewording ("add AST cache" vs "add AST caching")
- Near-identical hypotheses

It does NOT catch semantic duplicates with different wording ("cache the AST" vs "memoize parsed nodes"). That's planned for a future phase with embeddings.

The warning is **advisory** — the agent can proceed if it judges the idea is genuinely different.

---

## UCB1 suggestions

The tree includes **UCB1 ranking** — a formula from reinforcement learning that balances:

- **Exploitation:** Nodes whose children showed good improvement (promising territory)
- **Exploration:** Nodes with few children (unexplored territory)

High UCB1 nodes are good candidates for expansion. The agent sees:

```
UCB1 Suggestions (expandable nodes):
  #1  n6  UCB1=0.81  (1 child) — underexplored, high reward
  #2  n0  UCB1=0.44  (3 children) — baseline, try new vector?
  ❌ n1  EXHAUSTED

💡 Suggestion: explore_from("n6")
```

**Configuration:** The exploration constant C defaults to 0.5. Tune via `.auto/config.json`:

```json
{
  "parallel": {
    "ucb1C": 0.7
  }
}
```

Higher C = more exploration (favor unexplored nodes). Lower C = more exploitation (favor proven territory).

---

## Git integration

The tree leverages git to preserve every experiment branch:

- **`refs/exp/<nodeId>`** — Each keep-node's commit is protected from garbage collection
- **`explore_from`** checks out a specific commit (detached HEAD)
- **`compose`** finds the merge-base and applies orthogonal file-level changes

You can inspect the refs manually:

```bash
git show-ref refs/exp/
# refs/exp/n0: abc1234
# refs/exp/n1: def5678
# refs/exp/n6: jkl3456
```

The tree is **non-destructive** — backtracking doesn't delete old branches. All keep-nodes remain accessible.

---

## The tree.json file

Structure stored in `.auto/tree.json`:

```json
{
  "version": 1,
  "rootId": "n0",
  "activeNodeId": "n4",
  "nextId": 5,
  "baselineMetric": 100,
  "direction": "lower",
  "metricName": "parse_time_us",
  "nodes": {
    "n0": {
      "id": "n0",
      "parentId": null,
      "children": ["n1", "n3"],
      "commit": "abc1234",
      "metric": 100,
      "hypothesis": "baseline",
      "status": "baseline",
      "depth": 0,
      "nodeType": "baseline"
    },
    "n1": {
      "id": "n1",
      "parentId": "n0",
      "children": ["n2"],
      "commit": "def5678",
      "metric": 92,
      "hypothesis": "Add AST caching layer",
      "status": "keep",
      "simhashFull": "fd7ae1eb",
      "depth": 1,
      "nodeType": "experiment"
    }
  }
}
```

Key fields:
- **`activeNodeId`** — Where the agent currently is in the tree
- **`commit`** — Git SHA (null for discard/crash "ghost" nodes)
- **`simhashFull`** — SimHash fingerprint for repeat detection
- **`exhausted`** — True if branch has 3+ consecutive discards
- **`nodeType`** — baseline / experiment / compose

---

## Compatibility

- **Zero migration:** Existing sessions without `.auto/tree.json` work unchanged
- **log.jsonl unchanged:** The flat log remains as the source of truth
- **tree.json is an overlay:** Adds structure on top of the existing flat log
- **BestOfN/SpaceSearch:** Work independently (tree integration planned for Phase 2)

---

## Limitations (Phase 1)

| Limitation | Workaround |
|------------|------------|
| SimHash is lexical, not semantic | Rephrased duplicates are caught; semantic duplicates with different words may be missed |
| Compose only works for orthogonal files | Same-file conflicts return an error — manual merge is planned for Phase 2 |
| No GC of old refs | All `refs/exp/*` are preserved; GC strategy planned for Phase 2 |
| BestOfN/SpaceSearch don't write to tree | These parallel tools work independently; tree integration is Phase 2 |

---

## FAQ

### Where is the tree data stored?

In `.auto/tree.json` — alongside the existing `.auto/log.jsonl`. Both are preserved across `log_experiment` revert operations.

### Can I delete the tree?

Delete `.auto/tree.json`. The session continues with the flat log. The tree is recreated on the next `init_experiment`.

### Can I have multiple trees?

Not in Phase 1. Each `init_experiment` creates a fresh tree (clearing any previous one). Use `init_experiment` to start a new segment with a new tree.

### What happens if I interrupt (Escape) during explore_from?

The detached HEAD persists. Run `restore_main()` or `git checkout <branch>` manually to return.

### Can I manually edit tree.json?

Yes — it's a JSON file. But the tree is also cached in memory during the session. Changes take effect on the next tool call that reloads the tree (typically after `log_experiment`).
