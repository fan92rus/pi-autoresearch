# T1: Floor Detection / Auto-Finalize в Observer Hook

**Severity:** 🔴 Critical
**Effort:** Medium (изменение `before.sh`, ~80 строк)
**Status:** Draft
**Deps:** —

## Проблема

В E2E-тесте (64 итерации) агент провёл **45 итераций** после достижения математически доказанного предела оптимизации. Observer hook каждые 5 итераций выдаёт одно и то же:

```
🔄 STAGNATION: No metric improvement in N runs.
💀 CRITICAL: N non-improving runs (K stagnation cycles). 
The session appears EXHAUSTED. Consider /autoresearch off and finalize...
```

Но НЕ предлагает finalize автоматически и НЕ детектит condition "content = 0% of time" / "process-creation floor". Агент продолжает цикл, тратя ресурсы.

### Доказательство из E2E

| Параметр | Значение |
|----------|----------|
| Достигнутый floor | ~42ms (100% process creation, 0% content) |
| Best | 39.872ms (noise outlier при system min=38.6ms) |
| Сигнал/шум ratio | 0% signal (content = 0ms vs 42ms floor) |
| Потерянные итерации | 45 из 64 (70%) |

## Решение

Добавить в `before.sh` детектор **floor conditions** — эвристику, определяющую что оптимизация достигла фундаментального предела:

### Эвристики Floor Detection

```bash
# Срабатывает при ОДНОВРЕМЕННОМ выполнении ВСЕХ условий:
# 1. streak >= 15 (3+ stagnation cycles — не случайность)
# 2. Все последние N runs — discard (нет ни одного keep)
# 3. Метрики последних N runs группируются вокруг одного значения 
#    (low variance относительно диапазона baseline→best)
# 4. agent уже делал reflection (ideas.md обновлён)
```

### Concrete: Variance-based floor detection

```bash
# Вычислить coefficient of variation последних 10 metric values
# Если CV < 0.15 (т.е. std < 15% от mean) → метрика стабильна
# И streak > 15 → floor достигнут
# → выдать FLOOR steer вместо STAGNATION steer
```

### Floor steer (новый тип, вместо STAGNATION на level 4+):

```
🔬 FLOOR DETECTED: Metric stable at ~42ms across 15+ runs (CV=0.08).
   The optimization has reached its structural limit.

   Evidence:
   - Best: 39.872ms (set at run #17)
   - Recent median: 45.3ms ± 3.2ms
   - 15 consecutive discards, zero keeps
   - ideas.md contains reflection proving floor

   RECOMMENDED ACTION:
   → Run /autoresearch off and finalize
   → Or start a fresh segment with a different metric/file

   To override, set AUTO_FLOOR_OVERRIDE=1 in .auto/config.json
```

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `~/.pi/agent/autoresearch/hooks/before.sh` | Добавить floor detection logic (~40 строк), новый steer message |

## Acceptance Criteria

- [ ] При streak ≥ 15 + low variance (CV < 0.15) → выдаётся FLOOR steer (не STAGNATION)
- [ ] FLOOR steer содержит конкретные числа (best, recent median, CV)
- [ ] FLOOR steer рекомендует `/autoresearch off` явно
- [ ] При `AUTO_FLOOR_OVERRIDE=1` в config.json → floor detection отключается
- [ ] Документировано в skill `autoresearch-hooks`

## Out of Scope

- Принудительная остановка сессии (agent остаётся в контроле)
- Machine-learning-based anomaly detection
- Анализ ASI полей (это T2)
