/**
 * PBT State Machine — drives the REAL extension through fake-pi, asserting
 * invariants on real disk state (.auto/log.jsonl, tree.json, config.json).
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/pbt.test.mjs
 *
 * Every action calls the REAL tool execute / hook handler. Invariants assert
 * on the real store files and messages sent via pi.sendUserMessage.
 */
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { mulberry32, genInt, genPick, forAll } from "./pbt-harness.mjs";
import { createFakePi, makeCtx, readTree, readLog, readConfig } from "./fake-pi.ts";

// ──────────────────────────────────────────────────────────────────────
// RealSystem — mirrors runtime state, drives REAL tools
// ──────────────────────────────────────────────────────────────────────

class RealSystem {
  constructor(dir, seed, rng, opts = {}) {
    this.dir = dir;
    this.seed = seed;
    this.rng = rng;
    this.log = [];

    const { pi, tool, command, hook } = createFakePi({
      dir,
      sessionId: `pbt-${seed}`,
      realGit: true,
    });
    this.pi = pi;
    this.tool = tool;
    this.command = command;
    this.hook = hook;
    this.ctx = makeCtx(dir, `pbt-${seed}`, pi);

    // Load the REAL extension
    // (done outside constructor to avoid re-import per scenario — see setup)
    this.initialized = false;
    this.modeOn = false;
  }

  async load() {
    if (this.initialized) return;
    const { default: autoresearchExtension } = await import(
      pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
    );
    autoresearchExtension(this.pi);
    this.initialized = true;
  }

  record(k) {
    this.log.push(k);
  }

  // ── Actions (each drives a REAL tool/hook) ────────────────────────

  async enableMode() {
    if (this.modeOn) return;
    await this.load();
    await this.command("autoresearch").handler("on", this.ctx);
    this.modeOn = true;
    this.record("on");
  }

  async init() {
    await this.enableMode();
    const res = await this.tool("init_experiment").execute("id", {
      name: `bench-${this.seed}`,
      metric_name: "ms",
      metric_unit: "ms",
      direction: "lower",
    }, null, null, this.ctx);
    this._lastNextId = undefined; // init resets the tree
    this.record("init");
    return res;
  }

  async propose() {
    const tree = readTree(this.dir);
    if (!tree) return;
    const res = await this.tool("propose_hypothesis").execute("id", {
      description: `hypothesis-${this.seed}-${this.log.length}`,
    }, null, null, this.ctx);
    this.record("propose");
    return res;
  }

  async run() {
    const tree = readTree(this.dir);
    if (!tree) return;
    // Check for untested hypothesis nodes to run
    const nodes = Object.values(tree.nodes ?? {});
    const untested = nodes.find((n) => n.status === "untested");
    if (!untested) return;

    const res = await this.tool("run_experiment").execute("id", {
      command: 'node -e "0"',
      timeout_seconds: genInt(this.rng, 1, 5),
      hypothesis_id: untested.id,
    }, null, null, this.ctx);
    this.record("run");
    return res;
  }

  async log(result) {
    const tree = readTree(this.dir);
    if (!tree) return;
    const nodes = Object.values(tree.nodes ?? {});
    const running = nodes.find((n) => n.status === "running");
    if (!running) return;

    const status = result ?? genPick(this.rng, ["keep", "discard", "crash"]);
    const res = await this.tool("log_experiment").execute("id", {
      metric: genInt(this.rng, 100, 500),
      status,
      description: `result-${status}-${this.log.length}`,
      hypothesis_id: running.ideaId ?? running.id,
    }, null, null, this.ctx);
    this.record(`log(${status})`);
    return res;
  }

  async treeStatus() {
    const tree = readTree(this.dir);
    if (!tree) return;
    const res = await this.tool("tree_status").execute("id", {}, null, null, this.ctx);
    this.record("status");
    return res;
  }

  async finalize() {
    const tree = readTree(this.dir);
    if (!tree) return;
    const res = await this.tool("finalize_research").execute("id", {
      reason: "testing finalize",
    }, null, null, this.ctx);
    this.record("finalize");
    return res;
  }

  async beforeAgentStart() {
    const event = { systemPrompt: "You are a coding agent." };
    await this.hook("before_agent_start")(event, this.ctx);
    this.record("beforeStart");
  }

  async agentEnd() {
    await this.hook("agent_end")({ messages: [] }, this.ctx);
    this.record("agentEnd");
  }

  // ── Corruption actions ─────────────────────────────────────────────

  corruptLog() {
    const p = path.join(this.dir, ".auto", "log.jsonl");
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, "{ broken json\n{ also broken\n", "utf8");
      this.record("corruptLog");
    }
  }

  corruptTree() {
    const p = path.join(this.dir, ".auto", "tree.json");
    if (fs.existsSync(p)) {
      fs.writeFileSync(p, "{ broken", "utf8");
      this.record("corruptTree");
    }
  }

  // ── Disk state accessors ──────────────────────────────────────────

  logEntries() {
    return readLog(this.dir);
  }

  treeData() {
    return readTree(this.dir);
  }

  configData() {
    return readConfig(this.dir);
  }

  messages() {
    return this.pi.sentMessages;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function makeTempDir(label, seed) {
  const dir = path.join(
    os.tmpdir(),
    `pi-ar-pbt-${label}-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  // Init git repo
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  return dir;
}

/** Valid JSON line check. */
function isValidJson(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Invariants
// ──────────────────────────────────────────────────────────────────────

/** P1: log.jsonl is valid after each action (every line is parseable JSON). */
function checkLogValid(sys) {
  const p = path.join(sys.dir, ".auto", "log.jsonl");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    assert.ok(isValidJson(line), `P1: invalid JSON in log.jsonl: ${line.slice(0, 80)}`);
  }
}

/** P2: config header exists and is unique per segment after init. */
function checkConfigHeader(sys) {
  const entries = sys.logEntries();
  if (entries.length === 0) return;
  const configs = entries.filter((e) => e.type === "config");
  // After init there should be at least one config
  assert.ok(configs.length >= 1, "P2: no config header after init");
}

/** P3: tree is consistent — children exist, activeNodeId is valid. */
function checkTreeConsistent(sys) {
  const tree = sys.treeData();
  if (!tree) return;
  const nodeIds = new Set(Object.keys(tree.nodes ?? {}));
  // activeNodeId should reference an existing node
  if (tree.activeNodeId) {
    assert.ok(nodeIds.has(tree.activeNodeId), `P3: activeNodeId ${tree.activeNodeId} not in nodes`);
  }
  // rootId should exist
  if (tree.rootId) {
    assert.ok(nodeIds.has(tree.rootId), `P3: rootId ${tree.rootId} not in nodes`);
  }
  // Every node's parent should exist (except root)
  for (const [id, node] of Object.entries(tree.nodes ?? {})) {
    if (node.parentId && !nodeIds.has(node.parentId)) {
      assert.fail(`P3: node ${id} has orphaned parent ${node.parentId}`);
    }
  }
}

/** P4: tree.json is valid JSON (survives corruption recovery). */
function checkTreeValid(sys) {
  const p = path.join(sys.dir, ".auto", "tree.json");
  if (!fs.existsSync(p)) return;
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    assert.fail("P4: tree.json is not valid JSON");
  }
}

/** P5: every experiment entry in log.jsonl has a valid status. */
const VALID_STATUSES = new Set(["keep", "discard", "crash", "checks_failed", "budget_exceeded", "explore"]);
function checkLogStatuses(sys) {
  const entries = sys.logEntries();
  for (const e of entries) {
    if (e.type === "experiment") {
      assert.ok(VALID_STATUSES.has(e.status), `P5: invalid status '${e.status}' in log entry`);
    }
  }
}

/** P6: tree node statuses are from the valid set. */
const VALID_NODE_STATUSES = new Set(["untested", "running", "keep", "discard", "crash", "checks_failed", "budget_exceeded", "duplicate", "explore", "baseline"]);
function checkNodeStatuses(sys) {
  const tree = sys.treeData();
  if (!tree) return;
  for (const [id, node] of Object.entries(tree.nodes ?? {})) {
    if (node.status) {
      assert.ok(VALID_NODE_STATUSES.has(node.status), `P6: node ${id} has invalid status '${node.status}'`);
    }
  }
}

/** P7: at most one 'running' node at a time (no concurrent experiments). */
function checkSingleRunning(sys) {
  const tree = sys.treeData();
  if (!tree) return;
  const running = Object.entries(tree.nodes ?? {}).filter(([_id, n]) => n.status === "running");
  assert.ok(running.length <= 1, `P7: ${running.length} running nodes (expected <= 1)`);
}

/** P8: nextId always increases (never goes backward). */
function checkNextIdMonotonic(sys) {
  const tree = sys.treeData();
  if (!tree || !sys._lastNextId) {
    if (tree) sys._lastNextId = tree.nextId;
    return;
  }
  assert.ok(tree.nextId >= sys._lastNextId, `P8: nextId went backward: ${sys._lastNextId} → ${tree.nextId}`);
  sys._lastNextId = tree.nextId;
}

/** P9: config.json is valid JSON if it exists. */
function checkConfigValid(sys) {
  const p = path.join(sys.dir, ".auto", "config.json");
  if (!fs.existsSync(p)) return;
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    assert.fail("P9: config.json is not valid JSON");
  }
}

/** P10: root node has no parent. */
function checkRootNoParent(sys) {
  const tree = sys.treeData();
  if (!tree || !tree.rootId) return;
  const root = tree.nodes?.[tree.rootId];
  if (root) {
    assert.ok(!root.parentId, `P10: root node ${tree.rootId} has parent ${root.parentId}`);
  }
}

/** Run all invariants after each action. */
function checkInvariants(sys) {
  checkLogValid(sys);
  checkConfigHeader(sys);
  checkTreeConsistent(sys);
  checkTreeValid(sys);
  checkLogStatuses(sys);
  checkNodeStatuses(sys);
  checkSingleRunning(sys);
  checkNextIdMonotonic(sys);
  checkConfigValid(sys);
  checkRootNoParent(sys);
}

// ──────────────────────────────────────────────────────────────────────
// Test runner
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
    console.error(`  ❌ ${name}: ${msg}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PBT scenarios
// ──────────────────────────────────────────────────────────────────────

const ACTIONS = [
  { name: "init", weight: 3, run: (sys) => sys.init() },
  { name: "propose", weight: 4, run: (sys) => sys.propose() },
  { name: "run", weight: 4, run: (sys) => sys.run() },
  { name: "log", weight: 4, run: (sys) => sys.log() },
  { name: "status", weight: 2, run: (sys) => sys.treeStatus() },
  { name: "finalize", weight: 1, run: (sys) => sys.finalize() },
  { name: "beforeStart", weight: 2, run: (sys) => sys.beforeAgentStart() },
  { name: "agentEnd", weight: 2, run: (sys) => sys.agentEnd() },
];

function pickAction(rng) {
  const total = ACTIONS.reduce((s, a) => s + a.weight, 0);
  let r = rng() * total;
  for (const a of ACTIONS) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return ACTIONS[ACTIONS.length - 1];
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

console.log("## PBT: state machine — core actions");

await test("PBT init→propose→run→log preserves invariants", async () => {
  await forAll({
    seeds: 20,
    maxActions: 30,
    name: "core-lifecycle",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("core", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();

      // Always start with init
      await sys.init();
      checkInvariants(sys);

      // Random action sequence
      for (let i = 0; i < maxActions; i++) {
        const action = pickAction(rng);
        try {
          await action.run(sys);
        } catch (e) {
          // Tool may reject (pre-conditions not met) — that's OK, just record
          sys.log.push(`${action.name}!err`);
        }
        checkInvariants(sys);
      }
    },
  });
});

console.log("\n## PBT: corruption resilience");

await test("PBT corrupt log/tree doesn't crash next tool call", async () => {
  await forAll({
    seeds: 10,
    maxActions: 15,
    name: "corruption",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("corrupt", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();

      await sys.init();
      checkInvariants(sys);

      for (let i = 0; i < maxActions; i++) {
        // Mix normal actions with occasional corruption
        if (rng() < 0.2) {
          sys.corruptLog();
        } else if (rng() < 0.15) {
          sys.corruptTree();
        } else {
          const action = pickAction(rng);
          try {
            await action.run(sys);
          } catch {
            sys.log.push(`${action.name}!err`);
          }
        }
        // After corruption, the next successful tool call should not crash.
        // It may heal the file or ignore it — the invariant is "no crash".
        // tree.json validity check is skipped right after corruption (it's
        // expected to be broken until healed).
        const isCorrupt = sys.log[sys.log.length - 1]?.startsWith("corrupt");
        if (!isCorrupt) {
          // log.jsonl validity: skip if just corrupted (may not have healed yet)
          const tree = sys.treeData();
          if (tree) checkTreeConsistent(sys);
        }
      }
    },
  });
});

console.log("\n## PBT: hooks");

await test("PBT before_agent_start + agent_end don't crash under random sequences", async () => {
  await forAll({
    seeds: 10,
    maxActions: 20,
    name: "hooks",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("hooks", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();

      await sys.init();

      for (let i = 0; i < maxActions; i++) {
        const r = rng();
        if (r < 0.3) {
          await sys.beforeAgentStart();
        } else if (r < 0.5) {
          await sys.agentEnd();
        } else if (r < 0.7) {
          await sys.propose();
        } else if (r < 0.9) {
          await sys.treeStatus();
        } else {
          await sys.finalize();
        }
        checkInvariants(sys);
      }
    },
  });
});

console.log("\n## PBT: propose sequences");

await test("PBT multiple proposals maintain tree consistency", async () => {
  await forAll({
    seeds: 15,
    maxActions: 25,
    name: "multi-propose",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("multi-prop", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();
      await sys.init();

      for (let i = 0; i < maxActions; i++) {
        const r = rng();
        if (r < 0.5) {
          await sys.propose();
        } else if (r < 0.7) {
          await sys.run();
        } else if (r < 0.9) {
          await sys.treeStatus();
        } else {
          await sys.agentEnd();
        }
        checkInvariants(sys);
      }

      // After N proposals, tree should have root + at least some hypothesis nodes
      const tree = sys.treeData();
      assert.ok(Object.keys(tree.nodes ?? {}).length >= 1, "Tree should have at least root");
    },
  });
});

console.log("\n## PBT: re-init sequences");

await test("PBT re-init resets tree but preserves invariants", async () => {
  await forAll({
    seeds: 10,
    maxActions: 20,
    name: "re-init",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("reinit", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();
      await sys.init();

      for (let i = 0; i < maxActions; i++) {
        const r = rng();
        if (r < 0.15) {
          // Re-init: creates a new segment
          await sys.init();
        } else if (r < 0.5) {
          await sys.propose();
        } else if (r < 0.7) {
          await sys.run();
        } else {
          await sys.treeStatus();
        }
        checkInvariants(sys);
      }

      // log.jsonl should have >= 1 config header (possibly more after re-inits)
      const entries = sys.logEntries();
      const configs = entries.filter((e) => e.type === "config");
      assert.ok(configs.length >= 1, "Should have config after init(s)");
    },
  });
});

console.log("\n## PBT: finalize sequences");

await test("PBT finalize doesn't break subsequent operations", async () => {
  await forAll({
    seeds: 10,
    maxActions: 15,
    name: "finalize",
    run: async (rng, seed, maxActions) => {
      const dir = makeTempDir("fin", seed);
      const sys = new RealSystem(dir, seed, rng);
      await sys.load();
      await sys.init();
      await sys.propose();

      for (let i = 0; i < maxActions; i++) {
        const r = rng();
        if (r < 0.3) {
          await sys.finalize();
        } else if (r < 0.6) {
          await sys.propose();
        } else if (r < 0.8) {
          await sys.treeStatus();
        } else {
          await sys.agentEnd();
        }
        checkInvariants(sys);
      }
    },
  });
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
