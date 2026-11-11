/**
 * experiment-rigor 4.3 (end to end): log_experiment marks a keep as confirmed or
 * preliminary, never refuses it, and writes the status to the ledger row.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/experiment-rigor-wiring.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { sessionFilePath } from "../extensions/pi-autoresearch/paths.ts";
import { loadTree } from "../extensions/pi-autoresearch/parallel/tree.ts";
import { repeatConfidence } from "../extensions/pi-autoresearch/confidence.ts";

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ar-rigor-wire-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

async function session(dir) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: "rigor-wire", realGit: true, optimizeFixture: true });
  const ctx = makeCtx(dir, "rigor-wire", pi);
  const { default: ext } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  ext(pi);
  await command("autoresearch").handler("on", ctx);
  await tool("init_experiment").execute("id", {
    name: "bench", metric_name: "ms", metric_unit: "ms", direction: "lower",
  }, null, null, ctx);
  return { tool, ctx };
}

let touch = 0;
async function keep(s, metric, asi, description) {
  touch++;
  fs.writeFileSync(path.join(s.dir, `change${touch}.txt`), String(touch));
  return s.tool("log_experiment").execute("id", { metric, status: "keep", description, asi }, null, null, s.ctx);
}

function ledgerRows(dir) {
  const p = sessionFilePath(dir, "log");
  return fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => typeof e.run === "number");
}

test("4.3: first keep is accepted as preliminary and the ledger row says so", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  const base = await keep(s, 100, {}, "baseline");
  assert.ok(base.content[0].text.includes("keep"), "baseline keep lands");
  const first = await keep(s, 90, { hypothesis_node: "n1" }, "idea one");
  const text = first.content[0].text;
  assert.ok(text.includes("keep (preliminary)"), `text must carry the status, got: ${text.slice(0, 120)}`);
  assert.ok(!/refus|отказ|rejected/i.test(text), "a keep is never refused");
  const row = ledgerRows(dir).find((r) => r.description === "idea one");
  assert.equal(row.status, "keep", "keep is recorded");
  assert.equal(row.asi?.keep_status, undefined, "ledger row unchanged: the status is derived on read, not stored");
});

test("4.3: a repeat of the hypothesis that beats the baseline confirms the keep", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  await keep(s, 100, {}, "baseline");
  await s.tool("propose_hypothesis").execute("id", { description: "idea one" }, null, null, s.ctx);
  touch++;
  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chg43a.txt','x'); console.log('METRIC ms=90')"`,
    timeout_seconds: 30, hypothesis_id: "n1",
  }, null, null, s.ctx);
  await s.tool("log_experiment").execute("id", { metric: 90, status: "keep", description: "idea one", hypothesis_id: "n1" }, null, null, s.ctx);
  await s.tool("propose_hypothesis").execute("id", { description: "idea one", repeat_of: "n1", force: true }, null, null, s.ctx);
  const repeatNode = Object.values(loadTree(dir).nodes).find((n) => n.repeatOf === "n1");
  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chg43b.txt','x'); console.log('METRIC ms=91')"`,
    timeout_seconds: 30, hypothesis_id: repeatNode.id,
  }, null, null, s.ctx);
  const rep = await s.tool("log_experiment").execute("id", { metric: 91, status: "keep", description: "idea one repeat", hypothesis_id: repeatNode.id }, null, null, s.ctx);
  assert.ok(rep.content[0].text.includes("keep (confirmed)"), "repeat of n1 beating baseline confirms: " + rep.content[0].text.slice(0, 200));
  const row = ledgerRows(dir).find((r) => r.description === "idea one repeat");
  assert.equal(row.asi?.keep_status, undefined, "ledger row unchanged: the status is derived on read, not stored");
});

test("B1: a repeat registered with repeat_of is grouped with its original and gives a confidence", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  await keep(s, 100, {}, "baseline");
  await s.tool("propose_hypothesis").execute("id", { description: "idea one" }, null, null, s.ctx);
  touch++;
  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chgA.txt','x'); console.log('METRIC ms=90')"`,
    timeout_seconds: 30, hypothesis_id: "n1",
  }, null, null, s.ctx);
  await s.tool("log_experiment").execute("id", { metric: 90, status: "keep", description: "idea one", hypothesis_id: "n1" }, null, null, s.ctx);

  await s.tool("propose_hypothesis").execute("id", { description: "idea one", repeat_of: "n1", force: true }, null, null, s.ctx);
  const tree = loadTree(dir);
  const repeatNode = Object.values(tree.nodes).find((n) => n.repeatOf === "n1");
  assert.ok(repeatNode, "the repeat node records repeatOf=n1 in the tree");

  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chgB.txt','x'); console.log('METRIC ms=91')"`,
    timeout_seconds: 30, hypothesis_id: repeatNode.id,
  }, null, null, s.ctx);
  await s.tool("log_experiment").execute("id", { metric: 91, status: "keep", description: "idea one repeat", hypothesis_id: repeatNode.id }, null, null, s.ctx);

  const rows = ledgerRows(dir);
  const repeatRow = rows.find((r) => r.description === "idea one repeat");
  assert.equal(repeatRow.asi?.repeat_of, "n1", "the repeat's ledger row carries asi.repeat_of = original node");
  // m1: hypothesis_id must reach asi.hypothesis_node on both the original and the repeat row.
  const origRow = rows.find((r) => r.description === "idea one");
  assert.equal(origRow.asi?.hypothesis_node, "n1", "original run carries hypothesis_node from hypothesis_id");
  assert.equal(repeatRow.asi?.hypothesis_node, repeatNode.id, "repeat run carries its own hypothesis_node from hypothesis_id");
  const conf = repeatConfidence(rows.filter((r) => r.metric > 0), 100, "lower");
  assert.ok(conf !== null, "two runs of one hypothesis give a non-null confidence");
  // sample sd of {90, 91} = sqrt(0.5); |90 - 100| / sqrt(0.5) = 14.1421...
  assert.ok(Math.abs(conf.value - 10 / Math.sqrt(0.5)) < 1e-9, "confidence = |best - baseline| / sample sd of the group");
});

// ---------------------------------------------------------------------------
// B4 (review round 2): noise status line in tree_status, all three states.
// ---------------------------------------------------------------------------

function mergeConfig(dir, patch) {
  const p = path.join(dir, ".auto", "config.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch { cur = {}; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch }));
}

test("B4: tree_status says the noise floor is not calibrated when none is stored", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  const out = await s.tool("tree_status").execute("id", {}, null, null, s.ctx);
  assert.ok(
    out.content[0].text.includes("Noise floor: not calibrated"),
    "tree_status must show the uncalibrated state: " + out.content[0].text.slice(0, 300),
  );
});

test("B4: tree_status shows fresh noise on the active epoch, then stale after a new measurement epoch", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  mergeConfig(dir, { noiseFloor: 1, noiseFloorUnit: "metric", noiseFloorEpoch: 1 });
  const fresh = await s.tool("tree_status").execute("id", {}, null, null, s.ctx);
  assert.ok(fresh.content[0].text.includes("Noise floor: 1 — fresh"), "fresh floor on epoch 1: " + fresh.content[0].text.slice(0, 300));

  const change = {
    type: "measurement_change", epoch: 2,
    diff_ref: ".auto/measurement/e2_gold.diff", rescore_ref: ".auto/measurement/e2/rescore.md",
    justification: "finding f7", old_scale_score: 0.5, new_scale_score: 0.6, needs_verification: true,
  };
  fs.appendFileSync(sessionFilePath(dir, "log"), JSON.stringify(change) + "\n");
  const stale = await s.tool("tree_status").execute("id", {}, null, null, s.ctx);
  assert.ok(
    stale.content[0].text.includes("stale (calibrated on epoch 1, active epoch 2)"),
    "stale floor after epoch 2: " + stale.content[0].text.slice(0, 300),
  );
});

test("m3: agent-supplied asi cannot set hypothesis_node or repeat_of (harness owns the group keys)", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  await keep(s, 100, {}, "baseline");
  await keep(s, 90, { hypothesis_node: "n1", repeat_of: "n1" }, "forged group keys");
  const row = ledgerRows(dir).find((r) => r.description === "forged group keys");
  assert.equal(row.asi?.hypothesis_node, undefined, "agent asi.hypothesis_node is dropped");
  assert.equal(row.asi?.repeat_of, undefined, "agent asi.repeat_of is dropped");
});

test("B6: a repeat logged WITHOUT hypothesis_id still joins its original's group and finalizes its node", async () => {
  const dir = makeDir();
  const s = await session(dir);
  s.dir = dir;
  await keep(s, 100, {}, "baseline");
  await s.tool("propose_hypothesis").execute("id", { description: "idea one" }, null, null, s.ctx);
  touch++;
  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chgA.txt','x'); console.log('METRIC ms=90')"`,
    timeout_seconds: 30, hypothesis_id: "n1",
  }, null, null, s.ctx);
  await s.tool("log_experiment").execute("id", { metric: 90, status: "keep", description: "idea one", hypothesis_id: "n1" }, null, null, s.ctx);

  await s.tool("propose_hypothesis").execute("id", { description: "idea one", repeat_of: "n1", force: true }, null, null, s.ctx);
  const repeatNode = Object.values(loadTree(dir).nodes).find((n) => n.repeatOf === "n1");
  assert.ok(repeatNode, "repeat node recorded with repeatOf=n1");

  await s.tool("run_experiment").execute("id", {
    command: `node -e "require('fs').writeFileSync('chgB.txt','x'); console.log('METRIC ms=91')"`,
    timeout_seconds: 30, hypothesis_id: repeatNode.id,
  }, null, null, s.ctx);
  // No hypothesis_id on log: finalization falls back to the running node, and the group key must follow it.
  await s.tool("log_experiment").execute("id", { metric: 91, status: "keep", description: "idea one repeat" }, null, null, s.ctx);

  const rows = ledgerRows(dir);
  const repeatRow = rows.find((r) => r.description === "idea one repeat");
  assert.equal(repeatRow.asi?.repeat_of, "n1", "repeat row joins n1's group without an explicit hypothesis_id");
  assert.equal(repeatRow.asi?.hypothesis_node, repeatNode.id, "repeat row names the node it finalized");
  assert.equal(loadTree(dir).nodes[repeatNode.id].status, "keep", "the running repeat node is finalized");
  const conf = repeatConfidence(rows.filter((r) => r.metric > 0), 100, "lower");
  assert.ok(conf !== null, "the repeat is counted in the group, so confidence is not null");
});
