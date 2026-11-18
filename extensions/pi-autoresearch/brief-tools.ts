/**
 * optimize_brief + expedition_brief tools (extracted from index.ts; the
 * registered tool bodies are byte-identical apart from deps reads at the call
 * site). Transcript rows, refusals, guard order, owner dialogs, saved draft
 * replies and reply text are preserved. Extension-local collaborators arrive
 * through `deps` and are read as `deps.foo` at the point of use — never frozen
 * in an execute() destructure. `optimizeBriefDir` is a mutable binding owned by
 * index.ts and passed as a live getter/setter pair.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { askConsent } from "./brief-consent.ts";
import * as optimizeBrief from "./optimize-brief.ts";
import * as expedition from "./expedition.ts";
import * as chainJournal from "./chain-journal.ts";
import * as researchState from "./research-state.ts";

type BriefTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface BriefToolsDeps {
  assertModeActive: (ctx: ExtensionContext) => any;
  campaignBlocksOrdinaryLoop: (workDir: string) => Promise<boolean>;
  campaignBlockedResponse: () => any;
  researchBlocksOrdinaryLoop: (workDir: string, ctx: ExtensionContext) => Promise<boolean>;
  researchBlockedResponse: () => any;
  resolveWorkDir: (cwd: string) => string;
  optimizeRefusal: (text: string) => any;
  unexpectedArgKeys: (params: Record<string, unknown>, allowed: readonly string[], hint?: string) => string | null;
  getRuntime: (ctx: ExtensionContext) => any;
  recordAutoresearchActivation: (workDir: string, active: boolean) => void;
  setAutoresearchMode: (ctx: ExtensionContext, active: boolean) => void;
  updateWidget: (ctx: ExtensionContext) => void;
  sendWhenReady: (ctx: ExtensionContext, message: string, opts?: { steerIfBusy?: boolean }) => void;
  // Mutable state owned by index.ts: live accessors, never destructured.
  optimizeBriefDir: string | null;
}

/** init_experiment / run_experiment gates (extracted with the brief tools; the
 *  body is byte-identical apart from deps reads at the call site). */
export function createOptimizeGates(deps: {
  resolveWorkDir: (cwd: string) => string;
  autoresearchJsonlPath: (dir: string) => string;
}) {
  const optimizeRefusal = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const lastConfigHeader = (jsonlPath: string): Record<string, unknown> | undefined => {
    try {
      if (!fs.existsSync(jsonlPath)) return undefined;
      const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry && entry.type === "config") return entry;
        } catch { continue; }
      }
    } catch { /* unreadable ledger: treated as not started */ }
    return undefined;
  };
  // init_experiment: a resume of the same config needs no brief (D1); anything else needs the approved brief and the same arguments.
  const optimizeStartGate = (
    ctx: ExtensionContext,
    params: { name: string; metric_name: string; metric_unit?: string; direction?: string; cwd?: string },
  ) => {
    // An empty cwd would be read as the process directory by the gate but as absent by init: refuse it before any comparison.
    if (params.cwd !== undefined && optimizeBrief.isBlankPath(params.cwd)) {
      return optimizeRefusal("❌ init_experiment refused: cwd must be a non-empty path");
    }
    const workDir = deps.resolveWorkDir(ctx.cwd);
    const header = lastConfigHeader(deps.autoresearchJsonlPath(workDir));
    // D1 covers only this session's own ledger: a cwd that points elsewhere is another ledger and needs the brief.
    const sameDir = params.cwd === undefined || path.resolve(params.cwd) === path.resolve(workDir);
    if (
      sameDir &&
      header &&
      header.name === params.name &&
      header.metricName === params.metric_name &&
      (header.metricUnit ?? "") === (params.metric_unit ?? "") &&
      header.bestDirection === (params.direction ?? "lower")
    ) {
      return undefined;
    }
    const approved = optimizeBrief.approvedBriefFor(optimizeBrief.optimizeDirOf(ctx.cwd));
    if (!approved.ok) {
      const detail = "detail" in approved && approved.detail ? ` (${approved.detail})` : "";
      return optimizeRefusal(`❌ init_experiment refused (${approved.reason}): ${approved.message}${detail}. Order: optimize_brief draft → propose → init_experiment.`);
    }
    // A pinned session (init with cwd earlier) writes to workDir even without cwd: compare what is actually written.
    const effectiveCwd = params.cwd === undefined && workDir !== path.resolve(ctx.cwd) ? workDir : params.cwd;
    const diffs = optimizeBrief.initArgsMismatch(approved.brief, { ...params, cwd: effectiveCwd });
    if (diffs.length > 0) {
      return optimizeRefusal(`❌ init_experiment does not match the approved brief:\n- ${diffs.join("\n- ")}\nDraft the new values with optimize_brief draft and propose them again.`);
    }
    // The session runs with the approved direction, not with a direction inherited from an earlier segment.
    return { approvedDirection: optimizeBrief.effectiveDirection(approved.brief) };
  };
  // run_experiment / log_experiment: no measurement before a started session.
  const optimizeNotStartedGate = (ctx: ExtensionContext) => {
    if (lastConfigHeader(deps.autoresearchJsonlPath(deps.resolveWorkDir(ctx.cwd))) !== undefined) return undefined;
    const approved = optimizeBrief.approvedBriefFor(optimizeBrief.optimizeDirOf(ctx.cwd));
    const step = approved.ok
      ? "init_experiment"
      : approved.reason === "brief_missing" || approved.reason === "brief_invalid"
        ? "optimize_brief draft"
        : "optimize_brief propose";
    return optimizeRefusal(`❌ The optimization session is not started: next step is ${step}. Order: optimize_brief draft → propose → init_experiment.`);
  };
  return { optimizeRefusal, optimizeStartGate, optimizeNotStartedGate };
}

const optimizeBriefTranscriptText = (dir: string | null): string => {
  if (dir === null) return "Бриф для показа не найден: в этой сессии не было optimize_brief draft.";
  const read = optimizeBrief.readOptimizeBrief(dir);
  return read.ok ? optimizeBrief.optimizeBriefMarkdown(read.brief, read.sha256) : `Бриф для показа не найден: ${read.message}.`;
};

export function createOptimizeBriefTool(deps: BriefToolsDeps): BriefTool {
  return {
    name: "optimize_brief",
    label: "Optimize brief (phase 1)",
    // The full brief is drawn as this tool call's row: shown before execute and before the owner dialog.
    renderCall(args: any, _theme: any, _context: any) {
      if (args?.action !== "propose") return new Text(`optimize_brief ${String(args?.action ?? "")}`, 0, 0);
      return new Text(optimizeBriefTranscriptText(deps.optimizeBriefDir), 0, 0);
    },
    description:
      "Ordinary optimization loop, phase 1: draft the session brief (name, metric_name, metric_unit, direction, cwd), then ask the OWNER " +
      "to approve it with propose. init_experiment starts the session only with that approval and the same arguments. The model cannot approve.",
    promptSnippet: "Optimization brief: draft the session brief, then the owner approves it (propose); init_experiment starts only after that",
    promptGuidelines: [
      "Before init_experiment, call optimize_brief draft with name, metric_name, metric_unit, direction, cwd; then optimize_brief propose for the owner's approval.",
      "Use the same name, metric_name, metric_unit, direction and cwd in init_experiment as in the approved brief.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["draft", "propose"], description: "Brief action to perform." },
        brief: {
          type: "object",
          description: "draft only: {name, metric_name, metric_unit?, direction? (lower|higher), cwd?}. Unknown fields are refused.",
        },
      },
      required: ["action"],
    } as any,

    async execute(_toolCallId: string, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      if (await deps.campaignBlocksOrdinaryLoop(deps.resolveWorkDir(ctx.cwd))) return deps.campaignBlockedResponse();
      if (await deps.researchBlocksOrdinaryLoop(deps.resolveWorkDir(ctx.cwd), ctx)) return deps.researchBlockedResponse();
      const action = params?.action;
      if (action !== "draft" && action !== "propose") {
        return deps.optimizeRefusal(`❌ unknown action ${JSON.stringify(String(action))}; allowed: draft propose`);
      }
      if (action === "propose" && params.brief !== undefined) {
        return deps.optimizeRefusal("❌ propose takes no brief: the approved text is brief.json; draft a new brief first");
      }
      const extra = Object.keys(params ?? {}).filter((k) => k !== "action" && k !== "brief");
      if (extra.length > 0) {
        return deps.optimizeRefusal(`❌ unexpected field(s): ${extra.join(", ")}; approval and confirmation fields are not model arguments`);
      }
      const dir = optimizeBrief.optimizeDirOf(ctx.cwd);
      if (action === "draft") {
        if (params.brief === undefined) return deps.optimizeRefusal("❌ draft requires the brief object");
        const written = optimizeBrief.writeOptimizeBriefDraft(dir, params.brief);
        if (!written.ok) return deps.optimizeRefusal(`❌ brief rejected: ${written.errors.join("; ")}`);
        deps.optimizeBriefDir = dir;
        return {
          content: [{ type: "text", text: `✅ Brief draft saved (sha256 ${written.sha256}). It is NOT approved yet: the owner confirms it with optimize_brief propose.` }],
          details: { action },
        };
      }
      // propose: owner dialog. No UI or no explicit confirm === true means no approval.
      const read = optimizeBrief.readOptimizeBrief(dir);
      if (!read.ok) return deps.optimizeRefusal(`❌ ${read.message}`);
      deps.optimizeBriefDir = dir;
      const existing = optimizeBrief.readOptimizeApproval(dir);
      if (existing.ok && existing.approval.confirmed === true && existing.approval.brief_sha256 === read.sha256) {
        return { content: [{ type: "text", text: `✅ Brief already approved (sha256 ${read.sha256}). Call init_experiment with the same arguments.` }], details: { action } };
      }
      const outcome = await askConsent<{ ok: boolean; message: string }>({
        hasUi: !!(ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function"),
        title: "Optimization session: approve brief",
        body: optimizeBrief.optimizeConsentSummary(read.brief, read.sha256),
        confirm: (title, body) => ctx.ui.confirm(title, body),
        record: async (confirmed) => optimizeBrief.writeOptimizeApproval(dir, confirmed, read.sha256),
      });
      if (outcome.status === "no_ui") return deps.optimizeRefusal("❌ brief approval is an owner action and needs an interactive dialog; the brief stays unapproved");
      if (outcome.status === "refused") return deps.optimizeRefusal("❌ the owner did not confirm the brief; nothing was approved");
      if (outcome.status === "write_failed") return deps.optimizeRefusal(`❌ ${outcome.failure.message}; nothing was approved`);
      return {
        content: [{ type: "text", text: `✅ Brief approved (sha256 ${read.sha256}). Call init_experiment with the same name, metric_name, metric_unit, direction and cwd.` }],
        details: { action },
      };
    },
  };
}

export function createExpeditionBriefTool(deps: BriefToolsDeps): BriefTool {
  return {
    name: "expedition_brief",
    label: "Expedition document",
    renderCall(args: any) {
      if (args?.action !== "propose") return new Text(`expedition_brief ${String(args?.action ?? "")}`, 0, 0);
      const doc = typeof args?.doc === "object" && args?.doc !== null ? args.doc : null;
      if (!doc) return new Text("Expedition proposal", 0, 0);
      const goal = typeof doc.goal === "string" ? doc.goal : "";
      const dirs = Array.isArray(doc.directions)
        ? doc.directions.filter((d: any) => typeof d?.name === "string").map((d: any) => `- ${d.name}`).join("\\n")
        : "";
      return new Text(`Expedition proposal: ${goal}${dirs ? `\\n${dirs}` : ""}`, 0, 0);
    },
    description: "Draft and obtain owner confirmation for an expedition document, then create campaign 0.",
    promptSnippet: "Expedition: ask missing design questions as one packet, draft expedition_brief, then propose",
    promptGuidelines: ["Ask the owner all missing questions in one message before drafting.", "Use expedition_brief draft, then propose. Never pass approval or hash fields."],
    parameters: { type: "object", properties: { action: { type: "string", enum: ["draft", "propose"] }, doc: { type: "object" }, doc_path: { type: "string" } }, required: ["action"] } as any,
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: ExtensionContext) {
      const action = params?.action;
      const reply = (text: string, reason?: string) => ({content:[{type:"text" as const,text}],details:{action,...(reason?{reason}:{})}});
      const allowed = action === "draft" ? ["action","doc"] : action === "propose" ? ["action","doc_path"] : null;
      if (!allowed) return reply("invalid_argument: action must be draft or propose", "invalid_argument");
      const extra = deps.unexpectedArgKeys(params ?? {}, allowed);
      if (extra) return reply(`invalid_argument: ${extra}`, "invalid_argument");
      if (!ctx.hasUI && action === "propose") return reply("no_ui: expedition confirmation requires TUI", "no_ui");
      const workDir = deps.resolveWorkDir(ctx.cwd), runtime = deps.getRuntime(ctx);
      const stateRoot = runtime.researchStateRoot ?? path.join(workDir, ".auto");
      if (action === "draft") {
        const checked = expedition.validateExpeditionDoc(params.doc);
        if (!checked.ok) return reply(`${checked.reason}: ${checked.message}`, checked.reason);
        const saved = expedition.saveExpeditionDraft(stateRoot, checked.doc);
        return saved.ok ? reply(`Expedition draft saved: ${saved.path}. Next: expedition_brief propose.`) : reply(`${saved.reason}: ${saved.message}`, saved.reason);
      }
      let docPath: string;
      if (typeof params.doc_path === "string") docPath = path.resolve(workDir, params.doc_path);
      else {
        const latest = expedition.findLatestDraft(stateRoot);
        if (!latest) return reply("expedition_draft_missing: no draft found", "expedition_draft_missing");
        docPath = path.join(path.dirname(workDir), `expedition-${Date.now()}.json`);
        try { fs.writeFileSync(docPath, fs.readFileSync(latest)); fs.unlinkSync(latest); } catch (e) { return reply(`io_failed: ${String(e)}`, "io_failed"); }
      }
      try {
        const real = fs.realpathSync(docPath), realWork = fs.realpathSync(workDir), rel = path.relative(realWork, real);
        if (rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))) return reply("path_inside_workdir: document must be outside the work directory", "path_inside_workdir");
      } catch (e) { return reply(`expedition_doc_unreadable: ${String(e)}`, "expedition_doc_unreadable"); }
      const initial = expedition.readExpeditionDoc(docPath);
      if (!initial.ok) return reply(`${initial.reason}: ${initial.message}`, initial.reason);
      const dialog = expedition.expeditionDialogText(initial.doc, initial.sha256);
      const confirmed = await ctx.ui.confirm("Confirm expedition document", dialog);
      const current = expedition.readExpeditionDoc(docPath);
      if (!current.ok || current.sha256 !== initial.sha256) return reply("expedition_changed: document changed during confirmation", "expedition_changed");
      if (confirmed !== true) return reply("owner_declined: expedition was not created", "owner_declined");
      const id = `exp-${Date.now()}`, chainId = `${id}-chain`;
      const createdChain = await chainJournal.createChain(workDir, chainId, id);
      if (!createdChain.ok) return reply(`${createdChain.reason}: ${createdChain.message}`, createdChain.reason);
      const chainDir = chainJournal.chainDir(workDir, chainId)!;
      const add = async (type: string, payload: Record<string, unknown>) => chainJournal.appendEntry(chainDir, workDir, chainId, type, payload);
      let r = await add("expedition_created", {goal: current.doc.goal, doc_sha256: current.sha256});
      if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
      for (const d of current.doc.directions) { r = await add("direction_opened", {dir:d.name,why:d.why}); if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason); }
      const campaign = await researchState.createCampaign(workDir, id);
      if (!campaign.ok) return reply(`${campaign.reason}: ${campaign.message}`, campaign.reason);
      const brief = await researchState.writeBriefDraft(campaign.dir, current.doc.campaign0);
      if (!brief.ok) return reply(`${brief.reason}: ${brief.message}`, brief.reason);
      const approval = await researchState.writeApproval(campaign.dir, brief.sha256);
      if (!approval.ok) return reply(`${approval.reason}: ${approval.message}`, approval.reason);
      r = await add("brief_approved", {campaign_id:id,brief_sha256:brief.sha256,source:"expedition"});
      if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
      r = await add("campaign_added", {campaign_id:id});
      if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
      const started = await researchState.transitionPhase(campaign.dir, "start expedition campaign", "briefing", "research");
      if (!started.ok) return reply(`${started.reason}: ${started.message}`, started.reason);
      const status = await chainJournal.setChainStatus(workDir, chainId, "active");
      if (!status.ok) return reply(`${status.reason}: ${status.message}`, status.reason);
      // es1.8: every creation path pins the expedition view and refreshes the
      // widget — including a session where the mode was already ON.
      if (!runtime.autoresearchMode) { deps.recordAutoresearchActivation(workDir,true); deps.setAutoresearchMode(ctx,true); }
      runtime.uiMode = "expedition";
      runtime.researchCampaignId = id;
      runtime.researchChain = {chainId,workDir,charterPath:docPath,charterSha256:current.sha256,charter:current.doc.charter,expedition:true,docSha256:current.sha256};
      deps.updateWidget(ctx);
      // Restart marker (bd pi-autoresearch-es1.3): lets a fresh session restore
      // the binding from disk. Chain creation is already durable at this point,
      // so a marker failure degrades to a warning, not a rollback.
      const marker = expedition.writeExpeditionMarker(chainDir, {goal: current.doc.goal, docPath, docSha256: current.sha256, campaignId: id, charter: current.doc.charter});
      const markerNote = marker.ok ? "" : `\nwarning: expedition restart marker not written (${marker.reason}: ${marker.message}); the expedition will not survive a pi restart.`;
      deps.sendWhenReady(ctx, `Expedition ${id} created. Campaign 0 is running; the campaign brief is approved by the expedition confirmation. Before question work: pick a direction and activate it with expedition_map(subaction="activate", dir=<name>, why=<rationale>) — questions of campaign 0 belong to that direction. Use separate research_questions calls with action="open", action="record", or action="close" for campaign questions. When the direction is closed, close its campaign questions first, then call expedition_map(subaction="resolve", dir=<name>, refs=[{campaign,question}]) or make a separate call to expedition_map(subaction="reject", dir=<name>, refs=[{campaign,question}]), expedition_map(subaction="advisory", dir=<name>, review_ref=<path>, review_sha256=<sha256>), or expedition_map(subaction="park", dir=<name>, reason=<why>); activate the next direction with expedition_map(subaction="activate", dir=<name>, why=<rationale>) before drafting the next campaign. Question close is not map direction resolve.`, { steerIfBusy: true });
      return reply(`✅ Expedition ${chainId} created; campaign ${id} started (document sha256 ${current.sha256}). Next: expedition_map(subaction="activate", dir=<name>, why=<rationale>) before question work; use separate research_questions calls with action="open", action="record", or action="close" for questions. After closing a direction with expedition_map(subaction="resolve", dir=<name>, refs=...) or a separate call with expedition_map(subaction="reject", dir=<name>, refs=...), activate the next direction with expedition_map(subaction="activate", dir=<name>, why=<rationale>) before drafting the next campaign.${markerNote}`);
    },
  };
}
