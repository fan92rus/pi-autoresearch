# Tasks: читаемое согласование брифа

## 1. Реализация
- [x] 1.1 Вместо pi.sendMessage (отложен до конца хода): строка вызова research_brief propose (renderCall) с полным брифом в читаемом виде и SHA-256, видна до диалога.
- [x] 1.2 Сводка 1–10 строк из брифа; первая строка `Brief SHA-256: <hex>`.

## 2. Тесты
- [x] 2.1 Строка вызова с брифом содержит goal и SHA (тест). Порядок «строка до диалога» подтверждён чтением кода pi (tool_execution_start → renderCall до execute → confirm), тестом не доказан.
- [x] 2.2 Текст диалога ≤ 10 строк, первая строка — SHA.
- [x] 2.3 Подтверждение/отказ и approval.json без изменений.
- [x] 2.4 Wrapper-suite зелёный (регрессия DIALOG_SHA_RE).

## 3. Гейты
- [x] 3.1 Полный прогон по файлам (serial, 68 файлов): 1435 pass / 0 fail. Параллельный `npm test` зависает и флейкает под нагрузкой (z3o, observation_lock_busy) — отдельная задача.
- [x] 3.2 `openspec validate brief-consent-summary --strict` зелёный.
