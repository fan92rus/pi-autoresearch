# ТЗ: autiresearch_optimize — триггер для main-agent цикла

**Версия:** 1.0  
**Scope:** v1 — main-agent-driven, без subagent, без worktree  
**Статус:** Draft  

---

## 1. Концепция

Главный агент (main agent) сам управляет циклом оптимизации, используя существующие инструменты. Tool `autoresearch_optimize` — только **триггер**: настраивает сессию, записывает baseline, даёт пошаговую инструкцию followUp.

```
Агент в работе:
  "модуль X тормозит"
  → autiresearch_optimize({...})
     │ 1. init_experition
     │ 2. baseline (run + log)
     │ 3. followUp с workflow
     └──→ Агент сам делает цикл:
            profile → propose → edit → run → log → tree_status → profile → ...
```

Всё остальное — уже существующие инструменты (`propose_hypothesis`, `run_experiment`, `log_experiment`, `tree_status`, `explore_from`). Ничего нового в инфраструктуре не нужно.

---

## 2. Tool API

```typescript
interface AutoresearchOptimizeParams {
  // Обязательные
  name: string;                 // "Render optimization"
  measure_command: string;      // "node bench.js" — что запускать
  metric_name: string;          // "total_µs"
  direction: "lower" | "higher";

  // Опциональные рамки
  goal_threshold?: number;      // 12000 — цель, при достижении стоп
  max_experiments?: number;     // default: 20
  files_in_scope?: string[];    // ["src/render/"]
  constraint_entities?: string[]; // ["quality"] — метрики которые нельзя ухудшать
  constraint_threshold?: number;  // default: 0.95
  hypothesis_hints?: string[];    // подсказки
  do_not_retry?: string[];        // тупики
 
  // Рабочая директория
  work_dir?: string;            // если не ctx.cwd
}
```

Возврат — простой статус:

```typescript
{
  status: "started" | "error",
  baseline_metric: 45,
  experiment_count: 1,
  message: "Optimization session started. Follow the workflow in the instructions above.",
  error?: string
}
```

---

## 3. Реализация

### 3.1 Где

Один блок в `index.ts` — новый gated tool:

```
Файл:        extensions/pi-autoresearch/index.ts
Добавить:    AutoresearchOptimizeParams (Type.Object)
Добавить:    handler (регистрация + execute)
Итого:       ~50-60 LOC
```

### 3.2 Handler (псевдокод)

```
execute(ctx, params):
  1. Валидация
     - name не пустой
     - measure_command не пустой
     - metric_name не пустой
     - direction ∈ ["lower", "higher"]
     - max_experiments ≥ 1 (default 20)

  2. Настройка сессии
     - Если есть .auto/config.json — проверяем что нет уже активной сессии
       (нет running-гипотезы). Если active → error "Session already in progress"
     - Записываем optimize_config в .auto/config.json:
       { name, goal_threshold, constraint_entities, constraint_threshold,
         files_in_scope, hypothesis_hints, do_not_retry, max_experiments,
         optimize_active: true }

  3. Создание measure.sh (если не существует)
     - Если .auto/measure.sh уже есть → не трогаем (может быть другая сессия)
     - Если нет: создаём .auto/measure.sh из measure_command
       #!/bin/bash
       {measure_command}

  4. init_experition + baseline
     - init_experition({ name, metric_name, direction })
       (если tree.json уже есть — переинициализировать с новым root)
     - run_experition({ command: "./.auto/measure.sh", timeout_seconds: 120 })
     - log_experition({ metric: parsed, status: "keep" })
       (baseline commit — root с метрикой)
     - baseline_metric = parsed

  5. FollowUp
     - pi.sendUserMessage(buildPrompt(params), { deliverAs: "followUp" })

  6. Возврат
     { status: "started", baseline_metric, experiment_count: 1 }
```

### 3.3 FollowUp message (buildPrompt)

```typescript
function buildPrompt(p: AutoresearchOptimizeParams): string {
  return `## Optimization Session: ${p.name}

You have ${p.max_experiments ?? 20} experiments to optimize ${p.metric_name} (${p.direction === "lower" ? "lower is better" : "higher is better"}).
Baseline recorded: ${baselineMetric}.

### Workflow

**Phase 0 — PROFILE FIRST**
Before any hypothesis, read ${p.files_in_scope?.join(", ") ?? "the codebase"}.
Run \`./.auto/measure.sh --profile\` or with debugging to identify TOP-3 bottlenecks.
Record findings — they matter for the final report.

**Phase 1 — Experiment** (one at a time, repeat):
1. \`propose_hypothesis({description: "..."})\` — register hypothesis with profiling finding
2. **EDIT THE CODE** — implement the change
3. \`run_experiment({command: "./.auto/measure.sh", hypothesis_id: "nX"})\`
4. \`log_experiment({metric: ..., status: "keep" | "discard"})\`

**Phase 2 — Navigate**
After each experiment:
- \`tree_status()\` — see where you are
- If branch exhausted (3+ discards): \`explore_from\` to a promising node

### When to Stop
- Goal ${p.goal_threshold ?? "N/A"} reached → stop
- ${p.max_experiments} experiments done → stop
- 3 consecutive explores without improvement → stop
- If stuck: report findings and stop

### Constraints
${p.constraint_entities?.length ? "- Do NOT worsen " + p.constraint_entities.join(", ") + " below " + (p.constraint_threshold ?? 0.95) + " of baseline\n" : ""}
${p.do_not_retry?.length ? "- Avoid: " + p.do_not_retry.join(", ") + "\n" : ""}

### When Done
Summarize:
1. Result: best metric, improvement %, best hypothesis
2. Key findings: what worked, what didn't
3. Dead-ends: what to not retry
Then continue your previous work.`;
}
```

---

## 4. Изменения в существующем коде

### 4.1 index.ts — добавить

| Часть | Строк |
|-------|-------|
| Schema AutoresearchOptimizeParams (Type.Object) | ~25 |
| Handler: валидация | ~10 |
| Handler: measure.sh создание | ~15 |
| Handler: init_experition + baseline | ~15 |
| Handler: followUp + return | ~10 |
| buildOptimizePrompt() | ~40 |
| Регистрация gated tool | ~5 |
| **Итого** | **~120** |

### 4.2 init_experiment — небольшое изменение (опционально)

Сейчас `init_experiment` при наличии tree.json создаёт НОВЫЙ root (переинициализирует). Это уже есть — ничего менять не нужно.

### 4.3 .auto/config.json

Добавляется поле `optimize_config`:

```json
{
  "optimize_config": {
    "active": true,
    "name": "Render optimization",
    "goal_threshold": 12000,
    "max_experiments": 20,
    "constraint_entities": ["quality"],
    ...
  }
}
```

---

## 5. Поток от начала до конца (реальный сценарий)

```
Context: main context
Agent задача: "реализовать экспорт в PDF"

Шаг 1: Агент реализует PDF экспорт

Шаг 2: Замечает что рендер страниц тормозит
  → autiresearch_optimize({
      name: "Page render",
      measure_command: "node bench/render-bench.js 2>&1",
      metric_name: "render_ms",
      direction: "lower",
      goal_threshold: 50,
      max_experiments: 15,
      files_in_scope: ["src/render/"],
    })

Шаг 3: handler
  → measure.sh создан
  → init_experition → baseline (render_ms: 120)
  → log_experition(keep) → n0
  → FollowUp

Шаг 4 [followUp]: Агент читает инструкцию

Шаг 5: Агент профилирует
  → читает src/render/*.ts
  → запускает node --prof bench
  → находит: draw() — 60%, sort() — 25%

Шаг 6: propose_hypothesis("Кэш transform в draw()")
  → n1 (untested)

Шаг 7: EDIT src/render/draw.ts (кэш)

Шаг 8: run_experiment({ command: "./.auto/measure.sh", hypothesis_id: "n1" })
  → render_ms: 95 (-21%)

Шаг 9: log_experiment({ metric: 95, status: "keep" })
  → n1 (experiment, metric=95)

Шаг 10: propose_hypothesis("TypedArray sort вместо кастомного")

... 15 экспериментов ...

Шаг N: max_experiments exhausted
  → tree_status() → видит что лучший n1 (95ms, -21%)
  → key_findings: "draw() кэш -21%, sort() не помог"
  → "Продолжаю PDF экспорт. Рендер оптимизирован на 21%."
```

---

## 6. Подводные камни

| Проблема | Решение |
|----------|---------|
| **Метрика уже считается** | handler явно вызывает init_experition + baseline |
| **Двойная сессия** | optimize_config.active проверяется, error если уже есть |
| **Агент не знает когда стоп** | FollowUp содержит goal_threshold + max_experiments + stuck detection |
| **Контекст забивается** | max_experiments — жёсткий лимит |
| **Агент забывает исходную задачу** | FollowUp заканчивается "...then continue your previous work" |
| **constraint_entities не проверяются** | FollowUp инструктирует агента — дальше его ответственность |

---

## 7. Оценка

| Этап | Время |
|------|-------|
| Написание (~120 LOC в index.ts) | ~1 час |
| esbuild проверка | ~5 мин |
| Smoke test (create → baseline → followUp) | ~15 мин |
| **Итого** | **~1.5 часа** |

Никаких новых файлов. Никаких модулей. Никакой инфраструктуры.

---

## 8. Open Questions (решить до реализации)

1. **Можно ли вызвать если уже есть tree.json с гипотезами?**  
   → Да, init_experiment сейчас создаёт новый root n0. Старое дерево остаётся на диске.

2. **Можно ли вызвать если уже есть optimize_config.active = true?**  
   → Нет. Error. Агент должен сначала закрыть активную сессию.

3. **measure.sh — перезаписывать если уже есть?**  
   → Нет. Только если нет. Если нужно другой — агент передаёт другой measure_command.

4. **Что если agent не последовал followUp?**  
   → Ничего. Это рекомендация, не принуждение. Tool только настраивает сессию.

5. **Нужна ли команда /autoresearch optimize для TUI?**  
   → В v1 нет. Только tool. TUI-команда — v2 опционально.
