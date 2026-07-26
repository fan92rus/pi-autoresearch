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
  exhausted: " ☒",
} as const;

const STATUS_ICONS: Record<string, string> = {
  baseline: "◯",
  keep: "●",
  discard: "○",
  crash: "✕",
  checks_failed: "⚠",
  compose: "◆",
};

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
  const icon = node.nodeType === "compose" ? STATUS_ICONS.compose : (STATUS_ICONS[node.status] || "?");
  const metric = formatMetric(node.metric, tree.metricName?.replace("time_", "").replace("_us", "µs") || "");
  const label = node.nodeType === "baseline" ? "baseline" : `"${truncateLabel(node.hypothesisLabel || node.hypothesis)}"`;
  const status = node.status;
  const delta = node.nodeType === "baseline" ? "" : deltaString(node.metric, tree.baselineMetric, tree.direction);

  let line = `${prefix}${node.id}  ${metric.padStart(8)}  ${icon}  ${label.padEnd(32)} ${status.padEnd(8)}`;
  if (delta) line += ` ${delta}`;
  if (node.exhausted) line += SYMBOLS.exhausted;
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
export function renderTree(tree: ExperimentTree): string {
  const bestId = findBestNodeId(tree);
  const lines: string[] = [];

  // Header
  const headerUnit = tree.metricName || "";
  const direction = tree.direction === "lower" ? "lower is better" : "higher is better";
  const nodeCount = Object.keys(tree.nodes).length;
  lines.push(`🌳 Experiment Tree — "${headerUnit}" (${direction})    [Tab → List view]`);
  lines.push("━".repeat(80));
  lines.push("");

  // Render tree recursively starting from root
  const root = tree.nodes[tree.rootId];
  if (!root) {
    lines.push("(empty tree)");
    return lines.join("\n");
  }

  // Calculate max depth for tree shape
  let maxDepth = 0;
  for (const node of Object.values(tree.nodes)) {
    if (node.depth > maxDepth) maxDepth = node.depth;
  }
  lines.push(`Nodes: ${nodeCount}  Depth: ${maxDepth}  Active: ${tree.activeNodeId}`);
  lines.push("");

  function renderNode(node: TreeNode, indent: string, isLast: boolean) {
    const isActive = node.id === tree.activeNodeId;
    const isBest = node.id === bestId;
    lines.push(renderNodeLine(node, tree, indent, isLast, isBest, isActive));

    const children = node.children.map((id) => tree.nodes[id]).filter(Boolean);
    children.forEach((child, i) => {
      const childIsLast = i === children.length - 1;
      const childIndent = indent + (isLast ? SYMBOLS.emptyIndent : SYMBOLS.verticalIndent);
      renderNode(child, childIndent, childIsLast);
    });
  }

  // Root has no tree prefix (it's the top of the tree)
  const isActiveRoot = root.id === tree.activeNodeId;
  const isBestRoot = root.id === bestId;
  lines.push(renderNodeLine(root, tree, "", true, isBestRoot, isActiveRoot, true));

  const rootChildren = root.children.map((id) => tree.nodes[id]).filter(Boolean);
  rootChildren.forEach((child, i) => {
    const childIsLast = i === rootChildren.length - 1;
    renderNode(child, "", childIsLast);
  });

  // Legend
  lines.push("");
  lines.push("─".repeat(80));
  lines.push(" ● keep   ○ discard   ✕ crash   ◆ compose   ★ best   ← active   ☒ exhausted");
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
