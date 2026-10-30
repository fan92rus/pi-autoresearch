/**
 * Council blackboard tools — append-only meeting files under .auto/councils/<id>/.
 *
 * Pattern after pi-brainstorm's meeting blackboard: participants write their FULL
 * contribution to disk and reply in chat only with "WROTE_ENTRY: <summary>". The
 * chat stays compact; the blackboard is the single source of truth for later phases.
 *
 * Deliberately light: no JSONL index, no mutation queues. An entry is ONE markdown
 * file with a small YAML-ish header; council_read_index parses headers of the files
 * in the directory (≤10 files in practice), so concurrent writes from separate
 * participant processes cannot corrupt anything.
 *
 * These tools are intentionally NOT gated on autoresearch mode: council
 * participants are separate headless sessions with no mode of their own.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CouncilPhase = "diverge" | "challenge" | "slate" | "facts";

export interface CouncilEntry {
  file: string;
  speaker: string;
  phase: CouncilPhase;
  summary: string;
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/** Resolve and validate a council dir: must live physically inside <cwd>/.auto/councils. */
export function resolveCouncilDir(cwd: string, councilDir: string): string | null {
  try {
    const root = path.resolve(cwd, ".auto", "councils");
    const resolved = path.resolve(cwd, councilDir);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    // Physical-path check: if .auto/councils (or a parent like .auto) is a symlink
    // pointing outside the project, the lexical containment above is a lie.
    // Compare REAL paths: the physical root must be inside the physical cwd.
    const cwdReal = fs.realpathSync(cwd);
    const physicalRoot = path.join(cwdReal, ".auto", "councils");
    const rootReal = fs.existsSync(physicalRoot) ? fs.realpathSync(physicalRoot) : physicalRoot;
    if (rootReal !== cwdReal && !rootReal.startsWith(cwdReal + path.sep)) return null;
    // Walk remaining components under the PHYSICAL root, re-checking each that exists.
    let probe = rootReal;
    for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      probe = path.join(probe, part);
      if (fs.existsSync(probe)) {
        const real = fs.realpathSync(probe);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
      }
    }
    return resolved;
  } catch {
    return null;
  }
}

function ensureCouncilDir(cwd: string, councilDir: string): string | null {
  const resolved = resolveCouncilDir(cwd, councilDir);
  if (!resolved) return null;
  try {
    fs.mkdirSync(path.join(resolved, "entries"), { recursive: true });
    return resolved;
  } catch {
    return null;
  }
}

// ─── Entry files ─────────────────────────────────────────────────────────────

const ENTRIES_DIR = "entries";

export function isCouncilPhase(v: unknown): v is CouncilPhase {
  return v === "diverge" || v === "challenge" || v === "slate" || v === "facts";
}

function sanitizeSpeaker(speaker: string): string {
  const clean = speaker.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 40);
  return clean || "unknown";
}

function entriesDir(councilDir: string): string {
  return path.join(councilDir, ENTRIES_DIR);
}

function listEntryFiles(councilDir: string): string[] {
  try {
    return fs
      .readdirSync(entriesDir(councilDir))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

function nextSeq(councilDir: string): number {
  let max = 0;
  for (const f of listEntryFiles(councilDir)) {
    const m = /^(\d{4})-/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const MAX_SEQ_RETRY = 50;

/**
 * Atomically claim the next entry slot: exclusive create (flag "wx") so two
 * participants writing in parallel can never overwrite each other's file — on
 * EEXIST the seq is bumped and the create retried.
 */
function writeEntryAtomic(councilDir: string, baseSpeaker: string, header: string, content: string): { file: string } | null {
  let seq = nextSeq(councilDir);
  for (let attempt = 0; attempt < MAX_SEQ_RETRY; attempt++) {
    const file = `${String(seq).padStart(4, "0")}-${sanitizeSpeaker(baseSpeaker)}.md`;
    try {
      fs.writeFileSync(path.join(entriesDir(councilDir), file), header + content.trim() + "\n", { encoding: "utf-8", flag: "wx" });
      return { file };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        seq++;
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Parse one entry file back into its header fields + body. */
export function parseEntryFile(filePath: string): { speaker: string; phase: CouncilPhase; summary: string; content: string } | null {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.startsWith("---\n")) return null;
    const speakerMatch = /^speaker:\s*(.*)$/m.exec(text);
    const phaseMatch = /^phase:\s*(.*)$/m.exec(text);
    const summaryMatch = /^summary:\s*(.*)$/m.exec(text);
    if (!speakerMatch || !phaseMatch || !summaryMatch) return null;
    const phase = phaseMatch[1].trim();
    if (!isCouncilPhase(phase)) return null;
    const bodyStart = text.indexOf("\n---\n", 4);
    if (bodyStart === -1) return null;
    return {
      speaker: speakerMatch[1].trim(),
      phase,
      summary: summaryMatch[1].trim(),
      content: text.slice(bodyStart + 5).trim(),
    };
  } catch {
    return null;
  }
}

// ─── Verdict / consensus parsing ─────────────────────────────────────────────

export interface HypothesisVerdict {
  hypothesisId: string;
  verdict: "accept" | "reject" | "refine";
  reason: string;
  by: string; // speaker name
}

const VERDICT_RE = /^VERDICT\s+(H-[A-Za-z]\d+)\s*:\s*(accept|reject|refine)\b\s*(?:—|--|-)?\s*(.*)/gim;
const HYP_RE = /^#{2,4}\s*(H-[A-Za-z]\d+)\s*[:—-]\s*(.*)/gm;

/** Collect all VERDICT lines from a challenge entry body. */
export function parseVerdicts(content: string, by: string): HypothesisVerdict[] {
  const out: HypothesisVerdict[] = [];
  for (const m of content.matchAll(VERDICT_RE)) {
    out.push({ hypothesisId: m[1].toUpperCase(), verdict: m[2].toLowerCase() as HypothesisVerdict["verdict"], reason: (m[3] ?? "").trim(), by });
  }
  return out;
}

/** Collect hypothesis ids/titles declared in a diverge entry body (### H-A1: title). */
export function parseHypotheses(content: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const m of content.matchAll(HYP_RE)) {
    out.push({ id: m[1].toUpperCase(), title: (m[2] ?? "").trim() });
  }
  return out;
}

export interface ConsensusReport {
  hypotheses: {
    id: string;
    title: string;
    owner: string;
    dispositions: Record<string, number>;
    verdictsBy: Record<string, string>; // speaker -> verdict
    missingFrom: string[]; // participants who have not voted yet
    settled: boolean;
  }[];
  settledCount: number;
  contestedCount: number;
  canConverge: boolean;
}

/**
 * Mechanical consensus detector: a hypothesis is settled when every participant
 * EXCEPT its owner has issued a final accept/reject verdict (an open "refine"
 * keeps it contested). canConverge when ≥ minExperiments settled and none contested.
 */
export function detectConsensus(entries: CouncilEntry[], readBody: (e: CouncilEntry) => string | null, participants: { name: string; letter: string }[], minExperiments: number): ConsensusReport {
  const letterByName = new Map(participants.map((p) => [p.name.toLowerCase(), p.letter.toUpperCase()]));
  const letterByFirstLetter = new Map(participants.map((p) => [p.letter.toUpperCase(), p.name]));
  const hypotheses = new Map<string, { id: string; title: string; ownerLetter: string }>();

  for (const e of entries) {
    if (e.phase !== "diverge") continue;
    const body = readBody(e);
    if (!body) continue;
    const ownerLetter = letterByName.get(e.speaker.toLowerCase()) ?? (e.speaker.match(/([A-Za-z])\s*$/) ?? [])[1]?.toUpperCase() ?? "?";
    for (const h of parseHypotheses(body)) {
      const letter = h.id.match(/^H-([A-Za-z])/)?.[1] ?? "?";
      hypotheses.set(h.id, { id: h.id, title: h.title, ownerLetter: letter !== "?" ? letter : ownerLetter });
    }
  }

  const verdicts = new Map<string, HypothesisVerdict[]>();
  for (const e of entries) {
    if (e.phase !== "challenge") continue;
    const body = readBody(e);
    if (!body) continue;
    const existing = verdicts.get(e.speaker) ?? [];
    existing.push(...parseVerdicts(body, e.speaker));
    verdicts.set(e.speaker, existing);
  }

  // Recency rule: entries arrive in seq order, so the LAST verdict a participant
  // issued for a hypothesis supersedes earlier ones — otherwise a round-1 refine
  // would keep a hypothesis contested forever even after a later accept.
  const latestVerdict = (speaker: string, hypothesisId: string): HypothesisVerdict | null => {
    const list = verdicts.get(speaker);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].hypothesisId === hypothesisId) return list[i];
    }
    return null;
  };

  const report: ConsensusReport["hypotheses"] = [];
  for (const h of hypotheses.values()) {
    const ownerName = letterByFirstLetter.get(h.ownerLetter) ?? `letter-${h.ownerLetter}`;
    const dispositions: Record<string, number> = { accept: 0, reject: 0, refine: 0 };
    const verdictsBy: Record<string, string> = {};
    const missingFrom: string[] = [];
    for (const p of participants) {
      if (p.name === ownerName) continue;
      const v = latestVerdict(p.name, h.id);
      if (!v) {
        missingFrom.push(p.name);
        continue;
      }
      dispositions[v.verdict]++;
      verdictsBy[p.name] = v.verdict;
    }
    const settled = missingFrom.length === 0 && dispositions.refine === 0;
    report.push({ id: h.id, title: h.title, owner: ownerName, dispositions, verdictsBy, missingFrom, settled });
  }

  report.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const settledCount = report.filter((h) => h.settled).length;
  const contestedCount = report.length - settledCount;
  return { hypotheses: report, settledCount, contestedCount, canConverge: settledCount >= minExperiments && contestedCount === 0 };
}

// ─── Tool registration ───────────────────────────────────────────────────────

interface RegisterToolLike {
  registerTool(tool: unknown): void;
}

export function registerCouncilTools(pi: RegisterToolLike): void {
  pi.registerTool({
    name: "council_write_entry",
    label: "Council: Write Entry",
    description:
      "Append your contribution to the council blackboard (one markdown file). Write your FULL analysis here — " +
      "do NOT paste it into chat. After writing, reply ONLY with: WROTE_ENTRY: <one-sentence summary>.",
    promptSnippet: "Write your full council contribution to the blackboard, then reply WROTE_ENTRY: <summary>",
    promptGuidelines: [
      "Use council_write_entry to write your FULL contribution (diverge hypotheses / challenge verdicts / slate). Then reply ONLY 'WROTE_ENTRY: <one-sentence summary>' — never paste the full text into chat.",
      "In challenge entries, one verdict per line, exactly: VERDICT H-B2: accept — <reason> (or reject / refine).",
      "In diverge entries, one hypothesis per section: '### H-A1: <title>' (your letter + running number).",
    ],
    parameters: {
      type: "object",
      properties: {
        councilDir: { type: "string", description: "Council directory, e.g. .auto/councils/1" },
        speaker: { type: "string", description: "Your participant name, e.g. AnalystA" },
        phase: { type: "string", enum: ["diverge", "challenge", "slate", "facts"], description: "Session phase this entry belongs to" },
        summary: { type: "string", description: "ONE-sentence summary of the contribution" },
        content: { type: "string", description: "FULL contribution text (markdown)" },
      },
      required: ["councilDir", "speaker", "phase", "summary", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { councilDir: string; speaker: string; phase: string; summary: string; content: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const resolved = ensureCouncilDir(ctx.cwd, params.councilDir);
      if (!resolved) {
        return {
          content: [{ type: "text", text: "❌ Invalid councilDir: must be a subdirectory of .auto/councils in the current project." }],
          details: {},
        };
      }
      if (!params.speaker.trim() || !params.summary.trim() || !params.content.trim()) {
        return { content: [{ type: "text", text: "❌ speaker, summary and content are required and must be non-empty." }], details: {} };
      }
      if (!isCouncilPhase(params.phase)) {
        return { content: [{ type: "text", text: `❌ phase must be one of: diverge, challenge, slate, facts.` }], details: {} };
      }
      const header = [
        "---",
        `speaker: ${sanitizeSpeaker(params.speaker)}`,
        `phase: ${params.phase}`,
        `summary: ${params.summary.replace(/\s+/g, " ").trim()}`,
        "---",
        "",
      ].join("\n");
      const written = writeEntryAtomic(resolved, params.speaker, header, params.content);
      if (!written) {
        return { content: [{ type: "text", text: "❌ Failed to write entry (atomic create failed)." }], details: {} };
      }
      return {
        content: [{ type: "text", text: `WROTE_ENTRY OK: entries/${written.file}\nNow reply in chat ONLY: WROTE_ENTRY: <your one-sentence summary>` }],
        details: { entryFile: `entries/${written.file}`, phase: params.phase },
      };
    },
  });

  pi.registerTool({
    name: "council_read_index",
    label: "Council: Read Index",
    description: "List all entries on the council blackboard (file, speaker, phase, one-sentence summary). Cheap — reads headers only.",
    promptSnippet: "List council blackboard entries: speaker, phase, summary",
    parameters: {
      type: "object",
      properties: {
        councilDir: { type: "string", description: "Council directory, e.g. .auto/councils/1" },
      },
      required: ["councilDir"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { councilDir: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const resolved = resolveCouncilDir(ctx.cwd, params.councilDir);
      if (!resolved) {
        return { content: [{ type: "text", text: "❌ Invalid councilDir." }], details: {} };
      }
      const files = listEntryFiles(resolved);
      if (files.length === 0) {
        return { content: [{ type: "text", text: "Blackboard is empty." }], details: { count: 0 } };
      }
      const lines: string[] = [];
      const entries: CouncilEntry[] = [];
      for (const f of files) {
        const parsed = parseEntryFile(path.join(resolved, ENTRIES_DIR, f));
        if (!parsed) continue;
        entries.push({ file: `entries/${f}`, speaker: parsed.speaker, phase: parsed.phase, summary: parsed.summary });
        lines.push(`- ${f} [${parsed.phase}] ${parsed.speaker}: ${parsed.summary}`);
      }
      return {
        content: [{ type: "text", text: `Blackboard: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n${lines.join("\n")}` }],
        details: { count: entries.length, entries },
      };
    },
  });

  pi.registerTool({
    name: "council_read_entry",
    label: "Council: Read Entry",
    description: "Read the FULL text of one blackboard entry by file name (see council_read_index for the list).",
    promptSnippet: "Read one council blackboard entry in full",
    parameters: {
      type: "object",
      properties: {
        councilDir: { type: "string", description: "Council directory, e.g. .auto/councils/1" },
        entryFile: { type: "string", description: "Entry file name, e.g. entries/0001-AnalystA.md" },
      },
      required: ["councilDir", "entryFile"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: { councilDir: string; entryFile: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const resolved = resolveCouncilDir(ctx.cwd, params.councilDir);
      if (!resolved) {
        return { content: [{ type: "text", text: "❌ Invalid councilDir." }], details: {} };
      }
      const base = path.basename(params.entryFile);
      if (!base.endsWith(".md") || base.includes("/") || base.includes("\\")) {
        return { content: [{ type: "text", text: "❌ entryFile must be a bare file name like entries/0001-AnalystA.md." }], details: {} };
      }
      const parsed = parseEntryFile(path.join(resolved, ENTRIES_DIR, base));
      if (!parsed) {
        return { content: [{ type: "text", text: `❌ Entry not found or unreadable: ${base}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `[${parsed.phase}] ${parsed.speaker}: ${parsed.summary}\n\n${parsed.content}` }],
        details: { speaker: parsed.speaker, phase: parsed.phase },
      };
    },
  });

  pi.registerTool({
    name: "council_check_consensus",
    label: "Council: Check Consensus",
    description:
      "Mechanical consensus check: parses hypothesis declarations (diverge entries) and VERDICT lines (challenge entries), " +
      "reports settled vs contested hypotheses and whether the council can converge (≥ minExperiments settled, none contested).",
    promptSnippet: "Check council consensus: settled vs contested hypotheses",
    parameters: {
      type: "object",
      properties: {
        councilDir: { type: "string", description: "Council directory, e.g. .auto/councils/1" },
        participants: {
          type: "array",
          description: "Participant roster with their hypothesis letters, e.g. [{\"name\":\"AnalystA\",\"letter\":\"A\"}, ...]",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              letter: { type: "string", description: "Single letter used in hypothesis ids (H-A1)" },
            },
            required: ["name", "letter"],
          },
        },
        minExperiments: { type: "number", description: "How many settled hypotheses the slate needs (default 3)" },
      },
      required: ["councilDir", "participants"],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: { councilDir: string; participants: { name: string; letter: string }[]; minExperiments?: number },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const resolved = resolveCouncilDir(ctx.cwd, params.councilDir);
      if (!resolved) {
        return { content: [{ type: "text", text: "❌ Invalid councilDir." }], details: {} };
      }
      const participants = (params.participants ?? []).filter((p) => p && p.name && p.letter);
      if (participants.length < 2) {
        return { content: [{ type: "text", text: "❌ Need at least 2 participants with name+letter." }], details: {} };
      }
      const entries: CouncilEntry[] = [];
      for (const f of listEntryFiles(resolved)) {
        const parsed = parseEntryFile(path.join(resolved, ENTRIES_DIR, f));
        if (parsed) entries.push({ file: `entries/${f}`, speaker: parsed.speaker, phase: parsed.phase, summary: parsed.summary });
      }
      const report = detectConsensus(
        entries,
        (e) => {
          const base = path.basename(e.file);
          const parsed = parseEntryFile(path.join(resolved, ENTRIES_DIR, base));
          return parsed?.content ?? null;
        },
        participants,
        params.minExperiments && params.minExperiments > 0 ? Math.floor(params.minExperiments) : 3,
      );
      const lines = report.hypotheses.map((h) => {
        const verdictStr = Object.entries(h.verdictsBy).map(([by, v]) => `${by}:${v}`).join(", ") || "no verdicts yet";
        const missing = h.missingFrom.length > 0 ? `; awaiting ${h.missingFrom.join(", ")}` : "";
        return `- ${h.id} "${h.title}" (by ${h.owner}) — ${h.settled ? "SETTLED" : "CONTESTED"} [${verdictStr}${missing}]`;
      });
      const text =
        `Consensus: ${report.settledCount} settled, ${report.contestedCount} contested, ` +
        `canConverge=${report.canConverge}\n${lines.join("\n") || "(no hypotheses declared yet)"}`;
      return { content: [{ type: "text", text }], details: report as unknown as Record<string, unknown> };
    },
  });
}
