// Test fixture helper (not a test file): approves the ordinary-loop brief for a session the test
// starts directly with init_experiment. It uses the same module as the real optimize_brief tool,
// so the approval bytes and the SHA binding are the production ones. Openspec: optimize-two-phase-start.
import * as fs from "node:fs";
import * as path from "node:path";
import * as ob from "../extensions/pi-autoresearch/optimize-brief.ts";

export function approveOptimizeBrief(cwd, params) {
  const brief = { name: params.name, metric_name: params.metric_name };
  if (params.metric_unit !== undefined) brief.metric_unit = params.metric_unit;
  if (params.direction !== undefined) brief.direction = params.direction;
  if (params.cwd !== undefined) brief.cwd = params.cwd;
  const dir = ob.optimizeDirOf(cwd);
  const draft = ob.writeOptimizeBriefDraft(dir, brief);
  if (!draft.ok) throw new Error(`approve fixture: ${draft.errors.join("; ")}`);
  ob.writeOptimizeApproval(dir, true, draft.sha256);
}

/** Marks a fixture session as started: a config header in the ledger (the run/log gate checks only its presence). */
export function markSessionStarted(cwd) {
  const logPath = path.join(cwd, ".auto", "log.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, JSON.stringify({ type: "config", name: "bench", metricName: "ms", bestDirection: "lower" }) + "\n", "utf-8");
  }
}
