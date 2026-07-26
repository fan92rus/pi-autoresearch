/**
 * UCB1 (Upper Confidence Bound 1) ranking for advisory node selection.
 *
 * Balances exploitation (nodes whose children showed good metric improvement)
 * and exploration (nodes with few children — underexplored). The agent sees a
 * ranked list in tree_status and decides which node to explore_from.
 *
 * Formula: UCB1 = exploitation + C * sqrt(ln(N_total) / (1 + n_node_children))
 *
 * This is advisory mode — the agent retains strategic control.
 */

import type { ExperimentTree, TreeNode } from "./tree.ts";
import type { Direction } from "./types.ts";

const DEFAULT_C = 0.5;

export interface RankedNode {
  nodeId: string;
  ucb1: number;
  exploitation: number;
  exploration: number;
  reason: string;
}

/**
 * Normalize an improvement relative to the baseline metric.
 * Returns a value in roughly [-1, 1] range.
 * Positive = good (metric improved in the desired direction).
 */
function normalizedImprovement(
  parentMetric: number,
  childMetric: number,
  direction: Direction,
  baselineMetric: number,
): number {
  if (baselineMetric === 0) return 0;
  const raw = direction === "lower" ? parentMetric - childMetric : childMetric - parentMetric;
  return raw / Math.abs(baselineMetric);
}

/**
 * Average improvement of a node's children relative to the node's own metric.
 * For leaf nodes, use the node's own improvement relative to its parent.
 */
function avgChildImprovement(tree: ExperimentTree, node: TreeNode): number {
  if (node.children.length === 0) {
    if (node.parentId === null) return 0;
    const parent = tree.nodes[node.parentId];
    if (!parent) return 0;
    return normalizedImprovement(parent.metric, node.metric, tree.direction, tree.baselineMetric);
  }
  const improvements = node.children.map((cid) => {
    const child = tree.nodes[cid];
    if (!child) return 0;
    return normalizedImprovement(node.metric, child.metric, tree.direction, tree.baselineMetric);
  });
  return improvements.reduce((a, b) => a + b, 0) / improvements.length;
}

/** Count all experiment + compose nodes (total "visits" for UCB1). */
function totalExperiments(tree: ExperimentTree): number {
  return Object.values(tree.nodes).filter(
    (n) => n.nodeType === "experiment" || n.nodeType === "compose",
  ).length;
}

/**
 * A node is expandable if it's not exhausted and has room for more children.
 * maxChildren prevents infinite branching from a single node.
 */
export function isExpandable(node: TreeNode, maxChildren = 5): boolean {
  return !node.exhausted && node.children.length < maxChildren;
}

/**
 * Rank all expandable nodes by UCB1 score.
 * Returns sorted list (highest UCB1 first).
 */
export function rankNodes(tree: ExperimentTree, c = DEFAULT_C): RankedNode[] {
  const nTotal = totalExperiments(tree);
  if (nTotal === 0) return [];

  const ranked: RankedNode[] = [];

  for (const node of Object.values(tree.nodes)) {
    if (!isExpandable(node)) continue;

    const exploitation = avgChildImprovement(tree, node);
    const visitCount = node.children.length;
    const exploration = Math.sqrt(Math.log(nTotal) / (1 + visitCount));
    const ucb1 = exploitation + c * exploration;

    let reason: string;
    if (visitCount === 0) {
      reason = "unexplored";
    } else if (exploitation > 0.05) {
      reason = `promising branch (avg +${(exploitation * 100).toFixed(1)}%)`;
    } else if (exploration > 0.8) {
      reason = "underexplored";
    } else {
      reason = "neutral";
    }

    ranked.push({ nodeId: node.id, ucb1, exploitation, exploration, reason });
  }

  ranked.sort((a, b) => b.ucb1 - a.ucb1);
  return ranked;
}

/**
 * Get the UCB1 constant from config (falls back to default).
 */
export function getUcb1C(configValue: unknown): number {
  if (typeof configValue === "number" && configValue > 0 && configValue < 5) {
    return configValue;
  }
  return DEFAULT_C;
}
