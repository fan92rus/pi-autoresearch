# Proposal: Headless-запуск research-кампаний autoresearch через RPC-обёртку

## Why

Research-кампании (research-vectors) сейчас стартуют только в интерактивной сессии:
`research_brief propose` требует `ctx.ui.confirm` в TUI, а в print-режиме (`pi -p`)
диалогов нет (док pi-пакета docs/extensions.md из
`@earendil-works/pi-coding-agent`: «JSON and print modes have no UI»). Владелец хочет
запускать авторесерч (research) через RPC из скриптов и проконтролировать ход работы
снаружи, без интерактивной сессии. Headless-optimize (candidate campaigns) —
документированный scope split: их consent-диалог init требует отдельного механизма,
в эту сборку не входит.

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
3. Покрывает research-кампании; headless-optimize — scope split (не в этой сборке).
4. Зарезервированное слово `research` вводится в парсер `/autoresearch` и в TUI
   (осознанное изменение TUI-поведения). optimize остаётся free-text потоком:
   цели вида «optimize research habits» идут legacy-путём как раньше (регресс-тест).
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
- Документация: docs/research-vectors.md раздел Headless launch, включая рецепт
  канонического брифа (байты draft-а агента как эталон; первый живой прогон
  реально отказал LLM-транскрипцию).

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
4. Таймаут при висящем confirm: `false`, shutdown pi (закрытие stdin, kill
   после 10 с), exit 3. Exit codes: 0 успех / 1 отказ по хешу или
   протокольная ошибка stage 2 / 2 ошибки аргументов (в т.ч. неканонический
   бриф, research без `--brief`) и отказ stage 1 / 3 таймаут.
5. Гейты зелёные: npm test (1409 pass / 0 fail), wiring 11/11, юнит обёртки 16/16,
   openspec strict valid; живой прогон на D:/tmp/rv-bench до report (exit 0).

## Risks / Trade-offs

- Хеш-подход переносит «владелец видел бриф» в момент фиксации хеша; отказ —
  fail-closed.
- Substring `Brief SHA-256:` в message — сознательно хрупкий контракт: смена
  формата диалога → отказ.
- LLM-транскрипция брифа может дать другие байты draft → отказ exit 1 (fail-closed,
  подтверждено живым прогоном); рецепт обхода — в docs (task 4.1).
