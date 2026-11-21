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

const config = {
  name: "bugfix", testCommand: "node tap.cjs", testIdCommand: "test -f {test}",
  proofCommands: {
    good: "node -e \"process.exit(0)\"",
    defect: "node -e \"process.exit(1)\"",
    fixed: "node -e \"process.exit(0)\"",
    counterfactual: "node -e \"process.exit(1)\"",
  },
  scopePaths: ["src"], baseRef: "HEAD", baselineFail: 0, baselineTests: 0,
};

test("proof states must resolve to distinct commits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-distinct-states-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  const same = "aaaaaaaaaaaaaaaaaaaa\n";
  const tool = createBugfixModeTool({
    assertModeActive: () => undefined,
    validateWorkDir: () => null,
    resolveWorkDir: () => dir,
    campaignBlocksOrdinaryLoop: async () => false,
    campaignBlockedResponse: () => ({ content: [{ type: "text", text: "blocked" }], details: {} }),
    researchBlocksOrdinaryLoop: async () => false,
    researchBlockedResponse: () => ({ content: [{ type: "text", text: "blocked" }], details: {} }),
    execBashScript: async (args) => {
      const command = args[1] ?? "";
      const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });
      const bad = () => ({ stdout: "", stderr: "", code: 1, killed: false });
      if (command.startsWith("git status")) return ok();
      if (command.startsWith("git rev-parse --verify")) return ok(same);
      if (command.startsWith("git worktree add")) return ok();
      if (command.startsWith("git worktree remove")) return ok();
      if (command.startsWith("git worktree prune")) return ok();
      if (command.includes("process.exit(1)")) return bad();
      return ok();
    },
    scorerFilePaths: [], measureCliPath: "node measure.ts", isBugfixMeasureCommand: () => true,
  });
  const ctx = { cwd: dir };
  const prepared = await tool.execute("prepare", { action: "prepare", campaignId: "c1", config }, null, null, ctx);
  assert.doesNotMatch(prepared.content[0].text, /❌/);

  const recorded = await tool.execute("record", {
    action: "record", campaignId: "c1", experimentId: "e1", defectId: "P1:x", severity: "P1",
    stateIds: { defect: "same", fixed: "same", counterfactual: "same" },
  }, null, null, ctx);
  assert.equal(recorded.details.reason, "state_refs_not_distinct");
  assert.equal(fs.existsSync(path.join(dir, ".auto", "bugfix", "c1", "evidence.jsonl")), false,
    "same-commit proof must not create evidence");
});
