# T7: E2E-тест для SpaceSearch и CheckOrthogonal

**Severity:** 🟢 Low
**Effort:** Large (дизайн теста, реализация, валидация)
**Status:** Draft
**Deps:** —

## Проблема

В E2E-тесте `_parallel_e2e/app.sh` протестированы:
- ✅ BestOfN — 1 раунд, победитель выбран корректно
- ✅ Phases (valley-crossing) — startPhase/commitPhase через valley
- ✅ Git-интеграция — auto-commit/revert работает

НЕ протестированы:
- ❌ CheckOrthogonal — стекающие ортогональные патчи
- ❌ SpaceSearch — beam search с K состояниями
- ❌ valleyProbe — параллельные continuation'ы из checkpoint
- ❌ Budget enforcement — превышение budget_seconds
- ❌ checks_failed handling — оптимизация ломающая correctness

## Решение

### Тест-кейс 1: CheckOrthogonal

**Цель:** Два независимых файла, два ортогональных патча.

```
project/
├── .auto/
│   ├── measure.sh    # суммирует время parse.js + render.js
│   └── checks.sh     # проверяет correctness
├── parse.js           # МОЖНО оптимизировать: for→closed-form
└── render.js          # МОЖНО оптимизировать: string concat→array.join
```

**Гипотезы:**
- Patch A: оптимизация parse.js (file_scope: ["parse.js"])
- Patch B: оптимизация render.js (file_scope: ["render.js"])

**Проверка:**
- [ ] CheckOrthogonal детектит что scope не пересекается
- [ ] Оба патча применяются последовательно
- [ ] Суммарное улучшение ≈ Σ индивидуальных
- [ ] При пересечении scope → отказ

### Тест-кейс 2: SpaceSearch

**Цель:** Мультимодальный ландшафт (несколько локальных оптимумов).

```
project/
├── .auto/
│   ├── measure.sh    # время зависит от выбранной стратегии
│   └── checks.sh     # correctness
├── config.js          # выбор стратегии: brute / hash / sorted
└── data.js            # данные для обработки
```

**Стратегии:**
- Brute force: O(n²) — локальный оптимум при n < 100
- Hash lookup: O(n) — локальный оптимум при n > 1000
- Sorted + binary: O(n log n) — глобальный оптимум

**Проверка:**
- [ ] SpaceSearch init → step → step → finish работает
- [ ] Beam содержит K состояний
- [ ] Diversity hints направляют поиск
- [ ] Regression-lookahead pruning отсекает тупики
- [ ] Winner re-measured на main

### Тест-кейс 3: Budget Enforcement

**Цель:** measure.sh с переменной длительностью.

```
project/
├── .auto/
│   ├── measure.sh    # sleep $((RANDOM % 20)) — 0-20 сек
│   └── checks.sh
└── app.sh
```

**Проверка:**
- [ ] При budget_seconds=5 → experiment killed at 5s
- [ ] `budget_exceeded` status записывается
- [ ] Steer "speed up measure.sh" выдаётся
- [ ] Parallel workers соблюдают индивидуальные бюджеты

### Тест-кейс 4: checks_failed Handling

**Цель:** Оптимизация, которая ломает correctness.

```
project/
├── .auto/
│   ├── measure.sh    # times app.sh
│   └── checks.sh     # strict output check
└── app.sh            # агент пытается "оптимизировать" → wrong output
```

**Проверка:**
- [ ] При wrong output → `checks_failed` status
- [ ] Code changes reverted (как при crash)
- [ ] ASI поля сохраняются
- [ ] Steer не блокирует продолжение

## Структура тестов

```
tests/
├── e2e-orthogonal/
│   ├── README.md       # как запустить
│   ├── setup.sh        # создаёт parse.js + render.js
│   ├── .auto/
│   │   ├── measure.sh
│   │   └── checks.sh
│   └── verify.sh       # проверяет результаты
├── e2e-spacesearch/
│   └── ... (аналогично)
├── e2e-budget/
│   └── ...
└── e2e-checks-failed/
    └── ...
```

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `tests/e2e-orthogonal/*` | Новый тест-кейс (new files) |
| `tests/e2e-spacesearch/*` | Новый тест-кейс (new files) |
| `tests/e2e-budget/*` | Новый тест-кейс (new files) |
| `tests/e2e-checks-failed/*` | Новый тест-кейс (new files) |
| `package.json` | `npm run test:e2e` script |

## Acceptance Criteria

- [ ] CheckOrthogonal: 2 ортогональных патча стекаются, scope-conflict отклоняется
- [ ] SpaceSearch: beam init/step/finish работает, winner re-measured
- [ ] Budget: превышение → kill + steer
- [ ] checks_failed: wrong output → revert, agent может продолжать
- [ ] Все тесты запускаются `npm run test:e2e`
- [ ] Тесты детерминированные (не flaky)

## Out of Scope

- ML training pipeline tests
- Multi-machine distributed tests
- Performance regression tests (только functional)
