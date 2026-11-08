# headless-launch Specification

## ADDED Requirements

### Requirement: RPC-обёртка для headless-запуска кампаний

Система SHALL предоставлять скрипт `scripts/research-rpc.mjs`, который запускает
`pi --mode rpc` в указанном каталоге и обслуживает запросы extension UI
(`extension_ui_request`) от Pi, записывая полный JSONL-лог сессии в файл.
Активация кампании SHALL выполняться одним сообщением: `/autoresearch research`
(для research) или `/autoresearch optimize <goal>` (для optimize).

#### Scenario: Запуск research-кампании headless
- **WHEN** оператор вызывает скрипт с `--mode research --brief <канонический файл>
  --approve-sha <sha>` и хеш верен
- **THEN** агент выполняет `research_brief draft` → `propose` → `research start`
  → открытие вопросов; confirm брифа подтверждается автоматически; в логе нет
  отказов «Autoresearch mode is OFF» и нет `/skill:autoresearch-create`.

### Requirement: Sequencing stage 1 → stage 2

`/autoresearch research` — extension-команда: её prompt-ответ всегда имеет
disposition `handled`, а собственный kickoff-запуск стримится внутри той же
сессии. Обёртка SHALL после stage-1 ответа ждать цикл `agent_start` →
`agent_settled`; если `agent_start` не наступил за `--stage1-timeout-sec`
(по умолчанию 30) — stage 1 отказала (exit 2).

#### Scenario: Sequencing stage 1 → stage 2
- **WHEN** stage-1 сообщение отправлено, ответ `handled`, затем пришёл
  `agent_start` и завершился `agent_settled`
- **THEN** stage 2 отправлена после этого `agent_settled`.

#### Scenario: Stage 1 отказала (guard или ошибка)
- **WHEN** после stage-1 ответа `agent_start` не наступил за
  `--stage1-timeout-sec`
- **THEN** обёртка завершается с кодом 2, причина в логе (кампания не создана).

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

### Requirement: Запрет legacy-команд активации

Скрипт MUST НЕ отправлять `/autoresearch on` и `/skill:autoresearch-create`.

#### Scenario: Ни одна отправка не содержит legacy-команд
- **WHEN** обёртка отработала любой режим
- **THEN** в логе отправленных сообщений нет `/autoresearch on` и
  `/skill:autoresearch-create`.

### Requirement: Трёхсторонняя сверка хеша в момент диалога

При ответе на propose-confirm скрипт MUST сверить три хеша: из текста диалога
(первое вхождение `Brief SHA-256: <hex>` от начала message), зафиксированный
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
отправить RPC-команду abort, дождаться выхода pi (kill после 10 с) и выйти
с кодом 1; в логе после отказа MUST отсутствовать вызовы
`research_brief`/`research`. Любой confirm без `Brief SHA-256:` в сообщении
MUST отклоняться (`confirmed: false`) с записью в лог. Поведение TUI-диалогов
инструментов (`ctx.ui.confirm === true` как единственный сигнал) не меняется.

#### Scenario: После отказа нет research-вызовов
- **WHEN** отказ по хешу обработан и сессия завершена
- **THEN** в логе после abort отсутствуют вызовы `research_brief` и `research`.

### Requirement: Таймаут сессии с незакрытым диалогом

По достижении `--timeout-sec` при незакрытом `extension_ui_request` скрипт MUST
ответить `confirmed: false` (или `cancelled: true`), инициировать завершение pi,
дождаться выхода (kill после 10 с) и выйти с кодом 3, записав причину в лог.
Кампания остаётся в текущей фазе; состояние на диске не повреждается.

#### Scenario: Висящий confirm при таймауте
- **WHEN** `--timeout-sec` истёк при незакрытом confirm
- **THEN** скрипт ответил `confirmed: false`, pi завершён, код выхода 3,
  причина `timeout` в логе.

### Requirement: Коды выхода

Скрипт SHALL использовать: 0 — успех (research: получен успешный `report`;
optimize: агент сообщил завершение цикла в финальном тексте); 1 — отказ по
хешу брифа (с abort сессии); 2 — ошибки аргументов и отказ guard-а на stage 1;
3 — таймаут.

#### Scenario: Код для отказа по хешу
- **WHEN** сработал отказ по хешу
- **THEN** код выхода 1 (не 0 и не 3).

### Requirement: Диалоги в optimize-режиме

В optimize-режиме обёртка MUST отвечать `confirmed:false` на любой диалог с
`Brief SHA-256:` (нет `--approve-sha`) и логировать его. Не-брифовый confirm
получает `confirmed:false` и лог; exit 1 даётся только отказом по хешу брифа
(abort сессии), штатное завершение — 0/3.

#### Scenario: Не-брифовый confirm не меняет код
- **WHEN** в optimize-режиме пришёл confirm без `Brief SHA-256:`
- **THEN** `confirmed:false`, лог; код выхода определяется штатным завершением
  (0/3), а не этим диалогом.

### Requirement: Kickoff для research-кампании не использует metric-loop skill

Подкоманда `/autoresearch research` (точное слово или префикс `research `,
хвост — описание кампании) MUST активировать autoresearch-режим и отправить
research-kickoff, НЕ отправляя `/skill:autoresearch-create` и не предписывая
run_experiment/log_experiment.

#### Scenario: Активация research-режима
- **WHEN** оператор вызывает `/autoresearch research`
- **THEN** режим включён, сообщение описывает research-последовательность,
  не содержит `/skill:autoresearch-create`.

### Requirement: Порядок ветвления и guard research-кампании

Ветвление `research` MUST проверяться до ветки «already active». Guard MUST
отказывать в новой research-кампании, если каталог `.auto/research` содержит
хоть одну кампанию в любой фазе (briefing включительно). campaign_id задаётся
оператором (`--campaign-id`) или генерируется обёрткой
(`bench-<yyyymmdd-hhmmss>`) и передаётся агенту в stage 2.

#### Scenario: Guard на briefing-кампанию
- **WHEN** существует кампания в фазе briefing и вызван `/autoresearch research`
- **THEN** запуск отказывает (существующая кампания должна быть завершена или
  удалена оператором).

### Requirement: Зарезервированное слово research в парсере /autoresearch

Парсер `/autoresearch` MUST распознавать `research` (точное слово или префикс
`research `) как зарезервированное слово research-кампании — это осознанное
изменение TUI-поведения (решение владельца).

#### Scenario: Свободная цель с префиксом research
- **WHEN** оператор вызывает `/autoresearch research something`
- **THEN** это research-кампания с описанием `something`.

### Requirement: Алиас optimize

Новый алиас `/autoresearch optimize <goal>` MUST проверяться ДО зарезервированной
ветки: слово `optimize` отбрасывается, хвост — полная цель metric-loop. Kickoff
алиаса — РОВНО тот же, что у существующего free-text optimize-потока сегодня:
`/skill:autoresearch-create <goal> BENCHMARK_GUARDRAIL` (при отсутствии
`.auto/prompt.md`) или «Autoresearch mode active. <goal> ...» (при наличии);
цель в kickoff — исходный хвост без слова `optimize`.

#### Scenario: Алиас optimize сохраняет выразимость целей
- **WHEN** оператор вызывает `/autoresearch optimize research habits`
- **THEN** отправляется metric-loop kickoff с полной целью «research habits».

#### Scenario: Optimize без цели
- **WHEN** оператор вызывает `/autoresearch optimize`
- **THEN** отказ с сообщением об отсутствии цели.

### Requirement: Регистрация подкоманд и edge-кейсы парсера

Подкоманды `research` и `optimize` MUST быть зарегистрированы в SUBCOMMANDS
(help/completions). Подкоманда распознаётся на lowercased trimmed command;
разделитель — `/^research(\s|$)/` (хвост берётся из исходного регистра
аргументов); `optimize` без цели — отказ; сравнение регистронезависимо.

#### Scenario: Регистрация в help
- **WHEN** оператор открывает help/completions `/autoresearch`
- **THEN** видны обе подкоманды `research` и `optimize` с описаниями.

#### Scenario: Tab после зарезервированного слова
- **WHEN** оператор вызывает `/autoresearch research\ttab-desc`
- **THEN** распознаётся research-кампания с описанием `tab-desc`.

### Requirement: Оптимизационный запуск headless

Скрипт SHALL поддерживать `--mode optimize` с целью в `--goal` (без `--goal` —
exit 2): отправка `/autoresearch optimize <goal>` без интерактивного UI;
неизвестные диалоги отклоняются с записью в лог; отклонение может остановить
цикл — документированное поведение, а не сбой. E2E SHALL проверять наполнение
`.auto/log.jsonl` и стоп-условие завершения (exit 0 — агент сообщил завершение
цикла в финальном тексте; иначе плановый таймаут — exit 3).

#### Scenario: Обычный цикл без UI
- **WHEN** скрипт запущен с `--mode optimize` и целью
- **THEN** агент выполняет init/run/log цикл; `.auto/log.jsonl` наполняется;
  входящий confirm → `false` + лог.

### Requirement: Headless-запуск не является песочницей briefing-фазы

Документация headless-запуска MUST повторять принятую границу: briefing-фаза
research-кампании не блокирует ordinary loop и shell (git-блок включается только
в фазе research); перехват команд Pi — best-effort, не песочница ОС.

#### Scenario: Документирование границы
- **WHEN** docs headless-запуска описывают research-режим
- **THEN** в них указано, что до `research start` git не блокируется и запуск
  обёртки не создаёт изоляции.

### Requirement: Handoff брифа и каноническая форма

Kickoff research-режима MUST инструктировать агента создать `research_brief
draft` из содержимого файла `--brief` (объект из его JSON). Поскольку draft
записывается в канонической форме (`JSON.stringify(brief, null, 2) + "\n"`) и
одобряемый хеш считается по этим байтам, байт-тождество файла и draft
достигается требованием канонической формы файла (см. Requirement research-режима).

#### Scenario: Handoff брифа в draft
- **WHEN** агент получает research-kickoff с путём к `--brief`
- **THEN** вызов `research_brief draft` использует объект из этого файла,
  и бриф в propose-диалоге совпадает с зафиксированным хешем (файл канонический).
