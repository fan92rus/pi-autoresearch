# Validation (subagent-wait-guard)

Дата: 2026-11-09. Коммиты: 877f50e (соседний change, учтён в замерах бюджета),
c632166 (guard + промпт + тесты), 21febe2 (раунд-1 покрытие), ab9cdf9 (раунд-2 покрытие).

Команда прогона: `node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test <файл>`

## Результаты (3.2)

| Набор | Результат |
|---|---|
| `tests/subagent-wait-guard.test.mjs` | 23 теста: 22 pass, 1 skipped, 0 fail, ~104 c. Skipped — wall-clock fuse (`RUN_FUSE_TEST=1`); mock-вариант fuse исполняется в обычном прогоне (проверено reviewer'ом: ветка fuse достигается, порог мутацией ловится) |
| `tests/agent-guidance.test.mjs` | 18/18 (включая тест строки bg_wait, задача 1.1) |
| `tests/loop-finding-routes.test.mjs` | 12/12 (бюджет секции 7500, задача 1.1) |
| `tests/smoke.test.mjs` | 1/1 |
| `tests/hypothesis-finding-links.test.mjs` (регресс общего index.ts) | 11/11 |
| `openspec validate --all` | 14 passed, 0 failed |

## Независимое ревью (claude-haiku-5-5)

- Раунд 1 (0e3db7f5): НЕ ГОДЕН по test evidence — мутации M3/M5/M6/M7/M9/FUSE выживали, campaign-тест вакуумный. Fix: 21febe2.
- Раунд 2 (cd5b9266): НЕ ГОДЕН — M6/M7a/M9 выживали, shutdown-тест короткое окно. Fix: ab9cdf9.
- Раунд 3 (9de5e050): ГОДЕН. M9 и M7a пойманы своими тестами (прогон мутанта валит ровно целевой тест), база 22 pass / 1 skipped / 0 fail, регресс agent-guidance 18/18.

## Известные остаточные (приняты владельцем)

- M6 — эквивалентный мутант: доставка при mode off отсекается проверкой `autoresearchMode` в `deliverDeferredDriftNudge`, поэтому тест сброса не отличает «сброс» от «отказа доставки».
- M4 (session_tree) и M9b (unsubscribe) — покрыты семантически (reset-тест session_tree + shutdown-тест с окном re-check), прямых мутаций не прогоняли.
- Wall-clock fuse-тест — ручной (`RUN_FUSE_TEST=1`), в CI-прогоне не исполняется;(mock-вариант — исполняется).
- Probe — сессионная грубость MVP: считает все async-run сессии, не только «наши» субагенты.
