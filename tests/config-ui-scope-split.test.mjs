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
const skillPath = path.join(repoRoot, "skills", "autoresearch-parallel");
const worktreePath = path.join(repoRoot, "extensions", "pi-autoresearch", "parallel", "worktree.ts");

const REMOVED_TOOL_RE = /BestOfN|SpaceSearch|valleyProbe|CheckOrthogonal|startPhase/;

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
  const indexSrc = fs.readFileSync(indexTsPath, "utf-8");
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
