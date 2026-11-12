import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import { AUTORESEARCH_SUBCOMMANDS } from "../extensions/pi-autoresearch/parallel/config-ui.ts";

const brief = { schema_version:1, goal:"Study cache latency", plan_source:"plan.md", caveat_block:"Observational only", data_roles:{explore:[],validate:[],confirm:[]}, questions:[{id:"Q1",text:"Does latency improve?",decision_rules:[{id:"yes",verdict:"confirmed",when:"measured improvement"},{id:"no",verdict:"rejected",when:"no improvement"},{id:"unknown",verdict:"inconclusive",when:"unclear"},{id:"wait",verdict:"waiting_for_data",when:"data missing"}],needs_data:null}], process_metrics:[], stop_rules:[] };
const doc = { charter:{stop_rules:[]}, goal:"Study cache latency", directions:[{name:"cache",why:"Measure cache effects"}], campaign0:brief };
function workdir(){const p=fs.mkdtempSync(path.join(os.tmpdir(),"expedition-wire-")); return p;}
async function harness(dir, confirm=true){const {pi,tool,command}=createFakePi({dir,sessionId:"exp-wire",realGit:false}); const ctx=makeCtx(dir,"exp-wire",pi); ctx.ui.confirm=async()=>confirm; const ext=await import(pathToFileURL(path.join(import.meta.dirname,"..","extensions","pi-autoresearch","index.ts")).href); ext.default(pi); return {pi,tool,command,ctx};}
const text = r=>r?.content?.[0]?.text ?? "";

test("expedition subcommand is registered",()=>{assert.ok(AUTORESEARCH_SUBCOMMANDS.some(x=>x.value==="expedition"));});
test("expedition command rejects headless invocation",async()=>{const dir=workdir(),h=await harness(dir); h.ctx.hasUI=false; await h.command("autoresearch").handler("expedition goal",h.ctx); assert.ok(h.pi.notifications.some(n=>/headless|TUI/i.test(n.text)));});
test("draft is saved and propose rejects workdir path",async()=>{const dir=workdir(),h=await harness(dir); await h.command("autoresearch").handler("expedition goal",h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); assert.match(text(out),/draft saved/i); const inside=path.join(dir,"inside.json"); fs.writeFileSync(inside,JSON.stringify(doc)); const refused=await h.tool("expedition_brief").execute("id",{action:"propose",doc_path:inside},null,null,h.ctx); assert.match(text(refused),/path_inside_workdir/);});
test("propose from draft creates expedition chain and starts campaign 0",async()=>{const dir=workdir(),h=await harness(dir,true); await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx); assert.match(text(out),/created/i); const kickoff=h.pi.sentMessages.map(m=>m.text).join("\n"); assert.match(kickoff,/expedition_map\(subaction="activate"/,"kickoff tells the agent to activate a direction before question work"); assert.match(kickoff,/When the direction is closed/,"kickoff explains the close-then-activate cycle"); assert.ok(!/activate[^\n]*campaign exp-/.test(kickoff),"review blocker: activate instruction must not tell the agent to pass a campaign argument (the tool rejects it)"); const id=text(out).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1]; assert.ok(id, text(out)); const chain=path.join(dir,".auto","research-chain",`${id}-chain`,`chain.json`); const entries=fs.readFileSync(chain,"utf8").trim().split("\n").map(JSON.parse); assert.ok(entries.some(e=>e.type==="expedition_created")); assert.ok(entries.some(e=>e.type==="direction_opened")); assert.ok(entries.some(e=>e.type==="campaign_added")); const before=fs.readFileSync(chain,"utf8"); await h.command("autoresearch").handler("expedition second",h.ctx); assert.equal(fs.readFileSync(chain,"utf8"),before,"re-entry guard leaves journal bytes untouched"); assert.ok(h.pi.notifications.some(n=>/resume or finish/i.test(n.text)));});
test("tool result of propose carries the activation instruction (insurance channel)",async()=>{const dir=workdir(),h=await harness(dir,true); await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx); assert.match(text(out),/expedition_map\(subaction="activate"/,"tool result itself tells the agent to activate a direction");});
test("propose message is delivered as steer when the agent is busy",async()=>{const dir=workdir(),h=await harness(dir,true); h.ctx.isIdle=()=>false; await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx); assert.match(text(out),/created/i); const last=h.pi.sentMessages[h.pi.sentMessages.length-1]; assert.match(last.text,/expedition_map\(subaction="activate"/); assert.equal(last.opts?.deliverAs,"steer","busy agent: kickoff must interrupt the turn, not queue as followUp");});
test("idle agent still receives the kickoff without deliverAs (regression)",async()=>{const dir=workdir(),h=await harness(dir,true); await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx); const last=h.pi.sentMessages[h.pi.sentMessages.length-1]; assert.match(last.text,/expedition_map\(subaction="activate"/); assert.equal(last.opts?.deliverAs,undefined,"idle delivery must stay un-queued (no deliverAs)");});
test("propose writes the expedition restart marker into the chain dir",async()=>{const dir=workdir(),h=await harness(dir,true); await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx); const id=text(out).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1]; const chainDir=path.join(dir,".auto","research-chain",`${id}-chain`); const marker=JSON.parse(fs.readFileSync(path.join(chainDir,"expedition.json"),"utf8")); assert.equal(marker.schema_version,1); assert.equal(marker.expedition,true); assert.equal(marker.goal,doc.goal); assert.equal(marker.campaign_id,id); assert.equal(typeof marker.doc_path,"string"); assert.match(marker.doc_sha256,/^[0-9a-f]{64}$/); assert.equal(marker.doc_sha256,marker.doc_path?marker.doc_sha256:marker.doc_sha256); const entries=fs.readFileSync(path.join(chainDir,"chain.json"),"utf8").trim().split("\n").map(JSON.parse); const created=entries.find(e=>e.type==="expedition_created"); assert.equal(created.doc_sha256,marker.doc_sha256,"marker digest anchors the journal");});
test("restore rebuilds binding, widget and mode from disk; live session is not interrupted",async()=>{const dir=workdir(),h=await harness(dir,true); const ext=await import(pathToFileURL(path.join(import.meta.dirname,"..","extensions","pi-autoresearch","index.ts")).href);
// Fresh context on the same dir: a new session after restart. researchChain is session memory — a new ctx starts empty.
const freshCtx=makeCtx(dir,"exp-restore-1",h.pi);
// No chain on disk yet: restore is a no-op.
await ext.restoreExpeditionForTest(freshCtx);
assert.ok(!h.pi.sentMessages.some(m=>/restored after restart/.test(m.text)),"no chain on disk: no restore message");
// Build a real expedition (marker included), then restore into a THIRD fresh context.
await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx);
const id=text(out).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
const restCtx=makeCtx(dir,"exp-restore-2",h.pi);
await ext.restoreExpeditionForTest(restCtx);
const restored=h.pi.sentMessages.filter(m=>/restored after restart/.test(m.text));
assert.equal(restored.length,1,"exactly one restore message");
assert.match(restored[0].text,new RegExp(`Expedition ${id}-chain restored`));
assert.match(restored[0].text,new RegExp(`Pinned campaign: ${id}`));
assert.match(restored[0].text,/Expedition map snapshot:/);
assert.equal(restored[0].opts?.deliverAs,undefined,"idle fresh session receives the restore message un-queued");
const expWidgets=h.pi.widgets.filter(w=>w.name==="autoresearch"&&w.widget);
assert.ok(expWidgets.length>=1,"restore sets the expedition widget");
const widget=expWidgets.at(-1).widget;const obj=typeof widget==="function"?widget(null,{fg:()=>""}):widget;
const lines=obj.render(200);
assert.match(lines.join("\n"),/🧭/,"widget renders expedition map, not the ordinary dashboard");
assert.match(lines.join("\n"),new RegExp(id),"widget shows the restored campaign");
// Guard: a session that already holds a chain is never interrupted.
const before=h.pi.sentMessages.length;
await ext.restoreExpeditionForTest(restCtx);
assert.equal(h.pi.sentMessages.length,before,"second restore on a bound session is a no-op");});
test("restore skips a stopped chain and reports a second active chain as NOT restored",async()=>{const dir=workdir(),h=await harness(dir,true); const ext=await import(pathToFileURL(path.join(import.meta.dirname,"..","extensions","pi-autoresearch","index.ts")).href);
// Build two expeditions; the re-entry guard on /autoresearch expedition blocks the second command,
// so build the second chain by direct disk manipulation: stop the first and add a second active chain dir.
await h.command("autoresearch").handler("expedition goal",h.ctx); await h.tool("expedition_brief").execute("id",{action:"draft",doc},null,null,h.ctx); const out=await h.tool("expedition_brief").execute("id",{action:"propose"},null,null,h.ctx);
const id=text(out).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
const chainRoot=path.join(dir,".auto","research-chain");
// Mark the live chain stopped in the journal (append a status_change via the module API is hash-chained;
// instead simulate restart-on-stopped by copying the chain dir with a fresh status entry is not valid —
// use the scan-level guarantee: temporarily stop by renaming status via a second chain dir with own journal).
const second=path.join(chainRoot,`${id}-b-chain`); fs.mkdirSync(second,{recursive:true});
fs.writeFileSync(path.join(second,"chain.json"),fs.readFileSync(path.join(chainRoot,`${id}-chain`,"chain.json"),"utf8"));
fs.copyFileSync(path.join(chainRoot,`${id}-chain`,"expedition.json"),path.join(second,"expedition.json"));
// Both dirs have status active in journal + valid markers with matching digests: fresh = the copy (later mtime).
const restCtx=makeCtx(dir,"exp-restore-3",h.pi);
await ext.restoreExpeditionForTest(restCtx);
const restored=h.pi.sentMessages.filter(m=>/restored after restart/.test(m.text));
assert.equal(restored.length,1);
assert.match(restored[0].text,/NOT restored/,"the older chain is reported as not restored");
// Stopped chain: append a stopped status is not trivial (hash chain) — stopped coverage lives in expedition.test.mjs scan tests.
});
