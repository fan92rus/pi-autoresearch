# Requirements — rev.3

## FR-1: Домен дефекта

Строки `.auto/defect-ledger.jsonl` должны поддерживать поле `domain` со значениями `product` и `harness`.

### Scenario: legacy row

GIVEN строка без поля `domain`  
WHEN система читает ledger  
THEN строка считается `product`.

## FR-2: Видимость баланса

Отчёт должен показывать отдельные счётчики product и harness defects.

### Scenario: смещение в harness

GIVEN campaign с 18 product и 9 harness defects  
WHEN строится отчёт  
THEN оба счётчика видны владельцу.

## FR-3: Не меняем scoring

Primary metric `hardening_score_v2` должна остаться прежней.

### Scenario: та же campaign

GIVEN те же строки ledger и тот же test run  
WHEN добавляется reporting по domain  
THEN `hardening_score_v2` не меняется.

## FR-4: Валидность строк

Только валидные keep-строки попадают в счётчики.

### Scenario: discard row

GIVEN строка со `status:"discard"`  
WHEN строится отчёт  
THEN она не попадает ни в product, ни в harness counter.

## Decisions

- D-1: Не создавать новый ledger.
- D-2: Не создавать новый score.
- D-3: Не менять веса и штрафы scorer.
- D-4: Legacy rows без `domain` считать product.
- D-5: Баланс показывает владелец, движок автоматически не.block’ирует.

## Open questions

- Q-1: Where exactly in report to show counters.
- Q-2: Should `observability` be separate from `harness` later?
