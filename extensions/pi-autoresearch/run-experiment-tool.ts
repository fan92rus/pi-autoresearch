/**
 * run_experiment tool (extracted from index.ts; tool body byte-identical apart
 * from deps destructuring at the top of execute()). Refusal/prompt text, guard
 * order, timing/budget/kill, ledger writes, METRIC parsing and .auto paths are
 * preserved. Extension-local collaborators arrive through a wide `deps` object;
 * late-declared helpers and mutable UI state are passed as getters (no TDZ).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getBashSpawnOptions, killTree } from "./bash-shell.ts";
import { AUTO_DIR } from "./paths.ts";
import { currentResults, findBestMetric } from "./ledger-metrics.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { loadFindings } from "./findings.ts";
import { treeExists, loadTree, saveTree, treeDist, findRunningNode } from "./parallel/tree.ts";
import {
  allocateRunArtifacts, disabledRunOutputSink, highestRunDirNumber,
  openRunOutputSink, writeRunManifest, type RunArtifacts, type RunOutputSink,
} from "./lens.ts";
import { isRunNumber } from "./run-links.ts";
import { formatNum } from "./widget.ts";

type RunExperimentTool = Parameters<ExtensionAPI["registerTool"]>[0];

/**
 * Best kept metric of the durable JSONL ledger. The in-memory runtime state can
 * lag behind after measurement changes/compaction (its currentSegment may be
 * older than the ledger's), so the reported best must come from the ledger.
 */
export function bestMetricFromJsonl(
  jsonl: string,
  direction: "higher" | "lower",
  fallback: number | null = null,
): number | null {
  try {
    const restored = reconstructJsonlState(jsonl);
    return findBestMetric(restored.results, restored.currentSegment, direction) ?? fallback;
  } catch {
    return fallback;
  }
}

interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  /** True if killed specifically because it exceeded budget_seconds (not the hard timeout_seconds). */
  budgetExceeded: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;
}

/** Extension-local collaborators injected by index.ts. Every field is a thunk:
 *  a collaborator is read when the tool is called, never frozen at creation. */
export interface RunExperimentToolDeps {
  EXPERIMENT_MAX_BYTES: () => number;
  EXPERIMENT_MAX_LINES: () => number;
  RunParams: () => any;
  assertModeActive: () => (ctx: ExtensionContext) => any;
  autoresearchChecksPath: () => (dir: string) => string;
  autoresearchJsonlPath: () => (dir: string) => string;
  autoresearchScriptPath: () => (dir: string) => string;
  campaignBlockedResponse: () => () => any;
  campaignBlocksOrdinaryLoop: () => (workDir: string) => Promise<boolean>;
  execBashScript: () => (args: string[], opts?: Record<string, unknown>) => Promise<any>;
  formatElapsed: () => (ms: number) => string;
  getRuntime: () => (ctx: ExtensionContext) => any;
  isAutoresearchShCommand: () => (command: string) => boolean;
  isBugfixCampaignMeasureCommand: () => (command: string, workDir: string) => boolean;
  optimizeNotStartedGate: () => (ctx: ExtensionContext) => any;
  overlayTui: () => { requestRender: () => void } | null;
  parseMetricLines: () => (output: string) => Map<string, number>;
  readExperimentMaxMinutes: () => (cwd: string) => number | null;
  readLedgerMaxRun: () => (workDir: string) => number;
  readRunAnalysisConfig: () => (workDir: string) => any;
  researchBlockedResponse: () => () => any;
  researchBlocksOrdinaryLoop: () => (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  resolveWorkDir: () => (cwd: string) => string;
  tryBeginRunIdentity: () => (runtime: any, run: number | null, prefix: any) => string | null;
  tryRecordPendingMarker: () => (runtime: any, kind: "started" | "result", executionId: string, line: string | null) => void;
  updateWidget: () => (ctx: ExtensionContext) => void;
  validateWorkDir: () => (cwd: string) => string | null;
  writeRunStartedMarkerWithPrefix: () => (autoDir: string, jsonlPath: string, buildLine: () => string) => Promise<{ prefix: any; line: string }>;
}

/** Resolve thunks once at the call boundary; the result is scoped to that call. */
export function readGetterDeps<T extends Record<string, () => any>>(deps: T): { [K in keyof T]: ReturnType<T[K]> } {
  const out = {} as { [K in keyof T]: ReturnType<T[K]> };
  for (const key of Object.keys(deps) as (keyof T)[]) {
    (out as Record<string, unknown>)[String(key)] = deps[key]();
  }
  return out;
}

export function createRunExperimentTool(deps: RunExperimentToolDeps): RunExperimentTool {
  // Only schema constants are read at construction: late-declared collaborators
  // are getters that must not be called before the extension body finishes.
  const EXPERIMENT_MAX_LINES = deps.EXPERIMENT_MAX_LINES();
  const EXPERIMENT_MAX_BYTES = deps.EXPERIMENT_MAX_BYTES();
  const RunParams = deps.RunParams();
  return {
    name: "run_experiment",
    label: "Run Experiment",
    description:
      `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). Full output is always saved to .auto/runs/<n>/output.txt (the path is in the response). Use for any autoresearch experiment.`,
    promptSnippet:
      "Run a timed experiment command (captures duration, output, exit code). Ordinary loop; blocked during a candidate campaign.",
    promptGuidelines: [
      "An experiment ONLY exists if it ran through run_experiment: bash-run benchmarks are invisible to the ledger, corrupt the noise floor, and their edits are lost on the next revert.",
      "Always pass a tight timeout_seconds (required). A runaway process will be force-killed at the limit and logged as 'crash'.",
      "After run_experiment, always call log_experiment to record the result.",
      "ALWAYS call propose_hypothesis BEFORE run_experiment to get a hypothesis_id. Pass hypothesis_id to both run_experiment and log_experiment.",
      "Exception: the baseline run (first after init_experiment) does NOT need hypothesis_id.",
      "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",
    ],
    parameters: RunParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const {
        assertModeActive, campaignBlockedResponse, campaignBlocksOrdinaryLoop,
        execBashScript, getRuntime, optimizeNotStartedGate,
        readExperimentMaxMinutes, readLedgerMaxRun, researchBlockedResponse,
        researchBlocksOrdinaryLoop, resolveWorkDir, updateWidget, validateWorkDir,
        isAutoresearchShCommand, isBugfixCampaignMeasureCommand,
        autoresearchJsonlPath, autoresearchScriptPath,
        autoresearchChecksPath, writeRunStartedMarkerWithPrefix,
        tryBeginRunIdentity, tryRecordPendingMarker, parseMetricLines,
        formatElapsed, readRunAnalysisConfig,
      } = readGetterDeps(deps);
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      // Candidate-branch campaign guard (tasks 3.2): an active campaign blocks
      // the ordinary loop. A missing state keeps the ordinary behavior; an unreadable state fails closed.
      // (Placed after the existing workDirError validation below.)
      const runtime = getRuntime(ctx);
      const state = runtime.state;

      // Validate working directory exists
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return {
          content: [{ type: "text", text: `❌ ${workDirError}` }],
          details: {},
        };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      if (await campaignBlocksOrdinaryLoop(workDir)) return campaignBlockedResponse();
      if (await researchBlocksOrdinaryLoop(workDir, ctx)) return researchBlockedResponse();
      // A prepared bugfix campaign has its own measurer; recognise it only so
      // the measure.sh guard below can let that exact command through.
      const isBugfixMeasure = isBugfixCampaignMeasureCommand(params.command, workDir);
      const looksLikeBugfixMeasure = /^\s*node\s+[^\n]*bugfix-mode-measure\.ts["']?\s+--campaign\b/.test(params.command);
      const optimizeRunGate = optimizeNotStartedGate(ctx);
      if (optimizeRunGate) return optimizeRunGate as any;
      // The config (and therefore the cap) always lives in ctx.cwd — even when
      // workingDir redirects the experiment work elsewhere (see readConfig).
      const expMaxMinutes = readExperimentMaxMinutes(ctx.cwd);

      // Project time cap (.auto/config.json experiment_max_minutes): reject a
      // timeout beyond it with a reminder — the agent must adapt the experiment
      // (smaller workload, quick subset) instead of asking for more time.
      if (expMaxMinutes !== null && params.timeout_seconds > expMaxMinutes * 60) {
        return {
          content: [{ type: "text", text:
            `⛔ TIMEOUT OVER PROJECT LIMIT: timeout_seconds=${params.timeout_seconds}s but experiment_max_minutes=${expMaxMinutes} (${expMaxMinutes * 60}s) in .auto/config.json.\n` +
            `The cap is fixed — ADAPT THE EXPERIMENT to fit, do not ask for more time:\n` +
            `- cut the workload: smaller fixture/corpus, fewer iterations, measure a subset\n` +
            `- add a BENCH_MODE=quick subset to measure.sh and benchmark that\n` +
            `- move warm-up/caching outside the timed region\n` +
            `Re-issue run_experiment with timeout_seconds <= ${expMaxMinutes * 60}.` }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            budgetExceeded: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
            overTimeLimit: true,
            limitSeconds: expMaxMinutes * 60,
          } as RunDetails,
        };
      }

      // Block if max experiments limit already reached
      if (state.maxExperiments !== null) {
        const segCount = currentResults(state.results, state.currentSegment).length;
        if (segCount >= state.maxExperiments) {
          return {
            content: [{ type: "text", text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.` }],
            details: {},
          };
        }
      }

      // Hard timeout — required parameter (validated by schema minimum: 1).
      // Budget: a soft kill below the hard timeout. When set and <= timeout,
      // the kill timer uses the budget and the result is flagged budget_exceeded.
      const hardTimeoutSeconds = params.timeout_seconds;
      const hardTimeoutMs = hardTimeoutSeconds * 1000;
      const budgetMs = params.budget_seconds != null ? params.budget_seconds * 1000 : null;
      if (budgetMs !== null && budgetMs > hardTimeoutMs) {
        return {
          content: [{ type: "text", text: `❌ budget_seconds (${params.budget_seconds}) must be <= timeout_seconds (${hardTimeoutSeconds}).` }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            budgetExceeded: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }
      const killedByBudget = budgetMs !== null; // safe: validated <= hardTimeoutMs above
      const timeout = killedByBudget ? budgetMs! : hardTimeoutMs;

      // ── Hypothesis validation ──
      // hypothesis_id links this run to a pre-registered hypothesis node.
      // Required for all non-baseline experiments. Baseline exception: when
      // the tree root has no experiment/hypothesis children yet (first run).
      let repeatWarning = "";
      let findingRunWarning = "";
      let runningNodeId: string | null = null;

      if (params.hypothesis_id) {
        // ── New flow: validate pre-registered hypothesis node ──
        if (!treeExists(workDir)) {
          return {
            content: [{ type: "text", text: `❌ hypothesis_id="${params.hypothesis_id}" but no tree exists. Call init_experiment first.` }],
            details: {},
          };
        }
        const tree = loadTree(workDir);
        if (!tree) {
          return {
            content: [{ type: "text", text: `❌ Failed to load tree.json for hypothesis_id="${params.hypothesis_id}".` }],
            details: {},
          };
        }
        const node = tree.nodes[params.hypothesis_id];
        if (!node) {
          return {
            content: [{ type: "text", text: `❌ hypothesis_id="${params.hypothesis_id}" not found in tree. Call propose_hypothesis first.` }],
            details: {},
          };
        }
        if (node.status === "duplicate") {
          return {
            content: [{ type: "text", text: `❌ hypothesis_id="${params.hypothesis_id}" is a duplicate. Re-propose with force=true if genuinely different.` }],
            details: {},
          };
        }
        if (node.status !== "untested") {
          return {
            content: [{ type: "text", text: `❌ hypothesis_id="${params.hypothesis_id}" has status="${node.status}". Only untested hypotheses can be run.` }],
            details: {},
          };
        }
        // Finding-revision warning (hypothesis-evidence-context)
        if (node.findingId) {
          const loadedFindings = loadFindings(workDir);
          if (!loadedFindings.ok) {
            findingRunWarning = `\nℹ️ Hypothesis linked to finding ${node.findingId}; its current status is unknown (findings store unreadable).`;
          } else {
            const view = loadedFindings.value.findings.get(node.findingId);
            if (!view) {
              findingRunWarning = `\nℹ️ Hypothesis linked to finding ${node.findingId}; its current status is unknown (finding not found).`;
            } else if (view.status === "revised") {
              findingRunWarning = `\n⚠️ Linked finding ${node.findingId} is revised — check whether the hypothesis is still relevant.`;
            }
          }
        }

        // Warn if hypothesis was proposed under a different branch (code diverged)
        const td = treeDist(tree, tree.activeNodeId, node.id);
        if (td > 2) {
          const parent_1 = tree.nodes[node.parentId!]?.id ?? "?";
          repeatWarning =
            `\n⚠️ DIVERGED BRANCH: ${node.id} was proposed under ${parent_1} (td=${td} from active ${tree.activeNodeId}).\n` +
            `  Code has changed since registration — results may differ from expectations.`;
        }
        // Transition to running
        node.status = "running";
        saveTree(workDir, tree);
        runningNodeId = node.id;
      } else {
        // ── No hypothesis_id: check baseline exception ──
        if (treeExists(workDir)) {
          const tree = loadTree(workDir);
          if (tree) {
            const root = tree.nodes[tree.rootId];
            const hasChildren = root && root.children.length > 0;
            if (hasChildren) {
              return {
                content: [{ type: "text", text: `❌ hypothesis_id is required for non-baseline experiments.\n  Call propose_hypothesis first, then run_experiment(hypothesis_id: \"nX\").` }],
                details: {},
              };
            }
            // Baseline context: root has no children yet. Allowed.
          }
        }
      }

      // Guard: if the benchmark script exists, only allow running it
      const autoresearchShPath = autoresearchScriptPath(workDir);
      const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
      if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(params.command) && !isBugfixMeasure) {
        return {
          content: [{
            type: "text",
            text: looksLikeBugfixMeasure
              ? `❌ The prepared bugfix measurement command is not accepted by this runtime. The installed autoresearch extension is likely stale: run \`pi update https://github.com/fan92rus/pi-autoresearch\` and restart the session.\n\nYour command: ${params.command}`
              : `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${params.command}\n\nUse: run_experiment({ command: "bash ${benchmarkScriptRel}", timeout_seconds: 180 }) or run_experiment({ command: "./${benchmarkScriptRel}", timeout_seconds: 180 })`,
          }],
          details: {
            command: params.command,
            exitCode: null,
            durationSeconds: 0,
            passed: false,
            crashed: true,
            timedOut: false,
            budgetExceeded: false,
            tailOutput: "",
            checksPass: null,
            checksTimedOut: false,
            checksOutput: "",
            checksDuration: 0,
          } as RunDetails,
        };
      }

      // Full output goes to .auto/runs/<n>/output.txt from the first byte, so a
      // crash, timeout or abort keeps whatever was printed before it. The run
      // number is minted here and reused by log_experiment, so the ledger entry
      // for this run always names the directory holding its output
      // (inspect_results reads .auto/runs/<run>/ by the ledger number). The
      // ledger floor covers campaigns that predate .auto/runs (their run
      // numbers are far ahead of the dirs) and unlogged runs (dirs ahead of the
      // ledger); the exclusive mkdir above the highest dir prevents overwrite.
      // Artifacts are best-effort by contract (spec result-lens: missing or
      // unwritable artifacts are logged, never fatal): if `.auto/runs` cannot
      // be created/opened the run still executes, persistence is simply off
      // and the reason surfaces in the response. A ledger-safe number is
      // minted either way so log_experiment never collides with old numbers.
      let runArtifacts: RunArtifacts | null = null;
      let outputSink: RunOutputSink = disabledRunOutputSink("artifact persistence not attempted");
      try {
        runArtifacts = allocateRunArtifacts(workDir, readLedgerMaxRun(workDir) + 1);
        runtime.lastRunNumber = runArtifacts.runNumber;
        outputSink = openRunOutputSink(runArtifacts.outputPath);
      } catch (e) {
        if (runArtifacts === null) {
          runtime.lastRunNumber = Math.max(readLedgerMaxRun(workDir), highestRunDirNumber(workDir)) + 1;
        } else {
          // Directory allocated but the sink could not be opened: the number
          // stays (the ledger binds to it), but no path is reported — nothing
          // readable is guaranteed to exist under it.
          runArtifacts = null;
        }
        outputSink = disabledRunOutputSink(
          `run artifacts unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Task 1.3: declared-artifact copying + the run manifest are driven by
      // the analysis header (init-time config, see readRunAnalysisConfig).
      // Read once before the spawn; the manifest itself is written when the
      // run settles, in the spawn's finally below, so aborted, crashed and
      // timed-out runs keep their artifacts too.
      const runAnalysisConfig = readRunAnalysisConfig(workDir);

      // TODO(/tree): replace compaction-based resume with a checkpoint-per-iteration model.
      runtime.runningExperiment = { startedAt: Date.now(), command: params.command };
      // Run-links identity (§5.2): 128-bit execution_id bound to the minted
      // run number BEFORE the run_started marker write, so the exact serialized
      // line can be captured at the moment of writing. Best-effort: on any
      // failure the run continues without a sidecar record (D-RM-08). The
      // analysis prefix snapshot AND the run_started marker write share the
      // shared analysis.lock critical section; a busy lock, torn tail, read
      // error or failed marker write degrades per §5.2 (null prefix pair /
      // sticky-incomplete identity) and never blocks the run.
      const runNumberForLinks = runArtifacts?.runNumber ?? null;
      const runLinkRun = isRunNumber(runNumberForLinks) ? runNumberForLinks : null;
      let runLinkExecutionId: string | null = null;
      const runStartedAt = new Date().toISOString();
      let runNodeId: string | null = params.hypothesis_id ?? null;
      if (!runNodeId && treeExists(workDir)) {
        try {
          const startedTree = loadTree(workDir);
          runNodeId = startedTree ? (findRunningNode(startedTree)?.id ?? null) : null;
        } catch { runNodeId = null; }
      }
      const jsonlPath = autoresearchJsonlPath(workDir);
      const buildRunStartedLine = () => JSON.stringify({ type: "run_started", run_dir: runArtifacts?.runNumber, node_id: runNodeId, command: params.command, started_at: runStartedAt });
      try {
        const markerOutcome = await writeRunStartedMarkerWithPrefix(path.join(workDir, AUTO_DIR), jsonlPath, buildRunStartedLine);
        runLinkExecutionId = tryBeginRunIdentity(runtime, runLinkRun, markerOutcome.prefix);
        if (runLinkExecutionId !== null) {
          tryRecordPendingMarker(runtime, "started", runLinkExecutionId, markerOutcome.line);
        }
      } catch { /* best-effort: run continues without pending identity */ }
      // Ledger marker written BEFORE the spawn (goal-x discipline: events before
      // action, inside the critical section above). If the session dies
      // mid-benchmark, reconstructState sees a run_started without a matching
      // run_result and marks the hypothesis node crashed.
      updateWidget(ctx);
      deps.overlayTui()?.requestRender();

      const t0 = Date.now();

      // Spawn the process directly (like the bash tool) for streaming output
      const { exitCode, killed: timedOut, output } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
      }>((resolve, reject) => {
        let processTimedOut = false;

        // Resolve the shell through getBashSpawnOptions: a bare spawn("bash") on
        // Windows lets CreateProcess find System32\bash.exe (the WSL launcher)
        // before any PATH entry — with WSL installed but broken this is exactly
        // the "experiment invokes WSL bash" failure mode.
        const bashSpawn = getBashSpawnOptions();
        const child = spawn(bashSpawn.shell, ["-c", params.command], {
          cwd: workDir,
          detached: bashSpawn.detached,
          stdio: ["ignore", "pipe", "pipe"],
          env: params.bench_mode ? { ...process.env, BENCH_MODE: params.bench_mode } : process.env,
          windowsHide: true,
        });

        // Rolling buffer for tail truncation (keep 2x what we need)
        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        // Cache for Buffer.concat — only rebuild when chunks change
        let chunksGeneration = 0;
        let cachedGeneration = -1;
        let cachedText = "";

        function getBufferText(): string {
          if (cachedGeneration === chunksGeneration) return cachedText;
          cachedText = Buffer.concat(chunks).toString("utf-8");
          cachedGeneration = chunksGeneration;
          return cachedText;
        }

        // Timer interval — update every second with elapsed time + tail output
        const timerInterval = setInterval(() => {
          if (!onUpdate) return;
          const elapsed = formatElapsed(Date.now() - t0);
          const trunc = truncateTail(getBufferText(), {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          onUpdate({
            content: [{ type: "text", text: trunc.content || "" }],
            details: {
              phase: "running",
              elapsed,
              truncation: trunc.truncated ? trunc : undefined,
              fullOutputPath: runArtifacts?.outputPath,
            },
          });
        }, 1000);

        const handleData = (data: Buffer) => {
          outputSink.write(data);

          // Keep rolling buffer of recent data
          chunks.push(data);
          chunksBytes += data.length;

          // Evict old chunks, then trim the first surviving chunk to a line
          // boundary. This avoids splitting multi-byte UTF-8 characters that
          // straddle chunk boundaries (which would produce U+FFFD on decode).
          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          // Trim first surviving chunk to a newline boundary
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a); // '\n'
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }

          chunksGeneration++;
        };

        if (child.stdout) child.stdout.on("data", handleData);
        if (child.stderr) child.stderr.on("data", handleData);

        // Timeout
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let terminationFallbackHandle: ReturnType<typeof setTimeout> | undefined;
        let terminationReason = "killTree result pending";
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) {
              try {
                Promise.resolve(killTree(child.pid))
                  .then((outcome) => {
                    if (outcome?.reason) terminationReason = outcome.reason;
                    if (outcome?.verified === true) terminationReason = "verified";
                  })
                  .catch((e) => { terminationReason = `killTree rejected: ${String(e)}`; });
              } catch (e) {
                terminationReason = `killTree threw: ${String(e)}`;
              }
            } else {
              terminationReason = "no child pid";
            }
            // killTree is best-effort. If the child survives it, close never
            // fires; bound the wait and reject instead of hanging the tool.
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            terminationFallbackHandle = setTimeout(() => {
              finish(
                null,
                `\n[termination] killTree ${terminationReason}; child termination not verified`,
              );
            }, 1000);
          }, timeout);
        }

        // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
        // Using child.kill() as fallback ensures the signal is never silently swallowed.
        const onAbort = () => {
          if (child.pid) killTree(child.pid);
          else {
            // pid not yet assigned — try child.kill() which works without pid,
            // and also queue killTree for spawn in case child.kill() isn't enough
            // to clean up the full process tree.
            child.kill();
            child.once("spawn", () => { if (child.pid) killTree(child.pid); });
          }
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        child.on("error", (err) => {
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (terminationFallbackHandle) clearTimeout(terminationFallbackHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        });

        let finished = false;
        const finish = (code: number | null, note?: string): void => {
          if (finished) return;
          finished = true;
          clearInterval(timerInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (terminationFallbackHandle) clearTimeout(terminationFallbackHandle);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }

          if (note) {
            const noteBuffer = Buffer.from(note, "utf-8");
            outputSink.write(noteBuffer);
            chunks.push(noteBuffer);
          }
          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString("utf-8"),
          });
        };
        child.on("close", (code) => finish(code));
      }).finally(() => {
        outputSink.close();
        // Task 1.3: manifest AFTER the sink close — output.txt must be
        // complete before it is hashed, and this runs on every settle path
        // (exit, crash, timeout, abort). Best-effort by contract:
        // writeRunManifest never throws and writes nothing when nothing is
        // declared; a missing or garbled manifest must not fail a finished
        // run.
        if (runArtifacts !== null && runAnalysisConfig !== null) {
          writeRunManifest(workDir, runArtifacts, runAnalysisConfig);
        }
        runtime.runningExperiment = null;
        updateWidget(ctx);
        deps.overlayTui()?.requestRender();
      });

      const durationSeconds = (Date.now() - t0) / 1000;
      runtime.lastRunDuration = durationSeconds;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run backpressure checks if benchmark passed and checks file exists
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = "";
      let checksDuration = 0;

      const checksPath = autoresearchChecksPath(workDir);
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
        const ct0 = Date.now();
        try {
          const checksResult = await execBashScript([checksPath], {
            signal,
            timeout: checksTimeout,
            cwd: workDir,
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = !!checksResult.killed;
          checksPass = checksResult.code === 0 && !checksResult.killed;
          checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
        } catch (e) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = false;
          checksOutput = e instanceof Error ? e.message : String(e);
        }
      }

      // Store checks result for log_experiment gate
      runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

      const passed = benchmarkPassed && (checksPass === null || checksPass);

      const fullOutputPath = runArtifacts?.outputPath;

      // Wider truncation for TUI display (details.tailOutput)
      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      // Tight truncation for LLM context (10 lines / 4KB)
      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Matching ledger marker AFTER the spawn resolves (exit/timeout/kill alike).
      let runResultLine: string | null = null;
      try {
        const jsonlPath = autoresearchJsonlPath(workDir);
        runResultLine = JSON.stringify({ type: "run_result", run_dir: runArtifacts?.runNumber, started_at: runStartedAt, node_id: runNodeId, exit_code: exitCode, killed: timedOut, duration_seconds: Number(durationSeconds.toFixed(1)) });
        fs.appendFileSync(jsonlPath, runResultLine + "\n");
      } catch {
        // best-effort
        runResultLine = null;
      }
      if (runLinkExecutionId !== null) {
        // A late/evicted identity is ignored inside recordPendingMarker (§5.2):
        // completion never replaces a newer pending object.
        tryRecordPendingMarker(runtime, "result", runLinkExecutionId, runResultLine);
      }

      // Parse structured METRIC lines from output
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics = parsedMetricMap.size > 0
        ? Object.fromEntries(parsedMetricMap)
        : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      const details: RunDetails = {
        command: params.command,
        exitCode,
        durationSeconds,
        passed,
        crashed: !passed,
        timedOut,
        budgetExceeded: timedOut && killedByBudget,
        tailOutput: displayTruncation.content,
        checksPass,
        checksTimedOut,
        checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
      };

      // Honest-metric provenance: remember what run_experiment actually measured,
      // so log_experiment can flag hand-copied or invented numbers (goal-x
      // pattern: the claim is untrusted, the measurement is the evidence).
      runtime.lastMeasurement = { primary: parsedPrimary, wallClockSeconds: durationSeconds };

      // Build LLM response
      let text = "";
      if (details.budgetExceeded) {
        text += `⏰ BUDGET EXCEEDED after ${durationSeconds.toFixed(1)}s (budget ${params.budget_seconds}s)\n`;
        text += `Log this as 'budget_exceeded'. The time cap is fixed${expMaxMinutes !== null ? ` (experiment_max_minutes=${expMaxMinutes} in .auto/config.json)` : ""} — do not drop the experiment and do not benchmark via bash: ADAPT it so a single run fits — smaller fixture/corpus, fewer iterations, a BENCH_MODE=quick subset, warm-up outside the timed region.\n`;
      } else if (details.timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s (hard limit ${params.timeout_seconds}s)\n`;
        text += `Log this as 'crash'. The time cap is fixed${expMaxMinutes !== null ? ` (experiment_max_minutes=${expMaxMinutes} in .auto/config.json)` : ""} — do not raise timeout_seconds beyond it: ADAPT the experiment so a single run fits — smaller fixture/corpus, fewer iterations, a BENCH_MODE=quick subset, warm-up outside the timed region.\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
        text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      // `state.bestMetric` is the restored epoch baseline, not the best kept
      // result (a re-init resets it to the baseline). Show the actual best
      // so the agent's decision gate compares against the right number.
      const ledgerPath = autoresearchJsonlPath(workDir);
      const fallbackBest = findBestMetric(state.results, state.currentSegment, state.bestDirection) ?? state.bestMetric;
      const displayedBest = fs.existsSync(ledgerPath)
        ? bestMetricFromJsonl(fs.readFileSync(ledgerPath, "utf8"), state.bestDirection, fallbackBest)
        : fallbackBest;
      if (displayedBest !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(displayedBest, state.metricUnit)}\n`;
      }

      // Show parsed METRIC lines to the LLM
      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

        // Human-readable summary
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          // Infer unit from name suffix for display
          const sm = state.secondaryMetrics.find((m) => m.name === name);
          const unit = sm?.unit ?? "";
          text += ` ${name}=${formatNum(value, unit)}`;
        }

        // Machine-ready values for log_experiment (raw numbers, not formatted)
        text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === "lines") {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      } else if (fullOutputPath) {
        text += `\n\nFull output: ${fullOutputPath}`;
      }
      if (outputSink.error !== null) {
        text += runArtifacts === null
          ? `\n⚠ ${outputSink.error}`
          : `\n⚠ Full output was not completely persisted: ${outputSink.error}`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
      }

      // Append pre-run warnings (diverged branch, etc.)
      if (repeatWarning) {
        text += repeatWarning;
      }
      if (findingRunWarning) {
        text += findingRunWarning;
      }

      // Include hypothesis node info
      if (runningNodeId) {
        text += `\n🧪 Hypothesis node: ${runningNodeId} (status=running). Pass to log_experiment(hypothesis_id: "${runningNodeId}") after.`;
      }

      return {
        content: [{ type: "text", text }],
        details: { ...details, truncation: llmTruncation.truncated ? llmTruncation : undefined, fullOutputPath },
      };
    },

    renderCall(args, theme) {
      let text = theme?.fg ? theme.fg("toolTitle", theme.bold("run_experiment ")) : "run_experiment ";
      text += theme?.fg ? theme.fg("muted", String(args?.command ?? "")) : String(args?.command ?? "");
      if (args?.timeout_seconds) {
        text += theme?.fg ? theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`) : ` (timeout: ${args.timeout_seconds}s)`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const PREVIEW_LINES = 5;

      if (isPartial) {
        // Streaming: show elapsed timer + tail of output
        const d = result.details as { phase?: string; elapsed?: string; truncation?: any; fullOutputPath?: string } | undefined;
        const elapsed = d?.elapsed ?? "";
        const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

        let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

        // Always show tail of streaming output (like bash tool shows preview lines)
        if (outputText) {
          const lines = outputText.split("\n");
          const maxLines = expanded ? 20 : PREVIEW_LINES;
          const tail = lines.slice(-maxLines).join("\n");
          if (tail.trim()) {
            text += "\n" + theme.fg("dim", tail);
          }
        }

        return new Text(text, 0, 0);
      }

      const d = result.details as (RunDetails & { truncation?: any; fullOutputPath?: string }) | undefined;
      if (!d) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }

      // Helper: append tail output preview or full output
      const appendOutput = (text: string, output: string): string => {
        if (!output) return text;
        const lines = output.split("\n");
        if (expanded) {
          text += "\n" + theme.fg("dim", output.slice(-2000));
        } else {
          const tail = lines.slice(-PREVIEW_LINES).join("\n");
          if (tail.trim()) {
            const hidden = lines.length - PREVIEW_LINES;
            if (hidden > 0) {
              text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
            }
            text += "\n" + theme.fg("dim", tail);
          }
        }
        return text;
      };

      if (d.timedOut) {
        let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      // Helper: format parsed primary metric suffix (empty string if not available)
      const parsedSuffix = d.parsedPrimary !== null
        ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
        : "";

      if (d.checksTimedOut) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.checksPass === false) {
        let text =
          theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
          parsedSuffix +
          theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
        text = appendOutput(text, d.checksOutput);
        return new Text(text, 0, 0);
      }

      if (d.crashed) {
        let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
        text = appendOutput(text, d.tailOutput);
        return new Text(text, 0, 0);
      }

      let text = theme.fg("success", "✅ ");

      // Show wall-clock and parsed primary metric together
      const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
      if (d.parsedPrimary !== null) {
        parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
      }
      text += theme.fg("accent", parts.join(", "));

      if (d.checksPass === true) {
        text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
      }

      if (d.truncation?.truncated && d.fullOutputPath) {
        text += theme.fg("warning", " (truncated)");
      }

      text = appendOutput(text, d.tailOutput);

      if (expanded && d.truncation?.truncated && d.fullOutputPath) {
        if (d.truncation.truncatedBy === "lines") {
          text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
        } else {
          text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
        }
      }

      return new Text(text, 0, 0);
    },
  };
}
