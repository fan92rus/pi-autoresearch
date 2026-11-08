# Proposal: Brief-declared verdicts + test-split gate (MVP для запуска на lob-collector-data)

## Why

Аудит применения research-режима к lob-collector-data (bd pi-autoresearch-p40) нашёл
три P0/P1. Два закрыты (--state-root в 47eebb7, report/findings там же). Осталось:

1. **P0-3, словарь вердиктов.** Протокол lob (research/protocol.md, секция 10)
   запрещает уровень «confirmed» — максимум строгости там «test-consistent».
   Захардкоженный enum режима (`confirmed|rejected|inconclusive|waiting_for_data`,
   research-state.ts:56) не соответствует, и каждый вердикт кампании на lob
   лжёт терминологией протокола. Владелец решил (2026-11-08): **бриф объявляет
   собственные имена вердиктов**, close валидирует по брифу.
2. **P1, test-split gate.** Протокол lob (секция 11) требует, чтобы тестовый
   сплит открывался ровно один раз и только после записанного `TEST_GATE`.
   Режим это никак не контролирует — агент может записать evidence из test-файлов
   раньше времени. Владелец решил (2026-11-08): **механическое запрещение** —
   правило в брифе, проверка в `record`.
3. Организационное (вне кода): перед первой кампанией на lob владелец поставит
   на паузу активную цель mw58qmdm-ctc7hr (autoContinue, два агента в одном репо
   гоняются за файлы и GPU-время).

## Решения владельца (зафиксированы)

1. Brief-declared verdicts — да (выбран «правильный» вариант из двух
   предложенных; caveat-оговорка отвергнута).
2. Test-split gate — да, механический, enforced в record.
3. Пауза цели mw58qmdm перед запуском — да (операционное действие владельца,
   не код).

## Scope: MVP, минимум

Входят только три вещи ниже. Всё остальное — out of scope: переименование
существующих вердиктов в старых кампаниях, миграции state/log, изменения
парсера `/autoresearch`, wrapper (research-rpc.mjs), ordinary-loop
(record_finding), doc-переписывания кроме одной секции research-vectors.md.

## Что меняется (три механики)

### A. Brief-declared verdicts

- Бриф получает ОДНО новое необязательное поле `verdicts` — массив строк
  (не пустой, уникальные, id-совместимые токены). Нет поля → дефолт
  `["confirmed", "rejected", "inconclusive", "waiting_for_data"]` (обратная
  совместимость: все существующие брифы и кампании валидны без изменений).
- Правило «минимум по одному rule на каждый verdict вопроса» (research-state
  validateQuestion:737) применяется к declared-набору: каждый вопрос обязан
  иметь правило на КАЖДЫЙ вердикт из `brief.verdicts` — не больше и не меньше.
- `research close` принимает только вердикт из `brief.verdicts`; правило
  `rule.verdict === verdict` сверяется как сейчас.
- Ветки причин и маршрутизация находок работают по **буквальным именам** вердиктов
  (как сейчас): reason обязателен для `inconclusive` и `waiting_for_data`;
  находки пишутся только для `confirmed` и `rejected`. Для lob это значит, что
  вердикт `test-consistent` не попадёт в findings.jsonl — это явное ограничение
  MVP, записывается в research-vectors.md, а не лечится кодом.

### B. Test-split gate (evidence gate)

- Бриф получает ОДНО новое необязательное поле `evidence_gate`:
  `{ "blocked_globs": [...], "gate_file": "path", "gate_contains": "TEXT" }`.
  Нет поля → проверка не активна (существующие брифы не меняются).
- `research record`: перед записью evidence если файл под evidence_path
  матчится хотя бы один glob из `blocked_globs` — требуется, чтобы файл
  `gate_file` существовал и содержал подстроку `gate_contains`; иначе отказ
  `evidence_gate_blocked` с текстом «test-split evidence before gate; create
  <gate_file> containing <gate_contains> after the leakage pass».
- Проверка — только на `record`. open/close/report не проверяются; содержимое
  НЕ анализируется глубже подстроки; анкоры/строки не проверяются. Glob —
  минимальный matcher (точный сегмент или `*` внутри одного сегмента, `**`
  между сегментами), никаких внешних библиотек.

### C. Операционный шаг (не код)

Перед первой lob-кампанией владелец ставит goal mw58qmdm-ctc7hr на паузу
(pi goal pause) и подтверждает это в чате. Без этого кампанию не запускать.

## Acceptance

1. Lob-бриф с `"verdicts": ["test-consistent", "rejected", "inconclusive",
   "waiting_for_data"]` и `"evidence_gate"` на `episodes_test.jsonl` валиден;
   `close` с `test-consistent` принимается, с `confirmed` — отказ.
2. Бриф без новых полей ведёт себя байт-в-байт как сегодня (все существующие
   суиты зелёные без правок).
3. record по test-глобу без gate-файла отказывается; после записи gate-файла —
   проходит.
4. Полный npm test зелёный; new tests: verdicts declaration (валидация,
   close-accept/close-refuse, дефолт) + evidence gate (block/pass/no-op).
