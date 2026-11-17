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
| 27b75f5 | **11,154** | **−96** | E2 research scan/dispatch adapters (8af.5, partial) |

## Observations

- Bugfix waves typically ADD lines (+15…+66); only true extractions reduce the file.
- lrx.1 is the first extraction with a measurable reduction (−152, 1.25% of the file); cumulative reduction across lrx.1+8e5.6+el3.3+8af.5 is −1,004 lines (−8.3% from the 12,158 baseline).
- Remaining large extractions (in dependency order): 8e5.6 (resume-policy, ~460 lines), el3.3 (candidate orchestration, ~900 lines), 8af.5 (research cluster ~2,500 lines), 161.1 (slash-commands/widget), 161.2 (findings/measurement tool adapters).
- To reach ≤6k, several of the large extractions MUST land — bugfix-only waves cannot get there.

## Verification contract

After every extraction step: measure `wc -l`, record in the corresponding bd task comment, compare top-level declarations with HEAD (no tool/hook may disappear), run `npm test` (only the 6 baseline flakes allowed).
