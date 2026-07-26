/**
 * Persistent Experiment Tree — data model and storage.
 *
 * Each experiment (keep/discard/crash) becomes a node in a tree. The tree
 * captures parent→child relationships, enabling backtracking (explore_from),
 * repeat detection (via simhash), and composition (combining diffs from
 * different branches).
 *
 * tree.json is an OPTIONAL overlay on top of log.jsonl:
 *  - If it doesn't exist, the system works exactly as before (zero migration).
 *  - init_experiment creates the root node; log_experiment creates children.
 *  - log.jsonl stays the canonical flat log (unchanged).
 *
 * Storage: .auto/tree.json (atomic write via temp+rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Direction } from "./types.ts";
import { computeSimhash } from "./simhash.ts";

// ── Path ───────────────────────────────────────────────────────────────────

const TREE_FILE = path.join(".auto", "tree.json");

/** Resolve the tree.json path for a working directory. */
export function treeFilePath(workDir: string): string {
  return path.join(workDir, TREE_FILE);
}

/** Does a tree.json already exist for this work directory? */
export function treeExists(workDir: string): boolean {
  return fs.existsSync(treeFilePath(workDir));
}

// ── Types ──────────────────────────────────────────────────────────────────

export type TreeNodeStatus = "baseline" | "keep" | "discard" | "crash" | "checks_failed";

export type TreeNodeType = "baseline" | "experiment" | "compose";

export interface TreeNode {
  /** Unique node ID (e.g. "n0", "n1", ...). */
  id: string;
  /** Parent node ID, null for the root (baseline). */
  parentId: string | null;
  /** Child node IDs, in chronological order. */
  children: string[];
  /** Git commit SHA (short, 7 chars). Null for discard/crash (code was reverted). */
  commit: string | null;
  /** Metric value at this node. */
  metric: number;
  /** Full hypothesis / description text. */
  hypothesis: string;
  /** Short label extracted from hypothesis (first clause before — or : ). */
  hypothesisLabel: string | null;
  /** Outcome status. */
  status: TreeNodeStatus;
  /** Actionable Side Information from log_experiment. */
  asi: Record<string, unknown> | null;
  /** SimHash of hypothesisLabel (16-char hex), or null for baseline/compose. */
  simhashLabel: string | null;
  /** SimHash of full hypothesis text (16-char hex), or null. */
  simhashFull: string | null;
  /** Backlog idea_id from ASI (if the agent tracks ideas). */
  ideaId: string | null;
  /** Depth from root (0 = baseline). */
  depth: number;
  /** Unix timestamp (ms) when the node was created. */
  createdAt: number;
  /** True when the branch is marked exhausted (≥3 consecutive discards). */
  exhausted: boolean;
  /** What kind of node this is. */
  nodeType: TreeNodeType;
  /** Reference to the run # in log.jsonl (1-based), for experiment nodes. */
  runRef?: number;
  /** For compose nodes: the source node IDs that were combined. */
  composedFrom?: string[];
  /** True if the commit has been garbage-collected (ghost node). */
  gc?: boolean;
}

export interface ExperimentTree {
  /** Schema version (currently 1). */
  version: 1;
  /** Root node ID (the baseline). */
  rootId: string;
  /** Node the agent is currently working from. */
  activeNodeId: string;
  /** Counter for generating the next node ID. */
  nextId: number;
  /** Baseline metric value (from the root node). */
  baselineMetric: number;
  /** Optimization direction. */
  direction: Direction;
  /** Metric name. */
  metricName: string;
  /** All nodes keyed by ID. */
  nodes: Record<string, TreeNode>;
  /** Saved branch name before explore_from detached HEAD (null = on main). */
  savedBranch?: string | null;
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Load the tree from .auto/tree.json.
 * Returns null if the file does not exist.
 */
export function loadTree(workDir: string): ExperimentTree | null {
  const filePath = treeFilePath(workDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ExperimentTree;
    if (!parsed || typeof parsed !== "object" || !parsed.nodes) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save the tree to .auto/tree.json atomically (write temp, then rename).
 * This prevents corruption if the process is killed mid-write.
 */
export function saveTree(workDir: string, tree: ExperimentTree): void {
  const filePath = treeFilePath(workDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: temp file in the same directory, then rename.
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(tree, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ── Node creation helpers ──────────────────────────────────────────────────

/**
 * Extract a short label from a hypothesis string.
 * Takes the text up to the first "—" (em dash), "—" (en dash), ":" or newline,
 * trimmed to 60 chars. Returns null for empty input.
 */
export function extractLabel(hypothesis: string): string | null {
  if (!hypothesis || !hypothesis.trim()) return null;
  const separators = /[—–:\n]/;
  const first = hypothesis.split(separators)[0].trim();
  if (!first) return null;
  return first.length > 60 ? first.slice(0, 57) + "..." : first;
}

/**
 * Create the root (baseline) node for a new tree.
 */
export function createRootNode(
  nodeId: string,
  commit: string,
  metric: number,
): TreeNode {
  return {
    id: nodeId,
    parentId: null,
    children: [],
    commit,
    metric,
    hypothesis: "baseline",
    hypothesisLabel: null,
    status: "baseline",
    asi: null,
    simhashLabel: null,
    simhashFull: null,
    ideaId: null,
    depth: 0,
    createdAt: Date.now(),
    exhausted: false,
    nodeType: "baseline",
  };
}

/**
 * Create an experiment node (child of activeNode).
 */
export function createExperimentNode(
  nodeId: string,
  parentId: string,
  parentDepth: number,
  commit: string | null,
  metric: number,
  hypothesis: string,
  status: TreeNodeStatus,
  asi: Record<string, unknown> | null,
  runRef?: number,
): TreeNode {
  const label = extractLabel(hypothesis);
  const ideaId = asi && typeof asi.idea_id === "string" ? asi.idea_id : null;

  return {
    id: nodeId,
    parentId,
    children: [],
    commit,
    metric,
    hypothesis,
    hypothesisLabel: label,
    status,
    asi,
    simhashLabel: label ? computeSimhash(label) : null,
    simhashFull: computeSimhash(hypothesis),
    ideaId,
    depth: parentDepth + 1,
    createdAt: Date.now(),
    exhausted: false,
    nodeType: "experiment",
    runRef,
  };
}

// ── Tree traversal helpers ─────────────────────────────────────────────────

/**
 * Get the path from root to a node (inclusive), as an array of node IDs.
 * Returns [] if the node is not found.
 */
export function getPath(tree: ExperimentTree, nodeId: string): string[] {
  const path: string[] = [];
  let current: string | null = nodeId;
  const guard = new Set<string>();
  while (current && tree.nodes[current] && !guard.has(current)) {
    guard.add(current);
    path.unshift(current);
    current = tree.nodes[current].parentId;
  }
  return path;
}

/**
 * Get all children of a node (TreeNode objects).
 */
export function getChildren(tree: ExperimentTree, nodeId: string): TreeNode[] {
  const node = tree.nodes[nodeId];
  if (!node) return [];
  return node.children
    .map((id) => tree.nodes[id])
    .filter((n): n is TreeNode => n !== undefined);
}

/**
 * Find the best (keep) node in the entire tree by metric.
 * Respects direction (lower or higher is better).
 */
export function findBestNode(tree: ExperimentTree): TreeNode | null {
  const candidates = Object.values(tree.nodes).filter(
    (n) => n.status === "keep" || n.status === "baseline",
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, n) => {
    const isBetter =
      tree.direction === "lower" ? n.metric < best.metric : n.metric > best.metric;
    return isBetter ? n : best;
  });
}

/**
 * Check if a node's children indicate an exhausted branch:
 * the last 3 children are all discard/crash/checks_failed.
 * Mutates node.exhausted in place if exhausted.
 */
export function checkExhausted(tree: ExperimentTree, nodeId: string): boolean {
  const node = tree.nodes[nodeId];
  if (!node) return false;
  if (node.exhausted) return true;

  const children = getChildren(tree, nodeId);
  if (children.length < 3) return false;

  const recent = children.slice(-3);
  const allBad = recent.every(
    (c) => c.status === "discard" || c.status === "crash" || c.status === "checks_failed",
  );
  if (allBad) {
    node.exhausted = true;
    return true;
  }
  return false;
}

/**
 * Append a child node to a parent and update the tree structure.
 * Does NOT save to disk — caller must saveTree().
 */
export function appendChild(
  tree: ExperimentTree,
  parentId: string,
  child: TreeNode,
): void {
  const parent = tree.nodes[parentId];
  if (!parent) throw new Error(`Parent node ${parentId} not found`);
  parent.children.push(child.id);
  tree.nodes[child.id] = child;
}

/**
 * Generate the next node ID and increment the counter.
 */
export function nextNodeId(tree: ExperimentTree): string {
  const id = `n${tree.nextId}`;
  tree.nextId++;
  return id;
}
