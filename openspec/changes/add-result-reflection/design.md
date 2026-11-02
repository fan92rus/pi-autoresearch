# Design: add-result-reflection

## Context

pi-autoresearch — расширение pi, добавляющее цикл экспериментов (tools `run_experiment`/`log_experiment`/`propose_hypothesis`, леджер `.auto/log.jsonl`, дерево `.auto/tree.json`, observer-хуки, совет стагнации, finalize). Точки интеграции:

| Шов | Файл | Что там |
|---|---|---|
| Персистенция вывода | `index.ts` ~L2846 (`run_experiment`) | вывод обрезается, полный уходит в temp-файл ОС (`tmpdir` import L63) |
| Loop-промпт | `index.ts` ~L2376 | правила цикла, BENCHMARK_GUARDRAIL, путь `ideas/` |
| Observer | `observer.ts` (`checkReflection` L874, триггеры finalize/floor/stagnation) | тексты нуджей; конфиг `.auto/config.json` → `observer.*` |
| Бриф совета | `council.ts` (builder брифа), `council-delegation.ts` (challenge-раунды, validateSlate) | бриф — механический дайджест леджера |
| Леджер | `jsonl.ts` (`parseJsonlEntry`, `reconstructJsonlState`) | схема записей, реконструкция состояния |

Прецедент-мотивация: в lobprobe DPO-TA ручной разбор примеров по запросу владельца выявил кандидатов на проблемы измерителя; оценка масштаба требует независимой проверки. Совет также ранее предлагал аудит.

## Goals / Non-Goals

- **Goals**: замкнуть контур «результаты → находки → потребители» (совет, гипотезы, отчёт, владелец); легализовать самостоятельную коррекцию измерителя с полным учётом; сохранить обратную совместимость (старые кампании работают без новых файлов).
- **Non-Goals**: автоматический разбор ошибок кодом (чтение выполняет агент); доменная логика в расширении (FP/FN, таймеры — всё в конфиге кампании); принудительный блок созыва совета; owner-гейт на measurement-изменения (решение владельца 2026-11-02: самостоятельность агента); fresh-субагент на каждый checkpoint (дорого; независимость обеспечивают challenge-фаза и верификация находок).

## Decisions (согласованы с владельцем 2026-11-02)

1. **Читает главный агент кампании** — но «внимательность» механифицирована: сначала разбор каждого примера сэмпла (gold → pred → причина расхождения), потом обобщение; `record_finding` отвергает находки без конкретных примеров (механизм как metricProvenance-rejection для логов).
2. **Четыре темы находок** {measurement, behavior, capability, tradeoff} с фиксированными маршрутами; штамп ставит агент, оспаривание — challenge-фаза совета.
3. **Третий слой хранения** `.auto/findings.jsonl` — долговечное знание кампании (переживает revert'ы, потребляется советом и отчётом), в отличие от ASI (диагностика прогона в леджере) и `ideas/` (только гипотезы).
4. **Линза на стагнации обязательна с мягким маркером**: `lens: not done` в брифе, не блок. Жёсткий блок породил бы формальное отмахивание; отсутствие требования повторяет lobprobe.
5. **Конфиг `analysis:` в config-header** (задаётся при init, рядом с metric/run-командой): правила «что читать» — часть «как измеряем», mid-campaign правки не предполагаются. Невалидный regex — ошибка конфигурации, не молчание.
6. **Measurement-трек самостоятельный**: `log_measurement_change` без owner-гейта; обязательный учёт (дифф в `.auto/measurement/`, обе шкалы или `rescore_pending`, эпоха). Владелец ревьюит пост-фактум (леджер, отчёт). Это осознанное изменение политики против существующего предостережения против подгонки и обмана бенчмарка (`index.ts`, `BENCHMARK_GUARDRAIL`): граница с подгонкой = учёт (молчащее ослабление метрики в model-треке запрещено).
7. **Эпохи шкалы блокируют поперечные дельты** (не предупреждают): confidence score и best-сравнения молча смешали бы шкалы; старые числа никогда не переписываются.
8. **Порядок фаз**: линза+находки → measurement-трек → отчёт. Детектор важнее гейта: без находок measurement-треку нечего проводить.
9. **Независимая проверяемость measurement-изменений**: учёт не принимается на слово агенту — числа берутся из воспроизводимого рескор-артефакта (якорный набор + команды + обе оценки), запись `measurement_change` стартует с `needs_verification: true` и помечается предварительной до независимой проверки (challenge-фаза либо повторное чтение артефакта). Формат measurement-EXP: строка `TRACK: measurement` внутри секции + поля плана DIFF/RESCORE/JUSTIFY.

## Data Schemas

```jsonc
// .auto/runs/<n>/manifest.json — один файл на прогон
{ "run": 45, "output": "output.txt", "bytes": 51234, "sha16": "ab12…",
  "measurement_files": [{ "path": "eval/scorer.py", "sha16": "ab12…" }],
  "artifacts": [ { "declared": "eval.json", "copied": true, "bytes": 8192 },
                 { "declared": "trace.bin", "copied": false, "missing": false, "size_only": true } ] }

// .auto/findings.jsonl — append-only
{ "id": "f7", "run": 45, "theme": "measurement",
  "description": "Форм-варианты верных фактов штрафуются дважды (зампред vs заместитель…)",
  "evidence_ref": ".auto/runs/45/output.txt#MISMATCH gold=заместитель… pred=зампред… (строки 120-134)",
  "estimated_impact": "~14% всех ошибок", "status": "open",
  "needs_verification": true, "created": "2026-11-02T03:00:00Z" }

// .auto/measurement/e2/rescore.md — воспроизводимый рескор-артефакт (якорь + команды + обе оценки)
{ "anchor": "run 45 window dev366", "commands": ["python rescore.py --gold v15", "python rescore.py --gold v16"],
  "old_scale_score": 0.5598, "new_scale_score": 0.6383, "verified": false }

// запись леджера .auto/log.jsonl — новые поля
{ "type": "measurement_change", "epoch": 2, "diff_ref": ".auto/measurement/e2_gold_v16.diff",
  "rescore_ref": ".auto/measurement/e2/rescore.md", "justification": "finding f7",
  "old_scale_score": 0.5598, "new_scale_score": 0.6383, "needs_verification": true }
{ "type": "measurement_change_completed", "change_ref": "e2", "epoch": 2, "rescore_ref": ".auto/measurement/e2/rescore.json", "old_scale_score": 0.5598, "new_scale_score": 0.6383 }
{ "run": 46, "epoch": 2, … }   // все обычные записи несут эпоху (без поля = эпоха 1)
```

```jsonc
// config-header секция analysis
{ "analysis": {
    "artifacts": ["eval_output.json"],
    "measurement_files": ["eval/scorer.py", "eval/gold.json"],
    "extractors": { "failures": { "regex": "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", "sample": 10 },
                     "hotspots": { "timing_line": true, "top": 10 } },
    "copy_limit_mb": 32 } }
```

## Code Touch Points

1. `index.ts` run_experiment: писать `.auto/runs/<n>/output.txt` + копировать `analysis.artifacts` (лимит `copy_limit_mb`), манифест с хешами доступных `analysis.measurement_files`; путь полного вывода — в ответ инструмента. Необъявленные или недоступные компоненты означают неполный контроль.
2. `index.ts` регистрация tools: `inspect_results`, `record_finding`, `log_measurement_change`; команда `/autoresearch report`.
3. `index.ts` loop-промпт: правила тем/маршрутов + граница с подгонкой бенчмарка (короткие строки; основную нагрузку несут нуджи и валидации tool'ов).
4. `observer.ts`: пункт линзы в `checkReflection`; требование инспекции в stagnation-триггере; строка Measurement health в периодических сообщениях; подавление confidence при `rescore_pending`/устаревшем floor.
5. `council.ts`: builder брифа — секции «Open findings» и Measurement health + маркер `lens: not done`; `validateSlate` — measurement-EXP контракт.
6. `council-delegation.ts`: находки как вход challenge-раундов (флаг needs_verification подсвечивается).
7. `jsonl.ts`: поля `epoch`/`track` в parse/reconstruct; блокировка поперечных дельт в confidence/best-логике (плюс dashboard).
8. Новые модули: `lens.ts` (персистенция+экстракторы+inspect_results), `findings.ts` (store+валидация), `measurement.ts` (учёт+эпохи), `report.ts` (генератор отчёта).

## Risks / Trade-offs

- **Анализ-театр** (нуджи выполняются формально) → валидация доказательной базы в `record_finding`; маркер `lens: not done` в брифе виден аналитикам; находки без потребителя не проходят (критерий приёмки: бриф / гипотеза / owner-гейт).
- **Ложные срабатывания needs_verification** (regex на «0/N») → флаг консервативен: только подсветка в брифе/отчёте, без блокировок.
- **Раздувание `.auto/runs/`** → `copy_limit_mb` + size-only ссылки для крупных артефактов; манифест всегда полный.
- **Незнакомый домен без `analysis`** → generic-экстракторы (METRIC/error/timing/delta) дают полезный сэмпл в любом домене; деградация — сырые head/tail.
- **Самостоятельная коррекция измерителя** → учёт не принимается на слово: числа парсятся из воспроизводимого рескор-артефакта, запись стартует `needs_verification` с предварительной шкалой до независимой проверки; полный учёт (дифф, рескор, эпоха) + пост-фактум ревью владельцем в отчёте.
- **Совместимость** → все механизмы отключаются отсутствием файлов/секции; записи без `epoch` = эпоха 1; существующие тесты леджера/совета не должны менять поведение.

## Migration Plan

Ничего не мигрирует: `.auto/runs/` заполняется с новых прогонов; findings.jsonl создаётся при первой находке; эпоха по умолчанию 1 (записи без epoch = эпоха 1). Старые кампании (lobprobe) получают механизмы после перезапуска сессии с новым расширением.

## Open Questions

- Нужна ли отдельная slash-команда `/autoresearch lens` для ручного вызова инспекции (сейчас — только tool)? — решить на этапе apply.

Разрешённые ранее открытые вопросы: формат measurement-EXP зафиксирован — строка `TRACK: measurement` внутри секции + план DIFF/RESCORE/JUSTIFY (решение по итогам ревью 2026-11-02).
