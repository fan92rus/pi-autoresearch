// config-ui scope-split texts (bd pi-autoresearch-hsu): the parallel-* tools
// were removed in the dead-code cut (dd43c7f), but the /autoresearch parallel-*
// commands and the config dialog remain for campaign policy (models,
// concurrency, budget). No user-facing text may name a removed tool as
// available.
//
// Run: node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/config-ui-scope-split.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUiPath = path.join(repoRoot, "extensions", "pi-autoresearch", "parallel", "config-ui.ts");
const skillPath = path.join(repoRoot, "skills", "autoresearch-parallel", "SKILL.md");

const REMOVED_TOOL_RE = /BestOfN|SpaceSearch|valleyProbe|CheckOrthogonal|startPhase/;

test("autocomplete entries for parallel-* carry the removed-tools scope-split note", async () => {
  const { filterSubcommands } = await import("../extensions/pi-autoresearch/parallel/config-ui.ts");
  for (const value of ["parallel-best-of-n", "parallel-stack", "parallel-search"]) {
    const entry = filterSubcommands(value).find((s) => s.value === value);
    assert.ok(entry, `${value} still offered as completion`);
    assert.match(entry.description, /removed.*scope split|scope split.*removed/i, `${value} description names the scope split`);
  }
});

test("non-parallel completions keep their original descriptions", async () => {
  const { filterSubcommands } = await import("../extensions/pi-autoresearch/parallel/config-ui.ts");
  const research = filterSubcommands("research").find((s) => s.value === "research");
  assert.ok(research);
  assert.match(research.description, /research campaign/);
  const off = filterSubcommands("off").find((s) => s.value === "off");
  assert.ok(off);
  assert.match(off.description, /off/i);
});

test("concurrency prompt in config-ui.ts names no removed tool", () => {
  const src = fs.readFileSync(configUiPath, "utf-8");
  // The concurrency dialog block: from its title to the input prompt. The only
  // allowed mention anywhere in user-facing strings is inside the scope-split
  // note, so assert the whole file's user-facing string literals stay clean.
  const stringLiterals = src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
  for (const lit of stringLiterals) {
    // Skip import/require paths and the removed-tools regexes used for
    // detection (none expected here) — flag only prompt/notify/select texts.
    if (/RU \?|title|prompt|notify|select|description/.test(src.slice(Math.max(0, src.indexOf(lit) - 200), src.indexOf(lit)))) {
      if (REMOVED_TOOL_RE.test(lit)) {
        assert.fail(`user-facing string names a removed tool: ${lit.slice(0, 80)}`);
      }
    }
  }
});

test("SKILL.md opens with the scope-split notice and no removed tool is offered as available", () => {
  const skill = fs.readFileSync(skillPath, "utf-8");
  assert.match(skill, /SCOPE SPLIT \(2026-11-08\)/);
  assert.match(skill, /removed in the dead-code cut \(dd43c7f\)/);
  assert.match(skill, /campaign config only/);
  // The removal notice must appear before any tool name to warn readers first.
  const noticeIdx = skill.indexOf("SCOPE SPLIT");
  const firstToolIdx = skill.search(REMOVED_TOOL_RE);
  assert.ok(noticeIdx !== -1 && firstToolIdx !== -1 && noticeIdx < firstToolIdx, "scope-split notice precedes first tool mention");
});
