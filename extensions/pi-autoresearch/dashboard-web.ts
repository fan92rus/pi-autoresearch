/** Expedition web dashboard page (expedition-tui spec, group 4 / D4).
 *
 *  The K2-compact kanban mockup (owner-approved) ported onto the live
 *  ExpeditionView + campaigns contract: six DirectionStatus columns, campaign
 *  strip, inline question accordions, hover tooltips, journal history, next
 *  hint with copy, honest damage/stop banners, WIP invariant.
 *
 *  The page is data-agnostic: buildExpeditionHtml never interpolates view or
 *  campaign content into the static HTML (that would bake a snapshot into the
 *  served file and break the live-update contract). The page fetches
 *  GET /expedition on load, re-fetches on the existing SSE signal
 *  «jsonl-updated» (EventSource /events) and on a 10s polling timer, then
 *  renders everything from the JSON payload. Every payload string passes
 *  through esc() before touching innerHTML. */
import { type ExpeditionView } from "./expedition-view.ts";

/** One chain campaign in the /expedition payload (the `campaigns` array from
 *  the wiring contract; fail-soft per campaign: a broken directory yields
 *  phase null, empty questions, zero evidence). */
export interface ExpeditionWebCampaign {
  id: string;
  phase: string | null;
  q: Array<{ id: string; text: string; verdict: string | null }>;
  evidenceCount: number;
}

/** Builds the standalone expedition dashboard page. Deterministic: the same
 *  call always returns a bit-identical string (no timestamps, no random ids);
 *  view/campaigns are accepted for signature stability of the wiring caller
 *  but the page itself reads fresh data from GET /expedition at runtime. */
export function buildExpeditionHtml(_view: ExpeditionView, _campaigns: ExpeditionWebCampaign[]): string {
  return HTML;
}

const HTML: string = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Экспедиция — канбан</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--text:#c9d1d9;--muted:#8b949e;--line:#30363d;
  --good:#3fb950;--bad:#f85149;--accent:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);
  font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  display:flex;flex-direction:column;height:100vh;overflow:hidden}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* ---------- header ---------- */
header{padding:10px 16px 8px;border-bottom:1px solid var(--line);flex:none}
.hrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{margin:0;font-size:15px;color:#fff;font-weight:650}
.chip{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;
  color:var(--muted);white-space:nowrap}
#chainChip{border-color:#3d3320;color:#d2a54a}
#chainChip.live{border-color:#1e4620;color:#7dc47f}
#histBtn{margin-left:auto;all:unset;cursor:pointer;font-size:11px;color:var(--accent);
  border:1px solid #1f4a6e;border-radius:7px;padding:2px 10px;white-space:nowrap}
#histBtn:hover{background:#12233a}
#histBtn:focus-visible{outline:2px solid var(--accent)}
#goal{margin:6px 0 0;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.counters{display:flex;gap:8px;margin-top:7px;flex-wrap:wrap}
.counter{display:inline-flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--line);
  border-radius:7px;padding:3px 9px;font-size:11px;color:var(--muted)}
.counter b{color:var(--text);font-size:12px}
.mbar{width:60px;height:4px;border-radius:2px;background:#21262d;overflow:hidden}
.mbar i{display:block;height:100%;background:var(--accent)}
.mbar.q i{background:var(--good)}

/* ---------- campaign strip ---------- */
.strip{display:flex;gap:6px;margin-top:8px;overflow-x:auto;padding-bottom:2px}
.strip::-webkit-scrollbar{height:5px}.strip::-webkit-scrollbar-thumb{background:#2b3240;border-radius:3px}
.cchip{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
  border-radius:7px;padding:2px 8px;font-size:10px;color:var(--muted);white-space:nowrap;background:var(--panel)}
.cchip:hover{border-color:var(--accent);color:var(--text)}
.cchip:focus-visible{outline:2px solid var(--accent)}
.cchip.noflash{animation:noflash .8s ease}
@keyframes noflash{0%{border-color:var(--muted);color:var(--text)}100%{}}
.dot{font-size:9px}
.ph-briefing{color:var(--warn)}.ph-research{color:var(--accent)}.ph-stopped{color:var(--muted)}
.ccid{color:var(--accent);font-family:ui-monospace,Menlo,monospace}
.v-confirmed{color:var(--good)}.v-rejected{color:var(--bad)}
.v-inconclusive{color:var(--warn)}.v-waiting_for_data{color:var(--accent)}.v-open{color:#484f58}
.cev{color:#6e7681}

/* ---------- kanban ---------- */
main{flex:1;min-height:0;padding:8px 16px;overflow:auto}
.kanban{height:100%;display:grid;grid-template-columns:
  minmax(150px,1.5fr) minmax(200px,2fr) minmax(150px,1.5fr) minmax(96px,.6fr) minmax(96px,.6fr) minmax(140px,1.2fr);
  gap:8px}
.kcol{background:#10151d;border:1px solid var(--line);border-radius:10px;display:flex;
  flex-direction:column;min-height:0;overflow:hidden}
/* empty non-active columns: narrow column (~96px) with the title on top */
.kcol-empty{min-width:96px;flex-direction:column}
.kcol-empty .kcards{display:none}
.kcol-empty h2{justify-content:center;gap:6px}
.kcol-empty .n{background:#21262d}
.kcol-empty::after{content:"—";color:#484f58;font-size:11px;text-align:center;padding:8px 0}
.kcol h2{margin:0;padding:7px 10px 5px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--muted);font-weight:600;display:flex;justify-content:space-between;align-items:center;
  gap:6px;border-bottom:1px solid #1c232d}
.kcol h2 .n{font-size:10px;color:var(--text);background:#21262d;border-radius:999px;padding:0 7px;font-weight:400}
.kcol.h-active h2{color:var(--accent)}
.kcol.h-resolved h2{color:var(--good)}
.kcol.h-rejected h2{color:var(--bad)}
.kcol.h-advisory_exhausted h2{color:var(--warn)}
.n.wip-ok{background:#153024;color:var(--good)}
.n.wip-bad{background:#332023;color:var(--bad)}
.kcards{flex:1;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.kcards::-webkit-scrollbar{width:6px}.kcards::-webkit-scrollbar-thumb{background:#2b3240;border-radius:3px}
.empty{color:#484f58;font-size:11px;text-align:center;padding:8px 0}

.card{background:#141a22;border:1px solid #262d36;border-radius:8px;padding:7px 9px;cursor:pointer}
.card:hover{border-color:#3d4654}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.card.sel-active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.card.flash{animation:flash 1.1s ease}
@keyframes flash{0%{border-color:var(--accent);background:#12233a}100%{background:#141a22}}
.cname{font-size:12px;font-weight:600;color:#fff;line-height:1.25;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cname .g{margin-right:4px}
.meta{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:10px;color:var(--muted);
  white-space:nowrap;overflow:hidden}
.meta .ph{white-space:nowrap}
.nocamp-tag{opacity:.65;font-style:italic}
.qmini{margin-left:auto;display:flex;align-items:center;gap:4px}
.qmini .mbar{width:34px}
.qn{font-family:ui-monospace,Menlo,monospace;color:var(--muted)}
.inline{border-top:1px dashed #2a3138;margin-top:6px;padding-top:6px}
.iwhy{font-size:11px;color:var(--muted);margin:2px 0}
.inline .tnote{color:var(--warn)}
.nocamp{font-size:10px;color:#484f58;margin-top:4px}
.q{padding:3px 0;font-size:11px;display:flex;gap:6px;align-items:baseline}
.q + .q{border-top:1px solid #1c232d}
.q .qid{color:var(--accent);font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.q .qg{white-space:nowrap}
.q .qt{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdetail{font-size:10px;color:var(--muted);padding:2px 0 3px 40px;white-space:normal}

/* ---------- damage / campaign banners ---------- */
.banner{margin:14px 16px 0;background:#20161a;border:1px solid #6e2a31;border-radius:10px;
  padding:12px 16px;font-size:13px;color:#f0a8a3;flex:none}
.banner.warn{background:#211c10;border-color:#6e5427;color:#e3b341}
.banner .sub{margin-top:4px;font-size:11px;color:var(--muted)}

/* ---------- history ---------- */
#history{flex:none;max-height:34vh;overflow:auto;border-top:1px solid var(--line);
  background:#0f141b;padding:8px 16px 10px}
#history h2{margin:0 0 6px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
#histList{list-style:none;margin:0;padding:0;columns:3;column-gap:18px;font-size:11px}
#histList li{break-inside:avoid;padding:2px 0;border-bottom:1px dotted #1a2028;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#histList .ht{color:#6e7681;font-family:ui-monospace,Menlo,monospace;font-size:10px;margin-right:6px}
#histList .hl{font-weight:600}
#histList li.dir-event .hl{color:var(--accent)}
#histList li.campaign-event .hl{color:var(--warn)}
#histList li.stop-event .hl{color:var(--bad)}
#histList li.status-event .hl{color:var(--muted)}
#histList .hs{color:var(--muted);margin-left:6px}

/* ---------- footer ---------- */
footer{flex:none;padding:6px 16px;border-top:1px solid var(--line);display:flex;gap:10px;
  align-items:center;background:var(--panel)}
.nexthint{flex:1;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--warn);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nexthint b{color:var(--muted);font-weight:400}
#copyBtn{all:unset;cursor:pointer;font-size:11px;color:var(--accent);border:1px solid #1f4a6e;
  border-radius:6px;padding:1px 8px;white-space:nowrap}
#copyBtn:hover{background:#12233a}
#copyBtn:focus-visible{outline:2px solid var(--accent)}

/* ---------- tooltip ---------- */
.tip{position:fixed;z-index:50;max-width:320px;background:#05080c;border:1px solid #526273;
  border-radius:8px;padding:9px 11px;font-size:11px;color:var(--text);pointer-events:none;
  box-shadow:0 8px 24px #0009}
.tip .tname{font-weight:600;color:#fff;font-size:12px}
.tip .twhy{margin-top:5px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;
  -webkit-box-orient:vertical;overflow:hidden}
.tip .tnote{margin-top:4px;color:var(--warn)}
.tip .tcamp{margin-top:6px;padding-top:5px;border-top:1px solid #1c2633;color:var(--muted)}

@media (max-width:1100px){
  body{overflow:auto;height:auto}
  main{min-height:420px}
  .kanban{grid-template-columns:repeat(3,minmax(0,1fr));height:auto}
  .kcol-empty::after{display:none}
  .kcol-empty .kcards{display:block}
  .kcol-empty .kcards .empty{display:block}
  #histList{columns:2}
}
@media (max-width:640px){.kanban{grid-template-columns:repeat(2,minmax(0,1fr))}#histList{columns:1}}
</style>
</head>
<body>
<header>
  <div class="hrow">
    <h1>🧭 Экспедиция</h1>
    <span class="chip" id="chainChip" hidden></span>
    <button id="histBtn" aria-expanded="false" aria-controls="history" hidden></button>
  </div>
  <p id="goal" title=""></p>
  <div class="counters" id="counters"></div>
  <div class="strip" id="strip" aria-label="Кампании — прогресс экспедиции"></div>
</header>

<main>
  <div class="kanban" id="kanban" aria-label="Направления по статусам"></div>
</main>

<section id="history" hidden>
  <h2>История журнала</h2>
  <ol id="histList"></ol>
</section>

<footer>
  <div class="nexthint" id="nextHint"><b>next:</b> …</div>
  <button id="copyBtn" title="Скопировать команду" hidden>⧉ копировать</button>
</footer>

<div class="tip" id="tip" hidden aria-hidden="true"></div>

<script>
"use strict";
const $ = (id) => document.getElementById(id);

/* ---------- constants ---------- */
const DIRS_ORDER = ["open","active","resolved","rejected","advisory_exhausted","parked"];
const DIR_LABEL = {open:"Открыты",active:"Активно",resolved:"Подтверждены",rejected:"Отклонены",
  advisory_exhausted:"Advisory",parked:"Отложены"};
const DIR_GLYPH = {open:"○",active:"🔄",resolved:"✅",rejected:"❌",advisory_exhausted:"❓",parked:"💤"};
const DONE_STATUSES = ["resolved","rejected","advisory_exhausted"];
const PH_GLYPH = {briefing:"○",research:"●",stopped:"■"};
const V_GLYPH = {confirmed:"✓",rejected:"✗",inconclusive:"❓",waiting_for_data:"⏳"};
const Q_CLOSED = (v) => !!v && v !== "waiting_for_data";
const TL_LABEL = {
  chain_created:"Цепочка создана", expedition_created:"Экспедиция создана",
  direction_opened:"Направление открыто", direction_activated:"Активировано",
  direction_resolved:"Подтверждено", direction_rejected:"Отклонено",
  direction_parked:"Отложено", direction_reopened:"Возобновлено",
  direction_advisory:"Advisory исчерпан", direction_advisory_exhausted:"Advisory исчерпан",
  pivot:"Pivot", campaign_added:"Кампания добавлена",
  brief_approved:"Бриф утверждён", brief_rejected:"Бриф отклонён",
  status_change:"Статус цепочки", expedition_stop:"Экспедиция остановлена"
};
const POLL_MS = 10000;

/* ---------- state ---------- */
let view = null;       // /expedition payload (ExpeditionView-shaped)
let campaigns = [];    // payload.campaigns
let lastHint = "";
let lastFetchFailed = false;

/* ---------- helpers ---------- */
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function pct(a,b){return b?Math.round(100*a/b):0;}
function fmtTime(iso){return (iso||"").slice(11,16);}
function fmtDay(iso){return (iso||"").slice(5,10);}
function shortCamp(id){if(!id)return"";const m=/-c(\\d+)$/.exec(id);return m?"…c"+m[1]:"c0";}
function typeClass(t){
  if(String(t).indexOf("direction_")===0)return"dir-event";
  if(["campaign_added","brief_approved","brief_rejected"].indexOf(t)>=0)return"campaign-event";
  if(t==="expedition_stop")return"stop-event";
  if(t==="status_change")return"status-event";
  return"";
}
function humanAgo(iso){
  if(!iso)return"";
  const mins=Math.max(0,Math.round((Date.now()-Date.parse(iso))/60000));
  if(isNaN(mins)||mins<0)return"";
  return mins<1?"только что":mins<60?mins+" мин назад":
    mins<1440?Math.round(mins/60)+" ч назад":Math.round(mins/1440)+" дн назад";
}

/* ---------- render ---------- */
function campChip(c){
  const glyphs=(c.q||[]).map(q=>q.verdict
    ? '<span class="v-'+esc(q.verdict)+'">'+(V_GLYPH[q.verdict]||"*")+'</span>'
    : '<span class="v-open">·</span>').join("");
  const ev=c.evidenceCount||0;
  return '<button class="cchip" data-camp="'+esc(c.id)+'" title="'+esc(c.id)+' · '+(c.q||[]).length+' вопр. · evidence: '+ev+'">'+
    '<span class="dot ph-'+esc(c.phase||"stopped")+'">'+(PH_GLYPH[c.phase]||"■")+'</span>'+
    '<span class="ccid">'+esc(shortCamp(c.id))+'</span>'+
    '<span class="cvg">'+glyphs+'</span>'+
    (ev?'<span class="cev">📁'+ev+'</span>':'')+'</button>';
}

function cardHTML(d){
  const camp=campaigns.find(c=>c.id===d.campaign);
  const q=camp?(camp.q||[]):[];
  const closed=q.filter(x=>Q_CLOSED(x.verdict)).length;
  let metaBits="";
  if(camp) metaBits+='<span class="ccid">'+esc(shortCamp(camp.id))+'</span>'+
    '<span class="ph ph-'+esc(camp.phase||"stopped")+'">'+(PH_GLYPH[camp.phase]||"■")+' '+esc(camp.phase||"—")+'</span>';
  let qmini="";
  const vrow=q.length?'<span class="cvg" title="вердикты кампании">'+q.map(x=>x.verdict?(V_GLYPH[x.verdict]||"*"):"·").join("")+'</span>':"";
  if(q.length) qmini=vrow+'<span class="qmini"><span class="mbar q"><i style="width:'+pct(closed,q.length)+'%"></i></span><span class="qn">'+closed+'/'+q.length+'</span></span>';
  else if(!camp) qmini='<span class="nocamp-tag">ждёт активации</span>';
  const rows=q.map(x=>{
    const det=(x.verdict||x.text)?'<div class="qdetail"></div>':"";
    return '<div class="q"><span class="qid">'+esc(x.id)+'</span><span class="qg">'+
      (x.verdict?'<span class="v-'+esc(x.verdict)+'">'+(V_GLYPH[x.verdict]||"*")+'</span>':'<span class="v-open">·</span>')+
      '</span><span class="qt" title="'+esc(x.text||"")+'">'+esc(x.text||"—")+'</span></div>'+det;
  }).join("");
  const inline='<div class="inline" hidden>'+
    (d.why?'<div class="iwhy">'+esc(d.why)+'</div>':'')+
    (d.refs&&d.refs.length?'<div class="iwhy">refs: '+esc(d.refs.map(r=>r.campaign+"/"+r.question).join(", "))+'</div>':'')+
    (camp?rows:'<div class="nocamp">нет привязанной кампании</div>')+
  '</div>';
  return '<article class="card'+(d.status==="active"?' sel-active':'')+'" role="button" tabindex="0" '+
    'aria-expanded="false" data-name="'+esc(d.name)+'"'+(d.campaign?' data-camp="'+esc(d.campaign)+'"':'')+'>'+
    '<div class="cname"><span class="g">'+(DIR_GLYPH[d.status]||"○")+'</span>'+esc(d.name)+'</div>'+
    '<div class="meta">'+metaBits+qmini+'</div>'+inline+'</article>';
}

function renderHistory(v){
  $("histList").innerHTML=(v.timeline||[]).map(e=>{
    const sub=e.dir||e.to||(e.note?String(e.note).slice(0,30):"");
    return '<li class="'+typeClass(e.type)+'"><span class="ht">'+esc(fmtDay(e.at))+' '+esc(fmtTime(e.at))+'</span>'+
      '<span class="hl">'+(TL_LABEL[e.type]||esc(e.type))+'</span>'+
      (sub?' <span class="hs">'+esc(sub)+'</span>':'')+'</li>';
  }).join("")+'<li class="status-event"><span class="ht"></span><span class="hl">всего '+esc(v.timelineTotal||0)+' событий</span></li>';
}

function damageBanner(v){
  if(v.fail==="journal") return '<div class="banner">⚠ Журнал экспедиции повреждён — карта недоступна<div class="sub">chain.json не читается; экспедиция продолжает работу, отображение восстановится при починке файла</div></div>';
  if(v.fail==="not_expedition") return '<div class="banner">⚠ Это не экспедиционная цепочка<div class="sub">journal без expedition_created — веб-дашборд экспедиции неприменим</div></div>';
  return null;
}

function campaignBanner(v){
  if(v.campaignState==="none") return '<div class="banner warn">Нет активной кампании<div class="sub">next: '+esc(v.counters&&v.counters.next||"")+'</div></div>';
  if(v.campaignState==="unavailable") return '<div class="banner warn">Данные кампании недоступны<div class="sub">каталог кампании существует, но state.json не читается</div></div>';
  return null;
}

function render(){
  const v=view;
  if(!v)return;
  hideTip();

  const banner=damageBanner(v);
  if(banner!==null){
    document.querySelector("main").innerHTML=banner+(v.mapError?'<div class="banner warn">'+esc(v.mapError)+'</div>':"");
    $("strip").innerHTML="";$("counters").innerHTML="";
    $("goal").textContent="";
    $("histBtn").hidden=true;$("copyBtn").hidden=true;
    $("nextHint").innerHTML="";
    $("history").hidden=true;
    return;
  }

  // goal + damage-free header
  const g=$("goal");g.textContent=v.goal||"(цель не указана)";g.title=v.goal||"";
  // honest chain-status badge: stopped/completed expeditions are first-class
  // viewers now (payload.chainStatus; owner request 2026-11-12)
  const chip=$("chainChip");
  const cs=v.chainStatus||null;
  if(cs){
    const live=cs==="active"||cs==="awaiting_child";
    chip.textContent=live?"цепочка: "+cs:"цепочка остановлена: "+cs;
    chip.hidden=false;
    chip.classList.toggle("live",live);
  }else{
    chip.hidden=true;
  }

  // counters: last event age + done/total + campaigns + questions (from the view counters)
  let lastTxt="";
  const lastEv=(v.timeline&&v.timeline.length)?v.timeline[v.timeline.length-1]:null;
  if(lastEv&&lastEv.at){
    const ago=humanAgo(lastEv.at);
    if(ago)lastTxt='<span class="counter">последнее событие <b title="'+esc(lastEv.at)+'">'+esc(ago)+'</b></span>';
  }
  const c=v.counters||{done:0,total:0,campaignsUsed:0,campaignsMax:null,qClosed:0,qTotal:0,next:""};
  const cmax=c.campaignsMax!==null&&c.campaignsMax!==undefined?c.campaignsMax:c.campaignsUsed;
  const mbar=(x,m,q)=>'<span class="mbar'+(q?' q':'')+'"><i style="width:'+pct(x,m)+'%"></i></span>';
  $("counters").innerHTML=lastTxt+
    '<span class="counter">Направления <b>'+c.done+'/'+c.total+'</b>'+mbar(c.done,c.total)+'</span>'+
    '<span class="counter">Кампании <b>'+c.campaignsUsed+'/'+cmax+'</b>'+mbar(c.campaignsUsed,cmax)+'</span>'+
    '<span class="counter">Вопросы <b>'+c.qClosed+'/'+c.qTotal+'</b>'+mbar(c.qClosed,c.qTotal,true)+'</span>';

  $("strip").innerHTML=campaigns.map(campChip).join("")||'<span class="empty">нет кампаний</span>';

  const cb=campaignBanner(v);
  if(cb!==null){
    document.querySelector("main").innerHTML=cb+'<div class="kanban" id="kanban" aria-label="Направления по статусам"></div>';
  } else {
    const kan=$("kanban");
    if(!kan)document.querySelector("main").innerHTML='<div class="kanban" id="kanban" aria-label="Направления по статусам"></div>';
  }

  const by={};DIRS_ORDER.forEach(s=>by[s]=[]);
  for(const d of(v.dirs||[]))(by[d.status]||by.open).push(d);
  const stopped=(v.timeline||[]).some(e=>e.type==="expedition_stop");
  const activeCount=by.active.length;
  $("kanban").innerHTML=DIRS_ORDER.map(s=>{
    let nCls="n",nTitle="";
    if(s==="active"){
      if(activeCount===1){nCls="n wip-ok";nTitle="WIP-инвариант: ровно одно активное направление — ок";}
      else{nCls="n wip-bad";nTitle="WIP-инвариант: активных направлений "+activeCount;}
    }
    const collapse=!by[s].length&&s!=="active";
    return '<div class="kcol h-'+s+(collapse?' kcol-empty':'')+'"><h2>'+DIR_LABEL[s]+' <span class="'+nCls+'"'+(nTitle?' title="'+esc(nTitle)+'"':'')+'>'+by[s].length+'</span></h2>'+
      '<div class="kcards">'+(by[s].length?by[s].map(cardHTML).join(""):'<div class="empty">—</div>')+'</div></div>';
  }).join("")+
  (v.mapError?'<div style="grid-column:1/-1" class="banner warn">'+esc(v.mapError)+'</div>':"");

  // history: keep open/closed state across re-renders (spec: survives refresh)
  const histOpen=!$("history").hidden;
  $("histBtn").hidden=false;
  $("histBtn").setAttribute("aria-expanded",String(histOpen));
  $("histBtn").textContent=(histOpen?"Свернуть историю":"История")+" ("+(v.timelineTotal||0)+")";
  renderHistory(v);

  lastHint=(c&&c.next)||"";
  $("nextHint").innerHTML='<b>next:</b> '+esc(lastHint);
  $("nextHint").title=lastHint;
  $("copyBtn").hidden=false;
}

/* ---------- data loading ---------- */
async function load(){
  try{
    const res=await fetch("/expedition",{cache:"no-store"});
    if(!res.ok)throw new Error("http "+res.status);
    const payload=await res.json();
    view=payload&&payload.fail!==undefined?payload:null;
    campaigns=(payload&&Array.isArray(payload.campaigns))?payload.campaigns:[];
    lastFetchFailed=false;
    render();
  }catch(err){
    lastFetchFailed=true;
    $("nextHint").innerHTML='<b>next:</b> (нет связи с сервером — повтор через '+(POLL_MS/1000)+'с)';
  }
}

/* ---------- tooltip ---------- */
const tip=$("tip");
function showTipFor(card){
  if(card.getAttribute("aria-expanded")==="true"){hideTip();return;}
  const name=card.dataset.name;
  const d=(view&&view.dirs||[]).find(x=>x.name===name);
  if(!d)return;
  const camp=campaigns.find(c=>c.id===d.campaign);
  let html='<div class="tname">'+(DIR_GLYPH[d.status]||"○")+' '+esc(d.name)+'</div>';
  if(d.why)html+='<div class="twhy">'+esc(d.why)+'</div>';
  if(camp){
    const glyphs=(camp.q||[]).map(q=>q.verdict?(V_GLYPH[q.verdict]||"*"):"·").join("");
    html+='<div class="tcamp"><span class="ccid">'+esc(camp.id)+'</span> · '+esc(camp.phase||"—")+
      ' · '+glyphs+(camp.evidenceCount?' · 📁'+camp.evidenceCount:'')+'</div>';
  }
  tip.innerHTML=html;
  tip.hidden=false;
  const r=card.getBoundingClientRect();
  const tw=tip.offsetWidth,th=tip.offsetHeight;
  let left=Math.min(r.left,window.innerWidth-tw-8);
  let top=r.bottom+6;
  if(top+th>window.innerHeight-8)top=Math.max(8,r.top-th-6);
  tip.style.left=Math.max(8,left)+"px";
  tip.style.top=top+"px";
}
function hideTip(){tip.hidden=true;}

/* ---------- wiring (delegated once; containers survive innerHTML swaps) ---------- */
const mainEl=document.querySelector("main");
mainEl.addEventListener("click",e=>{
  const card=e.target.closest(".card");if(!card)return;
  const inline=card.querySelector(".inline");
  if(!inline)return;
  const open=inline.hidden;
  inline.hidden=!open;
  card.setAttribute("aria-expanded",String(open));
  hideTip();
});
mainEl.addEventListener("keydown",e=>{
  const card=e.target.closest(".card");if(!card)return;
  if(e.key==="Enter"||e.key===" "){e.preventDefault();card.click();}
  if(e.key==="Escape"){
    const inline=card.querySelector(".inline");
    if(inline)inline.hidden=true;
    card.setAttribute("aria-expanded","false");
    hideTip();
  }
});
mainEl.addEventListener("mouseover",e=>{const card=e.target.closest(".card");if(card)showTipFor(card);});
mainEl.addEventListener("mouseleave",hideTip);
mainEl.addEventListener("focusin",e=>{const card=e.target.closest(".card");if(card)showTipFor(card);});
mainEl.addEventListener("focusout",hideTip);
mainEl.addEventListener("mouseout",e=>{
  const card=e.target.closest(".card");
  if(card&&!card.contains(e.relatedTarget))hideTip();
});
mainEl.addEventListener("scroll",hideTip,true);
window.addEventListener("resize",hideTip);
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape")return;
  const open=document.querySelector('.card[aria-expanded="true"]');
  if(open){
    const inline=open.querySelector(".inline");
    if(inline)inline.hidden=true;
    open.setAttribute("aria-expanded","false");
    hideTip();
  }
});

$("strip").addEventListener("click",e=>{
  const b=e.target.closest(".cchip");if(!b)return;
  const id=b.dataset.camp;
  const card=[...document.querySelectorAll(".card")].find(c=>c.dataset.camp===id);
  if(card){
    card.scrollIntoView({block:"nearest"});
    card.classList.remove("flash");void card.offsetWidth;card.classList.add("flash");
  }else{
    b.classList.remove("noflash");void b.offsetWidth;b.classList.add("noflash");
  }
});

$("histBtn").addEventListener("click",()=>{
  const h=$("history");
  const open=h.hidden;
  h.hidden=!open;
  $("histBtn").setAttribute("aria-expanded",String(open));
  $("histBtn").textContent=(open?"Свернуть историю":"История")+" ("+((view&&view.timelineTotal)||0)+")";
});

$("copyBtn").addEventListener("click",async ()=>{
  const b=$("copyBtn");
  let ok=false;
  try{await navigator.clipboard.writeText(lastHint);ok=true;}
  catch(err){
    try{
      const ta=document.createElement("textarea");
      ta.value=lastHint;document.body.appendChild(ta);ta.select();
      document.execCommand("copy");ta.remove();ok=true;
    }catch(e2){ok=false;}
  }
  b.textContent=ok?"✓ скопировано":"✗ не удалось";
  setTimeout(()=>{b.textContent="⧉ копировать";},1200);
});

/* live updates: existing SSE signal + 10s polling (spec group 4; no new broadcast points) */
try{
  const es=new EventSource("/events");
  es.addEventListener("jsonl-updated",()=>{load();});
}catch(err){/* SSE unavailable: polling below still covers refresh */}
setInterval(load,POLL_MS);
load();
</script>
</body>
</html>
`;
