/**
 * research_questions + expedition_map alias tools (extracted from index.ts;
 * registered tool bodies are byte-identical apart from deps reads at the call
 * site). Field allowlists, action/subaction sets, renderer normalization,
 * refusal strings, guard order and the hidden dispatcher call shape are
 * preserved. Extension-local collaborators arrive through `deps` and are read
 * as `deps.foo` at the point of use — never frozen in an execute() destructure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type AliasTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface ResearchAliasToolDeps {
  assertModeActive: (ctx: ExtensionContext) => any;
  refusalText: (r: { reason: string | null; message: string }) => string;
  researchExecutor: (...args: any[]) => Promise<any>;
  researchRenderer?: ((...args: any[]) => any) | undefined;
}

const campaignAliasKeys = new Set(["action", "expected_sha256", "question_id", "evidence_ref", "rule_id", "verdict", "reason"]);
const campaignAliasActions = new Set(["start", "open", "record", "close", "stop", "status", "report", "resolve", "chain_stop"]);
const mapAliasKeys = new Set(["subaction", "dir", "from", "to", "reason", "why", "refs", "review_ref", "review_sha256"]);
const mapAliasActions = new Set(["open", "activate", "resolve", "reject", "advisory", "park", "reopen", "pivot", "status"]);

const aliasRefusal = (deps: ResearchAliasToolDeps, toolName: string, message: string) => ({
  content: [{ type: "text" as const, text: deps.refusalText({ reason: "invalid_argument", message }) }],
  details: { action: toolName, reason: "invalid_argument" },
});

const makeAliasRenderer = (deps: ResearchAliasToolDeps, toolName: string, mapAlias: boolean) => (args: any, theme: any, context: any) => {
  try {
    const normalized = mapAlias ? { ...(args ?? {}), action: "expedition" } : args;
    return deps.researchRenderer?.(normalized, theme, context) ?? new Text(theme ? theme.fg("toolTitle", theme.bold(`${toolName} `)) : `${toolName} `, 0, 0);
  } catch {
    return new Text(`${toolName} `, 0, 0);
  }
};

export function createResearchQuestionsTool(deps: ResearchAliasToolDeps): AliasTool {
  return {
    name: "research_questions",
    label: "Research campaign questions",
    description: "Campaign lifecycle and approved-brief question tool. Actions: start, open, record, close, stop, status, report, resolve, chain_stop. `close` resolves a CAMPAIGN QUESTION using question_id + rule_id + verdict + evidence. `resolve` is OPERATOR-only pending-operation cleanup requiring owner dialog confirmation. For EXPEDITION MAP direction operations use expedition_map, not this tool.",
    promptSnippet: "Campaign questions: open, record evidence, close questions under the approved brief; expedition map is a separate tool",
    promptGuidelines: [
      "Use research_questions(action=close) to close a campaign question: provide question_id, rule_id from that question, verdict, and recorded evidence.",
      "Workflow per question: action=open(question_id) -> action=record(evidence_ref) -> action=close(question_id, rule_id, verdict). record takes ONLY evidence_ref (a file:lines or file#anchor INSIDE the work directory) and binds to the currently open question — never pass question_id to record. If the evidence file lives outside the work directory, copy it in first (e.g. under .auto/research/evidence/) and cite the relative path.",
      "This tool's resolve is only an operator-confirmed pending-op cleanup; it does not resolve map directions.",
      "Do not pass map refs/review_ref/from/to here; use expedition_map for map operations.",
    ],
    renderCall: makeAliasRenderer(deps, "research_questions", false),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "open", "record", "close", "stop", "status", "report", "resolve", "chain_stop"], description: "Campaign/question action." },
        expected_sha256: { type: "string", description: "start only: approved brief SHA-256." },
        question_id: { type: "string", description: "open/close: question id from the approved brief." },
        evidence_ref: { type: "string", description: "record only: path:lines or path#anchor pointing INSIDE the work directory (copy external evidence in first); binds to the currently open question — question_id is not taken." },
        rule_id: { type: "string", description: "close: decision rule for that question; stop: stop rule of the approved brief; chain_stop: charter stop rule." },
        verdict: { type: "string", description: "close only: verdict declared by the approved brief." },
        reason: { type: "string", description: "stop: required; close: required for inconclusive/waiting_for_data verdicts." },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const extra = Object.keys(params ?? {}).filter((key) => !campaignAliasKeys.has(key));
      if (extra.length) {
        const mapOnly = extra.some((key) => ["refs", "review_ref", "review_sha256", "from", "to"].includes(key));
        return aliasRefusal(deps, "research_questions", `unexpected field(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; ${mapOnly ? "use expedition_map(subaction=..., refs=...) for map direction operations" : "only campaign/question fields are accepted"}`);
      }
      if (!campaignAliasActions.has(params?.action)) return aliasRefusal(deps, "research_questions", `unknown campaign/question action ${JSON.stringify(String(params?.action))}`);
      return deps.researchExecutor(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function createExpeditionMapTool(deps: ResearchAliasToolDeps): AliasTool {
  return {
    name: "expedition_map",
    label: "Expedition direction map",
    description: "Expedition MAP ONLY: open/activate/resolve/reject/advisory/park/reopen/pivot/status directions. `resolve`/`reject` close a MAP DIRECTION using refs to already-closed campaign questions; they do NOT close a question and never accept rule_id/verdict. For questions use research_questions(action=close, question_id, rule_id, verdict).",
    promptSnippet: "Expedition map only: activate/resolve/reject directions using refs; campaign questions use research_questions",
    promptGuidelines: [
      "Use expedition_map(subaction=activate, dir=<name>, why=<rationale>) to activate the current direction.",
      "Use expedition_map(subaction=resolve, dir=<name>, refs=[{campaign,question}]) or expedition_map(subaction=reject, dir=<name>, refs=[{campaign,question}]) to close a MAP DIRECTION after referenced questions are closed; reason is optional for both.",
      "This tool never accepts rule_id or verdict. Use research_questions(action=close, question_id, rule_id, verdict) to close a campaign question.",
      "Do not confuse research_questions(action=resolve), which is operator-only pending-op cleanup, with map resolve.",
    ],
    renderCall: makeAliasRenderer(deps, "expedition_map", true),
    parameters: {
      type: "object",
      properties: {
        subaction: { type: "string", enum: ["open", "activate", "resolve", "reject", "advisory", "park", "reopen", "pivot", "status"], description: "Map transition or status." },
        dir: { type: "string", description: "Direction name for open/activate/resolve/reject/advisory/park/reopen." },
        from: { type: "string", description: "pivot only: currently active direction." },
        to: { type: "string", description: "pivot only: open target direction." },
        reason: { type: "string", description: "Transition rationale; required for park/reopen/pivot." },
        why: { type: "string", description: "open/activate rationale." },
        refs: { type: "array", items: { type: "object", properties: { campaign: { type: "string" }, question: { type: "string" } }, required: ["campaign", "question"], additionalProperties: false }, description: "resolve/reject only: closed question refs proving direction outcome." },
        review_ref: { type: "string", description: "advisory only: review file path." },
        review_sha256: { type: "string", description: "advisory only: SHA-256 of the review file." },
      },
      required: ["subaction"],
      additionalProperties: false,
    } as any,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const extra = Object.keys(params ?? {}).filter((key) => !mapAliasKeys.has(key));
      if (extra.length) {
        const questionOnly = extra.some((key) => ["rule_id", "verdict", "question_id", "expected_sha256", "evidence_ref"].includes(key));
        return aliasRefusal(deps, "expedition_map", `unexpected field(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; ${questionOnly ? "use research_questions(action=close, question_id, rule_id, verdict) to close a campaign question" : "only expedition map fields are accepted"}`);
      }
      if (!mapAliasActions.has(params?.subaction)) return aliasRefusal(deps, "expedition_map", `unknown expedition-map subaction ${JSON.stringify(String(params?.subaction))}`);
      return deps.researchExecutor(toolCallId, { ...params, action: "expedition" }, signal, onUpdate, ctx);
    },
  };
}
