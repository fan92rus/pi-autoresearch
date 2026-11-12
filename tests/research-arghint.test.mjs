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
