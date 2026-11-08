/**
 * report.md persistence and findings routing on close (bd pi-autoresearch-7ii):
 * research report writes <campaignDir>/report.md next to state.json and close
 * with confirmed/rejected appends a finding to .auto/findings.jsonl of the
 * PROJECT ROOT (workDir), so campaign verdicts become searchable precedents.
 * Drives the REAL extension through the fake pi harness.
 *
 * Run: timeout 120 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-report-persist.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-rp-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rulesFor(qid) {
  return [
    { id: `${qid}-yes`, verdict: "confirmed", when: "effect is present in validate data" },
    { id: `${qid}-no`, verdict: "rejected", when: "effect is absent in validate data" },
    { id: `${qid}-unknown`, verdict: "inconclusive", when: "data are too noisy to decide" },
    { id: `${qid}-wait`, verdict: "waiting_for_data", when: "validate data are missing" },
  ];
}

function briefFixture(overrides = {}) {
  const base = {
    schema_version: 1,
    goal: "Check whether the cache layer explains the latency drop.",
    plan_source: "docs/plan.md",
    caveat_block: "Results are observational; no causal claim is made beyond the listed data.",
    data_roles: { explore: ["logs/2024-01.txt"], validate: ["logs/2024-02.txt"], confirm: [] },
    questions: [
      { id: "Q1", text: "Does the cache hit rate rise after the change?", decision_rules: rulesFor("Q1"), needs_data: null },
      { id: "Q2", text: "Does the retry policy add latency?", decision_rules: rulesFor("Q2"), needs_data: null },
    ],
    process_metrics: ["number of log files read"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
  };
  return { ...base, ...overrides };
}

async function loadExtension(dir, label) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: `rp-${label}`, realGit: false });
  const ctx = makeCtx(dir, `rp-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1", ctx);
  return { pi, tool, command, ctx, dir };
}

function call(h, name, params) {
  return h.tool(name).execute("tool-call-id", params, null, null, h.ctx);
}

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

/** Full campaign to the research phase with one recorded evidence for Q1. */
async function campaignWithEvidence(h, evidenceRef = "logs/2024-02.txt:2") {
  fs.mkdirSync(path.join(h.dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "logs", "2024-02.txt"), "line1\nhit rate 0.62\nline3\n");
  const draft = await call(h, "research_brief", { action: "draft", brief: briefFixture() });
  assert.match(textOf(draft), /Brief draft saved/, textOf(draft));
  h.ctx.ui.confirm = async () => true;
  const proposed = await call(h, "research_brief", { action: "propose" });
  assert.match(textOf(proposed), /Brief approved/, textOf(proposed));
  const briefFile = locateCampaignFile(h, "brief.json");
  const briefSha = sha256Of(fs.readFileSync(briefFile));
  const started = await call(h, "research", { action: "start", expected_sha256: briefSha });
  assert.match(textOf(started), /Research phase started/, textOf(started));
  await call(h, "research", { action: "open", question_id: "Q1" });
  const recorded = await call(h, "research", { action: "record", evidence_ref: evidenceRef });
  assert.match(textOf(recorded), /Evidence recorded/, textOf(recorded));
  return briefSha;
}

/** Locates a file under the campaign dir c1 (default root or a --state-root). */
function locateCampaignFile(h, file) {
  const candidates = [
    path.join(h.dir, ".auto", "research", "c1", file),
    path.join(h.dir, "runs", "c1", ".auto", "research", "c1", file),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`campaign file ${file} not found in any root`);
  return found;
}

function campaignDirOf(h) {
  return path.dirname(locateCampaignFile(h, "state.json"));
}

// ─── report.md persistence ───────────────────────────────────────────────────

test("report writes <campaignDir>/report.md and returns the text with a saved-to line", async () => {
  const dir = makeWorkDir("report");
  const h = await loadExtension(dir, "report");
  await campaignWithEvidence(h);

  const report = await call(h, "research", { action: "report" });
  const text = textOf(report);
  assert.match(text, /# Research campaign report: c1/, "report body returned as before");
  assert.match(text, /Report saved to/, "saved-to line present");

  const file = path.join(campaignDirOf(h), "report.md");
  assert.ok(fs.existsSync(file), "report.md written next to state.json");
  const fileText = fs.readFileSync(file, "utf8");
  assert.match(fileText, /# Research campaign report: c1/, "file carries the report header");
  assert.match(fileText, /## Caveat \(verbatim from the brief\)/, "caveat block persisted");
  assert.ok(!fileText.includes("Report saved to"), "file content has no saved-to meta line");
});

test("report works without stop (report is not gated on a stop rule)", async () => {
  const dir = makeWorkDir("report-no-stop");
  const h = await loadExtension(dir, "report-no-stop");
  await campaignWithEvidence(h);
  // No stop called at all.
  const report = await call(h, "research", { action: "report" });
  assert.match(textOf(report), /# Research campaign report: c1/, "report succeeds without stop");
  assert.ok(fs.existsSync(path.join(campaignDirOf(h), "report.md")), "report.md written without stop");
});

test("a failing report write warns but still returns the report text", async () => {
  const dir = makeWorkDir("report-warn");
  const h = await loadExtension(dir, "report-warn");
  await campaignWithEvidence(h);
  // Make the campaign directory read-only-ish: replace report.md target with
  // a DIRECTORY so writeFile fails with EISDIR — the write fails, the report
  // must still be returned with a warning line.
  fs.mkdirSync(path.join(campaignDirOf(h), "report.md"), { recursive: true });
  const report = await call(h, "research", { action: "report" });
  const text = textOf(report);
  assert.match(text, /# Research campaign report: c1/, "report still returned on write failure");
  assert.match(text, /warning/i, "warning line present when the write fails");
});

// ─── findings routing on close ───────────────────────────────────────────────

test("close with confirmed appends a finding to the PROJECT .auto/findings.jsonl", async () => {
  const dir = makeWorkDir("find-confirmed");
  const h = await loadExtension(dir, "find-confirmed");
  await campaignWithEvidence(h);
  const closed = await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  assert.match(textOf(closed), /Vector Q1 closed: confirmed by rule Q1-yes/, textOf(closed));

  const findingsFile = path.join(h.dir, ".auto", "findings.jsonl");
  assert.ok(fs.existsSync(findingsFile), "findings.jsonl created in the project root");
  const line = JSON.parse(fs.readFileSync(findingsFile, "utf8").trim());
  assert.equal(line.type, "finding", "ordinary finding record shape");
  assert.equal(line.status, "open");
  assert.match(line.description, /c1\/Q1: confirmed by Q1-yes/, "description carries campaign/question/verdict/rule");
  assert.equal(line.evidence_ref, "logs/2024-02.txt:2", "evidence_ref is the vector's recorded evidence");
  // Compatibility with findings.ts reader: theme must be a known theme.
  assert.ok(["measurement", "behavior", "capability", "tradeoff"].includes(line.theme), `theme must be a legal FindingTheme, got ${line.theme}`);
});

test("close with rejected also appends a finding", async () => {
  const dir = makeWorkDir("find-rejected");
  const h = await loadExtension(dir, "find-rejected");
  await campaignWithEvidence(h);
  const closed = await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-no", verdict: "rejected" });
  assert.match(textOf(closed), /Vector Q1 closed/, textOf(closed));
  const line = JSON.parse(fs.readFileSync(path.join(h.dir, ".auto", "findings.jsonl"), "utf8").trim());
  assert.match(line.description, /c1\/Q1: rejected by Q1-no/);
});

test("close with inconclusive or waiting_for_data writes NO finding", async () => {
  const dir = makeWorkDir("find-none");
  const h = await loadExtension(dir, "find-none");
  await campaignWithEvidence(h);
  await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-unknown", verdict: "inconclusive", reason: "noise" });
  assert.equal(fs.existsSync(path.join(h.dir, ".auto", "findings.jsonl")), false, "inconclusive writes no finding");

  await call(h, "research", { action: "open", question_id: "Q2" });
  fs.mkdirSync(path.join(h.dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "logs", "2024-01.txt"), "line1\nretry spike\n");
  await call(h, "research", { action: "record", evidence_ref: "logs/2024-01.txt:2" });
  await call(h, "research", { action: "close", question_id: "Q2", rule_id: "Q2-wait", verdict: "waiting_for_data", reason: "confirm set missing" });
  assert.equal(fs.existsSync(path.join(h.dir, ".auto", "findings.jsonl")), false, "waiting_for_data writes no finding");
});

test("a findings write failure does not fail the close", async () => {
  const dir = makeWorkDir("find-fail");
  const h = await loadExtension(dir, "find-fail");
  await campaignWithEvidence(h);
  // Corrupt the store: findings.jsonl as a directory makes append fail.
  fs.mkdirSync(path.join(h.dir, ".auto", "findings.jsonl"), { recursive: true });
  const closed = await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  const text = textOf(closed);
  assert.match(text, /Vector Q1 closed: confirmed by rule Q1-yes/, "close succeeds regardless");
  assert.match(text, /finding/i, "warning mentions the finding write");
});

test("M2: record refuses a bare path evidence_ref with the expected format message", async () => {
  const dir = makeWorkDir("m2-bare");
  const h = await loadExtension(dir, "m2-bare");
  await campaignWithEvidence(h, "logs/2024-02.txt:2");
  // This campaign already recorded a valid ref; open Q2 and try a bare path.
  await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  await call(h, "research", { action: "open", question_id: "Q2" });
  const bad = await call(h, "research", { action: "record", evidence_ref: "logs/2024-01.txt" });
  assert.match(textOf(bad), /path:lines or path#anchor/i, "refusal teaches the format");
  assert.match(textOf(bad), /logs\/2024-01\.txt/, "refusal names the rejected ref");
});

test("M2: a confirmed close after a VALID record writes findings.jsonl (end-to-end format coherence)", async () => {
  const dir = makeWorkDir("m2-valid");
  const h = await loadExtension(dir, "m2-valid");
  await campaignWithEvidence(h, "logs/2024-02.txt:2-3");
  const closed = await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  assert.match(textOf(closed), /Finding recorded: f\d+/, textOf(closed));
  const line = JSON.parse(fs.readFileSync(path.join(h.dir, ".auto", "findings.jsonl"), "utf8").trim());
  assert.equal(line.evidence_ref, "logs/2024-02.txt:2-3", "stored evidence_ref parses (lines form)");
});

test("findings land in the PROJECT root even with a --state-root campaign", async () => {
  const dir = makeWorkDir("find-stateroot");
  const { pi, tool, command } = createFakePi({ dir, sessionId: "rp-find-sr", realGit: false });
  const ctx = makeCtx(dir, "rp-find-sr", pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  await command("autoresearch").handler("research --id c1 --state-root runs/c1", ctx);
  const h = { pi, tool, command, ctx, dir };
  await campaignWithEvidence(h);
  await call(h, "research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });

  assert.ok(fs.existsSync(path.join(dir, ".auto", "findings.jsonl")), "findings in the project root .auto, not the state root");
  assert.equal(
    fs.existsSync(path.join(dir, "runs", "c1", ".auto", "findings.jsonl")), false,
    "no findings file inside the state root",
  );
});
