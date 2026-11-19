# Worker plan: fix 5 review minors, then commit (issue pi-autoresearch-iky.4.3)

Task: M-a..M-e from the verification review, gates, commit, push, bd close.

## State
- Baseline research-map-tools: 26 pass / 0 fail. Target: 29 pass / 0 fail (+3 tests).
- Spec finding for M-a (§5.2 + §12.4/§12.4a): torn = non-empty line where
  parseJsonlEntry gives no object — the spec does NOT distinguish an
  unterminated fragment from a complete-but-invalid line; both are torn →
  any unknown → no hint. Existing `ledgerTailTorn()` already implements the
  §5.2 definition; it must also be applied to the PRE-append state.
- §8.2 note enum is closed: not_provided | invalid_ref | non_local_ref |
  denied_by_policy. M-e: keep note:"not_provided" for the conflict case in
  stored-facing schema terms; add view-only `conflict: "passport_conflict"`
  key; record as open question (spec does not define this view key).

## Steps
- [x] Read review artifact, spec §12.4/§12.4a/§5.2/§8.2, code, tests.
- [x] M-a: torn flag on researchMapPreState + early return in researchMapLogHint; +2 tests.
- [x] M-b: +1 S_ser test per T155(b)/E-26 (baseline counts as improvement 1 per trailingBestImprovements; fires at 3rd keep).
- [x] M-c: rewrote no-overwrite test with frozen-Date same-stamp collision; asserts -2 + byte-identical first doc.
- [x] M-d: details.hint = full merged line (leading \n + 💡 …); merged test asserts byte-identity + second cause.
- [x] M-e: conflict case → note:"not_provided" + view-only conflict:"passport_conflict"; render unchanged text via conflict ?? note; tests updated.
- [x] Gates: research-map-tools 29/29; smoke 1/1 exit 0; activity-label 13; run-links-wiring 11; run-links 56; research-journal 35; research-observations 44; research-analysis 47; exhaustion-hints 46. ALL GREEN.
- [ ] Commit exactly 4 staged files; push origin master; bd close pi-autoresearch-iky.4.3 with comment.

## Notes
- Spec (§5.2) does NOT distinguish unterminated fragment vs complete-but-invalid
  line: both are torn ("non-empty line parseJsonlEntry gives no object") → both
  suppress hints. Implemented exactly that; 2 tests cover both damage modes.
- OPEN QUESTION for spec owner: §8.2 does not define the view-only
  `conflict:"passport_conflict"` response key (note enum is closed).
- details.hint semantic: full appended line including leading "\n💡" (verified
  byte-identical against the text line in the merged-hint test).
