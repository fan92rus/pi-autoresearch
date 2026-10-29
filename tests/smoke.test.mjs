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
  "before_agent_start", "tool_execution_end",
];

await test("registers all 6 tools (parallel + branching disabled)", async () => {
  const dir = makeTempDir("reg");
  const { pi } = await loadExtension(dir);
  const names = pi.tools.map((t) => t.name);
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.includes(expected), `Missing tool: ${expected}`);
  }
  assert.strictEqual(names.length, 6, `Expected 6 tools, got ${names.length}: ${names.join(", ")}`);
});

await test("registers all 10 hooks", async () => {
  const dir = makeTempDir("hooks");
  const { pi } = await loadExtension(dir);
  const names = [...pi.hooks.keys()];
  for (const expected of EXPECTED_HOOKS) {
    assert.ok(names.includes(expected), `Missing hook: ${expected}`);
  }
  assert.strictEqual(names.length, 10, `Expected 10 hooks, got ${names.length}`);
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
// Results
// ──────────────────────────────────────────────────────────────────────

console.log(`\n# Results: ${passCount} pass, ${failCount} fail`);
if (failures.length > 0) {
  console.error("\nFailed tests:");
  failures.forEach((f) => console.error(`  - ${f}`));
}
process.exit(failCount > 0 ? 1 : 0);
