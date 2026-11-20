import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { measure } from "../extensions/pi-autoresearch/bugfix-mode-measure.ts";
import {
  appendRow,
  DECISIONS_FILE,
  EVIDENCE_FILE,
  hashMeasurementFiles,
  readRows,
  readStoredConfig,
  scorerChanged,
  writeStoredConfig,
} from "../extensions/pi-autoresearch/bugfix-mode-store.ts";

function tempRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-mode-${label}-`));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// seeded\n");
  fs.writeFileSync(path.join(dir, "tap.cjs"), "console.log('# tests 10\\n# pass 10\\n# fail 0\\n# skipped 0');\n");
  fs.writeFileSync(path.join(dir, "measured.txt"), "original\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

const config = {
  campaignId: "campaign1",
  name: "bugfix",
  testCommand: "node tap.cjs",
  proofCommands: { defect: "run-defect", fixed: "run-fixed", counterfactual: "run-counterfactual" },
  scopePaths: ["src"],
  baseRef: "HEAD",
  baselineFail: 0,
  baselineTests: 0,
};

const proof = (experimentId) => ({
  kind: "evidence",
  experimentId,
  defectId: "P1:first",
  severity: "P1",
  stateIds: { defect: "d", fixed: "f", counterfactual: "c" },
  checks: ["defect", "fixed", "counterfactual"].map((name, i) => ({
    name, command: `run-${name}`, exitCode: i === 1 ? 0 : 1, output: `out-${name}`,
  })),
});

test("campaign config is isolated and cannot be overwritten", () => {
  const dir = tempRepo("store");
  const hashes = hashMeasurementFiles(["measured.txt"], dir);
  const written = writeStoredConfig(dir, "campaign1", config, hashes);
  assert.equal(written.ok, true);
  assert.ok(fs.existsSync(path.join(dir, ".auto", "bugfix", "campaign1", "config.json")));
  assert.equal(fs.existsSync(path.join(dir, ".auto", "measure.sh")), false);
  assert.equal(writeStoredConfig(dir, "campaign1", config, hashes).ok, false);
  assert.equal(readStoredConfig(dir, "campaign1").ok, true);
  assert.equal(scorerChanged(hashes, dir), 0);
  fs.writeFileSync(path.join(dir, "measured.txt"), "tampered\n");
  assert.equal(scorerChanged(hashes, dir), 1);

  appendRow(dir, "campaign1", EVIDENCE_FILE, proof("e1"));
  fs.appendFileSync(path.join(dir, ".auto", "bugfix", "campaign1", EVIDENCE_FILE), "not json\n");
  assert.equal(readRows(dir, "campaign1", EVIDENCE_FILE).length, 1);
});

test("measurer prints durable score and fails loudly on unparseable output", () => {
  const dir = tempRepo("measure");
  const hashes = hashMeasurementFiles(["measured.txt"], dir);
  assert.equal(writeStoredConfig(dir, "campaign1", config, hashes).ok, true);
  appendRow(dir, "campaign1", EVIDENCE_FILE, proof("e1"));
  appendRow(dir, "campaign1", DECISIONS_FILE, { kind: "decision", experimentId: "e1", status: "keep" });

  const good = measure(["--campaign", "campaign1", "--cwd", dir]);
  assert.equal(good.code, 0, good.error);
  assert.ok(good.lines.includes("METRIC metric_version=bugfix_score_v1"));
  assert.ok(good.lines.includes("METRIC bugfix_score_v1=10.2"));
  assert.ok(good.lines.includes("METRIC mutation_proven_fixed=1"));

  // A pending decision is provisional: no durable credit, no score for the fix.
  const pending = tempRepo("pending");
  assert.equal(writeStoredConfig(pending, "campaign1", config, hashMeasurementFiles(["measured.txt"], pending)).ok, true);
  appendRow(pending, "campaign1", EVIDENCE_FILE, proof("e1"));
  const pendingResult = measure(["--campaign", "campaign1", "--cwd", pending]);
  assert.equal(pendingResult.code, 0);
  assert.ok(pendingResult.lines.includes("METRIC mutation_proven_fixed=0"));
  assert.ok(pendingResult.lines.includes("METRIC tentative_credit=1"));

  fs.writeFileSync(path.join(dir, "tap.cjs"), "console.log('no summary here');\n");
  const broken = measure(["--campaign", "campaign1", "--cwd", dir]);
  assert.equal(broken.code, 2);
  assert.match(broken.error, /missing TAP summary/);
});
