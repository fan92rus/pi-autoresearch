/** Interactive research_charter tool wiring tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

function workDir(label) {
  const dir = path.join(os.tmpdir(), `pi-charter-launch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function textOf(res) { return res?.content?.[0]?.text ?? ""; }
function snapshot(dir) {
  const out = {};
  const visit = (base, rel = "") => {
    for (const name of fs.readdirSync(base).sort()) {
      const p = path.join(base, name), key = path.join(rel, name);
      if (fs.statSync(p).isDirectory()) visit(p, key);
      else out[key] = fs.readFileSync(p).toString("base64");
    }
  };
  visit(dir);
  return JSON.stringify(out);
}
async function harness(label, confirm = true) {
  const dir = workDir(label);
  const { pi, tool, command } = createFakePi({ dir, sessionId: `charter-launch-${label}-${Math.random()}`, realGit: false });
  const ctx = makeCtx(dir, `charter-launch-${label}-${Math.random()}`, pi);
  ctx.ui.confirm = async (_title, body) => { ctx.lastDialog = body; return confirm; };
  const { default: ext } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext(pi);
  return { dir, pi, tool, command, ctx };
}
function call(h, action, extra = {}) { return h.tool("research_charter").execute("call", { action, ...extra }, null, null, h.ctx); }
async function openDialog(h) { await h.command("autoresearch").handler("charter test", h.ctx); }
function dirs(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; }
function chainPath(dir, root) { return path.join(dir, ".auto", "research-chain", `${root}-chain`); }

const charter = { max_campaigns: 3, stop_rules: ["two rejected findings in a row"] };

test("draft saves a validated charter and hash without filesystem or mode activation", async () => {
  const h = await harness("draft"); await openDialog(h);
  const parentCharterFiles = dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-") && n.endsWith(".json"));
  const result = textOf(await call(h, "draft", { charter }));
  assert.match(result, new RegExp(sha256Hex(JSON.stringify(charter, null, 2) + "\n")));
  assert.equal(fs.existsSync(path.join(h.dir, ".auto", "research-chain")), false);
  assert.equal(dirs(path.join(h.dir, ".auto", "research")).length, 0);
  const parentCharterFilesAfter = dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-") && n.endsWith(".json"));
  assert.deepEqual(parentCharterFilesAfter.filter((n) => !parentCharterFiles.includes(n)), []);
  assert.match(textOf(await h.tool("research_brief").execute("x", { action: "draft", brief: {} }, null, null, h.ctx)), /Autoresearch mode is OFF/);
});

test("invalid charter draft refuses without changing disk", async () => {
  const h = await harness("invalid"); await openDialog(h); const before = snapshot(h.dir);
  assert.match(textOf(await call(h, "draft", { charter: { unknown: true } })), /charter_invalid/);
  assert.equal(snapshot(h.dir), before);
});

test("owner approval fields are rejected", async () => {
  const h = await harness("approval");
  assert.match(textOf(await call(h, "draft", { charter, approved: true })), /invalid_argument.*approved/);
  assert.match(textOf(await call(h, "propose", { approved: true })), /invalid_argument.*approved/);
});

test("a replacement draft is what the owner sees in propose", async () => {
  const h = await harness("replace"); await openDialog(h); const second = { max_depth: 4 };
  await call(h, "draft", { charter }); await call(h, "draft", { charter: second });
  await call(h, "propose");
  assert.match(h.ctx.lastDialog, new RegExp(sha256Hex(JSON.stringify(second, null, 2) + "\n")));
});

test("propose without a draft refuses", async () => {
  const h = await harness("missing"); await openDialog(h);
  assert.match(textOf(await call(h, "propose")), /charter_draft_missing/);
});

function writeStoppedRootCampaign(dir, id) {
  const root = path.join(dir, ".auto", "research", id); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase: "stopped" }, null, 2) + "\n");
  const brief = { schema_version: 1, goal: "test", plan_source: "plan", caveat_block: "observational", data_roles: { explore: [], validate: [], confirm: [] }, questions: [], process_metrics: [], stop_rules: [] };
  fs.writeFileSync(path.join(root, "brief.json"), JSON.stringify(brief, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "approval.json"), JSON.stringify({ schema_version: 1, brief_sha256: sha256Hex(JSON.stringify(brief, null, 2) + "\n"), approved_at: new Date().toISOString(), confirmed: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "log.jsonl"), "");
  fs.writeFileSync(path.join(root, "report.md"), "# report\n");
}

test("active chain blocks draft/propose; successful repeated propose replays first launch without dialog", async () => {
  const h = await harness("active-chain"); writeStoppedRootCampaign(h.dir, "c1");
  await openDialog(h); await call(h, "draft", { charter });
  const cp = path.join(h.dir, "..", `charter-source-${Date.now()}.json`); fs.writeFileSync(cp, "{}\n");
  await h.command("autoresearch").handler(`research --charter ${cp} --id c1`, h.ctx);
  assert.match(textOf(await call(h, "draft", { charter })), /chain_active/);
  assert.match(textOf(await call(h, "propose")), /chain_active/);
  const fresh = await harness("replay");
  await openDialog(fresh); await call(fresh, "draft", { charter });
  let dialogs = 0;
  fresh.ctx.ui.confirm = async () => { dialogs++; return true; };
  await call(fresh, "propose");
  const again = textOf(await call(fresh, "propose"));
  assert.match(again, /first confirmation/);
  assert.equal(dialogs, 1);
});

test("propose writes canonical charter outside workdir, creates chain, enables mode and sends kickoff", async () => {
  const h = await harness("success"); await openDialog(h); await call(h, "draft", { charter });
  const before = h.pi.sentMessages.length;
  const result = textOf(await call(h, "propose"));
  assert.match(result, /started/);
  const files = dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-bench-") && n.endsWith(".json"));
  assert.ok(files.length > 0);
  const p = path.join(path.dirname(h.dir), files.at(-1));
  assert.equal(fs.realpathSync(p).startsWith(fs.realpathSync(h.dir) + path.sep), false);
  assert.equal(fs.readFileSync(p, "utf8"), JSON.stringify(charter, null, 2) + "\n");
  assert.ok(dirs(path.join(h.dir, ".auto", "research-chain")).some((name) => name.endsWith("-chain")));
  assert.equal(sha256Hex(fs.readFileSync(p, "utf8")), sha256Hex(JSON.stringify(charter, null, 2) + "\n"));
  assert.ok(h.pi.sentMessages.length > before);
  assert.match(h.pi.sentMessages.at(-1).text, /research_brief/);
});

test("missing UI preserves draft and permits a later confirmed propose", async () => {
  const h = await harness("no-ui"); await openDialog(h); await call(h, "draft", { charter }); delete h.ctx.ui.confirm;
  const before = dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-"));
  assert.match(textOf(await call(h, "propose")), /interactive dialog/);
  assert.deepEqual(dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-")), before);
  h.ctx.ui.confirm = async () => true;
  assert.match(textOf(await call(h, "propose")), /started/);
});

test("owner refusal writes no charter and retry shows the dialog again", async () => {
  const h = await harness("refusal", false); await openDialog(h); await call(h, "draft", { charter });
  const before = dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-"));
  assert.match(textOf(await call(h, "propose")), /did not confirm/);
  assert.deepEqual(dirs(path.dirname(h.dir)).filter((n) => n.startsWith("charter-")), before);
  h.ctx.ui.confirm = async () => false;
  await call(h, "propose"); assert.equal((h.ctx.lastDialog.match(/Charter SHA-256:/g) ?? []).length, 1);
});

test("draft and propose outside the charter command are refused; command enables draft", async () => {
  const h = await harness("closed-draft"); const before = snapshot(h.dir);
  assert.match(textOf(await call(h, "draft", { charter })), /charter_dialog_closed/);
  assert.match(textOf(await call(h, "propose")), /charter_dialog_closed/);
  assert.equal(snapshot(h.dir), before);
  await openDialog(h);
  assert.match(textOf(await call(h, "draft", { charter })), /draft saved/);
});

test("allowlist rejects extra fields before successful propose replay", async () => {
  const h = await harness("replay-allowlist"); await openDialog(h); await call(h, "draft", { charter });
  assert.match(textOf(await call(h, "propose")), /started/);
  const replay = textOf(await call(h, "propose", { approved: true }));
  assert.match(replay, /invalid_argument.*approved/);
  assert.doesNotMatch(replay, /already launched/);
});

// charter_path_taken is covered at the charter-launch unit-test layer, not duplicated here.
