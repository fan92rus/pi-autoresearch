# headless-launch Specification

## ADDED Requirements

### Requirement: RPC-обёртка для headless-запуска кампаний

Система SHALL предоставлять скрипт `scripts/research-rpc.mjs`, который запускает
`pi --mode rpc` в указанном каталоге, отправляет kickoff-сообщение для выбранного
вида кампании (`research` или `optimize`) и обслуживает запросы extension UI
(`extension_ui_request`) от Pi, записывая полный JSONL-лог сессии в файл.
Скрипт SHALL отправлять kickoff только после observable-подтверждения активации
autoresearch-режима (первый `agent_end`/`agent_settled` после `/autoresearch on`).

#### Scenario: Запуск research-кампании headless
- **WHEN** оператор вызывает скрипт с `--mode research --brief <файл>` и верным
  `--approve-sha`
- **THEN** агент выполняет `research_brief draft` → `propose` → `research start`
  → открытие вопросов; confirm-диалог брифа подтверждается скриптом автоматически
  при совпадении SHA-256; в логе tool-вызовы research_brief не отклоняются
  с «Autoresearch mode is OFF» (kickoff обработан после активации режима).

#### Scenario: Чужой хеш отклоняется
- **WHEN** confirm-диалог содержит хеш, не совпадающий с `--approve-sha`
- **THEN** скрипт отвечает `confirmed: false`, approval не записывается,
  кампания остаётся в фазе briefing; в логе зафиксировано расхождение хешей.

### Requirement: Трёхсторонняя сверка хеша брифа

Auto-approve MUST подтверждать только те confirm-диалоги, где выполняются все
условия: метод `confirm`; в сообщении присутствует `Brief SHA-256: <hex>`;
`<hex>` совпадает с хешем, зафиксированным оператором (`--approve-sha`);
и `<hex>` совпадает с SHA-256 файла `--brief`, посчитанным скриптом при старте.

#### Scenario: Файл брифа изменён после kickoff
- **WHEN** файл `--brief` изменён после старта скрипта, и хеш в диалоге
  отличается от хеша файла, посчитанного при старте
- **THEN** скрипт отвечает `confirmed: false`, завершает сессию с ненулевым
  кодом, и агент не получает подтверждения расходящегося брифа.

#### Scenario: Диалоговый хеш совпал
- **WHEN** все три хеша совпали (операторский, диалоговый, файловый)
- **THEN** скрипт отвечает `confirmed: true`, approval записан, кампания
  переходит к `research start`.

### Requirement: Отклонение не-брифовых диалогов

Любой confirm без `Brief SHA-256:` в сообщении MUST отклоняться по умолчанию
(`confirmed: false`) с записью события в лог. Поведение TUI
(`ctx.ui.confirm === true` как единственный сигнал) не меняется.

#### Scenario: Не-брифовый диалог не подтверждается
- **WHEN** расширение эмитит confirm, не содержащий строку `Brief SHA-256:`
- **THEN** скрипт отвечает `confirmed: false` и пишет событие в лог.

### Requirement: Таймаут сессии с незакрытым диалогом

По достижении `--timeout-sec` при незакрытом `extension_ui_request` скрипт
MUST ответить `confirmed: false` (или `cancelled: true`), инициировать
завершение процесса pi, дождаться его выхода (принудительный kill после 10 с)
и выйти с ненулевым кодом, записав причину `timeout` в лог. Кампания остаётся
в текущей фазе; состояние на диске не повреждается.

#### Scenario: Висящий confirm при таймауте
- **WHEN** `--timeout-sec` истёк при незакрытом confirm
- **THEN** скрипт ответил `confirmed: false`, процесс pi завершён, код выхода
  ненулевой, в логе причина `timeout`; кампания в своей фазе на диске.

### Requirement: Kickoff для research-кампании не использует metric-loop skill

Команда `/autoresearch research` (точное слово `research` или префикс `research `)
MUST активировать autoresearch-режим и отправить research-kickoff (последовательность
research_brief/research), НЕ отправляя `/skill:autoresearch-create` и не предписывая
run_experiment/log_experiment.

#### Scenario: Активация research-режима
- **WHEN** оператор вызывает `/autoresearch research` (в TUI или через обёртку)
- **THEN** режим включён, отправленное сообщение описывает research-последовательность
  и не содержит `/skill:autoresearch-create`.

### Requirement: Зарезервированное слово research в парсере /autoresearch

Парсер `/autoresearch` MUST распознавать `research` (точное слово или префикс
`research `) как зарезервированное слово research-кампании; свободный текст
после него является описанием кампании. Free-text цель optimize, начинающаяся
с этих форм, в print-/RPC-запуске задаётся только через обёртку
(`--mode optimize`); ограничение документируется.

#### Scenario: Свободная цель с префиксом research
- **WHEN** оператор вызывает `/autoresearch research something`
- **THEN** это интерпретируется как research-кампания с описанием `something`
  (зарезервированное слово), а не как optimize-цель.

### Requirement: Оптимизационный запуск headless

Скрипт SHALL поддерживать `--mode optimize "<goal>"`: отправка `/autoresearch <goal>`
без требования интерактивного UI; неизвестные диалоги отклоняются с записью в лог.
Отклонение диалога может остановить цикл — это документированное поведение, а не
сбой; гарантия успешного завершения цикла при появлении диалога не даётся.

#### Scenario: Обычный цикл без UI
- **WHEN** скрипт запущен с `--mode optimize` и целью
- **THEN** агент выполняет init/run/log цикл headless; леджер `.auto/log.jsonl`
  наполняется; если расширение запросит confirm — скрипт отвечает `false` и логирует.

### Requirement: Headless-запуск не является песочницей briefing-фазы

Документация headless-запуска MUST повторять принятую границу: briefing-фаза
research-кампании не блокирует ordinary loop и shell (git-блок включается только
в фазе research); перехват команд Pi — best-effort, не песочница ОС.

#### Scenario: Документирование границы
- **WHEN** docs headless-запуска описывают research-режим
- **THEN** в них указано, что до `research start` git не блокируется и запуск
  обёртки не создаёт изоляции.
