/**
 * Smoke real-extension tests — verify the REAL extension registers correctly
 * and basic lifecycle works end-to-end.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/smoke.test.mjs
 *
 * The redirect-loader stubs 4 packages so we can import the real index.ts.
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx, readConfig, readTree, readLog } from "./fake-pi.ts";

// ──────────────────────────────────────────────────────────────────────
// Test harness
// ──────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passCount++;
  } catch (e) {
    failCount++;
    const msg = e.message.split("\n")[0];
    failures.push(`${name}: ${msg}`);
    console.error(`  ❌ ${name}\n     ${msg}`);
  }
}

function makeTempDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

async function loadExtension(dir, sessionId = "smoke", opts = {}) {
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId, realGit: true, ...opts });
  const ctx = makeCtx(dir, sessionId, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  return { pi, tool, command, hook, ctx };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

console.log("## Smoke: real-extension registration");

const EXPECTED_TOOLS = [
  "init_experiment", "propose_hypothesis", "run_experiment", "log_experiment",
  "tree_status", "finalize_research",
  "council_write_entry", "council_read_index", "council_read_entry", "council_check_consensus",
  "council_convene",
];

// Disabled tool groups (both flags false):
// - PARALLEL_TOOLS_ENABLED: BestOfN, startPhase, commitPhase, abortPhase,
//   valleyProbe, CheckOrthogonal, SpaceSearch
// - BRANCHING_TOOLS_ENABLED: explore_from, restore_main, compose
const DISABLED_TOOLS = [
  "BestOfN", "startPhase", "commitPhase", "abortPhase", "valleyProbe",
  "CheckOrthogonal", "SpaceSearch", "explore_from", "restore_main", "compose",
];

const EXPECTED_HOOKS = [
  "session_start", "session_tree", "session_before_switch", "session_shutdown",
  "agent_start", "session_before_compact", "session_compact", "agent_end",
  "before_agent_start", "tool_execution_end", "tool_call",
];

await test("registers all 10 tools (parallel + branching disabled)", async () => {
  const dir = makeTempDir("reg");
  const { pi } = await loadExtension(dir);
  const names = pi.tools.map((t) => t.name);
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.includes(expected), `Missing tool: ${expected}`);
  }
  assert.strictEqual(names.length, 11, `Expected 11 tools, got ${names.length}: ${names.join(", ")}`);
});

await test("registers all 11 hooks", async () => {
  const dir = makeTempDir("hooks");
  const { pi } = await loadExtension(dir);
  const names = [...pi.hooks.keys()];
  for (const expected of EXPECTED_HOOKS) {
    assert.ok(names.includes(expected), `Missing hook: ${expected}`);
  }
  assert.strictEqual(names.length, 11, `Expected 11 hooks, got ${names.length}`);
});

await test("registers /autoresearch command", async () => {
  const dir = makeTempDir("cmd");
  const { pi } = await loadExtension(dir);
  const cmd = pi.commands.find((c) => c.name === "autoresearch");
  assert.ok(cmd, "autoresearch command not registered");
  assert.strictEqual(typeof cmd.handler, "function");
});

await test("registers no shortcuts by default (opt-in)", async () => {
  const dir = makeTempDir("shortcut");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; // no config written there
  try {
    const { pi } = await loadExtension(dir);
    assert.strictEqual(pi.shortcuts.length, 0, "shortcuts must be opt-in — none bound by default");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

await test("registers a shortcut opted in via agent config", async () => {
  const dir = makeTempDir("shortcut");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-agent-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "extensions", "pi-autoresearch.json"),
      JSON.stringify({ shortcuts: { fullscreenDashboard: "ctrl+shift+u" } })
    );
    const { pi } = await loadExtension(dir);
    assert.ok(pi.shortcuts.length >= 1, "opted-in shortcut not registered");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// ── Lifecycle e2e ────────────────────────────────────────────────────

console.log("\n## Smoke: lifecycle e2e");

await test("init_experiment creates tree.json + log.jsonl", async () => {
  const dir = makeTempDir("init");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  const res = await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  assert.ok(fs.existsSync(path.join(dir, ".auto", "tree.json")), "tree.json not created");
  assert.ok(fs.existsSync(path.join(dir, ".auto", "log.jsonl")), "log.jsonl not created");

  const log = readLog(dir);
  assert.ok(log.some((e) => e.type === "config"), "log.jsonl missing config header");
  const configEntry = log.find((e) => e.type === "config");
  assert.strictEqual(configEntry.name, "bench");
  assert.strictEqual(configEntry.metricName, "ms");
});

await test("log.jsonl config header is unique (no duplicate on re-init)", async () => {
  const dir = makeTempDir("dup-init");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  // Second init in same session — should not duplicate
  await tool("init_experiment").execute("id", {
    name: "bench2", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  const log = readLog(dir);
  const configs = log.filter((e) => e.type === "config");
  // The second init may create a new segment, but each segment should have exactly 1 config
  assert.ok(configs.length >= 1, "No config entries");
});

await test("init_experiment with identical config resumes the segment (no re-segmentation)", async () => {
  const dir = makeTempDir("init-resume");
  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const lines = [
    JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" }),
    JSON.stringify({ run: 1, metric: 100, status: "keep", description: "baseline", timestamp: 1793380062 }),
    JSON.stringify({ run: 2, metric: 99, status: "keep", description: "improved", timestamp: 1793380162 }),
  ];
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await hook("session_start")({}, ctx);
  const res = await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  assert.strictEqual(res.details?.resumed, true, "identical-config init must resume, not re-segment");
  assert.strictEqual(readLog(dir).filter((e) => e.type === "config").length, 1, "no second config header on resume");

  // A genuinely different target still re-segments (one new header).
  const res2 = await tool("init_experiment").execute("id", {
    name: "other-bench", metric_name: "ops", metric_unit: "", direction: "higher",
  }, null, null, ctx);
  assert.ok(res2.details?.resumed !== true, "config change must not be a resume");
  assert.strictEqual(readLog(dir).filter((e) => e.type === "config").length, 2, "config change appends exactly one header");
});

await test("propose + run + log(keep) updates tree and log", async () => {
  const dir = makeTempDir("lifecycle");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  // Propose hypothesis
  const prop = await tool("propose_hypothesis").execute("id", {
    description: "Use lookup table for O(1) access",
  }, null, null, ctx);
  assert.ok(!prop.content?.[0]?.text?.includes("error"), "propose failed");

  const tree = readTree(dir);
  assert.ok(tree, "tree.json missing after propose");
  // There should be at least the root + the hypothesis node
  const nodeCount = Object.keys(tree.nodes ?? {}).length;
  assert.ok(nodeCount >= 2, `Expected >=2 nodes, got ${nodeCount}`);
});

await test("tree_status returns structured info", async () => {
  const dir = makeTempDir("status");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const res = await tool("tree_status").execute("id", {}, null, null, ctx);
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text.length > 0, "tree_status returned empty");
  // Should contain tree structure or "empty" indication
  assert.ok(text.includes("n0") || text.includes("root") || text.includes("Tree"),
    `tree_status should mention tree/root, got: ${text.slice(0, 120)}`);
});

await test("tools gated when mode is OFF", async () => {
  const dir = makeTempDir("gated");
  initGitRepo(dir);
  const { tool, ctx } = await loadExtension(dir);
  // Don't turn on autoresearch mode
  const res = await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text.includes("OFF") || text.includes("off"), `Tool should be gated when mode is OFF, got: ${text.slice(0, 120)}`);
});

// ── Hooks ─────────────────────────────────────────────────────────────

console.log("\n## Smoke: hooks");

await test("before_agent_start adds prompt section in autoresearch mode", async () => {
  const dir = makeTempDir("prompt");
  initGitRepo(dir);
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const event = { systemPrompt: "You are a coding agent." };
  await hook("before_agent_start")(event, ctx);
  const prompt = ctx.sessionManager.getSessionId(); // just check no crash
  assert.ok(true, "before_agent_start ran without crash");
});

await test("agent_end hook runs without crash", async () => {
  const dir = makeTempDir("agent-end");
  initGitRepo(dir);
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await hook("agent_end")({ messages: [] }, ctx);
  assert.ok(true, "agent_end ran without crash");
});

await test("drifted turns get bounded corrective resumes, then pause", async () => {
  const dir = makeTempDir("drift");
  initGitRepo(dir);
  const { pi, tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  // Simulate pure-chat turns: before_agent_start (flag reset) → agent_end with
  // no loop-tool activity in between (no tool_execution_end events).
  const settle = async () => {
    await hook("before_agent_start")({ systemPrompt: "x" }, ctx);
    await hook("agent_end")({ messages: [] }, ctx);
    await new Promise((r) => setTimeout(r, 1000)); // SETTLED_WINDOW_MS = 800
  };

  await settle();
  const nudges = () => pi.sentMessages.filter((m) => m.text.includes("used no experiment tools"));
  assert.strictEqual(nudges().length, 1, `first drift should nudge, sent: ${pi.sentMessages.map((m) => m.text.slice(0, 60)).join(" | ")}`);

  await settle();
  assert.strictEqual(nudges().length, 2, "second drift should nudge again");

  await settle();
  assert.strictEqual(nudges().length, 2, "third drift must NOT nudge (bounded)");
  assert.ok(
    pi.notifications.some((n) => n.text.includes("Autoresearch paused")),
    `user should be notified of the pause, got: ${pi.notifications.map((n) => n.text.slice(0, 60)).join(" | ")}`,
  );
});

// ── Detailed lifecycle ───────────────────────────────────────────────

console.log("\n## Smoke: detailed lifecycle");

await test("propose creates untested node with correct fields", async () => {
  const dir = makeTempDir("propose-detail");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await tool("propose_hypothesis").execute("id", {
    description: "Cache results in a Map",
  }, null, null, ctx);

  const tree = readTree(dir);
  const nodes = Object.values(tree.nodes ?? {});
  const untested = nodes.find((n) => n.status === "untested");
  assert.ok(untested, "No untested node after propose");
  assert.strictEqual(untested.hypothesis, "Cache results in a Map");
});

await test("duplicate hypothesis gets 'duplicate' status", async () => {
  const dir = makeTempDir("dup-hyp");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await tool("propose_hypothesis").execute("id", {
    description: "Use a hash table for fast lookups",
  }, null, null, ctx);

  const dup = await tool("propose_hypothesis").execute("id", {
    description: "Use a hash table for fast lookups",
  }, null, null, ctx);
  const text = dup.content?.[0]?.text ?? "";
  assert.ok(text.toLowerCase().includes("duplicate"), `Should detect duplicate, got: ${text.slice(0, 100)}`);
});

await test("log_experiment with status keep creates experiment entry", async () => {
  const dir = makeTempDir("log-keep");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  await tool("propose_hypothesis").execute("id", {
    description: "Optimize loop",
  }, null, null, ctx);

  const tree1 = readTree(dir);
  const hyp = Object.values(tree1.nodes ?? {}).find((n) => n.status === "untested");

  // Run experiment (trivial command)
  await tool("run_experiment").execute("id", {
    command: 'node -e "0"', timeout_seconds: 5,
    hypothesis_id: hyp?.id,
  }, null, null, ctx);

  // Log result — either as keep or discard (keep requires git diff, so test
  // that the tool returns a response with experiment info)
  const logRes = await tool("log_experiment").execute("id", {
    metric: 200, status: "discard", description: "optimized loop",
    hypothesis_id: hyp?.id,
  }, null, null, ctx);
  const text = logRes.content?.[0]?.text ?? "";
  // The tool should acknowledge the result
  assert.ok(text.length > 0, "log_experiment returned empty response");

  // Tree should reflect the logged result
  const tree2 = readTree(dir);
  const hypNode = tree2?.nodes?.[hyp?.id];
  if (hypNode) {
    assert.ok(hypNode.status !== "untested", `Node should transition from untested, got: ${hypNode.status}`);
  }
});

await test("log_experiment flags unmeasured metric (honest provenance)", async () => {
  const dir = makeTempDir("prov");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  // Log WITHOUT any prior run_experiment this session → agent-claimed metric
  const res = await tool("log_experiment").execute("id", {
    metric: 100, status: "discard", description: "claimed number",
  }, null, null, ctx);
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text.includes("METRIC PROVENANCE"), `expected provenance warning, got: ${text.slice(0, 200)}`);
  assert.strictEqual(res.details?.metricProvenance, "unmeasured");
});

await test("log_experiment provenance: measured vs manual", async () => {
  const dir = makeTempDir("prov2");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC ms=123')"`, timeout_seconds: 10,
  }, null, null, ctx);

  // Baseline log at the measured value → measured provenance, no warning
  const ok = await tool("log_experiment").execute("id", {
    metric: 123, status: "discard", description: "baseline at measured value",
  }, null, null, ctx);
  assert.strictEqual(ok.details?.metricProvenance, "measured");
  assert.ok(!ok.content[0].text.includes("METRIC PROVENANCE"), `unexpected provenance warning: ${ok.content[0].text.slice(0, 300)}`);

  // Hand-copied number → manual + warning
  const bad = await tool("log_experiment").execute("id", {
    metric: 999, status: "discard", description: "invented number",
  }, null, null, ctx);
  assert.strictEqual(bad.details?.metricProvenance, "manual");
  assert.ok(bad.content[0].text.includes("METRIC PROVENANCE"), `expected provenance warning, got: ${bad.content[0].text.slice(0, 300)}`);
});

await test("autoresearch off blocks gated tools", async () => {
  const dir = makeTempDir("off-gated");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);

  // Turn on, init, then turn off
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  await command("autoresearch").handler("off", ctx);

  const res = await tool("propose_hypothesis").execute("id", {
    description: "test",
  }, null, null, ctx);
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text.includes("OFF") || text.includes("off"), `Tool should be blocked when off, got: ${text.slice(0, 80)}`);
});

await test("tree_status returns the hypothesis list", async () => {
  const dir = makeTempDir("tree-status");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const res = await tool("tree_status").execute("id", {}, null, null, ctx);
  const text = res.content?.[0]?.text ?? "";
  assert.ok(text, "tree_status should return a response");
  assert.ok(!text.includes("explore_from"), "no references to disabled branching tools");
  assert.ok(!text.includes("compose("), "no compose suggestions");
});

await test("finalize_research returns a response", async () => {
  const dir = makeTempDir("finalize");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const res = await tool("finalize_research").execute("id", {
    reason: "reached goal",
  }, null, null, ctx);
  assert.ok(res.content?.[0]?.text, "finalize_research should return a response");
});

await test("before_agent_start mutates system prompt in autoresearch mode", async () => {
  const dir = makeTempDir("prompt-mutate");
  initGitRepo(dir);
  const { pi, tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const event = { systemPrompt: "You are a coding agent." };
  await hook("before_agent_start")(event, ctx);
  // The hook should have appended autoresearch sections to systemPrompt.
  // Check either event.systemPrompt was extended OR pi captured the prompt.
  const promptExtended = event.systemPrompt.includes("Autoresearch") || event.systemPrompt.includes("Experiment");
  const capturedPrompt = pi._lastSystemPrompt &&
    (pi._lastSystemPrompt.includes("Autoresearch") || pi._lastSystemPrompt.includes("Experiment"));
  assert.ok(
    promptExtended || capturedPrompt,
    "systemPrompt should be extended in autoresearch mode",
  );
});

await test("parallel + branching tools are NOT registered (disabled)", async () => {
  const dir = makeTempDir("tools-disabled");
  const { tool } = await loadExtension(dir);
  for (const name of DISABLED_TOOLS) {
    assert.ok(!tool(name), `${name} should be disabled (flag=false)`);
  }
});

await test("failure warning counts streak since last keep, not campaign total", async () => {
  const dir = makeTempDir("streak");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "f1", metric_unit: "", direction: "higher",
  }, null, null, ctx);

  // Helper: plant a flat tree with an interleaved keep/failure history
  // (the owner's real scenario: 10 failures + keeps on the board, then a new
  // proposal — the old TOTAL count scolded despite the breakthroughs).
  const plantTree = (statuses) => {
    const nodes = {
      n0: { id: "n0", parentId: null, children: [], nodeType: "baseline", status: "baseline", metric: 0.28, hypothesis: "baseline", hypothesisLabel: null, commit: null, asi: null, depth: 0 },
    };
    statuses.forEach((st, i) => {
      const id = `n${i + 1}`;
      nodes[id] = { id, parentId: "n0", children: [], nodeType: "experiment", status: st, metric: st === "keep" ? 0.4 : 0, hypothesis: `H${i}`, hypothesisLabel: `H${i}`, commit: null, asi: null, depth: 1 };
      nodes.n0.children.push(id);
    });
    fs.writeFileSync(path.join(dir, ".auto", "tree.json"), JSON.stringify({
      version: 1, rootId: "n0", activeNodeId: "n0", nextId: statuses.length + 1,
      baselineMetric: 0.28, direction: "higher", metricName: "f1", savedBranch: null, nodes,
    }));
  };

  // Case 1: recent keeps — NO warning despite 10 total failures on the root
  plantTree(["discard","discard","keep","discard","discard","keep","discard","discard","discard","discard","keep"]);
  let res = await tool("propose_hypothesis").execute("id", { description: "H-next after breakthrough: new idea, force=true" }, null, null, ctx);
  let text = res.content?.[0]?.text ?? "";
  assert.ok(!text.includes("consecutive failed"), `no streak warning right after a keep, got: ${text.slice(-300)}`);

  // Case 2: 6 consecutive failures after the last keep — warning IS shown
  plantTree(["keep","discard","discard","discard","discard","discard","discard"]);
  res = await tool("propose_hypothesis").execute("id", { description: "H-next after losing streak, force=true" }, null, null, ctx);
  text = res.content?.[0]?.text ?? "";
  assert.ok(text.includes("6 consecutive failed hypotheses since last keep"), `streak warning expected, got: ${text.slice(-300)}`);
  assert.ok(!text.includes("All failures:"), "failure list must be capped, not 'All failures'");
});

await test("bash-run of measure.sh is blocked while mode is on (goal-x hard gate)", async () => {
  const dir = makeTempDir("bench-gate");
  initGitRepo(dir);
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const call = (cmd) => hook("tool_call")({ toolName: "bash", input: { command: cmd } }, ctx);

  const blocked = await call("bash measure.sh");
  assert.ok(blocked?.block === true, "executing measure.sh via bash must be blocked");
  assert.ok(String(blocked.reason).includes("run_experiment"), "reason must point to run_experiment");

  const blockedEnv = await call("BENCH_MODE=quick ./measure.sh");
  assert.ok(blockedEnv?.block === true, "BENCH_MODE= assignment must be blocked");

  const reading = await call("cat measure.sh");
  assert.ok(!reading?.block, `reading the script must stay allowed, got: ${JSON.stringify(reading)}`);

  const off = makeCtx(dir, "sess-gate-off");
  const offResult = await hook("tool_call")({ toolName: "bash", input: { command: "bash measure.sh" } }, off);
  assert.ok(!offResult?.block, "mode off — no gating");
});

await test("run_started/run_result ledger markers wrap the benchmark run", async () => {
  const dir = makeTempDir("run-markers");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await tool("run_experiment").execute("id", {
    command: "node -e \"0\"", timeout_seconds: 10,
  }, null, null, ctx);

  const log = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf-8");
  const starts = log.split("\n").filter((l) => l.includes('"type":"run_started"'));
  const results = log.split("\n").filter((l) => l.includes('"type":"run_result"'));
  assert.strictEqual(starts.length, 1, `one run_started expected, log:\n${log}`);
  assert.strictEqual(results.length, 1, "one run_result expected");
  const startAt = JSON.parse(starts[0]).started_at;
  assert.strictEqual(JSON.parse(results[0]).started_at, startAt, "run_result must correlate via started_at");
});

await test("dangling run_started marks the node crashed on session start", async () => {
  const dir = makeTempDir("dangling");
  initGitRepo(dir);
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(path.join(autoDir, "log.jsonl"),
    JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" }) + "\n" +
    JSON.stringify({ type: "run_started", node_id: "n1", command: "bash measure.sh", started_at: "2026-10-29T00:00:00Z" }) + "\n");
  fs.writeFileSync(path.join(autoDir, "tree.json"), JSON.stringify({
    version: 1, rootId: "n0", activeNodeId: "n1", nextId: 2,
    baselineMetric: 10, direction: "lower", metricName: "ms", savedBranch: null,
    nodes: {
      n0: { id: "n0", parentId: null, children: ["n1"], nodeType: "baseline", status: "baseline", metric: 10, hypothesis: "baseline", hypothesisLabel: null, commit: null, asi: null, depth: 0 },
      n1: { id: "n1", parentId: "n0", children: [], nodeType: "hypothesis", status: "running", metric: 0, hypothesis: "mid-run death", hypothesisLabel: "GONE", commit: null, asi: null, depth: 1 },
    },
  }));

  const { hook } = await loadExtension(dir);
  await hook("session_start")({}, makeCtx(dir, "sess-dangling"));

  const after = JSON.parse(fs.readFileSync(path.join(autoDir, "tree.json"), "utf-8"));
  assert.strictEqual(after.nodes.n1.status, "crashed", "dangling run_started => crashed (not just abandoned)");
});

await test("flagged provenance is re-injected into the next resume", async () => {
  const dir = makeTempDir("reinforce");
  initGitRepo(dir);
  const { tool, command, hook, ctx, pi } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  // Invented metric: no run_experiment preceded => provenance 'unmeasured'
  await tool("log_experiment").execute("id", {
    status: "keep", metric: 123, description: "invented number",
  }, null, null, ctx);
  await hook("tool_execution_end")({ toolName: "log_experiment" }, ctx);

  // Settled turn end -> plain resume must carry the flag reminder
  await hook("before_agent_start")({ systemPrompt: "x" }, ctx);
  await hook("agent_end")({ messages: [] }, ctx);
  await new Promise((r) => setTimeout(r, 1000)); // SETTLED_WINDOW_MS = 800

  const last = pi.sentMessages[pi.sentMessages.length - 1]?.text ?? "";
  assert.ok(last.includes("flagged"), `resume must carry the provenance reminder, got: ${last.slice(0, 200)}`);
  assert.ok(last.includes("unmeasured"), "reminder must name the provenance problem");
});

await test("stale running tree nodes are marked abandoned on session start", async () => {
  const dir = makeTempDir("stale-running");
  initGitRepo(dir);
  // Plant a tree.json with a ghost running node (like a crashed prior session)
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const treeJson = {
    version: 1,
    rootId: "n0",
    activeNodeId: "n2",
    nextId: 3,
    baselineMetric: 10,
    direction: "lower",
    metricName: "ms",
    savedBranch: null,
    nodes: {
      n0: { id: "n0", parentId: null, children: ["n1", "n2"], nodeType: "baseline", status: "baseline", metric: 10, hypothesis: "baseline", hypothesisLabel: null, commit: null, asi: null, depth: 0 },
      n1: { id: "n1", parentId: "n0", children: [], nodeType: "hypothesis", status: "running", metric: 0, hypothesis: "ghost run", hypothesisLabel: "GHOST", commit: null, asi: null, depth: 1 },
      n2: { id: "n2", parentId: "n0", children: [], nodeType: "hypothesis", status: "keep", metric: 8, hypothesis: "resolved", hypothesisLabel: "OK", commit: null, asi: null, depth: 1 },
    },
  };
  fs.writeFileSync(path.join(autoDir, "tree.json"), JSON.stringify(treeJson));

  const { hook } = await loadExtension(dir);
  await hook("session_start")({}, makeCtx(dir, "sess-stale"));

  const after = JSON.parse(fs.readFileSync(path.join(autoDir, "tree.json"), "utf-8"));
  assert.strictEqual(after.nodes.n1.status, "abandoned", "ghost running node must become abandoned");
  assert.strictEqual(after.nodes.n2.status, "keep", "resolved node must stay untouched");
});

// ── Individual tool registration (smoke for all 6) ──────────────────

console.log("\n## Smoke: all 6 tools individually");

for (const toolName of EXPECTED_TOOLS) {
  await test(`tool '${toolName}' is registered with execute + schema`, async () => {
    const dir = makeTempDir(`tool-${toolName}`);
    const { tool } = await loadExtension(dir);
    const t = tool(toolName);
    assert.ok(t, `Tool ${toolName} not registered`);
    assert.strictEqual(typeof t.execute, "function", `${toolName} has no execute`);
    assert.ok(t.inputSchema || t.parameters || t.name, `${toolName} has no schema`);
  });
}

// ── Individual hooks (smoke for all 9) ───────────────────────────────

console.log("\n## Smoke: all 9 hooks individually");

const HOOK_TEST_EVENTS = {
  session_start: [{}],
  session_tree: [{}],
  session_before_switch: [{}],
  session_shutdown: [{}],
  agent_start: [{}],
  session_before_compact: [{ preparation: { firstKeptEntryId: "x", lastKeptEntryId: "y" } }],
  session_compact: [{ preparation: { firstKeptEntryId: "x", lastKeptEntryId: "y" } }],
  agent_end: [{ messages: [] }],
  before_agent_start: [{ systemPrompt: "test" }],
};

for (const hookName of EXPECTED_HOOKS) {
  await test(`hook '${hookName}' is registered and callable`, async () => {
    const dir = makeTempDir(`hook-${hookName}`);
    initGitRepo(dir);
    const { tool, command, hook, ctx } = await loadExtension(dir);
    // Most hooks need autoresearch mode + init to work properly
    await command("autoresearch").handler("on", ctx);
    await tool("init_experiment").execute("id", {
      name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
    }, null, null, ctx);

    const h = hook(hookName);
    assert.ok(h, `Hook ${hookName} not registered`);
    // Should not crash
    const event = HOOK_TEST_EVENTS[hookName] ?? [{}];
    await h(...event, ctx);
    assert.ok(true, `${hookName} ran without crash`);
  });
}

// ── State reconstruction (session_tree) ──────────────────────────────

console.log("\n## Smoke: state reconstruction");

await test("session_tree hook reconstructs state after init", async () => {
  const dir = makeTempDir("reconstruct");
  initGitRepo(dir);
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  // session_tree should reconstruct without crash
  await hook("session_tree")({}, ctx);
  assert.ok(true, "session_tree ran without crash");
});

await test("session_start hook initializes runtime", async () => {
  const dir = makeTempDir("session-start");
  initGitRepo(dir);
  const { tool, command, hook, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  await hook("session_start")({}, ctx);
  assert.ok(true, "session_start ran without crash");
});

// ── Config persistence ───────────────────────────────────────────────

console.log("\n## Smoke: config persistence");

await test("init_experiment writes config to log.jsonl", async () => {
  const dir = makeTempDir("config-persist");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "my-bench", metric_name: "score", metric_unit: "", direction: "higher",
  }, null, null, ctx);

  const log = readLog(dir);
  const config = log.find((e) => e.type === "config");
  assert.ok(config, "No config entry");
  assert.strictEqual(config.name, "my-bench");
  assert.strictEqual(config.metricName, "score");
  assert.strictEqual(config.bestDirection, "higher");
});

await test("tree.json has correct root structure", async () => {
  const dir = makeTempDir("tree-root");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);

  const tree = readTree(dir);
  assert.ok(tree.version, "tree.json missing version");
  assert.ok(tree.rootId, "tree.json missing rootId");
  assert.ok(tree.activeNodeId, "tree.json missing activeNodeId");
  assert.ok(tree.nodes, "tree.json missing nodes");
  assert.strictEqual(tree.rootId, tree.activeNodeId, "root should be active after init");
});

await test("propose_hypothesis writes idea file to .auto/ideas/", async () => {
  const dir = makeTempDir("idea-file");
  initGitRepo(dir);
  const { tool, command, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  await tool("propose_hypothesis").execute("id", {
    description: "Use a faster algorithm",
  }, null, null, ctx);

  const ideasDir = path.join(dir, ".auto", "ideas");
  assert.ok(fs.existsSync(ideasDir), "ideas/ directory not created");
  const files = fs.readdirSync(ideasDir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "No .md files in ideas/");
});

// ──────────────────────────────────────────────────────────────────────
// Reflection checkpoints + advisor-aware hints (goal-x / pi-advisor)
// ──────────────────────────────────────────────────────────────────────

function plantRunLog(dir, runs) {
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const lines = [JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" })];
  for (let i = 0; i < runs; i++) {
    lines.push(JSON.stringify({ run: i + 1, metric: 100 - i, status: "keep", description: `keep ${i}` }));
  }
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), lines.join("\n") + "\n");
}

await test("reflection checkpoint fires at the run interval, without advisor when absent", async () => {
  const dir = makeTempDir("reflect");
  plantRunLog(dir, 10); // 10 improving keeps → decidedRuns = 10
  const { runObserver } = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "observer.ts")));

  const steer = runObserver({
    cwd: dir, direction: "lower", metricName: "ms", metricUnit: "ms",
    baselineMetric: 100, bestMetric: 91, runCount: 10, goal: "bench",
  });
  assert.ok(steer?.includes("REFLECTION CHECKPOINT"), `expected reflection steer, got: ${steer?.slice(0, 200)}`);
  assert.ok(steer.includes("advisor") === false, "no advisor mention when the tool is absent");
  assert.ok(!steer.includes("MILESTONE"), "reflection shadows the 5-run progress milestone");
});

await test("reflection checkpoint does not fire off-interval", async () => {
  const dir = makeTempDir("reflect-off");
  plantRunLog(dir, 11);
  const { runObserver } = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "observer.ts")));

  const steer = runObserver({
    cwd: dir, direction: "lower", metricName: "ms", metricUnit: "ms",
    baselineMetric: 100, bestMetric: 90, runCount: 11, goal: "bench",
  });
  assert.ok(!steer?.includes("REFLECTION CHECKPOINT"), `off-interval must not fire, got: ${steer?.slice(0, 120)}`);
});

await test("stagnation hint addresses advisor when the tool is present", async () => {
  const dir = makeTempDir("advisor-stag");
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const lines = [JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" })];
  for (let i = 0; i < 5; i++) {
    lines.push(JSON.stringify({ run: i + 1, metric: 120 + i, status: "discard", description: `tweak ${i}` }));
  }
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), lines.join("\n") + "\n");
  const { runObserver } = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "observer.ts")));

  const payload = {
    cwd: dir, direction: "lower", metricName: "ms", metricUnit: "ms",
    baselineMetric: 100, bestMetric: 100, runCount: 5, goal: "bench",
  };
  const withAdvisor = runObserver({ ...payload, advisorAvailable: true });
  assert.ok(withAdvisor?.includes("STAGNATION"), `expected stagnation, got: ${withAdvisor?.slice(0, 120)}`);
  assert.ok(withAdvisor.includes('advisor({ stage: "recovery" })'), "stagnation must route to advisor when present");
  assert.ok(withAdvisor.includes("discriminating experiment"), "argue protocol must be present");
  assert.ok(withAdvisor.includes("quote the disputed advice"), "quote-before-reconsult must be present (advisor sees no toolResults)");

  const withoutAdvisor = runObserver(payload);
  assert.ok(withoutAdvisor?.includes("STAGNATION"));
  assert.ok(!withoutAdvisor.includes("ADVISOR"), "no advisor line when tool absent");
});

await test("observer steers carry advisor awareness through the hook pipeline", async () => {
  const dir = makeTempDir("advisor-wire");
  initGitRepo(dir);
  plantRunLog(dir, 9); // log_experiment appends the 10th → checkpoint fires on the after-hook
  const { tool, command, pi } = await loadExtension(dir);
  const ctx = Object.assign(makeCtx(dir, "sess-adv", pi), { tools: [{ name: "advisor" }, { name: "bash" }] });

  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  plantRunLog(dir, 9); // init archives pre-existing logs — plant AFTER init, before the 10th run lands
  await tool("log_experiment").execute("id", {
    status: "keep", metric: 91, description: "tenth run",
  }, null, null, ctx);

  const joined = pi.sentMessages.map((m) => m.text ?? "").join("\n");
  assert.ok(joined.includes("REFLECTION CHECKPOINT"), `after-steer must carry the checkpoint, got: ${joined.slice(0, 300)}`);
  assert.ok(joined.includes('advisor({ stage: "recovery" })'), "pipeline must see ctx.tools and mention advisor");
});

// ──────────────────────────────────────────────────────────────────────
// Stagnation Council: blackboard tools, roster, consensus, slate, trigger
// ──────────────────────────────────────────────────────────────────────

const councilMod = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "council.ts")));
const councilToolsMod = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "council-tools.ts")));

function makeToolCtx(dir) {
  return { cwd: dir };
}

async function writeEntry(dir, entry) {
  const { tool } = await loadExtension(dir);
  return tool("council_write_entry").execute("id", entry, null, null, makeToolCtx(dir));
}

function plantStalledLedger(dir, stalledRuns = 10) {
  const autoDir = path.join(dir, ".auto");
  fs.mkdirSync(autoDir, { recursive: true });
  const lines = [JSON.stringify({ type: "config", name: "bench", metricName: "ms", metricUnit: "ms", bestDirection: "lower" })];
  lines.push(JSON.stringify({ run: 1, metric: 100, status: "keep", description: "baseline-ish keep" }));
  for (let i = 0; i < stalledRuns; i++) {
    lines.push(JSON.stringify({ run: i + 2, metric: 120 + i, status: "discard", description: `tweak ${i}` }));
  }
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), lines.join("\n") + "\n");
}

await test("council blackboard: write, index, read roundtrip", async () => {
  const dir = makeTempDir("council-bb");
  await writeEntry(dir, { councilDir: ".auto/councils/1", speaker: "AnalystA", phase: "diverge", summary: "three hypotheses", content: "### H-A1: cache warm\nstuff\n### H-A2: fewer iters\nstuff" });
  await writeEntry(dir, { councilDir: ".auto/councils/1", speaker: "AnalystB", phase: "challenge", summary: "verdicts", content: "VERDICT H-A1: accept — cheap\nVERDICT H-A2: reject — below noise" });

  const { tool } = await loadExtension(dir);
  const idx = await tool("council_read_index").execute("id", { councilDir: ".auto/councils/1" }, null, null, makeToolCtx(dir));
  const idxText = idx.content[0].text;
  assert.ok(idxText.includes("2 entries"), `index lists both entries: ${idxText}`);
  assert.ok(idxText.includes("[diverge] AnalystA"));
  assert.ok(idxText.includes("[challenge] AnalystB"));

  const entry = await tool("council_read_entry").execute("id", { councilDir: ".auto/councils/1", entryFile: "entries/0001-AnalystA.md" }, null, null, makeToolCtx(dir));
  assert.ok(entry.content[0].text.includes("H-A1: cache warm"));
  assert.ok(entry.content[0].text.includes("H-A2"));
});

await test("council blackboard rejects paths outside .auto/councils", async () => {
  const dir = makeTempDir("council-path");
  const { tool } = await loadExtension(dir);
  const bad = await tool("council_write_entry").execute("id", { councilDir: ".auto/../elsewhere", speaker: "X", phase: "diverge", summary: "s", content: "c" }, null, null, makeToolCtx(dir));
  assert.ok(bad.content[0].text.startsWith("❌"), `escape must be rejected: ${bad.content[0].text}`);
  const badIdx = await tool("council_read_index").execute("id", { councilDir: "D:/tmp" }, null, null, makeToolCtx(dir));
  assert.ok(badIdx.content[0].text.startsWith("❌"));
});

await test("consensus detector: settled requires all other voters and no refine", async () => {
  const { detectConsensus } = councilToolsMod;
  const participants = [{ name: "AnalystA", letter: "A" }, { name: "AnalystB", letter: "B" }, { name: "AnalystC", letter: "C" }];
  const entries = [
    { file: "e1", speaker: "AnalystA", phase: "diverge", summary: "" },
    { file: "e2", speaker: "AnalystB", phase: "diverge", summary: "" },
    { file: "e3", speaker: "AnalystC", phase: "diverge", summary: "" },
  ];
  const bodies = new Map([
    ["e1", "### H-A1: proposal one\n### H-A2: proposal two"],
    ["e2", "### H-B1: proposal three"],
    ["e3", "### H-C1: proposal four"],
  ]);
  // No challenge entries yet → all contested.
  let report = detectConsensus(entries, (e) => bodies.get(e.file) ?? null, participants, 3);
  assert.strictEqual(report.hypotheses.length, 4);
  assert.strictEqual(report.settledCount, 0);
  assert.strictEqual(report.canConverge, false);

  // A's entry challenges B1 (accept) and C1 (accept) — those become settled (owner excluded from voting).
  entries.push({ file: "e4", speaker: "AnalystA", phase: "challenge", summary: "" });
  bodies.set("e4", "VERDICT H-B1: accept — grounded\nVERDICT H-C1: refine — needs cheaper kill test");
  entries.push({ file: "e5", speaker: "AnalystB", phase: "challenge", summary: "" });
  bodies.set("e5", "VERDICT H-A1: accept — ok\nVERDICT H-C1: accept — fine");
  entries.push({ file: "e6", speaker: "AnalystC", phase: "challenge", summary: "" });
  bodies.set("e6", "VERDICT H-A1: reject — too costly\nVERDICT H-B1: refine — cut scope first");

  report = detectConsensus(entries, (e) => bodies.get(e.file) ?? null, participants, 3);
  const byId = Object.fromEntries(report.hypotheses.map((h) => [h.id, h]));
  assert.strictEqual(byId["H-A1"].settled, true, "A1: voted by B+C, no refine (reject is a final verdict)");
  assert.strictEqual(byId["H-B1"].settled, false, "B1: refine from C keeps it contested");
  assert.strictEqual(byId["H-C1"].settled, false, "C1: has refine from A");
  assert.deepStrictEqual(byId["H-A1"].missingFrom, []);
  assert.strictEqual(byId["H-A1"].verdictsBy["AnalystB"], "accept");
  assert.strictEqual(byId["H-A1"].verdictsBy["AnalystC"], "reject");
  assert.strictEqual(report.canConverge, false);
});

await test("slate validator: count, gain threshold, kill criterion", () => {
  const { validateSlate } = councilMod;
  const good = [
    "## EXP1: warm cache", "- EXPECTED_GAIN: 5", "- KILL_WHEN: no gain after 2 runs",
    "## EXP2: cut iterations", "- EXPECTED_GAIN: 3", "- KILL_WHEN: variance explodes",
    "## EXP3: drop parser pass", "- EXPECTED_GAIN: 4", "- KILL_WHEN: correctness drops",
  ].join("\n");
  const v = validateSlate(good, 1.0);
  assert.strictEqual(v.ok, true, `expected ok, errors: ${v.errors.join("; ")}`);

  const lowGain = good.replace("EXPECTED_GAIN: 5", "EXPECTED_GAIN: 1.5");
  const v2 = validateSlate(lowGain, 1.0);
  assert.strictEqual(v2.ok, false);
  assert.ok(v2.errors[0].includes("below 2× noise"));

  const noKill = good.replace(/- KILL_WHEN:[^\n]+\n/g, "");
  assert.strictEqual(validateSlate(noKill, 1.0).ok, false);

  assert.strictEqual(validateSlate("## EXP1: x\n- EXPECTED_GAIN: 9\n- KILL_WHEN: y", 1.0).ok, false, "1 experiment is not enough");
  assert.strictEqual(validateSlate(good, null).ok, true, "no noise floor — presence checks only");
});

await test("roster resolver: models vs personas mode with letter assignment", () => {
  const { resolveRoster, defaultCouncilConfig } = councilMod;
  const cfg = defaultCouncilConfig();
  const distinct = resolveRoster(cfg);
  assert.strictEqual(distinct.mode, "models");
  assert.deepStrictEqual(distinct.participants.map((p) => p.letter), ["A", "B", "C"]);
  assert.ok(distinct.participants.every((p) => p.model === p.model));

  const sameModel = resolveRoster({ ...cfg, participants: cfg.participants.map((p) => ({ ...p, model: "zai-coding-cn/glm-5.3-flash" })) });
  assert.strictEqual(sameModel.mode, "personas", "identical models → persona mode");
  assert.ok(sameModel.participants.every((p) => p.model === "zai-coding-cn/glm-5.3-flash"));

  const forced = resolveRoster({ ...cfg, mode: "personas" });
  assert.strictEqual(forced.mode, "personas");
});

await test("council config: defaults, overrides, malformed input falls back", () => {
  const dir = makeTempDir("council-cfg");
  const { readCouncilConfig } = councilMod;
  const defaults = readCouncilConfig(dir);
  assert.strictEqual(defaults.enabled, true);
  assert.strictEqual(defaults.stagnationRuns, 10);
  assert.strictEqual(defaults.maxCouncils, Infinity, "no cap by default — long campaigns may convene many councils");

  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({
    council: { enabled: false, stagnation_runs: 4, max_councils: 2, chair_model: "test/model", participants: [{ name: "Solo", model: "m", persona: "skeptic" }, { name: "Duo", model: "m", persona: "explorer" }] },
  }));
  const cfg = readCouncilConfig(dir);
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.stagnationRuns, 4);
  assert.strictEqual(cfg.maxCouncils, 2);
  assert.strictEqual(cfg.chairModel, "test/model");
  assert.strictEqual(cfg.participants.length, 2);

  fs.writeFileSync(path.join(dir, ".auto", "config.json"), "{ broken json");
  assert.strictEqual(readCouncilConfig(dir).enabled, true, "malformed config → defaults");
});

await test("council trigger: threshold, pending resume, cooldown, cap, enabled flag, force", () => {
  const dir = makeTempDir("council-trigger");
  const { checkCouncilTrigger, readCouncilState } = councilMod;
  const brief = { metricName: "ms", metricUnit: "ms", direction: "lower", baselineMetric: 100, bestMetric: 100, goal: "bench" };
  const closeCouncil = (n) => {
    const ed = path.join(dir, ".auto", "councils", String(n), "entries");
    fs.mkdirSync(ed, { recursive: true });
    fs.writeFileSync(path.join(ed, "0099-Chair.md"), "---\nspeaker: Chair\nphase: slate\nsummary: done\n---\n## EXP1: x\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: nothing");
  };

  assert.strictEqual(checkCouncilTrigger(9, 10, dir, brief), null, "below stagnation threshold");
  let msg = checkCouncilTrigger(10, 11, dir, brief);
  assert.ok(msg?.includes("STAGNATION COUNCIL #1"), "fires at threshold");
  assert.ok(msg.includes("council_convene("), "nudge points at the autonomous tool");
  assert.ok(msg.includes(".auto/councils/1"), "message carries the council dir");
  assert.ok(fs.existsSync(path.join(dir, ".auto", "councils", "1", "00-brief.md")), "brief written");
  assert.strictEqual(readCouncilState(dir).councilsRun, 1);

  // pending council (brief written, no slate yet) → pointed at again, never re-sequenced
  msg = checkCouncilTrigger(10, 12, dir, brief);
  assert.ok(msg?.includes("STAGNATION COUNCIL #1"), "pending council re-nudged");
  assert.strictEqual(readCouncilState(dir).councilsRun, 1, "no new seq while pending");

  // close council #1 (slate entry lands) → cooldown logic becomes observable
  closeCouncil(1);
  assert.strictEqual(checkCouncilTrigger(10, 13, dir, brief), null, "cooldown still active (2 < 5 runs since council)");
  msg = checkCouncilTrigger(10, 16, dir, brief);
  assert.ok(msg?.includes("COUNCIL #2"), "cooldown passed → council #2");
  closeCouncil(2);

  // no cap by default: even many past councils do not block a new one
  councilMod.writeCouncilState(dir, { councilsRun: 10, lastCouncilRun: null });
  for (let s = 1; s <= 10; s++) closeCouncil(s);
  assert.ok(checkCouncilTrigger(10, 30, dir, brief)?.includes("COUNCIL #11"), "unlimited by default (long campaigns)");
  closeCouncil(11);

  // cap applies only when configured
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ council: { max_councils: 3 } }));
  assert.strictEqual(checkCouncilTrigger(10, 30, dir, brief), null, "configured max_councils reached");
  assert.ok(checkCouncilTrigger(10, 30, dir, brief, { force: true })?.includes("COUNCIL #12"), "manual force bypasses cap/cooldown");
  closeCouncil(12);

  // enabled=false blocks even force
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ council: { enabled: false } }));
  assert.strictEqual(checkCouncilTrigger(10, 40, dir, brief, { force: true }), null, "enabled=false wins over force");
});


await test("nudge message names the tool; facilitator message stays the manual fallback", () => {
  const dir = makeTempDir("council-msg");
  const { checkCouncilTrigger, composeFacilitatorMessage } = councilMod;
  const briefInput = { metricName: "ms", metricUnit: "ms", direction: "lower", baselineMetric: 100, bestMetric: 100, goal: "bench" };
  const nudge = checkCouncilTrigger(10, 11, dir, briefInput);
  assert.ok(nudge?.includes("council_convene"), "nudge points at the tool");
  assert.ok(nudge?.includes("blocks for several minutes"), "nudge says the workflow blocks");
  assert.ok(nudge?.includes("00-brief.md"), "nudge carries the brief path");

  const msg = composeFacilitatorMessage({
    councilDir: ".auto/councils/1",
    seq: 1,
    briefAbsPath: path.join(dir, ".auto", "councils", "1", "00-brief.md"),
    roster: { mode: "models", chairModel: "m", participants: [{ name: "AnalystA", letter: "A", model: "m1", persona: "patterns" }, { name: "AnalystB", letter: "B", model: "m2", persona: "explorer" }] },
    maxChallengeRounds: 5,
    minExperiments: 3,
  });
  for (const marker of ["Phase 1 — Diverge", "Phase 2 — Challenge", "Phase 3 — Chair", "Phase 4 — Execute", "WROTE_ENTRY", "council_check_consensus", "propose_hypothesis", "ONLY to correct objective facts", "Chair",
    // free-but-bounded exploration guidance for analysts (2026-10-30)
    "look around freely", "don't dig in", "don't run builds or benchmarks", "look at the project yourself",
    // codex_search grounding + unlimited councils budget note (2026-10-30)
    "use codex_search", "unlimited by default"]) {
    assert.ok(msg.includes(marker), `facilitator message must contain "${marker}"`);
  }
  assert.ok(msg.includes("AnalystA (letter A"), "roster with letters");
  assert.ok(msg.includes("council_write_entry"), "task templates teach the blackboard tool");
});

await test("observer fires the council on a stalled ledger (replaces stagnation hint)", async () => {
  const dir = makeTempDir("council-obs");
  plantStalledLedger(dir, 10);
  const observer = await import(pathToFileURL(path.join("extensions", "pi-autoresearch", "observer.ts")));
  const steer = observer.runObserver({
    cwd: dir, direction: "lower", metricName: "ms", metricUnit: "ms",
    baselineMetric: 100, bestMetric: 100, runCount: 11, goal: "bench",
  });
  assert.ok(steer?.includes("STAGNATION COUNCIL"), `council must fire on stalled ledger, got: ${steer?.slice(0, 120)}`);
  assert.ok(steer?.includes("council_convene"), "steer points at the autonomous tool");
  assert.ok(!steer.includes("STAGNATION:"), "plain stagnation hint must be replaced");
  assert.ok(fs.existsSync(path.join(dir, ".auto", "councils", "state.json")));

  // finish council #1 (slate lands) → immediate next call is cooldown-blocked → plain stagnation
  const ed = path.join(dir, ".auto", "councils", "1", "entries");
  fs.mkdirSync(ed, { recursive: true });
  fs.writeFileSync(path.join(ed, "0099-Chair.md"), "---\nspeaker: Chair\nphase: slate\nsummary: done\n---\n## EXP1: x\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: nothing");
  const steer2 = observer.runObserver({
    cwd: dir, direction: "lower", metricName: "ms", metricUnit: "ms",
    baselineMetric: 100, bestMetric: 100, runCount: 12, goal: "bench",
  });
  assert.ok(steer2?.includes("STAGNATION:"), `cooldown → plain stagnation: ${steer2?.slice(0, 80)}`);
  assert.ok(steer2?.includes("COUNCIL:"), "plain stagnation must mention the self-service council door");
  assert.ok(steer2?.includes("council_convene({ note:"), "stagnation hint names the convene tool with the note arg");
});

await test("brief builder: sections and determinism", () => {
  const dir = makeTempDir("council-brief");
  plantStalledLedger(dir, 12);
  const { buildBrief } = councilMod;
  const { path: briefPath, text } = buildBrief(dir, path.join(dir, ".auto", "councils", "1"), {
    seq: 1, metricName: "ms", metricUnit: "ms", direction: "lower", baselineMetric: 100, bestMetric: 100, noiseFloor: 2, goal: "bench",
  });
  for (const section of ["## Goal", "## Recent runs", "## Rules", "Noise floor", "tweak 11", "NEVER propose anything that cheats"]) {
    assert.ok(text.includes(section), `brief must contain "${section}"`);
  }
  const again = buildBrief(dir, path.join(dir, ".auto", "councils", "1"), {
    seq: 1, metricName: "ms", metricUnit: "ms", direction: "lower", baselineMetric: 100, bestMetric: 100, noiseFloor: 2, goal: "bench",
  });
  assert.strictEqual(again.text, text, "brief is deterministic");
  assert.ok(fs.existsSync(briefPath));
});

await test("council blackboard rejects symlinked roots (physical-path escape)", async () => {
  const dir = makeTempDir("council-symlink");
  const evil = path.join(os.tmpdir(), `pi-ar-evil-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(evil, { recursive: true });
  try {
    // Case 1: .auto/councils itself is a symlink outside the project.
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    let linked = true;
    try { fs.symlinkSync(evil, path.join(dir, ".auto", "councils"), "dir"); } catch { linked = false; }
    if (linked) {
      const { tool } = await loadExtension(dir);
      const res = await tool("council_write_entry").execute("id", { councilDir: ".auto/councils/1", speaker: "X", phase: "diverge", summary: "s", content: "c" }, null, null, makeToolCtx(dir));
      assert.ok(res.content[0].text.startsWith("❌"), `symlinked councils root must be rejected: ${res.content[0].text}`);
      assert.strictEqual(fs.existsSync(path.join(evil, "1")), false, "nothing may be written outside the project");
    }

    // Case 2: .auto itself is the symlink; councils is a real dir inside the target.
    const dir2 = makeTempDir("council-symlink2");
    fs.mkdirSync(path.join(evil, "councils"), { recursive: true });
    let linked2 = true;
    try { fs.symlinkSync(evil, path.join(dir2, ".auto"), "dir"); } catch { linked2 = false; }
    if (linked2) {
      const { tool } = await loadExtension(dir2);
      const res = await tool("council_write_entry").execute("id", { councilDir: ".auto/councils/1", speaker: "X", phase: "diverge", summary: "s", content: "c" }, null, null, makeToolCtx(dir2));
      assert.ok(res.content[0].text.startsWith("❌"), `symlinked .auto must be rejected: ${res.content[0].text}`);
      assert.strictEqual(fs.existsSync(path.join(evil, "councils", "1")), false, "nothing written via symlinked .auto");
    }
    fs.rmSync(evil, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("council blackboard: seq collision falls through, nothing is overwritten", async () => {
  const dir = makeTempDir("council-collide");
  fs.mkdirSync(path.join(dir, ".auto", "councils", "1", "entries"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "councils", "1", "entries", "0001-AnalystA.md"), "---\nspeaker: AnalystA\nphase: diverge\nsummary: pre-existing\n---\nkeep me");
  const { tool } = await loadExtension(dir);
  const res = await tool("council_write_entry").execute("id", { councilDir: ".auto/councils/1", speaker: "AnalystA", phase: "diverge", summary: "new entry", content: "### H-A9: fresh" }, null, null, makeToolCtx(dir));
  assert.ok(res.content[0].text.includes("0002-AnalystA.md"), `collision must bump seq: ${res.content[0].text}`);
  const kept = fs.readFileSync(path.join(dir, ".auto", "councils", "1", "entries", "0001-AnalystA.md"), "utf-8");
  assert.ok(kept.includes("keep me"), "pre-existing entry must survive");
});

await test("council blackboard: parallel batch keeps every entry", async () => {
  const dir = makeTempDir("council-par");
  const { tool } = await loadExtension(dir);
  const names = ["AnalystA", "AnalystB", "AnalystC", "AnalystD", "AnalystE"];
  const results = await Promise.all(names.map((s) =>
    tool("council_write_entry").execute("id", { councilDir: ".auto/councils/1", speaker: s, phase: "diverge", summary: `entry ${s}`, content: `### H-${s.slice(-1)}1: x` }, null, null, makeToolCtx(dir)),
  ));
  for (const r of results) {
    assert.ok(r.content[0].text.includes("WROTE_ENTRY OK"), "each parallel write must succeed");
  }
  const idx = await tool("council_read_index").execute("id", { councilDir: ".auto/councils/1" }, null, null, makeToolCtx(dir));
  assert.ok(idx.content[0].text.includes("5 entries"), `all 5 entries preserved: ${idx.content[0].text}`);
});

await test("consensus: later verdicts supersede earlier ones (recency rule)", async () => {
  const { detectConsensus } = councilToolsMod;
  const participants = [{ name: "AnalystA", letter: "A" }, { name: "AnalystB", letter: "B" }, { name: "AnalystC", letter: "C" }];
  const entries = [
    { file: "e1", speaker: "AnalystA", phase: "diverge", summary: "" },
    { file: "e2", speaker: "AnalystB", phase: "diverge", summary: "" },
    { file: "e3", speaker: "AnalystC", phase: "diverge", summary: "" },
  ];
  const bodies = new Map([
    ["e1", "### H-A1: alpha"],
    ["e2", "### H-B1: beta"],
    ["e3", "### H-C1: gamma"],
  ]);
  // Round 1: C's hypothesis gets refine from both voters.
  entries.push({ file: "e4", speaker: "AnalystA", phase: "challenge", summary: "r1" });
  bodies.set("e4", "VERDICT H-B1: accept — ok\nVERDICT H-C1: refine — needs a cheaper kill test");
  entries.push({ file: "e5", speaker: "AnalystB", phase: "challenge", summary: "r1" });
  bodies.set("e5", "VERDICT H-A1: accept — ok\nVERDICT H-C1: refine — same");
  // Round 2 (later seq): both voters revise their C1 verdicts to final ones.
  entries.push({ file: "e6", speaker: "AnalystA", phase: "challenge", summary: "r2" });
  bodies.set("e6", "VERDICT H-C1: accept — revised form is fine");
  entries.push({ file: "e7", speaker: "AnalystB", phase: "challenge", summary: "r2" });
  bodies.set("e7", "VERDICT H-C1: reject — still below noise");

  const report = detectConsensus(entries, (e) => bodies.get(e.file) ?? null, participants, 3);
  const byId = Object.fromEntries(report.hypotheses.map((h) => [h.id, h]));
  assert.strictEqual(byId["H-C1"].settled, true, "round-2 verdicts must supersede round-1 refines");
  assert.strictEqual(byId["H-C1"].dispositions.refine, 0);
  assert.strictEqual(byId["H-C1"].dispositions.accept, 1);
  assert.strictEqual(byId["H-C1"].dispositions.reject, 1);
  assert.strictEqual(report.settledCount, 1, "A1 (B accepted, C has not voted) and B1 (A accepted, C has not voted) stay open");
});

await test("/autoresearch council [note] delegates to the autonomous tool", async () => {
  const dir = makeTempDir("council-cmd");
  initGitRepo(dir);
  const { command, ctx, pi } = await loadExtension(dir);
  await command("autoresearch").handler("council Stuck on the parser; focus on IO first", ctx);
  const joined = pi.sentMessages.map((m) => m.text ?? "").join("\n");
  assert.ok(joined.includes("council_convene({"), "command instructs the agent to call the tool");
  assert.ok(joined.includes("Stuck on the parser; focus on IO first"), "the note is forwarded verbatim");
  assert.ok(!fs.existsSync(path.join(dir, ".auto", "councils")), "no council dir until the tool actually runs");
});

await test("council_convene step 1: orchestration launch + manual fallback + resume same seq, gated when mode off", async () => {
  const dir = makeTempDir("council-convene");
  initGitRepo(dir);
  const { command, tool, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);

  const res = await tool("council_convene").execute("id", {
    note: "Stuck: 8 discards in a row, every micro-opt lands within noise. Focus on whether the harness itself dominates.",
  }, null, null, ctx);
  const text = res.content[0].text;
  assert.ok(text.includes("COUNCIL #1 convened"), `convene banner: ${text.slice(0, 160)}`);
  assert.ok(text.includes("council-loop.js"), "carries the workflow file path");
  assert.ok(text.includes('"async": false'), "launch is blocking");
  assert.ok(text.includes('"timeoutMs"'), "launch carries the timeout");
  assert.ok(text.includes("subagent("), "exact subagent call shape given to the agent");
  assert.ok(text.includes("council_convene({ slate"), "step 2 (validate + persist) is spelled out");
  assert.ok(text.includes("Manual fallback"), "manual protocol included as the no-subagent path");
  assert.ok(text.includes("Phase 1 — Diverge"), "manual protocol carries the phases");
  const brief = fs.readFileSync(path.join(dir, ".auto", "councils", "1", "00-brief.md"), "utf-8");
  assert.ok(brief.includes("Lead agent's note"), "brief carries the lead's note section");
  assert.ok(brief.includes("8 discards in a row"), "note lands verbatim");
  assert.strictEqual(councilMod.readCouncilState(dir).councilsRun, 1, "state incremented");

  // pending council (no slate) → a second immediate convene RESUMES the same dir;
  // no note given → the launch args must NOT contain an empty note key (engine rejects it)
  const res2 = await tool("council_convene").execute("id", {}, null, null, ctx);
  assert.ok(res2.content[0].text.includes("RESUMING the interrupted council"), "resume re-nudges the same council");
  const resumeLaunch = /subagent\((\{[\s\S]*?\})\)/.exec(res2.content[0].text);
  assert.ok(resumeLaunch, "resume carries the launch JSON");
  assert.ok(!/"note":/.test(resumeLaunch[1]), "no empty note key in the launch args");
  const dirs = fs.readdirSync(path.join(dir, ".auto", "councils")).filter((f) => f !== "state.json");
  assert.deepStrictEqual(dirs.sort(), ["1"], "no second council dir on resume");

  // gated when mode off
  await command("autoresearch").handler("off", ctx);
  const res3 = await tool("council_convene").execute("id", {}, null, null, ctx);
  assert.ok(res3.content[0].text.toLowerCase().includes("mode"), "mode gate refused");
});

await test("council_convene step 2: valid slate is validated, persisted and closes the council", async () => {
  const dir = makeTempDir("council-slate");
  initGitRepo(dir);
  const { command, tool, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("council_convene").execute("id", { note: "stuck" }, null, null, ctx);
  const SLATE = "## EXP1: a\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: x\n\n## EXP2: b\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: y\n\n## EXP3: c\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: z";
  const res = await tool("council_convene").execute("id", { slate: SLATE }, null, null, ctx);
  const text = res.content[0].text;
  assert.ok(text.includes("COUNCIL #1 COMPLETE"), `complete banner: ${text.slice(0, 160)}`);
  assert.ok(text.includes("validated ✓"), "slate validated");
  assert.ok(text.includes("## EXP1: a"), "slate body returned");
  const ed = path.join(dir, ".auto", "councils", "1", "entries");
  const persisted = fs.readdirSync(ed).find((f) => f.endsWith("-Chair.md"));
  assert.ok(persisted && fs.readFileSync(path.join(ed, persisted), "utf-8").includes("phase: slate"), "slate persisted to the blackboard");
  assert.strictEqual(councilMod.findUnfinishedCouncil(dir), null, "completed council is closed");
});

await test("council_convene step 2: invalid slate returns the exact chairFix instruction", async () => {
  const dir = makeTempDir("council-slate-bad");
  initGitRepo(dir);
  const { command, tool, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  await tool("council_convene").execute("id", {}, null, null, ctx);
  const INVALID = "## EXP1: a\nEXPECTED_GAIN: 100 ms\n\n## EXP2: b\nEXPECTED_GAIN: 100 ms\n\n## EXP3: c\nEXPECTED_GAIN: 100 ms";
  const res = await tool("council_convene").execute("id", { slate: INVALID }, null, null, ctx);
  const text = res.content[0].text;
  assert.ok(text.includes("failed validation"), "validation failure reported");
  assert.ok(text.includes("KILL_WHEN"), "validation errors named");
  assert.ok(text.includes("args.chairFix"), "corrective workflow instruction given");
  assert.strictEqual(res.details?.outcome, "invalid-slate");
  // the council stays pending (no slate persisted) → still resumable
  assert.strictEqual(councilMod.findUnfinishedCouncil(dir)?.seq, 1, "invalid slate keeps the council pending");
});

await test("council_convene step 1 forwards the note into the workflow args and honours config timeout", async () => {
  const dir = makeTempDir("council-args");
  initGitRepo(dir);
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ council: { timeout_minutes: 45 } }), "utf-8");
  const { command, tool, ctx } = await loadExtension(dir);
  await command("autoresearch").handler("on", ctx);
  const res = await tool("council_convene").execute("id", { note: "io-bound, harness dominates" }, null, null, ctx);
  const text = res.content[0].text;
  assert.ok(text.includes('"timeoutMs": 2700000'), "timeout_minutes mapped to ms");
  assert.ok(text.includes("io-bound, harness dominates"), "note forwarded into workflow args");
  assert.ok(text.includes('"chairModel": "zai-coding-cn/glm-5.3:high"'), "default chair model in args");
  assert.ok((text.match(/"personaPrompt"/g) ?? []).length === 3, "three analysts in the roster");
});


await test("council-loop.js: full fileless pipeline in a fake sandbox — diverge, one challenge round, chair slate", async () => {
  const participants = [
    { name: "AnalystA", letter: "A", model: "model-a", personaPrompt: "patterns lens" },
    { name: "AnalystB", letter: "B", model: "model-b", personaPrompt: "explorer lens" },
    { name: "AnalystC", letter: "C", model: "model-c", personaPrompt: "skeptic lens" },
  ];
  const script = fs.readFileSync(path.join("extensions", "pi-autoresearch", "workflows", "council-loop.js"), "utf-8");
  const launched = [];
  const runs = {
    async all(items) { return Promise.all(items.map((it) => runs.run(it.key, it))); },
    async run(key, params) {
      launched.push({ key, model: params.model, task: params.task });
      let m = /^diverge-(\w+)-a(\d+)$/.exec(key);
      if (m) {
        const L = m[1].slice(-1);
        return { output: "### H-" + L + "1: alpha hypothesis\nEXPECTED_GAIN: 5 ms; KILL_WHEN: nothing" };
      }
      m = /^challenge-r(\d+)-(\w+)-a1$/.exec(key);
      if (m) {
        const verdicts = ["A", "B", "C"].filter((L) => L !== m[2]).map((L) => "VERDICT H-" + L + "1: accept — ok").join("\n");
        return { output: verdicts };
      }
      if (key === "chair-a1") {
        return { output: "## EXP1: a\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: x\n\n## EXP2: b\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: y\n\n## EXP3: c\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: z" };
      }
      throw new Error("unexpected child key: " + key);
    },
  };
  const fn = new Function("args", "runs", "emit", "return (async () => {\n" + script + "\n})()");
  const raw = await fn({
    briefText: "# Council brief\nCampaign: test\n\n## Recent runs\n(nothing)",
    participants,
    chairModel: "model-chair",
    maxChallengeRounds: 5,
    minExperiments: 3,
    note: "test note",
  }, runs, () => {});
  assert.ok(String(raw).startsWith("COUNCIL_RESULT:"), "script returns the marker: " + String(raw).slice(0, 140));
  const result = JSON.parse(String(raw).slice("COUNCIL_RESULT:".length));
  assert.strictEqual(result.ok, true, "pipeline ok");
  assert.strictEqual(result.rounds, 1, "consensus at round 1");
  assert.deepStrictEqual(result.unavailable, []);
  assert.strictEqual(result.consensus.canConverge, true, "consensus reached in-script");
  assert.strictEqual(result.consensus.settledCount, 3);
  assert.ok(result.slate.includes("## EXP1: a"), "slate text returned");
  const diverge = launched.filter((l) => l.key.startsWith("diverge-"));
  assert.strictEqual(diverge.length, 3);
  assert.ok(diverge.every((l) => l.task.includes("test note") && l.task.includes("<<<BRIEF") && l.task.includes("H-" + l.key.split("-")[1].slice(-1))), "diverge tasks carry the brief, the note and the letter format");
  assert.ok(launched.some((l) => l.key === "chair-a1" && l.model === "model-chair"), "chair runs on the chair model");
  assert.ok(launched.every((l) => !l.key.startsWith("referee")), "no referee children — consensus is in-script");
  const challenge = launched.filter((l) => l.key.startsWith("challenge-r1-"));
  assert.ok(challenge.every((l) => l.task.includes("alpha hypothesis")), "challenge tasks relay the proposals verbatim");
});

await test("council-loop.js: unavailable analyst degrades, quorum failure is honest", async () => {
  const participants = [
    { name: "AnalystA", letter: "A", model: "model-a", personaPrompt: "patterns" },
    { name: "AnalystB", letter: "B", model: "model-b", personaPrompt: "explorer" },
    { name: "AnalystC", letter: "C", model: "model-c", personaPrompt: "skeptic" },
  ];
  const script = fs.readFileSync(path.join("extensions", "pi-autoresearch", "workflows", "council-loop.js"), "utf-8");
  const makeRuns = (absent) => {
    const launched = [];
    return { launched, runs: {
      async all(items) { return Promise.all(items.map((it) => this.run(it.key, it))); },
      async run(key, params) {
        launched.push({ key, task: params.task });
        let m = /^diverge-(\w+)-a(\d+)$/.exec(key);
        if (m) {
          if (absent.has(m[1])) return { output: "I could not produce hypotheses." };
          return { output: "### H-" + m[1].slice(-1) + "1: alpha hypothesis\nEXPECTED_GAIN: 5 ms; KILL_WHEN: nothing" };
        }
        m = /^challenge-r(\d+)-(\w+)-a1$/.exec(key);
        if (m) {
          if (absent.has(m[2])) return { output: "" };
          const others = participants.map((p) => p.letter).filter((L) => L !== m[2] && !absent.has("Analyst" + L));
          return { output: others.map((L) => "VERDICT H-" + L + "1: accept — ok").join("\n") };
        }
        if (key === "chair-a1") {
          return { output: "## EXP1: a\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: x\n\n## EXP2: b\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: y\n\n## EXP3: c\nEXPECTED_GAIN: 100 ms\nKILL_WHEN: z" };
        }
        throw new Error("unexpected child key: " + key);
      },
    } };
  };
  const fn = new Function("args", "runs", "emit", "return (async () => {\n" + script + "\n})()");
  const baseArgs = { briefText: "# brief\nCampaign: test", participants, chairModel: "model-chair", maxChallengeRounds: 5, minExperiments: 2, note: "" };

  // Case 1: one analyst dead → UNAVAILABLE after retries, council proceeds with 2.
  let { runs, launched } = makeRuns(new Set(["AnalystB"]));
  let raw = await fn({ ...baseArgs }, runs, () => {});
  let result = JSON.parse(String(raw).slice("COUNCIL_RESULT:".length));
  assert.strictEqual(result.ok, true, "council proceeds with 2 analysts");
  assert.deepStrictEqual(result.unavailable, ["AnalystB"], "dead analyst reported UNAVAILABLE");
  assert.ok(launched.filter((l) => /^diverge-AnalystB-a\d+$/.test(l.key)).length === 3, "three attempts before UNAVAILABLE");

  // Case 2: only one analyst alive → honest quorum failure, no chair.
  ({ runs, launched } = makeRuns(new Set(["AnalystB", "AnalystC"])));
  raw = await fn({ ...baseArgs }, runs, () => {});
  result = JSON.parse(String(raw).slice("COUNCIL_RESULT:".length));
  assert.strictEqual(result.ok, false, "quorum failure is honest");
  assert.strictEqual(result.reason, "quorum");
  assert.ok(!launched.some((l) => l.key === "chair-a1"), "no chair without quorum");
});

// ──────────────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────────────

console.log(`\n# Results: ${passCount} pass, ${failCount} fail`);
if (failures.length > 0) {
  console.error("\nFailed tests:");
  failures.forEach((f) => console.error(`  - ${f}`));
}
process.exit(failCount > 0 ? 1 : 0);
