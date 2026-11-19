/**
 * Findings tool schemas and adapters.
 *
 * Registration and lifecycle policy (gated tool tracking, mode gating and
 * work-dir policy) stays in index.ts; the policy hooks are injected via deps
 * so every findings tool goes through exactly the same gates.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  FINDING_STATUSES,
  FINDING_THEMES,
  FINDING_TRANSITIONS,
  recordFinding,
  updateFinding,
} from "./findings.ts";
import { inspectResults } from "./lens-inspect.ts";

export interface RegisterToolLike {
  registerTool(tool: unknown): void;
}

export interface GatedToolDeps {
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  validateWorkDir: (cwd: string) => string | null;
  resolveWorkDir: (cwd: string) => string;
}

const RecordFindingParams = Type.Object({
  theme: Type.String({
    description: `Finding theme: ${FINDING_THEMES.join(" | ")}.`,
  }),
  description: Type.String({
    description: "What the results show, stated concretely (not a generalisation without examples).",
  }),
  evidence_ref: Type.String({
    description:
      "REQUIRED. A checkable example: 'path:start-end' (e.g. '.auto/runs/45/output.txt:120-134') or 'path#anchor' (literal substring of the file).",
  }),
  estimated_impact: Type.Optional(Type.String({
    description: "Optional scale estimate, e.g. '~14% of errors'.",
  })),
  run: Type.Optional(Type.Number({
    description: "Optional run number the finding comes from.",
    minimum: 1,
  })),
});

/** Tool-facing status vocabulary, generated from findings.ts (bd tj0.8). */
export function findingStatusDescription(): string {
  return `Target status: ${FINDING_STATUSES.join(" | ")}.`;
}

/** Tool-facing transition graph, generated from findings.ts (bd tj0.8). */
export function findingTransitionsDescription(): string {
  return Object.entries(FINDING_TRANSITIONS)
    .map(([from, targets]) => `${from}→${targets.join("|")}`)
    .join(", ");
}

/** The exact description used by update_finding.status. */
export function findingStatusAndTransitionsDescription(): string {
  return `${findingStatusDescription()} Transitions are restricted (${findingTransitionsDescription()}).`;
}

/** Built per registration so a change to the exported constants reaches the schema. */
const updateFindingParams = () => Type.Object({
  id: Type.String({ description: "Finding id, e.g. f1." }),
  status: Type.String({
    description: findingStatusAndTransitionsDescription(),
  }),
  evidence_ref: Type.Optional(Type.String({
    description: "Required for verified and revised: 'path:start-end' or 'path#anchor' pointing at the verification or counterexample.",
  })),
  note: Type.Optional(Type.String({ description: "Optional short note." })),
});

const InspectResultsParams = Type.Object({
  run: Type.Optional(Type.Number({
    description: "Run number to inspect. Default: the best keep run of the current epoch.",
    minimum: 1,
  })),
  extractor: Type.Optional(Type.String({
    description: "Extractor: metric | errors | timing | delta | raw, or a name from analysis.extractors. Default: all generic extractors plus the campaign extractors.",
  })),
  page: Type.Optional(Type.Number({
    description: "Page of the response (200 content lines / 8 KiB per page). Default 1.",
    minimum: 1,
  })),
});

/**
 * Registers record_finding / update_finding / inspect_results behind the
 * injected mode, work-dir and resolution gates. Tool names, descriptions,
 * schemas and response text are the adapter contract — change them only
 * deliberately.
 */
export function registerFindingsTools(pi: RegisterToolLike, deps: GatedToolDeps): void {
  const { assertModeActive, validateWorkDir, resolveWorkDir } = deps;

  pi.registerTool({
    name: "record_finding",
    label: "Record Finding",
    description:
      "Record a finding from the results into .auto/findings.jsonl (append-only). Status starts as open. " +
      "Rejected without a concrete evidence_ref.",
    promptSnippet: "Record a result finding backed by a concrete example",
    promptGuidelines: [
      "Every finding needs evidence_ref pointing at a concrete case: path:start-end or path#anchor.",
    ],
    parameters: RecordFindingParams,

    async execute(_toolCallId, params: Static<typeof RecordFindingParams>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const res = await recordFinding(workDir, params);
      if (!res.ok) {
        return { content: [{ type: "text", text: `❌ record_finding rejected:\n  ${res.errors.join("\n  ")}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `🔎 Finding ${res.value.id} recorded (theme: ${res.value.theme}, status: open).` }],
        details: { id: res.value.id, status: res.value.status },
      };
    },
  });

  pi.registerTool({
    name: "update_finding",
    label: "Update Finding",
    description:
      "Change a finding's status (append-only transition in .auto/findings.jsonl). verified and revised require evidence_ref. " +
      "Moving a finding to revised may trigger a soft warning on hypotheses explicitly linked to it.",
    promptSnippet: "Move a finding through open/verified/revised/deferred",
    promptGuidelines: [
      "verified requires evidence_ref to an independent check; revised requires evidence_ref to a counterexample.",
    ],
    parameters: updateFindingParams(),

    async execute(_toolCallId, params: Static<ReturnType<typeof updateFindingParams>>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const res = await updateFinding(workDir, params);
      if (!res.ok) {
        return { content: [{ type: "text", text: `❌ update_finding rejected:\n  ${res.errors.join("\n  ")}` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `🔎 Finding ${res.value.id}: ${res.value.from} → ${res.value.status}.` }],
        details: { id: res.value.id, from: res.value.from, status: res.value.status },
      };
    },
  });

  pi.registerTool({
    name: "inspect_results",
    label: "Inspect Results",
    description:
      "Inspect a persisted run output from .auto/runs/<n>/ (ledger and run files only): METRIC lines, error/warn lines, timing top-N, delta against the best keep of the same epoch, and campaign extractors. Response is bounded to 200 lines / 8 KiB per page; use page for the rest.",
    promptSnippet: "Inspect a persisted run output (best keep by default) with bounded pages",
    promptGuidelines: [
      "Use inspect_results before recording a finding: read the concrete examples it shows, then record_finding with evidence_ref pointing at them.",
    ],
    parameters: InspectResultsParams,

    async execute(_toolCallId, params: Static<typeof InspectResultsParams>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const res = inspectResults(workDir, params);
      return { content: [{ type: "text", text: res.text }], details: res.details };
    },
  });
}
