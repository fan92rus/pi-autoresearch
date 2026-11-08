# Proposal: Headless-запуск кампаний autoresearch (research и optimize) через RPC-обёртку

## Why

Research-кампании (research-vectors) сейчас стартуют только в интерактивной сессии:
`research_brief propose` требует `ctx.ui.confirm` в TUI, а в print-режиме (`pi -p`)
диалогов нет (док pi-пакета docs/extensions.md из
`@earendil-works/pi-coding-agent`: «JSON and print modes have no UI»). Владелец хочет
запускать авторесерч — исследовательский и оптимизационный — через `pi -p`/RPC из
скриптов и проконтролировать ход работы снаружи, без интерактивной сессии.

Проверенные факты: расширения грузятся во всех режимах; в RPC-режиме (`pi --mode rpc`)
диалоги работают через под-протокол `extension_ui_request`/`extension_ui_response`
(`confirm` отвечает `confirmed: true/false`); gated-инструменты держатся always-active,
но каждый execute требует флага режима; `/autoresearch on` — НЕ подкоманда (уходит
в free-text и отправляет legacy skill); `research_brief draft` записывает бриф в
канонической форме `JSON.stringify(brief, null, 2) + "\n"`, хеш одобрения считается
по этим байтам.

## Решения владельца (зафиксированы)

1. Headless-подтверждение брифа — **auto-approve по SHA-256** (механизм:
   флаг `--approve-sha`; env-переменные не используются). Обёртка подтверждает
   `propose` только при совпадении всех трёх хешей (операторский, диалоговый,
   файловый в момент диалога). Любое несовпадение — отказ + abort сессии, exit 1.
2. Обёртка живёт в **`scripts/` репозитория pi-autoresearch**.
3. Покрывает оба вида кампаний: **research** и **optimize**.
4. Зарезервированное слово `research` вводится в парсер `/autoresearch` и в TUI
   (осознанное изменение TUI-поведения); выразимость optimize-целей со словом
   `research` сохраняется новым явным алиасом `/autoresearch optimize <goal>`
   (алиас минует зарезервированную ветку, слово `optimize` отбрасывается).
5. Файл брифа для research-запуска должен быть в канонической форме
   (`JSON.stringify(parsed, null, 2) + "\n"`) — иначе обёртка отказывает до
   спавна pi; канонизацию делает оператор (однострочник в docs).

## Что меняется

- Новый скрипт `scripts/research-rpc.mjs`: спавнит `pi --mode rpc`, активация
  одним сообщением `/autoresearch research` (stage 1), затем stage 2 — текст
  с путём брифа, хешем, campaign_id (`--campaign-id` или сгенерированный) и
  шагами (draft из содержимого файла → propose → start → open → close → stop
  → report). Sequencing (extension-команда всегда даёт `handled`, а её kickoff
  стримится): stage 2 после цикла `agent_start` → `agent_settled`; нет
  `agent_start` за `--stage1-timeout-sec` → stage 1 отказала (exit 2); `queued`/
  `success:false` на stage-2 prompt — ошибка обёртки (exit 1). Полный JSONL-лог;
  exit codes 0/1/2/3.
- Подкоманда `research` в парсере `/autoresearch` (index.ts + commands.ts
  SUBCOMMANDS): проверяется до ветки already-active; guard — отказ при существующей
  кампании в ЛЮБОЙ фазе (briefing тоже; `researchBlocksOrdinaryLoop` недостаточно).
- Новый алиас `/autoresearch optimize <goal>` (metric-loop; проверяется до
  зарезервированного слова; документированные примеры optimize-запуска меняют
  формулировку — обновляются в task 4.2).
- Headless optimize: обёртка шлёт `/autoresearch optimize <goal>`.
- Документация: docs/research-vectors.md (Headless launch) и общий headless-раздел.

## Что не меняется

- `ctx.ui.confirm === true` остаётся единственным сигналом согласия инструментов
  в TUI. Осознанные изменения TUI-поведения — ровно два, оба задокументированы:
  зарезервированное слово `research` и алиас `optimize` (примеры в help меняются).
- Auto-approve НЕ распространяется на candidate-branches policy-consent.
- Формат state/journal кампаний, гейты блокировок.
- Остальные свободные цели `/autoresearch <goal>` — как раньше.

## Критерии приёмки

1. `node scripts/research-rpc.mjs --cwd <песочница> --mode research --brief
   <канонический файл> --approve-sha <sha>` доходит до phase research; в логе
   нет «mode OFF» отказов; последовательность draft → propose → start видна.
2. Чужой `--approve-sha` (≠ диалоговому хешу): `confirmed:false`, abort,
   exit 1, после отказа в логе нет research-вызовов. Мутация файла при висящем
   диалоге: отказ при ответе (файловый хеш пересчитывается в этот момент).
3. `--mode optimize "<goal>"`: цикл init/run/log выполняется, `.auto/log.jsonl`
   наполняется (покрыто E2E-задачей); входящий confirm → `false` + лог, цикл
   может остановиться (документированное поведение).
4. Таймаут при висящем confirm: `false`, shutdown pi (kill после 10 с), exit 3.
   Exit codes: 0 успех / 1 отказ по хешу / 2 ошибки аргументов (в т.ч.
   неканонический бриф, research без `--brief`) / 3 таймаут.
5. Полный npm test зелёный; openspec strict valid; юнит- и wiring-тесты задач
   3.1–3.2 (обёртка: каноничность, три хеша, таймаут, exit codes, sequencing,
   stage-2 текст; wiring: research/optimize парсер, guard, SUBCOMMANDS) и
   E2E (research + optimize ledger).

## Risks / Trade-offs

- Хеш-подход переносит «владелец видел бриф» в момент фиксации хеша; отказ —
  fail-closed.
- Substring `Brief SHA-256:` в message — сознательно хрупкий контракт: смена
  формата диалога → отказ.
- Алиас `optimize` меняет kickoff-формулировки двух документированных примеров
  (commands.ts:30, index.ts:2742) — обновление в task 4.2.
