# Tasks: E2E Feedback — Parallel Modes Quality Improvements

**Дата:** 2026-07-23
**Источник:** 64-iteration E2E test (`_parallel_e2e/app.sh` latency optimization)
**Статус:** ✅ Implemented (commit 7d0c779, merged to master 7d7cc1d)

---

## Summary

После 64 итераций E2E-теста параллельных режимов (BestOfN, phases, git-интеграция — ✅ работают), обнаружены системные слабые места в observer-loop и measurement pipeline. Задачи ниже приоритизированы по impact × effort.

## Приоритизация

| ID | Заголовок | Severity | Effort | Deps |
|----|-----------|----------|--------|------|
| T1 | Floor detection / auto-finalize в observer hook | 🔴 Critical | M | — |
| T2 | Observer: ASI-context-aware steers | 🔴 Critical | M | T1 |
| T3 | Checks timeout false positive (race condition) | 🟡 High | S | — |
| T4 | Agent-driven finalize signal | 🟡 Medium | S | T1 |
| T5 | Confidence score: per-run вместо global | 🟡 Medium | S | — |
| T6 | Noise-gate: pre-flight skip при noise > best | 🟡 Medium | S | — |
| T7 | E2E-тест для SpaceSearch и CheckOrthogonal | 🟢 Low | L | — |

## Детали

Каждая задача — отдельный `.md` файл:

- [T1 — Floor Detection](./01-floor-detection.md)
- [T2 — ASI-Context-Aware Steers](./02-asi-aware-steers.md)
- [T3 — Checks Timeout Race Condition](./03-checks-timeout-race.md)
- [T4 — Agent-Driven Finalize Signal](./04-agent-finalize-signal.md)
- [T5 — Per-Run Confidence Score](./05-per-run-confidence.md)
- [T6 — Noise Gate Pre-Flight](./06-noise-gate.md)
- [T7 — SpaceSearch/Orthogonal E2E Test](./07-spacesearch-orthogonal-e2e.md)

## Рекомендуемый порядок имплементации

```
Phase 1 (quick wins):    T3 → T5 → T6
Phase 2 (core fix):      T1 → T4 → T2
Phase 3 (coverage):      T7
```

## Карта зависимостей

```
T1 ──┬──> T2
     └──> T4
T3 (independent)
T5 (independent)
T6 (independent)
T7 (independent)
```
