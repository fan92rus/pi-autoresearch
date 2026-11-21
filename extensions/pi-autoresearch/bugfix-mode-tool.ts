/**
 * bugfix_mode tool: campaign setup and proof bookkeeping for the reusable
 * defect-hunting loop. It never commits, reverts or runs the full suite, so it
 * cannot include or destroy foreign working-tree changes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTree, saveTree } from "./parallel/tree.ts";
import {
  BUGFIX_METRIC_VERSION,
  DISCOVERY_CHECKS,
  PROOF_CHECKS,
  inspectEvidence,
  isSafeCampaignId,
  validateBugfixConfig,
  type CheckName,
  type Severity,
} from "./bugfix-mode.ts";
import {
  appendRow,
  bugfixMeasureCommand,
  campaignDir,
  DECISIONS_FILE,
  EVIDENCE_FILE,
  hashMeasurementFiles,
  readRows,
  readStoredConfig,
  writeStoredConfig,
} from "./bugfix-mode-store.ts";

type ToolLike = Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["registerTool"]>[0];

export interface BugfixModeToolDeps {
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  validateWorkDir: (cwd: string) => string | null;
  resolveWorkDir: (cwd: string) => string;
  campaignBlocksOrdinaryLoop: (dir: string) => Promise<boolean>;
  campaignBlockedResponse: () => any;
  researchBlocksOrdinaryLoop: (dir: string, ctx: ExtensionContext) => Promise<boolean>;
  researchBlockedResponse: () => any;
  execBashScript: (
    args: string[],
    options: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
  /** Absolute paths to the packaged measurer and scoring core. */
  scorerFilePaths: string[];
  /** Absolute path printed as the run_experiment command for the campaign. */
  measureCliPath: string;
  /** Same predicate run_experiment uses; catches a stale installed runtime early. */
  isBugfixMeasureCommand: (command: string, workDir: string) => boolean;
}

const SEVERITIES: readonly Severity[] = ["P1", "P2", "P3"];

const BugfixModeParams = Type.Object({
  action: Type.String({ description: "prepare | record | decide" }),
  campaignId: Type.String({ description: "Stable campaign id: [A-Za-z0-9._-]{1,64}" }),
  config: Type.Optional(Type.Object({
    name: Type.String(),
    testCommand: Type.String(),
    testIdCommand: Type.String({ description: "Template containing {test}, e.g. node --test {test}" }),
    proofCommands: Type.Object({
      good: Type.String(),
      defect: Type.String(),
      fixed: Type.String(),
      counterfactual: Type.String(),
    }, { description: "Checks fixed for the whole campaign; per-experiment commands are not accepted." }),
    scopePaths: Type.Array(Type.String()),
    baseRef: Type.String(),
    baselineFail: Type.Number(),
    baselineTests: Type.Number(),
  }, { description: "Project parameters for prepare; no defaults from another campaign." })),
  experimentId: Type.Optional(Type.String()),
  defectId: Type.Optional(Type.String()),
  severity: Type.Optional(Type.String({ description: "P1 | P2 | P3" })),
  stateIds: Type.Optional(Type.Object({
    defect: Type.String(),
    good: Type.Optional(Type.String()),
    fixed: Type.Optional(Type.String()),
    counterfactual: Type.Optional(Type.String()),
  })),
  phase: Type.Optional(Type.String({ description: "discover (N immediately) | proof (2N on keep)" })),
  detectorTests: Type.Optional(Type.Array(Type.String(), { description: "Test ids that revealed this defect." })),
  proofTests: Type.Optional(Type.Array(Type.String(), { description: "Test ids that lock in this fix." })),
  status: Type.Optional(Type.String({ description: "keep | discard for decide" })),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Per-check timeout, default 120." })),
});

const reply = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});
const refusal = (text: string, reason: string) => reply(`❌ ${text}`, { reason });

/** Pre-existing changes outside .auto are never included or reverted by the mode. */
export function dirtyTreeProblem(statusOutput: string): string | null {
  const offenders = statusOutput.split(/\r?\n/).filter((line) => {
    if (line.trim() === "") return false;
    const target = line.slice(3).trim();
    return target !== ".auto" && !target.startsWith(".auto/");
  });
  return offenders.length === 0
    ? null
    : `Refusing to prepare bugfix campaign: pre-existing working-tree changes must be committed or stashed first:\n${offenders.slice(0, 12).join("\n")}`;
}

function requiredText(value: unknown, name: string): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function createBugfixModeTool(deps: BugfixModeToolDeps): ToolLike {
  return {
    name: "bugfix_mode",
    label: "Bugfix mode",
    description:
      "Prepare a reusable defect-hunting campaign, execute proof checks and record keep/discard decisions. " +
      "Campaign state stays under .auto/bugfix/<id>/; existing .auto/measure.sh and the working tree are not touched.",
    promptSnippet: "Prepare/run the reusable bugfix campaign with executable proofs",
    promptGuidelines: [
      "Call prepare once with explicit project parameters. Record phase=discover with good/defect refs to pay N immediately, then phase=proof with defect/fixed/counterfactual refs before decide keep for 2N.",
      "Use the returned node command with run_experiment; a discard earns no credit but is not an invalid proof.",
      "For stagnation analysis use the existing tree_status and direction_review tools; stagnation is not proof that all defects are found.",
    ],
    parameters: BugfixModeParams,

    async execute(_toolCallId: string, params: Record<string, any>, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = deps.validateWorkDir(ctx.cwd);
      if (workDirError) return reply(`❌ ${workDirError}`);
      const dir0 = deps.resolveWorkDir(ctx.cwd);
      if (await deps.campaignBlocksOrdinaryLoop(dir0)) return deps.campaignBlockedResponse();
      if (await deps.researchBlocksOrdinaryLoop(dir0, ctx)) return deps.researchBlockedResponse();
      const workDir = dir0;
      const action = params.action;
      const campaignId = params.campaignId;
      if (!isSafeCampaignId(campaignId)) {
        return refusal("campaignId: expected 1-64 characters from [A-Za-z0-9._-]", "invalid_campaign_id");
      }

      if (action === "prepare") {
        const config = validateBugfixConfig({ ...(params.config ?? {}), campaignId });
        if (!config.ok) return refusal(config.error, "invalid_config");
        const status = await deps.execBashScript(["-c", "git status --porcelain=v1 --ignored=matching"], {
          cwd: workDir, timeout: 30_000,
        });
        if (status.code !== 0) {
          return refusal(`git status failed (exit ${status.code}): ${(status.stderr || status.stdout).slice(0, 300)}`, "tree_check_failed");
        }
        const treeProblem = dirtyTreeProblem(status.stdout);
        if (treeProblem) return refusal(treeProblem, "dirty_tree");
        const hashes = hashMeasurementFiles(deps.scorerFilePaths, workDir);
        const written = writeStoredConfig(workDir, campaignId, config.value, hashes);
        if (!written.ok) return refusal(written.error, "campaign_exists");
        const command = bugfixMeasureCommand(deps.measureCliPath, campaignId, workDir);
        if (!deps.isBugfixMeasureCommand(command, workDir)) {
          fs.rmSync(written.value.dir, { recursive: true, force: true });
          return refusal(
            "Installed autoresearch extension is stale: run_experiment would reject this prepared bugfix command. " +
            "Run `pi update https://github.com/fan92rus/pi-autoresearch` and restart the session before preparing a campaign.",
            "stale_extension",
          );
        }
        // Bugfix campaigns log through bugfix_mode, not init_experiment, so
        // the tree's metric label would otherwise keep naming an older
        // campaign scale in tree_status and the dashboard.
        const tree = loadTree(workDir);
        if (tree && tree.metricName !== BUGFIX_METRIC_VERSION) {
          saveTree(workDir, { ...tree, metricName: BUGFIX_METRIC_VERSION });
        }
        return reply(
          `Bugfix campaign ${campaignId} prepared at ${written.value.filePath}.\n` +
          `Run it with run_experiment({ command: ${JSON.stringify(command)}, timeout_seconds: 600 }).\n` +
          `Metric: ${config.value.name}. Existing campaign scripts were not modified.`,
          { campaignDir: written.value.dir, command },
        );
      }

      const stored = readStoredConfig(workDir, campaignId);
      if (!stored.ok) return refusal(stored.error, "campaign_not_prepared");
      if (campaignDir(workDir, campaignId) === null) return refusal("invalid campaignId", "invalid_campaign_id");

      if (action === "record") {
        const experimentId = requiredText(params.experimentId, "experimentId");
        const defectId = requiredText(params.defectId, "defectId");
        const severity = params.severity;
        const stateIds = params.stateIds;
        const phase = params.phase === "discover" ? "discover"
          : params.phase === undefined || params.phase === "proof" ? "proof" : null;
        const names: readonly CheckName[] = phase === "discover" ? DISCOVERY_CHECKS : PROOF_CHECKS;
        // Test ids are interpolated into a frozen shell template: allow only safe path-like tokens.
        const testIds = (value: unknown): string[] => Array.isArray(value)
          ? value.filter((entry): entry is string =>
            typeof entry === "string" && /^[A-Za-z0-9._/-]{1,120}$/.test(entry)).slice(0, 10)
          : [];
        const safeRef = (value: unknown): boolean =>
          typeof value === "string" && /^[A-Za-z0-9._/@^~-]{1,120}$/.test(value);
        if (!experimentId || !defectId || phase === null || !SEVERITIES.includes(severity as Severity) ||
            !stateIds || !names.every((name) => safeRef(stateIds[name]))) {
          return refusal("record needs experimentId, defectId, severity and the git refs for this phase", "invalid_record");
        }
        const stateRefs: Record<string, string> = {};
        for (const name of names) {
          const ref = stateIds[name] as string;
          const resolved = await deps.execBashScript(["-c", `git rev-parse --verify "${ref}^{commit}"`], {
            cwd: workDir, timeout: 30_000,
          });
          if (resolved.code !== 0 || resolved.stdout.trim() === "") {
            return refusal(`state ${name} (${ref}) is not a resolvable git commit`, "state_unresolved");
          }
          stateRefs[name] = resolved.stdout.trim();
        }
        const commands = stored.value.config.proofCommands;
        const timeout = Math.max(1, Math.min(600, Math.floor(params.timeoutSeconds ?? 120)));
        type Check = { name: string; command: string; exitCode: number; output: string; killed: boolean };
        const checks: Check[] = [];
        const testChecks: Array<Check & { testId: string }> = [];
        const worktrees: string[] = [];
        const cleanupFailures: string[] = [];
        let checkoutFailure: string | null = null;
        const runInWorktree = async (name: string, ref: string, command: string): Promise<Check | null> => {
          const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `bugfix-proof-${campaignId}-`));
          fs.rmdirSync(scratch);
          const posix = scratch.replace(/\\/g, "/");
          // Register before the command: a partially created worktree must still be removed.
          worktrees.push(posix);
          const added = await deps.execBashScript(
            ["-c", `git worktree add --detach "${posix}" ${ref}`],
            { cwd: workDir, timeout: 120_000 },
          );
          if (added.code !== 0 || !fs.existsSync(scratch)) {
            checkoutFailure = `could not check out state ${name}: ${(added.stderr || added.stdout).slice(0, 300)}`;
            return null;
          }
          const result = await deps.execBashScript(["-c", command], { cwd: scratch, timeout: timeout * 1000 });
          return {
            name, command, exitCode: result.code, killed: result.killed,
            output: `${result.stdout}${result.stderr}`.slice(0, 4000),
          };
        };
        for (const name of names) {
          const check = await runInWorktree(name, stateRefs[name], commands[name] as string);
          if (check === null) break;
          checks.push(check);
        }
        if (checkoutFailure === null) {
          const prefix = phase === "discover" ? "detector" : "proof";
          const pairs = phase === "discover"
            ? [["good", true], ["defect", false]] as const
            : [["fixed", true], ["counterfactual", false]] as const;
          const ids = Array.from(new Set(testIds(
            phase === "discover" ? params.detectorTests : params.proofTests,
          ))).slice(0, 3);
          for (const id of ids) {
            for (const [state, shouldPass] of pairs) {
              const command = stored.value.config.testIdCommand.replaceAll("{test}", id);
              const check = await runInWorktree(`${prefix}:${id}:${state}`, stateRefs[state], command);
              if (check === null) break;
              testChecks.push({ ...check, testId: id });
            }
            if (checkoutFailure !== null) break;
          }
        }
        for (const posix of worktrees) {
          const removed = await deps.execBashScript(["-c", `git worktree remove --force "${posix}"`], {
            cwd: workDir, timeout: 30_000,
          });
          if (removed.code !== 0 || fs.existsSync(posix)) {
            try {
              fs.rmSync(posix, { recursive: true, force: true });
            } catch {
              cleanupFailures.push(posix);
            }
            const pruned = await deps.execBashScript(["-c", "git worktree prune"], { cwd: workDir, timeout: 30_000 });
            if (pruned.code !== 0 || fs.existsSync(posix)) {
              if (!cleanupFailures.includes(posix)) cleanupFailures.push(posix);
            }
          }
        }
        if (checkoutFailure) return refusal(checkoutFailure, "state_checkout_failed");
        if (cleanupFailures.length > 0) {
          return refusal(`proof worktree cleanup failed: ${cleanupFailures.join(", ")}`, "cleanup_failed");
        }
        // A test id counts only when its own executed checks separate the states.
        const prefix = phase === "discover" ? "detector" : "proof";
        const pairs = phase === "discover"
          ? [["good", true], ["defect", false]] as const
          : [["fixed", true], ["counterfactual", false]] as const;
        const verifiedIds = phase === "discover" ? params.detectorTests : params.proofTests;
        const countedIds = Array.from(new Set(testIds(verifiedIds))).slice(0, 3).filter((id) =>
          pairs.every(([state, shouldPass]) => testChecks.some((check) =>
            check.testId === id && check.name === `${prefix}:${id}:${state}` &&
            (shouldPass ? check.exitCode === 0 : check.exitCode !== 0),
          )),
        );
        const detectorTests = phase === "discover" ? countedIds : [];
        const proofTests = phase === "proof" ? countedIds : [];
        const evidence = {
          kind: "evidence",
          experimentId,
          defectId,
          severity,
          phase,
          detectorTests,
          proofTests,
          testChecks,
          stateIds,
          stateRefs,
          checks,
        };
        const proof = inspectEvidence(evidence);
        appendRow(workDir, campaignId, EVIDENCE_FILE, { ...evidence, valid: proof.valid });
        return reply(
          `${proof.valid ? "Executed proof accepted" : `Executed proof rejected: ${proof.reason}`}. ` +
          `Checked commits: ${names.map((name) => `${name}=${stateRefs[name].slice(0, 8)}`).join(", ")}. ` +
          `Checks: ${checks.map((check) => `${check.name}=${check.exitCode}`).join(", ")}. ` +
          `${phase === "discover"
            ? "Discovery credit is paid now and is not revoked by discard."
            : "Fix credit becomes durable only after decide(status=keep)."}`,
          {
            valid: proof.valid, reason: proof.reason, phase,
            detectorTests, proofTests,
            exitCodes: checks.map((check) => check.exitCode),
          },
        );
      }

      if (action === "decide") {
        const experimentId = requiredText(params.experimentId, "experimentId");
        if (!experimentId || (params.status !== "keep" && params.status !== "discard")) {
          return refusal("decide needs experimentId and status=keep|discard", "invalid_decision");
        }
        if (params.status === "keep") {
          const rows = readRows(workDir, campaignId, EVIDENCE_FILE);
          const evidence = rows.filter((row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && (row as Record<string, unknown>).experimentId === experimentId,
          ).at(-1);
          if (!evidence) return refusal("no executed proof for this experiment", "proof_missing");
          const proof = inspectEvidence(evidence);
          if (!proof.valid) return refusal(`keep refused: ${proof.reason}`, "proof_invalid");
        }
        appendRow(workDir, campaignId, DECISIONS_FILE, {
          kind: "decision", experimentId, status: params.status,
        });
        return reply(
          params.status === "keep"
            ? "Keep recorded: executed proof becomes durable credit."
            : "Discard recorded: no credit and no invalid-proof penalty.",
          { status: params.status },
        );
      }

      return refusal(`unknown action ${String(action)}`, "invalid_action");
    },
  } as ToolLike;
}
