// council-delegation.ts — single-step Stagnation Council orchestration.
//
// Runs the whole council (diverge → challenge rounds → chair → validation
// with one corrective chair re-run) INSIDE the council_convene tool call by
// delegating every child through pi-subagents' structured delegation API
// (prompt-template:subagent:* event family — the documented extension
// integration seam). No workflow file, no model-mediated round trips, no
// blackboard writes during the dispute: children return their proposals,
// verdicts and the slate as chat text; all parsing and consensus counting is
// mechanical, here.
//
// Fallback when the delegation seam is unavailable: the manual facilitator
// protocol (composeFacilitatorMessage) stays the degrade path.

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Minimal structural types (no pi-coding-agent import — keeps council.ts's no-pi rule) ───

/** The slice of ExtensionAPI the delegation seam needs. */
export interface DelegationPi {
  events: {
    on(name: string, handler: (payload: unknown) => void): unknown;
    off?(name: string, handler: unknown): void;
    emit(name: string, payload: unknown): void;
  };
}

export interface DelegationParticipant {
  name: string;
  letter: string;
  model: string;
  personaPrompt: string;
}

export interface CouncilDelegationArgs {
  seq: number;
  briefText: string;
  participants: DelegationParticipant[];
  chairModel: string;
  maxChallengeRounds: number;
  minExperiments: number;
  note?: string;
  cwd: string;
  /** Absolute wall-clock deadline for the whole council. */
  deadlineAt: number;
  /** Mechanical slate validator (validateSlate from council.ts, pre-bound). */
  validate: (slate: string) => { ok: boolean; errors?: string[] };
  onLog?: (line: string) => void;
}

export type CouncilOutcome =
  | { ok: true; slate: string; unavailable: string[]; rounds: number; consensus: ConsensusReport; corrected: boolean }
  | {
      ok: false;
      reason: "quorum" | "no-slate" | "deadline" | "delegation";
      detail: string;
      unavailable: string[];
      rounds: number;
      consensus: ConsensusReport | null;
      /** True when every analyst failed with unavailable_context — the delegation seam itself is dead (e.g. SDK-hosted sessions), not the models. */
      seamUnavailable?: boolean;
    };

interface ConsensusHypothesis { id: string; title: string; settled: boolean }
interface ConsensusReport {
  hypotheses: ConsensusHypothesis[];
  settledCount: number;
  contestedCount: number;
  canConverge: boolean;
}
interface VerdictRecord { id: string; verdict: "accept" | "reject" | "refine"; speaker: string }

interface TerminalResponse {
  status: string;
  result?: { kind: "text"; text?: string } | { kind: "structured"; value?: unknown };
  error?: string;
}

// ─── Delegation client: one subscription, requests routed by requestId ───

const RESPONSE_EVENT = "prompt-template:subagent:request";
const RESPONSE_EVENT_REPLY = "prompt-template:subagent:response";

export function delegationAvailable(pi: unknown): pi is DelegationPi {
  const ev = (pi as { events?: { on?: unknown; emit?: unknown } })?.events;
  return !!(ev && typeof ev.on === "function" && typeof ev.emit === "function");
}

interface PendingCall {
  resolve: (r: TerminalResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createDelegationClient(pi: DelegationPi) {
  const pending = new Map<string, PendingCall>();
  const handler = (payload: unknown) => {
    const r = payload as Partial<TerminalResponse> & { requestId?: string };
    if (!r || typeof r.requestId !== "string") return;
    const call = pending.get(r.requestId);
    if (!call) return;
    pending.delete(r.requestId);
    clearTimeout(call.timer);
    call.resolve({ status: String(r.status ?? "failed"), result: r.result as TerminalResponse["result"], error: r.error });
  };
  pi.events.on(RESPONSE_EVENT_REPLY, handler);
  let disposed = false;
  return {
    /** Fire one delegated child and await its terminal response. */
    run(req: {
      requestId: string;
      ownerRunId: string;
      nodeId: string;
      agent: string;
      task: string;
      model?: string;
      cwd: string;
      timeoutMs: number;
    }): Promise<TerminalResponse> {
      if (disposed) return Promise.resolve({ status: "failed", error: "delegation client disposed" });
      return new Promise<TerminalResponse>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(req.requestId);
          resolve({ status: "timed_out", error: "no terminal response within timeoutMs" });
        }, req.timeoutMs + 15_000); // grace over the child-side timeout
        pending.set(req.requestId, { resolve, timer });
        pi.events.emit(RESPONSE_EVENT, {
          requestId: req.requestId,
          ownerRunId: req.ownerRunId,
          nodeId: req.nodeId,
          agent: req.agent,
          task: req.task,
          ...(req.model ? { model: req.model } : {}),
          context: "fresh",
          cwd: req.cwd,
          timeoutMs: req.timeoutMs,
          result: { kind: "text" },
        });
      });
    },
    dispose() {
      disposed = true;
      for (const [, call] of pending) {
        clearTimeout(call.timer);
        call.resolve({ status: "failed", error: "client disposed" });
      }
      pending.clear();
      if (typeof (pi.events as { off?: unknown }).off === "function") {
        (pi.events as { off: (n: string, h: unknown) => void }).off(RESPONSE_EVENT_REPLY, handler);
      }
    },
  };
}

function resultText(r: TerminalResponse): string {
  if (r.status !== "completed") return "";
  if (r.result && r.result.kind === "text") return String(r.result.text ?? "");
  return "";
}

// ─── Mechanical parsing (ported from the former council-loop.js verbatim) ───

export function parseHyps(text: string): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const re = /^###\s*(H-[A-Za-z]\d+)\s*:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({ id: m[1].toUpperCase(), title: m[2].trim().slice(0, 120) });
  }
  return out;
}

export function parseVerdicts(text: string, speaker: string): VerdictRecord[] {
  const out: VerdictRecord[] = [];
  const re = /^VERDICT\s+(H-[A-Za-z]\d+)\s*:\s*(accept|reject|refine)\b/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ""))) !== null) {
    out.push({ id: m[1].toUpperCase(), verdict: m[2].toLowerCase() as VerdictRecord["verdict"], speaker });
  }
  return out;
}

// ─── Child task builders (ported verbatim; brief/note interpolated) ───

function divergeTask(p: DelegationParticipant, briefText: string, note?: string): string {
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

function challengeTask(p: DelegationParticipant, round: number, contested: string[], othersText: string): string {
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

function chairTask(briefText: string, note: string | undefined, allProposals: string, allVerdicts: string, chairFix?: string): string {
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

// ─── Slate persistence (used by the tool after a successful council) ───

export function persistSlateEntry(councilDirAbs: string, slate: string): string {
  const ed = path.join(councilDirAbs, "entries");
  fs.mkdirSync(ed, { recursive: true });
  const file = String(Date.now()).slice(-6) + "-Chair.md";
  fs.writeFileSync(path.join(ed, file), "---\nspeaker: Chair\nphase: slate\nsummary: final slate\n---\n" + slate.trim() + "\n", "utf-8");
  return file;
}

// ─── Orchestration: diverge → challenge rounds → chair (+ one corrective fix) ───

const CHILD_TIMEOUT_MS = 420_000; // per-child hard cap (analysts)
const CHAIR_TIMEOUT_MS = 540_000;

export async function runCouncilDelegated(pi: DelegationPi, args: CouncilDelegationArgs): Promise<CouncilOutcome> {
  const log = args.onLog ?? (() => {});
  const client = createDelegationClient(pi);
  const ownerRunId = "council-" + args.seq + "-" + Date.now();
  let attemptCounter = 0;
  const nextIds = (base: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ requestId: ownerRunId + "-" + base + "-" + (++attemptCounter), nodeId: base + "-a" + (attemptCounter) }));

  const remainingMs = () => args.deadlineAt - Date.now();
  const childTimeout = (cap: number) => Math.max(30_000, Math.min(cap, remainingMs()));

  try {
    const unavailable: string[] = [];
    const lastStatus = new Map<string, string>();
    const live = args.participants.slice();
    const MAX_ATTEMPTS = 3; // initial + 2 retries (approved behavior)
    const proposalTexts = new Map<string, string>(); // name -> full diverge output

    // ── Phase 1 — Diverge (parallel, chat outputs only) ──
    log("phase 1: diverge (" + live.length + " analysts)");
    const runDivergeBatch = async (batch: DelegationParticipant[], attempt: number) => {
      const ids = nextIds("diverge", batch.length);
      const results = await Promise.all(batch.map((p, i) =>
        client.run({
          requestId: ids[i].requestId,
          ownerRunId,
          nodeId: ids[i].nodeId,
          agent: "delegate",
          task: divergeTask(p, args.briefText, args.note),
          model: p.model,
          cwd: args.cwd,
          timeoutMs: childTimeout(CHILD_TIMEOUT_MS),
        }).then((r) => ({ p, text: resultText(r), status: r.status, error: r.error })),
      ));
      void attempt;
      return results;
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const absent = live.filter((p) => parseHyps(proposalTexts.get(p.name) || "").length === 0);
      if (absent.length === 0) break;
      if (attempt > 1) log("diverge retry " + (attempt - 1) + " for: " + absent.map((p) => p.name).join(", "));
      if (remainingMs() <= 0) break;
      for (const r of await runDivergeBatch(absent, attempt)) {
        if (r.text) proposalTexts.set(r.p.name, r.text);
        if (!r.text) lastStatus.set(r.p.name, r.status + (r.error ? ": " + r.error.slice(0, 120) : ""));
      }
    }
    for (const p of args.participants.slice()) {
      if (parseHyps(proposalTexts.get(p.name) || "").length === 0) {
        unavailable.push(p.name);
        const idx = live.indexOf(p);
        if (idx >= 0) live.splice(idx, 1);
        log(p.name + " UNAVAILABLE after " + MAX_ATTEMPTS + " attempts");
      }
    }
    if (live.length < 2) {
      const statuses = unavailable.map((n) => n + " [" + (lastStatus.get(n) ?? "no response") + "]").join(", ");
      const seamDead = unavailable.length > 0 && unavailable.every((n) => (lastStatus.get(n) ?? "").includes("unavailable_context"));
      return {
        ok: false,
        reason: "quorum",
        detail: "fewer than 2 analysts delivered proposals (unavailable: " + statuses + ") — council not held",
        unavailable,
        rounds: 0,
        consensus: null,
        seamUnavailable: seamDead,
      };
    }
    const hypothesisTexts: Array<{ id: string; title: string }> = [];
    for (const p of live) {
      for (const h of parseHyps(proposalTexts.get(p.name) || "")) hypothesisTexts.push({ id: h.id, title: h.title });
    }

    // ── Phase 2 — Challenge rounds (verdicts in chat, consensus mechanical) ──
    const verdictRecords: VerdictRecord[] = [];
    const consensusReport = (): ConsensusReport => {
      const latest: Record<string, Record<string, string>> = {};
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
        canConverge: settledCount >= args.minExperiments && settledCount === hypotheses.length,
      };
    };

    let consensus: ConsensusReport = { hypotheses: [], settledCount: 0, contestedCount: 0, canConverge: false };
    let roundsUsed = 0;
    let contested: string[] = [];
    for (let round = 1; round <= args.maxChallengeRounds; round++) {
      roundsUsed = round;
      log("phase 2: challenge round " + round + " (" + live.length + " analysts" + (contested.length ? ", contested: " + contested.join(",") : "") + ")");
      if (remainingMs() <= 0) {
        return { ok: false, reason: "deadline", detail: "council deadline hit before challenge rounds finished", unavailable, rounds: roundsUsed, consensus: consensusReport() };
      }
      const othersText = live.map((p) => "### Proposals by " + p.name + ":\n" + (proposalTexts.get(p.name) || "(none)")).join("\n\n");
      const ids = nextIds("challenge-r" + round, live.length);
      const results = await Promise.all(live.map((p, i) =>
        client.run({
          requestId: ids[i].requestId,
          ownerRunId,
          nodeId: ids[i].nodeId,
          agent: "delegate",
          task: challengeTask(p, round, contested, othersText),
          model: p.model,
          cwd: args.cwd,
          timeoutMs: childTimeout(CHILD_TIMEOUT_MS),
        }).then((r) => ({ name: p.name, text: resultText(r) })),
      ));
      for (const r of results) {
        for (const v of parseVerdicts(r.text, r.name)) verdictRecords.push(v);
      }
      consensus = consensusReport();
      contested = consensus.hypotheses.filter((h) => !h.settled).map((h) => h.id);
      if (consensus.canConverge) {
        log("consensus reached at round " + round);
        break;
      }
      if (round === args.maxChallengeRounds) log("rounds exhausted without consensus — chair decides best-effort");
    }

    // ── Phase 3 — Chair slate + mechanical validation (+ one corrective fix) ──
    log("phase 3: chair slate");
    if (remainingMs() <= 0) {
      return { ok: false, reason: "deadline", detail: "council deadline hit before the chair ran", unavailable, rounds: roundsUsed, consensus };
    }
    const allProposals = live.map((p) => "--- " + p.name + " (" + p.letter + ") ---\n" + (proposalTexts.get(p.name) || "(none)")).join("\n\n");
    const allVerdicts = verdictRecords.map((v) => "VERDICT " + v.id + ": " + v.verdict + " — by " + v.speaker).join("\n");

    const runChair = async (chairFix?: string): Promise<string> => {
      const [id] = nextIds(chairFix ? "chair-fix" : "chair", 1);
      const r = await client.run({
        requestId: id.requestId,
        ownerRunId,
        nodeId: id.nodeId,
        agent: "delegate",
        task: chairTask(args.briefText, args.note, allProposals, allVerdicts, chairFix),
        model: args.chairModel,
        cwd: args.cwd,
        timeoutMs: childTimeout(CHAIR_TIMEOUT_MS),
      });
      return resultText(r).trim();
    };

    let slate = await runChair();
    let corrected = false;
    if (!slate || !/##\s*EXP/i.test(slate)) {
      return { ok: false, reason: "no-slate", detail: "the chair did not return a slate", unavailable, rounds: roundsUsed, consensus };
    }
    let validation = args.validate(slate);
    if (!validation.ok) {
      log("slate failed validation — one corrective chair re-run: " + (validation.errors ?? []).join(" "));
      if (remainingMs() <= 0) {
        return { ok: false, reason: "deadline", detail: "council deadline hit before the corrective chair re-run", unavailable, rounds: roundsUsed, consensus };
      }
      const fixed = await runChair((validation.errors ?? []).join(" "));
      if (fixed && /##\s*EXP/i.test(fixed)) {
        const revalidation = args.validate(fixed);
        if (revalidation.ok) {
          slate = fixed;
          validation = revalidation;
          corrected = true;
        }
      }
      if (!validation.ok) {
        return {
          ok: false,
          reason: "no-slate",
          detail: "the slate failed validation even after the corrective re-run: " + (validation.errors ?? []).join(" "),
          unavailable,
          rounds: roundsUsed,
          consensus,
        };
      }
    }

    return { ok: true, slate, unavailable, rounds: roundsUsed, consensus, corrected };
  } finally {
    client.dispose();
  }
}
