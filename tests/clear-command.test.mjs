import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-clear-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeResearchCampaign(dir, id = "c1", phase = "briefing") {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(path.join(campaignDir, "state.json"), JSON.stringify({
    schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase,
  }));
  return campaignDir;
}

async function load(dir, label) {
  const { pi, command } = createFakePi({ dir, sessionId: `clear-${label}`, realGit: false });
  const ctx = makeCtx(dir, `clear-${label}`, pi);
  const { default: extension } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  extension(pi);
  return { pi, ctx, clear: () => command("autoresearch").handler("clear", ctx), command: (args) => command("autoresearch").handler(args, ctx) };
}

const ACTIVATION = "pi-autoresearch.activation";
const activationCount = (pi) => pi.entries.filter((entry) => entry === ACTIVATION).length;
const notifications = (pi) => pi.notifications.map((n) => n.text);

test("clear removes run data and ideas, keeps owner config, and reports deleted paths", async () => {
  const dir = makeWorkDir("data");
  const auto = path.join(dir, ".auto");
  fs.mkdirSync(path.join(auto, "ideas"), { recursive: true });
  fs.mkdirSync(path.join(auto, "runs", "1"), { recursive: true });
  for (const file of ["log.jsonl", "findings.jsonl", "observations.jsonl", "analysis.jsonl", "report.md", "runs/1/output.txt", "ideas/n1.md"]) {
    fs.writeFileSync(path.join(auto, file), "test-data\n");
  }
  for (const file of ["config.json", "prompt.md", "checks.sh", "measure.sh"]) fs.writeFileSync(path.join(auto, file), "owner-config\n");
  const h = await load(dir, "data");
  await h.command("on");
  const before = activationCount(h.pi);
  await h.clear();
  for (const file of ["log.jsonl", "findings.jsonl", "observations.jsonl", "analysis.jsonl", "report.md", "runs", "ideas"]) {
    assert.equal(fs.existsSync(path.join(auto, file)), false, `${file} removed`);
  }
  for (const file of ["config.json", "prompt.md", "checks.sh", "measure.sh"]) {
    assert.equal(fs.existsSync(path.join(auto, file)), true, `${file} survives clear`);
  }
  assert.ok(activationCount(h.pi) > before, "successful clear records mode-off activation");
  const notify = notifications(h.pi).at(-1).replace(/\\/g, "/");
  for (const file of [".auto/log.jsonl", ".auto/findings.jsonl", ".auto/observations.jsonl", ".auto/analysis.jsonl", ".auto/report.md", ".auto/runs", ".auto/ideas"]) {
    assert.ok(notify.includes(file), `notify includes ${file}: ${notify}`);
  }
});

test("clear refuses under a research campaign before changing anything", async () => {
  const dir = makeWorkDir("research-guard");
  const auto = path.join(dir, ".auto");
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, "log.jsonl"), "ledger\n");
  fs.writeFileSync(path.join(auto, "findings.jsonl"), "finding\n");
  const campaignDir = writeResearchCampaign(dir);
  const h = await load(dir, "research-guard");
  await h.command("on");
  const before = activationCount(h.pi);
  await h.clear();
  assert.equal(fs.readFileSync(path.join(auto, "log.jsonl"), "utf8"), "ledger\n");
  assert.equal(fs.readFileSync(path.join(auto, "findings.jsonl"), "utf8"), "finding\n");
  assert.equal(fs.existsSync(path.join(campaignDir, "state.json")), true);
  assert.equal(activationCount(h.pi), before, "refusal must not write activation-off");
  assert.ok(notifications(h.pi).some((t) => /Research campaign active.*complete or remove/i.test(t)), notifications(h.pi).join("\n"));
});

test("clear refuses under an active candidate campaign before changing anything", async () => {
  const dir = makeWorkDir("candidate-guard");
  const auto = path.join(dir, ".auto");
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, "log.jsonl"), "ledger\n");
  const candidateDir = path.join(auto, "candidate");
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(candidateDir, "state.json"), JSON.stringify({ schema_version: 1, disabled: false, candidates: [] }));
  const h = await load(dir, "candidate-guard");
  await h.command("on");
  const before = activationCount(h.pi);
  await h.clear();
  assert.equal(fs.readFileSync(path.join(auto, "log.jsonl"), "utf8"), "ledger\n");
  assert.equal(fs.existsSync(path.join(candidateDir, "state.json")), true);
  assert.equal(activationCount(h.pi), before, "refusal must not write activation-off");
  assert.ok(notifications(h.pi).some((t) => /Candidate campaign active/i.test(t)), notifications(h.pi).join("\n"));
});

test("clear on empty workdir reports no session log and does not throw", async () => {
  const dir = makeWorkDir("empty");
  const h = await load(dir, "empty");
  await assert.doesNotReject(h.clear());
  assert.ok(notifications(h.pi).some((t) => /No session log found/.test(t)), notifications(h.pi).join("\n"));
});

test("clear preserves owner config", async () => {
  const dir = makeWorkDir("config");
  const auto = path.join(dir, ".auto");
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, "config.json"), "{\"owner\":true}\n");
  fs.writeFileSync(path.join(auto, "log.jsonl"), "ledger\n");
  const h = await load(dir, "config");
  await h.clear();
  assert.equal(fs.readFileSync(path.join(auto, "config.json"), "utf8"), "{\"owner\":true}\n");
});
