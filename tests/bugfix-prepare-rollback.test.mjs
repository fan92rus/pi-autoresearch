import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { createBugfixModeTool } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode-tool.ts")).href
);
const { loadTree, saveTree } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "parallel", "tree.ts")).href
);

const config = {
  name: "bugfix", testCommand: "node tap.cjs", testIdCommand: "node --test {test}",
  proofCommands: { good: "g", defect: "d", fixed: "f", counterfactual: "c" },
  scopePaths: ["src"], baseRef: "HEAD", baselineFail: 0, baselineTests: 0,
};

function makeDeps(saveExperimentTree) {
  return {
    assertModeActive: () => undefined,
    validateWorkDir: () => null,
    resolveWorkDir: (cwd) => cwd,
    campaignBlocksOrdinaryLoop: async () => false,
    campaignBlockedResponse: () => ({}),
    researchBlocksOrdinaryLoop: async () => false,
    researchBlockedResponse: () => ({}),
    execBashScript: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    scorerFilePaths: [],
    measureCliPath: "measure.ts",
    isBugfixMeasureCommand: () => true,
    saveExperimentTree,
  };
}

test("prepare rolls back campaign state when tree relabelling fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-prepare-rollback-"));
  const treePath = path.join(dir, ".auto", "tree.json");
  fs.mkdirSync(path.dirname(treePath), { recursive: true });
  fs.writeFileSync(treePath, JSON.stringify({
    version: 1, rootId: "n0", activeNodeId: "n0", nextId: 1, baselineMetric: 0,
    direction: "higher", metricName: "hardening_score_v2", nodes: {}, savedBranch: null,
  }), "utf8");

  let calls = 0;
  const failing = makeDeps((workDir, tree) => {
    calls += 1;
    if (calls === 1) throw new Error("injected saveTree failure");
    saveTree(workDir, tree);
  });
  const tool = createBugfixModeTool(failing);
  const ctx = { cwd: dir };
  const first = await tool.execute("prepare-1", { action: "prepare", campaignId: "campaign1", config }, null, null, ctx);
  assert.match(first.content[0].text, /campaign state rolled back/, first.content[0].text);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "bugfix", "campaign1", "config.json")), false,
    "partial campaign config must not survive a failed prepare");
  assert.equal(loadTree(dir).metricName, "hardening_score_v2", "tree must not be half-updated");

  const retry = await tool.execute("prepare-2", { action: "prepare", campaignId: "campaign1", config }, null, null, ctx);
  assert.doesNotMatch(retry.content[0].text, /❌/, retry.content[0].text);
  assert.equal(loadTree(dir).metricName, "bugfix_score_v2");
});
