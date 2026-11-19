// config-ui scope-split (bd pi-autoresearch-hsu) superseded by full removal
// (bd pi-autoresearch-el3.4, owner decision 2026-11-16): the /autoresearch
// parallel-* commands, their autocomplete entries, the legacy parallel skill
// and the dead parallel config API are REMOVED — not merely labeled. No
// user-facing surface may offer or name the legacy parallel flow.
//
// Run: node --experimental-strip-types --env-file=./tests/test.env --experimental-loader ./tests/redirect-loader.mjs --test tests/config-ui-scope-split.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUiPath = path.join(repoRoot, "extensions", "pi-autoresearch", "parallel", "config-ui.ts");
const configTsPath = path.join(repoRoot, "extensions", "pi-autoresearch", "parallel", "config.ts");
const indexTsPath = path.join(repoRoot, "extensions", "pi-autoresearch", "index.ts");
const commandTsPath = path.join(repoRoot, "extensions", "pi-autoresearch", "autoresearch-command.ts");
const skillPath = path.join(repoRoot, "skills", "autoresearch-parallel");
const worktreePath = path.join(repoRoot, "extensions", "pi-autoresearch", "parallel", "worktree.ts");

const REMOVED_TOOL_RE = /BestOfN|SpaceSearch|valleyProbe|CheckOrthogonal|startPhase/;
const ACTIVE_DOC_PATHS = [
  "docs/USER-GUIDE.md", "docs/AGENT-GUIDE.md",
  "docs/PRD-decision-tree.md", "docs/TZ-decision-tree.md",
];
const HISTORICAL_DOC_PATHS = ["docs/PRD.md", "docs/TZ.md"];
// Policy fields with no runtime reader left after the el3.4 removal.
const REMOVED_POLICY_FIELDS = [
  "complexityMap", "cascade", "defaultTier", "defaultComplexity",
  "workerTimeoutMs", "workerBenchMode", "finalBenchMode", "repeats",
];
// Promises that only made sense while parallel workers existed.
const REMOVED_PARALLEL_PROMISES = [
  /parallel\.ucb1C/,
  /budget_exceeded/,
  /parallel mode/i,
  /worker subagents running in parallel/i,
];

test("parallel-* subcommands are removed from autocomplete", async () => {
  const { filterSubcommands, AUTORESEARCH_SUBCOMMANDS } = await import("../extensions/pi-autoresearch/parallel/config-ui.ts");
  for (const value of ["parallel-best-of-n", "parallel-stack", "parallel-search"]) {
    assert.ok(!AUTORESEARCH_SUBCOMMANDS.some((s) => s.value === value), `${value} still offered`);
    assert.ok(!filterSubcommands(value).some((s) => s.value === value), `${value} still matches by prefix`);
  }
});

test("non-parallel completions keep their descriptions", async () => {
  const { filterSubcommands } = await import("../extensions/pi-autoresearch/parallel/config-ui.ts");
  const research = filterSubcommands("research").find((s) => s.value === "research");
  assert.ok(research);
  assert.match(research.description, /research campaign/);
  const off = filterSubcommands("off").find((s) => s.value === "off");
  assert.ok(off);
  assert.match(off.description, /off/i);
  const config = filterSubcommands("config").find((s) => s.value === "config");
  assert.ok(config, "campaign config entry survives (models, concurrency, budget policy)");
});

test("config-ui.ts user-facing strings name no removed tool", () => {
  const src = fs.readFileSync(configUiPath, "utf-8");
  const stringLiterals = src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
  for (const lit of stringLiterals) {
    if (/RU \?|title|prompt|notify|select|description/.test(src.slice(Math.max(0, src.indexOf(lit) - 200), src.indexOf(lit)))) {
      if (REMOVED_TOOL_RE.test(lit)) {
        assert.fail(`user-facing string names a removed tool: ${lit.slice(0, 80)}`);
      }
    }
  }
});

test("the legacy parallel skill is deleted and index.ts has no parallel-* dispatch", () => {
  assert.ok(!fs.existsSync(skillPath), "skills/autoresearch-parallel must not exist");
  // The command body lives in autoresearch-command.ts (extracted from index.ts);
  // scan both sources so the rejection guard is checked where it now lives.
  const indexSrc = fs.readFileSync(indexTsPath, "utf-8") + fs.readFileSync(commandTsPath, "utf-8");
  // The only allowed parallel-* reference is the explicit rejection guard:
  // it must notify "removed" and return — never dispatch or activate a mode.
  const guardAnchor = 'if (/^parallel-(best-of-n|stack|search)\\b/.test(command)) {';
  const gi = indexSrc.indexOf(guardAnchor);
  assert.ok(gi >= 0, "rejection guard for parallel-* commands expected");
  const guardBlock = indexSrc.slice(gi, indexSrc.indexOf("}", gi));
  assert.match(guardBlock, /were removed/, "guard must explain the removal");
  assert.match(guardBlock, /return;/, "guard must return");
  assert.ok(!indexSrc.includes("parallelMatch"), "legacy dispatch machinery still present");
  assert.ok(!indexSrc.includes("autoresearch-parallel"), "index.ts still references the removed skill");
  assert.ok(!indexSrc.includes("cleanupAllWorktrees"), "index.ts still imports legacy worktree cleanup");
});

test("dead parallel config API is removed; worktree.ts is gone", () => {
  const cfg = fs.readFileSync(configTsPath, "utf-8");
  assert.ok(!cfg.includes("resolveTier"), "resolveTier must be removed");
  assert.ok(!cfg.includes("defaultConcurrency"), "defaultConcurrency must be removed");
  assert.ok(!fs.existsSync(worktreePath), "parallel/worktree.ts must not exist (candidate-worktree.ts carries its own ExecFn)");
});

test("candidate-worktree.ts defines ExecFn locally", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions", "pi-autoresearch", "candidate-worktree.ts"), "utf-8");
  assert.match(src, /export type ExecFn/, "ExecFn type-local to candidate module");
  assert.ok(!/from\s+"[^"]*parallel\/worktree/.test(src), "candidate module must not import from the legacy parallel namespace");
});

test("removed parallel worker names and promises are absent from source and active docs", () => {
  const configUiLines = fs.readFileSync(configUiPath, "utf-8").split("\n");
  const balancedLine = configUiLines.find((line) => line.includes("presetBalancedDesc:"));
  assert.ok(balancedLine, "presetBalancedDesc line expected in config-ui.ts");
  assert.ok(
    !/for workers|для воркеров/i.test(balancedLine),
    `presetBalancedDesc still promises parallel workers: ${balancedLine.trim()}`,
  );
  const files = [configTsPath, configUiPath, ...ACTIVE_DOC_PATHS.map((p) => path.join(repoRoot, p))];
  for (const file of files) {
    const label = path.relative(repoRoot, file);
    const src = fs.readFileSync(file, "utf-8");
    assert.ok(!REMOVED_TOOL_RE.test(src), `${label} names a removed parallel worker`);
    for (const promise of REMOVED_PARALLEL_PROMISES) {
      assert.ok(!promise.test(src), `${label} still promises removed behavior: ${promise}`);
    }
  }
  // The legacy storage namespace itself stays readable/writable.
  assert.match(fs.readFileSync(configTsPath, "utf-8"), /obj\.parallel/, "legacy config namespace must stay readable");
  assert.match(fs.readFileSync(configUiPath, "utf-8"), /raw\.parallel/, "legacy config namespace must stay writable");
});

test("dead parallel policy fields are gone; surviving legacy fields promise no behavior", () => {
  const cfg = fs.readFileSync(configTsPath, "utf-8");
  const lines = cfg.split("\n");
  for (const field of REMOVED_POLICY_FIELDS) {
    assert.ok(!lines.some((line) => new RegExp(`\\b${field}\\b`).test(line)), `config.ts still declares ${field}`);
  }
  for (const legacy of ["concurrency", "budgetSeconds"]) {
    const fieldIndex = lines.findIndex((line) => new RegExp(`\\b${legacy}\\??:`).test(line));
    assert.ok(fieldIndex >= 0, `${legacy} must survive as legacy storage`);
    const preceding = lines.slice(Math.max(0, fieldIndex - 4), fieldIndex).join("\n");
    assert.match(preceding, /legacy/i, `${legacy} must be documented as legacy`);
    assert.match(preceding, /inactive|no runtime|no behavior/i, `${legacy} must promise no runtime behavior`);
  }
});

test("historical PRD/TZ mark removed parallel commands as superseded", () => {
  for (const rel of HISTORICAL_DOC_PATHS) {
    const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    const lines = src.split("\n");
    const header = lines.slice(0, 12).join("\n");
    assert.match(header, /SUPERSEDED/i, `${rel} needs a superseded banner`);
    assert.match(header, /el3\.4/, `${rel} must name el3.4 as the removal decision`);
    assert.match(header, /candidate_branch/, `${rel} must point to candidate_branch`);
    lines.forEach((line, i) => {
      if (line.includes("/autoresearch parallel-")) {
        assert.match(line, /SUPERSEDED|REMOVED/i, `${rel}:${i + 1} presents a removed command as active`);
      }
    });
  }
});
