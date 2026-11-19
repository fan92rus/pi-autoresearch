/**
 * candidate_branch tool (extracted from index.ts; the tool body is byte-identical
 * apart from deps reads at the call site). Refusal strings, guard order, campaign
 * and state handling, reply text, policy and prompt text are preserved.
 * Extension-local collaborators arrive through `deps` (getter-backed in
 * index.ts) and are read as `deps.foo` at the point of use — never frozen in an
 * execute() destructure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { killTree } from "./bash-shell.ts";
import type * as candidateState from "./candidate-state.ts";
import * as candidateWorktree from "./candidate-worktree.ts";
import * as candidateMeasure from "./candidate-measure.ts";
import {
  candidateWorktreeRoot,
  canonicalWorktreePath,
  createCandidateExecRunner,
  executeCandidateBranchAction,
} from "./candidate-campaign.ts";
import type { CandidatePolicy } from "./candidate-policy.ts";

type CandidateBranchTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface CandidateBranchToolDeps {
  assertModeActive: (ctx: ExtensionContext) => any;
  campaignDirOf: (workDir: string) => string;
  cancelSubagentDeferral: (runtime: any) => void;
  getRuntime: (ctx: ExtensionContext) => any;
  measurementScaleStatusOfDir: (dir: string) => any;
  requestCandidatePolicyConsent: (ui: any, raw: any) => Promise<any>;
  researchBlockedResponse: () => any;
  researchBlocksOrdinaryLoop: (workDir: string, ctx?: ExtensionContext) => Promise<boolean>;
  resolveWorkDir: (cwd: string) => string;
  validateWorkDir: (cwd: string) => string | null;
  /** Optional deterministic fault-injection seams; production leaves them unset. */
  candidateGitExec?: (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  runRepeatedMeasurement?: typeof candidateMeasure.runRepeatedMeasurement;
}

export function createCandidateBranchTool(deps: CandidateBranchToolDeps): CandidateBranchTool {
  // =======================================================================
  // candidate_branch — candidate-branch MVP (openspec/changes/candidate-branches)
  // Integrates candidate-policy + candidate-state + candidate-worktree +
  // candidate-measure into one gated tool. See design §2–§5. The user's own
  // branch/worktree is never moved: all candidate work happens in detached
  // system-owned worktrees, promotion only moves the private leader ref.
  // =======================================================================

  // Worktrees MUST live outside the user's tree (worktree module refuses
  // inside-source paths — design §4). The OS temp dir keeps them system-owned
  // and out of the repository; the campaign-scoped subdirectory name derives
  // from the resolved workDir so different campaigns never collide.
  const candidateWtRootOf = (workDir: string): string => candidateWorktreeRoot(workDir, {
    resolve: path.resolve,
    join: path.join,
    tmpdir: os.tmpdir,
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const LEADER_REF = "refs/pi-autoresearch/campaign-leader";

  /** Real child_process exec on a raw argv (no shell): maps to the
   *  candidate-measure ExecRunner shape (argv, {cwd, timeoutMs}). */
  const candidateExecRunner = createCandidateExecRunner(spawn, killTree, process.env);

  /** candidate-worktree ExecFn shape: (cmd, args, {cwd, timeout}). */
  const defaultCandidateGitExec = async (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const r = await candidateExecRunner([cmd, ...args], { cwd: opts?.cwd, timeoutMs: opts?.timeout });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
  const candidateGitExec = deps.candidateGitExec ?? defaultCandidateGitExec;
  const runRepeatedMeasurement = deps.runRepeatedMeasurement ?? candidateMeasure.runRepeatedMeasurement;

  /** SHA-256 of one methodology file, read fresh from disk (repo-relative). */

  /** Review final-B2 (round 2): hash a methodology file's blob from a COMMIT,
 *  not the working copy. Raw bytes via a Buffer-returning git call: the
 *  string-decoding runner would re-encode non-ASCII content through latin1
 *  (update(out, "binary")) and break equality with the init pin, and a CRLF
 *  working copy under core.autocrlf=true would disagree with the LF blob. */
  const gitShowBytes = async (workDir: string, refPath: string): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const child = spawn("git", ["show", refPath], {
        cwd: workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => reject(new Error(String(err))));
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`git show ${refPath} failed: ${stderr.slice(0, 200)}`));
        else resolve(Buffer.concat(chunks));
      });
    });

  /** SHA-256 of one methodology file's blob in a commit (raw bytes). */
  const hashMethodologyBlob = async (workDir: string, commitSha: string, relPath: string): Promise<string | null> => {
    try {
      // Containment: the path must be repo-relative inside the workDir.
      if (path.isAbsolute(relPath) || relPath.includes("..")) return null;
      // `./` makes the path relative to the workDir (git resolves a bare path from the repo root)
      const content = await gitShowBytes(workDir, `${commitSha}:./${relPath}`);
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  };

  /** Init pin: methodology hashes from the BASE commit's blobs (git show
   *  HEAD:<path>), so init and confirm read the same bytes and a CRLF working
   *  copy or a non-ASCII content cannot break the equality (review round 2). */
  const hashMethodologyAtCommit = async (workDir: string, commitSha: string, policy: CandidatePolicy): Promise<{ ok: true; hashes: { path: string; sha256: string }[] } | { ok: false; reason: string }> => {
    const hashes: { path: string; sha256: string }[] = [];
    for (const f of policy.methodology_files) {
      const h = await hashMethodologyBlob(workDir, commitSha, f.path);
      if (h === null) return { ok: false, reason: `methodology file ${JSON.stringify(f.path)} does not exist in commit ${commitSha.slice(0, 12)}` };
      hashes.push({ path: f.path, sha256: h });
    }
    return { ok: true, hashes };
  };

  const gitOut = async (workDir: string, args: string[]): Promise<string> => {
    const r = await candidateGitExec("git", args, { cwd: workDir, timeout: 15000 });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return r.stdout;
  };

  const fullShaOf = async (workDir: string, ref: string): Promise<string | null> => {
    try {
      const out = await gitOut(workDir, ["rev-parse", "--verify", "--quiet", ref]);
      const sha = out.trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
    } catch {
      return null;
    }
  };

  const activeCandidateOf = (state: candidateState.CampaignState | null): candidateState.CandidateRecord | null => {
    if (!state) return null;
    return state.candidates.find((c) => c.status === "active") ?? null;
  };

  type EphemeralCleanup = { removed: boolean; message?: string };
  type SideMeasurement =
    | { ok: true; average: number; wtPath: string }
    | { ok: false; reason: string; message: string; wtPath: string; cleanup?: EphemeralCleanup };

  /** Side measurement in an ephemeral worktree for one side of a confirm. */
  const measureSideInEphemeral = async (
    ctx: ExtensionContext,
    workDir: string,
    label: string,
    sideSha: string,
    policy: CandidatePolicy,
  ): Promise<SideMeasurement> => {
    // Review B1: "confirm-leader"/"confirm-cand" are valid user candidate ids,
    // so a live candidate could occupy the ephemeral path and confirm's force
    // removal would destroy unsaved work. Unique namespaced ids cannot collide.
    const ephemeralId = `tmp-confirm-${label}-${createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}`;
    const wtPath = path.join(candidateWtRootOf(workDir), ephemeralId);
    // bd tj0.6: the path is known before anything can throw. Every failure
    // result carries it, and every exit after creation cleans up (unless the
    // caller keeps the worktree for checks after a successful measurement).
    let created = false;
    let keepWorktree = false;
    let cleanupOutcome: EphemeralCleanup | null = null;
    let thrownCleanup: { wtPath: string; cleanup: EphemeralCleanup | null } | null = null;
    const cleanupNow = async (): Promise<EphemeralCleanup> => {
      if (cleanupOutcome === null) cleanupOutcome = await removeEphemeralWorktree(ctx, workDir, wtPath);
      return cleanupOutcome;
    };
    try {
      const wtRes = await candidateWorktree.createCandidateWorktree(candidateGitExec, {
        repoRoot: workDir,
        baseCommit: sideSha,
        worktreePath: wtPath,
        candidateId: ephemeralId,
      });
      if (!wtRes.ok) return { ok: false, reason: wtRes.reason, message: wtRes.reason, wtPath };
      created = true;
      const measured = await runRepeatedMeasurement(candidateExecRunner, {
        dir: wtPath,
        metricName: policy.metric_name,
        argv: policy.benchmark_argv,
        timeoutMs: policy.benchmark_timeout_seconds * 1000,
        repeats: policy.repeats,
        budgetMs: policy.confirm_budget_seconds * 1000,
      });
      if (!measured.ok) {
        return { ok: false, reason: measured.reason, message: measured.message, wtPath, cleanup: await cleanupNow() };
      }
      keepWorktree = true;
      return { ok: true, average: measured.average, wtPath };
    } catch (err) {
      // Keep the exception (an uncertain outcome must retain the pending-op
      // marker), but carry the path and cleanup result to the confirm reply.
      thrownCleanup = { wtPath, cleanup: null };
      if (err && typeof err === "object") (err as any).candidateWorktreeCleanup = thrownCleanup;
      throw err;
    } finally {
      if (created && !keepWorktree) {
        const outcome = await cleanupNow();
        if (thrownCleanup) thrownCleanup.cleanup = outcome;
      }
    }
  };

  /**
   * Remove an ephemeral confirm worktree and report the outcome (bd el3.2:
   * cleanup must not silently claim success). A failed removal is remembered
   * in runtime.candidateLeftovers so `candidate_branch status` surfaces it —
   * the confirm itself still succeeds (cleanup must not fail a passed
   * measurement), but the leftover is never silent.
   */
  const removeEphemeralWorktree = async (ctx: ExtensionContext, workDir: string, wtPath: string): Promise<{ removed: boolean; message?: string }> => {
    const runtime = deps.getRuntime(ctx);
    // Plain remove first; --force ONLY for the paths this confirm created.
    // Windows: a just-finished benchmark process / AV scan can hold the
    // directory for a moment, so retry a few times before declaring a leftover.
    // The per-attempt git timeout is short (3s): cleanup must not delay the
    // tool reply by minutes when git itself is wedged — a leftover is the
    // safer outcome, it is surfaced in the reply and by candidate_branch status.
    let r = { code: 1, stdout: "", stderr: "" };
    const tryRemove = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        return await candidateGitExec("git", ["worktree", "remove", ...args, wtPath], { cwd: workDir, timeout: 3000 });
      } catch (err) {
        return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await tryRemove([]);
      if (r.code === 0) break;
      r = await tryRemove(["--force"]);
      if (r.code === 0) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    if (r.code !== 0) {
      // Never fail the confirm for cleanup; remember the leftover for status.
      const message = `git worktree remove failed (code ${r.code}): ${(r.stderr || r.stdout || "").trim().split("\n")[0] || "no output"}`;
      runtime.candidateLeftovers = runtime.candidateLeftovers ?? [];
      const samePath = (p: string) => canonicalWorktreePath(p) === canonicalWorktreePath(wtPath);
      if (!runtime.candidateLeftovers.some(samePath)) runtime.candidateLeftovers.push(wtPath);
      return { removed: false, message };
    }
    // Success clears any stale memory of this path (separators/case may differ).
    if (runtime.candidateLeftovers) {
      runtime.candidateLeftovers = runtime.candidateLeftovers.filter((p) => canonicalWorktreePath(p) !== canonicalWorktreePath(wtPath));
    }
    return { removed: true };
  };

  return {
    name: "candidate_branch",
    label: "Candidate branch campaign",
    description:
      "Candidate-branch campaign tool (MVP): sequentially develop multiple candidates in isolated system-owned " +
      "worktrees with checkpoints, then confirm a promotion only after re-measurement. Actions: init (policy + " +
      "EXPLICIT user consent via dialog; no consent = no campaign), create, status, resume, run (candidate measurement, " +
      "not a global keep), checkpoint, pause, select, close, confirm (re-measure leader+candidate, CAS-promote the " +
      "private ref refs/pi-autoresearch/campaign-leader), disable, resolve (OPERATOR-only manual resolution of a pending " +
      "op or stale lock via an explicit dialog consent; the model cannot self-approve it). While a campaign is active, run_experiment and " +
      "log_experiment are blocked. The user's own branch and files are never moved, reset or deleted; checkpoints and " +
      "state survive disable. Policy is immutable after init.",
    promptSnippet: "Candidate-branch campaign: init/create/run/checkpoint/confirm in isolated worktrees",
    promptGuidelines: [
      "init REQUIRES the user to confirm the full policy in a dialog; without consent the campaign does not start.",
      "Run candidate work only inside the candidate worktree (returned in create); run measures the candidate, it is NOT a global keep.",
      "checkpoint saves allowed files into a commit + ref; regression is allowed. confirm re-measures BOTH sides and promotes the leader ref only on a strict gain above min_gain with passing checks.",
      "resolve is OPERATOR-only: it asks the human via a dialog before clearing a pending op or a stale lock, and can register a verified orphan checkpoint; never assume it succeeded without the dialog.",
      "While the campaign is active, ordinary run_experiment/log_experiment are blocked; use candidate_branch run/checkpoint or disable first.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["init", "create", "status", "resume", "run", "checkpoint", "pause", "select", "close", "confirm", "disable", "resolve"],
          description: "Campaign action to perform.",
        },
        policy: {
          type: "object",
          description: "init only: full campaign policy (metric_name, direction higher/lower, repeats>=1, min_gain>=0, benchmark_argv, checks_argv, benchmark_timeout_seconds, confirm_budget_seconds, candidate_step_limit, candidate_time_limit_seconds, methodology_files [{path,sha256?}], change_files). Methodology sha256 values are computed from disk; pass paths.",
        },
        candidate_id: { type: "string", description: "Candidate id (create/pause/resume/select/close): [A-Za-z0-9._-], 1-64 chars." },
        allowed_files: { type: "array", items: { type: "string" }, description: "checkpoint only: explicit repo-relative files the checkpoint may include." },
        message: { type: "string", description: "checkpoint only: commit message." },
        checkpoint_id: { type: "string", description: "select only: checkpoint id (full commit sha) to select." },
      },
      required: ["action"],
    } as any,

    async execute(_toolCallId: string, params: any, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = deps.assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = deps.validateWorkDir(ctx.cwd);
      if (workDirError) return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      const workDir = deps.resolveWorkDir(ctx.cwd);
      if (await deps.researchBlocksOrdinaryLoop(workDir, ctx)) return deps.researchBlockedResponse();
      return executeCandidateBranchAction(params, ctx, workDir, {
        campaignDirOf: deps.campaignDirOf,
        fullShaOf,
        LEADER_REF,
        activeCandidateOf,
        getRuntime: deps.getRuntime,
        candidateGitExec,
        hashMethodologyBlob,
        requestCandidatePolicyConsent: deps.requestCandidatePolicyConsent,
        gitOut,
        candidateWtRootOf,
        measurementScaleStatusOfDir: deps.measurementScaleStatusOfDir,
        hashMethodologyAtCommit,
        candidateExecRunner,
        measureSideInEphemeral,
        removeEphemeralWorktree,
        cancelSubagentDeferral: deps.cancelSubagentDeferral,
      });
    },
  };
}
