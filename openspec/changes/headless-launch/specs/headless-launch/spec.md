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
- **THEN** скрипт отвечает `confirmed: false`, approval не записывается;
  сессия завершается с ненулевым кодом до дальнейших шагов агента; в логе
  зафиксировано расхождение хешей; кампания остаётся в фазе briefing.

### Requirement: Research-режим требует бриф

`--mode research` MUST требовать `--brief` и `--approve-sha`: без файла брифа
или зафиксированного хеша скрипт MUST завершаться с ошибкой аргументов до
спавна pi (research-кампания без зафиксированного брифа не запускается).

#### Scenario: Запуск без брифа
- **WHEN** скрипт вызван с `--mode research` без `--brief` или без
  `--approve-sha`
- **THEN** скрипт завершается с ошибкой аргументов и ненулевым кодом;
  процесс pi не запускается.

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
(`confirmed: false`) с записью события в лог. Поведение TUI-диалогов инструментов
(`ctx.ui.confirm === true` как единственный сигнал согласия) не меняется.

#### Scenario: Не-брифовый диалог не подтверждается
- **WHEN** расширение эмитит confirm, не содержащий строку `Brief SHA-256:`
- **THEN** скрипт отвечает `confirmed: false` и пишет событие в лог.

### Requirement: Таймаут сессии с незакрытым диалогом

По достижении `--timeout-sec` при незакрытом `extension_ui_request` скрипт
MUST ответить `confirmed: false` (или `cancelled: true`), инициировать
завершение процесса pi, дождаться его выхода (принудительный kill после 10 с)
и выйти с кодом 3, записав причину `timeout` в лог. Кампания остаётся
в текущей фазе; состояние на диске не повреждается.

#### Scenario: Висящий confirm при таймауте
- **WHEN** `--timeout-sec` истёк при незакрытом confirm
- **THEN** скрипт ответил `confirmed: false`, процесс pi завершён, код выхода 3,
  в логе причина `timeout`; кампания в своей фазе на диске.

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
после него является описанием кампании. Это поведение вводится И в TUI, и в
headless (осознанное изменение TUI-поведения, решение владельца); цель
optimize со словом `research` остаётся выразимой через новый явный алиас
`/autoresearch optimize <goal>` (синтаксический сахар над существующим
free-text потоком).

#### Scenario: Свободная цель с префиксом research
- **WHEN** оператор вызывает `/autoresearch research something`
- **THEN** это интерпретируется как research-кампания с описанием `something`
  (зарезервированное слово), а не как optimize-цель.

#### Scenario: Алиас optimize сохраняет выразимость целей
- **WHEN** оператор вызывает `/autoresearch optimize research habits`
- **THEN** отправляется metric-loop kickoff с целью «research habits»
  (алиас работает, цель не превращается в research-кампанию).

### Requirement: Draft для headless-одобрения берётся из зафиксированного файла

Kickoff research-режима MUST инструктировать агента создать `research_brief draft`
из содержимого файла `--brief` (объект из его JSON), так чтобы одобряемый draft
совпадал по байтам с файлом, чей SHA-256 зафиксирован оператором.

#### Scenario: Handoff брифа в draft
- **WHEN** агент получает research-kickoff с путём к `--brief`
- **THEN** вызов `research_brief draft` использует объект из этого файла,
  и бриф, показанный в propose-диалоге, совпадает с зафиксированным хешем.

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
