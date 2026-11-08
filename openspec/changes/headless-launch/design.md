# Design: Headless-запуск через RPC-обёртку

## Архитектура

```
оператор ──> scripts/research-rpc.mjs ──spawn──> pi --mode rpc (cwd=<target>)
                │                                    │
                │  stage 1: /autoresearch research   │
                │  (extension: mode + research rules)│
                │  wait: disposition + agent_settled │
                │  stage 2: brief path/hash/steps    │
                │<── extension_ui_request (confirm) ──┤
                │──> extension_ui_response (confirmed)│
                │<── jsonl events (tool_call, agent_*)┤
                └──> session-events.log + console tail
```

## Каноническая форма брифа и хеши

`research_brief draft` записывает бриф в канонической форме:
`JSON.stringify(validation.brief, null, 2) + "\n"` (research-state.ts), и
одобряемый хеш считается по этим байтам. Поэтому:

- Обёртка при старте парсит `--brief` и ТРЕБУЕТ, чтобы байты файла уже были
  канонической формой: `bytes === JSON.stringify(JSON.parse(bytes), null, 2) + "\n"`.
  Не канонический файл — ошибка аргументов (exit 2) до спавна pi; оператор
  канонизирует файл заранее (в docs — однострочник).
- `--approve-sha` = sha256 канонических байтов файла (sha256 от сырых байтов,
  lowercase hex — тот же алгоритм, что `sha256Hex`).
- Три хеша сверяются В МОМЕНТ ответа на диалог: диалоговый (из message),
  операторский (`--approve-sha`) и файловый — пересчитанный из `--brief` в этот
  момент. Это делает сценарий «файл изменён после kickoff» детерминированным:
  мутация файла, сделанная пока диалог висит, обнаруживается при ответе.
- Любое несовпадение: `confirmed: false`, затем немедленно RPC-команда abort
  процессу pi (агент прерывается до дальнейших шагов), ожидание выхода
  (kill после 10 с), exit 1. Тест ассертит: после отказа в логе нет
  `research_brief`/`research` вызовов.

## Компоненты

### 1. `scripts/research-rpc.mjs` (новый)

Node-скрипт без внешних зависимостей. JSONL-фрейминг по LF, сплит только по
`\n` (U+2028/29 не границы, как требует docs/rpc.md).

```
node scripts/research-rpc.mjs --cwd <dir> --mode research|optimize
     [--brief <path>] [--approve-sha <hex>] [--campaign-id <id>]
     [--goal "<description>"] [--pi <путь>] [--log <файл>] [--timeout-sec N]
```

- `--mode research` ТРЕБУЕТ `--brief` и `--approve-sha` (иначе exit 2 до спавна).
- Активация: ОДНО сообщение `/autoresearch research` (+ описание из `--goal`
  как хвост аргумента). Команду обрабатывает расширение: флипает режим и
  отправляет research-kickoff (правила кампании). Обёртка НЕ отправляет
  `/autoresearch on` (не подкоманда) и никогда не отправляет
  `/skill:autoresearch-create`.
- Sequencing: после отправки stage 1 обёртка ждёт ответ prompt
  (`data.disposition`): `started` — ждёт `agent_settled`; `handled` — режим
  активирован без запуска LLM-хода, переходим к stage 2 немедленно. Один
  сигнал во всех файлах: disposition + agent_settled.
- Stage 2 (после stage-1 завершения): текст с путём `--brief`, его SHA-256,
  `campaign_id` (из `--campaign-id`, иначе сгенерированный `bench-<yyyymmdd-hhmmss>`)
  и шагами: прочитать файл брифа → `research_brief draft` (campaign_id, объект
  из JSON файла) → `propose` → `research start` (campaign_id, expected_sha256)
  → open по одному вопросу → close по правилам → stop → report.
- `--mode optimize "<goal>"`: ОДНО сообщение `/autoresearch optimize <goal>`
  (явный алиас metric-loop). Никогда не `/autoresearch <goal>` голым текстом —
  цель, начинающаяся с `research`, иначе попала бы в зарезервированную ветку.
- Диалоги: см. раздел хешей; не-брифовые confirm — `confirmed: false` + лог
  (оптимизационный цикл может остановиться — документированное поведение).
- Таймаут: незакрытый request → `confirmed: false`/`cancelled: true`, shutdown
  pi (kill после 10 с), exit 3, причина в логе.
- Exit codes: 0 — успех (report/финиш цикла); 1 — отказ по хешу/диалогу;
  2 — ошибки аргументов; 3 — таймаут.
- Лог: сырой JSONL всех записей stdout + консольный tail tool-вызовов.

### 2. Изменения в `extensions/pi-autoresearch/index.ts` и `commands.ts`

- Подкоманда `research` в парсере `/autoresearch`: точное слово `research`
  или префикс `research ` (хвост — описание кампании). Ветвление проверяется
  ДО ветки «already active» (иначе `/autoresearch research` при включённом
  режиме молча проглатывается). Guard: отказ, если каталог `.auto/research`
  существует и содержит хоть одну кампанию (любая фаза — briefing тоже:
  `researchBlocksOrdinaryLoop` блокирует только research/stopped/pending, его
  недостаточно). Kickoff — research-правила, БЕЗ `/skill:autoresearch-create`.
- Подкоманда `optimize` (алиас): `/autoresearch optimize <goal>` — явный вход
  в metric-loop: слово `optimize` отбрасывается, хвост — цель. Проверяется
  ДО зарезервированного слова `research`, поэтому
  `/autoresearch optimize research habits` даёт metric-loop с полной целью
  «research habits». Это НЕ чистый сахар: алиас минует зарезервированное
  слово. Два документированных примера (`commands.ts:30`, `index.ts:2742` —
  «/autoresearch optimize unit test runtime…») меняют смысл: их kickoff-цель
  теперь без слова `optimize` — обновить примеры (task 4.2).
- Регистрация обеих подкоманд в `commands.ts` `SUBCOMMANDS` (help/completions).
- Никаких изменений в `ctx.ui.confirm`-гейтах инструментов.

### 3. Что НЕ меняется

- Гейты инструментов, fail-closed поведение, форматы state/journal.
- Остальные свободные цели `/autoresearch <goal>` (кроме префикса `research `
  и нового алиаса) — как раньше.

## Потоки

### Research (headless)
1. Оператор канонизирует бриф-JSON и считает `sha256(файла)`.
2. Обёртка `--mode research --brief --approve-sha [--campaign-id] [--goal]`.
3. Stage 1 `/autoresearch research` → disposition/agent_settled.
4. Stage 2: путь брифа + хеш + campaign_id + шаги.
5. Агент: draft (объект из файла; записанные байты = каноническая форма =
   байты файла, т.к. файл уже канонический) → propose → confirm → обёртка
   сверяет три хеша в момент диалога → `confirmed: true`.
6. Агент: `research start` (campaign_id, expected_sha256) → вопросы → report.
7. Обёртка: tail, лог, exit 0 по agent_settled после report.

### Optimize (headless)
`/autoresearch optimize <goal>` → metric-loop init/run/log. Диалог → `false`
+ лог (цикл может остановиться — документировано).

## Тесты

- Юнит обёртки: каноничность файла (не канонический → exit 2); решение confirm
  (три совпали / операторский ≠ диалоговый → false+abort+exit 1 / диалоговый ≠
  файловый в момент ответа → false+abort+exit 1 / не-брифовый → false);
  timeout → exit 3; exit codes 0/1/2/3; sequencing disposition+agent_settled,
  ветка handled; сборка stage-2 текста (путь, хеш, campaign_id, шаги).
- Wiring: `/autoresearch research` без `/skill:autoresearch-create`;
  `research something` = кампания с темой something; `research` до ветки
  already-active; guard на briefing-кампанию; `/autoresearch optimize research
  habits` = metric-loop с полной целью; SUBCOMMANDS содержит research/optimize;
  edge-кейсы парсера: tab после `research`, `optimize` без цели → отказ,
  lowercase-чувствительность (command.toLowerCase()).
- E2E (`PI_RPC_E2E=1`, иначе skip; CLI из `--pi` или PATH): research до phase
  research без «mode OFF» отказов; чужой sha → отказ + abort + exit 1 + нет
  research-вызовов после отказа; мутация файла при висящем диалоге → отказ;
  optimize-прогон наполняет `.auto/log.jsonl`.
