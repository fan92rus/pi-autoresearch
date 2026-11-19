/** Candidate action dispatcher; side effects are supplied by the extension adapter. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as candidateState from "./candidate-state.ts";
import * as candidateWorktree from "./candidate-worktree.ts";
import * as candidateMeasure from "./candidate-measure.ts";
import { renderRefusal } from "./refusal.ts";
import type { CandidatePolicy } from "./candidate-policy.ts";
import type { spawn as SpawnFn } from "node:child_process";

/**
 * One canonical spelling for worktree path comparison (bd tj0.6): git and
 * Windows disagree on separator and case. Originals are kept for display.
 */
export function canonicalWorktreePath(p: string): string {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

export async function executeCandidateBranchAction(params: any, ctx: any, workDir: string, deps: Record<string, any>) {
      const { campaignDirOf, fullShaOf, LEADER_REF, activeCandidateOf, getRuntime, candidateGitExec, hashMethodologyBlob, requestCandidatePolicyConsent, gitOut, candidateWtRootOf, measurementScaleStatusOfDir, hashMethodologyAtCommit, candidateExecRunner, measureSideInEphemeral, removeEphemeralWorktree, cancelSubagentDeferral } = deps;
      const campDir = campaignDirOf(workDir);
      const action = params?.action;

      const fail = (reason: string, message: string, extra = "") => ({
        content: [{ type: "text", text: `${renderRefusal({ reason, message })}${extra}` }],
        details: { action, reason },
      });

      // ---- status: read-only, no lock ----
      if (action === "status") {
        const insp = await candidateState.inspectCampaign(campDir);
        let text = `Campaign status: ${insp.status}\n`;
        text += `${insp.message}\n`;
        const leaderSha = await fullShaOf(workDir, LEADER_REF);
        text += `Leader ref ${LEADER_REF}: ${leaderSha ?? "(not set)"}\n`;
        if (insp.state) {
          const active = activeCandidateOf(insp.state);
          for (const c of insp.state.candidates) {
            text += `Candidate ${c.id}: ${c.status}, steps ${c.steps_used}/${insp.state.policy.candidate_step_limit}, time ${Math.round(c.time_used_seconds)}s/${insp.state.policy.candidate_time_limit_seconds}s, checkpoints ${c.checkpoints.length}, selected ${c.selected_checkpoint ?? "none"}${active && active.id === c.id ? " [ACTIVE]" : ""}\n`;
          }
        }
        if (insp.pendingOp) text += `Pending op: ${insp.pendingOp.name} (started ${insp.pendingOp.started_at}) — manual check required\n`;
        try {
          const lm = JSON.parse(fs.readFileSync(path.join(campDir, "last-measurement.json"), "utf8"));
          if (lm && typeof lm.average === "number") text += `Last measurement: ${JSON.stringify(String(lm.metric_name))} average ${lm.average} (candidate ${JSON.stringify(String(lm.candidate))}, ${lm.at})
`;
        } catch { /* no measurement yet */ }
        if (insp.lockPresent) text += "Lock file present — if no process is running, resolve (operator action, dialog-confirmed)\n";
        // bd el3.2: surface ephemeral worktree leftovers — both remembered
        // failures and a LIVE porcelain scan (a leftover from a previous
        // session is not in runtime memory but still clutters the repo).
        const rt = getRuntime(ctx);
        let scanWarning = "";
        try {
          const lst = await candidateGitExec("git", ["worktree", "list", "--porcelain"], { cwd: workDir, timeout: 15000 });
          if (lst.code !== 0) {
            // bd tj0.6: a failed scan is NOT evidence of a clean tree.
            scanWarning = `⚠ Ephemeral worktree scan unavailable (git worktree list --porcelain exited ${lst.code}: ${(lst.stderr || lst.stdout || "").trim().split("\n")[0] || "no output"}); leftovers may not be listed.\n`;
          } else {
            const norm = canonicalWorktreePath;
            const entries = lst.stdout.split("\n")
              .filter((l) => l.startsWith("worktree "))
              .map((l) => l.slice("worktree ".length).trim());
            const registered = new Set(entries.map(norm));
            const orphans = entries.filter((p) => norm(p).includes("/tmp-confirm-"));
            for (const o of orphans) {
              if (!rt.candidateLeftovers?.some((p) => norm(p) === norm(o))) {
                rt.candidateLeftovers = rt.candidateLeftovers ?? [];
                rt.candidateLeftovers.push(o);
              }
            }
            // bd el3.2: a remembered leftover whose path is no longer registered
            // (the operator removed it by hand) is cleared — status must not
            // haunt the user with already-fixed problems.
            if (rt.candidateLeftovers?.length) {
              rt.candidateLeftovers = rt.candidateLeftovers.filter((p) => registered.has(norm(p)));
            }
          }
        } catch (err) {
          scanWarning = `⚠ Ephemeral worktree scan unavailable (git worktree list --porcelain failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err).split("\n")[0]}); leftovers may not be listed.\n`;
        }
        if (scanWarning) text += scanWarning;
        if (rt.candidateLeftovers?.length) {
          text += "⚠ Ephemeral worktree leftovers (cleanup failed; remove by hand):\n" + rt.candidateLeftovers.map((p) => `  ${p}`).join("\n") + "\n";
        }
        return { content: [{ type: "text", text }], details: { inspection: insp as any, leader: leaderSha } };
      }

      // ---- init: validate policy, hash methodology, ask consent, then create state ----
      if (action === "init") {
        if (!params.policy || typeof params.policy !== "object") {
          return fail("invalid_argument", "init requires a policy object");
        }
        // B-C fix (review round 2): a disabled campaign directory is archived
        // only AFTER consent and validation pass, immediately before the new
        // state is created — a consent refusal must not rename anything.
        const preInsp = await candidateState.inspectCampaign(campDir);
        const needsArchive = preInsp.status === "disabled";
        if (preInsp.status === "manual_check_required" || preInsp.status === "state_unreadable") {
          return fail(preInsp.status, `cannot init over an unresolved campaign directory: ${preInsp.message}`);
        }
        const raw = { ...params.policy } as Record<string, unknown>;
        // Methodology sha256 values are computed here from disk (untrusted input otherwise).
        const methodPaths = raw.methodology_files;
        if (!Array.isArray(methodPaths) || methodPaths.length === 0) {
          return fail("invalid_argument", "policy.methodology_files must be a non-empty array of {path}");
        }
        const methodFiles: { path: string; sha256: string }[] = [];
        for (const m of methodPaths) {
          const p = m && typeof m === "object" && typeof (m as any).path === "string" ? (m as any).path : null;
          if (!p) return fail("invalid_argument", "methodology_files entries must be objects with a path");
          const hash = await hashMethodologyBlob(workDir, "HEAD", p);
          if (!hash) return fail("invalid_argument", `methodology file ${JSON.stringify(p)} missing from the base commit HEAD; hash computed from the commit blob, cannot pin`);
          methodFiles.push({ path: p, sha256: hash });
        }
        raw.methodology_files = methodFiles;

        // Consent FIRST (writes nothing): the full policy is rendered by
        // formatCandidatePolicy (all user strings JSON-quoted) and confirmed
        // via the real dialog. No UI or refusal => no campaign, no disk write.
        const consent = await requestCandidatePolicyConsent(
          ctx.hasUI && ctx.ui ? { confirm: (t, m) => ctx.ui.confirm(t, m) } : null,
          raw,
        );
        if (!consent.ok || !consent.policy) {
          const errs = "errors" in consent && consent.errors.length ? ` First problem: ${consent.errors[0]}` : "";
          return fail(`policy_${consent.stage}`, consent.reason, errs);
        }
        const policy = consent.policy;

        // Archive the disabled campaign directory now (after consent + policy
        // validation): rename to <dir>-disabled-<timestamp>, data preserved
        // byte-exact, no deletion. On failure roll the rename back and refuse.
        if (needsArchive) {
          const archived = `${campDir}-disabled-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          try {
            fs.renameSync(campDir, archived);
          } catch (err) {
            return fail("archive_failed", `cannot archive the disabled campaign directory: ${err instanceof Error ? err.message : String(err)}`);
          }
          try {
            fs.mkdirSync(campDir, { recursive: true });
          } catch (err) {
            try { fs.renameSync(archived, campDir); } catch { /* keep the archive; report the failure */ }
            return fail("archive_failed", `cannot recreate the campaign directory after archive: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Base + leader ref: created only after consent.
        let baseSha: string;
        try {
          baseSha = (await gitOut(workDir, ["rev-parse", "HEAD"])).trim().toLowerCase();
          if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error("HEAD is not a full sha");
        } catch (err) {
          return fail("invalid_argument", `cannot resolve HEAD: ${err instanceof Error ? err.message : String(err)}`);
        }
        let preLeaderSha: string | null = null;
        try {
          // Review N6: after a previous campaign was disabled, the leader ref
          // may still exist; update-ref with a zero old value would fail with
          // "cannot lock ref". Read the CURRENT value (if any) and CAS from
          // it — create-or-replace in one compare-and-swap.
          preLeaderSha = await fullShaOf(workDir, LEADER_REF);
          const existing = preLeaderSha;
          const zero = "0".repeat(40);
          const r = await candidateGitExec("git", ["update-ref", LEADER_REF, baseSha, existing ?? zero], { cwd: workDir, timeout: 15000 });
          if (r.code !== 0) {
            return fail("leader_ref_failed", `git update-ref ${LEADER_REF} failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
          }
        } catch (err) {
          return fail("leader_ref_failed", `git update-ref failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const initRes = await candidateState.initCampaign(campDir, {
          ...policy,
          candidate_step_limit: policy.candidate_step_limit,
          candidate_time_limit_seconds: policy.candidate_time_limit_seconds,
        });
        if (!initRes.ok) {
          // Roll the leader ref back to its pre-init value so a refused init
          // leaves no leader change (deleting would lose an earlier ref).
          const existing2 = await fullShaOf(workDir, LEADER_REF);
          const zero2 = "0".repeat(40);
          const prev = preLeaderSha ?? zero2;
          if ((existing2 ?? zero2) !== prev) {
            await candidateGitExec("git", ["update-ref", LEADER_REF, prev, existing2 ?? zero2], { cwd: workDir, timeout: 15000 });
          }
          return fail(initRes.reason, initRes.message);
        }
        return {
          content: [{ type: "text", text: `✅ Campaign initialized. Policy is frozen (immutable). Leader ref ${LEADER_REF} = base ${baseSha.slice(0, 12)}. Next: create a candidate.` }],
          details: { action, leader: baseSha, policy: policy as any },
        };
      }

      // ---- create: state row + detached worktree from current leader ----
      if (action === "create") {
        const candidateId = typeof params.candidate_id === "string" ? params.candidate_id : "";
        if (!candidateWorktree.isValidCandidateId(candidateId)) {
          return fail("invalid_argument", "candidate_id must be [A-Za-z0-9._-], 1-64 chars");
        }
        const insp = await candidateState.inspectCampaign(campDir);
        if (insp.status !== "ready") return fail(insp.status, insp.message);
        const preState = insp.state!;
        // Review B4: refuse BEFORE creating any worktree, so a refused create
        // changes no files (design §5: forbidden transitions change nothing).
        // Mirrors candidateState.createCandidate's checks on the current state.
        if (preState.candidates.some((c) => c.id === candidateId)) {
          return fail("duplicate_candidate", `candidate ${JSON.stringify(candidateId)} already exists`);
        }
        const preActive = preState.candidates.find((c) => c.status === "active");
        if (preActive) {
          // Review final-B3 (design §2.4): an active candidate with unsaved
          // worktree changes must not be silently stranded by a create; the
          // switch is refused with the path list first.
          const activeWt = path.join(candidateWtRootOf(workDir), preActive.id);
          if (fs.existsSync(activeWt)) {
            const activeChanges = await candidateWorktree.collectWorktreeChanges(candidateGitExec, activeWt);
            if (!activeChanges.ok) {
              // bd 51n.11: an unreadable worktree must NOT pass as clean —
              // the switch would strand unknown work. Fail closed.
              return fail("worktree_unreadable", `cannot inspect active candidate ${JSON.stringify(preActive.id)} worktree (${activeChanges.reason}); refusing to create ${JSON.stringify(candidateId)} — resolve the worktree by hand first`);
            }
            if (activeChanges.changes.all.length > 0) {
              return fail("unsaved_changes", `active candidate ${JSON.stringify(preActive.id)} worktree has unsaved changes: ${activeChanges.changes.all.join(", ")}. Checkpoint or revert them before creating ${JSON.stringify(candidateId)}; nothing was deleted`);
            }
          }
          return fail("second_active_candidate", `candidate ${JSON.stringify(preActive.id)} is active; pause it before creating ${JSON.stringify(candidateId)}`);
        }
        const leaderSha = await fullShaOf(workDir, LEADER_REF);
        if (!leaderSha) return fail("leader_missing", `leader ref ${LEADER_REF} is missing; the campaign cannot create candidates`);
        const wtPath = path.join(candidateWtRootOf(workDir), candidateId);
        // Create worktree FIRST (fail-closed); the state row follows. If the
        // state write fails, the worktree stays (no deletion in MVP) and the
        // retry of create with the same id refuses on the existing path — the
        // operator resolves by hand; nothing is deleted automatically.
        const wtRes = await candidateWorktree.createCandidateWorktree(candidateGitExec, {
          repoRoot: workDir,
          baseCommit: leaderSha,
          worktreePath: wtPath,
          candidateId,
        });
        if (!wtRes.ok) return fail(wtRes.reason, wtRes.reason);
        const stateRes = await candidateState.createCandidate(campDir, candidateId);
        if (!stateRes.ok) return fail(stateRes.reason, stateRes.message);
        return {
          content: [{ type: "text", text: `✅ Candidate ${candidateId} created from leader ${leaderSha.slice(0, 12)}. Worktree: ${wtPath}. Edit files there, then run.` }],
          details: { action, candidate: candidateId, worktree: wtPath, base: leaderSha },
        };
      }

      // ---- run: budget-guarded candidate measurement (not a keep) ----
      if (action === "run") {
        const insp = await candidateState.inspectCampaign(campDir);
        if (insp.status !== "ready") return fail(insp.status, insp.message);
        const state = insp.state!;
        const active = activeCandidateOf(state);
        if (!active) return fail("no_active_candidate", "no active candidate; create or resume one first");
        const wtPath = path.join(candidateWtRootOf(workDir), active.id);
        if (!fs.existsSync(wtPath)) return fail("worktree_missing", `candidate worktree ${wtPath} is missing; resolve manually`);
        // bd tj0.6: a directory can exist while its git worktree is broken.
        // An unreadable worktree must never reach the benchmark (fail closed).
        const wtCheck = await candidateWorktree.collectWorktreeChanges(candidateGitExec, wtPath);
        if (!wtCheck.ok) {
          return fail("worktree_unreadable", `cannot inspect candidate ${JSON.stringify(active.id)} worktree (${wtCheck.reason}); refusing run — resolve the worktree by hand first`);
        }
        const policy = state.policy as unknown as CandidatePolicy;
        let measuredAverage: number | null = null;
        let runError: { reason: string; message: string } | null = null;
        const stateRes = await candidateState.runCandidateMeasurement(campDir, active.id, async () => {
          // Review B3: the time budget accumulates the REAL wall time of a
          // SUCCESSFUL measurement. Review round-3 B1: a KNOWN measurement
          // refusal (exec_failed/timeout/metric_*/checks_failed — the run
          // produced no value, nothing was promoted) is a CleanRefusal: the
          // pending-op marker is cleared and the campaign stays usable. The
          // failed run's time is NOT persisted (the step IS counted by the
          // state wrapper before the callback); a THROW (process crash,
          // unexpected exception) still keeps the marker (manual_check_required).
          const t0 = Date.now();
          const measured = await candidateMeasure.runRepeatedMeasurement(candidateExecRunner, {
            dir: wtPath,
            metricName: policy.metric_name,
            argv: policy.benchmark_argv,
            timeoutMs: policy.benchmark_timeout_seconds * 1000,
            repeats: policy.repeats,
          });
          if (!measured.ok) {
            runError = { reason: measured.reason, message: measured.message };
            throw new candidateState.CleanRefusal(measured.reason as any, measured.message);
          }
          measuredAverage = measured.average;
          return { seconds: (Date.now() - t0) / 1000 };
        });
        if (runError) {
          // Clean refusal: the outcome is known, the campaign is alive; the
          // step was already counted by runCandidateMeasurement.
          return fail(runError.reason, `${runError.message}. The run was refused; the step counts against the budget, nothing was promoted`);
        }
        if (!stateRes.ok) return fail(stateRes.reason, stateRes.message);
        // Persist the last measurement for status display (sidecar; state.json
        // schema stays untouched — the value is advisory, never authoritative).
        try {
          const lm = { candidate: active.id, metric_name: policy.metric_name, average: measuredAverage, at: new Date().toISOString() };
          fs.writeFileSync(path.join(campDir, "last-measurement.json"), JSON.stringify(lm));
        } catch { /* advisory only */ }
        return {
          content: [{ type: "text", text: `✅ Candidate ${active.id} measured: ${JSON.stringify(String(policy.metric_name))} average ${measuredAverage}. This is the candidate's local measurement — NOT a global keep. Next: checkpoint to save work.` }],
          details: { action, candidate: active.id, average: measuredAverage } as any,
        };
      }

      // ---- checkpoint: commit allowed files + ref + state row ----
      // B-B fix (review round 2): commit + ref + state row now live under ONE
      // pending-op marker via candidateState.checkpointUnderMarker — a crash
      // after the commit leaves the marker, so the next call reports
      // manual_check_required (design §4), never a silent commit-without-row.
      if (action === "checkpoint") {
        const candidateId = typeof params.candidate_id === "string" ? params.candidate_id : "";
        const insp = await candidateState.inspectCampaign(campDir);
        if (insp.status !== "ready") return fail(insp.status, insp.message);
        const state = insp.state!;
        const cand = candidateId
          ? state.candidates.find((c) => c.id === candidateId && c.status === "active") ?? null
          : activeCandidateOf(state);
        if (!cand) return fail("no_active_candidate", "checkpoint needs an active candidate (or an explicit active candidate_id)");
        const allowed = Array.isArray(params.allowed_files) ? params.allowed_files : [];
        const allowedCheck = candidateWorktree.validateAllowedFilePaths(allowed);
        if (!allowedCheck.ok) return fail("invalid_argument", allowedCheck.errors.join("; ") || "allowed_files invalid");
        // Review final-B2 (FR-07): methodology files are not changed by the
        // candidate — refuse before any git side effect if the checkpoint tries
        // to include one. The init-time change_files set is the only writable scope.
        const changeFiles: readonly string[] = Array.isArray((state.policy as { change_files?: unknown }).change_files)
          ? (state.policy as { change_files: readonly string[] }).change_files
          : [];
        // Compare in one spelling (forward slashes): src\\method.md is src/method.md.
        // Same canonical form as candidate-policy (slashes + lowercase), so the
        // checkpoint guard matches the init-time overlap guard exactly.
        const slash = (p: string): string => String(p).replace(/\\/g, "/").toLowerCase();
        const methodPaths = new Set((state.policy as { methodology_files?: { path?: string }[] }).methodology_files?.map((m) => slash(String(m?.path))) ?? []);
        const exactPath = (p: string): string => String(p).replace(/\\/g, "/");
        const changeSet = new Set(changeFiles.map(exactPath));
        for (const p of allowed) {
          if (methodPaths.has(slash(p))) {
            return fail("methodology_in_checkpoint", `allowed file ${JSON.stringify(p)} is a pinned methodology file and can never be changed by a candidate`);
          }
          if (!changeSet.has(exactPath(p))) {
            return fail("outside_change_files", `allowed file ${JSON.stringify(p)} is not in the campaign's change_files; only ${JSON.stringify(changeFiles)} may be changed`);
          }
        }
        const message = typeof params.message === "string" && params.message.trim().length > 0 ? params.message : `checkpoint ${cand.id}`;
        const wtPath = path.join(candidateWtRootOf(workDir), cand.id);
        let commitSha: string | null = null;
        const cpRes = await candidateState.checkpointUnderMarker(campDir, cand.id, async () => {
          const cp = await candidateWorktree.checkpointCandidateWorktree(candidateGitExec, {
            repoRoot: workDir,
            worktreePath: wtPath,
            candidateId: cand.id,
            allowedFiles: allowed,
            message,
            committedScope: { baseRef: LEADER_REF, scope: changeFiles },
          });
          if (!cp.ok) {
            // Review round-3 B1: pre-commit stages (validate/guard/
            // outside-allowed/allowed-files/empty) write NOTHING — a known
            // outcome, so the campaign must stay usable. CleanRefusal clears
            // the pending-op marker inside checkpointUnderMarker; commit/ref
            // stage failures still throw (the marker stays => manual_check_required).
            if (cp.stage === "commit" || cp.stage === "ref") {
              throw new Error(`${cp.stage}: ${cp.reason}`);
            }
            throw new candidateState.CleanRefusal("operation_failed", `${cp.stage}: ${cp.reason}`);
          }
          commitSha = cp.commit;
          return { checkpointId: cp.commit };
        });
        if (!cpRes.ok) {
          const suffix = commitSha !== null ? ` (worktree commit ${(commitSha as string).slice(0, 12)} and its ref already exist; inspect before retrying)` : "";
          return fail(cpRes.reason, cpRes.message + suffix);
        }
        return {
          content: [{ type: "text", text: `✅ Checkpoint saved: ${commitSha} (ref ${candidateWorktree.candidateRefFor(cand.id)}). It is now the selected checkpoint. Regression is allowed.` }],
          details: { action, candidate: cand.id, checkpoint: commitSha },
        };
      }

      // ---- pause/resume/select/close/disable: state-machine transitions ----
      if (action === "pause" || action === "close" || action === "disable") {
        // Review final-B3 (design §2.4): pausing or closing a candidate whose
        // worktree still carries unsaved changes would strand them (a paused
        // candidate cannot checkpoint, so the only exit would be manual git).
        // Refuse with the path list; nothing is changed or deleted.
        // bd 51n.11 (review blocker): disable ALSO strands an active candidate
        // with unsaved/unreadable worktree state — after it no candidate
        // operation (checkpoint, pause, run) is available, so the only exit
        // would be manual git. Same fail-closed check for all three actions.
        if (action === "pause" || action === "close" || action === "disable") {
          const targetId = String(params.candidate_id ?? "");
          const inspP = await candidateState.inspectCampaign(campDir);
          if (inspP.status !== "ready") return fail(inspP.status, inspP.message);
          const pState = inspP.state!;
          const pCand = targetId
            ? pState.candidates.find((c) => c.id === targetId) ?? null
            : activeCandidateOf(pState);
          if (!pCand) return fail("unknown_candidate", `candidate ${JSON.stringify(targetId || "<active>")} does not exist`);
          if (pCand.status === "active") {
            const wtPathP = path.join(candidateWtRootOf(workDir), pCand.id);
            if (fs.existsSync(wtPathP)) {
              const changes = await candidateWorktree.collectWorktreeChanges(candidateGitExec, wtPathP);
              if (!changes.ok) {
                return fail("worktree_unreadable", `cannot inspect candidate ${JSON.stringify(pCand.id)} worktree (${changes.reason}); refusing ${action} — resolve the worktree by hand first`);
              }
              if (changes.changes.all.length > 0) {
                return fail("unsaved_changes", `candidate ${JSON.stringify(pCand.id)} worktree has unsaved changes: ${changes.changes.all.join(", ")}. Checkpoint or revert them before ${action}; nothing was deleted`);
              }
            }
          }
        }
        const res = action === "disable"
          ? await candidateState.disableCampaign(campDir)
          : action === "pause"
            ? await candidateState.pauseCandidate(campDir, String(params.candidate_id ?? ""))
            : await candidateState.closeCandidate(campDir, String(params.candidate_id ?? ""));
        if (!res.ok) return fail(res.reason, res.message);
        // Owner pause/close/disable resets a pending deferral (design Decision 6).
        if (action !== "run") cancelSubagentDeferral(getRuntime(ctx));
        return { content: [{ type: "text", text: `✅ ${action} done. Checkpoints and refs are kept.` }], details: { action } };
      }

      if (action === "resume" || action === "select") {
        const candidateId = String(params.candidate_id ?? "");
        if (action === "resume") {
          // Design §2 step 4: switching candidates requires saved changes.
          const insp = await candidateState.inspectCampaign(campDir);
          if (insp.status !== "ready") return fail(insp.status, insp.message);
          const state = insp.state!;
          const target = state.candidates.find((c) => c.id === candidateId);
          if (!target) return fail("unknown_candidate", `candidate ${JSON.stringify(candidateId)} does not exist`);
          const wtPath = path.join(candidateWtRootOf(workDir), candidateId);
          if (fs.existsSync(wtPath)) {
            const changes = await candidateWorktree.collectWorktreeChanges(candidateGitExec, wtPath);
            if (!changes.ok) {
              return fail("worktree_unreadable", `cannot inspect candidate ${JSON.stringify(candidateId)} worktree (${changes.reason}); refusing resume — resolve the worktree by hand first`);
            }
            if (changes.changes.all.length > 0) {
              return fail("unsaved_changes", `candidate ${JSON.stringify(candidateId)} worktree has unsaved changes: ${changes.changes.all.join(", ")}. Checkpoint or revert them first; nothing was deleted`);
            }
          }
          const res = await candidateState.resumeCandidate(campDir, candidateId);
          if (!res.ok) return fail(res.reason, res.message);
          return { content: [{ type: "text", text: `✅ Candidate ${candidateId} resumed (active).` }], details: { action, candidate: candidateId } };
        }
        // select: switch the selected checkpoint of a candidate. Design §2
        // step 4: switching requires saved changes — the candidate's own
        // worktree must be clean (unsaved changes refuse with a listing;
        // nothing is deleted). Review N2: resume already enforced this;
        // select (checkpoint switch on the SAME candidate) changes which
        // tree content the next run measures, so it must refuse on dirt too.
        const checkpointId = String(params.checkpoint_id ?? "");
        {
          const inspSel = await candidateState.inspectCampaign(campDir);
          if (inspSel.status !== "ready") return fail(inspSel.status, inspSel.message);
          const selTarget = inspSel.state!.candidates.find((c) => c.id === candidateId);
          if (!selTarget) return fail("unknown_candidate", `candidate ${JSON.stringify(candidateId)} does not exist`);
          const wtPathSel = path.join(candidateWtRootOf(workDir), candidateId);
          if (fs.existsSync(wtPathSel)) {
            const changes = await candidateWorktree.collectWorktreeChanges(candidateGitExec, wtPathSel);
            if (!changes.ok) {
              return fail("worktree_unreadable", `cannot inspect candidate ${JSON.stringify(candidateId)} worktree (${changes.reason}); refusing select — resolve the worktree by hand first`);
            }
            if (changes.changes.all.length > 0) {
              return fail("unsaved_changes", `candidate ${JSON.stringify(candidateId)} worktree has unsaved changes: ${changes.changes.all.join(", ")}. Checkpoint or revert them first; nothing was deleted`);
            }
          }
        }
        const res = await candidateState.selectCheckpoint(campDir, candidateId, checkpointId);
        if (!res.ok) return fail(res.reason, res.message);
        return { content: [{ type: "text", text: `✅ Checkpoint ${checkpointId.slice(0, 12)} selected for ${candidateId}.` }], details: { action, candidate: candidateId, checkpoint: checkpointId } };
      }

      // ---- confirm: re-measure both sides, gate, CAS-promote ----
      if (action === "confirm") {
        const insp = await candidateState.inspectCampaign(campDir);
        if (insp.status !== "ready") return fail(insp.status, insp.message);
        const state = insp.state!;
        const active = activeCandidateOf(state);
        if (!active) return fail("no_active_candidate", "confirm needs an active candidate with a selected checkpoint");
        if (!active.selected_checkpoint) return fail("no_checkpoint", `candidate ${JSON.stringify(active.id)} has no selected checkpoint; run checkpoint first`);
        const policy = state.policy as unknown as CandidatePolicy;
        const cpSha = active.selected_checkpoint;
        const expectedLeader = await fullShaOf(workDir, LEADER_REF);
        if (!expectedLeader) return fail("leader_missing", `leader ref ${LEADER_REF} missing`);
        const epoch = String(measurementScaleStatusOfDir(workDir).epoch);
        // Review final-B2: hash methodology from the checkpoint COMMIT blob, so
        // edits committed by the candidate itself are caught (FR-07: methodology
        // files are not changed by the candidate).
        const currentMethodology = await hashMethodologyAtCommit(workDir, cpSha, policy);
        if (!currentMethodology.ok) return fail("methodology_changed", currentMethodology.reason);

        let outcome: { text: string; details: Record<string, unknown> } | null = null;
        // Review B1: capture the sides so cleanup removes ONLY worktrees this
        // call actually created; a refused side leaves its path untouched.
        let leaderSideCleanup: { ok: true; wtPath: string } | null = null;
        let candSideCleanup: { ok: true; wtPath: string } | null = null;
        // bd tj0.6: failures discovered while a side was being measured must
        // reach the reply even when beginOperation turns the side into a refusal.
        let leftoverWarn = "";
        const noteSideCleanup = (wtPath: string, cleanup?: { removed: boolean; message?: string }) => {
          if (!cleanup) return;
          if (cleanup.removed) {
            leftoverWarn += `\nℹ Ephemeral worktree ${wtPath} was cleaned after the failed measurement.`;
          } else {
            leftoverWarn += `\n⚠ Ephemeral worktree cleanup failed (${cleanup.message ?? "unknown"}) — ${wtPath} is left in place; it is now listed by candidate_branch status.`;
          }
        };
        const measureSide = async (label: string, sha: string) => {
          try {
            return await measureSideInEphemeral(ctx, workDir, label, sha, policy);
          } catch (err) {
            // An unexpected exception keeps the pending marker (beginOperation
            // does not treat it as a CleanRefusal), but its worktree path and
            // cleanup result are attached by measureSideInEphemeral.
            const meta = err && typeof err === "object" ? (err as any).candidateWorktreeCleanup : null;
            if (meta && typeof meta.wtPath === "string") noteSideCleanup(meta.wtPath, meta.cleanup);
            throw err;
          }
        };
        const opRes = await candidateState.beginOperation(campDir, `confirm ${active.id}`, async () => {
          // bd tj0.7: the captures above happened before beginOperation took
          // the campaign lock. Re-read all three preconditions here, before
          // measuring or promoting, so a concurrent promotion or a change of
          // measurement scale / methodology cannot make the two sides
          // incomparable. CleanRefusal clears the marker: nothing was started.
          const lockedLeader = await fullShaOf(workDir, LEADER_REF);
          const lockedEpoch = String(measurementScaleStatusOfDir(workDir).epoch);
          const lockedMethodology = await hashMethodologyAtCommit(workDir, cpSha, policy);
          const changed: string[] = [];
          if (lockedLeader !== expectedLeader) changed.push("leader ref");
          if (lockedEpoch !== epoch) changed.push("measurement epoch");
          const methodologyUnchanged = lockedMethodology.ok
            && lockedMethodology.hashes.length === currentMethodology.hashes.length
            && lockedMethodology.hashes.every((h, i) =>
              h.path === currentMethodology.hashes[i].path && h.sha256 === currentMethodology.hashes[i].sha256);
          if (!methodologyUnchanged) changed.push("methodology hashes");
          if (changed.length > 0) {
            throw new candidateState.CleanRefusal("preconditions_changed" as any,
              `confirm preconditions changed before the locked operation (${changed.join(", ")}); nothing was promoted`);
          }
          const leaderSide = await measureSide("leader", expectedLeader);
          if (!leaderSide.ok) {
            noteSideCleanup(leaderSide.wtPath, leaderSide.cleanup);
            // Round-3 B1 (parent decision): a KNOWN side refusal means no
            // promotion and no uncertainty — clean refusal clears the marker.
            throw new candidateState.CleanRefusal(leaderSide.reason as any, leaderSide.message);
          }
          leaderSideCleanup = { ok: true, wtPath: leaderSide.wtPath };
          const candSide = await measureSide("cand", cpSha);
          if (!candSide.ok) {
            noteSideCleanup(candSide.wtPath, candSide.cleanup);
            throw new candidateState.CleanRefusal(candSide.reason as any, candSide.message);
          }
          candSideCleanup = { ok: true, wtPath: candSide.wtPath };
          // Review B2: checks MUST run on the exact checkpoint, not the live
          // tree. The ephemeral candidate worktree is checked out from cpSha
          // (its HEAD is the checkpoint), so uncommitted live edits cannot
          // mask a bad checkpoint; compareForPromotion re-proves HEAD via
          // rev-parse inside that clean worktree before running the checks.
          const comparison = await candidateMeasure.compareForPromotion({
            runner: candidateExecRunner,
            policyMetricName: policy.metric_name,
            policyDirection: policy.direction,
            policyMinGain: policy.min_gain,
            policyMethodology: policy.methodology_files as any,
            currentMethodology: currentMethodology.hashes as any,
            leaderCommit: expectedLeader,
            candidateCommit: cpSha,
            leaderEpoch: epoch,
            candidateEpoch: epoch,
            leaderMeasurement: { metricName: policy.metric_name, direction: policy.direction, average: leaderSide.average },
            candidateMeasurement: { metricName: policy.metric_name, direction: policy.direction, average: candSide.average },
            checks: { argv: policy.checks_argv, dir: candSide.wtPath, timeoutMs: policy.benchmark_timeout_seconds * 1000 },
          });
          if (!comparison.ok) {
            outcome = { text: `⛔ No promotion (${comparison.reason}): ${comparison.message}`, details: { action: "confirm", promoted: false, reason: comparison.reason } };
            return;
          }
          const promoted = await candidateMeasure.promoteLeader(candidateExecRunner, {
            repoDir: workDir,
            leaderRef: LEADER_REF,
            expectedSha: expectedLeader,
            newSha: cpSha,
          });
          if (promoted.ok) {
            outcome = { text: `✅ PROMOTED: leader ref ${LEADER_REF} moved ${promoted.from.slice(0, 12)} -> ${promoted.to.slice(0, 12)}. The user's branch was not changed.`, details: { action: "confirm", promoted: true, from: promoted.from, to: promoted.to } };
          } else if (promoted.reason === "uncertain") {
            throw new Error(`promotion outcome unknown (${promoted.message}); inspect git rev-parse ${LEADER_REF} by hand before any further operation`);
          } else {
            outcome = { text: `⛔ No promotion (${promoted.reason}): ${promoted.message}`, details: { action: "confirm", promoted: false, reason: promoted.reason } };
          }
        });
        // Cleanup: remove ONLY the ephemeral worktrees this call created
        // (review B1: a refused/failed side must not touch anything at that
        // path — a live candidate worktree could be sitting there). B-A fix:
        // null checks (not .ok deref) — a side refused BEFORE creation leaves
        // the variable null, and a side that failed AFTER creation already
        // cleaned itself up inside measureSideInEphemeral. bd el3.2: a failed
        // removal surfaces ⚠ in the reply AND is remembered for status.
        for (const side of [leaderSideCleanup, candSideCleanup]) {
          if (side === null) continue;
          const rm = await removeEphemeralWorktree(ctx, workDir, side.wtPath);
          if (!rm.removed) leftoverWarn += `\n⚠ Ephemeral worktree cleanup failed (${rm.message ?? "unknown"}) — ${side.wtPath} is left in place; it is now listed by candidate_branch status.`;
        }
        if (!opRes.ok) {
          return fail(opRes.reason, opRes.message + leftoverWarn);
        }
        if (outcome === null) {
          return fail("internal", "confirm finished without a verdict; inspect the campaign state" + leftoverWarn);
        }
        return { content: [{ type: "text", text: outcome.text + leftoverWarn }], details: outcome.details };
      }

      // ---- resolve: OPERATOR manual resolution of an unresolved state ----
      // Design §4: no automatic recovery and no guessing. Resolution is an
      // OPERATOR action (review round-3 B2): the model cannot clear a pending
      // marker or a lock — it requires the human's explicit dialog consent
      // (ctx.ui.confirm === true), same principle as the policy consent. The
      // model-supplied operator_confirmation parameter is ignored.
      if (action === "resolve") {
        const insp = await candidateState.inspectCampaign(campDir);
        if (insp.status === "manual_check_required" && insp.pendingOp) {
          // Verify the git side of an interrupted checkpoint: if the ref
          // exists and resolves to a commit whose parent is the candidate's
          // previous checkpoint or base, the operator's consent may register
          // the orphan checkpoint (round-3 B4) instead of leaving a dead end.
          const refName = /^checkpoint (.+)$/.exec(insp.pendingOp.name);
          let orphanSha: string | null = null;
          let orphanCandidate: string | null = null;
          if (refName && insp.state) {
            const candId = refName[1];
            const ref = candidateWorktree.candidateRefFor(candId);
            try {
              const sha = (await gitOut(workDir, ["rev-parse", "--verify", "--quiet", ref])).trim().toLowerCase();
              if (/^[0-9a-f]{40}$/.test(sha)) {
                orphanSha = sha;
                orphanCandidate = candId;
              }
            } catch { /* ref missing — plain resolve below */ }
          }
          const orphanNote = orphanSha && orphanCandidate
            ? `Interrupted checkpoint detected: commit ${orphanSha} with ref ${candidateWorktree.candidateRefFor(orphanCandidate)} exists but is NOT registered in the state. Consenting will verify and register it. `
            : "";
          if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
            return fail("no_ui", `${orphanNote}resolve is an operator action and requires an interactive dialog; the pending op stays`);
          }
          const confirmed = await ctx.ui.confirm(
            "Candidate campaign: manual resolution",
            `${orphanNote}Pending operation: ${insp.pendingOp.name} (started ${insp.pendingOp.started_at}). Have you inspected Git refs and worktrees by hand and confirmed the outcome? Consenting clears the pending-op marker${orphanSha && orphanCandidate ? ` and registers orphan checkpoint ${orphanSha.slice(0, 12)} after verification` : ""}.`,
          );
          if (confirmed !== true) {
            return fail("operator_consent", "resolve requires explicit operator consent in the dialog; the pending op stays");
          }
          // Operator consented. If an orphan checkpoint was detected, verify
          // its lineage and register it under one marker before clearing.
          const alreadyRegistered = !!orphanSha && !!orphanCandidate && !!insp.state &&
            !!insp.state.candidates.find((c) => c.id === orphanCandidate)?.checkpoints.includes(orphanSha);
          if (orphanSha && orphanCandidate && insp.state && !alreadyRegistered) {
            const cand = insp.state.candidates.find((c) => c.id === orphanCandidate);
            let parentSha = "";
            try {
              parentSha = (await gitOut(workDir, ["rev-parse", "--verify", "--quiet", `${orphanSha}^`])).trim().toLowerCase();
            } catch { /* root commit or missing parent: unverifiable, handled below */ }
            const expectedParent = cand?.checkpoints.length
              ? cand.checkpoints[cand.checkpoints.length - 1]
              : null;
            const lineageOk = expectedParent
              ? parentSha === expectedParent
              : /^[0-9a-f]{40}$/.test(parentSha); // parent must exist (base-match is not recorded in state; see residual note)
            if (!cand || !/^[0-9a-f]{40}$/.test(parentSha) || !lineageOk) {
              return fail("orphan_unverified", `orphan commit ${orphanSha.slice(0, 12)} could not be verified (parent ${parentSha.slice(0, 12) || "missing"} does not continue the candidate's checkpoint chain); inspect by hand — the pending op stays`);
            }
            const regRes = await candidateState.registerOrphanCheckpoint(campDir, orphanCandidate, orphanSha, async () => {
              // The marker is already present (we are resolving it), so the
              // state primitive does not re-take it. Verify ref == sha still
              // holds at registration time.
              const nowSha = (await gitOut(workDir, ["rev-parse", "--verify", "--quiet", candidateWorktree.candidateRefFor(orphanCandidate!)])).trim().toLowerCase();
              if (nowSha !== orphanSha) {
                throw new candidateState.CleanRefusal("operation_failed", `checkpoint ref moved during resolution (${nowSha.slice(0, 12) || "missing"} != ${orphanSha.slice(0, 12)})`);
              }
            });
            if (!regRes.ok) {
              return fail(regRes.reason, `orphan checkpoint registration failed: ${regRes.message} — the pending op stays for manual inspection`);
            }
            return { content: [{ type: "text", text: `✅ Orphan checkpoint registered: ${orphanSha} (candidate ${orphanCandidate}, selected). Pending op resolved by operator consent.` }], details: { action, registered: orphanSha } };
          }
          const res = await candidateState.manualResolvePendingOp(campDir, candidateState.OPERATOR_CONFIRMATION);
          if (!res.ok) return fail(res.reason, res.message);
          return { content: [{ type: "text", text: "✅ Pending operation resolved by the operator; the marker is cleared. Verify the campaign with status." }], details: { action } };
        }
        if (insp.status === "ready" && insp.lockPresent) {
          if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== "function") {
            return fail("no_ui", "clearing a stale campaign lock is an operator action and requires an interactive dialog; the lock stays");
          }
          const confirmed = await ctx.ui.confirm(
            "Candidate campaign: clear stale lock",
            `A campaign lock file is present but no campaign operation is pending (${insp.message}). Confirm you verified no process is running and the lock is stale.`,
          );
          if (confirmed !== true) {
            return fail("operator_consent", "lock clearing requires explicit operator consent in the dialog; the lock stays");
          }
          const res = await candidateState.manualClearLock(campDir, candidateState.OPERATOR_CONFIRMATION);
          if (!res.ok) return fail(res.reason, res.message);
          return { content: [{ type: "text", text: "✅ Campaign lock cleared by the operator; state is untouched." }], details: { action } };
        }
        return fail("invalid_argument", `nothing to resolve: campaign status is ${insp.status} (${insp.message})`);
      }

      return fail("invalid_argument", `unknown action ${JSON.stringify(String(action))}; allowed: init create status resume run checkpoint pause select close confirm disable resolve`);
}

export interface CandidateExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface CandidateExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export function createCandidateExecRunner(
  spawn: typeof SpawnFn,
  killTree: (pid: number) => void,
  env: NodeJS.ProcessEnv,
): (argv: string[], opts: CandidateExecOptions) => Promise<CandidateExecResult> {
  return (argv, opts) => new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeoutHandle = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); }, opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ code: 127, stdout, stderr: stderr + String(err), killed: false });
    });
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ code: code ?? 1, stdout, stderr, killed: timedOut });
    });
  });
}

export function candidateWorktreeRoot(
  workDir: string,
  deps: {
    resolve: (p: string) => string;
    join: (...parts: string[]) => string;
    tmpdir: () => string;
    sha256: (value: string) => string;
  },
): string {
  const key = deps.sha256(deps.resolve(workDir)).slice(0, 16);
  return deps.join(deps.tmpdir(), "pi-ar-candidate", key);
}
