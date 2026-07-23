# T4: Agent-Driven Finalize Signal

**Severity:** 🟡 Medium
**Effort:** Small (1 новый tool + handler в `index.ts`)
**Status:** Draft
**Deps:** T1 (floor detection — комплементарен)

## Проблема

В E2E-тесте агент доказал математическую невозможность дальнейшей оптимизации (через profiling), но **не имел способа** сказать системе "я у предела, давай финализировать." Единственный вариант — продолжать цикл или ждать user-interrupt.

Нет механизма для agent-initiated completion.

### Конкретный случай

- Итерация #17: best=39.872ms достигнут
- Итерация #48: profiling доказал floor (content=0% of 42ms)
- Итерация #64: агент всё ещё продолжает цикл (16 итераций после доказательства)

## Решение

### Новый tool: `finalize_research`

```typescript
pi.registerTool({
  name: "finalize_research",
  description: "Signal that the optimization target has reached its structural limit. " +
    "Records a finalize entry in log.jsonl and sends a completion steer. " +
    "The agent retains control — this does NOT force-stop the session.",
  parameters: {
    reason: { type: "string", description: "Why the optimization is complete" },
    evidence: { type: "string", description: "Proof (profiling data, variance analysis, etc.)" },
    confidence: { type: "number", description: "0.0-1.0 confidence in finalization" }
  },
  handler: async (args) => {
    // 1. Write finalize entry to log.jsonl
    const entry = {
      type: "finalize",
      reason: args.reason,
      evidence: args.evidence,
      confidence: args.confidence,
      timestamp: new Date().toISOString()
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    
    // 2. Send completion steer
    pi.sendUserMessage(
      `🏁 FINALIZE SIGNAL: Agent reports optimization complete.\n` +
      `   Reason: ${args.reason}\n` +
      `   Confidence: ${(args.confidence * 100).toFixed(0)}%\n` +
      `   Evidence: ${args.evidence}\n\n` +
      `   Run /autoresearch off to finalize, or continue if you disagree.`,
      { deliverAs: "steer" }
    );
    
    return { content: [{ type: "text", text: "Finalize signal sent." }] };
  }
});
```

### Использование

```javascript
// Агент доказал floor через profiling:
finalize_research({
  reason: "Process-creation floor reached: content is 0% of 42ms measured time",
  evidence: "T = bash_startup(32.5ms) + cmd_overhead(9.5ms) + content(0ms). " +
    "Proven by empty-script baseline profiling (42.0ms = formula 42.4ms).",
  confidence: 0.98
})
```

### Интеграция с observer hook (T1)

Observer hook может детектить finalize entries:

```bash
# В before.sh:
finalize_found="$(jq -r 'select(.type == "finalize") | .confidence // empty' "$jsonl" | tail -1)"
if [ -n "$finalize_found" ] && [ "$(echo "$finalize_found > 0.8" | bc)" -eq 1 ]; then
  # Агент уверен на >80% — усилить рекомендацию finalize
  echo "🏁 Agent signaled finalize (confidence=${finalize_found}). Consider /autoresearch off."
fi
```

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `extensions/pi-autoresearch/index.ts` | Новый tool `finalize_research` (~30 строк) |
| `~/.pi/agent/autoresearch/hooks/before.sh` | Detect finalize entries in jq filter (~5 строк) |
| `skills/autoresearch-create/SKILL.md` | Документация нового tool |

## Acceptance Criteria

- [ ] Tool `finalize_research` доступен в autoresearch mode
- [ ] Запись `{type:"finalize", reason, evidence, confidence}` добавляется в log.jsonl
- [ ] Steer message отправляется с результатом
- [ ] Observer hook детектит finalize entries и адаптирует steers
- [ ] При confidence > 0.8 → observer рекомендует `/autoresearch off`
- [ ] Сессия НЕ прерывается принудительно (agent retain control)

## Out of Scope

- Auto-stop сессии (контроль остаётся у агента/пользователя)
- External webhook notifications
