// council-loop.js — Stagnation Council orchestration as a pi-subagents workflow
// script (the pi-agile "workflow in a file" pattern). The extension hands in
// everything static via args (the sandbox has NO filesystem and NO tools).
//
// FILELESS DISPUTE: nothing is written to disk during the council. Every child
// returns its full text in chat (the script relays it), consensus is computed
// IN-SCRIPT from VERDICT lines, and the chair returns the slate as text. The
// extension persists only the final slate (audit + resume detection).
//
// Relaunching the same script with the same args reuses finished children
// (engine-native reuse), so a crash/relaunch resumes cheaply.
//
// Args:
//   briefText          (string, required) the mechanical brief, inlined
//   participants       (array, required) [{ name, letter, model, personaPrompt }]
//   chairModel         (string, required) model for the chair child
//   maxChallengeRounds (number, default 5) cap on challenge rounds
//   minExperiments     (number, default 3) settled hypotheses needed to converge
//   note               (string, default "") the lead agent's note (context only)
//   chairFix           (string, default "") slate-validation errors from a
//                      previous chair attempt — the chair revises its slate
//
// Return: a "COUNCIL_RESULT:{...}" JSON string (the extension parses it out of
// the tool-result text): { ok, slate?, reason?, detail?, unavailable, rounds,
//                          consensus: { settledCount, contestedCount, canConverge } }
"use strict";

const briefText = String(args.briefText || "");
const participants = Array.isArray(args.participants) ? args.participants : [];
const chairModel = String(args.chairModel || "");
const maxChallengeRounds = Math.min(Math.max(Number(args.maxChallengeRounds) || 5, 1), 10);
const minExperiments = Math.max(Number(args.minExperiments) || 3, 1);
const note = String(args.note || "");
const chairFix = String(args.chairFix || "");

function emitLine(line) { emit("[council-loop] " + line); }

// ─── In-script mechanical parsing (no tools, no filesystem) ────────────────

function parseHyps(text) {
  const out = [];
  const re = /^###\s*(H-[A-Za-z]\d+)\s*:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({ id: m[1].toUpperCase(), title: m[2].trim().slice(0, 120) });
  }
  return out;
}

function parseVerdicts(text, speaker) {
  const out = [];
  const re = /^VERDICT\s+(H-[A-Za-z]\d+)\s*:\s*(accept|reject|refine)\b/gim;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({ id: m[1].toUpperCase(), verdict: m[2].toLowerCase(), speaker });
  }
  return out;
}

function childText(res) { return res && typeof res === "object" ? String(res.output || "") : String(res || ""); }

// Latest-verdict-wins consensus over the collected verdict records.
const consensusReport = () => {
  const latest = {};
  for (const v of verdictRecords) {
    if (!latest[v.id]) latest[v.id] = {};
    latest[v.id][v.speaker] = v.verdict;
  }
  const hypotheses = hypothesisTexts.map((h) => {
    const owner = live.find((p) => p.letter.toUpperCase() === h.id.charAt(2).toUpperCase()) || null;
    const voters = owner ? live.filter((p) => p.name !== owner.name) : live.slice();
    const given = voters.map((p) => (latest[h.id] ? latest[h.id][p.name] : undefined));
    const settled = voters.length > 0 && given.every((v) => v === "accept" || v === "reject");
    return { id: h.id, title: h.title, settled };
  });
  const settledCount = hypotheses.filter((h) => h.settled).length;
  return {
    hypotheses,
    settledCount,
    contestedCount: hypotheses.length - settledCount,
    canConverge: settledCount >= minExperiments && settledCount === hypotheses.length,
  };
};

// ─── Child task builders ─────────────────────────────────────────────────────

function divergeTask(p) {
  const lines = [
    "You are " + p.name + " (hypothesis letter " + p.letter + ") in a hypothesis council for an optimization campaign.",
    "Your lens: " + p.personaPrompt,
    "",
    "CAMPAIGN BRIEF (mechanical digest — do not assume anything not written here):",
    "<<<BRIEF",
    briefText,
    "BRIEF>>>",
  ];
  if (note) lines.push("", "Context from the lead agent (its own assessment, not evidence): " + note);
  lines.push(
    "",
    "You may also study the problem in the project yourself — look around freely, just don't dig in:",
    "  a quick orientation pass (project layout, the benchmarked source and the measure script, tail of .auto/log.jsonl, git log --oneline if this is a repo), not an audit.",
    "  Cite exact file:line for anything you take from the code.",
    "  Two hard lines: don't run builds or benchmarks (the campaign executes experiments, not you), don't write files.",
    "Also use codex_search (a handful of targeted queries) to ground your hypotheses in external knowledge: established techniques, prior art, known pitfalls. Skip it only if the tool is missing.",
    "If the brief lacks a fact you need or contradicts what you see, say so explicitly.",
    "",
    "Propose EXACTLY 3 experiment hypotheses. Start EACH with this exact header line:",
    "### H-" + p.letter + "<N>: <short title>",
    "<why this could work, grounded in facts; expected effect vs noise; cost/complexity; kill condition>",
    "",
    "Reply with your FULL proposal text in chat (it is relayed to the other analysts verbatim). No file writes, no persistence.",
  );
  return lines.join("\n");
}

function challengeTask(p, round, contested, othersText) {
  const lines = [
    "You are " + p.name + " (hypothesis letter " + p.letter + ") in CHALLENGE round " + round + " of a hypothesis council.",
    "The analysts' proposals follow (verbatim).",
    "",
    othersText,
    "",
  ];
  if (round > 1 && contested.length) {
    lines.push("This round addresses ONLY the still-contested hypotheses: " + contested.join(", ") + ".", "");
  }
  const scope = round > 1 && contested.length
    ? "For every STILL-CONTESTED hypothesis not authored by you (" + contested.join(", ") + "), add one verdict line:"
    : "For EVERY hypothesis NOT authored by you, add one verdict line:";
  lines.push(
    scope,
    "VERDICT H-<letter><n>: accept — <reason>   (or reject / refine)",
    "Base verdicts on facts: expected effect vs noise floor, cost, risk, kill condition. Do not accept because it sounds confident; do not reject to disagree. For refine, name exactly what must change.",
    "You may look at the project yourself when a verdict hinges on code reality — look around freely, just don't rabbit-hole; never run builds or benchmarks, never write files.",
    "codex_search is fair game when a verdict hinges on prior art or external facts — again, without rabbit-holing.",
    "",
    "Reply with ONLY your verdict lines (VERDICT ...) plus, if useful, one short improvement paragraph per refined hypothesis. No file writes.",
  );
  return lines.join("\n");
}

function chairTask(allProposals, allVerdicts) {
  const lines = [
    "You are the CHAIR of a hypothesis council. You read the whole record and compose the final slate.",
    "",
    "=== CAMPAIGN BRIEF ===",
    briefText,
  ];
  if (note && !chairFix) lines.push("=== LEAD AGENT'S NOTE (its own assessment, not evidence) ===", note);
  lines.push(
    "=== ANALYST PROPOSALS ===",
    allProposals,
    "=== CHALLENGE VERDICTS (rounds in order) ===",
    allVerdicts,
    "",
  );
  if (chairFix) {
    lines.push("IMPORTANT — your previous slate FAILED mechanical validation. Compose a CORRECTED slate. Fix exactly these problems:", chairFix, "");
  }
  lines.push(
    "Compose the slate: 3–5 experiments distilled from the hypotheses that reached consensus (merge duplicates into one experiment; drop rejected ones).",
    "Each experiment section MUST look like:",
    "## EXP<N>: <title> (source hypotheses)",
    "CHANGE: <what exactly changes in the code>",
    "EXPECTED_GAIN: <number> <unit> (must be >= 2x the noise floor; if the brief has no noise floor, gate this experiment on measuring it first and say so)",
    "KILL_WHEN: <observation that makes you abandon it>",
    "PRIORITY: <number> (diagnostics first — a measurement that gates the rest is run first)",
    "",
    "Rules: preserve exact computation and output (no benchmark gaming); instrumentation never goes into the benchmarked source; every experiment needs a kill condition.",
    "Reply with ONLY the full slate markdown — no preamble, no file writes.",
  );
  return lines.join("\n");
}

// ─── Orchestration ───────────────────────────────────────────────────────────

if (!briefText || participants.length === 0) {
  return "COUNCIL_RESULT:" + JSON.stringify({ ok: false, reason: "bad-args", detail: "briefText and participants are required" });
}

const unavailable = [];
const live = participants.slice();
const MAX_ATTEMPTS = 3; // initial + 2 retries (approved behavior)
const proposalTexts = {}; // name -> full diverge output
const hypothesisTexts = []; // { id, title }
const verdictRecords = []; // { id, verdict, speaker } in arrival order

// ── Phase 1 — Diverge (chat outputs only) ──
emitLine("phase 1: diverge (" + live.length + " analysts)");
// Children run as agent "delegate": its strict core-tool allowlist never
// references ambient extension tools, so foreground children cannot die at
// startup the way extension-referencing profiles (scout + advisor/codemode…)
// do. The task text carries the full role; missing optional tools (e.g.
// codex_search) are skipped gracefully by the child.
const firstBatch = await runs.all(live.map((p) => ({
  key: "diverge-" + p.name + "-a1",
  agent: "delegate",
  model: p.model,
  task: divergeTask(p),
})));
live.forEach((p, i) => { proposalTexts[p.name] = childText(firstBatch[i]); });

for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
  const absent = live.filter((p) => parseHyps(proposalTexts[p.name] || "").length === 0);
  if (absent.length === 0) break;
  emitLine("diverge retry " + (attempt - 1) + " for: " + absent.map((p) => p.name).join(", "));
  const results = await runs.all(absent.map((p) => ({
    key: "diverge-" + p.name + "-a" + attempt,
    agent: "delegate",
    model: p.model,
      task: divergeTask(p),
  })));
  absent.forEach((p, i) => {
    const text = childText(results[i]);
    if (text) proposalTexts[p.name] = text;
  });
}
for (const p of participants.slice()) {
  if (parseHyps(proposalTexts[p.name] || "").length === 0) {
    unavailable.push(p.name);
    live.splice(live.indexOf(p), 1);
    emitLine(p.name + " UNAVAILABLE after " + MAX_ATTEMPTS + " attempts");
  }
}
if (live.length < 2) {
  return "COUNCIL_RESULT:" + JSON.stringify({
    ok: false,
    reason: "quorum",
    detail: "fewer than 2 analysts delivered proposals (unavailable: " + unavailable.join(", ") + ") — council not held",
    unavailable,
  });
}
for (const p of live) {
  for (const h of parseHyps(proposalTexts[p.name])) hypothesisTexts.push({ id: h.id, title: h.title });
}

// ── Phase 2 — Challenge rounds (verdicts in chat, consensus in-script) ──
let consensus = { hypotheses: [], settledCount: 0, contestedCount: 0, canConverge: false };
let roundsUsed = 0;
let contested = [];
for (let round = 1; round <= maxChallengeRounds; round++) {
  roundsUsed = round;
  emitLine("phase 2: challenge round " + round + " (" + live.length + " analysts" + (contested.length ? ", contested: " + contested.join(",") : "") + ")");
  const othersText = live.map((p) => "### Proposals by " + p.name + ":\n" + (proposalTexts[p.name] || "(none)")).join("\n\n");
  const results = await runs.all(live.map((p) => ({
    key: "challenge-r" + round + "-" + p.name + "-a1",
    agent: "delegate",
    model: p.model,
      task: challengeTask(p, round, contested, othersText),
  })));
  results.forEach((res, i) => {
    for (const v of parseVerdicts(childText(res), live[i].name)) verdictRecords.push(v);
  });
  consensus = consensusReport();
  contested = consensus.hypotheses.filter((h) => !h.settled).map((h) => h.id);
  if (consensus.canConverge) {
    emitLine("consensus reached at round " + round);
    break;
  }
  if (round === maxChallengeRounds) emitLine("rounds exhausted without consensus — chair decides best-effort");
}

// ── Phase 3 — Chair slate (chat output; the extension validates + persists) ──
emitLine("phase 3: chair slate");
const allProposals = live.map((p) => "--- " + p.name + " (" + p.letter + ") ---\n" + (proposalTexts[p.name] || "(none)")).join("\n\n");
const allVerdicts = verdictRecords.map((v) => "VERDICT " + v.id + ": " + v.verdict + " — by " + v.speaker).join("\n");
const chairRes = childText(await runs.run("chair-a1", { agent: "delegate", model: chairModel, task: chairTask(allProposals, allVerdicts) }));
const slate = chairRes.trim();

if (!slate || !/##\s*EXP/i.test(slate)) {
  return "COUNCIL_RESULT:" + JSON.stringify({
    ok: false,
    reason: "no-slate",
    detail: "the chair did not return a slate",
    unavailable,
    rounds: roundsUsed,
    consensus,
  });
}

return "COUNCIL_RESULT:" + JSON.stringify({
  ok: true,
  slate,
  unavailable,
  rounds: roundsUsed,
  consensus,
});
