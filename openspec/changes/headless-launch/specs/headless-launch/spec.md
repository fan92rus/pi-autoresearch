# headless-launch Specification

## ADDED Requirements

### Requirement: RPC-обёртка для headless-запуска кампаний

Система SHALL предоставлять скрипт `scripts/research-rpc.mjs`, который запускает
`pi --mode rpc` в указанном каталоге, отправляет kickoff-сообщение для выбранного
вида кампании (`research` или `optimize`) и обслуживает запросы extension UI
(`extension_ui_request`) от Pi, записывая полный JSONL-лог сессии в файл.

#### Scenario: Запуск research-кампании headless
- **WHEN** оператор вызывает скрипт с `--mode research --brief <файл>` и верным
  `--approve-sha`
- **THEN** агент выполняет `research_brief draft` → `propose` → `research start`
  → открытие вопросов; confirm-диалог брифа подтверждается скриптом автоматически
  при совпадении SHA-256, лог содержит всю последовательность.

#### Scenario: Чужой хеш отклоняется
- **WHEN** confirm-диалог содержит хеш, не совпадающий с `--approve-sha`
- **THEN** скрипт отвечает `confirmed: false`, approval не записывается,
  кампания остаётся в фазе briefing; в логе зафиксировано расхождение хешей.

### Requirement: Согласие владельца сохраняется через фиксацию хеша

Auto-approve MUST подтверждать только те диалоги, где SHA-256 из текста диалога
совпадает с хешем, заранее зафиксированным оператором. Любой другой confirm
MUST отклоняться по умолчанию. Поведение TUI (`ctx.ui.confirm === true` как
единственный сигнал) не меняется.

#### Scenario: Не-брифовый диалог не подтверждается
- **WHEN** расширение эмитит confirm, не содержащий строку `Brief SHA-256:`
- **THEN** скрипт отвечает `confirmed: false` и пишет событие в лог.

### Requirement: Kickoff для research-кампании не использует metric-loop skill

Команда `/autoresearch research` MUST активировать autoresearch-режим и отправить
research-kickoff (последовательность research_brief/research), НЕ отправляя
`/skill:autoresearch-create` и не предписывая run_experiment/log_experiment.

#### Scenario: Активация research-режима
- **WHEN** оператор вызывает `/autoresearch research` (в TUI или через обёртку)
- **THEN** режим включён, отправленное сообщение описывает research-последовательность
  и не содержит `/skill:autoresearch-create`.

### Requirement: Оптимизационный запуск headless

Скрипт SHALL поддерживать `--mode optimize "<goal>"`: отправка `/autoresearch <goal>`
без требования интерактивного UI; неизвестные диалоги отклоняются с записью в лог.

#### Scenario: Обычный цикл без UI
- **WHEN** скрипт запущен с `--mode optimize` и целью
- **THEN** агент выполняет init/run/log цикл headless; леджер `.auto/log.jsonl`
  наполняется; если расширение запросит confirm — скрипт отвечает `false` и логирует.
