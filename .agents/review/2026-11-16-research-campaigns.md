# Review: research-campaign area — legacy improvement points
Date: 2026-11-16 · Scope: research-state.ts, research-journal.ts, research-analysis.ts, research-observations.ts, expedition.ts, expedition-view.ts, charter.ts, chain-briefs.ts, chain-journal.ts + research parts of index.ts (~2500–2900, ~9000–11000). Read-only review; all findings verified by reading code.

Totals: **21 findings** — dead/legacy code: 4, duplication: 7, phase-machine sprawl: 3, fail-open/closed & contracts: 4, extraction from index.ts: 3.

---

## 1. Dead / legacy code and stale branches

### F-01. Four near-identical campaign directory scanners (HIGH — see also F-08)
`index.ts:2607–2655` (researchScanSync), `:2677–2702` (researchGitBlockingScan), `:2726–2751` (researchLaunchBlockingScan), `:9107–9125` (listResearchCampaignIds) + `:9129–9149` (blockingCampaignIds). All five walk `<root>/*`, check `pending-op.json`, parse/validate `state.json` against the same inline predicate (`schema_version === 1 && campaign_id === name && phase ∈ CAMPAIGN_PHASES` — repeated verbatim at 2654, 2716, 2768), and apply a *different* phase-blocking rule each. The state-validation predicate is copy-pasted 3×; any schema change must touch 5 places. **Fix:** one parameterized scanner in research-state.ts, e.g. `scanCampaigns(root): {dir, id, state?, pendingOp?}[] | "unreadable"`, and per-caller policies as a small table: `blocksFor: {research: true, stopped: true|false, briefing: bool}, halted: bool, gitBan: bool`. Each current function becomes a 3-line policy over the shared scan.

### F-02. `VERDICTS` alias exists only for tests (LOW)
`research-state.ts:58` `export const VERDICTS = DEFAULT_VERDICTS;` — no production caller (`grep` finds only `tests/research-brief-gates.test.mjs:171-173`, whose own name says "the module still exports ... the Verdict-typed VERDICTS alias"). Either drop the alias and update the 2 test sites, or inline it — keeping a production export solely because a test asserts its existence is a legacy smell.

### F-03. Hidden combined `research` dispatcher — 700+ lines of dead weight as a tool (MED)
`index.ts:10237–10949` registers a full `registerTool` named `research` with `exposure: "hidden"` purely so `research_questions`/`expedition_map` aliases can call its `execute` (10944–10949 `researchExecutor = researchTool.execute`). The tool carries its own schema, renderer, promptGuidelines and promptSnippet that no model ever sees. **Fix:** extract the action handlers into a plain `researchDispatch(params, ctx)` function in a new module (`research-dispatch.ts`), register only the two real aliases. Removes the "hidden tool" concept and ~100 lines of renderer/schema boilerplate.

### F-04. Service-dir special cases now encoded 4× with different comments (LOW)
The "live case 2026-11-14: dirs without state.json are not campaigns" knowledge is duplicated at `index.ts:2636–2641` (researchScanSync), `:2688–2690` (git scan), `:2738–2740` (launch scan), `:9110–9115` (listResearchCampaignIds), each with its own phrasing of the same story. One shared scanner (F-01) collapses all four comments into one place.

---

## 2. Duplication

### F-05. `sha256Hex` duplicated by explicit comment (LOW)
`chain-journal.ts:11` header literally says *"imports writeFileAtomic from research-state.ts and keeps a local sha256Hex"*; `chain-journal.ts:98` re-implements `research-state.ts:880`. Also `index.ts` imports `createHash` separately for its own hashing. **Fix:** move `sha256Hex` to a tiny `hash.ts` (or export from research-state and import in chain-journal); delete the local copy.

### F-06. `appendResearchEvent` bypasses the journal abstraction (MED)
`index.ts:9488–9493` appends to `log.jsonl` with raw `fs.promises.appendFile`, while `research-journal.ts` exists precisely to provide locked, size-bounded, head-tracked journal appends (`appendJournalLine`, `withJournalLock`) and is used for observations/analysis/run-links. The campaign log is the only jsonl written without the shared critical-section machinery. Low practical risk today (writes happen inside `updateState`'s campaign lock), but it means two journal idioms coexist. **Fix:** either route campaign events through research-journal's append (new `JournalName: "campaign"`), or document explicitly why the campaign lock makes the journal lock redundant.

### F-07. `readResearchLog` strict parser re-implements jsonl reading (LOW)
`index.ts:9406–9428` hand-rolls split/JSON.parse/per-line validation; `jsonl.ts` already exports `parseJsonlEntry` and `reconstructJsonlState` used elsewhere (research-observations.ts imports them). Same torn-line/error semantics implemented twice with subtly different behavior (readResearchLog *refuses* on any bad line; the ledger reader is tolerant). **Fix:** shared `readStrictJsonl(path): {ok, events} | {ok:false, line}` helper in jsonl.ts.

### F-08. Scanners (see F-01) + launch-time campaign lists duplicated a 5th time (MED)
The `/autoresearch research` branch re-implements discovery again at `index.ts:11784–11905`: `listResearchCampaignIds` per base, per-id `readState`, per-phase refusal strings, `closeStaleCampaign` for stale unpinned campaigns — this is `blockingCampaignIds` (9129–9149) with richer messages and mutation. Two places define "which campaigns block a launch". **Fix:** one `campaignLaunchBlockers(bases, {closeStale?})` helper used by both the tool guard and the slash command.

### F-09. Multi-base union logic duplicated (MED)
`sessionResearchCampaignIds` (9276–9289: effective base + default root union) and `resolveResearchTarget` (9335–9355: same two-base union, single-id selection) and the launch branch's `uniqueLaunchBases` set-building (11784–11790) each re-derive "the bases visible to this session". **Fix:** one `sessionBases(workDir, ctx): string[]` + `forEachCampaign(bases, fn)`; the three callers reduce to policies.

### F-10. Phase-transition closures repeated inline (LOW)
`briefing→research` transition is written twice (`index.ts:9859–9886` expedition campaign start, `:10601–10608` research start) and `research→stopped` twice (`:10907–10912` stop, `:9284–9287` stale-abandon). Each repeats the `updateState(dir, msg, s => s.phase === X ? {ok,next:{...s,phase:Y}} : refusal(...))` idiom with slightly different messages. **Fix:** `transitionPhase(dir, opName, from, to, extraMsg)` in research-state.ts; all four call sites become one-liners.

### F-11. Evidence-ref existence checking duplicated between findings.ts and research tool (LOW)
`findings.ts:193` `parseEvidenceRef` validates format; the research `record` action (`index.ts:10772–10810`) re-implements its own path:lines/anchor resolution and containment rules instead of reusing findings.ts' parsed structure (it calls `parseEvidenceRef` only as a *format gate* at 10777–10780, then does its own file read). Two evidence-ref semantics that can drift. **Fix:** move the reference-resolution primitive into a shared module and have both callers consume `{path, start?, end?, anchor?}` uniformly.

---

## 3. Phase machine: asymmetric checks / scattered rules

### F-12. Blocking rules for the same phase differ per consumer without a single table (HIGH)
Current matrix (verified):
| Consumer | briefing | research | stopped | pending-op | unreadable |
|---|---|---|---|---|---|
| researchScanSync blocks (ordinary loop, 2647–2652) | no | yes | **yes** | yes | yes |
| researchScanSync halted (auto-continue, 2647–2652) | no | no | **yes** | yes | yes |
| researchGitBlockingScan (2695–2699) | no | yes | no | yes | yes |
| researchLaunchBlockingScan (2747) | **yes** | yes | no | yes | yes |
| blockingCampaignIds (9145) | yes | yes | no | (via inspect) | yes |
| closeStaleCampaign (9285) | stale-closable | stale-closable | no | n/a | refuse |

None of these rules is written in one place; the git gate just gained a *third* distinct scan (fix dbe2170) because the tables disagree. **Fix:** a single exported const, e.g. `RESEARCH_PHASE_POLICY = { ordinaryLoop: {research:1, stopped:1}, halt: {stopped:1}, git: {research:1}, launch: {briefing:1, research:1} }` in research-state.ts, with the scanners interpreting it. Any future fourth gate (like the git one) becomes a row, not a new function.

### F-13. Phase checks as inline string comparisons in 42 places (MED)
42 occurrences of `phase ===/!== "briefing"|"research"|"stopped"` across index.ts (grep verified), including type-unsafe reads of raw JSON in the scanners (`raw.phase` before validation). **Fix:** after F-01's shared scan returns typed `CampaignState | null`, most raw reads disappear; remaining comparisons go through helpers `isTerminal(state)`, `isActive(state)`.

### F-14. `inspectCampaign` status strings overlap refusal reasons (LOW)
`research-state.ts:638–681` returns `status: "ready"|"uninitialized"|"state_unreadable"|"manual_check_required"|"invalid_argument"` — a *second* vocabulary beside `RefusalReason`. Callers in index.ts (e.g. `otherCampaignBusyReason` 9326–9331, launch branch 11857) must remember which vocabulary applies where; `state_unreadable` exists in both with different shapes. **Fix:** make `inspectCampaign` return the same `Result`/`Refusal` union as everything else, or derive its status from RefusalReason.

---

## 4. Fail-open / fail-closed and implicit contracts

### F-15. `archiveFinishedCampaigns` ignores pending-op markers (HIGH, known open issue bd pi-autoresearch-vhr)
`index.ts:9153–9201`: reads `researchState.readState` (which does *not* check pending-op) and moves any `stopped` campaign; a campaign with an interrupted operation marker is archived silently while the finalize note claims success. The issue exists; the fix is one `readPendingOp` check in the loop. Re-listed here because review confirmed it is still unfixed at HEAD.

### F-16. `baseHasCampaign` counts service dirs, unlike every other scanner (MED)
`index.ts:9290–9299`: returns true if *any* directory exists under the research root — including `briefs/`/`evidence/` service dirs that all other scanners (F-01/F-04, live case 2026-11-14) deliberately skip. Consequence: `/autoresearch clear` (11557 via researchCampaignExists) can be permanently refused by leftover service dirs even with zero campaigns, while `research_brief draft` proceeds fine. Inconsistent contract for "what is a campaign". **Fix:** base it on `listResearchCampaignIds(base).length > 0` (null → true, fail closed).

### F-17. state.json contract is implicit in 3 inline predicates (MED)
The validity predicate (`schema_version && campaign_id === dirname && phase ∈ CAMPAIGN_PHASES`) is inlined in 3 scanners (2654, 2716, 2768) and also exists as `stateProblem` (research-state.ts:560–578) and in `readState`. The scanners do not use `researchState.readState` — presumably for sync-ness (resume timer). **Fix:** export a sync `stateProblemSync(raw, expectedId): string | null` from research-state.ts and have the scanners call it; one contract, still synchronous.

### F-18. `researchScanSync` treats `stopped` as `halted` forever until archived (MED, design tension worth documenting)
`index.ts:2649–2651`: a stopped campaign sets `blocks + halted`, so *all* auto-continuation (drift/compaction resumes) stays suppressed indefinitely, and the ordinary loop stays blocked, until some future `research_brief draft` archives the campaigns. That was the root of the 2026-11-15 lob-collector-data git-lock incident (only the git face was fixed in dbe2170; ordinary-loop blocking of finished campaigns remains by design §8/§9). Risk: a session that finished all campaigns keeps a paused widget and blocked loop with no agent-visible path except `draft` or archive-by-hand. **Fix (behavioral decision needed):** either archive finished campaigns at `report`/`exitResearchMode` time (not only at next draft), or scope the blocks to the pinned campaign id instead of "any campaign on disk". At minimum, document this deliberately in docs/research-vectors.md.

---

## 5. What to extract from index.ts

### F-19. Research-campaign cluster is ~2,500 lines of index.ts (HIGH)
Verified clusters inside index.ts that belong in modules: campaign scans & guards (2607–2800, ~200 lines), resume composers (2780–3030), researchSnapshot/replay/log (9390–9530), stale close/archive/campaign-id plumbing (9090–9360), the whole hidden `research` dispatcher (10237–10949, ~700 lines), the launch branch of `/autoresearch research` (11736–12000). Together ≈ 2,300–2,500 lines of pure research-campaign logic with no dependency on the ordinary-loop runtime except `getRuntime` pins. **Fix (order of least risk):** 1) `research-scan.ts` (F-01 scanner + policy table) — pure fs, zero runtime deps, easiest tests; 2) `research-dispatch.ts` (F-03 action handlers, injected with `{runtime pins, chain helpers}`); 3) `research-launch.ts` (slash-command branch + archive/stale close). index.ts shrinks ~20%.

### F-20. Test-hook `let` exports as DI pattern (`closeStaleCampaign`, `runtimeForTest`, …) (MED)
`index.ts:299` `export let closeStaleCampaign` is assigned at 9264 and consumed at 11868 through the module global — same pattern as `restoreExpeditionForTest`, `runtimeForTest`, `sendPendingResumeIfReadyForTest`, etc. (7+ such `export let` hooks). Works, but every extraction (F-19) must thread these through, and assignment order is implicit. **Fix:** when extracting modules, pass an explicit `hooks`/`deps` object parameter instead of module-level lets; keep the old lets as thin aliases for existing tests.

### F-21. `chainCampaignIds` in index.ts duplicates journal-walking that chain-journal could own (LOW)
The archive path (9160–9180) and launch guards read chain journals to decide which campaigns are chain-protected; that knowledge (which campaigns belong to an ACTIVE chain) belongs beside `chainJournal.statusOf/verifyChain` in chain-journal.ts, not as an index.ts closure capturing ctx. **Fix:** `chainJournal.chainCampaignIds(workDir, chainId)` returning ids; index.ts keeps only the ctx pin.

---

## Top-10 priority table

| # | Where | Issue | Risk | Action |
|---|---|---|---|---|
| 1 | index.ts:2607–2751, 9107–9149 | 4–5 duplicate campaign scanners, 3× copy-pasted state predicate | high | single `scanCampaigns` + policy table |
| 2 | index.ts:2647–2652 + F-18 | stopped blocks ordinary loop & auto-continue until archived | med–high | archive at report/exit or scope blocks to pin; document |
| 3 | index.ts:9153–9201 | archiver ignores pending-op markers (bd vhr) | high | add `readPendingOp` check |
| 4 | index.ts:10237–10949 | hidden `research` dispatcher tool, ~700 lines | med | extract `research-dispatch.ts`, register aliases only |
| 5 | research-state.ts (new export) | phase blocking rules scattered, 42 inline phase checks | high | `RESEARCH_PHASE_POLICY` table |
| 6 | index.ts:9290–9299 | baseHasCampaign counts service dirs (clear guard poisoned) | med | use listResearchCampaignIds |
| 7 | research-state.ts:560–578 vs scanners | state contract implicit in 3 inline predicates | med | export sync `stateProblemSync` |
| 8 | index.ts:9859/10601/10907/9284 | 4 inline phase-transition closures | low | `transitionPhase` helper |
| 9 | chain-journal.ts:98 vs research-state.ts:880 | sha256Hex duplicated by its own comment | low | shared hash.ts |
| 10 | index.ts:~2,500 lines cluster | research logic spread across 6 regions of god-file | high | extract in 3 steps (scan → dispatch → launch) |

Not issues (checked): state atomic-write protocol (research-state.ts:395–425 rename retry, 492–504 lock discipline, 606–634 pending-op order) is sound and fail-closed; chain-journal hash chain (290–365) is correct; expedition map replay/territoryComplete is self-consistent.
