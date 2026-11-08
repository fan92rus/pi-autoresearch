# Tasks: Headless-запуск кампаний через RPC-обёртку

## 1. Обёртка `scripts/research-rpc.mjs`
- [ ] 1.1 Скрипт: спавн `pi --mode rpc`, JSONL-фрейминг (LF, без readline-сплиттеров U+2028/29), лог всех записей, консольный tail tool-вызовов.
- [ ] 1.2 Обработчик `extension_ui_request`: confirm по брифу — сверка SHA-256 (`Brief SHA-256: <hex>` в сообщении) с `PI_RPC_AUTO_APPROVE`/`--approve-sha`; чужой/отсутствующий хеш → `confirmed:false` + запись в лог; не-брифовые confirm → `false`; notify/widget — игнор с логом.
- [ ] 1.3 Kickoff-режимы: `--mode research` (draft→propose→start→open→close→stop→report, хеш из файла брифа) и `--mode optimize "<goal>"` (`/autoresearch <goal>`).
- [ ] 1.4 CLI-парсер, таймаут, коды выхода, сводка в конце (что произошло, где лог).

## 2. Расширение: kickoff для research
- [ ] 2.1 `/autoresearch research`: активирует режим, отправляет research-kickoff БЕЗ `/skill:autoresearch-create`; guard против существующей research-кампании (reuse `researchBlocksOrdinaryLoop`).
- [ ] 2.2 Тест wiring: `/autoresearch research` НЕ содержит `/skill:autoresearch-create` в отправленном сообщении и содержит упоминание research_brief/research последовательности.

## 3. Тесты обёртки
- [ ] 3.1 Юнит: парсер запросов, решение confirm (совпал/чужой/не-бриф), сборка kickoff-текстов обоих режимов.
- [ ] 3.2 E2E (спавн настоящего pi, `skip` без `PI_RPC_E2E=1`): tmp-песочница, research-сессия с auto-approve доходит до phase research; чужой sha — кампания остаётся briefing.

## 4. Документация
- [ ] 4.1 `docs/research-vectors.md`: раздел Headless launch (RPC, auto-approve по хешу, границы).
- [ ] 4.2 Общий headless-раздел (optimize + research) — в docs; пример команды запуска.

## 5. Проверка
- [ ] 5.1 Полный npm test зелёный; openspec validate --strict valid.
- [ ] 5.2 Живой прогон на песочнице D:/tmp/rv-bench: research-кампания под контролем обёртки (ручная проверка владельцем или ассистентом с логом).
