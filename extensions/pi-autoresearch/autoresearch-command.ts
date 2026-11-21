/**
 * /autoresearch command registration (extracted from index.ts; command
 * description, argument completions, help text, every subcommand branch,
 * cancellation/finalization and notify strings are preserved; mode switches
 * now funnel through the transactional deps.transitionAutoresearchMode helper
 * (bd tj0.2). Extension-local
 * collaborators arrive through `deps` and are read as `deps.foo` at the
 * point of use — never destructured into a handler/execute local. Mutable
 * bindings (runtime, uiMode, brief dirs, pending resume, loop mode, research
 * and candidate guards, test hooks) are getter-backed in index.ts, so late
 * changes stay live.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { isHelpRequest, renderAutoresearchHelp } from "./commands.ts";
import { sessionFileCandidates } from "./paths.ts";
import * as expedition from "./expedition.ts";
import * as chainJournal from "./chain-journal.ts";
import * as researchState from "./research-state.ts";
import { readCouncilConfig } from "./council.ts";
import { listResearchCampaignIds } from "./research-scan.ts";
import { filterSubcommands, applyExperimentLimitArg, configureExperimentLimit, interactiveParallelConfig } from "./parallel/config-ui.ts";
import type { BoundTestHooks } from "./test-hooks.ts";
import type { ModeTransition } from "./index.ts";
import { BUGFIX_METRIC_DIRECTION, BUGFIX_METRIC_UNIT, BUGFIX_METRIC_VERSION } from "./bugfix-mode.ts";

export type ExperimentStartConfig = {
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
};

/** Shared guard/notice wording: the command and the direct expedition_brief
 *  propose path must refuse and notify with exactly the same text. */
export const EXPEDITION_RESEARCH_ACTIVE_NOTICE = "Cannot launch expedition while a research campaign is active; resume or finish it first.";
export const EXPEDITION_CANDIDATE_ACTIVE_NOTICE = "Candidate campaign active; finish it before starting an expedition.";
export const RESEARCH_KICKOFF_NOTICE = "Research campaign active — continue it with research_questions(action=status); the legacy autoresearch kickoff is not sent.";
export const BUGFIX_KICKOFF = [
  "Bugfix mode active. Use bugfix_mode(action=\"prepare\", campaignId, config) once with explicit project parameters and a clean working tree.",
  "Then bugfix_mode(action=\"record\", phase=\"discover\", ...) pays for a confirmed defect, bugfix_mode(action=\"record\", phase=\"proof\", ...) checks the fix, and bugfix_mode(action=\"decide\", status=\"keep|discard\", ...) records the decision.",
  "Run the returned node command with run_experiment, then log_experiment. Use tree_status/direction_review for stagnation; the metric loop's optimize_brief/init_experiment setup is not needed here.",
].join(" ");

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface AutoresearchCommandDeps {
  BENCHMARK_GUARDRAIL: string;
  acceptLaunchCharter: (ctx: ExtensionContext, workDir: string, charterPath: string) => Promise<{ sha256: string; charter: any } | null>;
  buildSessionSnapshot: (state: any) => any;
  campaignBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  cancelPendingResume: (runtime: any) => void;
  chainCampaignIds: (ctx: ExtensionContext) => Promise<string[]>;
  clearPersistedOffMarker: (workDir: string) => void;
  createExperimentState: () => any;
  exportDashboard: (ctx: ExtensionContext) => Promise<void>;
  expeditionForWeb: (ctx: ExtensionContext) => boolean;
  finalizeExpeditionForOptimization: (ctx: ExtensionContext) => Promise<{ ok: boolean; message: string }>;
  fireHook: (payload: any, ctx?: unknown) => Promise<string | null>;
  getRuntime: (ctx: ExtensionContext) => any;
  hasAutoresearchRules: (ctx: ExtensionContext) => boolean;
  hasLoggedExperiment: (cwd: string) => boolean;
  openExpeditionWebDashboard: (ctx: ExtensionContext) => Promise<void>;
  openFullscreenDashboard: (ctx: ExtensionContext) => Promise<void> | void;
  ordinaryLaunchResearchGate: (workDir: string, ctx: ExtensionContext) => Promise<"none" | "manual" | "active">;
  readLastRun: (workDir: string) => Record<string, unknown> | null;
  reconstructStateForCommand: (ctx: ExtensionContext) => void;
  recordAutoresearchActivation: (workDir: string, active: boolean) => void;
  recordModeSwitchFinalize: (ctx: ExtensionContext, reason: string) => void;
  researchBlocksExpeditionLaunch: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  researchBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  researchCampaignExists: (workDir: string, ctx?: ExtensionContext) => boolean;
  resolveWorkDir: (cwd: string) => string;
  resetStateForNewLaunch: (ctx: ExtensionContext, experiment?: ExperimentStartConfig) => string | null;
  saveDeadEnds: (workDir: string) => void;
  sendChainContinuation: (ctx: ExtensionContext, parentCampaignId: string) => Promise<void>;
  sendWhenReady: (ctx: ExtensionContext, message: string, opts?: { steerIfBusy?: boolean }) => void;
  setAutoresearchMode: (ctx: ExtensionContext, enabled: boolean) => void;
  stopDashboardServer: () => void;
  syncBriefPreview: (ctx: ExtensionContext) => void;
  transitionAutoresearchMode: (ctx: ExtensionContext, next: ModeTransition) => void;
  testHooks: BoundTestHooks;
  turnAutoresearchOff: (ctx: ExtensionContext) => void;
  updateWidget: (ctx: ExtensionContext) => void;
  writeCampaignReport: (workDir: string) => string;
}

export function createAutoresearchCommand(deps: AutoresearchCommandDeps): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
  const FINALIZE_KICKOFF = "/skill:autoresearch-finalize";

  async function finalizeAutoresearch(ctx: ExtensionCommandContext): Promise<void> {
    if (!deps.hasLoggedExperiment(ctx.cwd)) {
      ctx.ui.notify("No logged experiments to finalize — use '/autoresearch <goal>' to start a session", "error");
      return;
    }
    if (deps.getRuntime(ctx).autoresearchMode) await turnOffAndSettle(ctx);
    ctx.ui.notify("Loading autoresearch-finalize skill", "info");
    deps.sendWhenReady(ctx, FINALIZE_KICKOFF);
  }

  // An aborted run never drains its queue, so a skill queued as a follow-up
  // would be stranded there. Waiting out the abort lets it start a fresh turn.
  async function turnOffAndSettle(ctx: ExtensionCommandContext): Promise<void> {
    deps.turnAutoresearchOff(ctx);
    await ctx.waitForIdle();
  }

  pi.registerCommand("autoresearch", {
    description: "Start, stop, finalize, report, clear, export, configure, or open dashboards for autoresearch mode",
    getArgumentCompletions: (argumentPrefix: string) => {
      return filterSubcommands(argumentPrefix).map(function (s) {
        return { value: s.value, label: s.label, description: s.description };
      });
    },
    handler: async (args, ctx) => {
      const runtime = deps.getRuntime(ctx);
      const trimmedArgs = (args ?? "").trim();
      const command = trimmedArgs.toLowerCase();

      if (isHelpRequest(command)) {
        ctx.ui.notify(renderAutoresearchHelp(), "info");
        return;
      }

      if (command === "continue") {
        const workDir = deps.resolveWorkDir(ctx.cwd);
        deps.clearPersistedOffMarker(workDir);
        const researchGate = await deps.ordinaryLaunchResearchGate(workDir, ctx);
        if (researchGate !== "none") {
          ctx.ui.notify(RESEARCH_KICKOFF_NOTICE, "info");
          return;
        }
        if (await deps.campaignBlocksOrdinaryLoop(workDir)) {
          ctx.ui.notify("Candidate campaign active — continue it with candidate_branch status; the legacy autoresearch loop is not resumed.", "info");
          return;
        }
        deps.reconstructStateForCommand(ctx);
        deps.recordAutoresearchActivation(workDir, true);
        deps.transitionAutoresearchMode(ctx, { enabled: true, uiMode: "optimization" });
        ctx.ui.notify("Autoresearch mode ON — previous ledger restored", "info");
        deps.sendWhenReady(ctx, `Autoresearch resumed from the saved ledger. Continue the loop from the restored best. ${deps.BENCHMARK_GUARDRAIL}`);
        return;
      }

      if (command === "off") {
        // Save cross-session dead-ends before turning off
        try {
          deps.saveDeadEnds(deps.resolveWorkDir(ctx.cwd));
        } catch { /* best-effort */ }
        deps.turnAutoresearchOff(ctx);
        return;
      }

      if (command === "finalize") {
        if (await deps.researchBlocksOrdinaryLoop(deps.resolveWorkDir(ctx.cwd), ctx)) {
          ctx.ui.notify("Research campaign active — use research_questions(action=status); the legacy finalize flow is not started.", "info");
          return;
        }
        if (await deps.campaignBlocksOrdinaryLoop(deps.resolveWorkDir(ctx.cwd))) {
          ctx.ui.notify("Candidate campaign active — use candidate_branch; the legacy finalize flow is not started.", "info");
          return;
        }
        await finalizeAutoresearch(ctx);
        return;
      }

      if (command === "report") {
        // Task 3.2: intermediate campaign report on demand (spec campaign-report
        // «Идемпотентность и ручной вызов»): same generator as finalize_research,
        // fresh overwrite of .auto/report.md from the current ledger/tree/findings
        // state — available with the loop on or off, even before finalize.
        const reportWorkDir = deps.resolveWorkDir(ctx.cwd);
        try {
          const reportPath = deps.writeCampaignReport(reportWorkDir);
          ctx.ui.notify(`Campaign report written to ${reportPath}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Failed to write campaign report: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      if (command === "export") {
        await deps.exportDashboard(ctx);
        return;
      }

      if (command === "council" || command.startsWith("council ")) {
        // Delegate to the autonomous tool (single code path). The command
        // context has no executeTool, so the agent performs the blocking call.
        const note = trimmedArgs.replace(/^council\b\s*/i, "").trim();
        const workDir = deps.resolveWorkDir(ctx.cwd);
        if (await deps.researchBlocksOrdinaryLoop(workDir, ctx)) {
          ctx.ui.notify("Research campaign active — the council is blocked in this mode; use research_questions(action=status).", "info");
          return;
        }
        const cfg = readCouncilConfig(workDir);
        if (!cfg.enabled) {
          ctx.ui.notify("Council is disabled (council.enabled=false in .auto/config.json)", "error");
          return;
        }
        const noteArg = note ? "note: " + JSON.stringify(note) : "";
        const councilInCampaign = await deps.campaignBlocksOrdinaryLoop(workDir);
        pi.sendUserMessage(
          "Convene a hypothesis council NOW: call council_convene({" + noteArg + "}). " +
          "The tool is autonomous and BLOCKING — it runs the analysts, challenge rounds and chair itself and returns the finished slate. " +
          (councilInCampaign
            ? "When it returns, follow the slate through the candidate campaign (candidate_branch), not run_experiment or propose_hypothesis."
            : "When it returns, register each slate EXP via propose_hypothesis and run them through the normal loop."),
          { deliverAs: "followUp" },
        );
        ctx.ui.notify("Council delegated to council_convene — the agent will run it autonomously", "info");
        return;
      }

      if (command === "dashboard") {
        // Expedition chain active → the expedition WEB dashboard (spec group 4:
        // the browser kanban). Otherwise the ordinary fullscreen overlay path —
        // byte-for-byte unchanged, including its own TUI gate and notifies.
        if (deps.expeditionForWeb(ctx)) {
          await deps.openExpeditionWebDashboard(ctx);
          return;
        }
        await deps.openFullscreenDashboard(ctx);
        return;
      }

      if (command === "clear") {
        const workDir = deps.resolveWorkDir(ctx.cwd);
        // Clearing the ordinary experiment state under an active campaign
        // would corrupt its evidence/ledger. Refuse before any runtime or disk
        // mutation; campaign-specific commands own their cleanup lifecycle.
        if (deps.researchCampaignExists(workDir, ctx)) {
          ctx.ui.notify("Research campaign active — complete or remove it first before clearing autoresearch data", "info");
          return;
        }
        if (await deps.campaignBlocksOrdinaryLoop(workDir)) {
          ctx.ui.notify("Candidate campaign active — complete or disable it first before clearing autoresearch data", "info");
          return;
        }
        const jsonlPaths = sessionFileCandidates(workDir, "log");
        deps.recordAutoresearchActivation(workDir, false);
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        deps.cancelPendingResume(runtime);
        runtime.state = deps.createExperimentState();
        deps.stopDashboardServer();
        deps.transitionAutoresearchMode(ctx, { enabled: false, uiMode: "optimization" });

        const deletedPaths: string[] = [];
        const removePath = (target: string, recursive = false): boolean => {
          if (!fs.existsSync(target)) return true;
          const relative = path.relative(workDir, target) || path.basename(target);
          try {
            if (recursive) fs.rmSync(target, { recursive: true, force: true });
            else fs.unlinkSync(target);
            deletedPaths.push(relative);
            return true;
          } catch (error) {
            ctx.ui.notify(
              `Failed to delete ${relative}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return false;
          }
        };
        for (const jsonlPath of Object.values(jsonlPaths)) {
          if (!removePath(jsonlPath)) return;
        }

        // Per-campaign experiment artifacts are stale after clear; preserve
        // owner configuration and research/candidate campaign history.
        const autoDir = path.join(workDir, ".auto");
        for (const relative of ["findings.jsonl", "observations.jsonl", "analysis.jsonl", "report.md", "autoresearch-off.json"]) {
          if (!removePath(path.join(autoDir, relative))) return;
        }
        for (const relative of ["ideas", "runs"]) {
          if (!removePath(path.join(autoDir, relative), true)) return;
        }

        // The off marker is housekeeping, not session data: deleting it alone
        // is not a "deleted something" report — the empty-workdir message stays.
        const deletedData = deletedPaths.filter((p) => !p.endsWith("autoresearch-off.json"));
        if (deletedData.length > 0) {
          ctx.ui.notify(`Deleted ${deletedData.join(", ")} and turned autoresearch mode OFF`, "info");
        } else {
          ctx.ui.notify("No session log found. Autoresearch mode OFF", "info");
        }
        return;
      }

      // ===== tree subcommand: toggle tree/list view in dashboard widget =====
      if (command === "tree" || command === "tree-view") {
        runtime.treeViewMode = !runtime.treeViewMode;
        deps.updateWidget(ctx);
        ctx.ui.notify(
          runtime.treeViewMode
            ? "🌳 Tree view ON — experiment tree shown in dashboard"
            : "📋 List view ON — dashboard table restored",
          "info",
        );
        return;
      }

      // ===== limit subcommand: experiment time limit (minutes) =====
      const limitMatch = command.match(/^limit\b\s*(.*)$/);
      if (limitMatch) {
        const arg = limitMatch[1].trim();
        if (arg) {
          const msg = applyExperimentLimitArg(ctx.cwd, arg);
          if (msg === null) {
            ctx.ui.notify("Usage: /autoresearch limit <minutes> — set; /autoresearch limit off — clear; /autoresearch limit — interactive.", "warning");
          } else {
            ctx.ui.notify(msg, "info");
          }
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Interactive limit editor requires TUI mode. Use /autoresearch limit <minutes> or /autoresearch limit off.", "warning");
          return;
        }
        await configureExperimentLimit(ctx);
        return;
      }

      // ===== config subcommand: interactive parallel mode configuration =====
      if (command === "config") {
        const workDir = deps.resolveWorkDir(ctx.cwd);
        if (!ctx.hasUI) {
          ctx.ui.notify("Interactive config requires TUI mode. Edit .auto/config.json manually.", "warning");
          return;
        }
        await interactiveParallelConfig(ctx, workDir);
        return;
      }

      // ===== parallel-* subcommands removed (bd pi-autoresearch-el3.4):
      // the legacy parallel flow is dead (tools cut in dd43c7f, decision
      // 2026-11-16) — an explicit command is rejected below instead of being
      // treated as a free-text goal.
      if (/^parallel-(best-of-n|stack|search)\b/.test(command)) {
        ctx.ui.notify("parallel-* commands were removed — run diverse variants as candidate_branch campaigns instead.", "warning");
        return;
      }

      // ===== expedition subcommand: design-first research chain =====
      if (/^expedition(\s|$)/.test(command)) {
        const workDir = deps.resolveWorkDir(ctx.cwd);
        const chain = runtime.researchChain;
        if (chain?.expedition) {
          const verified = await chainJournal.verifyChain(chain.workDir, chain.chainId);
          if (!verified.ok) { ctx.ui.notify(`Expedition refused (manual_check_required): ${verified.message}`, "error"); return; }
          const status = await chainJournal.statusOf(chain.workDir, chain.chainId);
          if (status === "active" || status === "awaiting_child") {
            // Continuation fix (live case 2026-11-14): the previous refusal
            // suggested 'research --id <last campaign>', but a stopped campaign
            // is terminal and never resumes - a dead-end message loop. For an
            // awaiting_child chain the designed next step is the chain
            // continuation itself (report already recorded): turn the mode ON
            // and send the same continuation the report path sends, so the
            // agent closes the finished direction, activates the next one and
            // drafts the next child campaign brief (auto-approved by charter).
            // An 'active' chain still refuses: its campaign is live and the
            // existing wording stays correct.
            if (status === "awaiting_child") {
              deps.recordAutoresearchActivation(workDir, true);
              deps.transitionAutoresearchMode(ctx, { enabled: true, uiMode: "expedition" });
              const ids = await deps.chainCampaignIds(ctx);
              await deps.sendChainContinuation(ctx, ids.at(-1) ?? runtime.researchCampaignId ?? "<campaign>");
              ctx.ui.notify(`Expedition ${chain.chainId} continues (awaiting_child): the agent closes the finished direction and drafts the next campaign brief (auto-approved).`, "info");
              return;
            }
            const ids = await deps.chainCampaignIds(ctx);
            ctx.ui.notify(`Resume or finish the existing expedition; resume with /autoresearch research --id ${ids.at(-1) ?? runtime.researchCampaignId ?? "<campaign>"}`, "error"); return;
          }
        }
        if (!ctx.hasUI) { ctx.ui.notify("Expedition needs TUI confirmation; headless use requires the --expedition-doc wrapper.", "error"); return; }
        if (await deps.researchBlocksExpeditionLaunch(workDir, ctx)) { ctx.ui.notify(EXPEDITION_RESEARCH_ACTIVE_NOTICE, "error"); return; }
        if (await deps.campaignBlocksOrdinaryLoop(workDir)) { ctx.ui.notify(EXPEDITION_CANDIDATE_ACTIVE_NOTICE, "error"); return; }
        // es1.7: an active optimization loop is finalized (ledger + report) but
        // NOT steered — the design-phase kickoff below is the only message. The
        // persisted off-marker is untouched: the mode stays ON, only the view
        // changes. A chain-bound session is not a mode switch.
        if (runtime.autoresearchMode && runtime.researchChain?.expedition !== true && runtime.uiMode === "optimization") {
          deps.recordModeSwitchFinalize(ctx, "switch to expedition mode");
          deps.cancelPendingResume(runtime);
          runtime.autoResumeTurns = 0;
          runtime.consecutiveDriftResumes = 0;
        }
        deps.recordAutoresearchActivation(workDir, true);
        deps.transitionAutoresearchMode(ctx, { enabled: true, uiMode: "expedition" });
        const goal = trimmedArgs.slice("expedition".length).trim();
        const stateRoot = runtime.researchStateRoot ?? path.join(workDir, ".auto");
        const draft = expedition.findLatestDraft(stateRoot);
        deps.sendWhenReady(ctx, draft
          ? `Expedition design phase for ${goal || "the requested goal"}. An unconfirmed draft exists at ${draft}; begin with expedition_brief propose (or revise it).`
          : `Expedition design phase. Goal: ${goal || "not specified"}. Ask all missing owner questions in one message (territory, completion criteria, constraints, starting directions). Then use expedition_brief draft and propose; do not create chain state before owner confirmation.`);
        return;
      }

      // ===== research subcommand: a research campaign, not the metric loop =====
      // Matched before the already-active branch: a research campaign is a
      // separate campaign kind, so the loop's active flag must not block it.
      // Syntax: /autoresearch research [--id <campaign-id>] [--state-root <path>] <free description>.
      // The description is what the campaign studies; the agent turns it into
      // brief questions. The optional --id pins the campaign for the session
      // (the headless wrapper passes it; TUI runs get a generated id at draft).
      // The optional --state-root pins where campaign STATE lives (under
      // <stateRoot>/.auto/research/<id>/) for project layouts that only allow
      // writes into a run directory; evidence still resolves from the work dir.
      //
      // DOCUMENTED LIMITATION: a state-root campaign is invisible to OTHER
      // sessions' scans (they read only <workDir>/.auto/research); the launch
      // guard, ordinary-loop blocks, manual-check suppression and resume
      // composers in this session all consult the pin. A second session must
      // pass the same --state-root to see the campaign.
      if (/^research(\s|$)/.test(command)) {
        const researchWorkDir = deps.resolveWorkDir(ctx.cwd);
        let args_ = trimmedArgs.slice("research".length).trim();
        // research-charter: optional --charter <path> starts a chain for this
        // session. The path must live OUTSIDE the work directory (spec:
        // charter_inside_workdir refuses); the owner confirms the charter in a
        // dialog whose first line is `Charter SHA-256: <hex>`.
        let requestedCharterPath: string | null = null;
        const charterMatch = /^--charter\s+(\S+)(\s|$)/.exec(args_);
        if (charterMatch) {
          requestedCharterPath = charterMatch[1];
          args_ = args_.slice(charterMatch[0].length).trim();
          if (requestedCharterPath === "") {
            ctx.ui.notify("--charter does not accept an empty path; nothing was started", "error");
            return;
          }
        }

        let requestedId: string | null = null;
        const idMatch = /^--id\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\s|$)/.exec(args_);
        if (idMatch) {
          requestedId = idMatch[1];
          args_ = args_.slice(idMatch[0].length).trim();
        }
        // A chain needs a pinned root campaign. Refuse BEFORE mode/widget/
        // activation mutation: an error here must leave autoresearch OFF.
        if (requestedCharterPath !== null && requestedId === null) {
          ctx.ui.notify("Chain refused: --charter needs --id <root campaign> so the chain has a root to continue from", "error");
          return;
        }
        let requestedStateRoot: string | null = null;
        const stateRootMatch = /^--state-root\s+(\S+)(\s|$)/.exec(args_);
        if (stateRootMatch) {
          requestedStateRoot = stateRootMatch[1];
          args_ = args_.slice(stateRootMatch[0].length).trim();
        }
        // Validate the state root BEFORE any mutation: it must resolve inside
        // the work directory (same confinement pattern as locateEvidence).
        if (requestedStateRoot !== null) {
          if (requestedStateRoot.startsWith('"') || requestedStateRoot.startsWith("'")) {
            ctx.ui.notify(
              `--state-root does not accept quoted values (got ${requestedStateRoot}); pass the path unquoted or without spaces`,
              "error",
            );
            return;
          }
          const abs = path.resolve(researchWorkDir, requestedStateRoot);
          const rel = path.relative(researchWorkDir, abs);
          if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") {
            ctx.ui.notify(
              `--state-root must be a directory inside the work directory (got ${requestedStateRoot}); nothing was started`,
              "error",
            );
            return;
          }
          requestedStateRoot = abs;
        }
        const description = args_;
        // Discovery for the launch guards: the default root, the requested
        // (not yet pinned) state root, AND the session's already-pinned state
        // root, so a state-root campaign also refuses a second launch in this
        // session (review B1: the same-session pin must be honored here).
        const pinnedStateRoot = runtime.researchStateRoot;
        const launchBases = [
          researchWorkDir,
          ...[requestedStateRoot, pinnedStateRoot].filter((b) => b !== null) as string[],
        ];
        const uniqueLaunchBases = [...new Set(launchBases)];
        const campaignIdsByBase = new Map<string, string[] | null>();
        for (const base of uniqueLaunchBases) {
          campaignIdsByBase.set(base, listResearchCampaignIds(base));
        }
        const existingIds = [...new Set(uniqueLaunchBases.flatMap((b) => campaignIdsByBase.get(b) ?? []))].sort();

        // Explicit --id: pin it for the session. When the campaign already
        // exists it must be resumable (briefing/research); when it does not,
        // research_brief draft will create it under the pinned id (the
        // headless wrapper flow). It is never created by this command.
        // Resolve the campaign directory for an --id: effective (state-root)
        // base first, then the default root. Returns the dir when the campaign
        // exists in either root, else null.
        const resolveRequestedCampaignDir = (id: string): string | null => {
          const bases = requestedStateRoot !== null
            ? [requestedStateRoot, researchWorkDir]
            : [researchWorkDir];
          for (const base of bases) {
            const resolved = researchState.resolveCampaignDir(base, id);
            if (resolved.ok && fs.existsSync(resolved.dir)) return resolved.dir;
          }
          return null;
        };
        if (requestedId !== null) {
          const campaignDir = resolveRequestedCampaignDir(requestedId);
          if (campaignDir !== null) {
            const insp = await researchState.inspectCampaign(campaignDir);
            // bd tj0.3: the same ordered gate as every other research path —
            // pending_op, then state validity, then phase. "launch" refuses
            // unreadable states and stranded (pending) stopped campaigns; a
            // pending marker on a readable briefing/research campaign is still
            // resumable so the operator can run research_questions(action=resolve).
            const reason = researchState.researchPolicyRefusal(researchState.inspectionPolicyInput(insp), "launch");
            const phase = insp.state?.phase ?? null;
            const resumablePhase = phase === "briefing" || phase === "research";
            // The ONE explicit exception to the terminal-phase refusal:
            // research-charter resumes on top of a READY, pending-free stopped
            // chain root.
            const charterStoppedRoot = requestedCharterPath !== null && insp.status === "ready" &&
              !insp.pendingOp && phase === "stopped";
            if (charterStoppedRoot) {
              // allowed: the chain takes this campaign as its root.
            } else if (reason === "unreadable" || (reason === "pending_op" && !resumablePhase)) {
              ctx.ui.notify(
                reason === "pending_op"
                  ? `Campaign ${requestedId} has an interrupted operation (manual check required); resolve it before resuming`
                  : `Campaign ${requestedId} is unreadable; cannot resume from here`,
                "info",
              );
              return;
            } else if (phase === "stopped") {
              ctx.ui.notify(`Campaign ${requestedId} is stopped (terminal); it never resumes. Create a new campaign: /autoresearch research <description>`, "info");
              return;
            } else if (!resumablePhase) {
              ctx.ui.notify(`Campaign ${requestedId} is in phase ${String(phase)} or unreadable; cannot resume from here`, "info");
              return;
            } else if (reason === "pending_op") {
              ctx.ui.notify(`Campaign ${requestedId} has an interrupted operation (manual check required); resolve it with research_questions(action=resolve)`, "info");
            }
          }
        } else if (existingIds.length > 0 || uniqueLaunchBases.some((base) => campaignIdsByBase.get(base) === null)) {
          // Bare launches close stale, unpinned campaigns before proceeding;
          // protected or unreadable campaigns fail closed with their reason.
          const chainIds = await deps.chainCampaignIds(ctx);
          const seenDirs = new Set<string>();
          const idBaseCounts = new Map<string, number>();
          for (const base of uniqueLaunchBases) {
            for (const id of campaignIdsByBase.get(base) ?? []) idBaseCounts.set(id, (idBaseCounts.get(id) ?? 0) + 1);
          }
          const refusalName = (id: string, base: string): string =>
            idBaseCounts.get(id)! > 1 ? `${id} (at ${path.relative(researchWorkDir, path.join(base, ".auto", "research", id)) || "."})` : id;
          const refusals: string[] = [];
          for (const base of uniqueLaunchBases) {
            const campaignIds = campaignIdsByBase.get(base);
            if (campaignIds === null || campaignIds === undefined) {
              refusals.push(`(unreadable root ${base})`);
              continue;
            }
            for (const id of campaignIds) {
              const resolved = researchState.resolveCampaignDir(base, id);
              if (!resolved.ok) { refusals.push(`${refusalName(id, base)} (unreadable state)`); continue; }
              const dir = path.resolve(resolved.dir);
              if (seenDirs.has(dir)) continue;
              seenDirs.add(dir);
              // Live case 2026-11-14: service directories without state.json
              // (.auto/research/briefs, evidence) are not campaigns - skip.
              if (!fs.existsSync(path.join(dir, researchState.STATE_FILE))) continue;
              const name = refusalName(id, base);
              const state = await researchState.readState(dir);
              if (!state.ok) { refusals.push(`${name} (unreadable state)`); continue; }
              if (state.state.phase === "stopped") continue;
              if (state.state.phase !== "briefing" && state.state.phase !== "research") {
                refusals.push(`${name} (unreadable state)`); continue;
              }
              if (id === runtime.researchCampaignId) {
                // Spec (headless-launch): a pinned blocking campaign keeps the
                // EXISTING blocking wording ("resume it …, or finish it first").
                ctx.ui.notify(`Campaign ${id} is active or unreadable; resume it with /autoresearch research --id ${id}, or finish it first`, "info");
                return;
              }
              if (fs.existsSync(path.join(dir, "pending-op.json"))) { refusals.push(`${name} (pending op)`); continue; }
              if (chainIds.includes(id)) { refusals.push(`${name} (active chain)`); continue; }
              const closed = deps.testHooks.closeStaleCampaign ? await deps.testHooks.closeStaleCampaign(dir) : null;
              if (!closed?.ok) refusals.push(`${name} (${closed?.message ?? "could not close as stale"})`);
            }
          }
          if (refusals.length > 0) {
            ctx.ui.notify(`Cannot launch research; campaigns need attention: ${refusals.join("; ")}`, "info");
            return;
          }
        }
        if (await deps.campaignBlocksOrdinaryLoop(researchWorkDir)) {
          ctx.ui.notify("Candidate campaign active — use candidate_branch; the research campaign is not started.", "info");
          return;
        }
        let resumePhase: string | null = null;
        // The session may already hold a pin (an earlier launch in THIS
        // session). A pinned campaign still in briefing/research must not be
        // silently dropped: guard before any runtime mutation (review B1b).
        const pinnedId = runtime.researchCampaignId;
        if (pinnedId !== null) {
          const pinnedBases = [
            ...new Set((
              [...[requestedStateRoot, pinnedStateRoot].filter((b) => b !== null) as string[]]).concat(researchWorkDir)
            ),
          ];
          let pinnedDir: string | null = null;
          for (const base of pinnedBases) {
            const resolved = researchState.resolveCampaignDir(base, pinnedId);
            if (resolved.ok && fs.existsSync(resolved.dir)) {
              pinnedDir = resolved.dir;
              break;
            }
          }
          let pinnedPhase: string | null = null;
          if (pinnedDir !== null) {
            const insp = await researchState.inspectCampaign(pinnedDir);
            pinnedPhase = insp.state?.phase ?? null;
          }
          if (pinnedPhase === "briefing" || pinnedPhase === "research") {
            const resumingSameId = requestedId === pinnedId;
            // requestedStateRoot and pinnedStateRoot are both absolute here
            // (both pass the confinement resolve), so string equality is the
            // exact "same base" check; a null request matches a null pin only.
            const sameBase = requestedStateRoot !== null
              ? requestedStateRoot === (pinnedStateRoot ?? researchWorkDir)
              : pinnedStateRoot === null;
            if (!resumingSameId || !sameBase) {
              ctx.ui.notify(
                `Campaign ${pinnedId} is active for this session (phase ${pinnedPhase}); the pin is not replaced. ` +
                  (resumingSameId
                    ? "Pass the same --state-root as the pinned campaign, or /autoresearch off to drop the pin"
                    : `Resume it with /autoresearch research --id ${pinnedId}` +
                      (pinnedStateRoot !== null ? " --state-root <the pinned root>" : "") +
                      ", or /autoresearch off to drop the pin"),
                "error",
              );
              return;
            }
          }
        }
        if (requestedId !== null) {
          // The pin is installed by the transactional transition below (the
          // research tools take no campaign id, so this session works with
          // exactly this campaign — bd pi-autoresearch-9o2).
          const campaignDir = resolveRequestedCampaignDir(requestedId);
          const insp = campaignDir !== null ? await researchState.inspectCampaign(campaignDir) : null;
          resumePhase = insp?.state?.phase === "briefing" || insp?.state?.phase === "research" ? insp.state.phase : null;
          ctx.ui.notify(
            `Research mode ON — briefing phase; campaign ${requestedId} is pinned for this session (resume)` +
              (requestedStateRoot !== null ? `; campaign state under ${requestedStateRoot}` : ""),
            "info",
          );
        } else {
          ctx.ui.notify(
            "Research mode ON — briefing phase; the research kickoff is sent" +
              (requestedStateRoot !== null ? `; campaign state under ${requestedStateRoot}` : ""),
            "info",
          );
        }
        deps.recordAutoresearchActivation(researchWorkDir, true);
        // A research campaign keeps the legacy dashboard, never the expedition
        // view; the pin, the mode and the view move in one transactional step.
        deps.transitionAutoresearchMode(ctx, {
          enabled: true, uiMode: "optimization", stateRoot: requestedStateRoot,
          campaignId: requestedId ?? runtime.researchCampaignId,
        });
        deps.syncBriefPreview(ctx);
        // research-charter: accept the charter AFTER the mode is on (the chain
        // lives in the session runtime). A refusal here stops the launch: no
        // kickoff is sent, no chain state exists. The chain id derives from the
        // pinned (or first pinned-at-draft) campaign: <campaignId>-chain.
        if (requestedCharterPath !== null) {
          const accepted = await deps.acceptLaunchCharter(ctx, researchWorkDir, requestedCharterPath);
          if (accepted === null) return;
          const chainSeedId = requestedId ?? runtime.researchCampaignId ?? `bench-chain`;
          const chainId = `${chainSeedId}-chain`;
          const createdChain = await chainJournal.createChain(researchWorkDir, chainId, requestedId ?? "(root pinned at draft)");
          if (!createdChain.ok) {
            ctx.ui.notify(`Chain refused (${createdChain.reason}): ${createdChain.message}`, "error");
            return;
          }
          deps.transitionAutoresearchMode(ctx, {
            enabled: true, uiMode: "optimization",
            chain: { chainId, workDir: researchWorkDir, charterPath: requestedCharterPath, charterSha256: accepted.sha256, charter: accepted.charter },
          });
          ctx.ui.notify(`Research chain ${chainId} started (charter sha256 ${accepted.sha256.slice(0, 12)}); the chain follows the charter limits`, "info");
        }
        // No /skill: prefix: the metric-loop skill must not be expanded into a research campaign.
        const researchKickoff = resumePhase === "research"
          ? [
              `Research campaign ${requestedId} is already in the research phase. Continue it: call research_questions(action=status), then use separate research_questions calls with action=open plus question_id, action=record plus evidence_ref, or action=close plus question_id/rule_id/verdict as needed for the remaining questions; when the stop rule fires call research_questions(action=stop, rule_id=<rule_id>, reason=<why the stop condition is met>) and research_questions(action=report).`,
            ].join("\n")
          : resumePhase === "briefing"
            ? [
                `Research campaign ${requestedId} already has a brief draft. Continue: research_brief(action=propose) (the owner approves the Brief SHA-256 dialog), then research_questions(action=start, expected_sha256); for each brief question call research_questions(action=open, question_id), research_questions(action=record, evidence_ref), and research_questions(action=close, question_id, rule_id, verdict). When the stop rule fires call research_questions(action=stop, rule_id, reason), then research_questions(action=report).`,
              ].join("\n")
            : [
              "Research campaign: briefing phase." + (description ? ` Campaign description: ${description}.` : ""),
              "The optimization loop does not apply here; research_brief and research_questions are the campaign tools.",
              requestedId !== null
                ? "Wait for the next message: it gives the brief file path and its SHA-256. Then follow it in order:"
                : "Formulate the brief (questions, decision rules, stop rules) from the campaign description, then:",
              "1. research_brief draft with the brief object" + (requestedId !== null ? "," : " (the campaign id is generated for you; note it from the reply),"),
              "2. research_brief propose (the owner approves the Brief SHA-256 dialog),",
              "3. research_questions(action=start, expected_sha256),",
              "4. research_questions(action=open, question_id) for each question, then research_questions(action=record, evidence_ref) and research_questions(action=close, question_id, rule_id, verdict),",
              "5. research_questions(action=stop, rule_id, reason), then research_questions(action=report).",
            ].join("\n");
        deps.sendWhenReady(ctx, researchKickoff);
        return;
      }

      // ===== bugfix subcommand: the reusable defect-hunting loop =====
      // Enter autoresearch mode (so the gated bugfix_mode tools work) and send
      // a self-contained kickoff. It deliberately does NOT load the
      // optimization setup skill: bugfix_mode carries its own campaign config.
      if (/^bugfix(\s|$)/.test(command)) {
        if (runtime.autoresearchMode && (runtime.researchChain?.expedition === true || runtime.uiMode === "expedition")) {
          ctx.ui.notify("Finish the active expedition before starting a bugfix campaign.", "info");
          return;
        }
        if (runtime.autoresearchMode && runtime.researchChain && runtime.researchChain.expedition !== true) {
          ctx.ui.notify("Finish the active research campaign before starting a bugfix campaign.", "info");
          return;
        }
        const workDir = deps.resolveWorkDir(ctx.cwd);
        if (!runtime.autoresearchMode) {
          deps.clearPersistedOffMarker(workDir);
          const researchGate = await deps.ordinaryLaunchResearchGate(workDir, ctx);
          if (researchGate !== "none") {
            ctx.ui.notify(RESEARCH_KICKOFF_NOTICE, "info");
            return;
          }
          if (await deps.campaignBlocksOrdinaryLoop(workDir)) {
            ctx.ui.notify("Candidate campaign active — continue it with candidate_branch status; the bugfix kickoff is not sent.", "info");
            return;
          }
          // Seed the usual ledger session directly: the bugfix kickoff skips
          // optimize_brief/init_experiment but still needs the right metric and
          // direction for run_experiment/log_experiment. An already-active
          // session keeps its own state; re-entry only sends the kickoff.
          const startError = deps.resetStateForNewLaunch(ctx, {
            name: "bugfix",
            metricName: BUGFIX_METRIC_VERSION,
            metricUnit: BUGFIX_METRIC_UNIT,
            bestDirection: BUGFIX_METRIC_DIRECTION,
          });
          if (startError) {
            ctx.ui.notify(startError, "error");
            return;
          }
          deps.recordAutoresearchActivation(workDir, true);
          deps.transitionAutoresearchMode(ctx, { enabled: true, uiMode: "optimization" });
          ctx.ui.notify("Bugfix mode ON — bugfix_mode tools are available", "info");
        }
        const goal = trimmedArgs.slice("bugfix".length).trim();
        deps.sendWhenReady(ctx, `${BUGFIX_KICKOFF}${goal ? ` Goal: ${goal}` : ""}`);
        return;
      }

      // es1.8: the symmetric switch back. A bound expedition is finalized
      // exactly like finalize_research does, but the ordinary launch then
      // continues instead of being refused as "already active". A session
      // that was explicitly turned OFF keeps the legacy launch/restore path.
      if (runtime.autoresearchMode && runtime.researchChain?.expedition === true) {
        const switched = await deps.finalizeExpeditionForOptimization(ctx);
        if (!switched.ok) { ctx.ui.notify(switched.message, "error"); return; }
      }
      // An already-active optimization loop is not a blocker: a plain
      // /autoresearch <goal> is a NEW campaign, so fall through to the reset
      // below. Only /autoresearch continue keeps the previous ledger.

      const workDir = deps.resolveWorkDir(ctx.cwd);
      // An explicit ON always releases the persisted manual-off marker, even
      // when a campaign gate below refuses the kickoff: the marker records the
      // owner's last decision, and this request supersedes it. No activation
      // entry, mode flag or widget is touched by this housekeeping step.
      deps.clearPersistedOffMarker(workDir);
      // bd tj0.2: refuse BEFORE activating. A rejected launch must not leave
      // the mode ON with a widget and no kickoff behind it. Research campaigns
      // in stopped/pending/unreadable states are the exception: their recovery
      // is a manual-check path through the research tools, so the historic
      // notification and the suppressed kickoff are preserved.
      const researchKickoffNotice = RESEARCH_KICKOFF_NOTICE;
      const researchGate = await deps.ordinaryLaunchResearchGate(workDir, ctx);
      if (researchGate === "active") {
        ctx.ui.notify(researchKickoffNotice, "info");
        return;
      }
      if (await deps.campaignBlocksOrdinaryLoop(workDir)) {
        ctx.ui.notify("Candidate campaign active — continue it with candidate_branch status; the legacy autoresearch kickoff is not sent.", "info");
        return;
      }
      deps.resetStateForNewLaunch(ctx);
      deps.recordAutoresearchActivation(workDir, true);
      // The transition registers the widget NOW: the agent may take a while
      // before its first init_experiment, and the mode indicator must be
      // visible immediately after the guards have passed.
      // A research chain is session state owned by the campaign paths: an
      // ordinary launch must not unbind it. Off/stop paths and the expedition
      // → optimization switch clear it explicitly through their transactional
      // transitions (finalizeExpeditionForOptimization / exitResearchMode).
      deps.transitionAutoresearchMode(ctx, { enabled: true, uiMode: "optimization" });
      if (researchGate === "manual") {
        ctx.ui.notify(researchKickoffNotice, "info");
        return;
      }
      const rulesLoaded = deps.hasAutoresearchRules(ctx);
      // No .auto/prompt.md yet — load the create skill so the agent follows the
      // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md when
      // sent with `expandPromptTemplates` (see deps.sendWhenReady), and trailing args
      // are appended as the session goal. Must be sent as its own message that
      // STARTS with `/skill:` so expansion triggers — don't prepend hook output.
      const kickoff = rulesLoaded
        ? `Autoresearch mode active. ${trimmedArgs} ${deps.BENCHMARK_GUARDRAIL}`
        : `/skill:autoresearch-create ${trimmedArgs} ${deps.BENCHMARK_GUARDRAIL}`.replace(/\s+/g, " ").trim();

      ctx.ui.notify(
        rulesLoaded
          ? "Autoresearch mode ON — rules loaded from .auto/prompt.md"
          : "Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill",
        "info",
      );

      const state = runtime.state;
      const activationSteer = await deps.fireHook({
        event: "before",
        cwd: workDir,
        next_run: state.results.length + 1,
        last_run: deps.readLastRun(workDir),
        session: deps.buildSessionSnapshot(state),
      }, ctx);

      // Prepend hook output only when prompt.md exists; otherwise the message
      // must stay `/skill:...`-prefixed for command expansion.
      const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
      deps.sendWhenReady(ctx, message);
    },
  });
  };
}
