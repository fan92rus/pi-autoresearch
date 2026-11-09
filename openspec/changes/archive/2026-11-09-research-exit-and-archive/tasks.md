# Tasks: архив завершённых кампаний и выход из режима

## 1. Реализация (сделано, есть тесты)
- [x] 1.1 `research_brief draft` без закреплённого id переносит stopped-кампании в `.auto/research-archive/` (commit `65930dd`). Тест: `tests/research-archive-finished.test.mjs` 4/4 — доказано тестом.
- [x] 1.2 `research report` stopped-кампании: `report.md` записывается, затем режим выключается, OFF пишется в журнал, id сбрасывается, уведомление (commit `99f8dae`). Тест: `tests/research-auto-exit.test.mjs` 3/3 — доказано тестом.
- [x] 1.3 `stop` режим не выключает; текст ответа направляет на `report`. Тест: `research-auto-exit.test.mjs` — доказано тестом.
- [x] 1.4 После выхода автопродолжения нет. Тест: `research-auto-exit.test.mjs` — доказано тестом.

## 2. Расхождения «код ≠ спека» (исправлено в этом пакете)
- [x] 2.1 Сбой записи `report.md`: режим остаётся включённым, отчёт говорит «Research mode stays ON»; повторный report после устранения причины выходит. Тест: `tests/research-exit-archive-fixes.test.mjs` «2.1» — доказано тестом (сбой имитируется каталогом `report.md`).
- [x] 2.2 Закреплённый новый id: draft архивирует stopped-кампании; при активной другой кампании отказывает и ничего не переносит. Тесты: «2.2» ×2 в `research-exit-archive-fixes.test.mjs` — доказано тестом.
- [x] 2.3 Голое `/autoresearch research <описание>` не отказывает при одной stopped-кампании; отказывает при briefing/research/нечитаемой (тексты: «is active or unreadable» / «Several campaigns exist»). Тесты: «2.3» ×2 — доказано тестом.
- [x] 2.4 Порядок: бриф проверяется до переноса (невалидный бриф ничего не переносит). Тест: «invalid brief draft archives nothing» — доказано тестом.
- [x] 2.5 Строка про архив и выход добавлена в `docs/research-vectors.md` (раздел «Finished campaigns and leaving research mode»). Проверено чтением.

## 3. Открыто
- [x] 3.1 Установленная копия расширения синхронизирована с `origin/master` (fast-forward до `6d0a124`); тесты `research-exit-archive-fixes` 6/6 и `research-auto-exit` 3/3 зелёные. Перезапуск pi — за владельцем.
- [x] 3.2 Согласие владельца на текст спеки получено (2026-11-09, «согласен»). Спека заморожена: дальше только новым проходом цикла.
- [ ] 3.3 `openspec archive` для этого изменения упрётся в то, что `openspec/specs/` пуст (MODIFIED нужна базовая спека). Общая проблема всех изменений проекта, решается отдельно.
- [x] 3.4 Полный серийный гейт: все 74 `tests/*.test.mjs` по одному файлу, rc=0 (74/74); research-суиты отдельно зелёные; `openspec validate --all` 11/0.
