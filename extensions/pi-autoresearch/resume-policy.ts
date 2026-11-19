/** Resume and drift messaging/gate policy, parameterized by extension state access. */
export const SETTLED_WINDOW_MS = 800;

export type ResumeMode = "legacy" | "research" | "candidate";

export interface ResumeMessage {
  mode: ResumeMode;
  text: string;
}

export type PendingResume = ResumeMessage | { kind: "claimed" } | null;

export interface ResumeRuntime {
  autoresearchMode: boolean;
  lastLogFlag: string | null;
  lastRevertFailure: string | null;
  pendingResumeMessage: PendingResume;
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
  pendingResumeIsDrift: boolean;
  /** Monotonic cancellation token: off/turn-boundary paths bump it, and an in-flight
   *  sender re-checks it after every await. Optional so hand-built test runtimes
   *  remain valid; the extension runtime always carries it. */
  resumeEpoch?: number;
  consecutiveDriftResumes: number;
  autoResumeTurns: number;
}

export interface ResumeContext {
  cwd: string;
}

export interface ResumePolicyDeps<Ctx extends ResumeContext, Runtime extends ResumeRuntime> {
  resolveWorkDir(cwd: string): string;
  campaignNeedsManualCheck(workDir: string, ctx: Ctx): Promise<boolean>;
  autoResumeStopReasonFor(runtime: Runtime): string | null;
  isAgentSettled(ctx: Ctx): boolean;
  researchBlocks(workDir: string, ctx: Ctx): boolean;
  researchScanBlocks(workDir: string): boolean;
  campaignActive(workDir: string): boolean;
  resolveLoopMode(workDir: string, ctx: Ctx): Promise<{ mode: ResumeMode; researchCompletion: boolean }>;
  expeditionDriftBranchText(ctx: Ctx): Promise<string | null>;
  getRuntime(ctx: Ctx): Runtime;
  researchResumeText: string;
  researchCompletionText: string;
  measurementGuardrail: string;
  benchmarkGuardrail: string;
  experimentLimitClause(cwd: string): string;
  hasExperimentLedger(workDir: string): boolean;
  notifyAutoResumeLimitReached(ctx: Ctx, reason: string): void;
  composeCampaignResumeMessage(ctx: Ctx): Promise<string>;
  sendUserMessage(text: string): void;
}

export function createResumePolicy<Ctx extends ResumeContext, Runtime extends ResumeRuntime>(
  deps: ResumePolicyDeps<Ctx, Runtime>,
) {
  const researchNextStepText = (researchCompletion: boolean): string =>
    researchCompletion ? deps.researchCompletionText : deps.researchResumeText;

  const evaluateResumeGates = async (
    ctx: Ctx,
    runtime: Runtime,
  ): Promise<
    | { verdict: "cancel"; notify?: string | null }
    | { verdict: "retry" }
    | { verdict: "deliver"; workDir: string; researchBlocks: boolean }
  > => {
    if (!runtime.autoresearchMode) return { verdict: "cancel" };
    const workDir = deps.resolveWorkDir(ctx.cwd);
    if (await deps.campaignNeedsManualCheck(workDir, ctx)) return { verdict: "cancel" };
    const stopReason = deps.autoResumeStopReasonFor(runtime);
    if (stopReason !== null) return { verdict: "cancel", notify: stopReason };
    if (!deps.isAgentSettled(ctx)) return { verdict: "retry" };
    return { verdict: "deliver", workDir, researchBlocks: deps.researchScanBlocks(workDir) };
  };

  const composePausedNotice = (workDir: string, ctx: Ctx): string =>
    deps.researchBlocks(workDir, ctx)
      ? "Autoresearch paused — the last turns did no research-campaign work. Use research_questions(action=status) to see the state, then resume the campaign."
      : deps.campaignActive(workDir)
        ? "Autoresearch paused — the last turns did no candidate-campaign work. Use candidate_branch status to see the state, then resume the campaign."
        : "Autoresearch paused — the last turns did no experiment work (no run_experiment/log_experiment). Run /autoresearch <goal> to resume the loop.";

  const composeResearchCompactionMessage = (): string => [
    "Resume the research campaign now: call research_questions(action=status), then issue separate research_questions calls with action=open, action=record, or action=close per the brief.",
    "Do not re-read .auto/prompt.md for loop rules (they are not part of the research campaign).",
    "STOP on manual_check_required.",
  ].join(" ");

  const composeResearchDriftMessage = async (ctx: Ctx): Promise<string> => {
    const expeditionBranch = await deps.expeditionDriftBranchText(ctx);
    if (expeditionBranch !== null) {
      return ["⚠ Last turn did no research-campaign work.", expeditionBranch, "Questions and decision rules come only from the approved brief."].join(" ");
    }
    const mode = await deps.resolveLoopMode(deps.resolveWorkDir(ctx.cwd), ctx);
    return ["⚠ Last turn did no research-campaign work.", researchNextStepText(mode.researchCompletion), "Questions and decision rules come only from the approved brief."].join(" ");
  };

  const composeResumeMessage = (ctx: Ctx): string => {
    const runtime = deps.getRuntime(ctx);
    const flag = runtime.lastLogFlag;
    const head = flag
      ? `⚠ Last log_experiment was flagged (${flag}) — that value was agent-claimed, NOT measured. Run run_experiment and log the parsed METRIC. `
      : "";
    const revertWarn = runtime.lastRevertFailure
      ? `⚠ The last auto-revert FAILED (${runtime.lastRevertFailure}) — the working tree still carries the discarded experiment's changes. Run a manual git checkout/clean (excluding .auto) and verify git status is clean BEFORE trusting the next baseline. `
      : "";
    return [
      revertWarn + head + "Run the next iteration now.",
      "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
      deps.measurementGuardrail,
      deps.experimentLimitClause(ctx.cwd),
      deps.benchmarkGuardrail,
    ].join(" ");
  };

  const composeCampaignResumeMessage = async (ctx: Ctx): Promise<string> => {
    const mode = await deps.resolveLoopMode(deps.resolveWorkDir(ctx.cwd), ctx);
    if (mode.mode === "research") {
      const expeditionBranch = await deps.expeditionDriftBranchText(ctx);
      if (expeditionBranch !== null) return expeditionBranch;
      return researchNextStepText(mode.researchCompletion);
    }
    return [
      "Continue the candidate campaign now: candidate_branch status, then run/checkpoint on the active candidate.",
      "The ordinary experiment tools are blocked while the campaign is active.",
      "If status reports manual_check_required: STOP — report the pending operation and wait for the operator (resolve).",
    ].join(" ");
  };

  const composeDriftResumeMessage = async (cwd: string, ctx: Ctx): Promise<{ mode: ResumeMode; text: string }> => {
    const mode = await deps.resolveLoopMode(deps.resolveWorkDir(cwd), ctx);
    if (mode.mode === "research") return { mode: "research", text: await composeResearchDriftMessage(ctx) };
    if (mode.mode === "candidate") return { mode: "candidate", text: [
      "⚠ Last turn did no candidate-campaign work.",
      "Resume the campaign now: candidate_branch status, then run/checkpoint on the active candidate.",
      "If status reports manual_check_required: STOP — report the pending operation and wait for the operator (resolve).",
    ].join(" ") };
    if (!deps.hasExperimentLedger(deps.resolveWorkDir(cwd))) return { mode: "legacy", text: [
      "⚠ Last turn did no experiment work and no campaign is active.",
      "The experiment loop is not initialized in this project (no .auto/log.jsonl).",
      "To start a loop run /autoresearch <goal>; to run a research campaign use /autoresearch research <topic>.",
    ].join(" ") };
    return { mode: "legacy", text: [
      "⚠ Last turn used no experiment tools (chat/reads don't advance the loop).",
      "Resume the cycle now: propose_hypothesis → run_experiment → log_experiment.",
      deps.measurementGuardrail,
      deps.experimentLimitClause(cwd),
      deps.benchmarkGuardrail,
    ].join(" ") };
  };

  const pausePendingResume = (runtime: Runtime): void => {
    if (runtime.pendingResumeTimer === null) return;
    clearTimeout(runtime.pendingResumeTimer);
    runtime.pendingResumeTimer = null;
  };

  const cancelPendingResume = (runtime: Runtime): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = null;
    runtime.pendingResumeIsDrift = false;
  };

  const sendPendingResumeIfReady = async (ctx: Ctx, runtime: Runtime): Promise<void> => {
    const pending = runtime.pendingResumeMessage;
    if (pending === null || "kind" in pending) return;
    // Gates and composers await: the owner can turn the loop off (or a new
    // turn can drop a stale nudge) while this sender is suspended. A snapshot
    // of the epoch plus the live mode flag decides whether this particular
    // sender may still deliver — never clear a newer pending message here.
    const epoch = runtime.resumeEpoch ?? 0;
    const stillCurrent = (): boolean => (runtime.resumeEpoch ?? 0) === epoch && runtime.autoresearchMode;
    if (!stillCurrent()) return;
    const gates = await evaluateResumeGates(ctx, runtime);
    if (!stillCurrent()) return;
    if (gates.verdict === "cancel") {
      cancelPendingResume(runtime);
      if (gates.notify) deps.notifyAutoResumeLimitReached(ctx, gates.notify);
      return;
    }
    if (gates.verdict === "retry") {
      if (stillCurrent()) reschedulePendingResume(ctx, runtime);
      return;
    }
    if (pending.mode === "candidate" && !deps.campaignActive(gates.workDir)) {
      cancelPendingResume(runtime);
      return;
    }
    const wasDrift = runtime.pendingResumeIsDrift;
    cancelPendingResume(runtime);
    if (!stillCurrent()) return;
    const liveMode = await deps.resolveLoopMode(gates.workDir, ctx);
    if (!stillCurrent()) return;
    let sendText = pending.text;
    if (liveMode.mode === "research" && pending.mode === "legacy") {
      sendText = gates.researchBlocks ? deps.researchResumeText : await deps.composeCampaignResumeMessage(ctx);
      if (!stillCurrent()) return;
    } else if (liveMode.mode === "candidate" && pending.mode !== "candidate") {
      sendText = await deps.composeCampaignResumeMessage(ctx);
      if (!stillCurrent()) return;
    }
    // Last check immediately before delivery. Counters move only after the
    // message is actually sent: a nudge cancelled mid-flight spends no budget.
    if (!stillCurrent()) return;
    deps.sendUserMessage(sendText);
    if (wasDrift) runtime.consecutiveDriftResumes++;
    runtime.autoResumeTurns++;
  };

  const schedulePendingResume = (
    ctx: Ctx,
    runtime: Runtime,
    message: string,
    opts?: { mode?: ResumeMode },
  ): void => {
    pausePendingResume(runtime);
    runtime.pendingResumeMessage = { mode: opts?.mode ?? "legacy", text: message };
    runtime.pendingResumeTimer = setTimeout(() => sendPendingResumeIfReady(ctx, runtime), SETTLED_WINDOW_MS);
  };

  const reschedulePendingResume = (ctx: Ctx, runtime: Runtime): void => {
    const pending = runtime.pendingResumeMessage;
    if (pending === null || "kind" in pending) return;
    schedulePendingResume(ctx, runtime, pending.text, { mode: pending.mode });
  };

  const composeCompactionResumeMessage = async (ctx: Ctx): Promise<string> => {
    const mode = await deps.resolveLoopMode(deps.resolveWorkDir(ctx.cwd), ctx);
    if (mode.mode === "research") return composeResearchCompactionMessage();
    if (mode.mode === "candidate") return [
      "Resume the candidate campaign now: candidate_branch status, then run/checkpoint on the active candidate.",
      "If status reports manual_check_required: STOP — report the pending operation and wait for the operator (resolve).",
      "Read the campaign state with candidate_branch status; do not re-read .auto/prompt.md for loop rules (they are not part of the campaign).",
    ].join(" ");
    return [
      "Run the next iteration now.",
      "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
      "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
      deps.measurementGuardrail,
      deps.experimentLimitClause(ctx.cwd),
      deps.benchmarkGuardrail,
    ].join(" ");
  };

  return {
    evaluateResumeGates,
    pausePendingResume,
    cancelPendingResume,
    sendPendingResumeIfReady,
    schedulePendingResume,
    reschedulePendingResume,
    composePausedNotice,
    composeResearchDriftMessage,
    composeResearchCompactionMessage,
    composeResumeMessage,
    composeCampaignResumeMessage,
    composeDriftResumeMessage,
    composeCompactionResumeMessage,
  };
}
