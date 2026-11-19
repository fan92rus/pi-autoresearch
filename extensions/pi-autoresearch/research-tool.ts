/**
 * Internal research dispatcher tool (bd pi-autoresearch-8af.5).
 *
 * The tool definition, renderer and executor were moved verbatim out of
 * index.ts: strings, guard order, action names, schema, event names and phase
 * transitions are unchanged. Extension-local collaborators arrive via `deps`
 * (at the call site, helpers declared later use getters to avoid a TDZ read).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as chainJournal from "./chain-journal.ts";
import * as expedition from "./expedition.ts";
import * as researchState from "./research-state.ts";
import { executeResearchAction } from "./research-dispatch.ts";
import { parseEvidenceRef, recordFinding } from "./findings.ts";

type ResearchTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts. */
export interface ResearchToolDeps {
  assertModeActive: (ctx: ExtensionContext) => any;
  refusalText: (r: { reason: string | null; message: string }) => string;
  RESEARCH_ACTION_KEYS: Map<string, string[]>;
  unexpectedArgKeys: (params: Record<string, unknown>, allowed: readonly string[]) => string | null;
  resolveWorkDir: (cwd: string) => string;
  getRuntime: (ctx: ExtensionContext) => any;
  effectiveResearchBase: (workDir: string, ctx: ExtensionContext) => string;
  resolveResearchTarget: (workDir: string, ctx: ExtensionContext) => any;
  researchRefusal: (reason: researchState.RefusalReason, message: string) => researchState.Refusal;
  appendResearchEvent: (dir: string, entry: Record<string, unknown>) => Promise<void>;
  researchSnapshot: (dir: string) => Promise<any>;
  evidenceGateProblem: (workDir: string, brief: any, filePath: string) => Promise<string | null>;
  locateEvidence: (workDir: string, ref: string) => Promise<any>;
  evidenceStatus: (workDir: string, e: any) => Promise<string>;
  questionLines: (workDir: string, brief: any, replay: any) => Promise<string[]>;
  archiveFinishedCampaigns: (workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<string[] | null>;
  archiveOutcome: (workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<researchState.ResearchArchiveOutcome>;
  otherCampaignBusyReason: (workDir: string, ctx: ExtensionContext, selfId: string) => Promise<string | null>;
  sendWhenReady: (ctx: ExtensionContext, message: string, opts?: { steerIfBusy?: boolean }) => void;
  exitResearchMode: (ctx: ExtensionContext, campaignId: string) => void;
  activeChain: (ctx: ExtensionContext) => any;
  chainCanContinue: (ctx: ExtensionContext, workDir: string) => Promise<boolean>;
  collectChainJournals: (workDir: string, ctx: ExtensionContext, stateBase: string, chainId: string) => Promise<any>;
  writeExpeditionFinalReport: (chain: any, finalStatus: string, entries?: chainJournal.ChainEntry[]) => Promise<string>;
  expeditionCloseNudge: (ctx: ExtensionContext, chain: any, map: any, opts: any) => Promise<any>;
  expeditionTerritoryNote: (entries: chainJournal.ChainEntry[]) => string;
  sendChainContinuation: (ctx: ExtensionContext, parentCampaignId: string) => Promise<void>;
  exitChainModeFromPause: (ctx: ExtensionContext, chainId: string) => void;
  hooks: any;
}

export function createResearchTool(deps: ResearchToolDeps): ResearchTool {
  /** bd tj0.3: archive FIRST, leave the loop only on success. Chain campaigns
   *  are included because every caller here is a FINAL chain/campaign exit —
   *  the old "exit first" order only existed to clear the chain pin so the
   *  archive would see them. A null/throw means a stopped or unreadable
   *  campaign still blocks: keep the mode ON and name the manual check. */
  const archiveBeforeExit = async (
    ctx: ExtensionContext,
    workDir: string,
    campaignId: string,
  ): Promise<{ exited: boolean; note: string }> => {
    const { archiveOutcome, effectiveResearchBase, exitResearchMode } = deps;
    let outcome: researchState.ResearchArchiveOutcome = { ok: false, reason: "io" };
    let detail = "";
    try {
      outcome = await archiveOutcome(workDir, effectiveResearchBase(workDir, ctx), ctx, { includeChainCampaigns: true });
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    // A final chain can be stopped while its campaign is still in briefing/
    // research (owner chain_stop during work): nothing finished to move, but
    // the spec still turns the mode OFF. Every other refusal means a campaign
    // still blocks, so the loop must stay ON with an explicit manual check.
    const stillBlocking = !outcome.ok && outcome.reason !== "briefing" && outcome.reason !== "research";
    if (stillBlocking) {
      const reason = outcome.ok ? "io" : outcome.reason;
      return {
        exited: false,
        note: `\n⛔ Manual check required: finished campaigns could not be archived (${reason}${detail ? `: ${detail}` : ""}). ` +
          "Research mode stays ON and the ordinary loop stays blocked until the blocking campaign files are checked by hand.",
      };
    }
    exitResearchMode(ctx, campaignId);
    return { exited: true, note: outcome.ok && outcome.archived.length > 0 ? `\n🗄 Archived finished campaigns: ${outcome.archived.join(", ")}.` : "" };
  };

  const researchTool: ResearchTool = {
    name: "research",
    label: "Internal research dispatcher (not exposed)",
    exposure: "hidden",
    description:
      "Internal combined dispatcher used only by research_questions and expedition_map adapters. Not available as a model-callable tool. " +
      "Question operations: start (expected_sha256 must match the approved brief), open (one question id from the brief), record (evidence_ref path:lines or path#anchor), " +
      "close (verdict plus rule_id of that question), stop, status, report, resolve (OPERATOR-only pending-op dialog), chain_stop. " +
      "Legacy expedition calls use action=expedition; new calls should use expedition_map. Question close closes a CAMPAIGN QUESTION; map resolve/reject closes a MAP DIRECTION using refs.",
    promptSnippet: "Internal dispatcher for research_questions and expedition_map adapters",
    promptGuidelines: [
      "Internal dispatcher; use research_questions for campaign work and expedition_map for map transitions.",
      "research_questions(action=close) closes a campaign QUESTION with question_id, rule_id, verdict and evidence; it does not close a map direction.",
      "expedition_map with subaction=resolve or subaction=reject closes a MAP DIRECTION and needs refs naming already-closed questions; it does not take rule_id/verdict.",
      "research_questions(action=resolve) is OPERATOR-only pending-operation resolution and requires owner confirmation; it is unrelated to map direction resolve.",
      "STOP on manual_check_required or brief_changed.",
    ],
    renderCall(args: any, _theme?: any) {
      // This renderer is deliberately args-only: it runs before execute and must never touch the filesystem.
      // Frame contract (review R1): renderCall MUST always return a Text component — a defined
      // renderCall returning undefined breaks TUI rendering (MouseRegion renders its child
      // unguarded in pi-tui 1.5.1). Every non-rendering branch returns the plain default header
      // instead of undefined (spec fail-soft). The theme is optional: headless/test callers pass
      // no theme, so the fallback uses plain markup-free text there.
      const fallback = () => {
        try {
          const t = _theme;
          return new Text(t ? t.fg("toolTitle", t.bold("research ")) : "research ", 0, 0);
        } catch {
          return new Text("research ", 0, 0);
        }
      };
      try {
        if (args?.action !== "expedition") return fallback();
        const clean = (value: unknown): string => {
          if (typeof value !== "string") return "";
          const line = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
          return line.length > 120 ? `${Array.from(line).slice(0, 119).join("")}…` : line;
        };
        const quote = (value: unknown): string => {
          const text = clean(value);
          return text ? `«${text}»` : "";
        };
        const subaction = args?.subaction;
        const dir = quote(args?.dir);
        const reason = clean(args?.why ?? args?.reason);
        const reasonLine = reason ? ` └ ${subaction === "activate" ? "why" : "reason"}: ${reason}` : "";
        let text: string;
        switch (subaction) {
          case "activate":
            if (!dir) return fallback();
            text = `🔄 activate ${dir}${reasonLine}`;
            break;
          case "resolve":
          case "reject": {
            if (!dir) return fallback();
            const refs = Array.isArray(args?.refs) ? args.refs : [];
            const shown = refs.slice(0, 3).map((ref: any) => {
              const campaign = clean(ref?.campaign);
              const question = clean(ref?.question);
              return campaign && question ? `${campaign}/${question}` : "";
            }).filter(Boolean);
            const more = Math.max(0, refs.length - shown.length);
            const refText = shown.length ? ` ← ${shown.join(", ")}${more ? ` +${more} more` : ""}` : "";
            text = `${subaction === "resolve" ? "✅" : "✗"} ${subaction} ${dir}${refText}`;
            break;
          }
          case "advisory": {
            if (!dir) return fallback();
            const reviewRef = clean(args?.review_ref);
            text = `❓ advisory ${dir}${reviewRef ? ` ← ${reviewRef}` : ""}${reasonLine}`;
            break;
          }
          case "park":
          case "reopen":
            if (!dir) return fallback();
            text = `${subaction === "park" ? "💤" : "🔓"} ${subaction} ${dir}${reasonLine}`;
            break;
          case "pivot": {
            const from = quote(args?.from), to = quote(args?.to);
            if (!from || !to) return fallback();
            text = `🔀 pivot ${from} → ${to}${reasonLine}`;
            break;
          }
          case "expedition_stop":
            text = "🏁 expedition stop";
            break;
          default:
            return fallback();
        }
        return new Text(text, 0, 0);
      } catch {
        return fallback();
      }
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "open", "record", "close", "stop", "status", "report", "resolve", "chain_stop", "expedition"],
          description: "Research action to perform.",
        },
        expected_sha256: { type: "string", description: "start only: sha256 of the approved brief (64 lowercase hex)." },
        question_id: { type: "string", description: "open/close: question id from the approved brief." },
        evidence_ref: { type: "string", description: "record only: path:lines or path#anchor inside the work directory." },
        rule_id: { type: "string", description: "close: decision rule id of the question; stop: stop rule id of the brief." },
        verdict: { type: "string", description: "close only: one of the brief's declared verdicts (default confirmed, rejected, inconclusive, waiting_for_data)." },
        reason: { type: "string", description: "close: required for inconclusive and waiting_for_data. stop: the stop condition you mark as met." },
      },
      required: ["action"],
    } as any,

    async execute(_toolCallId: string, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
      const {
        assertModeActive, refusalText, RESEARCH_ACTION_KEYS, unexpectedArgKeys,
        resolveWorkDir, getRuntime, effectiveResearchBase, resolveResearchTarget,
        researchRefusal, appendResearchEvent, researchSnapshot, evidenceGateProblem,
        locateEvidence, evidenceStatus, questionLines, archiveFinishedCampaigns,
        otherCampaignBusyReason, sendWhenReady, exitResearchMode, activeChain,
        chainCanContinue, collectChainJournals, writeExpeditionFinalReport,
        expeditionCloseNudge, expeditionTerritoryNote, sendChainContinuation,
        exitChainModeFromPause, hooks: testHooks,
      } = deps;
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const action = params?.action;
      const reply = (text: string) => ({ content: [{ type: "text", text }], details: { action } });
      const fail = (reason: string, message: string) => ({
        content: [{ type: "text", text: refusalText({ reason, message }) }],
        details: { action, reason },
      });

      const allowed = RESEARCH_ACTION_KEYS.get(action);
      if (!allowed) {
        return fail("invalid_argument", `unknown action ${JSON.stringify(String(action))}; allowed: start open record close stop status report resolve chain_stop expedition`);
      }
      // Redirect hint (user bug report 2026-11-12, lob-collector-data): the agent
      // repeatedly sent question-close fields (rule_id/verdict) to the expedition
      // map action. The plain field list did not say WHERE those fields belong, so
      // name the right action for the known cross-scheme confusion.
      const argHint = (extraKeys: string[]): string | null => {
        const hasCloseOnly = extraKeys.includes("rule_id") || extraKeys.includes("verdict");
        if (hasCloseOnly && action === "expedition") {
          return "rule_id/verdict belong to closing a campaign QUESTION: use research_questions(action=close, question_id, rule_id, verdict, reason). To close a map DIRECTION make a separate expedition_map call with subaction=resolve or subaction=reject and refs to already-closed questions; advisory and park are distinct subactions.";
        }
        if (hasCloseOnly && (action === "open" || action === "record")) {
          return "rule_id/verdict belong to research_questions(action=close, question_id, rule_id, verdict), not to this action";
        }
        if (action === "record" && extraKeys.includes("question_id")) {
          return "record binds evidence to the CURRENTLY OPEN question automatically (the campaign decides which question is open); drop question_id — or open the intended question first with research_questions(action=open, question_id)";
        }
        if (action === "open" && extraKeys.includes("evidence_ref")) {
          return "evidence is recorded by a separate call research_questions(action=record, evidence_ref) AFTER opening; open only declares the question";
        }
        return null;
      };
      const extraKeys = Object.keys(params ?? {}).filter((k) => !allowed.includes(k));
      const hint = argHint(extraKeys);
      const extra = unexpectedArgKeys(params ?? {}, allowed);
      if (extra) return fail("invalid_argument", hint ? `${extra}. Hint: ${hint}` : extra);
      const workDir = resolveWorkDir(ctx.cwd);
      // The campaign id is never taken from the model: the pinned id (launch
      // command) wins; resolve stays exempt (operator-only, must reach any
      // campaign); otherwise the single existing campaign is used. Campaign
      // state resolves under the effective base (pinned --state-root) first,
      // then the default root.
      const pinnedId = params?.action === "resolve" ? null : getRuntime(ctx).researchCampaignId;
      const target = pinnedId !== null
        ? (() => {
            const stateBase = effectiveResearchBase(workDir, ctx);
            const r = researchState.resolveCampaignDir(stateBase, pinnedId);
            if (r.ok && (fs.existsSync(r.dir) || stateBase === workDir)) return { ok: true as const, dir: r.dir, id: pinnedId };
            if (stateBase !== workDir) {
              const fallback = researchState.resolveCampaignDir(workDir, pinnedId);
              if (fallback.ok && fs.existsSync(fallback.dir)) return { ok: true as const, dir: fallback.dir, id: pinnedId };
            }
            return r.ok && fs.existsSync(r.dir) ? { ok: true as const, dir: r.dir, id: pinnedId } : r;
          })()
        : resolveResearchTarget(workDir, ctx);
      const resolvedTarget = await target;
      if (!resolvedTarget.ok) return fail(resolvedTarget.reason, resolvedTarget.message);
      const { dir, id } = resolvedTarget;

      if (action === "resolve") {
        // Operator-only (design §9): the model cannot clear the marker; the dialog consent is required.
        const insp = await researchState.inspectCampaign(dir);
        if (!insp.pendingOp) return fail("invalid_argument", `nothing to resolve: campaign status is ${insp.status} (${insp.message})`);
        if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
          return fail("manual_check_required", "resolve is an operator action and needs an interactive dialog; the pending operation stays");
        }
        const confirmed = await ctx.ui.confirm(
          "Research campaign: manual resolution",
          `Pending operation: ${insp.pendingOp.name} (started ${insp.pendingOp.started_at}). Have you checked the campaign files by hand? ` +
            "Consenting clears the pending-op marker; state.json is not changed.",
        );
        if (confirmed !== true) {
          return fail("manual_check_required", "resolve requires explicit operator consent in the dialog; the pending operation stays");
        }
        const res = await researchState.manualResolvePendingOp(dir, researchState.OPERATOR_CONFIRMATION);
        if (!res.ok) return fail(res.reason, res.message);
        return reply("✅ Pending operation resolved by the operator; the marker is cleared. Check the campaign with research_questions(action=status).");
      }

      const dispatched = await executeResearchAction(params, ctx, workDir, {
        activeChain, collectChainJournals, effectiveResearchBase, researchSnapshot,
        expeditionCloseNudge, sendWhenReady, refusalText, hooks: testHooks,
      });
      if (dispatched !== undefined) return dispatched;

      if (action === "chain_stop") {
        const chain = activeChain(ctx);
        if (chain === null) {
          return fail("invalid_argument", "no active research chain in this session: chains are started by '/autoresearch research --charter <path>'");
        }
        // Verify the journal first (fail closed on damage or charter change).
        const verified = await chainJournal.verifyChain(chain.workDir, chain.chainId);
        if (!verified.ok) {
          await chainJournal.markManualCheckRequired(chain.workDir, chain.chainId, verified.message).catch(() => undefined);
          return fail("manual_check_required", `research chain ${chain.chainId}: ${verified.message}`);
        }
        const status = await chainJournal.statusOf(chain.workDir, chain.chainId);
        if (chainJournal.isFinal(status)) {
          return fail("invalid_transition", `research chain ${chain.chainId} is already ${status} (final); no further chain actions`);
        }
        // Charter stop rules are agent self-reports (spec: residual risk declared);
        // they name a rule_id from the charter and do NOT need the owner dialog.
        const ruleId = params.rule_id;
        if (typeof ruleId === "string") {
          const rules = chain.charter.stop_rules ?? [];
          if (!rules.includes(ruleId)) {
            return fail("invalid_argument", `stop rule ${JSON.stringify(ruleId)} is not in the charter (${rules.length ? rules.join("; ") : "no charter stop rules"})`);
          }
          // Review M4/N2: a journal write that fails must not turn the mode OFF
          // while the journal still says active/awaiting_child.
          if (chain.expedition && ruleId === "territory_complete") {
            const mapResult = expedition.replayExpeditionMap(verified.entries);
            if (!mapResult.ok) return fail(mapResult.reason, mapResult.message);
            const territory = expedition.territoryComplete(mapResult.map);
            if (!territory.value) return fail("invalid_transition", `territory_complete is false; open directions: ${territory.openDirs.join(", ") || "none"}${territory.pivotTail ? "; pivot after the last closure" : ""}`);
          }
          if (chain.expedition) {
            const chainDirPath = chainJournal.chainDir(chain.workDir, chain.chainId);
            if (!chainDirPath) return fail("manual_check_required", "chain directory is unavailable");
            const stop = await chainJournal.appendEntry(chainDirPath, chain.workDir, chain.chainId, "expedition_stop", {rule:ruleId,basis:"rule"});
            if (!stop.ok) return fail(stop.reason as never, `chain stop not recorded: ${stop.message}`);
          }
          const ruleWrite = await chainJournal.setChainStatus(chain.workDir, chain.chainId, "stopped_by_rule");
          if (!ruleWrite.ok) return fail(ruleWrite.reason as never, `chain stop not recorded: ${ruleWrite.message}`);
          const reportNote = chain.expedition ? await writeExpeditionFinalReport(chain, "stopped_by_rule") : "";
          const territoryNote = chain.expedition ? expeditionTerritoryNote(verified.entries) : "";
          if (status === "awaiting_child") {
            exitChainModeFromPause(ctx, chain.chainId);
            return reply(`🛑 Research chain ${chain.chainId} stopped by charter rule ${JSON.stringify(ruleId)} (charter stop rule, pause): research mode is OFF. (self-report: verify the rule condition actually fired)${reportNote ? ` ${reportNote}.` : ""}${territoryNote}`);
          }
          return reply(`🛑 Research chain ${chain.chainId} stopped by charter rule ${JSON.stringify(ruleId)} (self-report: verify the rule condition actually fired). ${reportNote ? `${reportNote}. ` : ""}New chain briefs are refused; the active campaign finishes its work and writes the final report, which turns research mode OFF.${territoryNote}`);
        }
        // Owner stop: the model cannot confirm for the owner — a dialog is required.
        if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
          return fail("manual_check_required", "chain_stop is an owner action and needs an interactive dialog; the chain keeps running");
        }
        const confirmed = await ctx.ui.confirm(
          "Research chain: owner stop",
          `Stop the research chain ${chain.chainId} now? No new chain campaigns will be created; the active campaign (if any) finishes its work and the final report turns research mode OFF. In awaiting_child the mode turns OFF immediately.`,
        );
        if (confirmed !== true) {
          return fail("invalid_argument", "chain_stop requires explicit owner consent in the dialog; the chain keeps running");
        }
        if (chain.expedition) {
          const chainDirPath = chainJournal.chainDir(chain.workDir, chain.chainId);
          if (!chainDirPath) return fail("manual_check_required", "chain directory is unavailable");
          const stop = await chainJournal.appendEntry(chainDirPath, chain.workDir, chain.chainId, "expedition_stop", {rule:ruleId ?? "owner",basis:"owner"});
          if (!stop.ok) return fail(stop.reason as never, `chain stop not recorded: ${stop.message}`);
        }
        const ownerWrite = await chainJournal.setChainStatus(chain.workDir, chain.chainId, "stopped_by_owner");
        if (!ownerWrite.ok) return fail(ownerWrite.reason as never, `chain stop not recorded: ${ownerWrite.message}`);
        const reportNote = chain.expedition ? await writeExpeditionFinalReport(chain, "stopped_by_owner") : "";
        const territoryNote = chain.expedition ? expeditionTerritoryNote(verified.entries) : "";
        if (status === "awaiting_child") {
          exitChainModeFromPause(ctx, chain.chainId);
          return reply(`🛑 Research chain ${chain.chainId} stopped by the owner (pause): research mode is OFF.${reportNote ? ` ${reportNote}.` : ""}${territoryNote}`);
        }
        return reply(`🛑 Research chain ${chain.chainId} stopped by the owner. ${reportNote ? `${reportNote}. ` : ""}New chain briefs are refused; the open vector is not interrupted; the active campaign finishes its work per research rules and writes the final report, which turns research mode OFF.${territoryNote}`);
      }

      if (action === "start") {
        const expected = params.expected_sha256;
        if (typeof expected !== "string") {
          return fail("invalid_argument", "start requires expected_sha256: the sha256 of the approved brief from research_brief propose");
        }
        // Chain gate: every chain action verifies the journal (fail closed on
        // damage) and refuses in a final status (spec: chain actions refuse).
        const chain = activeChain(ctx);
        if (chain !== null) {
          const verified = await chainJournal.verifyChain(chain.workDir, chain.chainId);
          if (!verified.ok) return fail("manual_check_required", `research chain ${chain.chainId}: ${verified.message}`);
          const status = await chainJournal.statusOf(chain.workDir, chain.chainId);
          const stop = chainJournal.actionRefusalForStatus(status, { allowReport: true });
          if (stop !== null) return fail("invalid_transition", `research chain ${chain.chainId} is ${status}: ${stop.message}`);
        }
        // One campaign works at a time (review B3): refuse the start when any
        // other campaign under the research root is already in the research
        // phase or holds a pending operation.
        const otherBusy = await otherCampaignBusyReason(workDir, ctx, id);
        if (otherBusy) return fail("invalid_transition", otherBusy);
        const checked = await researchState.checkBriefApproval(dir, expected);
        if (!checked.ok) return fail(checked.reason, checked.message);
        const started = await researchState.transitionPhase(dir, "start research phase", "briefing", "research");
        if (!started.ok) return fail(started.reason, started.message);
        return reply(
          `✅ Research phase started for campaign ${id} (brief sha256 ${checked.sha256}). Questions come only from the brief. Next: research_questions(action="open", question_id=<id from brief>).`,
        );
      }

      const snap = await researchSnapshot(dir);
      if (!snap.ok) return fail(snap.reason, snap.message);

      if (action === "status") {
        const insp = await researchState.inspectCampaign(dir);
        const lines = [
          `Research campaign ${id}: phase ${snap.state.phase}`,
          `Campaign state: ${insp.status} — ${insp.message}`,
        ];
        if (insp.pendingOp) lines.push(`Pending op: ${insp.pendingOp.name} (started ${insp.pendingOp.started_at}) — manual check required`);
        if (snap.brief) {
          lines.push(...(await questionLines(workDir, snap.brief, snap.replay)));
        } else {
          lines.push("Brief: not approved; no vector can be opened");
        }
        if (snap.replay.open) lines.push(`Open vector: ${snap.replay.open}`);
        const stop = snap.replay.stop;
        if (stop) lines.push(`Stop rule ${stop.rule_id} triggered: ${stop.reason}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { action, inspection: insp as any } };
      }

      if (action === "report") {
        if (!snap.brief || !snap.briefSha256) return fail("not_approved", "the report needs an approved brief");
        const brief = snap.brief;
        const stop = snap.replay.stop;
        const allEvidence = [...snap.replay.vectors.values()].flatMap((v) => v.evidence);
        const evidenceStates = await Promise.all(allEvidence.map((e) => evidenceStatus(workDir, e)));
        const changed = evidenceStates.filter((s) => s !== "ok").length;
        const lines = [
          `# Research campaign report: ${id}`,
          `Phase: ${snap.state.phase}`,
          `Brief sha256: ${snap.briefSha256}`,
          `Goal: ${brief.goal}`,
          `Plan source: ${brief.plan_source}`,
          "",
          "## Caveat (verbatim from the brief)",
          brief.caveat_block,
          "",
          "## Questions",
          ...(await questionLines(workDir, brief, snap.replay)),
          "",
          "## Stop rules",
          ...brief.stop_rules.map((r) => `${r.id}: ${r.when}${stop && stop.rule_id === r.id ? ` — TRIGGERED (${stop.reason})` : ""}`),
          "",
          "## Process metrics (declared by the brief; the system does not compute them)",
          ...brief.process_metrics.map((m) => `- ${m}`),
          "",
          "## Evidence integrity",
          `Evidence records: ${evidenceStates.length}; changed or missing: ${changed}`,
          "No target metric: the campaign answers only the questions of its brief.",
        ];
        const reportText = lines.join("\n");
        // Persist the report next to state.json: the campaign leaves a durable
        // artifact (bd pi-autoresearch-7ii). A write failure only warns — the
        // report text is still returned. Report is NOT gated on stop.
        const reportPath = path.join(dir, "report.md");
        let savedNote: string;
        let saved = false;
        try {
          await researchState.writeFileAtomic(reportPath, reportText + "\n");
          saved = true;
          savedNote = `Report saved to ${path.relative(workDir, reportPath)}`;
        } catch (err) {
          savedNote = `warning: the report could not be saved to ${path.relative(workDir, reportPath)} (${err instanceof Error ? err.message : String(err)})`;
        }
        // Chain-aware exit (research-charter): an active chain decides the exit
        // by the "can continue" predicate; outside a chain the legacy rule holds.
        const chain = activeChain(ctx);
        if (chain !== null && saved) {
          const verified = await chainJournal.verifyChain(chain.workDir, chain.chainId);
          if (!verified.ok) {
            await chainJournal.markManualCheckRequired(chain.workDir, chain.chainId, verified.message).catch(() => undefined);
            return reply(reportText + "\n\n" + savedNote + "\nResearch chain journal is damaged: actions are blocked until manual check (research_questions(action=status)). Research mode stays ON.");
          }
          const chainStatusNow = await chainJournal.statusOf(chain.workDir, chain.chainId);
          // Exception (spec): the final report of the active campaign of a chain
          // STOPPED during work turns the mode OFF regardless of the campaign phase.
          if (chainJournal.isFinal(chainStatusNow)) {
            const finish = await archiveBeforeExit(ctx, workDir, id);
            if (!finish.exited) return reply(reportText + "\n\n" + savedNote + finish.note);
            const archiveNote1 = finish.note;
            const expeditionNote = chain.expedition ? await writeExpeditionFinalReport(chain, chainStatusNow, verified.entries) : "";
            return reply(reportText + (archiveNote1 ? archiveNote1 + "\n" : "\n") + "\n\n" + savedNote + (expeditionNote ? `\n${expeditionNote}` : "") + "\n" + "Research mode is OFF. The chain is " + chainStatusNow + "." + (archiveNote1 ? " Note: the finished campaign moved to .auto/research-archive (report.md is inside the archive)." : ""));
          }
          if (chainStatusNow === "awaiting_child") {
            // Already waiting: no new continuation without a new agent action.
            return reply(reportText + "\n\n" + savedNote + "\nThe chain is awaiting the brief of the next campaign (parent " + id + "); write research_brief draft with finding_refs citing this chain.");
          }
          // Spec: the report of a campaign that REACHED the charter limits
          // (prospective predicate false) sets limit_reached and turns the mode
          // OFF — a forbidden child must never be prompted for.
          if (!(await chainCanContinue(ctx, workDir))) {
            // Review (ef7d8951): a charter change inside the predicate sets
            // manual_check_required; it must not be overwritten by limit_reached.
            if ((await chainJournal.statusOf(chain.workDir, chain.chainId)) === "manual_check_required") {
              const finish = await archiveBeforeExit(ctx, workDir, id);
              if (!finish.exited) return reply(reportText + "\n\n" + savedNote + finish.note);
              const archiveNote3 = finish.note;
              return reply(reportText + (archiveNote3 ? archiveNote3 + "\n" : "\n") + "\n\n" + savedNote + "\nThe charter file changed since the owner confirmed it: chain status manual_check_required. Research mode is OFF (spec: the predicate is false after the report)." + (archiveNote3 ? " Note: the finished campaign moved to .auto/research-archive." : ""));
            }
            const limitWrite = await chainJournal.setChainStatus(chain.workDir, chain.chainId, "limit_reached");
            if (!limitWrite.ok) {
              // Review M4/N2 (same invariant as chain_stop): a journal write that
              // fails must not turn the mode OFF while the journal still says
              // active/awaiting_child. The report stays saved; the owner fixes
              // the journal and reports again.
              let freshStatus = "active";
              try { freshStatus = await chainJournal.statusOf(chain.workDir, chain.chainId); } catch { /* best effort */ }
              return reply(reportText + "\n\n" + savedNote + `\nwarning: limit_reached could not be recorded (${limitWrite.message}); the chain stays ${freshStatus}; research mode stays ON; fix the journal and report again.`);
            }
            const finish = await archiveBeforeExit(ctx, workDir, id);
            if (!finish.exited) return reply(reportText + "\n\n" + savedNote + finish.note);
            const archiveNote4 = finish.note;
            return reply(reportText + (archiveNote4 ? archiveNote4 + "\n" : "\n") + "\n\n" + savedNote + "\nResearch mode is OFF: the charter limit is reached (chain limit_reached). No further chain campaigns are created." + (archiveNote4 ? " Note: the finished campaign moved to .auto/research-archive." : ""));
          }
          // Owner decision (review M1): the chain advances only on a report of a
          // campaign in phase stopped. A report written in phase research leaves
          // the chain active and sends no continuation (explicit gate, not a side effect).
          if (snap.state.phase !== "stopped") {
            return reply(reportText + "\n\n" + savedNote + "\nThe chain does not advance on a report written in phase research: stop the campaign first, then report. Chain status stays " + chainStatusNow + ", research mode stays ON.");
          }
          // Intermediate report: the chain can continue — the mode stays ON, the
          // chain moves to awaiting_child, ONE continuation with the parent id.
          await chainJournal.setChainStatus(chain.workDir, chain.chainId, "awaiting_child");
          if (!getRuntime(ctx).chainContinuationSent) {
            await sendChainContinuation(ctx, id);
          }
          return reply(reportText + "\n\n" + savedNote + "\nResearch mode stays ON: the chain can continue. Status awaiting_child — write the brief of the next campaign (parent " + id + ") with research_brief draft; the brief is auto-approved by the charter checks.");
        }
        // A report of a STOPPED campaign is the campaign's last step: leave
        // research mode now (the report is already on disk).
        if (snap.state.phase === "stopped" && saved) {
          const finish = await archiveBeforeExit(ctx, workDir, id);
          if (!finish.exited) return reply(reportText + "\n\n" + savedNote + finish.note);
          const archiveNote2 = finish.note;
          return reply(reportText + (archiveNote2 ? archiveNote2 + "\n" : "\n") + "\n\n" + savedNote + "\nResearch mode is OFF.");
        }
        if (snap.state.phase === "stopped") {
          return reply(reportText + "\n\n" + savedNote + "\nResearch mode stays ON: the report is not saved. Fix the cause and run research_questions(action=report) again.");
        }
        return reply(reportText + "\n\n" + savedNote);
      }

      // Vector actions: the brief must be approved and the campaign in phase research.
      if (!snap.brief) return fail("not_approved", "the brief is not approved; no vector can be opened, recorded or closed");
      const brief = snap.brief;
      const phaseRefusal = () =>
        fail("invalid_transition", `campaign is in phase ${snap.state.phase}; ${action} needs phase research`);
      const inResearchPhase = (cur: researchState.CampaignState) => cur.phase === "research";

      if (action === "open") {
        const qid = params.question_id;
        if (typeof qid !== "string") return fail("invalid_argument", "open requires question_id");
        if (snap.state.phase !== "research") return phaseRefusal();
        const question = brief.questions.find((q) => q.id === qid);
        if (!question) return fail("invalid_argument", `question ${JSON.stringify(qid)} is not in the approved brief`);
        if (snap.replay.open !== null) return fail("invalid_transition", `vector ${snap.replay.open} is open; close it before opening another`);
        if (snap.replay.vectors.has(qid)) return fail("invalid_transition", `vector ${qid} is already closed; a closed vector is never reopened`);
        const done = await researchState.updateState(
          dir,
          `open vector ${qid}`,
          (cur) => (inResearchPhase(cur) ? { ok: true, next: cur } : researchRefusal("invalid_transition", `campaign is in phase ${cur.phase}; open needs phase research`)),
          async () => appendResearchEvent(dir, { event: "open", question_id: qid, question_text: question.text }),
        );
        if (!done.ok) return fail(done.reason, done.message);
        return reply(`✅ Vector ${qid} opened: ${question.text}`);
      }

      if (action === "record") {
        const ref = params.evidence_ref;
        if (typeof ref !== "string" || ref.trim() === "") {
          return fail("invalid_argument", "record requires evidence_ref: path:lines or path#anchor inside the work directory");
        }
        // Format gate (review M2): a bare path that parseEvidenceRef cannot
        // parse would later break the findings routing on close (which stores
        // the recorded ref verbatim); refuse it here with the expected format.
        if (!parseEvidenceRef(ref).ok) {
          return fail(
            "invalid_argument",
            `evidence_ref must be path:lines or path#anchor (e.g. logs/app.log:5-9 or logs/app.log#anchor-substring), not a bare path: ${JSON.stringify(ref)}`,
          );
        }
        if (snap.state.phase !== "research") return phaseRefusal();
        const openId = snap.replay.open;
        if (openId === null) return fail("invalid_transition", "no vector is open; open a question before recording evidence");
        const located = await locateEvidence(workDir, ref);
        if (!located.ok) return fail(located.reason, located.message);
        const gateProblem = await evidenceGateProblem(workDir, brief, located.path);
        if (gateProblem !== null) return fail("evidence_gate_blocked", gateProblem);
        const done = await researchState.updateState(
          dir,
          `record evidence for ${openId}`,
          (cur) => (inResearchPhase(cur) ? { ok: true, next: cur } : researchRefusal("invalid_transition", `campaign is in phase ${cur.phase}; record needs phase research`)),
          async () =>
            appendResearchEvent(dir, {
              event: "record",
              question_id: openId,
              evidence_ref: ref,
              evidence_path: located.path,
              evidence_sha256: located.sha256,
            }),
        );
        if (!done.ok) return fail(done.reason, done.message);
        return reply(`✅ Evidence recorded for vector ${openId}: ${ref} (sha256 ${located.sha256}).`);
      }

      if (action === "close") {
        const { question_id: qid, rule_id: rid, verdict, reason } = params;
        if (typeof qid !== "string" || typeof rid !== "string") return fail("invalid_argument", "close requires question_id and rule_id");
        const declaredVerdicts = researchState.briefVerdicts(brief);
        if (typeof verdict !== "string" || !declaredVerdicts.includes(verdict)) {
          return fail("invalid_argument", `verdict must be one of the brief's declared verdicts: ${declaredVerdicts.join(", ")}`);
        }
        const needsReason = verdict === "inconclusive" || verdict === "waiting_for_data";
        if (needsReason && (typeof reason !== "string" || reason.trim() === "")) {
          return fail("invalid_argument", `verdict ${verdict} requires a reason`);
        }
        if (snap.state.phase !== "research") return phaseRefusal();
        const question = brief.questions.find((q) => q.id === qid);
        if (!question) return fail("invalid_argument", `question ${JSON.stringify(qid)} is not in the approved brief`);
        const rule = question.decision_rules.find((r) => r.id === rid);
        if (!rule) return fail("invalid_argument", `rule ${JSON.stringify(rid)} is not a decision rule of question ${qid}`);
        if (rule.verdict !== verdict) return fail("invalid_argument", `rule ${rid} has verdict ${rule.verdict}, not ${verdict}`);
        if (snap.replay.open !== qid) {
          return fail("invalid_transition", snap.replay.open ? `vector ${snap.replay.open} is open, not ${qid}` : `vector ${qid} is not open`);
        }
        const vector = snap.replay.vectors.get(qid);
        if (!vector || vector.evidence.length === 0) {
          return fail("invalid_transition", `no evidence recorded for ${qid}; record evidence before closing`);
        }
        const done = await researchState.updateState(
          dir,
          `close vector ${qid}`,
          (cur) => (inResearchPhase(cur) ? { ok: true, next: cur } : researchRefusal("invalid_transition", `campaign is in phase ${cur.phase}; close needs phase research`)),
          async () =>
            appendResearchEvent(dir, {
              event: "close",
              question_id: qid,
              question_text: question.text,
              rule_id: rid,
              rule_when: rule.when,
              verdict,
              reason: typeof reason === "string" ? reason : null,
              evidence_count: vector.evidence.length,
            }),
        );
        if (!done.ok) return fail(done.reason, done.message);
        // Findings routing (bd pi-autoresearch-7ii): decisive verdicts
        // (confirmed/rejected) append a finding to the PROJECT root
        // .auto/findings.jsonl, so campaign verdicts become searchable
        // precedents for later sessions. inconclusive/waiting_for_data route
        // nothing. A routing failure NEVER fails the close: warn only.
        let findingNote = "";
        if (verdict === "confirmed" || verdict === "rejected") {
          const qText = question.text.length > 200 ? question.text.slice(0, 197) + "..." : question.text;
          try {
            const res = await recordFinding(workDir, {
              theme: "behavior",
              description: `${id}/${qid}: ${verdict} by ${rid} — ${qText}`,
              evidence_ref: vector.evidence[0].evidence_ref,
            });
            findingNote = res.ok ? ` Finding recorded: ${res.value.id}.` : ` (warning: the finding could not be recorded — ${res.errors.join("; ")})`;
          } catch {
            findingNote = " (warning: the finding could not be recorded)";
          }
        }
        const afterClose = await researchSnapshot(dir);
        const allClosed = afterClose.ok && afterClose.brief !== null && afterClose.replay.vectors.size > 0 &&
          afterClose.brief.questions.every((q) => afterClose.replay.vectors.get(q.id)?.status === "closed");
        // Expedition chains (live-stall fix 2026-11-12): after the LAST question
        // closes, the next executable step is closing the MAP DIRECTION — the
        // agent stalled in the live run because nothing said question close ≠
        // direction resolve at that point. Non-expedition campaigns keep the
        // exact legacy nudge (regression contract). Review blocker B1: in an
        // expedition the stop suggestion is NOT offered here — campaign stop is
        // legal only in the exhaustion branch of the post-close nudge (all
        // questions closed AND no new vectors in sight); with open directions
        // or finding-driven hypotheses the map hint routes to resolve/open, so
        // a premature "pick a stop rule" would contradict the owner contract.
        const chainCtx = activeChain(ctx);
        const mapHint = allClosed && afterClose.ok && afterClose.replay.stop === null && chainCtx?.expedition
          ? " Then close the map direction with a separate expedition_map call — expedition_map(subaction=resolve, dir=<name>, refs=[{campaign,question}]) citing the closed questions, or expedition_map(subaction=reject, dir=<name>, refs=[...]) / expedition_map(subaction=advisory, ...) / expedition_map(subaction=park, ...): question close is not direction resolve."
          : "";
        const closingNudge = allClosed && afterClose.ok && afterClose.replay.stop === null && !chainCtx?.expedition
          ? " All questions are closed: pick a stop rule, then call research_questions(action=stop, rule_id=<rule_id>, reason=<why the stop condition is met>) and research_questions(action=report)."
          : "";
        return reply(`✅ Vector ${qid} closed: ${verdict} by rule ${rid}.` + findingNote + closingNudge + mapHint);
      }

      if (action === "stop") {
        const rid = params.rule_id;
        const reason = params.reason;
        if (typeof rid !== "string") return fail("invalid_argument", "stop requires rule_id: a stop rule of the brief");
        if (typeof reason !== "string" || reason.trim() === "") {
          return fail("invalid_argument", "stop requires reason: the stop condition you mark as met");
        }
        const stopRule = brief.stop_rules.find((s) => s.id === rid);
        if (!stopRule) return fail("invalid_argument", `stop rule ${JSON.stringify(rid)} is not in the approved brief`);
        if (snap.state.phase !== "research") return phaseRefusal();
        const done = await researchState.transitionPhase(
          dir,
          "stop research phase",
          "research",
          "stopped",
          async () => appendResearchEvent(dir, { event: "stop", rule_id: rid, stop_when: stopRule.when, reason }),
        );
        if (!done.ok) return fail(done.reason, done.message);
        return reply(`🛑 Research stopped by ${rid}. No vector can be opened in this campaign; a new campaign needs a new brief. ${activeChain(ctx) !== null ? "Next: research_questions(action=report); for a chain campaign the report leaves the chain awaiting_child and research mode stays ON." : "Next: research_questions(action=report); it writes the final report and leaves research mode."}`);
      }

      return fail("invalid_argument", `unknown action ${JSON.stringify(String(action))}`);
    },
  };
  return researchTool;
}
