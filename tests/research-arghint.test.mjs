import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arghint-"));
  const { pi, tool, command } = createFakePi({ dir, sessionId: "arghint", realGit: false });
  const ctx = makeCtx(dir, "arghint", pi);
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  await command("autoresearch").handler("on", ctx);
  return { tool: tool("research"), ctx };
}

const refusalText = (result) => result.content?.[0]?.text ?? "";

test("legacy executor redirects question-close fields to the split aliases", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id1", { action: "expedition", subaction: "resolve", dir: "Tape", rule_id: "t3-rejected", verdict: "rejected", reason: "done" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.match(text, /unexpected field\(s\) "rule_id", "verdict"/);
  assert.match(text, /Hint: rule_id\/verdict belong to closing a campaign QUESTION: use research_questions\(action=close/);
  assert.match(text, /close a map DIRECTION make a separate expedition_map call with subaction=resolve or subaction=reject/);
  assert.match(text, /refs to already-closed questions/);
});

test("open action with close-only fields gets the shorter hint", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id2", { action: "open", question_id: "Q1", rule_id: "r1" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.match(text, /Hint: rule_id\/verdict belong to research_questions\(action=close/);
});

test("close action itself with its own fields is NOT refused (no hint noise)", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id3", { action: "close", question_id: "Q1", rule_id: "r1", verdict: "confirmed", reason: "ok" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.equal(text.includes("unexpected field"), false);
});

test("expedition action with other extra fields (no rule_id/verdict) gets no false hint", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id4", { action: "expedition", subaction: "resolve", dir: "Tape", verdict2: "x" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.match(text, /unexpected field\(s\) "verdict2"/);
  assert.equal(text.includes("Hint: rule_id/verdict"), false);
});

test("record with question_id gets the auto-binding hint (live homeserver-docs case)", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id5", { action: "record", evidence_ref: "x.log:1-2", question_id: "Q1" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.match(text, /unexpected field\(s\) "question_id"/);
  assert.match(text, /Hint: record binds evidence to the CURRENTLY OPEN question automatically/);
  assert.match(text, /drop question_id/);
});

test("open with evidence_ref hints the separate record call", async () => {
  const { tool, ctx } = await harness();
  const result = await tool.execute("id6", { action: "open", question_id: "Q1", evidence_ref: "x.log:1-2" }, undefined, undefined, ctx);
  const text = refusalText(result);
  assert.match(text, /Hint: evidence is recorded by a separate call research_questions\(action=record, evidence_ref\)/);
});

test("evidence outside the workdir refusal names the workdir and teaches the copy-in path", async () => {
  const { tool, ctx } = await harness();
  // need an active campaign with an open question for record to reach locateEvidence
  // — but locateEvidence refusal fires before phase gate? No: phase gate first.
  // So seed a campaign quickly via the research tool if possible; else assert via direct call.
  // Simpler: call the alias executor on a NON-campaign dir is not enough; use the real flow:
  const result = await tool.execute("id7", { action: "start" }, undefined, undefined, ctx);
  const startText = refusalText(result);
  // start needs an approved brief; regardless of its outcome, the refusal path we
  // want to pin is locateEvidence. Seed minimal campaign files directly:
  const workDir = ctx.cwd;
  const campRoot = path.join(workDir, ".auto", "research", "camp-hint");
  fs.mkdirSync(path.join(campRoot, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(campRoot, "state.json"), JSON.stringify({ schema_version: 1, campaign_id: "camp-hint", created_at: "t", phase: "research" }));
  fs.writeFileSync(path.join(campRoot, "log.jsonl"), JSON.stringify({ at: "a", event: "open", question_id: "Q1" }) + "\n");
  const rules = [
    { id: "Q1-yes", verdict: "confirmed", when: "effect is present" },
    { id: "Q1-no", verdict: "rejected", when: "effect is absent" },
    { id: "Q1-unknown", verdict: "inconclusive", when: "data are noisy" },
    { id: "Q1-wait", verdict: "waiting_for_data", when: "data are insufficient" },
  ];
  const briefBytes = JSON.stringify({ schema_version: 1, goal: "g", plan_source: "p", caveat_block: "c", data_roles: { explore: [], validate: [], confirm: [] }, questions: [{ id: "Q1", text: "t?", decision_rules: rules, needs_data: null }], process_metrics: [], stop_rules: [{ id: "S1", when: "all questions closed" }] });
  fs.writeFileSync(path.join(campRoot, "brief.json"), briefBytes);
  const { createHash } = await import("node:crypto");
  fs.writeFileSync(path.join(campRoot, "approval.json"), JSON.stringify({ schema_version: 1, brief_sha256: createHash("sha256").update(briefBytes).digest("hex"), approved_at: "t", confirmed: true }));
  // pin: resolveCampaignDir picks the single existing campaign when nothing is pinned
  const result2 = await tool.execute("id8", { action: "record", evidence_ref: "D:/outside/other-repo/run.log:1-2" }, undefined, undefined, ctx);
  const text2 = refusalText(result2);
  assert.match(text2, /evidence must be a file INSIDE the work directory/);
  assert.match(text2, /copy it in first|copy.*in first|External sources must be copied in first/);
  assert.match(text2, /\.auto\/research\/evidence/);
}, { timeout: 60000 });
