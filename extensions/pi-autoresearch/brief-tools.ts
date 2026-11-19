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
import { randomUUID } from "node:crypto";
import { askConsent } from "./brief-consent.ts";
import * as optimizeBrief from "./optimize-brief.ts";
import * as expedition from "./expedition.ts";
import * as chainJournal from "./chain-journal.ts";
import * as researchState from "./research-state.ts";
import type { ModeTransition } from "./index.ts";
import {
  EXPEDITION_CANDIDATE_ACTIVE_NOTICE, EXPEDITION_RESEARCH_ACTIVE_NOTICE, RESEARCH_KICKOFF_NOTICE,
} from "./autoresearch-command.ts";

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
  sendWhenReady: (ctx: ExtensionContext, message: string, opts?: { steerIfBusy?: boolean }) => void;
  // Late-declared mode helpers (getter-backed in index.ts): a direct propose
  // is a mode switch and must use the same transactional owner as the command.
  cancelPendingResume: (runtime: any) => void;
  candidateBlocksOrdinaryLoop: (workDir: string) => boolean;
  classifyOrdinaryLaunchResearch: (workDir: string, ctx: ExtensionContext) => "none" | "manual" | "active";
  recordModeSwitchFinalize: (ctx: ExtensionContext, reason: string) => void;
  transitionAutoresearchMode: (ctx: ExtensionContext, next: ModeTransition) => void;
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

/**
 * Publication journal (tj0.5): a partially committed expedition must keep its
 * id, document digest and completed step so a retry resumes the same chain
 * instead of starting a new exp-*. The canonical draft is kept until the chain
 * is fully published; only the out-of-workdir copy is removed on refusal.
 */
const EXPEDITION_PUBLICATION_FILE = "expedition-publication.json";
interface ExpeditionPublication {
  schema_version: 1;
  id: string;
  chain_id: string;
  doc_path: string;
  doc_sha256: string;
  step: string;
  done: string[];
}
type StepResult = { ok: true } | { ok: false; reason: string; message: string };

const publicationFile = (workDir: string) => path.join(workDir, ".auto", EXPEDITION_PUBLICATION_FILE);

function readPublication(workDir: string): { state: ExpeditionPublication | null; problem?: string } {
  const file = publicationFile(workDir);
  if (!fs.existsSync(file)) return { state: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      raw.schema_version !== 1 || typeof raw.id !== "string" || !raw.id.startsWith("exp-") ||
      typeof raw.chain_id !== "string" || !raw.chain_id.endsWith("-chain") ||
      typeof raw.doc_path !== "string" || raw.doc_path === "" ||
      typeof raw.doc_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.doc_sha256) ||
      typeof raw.step !== "string" || !Array.isArray(raw.done) ||
      !raw.done.every((step) => typeof step === "string")
    ) return { state: null, problem: "expedition_publication_invalid" };
    return { state: { schema_version: 1, id: raw.id, chain_id: raw.chain_id, doc_path: raw.doc_path, doc_sha256: raw.doc_sha256, step: raw.step, done: raw.done as string[] } };
  } catch {
    return { state: null, problem: "expedition_publication_invalid" };
  }
}

async function writePublication(workDir: string, state: ExpeditionPublication): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(publicationFile(workDir)), { recursive: true });
    await researchState.writeFileAtomic(publicationFile(workDir), JSON.stringify(state, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Refuse a resume whose recorded steps disagree with the on-disk journal. */
function publicationMatchesChain(workDir: string, state: ExpeditionPublication): boolean {
  const dir = chainJournal.chainDir(workDir, state.chain_id);
  if (!dir) return false;
  try {
    const actual = fs.readFileSync(path.join(dir, "chain.json"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => (JSON.parse(line) as { type?: unknown }).type);
    const entryTypes: Record<string, string> = {
      chain_created: "chain_created", expedition_created: "expedition_created",
      chain_brief_approved: "brief_approved", chain_campaign_added: "campaign_added", chain_active: "status_change",
    };
    // Campaign/brief steps leave no chain entry; only chain steps are compared.
    const expected = state.done.filter((step) => step !== "complete")
      .map((step) => step.startsWith("direction_opened:") ? "direction_opened" : entryTypes[step])
      .filter((type): type is string => typeof type === "string");
    const prefixMatches = expected.every((type, i) => actual[i] === type);
    // A completed publication may have later chain entries (map actions), an
    // unfinished one must match exactly: extra entries mean a write raced the
    // journal and appending again would duplicate a step.
    return prefixMatches && (state.step === "complete" || actual.length === expected.length);
  } catch {
    return false;
  }
}

function discardDocumentCopy(docPath: string): void {
  try { fs.unlinkSync(docPath); } catch { /* the copy may already be gone; the canonical draft is never touched here */ }
}

/**
 * Exclusive, workdir-scoped propose claim. It is acquired only after the owner
 * confirms and the document is re-read, and released by its owner in a finally
 * block: while it exists no other propose can re-read and rewrite the journal,
 * so two gated confirms cannot mint two chains. It never outlives its propose,
 * so a later, unrelated expedition is not blocked.
 */
const PROPOSE_CLAIM_FILE = "expedition-propose.claim";
const proposeClaimFile = (workDir: string) => path.join(workDir, ".auto", PROPOSE_CLAIM_FILE);

function acquireProposeClaim(workDir: string): { ok: true; token: string } | { ok: false; reason: string; message: string } {
  const file = proposeClaimFile(workDir);
  const token = randomUUID();
  let ours = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "wx");
    ours = true;
    try {
      const payload = Buffer.from(JSON.stringify({ token, pid: process.pid }), "utf8");
      if (fs.writeSync(fd, payload) !== payload.length) throw new Error("short propose claim write");
    } finally { fs.closeSync(fd); }
    return { ok: true, token };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (ours) { try { fs.unlinkSync(file); } catch { /* the claim is not writable; no chain was started */ } }
    if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") {
      return { ok: false, reason: "expedition_publication_in_progress", message: `another expedition propose holds the publication claim for ${workDir}; no chain was created` };
    }
    return { ok: false, reason: "io_failed", message: `cannot create propose claim ${file}: ${String(e)}` };
  }
}

function releaseProposeClaim(workDir: string, token: string): void {
  const file = proposeClaimFile(workDir);
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    if (info?.token === token) fs.unlinkSync(file);
  } catch { /* missing or foreign claim: never remove another owner's marker */ }
}

/**
 * A completed journal may be retired only for a different document whose old
 * chain is finalized. Republishing the same sha and an in-progress old chain
 * stay explicit refusals.
 */
async function completedJournalVerdict(
  workDir: string, state: ExpeditionPublication, docSha: string,
): Promise<{ retire: true } | { retire: false; reason: string; message: string }> {
  if (state.doc_sha256 === docSha) {
    return { retire: false, reason: "expedition_already_published", message: `expedition_already_published: sha256 ${docSha} was already published as ${state.chain_id}; no second chain was created. Resume work on that chain` };
  }
  let status: string;
  try { status = await chainJournal.statusOf(workDir, state.chain_id); }
  catch (e) {
    return { retire: false, reason: "expedition_publication_inconsistent", message: `expedition_publication_inconsistent: completed chain ${state.chain_id} cannot be verified (${String(e)}); manual check required` };
  }
  if (!chainJournal.isFinal(status) || status === "manual_check_required") {
    return { retire: false, reason: "expedition_publication_conflict", message: `expedition_publication_conflict: completed publication ${state.chain_id} is bound to sha256 ${state.doc_sha256} and its chain is still ${status}; resolve ${publicationFile(workDir)} before proposing another document` };
  }
  return { retire: true };
}

function retireCompletedPublication(workDir: string, state: ExpeditionPublication): boolean {
  const retired = path.join(path.dirname(publicationFile(workDir)), `expedition-publication.retired-${state.chain_id}-${randomUUID().slice(0, 8)}.json`);
  try { fs.renameSync(publicationFile(workDir), retired); return true; }
  catch { return false; }
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
      // doc_path is in the published schema for both actions. On draft it has no
      // meaning (the canonical draft path is fixed), so it is accepted and ignored.
      const allowed = action === "draft" ? ["action","doc","doc_path"] : action === "propose" ? ["action","doc_path"] : null;
      if (!allowed) return reply("invalid_argument: action must be draft or propose", "invalid_argument");
      const extra = deps.unexpectedArgKeys(params ?? {}, allowed);
      if (extra) return reply(`invalid_argument: ${extra}`, "invalid_argument");
      if (!ctx.hasUI && action === "propose") return reply("no_ui: expedition confirmation requires TUI", "no_ui");
      const workDir = deps.resolveWorkDir(ctx.cwd), runtime = deps.getRuntime(ctx);
      const stateRoot = runtime.researchStateRoot ?? path.join(workDir, ".auto");
      // bd tj0.2: a direct propose is a launch, not a passive edit. Classify
      // the research state BEFORE the owner dialog, the claim or any disk
      // write. A pending/completed publication is a retry of this expedition
      // (its own campaign must not block the resume), so the gate applies to
      // a fresh publication only.
      const loaded = action === "propose" ? readPublication(workDir) : null;
      let manualResearchGate = false;
      if (action === "propose" && loaded !== null && !loaded.problem && loaded.state === null) {
        // Synchronous scan: a hard refusal must happen before the owner dialog
        // and before any disk write, while a clean gate still reaches the
        // dialog in the same tick (gated publish tests rely on that).
        const researchGate = deps.classifyOrdinaryLaunchResearch(workDir, ctx);
        if (researchGate === "active") {
          ctx.ui.notify(EXPEDITION_RESEARCH_ACTIVE_NOTICE, "error");
          return reply(EXPEDITION_RESEARCH_ACTIVE_NOTICE, "expedition_launch_research_active");
        }
        if (deps.candidateBlocksOrdinaryLoop(workDir)) {
          ctx.ui.notify(EXPEDITION_CANDIDATE_ACTIVE_NOTICE, "error");
          return reply(EXPEDITION_CANDIDATE_ACTIVE_NOTICE, "expedition_launch_candidate_active");
        }
        if (researchGate === "manual") {
          // Manual-check campaigns stay reachable through the research tools,
          // but the autonomous expedition kickoff must not start over them.
          ctx.ui.notify(RESEARCH_KICKOFF_NOTICE, "info");
          manualResearchGate = true;
        }
      }
      if (action === "draft") {
        const checked = expedition.validateExpeditionDoc(params.doc);
        if (!checked.ok) return reply(`${checked.reason}: ${checked.message}`, checked.reason);
        const saved = expedition.saveExpeditionDraft(stateRoot, checked.doc);
        return saved.ok
          ? reply(`Expedition draft saved: ${saved.path}. Next: expedition_brief propose.${params.doc_path !== undefined ? " (doc_path ignored on draft; propose uses the saved draft.)" : ""}`)
          : reply(`${saved.reason}: ${saved.message}`, saved.reason);
      }
      if (loaded?.problem) return reply(`${loaded.problem}: publication journal ${publicationFile(workDir)} is unreadable; no chain was created`, loaded.problem);
      let resuming = loaded?.state !== null;
      let resumeStep = loaded?.state?.step ?? "";
      let state = loaded?.state ?? null;
      let retireChainId: string | null = null;
      let docPath: string;
      let copied = false;
      let canonical: string | null = null;
      if (typeof params.doc_path === "string") {
        docPath = path.resolve(workDir, params.doc_path);
        if (state) {
          let explicitBytes: string;
          try { explicitBytes = fs.readFileSync(docPath, "utf8"); }
          catch (e) { return reply(`expedition_doc_unreadable: ${String(e)}`, "expedition_doc_unreadable"); }
          const explicitSha = researchState.sha256Hex(explicitBytes);
          // A completed journal is decided after the document is read, so a
          // different sha can retire it while the same sha stays refused.
          if (state.step !== "complete" && explicitSha !== state.doc_sha256) return reply(`expedition_publication_conflict: pending publication ${state.chain_id} is bound to sha256 ${state.doc_sha256}, the document is ${explicitSha}; resolve ${publicationFile(workDir)} before proposing another document`, "expedition_publication_conflict");
          if (state.step !== "complete") {
            if (path.resolve(state.doc_path) !== docPath) return reply(`expedition_publication_conflict: pending publication ${state.chain_id} is bound to ${state.doc_path}; resume with that document or resolve ${publicationFile(workDir)} first`, "expedition_publication_conflict");
            if (!publicationMatchesChain(workDir, state)) return reply(`expedition_publication_inconsistent: journal step ${state.step} does not match chain ${state.chain_id}; manual check required`, "expedition_publication_inconsistent");
          }
        }
      } else {
        const latest = expedition.findLatestDraft(stateRoot);
        if (!latest) return reply("expedition_draft_missing: no draft found", "expedition_draft_missing");
        canonical = latest;
        let bytes: string;
        try { bytes = fs.readFileSync(latest, "utf8"); }
        catch (e) { return reply(`io_failed: ${String(e)}`, "io_failed"); }
        const sha = researchState.sha256Hex(bytes);
        if (state && state.step !== "complete" && state.doc_sha256 !== sha) return reply(`expedition_publication_conflict: pending publication ${state.chain_id} is bound to sha256 ${state.doc_sha256}, the draft is ${sha}; resolve ${publicationFile(workDir)} before proposing another document`, "expedition_publication_conflict");
        if (state && state.step !== "complete") {
          docPath = state.doc_path;
          if (!fs.existsSync(docPath)) return reply(`expedition_publication_unreadable: published document ${docPath} is missing; resume is not possible without it`, "expedition_publication_unreadable");
          if (!publicationMatchesChain(workDir, state)) return reply(`expedition_publication_inconsistent: journal step ${state.step} does not match chain ${state.chain_id}; manual check required`, "expedition_publication_inconsistent");
        } else {
          // The canonical draft stays in place until publication succeeds; a
          // refusal only removes this out-of-workdir copy.
          docPath = path.join(path.dirname(workDir), `expedition-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          try { fs.writeFileSync(docPath, bytes); copied = true; } catch (e) { return reply(`io_failed: ${String(e)}`, "io_failed"); }
        }
      }
      try {
        const real = fs.realpathSync(docPath), realWork = fs.realpathSync(workDir), rel = path.relative(realWork, real);
        if (rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))) { if (copied) discardDocumentCopy(docPath); return reply("path_inside_workdir: document must be outside the work directory", "path_inside_workdir"); }
      } catch (e) { if (copied) discardDocumentCopy(docPath); return reply(`expedition_doc_unreadable: ${String(e)}`, "expedition_doc_unreadable"); }
      const initial = expedition.readExpeditionDoc(docPath);
      if (!initial.ok) { if (copied) discardDocumentCopy(docPath); return reply(`${initial.reason}: ${initial.message}`, initial.reason); }
      if (state?.step === "complete") {
        const verdict = await completedJournalVerdict(workDir, state, initial.sha256);
        if (!verdict.retire) { if (copied) discardDocumentCopy(docPath); return reply(verdict.message, verdict.reason); }
        retireChainId = state.chain_id;
        state = null;
        resuming = false;
        resumeStep = "";
      }
      const dialog = expedition.expeditionDialogText(initial.doc, initial.sha256);
      const confirmed = await ctx.ui.confirm("Confirm expedition document", dialog);
      const current = expedition.readExpeditionDoc(docPath);
      if (!current.ok || current.sha256 !== initial.sha256) { if (copied) discardDocumentCopy(docPath); return reply("expedition_changed: document changed during confirmation", "expedition_changed"); }
      if (confirmed !== true) { if (copied) discardDocumentCopy(docPath); return reply("owner_declined: expedition was not created", "owner_declined"); }
      const claim = acquireProposeClaim(workDir);
      if (!claim.ok) { if (copied) discardDocumentCopy(docPath); return reply(`${claim.reason}: ${claim.message}`, claim.reason); }
      try {
        // The journal is re-read under the exclusive claim: a journal that
        // appeared while our confirm was open belongs to another propose and
        // must never be silently resumed into a second chain.
        const fresh = readPublication(workDir);
        if (fresh.problem) { if (copied) discardDocumentCopy(docPath); return reply(`${fresh.problem}: publication journal ${publicationFile(workDir)} is unreadable; no chain was created`, fresh.problem); }
        const claimedDuringConfirm = (other: ExpeditionPublication) => {
          if (copied) discardDocumentCopy(docPath);
          return reply(`expedition_publication_claimed: another propose claimed sha256 ${other.doc_sha256} as ${other.chain_id} during this confirmation; no second chain was created`, "expedition_publication_claimed");
        };
        if (retireChainId !== null) {
          if (fresh.state && fresh.state.chain_id === retireChainId && fresh.state.step === "complete") {
            const verdict = await completedJournalVerdict(workDir, fresh.state, current.sha256);
            if (!verdict.retire) { if (copied) discardDocumentCopy(docPath); return reply(verdict.message, verdict.reason); }
            if (!retireCompletedPublication(workDir, fresh.state)) { if (copied) discardDocumentCopy(docPath); return reply(`io_failed: cannot retire ${publicationFile(workDir)}`, "io_failed"); }
          } else if (fresh.state) return claimedDuringConfirm(fresh.state);
        } else if (!resuming && fresh.state !== null) {
          return claimedDuringConfirm(fresh.state);
        } else if (resuming && fresh.state) {
          if (fresh.state.doc_sha256 !== current.sha256) return reply(`expedition_publication_conflict: pending publication ${fresh.state.chain_id} is bound to sha256 ${fresh.state.doc_sha256}, the document is ${current.sha256}; resolve ${publicationFile(workDir)} before proposing another document`, "expedition_publication_conflict");
          if (fresh.state.step === "complete") return reply(`expedition_already_published: sha256 ${current.sha256} was already published as ${fresh.state.chain_id}; no second chain was created. Resume work on that chain`, "expedition_already_published");
          if (path.resolve(fresh.state.doc_path) !== docPath) return reply(`expedition_publication_conflict: pending publication ${fresh.state.chain_id} is bound to ${fresh.state.doc_path}; resume with that document or resolve ${publicationFile(workDir)} first`, "expedition_publication_conflict");
          if (!publicationMatchesChain(workDir, fresh.state)) return reply(`expedition_publication_inconsistent: journal step ${fresh.state.step} does not match chain ${fresh.state.chain_id}; manual check required`, "expedition_publication_inconsistent");
          state = fresh.state;
        } else if (resuming && !fresh.state) {
          resuming = false;
          resumeStep = "";
        }
        // es1.7/es1.8: the optimization → expedition switch is finalized once
        // before the new expedition is bound, with the same reason/order as
        // '/autoresearch expedition'. An OFF session has nothing to finalize.
        if (runtime.autoresearchMode && runtime.researchChain?.expedition !== true && runtime.uiMode === "optimization") {
          deps.recordModeSwitchFinalize(ctx, "switch to expedition mode");
          deps.cancelPendingResume(runtime);
        }
        if (!state) {
          // The id and chain id exist only after the claim is won.
          const id = `exp-${Date.now()}-${randomUUID().slice(0, 8)}`;
          state = { schema_version: 1, id, chain_id: `${id}-chain`, doc_path: docPath, doc_sha256: current.sha256, step: "prepared", done: [] };
          if (!(await writePublication(workDir, state))) { if (copied) discardDocumentCopy(docPath); return reply(`io_failed: cannot write ${publicationFile(workDir)}`, "io_failed"); }
        }
        // Each durable step is recorded before the next one starts. A retry skips
        // recorded steps; a step that cannot be recorded refuses instead of
        // risking a duplicate append on the next attempt.
        const stepDone = (step: string) => state!.done.includes(step);
        const mark = async (step: string, run: () => Promise<StepResult>): Promise<StepResult> => {
          if (stepDone(step)) return { ok: true };
          const result = await run();
          if (!result.ok) return result;
          const next = { ...state!, done: [...state!.done, step], step };
          if (!(await writePublication(workDir, next))) return { ok: false, reason: "expedition_publication_journal_failed", message: `step ${step} completed but was not recorded in ${publicationFile(workDir)}; manual check required` };
          state = next;
          return { ok: true };
        };
        const id = state.id, chainId = state.chain_id;
        const createdChain = await mark("chain_created", () => chainJournal.createChain(workDir, chainId, id));
        if (!createdChain.ok) return reply(`${createdChain.reason}: ${createdChain.message}`, createdChain.reason);
        const chainDir = chainJournal.chainDir(workDir, chainId)!;
        const add = async (type: string, payload: Record<string, unknown>) => chainJournal.appendEntry(chainDir, workDir, chainId, type, payload);
        let r = await mark("expedition_created", () => add("expedition_created", {goal: current.doc.goal, doc_sha256: current.sha256}));
        if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
        for (let i = 0; i < current.doc.directions.length; i++) {
          const d = current.doc.directions[i];
          r = await mark(`direction_opened:${i}`, () => add("direction_opened", {dir:d.name,why:d.why}));
          if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
        }
        const campaign = await mark("campaign_created", () => researchState.createCampaign(workDir, id));
        if (!campaign.ok) return reply(`${campaign.reason}: ${campaign.message}`, campaign.reason);
        const resolvedCampaign = researchState.resolveCampaignDir(workDir, id);
        if (!resolvedCampaign.ok) return reply(`${resolvedCampaign.reason}: ${resolvedCampaign.message}`, resolvedCampaign.reason);
        const campaignDir = resolvedCampaign.dir;
        const draftBrief = await mark("campaign_brief_drafted", () => researchState.writeBriefDraft(campaignDir, current.doc.campaign0));
        if (!draftBrief.ok) return reply(`${draftBrief.reason}: ${draftBrief.message}`, draftBrief.reason);
        const briefDigest = await researchState.briefSha256(campaignDir);
        if (!briefDigest.ok) return reply(`${briefDigest.reason}: ${briefDigest.message}`, briefDigest.reason);
        const approval = await mark("campaign_brief_approved", () => researchState.writeApproval(campaignDir, briefDigest.sha256));
        if (!approval.ok) return reply(`${approval.reason}: ${approval.message}`, approval.reason);
        r = await mark("chain_brief_approved", () => add("brief_approved", {campaign_id:id,brief_sha256:briefDigest.sha256,source:"expedition"}));
        if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
        r = await mark("chain_campaign_added", () => add("campaign_added", {campaign_id:id}));
        if (!r.ok) return reply(`${r.reason}: ${r.message}`, r.reason);
        const started = await mark("campaign_started", () => researchState.transitionPhase(campaignDir, "start expedition campaign", "briefing", "research"));
        if (!started.ok) return reply(`${started.reason}: ${started.message}`, started.reason);
        const status = await mark("chain_active", () => chainJournal.setChainStatus(workDir, chainId, "active"));
        if (!status.ok) return reply(`${status.reason}: ${status.message}`, status.reason);
        state = { ...state, done: [...state.done, "complete"], step: "complete" };
        if (!(await writePublication(workDir, state))) return reply(`expedition_publication_journal_failed: publication step complete but could not be recorded in ${publicationFile(workDir)}; manual check required`, "expedition_publication_journal_failed");
        if (copied && canonical) { try { fs.unlinkSync(canonical); } catch { /* the draft is spent; the charter copy is durable */ } }
        const resumeNote = resuming ? ` (RESUME from publication journal at step ${resumeStep})` : "";
        // es1.8: every creation path pins the expedition view. The flag, the
        // bindings and the widget move together in one transactional switch.
        if (!runtime.autoresearchMode) deps.recordAutoresearchActivation(workDir,true);
        deps.transitionAutoresearchMode(ctx, {
          enabled: true,
          uiMode: "expedition",
          chain: {chainId,workDir,charterPath:docPath,charterSha256:current.sha256,charter:current.doc.charter,expedition:true,docSha256:current.sha256},
          campaignId: id,
        });
        // Restart marker (bd pi-autoresearch-es1.3): lets a fresh session restore
        // the binding from disk. Chain creation is already durable at this point,
        // so a marker failure degrades to a warning, not a rollback.
        const marker = expedition.writeExpeditionMarker(chainDir, {goal: current.doc.goal, docPath, docSha256: current.sha256, campaignId: id, charter: current.doc.charter});
        const markerNote = marker.ok ? "" : `\nwarning: expedition restart marker not written (${marker.reason}: ${marker.message}); the expedition will not survive a pi restart.`;
        if (!manualResearchGate) deps.sendWhenReady(ctx, `Expedition ${id} created. Campaign 0 is running; the campaign brief is approved by the expedition confirmation. Before question work: pick a direction and activate it with expedition_map(subaction="activate", dir=<name>, why=<rationale>) — questions of campaign 0 belong to that direction. Use separate research_questions calls with action="open", action="record", or action="close" for campaign questions. When the direction is closed, close its campaign questions first, then call expedition_map(subaction="resolve", dir=<name>, refs=[{campaign,question}]) or make a separate call to expedition_map(subaction="reject", dir=<name>, refs=[{campaign,question}]), expedition_map(subaction="advisory", dir=<name>, review_ref=<path>, review_sha256=<sha256>), or expedition_map(subaction="park", dir=<name>, reason=<why>); activate the next direction with expedition_map(subaction="activate", dir=<name>, why=<rationale>) before drafting the next campaign. Question close is not map direction resolve.`, { steerIfBusy: true });
        return reply(`✅ Expedition ${chainId} created${resumeNote}; campaign ${id} started (document sha256 ${current.sha256}). Next: expedition_map(subaction="activate", dir=<name>, why=<rationale>) before question work; use separate research_questions calls with action="open", action="record", or action="close" for questions. After closing a direction with expedition_map(subaction="resolve", dir=<name>, refs=...) or a separate call with expedition_map(subaction="reject", dir=<name>, refs=...), activate the next direction with expedition_map(subaction="activate", dir=<name>, why=<rationale>) before drafting the next campaign.${markerNote}`);
      } finally {
        releaseProposeClaim(workDir, claim.token);
      }
    },
  };
}
