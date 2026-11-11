import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(repo, "scripts", "research-rpc.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (obj) => Buffer.from(`${JSON.stringify(obj, null, 2)}\n`);
const document = canonical({ charter: { stop_rules: ["territory_complete"] }, goal: "Explore", directions: [{ name: "D1", why: "Test" }], campaign0: { schema_version: 1, goal: "Explore" } });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-rpc-expedition-"));
  const doc = path.join(dir, "expedition.json");
  fs.writeFileSync(doc, document);
  const fake = path.join(dir, "fake.mjs");
  fs.writeFileSync(fake, `import * as readline from "node:readline";\nconst out=v=>process.stdout.write(JSON.stringify(v)+"\\n");\nconst input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});\ninput.on("line",line=>{let r;try{r=JSON.parse(line)}catch{return};if(r.type==="abort"){input.close();return}if(r.type==="extension_ui_response"){if(r.confirmed)out({type:"agent_settled",chain_status:"awaiting_child"});else input.close();return}if(r.type==="prompt"){out({type:"agent_start"});out({id:r.id,type:"response",command:"prompt",success:true,data:{disposition:"started"}});out({id:"exp-dialog",type:"extension_ui_request",method:"confirm",message:"Expedition SHA-256: "+(process.env.DIALOG_SHA||process.env.DOC_SHA)+"\\nApprove?"});}});\n`);
  return { dir, doc, fake, log: path.join(dir, "log.jsonl"), digest: sha(document) };
}
function run(ctx, extra = [], dialogSha = ctx.digest) {
  return new Promise((resolve) => {
    const args = [wrapper, "--mode", "research", "--expedition-doc", ctx.doc, "--approve-expedition-sha", ctx.digest, "--pi", ctx.fake, "--cwd", ctx.dir, "--log", ctx.log, "--timeout-sec", "3", "--stage1-timeout-sec", "1", ...extra];
    const child = spawn(process.execPath, args, { cwd: ctx.dir, env: { ...process.env, DOC_SHA: ctx.digest, DIALOG_SHA: dialogSha }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.setEncoding("utf8").on("data", s => stderr += s);
    const timer = setTimeout(() => child.kill(), 10000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
function events(ctx) { return fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }

test("expedition option pair is mandatory and incompatible with brief or charter options", async () => {
  const ctx = setup();
  for (const extra of [["--approve-expedition-sha", ctx.digest], ["--expedition-doc", ctx.doc]]) assert.equal((await run(ctx, extra)).code, 2);
  for (const extra of [["--brief", ctx.doc], ["--approve-sha", ctx.digest], ["--charter", ctx.doc, "--approve-charter-sha", ctx.digest]]) assert.equal((await run(ctx, extra)).code, 2);
  assert.equal(fs.existsSync(ctx.log), false);
});

test("noncanonical expedition document fails preflight", async () => {
  const ctx = setup(); fs.writeFileSync(ctx.doc, Buffer.from('{"goal":"Explore"}\n'));
  assert.equal((await run(ctx)).code, 2); assert.equal(fs.existsSync(ctx.log), false);
});

test("matching expedition confirmation starts kickoff and exits 0 at awaiting_child", async () => {
  const ctx = setup(); const result = await run(ctx);
  assert.equal(result.code, 0, result.stderr);
  const log = events(ctx);
  assert.ok(log.some(e => e.direction === "to_pi" && e.record.type === "extension_ui_response" && e.record.confirmed === true));
  const kickoff = log.find(e => e.direction === "to_pi" && e.record.type === "prompt").record.message;
  assert.match(kickoff, /\/autoresearch expedition/); assert.ok(kickoff.includes(ctx.doc));
});

test("mismatched dialog hash is refused and exits 3", async () => {
  const ctx = setup(); const result = await run(ctx, [], "f".repeat(64));
  assert.equal(result.code, 3, result.stderr);
  assert.ok(events(ctx).some(e => e.direction === "to_pi" && e.record.type === "extension_ui_response" && e.record.confirmed === false));
});

test("document changed while dialog is pending is refused", async () => {
  const ctx = setup(); const pending = run(ctx, ["--hold-dialog-ms", "800"]);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!fs.existsSync(ctx.log) || !fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request"))) await delay(10);
  assert.ok(fs.existsSync(ctx.log) && fs.readFileSync(ctx.log, "utf8").includes("extension_ui_request"));
  fs.writeFileSync(ctx.doc, canonical({ goal: "changed" }));
  const result = await pending; assert.equal(result.code, 3, result.stderr);
  assert.ok(events(ctx).some(e => e.record?.event === "expedition_confirmation" && e.record.confirmed === false));
});
