# Research-map: evidence for specification approval

This file preserves session tool output and the owner's answer. It is a transcript excerpt recorded by the orchestrator, not an independently signed review report. The reviewer role had no write-capable tool, so the full underlying review and the full list of 11 minor findings were not saved as a separate file.

## Final independent review

Session `recall` entry `#1121` / observation `b7d2adfc0285`; reviewer output received 2026-11-05 23:35, before owner approval and before the later status-label-only changes. The review covered `openspec/INDEX.md` and the research-map proposal, requirements, design rev.11, tasks and four delta specifications. The author model was identified as `openai-codex/gpt-6.1-terra`.

Verbatim `fusion_delegate` tool result:

> research-map-package-final · done · Final read-only owner-approval-readiness review of the research-map package (proposal, requirements, design rev.11, tasks, four delta specs, openspec/INDEX.md). Reviewer identity from the environment: PI_MODEL=claude-haiku-5-5, PI_PROVIDER=anthropic, which differs from the author model openai-codex/gpt-6.1-terra. I tried to break the previous fixes: semantic_outcome is consistent across proposal, requirements FR-01.6, design §11.1a and T153; advisories carry the mandatory 'not confirmed' wording (§12.3, §12.3b, §12.4, §12.2 item 7); T51 is explicitly synthetic and disclaims the historical run 56; the run-link lifecycle, prereg ordering (§9.3, T43/T69-T72/T136), comparison context (§9.2 step 5, T138) and S_exh barriers (§12.3a, T119/T123-T126) are internally coherent; Git side effects of locks and .auto/ on keep are disclosed as owner-gated (E-8, R11, §5.6). I found no blocker and no major: every remaining item is either owner-gated and disclosed or a minor wording/evidence issue. Verdict PASS means only ready to ask the owner; it does not mean the owner approved, and no T-tests were executed. · -
> · verdict: pass · findings: 11 · checksRun: 6

The subsequent owner-approval status-label changes were independently re-reviewed by `research-map-owner-approval-recheck`: PASS, status labels only, no changes to technical requirements, `openspec validate --all` 3 passed / 0 failed and `git diff --check` exit 0. Its tool summary did not establish a literal reviewer model ID; do not treat that status-only recheck as separately proven cross-model evidence.

## Owner's explicit decision

After presenting the scope and tradeoffs (including activity types, the provenance journal and unknown legacy links, manual recovery after corruption, possible Git inclusion of `.auto/` files, advisory-only recommendations and unreachable `evidence_bound` in v1), the `goal_question` tool displayed:

> Утверждаете этот пакет ТЗ с предлагаемыми вариантами по умолчанию и перечисленными ограничениями? Это согласование документации, не разрешение начинать реализацию.

The tool recorded the user's answer: **«Да, утвердить ТЗ»**. The answer approved the documentation and proposed defaults, not implementation. Approval metadata is recorded in commit `f845f8e`; specification commits are `3219163` and `b15abba`.

## Historical review limitation

The rev.4 design review returned FAIL with 12 findings. Only its summary was preserved in session `recall` entry `#224`, not the full itemized report. It identified missing comparison-context and attribution mechanisms for FR-04.1–04.3 and FR-05.1–05.2, no reader for `activity_type`, and the missing FR-06.3 direction-exhaustion criterion. Do not claim that all 12 historical items were individually reconstructed or individually closed. Later whole-package independent review assessed the current package and returned PASS as quoted above; that is distinct evidence, not recovery of the lost list.

## Verification and limits

`openspec validate --all` was rerun after approval metadata changes: 3 changes passed, 0 failed, with long-requirement warnings. This validates OpenSpec structure, not the correctness of an implementation. No implementation was started and the proposed acceptance tests T1–T154 were not run. Existing unrelated uncommitted repository files and `.beads/issues.jsonl` were not included in the specification commits.
