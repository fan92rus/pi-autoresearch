import * as chainJournal from "./chain-journal.ts";
import * as expedition from "./expedition.ts";
import * as researchState from "./research-state.ts";
import { renderRefusal } from "./refusal.ts";

export function createResearchPolicy(): Map<string, string[]> {
  return new Map([
    ["start", ["action", "expected_sha256"]],
    ["open", ["action", "question_id"]],
    ["record", ["action", "evidence_ref"]],
    ["close", ["action", "question_id", "rule_id", "verdict", "reason"]],
    ["stop", ["action", "rule_id", "reason"]],
    ["status", ["action"]],
    ["report", ["action"]],
    ["resolve", ["action"]],
    ["chain_stop", ["action", "rule_id", "reason"]],
    ["expedition", ["action", "subaction", "dir", "to", "from", "reason", "why", "refs", "review_ref", "review_sha256"]],
  ]);
}

/** Executes the expedition action; collaborators are injected by the extension adapter. */
export async function executeResearchAction(params: any, ctx: any, workDir: string, deps: Record<string, any>) {
  // bd pi-autoresearch-161.3: runtime access arrives through the canonical
  // hooks object (`deps.hooks`), with the old direct deps key kept as fallback
  // for callers that have not adopted the deps object yet.
  const { activeChain, getRuntime = deps.hooks?.getRuntime, collectChainJournals, effectiveResearchBase, researchSnapshot, expeditionCloseNudge, sendWhenReady } = deps;
  const action = params?.action;
  const reply = (text: string) => ({ content: [{ type: "text", text }], details: { action } });
  const fail = (reason: string, message: string) => ({
    content: [{ type: "text", text: renderRefusal({ reason, message }) }],
    details: { action, reason },
  });
  if (action !== "expedition") return undefined;
  const chain = activeChain(ctx);
  if (!chain?.expedition) return fail("not_an_expedition", "expedition_map is available only on an expedition chain");
  const verified = await chainJournal.verifyChain(chain.workDir, chain.chainId);
  if (!verified.ok) {
    await chainJournal.markManualCheckRequired(chain.workDir, chain.chainId, verified.message).catch(() => undefined);
    return fail("manual_check_required", verified.message);
  }
  const replay = expedition.replayExpeditionMap(verified.entries);
  if (!replay.ok) return fail(replay.reason, replay.message);
  const subaction = params.subaction;
  if (subaction === "status") return reply(expedition.mapSliceText(replay.map) || "Expedition map is empty.");
  const types: Record<string, expedition.MapEventType> = {open:"direction_opened",activate:"direction_activated",resolve:"direction_resolved",reject:"direction_rejected",advisory:"direction_advisory",park:"direction_parked",reopen:"direction_reopened",pivot:"pivot"};
  if (subaction === "expedition_stop" || !types[subaction]) return fail("invalid_argument", "invalid expedition subaction; expedition_stop is written by the system");
  const type = types[subaction];
  const payload: Record<string, unknown> = {dir:params.dir,from:params.from,to:params.to,why:params.why ?? params.reason,reason:params.reason ?? params.why,refs:params.refs,review_ref:params.review_ref,review_sha256:params.review_sha256,...(subaction === "activate" ? {campaign:getRuntime(ctx).researchCampaignId} : {})};
  const journals = new Map<string, Array<{questionId:string;verdict:string;hasEvidence:boolean}>>();
  for (const j of await collectChainJournals(workDir, ctx, effectiveResearchBase(workDir, ctx), chain.chainId)) journals.set(j.campaignId, j.closedQuestions);
  if (subaction === "activate") {
    const pinnedId = getRuntime(ctx).researchCampaignId;
    if (typeof pinnedId === "string" && pinnedId.length > 0) {
      const pinnedResolved = researchState.resolveCampaignDir(workDir, pinnedId);
      if (pinnedResolved.ok) {
        try {
          const pinnedSnap = await researchSnapshot(pinnedResolved.dir);
          if (pinnedSnap.ok && pinnedSnap.brief !== null && pinnedSnap.state.phase === "research" && pinnedSnap.brief.questions.length > 0) {
            const anyOpen = pinnedSnap.brief.questions.some((q: any) => pinnedSnap.replay.vectors.get(q.id)?.status !== "closed");
            if (!anyOpen) return fail("campaign_exhausted", `Campaign ${pinnedId} has every brief question closed (phase research) — activating another direction on it gives the agent nothing to record against. Brief a NEW chain campaign first: research_brief draft (finding_refs cite closed questions of this chain; auto-approved by the charter checks) -> research_questions(action=start, expected_sha256=<approved brief sha256>), then activate the next direction (it will pin the new campaign).`);
          }
        } catch { /* snapshot failure: keep the legacy behavior */ }
      }
    }
  }
  const transition = expedition.validateMapTransition(replay.map, type, payload, journals);
  if (!transition.ok) return fail(transition.reason, transition.message);
  const chainDirPath = chainJournal.chainDir(chain.workDir, chain.chainId);
  if (!chainDirPath) return fail("manual_check_required", "chain directory is unavailable");
  const written = await chainJournal.appendEntry(chainDirPath, chain.workDir, chain.chainId, type, payload);
  if (!written.ok) return fail(written.reason as never, written.message);
  if (["resolve", "reject", "advisory", "park"].includes(subaction)) {
    const postReplay = expedition.replayExpeditionMap([...verified.entries, written.entry]);
    if (!postReplay.ok) return reply(`Expedition map recorded: ${subaction} ${params.dir ?? params.from ?? ""}.`);
    const preActive = replay.map.directions.get(String(payload.dir ?? ""))?.status === "active";
    const nudge = await expeditionCloseNudge(ctx, chain, postReplay.map, { eventClosedActive: preActive });
    if (nudge !== null) {
      if (nudge.steerMessage !== null) sendWhenReady(ctx, nudge.steerMessage, { steerIfBusy: true });
      return reply(`Expedition map recorded: ${subaction} ${params.dir ?? params.from ?? ""}. ${nudge.replySuffix}`);
    }
  }
  return reply(`Expedition map recorded: ${subaction} ${params.dir ?? params.from ?? ""}.`);
}
