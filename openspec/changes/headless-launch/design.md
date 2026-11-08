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
(в) `<hex>` совпадает с фиксированным оператором, (г) хеш совпадает
также с хешем файла `--brief`, посчитанным скриптом при старте. Любое
несовпадение (операторский ≠ диалоговый, диалоговый ≠ файловый) —
`confirmed: false` и завершение сессии с ненулевым кодом до дальнейших
шагов агента (fail-closed: агент никогда не получает подтверждения брифа,
расходящегося с зафиксированным). Остальные confirm — `confirmed: false`
с пометкой в логе.

## Компоненты

### 1. `scripts/research-rpc.mjs` (новый)

Node-скрипт без внешних зависимостей (`node:child_process`, `node:readline`
не используется — ручной JSONL-фрейминг по LF, сплит только по `\n`, как
требует docs/rpc.md).

CLI:
```
node scripts/research-rpc.mjs --cwd <dir> --mode research|optimize
     [--goal "<text>"] [--brief <path>] [--approve-sha <hex>]
     [--pi <путь к pi>] [--log <файл>] [--timeout-sec N]
```

- `--mode research`: шлёт `/autoresearch on`, дожидается observable-подтверждения
  активации режима (первый `agent_end`/`agent_settled` после команды), затем
  отправляет kickoff: инструкция с путём брифа, его SHA-256 (скрипт считает
  sha256 байтов файла тем же алгоритмом, что `sha256Hex` в research-state.ts:
  sha256 от сырых байтов, hex-строка) и последовательностью draft → propose →
  start `expected_sha256=<hash>` → open по одному вопросу → close по правилам
  → stop → report.
- `--mode optimize "<goal>"`: `/autoresearch <goal>` — обычный цикл.
- Лог: сырой JSONL всех записей stdout-потока + сводка tool-вызовов в консоль.
- Завершение: `agent_settled` после report/финиша цикла, или таймаут.

### 2. Таймаут и висящие диалоги

По достижении `--timeout-sec`: если есть незакрытый `extension_ui_request`,
скрипт отвечает `confirmed: false` (или `cancelled: true`), посылает pi
shutdown, дожидается выхода процесса (kill после 10с), пишет в лог причину
`timeout` и выходит с кодом 3. Кампания остаётся в текущей фазе — состояние
на диске не повреждается (approval либо записан целиком, либо нет: запись
approval атомарна на стороне расширения).

### 3. Изменения в `extensions/pi-autoresearch/index.ts`

Минимальные:

- В обработчике `/autoresearch`: подкоманда `research` распознаётся ТОЛЬКО
  как точное слово `research` или префикс `research ` (с последующим текстом —
  он становится описанием кампании). Free-text цель «research something»
  поэтому интерпретируется как research-кампания с темой «something» — это
  документированное поведение (см. spec); цель optimize, начинающаяся с этих
  форм, задаётся через обёртку `--mode optimize`. Остальные аргументы —
  без изменений.
- Ветка `research`: активирует режим, затем отправляет research-kickoff
  (перечисление шагов кампании, БЕЗ `/skill:autoresearch-create`); guard
  против существующей research-кампании (reuse `researchBlocksOrdinaryLoop`).
- Никаких изменений в `ctx.ui.confirm`-гейтах инструментов.

### 4. Что НЕ меняется

- Гейты инструментов, fail-closed поведение, форматы state/journal.
- TUI-путь запуска.

## Потоки

### Research (headless)
1. Оператор готовит бриф-JSON и считает `sha256(файла)`.
2. Запуск обёртки с `--brief` и `--approve-sha`.
3. Обёртка: `/autoresearch on` → ждёт первый `agent_end` → kickoff-текст.
4. Агент: `research_brief draft` → `research_brief propose` → пи эмитит confirm →
   обёртка сверяет хеш (три стороны: операторский, диалоговый, файловый) →
   `confirmed: true` → approval записан.
5. Агент: `research start` с хешем → фаза research → вопросы → report.
6. Обёртка печатает tail событий, сохраняет лог, завершается по `agent_settled`.

### Optimize (headless)
1. `/autoresearch <goal>` → обычный цикл init/run/log. Диалогов нет; если
   расширение эмитит confirm — обёртка отвечает `false` и логирует. Цикл
   при этом может остановиться: это документированное поведение, а не сбой
   (candidate policy-consent и manual recovery — отдельные интерактивные
   пути, в optimize-headless не входят).

## Тесты

- Юнит на обёртку (без спавна pi): парсер `extension_ui_request`, решение
  confirm по хешу: совпал / чужой диалоговый / файловый ≠ диалоговый /
  не-брифовый (substring без hex или другой метод) / timeout с висящим
  confirm; сборка kickoff-текстов обоих режимов; последовательность
  mode-flip → ожидание agent_end → kickoff.
- Интеграционный (спавн настоящего `pi --mode rpc`; путь к CLI берётся из
  `--pi`, иначе `pi` из PATH; выполняется только при `PI_RPC_E2E=1`, иначе
  `skip`): draft→propose с auto-approve доходит до phase research; чужой хеш
  кампания остаётся briefing; файл брифа изменён после kickoff — отказ до
  confirm.
- Wiring: `/autoresearch research` не отправляет `/skill:autoresearch-create`;
  `/autoresearch research something` трактуется как research-кампания с темой
  `something` (документированное поведение парсера).
