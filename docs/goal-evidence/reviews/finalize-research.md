## Review

**ГОДЕН.** No blockers found.

- **Correct:** The extracted tool body preserves the old finalize behavior: gates and refusal paths, expedition journal/status/report order, archival, finalize ledger entry, campaign report fallback, steer, and response/details. The only execution changes are collaborator accesses through `deps`; the registration wrapper is at `index.ts:4773–4790`.
- **Correct:** All 16 dependencies are accounted for. Late-bound functions—including the campaign/research guards and responses, chain campaign IDs, mode exit, archival, effective research base, and expedition report writer—are getter-backed. The stable references (`pi`, `autoresearchJsonlPath`, `getRuntime`, `resolveWorkDir`, `writeCampaignReport`) are passed directly. The getters are not read during registration; their referenced declarations being later in `index.ts` introduces no TDZ issue. The new module imports no `index.ts` module, so I found no cycle or new module state.
- **Verification:** esbuild succeeded; targeted tests passed **46/46**. Full-suite log reports **1,950 passed, 5 failed, 4 skipped** out of 1,959: failures are the reported prompt-size baseline (871), hung child (1200), and cross-process tests (1368, 1578, 1655). I did not rerun the full suite.
- **Change size:** `index.ts` is **7,402 → 7,291 lines (−111)**; extracted module is **172 lines**. `git diff --check` reported no whitespace errors.

**Blockers:** none. **Minors/nits:** none identified.