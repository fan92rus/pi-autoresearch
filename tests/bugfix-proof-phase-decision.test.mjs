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

const TEST_ID = "bugfixKeepRequiresProofPhase";
const config = {
  name: "bugfix", testCommand: "node tap.cjs", testIdCommand: `test-{test}`,
  proofCommands: { good: "good-command", defect: "defect-command", fixed: "fixed-command", counterfactual: "counter-command" },
  scopePaths: ["src"], baseRef: "HEAD", baselineFail: 0, baselineTests: 0,
};

function makeTool(dir) {
  const shas = {
    good: "a".repeat(20), defect: "b".repeat(20), fixed: "c".repeat(20), counterfactual: "d".repeat(20),
  };
  const bySha = Object.fromEntries(Object.entries(shas).map(([name, sha]) => [sha, name]));
  const worktreeStates = new Map();
  const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
  const bad = (stdout = "") => ({ stdout, stderr: "", code: 1, killed: false });
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
      if (command.startsWith("git worktree remove")) return ok();
      if (command.startsWith("git worktree prune")) return ok();
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
  return { tool, shas };
}

test("bugfixKeepRequiresProofPhase", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-proof-phase-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  const { tool, shas } = makeTool(dir);
  const ctx = { cwd: dir };
  const prepared = await tool.execute("prepare", { action: "prepare", campaignId: "phase", config }, null, null, ctx);
  assert.doesNotMatch(prepared.content[0].text, /❌/);

  const discovery = await tool.execute("record", {
    action: "record", campaignId: "phase", experimentId: "e1", defectId: "P1:phase", severity: "P2",
    phase: "discover", stateIds: { good: "good", defect: "defect" }, detectorTests: [TEST_ID],
  }, null, null, ctx);
  assert.equal(discovery.details.valid, true, JSON.stringify(discovery.details));
  assert.deepEqual(discovery.details.detectorTests, [TEST_ID]);

  const early = await tool.execute("decide-early", {
    action: "decide", campaignId: "phase", experimentId: "e1", status: "keep",
  }, null, null, ctx);
  assert.equal(early.details.reason, "proof_phase_required", JSON.stringify(early.details));

  const proof = await tool.execute("record-proof", {
    action: "record", campaignId: "phase", experimentId: "e1", defectId: "P1:phase", severity: "P2",
    phase: "proof", stateIds: shas, proofTests: [TEST_ID],
  }, null, null, ctx);
  assert.equal(proof.details.valid, true, JSON.stringify(proof.details));
  assert.deepEqual(proof.details.proofTests, [TEST_ID]);

  const accepted = await tool.execute("decide-proof", {
    action: "decide", campaignId: "phase", experimentId: "e1", status: "keep",
  }, null, null, ctx);
  assert.equal(accepted.details.status, "keep", JSON.stringify(accepted.details));
});
