// bd pi-autoresearch-tj0.9: one documented cap policy — council.max_councils
// limits the AUTOMATIC stagnation trigger only; a manual council_convene call
// is always available to the owner. Both the facilitator brief and the tool
// description must say the same thing, and the trigger must still honor it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkCouncilTrigger, composeFacilitatorMessage, writeCouncilState } from "../extensions/pi-autoresearch/council.ts";
import { createCouncilConveneTool } from "../extensions/pi-autoresearch/tree-council-tools.ts";

test("facilitator brief and council_convene describe the same cap policy", () => {
  const brief = composeFacilitatorMessage({
    councilDir: ".auto/councils/1",
    seq: 1,
    briefAbsPath: "/tmp/.auto/councils/1/00-brief.md",
    roster: {
      mode: "models",
      chairModel: "m",
      participants: [{ name: "AnalystA", letter: "A", model: "m1", persona: "patterns" }],
    },
    maxChallengeRounds: 5,
    minExperiments: 3,
  });
  const tool = createCouncilConveneTool({});

  assert.match(brief, /automatic stagnation councils are unlimited by default/);
  assert.match(brief, /council\.max_councils[^\n]*caps ONLY the automatic stagnation trigger/);
  assert.match(brief, /never caps a manual council_convene/);
  assert.match(tool.description, /no cap/);
  assert.match(tool.description, /council\.max_councils[^\n]*caps only the automatic stagnation trigger, never this manual tool/);
});

test("max_councils still blocks the automatic trigger when configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-cap-policy-"));
  try {
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "config.json"), JSON.stringify({ council: { max_councils: 1 } }));
    writeCouncilState(dir, { councilsRun: 1, lastCouncilRun: null });
    const brief = { metricName: "ms", metricUnit: "ms", direction: "lower", baselineMetric: 100, bestMetric: 100, goal: "bench" };

    assert.equal(checkCouncilTrigger(10, 30, dir, brief), null, "automatic trigger respects the cap");
    assert.match(checkCouncilTrigger(10, 30, dir, brief, { force: true }), /COUNCIL #2/, "forced/manual path stays uncapped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
