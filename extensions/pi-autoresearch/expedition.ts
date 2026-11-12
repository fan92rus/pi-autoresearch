/** Pure expedition document, map, transition, and presentation logic (research-expedition spec scenarios). */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, type ChainEntry, type Result } from "./chain-journal.ts";
import * as charter from "./charter.ts";
import * as researchState from "./research-state.ts";

export interface ExpeditionDoc { charter: charter.Charter; goal: string; directions: Array<{name: string; why: string}>; campaign0: researchState.ResearchBrief }
const refuse = (reason: string, message: string): Result<never> => ({ ok: false, reason, message });
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Validates the expedition-specific allowlist and nested charter/brief (spec: invalid document). */
export function validateExpeditionDoc(raw: unknown): Result<{doc: ExpeditionDoc}> {
  if (!record(raw)) return refuse("expedition_doc_invalid", "document must be an object");
  const errors: string[] = [];
  if (!Object.keys(raw).every(k => ["charter", "goal", "directions", "campaign0"].includes(k)) || !["charter", "goal", "directions", "campaign0"].every(k => k in raw)) errors.push("document fields must be charter, goal, directions, campaign0");
  const c = charter.validateCharter(raw.charter); if (!c.ok) errors.push(...c.errors);
  if (!nonempty(raw.goal)) errors.push("goal must be a non-empty string");
  if (!Array.isArray(raw.directions) || raw.directions.length === 0) errors.push("directions must be a non-empty array");
  else raw.directions.forEach((d, i) => { if (!record(d) || !nonempty(d.name) || !nonempty(d.why) || Object.keys(d).some(k => !["name", "why"].includes(k))) errors.push(`directions[${i}] must have non-empty name and why`); });
  const b = researchState.validateBrief(raw.campaign0); if (!b.ok) errors.push(...b.errors);
  if (errors.length) return refuse("expedition_doc_invalid", errors.join("; "));
  return { ok: true, doc: { charter: c.charter, goal: raw.goal as string, directions: raw.directions as ExpeditionDoc["directions"], campaign0: b.brief } };
}

/** Renders owner confirmation contents, bound to the exact document digest. */
export function expeditionDialogText(doc: ExpeditionDoc, sha256: string): string {
  return [`Expedition SHA-256: ${sha256}`, `Goal: ${doc.goal}`, "Directions:", ...doc.directions.map(d => `- ${d.name}: ${d.why}`), "Campaign 0 questions:", ...doc.campaign0.questions.map(q => `- ${q.id}: ${q.text}`), `Stop rules: ${(doc.charter.stop_rules ?? []).join("; ") || "none"}`, `Limits: max_campaigns=${doc.charter.max_campaigns ?? "unlimited"}; max_depth=${doc.charter.max_depth ?? "unlimited"}`].join("\n");
}
export const EXPEDITION_DRAFTS_DIR = "research-expedition-drafts";
export function expeditionDraftsDir(stateRoot: string): string { return join(stateRoot, EXPEDITION_DRAFTS_DIR); }
/** Saves the single canonical draft file. */
export function saveExpeditionDraft(stateRoot: string, doc: ExpeditionDoc): Result<{path: string}> {
  const valid = validateExpeditionDoc(doc); if (!valid.ok) return valid;
  const dir = expeditionDraftsDir(stateRoot), path = join(dir, "expedition-draft.json");
  try { mkdirSync(dir, {recursive:true}); writeFileSync(path, JSON.stringify(valid.doc, null, 2) + "\n", "utf8"); return {ok:true,path}; }
  catch (e) { return refuse("io_failed", `cannot save expedition draft: ${String(e)}`); }
}
export function findLatestDraft(stateRoot: string): string | null { const p=join(expeditionDraftsDir(stateRoot),"expedition-draft.json"); return existsSync(p)?p:null; }
/** Reads, validates, and hashes the exact UTF-8 file bytes. */
export function readExpeditionDoc(path: string): Result<{doc: ExpeditionDoc; sha256: string; bytes: string}> {
  try { const bytes=readFileSync(path,"utf8"), parsed: unknown=JSON.parse(bytes), v=validateExpeditionDoc(parsed); return v.ok?{ok:true,doc:v.doc,sha256:sha256Hex(bytes),bytes}:v; }
  catch(e) { return refuse("expedition_doc_unreadable", `cannot read expedition document: ${String(e)}`); }
}

export type DirectionStatus = "open"|"active"|"resolved"|"rejected"|"advisory_exhausted"|"parked";
export interface DirectionState { dir:string; status:DirectionStatus; why:string; refs?:Array<{campaign:string;question:string}>; campaign?:string; reason?:string; reviewRef?:string; reviewSha256?:string }
export type MapEventType = "direction_opened"|"direction_activated"|"direction_resolved"|"direction_rejected"|"direction_parked"|"direction_reopened"|"direction_advisory"|"pivot"|"expedition_stop";
export interface ExpeditionMap { goal:string; docSha256:string; directions:Map<string,DirectionState>; lastCloseAt:number|null; lastPivotAt:number|null; openedCount:number; stopEvent:{rule:string;basis:string}|null; timeline:Array<{type:MapEventType;dir?:string;to?:string;at:string;note?:string}> }
const mapTypes = new Set<string>(["direction_opened","direction_activated","direction_resolved","direction_rejected","direction_parked","direction_reopened","direction_advisory","pivot","expedition_stop"]);
/** Replays verified entries in order; does not validate historical transition legality. */
export function replayExpeditionMap(entries: ChainEntry[]): Result<{map:ExpeditionMap}> {
  const created=entries.find(e=>e.type==="expedition_created"); if (!created) return refuse("not_an_expedition","chain has no expedition_created entry");
  const map:ExpeditionMap={goal:typeof created.goal==="string"?created.goal:"",docSha256:typeof created.doc_sha256==="string"?created.doc_sha256:"",directions:new Map(),lastCloseAt:null,lastPivotAt:null,openedCount:0,stopEvent:null,timeline:[]};
  entries.forEach((e,i)=>{ const type=e.type as MapEventType; if(!mapTypes.has(type)) return;
    const dir=typeof e.dir==="string"?e.dir:(type==="pivot"&&typeof e.from==="string"?e.from:undefined), to=typeof e.to==="string"?e.to:undefined;
    const note=typeof e.why==="string"?e.why:typeof e.reason==="string"?e.reason:typeof e.note==="string"?e.note:undefined;
    map.timeline.push({type,...(dir?{dir}:{}),...(to?{to}:{}),at:typeof e.at==="string"?e.at:"",...(note?{note}:{})});
    if(type==="expedition_stop"){map.stopEvent={rule:typeof e.rule==="string"?e.rule:"",basis:typeof e.basis==="string"?e.basis:""};return;}
    if(type==="pivot") { if(dir){map.directions.set(dir,{dir,status:"parked",why:typeof e.reason==="string"?e.reason:"",reason:typeof e.reason==="string"?e.reason:""});} if(to){if(!map.directions.has(to))map.openedCount++;map.directions.set(to,{dir:to,status:"active",why:typeof e.reason==="string"?e.reason:"",reason:typeof e.reason==="string"?e.reason:"",campaign:typeof e.campaign==="string"?e.campaign:undefined});} map.lastPivotAt=i; return; }
    if(!dir)return;
    const old=map.directions.get(dir); const why=typeof e.why==="string"?e.why:typeof e.reason==="string"?e.reason:typeof e.note==="string"?e.note:old?.why??"";
    let status:DirectionStatus=old?.status??"open";
    if(type==="direction_opened"){status="open";if(!old)map.openedCount++;}
    else if(type==="direction_activated")status="active";
    else if(type==="direction_resolved"){status="resolved";map.lastCloseAt=i;}
    else if(type==="direction_rejected"){status="rejected";map.lastCloseAt=i;}
    else if(type==="direction_parked")status="parked";
    else if(type==="direction_reopened")status="open";
    else if(type==="direction_advisory")status="advisory_exhausted";
    map.directions.set(dir,{dir,status,why,...(Array.isArray(e.refs)?{refs:e.refs as DirectionState["refs"]}:{}),...(typeof e.campaign==="string"?{campaign:e.campaign}:{}),...(typeof e.reason==="string"?{reason:e.reason}:{}),...(typeof e.review_ref==="string"?{reviewRef:e.review_ref}:{}),...(typeof e.review_sha256==="string"?{reviewSha256:e.review_sha256}:{})});
  }); return {ok:true,map};
}
/** Checks the proposed map event without mutating the replayed map. For activation, journals coverage is the chain-membership proof; the research-phase condition is enforced by the caller passing the runtime campaign id. */
export function validateMapTransition(map:ExpeditionMap,type:MapEventType,payload:Record<string,unknown>,journals:Map<string,Array<{questionId:string;verdict:string;hasEvidence:boolean}>>):Result<{dir?:string;to?:string}> {
  const dir=typeof payload.dir==="string"?payload.dir:"", from=typeof payload.from==="string"?payload.from:"", to=typeof payload.to==="string"?payload.to:"", cur=map.directions.get(type==="pivot"?from:dir);
  const bad=(r:string,m:string)=>refuse(r,m);
  if(type==="direction_opened"){if(!dir||map.directions.has(dir))return bad("direction_already_exists","direction_opened requires a new direction name");if(!nonempty(payload.why))return bad("direction_why_required","why is required");}
  if(type==="direction_activated"){if(!cur||cur.status!=="open")return bad("direction_not_open","activation requires an open direction");if([...map.directions.values()].some(d=>d.status==="active"))return bad("active_direction_exists","another direction is active");if(!nonempty(payload.campaign))return bad("campaign_required","campaign is required");if(!journals.has(payload.campaign as string))return bad("campaign_not_in_chain","activation campaign must be a campaign of this chain");if(!nonempty(payload.why))return bad("activation_why_required","activation requires a rationale (why)");}
  if(type==="direction_resolved"||type==="direction_rejected"){if(!cur||cur.status!=="active")return bad("direction_not_active","closing requires active direction");if(!Array.isArray(payload.refs)||!payload.refs.length)return bad("refs_required","closing requires evidence refs");for(const r of payload.refs){if(!record(r)||typeof r.campaign!=="string"||typeof r.question!=="string")return bad("refs_invalid","invalid evidence ref");const rows=journals.get(r.campaign);if(!rows||!rows.some(x=>x.questionId===r.question&&x.verdict!==""&&x.hasEvidence))return bad("refs_unproven","ref must name a closed question with evidence in this chain");}}
  if(type==="direction_advisory"){if(!cur||cur.status!=="active")return bad("direction_not_active","advisory requires active direction");if(!nonempty(payload.review_ref)||!nonempty(payload.review_sha256)||!existsSync(payload.review_ref as string))return bad("review_missing","advisory requires an existing review and sha256");if(sha256Hex(readFileSync(payload.review_ref as string))!==payload.review_sha256)return bad("review_hash_mismatch","review_sha256 does not match the review file contents");}
  if(type==="direction_parked"){if(!cur||! ["open","active"].includes(cur.status))return bad("invalid_transition","only open or active directions can be parked");if(!nonempty(payload.reason))return bad("reason_required","park requires reason");}
  if(type==="direction_reopened"){if(!cur||!["parked","advisory_exhausted","resolved","rejected"].includes(cur.status))return bad("invalid_transition","reopen requires parked, advisory, resolved or rejected");if(!nonempty(payload.reason))return bad("reason_required","reopen requires reason");}
  if(type==="pivot"){if(!cur||cur.status!=="active")return bad("pivot_from_not_active","pivot from must be active");if(!to||to===from)return bad("pivot_target_invalid","pivot target must differ from source");const target=map.directions.get(to);if(target&&!["open","parked"].includes(target.status))return bad("pivot_target_invalid","pivot target must be new, open or parked");if(!nonempty(payload.reason))return bad("reason_required","pivot requires reason");}
  return {ok:true,...(dir?{dir}:{}),...(to?{to}:{})};
}
/** Pure territory predicate; event order, not wall-clock time, determines pivot tail. */
export function territoryComplete(map:ExpeditionMap):{value:boolean;openDirs:string[];pivotTail:boolean;openedCount:number} {const openDirs=[...map.directions.values()].filter(d=>d.status==="open"||d.status==="active").map(d=>d.dir);const lastClose=map.lastCloseAt??-1,lastPivot=map.lastPivotAt??-1;const pivotTail=lastPivot>lastClose;return {value:openDirs.length===0&&!pivotTail&&map.openedCount>=1,openDirs,pivotTail,openedCount:map.openedCount};}
function glyph(s:DirectionStatus):string{return ({resolved:"✅",active:"🔄",parked:"💤",open:"○",advisory_exhausted:"❓",rejected:"❌"})[s];}
/** Text map slice for an agent continuation, preserving evidence caveats. */
export function mapSliceText(map:ExpeditionMap):string{return [...map.directions.values()].map(d=>`${glyph(d.status)} ${d.dir} — ${d.status}: ${d.why}${d.status==="advisory_exhausted"?" (основание — самоотчёт, не доказательство)":""}${d.status==="active"?` [campaign ${d.campaign??"unknown"}]`:""}${d.refs?.length?` [refs ${d.refs.map(r=>`${r.campaign}/${r.question}`).join(", ")}]`:""}`).join("\n");}
/** Plain-text TUI widget lines (the renderer owns width truncation). Every row
 *  is guaranteed single-line: dynamic strings are sanitized because
 *  truncateToWidth cuts width but not embedded CR/LF, and a newline inside a
 *  row would break the TUI widget layout contract (render returns one string
 *  per visual line). */
function oneLine(s:string):string{return s.replace(/\s*[\r\n]+\s*/g," ");}
export function expeditionWidgetLines(map:ExpeditionMap,info:{campaignId:string|null;campaignPhase:string|null;openQuestions:string[];campaignsUsed:number;campaignsLimit:number|null;chainStatus:string}):string[]{
  const done=[...map.directions.values()].filter(d=>["resolved","rejected"].includes(d.status)).length;
  const goal=oneLine(map.goal),camp=oneLine(info.campaignId??info.chainStatus);
  const phase=info.campaignPhase?oneLine(info.campaignPhase):null;
  const head="🧭 "+goal+" │ campaign "+camp+(phase?(" ("+phase+")"):"");
  const rows=[...map.directions.values()].map(d=>{
    const why=oneLine(d.why);
    const dcamp=oneLine(d.campaign??info.campaignId??"?");
    const qs=info.openQuestions.map(oneLine).join(", ");
    let row=glyph(d.status)+" "+d.dir;
    if(d.status==="active")row+=" campaign "+dcamp+(qs.length?" — "+qs:"");
    else row+=" — "+why;
    if(d.status==="advisory_exhausted")row+=" (самоотчёт, не доказательство)";
    return row;
  });
  const foot="territory "+done+"/"+map.directions.size+" │ campaigns "+info.campaignsUsed+(info.campaignsLimit===null?"":"/"+info.campaignsLimit)+" │ next: "+oneLine(info.chainStatus);
  return [head,...rows,foot];
}
/** Produces a conservative markdown final report; never claims successful coverage. */
export function expeditionReportText(map:ExpeditionMap,opts:{chainId:string;finalStatus:string;campaigns:Array<{id:string;reportPath:string}>;computedAt:string;activeDirWithoutCampaign?:string}):string{const pred=territoryComplete(map),unclosed=[...map.directions.values()].filter(d=>["parked","advisory_exhausted","active","open"].includes(d.status));const lines=[`# Expedition report — ${opts.chainId}`,`Status: ${opts.finalStatus}`,`Stop: ${map.stopEvent?`${map.stopEvent.rule} (${map.stopEvent.basis})`:"not recorded"}`,"Campaigns:",...opts.campaigns.map(c=>`- ${c.id}: ${c.reportPath}`),"",`Goal: ${map.goal}`,"","## Map (final)","| Dir | Status | Basis | Evidence |","|---|---|---|---|"];for(const d of map.directions.values())lines.push(`| ${d.dir} | ${d.status} | ${d.status==="advisory_exhausted"?"UNKNOWN basis: self-report — NOT proof":d.why} | ${(d.refs??[]).map(r=>`${r.campaign}/${r.question}`).join(", ")} |`);lines.push("","## Timeline",...map.timeline.map((e,i)=>`${i+1}. ${e.at} ${e.type}${e.dir?` ${e.dir}`:""}${e.to?` → ${e.to}`:""}${e.note?` — ${e.note}`:""}`),"","## Unfinished",...(unclosed.length?unclosed.map(d=>`- ${d.dir}: ${d.status==="parked"?"не исследовано":d.status==="advisory_exhausted"?"не доказательство":d.status}${d.status==="active"&&opts.activeDirWithoutCampaign===d.dir?" — active direction without a live campaign":""}`):["- none recorded"]),`territory_complete: ${pred.value} (computed ${opts.computedAt})${pred.openDirs.length?`; open: ${pred.openDirs.join(", ")}`:""}`);return lines.join("\n");}
