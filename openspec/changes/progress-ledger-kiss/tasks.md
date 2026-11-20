# Tasks — rev.3

Статус: Draft after two review rounds. Реализация не начата.

## 1. Domain field

- [ ] 1.1 Add `domain` to new defect-ledger rows.
- [ ] 1.2 Treat missing `domain` as `product`.
- [ ] 1.3 Add focused test for legacy row handling.

## 2. Reporting

- [ ] 2.1 Count valid kept rows by domain.
- [ ] 2.2 Add `Product defects fixed` and `Harness defects fixed` to report.
- [ ] 2.3 Verify discarded and invalid rows are excluded.

## 3. No metric change

- [ ] 3.1 Verify `hardening_score_v2` output is unchanged.
- [ ] 3.2 Verify no measurement change is required.

## 4. Verification

- [ ] 4.1 Run focused tests with explicit timeout.
- [ ] 4.2 Run full suite through registered benchmark runner.
- [ ] 4.3 Run `openspec validate --all`.
