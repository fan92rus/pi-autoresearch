/**
 * finalize_research tool (extracted from index.ts; tool body byte-identical
 * apart from deps reads at the call site). Refusal strings, expedition
 * finalization order, journal/status/report writes, ledger entry, steer text,
 * campaign guards and reply/details fields are preserved. Extension-local
 * collaborators arrive through `deps` (getter-backed in index.ts) and are read
 * as `deps.foo` at the point of use — never frozen in an execute() destructure.
 * In particular runtime/state are re-read from deps.getRuntime(ctx) on every
 * call, so late-bound researchChain/mode/state changes remain live.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { ensureParentDir } from "./paths.ts";
import * as chainJournal from "./chain-journal.ts";
import * as researchState from "./research-state.ts";
import { formatNum } from "./widget.ts";
import { findBestMetric } from "./ledger-metrics.ts";

type FinalizeResearchTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface FinalizeResearchToolDeps {
  pi: ExtensionAPI;
  assertModeActive: (ctx: ExtensionContext) => any;
  archiveFinishedCampaigns: (workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<string[] | null>;
  archiveOutcome: (workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<researchState.ResearchArchiveOutcome>;
  autoresearchJsonlPath: (dir: string) => string;
  broadcastDashboardUpdate: (workDir: string) => void;
  campaignBlockedResponse: () => any;
  campaignBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  chainCampaignIds: (ctx: ExtensionContext) => Promise<string[]>;
  effectiveResearchBase: (workDir: string, ctx: ExtensionContext) => string;
  exitResearchMode: (ctx: ExtensionContext, campaignId: string) => void;
  getRuntime: (ctx: ExtensionContext) => any;
  researchBlockedResponse: () => any;
  researchBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  resolveWorkDir: (cwd: string) => string;
  writeCampaignReport: (workDir: string) => string;
  writeExpeditionFinalReport: (chain: any, finalStatus: string, entries?: chainJournal.ChainEntry[]) => Promise<string>;
}

export function createFinalizeResearchTool(deps: FinalizeResearchToolDeps): FinalizeResearchTool {
  return {
    name: "finalize_research",
    label: "Signal optimization is complete",
    description:
      "Signal that the optimization target has reached its structural limit or is otherwise complete. " +
      "Records a finalize entry in .auto/log.jsonl and sends a completion steer. " +
      "The agent retains control — this does NOT force-stop the session. " +
      "Use when profiling or analysis proves further optimization is impossible or not worth the cost. " +
      "When an expedition research chain is pinned, finalize marks the expedition COMPLETED " +
      "(journal expedition_stop + completed status + final expedition report), leaves research mode " +
      "and archives its finished campaigns, so the chain does not restore on restart.",
    promptSnippet: "Signal that optimization is complete (floor reached, goal met, etc.)",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the optimization is complete (e.g. 'Process-creation floor reached', 'Goal metric achieved')" },
        evidence: { type: "string", description: "Proof supporting finalization (profiling data, variance analysis, goal comparison)" },
        confidence: { type: "number", description: "Confidence in finalization, 0.0 to 1.0. Above 0.8 triggers strong finalize recommendation in observer.", default: 0.8 },
      },
      required: ["reason"],
    } as any,
    async execute(_toolCallId: string, params: { reason: string; evidence?: string; confidence?: number }, _signal, _onUpdate, ctx: ExtensionContext) {
      const workDir = deps.resolveWorkDir(ctx.cwd);
      const runtime = deps.getRuntime(ctx);
      const state = runtime.state;
      const conf = typeof params.confidence === "number" ? Math.max(0, Math.min(1, params.confidence)) : 0.8;
      // Expedition completion (owner request 2026-11-14, live lob-collector-data):
      // finalize on a pinned expedition chain marks the expedition COMPLETED
      // instead of refusing on the research block — otherwise a finished chain
      // (all campaigns stopped, awaiting_child) restores on every restart forever.
      // A campaign still in phase research is refused (finalize would strand it);
      // otherwise the journal records expedition_stop + completed, the final
      // expedition report is written, research mode is left and the finished
      // campaigns are archived so nothing blocks or restores afterwards.
      let expeditionNote = "";
      let archiveNote = "";
      const expeditionChain = runtime.researchChain?.expedition === true ? runtime.researchChain : null;
      if (expeditionChain !== null) {
        if (await deps.campaignBlocksOrdinaryLoop(workDir, ctx)) return deps.campaignBlockedResponse();
        const verified = await chainJournal.verifyChain(expeditionChain.workDir, expeditionChain.chainId);
        if (!verified.ok) {
          await chainJournal.markManualCheckRequired(expeditionChain.workDir, expeditionChain.chainId, verified.message).catch(() => undefined);
          return { content: [{ type: "text", text: `⛔ Research chain ${expeditionChain.chainId} journal is damaged: actions are blocked until manual check (research_questions(action=status)); finalize refused.` }], details: {} };
        }
        const chainStatus = await chainJournal.statusOf(expeditionChain.workDir, expeditionChain.chainId);
        if (!chainJournal.isFinal(chainStatus)) {
          let researching: string | null = null;
          for (const cid of await deps.chainCampaignIds(ctx)) {
            const resolved = researchState.resolveCampaignDir(expeditionChain.workDir, cid);
            if (!resolved.ok) continue;
            const st = await researchState.readState(resolved.dir);
            if (st.ok && st.state.phase === "research") { researching = cid; break; }
          }
          if (researching !== null) {
            return { content: [{ type: "text", text: `⛔ finalize would strand campaign ${researching} in phase research: close its questions, then research_questions(action=stop, rule_id=<rule>, reason=<why>) and research_questions(action=report), and try finalize again.` }], details: {} };
          }
          const chainDirPath = chainJournal.chainDir(expeditionChain.workDir, expeditionChain.chainId);
          if (!chainDirPath) return { content: [{ type: "text", text: "⛔ chain directory is unavailable; finalize refused." }], details: {} };
          const stop = await chainJournal.appendEntry(chainDirPath, expeditionChain.workDir, expeditionChain.chainId, "expedition_stop", { rule: "finalize_research", basis: "rule" });
          if (!stop.ok) return { content: [{ type: "text", text: `⛔ expedition stop not recorded (${stop.message}); the chain stays ${chainStatus}; finalize refused.` }], details: {} };
          const completed = await chainJournal.setChainStatus(expeditionChain.workDir, expeditionChain.chainId, "completed");
          if (!completed.ok) return { content: [{ type: "text", text: `⛔ completed status not recorded (${completed.message}); the chain stays ${chainStatus}; finalize refused.` }], details: {} };
          expeditionNote = `🧭 Expedition ${expeditionChain.chainId} marked completed${params.reason ? ` (reason: ${params.reason})` : ""}. ${await deps.writeExpeditionFinalReport(expeditionChain, "completed", verified.entries)}`;
        } else {
          expeditionNote = `🧭 Expedition chain ${expeditionChain.chainId} was already ${chainStatus} (final); nothing to finalize on it.`;
        }
        // bd tj0.3: archive BEFORE unbinding. The chain campaigns are included
        // because this chain is final; the old exit-first order only cleared
        // the pin so the archive could see them. On any refusal/throw a stopped
        // campaign still blocks, so the mode stays ON and the reply says so.
        // MINOR-3 (review 2026-11-15): this also runs on a manual_check_required
        // chain — the on-disk marker keeps chain actions blocked; recovery stays
        // research_questions(action=status).
        let outcome: researchState.ResearchArchiveOutcome = { ok: false, reason: "io" };
        let detail = "";
        try {
          outcome = await deps.archiveOutcome(
            workDir, deps.effectiveResearchBase(workDir, ctx), ctx, { includeChainCampaigns: true },
          );
        } catch (err) {
          detail = err instanceof Error ? err.message : String(err);
        }
        const stillBlocking = !outcome.ok && outcome.reason !== "briefing" && outcome.reason !== "research";
        if (stillBlocking) {
          const reason = outcome.ok ? "io" : outcome.reason;
          archiveNote = `\n⛔ Manual check required: finished campaigns could not be archived (${reason}${detail ? `: ${detail}` : ""}). ` +
            "Research mode stays ON and the ordinary loop stays blocked until the blocking campaign files are checked by hand.";
        } else {
          deps.exitResearchMode(ctx, expeditionChain.chainId);
          if (outcome.ok && outcome.archived.length > 0) archiveNote = `\n🗄 Archived finished campaigns: ${outcome.archived.join(", ")}.`;
        }
      } else {
        if (await deps.campaignBlocksOrdinaryLoop(workDir)) return deps.campaignBlockedResponse();
        if (await deps.researchBlocksOrdinaryLoop(workDir, ctx)) return deps.researchBlockedResponse();
        deps.assertModeActive(ctx);
      }

      // state.bestMetric is the restored epoch baseline, not the best keep.
      // Compute one epoch-scoped best and use it everywhere so the ledger,
      // reply and owner-facing steer cannot disagree across measurement epochs.
      const epochBest = findBestMetric(state.results, state.currentSegment, state.bestDirection) ?? state.bestMetric;
      const entry = {
        type: "finalize",
        reason: params.reason,
        evidence: params.evidence ?? "",
        confidence: conf,
        best_metric: epochBest,
        run_count: state.results.length,
        timestamp: Date.now(),
      };

      try {
        const jsonlPath = deps.autoresearchJsonlPath(workDir);
        ensureParentDir(jsonlPath);
        fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");
        deps.broadcastDashboardUpdate(workDir);
      } catch (e) {
        return { content: [{ type: "text", text: `❌ Failed to write finalize entry: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
      }

      // Task 3.2 (add-result-reflection): finalize builds the campaign report
      // and persists it as .auto/report.md. A report failure must not fail
      // the finalize signal — degrade to a note in the response.
      let reportPath: string | null = null;
      let reportNote = "";
      try {
        reportPath = deps.writeCampaignReport(workDir);
        reportNote = `\n📄 Campaign report: ${reportPath}`;
      } catch (e) {
        reportNote = `\n⚠️ Campaign report failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Send completion steer to the agent
      deps.pi.sendUserMessage(
        `🏁 FINALIZE SIGNAL: Agent reports optimization complete.\n` +
        `   Reason: ${params.reason}\n` +
        `   Confidence: ${(conf * 100).toFixed(0)}%\n` +
        (params.evidence ? `   Evidence: ${params.evidence.slice(0, 200)}\n` : "") +
        `   Best ${state.metricName}: ${epochBest !== null ? formatNum(epochBest, state.metricUnit) : "?"}\n` +
        `   Total runs: ${state.results.length}\n` +
        reportNote + `\n\n` +
        `   Run /autoresearch off to finalize, or continue if you disagree.`,
        { deliverAs: "steer" }
      );

      return {
        content: [{ type: "text", text: `${expeditionNote ? `${expeditionNote}\n` : ""}${archiveNote ? `${archiveNote}\n` : ""}🏁 Finalize signal recorded (confidence=${conf}). The observer will now recommend /autoresearch off in its steers.${reportNote}` }],
        details: { finalized: true, confidence: conf, bestMetric: epochBest, reportPath, expeditionNote: expeditionNote || undefined },
      };
    },
  };
}
