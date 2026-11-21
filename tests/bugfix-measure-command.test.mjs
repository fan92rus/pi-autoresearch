/**
 * bugfix_mode measurement command is the only custom command allowed past
 * run_experiment's `.auto/measure.sh` guard. The guard must accept exactly the
 * command prepare() emitted for a prepared campaign and reject lookalikes.
 *
 * Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/bugfix-measure-command.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { writeStoredConfig } from "../extensions/pi-autoresearch/bugfix-mode-store.ts";
import {
  bugfixMeasureCommand,
  parseBugfixMeasureCommand,
} from "../extensions/pi-autoresearch/bugfix-mode-store.ts";

const text = (r) => r?.content?.[0]?.text ?? "";

const config = {
  campaignId: "campaign1",
  name: "bugfix",
  testCommand: "node tap.cjs",
  testIdCommand: "node --test {test}",
  proofCommands: { good: "run-good", defect: "run-defect", fixed: "run-fixed", counterfactual: "run-counterfactual" },
  scopePaths: ["src"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

function tempRepo(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-measure-cmd-${label}-`));
}

test("parse accepts exactly the prepare() command of a prepared campaign", () => {
  const dir = tempRepo("accept");
  const cli = path.resolve(os.tmpdir(), "bugfix-mode-measure.ts");
  assert.equal(writeStoredConfig(dir, "campaign1", config, {}).ok, true);
  const command = bugfixMeasureCommand(cli, "campaign1", dir);
  const parsed = parseBugfixMeasureCommand(command, cli, dir);
  assert.deepEqual(parsed, { ok: true, campaignId: "campaign1" });
});

test("parse rejects lookalike commands and unready campaigns", () => {
  const dir = tempRepo("reject");
  const cli = path.resolve(os.tmpdir(), "bugfix-mode-measure.ts");
  const command = bugfixMeasureCommand(cli, "campaign1", dir);
  assert.equal(parseBugfixMeasureCommand(command, cli, dir).ok, false, "campaign not prepared");
  assert.equal(writeStoredConfig(dir, "campaign1", config, {}).ok, true);

  const rejected = [
    `node -e "console.log('METRIC x=1')"`,
    `${command} ; node -e "console.log('evil')"`,
    command.replace("campaign1", "other"),
    bugfixMeasureCommand(path.resolve(os.tmpdir(), "other-measure.ts"), "campaign1", dir),
    bugfixMeasureCommand(cli, "campaign1", tempRepo("wrong-cwd")),
    command.replace("--experimental-strip-types", "--experimental-strip-types --eval"),
  ];
  for (const bad of rejected) {
    assert.equal(parseBugfixMeasureCommand(bad, cli, dir).ok, false, `must reject: ${bad}`);
  }
});

test("the real run_experiment accepts a prepared bugfix command despite measure.sh", async () => {
  const dir = tempRepo("integration");
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "pipe" });
  const { pi, tool, command } = createFakePi({
    dir, sessionId: `bugfix-measure-${path.basename(dir)}`, realGit: true, optimizeFixture: true,
  });
  const ctx = makeCtx(dir, `bugfix-measure-${path.basename(dir)}`, pi);
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// seeded\n");
  fs.writeFileSync(path.join(dir, "tap.cjs"), "console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0');\n");
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".auto", "measure.sh"), "#!/bin/sh\necho 'METRIC unrelated=0'\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });

  await command("autoresearch").handler("bugfix integration", ctx);
  await tool("init_experiment").execute("id", {
    name: "bugfix", metric_name: "bugfix_score_v2", metric_unit: "score", direction: "higher",
  }, null, null, ctx);
  const prepared = await tool("bugfix_mode").execute("id", { action: "prepare", campaignId: "campaign1", config }, null, null, ctx);
  assert.equal(prepared.details?.reason, undefined, text(prepared));
  const bugfixCommand = prepared.details?.command;
  assert.equal(typeof bugfixCommand, "string", "prepare returns the campaign measurement command");

  const arbitrary = await tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC x=1')"`, timeout_seconds: 30,
  }, null, null, ctx);
  assert.match(text(arbitrary), /must run it instead of a custom command/, "ordinary guard still refuses arbitrary commands");

  const run = await tool("run_experiment").execute("id", {
    command: bugfixCommand, timeout_seconds: 120,
  }, null, null, ctx);
  assert.doesNotMatch(text(run), /must run it instead of a custom command/, text(run));
  assert.equal(run.details?.parsedMetrics?.suite_exit, 0, "bugfix measurer ran through run_experiment");

  const logged = await tool("log_experiment").execute("id", {
    metric: run.details?.parsedMetrics?.bugfix_score_v2 ?? 0,
    status: "keep",
    description: "bugfix campaign measurement",
  }, null, null, ctx);
  assert.match(text(logged), /keep/, text(logged));
  const ledger = fs.readFileSync(path.join(dir, ".auto", "log.jsonl"), "utf8");
  assert.match(ledger, /bugfix campaign measurement/, "measurement is in the durable ledger");
});
