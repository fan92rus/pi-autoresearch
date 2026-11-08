#!/usr/bin/env node
import * as readline from "node:readline";

const scenario = process.env.FAKE_RPC_SCENARIO ?? "success";
const sha = scenario === "foreign-sha" ? "f".repeat(64) : (process.env.FAKE_RPC_SHA ?? "0".repeat(64));
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
  out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  awaitingConfirm = true;
  if (scenario === "non-brief-confirm") {
    out({ id: "dialog-1", type: "extension_ui_request", method: "confirm", message: "Continue?" });
  } else {
    out({ id: "dialog-1", type: "extension_ui_request", method: "confirm", message: `Brief SHA-256: ${sha}\nApprove?` });
  }
});

function emitReport(error = false) {
  reportCallId = "call-report";
  out({ type: "tool_execution_start", toolCallId: reportCallId, toolName: "research", args: { action: "report" } });
  out({ type: "tool_execution_end", toolCallId: reportCallId, toolName: "research", result: { details: error ? { reason: "not_approved" } : {} }, isError: false });
  out({ type: "agent_settled" });
  input.close();
}
