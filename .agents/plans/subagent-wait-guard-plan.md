# План: анти-зацикливание при ожидании субагента (перенос паттерна pi-goal-x)

## Проблема

Когда автаресёрч-агент запускает субагента (например, ревьюера) через асинхронный
`subagent`-вызов, он может не дождаться его результата, а начать действовать:
задавать пустые ходы («жду агента…»), повторять шаги, дёргать `tree_status`,
или закончить ход с ответом «waiting». На фоне `agent_end`-механики
(drift-resume) это выливается в цикл пустых ходов: drift-resume пинает агента,
агент снова ничего не делает, счётчик drift растёт, ходы сгорают.

В `D:\Documents\Repositories\goal-x\pi-goal-x` эта проблема решена коммитом
`0449563 fix: defer goal continuations while async subagents run`. Там механика
другая (goal-continuation вместо autoresearch agent_end), но паттерн двусоставный
и переносим:

## Как решено в pi-goal-x (анализ)

1. **Промпт-слой (поведенческая инструкция).** В фиксированный policy-блок
   промпта добавлена строка: «долгий async-субагент в полёте и нечего полезного
   делать — держи ход открытым через `bg_wait` (перевзводи `bg_wait` по
   таймауту) вместо того, чтобы заканчивать ход ответом "waiting"». Тест
   проверяет наличие строки и её вариантов.

2. **Механический слой (guard в планировщике).**
   - `goal-subagent-probe.ts`: RPC-проба `subagents:rpc:v1:request` метода
     `status` → `data.fleet.totalActive` (окно 250 мс; нет ответа → fail-open).
   - В `schedule()` перед доставкой continuation: если `phase=ready` и есть
     живые async-субагенты — доставка откладывается (re-check каждые 30 с),
     с предохранителем 10 минут (fuse): даже зависший субагент не блокирует
     навсегда.
   - Событие `subagent:async-complete` снимает отсрочку и продолжает немедленно.
   - Guard взводится только после `subagents:rpc:v1:ready` (pi-subagents реально
     загружен); при его отсутствии — fail-open (поведение как раньше).
   - Тесты: fake-RPC-ответчик, проверка отсрочки, fuse, resume по завершению.

## Текущее состояние pi-autoresearch

- `agent_end` (index.ts ~3118): drift-policy уже ограничивает цикл
  (`MAX_CONSECUTIVE_DRIFT_RESUMES = 2`), но сама причина цикла — ходы без
  полезной работы во время ожидания субагента — не устранена: partial-cycle и
  drift-пины продолжают тратить ходы.
- Промпт «## Autoresearch Mode» (~7200/7300 символов): строки про `bg_wait` нет.
- pi-subagents RPC (`subagents:rpc:v1:*`) доступен вpi.events (документировано
  в docs/TZ.md §0.3), но расширение его для этой задачи не использует.
- `council-delegation.ts` уже слушает события ответов субагентов — паттерн
  работы с event bus в репозитории есть.

## План изменений (MVP)

### 1. Промпт-слой

- Файл: `extensions/pi-autoresearch/index.ts`, блок «## Autoresearch Mode».
- Добавить одну строку (кратко, в стиле существующих):
  «Async subagent in flight (review, delegation)? Hold the turn open with
  bg_wait (re-arm on timeout) instead of ending the turn with a "waiting"
  reply — empty turns burn drift-resume allowance. Your message still
  interrupts the wait.»
- Ограничение: следить за бюджетом секции 7300 (`tests/loop-finding-routes.test.mjs`);
  сейчас 7200 — одна строка ~200–250 символов укладывается, при превышении —
  ужать другую строку, а не поднимать бюджет без согласования.

### 2. Механический слой: defer resume при живых async-субагентах

- Новый модуль `extensions/pi-autoresearch/subagent-probe.ts` — порт
  `goal-subagent-probe.ts` (та же RPC-проба, то же fail-open, окно 250 мс).
  Никакой логики поверх: только «сколько живых async-run».
- В `agent_end` (index.ts ~3118) перед drift/partial-cycle ветвями:
  - если pi-subagents активен (видели `subagents:rpc:v1:ready`) и проба
    показывает `active > 0` — **не** отправлять drift-resume и не пинать:
    ход завершился без работы цикла только потому, что агент ждёт субагента;
    отложить nudge, перепробовать по завершению субагента или по таймеру.
  - Предохранитель (fuse) 10 минут: дольше — доставить nudge как обычно
    (субагент завис/умер тихо).
  - Событие `subagent:async-complete` → немедленно продолжить отложенный nudge.
  - Fail-open: pi-subagents не загружен → поведение ровно как сейчас.
- Не трогать: partial-cycle path при `lastTurnUsedExperimentTools` (это реальная
  работа), счетчики drift, кампании, механику keep/discard.

### 3. Тесты

- Новый `tests/subagent-wait-guard.test.mjs` (по образцу
  `goal-scheduler-subagent-guard.test.ts`):
  - fake-RPC-ответчик в fake-pi с управляемым `totalActive`;
  - агент в autoresearch-режиме, ход без loop-работы, `totalActive=1` →
    drift-resume НЕ отправляется (нет pending resume);
  - `subagent:async-complete` → nudge доставлен;
  - fuse: держим `totalActive=1` дольше fuse-окна (инжект времени/короткий fuse
    в тесте) → nudge доставлен вопреки живой пробе;
  - pi-subagents отсутствует (нет ответа RPC) → поведение без изменений
    (fail-open);
  - промпт содержит строку про `bg_wait` (вариант теста goal-prompts).
- Прогон: файл + `tests/loop-finding-routes.test.mjs` (бюджет секции) +
  `tests/agent-guidance.test.mjs` при наличии.

### 4. Документация

- `README.md`: одна строка в таблице поведения цикла: при живом async-субагенте
  extension откладывает nudge; агент держит ход через `bg_wait`.
- В скоуп не входит: изменение goal-механики, механики drift-лимитов,
  кампании, исследования в других режимах.

## Риски / компромиссы

- Проба RPC асинхронна и с окном 250 мс — это синхронная задержка в `agent_end`;
  в pi-goal-x она сочтена приемлемой. При отсутствии pi-subagents — fail-open
  без задержки выше окна.
- `subagent:async-complete` — событие pi-subagents; если мост умер, событие не
  придёт — оттого и fuse 10 минут.
- Промпт-бюджет: строка должна быть краткой; контроль тестом.
- Событийная гонка «субагент завершился между пробой и решением» закрывается
  re-check по событию и fuse; идеальная точность не требуется — достаточно
  отсечь массовый спам пустых ходов.

## Открытый вопрос владельцу (один)

Fuse 10 минут и re-check 30 секунд — значения из pi-goal-x. Оставить как есть
или настроить под типичный ревью-субагент (3–15 минут)?
