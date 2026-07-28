/**
 * ASCII tree renderer for TUI display.
 *
 * Renders the experiment tree from tree.json as a colored ASCII tree:
 *
 *   n0  100µs  baseline
 *   ├── n1  92µs  ●  "AST cache"          keep   -8µs
 *   │    ├── n2  88µs  ●  "LRU eviction"  keep   -4µs  ← HERE
 *   │    └── n3  88µs  ○  "bigger cache"  discard
 *   └── n4  72µs  ◆  "compose(n1,n3)"    keep  -28µs ★ BEST
 */

import type { ExperimentTree, TreeNode } from "./tree.ts";

const SYMBOLS = {
  branch: "├── ",
  lastBranch: "└── ",
  vertical: "│",
  verticalIndent: "│   ",
  emptyIndent: "    ",
  active: " ← HERE",
  best: " ★ BEST",
} as const;

const STATUS_ICONS: Record<string, string> = {
  baseline: "◯",
  keep: "●",
  discard: "○",
  crash: "✕",
  checks_failed: "⚠",
  compose: "◆",
  untested: "◇",
  running: "◎",
  duplicate: "⊘",
};

/**
 * Get recent-subtree view: last N branches from root, at most M nodes per branch.
 * Returns { rootChildren (filtered), hiddenBranches, nodesPerBranchLimit }.
 */
function getRecentView(
  tree: ExperimentTree,
  maxBranches: number,
  nodesPerBranch: number,
): { rootChildren: string[]; hiddenBranches: number; nodeLimit: number } {
  const root = tree.nodes[tree.rootId];
  if (!root) return { rootChildren: [], hiddenBranches: 0, nodeLimit: nodesPerBranch };

  const allChildren = root.children;
  if (allChildren.length <= maxBranches) {
    return { rootChildren: allChildren, hiddenBranches: 0, nodeLimit: nodesPerBranch };
  }

  return {
    rootChildren: allChildren.slice(-maxBranches),
    hiddenBranches: allChildren.length - maxBranches,
    nodeLimit: nodesPerBranch,
  };
}

/**
 * Format a metric value for display.
 */
function formatMetric(value: number, unit: string): string {
  if (unit === "µs" || unit === "us") {
    return `${value.toFixed(1)}µs`;
  }
  if (unit === "ms") return `${value.toFixed(2)}ms`;
  if (unit === "s") return `${value.toFixed(3)}s`;
  if (unit === "kb") return `${value.toFixed(0)}kb`;
  if (unit === "mb") return `${value.toFixed(1)}mb`;
  return `${value.toFixed(1)}${unit ? " " + unit : ""}`;
}

/**
 * Compute delta string relative to baseline.
 */
function deltaString(metric: number, baseline: number, direction: string): string {
  const delta = direction === "lower" ? baseline - metric : metric - baseline;
  const sign = delta > 0 ? "+" : "";
  const pct = baseline !== 0 ? ` (${((delta / baseline) * 100).toFixed(0)}%)` : "";
  return `${sign}${delta.toFixed(1)}${pct}`;
}

/**
 * Truncate a hypothesis label for tree display.
 */
function truncateLabel(label: string | null, maxLen = 30): string {
  if (!label) return "";
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 1) + "…";
}

/**
 * Render a single node line.
 */
function renderNodeLine(
  node: TreeNode,
  tree: ExperimentTree,
  indent: string,
  isLast: boolean,
  isBest: boolean,
  isActive: boolean,
  isRoot: boolean = false,
): string {
  const prefix = isRoot ? "" : indent + (isLast ? SYMBOLS.lastBranch : SYMBOLS.branch);
  const icon = node.nodeType === "compose" ? STATUS_ICONS.compose
    : node.nodeType === "hypothesis" ? (STATUS_ICONS[node.status] || "◇")
    : (STATUS_ICONS[node.status] || "?");
  const metric = formatMetric(node.metric, tree.metricName?.replace("time_", "").replace("_us", "µs") || "");
  const label = node.nodeType === "baseline" ? "baseline" : `"${truncateLabel(node.hypothesisLabel || node.hypothesis)}"`;
  const status = node.status;
  const delta = node.nodeType === "baseline" ? "" : deltaString(node.metric, tree.baselineMetric, tree.direction);

  let line = `${prefix}${node.id}  ${metric.padStart(8)}  ${icon}  ${label.padEnd(32)} ${status.padEnd(8)}`;
  if (delta) line += ` ${delta}`;
  if (isActive) line += SYMBOLS.active;
  if (isBest) line += SYMBOLS.best;

  return line;
}

/**
 * Find the best node in the tree (best metric in the desired direction).
 */
export function findBestNodeId(tree: ExperimentTree): string | null {
  const experimentNodes = Object.values(tree.nodes).filter(
    (n) => (n.nodeType === "experiment" || n.nodeType === "compose") && n.status === "keep",
  );
  if (experimentNodes.length === 0) return null;

  const sorted = experimentNodes.sort((a, b) =>
    tree.direction === "lower" ? a.metric - b.metric : b.metric - a.metric,
  );
  return sorted[0].id;
}

/**
 * Render the full tree as ASCII art.
 * Returns a string ready for TUI display.
 */
export function renderTree(
  tree: ExperimentTree,
  maxLines: number = 60,
  maxBranches?: number,
  nodesPerBranch?: number,
): string {
  const bestId = findBestNodeId(tree);
  const lines: string[] = [];
  const push = (s: string) => { if (lines.length < maxLines) lines.push(s); };

  // Header
  const headerUnit = tree.metricName || "";
  const direction = tree.direction === "lower" ? "lower is better" : "higher is better";
  const nodeCount = Object.keys(tree.nodes).length;
  lines.push(`🌳 Experiment Tree — "${headerUnit}" (${direction})    [/tree → List view]`);
  lines.push("━".repeat(80));
  lines.push("");

  const root = tree.nodes[tree.rootId];
  if (!root) {
    lines.push("(empty tree)");
    return lines.join("\n");
  }

  let maxDepth = 0;
  for (const node of Object.values(tree.nodes)) {
    if (node.depth > maxDepth) maxDepth = node.depth;
  }

  // Compute branch truncation when tree is large
  const effMaxBranches = maxBranches && maxBranches > 0 ? maxBranches : 0;
  const effNodesPerBranch = nodesPerBranch && nodesPerBranch > 0 ? nodesPerBranch : 0;
  const truncateBranches = effMaxBranches > 0 && root.children.length > effMaxBranches;
  const truncateDepth = effNodesPerBranch > 0;
  const recentView = truncateBranches
    ? getRecentView(tree, effMaxBranches, effNodesPerBranch)
    : null;

  if (recentView) {
    lines.push(`Nodes: ${nodeCount}  Depth: ${maxDepth}  Active: ${tree.activeNodeId}  (showing last ${root.children.slice(-effMaxBranches).length} of ${root.children.length} branches)`);
  } else {
    lines.push(`Nodes: ${nodeCount}  Depth: ${maxDepth}  Active: ${tree.activeNodeId}`);
  }
  lines.push("");

  // Consecutive discard count (for collapse heuristic)
  function countDiscards(tree: ExperimentTree, id: string): number {
    const n = tree.nodes[id];
    if (!n) return 0;
    let c = (n.status === "discard" || n.status === "crash" || n.status === "checks_failed") ? 1 : 0;
    for (const cid of n.children) c += countDiscards(tree, cid);
    return c;
  }

  // Iterative DFS stack: [nodeId, indent, isLast, isRoot, depthFromBranch]
  const stack: Array<[string, string, boolean, boolean, number]> = [[tree.rootId, "", true, true, 0]];
  let hiddenCount = 0;
  let hiddenSubtree = false;
  let hiddenBranchesLines = 0;
  let hiddenNodesInBranch = 0;

  while (stack.length > 0) {
    const [nodeId, indent, isLast, isRoot, depthFromBranch] = stack.pop()!;
    if (hiddenSubtree) { hiddenCount++; continue; }

    const node = tree.nodes[nodeId];
    if (!node) continue;

    // Collapse chains of 3+ consecutive discard/crash
    if (!isRoot && (node.status === "discard" || node.status === "crash" || node.status === "checks_failed")) {
      const totalDiscards = countDiscards(tree, nodeId);
      if (totalDiscards >= 3) {
        const remaining = lines.length < maxLines - 1;
        if (remaining) {
          const icon = STATUS_ICONS[node.status] || "?";
          const prefix = indent + (isLast ? SYMBOLS.lastBranch : SYMBOLS.branch);
          const metric = formatMetric(node.metric, "");
          push(`${prefix}${node.id}  ${metric.padStart(8)}  ${icon}  (${totalDiscards} collapsed discard nodes)`);
        }
        hiddenSubtree = true;
        continue;
      }
    }

    const isActive = node.id === tree.activeNodeId;
    const isBest = node.id === bestId;
    const line = renderNodeLine(node, tree, indent, isLast, isBest, isActive, isRoot);
    push(line);

    // Determine children to show: root-level truncation via recentView
    let children: TreeNode[];
    if (isRoot && recentView) {
      children = recentView.rootChildren.map((id) => tree.nodes[id]).filter(Boolean) as TreeNode[];
    } else {
      children = node.children.map((id) => tree.nodes[id]).filter(Boolean) as TreeNode[];
    }

    if (children.length > 0) {
      const remaining = maxLines - lines.length;

      // Nodes-per-branch limit: if root node and recentView, compute hidden sibling branches
      if (isRoot && recentView && recentView.hiddenBranches > 0) {
        const childIndent = indent + SYMBOLS.emptyIndent;
        if (remaining >= 2) {
          push(`${childIndent}${SYMBOLS.branch}(… ${recentView.hiddenBranches} older branches hidden)`);
          hiddenBranchesLines++;
        }
      }

      // Apply nodesPerBranch limit at each branch level
      if (truncateDepth && !isRoot && depthFromBranch >= effNodesPerBranch) {
        // Count how many nodes in this subtree are being hidden
        let hiddenSub = 0;
        const countSub = (id: string) => { hiddenSub++; const n = tree.nodes[id]; if (n) for (const c of n.children) countSub(c); };
        for (const ch of children) countSub(ch.id);
        hiddenNodesInBranch += hiddenSub;
        const prefix = indent + (isLast ? SYMBOLS.emptyIndent : SYMBOLS.verticalIndent);
        push(`${prefix}${SYMBOLS.lastBranch}(… ${hiddenSub} deeper nodes in this branch)`);
        continue; // don't push children
      }

      if (remaining < 2 && !isRoot) {
        // Collapse all children
        let totalKids = 0;
        const visit = (id: string) => { totalKids++; const n = tree.nodes[id]; if (n) for (const c of n.children) visit(c); };
        for (const ch of children) visit(ch.id);
        const childIndent = indent + (isLast ? SYMBOLS.emptyIndent : SYMBOLS.verticalIndent);
        push(`${childIndent}${SYMBOLS.lastBranch}(${totalKids} more nodes — use tree_detail for full view)`);
        hiddenSubtree = true;
      } else {
        for (let i = children.length - 1; i >= 0; i--) {
          const childIsLast = i === children.length - 1;
          const childIndent = indent + (isLast ? SYMBOLS.emptyIndent : SYMBOLS.verticalIndent);
          const childDepth = isRoot ? 1 : depthFromBranch + 1;
          stack.push([children[i].id, childIndent, childIsLast, false, childDepth]);
        }
      }
    }
  }

  // Footer: show collapse/truncation summary
  const footNotes: string[] = [];
  if (hiddenCount > 0) {
    footNotes.push(hiddenCount > 1
      ? `${hiddenCount} nodes hidden (collapse)`
      : `1 node hidden (collapse)`);
  }
  if (hiddenBranchesLines > 0) {
    footNotes.push(`${hiddenBranchesLines} branch${hiddenBranchesLines > 1 ? "es" : ""} hidden`);
  }
  if (hiddenNodesInBranch > 0) {
    footNotes.push(`${hiddenNodesInBranch} nodes hidden (depth limit)`);
  }
  if (footNotes.length > 0) {
    push(`  (${footNotes.join("; ")})`);
  }

  // Legend
  lines.push("");
  lines.push("─".repeat(80));
  lines.push(" ● keep   ○ discard   ✕ crash   ◆ compose   ◇ untested   ◎ running   ⊘ duplicate   ★ best   ← active");
  lines.push("─".repeat(80));

  return lines.join("\n");
}

/**
 * Render node detail view (shown when user selects a node).
 */
export function renderNodeDetail(tree: ExperimentTree, node: TreeNode): string {
  const lines: string[] = [];
  const path = getPathArray(tree, node.id);

  lines.push(`─── ${node.id} ${"─".repeat(Math.max(0, 60 - node.id.length))}`);
  lines.push(`  Hypothesis:  ${node.hypothesis}`);
  lines.push(`  Status:      ${node.status}`);
  lines.push(`  Metric:      ${formatMetric(node.metric, "")} (baseline: ${formatMetric(tree.baselineMetric, "")})`);
  if (node.commit) {
    lines.push(`  Commit:      ${node.commit}  (refs/exp/${node.id})`);
  } else {
    lines.push(`  Commit:      (ghost — code reverted)`);
  }
  lines.push(`  Depth:       ${node.depth}  (${path.join(" → ")})`);
  if (node.simhashFull) {
    lines.push(`  SimHash:     ${node.simhashFull}`);
  }
  if (node.asi) {
    const asiStr = JSON.stringify(node.asi);
    lines.push(`  ASI:         ${asiStr.length > 200 ? asiStr.slice(0, 197) + "…" : asiStr}`);
  }
  if (node.children.length > 0) {
    const childrenStr = node.children
      .map((cid) => {
        const c = tree.nodes[cid];
        return c ? `${cid} (${c.status})` : cid;
      })
      .join(", ");
    lines.push(`  Children:    ${childrenStr}`);
  }
  if (node.composedFrom && node.composedFrom.length > 0) {
    lines.push(`  Composed:    ${node.composedFrom.join(" + ")}`);
  }
  const ageMs = Date.now() - node.createdAt;
  const ageStr = formatAge(ageMs);
  lines.push(`  Created:     ${ageStr}`);
  lines.push("─".repeat(70));
  return lines.join("\n");
}

/** Format elapsed time in human-readable form. */
function formatAge(ms: number): string {
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

/** Get path from root to a node as an array of IDs. */
function getPathArray(tree: ExperimentTree, nodeId: string): string[] {
  const path: string[] = [];
  let current: string | null = nodeId;
  while (current) {
    path.unshift(current);
    const node = tree.nodes[current];
    if (!node) break;
    current = node.parentId;
  }
  return path;
}
