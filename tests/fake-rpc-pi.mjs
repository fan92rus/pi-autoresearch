#!/usr/bin/env node
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const scenario = process.env.FAKE_RPC_SCENARIO ?? "success";
const sha = scenario === "foreign-sha" ? "f".repeat(64) : (process.env.FAKE_RPC_SHA ?? "0".repeat(64));
// Drift scenarios: the agent's own draft (written to .auto/research/<id>/brief.json) is what the dialog hashes.
// transcription-drift: stage-2 draft differs from the operator brief; the adopted retry transcribes it verbatim.
// double-drift: the retry drifts again. drift-no-draft: the dialog hashes a draft that was never written.
const DRIFT = scenario === "transcription-drift" || scenario === "double-drift" || scenario === "drift-no-draft" || scenario === "drift-stale-draft";
const draftBytes = (variant) => Buffer.from(`${JSON.stringify({ schema_version: 1, goal: "test", extra_rule: variant }, null, 2)}\n`);
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
let campaignId = "unknown";
function driftDialogSha(promptNumber) {
  if (scenario === "drift-no-draft") return "f".repeat(64);
  const bytes = scenario === "double-drift" && promptNumber === 3 ? draftBytes("second") : draftBytes("first");
  const draftPath = path.join(process.cwd(), ".auto", "research", campaignId, "brief.json");
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, bytes);
  // drift-stale-draft: the draft on disk differs from the hash shown in the dialog.
  if (scenario === "drift-stale-draft") return sha256Hex(draftBytes("stale"));
  return sha256Hex(bytes);
}
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let promptCount = 0;
let reportCallId;
let awaitingConfirm = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === "abort") {
    out({ type: "abort_ack" });
    input.close();
    return;
  }
  if (request.type === "extension_ui_response") {
    if (scenario === "hold-confirm") return;
    if (awaitingConfirm) {
      awaitingConfirm = false;
      if (request.confirmed === true || (scenario === "non-brief-confirm" && request.confirmed === false)) setTimeout(() => emitReport(scenario === "bad-report"), 20);
      // A refused drift dialog ends the refused turn; the wrapper decides whether to send the retry.
      else if (DRIFT && request.confirmed === false) setTimeout(() => out({ type: "agent_settled" }), 20);
      else input.close();
    }
    return;
  }
  if (request.type !== "prompt") return;
  promptCount += 1;
  if (scenario === "crash") {
    process.exit(1);
  }

  if (scenario === "silent") return;
  if (promptCount === 1) {
    if (scenario === "no-agent-start") {
      out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
      return;
    }
    out({ type: "agent_start" });
    out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
    out({ type: "agent_settled" });
    return;
  }
  if (scenario === "stage2-queued") {
    out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "queued" } });
    return;
  }
  if (DRIFT) campaignId = /Research campaign (\S+) /.exec(request.message)?.[1] ?? campaignId;
  out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  awaitingConfirm = true;
  if (scenario === "non-brief-confirm") {
    out({ id: "dialog-1", type: "extension_ui_request", method: "confirm", message: "Continue?" });
  } else {
    const dialogSha = DRIFT ? driftDialogSha(promptCount) : sha;
    out({ id: "dialog-1", type: "extension_ui_request", method: "confirm", message: `Brief SHA-256: ${dialogSha}\nApprove?` });
  }
});

function emitReport(error = false) {
  reportCallId = "call-report";
  out({ type: "tool_execution_start", toolCallId: reportCallId, toolName: "research", args: { action: "report" } });
  out({ type: "tool_execution_end", toolCallId: reportCallId, toolName: "research", result: { details: error ? { reason: "not_approved" } : {} }, isError: false });
  out({ type: "agent_settled" });
  input.close();
}
