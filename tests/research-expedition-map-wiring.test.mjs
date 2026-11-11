import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as chainJournal from "../extensions/pi-autoresearch/chain-journal.ts";

const brief = {schema_version:1,goal:"Map the cache",plan_source:"plan.md",caveat_block:"Observational",data_roles:{explore:[],validate:[],confirm:[]},questions:[{id:"Q1",text:"Does it help?",decision_rules:[{id:"yes",verdict:"confirmed",when:"yes"},{id:"no",verdict:"rejected",when:"no"},{id:"unknown",verdict:"inconclusive",when:"unknown"},{id:"wait",verdict:"waiting_for_data",when:"wait"}],needs_data:null}],process_metrics:[],stop_rules:[]};
const doc = {charter:{stop_rules:["territory_complete"]},goal:"Map the cache",directions:[{name:"cache",why:"Measure cache"}],campaign0:brief};
const text = r => r?.content?.[0]?.text ?? "";
async function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"exp-map-wire-"));
  const {pi,tool,command}=createFakePi({dir,sessionId:"exp-map-wire",realGit:false});
  const ctx=makeCtx(dir,"exp-map-wire",pi); ctx.ui.confirm=async()=>true;
  const ext=await import(pathToFileURL(path.join(import.meta.dirname,"..","extensions","pi-autoresearch","index.ts")).href); ext.default(pi);
  const call=(name,params)=>tool(name).execute("call",params,null,null,ctx);
  await command("autoresearch").handler("expedition cache",ctx);
  await call("expedition_brief",{action:"draft",doc});
  const proposed=await call("expedition_brief",{action:"propose"});
  const campaignId=text(proposed).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1]; assert.ok(campaignId,text(proposed));
  const chainId=`${campaignId}-chain`;
  const chainDir=chainJournal.chainDir(dir,chainId); assert.ok(chainDir);
  return {dir,ctx,call,chainId,chainDir};
}
async function append(h,type,payload){assert.equal((await chainJournal.appendEntry(h.chainDir,h.dir,h.chainId,type,payload)).ok,true);}

test("expedition map status renders replay and invalid transition is refused",async()=>{
  const h=await setup();
  const status=await h.call("research",{action:"expedition",subaction:"status"});
  assert.match(text(status),/cache.*open/i);
  const denied=await h.call("research",{action:"expedition",subaction:"resolve",dir:"cache",refs:[{campaign:"missing",question:"Q1"}]});
  assert.match(text(denied),/active|ref/i);
});

test("territory_complete refuses open directions without changing chain status",async()=>{
  const h=await setup();
  const before=await chainJournal.statusOf(h.dir,h.chainId);
  const result=await h.call("research",{action:"chain_stop",rule_id:"territory_complete"});
  assert.match(text(result),/territory_complete is false.*cache/i);
  assert.equal(await chainJournal.statusOf(h.dir,h.chainId),before);
  const verified=await chainJournal.verifyChain(h.dir,h.chainId);
  assert.equal(verified.entries.some(e=>e.type==="expedition_stop"),false);
});

test("territory_complete rejects a pivot after the last closure",async()=>{
  const h=await setup();
  await append(h,"direction_resolved",{dir:"cache",why:"Measured",refs:[{campaign:"c",question:"Q1"}]});
  await append(h,"pivot",{from:"cache",to:"next",reason:"Follow-up"});
  const result=await h.call("research",{action:"chain_stop",rule_id:"territory_complete"});
  assert.match(text(result),/pivot after the last closure/i);
  assert.equal(await chainJournal.statusOf(h.dir,h.chainId),"active");
});

test("completed expedition stop records system event and writes final report",async()=>{
  const h=await setup();
  await append(h,"direction_resolved",{dir:"cache",why:"Measured",refs:[{campaign:"c",question:"Q1"}]});
  const result=await h.call("research",{action:"chain_stop",rule_id:"territory_complete"});
  assert.match(text(result),/stopped by charter rule/i);
  assert.equal(await chainJournal.statusOf(h.dir,h.chainId),"stopped_by_rule");
  const verified=await chainJournal.verifyChain(h.dir,h.chainId);
  assert.ok(verified.entries.some(e=>e.type==="expedition_stop"&&e.rule==="territory_complete"));
  const report=path.join(h.chainDir,"expedition-report.md");
  assert.ok(fs.existsSync(report)); assert.match(fs.readFileSync(report,"utf8"),/territory_complete/);
});

test("expedition status snapshot includes the direction basis",async()=>{
  const h=await setup();
  const result=await h.call("research",{action:"expedition",subaction:"status"});
  assert.match(text(result),/cache.*Measure cache/);
});
