# Tasks: Headless-запуск кампаний через RPC-обёртку

## 1. Обёртка `scripts/research-rpc.mjs`
- [ ] 1.1 Скрипт: спавн `pi --mode rpc`, JSONL-фрейминг по LF (без readline; U+2028/29 не границы записей), лог всех записей, консольный tail tool-вызовов.
- [ ] 1.2 Обработчик `extension_ui_request`: трёхсторонняя сверка (метод confirm + `Brief SHA-256: <hex>` в message + hex == `--approve-sha` + hex == sha256 файла `--brief` при старте); любое несовпадение → `confirmed:false`, завершение сессии с ненулевым кодом; не-брифовый confirm → `false`; notify/widget — игнор с логом.
- [ ] 1.3 Kickoff-режимы: `--mode research` (после `/autoresearch on` ждать первый `agent_end`, затем текст: draft→propose→start `expected_sha256=<hash>`→open→close→stop→report; хеш — sha256 байтов файла тем же алгоритмом, что `sha256Hex`) и `--mode optimize "<goal>"` (`/autoresearch <goal>`).
- [ ] 1.4 CLI-парсер (`--pi` или `pi` из PATH), таймаут: при висящем confirm ответить `confirmed:false`, shutdown pi, kill после 10с, код выхода 3, причина `timeout` в лог; сводка в конце.

## 2. Расширение: kickoff для research
- [ ] 2.1 `/autoresearch research` (точное слово или префикс `research `; хвост — описание кампании): активирует режим, отправляет research-kickoff БЕЗ `/skill:autoresearch-create`; guard против существующей research-кампании (reuse `researchBlocksOrdinaryLoop`).
- [ ] 2.2 Тесты wiring: `/autoresearch research` НЕ содержит `/skill:autoresearch-create` и содержит последовательность research_brief/research; `/autoresearch research something` = research-кампания с темой `something` (зарезервированное слово, документировано).

## 3. Тесты обёртки
- [ ] 3.1 Юнит: парсер запросов; решение confirm (совпал / чужой диалоговый / файловый ≠ диалоговый → отказ с ненулевым кодом / не-брифовый → false); timeout с висящим confirm (false → shutdown → kill → код 3); сборка kickoff-текстов; последовательность mode-flip → agent_end → kickoff.
- [ ] 3.2 E2E (спавн настоящего pi; CLI из `--pi`, иначе `pi` из PATH; `skip` без `PI_RPC_E2E=1`): research-сессия с auto-approve доходит до phase research, в логе нет отказов «mode OFF»; чужой sha — кампания остаётся briefing; файл брифа изменён после kickoff — отказ до confirm.

## 4. Документация
- [ ] 4.1 `docs/research-vectors.md`: раздел Headless launch (RPC, auto-approve по трёхсторонней сверке хеша, границы: briefing не блокирует git, перехват best-effort).
- [ ] 4.2 Общий headless-раздел (optimize + research) — в docs; примеры команд; ограничение зарезервированного слова `research`.

## 5. Проверка
- [ ] 5.1 Полный npm test зелёный; openspec validate --strict valid.
- [ ] 5.2 Живой прогон на песочнице D:/tmp/rv-bench: research-кампания под контролем обёртки (лог сохраняется, кампания доходит до report).
