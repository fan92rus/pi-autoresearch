import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createFakePi, makeCtx } from "./fake-pi.ts";
import * as chainJournal from "../extensions/pi-autoresearch/chain-journal.ts";

/* Expedition direction nudges (bd pi-autoresearch-es1.6 follow-up): after a
 * direction is closed (resolve/reject/advisory/park) while the campaign is in
 * research, the tool reply must push the agent to keep the expedition moving:
 * activate an open direction, open a new one from the findings, reopen a
 * parked one, or finish the campaign honestly. The agent stalled on the bare
 * "Expedition map recorded" reply in the live lob-collector-data run. */

const rulesFor = (id) => [
  { id: `${id}-yes`, verdict: "confirmed", when: "effect is present" },
  { id: `${id}-no`, verdict: "rejected", when: "effect is absent" },
  { id: `${id}-unknown`, verdict: "inconclusive", when: "data are noisy" },
  { id: `${id}-wait`, verdict: "waiting_for_data", when: "data are missing" },
];
const brief = {
  schema_version: 1, goal: "Nudge territory", plan_source: "plan.md", caveat_block: "Observational only.",
  data_roles: { explore: ["evidence.txt"], validate: ["evidence.txt"], confirm: [] },
  questions: ["Q1", "Q2"].map((id) => ({ id, text: `Question ${id}?`, decision_rules: rulesFor(id), needs_data: null })),
  process_metrics: [], stop_rules: [{ id: "S1", when: "all questions closed" }],
};
const doc = (directions) => ({
  charter: { stop_rules: [] },
  goal: "Nudge territory",
  directions,
  campaign0: brief,
});
const text = (r) => r?.content?.[0]?.text ?? "";

async function setup(directions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-nudge-"));
  fs.writeFileSync(path.join(dir, "evidence.txt"), "evidence\n");
  const { pi, tool, command, hook } = createFakePi({ dir, sessionId: "exp-nudge", realGit: false });
  const ctx = makeCtx(dir, "exp-nudge", pi);
  ctx.ui.confirm = async () => true;
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  const call = (name, params) => tool(name).execute("id", params, null, null, ctx);
  await command("autoresearch").handler("expedition goal", ctx);
  await call("expedition_brief", { action: "draft", doc: doc(directions) });
  const proposed = await call("expedition_brief", { action: "propose" });
  const campaignId = text(proposed).match(/campaign (exp-[A-Za-z0-9-]+)/)?.[1];
  assert.ok(campaignId, text(proposed));
  const chainId = `${campaignId}-chain`;
  const chainDir = chainJournal.chainDir(dir, chainId);
  assert.ok(chainDir);
  return { dir, ctx, pi, call, chainId, chainDir, campaignId, hook };
}

/** Activates a direction on the campaign and closes one question with evidence
 *  so refs for a direction resolve are proven in the chain journals. */
async function activateAndCloseQuestion(h, dirName) {
  await chainJournal.appendEntry(h.chainDir, h.dir, h.chainId, "direction_activated", { dir: dirName, why: "Start", campaign: h.campaignId });
  const campaignDir = path.join(h.dir, ".auto", "research", h.campaignId);
  // start phase research
  const sha = (await import("node:crypto")).createHash("sha256")
    .update(fs.readFileSync(path.join(campaignDir, "brief.json"))).digest("hex");
  await h.call("research", { action: "start", expected_sha256: sha });
  await h.call("research", { action: "open", question_id: "Q1" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  return campaignDir;
}

test("resolve with an open direction left: step-1 nudge opens vectors from findings first; activation framed as the SEPARATE later priority step; NO stop", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "second", why: "Second" }]);
  await activateAndCloseQuestion(h, "first");
  const out = await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const reply = text(out);
  assert.match(reply, /Expedition map recorded: resolve first/);
  assert.match(reply, /Step 1/i);
  assert.match(reply, /if the findings support a new testable hypothesis/);
  assert.match(reply, /subaction=open, dir=<new name>, why=<finding>/, "opening from findings is step 1");
  assert.match(reply, /Step 2/i);
  assert.match(reply, /subaction=activate, dir=<chosen>/, "activation is a separate priority choice among the accumulated open directions");
  assert.doesNotMatch(reply, /subaction=activate, dir=second/, "do NOT pair activate with a specific leftover direction in the same step");
  assert.doesNotMatch(reply, /action=stop/, "stop is NEVER offered while open candidates exist");
  assert.doesNotMatch(reply, /open the next direction/i);
}, { timeout: 60000 });

test("resolve of the last active with only parked left: open-from-findings + reopen example, next-brief path (Q2 open), stop NOT mentioned", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "other", why: "Other" }]);
  await activateAndCloseQuestion(h, "first");
  await chainJournal.appendEntry(h.chainDir, h.dir, h.chainId, "direction_parked", { dir: "other", reason: "Waiting" });
  const out = await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const reply = text(out);
  assert.match(reply, /Step 1/i);
  assert.match(reply, /subaction=open, dir=<new name>, why=<finding>/);
  assert.match(reply, /subaction=reopen, dir=other/, "the parked direction is the reopen example");
  assert.match(reply, /research_brief draft/, "no open direction and Q2 still open → next chain campaign");
  assert.doesNotMatch(reply, /action=stop/, "stop not offered: questions remain open");
}, { timeout: 60000 });

test("resolve of the last active with all directions closed and ALL questions closed: exhaustion — open-from-findings or stop IS the valid outcome + steer", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  // close Q2 as well: full exhaustion (no candidates AND no open questions)
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  const before = h.pi.sentMessages.length;
  const out = await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const reply = text(out);
  assert.match(reply, /Expedition map recorded: resolve first/);
  assert.match(reply, /if the findings support a new testable hypothesis/, "opening a new direction is conditioned on the results");
  assert.match(reply, /subaction=open, dir=<new name>, why=<finding>/);
  assert.match(reply, /research_questions\(action=stop/);
  assert.match(reply, /valid outcome/);
  assert.doesNotMatch(reply, /open the next direction/i);
  // Steer: the agent may end the turn on the tool reply; a continuation presents the same decision.
  assert.equal(h.pi.sentMessages.length, before + 1, "exactly one nudge steer sent");
  const steer = h.pi.sentMessages[h.pi.sentMessages.length - 1];
  assert.match(steer.text, /subaction=open, dir=<new name>/);
  assert.match(steer.text, /research_questions\(action=stop/);
  assert.match(steer.text, /valid outcome/);
}, { timeout: 60000 });

test("no candidates left but questions still open: steer to the NEXT campaign brief, not to stop", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first"); // Q2 remains OPEN
  const before = h.pi.sentMessages.length;
  const out = await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const reply = text(out);
  assert.match(reply, /subaction=open, dir=<new name>, why=<finding>/, "opening from findings stays an option");
  assert.match(reply, /research_brief draft/, "campaign not exhausted (Q2 open): continue via the next chain campaign brief");
  assert.doesNotMatch(reply, /action=stop/, "stop is NOT offered while questions remain open");
  assert.equal(h.pi.sentMessages.length, before + 1);
}, { timeout: 60000 });

test("park of the last active: open-from-findings/reopen options, next-campaign-brief path, no stop (Q2 open) + steer", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  const before = h.pi.sentMessages.length;
  const out = await h.call("research", { action: "expedition", subaction: "park", dir: "first", reason: "No signal yet" });
  const reply = text(out);
  assert.match(reply, /Step 1/i);
  assert.match(reply, /subaction=open, dir=<new name>, why=<finding>/);
  assert.match(reply, /subaction=reopen, dir=first/, "the parked direction itself is the reopen example");
  assert.match(reply, /research_brief draft/, "questions still open → next chain campaign, not stop");
  assert.doesNotMatch(reply, /action=stop/, "stop is NOT offered while brief questions remain open");
  assert.equal(h.pi.sentMessages.length, before + 1, "steer sent for park of the last active too");
}, { timeout: 60000 });

test("steer re-arms per closing EVENT: two activate→resolve cycles each deliver exactly one steer (review blocker B2/B3)", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "second", why: "Second" }]);
  await activateAndCloseQuestion(h, "first");
  const before = h.pi.sentMessages.length;
  // Cycle 1: close the active "first" ("second" stays open) → suffix nudge + steer (no active left).
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  assert.equal(h.pi.sentMessages.length, before + 1, "cycle 1 delivered its steer");
  // Cycle 2: activate "second" (re-arms the flag) and close it with proven refs.
  await h.call("research", { action: "expedition", subaction: "activate", dir: "second", why: "Next candidate" });
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "second", refs: [{ campaign: h.campaignId, question: "Q2" }] });
  assert.equal(h.pi.sentMessages.length, before + 2, "cycle 2 ALSO delivered its steer: the steer is per closing EVENT, not once per chain");
  // Mutation guard: removing the sendWhenReady call (or throttling it behind a once-per-chain
  // flag) swallows cycle 2's steer and the second assertion fails; sending twice per event
  // inflates cycle 1 past +1 and the first assertion fails.
}, { timeout: 90000 });

test("no nudge outside the research phase: bare reply for a stopped campaign (regression)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  const campaignDir = await activateAndCloseQuestion(h, "first");
  const statePath = path.join(campaignDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), phase: "stopped" }, null, 2) + "\n");
  const before = h.pi.sentMessages.length;
  const out = await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  assert.equal(text(out), "Expedition map recorded: resolve first.", "stopped campaign: reply stays bit-identical, no nudge");
  assert.equal(h.pi.sentMessages.length, before, "no steer for a non-research campaign phase");
}, { timeout: 60000 });

test("activate keeps the bare reply (no nudge on non-closing transitions)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  const sha = (await import("node:crypto")).createHash("sha256")
    .update(fs.readFileSync(path.join(h.dir, ".auto", "research", h.campaignId, "brief.json"))).digest("hex");
  await h.call("research", { action: "start", expected_sha256: sha });
  const out = await h.call("research", { action: "expedition", subaction: "activate", dir: "first", why: "Go" });
  assert.equal(text(out), "Expedition map recorded: activate first.");
}, { timeout: 60000 });

test("closing the last open question adds the map-direction close hint in an expedition — WITHOUT the premature stop suggestion", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  const campaignDir = await activateAndCloseQuestion0(h);
  // Q1 already closed inside activateAndCloseQuestion0 → the close reply carries the map hint.
  // Review blocker B1: in an expedition the legacy "pick a stop rule" text MUST NOT appear
  // (stop is legal only in the post-close nudge's exhaustion branch); the map hint routes
  // the agent to resolve/open instead.
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  const closeOut = await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  const reply = text(closeOut);
  assert.match(reply, /expedition_map\(subaction=resolve, dir=<name>, refs=/, "map close hint after the last question");
  assert.match(reply, /question close is not direction resolve/i);
  assert.doesNotMatch(reply, /pick a stop rule/i, "review blocker B1: no premature stop suggestion in an expedition");
  void campaignDir;
}, { timeout: 60000 });

test("close of a non-final question keeps the old nudge-free reply (regression)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  const sha = (await import("node:crypto")).createHash("sha256")
    .update(fs.readFileSync(path.join(h.dir, ".auto", "research", h.campaignId, "brief.json"))).digest("hex");
  await h.call("research", { action: "start", expected_sha256: sha });
  await h.call("research", { action: "open", question_id: "Q1" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  const out = await h.call("research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  assert.doesNotMatch(text(out), /expedition_map\(subaction=resolve/, "map hint only after ALL questions are closed");
  assert.doesNotMatch(text(out), /All questions are closed/i, "Q2 still open in this brief");
}, { timeout: 60000 });

test("final expedition stop reply lists the unexhausted territory and the next-expedition path", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "later", why: "Later" }]);
  await activateAndCloseQuestion(h, "first");
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const stopped = await h.call("research", { action: "chain_stop", rule_id: "nonexistent-not-used" }).catch(() => null);
  // rule id above is invalid on purpose: use the owner path (confirm=true) instead
  const ownerStop = await h.call("research", { action: "chain_stop" });
  const reply = text(ownerStop);
  assert.match(reply, /stopped by the owner/i);
  assert.match(reply, /1 direction\(s\) remain: later \(open\)/, "territory summary with names and statuses");
  assert.match(reply, /expedition_brief draft/);
}, { timeout: 60000 });

test("final expedition stop reply stays clean when the territory is exhausted", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const ownerStop = await h.call("research", { action: "chain_stop" });
  const reply = text(ownerStop);
  assert.match(reply, /stopped by the owner/i);
  assert.doesNotMatch(reply, /expedition_brief draft/, "no next-expedition push when nothing is left");
  assert.doesNotMatch(reply, /remain/);
}, { timeout: 60000 });

/** Helper variant that closes only Q1 of the two-question brief used by the
 *  map-hint tests (Q2 stays open until the test closes it). */
async function activateAndCloseQuestion0(h) {
  await chainJournal.appendEntry(h.chainDir, h.dir, h.chainId, "direction_activated", { dir: "first", why: "Start", campaign: h.campaignId });
  const campaignDir = path.join(h.dir, ".auto", "research", h.campaignId);
  const sha = (await import("node:crypto")).createHash("sha256")
    .update(fs.readFileSync(path.join(campaignDir, "brief.json"))).digest("hex");
  await h.call("research", { action: "start", expected_sha256: sha });
  await h.call("research", { action: "open", question_id: "Q1" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q1", rule_id: "Q1-yes", verdict: "confirmed" });
  return campaignDir;
}

test("drift resume in an expedition with live directions: expedition continuation, NO legacy 'pick a stop rule' (review blocker)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first"); // first=active, Q2 still open
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  // A turn that did no loop work → drift resume. The expedition has an ACTIVE
  // direction and open "second"?? none here — first is still active, so the
  // message must prescribe expedition continuation, not a campaign stop.
  await h.hook("agent_start")({}, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const last = h.pi.sentMessages[h.pi.sentMessages.length - 1]?.text ?? "";
  assert.match(last, /Last turn did no research-campaign work/);
  assert.match(last, /Continue the expedition now/, "expedition branch must replace the legacy selection");
  assert.match(last, /expedition_map/, "nudge content (open/activate/reopen) is carried into the drift resume");
  assert.doesNotMatch(last, /pick a stop rule/i, "review blocker: no premature stop in the drift path");
}, { timeout: 90000 });

test("unverifiable campaign snapshot in drift falls back to the safe legacy resume (no stop) — review R1B P1", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  // Corrupt the brief AFTER closing Q2 and resolving the direction: the map
  // has no active/open, the state.json is healthy, but the question state is
  // UNVERIFIABLE. The exhaustion stop branch MUST be suppressed: the drift
  // nudge continues with the safe next-campaign-brief path instead.
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  fs.writeFileSync(path.join(h.dir, ".auto", "research", h.campaignId, "brief.json"), "{ broken");
  await h.hook("agent_start")({}, h.ctx);
  await h.hook("agent_end")({ messages: [] }, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const last = h.pi.sentMessages[h.pi.sentMessages.length - 1]?.text ?? "";
  assert.match(last, /Continue the expedition now/, "expedition branch still guides (safe brief path)");
  assert.match(last, /research_brief draft/, "unknown question state -> next-campaign brief path, not stop");
  assert.doesNotMatch(last, /action=stop/, "unknown question state must NEVER suggest a stop");
}, { timeout: 90000 });

test("park of an OPEN direction with no active before it sends NO steer (review R1B P2)", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "second", why: "Second" }]);
  await activateAndCloseQuestion(h, "first");
  // Cycle 1: resolve the active "first" → qualifying event → exactly 1 steer.
  const before = h.pi.sentMessages.length;
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  assert.equal(h.pi.sentMessages.length, before + 1, "resolve of the active direction steers");
  // Event 2: park the OPEN "second" — no active existed before this event, so
  // this is not a "last active closed" event and must not steer.
  await h.call("research", { action: "expedition", subaction: "park", dir: "second", reason: "Deprioritized" });
  assert.equal(h.pi.sentMessages.length, before + 1, "park of an open direction does NOT steer (reply nudge still present)");
  const reply = text((await h.call("research", { action: "expedition", subaction: "status" })));
  assert.match(reply, /second/);
}, { timeout: 90000 });

test("reject triggers the nudge too (wiring list regression, review R1C P2)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  const out = await h.call("research", { action: "expedition", subaction: "reject", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const reply = text(out);
  assert.match(reply, /Expedition map recorded: reject first/);
  assert.match(reply, /Step 1/i, "reject is a closing event: nudge present");
  assert.doesNotMatch(reply, /action=stop/);
}, { timeout: 90000 });

test("advisory triggers the nudge too (wiring list regression, review R1C/R2 P2)", async () => {
  const h = await setup([{ name: "first", why: "First" }]);
  await activateAndCloseQuestion(h, "first");
  // advisory requires an existing review file with matching sha256 (validator)
  const reviewPath = path.join(h.dir, "review.md");
  fs.writeFileSync(reviewPath, "# review\n");
  const sha = createHash("sha256").update(fs.readFileSync(reviewPath)).digest("hex");
  const out = await h.call("research", { action: "expedition", subaction: "advisory", dir: "first", review_ref: reviewPath, review_sha256: sha });
  const reply = text(out);
  assert.match(reply, /Expedition map recorded: advisory first/, "advisory close recorded");
  assert.match(reply, /Step 1/i, "advisory is a closing event: nudge present");
  assert.doesNotMatch(reply, /action=stop/);
}, { timeout: 90000 });

test("activate on an EXHAUSTED campaign (every question closed) is refused with the brief-next hint — live lob-collector-data stall", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "second", why: "Second" }]);
  const campaignDir = await activateAndCloseQuestion(h, "first");
  // close Q2 too: now EVERY brief question is closed while phase is research
  await h.call("research", { action: "open", question_id: "Q2" });
  await h.call("research", { action: "record", evidence_ref: "evidence.txt:1" });
  await h.call("research", { action: "close", question_id: "Q2", rule_id: "Q2-yes", verdict: "confirmed" });
  // resolve the finished direction (all questions closed — refs are proven)
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  // the agent tries the live-stall move: open + activate the next direction on the SAME exhausted campaign
  await h.call("research", { action: "expedition", subaction: "open", dir: "third", why: "From the findings" });
  const out = await h.call("research", { action: "expedition", subaction: "activate", dir: "third", why: "Next priority" });
  const reply = text(out);
  assert.match(reply, /campaign_exhausted/, "the exhausted-campaign activation is refused");
  assert.match(reply, /every brief question closed/, "the refusal names the condition");
  assert.match(reply, /research_brief draft/, "the refusal teaches the honest next step");
}, { timeout: 90000 });

test("activate with an OPEN question on the pinned campaign still works (no false positive)", async () => {
  const h = await setup([{ name: "first", why: "First" }, { name: "second", why: "Second" }]);
  await activateAndCloseQuestion(h, "first"); // Q2 remains open
  await h.call("research", { action: "expedition", subaction: "resolve", dir: "first", refs: [{ campaign: h.campaignId, question: "Q1" }] });
  const out = await h.call("research", { action: "expedition", subaction: "activate", dir: "second", why: "Next" });
  const reply = text(out);
  assert.doesNotMatch(reply, /campaign_exhausted/, "an open question keeps activation legal");
}, { timeout: 90000 });
