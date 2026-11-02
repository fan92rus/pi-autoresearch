/**
 * Stub for @earendil-works/pi-coding-agent — test process only.
 *
 * Real implementations of truncateTail and formatSize (they're used in real
 * code paths that PBT exercises); getAgentDir returns a temp dir for hermetic
 * tests; type-only exports are erased by strip-types and need no stub.
 */

import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2000;

/**
 * truncateTail aligned with the REAL TruncationResult API as used by this
 * extension: object options in, { content, truncated, truncatedBy, totalLines,
 * totalBytes, outputLines, outputBytes } out. The production type also has
 * lastLinePartial / firstLineExceedsLimit / maxLines / maxBytes (unused here)
 * and never splits a line mid-bytes — this stub may cut at a byte boundary,
 * which no current test observes.
 */
export function truncateTail(text, options = {}) {
  if (typeof text !== "string") {
    return { content: "", truncated: false, truncatedBy: null, totalLines: 0, totalBytes: 0, outputLines: 0, outputBytes: 0 };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf8");
  let content = text;
  let truncated = false;
  let truncatedBy = null;
  if (totalLines > maxLines) {
    const removed = totalLines - maxLines;
    truncated = true;
    truncatedBy = "lines";
    content = `[... ${removed} lines truncated from the start ...]\n` + lines.slice(-maxLines).join("\n");
  }
  let outputBytes = Buffer.byteLength(content, "utf8");
  if (outputBytes > maxBytes) {
    truncated = true;
    truncatedBy = truncatedBy ?? "bytes";
    content = `[... ${outputBytes - maxBytes} bytes truncated from the start ...]\n` + Buffer.from(content).subarray(Math.max(0, outputBytes - maxBytes)).toString("utf8");
    outputBytes = Buffer.byteLength(content, "utf8");
  }
  const outputLines = content.split("\n").length;
  return { content, truncated, truncatedBy, totalLines, totalBytes, outputLines, outputBytes };
}

/** Human-readable file size (real implementation). */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Return a temp agent dir (hermetic — does NOT touch real ~/.pi/agent). */
export function getAgentDir() {
  // Honour the same env override as the real pi so tests can point the
  // extension at a scratch agent dir (see withAgentDir in shortcuts.test.mjs).
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return fromEnv;
  const dir = path.join(os.tmpdir(), `pi-test-agent-${process.pid}`);
  return dir;
}
