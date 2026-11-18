/**
 * tree_status + council_convene tools (extracted from index.ts; tool bodies
 * byte-identical apart from deps reads at the call site). Prompt text, render
 * functions, tree formatting, UCB1 view wiring, council brief/protocol text and
 * reply details are preserved. Extension-local collaborators arrive through
 * `deps` (getter-backed in index.ts) and are read as `deps.foo` at the point of
 * use — never frozen in an execute() destructure. In particular
 * campaignBlocksOrdinaryLoop is declared later in index.ts and stays live via
 * its getter; state is re-read from deps.getRuntime(ctx) on every council call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  treeExists,
  loadTree,
  failedStreakSinceLastKeep,
  type ExperimentTree,
  type TreeNode,
} from "./parallel/tree.ts";
import { renderTree, renderNodeDetail, findBestNodeId } from "./parallel/treeview.ts";
import { epochTreeView, type EpochTreeView } from "./widget.ts";
import { noiseFloorStatusOfDir } from "./measurement.ts";
import { loadFindings } from "./findings.ts";
import {
  buildBrief,
  buildPrecedentSupplement,
  composeFacilitatorMessage,
  findUnfinishedCouncil,
  loadLatestPrecedentDigest,
  nextCouncilDir,
  personaPrompt,
  readCouncilConfig,
  resolveRoster,
  validateSlate,
  writeCouncilState,
} from "./council.ts";
import {
  delegationAvailable,
  persistSlateEntry,
  runCouncilDelegated,
} from "./council-delegation.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface TreeStatusToolDeps {
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  epochReferenceLine: (view: EpochTreeView) => string | null;
  readJsonlLines: (workDir: string) => string[];
  resolveWorkDir: (cwd: string) => string;
}

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface CouncilConveneToolDeps {
  pi: ExtensionAPI;
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  campaignBlocksOrdinaryLoop: (workDir: string) => Promise<boolean>;
  getRuntime: (ctx: ExtensionContext) => any;
  researchBlockedResponse: () => any;
  researchBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  resolveWorkDir: (cwd: string) => string;
}

export function createTreeStatusTool(deps: TreeStatusToolDeps): RegisteredTool {
  /** Format a node's metric value with unit, for action directive text. */
  function formatNodeMetric(node: TreeNode | undefined, tree: ExperimentTree): string {
    if (!node || node.metric == null) return "?";
    const unit = tree.metricName || "";
    return `${node.metric}${unit ? " " + unit : ""}`;
  }
  return {
    name: "tree_status",
    label: "Show hypothesis tree with statuses",
    description:
      "Display the hypothesis tree as an ASCII diagram with statuses and metrics. " +
      "Use this to see which hypotheses were tried, which were kept/discarded, and where the best result is. " +
      "Modes: 'summary' (default, tree + high-failure warnings), 'full' (tree + all node details).",
    promptSnippet: "View hypothesis tree: statuses, metrics, current best",
    promptGuidelines: [
      "Call tree_status() after every 3-4 experiments or when you lose track of what was tried.",
      "The tree shows the flat hypothesis list: baselines, keeps (with the current best ★), discards and abandoned nodes.",
    ],
    parameters: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["summary", "full"],
          description: "Level of detail: 'summary' (default, tree + warnings), 'full' (all node details).",
        },
      },
    } as any,
    async execute(_toolCallId: string, params: { detail?: string }, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDir = deps.resolveWorkDir(ctx.cwd);

      if (!treeExists(workDir)) {
        return {
          content: [{ type: "text", text: "ℹ️ No experiment tree yet. Call init_experiment to create one." }],
          details: {},
        };
      }

      const tree = loadTree(workDir);
      if (!tree) {
        return {
          content: [{ type: "text", text: "❌ Failed to load experiment tree." }],
          details: {},
        };
      }

      const detailMode = params.detail || "summary";
      const activeNode = tree.nodes[tree.activeNodeId];
      // Epoch view (task 2.3): ★ best, deltas and the tree body cover the current epoch only.
      const view = epochTreeView(tree, deps.readJsonlLines(workDir).join("\n"));
      const bestId = findBestNodeId(view.scoped);
      const nodeCount = Object.keys(tree.nodes).length;
      const failStreak = failedStreakSinceLastKeep(tree, tree.activeNodeId);

      let text = "";

      // ── Where we are (one line, most important for the agent) ──
      const activeHypothesis = activeNode?.hypothesisLabel || activeNode?.hypothesis || "";
      text += `▶ Current: ${tree.activeNodeId}`;
      if (activeHypothesis) text += ` — "${activeHypothesis}"`;
      text += ` (${formatNodeMetric(activeNode, tree)})\n`;
      if (bestId && bestId !== tree.activeNodeId) {
        const bestNode = tree.nodes[bestId];
        const bestHypothesis = bestNode?.hypothesisLabel || bestNode?.hypothesis || "";
        text += `★ Best: ${bestId}`;
        if (bestHypothesis) text += ` — "${bestHypothesis}"`;
        text += ` (${formatNodeMetric(bestNode, tree)})\n`;
      }
      text += "\n";

      if (view.epoch > 1) text += `Epoch ${view.epoch} (current): best and deltas within this epoch only\n`;
      const referenceLine = deps.epochReferenceLine(view);
      if (referenceLine) text += `${referenceLine}\n`;

      // experiment-rigor 2.1: visible noise status (not calibrated / stale / fresh).
      const floorStatus = noiseFloorStatusOfDir(workDir);
      if (floorStatus.floor === null) {
        text += "Noise floor: not calibrated (config.json noiseFloor with noiseFloorUnit \"metric\" is missing or legacy)\n";
      } else if (floorStatus.stale) {
        text += `Noise floor: ${floorStatus.floor} — stale (calibrated on epoch ${floorStatus.floor_epoch}, active epoch ${floorStatus.epoch})\n`;
      } else {
        text += `Noise floor: ${floorStatus.floor} — fresh\n`;
      }

      text += renderTree(view.scoped, 60, 3, 7);

      // Linked findings (hypothesis-evidence-context): show current status
      const linkedNodes = Object.values(view.scoped.nodes).filter((n) => n.findingId);
      if (linkedNodes.length > 0) {
        const loadedFindings = loadFindings(workDir);
        text += `\nLinked findings:\n`;
        for (const n of linkedNodes) {
          let fStatus = "unknown";
          if (loadedFindings.ok) {
            const v = loadedFindings.value.findings.get(n.findingId!);
            if (v) fStatus = v.status;
          }
          const mark = fStatus === "revised" ? "⚠️" : fStatus === "unknown" ? "ℹ️" : "•";
          text += `  ${mark} ${n.id} → ${n.findingId} (${fStatus})\n`;
        }
      }

      // Failure streak since last keep (NOT the total — flat trees accumulate
      // the whole campaign on the root and the total always looks catastrophic)
      if (failStreak >= 6) {
        text += `\n⚠️ ${failStreak} consecutive failed hypotheses since last keep — consider a FUNDAMENTALLY different direction.\n`;
      }

      // Full detail mode: append all node details
      if (detailMode === "full") {
        text += `\n${"═".repeat(80)}\n`;
        text += `Node Details:\n\n`;
        for (const node of Object.values(view.scoped.nodes)) {
          text += renderNodeDetail(view.scoped, node) + "\n";
        }
      }

      return {
        content: [{ type: "text", text }],
        details: {
          nodeCount,
          activeNodeId: tree.activeNodeId,
          bestNodeId: bestId,
          failStreakSinceLastKeep: failStreak,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme?.fg ? theme.fg("toolTitle", theme.bold("tree_status")) : "tree_status";
      if (args?.detail) {
        text += theme?.fg ? theme.fg("dim", ` (${args.detail})`) : ` (${args.detail})`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  };
}

export function createCouncilConveneTool(deps: CouncilConveneToolDeps): RegisteredTool {
  return {
    name: "council_convene",
    label: "Convene a hypothesis council (autonomous, blocking)",
    description:
      "Convene a stagnation council at any time, with no limits — no stagnation threshold, no cooldown, no cap " +
      "(only council.enabled in .auto/config.json can veto). The tool itself convenes the council: spawns the " +
      "analysts, runs the fileless dispute and the chair, validates the slate (3–5 EXP sections, EXPECTED_GAIN >= 2x " +
      "noise floor, KILL_WHEN) and persists it to the blackboard. It BLOCKS for several minutes and returns the " +
      "finished slate. Use it when you feel stuck; your note is added to the brief the analysts read.",
    promptSnippet: "Convene a hypothesis council yourself (autonomous + blocking) — returns the finished slate",
    promptGuidelines: [
      "When stuck (e.g. a long failure streak with no keep in sight, or every direction ends in 'no effect'), convene a council: council_convene({ note: \"...\" }).",
      "The tool runs the whole council itself and blocks for several minutes; the returned text carries the finished slate — follow the instructions in that text.",
    ],
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "Why you are stuck and what the council should focus on. Goes verbatim into the brief.",
        },
      },
    },
    async execute(_toolCallId: string, params: { note?: string }, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDir = deps.resolveWorkDir(ctx.cwd);
      if (await deps.researchBlocksOrdinaryLoop(workDir, ctx)) return deps.researchBlockedResponse();
      const state = deps.getRuntime(ctx).state;
      const cfg = readCouncilConfig(workDir);
      if (!cfg.enabled) {
        return {
          content: [{ type: "text", text: "❌ Councils are disabled (council.enabled = false in .auto/config.json)." }],
          details: { outcome: "disabled" },
        };
      }

      // ── Resume or create the council dir (shared by both paths) ──
      const roster = resolveRoster(cfg);

      // Precedent summary (research-precedent-search, "Потребление агентом и советом"):
      // the newest evaluated report feeds the fresh brief; on resume it becomes the
      // supplement. Null → the brief states `not-searched` explicitly.
      const precedents = await loadLatestPrecedentDigest(workDir);

      // A pending (brief written, no slate yet) council is resumed, never re-sequenced.
      const pending = findUnfinishedCouncil(workDir);
      let seq: number;
      let councilDirAbs: string;
      let councilDirRel: string;
      let briefAbsPath: string;
      // Resume supplement (spec "Возобновление совета"): written beside the unchanged
      // 00-brief.md and carried to every child task (delegated or facilitator).
      let supplementText: string | undefined;
      if (pending) {
        seq = pending.seq;
        councilDirAbs = pending.dir;
        councilDirRel = path.relative(workDir, pending.dir).split(path.sep).join("/");
        briefAbsPath = path.join(pending.dir, "00-brief.md");
        supplementText = buildPrecedentSupplement(workDir, councilDirAbs, precedents).text;
      } else {
        const next = nextCouncilDir(workDir);
        seq = next.seq;
        councilDirAbs = next.dir;
        councilDirRel = path.relative(workDir, next.dir).split(path.sep).join("/");
        const noiseFloor = noiseFloorStatusOfDir(workDir).floor;
        buildBrief(workDir, next.dir, {
          seq,
          noiseFloor,
          metricName: state.metricName || "metric",
          metricUnit: state.metricUnit || "",
          direction: state.bestDirection,
          baselineMetric: state.baselineMetric ?? state.bestMetric ?? null,
          bestMetric: state.bestMetric ?? null,
          goal: state.goal || state.name || "",
          agentNote: params.note,
          precedents,
        });
        writeCouncilState(workDir, { councilsRun: seq, lastCouncilRun: state.results.length });
        briefAbsPath = path.join(next.dir, "00-brief.md");
      }

      let briefText = "";
      try { briefText = fs.readFileSync(briefAbsPath, "utf-8"); } catch { /* validated below */ }
      if (!briefText) {
        return {
          content: [{ type: "text", text: "❌ Brief is missing at " + briefAbsPath + " — cannot assemble the council." }],
          details: { councilSeq: seq, outcome: "no-brief" },
        };
      }

      // ── Single step: delegate the whole council through pi-subagents' structured
      // delegation seam (children are foreground leaves; the tool call blocks until
      // the validated slate returns). Falls back to the manual facilitator protocol
      // only when the seam is unavailable.
      if (delegationAvailable(deps.pi)) {
        const floor = noiseFloorStatusOfDir(workDir).floor;
        const validate = (slate: string) => validateSlate(slate, floor);
        const deadlineAt = Date.now() + cfg.timeoutMinutes * 60_000;
        const outcome = await runCouncilDelegated(deps.pi, {
          seq,
          briefText,
          participants: roster.participants.map((p) => ({ name: p.name, letter: p.letter, model: p.model, personaPrompt: personaPrompt(p.persona) })),
          chairModel: roster.chairModel,
          maxChallengeRounds: 5,
          minExperiments: 3,
          note: params.note && params.note.trim() ? params.note : undefined,
          supplementText,
          cwd: workDir,
          deadlineAt,
          validate,
        });
        if (!outcome.ok && outcome.seamUnavailable) {
          // The delegation bridge itself is dead in this session type (e.g. SDK-hosted) —
          // degrade to the manual facilitator protocol instead of blaming the models.
          const text = [
            "🏛 COUNCIL #" + seq + " convened — " + (pending ? "RESUMING the interrupted council (same dir)." : "the blackboard is ready (" + councilDirRel + ")."),
            "",
            "The automatic delegation seam is unavailable in this session — orchestrate the manual protocol below instead (via your own subagent tool, or by self-organizing the roles if even that is missing).",
            "",
            composeFacilitatorMessage({
              councilDir: councilDirRel,
              seq,
              briefAbsPath,
              roster,
              maxChallengeRounds: 5,
              minExperiments: 3,
              supplementText,
              campaignActive: await deps.campaignBlocksOrdinaryLoop(workDir),
            }),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: { councilSeq: seq, outcome: "manual-protocol", pending: pending !== null },
          };
        }
        if (!outcome.ok) {
          const text = outcome.reason === "quorum"
            ? "🏛 COUNCIL #" + seq + " — quorum failed: " + outcome.detail + "\n\nYou may retry later (a fresh call reuses this council dir), or continue the campaign normally."
            : outcome.reason === "deadline"
              ? "🏛 COUNCIL #" + seq + " — deadline hit: " + outcome.detail + "\n\nCalling council_convene again resumes this council dir."
              : "🏛 COUNCIL #" + seq + " — no slate: " + outcome.detail + "\n\nYou may retry with a different note, or continue the campaign normally.";
          return {
            content: [{ type: "text", text }],
            details: { councilSeq: seq, outcome: outcome.reason, unavailable: outcome.unavailable, rounds: outcome.rounds },
          };
        }
        const file = persistSlateEntry(councilDirAbs, outcome.slate);
        const inCampaign = await deps.campaignBlocksOrdinaryLoop(workDir);
        const nextStep = inCampaign
          ? "Follow the slate through the candidate campaign (candidate_branch: run/checkpoint on the active candidate), not run_experiment or propose_hypothesis."
          : "Register each EXP via propose_hypothesis (SimHash dedup applies) and run them through the normal loop.";
        const header = "🏛 COUNCIL #" + seq + " COMPLETE — " + outcome.rounds + " challenge round(s)"
          + (outcome.corrected ? ", slate corrected after validation" : "")
          + (outcome.unavailable.length ? ", unavailable: " + outcome.unavailable.join(", ") : "")
          + ". Slate persisted to " + councilDirRel + "/entries/" + file + "\n\n";
        return {
          content: [{ type: "text", text: header + outcome.slate + "\n\n" + nextStep + " Honor the KILL_WHEN gates — the slate may legitimately skip experiments." }],
          details: { councilSeq: seq, outcome: "complete", validated: true, rounds: outcome.rounds, corrected: outcome.corrected },
        };
      }

      const text = [
        "🏛 COUNCIL #" + seq + " convened — " + (pending ? "RESUMING the interrupted council (same dir)." : "the blackboard is ready (" + councilDirRel + ")."),
        "",
        "The automatic delegation seam is unavailable in this session — orchestrate the manual protocol below instead (via your own subagent tool, or by self-organizing the roles if even that is missing).",
        "",
        composeFacilitatorMessage({
          councilDir: councilDirRel,
          seq,
          briefAbsPath,
          roster,
          maxChallengeRounds: 5,
          minExperiments: 3,
          supplementText,
          campaignActive: await deps.campaignBlocksOrdinaryLoop(workDir),
        }),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { councilSeq: seq, outcome: "manual-protocol", pending: pending !== null },
      };
    },
  };
}
