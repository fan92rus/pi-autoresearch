import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolvePiExecutable, DIALOG_SHA_RE, CHARTER_DIALOG_RE } from "../scripts/research-rpc.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(repo, "scripts", "research-rpc.mjs");
const fakePi = path.join(repo, "tests", "fake-rpc-pi.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-rpc-test-"));
  const brief = path.join(dir, "brief.json");
  const bytes = Buffer.from(`${JSON.stringify({ schema_version: 1, goal: "test" }, null, 2)}\n`);
  fs.writeFileSync(brief, bytes);
  return { dir, brief, bytes, digest: sha(bytes), log: path.join(dir, "session.jsonl") };
}

function run(ctx, extra = [], scenario = "success") {
  return new Promise((resolve) => {
    const overridden = new Set(extra.filter((value) => value.startsWith("--")));
    const pairs = [["--mode", "research"], ["--brief", ctx.brief], ["--approve-sha", ctx.digest],
      ["--campaign-id", "test-campaign"], ["--pi", fakePi], ["--cwd", ctx.dir], ["--log", ctx.log],
      ["--timeout-sec", "2"], ["--stage1-timeout-sec", "1.5"]];
    const defaults = pairs.filter(([name]) => !overridden.has(name)).flat();
    const args = [wrapper, ...defaults, ...extra];
    const child = spawn(process.execPath, args, {
      cwd: ctx.dir,
      windowsHide: true,
      env: { ...process.env, FAKE_RPC_SCENARIO: scenario, FAKE_RPC_SHA: ctx.digest },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function events(ctx) {
  if (!fs.existsSync(ctx.log)) return [];
  return fs.readFileSync(ctx.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sentMessages(ctx) {
  return events(ctx).filter((entry) => entry.direction === "to_pi" && entry.record.type === "prompt").map((entry) => entry.record.message);
}

test("canonical brief reaches fake RPC and successful report exits 0", async () => {
  const ctx = setup();
  const result = await run(ctx);
  assert.equal(result.code, 0, result.stderr);
  const messages = sentMessages(ctx);
  assert.equal(messages[0], "/autoresearch research --id test-campaign");
  assert.match(messages[1], /test-campaign/);
  assert.match(messages[1], /research_brief draft.*research_brief propose/s);
  assert.match(messages[1], /research start.*open.*close.*stop.*research report/s);
  assert.ok(messages.every((message) => !message.includes("/autoresearch on") && !message.includes("/skill:autoresearch-create")));
});

test("invalid canonical JSON variants exit 2 before pi starts", async () => {
  for (const bytes of [Buffer.from(""), Buffer.from("\uFEFF{}\n"), Buffer.from("{broken\n"), Buffer.from('{"goal":"x"}\n')]) {
    const ctx = setup();
    fs.writeFileSync(ctx.brief, bytes);
    const result = await run(ctx);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(fs.existsSync(ctx.log), false, "preflight failure must not spawn pi or create a session log");
  }
});

test("invalid approve sha and campaign id exit 2 before pi starts", async () => {
  const ctx = setup();
  assert.equal((await run(ctx, ["--approve-sha", "bad"])).code, 2);
  assert.equal((await run(ctx, ["--campaign-id", "bad id"])).code, 2);
});

test("matching dialog, operator and current file hashes are confirmed", async () => {
  const ctx = setup();
  assert.equal((await run(ctx)).code, 0);
  const confirmation = events(ctx).find((event) => event.record?.event === "brief_confirmation");
  assert.equal(confirmation?.record.confirmed, true);
  assert.equal(confirmation?.record.dialog_sha, ctx.digest);
});

test("foreign dialog hash is refused, aborts, and exits 1", async () => {
  const ctx = setup();
  const result = await run(ctx, [], "foreign-sha");
  assert.equal(result.code, 1, result.stderr);
  const logged = events(ctx);
  assert.ok(logged.some((event) => event.record?.event === "brief_confirmation" && event.record.confirmed === false));
  assert.ok(logged.some((event) => event.direction === "to_pi" && event.record.type === "abort"));
  const refusalIndex = logged.findIndex((event) => event.record?.event === "brief_confirmation" && event.record.confirmed === false);
  assert.equal(logged.slice(refusalIndex + 1).some((event) => /research_brief|toolName.:.research/.test(JSON.stringify(event.record))), false);
});

test("modifying the brief while the dialog is pending fails closed", async () => {
  const ctx = setup();
  const pending = run(ctx, ["--hold-dialog-ms", "800"], "success");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(ctx.log) && fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request")) break;
    await delay(10);
  }
  assert.ok(fs.existsSync(ctx.log) && fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request"), "fake should open propose dialog");
  fs.writeFileSync(ctx.brief, `${JSON.stringify({ schema_version: 1, goal: "modified" }, null, 2)}\n`);
  const result = await pending;
  assert.equal(result.code, 1, result.stderr);
  const confirmation = events(ctx).find((event) => event.record?.event === "brief_confirmation");
  assert.equal(confirmation?.record.confirmed, false);
});

test("deleting the brief while the dialog is pending fails closed", async () => {
  const ctx = setup();
  const pending = run(ctx, ["--hold-dialog-ms", "250"], "success");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(ctx.log) && fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request")) break;
    await delay(10);
  }
  assert.ok(fs.existsSync(ctx.log) && fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request"), "fake should open propose dialog");
  fs.unlinkSync(ctx.brief);
  const result = await pending;
  assert.equal(result.code, 1, result.stderr);
  assert.ok(events(ctx).some((event) => event.record?.event === "brief_confirmation" && event.record.confirmed === false));
});

test("non-brief confirm is refused without turning it into a hash failure", async () => {
  const ctx = setup();
  const result = await run(ctx, [], "non-brief-confirm");
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  assert.ok(logged.some((event) => event.record?.event === "dialog_refused"));
  assert.ok(logged.some((event) => event.direction === "to_pi" && event.record.type === "extension_ui_response" && event.record.id === "dialog-1" && event.record.confirmed === false));
});

test("stage 1 without agent_start exits 2", async () => {
  const ctx = setup();
  const result = await run(ctx, [], "no-agent-start");
  assert.equal(result.code, 2, result.stderr);
});

test("queued stage-2 prompt exits 1", async () => {
  const ctx = setup();
  const result = await run(ctx, [], "stage2-queued");
  assert.equal(result.code, 1, result.stderr);
});

test("a pending confirm is refused on total timeout and exits 3", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--timeout-sec", "0.4", "--stage1-timeout-sec", "1", "--hold-dialog-ms", "1000"], "hold-confirm");
  assert.equal(result.code, 3, result.stderr);
  assert.ok(events(ctx).some((event) => event.direction === "to_pi" && event.record.type === "extension_ui_response" && event.record.confirmed === false));
  assert.ok(events(ctx).some((event) => event.record?.event === "timeout"));
});

test("refused report does not exit 0", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--timeout-sec", "0.4"], "bad-report");
  assert.equal(result.code, 3, result.stderr);
});

test("Windows default pi resolver locates the pi.cmd shim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-rpc-path-"));
  const shim = path.join(dir, "pi.cmd");
  fs.writeFileSync(shim, "@echo off\n");
  assert.equal(resolvePiExecutable("pi", "win32", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }), shim);
});

test("CLI rejects unsupported optimize mode with documented scope split", async () => {
  const ctx = setup();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, "--mode", "optimize"], { cwd: ctx.dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /optimize mode is not implemented in this MVP build \(documented scope split; see openspec\/changes\/headless-launch\)/);
});

test("a real .cmd shim launches pi and completes the research flow on Windows", { skip: process.platform !== "win32" ? "windows-only" : false }, async () => {
  const ctx = setup();
  const dir = path.dirname(ctx.brief);
  const shim = path.join(dir, "fake-pi.cmd");
  fs.writeFileSync(shim, `@echo off\r\nnode "${fakePi}" %*\r\n`);
  const result = await run(ctx, ["--pi", shim, "--timeout-sec", "6"]);
  assert.equal(result.code, 0);
  const log = events(ctx);
  assert.ok(log.some((entry) => entry.direction === "to_pi" && entry.record.type === "extension_ui_response" && entry.record.confirmed === true));
  assert.ok(log.some((entry) => entry.direction === "from_pi" && entry.record.type === "tool_execution_end"));
});

test("unexpected pi exit is logged as pi_exited and exits 3", async () => {
  const ctx = setup();
  // Generous stage-1 deadline: under full-suite load the fake's node startup can
  // exceed the default; the crash must win the race, not the no-agent-start timer.
  const result = await run(ctx, ["--timeout-sec", "8", "--stage1-timeout-sec", "6"], "crash");
  assert.equal(result.code, 3);
  assert.ok(events(ctx).some((entry) => entry.direction === "wrapper" && entry.record.event === "pi_exited"));
});

const draftBytesFor = (variant) => Buffer.from(`${JSON.stringify({ schema_version: 1, goal: "test", extra_rule: variant }, null, 2)}\n`);

test("stage 2 instructs byte-for-byte transcription of the brief", async () => {
  const ctx = setup();
  assert.equal((await run(ctx)).code, 0);
  const messages = sentMessages(ctx);
  assert.match(messages[1], /Transcribe the brief VERBATIM byte-for-byte from the file; do NOT add, remove, reorder or reformat anything/);
});

test("auto-adopt retries once with the agent draft and exits 0", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--auto-adopt-draft"], "transcription-drift");
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  const adopt = logged.find((entry) => entry.direction === "wrapper" && entry.record.type === "auto_adopt");
  assert.equal(adopt?.record.from_sha, ctx.digest);
  assert.equal(adopt?.record.to_sha, sha(draftBytesFor("first")));
  const confirmations = logged.filter((entry) => entry.record?.event === "brief_confirmation").map((entry) => entry.record.confirmed);
  assert.deepEqual(confirmations, [false, true]);
  const messages = sentMessages(ctx);
  assert.equal(messages.length, 3, "exactly one retry prompt after stage 2");
  assert.match(messages[2], /Re-transcribe research_brief draft VERBATIM from that file byte-for-byte/);
  assert.ok(messages[2].includes(path.join(ctx.dir, ".auto", "research", "test-campaign", "brief.json")));
  assert.ok(messages[2].includes(sha(draftBytesFor("first"))));
});

test("without the flag the same drift exits 1 and never retries", async () => {
  const ctx = setup();
  const result = await run(ctx, [], "transcription-drift");
  assert.equal(result.code, 1, result.stderr);
  assert.equal(events(ctx).some((entry) => entry.record.type === "auto_adopt"), false);
  assert.equal(sentMessages(ctx).length, 2);
});

test("a second refusal after the adopted retry exits 1 as exhausted", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--auto-adopt-draft"], "double-drift");
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /auto-adopt retry exhausted/);
  const logged = events(ctx);
  assert.ok(logged.some((entry) => entry.record.event === "auto_adopt_exhausted" && entry.record.message === "auto-adopt retry exhausted"));
  assert.equal(logged.filter((entry) => entry.record.type === "auto_adopt").length, 1);
  assert.equal(sentMessages(ctx).length, 3, "no retry beyond the single adopted prompt");
});

test("missing agent draft is skipped with a warning and exits 1", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--auto-adopt-draft"], "drift-no-draft");
  assert.equal(result.code, 1, result.stderr);
  assert.ok(events(ctx).some((entry) => entry.record.event === "auto_adopt_skipped" && entry.record.level === "warn" && entry.record.reason === "draft_missing"));
  assert.equal(events(ctx).some((entry) => entry.record.type === "auto_adopt"), false);
  assert.equal(sentMessages(ctx).length, 2);
});

test("stale agent draft (dialog sha differs from disk) is skipped with a warning and exits 1", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--auto-adopt-draft"], "drift-stale-draft");
  assert.equal(result.code, 1, result.stderr);
  assert.ok(events(ctx).some((entry) => entry.record.event === "auto_adopt_skipped" && entry.record.level === "warn" && entry.record.reason === "draft_sha_differs_from_dialog"));
  assert.equal(events(ctx).some((entry) => entry.record.type === "auto_adopt"), false);
  assert.equal(sentMessages(ctx).length, 2);
});

// ─── research-charter: headless chain launch (wave 2 + round-2 fixes) ────────

const EMPTY_CHARTER = `${JSON.stringify({ stop_rules: [] }, null, 2)}\n`;

/** Writes the per-test charter file and returns its digest. */
function writeCharterFile(ctx) {
  const charterPath = path.join(ctx.dir, "charter.json");
  fs.writeFileSync(charterPath, Buffer.from(EMPTY_CHARTER));
  return { charterPath, charterDigest: sha(EMPTY_CHARTER) };
}

/**
 * Writes a small fake pi with the given behavior hooks. opts:
 * - onUiResponse(confirmedTrue): lines emitted when a dialog is answered true
 * - onPrompt(stage): lines emitted per prompt; returns whether a dialog opens
 * Simplified generator used by the charter scenarios below.
 */
function buildCharterFakePi(dir, name, body) {
  const fake = path.join(dir, name);
  fs.writeFileSync(fake, body.join("\n") + "\n");
  return fake;
}

const FAKE_HEAD = [
  '#!/usr/bin/env node',
  'import * as readline from "node:readline";',
  'const scenario = process.env.CHARTER_FAKE_SCENARIO ?? "match";',
  'const charterSha = process.env.CHARTER_FAKE_SHA ?? "0".repeat(64);',
  'const briefSha = process.env.CHARTER_FAKE_BRIEF_SHA ?? "0".repeat(64);',
  'const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");',
  'const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
  'let stage = 0;',
  'const reportAndSettleAwaiting = () => {',
  '  out({ type: "tool_execution_start", toolCallId: "call-report", toolName: "research", args: { action: "report" } });',
  '  out({ type: "tool_execution_end", toolCallId: "call-report", toolName: "research", result: { details: {} }, isError: false });',
  '  out({ type: "agent_settled", chain_status: "awaiting_child" });',
  '};',
  'input.on("line", (line) => {',
  '  let request; try { request = JSON.parse(line); } catch { return; }',
  '  if (request.type === "abort") { out({ type: "abort_ack" }); input.close(); return; }',
];

const FAKE_TAIL = [
  '  if (request.type === "prompt") {',
  '    out({ type: "agent_start" });',
  '    out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });',
  '    stage += 1;',
  '    if (stage === 1) {',
  '      const shown = process.env.CHARTER_FAKE_MISMATCH === "1" ? "e".repeat(64) : charterSha;',
  '      out({ id: "dialog-1", type: "extension_ui_request", method: "confirm", message: "Charter SHA-256: " + shown + "\\nApprove charter?" });',
  '    } else if (process.env.CHARTER_FAKE_AFTER_PROMPT === "marker") {',
  '      // Continuation answered with another intermediate report + marker settle',
  '      // (fix1 scenario); the wrapper must pause, not loop.',
  '      reportAndSettleAwaiting();',
  '    } else if (process.env.CHARTER_FAKE_AFTER_PROMPT === "idle") {',
  '      // Continuation answered with an idle settle (fix6 scenario).',
  '      out({ type: "agent_settled", chain_status: "awaiting_child" });',
  '    }',
  '  }',
  '});',
];

function runCharter(ctx, { scenario = "match", extra = [], timeout = "6", fakeName = "charter-fake-pi.mjs", fakeBody = null, env = {} } = {}) {
  const { charterPath, charterDigest } = writeCharterFile(ctx);
  const body = fakeBody ?? [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    if (scenario === "match" || scenario === "root-brief") reportAndSettleAwaiting();',
    '    else out({ type: "agent_settled" });',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ];
  const fake = buildCharterFakePi(ctx.dir, fakeName, body);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, "--mode", "research", "--brief", ctx.brief, "--approve-sha", ctx.digest,
      "--campaign-id", "test-campaign", "--pi", fake, "--cwd", ctx.dir, "--log", ctx.log,
      "--timeout-sec", timeout, "--stage1-timeout-sec", "1.5",
      "--charter", charterPath, "--approve-charter-sha", charterDigest, ...extra], {
      cwd: ctx.dir,
      windowsHide: true,
      env: { ...process.env, CHARTER_FAKE_SCENARIO: scenario, CHARTER_FAKE_SHA: charterDigest, CHARTER_FAKE_BRIEF_SHA: ctx.digest, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("--charter and --approve-charter-sha are mutually required and validated before pi starts", async () => {
  const ctx = setup();
  const { charterPath } = writeCharterFile(ctx);
  const results = [];
  results.push(await run(ctx, ["--charter", charterPath]));
  results.push(await run(ctx, ["--approve-charter-sha", "a".repeat(64)]));
  results.push(await run(ctx, ["--charter", charterPath, "--approve-charter-sha", "NOT-Hex"]));
  for (const result of results) {
    assert.equal(result.code, 2, result.stderr);
    assert.equal(fs.existsSync(ctx.log), false, "parse failure must not spawn pi or create a session log");
  }
  const withMissing = await run(ctx, ["--charter", charterPath]);
  assert.match(withMissing.stderr, /--charter and --approve-charter-sha are mutually required/);
});

test("Charter and Brief dialog regexes are disjoint, also for a Charter line inside a brief dialog", () => {
  const hex = "a".repeat(64);
  const briefMsg = `Brief SHA-256: ${hex}\nApprove?`;
  const charterMsg = `Charter SHA-256: ${hex}\nApprove charter?`;
  assert.ok(DIALOG_SHA_RE.test(briefMsg));
  assert.equal(CHARTER_DIALOG_RE.test(briefMsg), false);
  assert.ok(CHARTER_DIALOG_RE.test(charterMsg));
  assert.equal(DIALOG_SHA_RE.test(charterMsg), false);
  assert.equal(CHARTER_DIALOG_RE.exec(charterMsg)?.[1], hex);
  const briefWithCharterLine = `Brief SHA-256: ${hex}\nCharter SHA-256: ${"b".repeat(64)}\nApprove?`;
  assert.equal(CHARTER_DIALOG_RE.test(briefWithCharterLine), false, "second-line Charter text must not match");
  assert.equal(DIALOG_SHA_RE.test(briefWithCharterLine), true);
});

test("charter dialog with a matching hash is confirmed; the intermediate report does not end the run", async () => {
  const ctx = setup();
  // After the continuation the fake answers with an idle marker settle, so the
  // wrapper pauses gracefully (exit 0) instead of timing out.
  const result = await runCharter(ctx, { scenario: "match", timeout: "4", env: { CHARTER_FAKE_AFTER_PROMPT: "idle" } });
  assert.equal(result.code, 0, `the intermediate report must deliver a continuation, then pause; stderr: ${result.stderr}`);
  const confirmation = events(ctx).find((event) => event.record?.event === "charter_confirmation");
  assert.equal(confirmation?.record.confirmed, true);
  assert.ok(events(ctx).some((event) => event.record?.event === "chain_continuation"), "the continuation was delivered");
});

test("charter dialog mismatch answers false and exits 3 without creating state", async () => {
  const ctx = setup();
  const result = await runCharter(ctx, { scenario: "match", timeout: "4", env: { CHARTER_FAKE_MISMATCH: "1" } });
  assert.equal(result.code, 3, result.stderr);
  const logged = events(ctx);
  const confirmation = logged.find((event) => event.record?.event === "charter_confirmation");
  assert.equal(confirmation?.record.confirmed, false);
  assert.ok(logged.some((event) => event.direction === "to_pi" && event.record.type === "abort"));
  const after = logged.slice(logged.indexOf(confirmation) + 1);
  assert.equal(after.some((event) => event.direction === "to_pi" && event.record.type === "prompt"), false, "no campaign prompt after a charter refusal");
  assert.equal(fs.existsSync(path.join(ctx.dir, ".auto", "research", "test-campaign")), false, "no campaign state is created");
});

test("round2 fix1: a persistent awaiting_child marker delivers exactly ONE continuation then exits 0", async () => {
  const ctx = setup();
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    reportAndSettleAwaiting(); // every settle carries the marker',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ];
  const result = await runCharter(ctx, { fakeName: "marker-always.mjs", fakeBody: body, timeout: "4", env: { CHARTER_FAKE_AFTER_PROMPT: "marker" } });
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  const continuations = logged.filter((event) => event.record?.event === "chain_continuation");
  assert.equal(continuations.length, 1, `expected exactly one continuation, got ${continuations.length}`);
  assert.ok(logged.some((event) => event.record?.event === "chain_awaiting_child"), "the second marker settle must pause gracefully");
  assert.equal(sentMessages(ctx).length, 2, "stage-1 + one continuation only");
});

test("round2 fix2: a pi crash after the confirmed charter exits 3, not 0", async () => {
  const ctx = setup();
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    process.exit(1); // crash right after the charter was confirmed',
    '  }',
    ...FAKE_TAIL,
  ];
  const result = await runCharter(ctx, { fakeName: "crash-after.mjs", fakeBody: body, timeout: "8" });
  assert.equal(result.code, 3, `a crash is not the awaiting_child pause; stderr: ${result.stderr}`);
  assert.ok(events(ctx).some((event) => event.direction === "wrapper" && event.record.event === "pi_exited"));
});

test("round2 fix3: a marker-less idle settle in charter mode without a report does NOT exit 0", async () => {
  const ctx = setup();
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    out({ type: "agent_settled" }); // idle settle: no report, no marker',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ];
  const result = await runCharter(ctx, { fakeName: "idle-no-report.mjs", fakeBody: body, timeout: "2.5" });
  assert.notEqual(result.code, 0, `an idle settle without a report and without the marker must not pause with 0; stderr: ${result.stderr}`);
  assert.equal(events(ctx).some((event) => event.record?.event === "chain_awaiting_child"), false);
});

test("round2 fix4: without --charter a marker-carrying settle does NOT deliver a continuation", async () => {
  const ctx = setup();
  // Brief-dialog flow (no charter dialog): stage-1 settles, stage-2 opens the
  // brief dialog, the report settle carries the marker.
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    reportAndSettleAwaiting();',
    '    return;',
    '  }',
    '  if (request.type === "prompt") {',
    '    out({ type: "agent_start" });',
    '    out({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });',
    '    stage += 1;',
    '    if (stage === 1) out({ type: "agent_settled" });',
    '    if (stage === 2) {',
    '      out({ id: "dialog-brief", type: "extension_ui_request", method: "confirm", message: "Brief SHA-256: " + (process.env.CHARTER_FAKE_BRIEF_SHA ?? process.env.FAKE_RPC_SHA) + "\\nApprove?" });',
    '    }',
    '  }',
    '});',
  ];
  const fake = buildCharterFakePi(ctx.dir, "nocharter-marker.mjs", body);
  const result = await run(ctx, ["--pi", fake, "--timeout-sec", "4"], "success");
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  assert.equal(logged.some((event) => event.record?.event === "chain_continuation"), false, "chain continuation must be charter-mode only");
  assert.equal(logged.some((event) => event.record?.event === "chain_awaiting_child"), false);
  assert.equal(sentMessages(ctx).length, 2, "stage-1 + stage-2 only, as before");
});

test("round2 M2: the stage-1 prompt forwards --charter <path>", async () => {
  const ctx = setup();
  const result = await runCharter(ctx, { scenario: "match", timeout: "3" });
  assert.match(sentMessages(ctx)[0], /--charter /, "the charter path must reach the agent through the stage-1 prompt");
});

test("round2 M2: an empty --charter value is a parse error", async () => {
  const ctx = setup();
  const result = await run(ctx, ["--charter", "", "--approve-charter-sha", "a".repeat(64)]);
  assert.equal(result.code, 2, "an empty charter path must refuse before pi starts");
  assert.equal(fs.existsSync(ctx.log), false);
});

test("round2 m3: charter mode without a confirmed charter exits 3 on success", async () => {
  const ctx = setup();
  // The plain success fake never opens a charter dialog; charter args alone must not grant success.
  const { charterPath, charterDigest } = writeCharterFile(ctx);
  const result = await run(ctx, ["--charter", charterPath, "--approve-charter-sha", charterDigest]);
  assert.equal(result.code, 3, "charter mode success without a confirmed charter must not report success");
  assert.equal(events(ctx).some((event) => event.record?.event === "charter_confirmation"), false);
});

test("idle awaiting_child after the delivered continuation exits 0 gracefully (marker asserted)", async () => {
  const ctx = setup();
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    stage += 1; // count settled continuation turns',
    '    if (stage === 1) reportAndSettleAwaiting(); // intermediate report with marker',
    '    else out({ type: "agent_settled", chain_status: "awaiting_child" }); // idle WITH marker (fix6)',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ];
  const result = await runCharter(ctx, { fakeName: "idle-marker.mjs", fakeBody: body, timeout: "4", env: { CHARTER_FAKE_AFTER_PROMPT: "idle" } });
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  assert.equal(logged.filter((event) => event.record?.event === "chain_continuation").length, 1);
  assert.ok(logged.some((event) => event.record?.event === "chain_awaiting_child"));
});

test("without --charter a Charter dialog is refused like any non-brief confirm and the wrapper does not abort", async () => {
  const ctx = setup();
  const fake = buildCharterFakePi(ctx.dir, "nocharter-dialog.mjs", [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    out({ type: "agent_settled" });',
    '    input.close();',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ]);
  const result = await run(ctx, ["--pi", fake]);
  const logged = events(ctx);
  assert.ok(logged.some((event) => event.record?.event === "dialog_refused"));
  assert.equal(logged.some((event) => event.record?.event === "charter_confirmation"), false);
  assert.equal(logged.some((event) => event.direction === "to_pi" && event.record.type === "abort"), false, "the wrapper must not abort on its own outside charter mode");
  assert.equal(result.code, 3, "pi closed without a report, so the pre-existing exit code stands");
});

// ─── Final-review coverage gaps (tasks 4.4–4.6) ──────────────────────────────

test("review-4.4: the root brief still needs its own dialog alongside the charter dialog", async () => {
  const ctx = setup();
  const body = [
    ...FAKE_HEAD,
    '  if (request.type === "extension_ui_response") {',
    '    if (request.confirmed !== true) { input.close(); return; }',
    '    globalThis.dialogs = (globalThis.dialogs ?? 0) + 1;',
    '    if (globalThis.dialogs === 1) out({ id: "dialog-2", type: "extension_ui_request", method: "confirm", message: "Brief SHA-256: " + briefSha + String.fromCharCode(10) + "Approve brief?" });',
    '    else reportAndSettleAwaiting();',
    '    return;',
    '  }',
    ...FAKE_TAIL,
  ];
  const result = await runCharter(ctx, { fakeName: "root-brief-fake.mjs", fakeBody: body, timeout: "5", env: { CHARTER_FAKE_AFTER_PROMPT: "idle" } });
  assert.equal(result.code, 0, result.stderr);
  const logged = events(ctx);
  const charter = logged.find((e) => e.record?.event === "charter_confirmation");
  assert.equal(charter?.record.confirmed, true, "the charter dialog was confirmed");
  const brief = logged.find((e) => e.record?.event === "brief_confirmation");
  assert.equal(brief?.record.confirmed, true, "the ROOT brief dialog was confirmed as usual");
  assert.equal(brief?.record.dialog_sha, ctx.digest, "the root brief hash is checked against --approve-sha");
  const prompts = sentMessages(ctx);
  assert.equal(prompts.length, 2, "stage-1 + one continuation");
  assert.match(prompts[0], /^\/autoresearch research --id test-campaign/, "the root keeps the --campaign-id");
});

test("review-4.4: the wrapper never invents a child campaign id (system-assigned by the extension)", async () => {
  const ctx = setup();
  const result = await runCharter(ctx, { timeout: "4", env: { CHARTER_FAKE_AFTER_PROMPT: "idle" } });
  assert.equal(result.code, 0, result.stderr);
  for (const message of sentMessages(ctx)) {
    assert.doesNotMatch(message, /--id [^\s]*-c\d+/, "no system child id in wrapper prompts");
  }
});

test("review-4.5: a graceful awaiting_child pause keeps the session state on disk", async () => {
  const ctx = setup();
  const result = await runCharter(ctx, { timeout: "4", env: { CHARTER_FAKE_AFTER_PROMPT: "idle" } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(ctx.log), "the session log survives the pause");
  const logged = events(ctx);
  assert.ok(logged.some((e) => e.record?.event === "chain_awaiting_child"), "the pause is logged");
  const prompts = sentMessages(ctx);
  assert.match(prompts[prompts.length - 1], /next campaign/i, "the last delivery is the continuation, nothing after the pause");
});

test("review-4.6: the legacy exit codes are unchanged without --charter", async () => {
  for (const { scenario, code } of [
    { scenario: "success", code: 0 },
    { scenario: "crash", code: 3 },
    { scenario: "foreign-sha", code: 1 },
  ]) {
    const ctx = setup();
    const result = await run(ctx, ["--timeout-sec", "8", "--stage1-timeout-sec", "6"], scenario);
    assert.equal(result.code, code, `${scenario}: expected ${code}, got ${result.code}; ${result.stderr}`);
    assert.equal(
      events(ctx).some((e) => e.record?.event === "charter_confirmation" || e.record?.event === "chain_continuation" || e.record?.event === "chain_awaiting_child"),
      false,
      `${scenario}: no charter events without --charter`,
    );
  }
  const ctx = setup();
  fs.writeFileSync(ctx.brief, Buffer.from("{broken\n"));
  assert.equal((await run(ctx)).code, 2, "invalid canonical brief still exits 2");
});
