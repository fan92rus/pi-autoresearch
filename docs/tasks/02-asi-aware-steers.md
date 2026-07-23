# T2: Observer — ASI-Context-Aware Steers

**Severity:** 🔴 Critical
**Effort:** Medium (изменение `before.sh`, парсинг ASI из log.jsonl)
**Status:** Draft
**Deps:** T1 (floor detection — естественное продолжение)

## Проблема

Observer hook (`before.sh`) генерирует **одинаковые** steer messages независимо от того, что агент уже знает и доказал. 

В E2E-тесте агент записал в ASI:

```json
{
  "learned": "content is 0% of 42ms process-creation floor",
  "proof": "T = bash_startup(32.5ms) + cmd_overhead(9.5ms) + content(0ms) = 42ms"
}
```

Но observer продолжает выдавать:

```
REFLECT:
1. Are you optimizing the right thing? Profile the code — where is time actually spent?
```

Агент УЖЕ профилировал (8 раз!) и УЖЕ доказал. Observer не читает контекст.

### Конкретные примеры бесполезных steers

| Steer | Реальность | Проблема |
|-------|-----------|----------|
| "Profile the code" | Профилировано 8 раз | Observer не знает |
| "Change direction" | Направлений нет (constraints) | Observer не знает |
| "Try something DIFFERENT" | 57 вариантов перепробовано | Observer не знает |

## Решение

### Вариант A: Парсинг ASI из log.jsonl (рекомендуется)

В `before.sh`, перед генерацией STAGNATION steer, парсить последние 3-5 ASI-полей из log.jsonl:

```bash
# Извлечь ASI из последних N runs
recent_asi="$(jq -r --argjson n 5 '
  [.[] | select(.run != null) | .asi // empty]
  | .[-($n):]
  | map(.learned // .hypothesis // .proof // "")
  | .[]
' "$jsonl" 2>/dev/null)"

# Keyword detection
if echo "$recent_asi" | grep -qiE "floor|impossible|provably|0%|irreducible|exhausted"; then
  # Агент уже доказал предел
  floor_evidence=true
fi

if echo "$recent_asi" | grep -qiE "profil|measured|benchmarked|breakdown"; then
  # Агент уже профилировал
  profiled=true
fi
```

### Адаптивные steers

| Условие | Текущий steer | Новый steer |
|---------|--------------|-------------|
| ASI содержит "floor/impossible" + streak > 10 | "Change direction" | "✅ Floor already proven in ASI. Consider /autoresearch off." |
| ASI содержит "profile/breakdown" + streak > 5 | "Profile the code" | "Profiling already done per ASI. Skip to actionable next steps." |
| ASI содержит "noise" + streak > 10 | "Try different approach" | "Noise dominates signal (per ASI). Consider finalize or new metric." |
| Streak > 20 + любой ASI | Generic REFLECT | "⚠️ 20+ non-improving runs. Hard recommend /autoresearch off." |

### Вариант B: Marker words в ideas.md

Альтернатива — парсить `ideas.md` вместо ASI:

```bash
if grep -qiE "PROVEN COMPLETE|MATHEMATICALLY IMPOSSIBLE|FLOOR REACHED" "$ideas_hint"; then
  floor_evidence=true
fi
```

Плюс: проще (не парсить JSON).
Минус: зависит от формата ideas.md (нестабилен).

**Рекомендация:** реализовать оба (A primary, B fallback).

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `~/.pi/agent/autoresearch/hooks/before.sh` | ASI parsing (~30 строк), adaptive steer logic (~20 строк) |

## Acceptance Criteria

- [ ] При ASI с "floor/impossible/provably" + streak > 10 → steer рекомендует finalize
- [ ] При ASI с "profile/breakdown" → steer НЕ просит "profile the code"
- [ ] При streak > 20 → steer явно рекомендует `/autoresearch off`
- [ ] Marker words в ideas.md работают как fallback
- [ ] Документировано в skill `autoresearch-hooks`

## Out of Scope

- LLM-based steer generation (слишком дорого для hook)
- Анализ произвольных ASI полей (только keyword matching)
