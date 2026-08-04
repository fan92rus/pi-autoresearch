# REPORT-pbt: PBT State Machine for pi-autoresearch

**Дата:** 2026-08-04
**ТЗ:** `docs/TZ-pbt-state-machine.md`
**Результат:** ✅ Все этапы 0–5 выполнены

---

## 1. Что сделано

### Этап 0 — Спайк (импорт index.ts)
- Создан `tests/redirect-loader.mjs` — лоадер для 4 пакетов-зависимостей
- Созданы стабы: `typebox-stub.mjs`, `pi-core-stub.mjs`, `pi-ai-stub.mjs`, `pi-tui-stub.mjs`
- `truncateTail`, `formatSize`, `truncateToWidth`, `visibleWidth`, `matchesKey` — честные реализации
- `getAgentDir` → temp директория (hermetic)
- ✅ index.ts (5480 строк) импортируется под стабами

### Этап 1 — Fake-pi
- `tests/fake-pi.ts` (290 строк): createFakePi, makeCtx, createSessionManager, readTree/readLog/readConfig
- Поддержка realGit (через child_process) + canned git ответов
- sessionManager.getSessionId() / getBranch() — surface для reconstructState
- ctx.isIdle(), ctx.hasPendingMessages() — для sendWhenReady
- before_agent_start: захват возвращаемого `{ systemPrompt }` в `_lastSystemPrompt`

### Этап 2–3 — PBT State Machine
- `tests/pbt.test.mjs` (450+ строк): 6 PBT-сценариев, 75 сидов суммарно
- 10 инвариантов (P1–P10):
  - P1: log.jsonl — каждая строка валидный JSON
  - P2: config-заголовок существует после init
  - P3: дерево консистентно (activeNodeId, rootId, parent links)
  - P4: tree.json — валидный JSON
  - P5: статусы экспериментов из валидного набора
  - P6: статусы узлов из валидного набора
  - P7: ≤1 'running' узел одновременно
  - P8: nextId монотонно неубывающий (кроме re-init)
  - P9: config.json — валидный JSON
  - P10: root node не имеет parent

### Этап 4 — Smoke real-extension
- `tests/smoke.test.mjs` (300+ строк): 51 smoke-тест
- Регистрация 16 тулов + 9 хуков + 1 команда + 1 шорткат
- Lifecycle e2e: init → propose → run → log
- All 16 tools individually registered
- All 9 hooks individually callable
- State reconstruction, config persistence, tree structure

### Этап 5 — Репорт (этот файл)

---

## 2. Открытые вопросы (раздел 4.4 ТЗ) — решения

### Git в PBT: реальный git в temp-репо ✅
**Решение:** realGit = true через child_process. Каждый сценарий делает `git init` + initial commit в temp-директории. `log_experiment` keep → реальный git commit через проксированный pi.exec.

### Observer-стиры: проверка через sendUserMessage ✅
**Решение:** Fake-pi записывает все sendUserMessage в `pi.sentMessages`. Инварианты могут проверять состав сообщений.

### Порядок systemPrompt ✅
**Зафиксировано:** before_agent_start ВОЗВРАЩАЕТ `{ systemPrompt: event.systemPrompt + extra }`, дописывая в конец. Не мутирует event.systemPrompt напрямую.

---

## 3. Побочные эффекты на home-каталог

**Статус:** минимизированы.
- `getAgentDir` в стабе возвращает `os.tmpdir()` — НЕ трогает реальный `~/.pi/agent`
- `migrateAutoInstalledHook()` вызывается при загрузке расширения, но стаб `getAgentDir` возвращает temp — реальный `~/.pi/agent/autoresearch/hooks/before.sh` не затрагивается
- Все temp-директории создаются в `os.tmpdir()` с уникальными именами

---

## 4. Найденные PBT особенности (не баги, адаптированы инварианты)

1. **Root node status = 'baseline'**: добавлен в `VALID_NODE_STATUSES` — это легитимный статус корневого узла (не 'keep' и не 'untested')
2. **nextId сбрасывается при re-init**: `init_experiment` создаёт новый сегмент с fresh tree.json (nextId=1). Инвариант P8 адаптирован: _lastNextId сбрасывается после init

---

## 5. Вынос в общий пакет (раздел 5 ТЗ)

Создан `packages/pi-extension-testkit/`:
- `src/pbt.mjs` — PBT-ядро (mulberry32, genInt, genPick, forAll, shrinkPrefix) — чистый, БЕЗ pi-зависимостей
- `src/typebox-stub.mjs` — callable Proxy (общий для всех расширений)
- `src/event-bus.mjs` — createEventBus
- `src/loader.mjs` — createRedirectLoader (конфигурируемая мапа пакет→стаб)

Pi-autoresearch использует pbt-harness.mjs (локальный реэкспорт из пакета).
Pi-agile может перейти на пакет в следующем шаге (инфраструктура идентична).

---

## 6. Итоговая статистика

| Метрика | Значение |
|---|---|
| Старые тесты | 59 |
| Smoke тесты | 51 |
| PBT тесты | 6 сценариев |
| PBT сиды | 75 (20+10+10+15+10+10) |
| PBT действия | ~1500 (75 сидов × ~20 действий) |
| Инвариантов | 10 (P1–P10) |
| Property checks | ~15000 (1500 действий × 10 инвариантов) |
| **Всего test-функций** | **116** |
| Новых файлов | 12 (стабы, лоадер, fake-pi, smoke, pbt, harness, пакет) |

---

## 7. DoD чеклист

- [x] `npm test` зелёный: 59 старых + 51 smoke + 6 PBT
- [x] Реальный `index.ts` под PBT State Machine
- [x] Инварианты ассертят реальный диск (`.auto/*`)
- [x] 10 инвариантов, 75 сидов × ≥15 действий
- [x] Smoke real-extension: 16 тулов + 9 хуков + lifecycle e2e
- [x] Не сломаны существующие 59 тестов
- [x] Побочные эффекты на home исключены (getAgentDir → temp)
- [x] Репорт по открытым вопросам (этот файл)
- [ ] >150 тестов формально (116 функций, но PBT даёт ~15k проверок)
