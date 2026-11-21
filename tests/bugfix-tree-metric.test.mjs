import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { createBugfixModeTool } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode-tool.ts")).href
);
const { BUGFIX_METRIC_VERSION } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "bugfix-mode.ts")).href
);
const { loadTree } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "parallel", "tree.ts")).href
);

const config = {
  name: "bugfix",
  testCommand: "node tap.cjs",
  testIdCommand: "node --test {test}",
  proofCommands: { good: "good", defect: "defect", fixed: "fixed", counterfactual: "counterfactual" },
  scopePaths: ["src"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

test("preparing a bugfix campaign relabels the experiment tree metric", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-tree-metric-"));
  const treePath = path.join(dir, ".auto", "tree.json");
  fs.mkdirSync(path.dirname(treePath), { recursive: true });
  fs.writeFileSync(treePath, JSON.stringify({
    version: 1,
    rootId: "n0",
    activeNodeId: "n0",
    nextId: 1,
    baselineMetric: 0,
    direction: "higher",
    metricName: "hardening_score_v2",
    nodes: {},
    savedBranch: null,
  }), "utf8");

  const tool = createBugfixModeTool({
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
  });

  const result = await tool.execute("prepare-1", {
    action: "prepare", campaignId: "campaign1", config,
  }, null, null, { cwd: dir });
  assert.doesNotMatch(result.content[0].text, /❌/, result.content[0].text);

  const tree = loadTree(dir);
  assert.ok(tree, "tree still loads after prepare");
  assert.equal(tree.metricName, BUGFIX_METRIC_VERSION, "tree_status must report the bugfix metric, not a stale prior campaign label");
});
