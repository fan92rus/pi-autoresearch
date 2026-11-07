// Candidate-branches: the council facilitator's Phase 4 must not prescribe the
// ordinary loop while a candidate campaign is active (design §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  composeFacilitatorMessage,
  defaultCouncilConfig,
  resolveRoster,
} from "../extensions/pi-autoresearch/council.ts";

function input(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cand-phase4-"));
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, "brief\n");
  return {
    councilDir: ".auto/councils/1",
    seq: 1,
    briefAbsPath: brief,
    roster: resolveRoster(defaultCouncilConfig()),
    maxChallengeRounds: 5,
    minExperiments: 3,
    ...extra,
  };
}

const LOOP = /propose_hypothesis|run_experiment|log_experiment/;

test("Phase 4 without a campaign keeps the ordinary-loop instruction", () => {
  const msg = composeFacilitatorMessage(input());
  assert.match(msg, /## Phase 4 — Execute/);
  assert.match(msg, LOOP, "legacy path must still name the ordinary loop");
});

test("Phase 4 under an active campaign names candidate_branch and never the blocked loop", () => {
  const msg = composeFacilitatorMessage(input({ campaignActive: true }));
  const phase4 = msg.slice(msg.indexOf("## Phase 4 — Execute"));
  assert.match(phase4, /candidate_branch/);
  assert.doesNotMatch(phase4, LOOP, "campaign Phase 4 must not prescribe propose/run/log");
});
