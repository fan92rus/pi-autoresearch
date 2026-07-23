# T5: Confidence Score — Per-Run Instead of Global

**Severity:** 🟡 Medium
**Effort:** Small (формула пересчёта в `index.ts`)
**Status:** Draft
**Deps:** —

## Проблема

После каждого `log_experiment` выводится:

```
📊 Confidence: 20.8× noise floor — improvement is likely real
```

Это confidence вычисляется на основе **base→best** (baseline vs best-ever improvement относительно noise floor). Но отображается на **каждом discard**, дезинформируя:

| Контекст | Показано | Реальность |
|----------|---------|------------|
| Run #64 (discard, 58ms) | "20.8× — likely real" | Но run — discard! Это не improvement |
| Run #60 (discard, 44ms) | "20.3× — likely real" | Best не изменился, это noise |
| Run #17 (keep, 39.87ms) | "25.1× — likely real" | ✅ Корректно — это и есть best |

**Проблема:** "improvement is likely real" относится к best (#17), а не к текущему run (#64). Это сбивает с толку.

## Решение

### Изменение 1: Clarify what confidence refers to

```typescript
// Было:
console.log(`📊 Confidence: ${(confidence * 100 / noiseFloor).toFixed(1)}× noise floor — improvement is likely real`);

// Стало:
if (status === "keep" && metric === bestMetric) {
  console.log(`📊 Confidence: ${(confidence * 100 / noiseFloor).toFixed(1)}× noise floor — this improvement is likely real`);
} else {
  console.log(`📊 Best (#${bestRun}): ${(bestConfidence * 100 / noiseFloor).toFixed(1)}× noise floor (set at run #${bestRun})`);
}
```

### Изменение 2: Show per-run delta context

```typescript
// Для discard runs:
const deltaVsBest = ((metric - bestMetric) / bestMetric * 100).toFixed(1);
console.log(`📊 Delta vs best: +${deltaVsBest}% (${metric.toFixed(1)} vs ${bestMetric.toFixed(1)})`);
```

### Пример вывода

**Keep (new best):**
```
📊 Confidence: 25.1× noise floor — this improvement is likely real
```

**Discard:**
```
📊 Best (#17): 25.1× noise floor (set at run #17)
📊 This run: 48.4ms (+21.5% vs best 39.87ms) — noise, not improvement
```

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `extensions/pi-autoresearch/index.ts` | Confidence display logic (~15 строк) |

## Acceptance Criteria

- [ ] На discard: показывает delta vs best, не "improvement is likely real"
- [ ] На keep: показывает confidence для текущего improvement
- [ ] Число "best confidence" стабильно между runs (не меняется на discards)
- [ ] Формат: "Best (#17): X× — set at run #17" для discards
