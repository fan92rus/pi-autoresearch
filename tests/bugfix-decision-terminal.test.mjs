import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const { createBugfixModeTool } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode-tool.ts")).href
);
const { readRows, DECISIONS_FILE } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode-store.ts")).href
);

const config = {
  name: "bugfix", testCommand: "node tap.cjs", testIdCommand: `test-{test}`,
  proofCommands: { good: "good-command", defect: "defect-command", fixed: "fixed-command", counterfactual: "counter-command" },
  scopePaths: ["src"], baseRef: "HEAD", baselineFail: 0, baselineTests: 0,
};

const TEST_IDS = [
  "bugfixDiscardCannotBecomeKeep",
  "bugfixKeepCannotBecomeDiscard",
  "bugfixDecisionRowIsAppendedOnce",
];

function makeHarness(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-${prefix}-`));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  const shas = {
    good: "a".repeat(20), defect: "b".repeat(20), fixed: "c".repeat(20), counterfactual: "d".repeat(20),
  };
  const bySha = Object.fromEntries(Object.entries(shas).map(([name, sha]) => [sha, name]));
  const worktreeStates = new Map();
  const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
  const bad = () => ({ stdout: "", stderr: "", code: 1, killed: false });
  const tool = createBugfixModeTool({
    assertModeActive: () => undefined,
    validateWorkDir: () => null,
    resolveWorkDir: () => dir,
    campaignBlocksOrdinaryLoop: async () => false,
    campaignBlockedResponse: () => ({}),
    researchBlocksOrdinaryLoop: async () => false,
    researchBlockedResponse: () => ({}),
    execBashScript: async (args, options) => {
      const command = args[1] ?? "";
      if (command.startsWith("git status")) return ok();
      if (command.startsWith("git rev-parse --verify")) {
        const ref = (command.match(/--verify "([^"]+)"/)?.[1] ?? "").replace(/\^\{commit\}$/, "");
        return ok(`${/^[a-f0-9]{20}$/.test(ref) ? ref : shas[ref] ?? "e".repeat(20)}\n`);
      }
      if (command.startsWith("git worktree add")) {
        const match = command.match(/--detach "([^"]+)" ([a-f0-9]+)/);
        if (match) worktreeStates.set(match[1], bySha[match[2]] ?? "unknown");
        fs.mkdirSync(match?.[1] ?? path.join(dir, "missing"), { recursive: true });
        return ok();
      }
      if (command.startsWith("git worktree remove") || command.startsWith("git worktree prune")) return ok();
      const state = (options?.cwd ?? "").replace(/\\/g, "/");
      const resolved = worktreeStates.get(state) ?? "";
      if (command.startsWith("test-")) {
        return resolved === "good" || resolved === "fixed" ? ok() : bad();
      }
      if (command === "good-command" || command === "fixed-command") return ok();
      if (command === "defect-command" || command === "counter-command") return bad();
      return ok();
    },
    scorerFilePaths: [], measureCliPath: "measure.ts", isBugfixMeasureCommand: () => true,
  });
  return { dir, tool, shas, ctx: { cwd: dir } };
}

async function recordProof(h, experimentId) {
  const result = await h.tool.execute(`record-${experimentId}`, {
    action: "record", campaignId: "terminal", experimentId, defectId: `P2:${experimentId}`, severity: "P2",
    phase: "proof", stateIds: h.shas, proofTests: TEST_IDS,
  }, null, null, h.ctx);
  assert.equal(result.details.valid, true, JSON.stringify(result.details));
  assert.deepEqual(result.details.proofTests, TEST_IDS);
}

async function prepare(h) {
  const result = await h.tool.execute("prepare", { action: "prepare", campaignId: "terminal", config }, null, null, h.ctx);
  assert.doesNotMatch(result.content[0].text, /❌/);
}

test("bugfixDiscardCannotBecomeKeep", async () => {
  const h = makeHarness("terminal-discard");
  await prepare(h);
  await recordProof(h, "e-discard");
  const discarded = await h.tool.execute("discard", {
    action: "decide", campaignId: "terminal", experimentId: "e-discard", status: "discard",
  }, null, null, h.ctx);
  assert.equal(discarded.details.status, "discard", JSON.stringify(discarded.details));
  const resurrected = await h.tool.execute("resurrect", {
    action: "decide", campaignId: "terminal", experimentId: "e-discard", status: "keep",
  }, null, null, h.ctx);
  assert.equal(resurrected.details.reason, "decision_already_recorded", JSON.stringify(resurrected.details));
});

test("bugfixKeepCannotBecomeDiscard", async () => {
  const h = makeHarness("terminal-keep");
  await prepare(h);
  await recordProof(h, "e-keep");
  const kept = await h.tool.execute("keep", {
    action: "decide", campaignId: "terminal", experimentId: "e-keep", status: "keep",
  }, null, null, h.ctx);
  assert.equal(kept.details.status, "keep", JSON.stringify(kept.details));
  const revoked = await h.tool.execute("revoke", {
    action: "decide", campaignId: "terminal", experimentId: "e-keep", status: "discard",
  }, null, null, h.ctx);
  assert.equal(revoked.details.reason, "decision_already_recorded", JSON.stringify(revoked.details));
});

test("bugfixDecisionRowIsAppendedOnce", async () => {
  const h = makeHarness("terminal-once");
  await prepare(h);
  await recordProof(h, "e-once");
  for (const [id, status] of [["first", "keep"], ["second", "keep"]]) {
    await h.tool.execute(id, {
      action: "decide", campaignId: "terminal", experimentId: "e-once", status,
    }, null, null, h.ctx);
  }
  const decisions = readRows(h.dir, "terminal", DECISIONS_FILE);
  assert.equal(decisions.length, 1, "a second decision must not append another row");
  assert.equal(decisions[0].status, "keep");
});
