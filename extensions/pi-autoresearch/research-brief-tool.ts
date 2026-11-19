/**
 * research_brief tool (extracted from index.ts; the registered tool body is
 * byte-identical apart from deps reads at the call site). Rendered brief text,
 * refusal strings, guard order, brief validation/writeApproval, reply text and
 * campaign-id handling are preserved. Extension-local collaborators arrive
 * through `deps` and are read as `deps.foo` at the point of use — never frozen
 * in an execute() destructure. The mutable briefPreviewDir is a live getter/setter
 * pair owned by index.ts; late-declared helpers are getter-backed there.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { askConsent, briefConsentSummary } from "./brief-consent.ts";
import * as chainJournal from "./chain-journal.ts";
import * as chainBriefs from "./chain-briefs.ts";
import * as researchState from "./research-state.ts";
import { briefTranscriptText } from "./widget.ts";
import type { ModeTransition } from "./index.ts";

type ResearchBriefTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface ResearchBriefToolDeps {
  assertModeActive: (ctx: ExtensionContext) => any;
  refusalText: (r: { reason: string | null; message: string }) => string;
  RESEARCH_BRIEF_ACTION_KEYS: Map<string, string[]>;
  unexpectedArgKeys: (params: Record<string, unknown>, allowed: readonly string[], hint?: string) => string | null;
  resolveWorkDir: (cwd: string) => string;
  getRuntime: (ctx: ExtensionContext) => any;
  effectiveResearchBase: (workDir: string, ctx: ExtensionContext) => string;
  archiveFinishedCampaigns: (workDir: string, stateBase: string, ctx?: ExtensionContext) => Promise<string[] | null>;
  researchSnapshot: (dir: string) => Promise<any>;
  sessionResearchCampaignIds: (workDir: string, ctx: ExtensionContext) => string[] | null;
  sendWhenReady: (ctx: ExtensionContext, message: string, opts?: { steerIfBusy?: boolean }) => void;
  // Declared later in the extension body: read through getters after init.
  activeChain: (ctx: ExtensionContext) => any;
  transitionAutoresearchMode: (ctx: ExtensionContext, next: ModeTransition) => void;
  chainCampaignIds: (ctx: ExtensionContext) => Promise<string[]>;
  charterFileIntact: (workDir: string, chainId: string, charterPath: string, charterSha256: string) => Promise<boolean>;
  collectChainJournals: (workDir: string, ctx: ExtensionContext, stateBase: string, chainId: string) => Promise<any>;
  // Mutable state owned by index.ts: live accessors, never destructured.
  briefPreviewDir: string | null;
}

export function createResearchBriefTool(deps: ResearchBriefToolDeps): ResearchBriefTool {
  return {
    name: "research_brief",
    label: "Research brief (phase 1)",
    // The full brief is drawn as this tool call's row in the transcript: the row is shown before execute and before the owner dialog.
    renderCall(args: any, _theme: any, _context: any) {
      if (args?.action !== "propose") return new Text(`research_brief ${String(args?.action ?? "")}`, 0, 0);
      return new Text(briefTranscriptText(deps.briefPreviewDir), 0, 0);
    },
    description:
      "Research-vectors campaign, phase 1: draft a brief of questions and decision rules, then ask the OWNER to approve it. " +
      "Actions: draft (validated brief saved for a new or still-unapproved campaign), status (approval and hash state), " +
      "propose (OWNER dialog showing the brief and its SHA-256; approval is written only on an explicit confirm). The model cannot " +
      "approve: approval fields are rejected. An approved brief is immutable; a changed brief means a new campaign. " +
      "The campaign id is not a model argument: it is pinned by the launch command or generated at draft; the tool tells you the id. " +
      "In the research phase the ordinary loop and candidate_branch are blocked; briefing does not block anything.",
    promptSnippet: "Research brief: draft questions and decision rules, then the owner approves it in a dialog (propose)",
    promptGuidelines: [
      "Draft questions, one decision rule per verdict (confirmed, rejected, inconclusive, waiting_for_data) and stop rules with research_brief draft. caveat_block is required and is copied verbatim into the report.",
      "propose asks the OWNER to confirm the brief in a dialog. Never try to pass approval, confirmation or operator fields; they are refused.",
      "After approval, start the research phase with research_questions(action=start, expected_sha256) using the hash that propose returned.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["draft", "status", "propose"], description: "Brief action to perform." },
        brief: {
          type: "object",
          description: "draft only: the full brief (schema_version 1, goal, plan_source, caveat_block, data_roles {explore, validate, confirm}, questions [{id, text, decision_rules [{id, verdict, when}], needs_data}], process_metrics, stop_rules [{id, when}]). Optional: verdicts (array of declared verdict names; absent = confirmed, rejected, inconclusive, waiting_for_data; every rule verdict must be declared and every question needs a rule per declared verdict) and evidence_gate {blocked_globs, gate_file, gate_contains} (record on a blocked path is refused until gate_file exists in the work directory and contains gate_contains).",
        },
      },
      required: ["action"],
    } as any,

    async execute(_toolCallId: string, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const action = params?.action;
      const reply = (text: string) => ({ content: [{ type: "text", text }], details: { action } });
      const fail = (reason: string, message: string) => ({
        content: [{ type: "text", text: deps.refusalText({ reason, message }) }],
        details: { action, reason },
      });

      const allowed = deps.RESEARCH_BRIEF_ACTION_KEYS.get(action);
      if (!allowed) return fail("invalid_argument", `unknown action ${JSON.stringify(String(action))}; allowed: draft status propose`);
      const extra = deps.unexpectedArgKeys(params ?? {}, allowed);
      if (extra) return fail("invalid_argument", extra);
      const workDir = deps.resolveWorkDir(ctx.cwd);
      // research-charter: a chain brief draft is auto-approved by the charter
      // checks (spec: no owner dialog; approval.json source 'charter'). The
      // chain must be awaiting_child (the parent report is recorded) — anything
      // else is parent_not_reported.
      const draftChain = deps.activeChain(ctx);
      if (action === "draft" && draftChain !== null) {
        const verified = await chainJournal.verifyChain(draftChain.workDir, draftChain.chainId);
        if (!verified.ok) {
          // Review M3: a damaged journal cannot take a status write; the marker records it durably.
          await chainJournal.markManualCheckRequired(draftChain.workDir, draftChain.chainId, verified.message).catch(() => undefined);
          return fail("manual_check_required", `research chain ${draftChain.chainId}: ${verified.message}`);
        }
        const status = await chainJournal.statusOf(draftChain.workDir, draftChain.chainId);
        const stop = chainJournal.actionRefusalForStatus(status);
        if (stop !== null) return fail("invalid_transition", `research chain ${draftChain.chainId} is ${status}: ${stop.message}`);
        if (!(await deps.charterFileIntact(draftChain.workDir, draftChain.chainId, draftChain.charterPath, draftChain.charterSha256))) {
          return fail("charter_changed", `research chain ${draftChain.chainId}: the charter file changed since the owner confirmed it; chain is manual_check_required`);
        }
        const brief = params.brief;
        if (brief === undefined) return fail("invalid_argument", "draft requires the brief object");
        // Spec (review M6): a resubmitted, already confirmed brief returns the first
        // confirmation record. Runs AFTER the charter check (review 701ded3d B1), so a
        // changed charter refuses even a resubmission.
        if (typeof brief === "object") {
          const resentSha = researchState.sha256Hex(JSON.stringify(brief, null, 2) + "\n");
          const firstApproval = verified.entries.find(
            (e) => e.type === "brief_approved" && (e as { brief_sha256?: string }).brief_sha256 === resentSha,
          );
          if (firstApproval !== undefined) {
            const firstId = String((firstApproval as { campaign_id?: string }).campaign_id ?? "");
            // Crash-recovery (live case 2026-11-13): the auto-approval died
            // between the brief_approved and campaign_added journal writes
            // (EPERM on the Windows rename), so the approved campaign exists
            // on disk in briefing but is NOT the last campaign_added entry —
            // the runtime pin still points at the stopped parent and every
            // start refuses. Pin the already-approved campaign and teach the
            // continuation instead of refusing the same way forever.
            const firstDir = researchState.resolveCampaignDir(deps.effectiveResearchBase(workDir, ctx), firstId);
            if (firstDir.ok) {
              const insp = await researchState.inspectCampaign(firstDir.dir);
              if (insp.state?.phase === "briefing" || insp.state?.phase === "research") {
                const rt = deps.getRuntime(ctx);
                deps.transitionAutoresearchMode(ctx, {
                  enabled: rt.autoresearchMode, uiMode: rt.uiMode, campaignId: firstId, resetCounters: false,
                });
                return reply(`ℹ️ This brief was already approved in this chain (campaign ${firstId}, phase ${insp.state.phase}): no second campaign is created. Continue it now: research_questions(action="status"), then open questions and work the campaign.`);
              }
            }
            return reply("ℹ️ This brief was already approved in this chain (first confirmation: campaign " + firstId + "): no second campaign is created.");
          }
        }
        if (status !== "awaiting_child") {
          return fail("invalid_argument", `parent_not_reported: the parent campaign's report must be recorded before the next chain brief (chain status ${status})`);
        }
        const campaignIds = await deps.chainCampaignIds(ctx);
        const parentId = campaignIds[campaignIds.length - 1] ?? deps.getRuntime(ctx).researchCampaignId ?? "";
        let parentBrief: researchState.ResearchBrief | null = null;
        let parentDir: string | null = null;
        for (const base of [deps.effectiveResearchBase(workDir, ctx), workDir]) {
          const resolved = researchState.resolveCampaignDir(base, parentId);
          if (resolved.ok && fs.existsSync(resolved.dir)) { parentDir = resolved.dir; break; }
        }
        if (parentDir !== null) {
          const snap = await deps.researchSnapshot(parentDir);
          if (snap.ok) parentBrief = snap.brief;
        }
        if (parentBrief === null) {
          return fail("campaign_missing", `the parent campaign ${parentId} brief cannot be read; the chain is blocked until manual check`);
        }
        // Same bytes writeBriefDraft writes (pretty JSON + newline), so a resent
        // brief hashes identically and the dedup check can match it (review B1).
        const childSha = researchState.sha256Hex(JSON.stringify(brief, null, 2) + "\n");
        const approvedHashes = verified.entries
          .filter((e) => e.type === "brief_approved" && typeof (e as { brief_sha256?: string }).brief_sha256 === "string")
          .map((e) => (e as { brief_sha256: string }).brief_sha256);
        const chainDirPath = chainJournal.chainDir(draftChain.workDir, draftChain.chainId);
        if (chainDirPath === null) return fail("invalid_argument", "invalid chain id");
        const campaignCount = campaignIds.length + 1;
        const newDepth = campaignIds.length;
        const check = chainBriefs.approveChainBrief({
          parentBrief,
          parentCampaignId: parentId,
          childBriefRaw: brief,
          childBriefSha256: childSha,
          charter: draftChain.charter,
          chainStatus: status,
          campaignJournals: await deps.collectChainJournals(workDir, ctx, deps.effectiveResearchBase(workDir, ctx), draftChain.chainId),
          campaignCount,
          newDepth,
          approvedBriefHashes: approvedHashes,
        });
        if (!check.ok) {
          // Refusals are journaled with the named reason and the brief hash (spec).
          await chainJournal.appendEntry(chainDirPath, draftChain.workDir, draftChain.chainId, "brief_rejected", {
            reason: check.reason, brief_sha256: childSha,
          }).catch(() => undefined);
          // Spec: a brief that would exceed a charter limit makes the chain
          // status FINAL (limit_reached); chain actions refuse from now on.
          if (check.reason === "limit_reached") {
            await chainJournal.setChainStatus(draftChain.workDir, draftChain.chainId, "limit_reached").catch(() => undefined);
          }
          return fail(check.reason as never, check.message);
        }
        // Unrelated finished campaigns are archived by the common rules; chain
        // campaigns are excluded inside archiveFinishedCampaigns.
        await deps.archiveFinishedCampaigns(workDir, deps.effectiveResearchBase(workDir, ctx), ctx);
        if (check.duplicate === true) {
          return reply("ℹ️ This brief was already approved in this chain: no second campaign is created. Continue the existing campaign or write a different brief.");
        }
        // System-assigned child id: <chainId>-c<N> (root keeps its own id).
        const childNumber = campaignIds.length;
        const childId = `${draftChain.chainId}-c${childNumber}`;
        const childBase = deps.effectiveResearchBase(workDir, ctx);
        const created = await researchState.createCampaign(childBase, childId);
        if (!created.ok) return fail(created.reason, created.message);
        // Review M5: the campaign dir was created just now and no journal entry
        // refers to it yet. A failure after this point removes it, so a retry is
        // not blocked by campaign_exists.
        const dropOrphan = () => { try { fs.rmSync(created.dir, { recursive: true, force: true }); } catch { /* best effort */ } };
        const written = await researchState.writeBriefDraft(created.dir, check.childBrief);
        if (!written.ok) { dropOrphan(); return fail(written.reason, written.message); }
        const approved = await chainBriefs.writeChainApproval(created.dir, written.sha256, draftChain.charterSha256);
        if (!approved.ok) { dropOrphan(); return fail(approved.reason as never, approved.message); }
        await chainJournal.appendEntry(chainDirPath, draftChain.workDir, draftChain.chainId, "brief_approved", {
          campaign_id: childId,
          parent_campaign_id: parentId,
          brief_sha256: written.sha256,
          charter_sha256: draftChain.charterSha256,
          snapshot: check.snapshot,
        });
        await chainJournal.appendEntry(chainDirPath, draftChain.workDir, draftChain.chainId, "campaign_added", { campaign_id: childId, parent_campaign_id: parentId, depth: newDepth });
        await chainJournal.setChainStatus(draftChain.workDir, draftChain.chainId, "active");
        const rt = deps.getRuntime(ctx);
        deps.transitionAutoresearchMode(ctx, {
          enabled: rt.autoresearchMode, uiMode: rt.uiMode,
          campaignId: childId, chainContinuationSent: false, resetCounters: false,
        });
        deps.briefPreviewDir = created.dir;
        // Live-stall fix (2026-11-12): the tool reply is the only place the
        // start instruction lived; when the agent's turn ended right after the
        // brief approval the child campaign sat in briefing forever. The steer
        // message reaches the agent mid-turn so the campaign actually starts.
        deps.sendWhenReady(ctx, `Campaign ${childId} created and brief approved (sha256 ${written.sha256}). Continue now: research_questions(action="start", expected_sha256="${written.sha256}"), then research_questions(action="open", question_id=<id>) for the first question; keep going until the campaign stops and reports.`, { steerIfBusy: true });
        return reply(`✅ Chain brief auto-approved by the charter checks (source: charter, sha256 ${written.sha256}). Campaign ${childId} created (parent ${parentId}, depth ${newDepth}). Next: research_questions(action=start, expected_sha256=<this sha256>).`);
      }
      // The campaign id is never taken from the model: the pinned id (launch
      // command) wins; otherwise the single existing campaign is reused (draft
      // into an unapproved campaign stays possible); with none, draft
      // generates one and pins it; with several, everything refuses.
      // Campaign STATE lives under the effective base (pinned --state-root or
      // the work directory): resolveCampaignDir/createCampaign take that base.
      // A refused brief must move nothing: validate before any archive step.
      if (action === "draft") {
        if (params.brief === undefined) return fail("invalid_argument", "draft requires the brief object");
        const early = researchState.validateBrief(params.brief);
        if (!early.ok) {
          return fail("brief_invalid", `brief rejected (${early.errors.length} problem(s)): ${early.errors.join("; ")}`);
        }
      }
      const stateBase = deps.effectiveResearchBase(workDir, ctx);
      let campaignId = deps.getRuntime(ctx).researchCampaignId;
      if (campaignId === null) {
        // A draft starts a NEW campaign: finished (stopped) campaigns are moved
        // to .auto/research-archive/ first. An active one keeps the refusal below.
        if (action === "draft") {
          const before = deps.sessionResearchCampaignIds(workDir, ctx);
          if (before !== null && before.length > 0) await deps.archiveFinishedCampaigns(workDir, stateBase, ctx);
        }
        const ids = deps.sessionResearchCampaignIds(workDir, ctx);
        if (ids === null) return fail("state_unreadable", "the research root cannot be listed; nothing was changed");
        if (ids.length > 1) {
          return fail("invalid_argument", `several campaigns exist (${ids.join(", ")}); stop the active one or move the others: a session works with exactly one campaign`);
        }
        if (ids.length === 1) {
          campaignId = ids[0];
        } else if (action === "draft") {
          campaignId = `bench-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
          while (fs.existsSync(path.join(researchState.researchRoot(stateBase), campaignId))) {
            campaignId = `${campaignId}-${Math.random().toString(36).slice(2, 6)}`;
          }
          const rt = deps.getRuntime(ctx);
          deps.transitionAutoresearchMode(ctx, {
            enabled: rt.autoresearchMode, uiMode: rt.uiMode, campaignId, resetCounters: false,
          });
        } else {
          return fail("campaign_missing", "no campaign yet: the id is pinned by the launch command or generated by research_brief draft");
        }
      }
      // Resolve against the effective base first, then the default root: the
      // pinned id may exist under --state-root only (launch flow) or in the
      // default root (TUI flow without a state root). A brand-new campaign
      // (draft) exists in neither yet: create under the state base.
      const resolveDirOf = (base: string) => researchState.resolveCampaignDir(base, campaignId as string);
      const stateRootDir = resolveDirOf(stateBase);
      const defaultRootDir = stateBase !== workDir ? resolveDirOf(workDir) : null;
      const dirFromState = stateRootDir.ok && fs.existsSync(stateRootDir.dir) ? stateRootDir.dir : null;
      const dirFromDefault = defaultRootDir && defaultRootDir.ok && fs.existsSync(defaultRootDir.dir) ? defaultRootDir.dir : null;
      if (dirFromState === null && dirFromDefault === null) {
        if (!stateRootDir.ok && (defaultRootDir === null || !defaultRootDir.ok)) {
          return fail(stateRootDir.reason, stateRootDir.message);
        }
        // Valid path, no directory yet: only draft creates a campaign.
        if (action !== "draft") {
          return fail("campaign_missing", `campaign ${campaignId} does not exist yet; only research_brief draft creates a campaign`);
        }
      }
      const campaignBase = dirFromState !== null ? stateBase : dirFromDefault !== null ? workDir : stateBase;
      const dir = dirFromState ?? dirFromDefault ?? (stateRootDir.ok ? stateRootDir.dir : path.join(researchState.researchRoot(stateBase), campaignId!));

      if (action === "draft") {
        // A NEW campaign directory (pinned or generated) moves the finished
        // campaigns to the archive first; an active or unreadable one refuses.
        if (dirFromState === null && dirFromDefault === null) {
          const moved = await deps.archiveFinishedCampaigns(workDir, stateBase, ctx);
          if (moved === null) {
            return fail("invalid_argument", `a research campaign other than ${campaignId} is active or unreadable; finish it first: a session works with exactly one campaign`);
          }
        }
        const created = await researchState.createCampaign(campaignBase, campaignId);
        if (!created.ok && created.reason !== "campaign_exists") return fail(created.reason, created.message);
        const written = await researchState.writeBriefDraft(dir, params.brief);
        if (!written.ok) return fail(written.reason, written.message);
        deps.briefPreviewDir = dir;
        return reply(`✅ Brief draft saved for campaign ${campaignId} (sha256 ${written.sha256}). It is NOT approved yet: the owner confirms it with research_brief propose.`);
      }

      if (action === "status") {
        const insp = await researchState.inspectCampaign(dir);
        const snap = await deps.researchSnapshot(dir);
        if (!snap.ok) return fail(snap.reason, snap.message);
        const lines = [
          `Research brief status for campaign ${campaignId} (phase ${snap.state.phase})`,
          `Campaign state: ${insp.status} — ${insp.message}`,
        ];
        if (insp.pendingOp) lines.push(`Pending op: ${insp.pendingOp.name} (started ${insp.pendingOp.started_at}) — manual check required`);
        const approval = await researchState.readApproval(dir);
        if (snap.brief && snap.briefSha256) {
          lines.push(`Brief approved; sha256 ${snap.briefSha256} matches approval.json`);
        } else if (!approval.ok && approval.reason === "not_approved") {
          const sha = await researchState.briefSha256(dir);
          lines.push(sha.ok ? `Brief draft, NOT approved; sha256 ${sha.sha256}` : `Brief draft: ${sha.message}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { action, inspection: insp as any } };
      }

      // propose: owner dialog. No UI or no explicit confirm === true means no approval.
      const state = await researchState.readState(dir);
      if (!state.ok) return fail(state.reason, state.message);
      // Checked before the dialog: an approved (or unreadable) approval is never shown for consent again.
      const existing = await researchState.readApproval(dir);
      if (existing.ok) return fail("brief_approved", "the brief is already approved; a changed brief means a new campaign");
      if (existing.reason !== "not_approved") return fail(existing.reason, existing.message);
      if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
        return fail("not_approved", "brief approval is an owner action and needs an interactive dialog; the brief stays unapproved");
      }
      let briefText: string;
      let briefSha = "";
      try {
        // Review M2: hash the SAME bytes shown in the dialog, not a second read.
        const bytes = await fs.promises.readFile(path.join(dir, researchState.BRIEF_FILE));
        briefText = bytes.toString("utf8");
        briefSha = researchState.sha256Hex(bytes);
      } catch {
        return fail("brief_missing", "brief.json does not exist; draft the brief first");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(briefText);
      } catch {
        return fail("brief_invalid", "brief.json is not valid JSON; the brief cannot be approved");
      }
      const validation = researchState.validateBrief(parsed);
      if (!validation.ok) {
        return fail("brief_invalid", `brief.json failed validation (${validation.errors.length} problem(s)): ${validation.errors.join("; ")}`);
      }
      const sha = briefSha ? { ok: true as const, sha256: briefSha } : await researchState.briefSha256(dir);
      if (!sha.ok) return fail(sha.reason, sha.message);
      // The full brief is in this tool call's transcript row (renderCall), above this dialog.
      const outcome = await askConsent<{ ok: boolean; reason?: string; message: string }>({
        hasUi: true,
        title: `Research campaign ${campaignId}: approve brief`,
        body: briefConsentSummary(validation.brief, sha.sha256, campaignId),
        confirm: (title, body) => ctx.ui.confirm(title, body),
        // A refusal writes nothing for research: its approval.json exists only for a confirmed brief.
        record: async (confirmed) => (confirmed ? researchState.writeApproval(dir, sha.sha256) : { ok: true as const, message: "" }),
      });
      if (outcome.status === "refused") return fail("not_approved", "the owner did not confirm the brief; nothing was approved");
      if (outcome.status === "write_failed") return fail(outcome.failure.reason ?? "approval_invalid", outcome.failure.message);
      return reply(
        `✅ Brief approved for campaign ${campaignId} (sha256 ${sha.sha256}). Start the research phase: research_questions(action=start, expected_sha256="${sha.sha256}"). Brief file: ${path.join(dir, researchState.BRIEF_FILE)}.`,
      );
    },
  };
}
