# Proposal — rev.3

## Why

Первая ревизия предлагала новый `progress.jsonl`, вторая — менять веса scorer. Ревью показали, что и то, и другое лишнее.

Дефект в измерителе — тоже дефект. Проблема не в том, что scorer-фиксы получают credit, а в том, что **не видно баланса**: campaign может незаметно сместиться от продукта к бесконечной защите измерителя.

Минимальное решение: добавить к дефектам метку домена и показывать баланс в отчёте. Саму метрику не трогать.

## What Changes

- В новые строки `.auto/defect-ledger.jsonl` добавляется поле `domain`: `product` или `harness`.
- Старые строки без `domain` считаются `product`.
- Scoring **не меняется**.
- В отчёт добавляются два счётчика:
  - product defects fixed;
  - harness defects fixed.
- Measurement change не нужен, потому что primary metric остаётся прежней.

## Capabilities

### New Capabilities

- `defect-domain-reporting`: домен дефекта и видимость баланса product/harness.

## Impact

- `.auto/defect-ledger.jsonl`: новое поле `domain` в новых строках.
- Reporting layer: две строки счётчиков.
- Тесты:legacy rows без `domain`; счётчики product/harness; неизменность primary metric.

## Out of scope

- Изменение весов scorer.
- Новый `progress.jsonl`.
- Новый `progress_score`.
- Measurement change, rescore, новый epoch.
- Skill, Profiles, DSL, Campaign Engine.
- Любая автоматическая блокировка campaign из-за баланса доменов.
