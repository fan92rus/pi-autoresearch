# Proposal: Headless-запуск кампаний autoresearch (research и optimize) через RPC-обёртку

## Why

Research-кампании (research-vectors) сейчас стартуют только в интерактивной сессии:
`research_brief propose` требует `ctx.ui.confirm` в TUI, а в print-режиме (`pi -p`)
диалогов нет (docs/extensions.md: «JSON and print modes have no UI»). Владелец хочет
запускать авторесерч — исследовательский и оптимизационный — через `pi -p` из
скриптов и проконтролировать ход работы снаружи, без интерактивной сессии.

Проверенные факты: расширения грузятся во всех режимах; в RPC-режиме (`pi --mode rpc`)
диалоги работают через под-протокол `extension_ui_request`/`extension_ui_response`
(`confirm` отвечает `confirmed: true/false`); gated-инструменты держатся always-active,
но каждый execute требует флага режима (`/autoresearch on`).

## Решения владельца (зафиксированы)

1. Headless-подтверждение брифа — **auto-approve по SHA-256**: оператор заранее
   фиксирует хеш брифа, обёртка подтверждает `propose` только при совпадении хеша
   из диалога. Чужой/отсутствующий хеш — отказ, fail-closed сохраняется.
2. Обёртка живёт в **`scripts/` репозитория pi-autoresearch** (версионируется
   вместе с расширением, тестируется в тех же гейтах).
3. Покрывает оба вида кампаний: **research** (исследование без метрики) и
   **optimize** (обычный метрический цикл).

## Что меняется

- Новый скрипт `scripts/research-rpc.mjs`: спавнит `pi --mode rpc` в целевом
  каталоге, отправляет kickoff (`/autoresearch on` + цель/бриф-инструкции),
  обслуживает `extension_ui_request`: `confirm` по брифу решает сравнением
  SHA-256 (переменная окружения `PI_RPC_AUTO_APPROVE`), остальные диалоги —
  в консоль оператору; полный JSONL-лог событий в файл.
- Kickoff для research-кампании: флаг `/autoresearch research` не отправляет
  legacy `/skill:autoresearch-create` (metric-loop) — research-правила уже
  инжектируются `before_agent_start`; в скрипте передаётся цель и путь к брифу.
- Оптимизационный запуск: `--mode optimize "<goal>"` — тот же скрипт, обычный
  цикл init/run/log; UI не требуется.
- Документация: `docs/research-vectors.md` (раздел headless-запуска) и общий
  headless-раздел в docs.

## Что не меняется

- `ctx.ui.confirm === true` остаётся единственным сигналом согласия в TUI;
  в TUI ничего не меняется.
- Auto-approve НЕ распространяется на candidate-branches policy-consent
  (отдельное решение владельца, сейчас не входит).
- Формат state/journal кампаний, сами инструменты и гейты блокировок.
- Семантика двухфазного запуска: бриф сначала создаётся и согласуется,
  потом замораживается хешем; auto-approve подтверждает ровно те байты,
  чей хеш оператор зафиксировал.

## Критерии приёмки

1. `node scripts/research-rpc.mjs --cwd <песочница> --mode research --brief <файл>`
   доходит до phase research; в логе видна последовательность draft → propose →
   start → open.
2. С верным `PI_RPC_AUTO_APPROVE=<sha>` propose подтверждён; с чужим sha —
   отклонён, кампания остаётся в briefing (fail-closed).
3. `--mode optimize "<goal>"` выполняет init/run/log цикл headless, леджер
   `.auto/log.jsonl` наполняется.
4. Полный npm test зелёный; openspec strict valid; новые тесты обёртки
   (спавн, подтверждение по хешу, отказ по чужому хешу).

## Risks / Trade-offs

- Подтверждение по хешу переносит «владелец видел бриф» из момента нажатия
  кнопки в момент фиксации хеша. Смягчение: скрипт печатает хеш и заголовок
  диалога в лог; несовпадение — отказ.
- Внутри RPC-сессии `/autoresearch on` и порядок kickoff-сообщений надо
  проверить живьём (поведение slash-команд расширений в RPC задокументировано
  на уровне «команды запускаются через prompt» — детали при реализации).
