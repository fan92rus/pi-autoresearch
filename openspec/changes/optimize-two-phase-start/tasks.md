# Tasks: двухфазный запуск обычной оптимизации (MVP)

Отметки честные: `[x]` означает, что есть тест или проверка команды. Если доказано только чтением кода, это написано в строке.

## 1. Бриф и черновик

- [x] 1.1 Схема брифа: поля `name`, `metric_name`, `metric_unit`, `direction`, `cwd`, отказ на неизвестные поля. Тест: unknown field (tests/optimize-two-phase-start.test.mjs).
- [x] 1.2 Канонизация и запись `.auto/optimize/brief.json`. Тест: канонические байты не зависят от порядка ключей.
- [x] 1.3 Тесты: канонические байты; неизвестное поле отклоняется, файл не пишется.

## 2. Согласование

- [x] 2.1 Инструмент `optimize_brief` с действиями `draft` и `propose`; renderCall строки с полным брифом. Тест проверяет содержимое строки. Порядок «строка до диалога» подтверждён чтением кода pi (как у research_brief), тестом не доказан.
- [x] 2.2 Диалог: сводка до 10 строк, первая строка `Brief SHA-256: <hex>`. Тест: optimizeConsentSummary (unit).
- [x] 2.3 Запись `approval.json` (`confirmed: true|false`, SHA). Тесты: отказ пишет confirmed:false, init отказывает.
- [x] 2.4 Тесты: отказ, правка после одобрения (stale_approval), повторный draft после отказа (unit).

## 3. Старт

- [x] 3.1 `init_experiment` проверяет `approval.json` и SHA. Тест happy path: draft → propose → init. Порядок «проверка до любой записи в log.jsonl» подтверждён чтением кода (optimizeStartGate стоит до writeConfig).
- [x] 3.2 Совпадение полей вызова с брифом. Тест: mismatch metric_name, init отказывает с перечнем различий.
- [x] 3.3 Старые сессии работают без брифа (D1). Прямой тест: "D1: a legacy session with a config header" — журнал с заголовком конфигурации без .auto/optimize/, resume init с теми же полями и run_experiment не просят бриф. Косвенно подтверждают и фикстуры lens, measurement, smoke.
- [x] 3.4 Тесты: happy path, mismatch, отказ без брифа.

## 4. Гейты и изоляция

- [x] 4.1 `run_experiment` до старта отказывает с подсказкой шага. Тест: next step is optimize_brief draft. `log_experiment` защищён тем же гейтом (чтением кода).
- [x] 4.2 Кампании: тест "campaign isolation" (tests/optimize-two-phase-start.test.mjs) — активная research-кампания отказывает optimize_brief, init и run без записи optimize-состояния и журнала. Тесты research-суит зелёные отдельно.
- [x] 4.3 `scripts/research-rpc.mjs` не менялся: `git diff -- scripts/` пуст.
- [x] 4.4 Смена `metric_name`, `direction` или `name` (цели) после старта требует нового согласования. Тесты: "4.4: changing metric_name", "direction after start", "name change after the start" — отказ без новой строки в журнале, одобренная смена даёт ровно один новый заголовок. Тесты стоят в начале файла (модульное _customWorkDir).

## 5. Промпт и документация

- [x] 5.1 Стартовая инструкция (блок режима автоисследования в before_agent_start) указывает порядок `optimize_brief draft` → `propose` → `init_experiment` и отказ run/log до старта. Тест: "5.1: the ordinary-loop system prompt states the order" проверяет порядок подстрок в системном промпте.
- [x] 5.2 `docs/optimize-two-phase-start.md`: порядок, решения D1–D4, остаточный риск подмены файлов.

## 6. Гейты и выпуск

- [x] 6.1 Серийный прогон всех 69 `tests/*.test.mjs` по одному: rc=0 у каждого. Полный параллельный `npm test` не использовался (зависает, флейк z3o). Раунд 2 ревью: полный серийный прогон 69 файлов после правок; tests/research-state.test.mjs один раз упал под нагрузкой полного прогона, изолированно 52/52 и на базе fc26757 зелёный, это флейк, не регресс.
- [x] 6.2 `openspec validate optimize-two-phase-start --strict`: valid.
- [x] 6.3 Независимое ревью свежим субагентом на `anthropic/claude-haiku-5-5`. Пять ревью: b2109ec6 НЕ ГОДЕН (B1–B3), 2d767151 НЕ ГОДЕН (B2, B4, M1, M2), d37c2f7b НЕ ГОДЕН (cwd ""), 1c3481b9 ГОДЕН (коммит 7b717ae), ecb607a0 НЕ ГОДЕН (B1: тест D1 стоял после закрепляющих тестов и проверял тривиальное). B1 закрыт переносом тестов 5.1 и D1 в начало файла и проверкой run_started в собственном журнале (коммит 5d1e1b6, 26/26). Повторного ревью после 5d1e1b6 нет: превышен лимит «одно ревью в конце» из цели. Остаточные миноры: cwd из невидимых символов формата (\p{Cf}: U+200B, U+2060, U+180E, U+00AD, U+200E и др.) отвергается как пустой; тесты покрывают эти символы; тесты покрывают cwd "", пробелы и невидимые символы.
- [x] 6.4 Точечные коммиты (24bdce4, 5e68dde, 9a749ca, 5102196, 41226d0, 7b717ae), bd pi-autoresearch-8p3, push в origin/master.
