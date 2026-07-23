# T3: Checks Timeout Race Condition

**Severity:** 🟡 High
**Effort:** Small (исправление в `index.ts`, ~10 строк)
**Status:** Draft
**Deps:** —

## Проблема

В итерации #64 E2E-теста наблюдался false positive checks timeout:

```
✅ Benchmark PASSED in 0.5s
⏰ CHECKS TIMEOUT (.auto/checks.sh) after 0.1s
Log this as 'checks_failed'

── Checks output (last 80 lines) ──
OK: app.sh correct        ← CHECKS ACTUALLY PASSED!
```

`checks.sh` **успешно выполнился** (вывел "OK: app.sh correct"), но был помечен как TIMED OUT. Баг.

## Root Cause Analysis

### Гипотеза: timer start race

`checks.sh` запускается с timeout `0.1s` (100ms). На Windows/MSYS2:

1. Node.js вызывает `spawn(bash, [checks.sh])`
2. Запускается cmd.exe → bash.exe → читает checks.sh → выполняет `[ "$out" = "4501500" ]`
3. Вся цепочка: cmd.exe start (~9ms) + bash start (~32ms) + script (~0ms) = ~41ms

При system noise timeout может сработать раньше, чем pipes закроются.

### Гипотеза: pipe close detection

Node.js детектит timeout по wall-clock. Но выход bash НЕ гарантирует что stdout pipe уже прочитан. Race:

```
Time 0ms:   spawn checks.sh
Time 41ms:  bash выполняет echo "OK", пишет в stdout pipe
Time 41ms:  bash вызывает exit(0)
Time 42ms:  pipe buffer flush (асинхронный)
Time 100ms: TIMEOUT fires — но pipe может быть ещё не закрыт!
```

### Гипотеза: checks_timeout default слишком мал

Если `checks_timeout` default = 0.1s (100ms), это на пределе для MSYS2 bash startup (~42ms) + noise (+20ms). При noise > 58ms → timeout.

## Решение

### Fix 1: Увеличить default checks_timeout

```typescript
// Было:
const DEFAULT_CHECKS_TIMEOUT = 0.1; // 100ms — слишком мало для Windows

// Стало:
const DEFAULT_CHECKS_TIMEOUT = process.platform === "win32" ? 5 : 2; // 5s Windows, 2s Unix
```

### Fix 2: Не помечать как timeout если есть корректный output

```typescript
// В checks execution logic:
const checksOutput = result.stdout.trim();
const checksPassed = checksOutput.includes("OK") || checksExitCode === 0;

if (timedOut && checksPassed) {
  // False positive timeout — checks actually completed
  console.log("✅ Checks passed (timeout ignored)");
  return { passed: true, timeout: false };
}
```

### Fix 3: Wait for pipe drain after process exit

```typescript
// После child.on('close'):
await new Promise(resolve => stream.once('end', resolve));
```

## Изменяемые файлы

| Файл | Изменение |
|------|-----------|
| `extensions/pi-autoresearch/index.ts` | checks_timeout default + false-positive guard |

## Acceptance Criteria

- [ ] `checks.sh` не помечается как timeout при корректном output "OK: app.sh correct"
- [ ] Default checks_timeout ≥ 5s на Windows
- [ ] При реальном timeout (no output, process killed) — корректно помечается как checks_failed
- [ ] Тест: запустить 20 раз с минимальным checks.sh — 0 false positives

## Reproduction

```bash
# Создать минимальный checks.sh (как в E2E):
echo 'out=$(bash app.sh); [ "$out" = "4501500" ] && echo "OK"' > .auto/checks.sh

# Запустить под нагрузкой (Docker Desktop + 90% RAM):
for i in $(seq 1 20); do bash .auto/measure.sh; done

# Ожидание: ~1 из 20 выдаст false timeout
```
