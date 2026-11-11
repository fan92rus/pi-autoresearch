/**
 * /autoresearch research subcommand (headless-launch spec, MVP): the reserved
 * word, the branch order before already-active, the campaign guards, the
 * research kickoff text and the subcommand registration. Drives the REAL
 * extension through the fake pi harness.
 *
 * Run: timeout 120 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-subcommand.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { SUBCOMMANDS, renderAutoresearchHelp } from "../extensions/pi-autoresearch/commands.ts";
import { filterSubcommands } from "../extensions/pi-autoresearch/parallel/config-ui.ts";

const KICKOFF_MARKERS = [
  "research_brief draft",
  "research_brief propose",
  "research start",
  "research open",
  "research close",
  "research stop",
  "research report",
];
const FORBIDDEN_IN_KICKOFF = ["/skill:autoresearch-create", "run_experiment", "log_experiment", "/autoresearch on"];
const RESEARCH_NOTIFY = "Research mode ON";
const ALREADY_ACTIVE_NOTIFY = "already active";

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-research-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a schema-valid campaign state with the given phase (same shape as the wiring test). */
function writeCampaignState(dir, id, phase) {
  const campaignDir = path.join(dir, ".auto", "research", id);
  fs.mkdirSync(campaignDir, { recursive: true });
  fs.writeFileSync(
    path.join(campaignDir, "state.json"),
    JSON.stringify({ schema_version: 1, campaign_id: id, created_at: new Date().toISOString(), phase }, null, 2) + "\n",
  );
  return campaignDir;
}

/** Loads the REAL extension on a fake pi without turning the mode on. */
async function loadExtension(dir, label) {
  const { pi, command } = createFakePi({ dir, sessionId: `research-sub-${label}`, realGit: false });
  const ctx = makeCtx(dir, `research-sub-${label}`, pi);
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href
  );
  autoresearchExtension(pi);
  const run = (args) => command("autoresearch").handler(args, ctx);
  return { pi, ctx, run };
}

/**
 * recordAutoresearchActivation(workDir, active) appends the activation type.
 * The fake pi keeps only the entry type (appendEntry(entry) drops the data), so
 * this proves an activation record was written, not its active flag.
 */
const ACTIVATION_ENTRY_TYPE = "pi-autoresearch.activation";
function activationEntries(pi) {
  return pi.entries.filter((e) => e === ACTIVATION_ENTRY_TYPE);
}

function notifyTexts(pi) {
  return pi.notifications.map((n) => n.text);
}

function researchKickoffs(pi) {
  // Bare kickoff (briefing) and phase-aware resume kickoffs share the tool
  // prescriptions; a research message is any kickoff sent by the research
  // branch (never a legacy metric-loop message).
  return pi.sentMessages.filter((m) =>
    m.text.includes("Research campaign: briefing phase") ||
    m.text.includes("already has a brief draft") ||
    m.text.includes("is already in the research phase"));
}

// ─── reserved word and kickoff ──────────────────────────────────────────────

test("'research' turns the research mode on and sends the research kickoff, never the metric-loop skill", async () => {
  const dir = makeWorkDir("bare");
  const h = await loadExtension(dir, "bare");
  await h.run("research");

  assert.ok(activationEntries(h.pi).length >= 1, "recordAutoresearchActivation must run");
  assert.ok(notifyTexts(h.pi).some((t) => t.includes(RESEARCH_NOTIFY)), "research mode ON notify");
  assert.equal(h.pi.sentMessages.length, 1, "exactly one message: the kickoff");
  const text = h.pi.sentMessages[0].text;
  assert.ok(researchKickoffs(h.pi).length === 1, "research kickoff is sent");
  assert.equal(text.startsWith("/skill:"), false, "kickoff must not start with a skill prefix");
  for (const forbidden of FORBIDDEN_IN_KICKOFF) {
    assert.equal(text.includes(forbidden), false, `kickoff must not contain ${forbidden}`);
  }
});

test("'research my campaign' carries the description tail into the kickoff", async () => {
  const dir = makeWorkDir("desc");
  const h = await loadExtension(dir, "desc");
  await h.run("research my campaign");
  const [kickoff] = researchKickoffs(h.pi);
  assert.ok(kickoff, "research kickoff sent");
  assert.match(kickoff.text, /Campaign description: my campaign\./);
});

test("'research<TAB>my desc' matches the reserved word and keeps the tail", async () => {
  const dir = makeWorkDir("tab");
  const h = await loadExtension(dir, "tab");
  await h.run("research\tmy desc");
  const [kickoff] = researchKickoffs(h.pi);
  assert.ok(kickoff, "tab after the reserved word still starts a research campaign");
  assert.match(kickoff.text, /Campaign description: my desc\./);
});

test("uppercase 'RESEARCH' matches the reserved word (command is lowercased)", async () => {
  const dir = makeWorkDir("upper");
  const h = await loadExtension(dir, "upper");
  await h.run("RESEARCH");
  assert.equal(researchKickoffs(h.pi).length, 1, "uppercase reserved word starts a research campaign");
});

test("'researcher x' does NOT take the research branch (free text, legacy path)", async () => {
  const dir = makeWorkDir("prefix");
  const h = await loadExtension(dir, "prefix");
  await h.run("researcher x");
  assert.equal(researchKickoffs(h.pi).length, 0, "no research kickoff");
  assert.equal(notifyTexts(h.pi).some((t) => t.includes(RESEARCH_NOTIFY)), false, "no research mode notify");
  assert.equal(h.pi.sentMessages.length, 1, "legacy free-text kickoff is sent instead");
  assert.match(h.pi.sentMessages[0].text, /researcher x/);
});

test("the kickoff lists the seven campaign steps and asks to wait for the details message", async () => {
  const dir = makeWorkDir("markers");
  const h = await loadExtension(dir, "markers");
  await h.run("research");
  const [kickoff] = researchKickoffs(h.pi);
  for (const marker of KICKOFF_MARKERS) {
    assert.ok(kickoff.text.includes(marker), `kickoff must name step: ${marker}`);
  }
  // Bare TUI kickoff is self-sufficient: no --id, so draft generates the id.
  assert.match(kickoff.text, /campaign id is generated/, "draft generates the campaign id when no --id is passed");
  assert.match(kickoff.text, /Formulate the brief/, "brief is formulated from the campaign description");
  assert.doesNotMatch(kickoff.text, /Wait for the next message/, "no wait when nothing is pinned to wait for");
});

// ─── branch order and guards ────────────────────────────────────────────────

test("research while the mode is already active runs the research branch, not 'already active'", async () => {
  const dir = makeWorkDir("active");
  const h = await loadExtension(dir, "active");
  await h.run("on");
  h.pi.notifications.length = 0;
  h.pi.sentMessages.length = 0;

  await h.run("research");
  assert.equal(notifyTexts(h.pi).some((t) => t.includes(ALREADY_ACTIVE_NOTIFY)), false, "already-active branch must not answer");
  assert.equal(researchKickoffs(h.pi).length, 1, "research kickoff is sent while the mode is on");
});

test("bare research closes a closable briefing campaign and proceeds; --id of the now-stopped campaign refuses", async () => {
  const dir = makeWorkDir("guard");
  const campaignDir = writeCampaignState(dir, "c1", "briefing");
  const h = await loadExtension(dir, "guard");
  await h.run("research");

  assert.equal(JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8")).phase, "stopped");
  assert.match(fs.readFileSync(path.join(campaignDir, "log.jsonl"), "utf8"), /"event":"abandon"/);
  assert.match(fs.readFileSync(path.join(campaignDir, "report.md"), "utf8"), /CLOSED AS STALE/);
  assert.equal(activationEntries(h.pi).length, 1, "launch activation recorded");
  assert.equal(researchKickoffs(h.pi).length, 1, "launch kickoff sent");
  assert.match(researchKickoffs(h.pi)[0].text, /Research campaign: briefing phase/);

  await h.run("research --id c1");
  assert.ok(notifyTexts(h.pi).some((t) => /stopped \(terminal\)/.test(t)), "stopped campaign refusal notified");
  assert.equal(activationEntries(h.pi).length, 1, "stopped --id refusal records no second activation");
});

test("bare research with an existing closable briefing campaign closes it and proceeds even when the mode is already on", async () => {
  const dir = makeWorkDir("guard-on");
  const h = await loadExtension(dir, "guard-on");
  await h.run("on");
  const campaignDir = writeCampaignState(dir, "c1", "briefing");
  h.pi.notifications.length = 0;
  h.pi.sentMessages.length = 0;
  const activationsBefore = activationEntries(h.pi).length;

  await h.run("research");

  assert.equal(JSON.parse(fs.readFileSync(path.join(campaignDir, "state.json"), "utf8")).phase, "stopped");
  assert.match(fs.readFileSync(path.join(campaignDir, "log.jsonl"), "utf8"), /"event":"abandon"/);
  assert.match(fs.readFileSync(path.join(campaignDir, "report.md"), "utf8"), /CLOSED AS STALE/);
  assert.equal(researchKickoffs(h.pi).length, 1, "research kickoff sent");
  assert.equal(activationEntries(h.pi).length, activationsBefore + 1, "successful research launch records activation");
});

test("free-text 'optimize research habits' stays on the legacy metric-loop path", async () => {
  const dir = makeWorkDir("optimize-alias-free");
  const h = await loadExtension(dir, "optimize-alias-free");
  await h.run("optimize research habits");

  assert.equal(notifyTexts(h.pi).some((t) => t.includes(RESEARCH_NOTIFY)), false, "no research mode notify");
  assert.equal(h.pi.sentMessages.length, 1, "exactly one legacy kickoff is sent");
  const text = h.pi.sentMessages[0].text;
  assert.equal(text.includes("research_brief draft"), false, "not the research kickoff");
  assert.match(text, /\/skill:autoresearch-create optimize research habits/, "legacy metric-loop kickoff carries the full goal");
});

// ─── registration ───────────────────────────────────────────────────────────

test("'research' is registered in SUBCOMMANDS and in the help and completion lists", () => {
  assert.ok(SUBCOMMANDS.some((s) => s.name === "research"), "SUBCOMMANDS has research");
  assert.match(renderAutoresearchHelp(), /^\s*research\s+Start a research campaign/m, "help lists research");
  assert.ok(filterSubcommands("res").some((s) => s.value === "research"), "completion offers research");
});
