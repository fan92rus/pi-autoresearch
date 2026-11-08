# Tasks: Headless-запуск кампаний через RPC-обёртку

## 1. Обёртка `scripts/research-rpc.mjs`
- [x] 1.1 Скрипт: спавн `pi --mode rpc`, JSONL-фрейминг по LF (без readline; U+2028/29 не границы), лог всех записей, консольный tail tool-вызовов.
- [x] 1.2 Каноничность: `--mode research` требует `--brief` + `--approve-sha` (иначе exit 2 до спавна); проверка `bytes === JSON.stringify(JSON.parse(bytes), null, 2) + "\n"` (неканонический → exit 2); трёхсторонняя сверка В МОМЕНТ диалога (диалоговый / `--approve-sha` / пересчитанный из файла): несовпадение → `confirmed:false` → RPC abort → kill после 10с → exit 1, тест ассертит отсутствие research-вызовов после отказа; не-брифовый confirm → `false`.
- [x] 1.3 Sequencing: stage 1 = `/autoresearch research`; ожидание с момента отправки (agent_start может прийти до ответа) — цикл `agent_start` → `agent_settled` (дедлайн отказа: нет agent_start за `--stage1-timeout-sec`, по умолчанию 30 → exit 2; kickoff-ход ограничен общим `--timeout-sec`, exit 3), затем stage 2: путь `--brief`, его sha256, campaign_id (`--campaign-id` или `bench-<yyyymmdd-hhmmss>`), шаги (draft из файла → propose → start expected_sha256 → open → close → stop → report). `queued`/`success:false` на stage-2 prompt → exit 1; на stage-1 → exit 2. Никогда `/autoresearch on` и `/skill:autoresearch-create`. `--mode optimize` — documented scope split: exit 2 с сообщением.
- [x] 1.4 CLI-парсер (`--pi` или `pi` из PATH), таймаут (false → shutdown → kill 10с → exit 3, причина в лог), exit codes 0/1/2/3, сводка в конце.

## 2. Расширение: парсер и kickoff
- [x] 2.1 Подкоманда `research` (точное слово / префикс `research `, хвост — описание): ветвление ДО ветки already-active; guard — отказ при любой существующей кампании (`.auto/research` непуст, briefing включительно); kickoff — research-правила, БЕЗ `/skill:autoresearch-create`.
- [x] 2.3 Регистрация `research` в `commands.ts` SUBCOMMANDS и TUI-автодополнении (config-ui). Примеры optimize-запусков НЕ меняются: без алиаса optimize остаётся free-text, документация остаётся верной.
- [x] 2.5 Тесты wiring (tests/research-subcommand.test.mjs, 11/11): `research` без `/skill:autoresearch-create`; `research my campaign` = кампания; research до already-active; guard на briefing-кампанию (вкл. комбинированный кейс с активным режимом); `optimize research habits` = legacy free-text (регресс); `researcher x` = free-text; SUBCOMMANDS содержит research; edge-кейсы: tab, uppercase RESEARCH.

## 3. Тесты обёртки
- [x] 3.1 Юнит: каноничность файла (exit 2; пустой/BOM → exit 2); валидация `--approve-sha` (`^[0-9a-f]{64}$`) и `--campaign-id` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) → exit 2; три хеша (совпали → true; операторский ≠ диалоговый → false+abort+exit 1; диалоговый ≠ файловый в момент ответа → false+abort+exit 1; не-брифовый → false без exit 1); timeout → exit 3; exit codes 0/1/2/3; sequencing: ожидание с момента отправки (agent_start до ответа), дедлайн agent_start → exit 2, settled без успеха → exit 3, queued/success:false на stage 2 → exit 1; `--hold-dialog-ms`; research без `--brief`/`--approve-sha` → exit 2; сборка stage-2 (путь, хеш, campaign_id, шаги); research exit 0 = report с пустым details.reason (отказавший report не даёт exit 0); unexpected pi exit → pi_exited в логе + exit 3; win32 `.cmd`-шим запускается end-to-end (windowsVerbatimArguments); draft-байты == байтам `--brief` (канонический файл); бриф удалён при висящем диалоге → exit 1.
- [x] 3.2 Live-верификация вместо CI-E2E (реальный pi в RPC-режиме слишком тяжёл для сьюта): живой прогон на D:/tmp/rv-bench закрыл те же кейсы — кампания до report (exit 0), чужой sha → отказ+abort+exit 1 (первый прогон: LLM-транскрипция брифа реально отказана).

## 4. Документация
- [x] 4.1 `docs/research-vectors.md`: раздел Headless launch — RPC-обёртка, трёхсторонняя сверка, границы (briefing не блокирует git, перехват best-effort), `--brief` обязателен, РЕЦЕПТ канонического брифа: LLM перепечатывает JSON (строки→массивы, ключи по алфавиту) — оператор сначала даёт агенту сделать draft, затем копирует .auto/research/<id>/brief.json как эталонный --brief и пересчитывает sha256.
- [x] 4.2 НЕ требуется: optimize-алиас не реализован, документированные примеры optimize-запусков остаются верными как есть.

## 5. Проверка
- [x] 5.1 Полный npm test зелёный (1409 pass / 0 fail; test:upstream не затронут — optimize-алиас не менял legacy-поток); openspec validate --strict valid.
- [x] 5.2 Живой прогон на песочнице D:/tmp/rv-bench: кампания bench-20261108 — confirmed:true, q1-confirmed (7 ERROR), q2-waiting_for_data, stop-all-closed, report наблюдён, WRAPPER_EXIT=0.
