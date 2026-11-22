import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const { measure } = await import(
  new URL("../extensions/pi-autoresearch/bugfix-mode-measure.ts", import.meta.url).href
);
const {
  appendRow, DECISIONS_FILE, EVIDENCE_FILE, hashMeasurementFiles,
  readRowsStrict, writeStoredConfig,
} = await import(
  new URL("../extensions/pi-autoresearch/bugfix-mode-store.ts", import.meta.url).href
);

const config = {
  campaignId: "campaign1", name: "bugfix", testCommand: "node tap.cjs",
  testIdCommand: "node --test {test}",
  proofCommands: { good: "run-good", defect: "run-defect", fixed: "run-fixed", counterfactual: "run-counterfactual" },
  scopePaths: ["src"], baseRef: "HEAD", baselineFail: 0, baselineTests: 0,
};

const proof = (experimentId) => ({
  kind: "evidence", experimentId, defectId: "P1:corrupt", severity: "P1",
  stateIds: { defect: "d", fixed: "f", counterfactual: "c" },
  checks: ["defect", "fixed", "counterfactual"].map((name, i) => ({
    name, command: `run-${name}`, exitCode: i === 1 ? 0 : 1, output: `out-${name}`,
  })),
});

function tempRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-corrupt-${label}-`));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// seeded\n");
  fs.writeFileSync(path.join(dir, "tap.cjs"), `process.stdout.write(${JSON.stringify("# tests 10\n# pass 10\n# fail 0\n# skipped 0\n")});\n`);
  fs.writeFileSync(path.join(dir, "measured.txt"), "original\\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  assert.equal(writeStoredConfig(dir, "campaign1", config, hashMeasurementFiles(["measured.txt"], dir)).ok, true);
  return dir;
}

function corrupt(dir, file) {
  fs.appendFileSync(path.join(dir, ".auto", "bugfix", "campaign1", file), "not json\\n");
}

test("bugfixMeasureRefusesCorruptEvidence", () => {
  const dir = tempRepo("evidence");
  appendRow(dir, "campaign1", EVIDENCE_FILE, proof("e1"));
  appendRow(dir, "campaign1", DECISIONS_FILE, { kind: "decision", experimentId: "e1", status: "keep" });
  corrupt(dir, EVIDENCE_FILE);
  const result = measure(["--campaign", "campaign1", "--cwd", dir]);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.match(result.error ?? "", /corrupt.*evidence/i);
});

test("bugfixMeasureRefusesCorruptDecision", () => {
  const dir = tempRepo("decision");
  appendRow(dir, "campaign1", EVIDENCE_FILE, proof("e1"));
  appendRow(dir, "campaign1", DECISIONS_FILE, { kind: "decision", experimentId: "e1", status: "keep" });
  corrupt(dir, DECISIONS_FILE);
  const result = measure(["--campaign", "campaign1", "--cwd", dir]);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.match(result.error ?? "", /corrupt.*decision/i);
});

test("bugfixStrictReaderReportsLineNumber", () => {
  const dir = tempRepo("line");
  appendRow(dir, "campaign1", EVIDENCE_FILE, proof("e1"));
  corrupt(dir, EVIDENCE_FILE);
  assert.throws(
    () => readRowsStrict(dir, "campaign1", EVIDENCE_FILE),
    /line 2/,
  );
});
