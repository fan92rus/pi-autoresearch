# Design: Headless-запуск через RPC-обёртку

## Архитектура

```
оператор ──> scripts/research-rpc.mjs ──spawn──> pi --mode rpc (cwd=<target>)
                │                                    │
                │<── extension_ui_request (confirm) ──┘
                │──> extension_ui_response (confirmed) │
                │<── jsonl events (tool_call, agent_*)─┘
                └──> session-events.log (полный JSONL) + console tail
```

Оператор заранее вычисляет SHA-256 брифа и передаёт её в переменной
`PI_RPC_AUTO_APPROVE` (или флагом `--approve-sha`). Скрипт подтверждает
confirm-диалог только когда: (а) метод — `confirm`, (б) в сообщении диалога
есть строка `Brief SHA-256: <hex>` (формат из `research_brief propose`),
(в) `<hex>` совпадает с фиксированным оператором. Остальные confirm —
`confirmed: false` с пометкой в логе (fail-closed по умолчанию).

## Компоненты

### 1. `scripts/research-rpc.mjs` (новый)

Node-скрипт без внешних зависимостей (`node:child_process`, `node:readline`).

CLI:
```
node scripts/research-rpc.mjs --cwd <dir> --mode research|optimize
     [--goal "<text>"] [--brief <path>] [--approve-sha <hex>]
     [--pi <путь к pi>] [--log <файл>] [--timeout-sec N]
```

- `--mode research`: шлёт `/autoresearch on`, затем текстовый kickoff с
  инструкцией: бриф из `--brief`, вызвать `research_brief draft` → `propose` →
  `research start expected_sha256=<hash>` → открыть вопросы по одному →
  close по правилам → stop → report. Хеш брифа скрипт считает сам из файла
  (одинаковый алгоритм `sha256Hex`) и передаёт агенту в kickoff.
- `--mode optimize "<goal>"`: `/autoresearch <goal>` — обычный цикл.
- Лог: сырой JSONL всех записей stdout-потока + сводка tool-вызовов в консоль.
- Завершение: `agent_settled` после report/финиша цикла, или таймаут.

### 2. Изменения в `extensions/pi-autoresearch/index.ts`

Минимальные:

- В обработчике `/autoresearch`: аргумент `research` — активирует режим
  и отправляет research-kickoff (перечисление шагов кампании, БЕЗ
  `/skill:autoresearch-create`). Без него `/autoresearch on` при отсутствии
  `.auto/prompt.md` отправит metric-loop skill — это ломало бы research-сессию.
- Никаких изменений в `ctx.ui.confirm`-гейтах инструментов.

### 3. Что НЕ меняется

- Гейты инструментов, fail-closed поведение, форматы state/journal.
- TUI-путь запуска.

## Потоки

### Research (headless)
1. Оператор пишет бриф-JSON заранее (или агент делает draft в первой сессии)
   и считает `sha256(brief.json)`.
2. Запуск обёртки с `--brief` и `--approve-sha`.
3. Обёртка: `/autoresearch on` → kickoff-текст (draft/propose/start/open/close/stop/report).
4. Агент: `research_brief draft` → `research_brief propose` → пи эмитит confirm →
   обёртка сверяет хеш → `confirmed: true` → approval записан.
5. Агент: `research start` с хешем → фаза research → открытые вопросы → report.
6. Обёртка печатает tail событий, сохраняет лог, завершается по `agent_settled`.

### Optimize (headless)
1. `/autoresearch <goal>` → обычный цикл init/run/log. Диалогов нет; если
   расширение всё же эмитит confirm — обёртка отвечает `false` и логирует
   (критично: не подтверждать неизвестные диалоги).

## Тесты

- Юнит на обёртку (без спавна pi): парсер `extension_ui_request`, решение
  confirm по хешу (совпал/не совпал/не бриф), формирование kickoff-текста
  для обоих режимов.
- Интеграционный (спавн настоящего `pi --mode rpc` в tmp-песочнице,
  помеченный `skip` без PI_RPC_E2E=1): draft→propose с auto-approve,
  отказ с чужим хешем.
- Wiring: `/autoresearch research` не отправляет `/skill:autoresearch-create`.
