import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHarness } from "./fake-pi.ts";
import { createBugfixModeTool } from "../extensions/pi-autoresearch/bugfix-mode-tool.ts";
import { dirtyTreeProblem } from "../extensions/pi-autoresearch/bugfix-mode-tool.ts";
import { DECISIONS_FILE, EVIDENCE_FILE, readRows } from "../extensions/pi-autoresearch/bugfix-mode-store.ts";
import { evaluateCredit } from "../extensions/pi-autoresearch/bugfix-mode.ts";

function tempRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-tool-${label}-`));
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["tag", "defect-state"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "fixed.txt"), "fixed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "fixed"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["tag", "fixed-state"], { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "counter.txt"), "counter\n");
  fs.rmSync(path.join(dir, "fixed.txt"), { force: true });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "counterfactual"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["tag", "counterfactual-state"], { cwd: dir, stdio: "pipe" });
  return dir;
}

const config = {
  name: "bugfix",
  testCommand: "node tap.cjs",
  testIdCommand: "test -f {test}",
  proofCommands: {
    good: "git rev-parse HEAD",
    defect: "git rev-parse HEAD; exit 1",
    fixed: "git rev-parse HEAD; echo regression.test",
    counterfactual: "git rev-parse HEAD; echo regression.test; exit 1",
  },
  scopePaths: ["src"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

test("dirty-tree guard preserves pre-existing changes including ignored files", () => {
  assert.equal(dirtyTreeProblem("!! .auto/\n"), null);
  const problem = dirtyTreeProblem(" M src/a.ts\n!! notes/output.bin\n!! .auto/\n");
  assert.match(problem, /src\/a\.ts/);
  assert.match(problem, /notes\/output\.bin/);
});

test("bugfix_mode prepares isolated campaign, executes proofs and gates decisions", async () => {
  const dir = tempRepo("flow");
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "bugfix-tool-flow" });
  await command("autoresearch").handler("on", ctx);
  const bugfix = tool("bugfix_mode");
  assert.ok(bugfix, "bugfix_mode tool was not registered");

  const prepared = await bugfix.execute("prepare-1", {
    action: "prepare", campaignId: "campaign1", config,
  }, null, null, ctx);
  assert.doesNotMatch(prepared.content[0].text, /❌/);
  assert.ok(fs.existsSync(path.join(dir, ".auto", "bugfix", "campaign1", "config.json")));
  assert.equal(fs.existsSync(path.join(dir, ".auto", "measure.sh")), false);

  const duplicate = await bugfix.execute("prepare-2", {
    action: "prepare", campaignId: "campaign1", config,
  }, null, null, ctx);
  assert.equal(duplicate.details.reason, "campaign_exists");

  const noProof = await bugfix.execute("decide-1", {
    action: "decide", campaignId: "campaign1", experimentId: "e1", status: "keep",
  }, null, null, ctx);
  assert.equal(noProof.details.reason, "proof_missing");

  const recorded = await bugfix.execute("record-1", {
    action: "record", campaignId: "campaign1", experimentId: "e1",
    defectId: "P1:bug", severity: "P1",
    stateIds: { defect: "defect-state", fixed: "fixed-state", counterfactual: "counterfactual-state" },
    proofTests: ["fixed.txt", "imaginary.test"],
    // Per-record commands are ignored: the campaign config owns the proof contract.
    commands: { defect: "node -e \"process.exit(0)\"" },
  }, null, null, ctx);
  assert.equal(recorded.details.valid, true);
  assert.deepEqual(recorded.details.exitCodes, [1, 0, 1]);
  const evidenceRows = readRows(dir, "campaign1", EVIDENCE_FILE);
  assert.equal(evidenceRows.length, 1);
  assert.deepEqual(Object.keys(evidenceRows[0].stateRefs).sort(), ["counterfactual", "defect", "fixed"]);
  const refs = evidenceRows[0].stateRefs;
  assert.equal(new Set(Object.values(refs)).size, 3, "states must be distinct commits");
  for (const check of evidenceRows[0].checks) {
    assert.ok(check.output.includes(refs[check.name]), `check ${check.name} did not run in its claimed state`);
  assert.deepEqual(evidenceRows[0].proofTests, ["fixed.txt"], "unsubstantiated test ids must be dropped");
  }

  const decided = await bugfix.execute("decide-2", {
    action: "decide", campaignId: "campaign1", experimentId: "e1", status: "keep",
  }, null, null, ctx);
  assert.equal(decided.details.status, "keep");
  assert.equal(readRows(dir, "campaign1", DECISIONS_FILE).length, 1);

  const evidence = readRows(dir, "campaign1", EVIDENCE_FILE);
  assert.equal(evaluateCredit(evidence, readRows(dir, "campaign1", DECISIONS_FILE)).creditedExperiments.length, 1);

  const unresolved = await bugfix.execute("record-unresolved", {
    action: "record", campaignId: "campaign1", experimentId: "e-bad",
    defectId: "P1:other", severity: "P1",
    stateIds: { defect: "no-such-ref", fixed: "fixed-state", counterfactual: "counterfactual-state" },
  }, null, null, ctx);
  assert.equal(unresolved.details.reason, "state_unresolved");
  assert.equal(readRows(dir, "campaign1", EVIDENCE_FILE).length, 1);

  const discarded = await bugfix.execute("decide-3", {
    action: "decide", campaignId: "campaign1", experimentId: "e2", status: "discard",
  }, null, null, ctx);
  assert.equal(discarded.details.status, "discard");
  const credit = evaluateCredit(evidence, readRows(dir, "campaign1", DECISIONS_FILE));
  assert.equal(credit.invalidKeepCount, 0);
  assert.equal(credit.creditedExperiments.length, 1);

  const removedAction = await bugfix.execute("continue-1", {
    action: "continue", campaignId: "campaign1",
  }, null, null, ctx);
  assert.equal(removedAction.details.reason, "invalid_action");
});

test("checkout and prune failures block evidence and leave no worktree behind", async () => {
  const dir = tempRepo("failure-injection");
  const makeTool = (mode) => createBugfixModeTool({
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
      const bad = (stderr = "") => ({ stdout: "", stderr, code: 1, killed: false });
      if (command.startsWith("git status")) return ok();
      if (command.startsWith("git rev-parse --verify")) return ok(`${mode.branch}${mode.branch}\n`);
      if (command.startsWith("git worktree add")) {
        const target = command.match(/"([^"]+)"/)[1];
        fs.mkdirSync(target, { recursive: true });
        mode.addedPaths.push(target);
        return mode.partialAdd ? bad("simulated partial add") : ok();
      }
      if (command.startsWith("git worktree remove")) return mode.removeFails ? bad("simulated remove failure") : ok();
      if (command.startsWith("git worktree prune")) return mode.pruneFails ? bad("simulated prune failure") : ok();
      if (command.includes("process.exit(1)")) return bad();
      return ok();
    },
    scorerFilePaths: [],
    measureCliPath: "node measure.ts",
  });

  for (const mode of [
    { branch: "a", partialAdd: true, removeFails: false, pruneFails: false, expected: "state_checkout_failed" },
    { branch: "b", partialAdd: false, removeFails: true, pruneFails: true, expected: "cleanup_failed" },
  ]) {
    mode.addedPaths = [];
    const tool = makeTool(mode);
    const campaignId = `campaign-${mode.branch}`;
    const prepared = await tool.execute("prepare", {
      action: "prepare", campaignId, config: { ...config, proofCommands: {
        good: "node -e \"process.exit(0)\"",
        defect: "node -e \"process.exit(1)\"",
        fixed: "node -e \"process.exit(0)\"",
        counterfactual: "node -e \"process.exit(1)\"",
      } },
    }, null, null, { cwd: dir });
    assert.doesNotMatch(prepared.content[0].text, /❌/);
    const recorded = await tool.execute("record", {
      action: "record", campaignId, experimentId: `e-${mode.branch}`,
      defectId: `P1:${mode.branch}`, severity: "P1",
      stateIds: { defect: "defect-state", fixed: "fixed-state", counterfactual: "counterfactual-state" },
    }, null, null, { cwd: dir });
    assert.equal(recorded.details.reason, mode.expected);
    assert.equal(fs.existsSync(path.join(dir, ".auto", "bugfix", campaignId, EVIDENCE_FILE)), false);
    for (const target of mode.addedPaths) assert.equal(fs.existsSync(target), false, `worktree leaked at ${target}`);
  }
});

test("prepare refuses a dirty working tree instead of including foreign changes", async () => {
  const dir = tempRepo("dirty");
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "bugfix-tool-dirty" });
  await command("autoresearch").handler("on", ctx);
  const bugfix = tool("bugfix_mode");
  fs.writeFileSync(path.join(dir, "foreign.txt"), "do not touch\n");
  const result = await bugfix.execute("prepare-dirty", {
    action: "prepare", campaignId: "campaign1", config,
  }, null, null, ctx);
  assert.equal(result.details.reason, "dirty_tree");
  assert.ok(fs.existsSync(path.join(dir, "foreign.txt")));
});

test("discovery phase records two executed checks and credits N at decision", async () => {
  const dir = tempRepo("discovery");
  const { tool, command, ctx } = await createHarness({ dir, sessionId: "bugfix-tool-discovery" });
  await command("autoresearch").handler("on", ctx);
  const bugfix = tool("bugfix_mode");
  const discoverConfig = {
    ...config,
    proofCommands: {
      ...config.proofCommands,
      good: "git rev-parse HEAD",
      defect: "git rev-parse HEAD; exit 1",
    },
  };
  const prepared = await bugfix.execute("prepare-discovery", {
    action: "prepare", campaignId: "campaign1", config: discoverConfig,
  }, null, null, ctx);
  assert.doesNotMatch(prepared.content[0].text, /❌/);

  const recorded = await bugfix.execute("record-discovery", {
    action: "record", campaignId: "campaign1", experimentId: "e-discover",
    defectId: "P1:pbt-found", severity: "P1", phase: "discover",
    stateIds: { good: "fixed-state", defect: "defect-state" },
    detectorTests: ["fixed.txt", "imaginary.test", "imaginary.test; test -f fixed.txt"],
  }, null, null, ctx);
  assert.equal(recorded.details.valid, true);
  assert.deepEqual(recorded.details.exitCodes, [0, 1]);

  const evidenceRows = readRows(dir, "campaign1", EVIDENCE_FILE);
  assert.equal(evidenceRows.length, 1);
  assert.equal(evidenceRows[0].phase, "discover");
  assert.deepEqual(evidenceRows[0].detectorTests, ["fixed.txt"], "unsubstantiated and shell-unsafe ids must be dropped");
  assert.equal(evidenceRows[0].testChecks.length, 4, "two safe ids were executed; the shell-unsafe one was rejected");

  const decided = await bugfix.execute("decide-discovery", {
    action: "decide", campaignId: "campaign1", experimentId: "e-discover", status: "keep",
  }, null, null, ctx);
  assert.equal(decided.details.status, "keep");
  const credit = evaluateCredit(evidenceRows, readRows(dir, "campaign1", DECISIONS_FILE));
  assert.equal(credit.discoveryCount, 1);
  assert.equal(credit.fixCount, 0);
  assert.equal(credit.detectorTests, 1);
});
