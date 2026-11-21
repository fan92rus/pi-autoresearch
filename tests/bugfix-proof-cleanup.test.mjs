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

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-proof-cleanup-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "t@e.com");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git("add", "-A"); git("commit", "-m", "init");
  return dir;
}

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

test("proof exception cleans up all registered worktrees", async () => {
  const dir = tempRepo();
  const added = [];
  const removed = [];
  let adds = 0;
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
      if (command.startsWith("git status")) return ok();
      if (command.startsWith("git rev-parse --verify")) return ok("aaaaaaaaaaaaaaaaaaaa\n");
      if (command.startsWith("git worktree add")) {
        const target = command.match(/"([^"]+)"/)[1];
        fs.mkdirSync(target, { recursive: true });
        added.push(target);
        adds += 1;
        if (adds === 2) throw new Error("injected checkout exception");
        return ok();
      }
      if (command.startsWith("git worktree remove")) {
        removed.push(command.match(/"([^"]+)"/)[1]);
        return ok();
      }
      if (command.startsWith("git worktree prune")) return ok();
      return ok();
    },
    scorerFilePaths: [], measureCliPath: "node measure.ts", isBugfixMeasureCommand: () => true,
  });
  const ctx = { cwd: dir };
  const prepared = await tool.execute("prepare", { action: "prepare", campaignId: "c1", config }, null, null, ctx);
  assert.doesNotMatch(prepared.content[0].text, /❌/);

  await assert.rejects(
    tool.execute("record", {
      action: "record", campaignId: "c1", experimentId: "e1", defectId: "P1:x", severity: "P1",
      stateIds: { defect: "aaaaaaaaaaaa", fixed: "bbbbbbbbbbbb", counterfactual: "cccccccccccc" },
    }, null, null, ctx),
    /injected checkout exception/,
  );

  assert.equal(added.length, 2);
  assert.deepEqual(removed.sort(), added.sort(), "every registered worktree must be removed even when checkout throws");
  for (const target of added) assert.equal(fs.existsSync(target), false, `worktree leaked at ${target}`);
  assert.equal(fs.existsSync(path.join(dir, ".auto", "bugfix", "c1", "evidence.jsonl")), false);
});
