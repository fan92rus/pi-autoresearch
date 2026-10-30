/**
 * Stagnation Council — multi-model hypothesis council for stalled campaigns.
 *
 * Flow: trigger (observer or /autoresearch council) → mechanical brief from the
 * ledger → facilitator protocol message → the campaign agent orchestrates 3
 * analyst subagents (diverge) → iterative challenge rounds until mechanical
 * consensus (cap 5) → a chair model composes the experiment slate → the campaign
 * registers it via propose_hypothesis (SimHash dedup) and runs it normally.
 * The benchmark, not the council, decides what is true.
 *
 * This module is pure state/helpers: no imports from observer.ts or index.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reconstructJsonlState, isAutoresearchRunEntry, parseJsonlEntry } from "./jsonl.ts";
import { treeExists, loadTree, getPath, type TreeNode } from "./parallel/tree.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

export type CouncilPersona = "patterns" | "explorer" | "skeptic";

export interface CouncilParticipantConfig {
  name: string;
  model: string;
  persona: CouncilPersona;
}

export interface CouncilConfig {
  enabled: boolean;
  participants: CouncilParticipantConfig[];
  chairModel: string;
  stagnationRuns: number;
  cooldownRuns: number;
  maxCouncils: number;
  mode: "auto" | "models" | "personas";
}

const DEFAULT_PARTICIPANTS: CouncilParticipantConfig[] = [
  { name: "AnalystA", model: "anthropic/claude-haiku-5-5", persona: "patterns" },
  { name: "AnalystB", model: "zai-coding-cn/glm-5.3-flash", persona: "explorer" },
  { name: "AnalystC", model: "openai-codex/gpt-6-luna", persona: "skeptic" },
];

const DEFAULT_CHAIR_MODEL = "zai-coding-cn/glm-5.3:high";

const PERSONA_CYCLE: CouncilPersona[] = ["patterns", "explorer", "skeptic"];

export function defaultCouncilConfig(): CouncilConfig {
  return {
    enabled: true,
    participants: DEFAULT_PARTICIPANTS.map((p) => ({ ...p })),
    chairModel: DEFAULT_CHAIR_MODEL,
    stagnationRuns: 10,
    cooldownRuns: 5,
    maxCouncils: Infinity,
    mode: "auto",
  };
}

function isPersona(v: unknown): v is CouncilPersona {
  return v === "patterns" || v === "explorer" || v === "skeptic";
}

/** Read council config from .auto/config.json section "council" with defaults. */
export function readCouncilConfig(cwd: string): CouncilConfig {
  const cfg = defaultCouncilConfig();
  try {
    const configPath = path.join(cwd, ".auto", "config.json");
    if (!fs.existsSync(configPath)) return cfg;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { council?: Record<string, unknown> };
    const c = raw.council;
    if (!c || typeof c !== "object") return cfg;
    if (typeof c.enabled === "boolean") cfg.enabled = c.enabled;
    if (typeof c.chair_model === "string" && c.chair_model.trim()) cfg.chairModel = c.chair_model.trim();
    if (typeof c.stagnation_runs === "number" && c.stagnation_runs > 0) cfg.stagnationRuns = Math.floor(c.stagnation_runs);
    if (typeof c.cooldown_runs === "number" && c.cooldown_runs >= 0) cfg.cooldownRuns = Math.floor(c.cooldown_runs);
    if (typeof c.max_councils === "number" && c.max_councils > 0) cfg.maxCouncils = Math.floor(c.max_councils);
    if (c.mode === "models" || c.mode === "personas") cfg.mode = c.mode;
    if (Array.isArray(c.participants) && c.participants.length >= 2) {
      const parsed: CouncilParticipantConfig[] = [];
      c.participants.forEach((p, i) => {
        if (!p || typeof p !== "object") return;
        const rec = p as Record<string, unknown>;
        const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim().slice(0, 40) : `Analyst${String.fromCharCode(65 + i)}`;
        const model = typeof rec.model === "string" && rec.model.trim() ? rec.model.trim() : DEFAULT_PARTICIPANTS[i % DEFAULT_PARTICIPANTS.length].model;
        const persona = isPersona(rec.persona) ? rec.persona : PERSONA_CYCLE[i % PERSONA_CYCLE.length];
        parsed.push({ name, model, persona });
      });
      if (parsed.length >= 2) cfg.participants = parsed.slice(0, 4);
    }
  } catch {
    /* defaults on any parse failure */
  }
  return cfg;
}

// ─── Roster ──────────────────────────────────────────────────────────────────

export interface ResolvedParticipant {
  name: string;
  letter: string;
  model: string;
  persona: CouncilPersona;
}

export interface ResolvedRoster {
  mode: "models" | "personas";
  participants: ResolvedParticipant[];
  chairModel: string;
}

/** Assign letters A.. to participants and resolve models|personas mode. */
export function resolveRoster(cfg: CouncilConfig): ResolvedRoster {
  const participants: ResolvedParticipant[] = cfg.participants.map((p, i) => ({
    name: p.name,
    letter: String.fromCharCode(65 + (i % 26)),
    model: p.model,
    persona: p.persona,
  }));
  const distinctModels = new Set(participants.map((p) => p.model)).size;
  const mode: "models" | "personas" =
    cfg.mode === "personas" ? "personas" : cfg.mode === "models" ? "models" : distinctModels > 1 ? "models" : "personas";
  if (mode === "personas") {
    // One model for all analysts: the first participant's model.
    const sharedModel = participants[0].model;
    for (const p of participants) p.model = sharedModel;
  }
  return { mode, participants, chairModel: cfg.chairModel };
}

// ─── Persona prompts ─────────────────────────────────────────────────────────

export function personaPrompt(persona: CouncilPersona): string {
  switch (persona) {
    case "patterns":
      return (
        "LENS: pattern analyst. Mine the run history for REPEATED failure causes: themes that show up in multiple " +
        "discard findings and do_not_retry entries. Propose hypotheses that attack the pattern itself (why do these " +
        "kinds of attempts keep failing?) rather than another instance of it."
      );
    case "explorer":
      return (
        "LENS: explorer. Read the actual project code (read/grep/find) and look for optimization directions the " +
        "campaign has NOT touched yet: untouched components, algorithms, data structures, caching layers, I/O paths. " +
        "Ground every hypothesis in a concrete file/symbol you inspected."
      );
    case "skeptic":
      return (
        "LENS: skeptic. Demand measurement honesty: proposals must have an expected effect clearly above the noise " +
        "floor stated in the brief, a cheap way to verify, and an explicit kill condition. Reject-flavored thinking: " +
        "prefer hypotheses that are cheap to falsify over grand rewrites."
      );
  }
}

// ─── Council state ───────────────────────────────────────────────────────────

export interface CouncilState {
  councilsRun: number;
  lastCouncilRun: number | null;
}

function councilStatePath(workDir: string): string {
  return path.join(workDir, ".auto", "councils", "state.json");
}

export function readCouncilState(workDir: string): CouncilState {
  try {
    const raw = JSON.parse(fs.readFileSync(councilStatePath(workDir), "utf-8")) as Partial<CouncilState>;
    return {
      councilsRun: typeof raw.councilsRun === "number" ? raw.councilsRun : 0,
      lastCouncilRun: typeof raw.lastCouncilRun === "number" ? raw.lastCouncilRun : null,
    };
  } catch {
    return { councilsRun: 0, lastCouncilRun: null };
  }
}

export function writeCouncilState(workDir: string, state: CouncilState): void {
  try {
    const dir = path.join(workDir, ".auto", "councils");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(councilStatePath(workDir), JSON.stringify(state, null, 2));
  } catch {
    /* best-effort */
  }
}

/** Next council directory: .auto/councils/<seq>. */
export function nextCouncilDir(workDir: string): { seq: number; dir: string } {
  const state = readCouncilState(workDir);
  const seq = state.councilsRun + 1;
  return { seq, dir: path.join(workDir, ".auto", "councils", String(seq)) };
}

// ─── Brief builder ───────────────────────────────────────────────────────────

export interface BriefInput {
  seq: number;
  metricName: string;
  metricUnit: string;
  direction: "lower" | "higher";
  baselineMetric: number | null;
  bestMetric: number | null;
  noiseFloor: number | null;
  goal: string;
  /** Verbatim note from the lead agent on why it convened the council (council_convene / /autoresearch council [note]). */
  agentNote?: string;
}

function fmtMetric(v: number | null, unit: string): string {
  return v === null ? "?" : `${Number(v.toFixed(4))}${unit}`;
}

/** Aggregate do_not_retry strings from tree ASI payloads. */
function collectDoNotRetry(tree: ReturnType<typeof loadTree>): string[] {
  if (!tree) return [];
  const out = new Set<string>();
  for (const node of Object.values(tree.nodes)) {
    const asi = node.asi as Record<string, unknown> | null;
    const dnr = asi?.do_not_retry;
    if (typeof dnr === "string" && dnr.trim()) out.add(dnr.trim().slice(0, 160));
  }
  return [...out].slice(0, 15);
}

function collectFindings(tree: ReturnType<typeof loadTree>): { id: string; status: string; finding: string }[] {
  if (!tree) return [];
  const out: { id: string; status: string; finding: string }[] = [];
  for (const node of Object.values(tree.nodes)) {
    const asi = node.asi as Record<string, unknown> | null;
    const finding = asi?.finding;
    if (typeof finding === "string" && finding.trim()) {
      out.push({ id: node.id, status: node.status, finding: finding.trim().slice(0, 160) });
    }
  }
  return out.slice(-15);
}

function keepChain(tree: ReturnType<typeof loadTree>): string[] {
  if (!tree) return [];
  return getPath(tree, tree.activeNodeId);
}

function untriedIdeas(workDir: string): string[] {
  try {
    const ideasDir = path.join(workDir, ".auto", "ideas");
    if (!fs.existsSync(ideasDir)) return [];
    return fs
      .readdirSync(ideasDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => {
        // hypothesis registration files have YAML frontmatter — tracked in the tree, not manual ideas
        try {
          return !fs.readFileSync(path.join(ideasDir, f), "utf-8").startsWith("---\n");
        } catch {
          return false;
        }
      })
      .slice(0, 12);
  } catch {
    return [];
  }
}

function previousCouncils(workDir: string, currentSeq: number): { dir: string; summary: string }[] {
  const out: { dir: string; summary: string }[] = [];
  try {
    const root = path.join(workDir, ".auto", "councils");
    if (!fs.existsSync(root)) return out;
    for (const name of fs.readdirSync(root).sort()) {
      const seqNum = Number(name);
      if (!Number.isFinite(seqNum) || seqNum >= currentSeq) continue;
      const entriesDir = path.join(root, name, "entries");
      if (!fs.existsSync(entriesDir)) continue;
      const slateFile = fs
        .readdirSync(entriesDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .find((f) => /^---\n.*^phase: slate/m.test(fs.readFileSync(path.join(entriesDir, f), "utf-8")));
      if (slateFile) {
        const summaryMatch = /^summary:\s*(.*)$/m.exec(fs.readFileSync(path.join(entriesDir, slateFile), "utf-8"));
        out.push({ dir: `.auto/councils/${name}`, summary: (summaryMatch?.[1] ?? "").slice(0, 200) });
      } else {
        out.push({ dir: `.auto/councils/${name}`, summary: "(no slate)" });
      }
    }
  } catch {
    /* best-effort */
  }
  return out.slice(-3);
}

/** Build the mechanical campaign digest and write it as 00-brief.md in the council dir. */
export function buildBrief(workDir: string, councilDir: string, input: BriefInput): { path: string; text: string } {
  const sections: string[] = [];

  sections.push(
    `# Council brief #${input.seq} — campaign facts (mechanical digest, do not assume anything not written here)`,
    "",
    "## Goal",
    `- Campaign: ${input.goal || "(unnamed)"}`,
    `- Metric: ${input.metricName} (${input.metricUnit}), direction: ${input.direction === "lower" ? "LOWER is better" : "HIGHER is better"}`,
    `- Baseline: ${fmtMetric(input.baselineMetric, input.metricUnit)}`,
    `- Best so far: ${fmtMetric(input.bestMetric, input.metricUnit)}`,
    `- Noise floor (single-run measurement noise): ${fmtMetric(input.noiseFloor, input.metricUnit)} — a proposal must expect an effect ≥ 2× this to be worth a run`,
    "",
  );

  // Recent runs from the ledger
  try {
    const jsonlPath = path.join(workDir, ".auto", "log.jsonl");
    const legacyPath = path.join(workDir, "autoresearch.jsonl");
    const logPath = fs.existsSync(jsonlPath) ? jsonlPath : fs.existsSync(legacyPath) ? legacyPath : null;
    if (logPath) {
      const content = fs.readFileSync(logPath, "utf-8");
      const reconstructed = reconstructJsonlState(content);
      const runs = reconstructed.results.slice(-15);
      const lines = runs.map((r) => {
        const finding = r.asi && typeof r.asi.finding === "string" ? ` — finding: ${r.asi.finding.slice(0, 100)}` : "";
        return `| ${r.run} | ${r.status} | ${fmtMetric(r.metric, input.metricUnit)} | ${r.description.slice(0, 90).replace(/\|/g, "/")}${finding} |`;
      });
      sections.push(
        "## Recent runs (last 15 in this segment)",
        "| run | status | metric | description |",
        "|-----|--------|--------|-------------|",
        ...lines,
        "",
      );
    }
  } catch {
    /* ledger section is best-effort */
  }

  if (treeExists(workDir)) {
    const tree = loadTree(workDir);
    if (tree) {
      const chain = keepChain(tree);
      sections.push(
        "## Keep chain (what worked, in order — the current derivation path)",
        chain.length > 0 ? chain.join(" → ") : "(no keeps yet)",
        "",
      );
      const dnr = collectDoNotRetry(tree);
      if (dnr.length > 0) {
        sections.push("## do_not_retry (learned the hard way — proposing these again is waste)", ...dnr.map((d) => `- ${d}`), "");
      }
      const findings = collectFindings(tree);
      if (findings.length > 0) {
        sections.push("## Findings recorded on nodes", ...findings.map((f) => `- ${f.id} (${f.status}): ${f.finding}`), "");
      }
    }
  }

  const ideas = untriedIdeas(workDir);
  if (ideas.length > 0) {
    sections.push("## Untried ideas backlog (.auto/ideas/)", ...ideas.map((i) => `- ${i}`), "");
  }

  const prev = previousCouncils(workDir, input.seq);
  if (prev.length > 0) {
    sections.push(
      "## Previous councils (check their slate hypotheses in the ledger — do not re-propose failures)",
      ...prev.map((p) => `- ${p.dir}: ${p.summary}`),
      "",
    );
  }

  if (input.agentNote?.trim()) {
    sections.push(
      "## Lead agent's note (why the campaign agent convened this council)",
      input.agentNote.trim(),
      "",
      "- This note is the lead's own assessment of where it is stuck — treat it as a hypothesis from the lead, not as evidence.",
      "",
    );
  }

  sections.push(
    "## Rules",
    "- NEVER propose anything that cheats or games the benchmark (no precomputed answers, no benchmark-condition exploitation, no measuring the wrong thing).",
    "- Every hypothesis must state an expected effect ≥ 2× the noise floor and a kill condition (what observation makes you abandon it).",
    "- Ground every hypothesis in the facts above. If the brief lacks a fact you need, say so explicitly in your entry.",
    "",
  );

  const text = sections.join("\n");
  const briefPath = path.join(councilDir, "00-brief.md");
  try {
    fs.mkdirSync(councilDir, { recursive: true });
    fs.writeFileSync(briefPath, text, "utf-8");
  } catch {
    /* best-effort — the facilitator message still carries key numbers */
  }
  return { path: briefPath, text };
}

// ─── Slate validation ────────────────────────────────────────────────────────

export interface SlateValidation {
  ok: boolean;
  errors: string[];
  experimentCount: number;
}

const EXP_SECTION_RE = /^#{2,4}\s*EXP\s*[-:]?\s*\d*/gim;
const EXPECTED_GAIN_RE = /EXPECTED[_ ]GAIN\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/i;
const KILL_RE = /KILL[_ ]?(?:WHEN|CRITERION)\s*[:=]/i;

/** Validate a chair-produced slate: 3–5 EXP sections, each with EXPECTED_GAIN and KILL_WHEN. */
export function validateSlate(slateText: string, noiseFloor: number | null, minExperiments = 3, maxExperiments = 5): SlateValidation {
  const errors: string[] = [];
  const text = slateText ?? "";
  const sections = [...text.matchAll(EXP_SECTION_RE)].map((m) => m.index ?? 0);
  if (sections.length < minExperiments || sections.length > maxExperiments) {
    errors.push(`Expected ${minExperiments}–${maxExperiments} experiments, found ${sections.length}.`);
  }
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1] : text.length;
    const body = text.slice(start, end);
    const label = (body.match(/^#{2,4}\s*EXP[^\n]*/im)?.[0] ?? `EXP#${i + 1}`).slice(0, 60);
    const gainMatch = EXPECTED_GAIN_RE.exec(body);
    if (!gainMatch) {
      errors.push(`${label}: missing EXPECTED_GAIN line.`);
    } else if (noiseFloor !== null && noiseFloor > 0) {
      const gain = Math.abs(Number(gainMatch[1]));
      if (gain < 2 * noiseFloor) {
        errors.push(`${label}: EXPECTED_GAIN ${gain} is below 2× noise floor (${(2 * noiseFloor).toFixed(4)}).`);
      }
    }
    if (!KILL_RE.test(body)) {
      errors.push(`${label}: missing KILL_WHEN / KILL_CRITERION line.`);
    }
  }
  return { ok: errors.length === 0, errors, experimentCount: sections.length };
}

// ─── Trigger ─────────────────────────────────────────────────────────────────

/** Read the calibrated noise floor from .auto/config.json (written by the loop after baseline). */
export function readNoiseFloor(cwd: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, ".auto", "config.json"), "utf-8")) as { noiseFloor?: unknown };
    return typeof raw.noiseFloor === "number" && Number.isFinite(raw.noiseFloor) && raw.noiseFloor > 0 ? raw.noiseFloor : null;
  } catch {
    return null;
  }
}

/**
 * Stagnation council trigger. Fires when the campaign is stalled (no best
 * improvement for stagnation_runs), the council budget/cooldown allow it, and
 * the council feature is enabled. On fire: writes the brief + state, returns the
 * full facilitator protocol message (replaces the plain stagnation hint).
 */
export function checkCouncilTrigger(
  runsSinceBestImprovement: number,
  runCount: number,
  cwd: string,
  briefInput: Omit<BriefInput, "seq" | "noiseFloor">,
  options?: { force?: boolean; agentNote?: string },
): string | null {
  const cfg = readCouncilConfig(cwd);
  if (!cfg.enabled) return null;
  if (!options?.force) {
    if (runsSinceBestImprovement < cfg.stagnationRuns) return null;
    const st = readCouncilState(cwd);
    if (st.councilsRun >= cfg.maxCouncils) return null;
    if (st.lastCouncilRun !== null && runCount - st.lastCouncilRun < cfg.cooldownRuns) return null;
  }

  const { seq, dir } = nextCouncilDir(cwd);
  const roster = resolveRoster(cfg);
  const noiseFloor = readNoiseFloor(cwd);
  const brief = buildBrief(cwd, dir, { ...briefInput, seq, noiseFloor, agentNote: options?.agentNote });
  writeCouncilState(cwd, { councilsRun: seq, lastCouncilRun: runCount });
  return composeFacilitatorMessage({
    councilDir: path.relative(cwd, dir).split(path.sep).join("/"),
    seq,
    briefAbsPath: brief.path,
    roster,
    maxChallengeRounds: 5,
    minExperiments: 3,
  });
}

// ─── Facilitator message ─────────────────────────────────────────────────────

export interface FacilitatorInput {
  councilDir: string; // relative, e.g. .auto/councils/1
  seq: number;
  briefAbsPath: string;
  roster: ResolvedRoster;
  maxChallengeRounds: number;
  minExperiments: number;
}

function participantTask(name: string, letter: string, model: string, persona: CouncilPersona, input: FacilitatorInput, round: "diverge" | "challenge"): string {
  if (round === "diverge") {
    return [
      `You are ${name} (hypothesis letter ${letter}) in a hypothesis council for an optimization campaign.`,
      `First read the campaign brief: ${input.briefAbsPath}`,
      `Your lens: ${personaPrompt(persona)}`,
      "",
      "Beyond the brief, you may also study the problem in the project yourself — look around freely, just don't dig in:",
      "  a quick orientation pass (project layout, the benchmarked source and the measure script, tail of .auto/log.jsonl, git log --oneline if this is a repo), not an audit.",
      "  Cite exact file:line for anything you take from the code.",
      "  Two hard lines: don't run builds or benchmarks (the campaign executes experiments, not you), don't write files.",
      "",
      "Also use codex_search (a handful of targeted queries) to ground your hypotheses in external knowledge: established techniques, algorithm/library prior art, known pitfalls for the area you are proposing. Cite what you found when it shapes a hypothesis. Skip it only if the tool is missing in your session.",
      "If what you see contradicts the brief (missing or stale facts, e.g. no noise floor), say so explicitly in your entry.",
      "",
      "Propose EXACTLY 3 experiment hypotheses. Format each as a markdown section:",
      "### H-<YOUR LETTER><N>: <short title>",
      "<why this could work, grounded in brief facts; expected effect vs noise; cost/complexity; kill condition>",
      "",
      "Write the FULL text with council_write_entry:",
      `  council_write_entry({ councilDir: "${input.councilDir}", speaker: "${name}", phase: "diverge", summary: "<one sentence>", content: "<full text>" })`,
      "Then reply in chat ONLY: WROTE_ENTRY: <your one-sentence summary>. Never paste the full text into chat.",
    ].join("\n");
  }
  return [
    `You are ${name} (hypothesis letter ${letter}) in the CHALLENGE round of a hypothesis council.`,
    `Read the campaign brief: ${input.briefAbsPath}`,
    "Then use council_read_index to list entries and council_read_entry to read the OTHER analysts' entries " +
      "(skip your own). For EVERY hypothesis not authored by you, add one verdict line to your entry:",
    "VERDICT H-<letter><n>: accept — <reason>   (or reject / refine)",
    "Base verdicts on the brief's facts: expected effect vs noise floor, cost, risk, kill condition. " +
      "Do not accept something merely because it sounds confident; do not reject merely to disagree. " +
      "For refine verdicts, name exactly what must change.",
    "You may also look at the project yourself when a verdict hinges on code reality rather than brief facts — look around freely, just don't rabbit-hole; and never run builds or benchmarks or write files (that's the campaign's job).",
    "codex_search is fair game too when a verdict hinges on prior art or external facts about a technique — again, without rabbit-holing.",
    "You may also append 1 improvement paragraph per hypothesis you refined.",
    "",
    "Write the FULL text with council_write_entry:",
    `  council_write_entry({ councilDir: "${input.councilDir}", speaker: "${name}", phase: "challenge", summary: "<one sentence>", content: "<full text with VERDICT lines>" })`,
    "Then reply in chat ONLY: WROTE_ENTRY: <your one-sentence summary>.",
  ].join("\n");
}

function chairTask(input: FacilitatorInput): string {
  return [
    "You are the CHAIR of a hypothesis council. The analysts have finished diverging and challenging.",
    `Read the campaign brief: ${input.briefAbsPath}`,
    `Then use council_read_index and council_read_entry to read ALL entries in ${input.councilDir}/entries/.`,
    "Compose the final experiment slate: 3–5 experiments, prioritized, each as a markdown section:",
    "## EXP1: <short title>",
    "- HYPOTHESIS: <one sentence>",
    "- WHY: <evidence from the brief and the analysts' verdicts>",
    `- EXPECTED_GAIN: <number in the campaign's metric units> (must be ≥ 2× the noise floor from the brief)`,
    "- KILL_WHEN: <the observation that makes you abandon this experiment>",
    "- COMPLEXITY: low | medium | high",
    "",
    "Only include hypotheses that reached council consensus (accept-majority, no open refines). If fewer than 3 survived, " +
      "include the strongest contested ones but mark them 'CONTESTED: <reason>'.",
    "Reject anything that games the benchmark.",
    "",
    "Write the slate with council_write_entry:",
    `  council_write_entry({ councilDir: "${input.councilDir}", speaker: "Chair", phase: "slate", summary: "<one sentence>", content: "<full slate>" })`,
    "Then reply in chat ONLY: WROTE_ENTRY: <your one-sentence summary>.",
  ].join("\n");
}

/** Full facilitator protocol the campaign agent follows to run the council. */
export function composeFacilitatorMessage(input: FacilitatorInput): string {
  const rosterLines = input.roster.participants
    .map((p) => `- ${p.name} (letter ${p.letter}, ${input.roster.mode === "personas" ? `persona: ${p.persona}` : "own model"}: ${p.model})`)
    .join("\n");

  const launchNote =
    input.roster.mode === "models"
      ? "Launch all analysts in ONE parallel subagent batch (different models)."
      : "Persona mode (shared model): launch at most 2 analysts in parallel, then the remaining one.";

  return [
    `🔬 STAGNATION COUNCIL #${input.seq} triggered. The loop is stalled — convene the council now.`,
    "",
    `Council dir: ${input.councilDir}   Brief: ${input.briefAbsPath}`,
    `Roster:`,
    rosterLines,
    `Chair: Chair (model: ${input.roster.chairModel})`,
    "",
    "Follow these phases in order. Analysts and the chair are SUBAGENTS spawned with the subagent tool " +
      `(agent: "scout", context: "fresh"); the campaign agent (you) orchestrates and executes the final slate.`,
    "",
    "## Phase 1 — Diverge",
    `For each analyst, spawn a subagent with its task (${launchNote}):`,
    ...input.roster.participants.map((p) => `  ${p.name}: ${JSON.stringify(participantTask(p.name, p.letter, p.model, p.persona, input, "diverge"))}`),
    "After the batch: council_read_index — every analyst must have exactly one diverge entry (success marker inside). " +
      "Missing → retry that analyst's task up to 2 more times; still missing → mark UNAVAILABLE and continue.",
    "",
    "## Phase 2 — Challenge (up to " + input.maxChallengeRounds + " rounds, until consensus)",
    "Round r: spawn each analyst with the challenge task (same roster):",
    ...input.roster.participants.map((p) => `  ${p.name}: ${JSON.stringify(participantTask(p.name, p.letter, p.model, p.persona, input, "challenge"))}`),
    "After the batch, call:",
    `  council_check_consensus({ councilDir: "${input.councilDir}", participants: [${input.roster.participants
      .map((p) => `{"name":"${p.name}","letter":"${p.letter}"}`)
      .join(", ")}], minExperiments: ${input.minExperiments} })`,
    "If canConverge=true → go to Phase 3. If contested>0 and rounds < " +
      input.maxChallengeRounds +
      " → next round, analysts address ONLY the contested hypotheses. " +
      "If rounds are exhausted without consensus → Phase 3 anyway (chair picks best-effort).",
    "You may append a 'facts' entry yourself (council_write_entry, phase: \"facts\") ONLY to correct objective facts " +
      "(wrong noise floor, missing constraint). NEVER judge hypotheses yourself — that is the council's job.",
    "",
    "## Phase 3 — Chair composes the slate",
    "Spawn ONE subagent (the chair):",
    `  Chair: ${JSON.stringify(chairTask(input))}`,
    "Then read the slate entry (the only entry with phase \"slate\") and validate it: 3–5 EXP sections, each with " +
      `EXPECTED_GAIN ≥ 2× noise floor and a KILL_WHEN line. If invalid → one retry with the chair asking to fix the listed problems.`,
    "",
    "## Phase 4 — Execute",
    "Register each slate experiment with propose_hypothesis (SimHash will drop duplicates of already-tried ideas — " +
      "that is expected and fine), then run them through the normal loop: run_experiment → log_experiment with ASI " +
      "(finding / do_not_retry). The benchmark decides — a council opinion is not evidence.",
    "",
    `Budget note: councils are unlimited by default — a long campaign may convene as many as stagnation demands. ` +
      `Set council.max_councils in .auto/config.json to cap them. A keep from this slate resets the stagnation clock.`,
  ].join("\n");
}
