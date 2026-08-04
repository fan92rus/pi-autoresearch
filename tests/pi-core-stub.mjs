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

/** Truncate text to fit within maxBytes / maxLines (real implementation). */
export function truncateTail(text, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES) {
  if (typeof text !== "string") return "";
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    const removed = lines.length - maxLines;
    return `[... ${removed} lines truncated from the start ...]\n` + lines.slice(-maxLines).join("\n");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    const truncated = Buffer.from(text).subarray(Math.max(0, bytes - maxBytes)).toString("utf8");
    return `[... ${bytes - maxBytes} bytes truncated from the start ...]\n` + truncated;
  }
  return text;
}

/** Human-readable file size (real implementation). */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Return a temp agent dir (hermetic — does NOT touch real ~/.pi/agent). */
export function getAgentDir() {
  const dir = path.join(os.tmpdir(), `pi-test-agent-${process.pid}`);
  return dir;
}
