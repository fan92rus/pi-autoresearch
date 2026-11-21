import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const { createFinalizeResearchTool } = await import(
  pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "finalize-research-tool.ts")).href
);

test("finalize uses one epoch-scoped best in ledger, details and steer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-best-"));
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  let steer = "";

  const runtime = {
    state: {
      results: [
        { segment: 1, epoch: 2, status: "keep", metric: 68.42 },
        { segment: 2, epoch: 3, status: "keep", metric: 3 },
        { segment: 2, epoch: 3, status: "keep", metric: 7 },
      ],
      currentSegment: 2,
      bestMetric: 3, // documented epoch baseline, not the best
      metricName: "bugfix_score_v2",
      metricUnit: "score",
      bestDirection: "higher",
    },
  };
  const deps = {
    pi: { sendUserMessage: (text) => { steer = text; } },
    assertModeActive: () => undefined,
    archiveFinishedCampaigns: async () => [],
    archiveOutcome: async () => ({ ok: true }),
    autoresearchJsonlPath: () => ledgerPath,
    broadcastDashboardUpdate: () => undefined,
    campaignBlockedResponse: () => ({}),
    campaignBlocksOrdinaryLoop: async () => false,
    chainCampaignIds: async () => [],
    effectiveResearchBase: () => dir,
    exitResearchMode: () => undefined,
    getRuntime: () => runtime,
    researchBlockedResponse: () => ({}),
    researchBlocksOrdinaryLoop: async () => false,
    resolveWorkDir: (cwd) => cwd,
    writeCampaignReport: () => path.join(dir, "report.md"),
    writeExpeditionFinalReport: async () => "",
  };
  const tool = createFinalizeResearchTool(deps);
  const result = await tool.execute("id", { reason: "test" }, null, null, { cwd: dir });

  const entry = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(entry.best_metric, 7, "ledger finalize entry must record the epoch best, not the baseline");
  assert.equal(result.details.bestMetric, 7, "reply details must agree with the ledger");
  assert.match(steer, /Best bugfix_score_v2: 7/, "owner-facing steer must use the same epoch best");
});
