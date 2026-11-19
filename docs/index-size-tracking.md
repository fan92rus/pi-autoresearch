# index.ts size tracking (bd pi-autoresearch-161.5)

Baseline of the overnight tech-debt campaign: **12,158 lines** (`extensions/pi-autoresearch/index.ts`, commit b27a253, 2026-11-17 01:20).
E6 exit criterion: **≤ ~6,000 lines**, with no tool/hook lost (full suite green after each extraction step).

## Measured commits (wc -l of extensions/pi-autoresearch/index.ts)

| Commit | Lines | Δ vs previous | Step |
|--------|------:|--------------:|------|
| 5fee5f8 | 12,071 | — | E7 dead code (before E1) |
| 04bcf6f | 12,100 | +29 | E1 wave-1 (noise-floor fix + tests) |
| acab462 | 12,100 | 0 | E1 wave-2 (findings lock) |
| adedf87 | 12,152 | +52 | E1 wave-4 (revert dedup) |
| b27a253 | 12,158 | +6 | E3 dedup helpers (baseline reference) |
| 60532b7 | 12,089 | −69 | E2 scanCampaignsSync |
| 014bbd4 | 12,116 | +27 | E2 archive-at-exit (8af.6) |
| f86099f | 12,099 | −17 | E5 parallel-* removal (el3.4) |
| 9454130 | 12,165 | +66 | E5 ephemeral cleanup (el3.2) |
| c300a86 | 12,180 | +15 | E4 delivery-time drift (8e5.1) |
| 4fba40d | 12,215 | +35 | E4 evaluateResumeGates (8e5.3) |
| 5168460 | 12,247 | +32 | E4 resolveLoopMode + mode tag (8e5.2) |
| 4e30c43 | 12,268 | +21 | E4 session registry (8e5.5) |
| 3d323ba | 12,116 | −152 | E3 ledger-metrics extraction (lrx.1) |
| 4ab2088 | 11,897 | −219 | E4 resume-policy extraction (8e5.6) |
| a2f0211 | 11,250 | −647 | E5 candidate dispatcher extraction (el3.3) |
| 27b75f5 | 11,154 | −96 | E2 research scan/dispatch adapters (8af.5, partial) |
| 2c1e4ac | 10,525 | −629 | E6 widget renderers extraction (161.1) |
| 048a134 | 10,188 | −337 | E6 findings/measurement adapters (161.2) |
| 6f0c189 | 10,202 | +14 | F-20 typed test-hooks object (161.3, DI enabler; net +14) |
| d937f07 | 10,203 | +1 | unified refusal renderer (161.4, net +1, remeasured) |
| ed6b3ba | 10,347 | +144 | es1.7/es1.8 explicit uiMode + mode-switch finalize (behavior fix, net +144, remeasured) |
| 02e5ede | 10,342 | −5 | RESEARCH_PHASE_POLICY migration (8af.2, net −5) |
| eec6cd6 | 9,739 | −603 | hidden research dispatcher extraction (8af.5 continuation) |
| 84e1d55 | 9,382 | −357 | direction-review tool extraction (161) |
| 7692a6b | 8,384 | −998 | log_experiment tool extraction (161/E6) |
| fdf2d96 | 7,641 | −743 | run_experiment tool extraction (161/E6) |
| ecd29b2 | 7,402 | −239 | candidate_branch registration wrapper extraction (161/E6) |
| cc96d25 | 7,291 | −111 | finalize_research tool extraction (161/E6) |
| 522fee1 | 6,978 | −313 | research_brief tool extraction (161/E6) |
| 8034912 | 6,646 | −332 | tree_status + council_convene extraction (161/E6) |
| 6b2b990 | 6,349 | −297 | brief + research/map alias tools extraction (parallel worktree, 161/E6) |
| de21afc | **5,722** | **−627** | autoresearch command handler extraction (161/E6) |
| <pending> | **5,484** | **−520** | dashboard + HTTP server extraction (bd tj0.13) |

## Observations

- Bugfix waves typically ADD lines (+15…+66); only true extractions reduce the file.
- lrx.1 is the first extraction with a measurable reduction (−152, 1.25% of the file); cumulative reduction at HEAD (de21afc, remeasured by `git show <sha>:index.ts | wc -l`) is −6,436 lines (−52.9% from the 12,158 baseline); E6 target ≤6k reached.
- Large extractions already landed: lrx.1 ledger-metrics, 8e5.6 resume-policy, el3.3 candidate dispatcher, 161.1 widget renderers, 161.2 findings/measurement adapters, 8af.5 dispatcher/research-tool, direction-review tool , log_experiment tool, run_experiment tool, candidate_branch wrapper , finalize_research tool and research_brief tool; E6 target ≤6k reached at 5,722 lines.
- To reach ≤6k, several of the large extractions MUST land — bugfix-only waves cannot get there.

## Verification contract

After every extraction step: measure `wc -l`, record in the corresponding bd task comment, compare top-level declarations with HEAD (no tool/hook may disappear), run `npm test` (only the 6 baseline flakes allowed).
