# T6: Noise Gate — Pre-Flight Skip при Noise > Best

**Severity:** 🟡 Medium
**Effort:** Small (pre-flight diagnostic в `run_experiment` или в `before.sh`)
**Status:** Draft
**Deps:** —

## Проблема

В E2E-тесте агент провёл 20+ экспериментов при noise floor (45-69ms) **выше** best (39.872ms). Каждый из них — гарантированный discard. Это пустая трата времени и токенов.

### Примеры потерь

| Итерация | Pre-run noise min | Best | Результат | Потеря |
|----------|-------------------|------|-----------|--------|
| #50 | — | 39.87ms | 91.3ms | ~0 токенов wasted |
| #54 | 45ms | 39.87ms | 55.3ms | ~0 токенов wasted |
| #56 | 46ms | 39.87ms | 61.5ms | ~0 токенов wasted |

Каждый discard расходует ~500 токенов на log_experiment + размышления.

## Решение

### Вариант A: Noise gate в before.sh hook (рекомендуется)

Перед каждым run, observer hook делает быстрый 3-sample diagnostic:

```bash
# В before.sh, BEFORE generating steer:
noise_samples=()
for i in 1 2 3; do
  t0=$(date +%s%N)
  bash -c 'true'  # минимальный bash запуск
  t1=$(date +%s%N)
  noise_samples+=($(( (t1 - t0) / 1000000 )))
done
noise_min=$(printf '%s\n' "${noise_samples[@]}" | sort -n | head -1)

# Получить best из log
best_metric="$(jq -r '...' <<<"$state_json")"

# Noise gate
if [ -n "$best_metric" ] && [ "$noise_min" -gt "$(echo "$best_metric * 1.1" | bc)" ]; then
  cat <<EOF
🔇 NOISE GATE: System noise floor (${noise_min}ms) exceeds best (${best_metric}ms) by >10%.
   Current conditions cannot produce an improvement.

   Options:
   → Wait for system load to decrease
   → Set NOISE_GATE_OVERRIDE=1 and continue anyway
   → Run /autoresearch off and finalize

   Skipping this experiment would save tokens.
EOF
  exit 0
fi
```

### Вариант B: Noise gate в run_experiment (TypeScript)

```typescript
// Перед основным experiment, quick noise check:
if (direction === "lower" && bestMetric !== null) {
  const noise = await quickNoiseCheck(); // 3× bash -c 'true'
  if (noise.min > bestMetric * 1.1) {
    return {
      skipped: true,
      reason: `Noise floor (${noise.min.toFixed(1)}ms) > best (${bestMetric}ms) + 10%`
    };
  }
}
```

### Вариант C: Предупреждение, не блокировка (мягкий gate)

```typescript
// Не блокировать, но предупредить:
if (noise.min > bestMetric * 1.1) {
  console.log(`⚠️ NOISE WARNING: System min (${noise.min.toFixed(1)}ms) > best (${bestMetric}ms).`);
  console.log(`   This experiment will almost certainly be a discard.`);
  console.log(`   Proceed anyway? (set NOISE_GATE=off to suppress)`);
}
```

**Рекомендация:** Вариант C (мягкий gate) — даёт информацию, не блокируя.

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `~/.pi/agent/autoresearch/hooks/before.sh` | Noise diagnostic + warning (~25 строк) |
| ИЛИ `extensions/pi-autoresearch/index.ts` | Pre-flight check в run_experiment (~20 строк) |

## Acceptance Criteria

- [ ] При noise_min > best + 10% → выдаётся NOISE WARNING
- [ ] Warning показывает конкретные числа (noise_min, best, delta)
- [ ] Опция NOISE_GATE=off подавляет warning
- [ ] Опция NOISE_GATE=hard — превращает в skip (не запускает experiment)
- [ ] Не добавляет >100ms overhead (3 quick samples)

## Out of Scope

- CPU frequency monitoring
- Thermal throttling detection
- Process-level resource contention analysis
