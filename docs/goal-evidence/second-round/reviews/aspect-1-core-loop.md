ЕСТЬ ТЕХДОЛГ

[bug] [major] extensions/pi-autoresearch/index.ts:2706-2720 — `agent_start` only pauses the pending timer; `agent_end` reschedules any surviving `pendingResumeMessage`, so a drift nudge queued before a new user turn is delivered after a productive turn, falsely saying "Last turn did no work" and spending the drift budget (resume-policy.ts:180) — cancel drift-tagged pending at the turn boundary, keeping non-drift/compaction pending — high.

[bug] [major] extensions/pi-autoresearch/index.ts:2416-2423, 1751-1760, 2632 — the persisted off marker is consulted only by expedition restore; initial auto-activation still defaults ON for a fresh same-cwd session with a log, resurrecting the loop after `/autoresearch off` — pass `!readPersistedOffMarker(workDir)` into the auto-activation decision at init — high.

[bug] [major] extensions/pi-autoresearch/index.ts:2744-2751, 5202-5207 + resume-policy.ts:163-186 — off during an in-flight composer/gate evaluation is not rechecked: `ensurePendingResume` schedules after its await, and `sendPendingResumeIfReady` checks mode only once before several awaits, so `/autoresearch off` can cancel a timer yet still see a nudge sent — add a generation token bumped by all off paths, rechecked after every await and immediately before send — medium-high.

[bug] [minor] extensions/pi-autoresearch/resume-policy.ts:177-185 — `consecutiveDriftResumes`/`autoResumeTurns` increment before awaited `resolveLoopMode` and `sendUserMessage`; a failed send or mode switch spends budget despite the "cancelled at send time spends nothing" invariant — move increments after confirmed send or guard them with the same token — medium.

[tech_debt] [minor] tests/subagent-wait-guard.test.mjs:214 — deferral reset at a new turn is tested, but pending-message carry-over across `agent_start` is not; the stale-nudge path above is unguarded by tests — add a regression test asserting no drift message/counter change after a turn that used loop tools — high.

Development points:
1. Introduce turn-tagged pending resumes: drop drift-tagged pending in `agent_start`, preserve explicit compaction resumes, and cover with a productive-turn regression test.
2. Centralize activation intent in one predicate combining session-recorded decision and the persisted `.auto/autoresearch-off.json` marker; use it in both init auto-activation and expedition restore.
3. Add cancellation tokens to the async resume pipeline (off, compaction, session switch) with post-await mode rechecks in `ensurePendingResume`, `sendPendingResumeIfReady`, and `deliverDeferredDriftNudge`.