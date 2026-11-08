# Tasks: Headless-запуск кампаний через RPC-обёртку

## 1. Обёртка `scripts/research-rpc.mjs`
- [ ] 1.1 Скрипт: спавн `pi --mode rpc`, JSONL-фрейминг по LF (без readline; U+2028/29 не границы), лог всех записей, консольный tail tool-вызовов.
- [ ] 1.2 Каноничность: `--mode research` требует `--brief` + `--approve-sha` (иначе exit 2 до спавна); проверка `bytes === JSON.stringify(JSON.parse(bytes), null, 2) + "\n"` (неканонический → exit 2); трёхсторонняя сверка В МОМЕНТ диалога (диалоговый / `--approve-sha` / пересчитанный из файла): несовпадение → `confirmed:false` → RPC abort → kill после 10с → exit 1, тест ассертит отсутствие research-вызовов после отказа; не-брифовый confirm → `false`.
- [ ] 1.3 Sequencing: stage 1 = `/autoresearch research`; ожидание — `data.disposition` (`started` → `agent_settled`, `handled` → сразу), затем stage 2: путь `--brief`, его sha256, campaign_id (`--campaign-id` или `bench-<yyyymmdd-hhmmss>`), шаги (draft из файла → propose → start expected_sha256 → open → close → stop → report). `--mode optimize "<goal>"` = `/autoresearch optimize <goal>`. Никогда `/autoresearch on` и `/skill:autoresearch-create`.
- [ ] 1.4 CLI-парсер (`--pi` или `pi` из PATH), таймаут (false → shutdown → kill 10с → exit 3, причина в лог), exit codes 0/1/2/3, сводка в конце.

## 2. Расширение: парсер и kickoff
- [ ] 2.1 Подкоманда `research` (точное слово / префикс `research `, хвост — описание): ветвление ДО ветки already-active; guard — отказ при любой существующей кампании (`.auto/research` непуст, briefing включительно); kickoff — research-правила, БЕЗ `/skill:autoresearch-create`.
- [ ] 2.2 Алиас `/autoresearch optimize <goal>`: проверяется ДО зарезервированной ветки; слово `optimize` отбрасывается, хвост — полная цель metric-loop; отказ без цели.
- [ ] 2.3 Регистрация `research` и `optimize` в `commands.ts` SUBCOMMANDS (help/completions); обновление двух документированных примеров optimize-запуска (commands.ts:30, index.ts:2742) под новую семантику.
- [ ] 2.4 Тесты wiring: `research` без `/skill:autoresearch-create`; `research something` = кампания `something`; research до already-active; guard на briefing-кампанию; `optimize research habits` = metric-loop с полной целью; SUBCOMMANDS содержит обе; edge-кейсы: tab после `research`, `optimize` без цели, lowercase.

## 3. Тесты обёртки
- [ ] 3.1 Юнит: каноничность файла (exit 2); три хеша (совпали → true; операторский ≠ диалоговый → false+abort+exit 1; диалоговый ≠ файловый в момент ответа → false+abort+exit 1; не-брифовый → false); timeout → exit 3; exit codes 0/1/2/3; sequencing disposition+agent_settled и ветка handled; сборка stage-2 (путь, хеш, campaign_id, шаги).
- [ ] 3.2 E2E (`PI_RPC_E2E=1`, иначе skip; CLI из `--pi` или PATH): research до phase research без «mode OFF» отказов; чужой sha → отказ + abort + exit 1 + нет research-вызовов после; мутация файла при висящем диалоге → отказ при ответе; optimize-прогон наполняет `.auto/log.jsonl`.

## 4. Документация
- [ ] 4.1 `docs/research-vectors.md`: раздел Headless launch (RPC, трёхсторонняя сверка, канонизация брифа однострочником, границы: briefing не блокирует git, перехват best-effort, `--brief` обязателен).
- [ ] 4.2 Общий headless-раздел (optimize + research): примеры команд; зарезервированное слово `research` и алиас `optimize` — в том числе для TUI-пользователей (изменение TUI-поведения и обновлённые примеры задокументированы).

## 5. Проверка
- [ ] 5.1 Полный npm test зелёный; openspec validate --strict valid.
- [ ] 5.2 Живой прогон на песочнице D:/tmp/rv-bench: research-кампания под контролем обёртки (лог сохраняется, кампания доходит до report).
