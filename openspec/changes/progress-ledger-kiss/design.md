# Design — rev.3

## Overview

Изменение только добавляет видимость. Ни scoring, ни runner, ни epoch не меняются.

## Data model

В `.auto/defect-ledger.jsonl` добавляется поле:

```json
{
  "id": "...",
  "severity": "P1",
  "domain": "product",
  "status": "keep",
  "mutation_red": true,
  "guard_restored": true
}
```

Значения:

- `product` — дефект системы или тестов;
- `harness` — дефект измерителя, scorer, ledger-accounting;
- отсутствие поля — legacy, считается `product`.

## Reporting

В отчёте появляются две строки:

```text
Product defects fixed: 18
Harness defects fixed: 9
```

Счётчики считаются по валидным keep-строкам:

```text
status == keep && mutation_red == true && guard_restored == true
```

## Scoring

Не меняется. Текущая формула `hardening_score_v2` остаётся прежней.

## Why this is KISS

- 1 новое поле;
- 2 счётчика в отчёте;
- 0 изменений scoring;
- 0 measurement change;
- 0 новых runner/ledger/profile/engine.

## Validation

- legacy row без `domain` считается product;
- discard-строка не попадает ни в один счётчик;
- invalid proof не попадает ни в один счётчик;
- старые primary metrics остаются прежними.

## Tests

- строка без `domain` попадает в product counter;
- `harness` row попадает в harness counter;
- `discard` row не попадает ни в один counter;
- scorer formula unchanged.
