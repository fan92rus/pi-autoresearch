#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DIALOG_SHA_RE = /^Brief SHA-256: ([0-9a-f]{64})/m;
export const EXPEDITION_DIALOG_RE = /^Expedition SHA-256: ([0-9a-f]{64})/m;
// Charter dialogs are recognized by their own anchor (research-charter spec).
// No multiline flag: the anchor must be the FIRST line of the message, so a
// Charter line inside a brief dialog can never reclassify it.
export const CHARTER_DIALOG_RE = /^Charter SHA-256: ([0-9a-f]{64})/;
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

export { DIALOG_SHA_RE };

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
    if (key === "auto-adopt-draft") { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  const KNOWN = new Set(["help", "mode", "brief", "approve-sha", "campaign-id", "state-root", "pi", "cwd", "timeout-sec", "stage1-timeout-sec", "hold-dialog-ms", "auto-adopt-draft", "log", "charter", "approve-charter-sha", "expedition-doc", "approve-expedition-sha"]);
  for (const key of Object.keys(args)) {
    if (!KNOWN.has(key)) throw new Error(`Unknown option: --${key} (typos silently become part of the campaign description otherwise)`);
  }
  if (args.help) return args;
  // research-charter: the two charter options are mutually required and the
  // expected hash must be well-formed; both checks run here, BEFORE pi spawns,
  // so a bad launch never creates campaign or chain state.
  const hasCharter = args.charter !== undefined;
  const hasCharterSha = args["approve-charter-sha"] !== undefined;
  if (hasCharter !== hasCharterSha) throw new Error("--charter and --approve-charter-sha are mutually required; pass both or neither");
  if (hasCharter && (typeof args.charter !== "string" || args.charter.trim() === "")) throw new Error("--charter must be a non-empty path");
  if (hasCharter && !SHA_RE.test(args["approve-charter-sha"])) throw new Error("--approve-charter-sha must be 64 lowercase hexadecimal characters");
  if (args.mode === "optimize") {
    // Optimize is an explicit scope split for this MVP; see the headless-launch change.
    throw new Error("optimize mode is not implemented in this MVP build (documented scope split; see openspec/changes/headless-launch)");
  }
  const hasExpedition = args["expedition-doc"] !== undefined;
  const hasExpeditionSha = args["approve-expedition-sha"] !== undefined;
  if (hasExpedition !== hasExpeditionSha) throw new Error("--expedition-doc and --approve-expedition-sha are mutually required; pass both or neither");
  if (hasExpedition && (hasCharter || args.brief !== undefined || args["approve-sha"] !== undefined)) throw new Error("--expedition-doc excludes --charter, --brief, and --approve-sha");
  if (hasExpedition && (args["expedition-doc"].trim() === "" || !SHA_RE.test(args["approve-expedition-sha"]))) throw new Error("Invalid expedition document path or hash");
  if (args.mode !== "research") throw new Error("--mode research is required");
  if (!hasExpedition) {
    if (!args.brief) throw new Error("--brief is required");
    if (!args["approve-sha"]) throw new Error("--approve-sha is required");
    if (!SHA_RE.test(args["approve-sha"])) throw new Error("--approve-sha must be 64 lowercase hexadecimal characters");
  }
  if (args["campaign-id"] !== undefined && !ID_RE.test(args["campaign-id"])) throw new Error("Invalid --campaign-id");
  if (args["state-root"] !== undefined && (typeof args["state-root"] !== "string" || args["state-root"].trim() === "")) throw new Error("Invalid --state-root");
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
function usage() { return "Usage: node scripts/research-rpc.mjs --mode research (--brief <canonical.json> --approve-sha <sha256> | --expedition-doc <canonical.json> --approve-expedition-sha <sha256>) [--campaign-id <id>] [--state-root <dir>] [--charter <path> --approve-charter-sha <sha256>] [--pi <path>] [--cwd <dir>] [--timeout-sec 3600] [--stage1-timeout-sec 30] [--hold-dialog-ms 0] [--auto-adopt-draft] [--log <path>]"; }

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n${usage()}`); return 2; }
  if (args.help) { console.log(usage()); return 0; }

  const cwd = path.resolve(args.cwd ?? process.cwd());
  let briefPath = args.brief ? path.resolve(cwd, args.brief) : null;
  let briefBytes;
  let expeditionPath = null;
  if (args["expedition-doc"] !== undefined) {
    expeditionPath = path.resolve(cwd, args["expedition-doc"]);
    try {
      const bytes = fs.readFileSync(expeditionPath);
      const text = bytes.toString("utf8");
      if (text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`) throw new Error("Expedition document is not canonical JSON");
    } catch (error) {
      console.error(`Invalid --expedition-doc: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  } else {
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
  }

  const campaignId = args["campaign-id"] ?? `bench-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
  if (!ID_RE.test(campaignId)) { console.error("Generated campaign id is invalid"); return 2; }
  let approveSha = args["approve-sha"];
  // research-charter mode: when a charter is supplied, the wrapper owns the
  // chain dialog (confirmed from --approve-charter-sha) and the chain lifecycle
  // (intermediate reports do not end the run; awaiting_child pauses exit 0).
  const charterSha = args["approve-charter-sha"];
  const charterMode = charterSha !== undefined;
  const expeditionMode = args["approve-expedition-sha"] !== undefined;
  const expeditionSha = args["approve-expedition-sha"];
  let expeditionConfirmed = false;
  const chainConfirmed = () => (charterMode && charterConfirmed) || (expeditionMode && expeditionConfirmed);
  const charterPath = charterMode ? path.resolve(cwd, args.charter) : null;
  let charterConfirmed = false;
  // One continuation per awaiting_child period: the flag is raised when the
  // continuation is sent and cleared only when a NEW brief action is observed
  // (a new research_brief draft), so a second marker settle without any agent
  // action pauses the run instead of looping (fix review B1).
  let continuationSentForAwaiting = false;
  let briefActionSeenSinceContinuation = false;
  const autoAdopt = args["auto-adopt-draft"] === true;
  // Auto-adopt state: none -> pending (first refusal, draft captured) -> applied (retry sent) or exhausted by a second refusal.
  let adoptState = "none";
  let adoptCandidate = null;
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

  const readAdoptCandidate = (dialogSha) => {
    const draftPath = path.join(cwd, ".auto", "research", campaignId, "brief.json");
    let bytes;
    try { bytes = fs.readFileSync(draftPath); } catch { return { ok: false, reason: "draft_missing" }; }
    const digest = sha256(bytes);
    // Adopt only the exact draft the operator dialog displayed.
    if (digest !== dialogSha) return { ok: false, reason: "draft_sha_differs_from_dialog" };
    const text = bytes.toString("utf8");
    try {
      if (text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`) return { ok: false, reason: "draft_not_canonical" };
    } catch {
      return { ok: false, reason: "draft_not_json" };
    }
    return { ok: true, path: draftPath, sha: digest };
  };
  const handleAdoptRefusal = async (dialogSha) => {
    // A refusal inside the pending window is answered (confirmed:false) and waits for the turn to settle.
    if (adoptState === "pending") return;
    if (adoptState === "applied") {
      logEvent("wrapper", { event: "auto_adopt_exhausted", message: "auto-adopt retry exhausted", dialog_sha: dialogSha });
      console.error("auto-adopt retry exhausted: the adopted brief was refused again");
      await stopChild(1, "auto_adopt_exhausted", true);
      return;
    }
    const candidate = readAdoptCandidate(dialogSha);
    if (!candidate.ok) {
      logEvent("wrapper", { event: "auto_adopt_skipped", level: "warn", reason: candidate.reason });
      console.error(`auto-adopt skipped: ${candidate.reason}`);
      await stopChild(1, "brief_hash_mismatch", true);
      return;
    }
    adoptCandidate = candidate;
    adoptState = "pending";
  };
  const adoptRetryMessage = () => [
    `Brief transcription mismatch. The canonical brief is at ${adoptCandidate.path} with SHA-256 ${adoptCandidate.sha}.`,
    `Campaign ${campaignId} (the id is pinned by the launch command; never pass a campaign_id to the tools).`,
    "Re-transcribe research_brief draft VERBATIM from that file byte-for-byte: copy the file content exactly, do NOT add, remove, reorder or reformat anything.",
    "Then run research_brief propose.",
  ].join("\n");

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
      // An unexpected pi exit is never a graceful charter pause (fix review B2).
      // Charter mode without a confirmed charter never reached the chain (m3):
      // only a confirmed charter plus a saved successful report may exit 0.
      if ((charterMode && !charterConfirmed) || (expeditionMode && !expeditionConfirmed)) exitCode = 3;
      else if (successfulReport && stage1Settled) exitCode = 0;
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
      } else if (stage >= 2 && disposition === "queued") {
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
      if (stage1Settled) {
        // research-charter (after the stage-1 settle): a marker-carrying settle
        // is the intermediate-report settle — the chain continues, deliver the
        // continuation for the next chain brief ONCE per awaiting_child period;
        // a settle without the marker (or a repeat marker without any agent
        // action) is the idle pause — exit 0, state stays on disk.
        if (chainConfirmed() && record.chain_status === "awaiting_child" && (!continuationSentForAwaiting || briefActionSeenSinceContinuation)) {
          continuationSentForAwaiting = true;
          briefActionSeenSinceContinuation = false;
          logEvent("wrapper", { event: "chain_continuation" });
          requestPrompt([
            `Chain campaign ${campaignId} finished its intermediate report.`,
            "Write the brief for the next campaign with research_brief draft: every question must cite findings from the previous campaign (finding_refs), keep the caveat block, verdict set and evidence_gate identical, then research_brief propose.",
            "The brief will be auto-approved by the charter checks (no dialog). After approval run research start, work the questions, close them, then research stop and research report.",
          ].join("\n"), 3);
          return;
        }
        if (chainConfirmed() && record.chain_status === "awaiting_child") {
          // A repeat marker with no intervening agent action: the continuation
          // was already delivered for this period — pause gracefully (fix review B1).
          logEvent("wrapper", { event: "chain_awaiting_child" });
          console.log("Chain paused in awaiting_child; wrapper exits 0 (state preserved).");
          await stopChild(0, "chain_awaiting_child");
          return;
        }
        if (chainConfirmed()) {
          // A marker-less idle settle in a confirmed chain is NOT the documented
          // awaiting_child pause (fix review B3): fall through to the
          // pre-existing non-charter behavior, which ends by timeout with 3.
        } else if ((charterMode && !charterConfirmed) || (expeditionMode && !expeditionConfirmed)) {
          // Charter mode without a confirmed charter never reached the chain:
          // any settle here must not report success (fix review m3).
          await stopChild(3, "charter_not_confirmed");
          return;
        } else if (successfulReport) {
          await stopChild(0, "successful_report");
          return;
        }
        // Non-charter fallthrough keeps the pre-existing behavior below.
      }
      if (!stage1Settled) {
        stage1Settled = true;
        if (adoptState === "pending") {
          // The agent proposed the brief DURING stage 1 (did not wait for the
          // stage-2 message). Send the adopt retry instead of stage 2.
          const from = approveSha;
          approveSha = adoptCandidate.sha;
          briefPath = adoptCandidate.path;
          adoptState = "applied";
          logEvent("wrapper", { type: "auto_adopt", from_sha: from, to_sha: approveSha });
          requestPrompt(adoptRetryMessage(), 2);
          return;
        }
        if (chainConfirmed() && record.chain_status === "awaiting_child" && !continuationSentForAwaiting) {
          // research-charter: the stage-1 turn already accepted the charter and
          // finished with an intermediate report — the root-brief stage is done,
          // deliver the ONE continuation for the next chain brief.
          continuationSentForAwaiting = true;
          logEvent("wrapper", { event: "chain_continuation" });
          requestPrompt([
            `Chain campaign ${campaignId} finished its intermediate report.`,
            "Write the brief for the next campaign with research_brief draft: every question must cite findings from the previous campaign (finding_refs), keep the caveat block, verdict set and evidence_gate identical, then research_brief propose.",
            "The brief will be auto-approved by the charter checks (no dialog). After approval run research start, work the questions, close them, then research stop and research report.",
          ].join("\n"), 2);
          return;
        }
        if (!stage2Sent) {
          stage2Sent = true;
          const briefHash = sha256(briefBytes);
          const message = [
            `Research campaign ${campaignId} (the id is pinned by the launch command; never pass a campaign_id to the tools).`,
            `Brief file: ${briefPath}`,
            `Brief SHA-256: ${briefHash}`,
            "Create the campaign with research_brief draft from this file, then research_brief propose.",
            "Transcribe the brief VERBATIM byte-for-byte from the file; do NOT add, remove, reorder or reformat anything (no new rules, no key reordering).",
            "After approval of the Brief SHA-256 dialog, run research start, open each question, record evidence, close each question, then research stop and research report.",
          ].join("\n");
          requestPrompt(message, 2);
        }
      } else if (((charterMode && !charterConfirmed) || (expeditionMode && !expeditionConfirmed)) && successfulReport) {
        // Charter mode without a confirmed charter never reached the chain:
        // a successful report here must not report success (fix review m3).
        await stopChild(3, "charter_not_confirmed");
      } else if (successfulReport) {
        await stopChild(0, "successful_report");
      } else if (adoptState === "pending") {
        // The refused turn has settled, so the retry prompt can be sent without streaming conflicts.
        const from = approveSha;
        approveSha = adoptCandidate.sha;
        briefPath = adoptCandidate.path;
        adoptState = "applied";
        logEvent("wrapper", { type: "auto_adopt", from_sha: from, to_sha: approveSha });
        requestPrompt(adoptRetryMessage(), 3);
      }
      return;
    }
    if (record.type === "tool_execution_start" && record.toolName === "research" && record.args?.action === "report") {
      const callId = record.toolCallId ?? record.callId ?? record.id;
      if (callId !== undefined) reportStarted.set(String(callId), true);
      return;
    }
    if (record.type === "tool_execution_start" && record.toolName === "research_brief") {
      // A new draft action re-arms the continuation guard: the agent acted on
      // the previous continuation, so the next awaiting_child period may need
      // a fresh one (fix review B1).
      briefActionSeenSinceContinuation = true;
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
        // research-charter: the charter dialog is checked BEFORE the brief one;
        // the prefixes are disjoint, so exactly one regex can match.
        const expeditionMatch = EXPEDITION_DIALOG_RE.exec(message);
        if (expeditionMatch) {
          if (!expeditionMode) {
            send({ type: "extension_ui_response", id: dialogId, confirmed: false });
            pendingDialogs.delete(dialogId);
            logEvent("wrapper", { event: "dialog_refused", reason: "expedition_dialog_without_expedition_mode", id: dialogId });
            return;
          }
          if (holdDialogMs > 0) await new Promise((resolve) => setTimeout(resolve, holdDialogMs));
          if (finished) return;
          let currentFileHash;
          try { currentFileHash = sha256(fs.readFileSync(expeditionPath)); } catch { currentFileHash = null; }
          const confirmed = expeditionMatch[1] === expeditionSha && expeditionMatch[1] === currentFileHash;
          expeditionConfirmed = confirmed;
          send({ type: "extension_ui_response", id: dialogId, confirmed });
          pendingDialogs.delete(dialogId);
          logEvent("wrapper", { event: "expedition_confirmation", id: dialogId, confirmed, dialog_sha: expeditionMatch[1], file_readable: currentFileHash !== null });
          if (!confirmed) await stopChild(3, "expedition_hash_mismatch", true);
          return;
        }
        const charterMatch = CHARTER_DIALOG_RE.exec(message);
        if (charterMatch) {
          if (!charterMode) {
            send({ type: "extension_ui_response", id: dialogId, confirmed: false });
            pendingDialogs.delete(dialogId);
            logEvent("wrapper", { event: "dialog_refused", reason: "charter_dialog_without_charter_mode", id: dialogId });
            return;
          }
          if (holdDialogMs > 0) await new Promise((resolve) => setTimeout(resolve, holdDialogMs));
          if (finished) return;
          const confirmed = charterMatch[1] === charterSha;
          charterConfirmed = confirmed;
          send({ type: "extension_ui_response", id: dialogId, confirmed });
          pendingDialogs.delete(dialogId);
          logEvent("wrapper", { event: "charter_confirmation", id: dialogId, confirmed, dialog_sha: charterMatch[1] });
          if (!confirmed) {
            // Charter refused: the chain never starts, no campaign state.
            await stopChild(3, "charter_hash_mismatch", true);
          }
          return;
        }
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
        if (!confirmed) {
          if (autoAdopt) await handleAdoptRefusal(shaMatch[1]);
          else await stopChild(1, "brief_hash_mismatch", true);
        }
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

  requestPrompt(expeditionMode ? `/autoresearch expedition\nPrepared expedition document: ${expeditionPath}\nValidate it with the expedition_brief tool and call propose. The owner approval is handled by this headless wrapper dialog.` : `/autoresearch research --id ${campaignId}${args["state-root"] ? ` --state-root ${args["state-root"]}` : ""}${charterMode ? ` --charter ${charterPath}` : ""}`, 1);
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
