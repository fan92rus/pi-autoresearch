# headless-launch Specification

## Purpose
Запуск исследовательской кампании без интерактивной сессии: RPC-обёртка, порядок стадий, согласие по хешу брифа, коды выхода и наблюдаемое завершение.

## Requirements

### Requirement: RPC-обёртка для headless-запуска кампаний

Система SHALL предоставлять скрипт `scripts/research-rpc.mjs`, который запускает
`pi --mode rpc` в указанном каталоге и обслуживает запросы extension UI
(`extension_ui_request`) от Pi, записывая полный JSONL-лог сессии в файл.
Активация кампании SHALL выполняться одним сообщением: `/autoresearch research`.

#### Scenario: Запуск research-кампании headless
- **WHEN** оператор вызывает скрипт с `--mode research --brief <канонический файл>
  --approve-sha <sha>` и хеш верен
- **THEN** агент выполняет `research_brief draft` → `propose` → `research start`
  → открытие вопросов; confirm брифа подтверждается автоматически; в логе нет
  отказов «Autoresearch mode is OFF» и нет `/skill:autoresearch-create`.

### Requirement: Sequencing stage 1 → stage 2

Два таймера: (а) `agent_start` MUST наступить за `--stage1-timeout-sec`
(по умолчанию 30) от отправки stage-1; иначе отказ — exit 2; (б) `agent_settled`
ограничен общим `--timeout-sec` (exit 3). Stage 2 — только после `agent_settled`.

#### Scenario: Sequencing stage 1 → stage 2
- **WHEN** stage-1 сообщение отправлено, ответ `handled` и `agent_start` могут
  прийти в любом порядке; пришёл `agent_start` и завершился `agent_settled`
- **THEN** stage 2 отправлена после этого `agent_settled`.

#### Scenario: Stage 1 отказала (нет agent_start за дедлайн)
- **WHEN** `agent_start` не наступил за `--stage1-timeout-sec` от отправки
- **THEN** обёртка завершается с кодом 2, причина в логе (кампания не создана).

#### Scenario: Медленный kickoff-ход не даёт ложный отказ
- **WHEN** `agent_start` пришёл вовремя, но `agent_settled` длится дольше 30 с
- **THEN** exit 2 не ставится; действует общий `--timeout-sec` (exit 3).

### Requirement: Отправка stage 2 и её протокольные ошибки

Stage 2 MUST отправляться только после `agent_settled` stage-1. Ответ
`queued`/`success:false` на stage-2 prompt (отправка во время стриминга —
не должен происходить при верном sequencing) — ошибка обёртки (exit 1),
причина в логе.

#### Scenario: Stage 2 при стриминге
- **WHEN** stage-2 prompt отправлен во время стриминга и вернулся `queued` или
  `success:false`
- **THEN** ошибка обёртки: exit 1, причина в логе.

### Requirement: Research-режим требует канонический бриф и хеш

`--mode research` MUST требовать `--brief` и `--approve-sha`; без них — ошибка
аргументов (exit 2) до спавна pi. Файл `--brief` MUST быть в канонической форме
`JSON.stringify(JSON.parse(bytes), null, 2) + "\n"`; неканонический файл, непарсируемый
JSON (включая пустой файл и BOM), отсутствующий файл, а также `--approve-sha` не
по маске `^[0-9a-f]{64}$` или `--campaign-id` не по маске
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — отказ (exit 2) до спавна pi.

#### Scenario: Запуск без брифа
- **WHEN** скрипт вызван с `--mode research` без `--brief` или без `--approve-sha`
- **THEN** завершение с ошибкой аргументов (exit 2); pi не запускается.

#### Scenario: Неканонический или непарсируемый бриф
- **WHEN** байты `--brief` не равны канонической форме, или файл отсутствует, или
  JSON не парсится (пустой файл, BOM)
- **THEN** завершение с ошибкой (exit 2) до спавна pi.

#### Scenario: Невалидный approve-sha или campaign-id
- **WHEN** `--approve-sha` не по `^[0-9a-f]{64}$` или `--campaign-id` не по
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
- **THEN** завершение с ошибкой (exit 2) до спавна pi.

#### Scenario: Stage 2 при стриминге
- **WHEN** stage-2 prompt отправлен во время стриминга (не должен происходить
  при верном sequencing) и вернулся `queued` или `success:false`
- **THEN** ошибка обёртки: exit 1, причина в логе.

### Requirement: Коды выхода

Скрипт SHALL использовать: 0 — успех (наблюдаемое завершение, см.
«Успешное завершение наблюдаемо»); 1 — отказ по хешу брифа (abort сессии) ИЛИ
протокольная/sequencing-ошибка обёртки (stage-2 при стриминге); 2 — ошибки
аргументов и отказ guard-а/stage-1 (нет `agent_start` за дедлайн); 3 — таймаут
(общий `--timeout-sec`, по умолчанию 3600; включая `agent_settled` без
наблюдаемого успеха).

#### Scenario: Код для отказа по хешу
- **WHEN** сработал отказ по хешу
- **THEN** код выхода 1 (не 0 и не 3).

#### Scenario: Код для протокольной ошибки stage 2
- **WHEN** stage-2 prompt вернул `queued`/`success:false`
- **THEN** код выхода 1, причина в логе.

#### Scenario: Settled без наблюдаемого успеха
- **WHEN** `agent_settled` наступил, но наблюдаемый успех не зафиксирован
  (research без успешного report)
- **THEN** обёртка ждёт до общего таймаута, затем exit 3 (а не 0).

### Requirement: Успешное завершение наблюдаемо

Exit 0 SHALL ставиться при наблюдении `tool_execution_start` (toolName=research,
args.action=report) + `tool_execution_end` того же call с `isError !== true` и пустым
`details.reason` (research-отказы возвращают fail()-результаты без isError —
пустой reason обязателен).

#### Scenario: Research exit 0
- **WHEN** зафиксированы `tool_execution_start` (research, action=report) и
  соответствующий `tool_execution_end` без isError
- **THEN** после `agent_settled` скрипт выходит с кодом 0.

#### Scenario: Отказавший report не даёт exit 0
- **WHEN** research report отклонён (mode OFF, not_approved — отказ без isError,
  с details.reason)
- **THEN** exit 0 не ставится; сессия завершается по таймауту (exit 3).

#### Scenario: Stage 2 при стриминге
- **WHEN** stage-2 prompt отправлен во время стриминга (не должен происходить
  при верном sequencing) и вернулся `queued` или `success:false`
- **THEN** ошибка обёртки: exit 1, причина в логе.

### Requirement: Запрет legacy-команд активации

Скрипт MUST НЕ отправлять `/autoresearch on` и `/skill:autoresearch-create`.

#### Scenario: Ни одна отправка не содержит legacy-команд
- **WHEN** обёртка отработала любой режим
- **THEN** в логе отправленных сообщений нет `/autoresearch on` и
  `/skill:autoresearch-create`.

### Requirement: Трёхсторонняя сверка хеша в момент диалога

При ответе на propose-confirm скрипт MUST сверить три хеша: из текста диалога
(regex `^Brief SHA-256: ([0-9a-f]{64})` на message), зафиксированный
оператором (`--approve-sha`) и пересчитанный из файла `--brief` в этот момент.
Совпадение всех трёх — `confirmed: true`; любое несовпадение — `confirmed: false`
и немедленная RPC-команда abort процессу pi. Тестовая опция `--hold-dialog-ms <n>`
(по умолчанию 0) задерживает ответ на диалог для теста мутации файла.

#### Scenario: Файл брифа изменён при висящем диалоге
- **WHEN** файл `--brief` изменён после kickoff, и диалог ещё открыт
- **THEN** при ответе файловый хеш не совпадёт с диалоговым: `confirmed: false`,
  abort, exit 1; в логе нет research-вызовов после отказа.

#### Scenario: Чужой операторский хеш
- **WHEN** диалоговый хеш не совпадает с `--approve-sha`
- **THEN** `confirmed: false`, abort, exit 1; approval не записан; кампания
  остаётся в фазе briefing.

#### Scenario: Диалоговый хеш совпал
- **WHEN** все три хеша совпали (операторский, диалоговый, файловый)
- **THEN** `confirmed: true`, approval записан, кампания переходит к
  `research start`.

#### Scenario: Не-брифовый диалог не подтверждается
- **WHEN** расширение эмитит confirm без строки `Brief SHA-256:`
- **THEN** скрипт отвечает `confirmed: false` и пишет событие в лог.

### Requirement: Последствия отказа по хешу

При любом несовпадении хешей скрипт MUST после `confirmed: false` немедленно
отправить RPC-команду abort, дождаться выхода pi (orderly: закрытие stdin;
kill после 10 с) и выйти с кодом 1; в логе после записи `confirmed: false`
MUST отсутствовать вызовы `research_brief`/`research` (отсечка — момент
записи `confirmed: false`). Если в момент ответа файл `--brief` удалён или
нечитаем — файловый хеш недоступен: это отказ (`confirmed: false`, abort,
exit 1).

#### Scenario: После отказа нет research-вызовов
- **WHEN** отказ по хешу обработан и сессия завершена
- **THEN** в логе после записи `confirmed: false` отсутствуют вызовы
  `research_brief` и `research`.

#### Scenario: Бриф удалён при висящем диалоге
- **WHEN** файл `--brief` удалён/нечитаем в момент ответа на диалог
- **THEN** `confirmed: false`, abort, exit 1 (fail-closed).

### Requirement: Таймаут сессии с незакрытым диалогом

По достижении `--timeout-sec` при незакрытом `extension_ui_request` скрипт MUST
ответить `confirmed: false` (или `cancelled: true`), инициировать завершение pi,
дождаться выхода (kill после 10 с) и выйти с кодом 3, записав причину в лог.
Кампания остаётся в текущей фазе; состояние на диске не повреждается.

#### Scenario: Висящий confirm при таймауте
- **WHEN** `--timeout-sec` истёк при незакрытом confirm
- **THEN** скрипт ответил `confirmed: false`, pi завершён ( orderly: закрытие
  stdin; kill после 10 с), код выхода 3, причина `timeout` в логе.

### Requirement: Kickoff для research-кампании не использует metric-loop skill

Подкоманда `/autoresearch research` (точное слово или префикс `research `,
хвост — описание кампании) MUST активировать autoresearch-режим и отправить
research-kickoff, НЕ отправляя `/skill:autoresearch-create` и не предписывая
run_experiment/log_experiment. Содержание kickoff: campaign_id, путь брифа
и последовательность `research_brief draft` → `propose` → `research start`
→ `open` → `close` → `stop` → `report` (точный текст задан реализацией,
тест ассертит по этим маркерам).

#### Scenario: Активация research-режима
- **WHEN** оператор вызывает `/autoresearch research`
- **THEN** режим включён, сообщение описывает research-последовательность,
  не содержит `/skill:autoresearch-create`.

### Requirement: Порядок ветвления и guard research-кампании

Ветвление `research` MUST проверяться до ветки «already active». Guard MUST
отказывать в новой research-кампании, если в каталоге `.auto/research` есть кампания в
фазе briefing или research либо кампания с нечитаемым состоянием. Завершённые
(`stopped`) кампании guard MUST NOT блокировать: их переносит в архив draft, который
начинает новую кампанию (см. `research-vectors`, «Архив завершённых кампаний»).
campaign_id задаётся оператором (`--id`) или генерируется обёрткой
(`bench-<yyyymmdd-hhmmss>`) и передаётся агенту в stage 2.

#### Scenario: Guard на briefing-кампанию
- **WHEN** существует кампания в фазе briefing и вызван `/autoresearch research`
- **THEN** запуск отказывает (существующая кампания должна быть завершена или
  удалена оператором).

#### Scenario: Завершённая кампания не блокирует запуск
- **WHEN** существует кампания в фазе stopped и вызван `/autoresearch research <описание>`
- **THEN** запуск не отказывает по причине завершённой кампании; при последующем draft она переносится в архив

#### Scenario: Нечитаемая кампания блокирует запуск
- **WHEN** `state.json` существующей кампании не читается
- **THEN** запуск отказывает, ничего не переносится

### Requirement: Зарезервированное слово research в парсере /autoresearch

Парсер `/autoresearch` MUST распознавать `research` (точное слово или префикс
`research `) как зарезервированное слово research-кампании — это осознанное
изменение TUI-поведения (решение владельца).

#### Scenario: Свободная цель с префиксом research
- **WHEN** оператор вызывает `/autoresearch research something`
- **THEN** это research-кампания с описанием `something`.

### Requirement: Отклонение не-брифовых диалогов

Любой confirm без `Brief SHA-256:` в сообщении MUST отклоняться
(`confirmed: false`) с записью в лог. Поведение TUI-диалогов инструментов
(`ctx.ui.confirm === true` как единственный сигнал) не меняется.

#### Scenario: Не-брифовый диалог не подтверждается
- **WHEN** расширение эмитит confirm без строки `Brief SHA-256:`
- **THEN** скрипт отвечает `confirmed: false` и пишет событие в лог.

### Requirement: Регистрация подкоманды и edge-кейсы парсера

Подкоманда `research` MUST быть зарегистрирована в SUBCOMMANDS (help/completions).
Подкоманда распознаётся на lowercased trimmed command; разделитель —
`/^research(\s|$)/` (хвост — из исходного регистра аргументов); сравнение
регистронезависимо. `optimize` остаётся free-text потоком (headless-optimize —
документированный scope split, не входит в эту сборку).

#### Scenario: Регистрация в help
- **WHEN** оператор открывает help/completions `/autoresearch`
- **THEN** видна подкоманда `research` с описанием.

#### Scenario: Tab после зарезервированного слова
- **WHEN** оператор вызывает `/autoresearch research\ttab-desc`
- **THEN** распознаётся research-кампания с описанием `tab-desc`.

#### Scenario: Оптимизатор не матчится на префикс
- **WHEN** оператор вызывает `/autoresearch researcher x`
- **THEN** это free-text цель «researcher x», а не research-кампания.

### Requirement: Headless-запуск не является песочницей briefing-фазы

Документация headless-запуска MUST повторять принятую границу: git-блок
включается в фазе research, а также на stopped/pending-op/повреждённом
состоянии (см. researchBlocksOrdinaryLoop); briefing-фаза не блокирует
ordinary loop и shell; перехват команд Pi — best-effort, не песочница ОС.

#### Scenario: Документирование границы
- **WHEN** docs headless-запуска описывают research-режим
- **THEN** в них указано, что до `research start` git не блокируется и запуск
  обёртки не создаёт изоляции.

### Requirement: Handoff брифа и каноническая форма

Kickoff research-режима MUST инструктировать агента создать `research_brief
draft` (writeBriefDraft, research-state.ts) из содержимого файла `--brief`
(объект из его JSON). Поскольку draft записывается в канонической форме
(`JSON.stringify(brief, null, 2) + "\n"`) и одобряемый хеш считается по этим
байтам, байт-тождество файла и draft достигается требованием канонической формы файла.

#### Scenario: Handoff брифа в draft
- **WHEN** агент получает research-kickoff с путём к `--brief`
- **THEN** вызов `research_brief draft` использует объект из этого файла,
  и бриф в propose-диалоге совпадает с зафиксированным хешем (файл канонический).

#### Scenario: LLM-транскрипция изменила байты
- **WHEN** агент передал объект, сериализация которого отличается от
  канонических байтов файла
- **THEN** propose-диалог показывает другой хеш → отказ обёртки (exit 1),
  approval не записан; это fail-closed поведение.

### Requirement: Остаточный риск транскрипции брифа

LLM-транскрипция объекта (перестановка ключей/изменение литералов) может
дать другие байты draft: тогда propose-диалог покажет другой хеш и MUST
сработать отказ (exit 1). Риск принят: отказ — fail-closed поведение, а не
сбой; обёртка никогда не подтверждает расходящийся бриф; отклонение
фиксируется в логе для диагностики.

#### Scenario: Транскрипция даёт другой хеш
- **WHEN** сериализация объекта, переданного агентом в draft, отличается от
  канонических байтов `--brief`
- **THEN** propose-диалог показывает другой хеш, обёртка отвечает
  `confirmed:false` и завершается с exit 1.
