/**
 * Stub for @earendil-works/pi-tui — test process only.
 * truncateToWidth / visibleWidth / matchesKey are real (10-line) implementations;
 * Text is a minimal renderable object (PBT does not exercise render paths).
 */

/** Visible width of a string (ignores ANSI escape sequences). */
export function visibleWidth(str) {
  if (typeof str !== "string") return 0;
  // Strip ANSI escapes for width calculation
  const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.length;
}

/** Truncate string to fit within `width` visible columns. */
export function truncateToWidth(str, width) {
  if (typeof str !== "string" || str.length <= width) return str ?? "";
  if (width <= 0) return "";
  const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.length <= width) return str;
  return clean.slice(0, Math.max(0, width - 1)) + "…";
}

/** Check if a key/shortcut string matches a pressed key. Simple equality. */
export function matchesKey(pressed, binding) {
  if (typeof pressed !== "string" || typeof binding !== "string") return false;
  return pressed.toLowerCase() === binding.toLowerCase();
}

/** Minimal Text component for TUI (PBT does not exercise rendering). */
export class Text {
  constructor(content = "") {
    this.content = content;
  }
  render() {
    return this.content;
  }
  get width() {
    return visibleWidth(this.content);
  }
}
