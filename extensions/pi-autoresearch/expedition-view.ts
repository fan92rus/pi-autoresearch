/** Pure read-only expedition view shared by the TUI surfaces (expedition-tui
 *  spec): fullscreen lines, widget verdicts line and the web JSON payload.
 *  Reads only the on-disk artifacts (chain journal, restart marker, campaign
 *  state/brief/log/evidence), verifies nothing (no hash checks — the same
 *  stance as the widget map) and never throws: every read is an independent
 *  fail-soft step. No pi module imports — sibling extension modules only. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ChainEntry } from "./chain-journal.ts";
import * as expedition from "./expedition.ts";
import { DEFAULT_VERDICTS } from "./research-state.ts";

export interface ExpeditionViewDir { name: string; status: expedition.DirectionStatus; why: string; refs: Array<{ campaign: string; question: string }>; campaign: string | null }
export interface ExpeditionViewQuestion { id: string; text: string; closed: boolean; verdict: string | null; ruleId: string | null; reason: string | null; hasEvidence: boolean }
export interface ExpeditionViewTimelineItem { type: string; dir: string | null; to: string | null; at: string; note: string | null }
export interface ExpeditionViewCounters { done: number; total: number; campaignsUsed: number; campaignsMax: number | null; qClosed: number; qTotal: number; next: string }
export interface ExpeditionView {
  fail: null | "journal" | "not_expedition";
  /** "(map unavailable: …)" when the replay refused; dirs are empty then. */
  mapError: string | null;
  goal: string;
  dirs: ExpeditionViewDir[];
  /** At most TIMELINE_LIMIT last map events (expedition_created first). */
  timeline: ExpeditionViewTimelineItem[];
  timelineTotal: number;
  /** Last campaign_added id in the journal (chain pin), null when none. */
  campaignId: string | null;
  campaignState: "none" | "unavailable" | "ok";
  campaignPhase: string | null;
  questions: ExpeditionViewQuestion[];
  evidence: string[];
  counters: ExpeditionViewCounters;
}

export const TIMELINE_LIMIT = 200;
/** Stub hint; the precise per-state action logic lives in the index.ts wiring. */
const NEXT_HINT = "expedition_map(subaction=activate, dir=<name>, why=<rationale>)";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const QUESTION_GLYPHS: Record<string, string> = { confirmed: "✓", rejected: "✗", inconclusive: "❓", waiting_for_data: "⏳" };
/** Verdict → glyph: "" for no verdict, ✓✗❓⏳ for the default set, "*" for any
 *  other (custom brief verdict or corrupted close line). */
export function verdictGlyph(verdict: string | null): string {
  if (verdict === null) return "";
  return (DEFAULT_VERDICTS as readonly string[]).includes(verdict) ? (QUESTION_GLYPHS[verdict] ?? "*") : "*";
}
const DIR_GLYPHS: Record<expedition.DirectionStatus, string> = { resolved: "✅", active: "🔄", parked: "💤", open: "○", advisory_exhausted: "❓", rejected: "❌" };

/** Code-point-safe single-line sanitization: CR/LF (and surrounding spaces)
 *  collapse to one space so a row stays one visual line (module-private in
 *  expedition.ts, so a local copy). */
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ");
/** Code-point-safe truncation (Array.from walks code points, not UTF-16 units). */
const truncate = (s: string, max: number): string => { const cps = Array.from(s); return cps.length <= max ? s : cps.slice(0, max - 1).join("") + "…"; };
const hhmm = (at: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? at.slice(11, 16) : "--:--");

function emptyView(fail: "journal" | "not_expedition"): ExpeditionView {
  return { fail, mapError: null, goal: "", dirs: [], timeline: [], timelineTotal: 0, campaignId: null, campaignState: "none", campaignPhase: null, questions: [], evidence: [], counters: { done: 0, total: 0, campaignsUsed: 0, campaignsMax: null, qClosed: 0, qTotal: 0, next: NEXT_HINT } };
}

/** Parses journal lines fail-soft: broken lines are skipped (same stance as
 *  scanActiveExpeditionChains); a journal where nothing parses is damage. */
function readJournalEntries(chainDir: string): { entries: ChainEntry[] } | "damaged" {
  let text: string;
  try { text = readFileSync(join(chainDir, "chain.json"), "utf8"); } catch { return "damaged"; }
  const entries: ChainEntry[] = [];
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    total++;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) entries.push(parsed as ChainEntry);
      else total--; // valid JSON but not an entry object: not usable, not damage
    } catch { /* broken line: skipped; damage only when nothing parses */ }
  }
  if (entries.length === 0 && total > 0) return "damaged";
  return { entries };
}

/** Builds the whole view from files; never throws. Fallback hierarchy per
 *  design D1: journal unreadable/total-garbage → fail "journal"; no
 *  expedition_created → fail "not_expedition"; replay refusal → empty map +
 *  mapError; campaignDir null → campaignState "none"; unreadable state.json →
 *  "unavailable" (questions/evidence empty); brief broken → texts fall back to
 *  ids (from the log); log broken → verdicts empty (questions remain from the
 *  brief); evidence readdir failure → []. */
export function buildExpeditionView(chainDir: string, campaignDir: string | null): ExpeditionView {
  const journal = readJournalEntries(chainDir);
  if (journal === "damaged") return emptyView("journal");
  const entries = journal.entries;
  const created = entries.find((e) => e.type === "expedition_created");
  if (!created) return emptyView("not_expedition");

  const replay = expedition.replayExpeditionMap(entries);
  const dirs: ExpeditionViewDir[] = replay.ok
    ? [...replay.map.directions.values()].map((d) => ({ name: d.dir, status: d.status, why: d.why, refs: d.refs ?? [], campaign: d.campaign ?? null }))
    : [];
  const mapError = replay.ok ? null : `(map unavailable: ${oneLine(replay.message)})`;

  // Restart marker (optional for the view): lenient read — goal fallback and
  // campaignsMax; strict marker validation is restore's job, not presentation.
  let markerGoal = "";
  let campaignsMax: number | null = null;
  try {
    const marker: any = JSON.parse(readFileSync(join(chainDir, "expedition.json"), "utf8"));
    if (typeof marker?.goal === "string") markerGoal = marker.goal;
    if (typeof marker?.charter?.max_campaigns === "number") campaignsMax = marker.charter.max_campaigns;
  } catch { /* marker absent or unreadable: view still works from the journal */ }

  const campaignIds: string[] = [];
  for (const e of entries) if (e.type === "campaign_added" && typeof e.campaign_id === "string" && !campaignIds.includes(e.campaign_id)) campaignIds.push(e.campaign_id);
  const campaignId = campaignIds.length > 0 ? campaignIds[campaignIds.length - 1] : null;

  let campaignState: ExpeditionView["campaignState"] = "none";
  let campaignPhase: string | null = null;
  let questions: ExpeditionViewQuestion[] = [];
  let evidence: string[] = [];
  if (campaignDir !== null) {
    try {
      const state: any = JSON.parse(readFileSync(join(campaignDir, "state.json"), "utf8"));
      campaignPhase = typeof state?.phase === "string" ? state.phase : null;
      campaignState = "ok";
    } catch { campaignState = "unavailable"; }
    if (campaignState === "ok") {
      // Brief order and texts; broken brief → ids from the log (text = id).
      const texts = new Map<string, string>();
      try {
        const brief: any = JSON.parse(readFileSync(join(campaignDir, "brief.json"), "utf8"));
        for (const q of Array.isArray(brief?.questions) ? brief.questions : []) {
          if (typeof q?.id === "string") texts.set(q.id, typeof q.text === "string" && q.text.length > 0 ? q.text : q.id);
        }
      } catch { /* broken brief: texts fall back to ids seen in the log */ }
      // Log replay: last event per question wins (open → closed with verdict).
      const status = new Map<string, { closed: boolean; verdict: string | null; ruleId: string | null; reason: string | null; hasEvidence: boolean }>();
      try {
        const log = readFileSync(join(campaignDir, "log.jsonl"), "utf8");
        for (const line of log.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          const id = typeof ev?.question_id === "string" ? ev.question_id : typeof ev?.questionId === "string" ? ev.questionId : null;
          if (id === null) continue;
          const action = typeof ev?.event === "string" ? ev.event : typeof ev?.type === "string" ? ev.type : "";
          const cur = status.get(id) ?? { closed: false, verdict: null, ruleId: null, reason: null, hasEvidence: false };
          if (action === "record") cur.hasEvidence = true;
          else if (action === "open" || action === "question_opened") status.set(id, { ...cur, closed: false, verdict: null, ruleId: null, reason: null });
          else if (action === "close" || action === "question_closed") status.set(id, { ...cur, closed: true, verdict: typeof ev.verdict === "string" ? ev.verdict : null, ruleId: optStr(ev.rule_id) ?? optStr(ev.ruleId), reason: optStr(ev.reason) });
          else status.set(id, cur);
        }
      } catch { /* unreadable log: verdicts stay empty, questions survive */ }
      const ids = texts.size > 0 ? [...texts.keys()] : [...status.keys()]; // brief order, else log discovery order
      questions = ids.map((id) => {
        const st = status.get(id);
        return { id, text: texts.get(id) ?? id, closed: st?.closed ?? false, verdict: st?.verdict ?? null, ruleId: st?.ruleId ?? null, reason: st?.reason ?? null, hasEvidence: st?.hasEvidence ?? false };
      });
      try {
        evidence = readdirSync(join(campaignDir, "evidence"), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
      } catch { evidence = []; }
    }
  }

  const goal = replay.ok && replay.map.goal.length > 0 ? replay.map.goal : markerGoal || str(created.goal);
  // The expedition_created root is pinned first and always visible; the window
  // then keeps the LAST map events (design D2: «не более 200 последних»).
  const mapTimeline = replay.ok ? replay.map.timeline.map((t) => ({ type: t.type, dir: t.dir ?? null, to: t.to ?? null, at: t.at, note: t.note ?? null })) : [];
  const rootRow: ExpeditionViewTimelineItem = { type: "expedition_created", dir: null, to: null, at: str(created.at), note: str(created.goal) || null };
  const kept = mapTimeline.length > TIMELINE_LIMIT - 1 ? mapTimeline.slice(-(TIMELINE_LIMIT - 1)) : mapTimeline;
  const timelineRaw: ExpeditionViewTimelineItem[] = [rootRow, ...kept];
  const done = dirs.filter((d) => d.status === "resolved" || d.status === "rejected").length;
  const qClosed = questions.filter((q) => q.closed).length;
  return {
    fail: null,
    mapError,
    goal,
    dirs,
    timeline: timelineRaw,
    timelineTotal: mapTimeline.length + 1,
    campaignId,
    campaignState,
    campaignPhase,
    questions,
    evidence,
    counters: { done, total: dirs.length, campaignsUsed: campaignIds.length, campaignsMax, qClosed, qTotal: questions.length, next: NEXT_HINT },
  };
}

/** Fullscreen overlay content: MAP / CAMPAIGN / EVIDENCE / TIMELINE sections
 *  plus the counters footer (design D2 order). Every row is sanitized to one
 *  line and clipped to `width` code points; fail views render a single
 *  message. Read-only: nothing is written. */
export function toFullscreenLines(view: ExpeditionView, width: number): string[] {
  if (view.fail === "journal") return ["(expedition: journal damaged)"];
  if (view.fail === "not_expedition") return ["(expedition: not an expedition)"];
  const clip = (s: string): string => { const cps = Array.from(s); return cps.length <= width ? s : cps.slice(0, width).join(""); };
  const lines: string[] = [];
  const push = (s: string): void => { lines.push(clip(oneLine(s))); };
  push(view.goal.length > 0 ? `🧭 Expedition — ${truncate(view.goal, 60)}` : "🧭 Expedition");
  lines.push("");
  push("MAP");
  if (view.mapError !== null) push(view.mapError);
  if (view.dirs.length === 0 && view.mapError === null) push("(no directions)");
  const openIds = view.questions.filter((q) => !q.closed).map((q) => q.id);
  for (const d of view.dirs) {
    let row = `${DIR_GLYPHS[d.status]} ${d.name}`;
    if (d.status === "active") {
      row += ` — campaign ${d.campaign ?? view.campaignId ?? "?"}${openIds.length > 0 ? " · " + openIds.join(", ") + " open" : ""}`;
    } else {
      row += ` — ${d.why}`;
    }
    if (d.refs.length > 0) row += ` ← ${d.refs.map((r) => `${r.campaign}/${r.question}`).join(", ")}`;
    if (d.status === "advisory_exhausted") row += " (самоотчёт, не доказательство)";
    push(row);
  }
  lines.push("");
  push(`CAMPAIGN ${view.campaignId ?? "—"}${view.campaignPhase !== null ? ` (${view.campaignPhase})` : ""}`);
  if (view.campaignState === "none") { push("нет активной кампании"); push(`next: ${view.counters.next}`); }
  else if (view.campaignState === "unavailable") push("(campaign data unavailable)");
  else if (view.questions.length === 0) push("(no questions)");
  else for (const q of view.questions) {
    const mark = q.closed ? (verdictGlyph(q.verdict) || "·") + " " + (q.verdict ?? "closed") : "· open";
    push(`${q.id} ${mark}${q.ruleId !== null ? " " + q.ruleId : ""}${q.reason !== null ? " — " + q.reason : ""}${q.hasEvidence ? " [E]" : ""}`);
  }
  lines.push("");
  push("EVIDENCE");
  push(view.evidence.length > 0 ? view.evidence.join(" · ") : "(none)");
  lines.push("");
  push("TIMELINE");
  view.timeline.forEach((t, i) => {
    push(`${i + 1}  ${hhmm(t.at)}  ${t.type}${t.dir !== null ? ` ${t.dir}` : ""}${t.to !== null ? ` → ${t.to}` : ""}${t.note !== null ? ` — ${t.note}` : ""}`);
  });
  const hidden = view.timelineTotal - view.timeline.length;
  if (hidden > 0) push(`… ${hidden} more`);
  lines.push("");
  const bar = "█".repeat(Math.min(view.counters.done, 10)) + "░".repeat(Math.min(view.counters.total, 10) - Math.min(view.counters.done, 10));
  push(`territory ${bar} done/${view.counters.total} │ campaigns ${view.counters.campaignsUsed}${view.counters.campaignsMax !== null ? "/" + view.counters.campaignsMax : ""} │ Q ${view.counters.qClosed}/${view.counters.qTotal} │ next: ${view.counters.next}`);
  return lines;
}

/** Widget footer verdicts line in brief question order: `Q: ✓T1 ✗T2` — null
 *  when no question is closed. Complements the existing Q closed/total
 *  counter (never replaces it). */
export function toWidgetVerdicts(view: ExpeditionView): string | null {
  const closed = view.questions.filter((q) => q.closed);
  if (closed.length === 0) return null;
  return "Q: " + closed.map((q) => verdictGlyph(q.verdict) + q.id).join(" ");
}
