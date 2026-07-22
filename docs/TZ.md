# ТЗ — parallel-режимы для pi-autoresearch

**Статус:** Draft v0.2 (переработан под RPC-over-EventBus архитектуру)
**Дата:** 2026-07-23
**Связанные документы:** [PRD.md](./PRD.md)
**База:** [fan92rus/pi-autoresearch](https://github.com/fan92rus/pi-autoresearch) v1.6.1 + патч `ensureGatedToolsActive` + [pi-subagents](https://github.com/fan92rus/pi-subagents) (поставщик RPC)

---

## 0. Контекст — установленные факты

Все решения ниже опираются на проверенные факты кода (`extensions/pi-autoresearch/`) и API pi (`@earendil-works/pi-coding-agent`).

### 0.1. Факты о pi-autoresearch (исходник)

| Факт | Где | Значение |
|------|-----|----------|
| `run_experiment` **не мутирует git и лог** — только spawn + METRIC-парсинг | `index.ts` | Безопасно вызывать из N worktree параллельно |
| `log_experiment` делает `git add -A && git commit` (keep) / `git checkout -- .`+`clean` (revert), пишет `fs.appendFileSync(log.jsonl)` **без лока** | `index.ts` | Сериализатор — только parent |
| Revert **сохраняет `.auto/`** (`:(exclude,glob)**/.auto`) | log_experiment | Worker может откатить неудачу без потери session-файлов |
| `.auto/` выводится из `resolveWorkDir(ctx.cwd)` → читает `workingDir` из `.auto/config.json` | `paths.ts` | Изоляция через worktree: N workdir → N изолированных `.auto/` |
| `runtime` (lastRunChecks, autoresearchMode) — **per-session** | `createRuntimeStore` | Субагент = свой sessionId = свой runtime |
| Патч `ensureGatedToolsActive` | `index.ts` | Gated-tools вызываемы в subagent/headless; execution gated by `autoresearchMode` runtime-флага |
| `measure.sh` **не имеет** флага подмножества нагрузки | — | Бюджет решается контрактом `BENCH_MODE` env-var |

### 0.2. Факты о ExtensionAPI pi (`dist/core/extensions/types.d.ts`)

| Факт | Значение |
|------|----------|
| `pi.events: EventBus` (строка 998) | **Общее пространство** между расширениями: `events.on(name, fn)`, `events.emit(name, data)` |
| `pi.exec(cmd, args, opts): Promise<ExecResult>` | Выполнение процессов (git, bash) из расширения |
| `pi.registerTool`, `pi.registerCommand`, `pi.getActiveTools` | Регистрация tools/commands |
| `pi.sendUserMessage(content, opts)` | Инжект пользовательского сообщения в agent-loop |
| `pi.events.emit(...) / on(...)` | Pub/sub между расширениями — наш основной transport |
| **НЕТ** `callTool`/`invokeTool` | Нельзя программно вызвать tool другого расширения напрямую — но можно через event bus (см. 0.3) |

### 0.3. Факты о pi-subagents RPC (КЛЮЧЕВОЕ)

`pi-subagents` публикует в `pi.events` полноценный **RPC-over-EventBus protocol** (`src/extension/rpc.ts`):

```ts
export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT      = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_READY_EVENT        = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_METHODS = ["ping", "status", "spawn", "interrupt", "stop"];
```

- **Слушатель** (`rpc.ts:351`): `events.on(SUBAGENT_RPC_REQUEST_EVENT, handler)` → обрабатывает → `events.emit(replyPrefix+requestId, reply)`.
- **`spawn`** (`rpc.ts:202`, `spawnParams`): принимает `SubagentParamsLike` (те же параметры что и tool `subagent`: `agent`, `task`, `cwd`, `context`, `model`, `toolBudget`, `acceptance`, ...). **Ограничения:** `async: true` форсируется (detached), `clarify: false` (без UI).
- **Возвращает** `{runId, asyncDir}` (spawn — всегда async/detached).
- **Доставка результата:** `SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT` (`intercom/result-intercom.ts:307`) — когда async-run завершается, результат публикуется в event bus. Альтернатива: поллинг через RPC `status`.

**Следствие:** наш extension может программно фан-аутить субагентов через `pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {method:"spawn",...})` и собирать результаты. **Ноль дублирования, ноль nested-pi, ноль патчей upstream.**

---

## 1. Архитектура — Tool-encapsulated RPC fan-out

```
┌──────────────────────────────────────────────────────────────────────┐
│ PARENT-АГЕНТ (LLM, main worktree, autoresearchMode ON)               │
│  • читает .auto/prompt.md, формулирует гипотезы (ТЕКСТ)               │
│  • вызывает tool BestOfN/CheckOrthogonal/SpaceSearch                  │
│  • по результату: log_experiment(keep/discard) — канонический лог     │
└───────────────┬──────────────────────────────────────────────────────┘
                │ tool call (agent → наш extension)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ НАШ EXTENSION (TS, tool handlers)                                     │
│  1. baseline = HEAD; pre-flight measure (BENCH_MODE=quick) < budget?  │
│  2. провижининг worktree-ов (git worktree add + копирование .auto/)   │
│  3. FAN-OUT: pi.events.emit("subagents:rpc:v1:request", spawn×N)      │
│  4. COLLECT: слушаем SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT ×N       │
│  5. читаем {wt}/.auto/worker-result.json из каждого worktree          │
│  6. aggregate: median-of-repeats, шум-фильтр, ранжирование            │
│  7. winner → git apply в main → re-measure (BENCH_MODE=full)           │
│  8. cleanup worktree-ов; вернуть {winner, ranked, final_metric}        │
└───────────────┬──────────────────────────────────────────────────────┘
                │ pi.events (RPC over EventBus)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ pi-subagents extension (СТОРОННИЙ, не модифицируем)                   │
│  • принимает spawn-запросы, создаёт child pi-процессы                 │
│  • управляет worktree (если worktree:true), concurrency, fresh-ctx    │
│  • доставляет результаты через result-intercom event bus              │
└───────────────┬──────────────────────────────────────────────────────┘
                │ spawn child pi (detached, async)
        ┌───────┼───────┐
        ▼       ▼       ▼
   [WORKER 1] [WORKER 2] [WORKER N]   (fresh-context LLM-агенты)
   cwd = wt-1  cwd = wt-2  cwd = wt-N
   • init_experiment (mode ON, metric)
   • читает код, реализует гипотезу-текст (LLM-суждение)
   • run_experiment(budget, BENCH_MODE=quick) × repeats → median
   • пишет {wt}/.auto/worker-result.json {diff, metric, notes}
   • НЕ логирует, НЕ трогает main, НЕ мутирует git-историю
```

**Принцип разделения:** LLM-суждение (генерация гипотез, реализация текста в коде, выбор направления) — в агентах. Детерминированная механика (fan-out, замер, агрегация, re-measure) — в расширении.

---

## 2. Механизм RPC — детали реализации

### 2.1. spawn-запрос

```ts
// наш tool handler
async function spawnWorker(opts: {
  agent: string; task: string; cwd: string; model?: string;
  toolBudget?: { hard: number }; workerTimeoutMs: number;
}): Promise<{ runId: string; asyncDir: string }> {
  const requestId = crypto.randomUUID();
  // подготовить reply-промис ДО эмита (не пропустить быстрый ответ)
  const reply = await onceEvent(pi.events, replyEventFor(requestId), opts.workerTimeoutMs);
  pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
    version: 1, requestId,
    method: "spawn",
    params: {
      agent: opts.agent, task: opts.task, cwd: opts.cwd,
      context: "fresh",
      model: opts.model,
      async: true, clarify: false,
      toolBudget: opts.toolBudget,
      output: path.join(opts.cwd, ".auto", "worker-result.json"),
      outputMode: "file-only",
    },
  });
  return { runId: reply.result.runId, asyncDir: reply.result.asyncDir };
}
```

Примечание: `output`/`outputMode: "file-only"` заставляет worker писать финальный результат в файл (не inline-вывод) — надёжнее парсинга текста. Структуру результата диктует наш task-шаблон (§6).

### 2.2. collect-результатов

```ts
async function collectWorkerResult(runId: string, cwd: string, timeoutMs: number) {
  // вариант A — ждать result-intercom event
  await onceEvent(pi.events, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
    timeoutMs, (d) => d.runId === runId);
  // вариант B (fallback) — poll RPC status
  const raw = await fs.readFile(path.join(cwd, ".auto", "worker-result.json"), "utf-8");
  return JSON.parse(raw);  // {diff, metric, metrics[], notes, status, error?}
}
```

Надёжность: event-intercom может не сработать (edge cases); поллинг `status` RPC как fallback. Таймаут на collect = `workerTimeoutMs`; при превышении → `interrupt` RPC на этот runId → пометить `status: "worker_timeout"`.

### 2.3. Ping/ready-check

Перед fan-out убедиться, что pi-subagents загружен и RPC готов: `pi.events.emit(REQUEST, {method:"ping"})` → ждать `SUBAGENT_RPC_READY_EVENT`. Если таймаут → понятная ошибка «pi-subagents не установлен/не готов».

---

## 3. API инструментов

### 3.1. `BestOfN` (Режим A, P0)

```ts
BestOfN({
  // кандидаты: либо массив текстов, либо с тегом сложности (см. §6.5)
  candidates: string[] | { hypothesis: string; complexity?: "simple"|"medium"|"hard" }[],
  agent?: string = "autoresearch-worker",
  model?: string | { tier: "fast"|"mid"|"strong" },  // override тира для ВСЕХ (иначе по complexity)
  cascade?: boolean,          // default из config (true): cheap-first, эскалация при сбое
  budgetSeconds?: number = 300,   // measure-бюджет на один run_experiment
  repeats?: number,               // default по complexity (simple=1, medium/hard=3)
  workerTimeoutMs?: number,       // default по complexity (5м/8м/12м)
  concurrency?: number,           // параллельность (default min(CPU-1,4,candidates.length))
  benchMode?: "quick"|"full" = "quick",
}) → {
  baselineMetric: number,
  winnerIndex: number | null,     // null если никто не превзошёл шум
  ranked: [{
    index, metric, medianMetric, status: "ok"|"budget_exceeded"|"apply_failed"|"worker_timeout"|"crash",
    notes?: string, error?: string,
  }],
  finalMetric: number | null,     // после re-measure победителя на main
  decision: "keep"|"discard",     // рекомендация для log_experiment
  appliedDiffSummary?: string,
}
```

Семантика: каждый candidate — текстовая гипотеза. Tool спавнит N worker'ов (по кандидату), каждый реализует текст в код, измеряет, возвращает. Tool ранжирует, **переизмеряет победителя на main** (BENCH_MODE=full), решает keep/discard, оставляет diff применённым (keep) или откатывает (discard). Агент вызывает `log_experiment(decision, metric=finalMetric)`.

### 3.2. `CheckOrthogonal` (Режим B, P1)

```ts
CheckOrthogonal({
  patches: { name: string; hypothesis: string; fileScope?: string[] }[],
  ...общие опции budget/repeats/concurrency...
}) → {
  perPatch: [{ name, metric, improvement, status, fileScopeActual: string[] }],
  independence: { orthogonal: boolean, conflicts: [{a,b,sharedFiles}] },
  stackedMetric: number | null,
  applied: string[], rejected: [{ name, reason }],
  decision: "keep"|"discard",
}
```

Две фазы: (1) параллельная проверка каждого патча; (2) проверка независимости по фактическим file-scope правок (git diff --name-only в каждом worktree), отказ при пересечении файлов; (3) стекающий merge в main с re-measure после каждого.

### 3.3. `SpaceSearch` (Режим C, P2)

Stateful per-session beam search. Состояние — в `.auto/parallel/beam.json`.

```ts
SpaceSearch({
  action: "init"|"step"|"finish"|"status",
  beamWidth?: number = 3,        // K живых состояний
  candidatesPerState?: number = 3, // M кандидатов на шаг
  diversityHints?: string[],     // принудительное разнообразие ("inline","cache","algo","simd")
  ...budget/repeats...
}) → {
  step: number,
  beam: [{ commit, metric, parentCommit, hypothesis, depth }],
  pruned: number,
  improved: boolean,
  converged: boolean,
}
```

- `init`: beam = [{commit: HEAD, metric: baseline, depth:0}].
- `step`: для каждого из K состояний спавнит M candidate-worker'ов (task включает state.diff + diversityHints[i%len]); собирает, ранжирует, отсев до топ-K; сохраняет beam; commit-chain сохраняется для финального cherry-pick.
- `finish`: cherry-pick цепочки лучшего state в main, re-measure (full), вернуть.

LLM-генерация гипотез происходит **внутри worker'ов** (каждый worker получает state + "улучши"). Agent лишь драйвит `step` до сходимости.

---

## 4. Бюджет времени — три слоя

Проблема: параллелизм умножает стоимость. Один 20-минутный `measure.sh` × N worker = катастрофа. Бюджет должен быть многослойным и жёстким.

| Слой | Параметр | Default | Что ограничивает | Как enforced |
|------|----------|---------|------------------|--------------|
| **measure** | `budgetSeconds` | 300 (5м) | один запуск `measure.sh` внутри worker'а | `run_experiment` budget-timer (существующий `timeout_seconds` репонируется) |
| **worker** | `workerTimeoutMs` | 600000 (10м) | стеночное время одного worker-процесса (LLM-правки + measure × repeats) | tool: `interrupt` RPC при превышении → `status:"worker_timeout"` |
| **round** | неявно | max(workerTimeoutMs) + re-measure | весь вызов BestOfN/CheckOrthogonal/SpaceSearch | tool: общее ожидание collect |

### 4.1. Pre-flight baseline check (обязательный)

Перед fan-out tool прогоняет baseline на main с `BENCH_MODE=quick` и `budgetSeconds`. Если **baseline сам превышает measure-бюджет** → fan-out НЕ стартует, tool возвращает:
```
{ decision: "discard", reason: "baseline_over_budget",
  baselineDurationMs, steer: "measure.sh слишком медленный (Xs > Ys бюджет). ..." }
```
Агент получает steer и должен сначала починить measure.sh (см. 4.3).

### 4.2. Новый статус `budget_exceeded`

В `LogParams.status` enum добавляется `"budget_exceeded"`. Поведение как у `crash` (no commit, revert), но со специализированным steer:
```
⏰ Эксперимент превысил бюджет 300с (фактически 312с).
Варианты:
1. Уменьшить покрытие: fixture/iter count так, чтобы замер остался репрезентативным и < 300с.
2. Включить BENCH_MODE=quick в measure.sh (подмножество нагрузки).
3. Закэшировать дорогие setup-шаги между запусками (warm cache, prebuilt).
Перепиши measure.sh и повтори. НЕ продолжай цикл с долгим экспериментом.
```

### 4.3. Контракт `BENCH_MODE` (env-var в measure.sh)

`measure.sh` авторское соглашение (валидируется skill'ом):
```bash
#!/bin/bash
MODE="${BENCH_MODE:-full}"
case "$MODE" in
  smoke) ITER=1 ;;    # sanity, только compile
  quick) ITER=10 ;;   # подмножество, для параллельных сравнений (workers)
  full)  ITER=100 ;;  # полное покрытие, для финального keep (re-measure)
esac
echo "METRIC total_ms=..."
```
- Worker-раунды (A/B/C): `BENCH_MODE=quick` (быстро, дёшево, репрезентативно для ранжирования).
- Parent re-measure победителя: `BENCH_MODE=full` (точно, для финального решения keep).

---

## 5. Worktree-провижининг (управляем МЫ, не pi-subagents)

Мы НЕ полагаемся на `worktree:true` в spawn-параметрах (его семантика для single-spawn неоднозначна и требует clean git state). Вместо этого расширение владеет жизненным циклом worktree напрямую через `pi.exec("git", [...])`.

### 5.1. Создание

```ts
async function provisionWorktree(index: number, baselineSha: string): Promise<string> {
  const wtPath = path.join(repoRoot, `.auto/parallel/wt-${index}`);
  await gitExec(["worktree", "add", "--detach", wtPath, baselineSha]);
  // скопировать session-файлы (measure.sh нужен worker'у; .auto/ обычно gitignored)
  await fs.copy(path.join(repoRoot, ".auto/measure.sh"), path.join(wtPath, ".auto/measure.sh"));
  await fs.copy(path.join(repoRoot, ".auto/checks.sh"),  path.join(wtPath, ".auto/checks.sh"));
  await fs.copy(path.join(repoRoot, ".auto/prompt.md"),  path.join(wtPath, ".auto/prompt.md"));
  return wtPath;
}
```

### 5.2. Cleanup

```ts
await gitExec(["worktree", "remove", "--force", wtPath]);
// + удалить orphan branches если создавались
```

Cleanup в `finally` — обязательно, даже при ошибке/таймауте раунда.

### 5.3. Почему так

- Полный контроль: baseline-коммит фиксирован, изоляция `.auto/` гарантирована.
- `--detach` — worktree не привязан к branch, HEAD = baselineSha.
- `measure.sh` копируется явно (он gitignored в main, в worktree иначе отсутствует).
- Worker-лог (`{wt}/.auto/log.jsonl`, `worker-result.json`) — scratch, не канонический; cleanup удаляет.

---

## 6. Контракт worker'а

### 6.1. Task-шаблон (генерируется tool'ом из гипотезы)

```
Работай в worktree: {wtPath}. Baseline commit: {baselineSha}.
Гипотеза (реализуй её в коде): {hypothesisText}
Целевая метрика: {metricName} ({direction}). Единица: {metricUnit}.

ШАГИ:
1. init_experiment(name="{sessionName}", metric_name="{metricName}",
                   metric_unit="{metricUnit}", direction="{direction}")
   — это включит autoresearchMode и откроет run_experiment.
2. Изучи код в worktree. Реализуй гипотезу правками (используй read/edit/bash).
   Не правь файлы вне релевантной области. Не трогай .auto/.
3. Вызови run_experiment(command="bash .auto/measure.sh",
       budget_seconds={budget}, env={BENCH_MODE:"{benchMode}"}) — повтори {repeats} раз.
   При budget_exceeded в результате — НЕ логируй, запиши status:"budget_exceeded" в файл результата.
4. Сформируй diff относительно baseline: `git diff {baselineSha} -- . ':(exclude).auto'`.
5. Запиши результат в {wtPath}/.auto/worker-result.json:
   { "diff": "<unified diff>", "metric": <median>, "metrics": [...],
     "status": "ok"|"budget_exceeded"|"apply_failed"|"crash",
     "notes": "<что сделал, кратко>", "error"?: "<текст ошибки>" }
6. Заверши работу. НЕ вызывай log_experiment. НЕ мутируй main. НЕ делай git commit.
```

### 6.2. Разрешённые tools worker'а (allowlist)

`init_experiment`, `run_experiment`, `read`, `edit`, `bash`, `ctx_*`/search-tools (для изучения кода).
**Без** `log_experiment`, `BestOfN`/`CheckOrthogonal`/`SpaceSearch` (антирекурсия), без `subagent` (worker не плодит субагентов), без `intercom`.

### 6.3. Mode propagation

Worker — отдельная сессия, свой `runtime`. **Worker сам вызывает `init_experiment`** (шаг 1 в task) — в существующем коде это автоматически `setAutoresearchMode(ctx, true)` (благодаря патчу `ensureGatedToolsActive`), после чего `run_experiment` доступен. Parent не пытается инжектить состояние в child (core API этого не позволяет). Это единственный надёжный путь.

### 6.4. Возврат результата

Worker пишет структурированный JSON в файл (`output: {wt}/.auto/worker-result.json`, `outputMode: "file-only"` в spawn). Наш tool читает файл напрямую после детекции завершения (result-intercom event / status-poll). **Без парсинга свободного текста** — надёжнее.

---

## 6.5. Модельная стратегия: тиры, сложность, cascade

**Экономический принцип:** параллельное исследование = много дешёвых попыток; финальная валидация (re-measure победителя) бесплатна — это `bash measure.sh` + парсинг METRIC, ноль LLM-токенов. Значит worker'ы по умолчанию идут на дешёвую модель, дорогая — только когда гипотеза реально сложная.

### 6.5.1. Три механизма (комбинируются)

**(1) Configurable tiers** — config задаёт 3 тира, каждый = `provider/model:thinking` (spawn принимает thinking-суффикс):

```json
// .auto/config.json
"parallel": {
  "tiers": {
    "fast":   "opencode-go/deepseek-v4-flash:low",
    "mid":    "opencode-go/deepseek-v4-flash:xhigh",
    "strong": "zai-glm/glm-5.2:high"
  },
  "complexityMap": {
    "simple": { "tier": "fast",   "workerTimeoutMs": 300000, "repeats": 1 },
    "medium": { "tier": "mid",    "workerTimeoutMs": 600000, "repeats": 3 },
    "hard":   { "tier": "strong", "workerTimeoutMs": 900000, "repeats": 3 }
  },
  "cascade": true,
  "defaultTier": "fast",
  "defaultComplexity": "medium"
}
```

**(2) Complexity tagging** — агент, формулирующий гипотезы, ТЕГИРУЕТ сложность (он единственный, кто видит код + текст гипотезы). Маппинг `complexity → {tier, workerTimeoutMs, repeats}` — в конфиге выше.

| complexity | tier | budget | repeats | пример |
|---|---|---|---|---|
| simple | fast (flash:low) | 5м | 1 | поменять константу, переупорядочить проверки |
| medium | mid (flash:xhigh) | 8м | 3 | рефакторинг функции, инлайн |
| hard | strong (glm:high) | 12м | 3 | смена алгоритма/архитектуры, SIMD |

Fallback-источники тега (если агент не тегирует): эвристика по ключевым словам (`rewrite`/`алгоритм`→hard, `tweak`/`констант`→simple) → иначе `defaultComplexity`.

**(3) Cascade fallback** — candidate сначала на дешёвом тире; при `apply_failed`/`crash`/`worker_timeout` → эскалация на следующий тир. Дёшево для простых, безопасно для сложных.

Ключевое свойство: **cascade делает систему робастной даже без тегирования** — всё идёт через `defaultTier=fast` + cascade; простое succeeds на fast, сложное эскалирует. Тегирование лишь оптимизирует первый тир (минус повторы, минус лишние эскалации).

`budget_exceeded` **не эскалируется** — это проблема `measure.sh`, не модели; эскалация не поможет, нужен steer по §4.

### 6.5.2. Cascade flow — batched (параллелизм сохраняется)

```
tiers = [tierFor(complexity), ...escalationTiers]   # напр. [fast, mid, strong]
round = 0
pending = all candidates
results = {}
while pending не пуст и round < len(tiers):
  tier = tiers[round]
  spawn = pending (parallel, concurrency)
  for each: spawnWorker(c, tier, workerTimeoutMs=tierTimeout, repeats=tierRepeats)
  collect
  for each result:
    if status in (ok, budget_exceeded, within_noise): results[c] = result; pending -= c
    if status in (apply_failed, crash, worker_timeout): оставить в pending для эскалации
  round++
# оставшиеся в pending после всех тиров → mark failed (best-tier result сохраняется для лога)
```
Batched, не per-candidate-sequential: round1 ВСЕ на base-tier параллельно → round2 ВСЕ failed на tier+1 параллельно. Параллелизм высокий, latency ≤ (число тиров) раундов.

### 6.5.3. Экономика

4 гипотезы, 1 hard, 3 simple, cascade on:
- **Без cascade (все на strong):** 4× GLM-5.2 — дорого.
- **Cascade on, без тегов:** round1 = 4× flash; 3 succeed, 1 fail → round2 = 1× strong. Итого 4×flash + 1×strong.
- **Cascade + теги:** то же, но 3 simple на `flash:low` × 1 повтор (вместо ×3) → минус токены на прогонах.

Экономия ~70–80% на типичном раунде (большинство гипотез — мусор/простые). На режиме C (SpaceSearch, много шагов × M кандидатов) экономия ещё заметнее — там объём worker-вызовов на порядки больше.

### 6.5.4. Per-call override

- `model: "provider/model:thinking"` или `model: {tier}` — переопределяет тир для **всех** кандидатов (cascade всё ещё работает поверх).
- `cascade: false` — отключить эскалацию (только один тир, проще/дешевле, но failure = отбросить).
- Глобально: через config или флаги `/autoresearch parallel-* --tier fast --no-cascade`.

---

## 7. Агрегация и выбор

### 7.1. Ранжирование

- Каждый candidate отдаёт `metrics[]` (repeats замеров в BENCH_MODE=quick).
- `medianMetric = median(metrics)`.
- Ранжирование по `medianMetric` в направлении цели (lower/higher).

### 7.2. Шум-фильтр (noise floor)

`noiseFloor = MAD(allMedianMetrics)` (Median Absolute Deviation — уже используется в pi-autoresearch confidence). Candidate, чьё улучшение `|medianMetric − baselineMetric| < noiseFloor`, помечается `within_noise` и не допускается к победе (даже если формально лучший). Если все в шуме → `winnerIndex: null`, `decision: "discard"`.

### 7.3. Selection-bias correction (КРИТИЧНО)

Выбор «лучшего из N» по одному (даже median-of-3) шумному замеру систематически переоценивает улучшение. **Победитель переизмеряется на main с `BENCH_MODE=full`**:
```
finalMetric = run measure.sh (BENCH_MODE=full, budgetSeconds) в main после git apply winner.diff
if isBetter(finalMetric, baselineMetric, direction) AND |finalMetric − baseline| > noiseFloor:
  decision = "keep"  // diff остаётся применённым
else:
  decision = "discard"; git checkout (откат apply)  // revert
```
Только `finalMetric` (не quick-оценка) попадает в `log_experiment`. Это убирает optimistic-bias.

---

## 8. Изоляция и конкуренция

| Ресурс | Кто пишет | Стратегия |
|--------|-----------|-----------|
| main `.auto/log.jsonl` | Parent (1 писатель) | Нет гонки |
| worktree `.auto/log.jsonl` | Worker (1 на worktree, scratch) | Изолирован; cleanup удаляет |
| main git index/refs | Parent (1) через `log_experiment` | Сериализован |
| worktree git index | Worker (только рабочие правки, commit НЕ требуется) | Изолирован |
| общий `.git` refs lock | Parent only (workers не коммитят) | Нет contention |
| `runtime` состояние | per-session | Worker = своя сессия |
| **CPU** | N worker-процессов | см. 8.1 |

### 8.1. CPU-contention (физическое ограничение)

Если `measure.sh` **однопоточный** (микро-бенчмарк) — N worktree реально параллелятся на N ядрах, выигрыш стеночного времени ≈ N×.

Если `measure.sh` **многопоточный** (сборка/test-suite на все ядра) — один замер ест 100% CPU → N worktree конкурируют → реальное ускорение ≈ 0 (то же стеночное время, N× CPU).

Митигация:
1. **Авто-калибровка concurrency:** pre-flight замеряет CPU-load baseline (`/usr/bin/time -v` или парсинг `ps`); если ~100% → `concurrency = min(2, candidates)`, с advisory.
2. **Advisory в результате tool'а:** `cpuWarning: "measure.sh грузит все ядра — реальный параллелизм ограничен"`.
3. `BENCH_MODE=quick` снижает нагрузку каждого (ценой точности; финал в `full`).

Это не баг — закон сохранения ядер. Главное не продавать иллюзию.

---

## 9. Режим A — Best-of-N (детальный поток)

```
BestOfN(candidates[H1..Hn], opts):
  # 0. pre-flight
  baseline = gitRevParse("HEAD")
  pre = runOnMain("bash .auto/measure.sh", BENCH_MODE=quick, budget=opts.budget)
  if pre.budgetExceeded: return {decision:discard, reason:"baseline_over_budget", steer:...}
  baselineMetric = pre.metric

  # 1. провижининг
  wts = [provisionWorktree(i, baseline) for i in 1..n]

  try:
    # 2. fan-out через RPC
    runs = [spawnWorker(agent, task=buildTask(Hi,wts[i],baseline,opts), cwd=wts[i], ...) for i]
    # 3. collect
    results = [collectWorkerResult(runs[i].runId, wts[i], opts.workerTimeoutMs) for i]
      # при таймауте → interrupt RPC → status:"worker_timeout"

    # 4. aggregate
    noise = MAD([r.medianMetric for r in results if r.status=="ok"])
    ranked = sort(results, by=medianMetric, direction) with within_noise filter

    candidates2 = [r for r in ranked if r.status=="ok" and |r.medianMetric-baseline|>noise]
    if empty(candidates2): return {decision:discard, reason:"all_within_noise", ranked}

    winner = candidates2[0]
    # 5. selection-bias correction: re-measure на main, full
    gitApply(winner.diff, main)
    final = runOnMain("bash .auto/measure.sh", BENCH_MODE=full, budget=opts.budget)
    if isBetter(final.metric, baselineMetric, direction) and |final.metric-baseline|>noise:
      leave applied; return {decision:keep, finalMetric:final.metric, winnerIndex:winner.index, ranked}
    else:
      gitCheckout(main, exclude=.auto); return {decision:discard, reason:"not_confirmed", ranked}
  finally:
    cleanupWorktrees(wts)
```

---

## 10. Режим B — Orthogonal stacking

```
CheckOrthogonal(patches[P1..Pk], opts):
  baseline, baselineMetric, pre-flight (как в A)
  wts = [provisionWorktree(i) for i in 1..k]
  try:
    perPatch = parallel: spawnWorker(Pi.hypothesis, wts[i]) → {diff, metric, filesActual}
    # independence check
    conflicts = findPairs(perPatch where filesActual пересекаются)
    if conflicts: return {independence:{orthogonal:false, conflicts}, decision:discard, reason:"not_orthogonal"}

    # stacking — sort by improvement desc, apply sequentially с re-measure
    stacked = baselineMetric; applied=[]; rejected=[]
    for P in sort(perPatch, by=improvement, desc):
      gitApply(P.diff, main)
      m = runOnMain(BENCH_MODE=full, budget)
      if isBetter(m, stacked, direction) and not regressesOtherMetrics(m):
        stacked = m; applied.append(P)
      else:
        gitCheckout(main, exclude=.auto); rejected.append({name:P.name, reason:"regression_or_noop"})
    return {independence:{orthogonal:true}, stackedMetric:stacked, applied, rejected,
            decision: applied? "keep":"discard"}
  finally: cleanupWorktrees(wts)
```

Re-measure после каждой правки обязателен: ортогональность по файлам ≠ отсутствие runtime-взаимодействий (кэш, аллокатор, shared state).

---

## 11. Режим C — Space search (beam)

Stateful, состояние в `.auto/parallel/beam.json`.

```
SpaceSearch(action="step", opts):
  beam = loadBeam()  # [{commit, metric, parentCommit, hypothesis, depth, diffFromParent}]
  candidates = []
  for state in beam (K состояний):
    for j in 1..M:
      hint = opts.diversityHints[j % len]
      wt = provisionWorktree(commit=state.commit)
      r = spawnWorker(task="state.diff уже применён (wt от state.commit); улучши, подход: {hint}; ...", cwd=wt)
      candidates.append({state, result:r, hint})
  # rank all candidates globally
  pool = beam ∪ [{commit:r.commit, metric:r.medianMetric, parent:state, ...} for candidates]
  newBeam = top_K(pool, by=metric, direction)   # отсев
  saveBeam(newBeam)
  return {step, beam:newBeam, pruned: len(pool)-K, improved: newBeam[0].metric < best(beam)}

SpaceSearch(action="finish"):
  best = loadBeam()[0]
  # reconstruct commit chain from parentCommit links → cherry-pick chain into main
  cherryPickChain(best.chain)
  final = runOnMain(BENCH_MODE=full, budget)
  return {finalMetric:final.metric, decision: isBetter(...)?"keep":"discard"}
```

Worker здесь получает worktree **уже от state.commit** (не от исходного baseline) — отсюда ветвление. diversityHints принуждают разные подходы у M кандидатов одного state.

---

## 12. Юзкейсы (проработанные)

### UC-1: Best-of-N — ускорение JSON-парсера

**Контекст:** `src/parse.ts`, метрика — секунды на bench/parse (lower). measure.sh = 100 итераций парсинга, ~12с (вписывается в бюджет).
**Цель:** попробовать 4 подхода одновременно.

```
пользователь: /autoresearch parallel-best-of-n 4 "ускорь горячий путь JSON-парсера в src/parse.ts"
агент: формулирует 4 гипотезы (текст):
  H1: "Инлайн hot-loop в функции parseValue, устранить call overhead"
  H2: "SIMD-пропуск whitespace черезbulk-skip"
  H3: "Lookup-table для char-class классификации"
  H4: "Мемоизация offsets часто-читаемых полей"
агент: BestOfN(candidates=[H1,H2,H3,H4], budgetSeconds=300, repeats=3)
tool:
  pre-flight: baseline=12.3с (quick), OK
  4 worktree, 4 worker (parallel, concurrency=4)
  worker H3: -18% (median 10.1с quick); H1: -7%; H2: +2% (noise); H4: apply_failed (типизация)
  ranked: [H3, H1, H2(within_noise), H4(crash)]
  winner=H3 → git apply → re-measure full → 10.3с (-16%, подтверждено)
  decision: keep
агент: log_experiment(status=keep, metric=10.3, description="H3 lookup-table confirmed -16%")
```

**Итог:** 4 гипотезы проверены за время ≈1 раунда (стеночно), вместо 4 последовательных. Selection-bias убран re-measure.

### UC-2: Orthogonal stack — время сборки

**Контекст:** build-time метрика. 3 независимых рычага, file-scopes disjoint: Dockerfile, Makefile (linker), webpack.config.
```
агент: CheckOrthogonal(patches=[
  {name:"deps-cache", hypothesis:"многослойный кэш зависимостей", fileScope:["Dockerfile"]},
  {name:"lld", hypothesis:"параллельный линкер lld вместо ld", fileScope:["Makefile"]},
  {name:"tree-shake", hypothesis:"агрессивный tree-shaking", fileScope:["webpack.config.js"]},
])
tool:
  phase1 parallel: deps-cache -15%, lld -22%, tree-shake -8% (each disjoint files — orthogonal:true)
  phase2 stack: apply deps-cache (cum -15%) → apply lld (cum -34%) → apply tree-shake (cum -38%)
  decision: keep, stackedMetric=-38%
агент: log_experiment(keep, metric, "stacked 3 orthogonal patches: -38% total")
```

### UC-3: Space search — минимизация bundle size

**Контекст:** bundle KB (lower). Ландшафт мультимодальный (minify vs split vs dynamic-import vs drop-polyfill — конфликтующие стратегии).
```
агент: SpaceSearch(action="init", beamWidth=3, candidatesPerState=3,
                   diversityHints=["minify","code-split","dynamic-import"])
loop (агент драйвит step до converged):
  SpaceSearch(action="step"):
    3 states × 3 candidates = 9 worker'ов
    rank → top-3: [minify+split(-30%), split+dynamic(-28%), minify+drop-poly(-25%)]
    improved:true
  ...repeat...
  SpaceSearch(action="step"): improved:false → converged
агент: SpaceSearch(action="finish") → cherry-pick цепочки лучшего state → re-measure full → keep
```

**Итог:** beam поддерживает разнообразие, не застревает в локальном минимуме (как жадный sequential).

### UC-4: Budget exceeded — measure.sh слишком медленный

**Контекст:** measure.sh = полный test-suite, ~8 мин.
```
агент: BestOfN(candidates=[...], budgetSeconds=300)
tool:
  pre-flight: baseline measure (BENCH_MODE=quick) → но quick не определён в measure.sh → работает как full → 480с > 300с бюджет → budget_exceeded
  return {decision:discard, reason:"baseline_over_budget",
          steer:"measure.sh = 480с > 300с. Варианты: 1) BENCH_MODE=quick подмножество тестов; 2) кэш prebuilt артефактов; ..."}
агент: получает steer → переписывает measure.sh (добавляет BENCH_MODE case: quick=smoke-test подмножество, ~20с)
агент: повторяет BestOfN → теперь pre-flight=18с OK → fan-out стартует
```

### UC-5: CPU contention detected

**Контекст:** measure.sh = многопоточная сборка (make -j$(nproc)), грузит все ядра.
```
агент: BestOfN(candidates=[H1..H4], concurrency=4)
tool:
  pre-flight: baseline CPU-load ~98% (все ядра) → auto-lower concurrency=2
  cpuWarning в результате
  fan-out 2×2 (вместо 4 параллельно) — реальный параллелизм ограничен
агент видит cpuWarning, понимает что ускорение стеночное < 4×
```

### UC-6: Worker failure изоляция

**Контекст:** H2 (SIMD) гипотеза требует фичи, которой нет в коде; worker правит, но не компилируется.
```
worker H2: edit → run_experiment → measure.sh падает (compile error) → status:"crash", error:"..."
worker-result.json: {status:"crash", error:"type mismatch line 42", metric:null}
tool: H2 помечен crash, не участвует в ранжировании; H1/H3/H4 проверяются нормально
```
**Итог:** отказ одного worker'а не валит раунд — изоляция через отдельные процессы/worktree.

---

## 13. Изменения расширения (по файлам)

### 13.1. `extensions/pi-autoresearch/index.ts`

| Компонент | Изменение |
|-----------|-----------|
| `RunParams` | +`budgetSeconds?` (default 300); репозиционировать существующий `timeout_seconds` как hard-kill, budget — soft contract |
| `run_experiment` handler | budget-timer; флаг `budgetExceeded`; возврат нового статуса |
| `LogParams.status` enum | +`"budget_exceeded"` |
| `log_experiment` | обработка `budget_exceeded` (как crash + спец-steer) |
| **Новое:** `parallel/worker.ts` | `spawnWorker()`, `collectWorkerResult()`, `interruptRun()` — RPC-over-eventBus клиент |
| **Новое:** `parallel/worktree.ts` | `provisionWorktree()`, `cleanupWorktrees()`, `gitExec()` |
| **Новое:** `parallel/aggregate.ts` | `median()`, `mad()`, `rankCandidates()`, `noiseFloor()` |
| **Новое:** `parallel/remeasure.ts` | `runOnMain()` (apply + measure.sh + parse METRIC, без gated-tool) |
| **Новое:** tool `BestOfN` | registerTool; handler = поток §9 |
| **Новое:** tool `CheckOrthogonal` | registerTool; handler = поток §10 |
| **Новое:** tool `SpaceSearch` | registerTool; handler = §11, stateful beam |
| **Новое:** `/autoresearch parallel-*` commands | activate parallel-mode, направляют агента к skill'у |

### 13.2. `paths.ts` — без изменений

`resolveWorkDir` уже поддерживает изоляцию worktree.

### 13.3. Новый skill `autoresearch-parallel`

`skills/autoresearch-parallel/SKILL.md`:
- Триггеры: `/autoresearch parallel-*`, цели с измеримой метрикой + пространство гипотез.
- Действия (режим A): сформулировать N гипотез (текст) → `BestOfN(...)` → `log_experiment(decision)`.
- Валидация `BENCH_MODE` в measure.sh (steer дописать при отсутствии).
- Режим B: идентификация ортогональных подсистем (file-scope) → `CheckOrthogonal`.
- Режим C: init/step/finish loop → `SpaceSearch`.

### 13.4. `.auto/` layout (дополнения)

```
.auto/
├── log.jsonl              # канонический (parent-only writer)
├── prompt.md, measure.sh, checks.sh, config.json   # без изменений
├── config.json            # +parallel:{mode,concurrency,budgetSeconds,benchMode}
└── parallel/              # NEW
    ├── wt-{i}/            # worktree-ы (scratch, cleanup удаляет)
    │   └── .auto/worker-result.json
    └── beam.json          # состояние SpaceSearch (persist между step'ами)
```

---

## 14. План реализации

| Этап | Скоуп | Критерий приёмки |
|------|-------|------------------|
| **1. Бюджет** | `budgetSeconds`, статус `budget_exceeded`, BENCH_MODE-документация | run_experiment budget=10s на 60s команде → budget_exceeded + steer; BENCH_MODE пробрасывается |
| **2. RPC-клиент** | `spawnWorker`/`collectWorkerResult`/`interrupt` через event bus | ping→ready; spawn 1 worker → collect result.json; interrupt по таймауту |
| **3. Worktree-менеджер** | `provisionWorktree`/`cleanup` + копирование .auto/ | 3 worktree, независимые .auto/, cleanup не оставляет мусора |
| **4. Режим A** | `BestOfN` tool + aggregate + re-measure + skill | UC-1 на синтетике: выбирает истинный оптимум, re-measure подтверждает, лог имеет 1 keep + N discard |
| **5. Режим B** | `CheckOrthogonal` + independence-check + stacking | UC-2: 3 ортогональных патча, Σ улучшение; не-ортогональные → отказ |
| **6. Режим C** | `SpaceSearch` + beam.json + cherry-pick chain | UC-3: мультимодальная синтетика, находит глобальный оптимум чаще жадного |
| **7. Полировка** | CPU-калибровка, advisory, дашборд для раундов | UC-5: auto-lower concurrency при CPU 100% |

MVP = этапы 1–4 (бюджет + режим A). B и C — после.

---

## 15. Решения на согласование

Эти пункты зафиксируют финальную версию. Укажите согласие/правки.

| # | Решение | Альтернатива | Рекомендация |
|---|---------|--------------|--------------|
| **D1** | Фан-аут через `subagents:rpc:v1:request` (RPC-over-EventBus), spawn-only-async | (a) agent-orch через tool subagent; (b) extension spawn nested pi | **RPC** — переиспользует pi-subagents, ноль дублирования, clean tool API для агента |
| **D2** | Worktree управляем МЫ через `git worktree add` (не `worktree:true` в spawn) | положиться на `worktree:true` pi-subagents | **Сами** — полный контроль lifecycle, изоляция .auto/, не зависит от clean-git-state |
| **D3** | Worker возвращает результат через **файл** `worker-result.json` (`outputMode:"file-only"`) | парсинг свободного текста вывода | **Файл** — структурный JSON, надёжнее |
| **D4** | Worker **сам** вызывает `init_experiment` (mode propagation) | parent инжектит runtime-флаг | **Сам** — core API не позволяет инжект; init_experiment гарантированно ставит mode ON |
| **D5** | `BENCH_MODE` env-контракт в measure.sh (workers=quick, re-measure=full) | флаг subset в run_experiment | **BENCH_MODE** — measure.sh уже не имеет subset-knob; env-контракт не требует менять tool-сигнатуру |
| **D6** | Selection-bias correction: **обязательный** re-measure победителя на main (full) | доверять quick-оценке | **Обязателен** — без него best-of-N систематически переоценивает |
| **D7** | Worker'ам запрещены `BestOfN`/`subagent` tools (антирекурсия) | доверять task-инструкции | **Запретить в allowlist** — защита от бесконечного фан-аута |
| **D8** | 3 слоя бюджета (measure=300с / worker=10м / round=неявно) + pre-flight | один общий таймаут | **3 слоя** — разные сбои (медленный measure vs зависший worker) требуют разной обработки |
| **D9** | `SpaceSearch` stateful (beam.json persist), agent драйвит step | tool делает весь цикл сам | **Stateful tool + agent-driver** — LLM-суждение (когда стопить) в агенте; механика поиска в tool |
| **D10** | MVP = бюджет + режим A (этапы 1–4); B/C после | всё сразу | **Поэтапно** — A даёт немедленную ценность, B/C строятся на проверенном фундаменте |
| **D11** | Дефолтный тир для параллельных worker'ов — **fast** (дешёвая flash), НЕ наследует модель родителя | наследовать модель родителя | **Fast** — параллельное исследование должно быть дешёвым по умолчанию; re-measure и без того бесплатен |
| **D12** | Источник оценки сложности — **агент тегирует при формулировке** | эвристика по словам / scout-вызов | **Агент** — он единственный видит код+гипотезу; почти бесплатно; fallback-эвристика как страховка |
| **D13** | Cascade fallback **включён по умолчанию** (cheap-first → эскалация при apply_failed/crash/timeout) | off (один тир, failure=отбросить) | **On** — робастность даже без тегирования; экономия 70–80% токенов; `budget_exceeded` не эскалируется |
| **D14** | Конфиг тиров/complexityMap — в `.auto/config.json` (`parallel.tiers`, `parallel.complexityMap`) | хардкод / per-call только | **Config** — пользователь настраивает под свой стек моделей; per-call override поверх |

---

## 16. Открытые вопросы (для валидации на этапе реализации)

1. **`outputMode:"file-only"` в RPC spawn:** поддерживает ли pi-subagents запись результата в заданный путь при async-spawn через RPC? Если нет — fallback: worker сам пишет `worker-result.json` (через bash в task), tool читает.
2. **`concurrency` через RPC:** spawn-запросы эмитятся мгновенно, но pi-subagents может иметь внутренний spawn-budget/cap. Проверить, что N одновременных spawn не блокируются (иначе — sequencer в нашем tool).
3. **result-intercom надёжность:** доставляет ли событие гарантированно при краше worker'a? Fallback — poll `status` RPC + проверка существования `worker-result.json`.
4. **Worktree + .gitignore:** `.auto/` должен быть gitignored (иначе копирование + git worktree конфликтуют). Проверить/документировать.
5. **Windows:** `git worktree` + bash measure.sh через Git Bash (унаследовано от базы-форка). Проверить RPC event bus не имеет race на Windows.

---

*Конец ТЗ v0.2. Ожидает согласования решений D1–D10.*
