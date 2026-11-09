# Tasks

## 1. Промпт-слой

- [x] 1.1 Добавить строку (~200 символов) про `bg_wait` в блок «## Autoresearch Mode»: существующие строки не ужимаются (решение владельца); бюджет `AUTORESEARCH_SECTION_MAX_CHARS` в `tests/loop-finding-routes.test.mjs` поднимается 7300 → 7500 (решение владельца, единственное изменение бюджета); проверка наличия строки в `tests/agent-guidance.test.mjs`, новый бюджет — обновлённый тест в `tests/loop-finding-routes.test.mjs`; перед вставкой — свежий замер секции; если после вставки бюджет нарушается — стоп и запрос владельцу.

## 2. Проба и отсрочка

- [x] 2.1 Добавить `extensions/pi-autoresearch/subagent-probe.ts` (порт `goal-subagent-probe.ts`): RPC `status` → `fleet.totalActive`; окно 250 мс; неуспех, отсутствие fleet или нечисловой totalActive → `unknown` (fail-open); экспорт `SUBAGENT_DEFER_RECHECK_MS = 30_000`, `SUBAGENT_DEFER_FUSE_MS = 600_000`.
- [x] 2.2 Guard в `index.ts`: подписки на `subagents:rpc:v1:ready` и `subagent:async-complete` при загрузке; `ping` на `session_start` как второй путь взвода (поздняя загрузка; ping подтверждает только доступность RPC, решает проба); в drift-ветви `agent_end` (включая кампанные сообщения) — проверка пробой после проверки drift-лимита и stop-reason, до любых инкрементов; активные субагенты → отдельное runtime-поле отсрочки (не `pendingResumeMessage`), drift и auto-resume не растут в момент взвода; составление текста nudge переносится на доставку; re-probe по событию и таймеру 30 с, доставка только при нуле активных; при доставке — ровно один инкремент дрейфа и `markAutoResumeSent`, затем переоценка условий и существующие гейты; fuse 10 мин непрерывной отсрочки, сброс при любом снятии; reset при `agent_start`, `session_start`/`session_tree` (reconstructState), `session_before_compact`, `session_shutdown` (там же снятие подписок и таймеров), пользовательской паузе кампании, выключении режима; partial-cycle и plain resume не затронуты; тексты nudged прежние.

## 3. Тесты

- [x] 3.1 Новый `tests/subagent-wait-guard.test.mjs` с fake-RPC-ответчиком (`mock.timers` для fuse): живой субагент → nudge нет, счётчики дрейфа и auto-resume не растут; один из двух завершился → nudge нет; последний завершился → доставлен с ровно одним инкрементом счётчиков; повторная проба по таймеру 30 с (без события) → доставлена; fuse (инъекция времени) → доставлен вопреки живой пробе; ответ без fleet или ошибка RPC → доставка как прежде (fail-open); поздняя загрузка без ready, но с ping → guard взведён; guard не взведён (нет pi-subagents) → проба не выполняется, путь прежний; partial-cycle → отсрочка не применяется; отсрочка под кампанией → кампанный nudge отложен по тем же правилам; новый ход → отсрочка сброшена, чужой nudge не доставлен; сброс при компакции и паузе кампании; drift-лимит после окончания ожидания работает как раньше (порядок: MAX-проверка до пробы).
- [x] 3.2 Прогнать последовательно с явной командой (`node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test <файл>`): `subagent-wait-guard`, `agent-guidance`, `loop-finding-routes`, `smoke`; `openspec validate --all`; записать результаты (числа прогонов) в `openspec/changes/subagent-wait-guard/` (файл `VALIDATION.md`).

## Прогон (3.2, факт)

Команда: `node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test <файл>`.

- `tests/subagent-wait-guard.test.mjs` — 14 тестов: 13 pass, 1 skipped (fuse — реальное ожидание 10 мин; выполняется вручную с `RUN_FUSE_TEST=1`), 0 fail, ~54 c.
- `tests/agent-guidance.test.mjs` + `tests/loop-finding-routes.test.mjs` + `tests/smoke.test.mjs` (один прогон): 31/31.
- `tests/hypothesis-finding-links.test.mjs` (регресс соседнего change, общий index.ts): 11/11.
- `openspec validate --all`: 14 passed, 0 failed.

Примечание: fuse-сценарий (задача 3.1) реализован как skip-by-default тест с `RUN_FUSE_TEST=1`, т.к. его реальное ожидание (10+ мин) не помещается в обычный прогон; константы fuse и re-check закреплены отдельным тестом.
