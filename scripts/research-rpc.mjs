#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DIALOG_SHA_RE = /^Brief SHA-256: ([0-9a-f]{64})/m;
const DEFAULT_TIMEOUT = 3600;
const DEFAULT_STAGE1_TIMEOUT = 30;
const SHUTDOWN_GRACE_MS = 10_000;

export function resolvePiExecutable(piPath, platform = process.platform, env = process.env) {
  if (platform !== "win32" || path.win32.extname(piPath)) return piPath;
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const directories = (env.PATH ?? "").split(path.win32.delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${piPath}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return piPath;
}

function piLaunch(piPath, platform = process.platform) {
  if (/\.m?js$/i.test(piPath)) return { command: process.execPath, args: [piPath, "--mode", "rpc"] };
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(piPath)) {
    const command = process.env.ComSpec ?? "cmd.exe";
    // The resolved executable path comes from PATH, not user-supplied shell input.
    // verbatim: node must NOT re-quote args — /s /c already carries the quoting;
    // re-escaping breaks the command line ("The filename... is incorrect").
    return { command, args: ["/d", "/s", "/c", `""${piPath}" --mode rpc"`], verbatim: true };
  }
  return { command: piPath, args: ["--mode", "rpc"] };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "help") { args.help = true; continue; }
    if (args[key] !== undefined) throw new Error(`Duplicate option: --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  if (args.help) return args;
  if (args.mode === "optimize") {
    // Optimize is an explicit scope split for this MVP; see the headless-launch change.
    throw new Error("optimize mode is not implemented in this MVP build (documented scope split; see openspec/changes/headless-launch)");
  }
  if (args.mode !== "research") throw new Error("--mode research is required");
  if (!args.brief) throw new Error("--brief is required");
  if (!args["approve-sha"]) throw new Error("--approve-sha is required");
  if (!SHA_RE.test(args["approve-sha"])) throw new Error("--approve-sha must be 64 lowercase hexadecimal characters");
  if (args["campaign-id"] !== undefined && !ID_RE.test(args["campaign-id"])) throw new Error("Invalid --campaign-id");
  for (const key of ["timeout-sec", "stage1-timeout-sec", "hold-dialog-ms"]) {
    if (args[key] !== undefined && (!/^\d+(?:\.\d+)?$/.test(args[key]) || Number(args[key]) <= 0 && key !== "hold-dialog-ms")) {
      throw new Error(`Invalid --${key}`);
    }
  }
  if (args["hold-dialog-ms"] !== undefined && !/^\d+(?:\.\d+)?$/.test(args["hold-dialog-ms"])) throw new Error("Invalid --hold-dialog-ms");
  return args;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonLine(value) { return `${JSON.stringify(value)}\n`; }
function usage() { return "Usage: node scripts/research-rpc.mjs --mode research --brief <canonical.json> --approve-sha <sha256> [--campaign-id <id>] [--pi <path>] [--cwd <dir>] [--timeout-sec 3600] [--stage1-timeout-sec 30] [--hold-dialog-ms 0] [--log <path>]"; }

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n${usage()}`); return 2; }
  if (args.help) { console.log(usage()); return 0; }

  const cwd = path.resolve(args.cwd ?? process.cwd());
  const briefPath = path.resolve(cwd, args.brief);
  let briefBytes;
  try {
    briefBytes = fs.readFileSync(briefPath);
    const text = briefBytes.toString("utf8");
    const parsed = JSON.parse(text);
    const canonical = `${JSON.stringify(parsed, null, 2)}\n`;
    if (text !== canonical) throw new Error("Brief is not canonical JSON");
  } catch (error) {
    console.error(`Invalid --brief: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const campaignId = args["campaign-id"] ?? `bench-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
  if (!ID_RE.test(campaignId)) { console.error("Generated campaign id is invalid"); return 2; }
  const approveSha = args["approve-sha"];
  const timeoutMs = Number(args["timeout-sec"] ?? DEFAULT_TIMEOUT) * 1000;
  const stage1TimeoutMs = Number(args["stage1-timeout-sec"] ?? DEFAULT_STAGE1_TIMEOUT) * 1000;
  const holdDialogMs = Number(args["hold-dialog-ms"] ?? 0);
  const configuredPi = args.pi ?? "pi";
  const piPath = resolvePiExecutable(configuredPi);
  // Default log is stored alongside campaign data in the target workspace.
  const logPath = path.resolve(cwd, args.log ?? path.join(".auto", `research-rpc-${campaignId}.log.jsonl`));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: "w", encoding: "utf8" });
  const logEvent = (direction, record) => {
    log.write(jsonLine({ ts: new Date().toISOString(), direction, record }));
  };

  const launch = piLaunch(piPath);
  const child = spawn(launch.command, launch.args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "inherit"], windowsVerbatimArguments: launch.verbatim === true });
  let exitCode = 3;
  let finished = false;
  let stage1Started = false;
  let stage1Settled = false;
  let stage2Sent = false;
  let reportStarted = new Map();
  let successfulReport = false;
  let pendingDialogs = new Set();
  let currentPrompt = null;
  let stage1Timer = null;
  let wholeTimer = null;
  let killTimer = null;
  let requestCounter = 0;
  let stdoutBuffer = "";

  child.stdin.on("error", (error) => {
    logEvent("wrapper", { event: "stdin_error", message: error.message });
  });

  const send = (record) => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      logEvent("to_pi", record);
      child.stdin.write(jsonLine(record));
    }
  };
  const requestPrompt = (message, stage) => {
    const id = `research-rpc-${++requestCounter}`;
    currentPrompt = { id, stage };
    send({ id, type: "prompt", message });
  };
  const stopChild = async (code, reason, abort = false) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    if (stage1Timer) clearTimeout(stage1Timer);
    if (wholeTimer) clearTimeout(wholeTimer);
    if (abort) {
      send({ id: `research-rpc-${++requestCounter}`, type: "abort", message: reason });
    }
    try { child.stdin.end(); } catch { /* already closed */ }
    if (child.exitCode === null && !child.killed) {
      killTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.unref();
        } else {
          child.kill("SIGKILL");
        }
      }, SHUTDOWN_GRACE_MS);
      killTimer.unref?.();
    }
  };
  const closeLog = () => new Promise((resolve) => log.end(resolve));

  child.on("error", (error) => {
    logEvent("wrapper", { event: "spawn_error", message: error.message });
    void stopChild(2, `spawn_error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (!finished) {
      logEvent("wrapper", { event: "pi_exited", code, signal });
      if (successfulReport && stage1Settled) exitCode = 0;
      else exitCode = 3;
      finished = true;
      if (stage1Timer) clearTimeout(stage1Timer);
      if (wholeTimer) clearTimeout(wholeTimer);
    }
    if (killTimer) clearTimeout(killTimer);
  });

  const handleRecord = async (record) => {
    logEvent("from_pi", record);
    if (finished) return;
    if (record.type === "response" && record.command === "prompt" && record.id === currentPrompt?.id) {
      const stage = currentPrompt.stage;
      currentPrompt = null;
      if (record.success !== true) {
        await stopChild(stage === 1 ? 2 : 1, `stage_${stage}_prompt_rejected`);
        return;
      }
      const disposition = record.data?.disposition;
      if (stage === 1 && disposition === "queued") {
        await stopChild(2, "stage_1_prompt_queued");
      } else if (stage === 2 && disposition === "queued") {
        await stopChild(1, "stage_2_prompt_queued");
      }
      return;
    }
    if (record.type === "agent_start") {
      if (!stage1Started) {
        stage1Started = true;
        if (stage1Timer) clearTimeout(stage1Timer);
      }
      return;
    }
    if (record.type === "agent_settled") {
      if (!stage1Started) return;
      if (!stage1Settled) {
        stage1Settled = true;
        if (!stage2Sent) {
          stage2Sent = true;
          const briefHash = sha256(briefBytes);
          const message = [
            `Research campaign ${campaignId}.`,
            `Brief file: ${briefPath}`,
            `Brief SHA-256: ${briefHash}`,
            "Create the campaign with research_brief draft from this file, then research_brief propose.",
            "After approval of the Brief SHA-256 dialog, run research start, open each question, record evidence, close each question, then research stop and research report.",
          ].join("\n");
          requestPrompt(message, 2);
        }
      } else if (successfulReport) {
        await stopChild(0, "successful_report");
      }
      return;
    }
    if (record.type === "tool_execution_start" && record.toolName === "research" && record.args?.action === "report") {
      const callId = record.toolCallId ?? record.callId ?? record.id;
      if (callId !== undefined) reportStarted.set(String(callId), true);
      return;
    }
    if (record.type === "tool_execution_end") {
      const callId = record.toolCallId ?? record.callId ?? record.id;
      const result = record.result;
      const details = record.details ?? result?.details;
      const action = record.args?.action ?? result?.details?.action;
      const toolName = record.toolName ?? result?.toolName;
      const wasReport = (callId !== undefined && reportStarted.has(String(callId))) || (toolName === "research" && action === "report");
      if (wasReport && record.isError !== true && !details?.reason) successfulReport = true;
      return;
    }
    if (record.type === "extension_ui_request") {
      if (record.method === "confirm") {
        const dialogId = record.id;
        pendingDialogs.add(dialogId);
        const message = String(record.message ?? "");
        const shaMatch = DIALOG_SHA_RE.exec(message);
        if (!shaMatch) {
          send({ type: "extension_ui_response", id: dialogId, confirmed: false });
          pendingDialogs.delete(dialogId);
          logEvent("wrapper", { event: "dialog_refused", reason: "not_brief_confirm", id: dialogId });
          return;
        }
        if (holdDialogMs > 0) await new Promise((resolve) => setTimeout(resolve, holdDialogMs));
        if (finished) return;
        let currentFileHash;
        try { currentFileHash = sha256(fs.readFileSync(briefPath)); } catch { currentFileHash = null; }
        const confirmed = shaMatch[1] === approveSha && shaMatch[1] === currentFileHash;
        send({ type: "extension_ui_response", id: dialogId, confirmed });
        pendingDialogs.delete(dialogId);
        logEvent("wrapper", { event: "brief_confirmation", id: dialogId, confirmed, dialog_sha: shaMatch[1], file_readable: currentFileHash !== null });
        if (!confirmed) await stopChild(1, "brief_hash_mismatch", true);
        return;
      }
      if (["select", "input", "editor"].includes(record.method)) {
        send({ type: "extension_ui_response", id: record.id, cancelled: true });
        logEvent("wrapper", { event: "dialog_cancelled", method: record.method, id: record.id });
      } else {
        logEvent("wrapper", { event: "ui_notification", method: record.method, id: record.id });
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { logEvent("wrapper", { event: "invalid_jsonl", line }); continue; }
      void handleRecord(record).catch((error) => stopChild(1, `handler_error: ${error.message}`));
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.length) logEvent("wrapper", { event: "unterminated_stdout", text: stdoutBuffer });
  });

  const startTime = Date.now();
  wholeTimer = setTimeout(() => {
    if (finished) return;
    for (const id of pendingDialogs) {
      send({ type: "extension_ui_response", id, confirmed: false });
      logEvent("wrapper", { event: "timeout_dialog_refused", id });
    }
    pendingDialogs.clear();
    logEvent("wrapper", { event: "timeout", elapsed_ms: Date.now() - startTime });
    void stopChild(3, "timeout");
  }, timeoutMs);
  stage1Timer = setTimeout(() => {
    if (!stage1Started && !finished) {
      logEvent("wrapper", { event: "stage1_timeout", timeout_ms: stage1TimeoutMs });
      void stopChild(2, "stage1_no_agent_start");
    }
  }, stage1TimeoutMs);

  requestPrompt("/autoresearch research", 1);
  const resultCode = await new Promise((resolve) => child.on("close", () => resolve(exitCode)));
  if (killTimer) clearTimeout(killTimer);
  await closeLog();
  return resultCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
