import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolvePiExecutable } from "../scripts/research-rpc.mjs";

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
