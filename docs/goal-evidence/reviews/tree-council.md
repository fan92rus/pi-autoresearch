## Review

**Verdict: APPROVED (ГОДЕН)** — no blockers.

### Correct — verified with evidence
- **Tool bodies are semantically identical to HEAD.** I extracted both tool objects from `git show HEAD:extensions/pi-autoresearch/index.ts` and from `tree-council-tools.ts`, normalized only `deps.<name>` → `<name>` plus the wrapper/closing lines, and compared bytes:
  - `tree_status`: 5,777 bytes vs 5,777 — identical.
  - `council_convene`: 9,782 bytes vs 9,782 — identical.
  - This covers all descriptions, prompts, refusal/gate messages, renderers, tree/UCB1 wiring, and council/brief/slate text. No diff of any kind.
- **Symbol resolution preserved.** All 25 runtime imports used by the extracted bodies resolve to the same modules as in HEAD (`parallel/tree.ts`, `parallel/treeview.ts`, `widget.ts`, `measurement.ts`, `findings.ts`, `council.ts`, `council-delegation.ts`, `pi-tui`, `node:fs`, `node:path`); no local shadows. None of the removed imports are referenced anywhere in the current `index.ts` (all counts 0).
- **Deps discipline.** 11 dep properties total: 4 in `TreeStatusToolDeps`, 7 in `CouncilConveneToolDeps`; 9 are getter-backed at the call sites in `index.ts`. The late const `campaignBlocksOrdinaryLoop` (declared at line 4512, after registration at 4425) is read via `get campaignBlocksOrdinaryLoop()`. The only by-value function dep, `epochReferenceLine`, is a hoisted top-level `function` declaration (line 748), so it cannot be in TDZ; `pi` is the stable extension parameter. No destructuring of deps in either `execute`; runtime state is re-read via `deps.getRuntime(ctx)` each call.
- **No module state / cycles.** The new module contains only imports, type declarations, and two factories. `tree-council-tools.ts` is imported only by `index.ts`; a transitive walk of all 31 reachable local modules found zero imports of `index.ts`.
- **Registration parity.** Tool-name set is 10/10 identical to HEAD; each factory is registered exactly once through the same `registerGatedTool` (typed as `Parameters<typeof pi.registerTool>[0]` in both places).
- **Numbers recomputed:** `index.ts` 6,978 → 6,646 lines (−332 = +18/−350); new module 400 lines. Logs: targeted `233 tests / 231 pass / 0 fail / 2 skipped`; full `1959 / 1950 pass / 5 fail / 4 skipped`. `git diff --check` clean; no staged files.
- **Full-run failures are pre-existing/environmental**, not caused by this extraction: `autoresearch section 7618 chars exceed 7500` fails identically at baseline (`tree-council2-baseline-solo.log`, detached baseline worktree); the journal-lock failure fails at baseline (`tree-council2-baseline-journal.log`); two other journal-lock/T10 cases pass in solo reruns, and an independent full run (`e6-briefs-full.log`) has the exact same five failures and counts.
- **Build log** `tree-council2-esbuild-final.log`: bundle 1.3 MB, completed in 41 ms, and the final bundle contains both tool definitions and the getter form.

### Notes / residual risks (non-blocking)
- Log mtimes (targeted 18:04:05, full 18:12:49) precede the final `index.ts` mtime (18:13:47), so those runs are evidence of a slightly earlier snapshot; the final source is nevertheless covered by the 18:24 esbuild bundle and by my byte-identity/static verification of the final file. No full suite was rerun per instruction.
- `epochReferenceLine` remains by-value: safe today, but if it is ever converted from a top-level function declaration to a late `const`, it must be switched to a getter like the other eight function deps.
- Full suite remains red at 5 failures; these match baseline/flaky behavior and should be treated as an existing test-environment debt, not a regression from this change.

No files were edited or committed during this review.