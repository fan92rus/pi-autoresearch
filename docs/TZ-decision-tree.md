# ТЗ: Decision Tree для autoresearch

> **Статус:** Draft
> **Версия:** 1.0
> **Связанные документы:** [PRD](./PRD-decision-tree.md)
> **Scope:** v1 — Persistent Tree + Backtracking + Composition + SimHash + UCB1 + TUI

---

## 1. Архитектура

### 1.1 Слои

```
┌─────────────────────────────────────────────────────────┐
│ TUI Layer                                                │
│  List view (current)  ←─ Tab ─→  Tree view (new)         │
├─────────────────────────────────────────────────────────┤
│ Tool Layer (new + patched)                               │
│  explore_from · tree_status · compose                    │
│  log_experiment (+tree) · run_experiment (+simhash)      │
├─────────────────────────────────────────────────────────┤
│ Logic Layer (new modules)                                │
│  tree.ts    — TreeNode, load/save, parent/child ops     │
│  simhash.ts — 64-bit fingerprint + hamming              │
│  ucb1.ts    — selection ranking                         │
│  compose.ts — diff extraction + merge                    │
├─────────────────────────────────────────────────────────┤
│ Storage Layer                                            │
│  tree.json  — structure + metadata                      │
│  refs/exp/* — git refs (protect commits from GC)        │
│  log.jsonl  — unchanged (linear log, backward compat)   │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Принцип: tree.json — опциональная надстройка

Дерево **не заменяет** log.jsonl. Оно строится **параллельно**:
- log.jsonl остаётся плоским логом (observer, dashboard, backward compat)
- tree.json хранит иерархию (new capability)
- Если tree.json не существует → система работает как раньше (zero migration)
- Если tree.json существует → log_experiment дополнительно пишет узел

Это даёт zero-migration-cost: существующие сессии не ломаются.

### 1.3 Новые модули

| Файл | Назначение |
|------|-----------|
| `parallel/tree.ts` | TreeNode interface, loadTree/saveTree, addChild, getPath, getChildren |
| `parallel/simhash.ts` | computeSimhash, hammingDistance, isPotentialDuplicate |
| `parallel/ucb1.ts` | rankNodes, isExhausted, selectForkCandidate |
| `parallel/compose.ts` | extractDiff, checkFileScopeConflict, applyPatches |

### 1.4 Интеграция в index.ts

| Точка | Изменение |
|-------|----------|
| `init_experiment` | Создаёт root node в tree.json |
| `log_experiment` | Создаёт child node + refs/exp/* |
| `run_experiment` | Pre-run simhash check (если передан `hypothesis`) |
| Новые tools | `explore_from`, `tree_status`, `compose` |
| `observer.ts` | Stagnation trigger → tree_status steer |
| TUI overlay | Tree view + Tab toggle |

---

## 2. Модель данных

### 2.1 tree.json — полная схема

```jsonc
{
  "version": 1,
  "rootId": "n0",
  "activeNodeId": "n4",
  "nextId": 7,
  "baselineMetric": 100,
  "direction": "lower",
  "metricName": "parse_time_us",
  "nodes": {
    "n0": {
      "id": "n0",
      "parentId": null,
      "children": ["n1", "n5", "n8"],
      "commit": "abc1234",
      "metric": 100,
      "hypothesis": "baseline",
      "hypothesisLabel": null,
      "status": "baseline",
      "asi": null,
      "simhashLabel": null,
      "simhashFull": null,
      "ideaId": null,
      "depth": 0,
      "createdAt": 1700000000000,
      "exhausted": false,
      "nodeType": "baseline"
    },
    "n1": {
      "id": "n1",
      "parentId": "n0",
      "children": ["n2", "n3"],
      "commit": "def5678",
      "metric": 92,
      "hypothesis": "Add AST caching layer for repeated node lookups",
      "hypothesisLabel": "AST cache",
      "status": "keep",
      "asi": { "next": "try LRU eviction policy", "bottleneck": "hash computation" },
      "simhashLabel": "A3F2E1C0",
      "simhashFull": "B7129F4A",
      "ideaId": null,
      "depth": 1,
      "createdAt": 1700000060000,
      "exhausted": false,
      "nodeType": "experiment",
      "runRef": 1
    },
    "n3": {
      "id": "n3",
      "parentId": "n1",
      "children": [],
      "commit": null,
      "metric": 88,
      "hypotesis": "Increase cache size to 256",
      "hypothesisLabel": "bigger cache",
      "status": "discard",
      "asi": { "reason": "within noise floor, no measurable improvement" },
      "simhashLabel": "A3F2E1C1",
      "simhashFull": "B7129F4B",
      "ideaId": null,
      "depth": 2,
      "createdAt": 1700000120000,
      "exhausted": false,
      "nodeType": "experiment",
      "runRef": 3
    },
    "n8": {
      "id": "n8",
      "parentId": "n0",
      "children": [],
      "commit": "ghi9012",
      "metric": 72,
      "hypothesis": "Compose AST cache (n1) + lookup table (n7) — orthogonal changes",
      "hypothesisLabel": "compose(n1,n7)",
      "status": "keep",
      "asi": null,
      "simhashLabel": null,
      "simhashFull": null,
      "ideaId": null,
      "depth": 1,
      "createdAt": 1700000180000,
      "exhausted": false,
      "nodeType": "compose",
      "composedFrom": ["n1", "n7"]
    }
  }
}
```

### 2.2 TreeNode — поля

| Поле | Тип | Описание |
|------|-----|---------|
| `id` | string | Уникальный ID узла (`n0`, `n1`, ...) |
| `parentId` | string \| null | Родительский узел (null = root) |
| `children` | string[] | ID дочерних узлов |
| `commit` | string \| null | Git commit SHA (null для discard/crash без commit) |
| `metric` | number | Значение метрики в этом узле |
| `hypothesis` | string | Текст гипотезы / описание |
| `hypothesisLabel` | string \| null | Короткое название (для display + simhash) |
| `status` | `baseline` \| `keep` \| `discard` \| `crash` \| `checks_failed` | Результат |
| `asi` | Record<string, unknown> \| null | Actionable Side Information |
| `simhashLabel` | string \| null | SimHash от hypothesisLabel (16-char hex = 64-bit) |
| `simhashFull` | string \| null | SimHash от hypothesis (16-char hex) |
| `ideaId` | string \| null | ID идеи из .auto/ideas/ backlog |
| `depth` | number | Глубина от root (0 = baseline) |
| `createdAt` | number | Unix timestamp (ms) |
| `exhausted` | boolean | Ветка помечена исчерпанной |
| `nodeType` | `baseline` \| `experiment` \| `compose` | Тип узла |
| `runRef` | number \| undefined | Ссылка на run # в log.jsonl |
| `composedFrom` | string[] \| undefined | Для compose-узлов: исходные узлы |
| `gc` | boolean \| undefined | True если commit был GC'd (ghost node) |

### 2.3 Статусы узлов

| Статус | Когда | Commit? | В дереве? |
|--------|-------|---------|-----------|
| `baseline` | init_experiment | Да (HEAD на старте) | Да (root) |
| `keep` | log_experiment(keep) | Да (новый commit) | Да |
| `discard` | log_experiment(discard) | Нет (код reverted) | Да (ghost: hypothesis сохранена) |
| `crash` | log_experiment(crash) | Нет (код reverted) | Да (ghost: hypothesis сохранена) |
| `checks_failed` | log_experiment(checks_failed) | Нет | Да (ghost) |

**Ключевой инвариант:** discard/crash/checks_failed узлы имеют `commit: null`, но сохраняют
`hypothesis` + `simhash` + `asi`. Это позволяет их искать и не повторять.

### 2.4 Top-level поля tree.json

| Поле | Тип | Описание |
|------|-----|---------|
| `version` | number | Версия схемы (1) |
| `rootId` | string | ID корневого узла (baseline) |
| `activeNodeId` | string | Узел, на котором сейчас работает агент |
| `nextId` | number | Счётчик для генерации новых ID |
| `baselineMetric` | number | Метрика baseline (n0) |
| `direction` | `"lower"` \| `"higher"` | Направление оптимизации |
| `metricName` | string | Имя метрики |

---

## 3. Git management

### 3.1 refs/exp/* — защита коммитов от GC

Каждый узел со status=keep создаёт git ref:

```sh
git update-ref refs/exp/n1 def5678
```

Naming convention: `refs/exp/<nodeId>` → commit SHA.

Это защищает коммит от git gc (unreferenced objects удаляются через ~2 недели).

### 3.2 Операции

| Операция | Git commands |
|----------|-------------|
| **Создание keep-узла** | log_experiment коммитит → `git update-ref refs/exp/n1 <newSha>` |
| **explore_from(n1)** | `git checkout refs/exp/n1` (detached HEAD) |
| **compose(n1,n7)** | `git merge-base <n1.commit> <n7.commit>` → LCA, затем apply diffs |
| **GC (ghost)** | `git update-ref -d refs/exp/n3` (удаляет ref, коммит будет собран gc) |
| **Restore main** | `git checkout master` (или原名 branch) |

### 3.3 Detached HEAD safety

`explore_from` переводит HEAD в detached state. Safety mechanism:

1. Перед checkout сохраняет текущую ветку: `tree.savedBranch = git rev-parse --abbrev-ref HEAD`
2. Если агент забыл вернуться (следующий init_experiment или session end), выводит warning
3. `restore_main()` tool: `git checkout <savedBranch>`

### 3.4 Ограничения

- Crash/discard узлы не создают refs (commit=null, нечего защищать)
- Compose-узлы создают ref на merged commit
- GC: старые discard/crash узлы (depth > N от active path) можно пометить `gc: true`
  и удалить их refs (если были созданы ошибочно). Метаданные в tree.json остаются.

---

## 4. Tool API

### 4.1 explore_from(node_id)

**Назначение:** Вернуться к любой точке дерева и исследовать оттуда.

```ts
// Параметры
{
  node_id: string;  // ID узла для перехода (например "n2")
}

// Возврат
{
  content: [{ type: "text", text: string }],
  details: {
    node: TreeNode,         // Узел куда перешли
    path: string[],         // Путь от root до этого узла
    children: TreeNode[],   // Дети этого узла (что уже пробовано)
    warning: string | null, // "Detached HEAD. Call restore_main() to return."
  }
}
```

**Логика:**
1. Проверить, что tree.json существует
2. Найти node по ID
3. Если node.commit == null → ошибка: "Ghost node (discard/crash). No commit to checkout."
4. Проверить commit доступен: `git cat-file -e <commit>`
5. Сохранить текущую ветку: `tree.savedBranch = git rev-parse --abbrev-ref HEAD`
6. `git checkout <node.commit>` (detached HEAD)
7. `tree.activeNodeId = node_id`
8. saveTree()
9. Вернуть информацию об узле и его детях

**Текст ответа:**
```
📍 explore_from(n2)
Перешёл к узлу n2 (88µs, "LRU eviction").
Path: n0 → n1 → n2
Children (уже пробовано отсюда):
  n3 "bigger cache"      discard
  n4 "precompute hash"   discard

⚠️ Detached HEAD. Для возврата на main: restore_main().
Теперь экспериментируй отсюда. Проверь tree_status для идей.
```

### 4.2 restore_main()

**Назначение:** Вернуться на основную ветку из detached HEAD.

```ts
// Параметры: нет
// Возврат: подтверждение + текущий activeNode
```

**Логика:**
1. Если tree.savedBranch существует → `git checkout <savedBranch>`
2. activeNodeId = последний keep-узел на main branch
3. Очистить savedBranch

### 4.3 tree_status()

**Назначение:** Показать дерево + UCB1 ранжирование + suggestions.

```ts
// Параметры
{
  detail: "summary" | "full" | "ucb1" | undefined;  // default: summary
}

// Возврат
{
  content: [{ type: "text", text: string }],
  details: {
    tree: ExperimentTree,
    activeNode: TreeNode,
    rankedNodes: RankedNode[],   // UCB1 ranking
    repeats: PotentialRepeat[],  // при наличии параметра hypothesis в run_experiment
  }
}
```

**Текст ответа (summary):**
```
🌳 Experiment Tree (8 nodes, depth 3)
📍 Active: n2 (88µs)

n0 100µs baseline
├── n1  92µs ● "AST cache"        keep   -8µs
│    ├── n2  88µs ● "LRU eviction" keep   -4µs  ← YOU ARE HERE
│    │    ├── n3  88µs ○ "bigger"  discard
│    │    └── n4  89µs ○ "precomp" discard
│    └── n5  90µs ● "hash table"  keep   -2µs
├── n6  81µs ● "lookup table"     keep  -19µs
│    └── n7  78µs ● "precompute"  keep   -3µs
└── n8  72µs ◆ "compose(n1,n7)"  keep  -28µs ★ BEST

UCB1 Ranking (expandable nodes):
  #1  n6  UCB1=0.71  (1 child, -19µs) — underexplored, high reward
  #2  n0  UCB1=0.44  (3 children) — baseline, try new vector?
  ❌ n1  EXHAUSTED (2 consecutive discards)

Suggestion: explore_from("n6") — underexplored branch with high reward.
```

### 4.4 compose(node_a, node_b)

**Назначение:** Объединить изменения из двух разных веток.

```ts
// Параметры
{
  node_a: string;   // ID первого узла
  node_b: string;   // ID второго узла
}

// Возврат
{
  content: [{ type: "text", text: string }],
  details: {
    conflict: boolean,
    conflicts: string[],      // файлы с конфликтами
    mergedCommit: string | null,
    newMetric: number | null,
    newNodeId: string | null,
    applied: boolean,
  }
}
```

**Логика:**
1. Загрузить оба узла из tree.json
2. Если у любого commit=null → ошибка: "Ghost node, no diff to compose"
3. Найти LCA: `git merge-base <a.commit> <b.commit>`
4. Извлечь диффы:
   - `diffA = git diff <LCA> <a.commit>`
   - `diffB = git diff <LCA> <b.commit>`
5. Проверить file-scope conflict (как CheckOrthogonal):
   - Извлечь изменённые файлы из каждого диффа
   - Если пересекаются → вернуть conflict: true со списком файлов
6. provisionWorktree на LCA commit
7. Применить diffA, затем diffB
8. Benchmark (BENCH_MODE=quick)
9. Если passed → commit, create node (nodeType: "compose", composedFrom: [a,b])
10. cleanupWorktree

**Текст ответа:**
```
🔗 compose(n1, n7)
  n1 "AST cache"    diff: src/parser/cache.ts
  n7 "precompute"   diff: src/parser/dispatch.ts
  LCA: n0 (abc1234)
  Conflicts: none ✓
  Applied diffA + diffB → benchmark...
  ✅ Merged: 72µs (-28% from baseline, -6µs from n7)
  New node: n8 (compose)
  
  → log_experiment(status="keep", metric=72, description="compose(n1,n7)")
```

### 4.5 Патч run_experiment — параметр hypothesis

```ts
const RunParams = Type.Object({
  command: Type.String({ ... }),
  timeout_seconds: Type.Number({ ... }),    // (уже required, см. предыдущий фикс)
  hypothesis: Type.Optional(Type.String({   // ← NEW
    description:
      "Краткое описание гипотезы (1-2 предложения). " +
      "Используется для pre-run повтор detection (SimHash). " +
      "Сильно рекомендуется — без него система не может предупредить о повторах. " +
      "Пример: 'Replace switch/case dispatch with lookup table for O(1) access'"
  })),
  checks_timeout_seconds: Type.Optional(...),
  budget_seconds: Type.Optional(...),
  bench_mode: Type.Optional(...),
});
```

**Pre-run simhash check** (в execute, перед spawn):

```ts
if (params.hypothesis && treeExists(workDir)) {
  const tree = loadTree(workDir);
  const activeNode = tree.nodes[tree.activeNodeId];
  const newSimhash = computeSimhash(params.hypothesis);
  
  const dupes = activeNode.children
    .map(id => tree.nodes[id])
    .filter(child => child.simhashFull)
    .map(child => ({
      node: child,
      distance: hammingDistance(newSimhash, child.simhashFull!),
    }))
    .filter(x => x.distance <= SIMHASH_LIKELY_THRESHOLD)  // ≤3
    .sort((a, b) => a.distance - b.distance);
  
  if (dupes.length > 0) {
    // Добавляем warning в текст результата (не блокируем!)
    details.potentialRepeat = dupes[0];
  }
}
```

**Предупреждение в выводе** (добавляется к стандартному output):
```
[стандартный вывод эксперимента...]

⚠️ ПОХОЖЕ НА ПОВТОР:
  n3 "bigger cache size" (discard — noise)
  SimHash distance=1 (очень похожи)
  Твоя: "Increase cache capacity to 256 entries"
  Если это другая идея — уточни hypothesis.
```

### 4.6 Патч log_experiment — создание узла дерева

После стандартной логики keep/discard/crash, **дополнительно** (если tree.json существует):

```ts
if (treeExists(workDir)) {
  const tree = loadTree(workDir);
  const nodeId = `n${tree.nextId++}`;
  const status = params.status;  // keep | discard | crash | checks_failed
  
  const newNode: TreeNode = {
    id: nodeId,
    parentId: tree.activeNodeId,
    children: [],
    commit: status === "keep" ? currentCommitSha : null,
    metric: params.metric,
    hypothesis: params.description,
    hypothesisLabel: extractLabel(params.description),  // первая строка или до "—"
    status,
    asi: params.asi ?? null,
    simhashLabel: params.description ? computeSimhash(extractLabel(params.description)) : null,
    simhashFull: params.description ? computeSimhash(params.description) : null,
    ideaId: params.asi?.ideaId ?? null,
    depth: tree.nodes[tree.activeNodeId].depth + 1,
    createdAt: Date.now(),
    exhausted: false,
    nodeType: "experiment",
    runRef: currentRunNumber,
  };
  
  tree.nodes[nodeId] = newNode;
  tree.nodes[tree.activeNodeId].children.push(nodeId);
  
  if (status === "keep") {
    tree.activeNodeId = nodeId;
    // Создать git ref для защиты коммита
    await exec("git", ["update-ref", `refs/exp/${nodeId}`, newCommitSha]);
  }
  
  // Проверить exhausted (≥3 consecutive discards among children)
  checkExhausted(tree, tree.nodes[tree.activeNodeId]);
  
  saveTree(workDir, tree);
}
```

### 4.7 Патч init_experiment — создание root node

После стандартной логики init, если tree.json не существует:

```ts
const tree: ExperimentTree = {
  version: 1,
  rootId: "n0",
  activeNodeId: "n0",
  nextId: 1,
  baselineMetric: metric,
  direction,
  metricName,
  nodes: {
    n0: {
      id: "n0",
      parentId: null,
      children: [],
      commit: currentCommitSha,
      metric,
      hypothesis: "baseline",
      hypothesisLabel: null,
      status: "baseline",
      asi: null,
      simhashLabel: null,
      simhashFull: null,
      ideaId: null,
      depth: 0,
      createdAt: Date.now(),
      exhausted: false,
      nodeType: "tree_root",
    }
  },
};
saveTree(workDir, tree);
// git update-ref refs/exp/n0 <baselineSha>
```

---

## 5. Алгоритмы

### 5.1 SimHash

**Файл:** `parallel/simhash.ts`

```ts
/**
 * 64-bit SimHash для repeat detection.
 *
 * Свойства:
 *  - Детерминированный (один текст → всегда один хэш)
 *  - Похожие тексты → маленькое Hamming distance
 *  - Не требует ML-модели, вычисляется за микросекунды
 *  - 16-char hex строка для хранения (64 бита)
 */

// Стоп-слова (English + технические глаголы-шум)
const STOP_WORDS = new Set([
  "the", "a", "an", "for", "with", "in", "of", "to", "at", "by",
  "add", "try", "use", "using", "replace", "change", "make", "get",
  "this", "that", "is", "are", "and", "or", "not", "from", "into",
  "on", "it", "we", "our", "be", "will", "would", "can", "could",
]);

/**
 * Нормализация текста → значимые токены.
 */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")   // пунктуация → пробел (Unicode-aware)
    .split(/\s+/)
    .filter(t => t.length > 2)            // убрать 1-2 char шум
    .filter(t => !STOP_WORDS.has(t))
    .map(stem);                           // простой стемминг: cache→cach, caching→cach
}

/**
 * Простой стемминг (Porter-lite): убрать частые суффиксы.
 */
function stem(word: string): string {
  return word
    .replace(/(ing|ed|es|s|er|ly|ment|tion)$/, "")
    .replace(/(.)\1{2,}/, "$1");   // collapse: caaache→cache (overflow guard)
}

/**
 * Вычислить 64-bit SimHash.
 * Возвращает 16-char hex строку.
 */
export function computeSimhash(text: string): string {
  const tokens = normalize(text);
  if (tokens.length === 0) return "0".repeat(16);

  const bits = new Int8Array(64);  // взвешенная сумма для каждого бита
  
  for (const token of tokens) {
    const hash = fnv1a(token);          // 32-bit hash каждого токена
    for (let i = 0; i < 32; i++) {       // расширяем до 64 бит (дублируем)
      const bit = (hash >> i) & 1;
      bits[i] += bit ? 1 : -1;
      bits[i + 32] += bit ? 1 : -1;
    }
  }
  
  // Финальный fingerprint: если сумма > 0 → 1, иначе 0
  let result = BigInt(0);
  for (let i = 0; i < 64; i++) {
    if (bits[i] > 0) {
      result |= (BigInt(1) << BigInt(i));
    }
  }
  
  return result.toString(16).padStart(16, "0");
}

/**
 * Hamming distance между двумя hex-строками SimHash.
 */
export function hammingDistance(hexA: string, hexB: string): number {
  const a = BigInt("0x" + hexA);
  const b = BigInt("0x" + hexB);
  let x = a ^ b;
  let count = 0;
  while (x > 0) {
    count += Number(x & BigInt(1));
    x >>= BigInt(1);
  }
  return count;
}

// Пороги для 64-bit SimHash
export const SIMHASH_EXACT = 0;
export const SIMHASH_LIKELY = 3;    // ≤3 бита = near-duplicate
export const SIMHASH_MAYBE = 6;     // ≤6 = отдалённо похож
```

### 5.2 UCB1 Node Selection

**Файл:** `parallel/ucb1.ts`

```ts
/**
 * UCB1 ranking для advisory node selection.
 *
 * Баланс exploitation (хорошие результаты) и exploration (мало детей).
 * Агент видит ранжированный список и сам решает.
 */

const DEFAULT_C = 0.5;  // exploration constant

/** Узел expandable если: не exhausted И (нет детей ИЛИ детей < maxChildren). */
function isExpandable(node: TreeNode, maxChildren = 5): boolean {
  return !node.exhausted && node.children.length < maxChildren;
}

/** Среднее улучшение детей относительно metric узла. */
function avgChildImprovement(tree: ExperimentTree, node: TreeNode): number {
  if (node.children.length === 0) {
    // Для leaf: используем собственное улучшение относительно родителя
    if (node.parentId === null) return 0;
    const parent = tree.nodes[node.parentId];
    return normalizedImprovement(parent.metric, node.metric, tree.direction, tree.baselineMetric);
  }
  const improvements = node.children.map(cid => {
    const child = tree.nodes[cid];
    return normalizedImprovement(node.metric, child.metric, tree.direction, tree.baselineMetric);
  });
  return improvements.reduce((a, b) => a + b, 0) / improvements.length;
}

/**
 * Нормализованное улучшение: (parentMetric - childMetric) / baselineMetric.
 * Положительное = хорошо (для direction="lower").
 * В диапазоне примерно [-1, 1].
 */
function normalizedImprovement(
  parentMetric: number, childMetric: number,
  direction: Direction, baselineMetric: number
): number {
  if (baselineMetric === 0) return 0;
  const raw = direction === "lower" ? parentMetric - childMetric : childMetric - parentMetric;
  return raw / Math.abs(baselineMetric);
}

/** Количество всех экспериментов в дереве (для exploration term). */
function totalExperiments(tree: ExperimentTree): number {
  return Object.values(tree.nodes).filter(n => n.nodeType === "experiment" || n.nodeType === "compose").length;
}

export interface RankedNode {
  nodeId: string;
  ucb1: number;
  exploitation: number;
  exploration: number;
  reason: string;
}

export function rankNodes(tree: ExperimentTree, c = DEFAULT_C): RankedNode[] {
  const nTotal = totalExperiments(tree);
  if (nTotal === 0) return [];
  
  const ranked: RankedNode[] = [];
  
  for (const node of Object.values(tree.nodes)) {
    if (!isExpandable(node)) continue;
    
    const exploitation = avgChildImprovement(tree, node);
    const visitCount = node.children.length;
    const exploration = Math.sqrt(Math.log(nTotal) / (1 + visitCount));
    const ucb1 = exploitation + c * exploration;
    
    let reason: string;
    if (visitCount === 0) {
      reason = "не исследован";
    } else if (exploitation > 0.05) {
      reason = `перспективная ветка (avg +${(exploitation * 100).toFixed(1)}%)`;
    } else if (exploration > 0.8) {
      reason = "underexplored";
    } else {
      reason = "neutral";
    }
    
    ranked.push({ nodeId: node.id, ucb1, exploitation, exploration, reason });
  }
  
  ranked.sort((a, b) => b.ucb1 - a.ucb1);
  return ranked;
}

/**
 * Ветка считается исчерпанной если:
 *  - ≥3 последовательных discard/crash среди последних детей
 *  - ИЛИ лучший ребёнок в пределах noise floor
 */
export function checkExhausted(tree: ExperimentTree, node: TreeNode): boolean {
  const children = node.children.map(id => tree.nodes[id]);
  
  // Сигнал 1: ≥3 consecutive discards (последние 3 ребёнка — все discard/crash)
  const recent = children.slice(-3);
  if (recent.length >= 3 && recent.every(c => c.status === "discard" || c.status === "crash")) {
    node.exhausted = true;
    return true;
  }
  
  return false;
}
```

### 4.3 Composition (diff merge)

**Файл:`parallel/compose.ts`**

Логика описана в §4.4. Ключевые функции:

```ts
/** Извлечь файлы, изменённые в коммите узла (относительно его родителя). */
function extractChangedFiles(tree: ExperimentTree, node: TreeNode): string[] {
  if (!node.commit || !node.parentId) return [];
  const parent = tree.nodes[node.parentId];
  if (!parent.commit) return [];
  // git diff --name-only <parent.commit> <node.commit>
  const r = await exec("git", ["diff", "--name-only", parent.commit, node.commit], { cwd: workDir });
  return r.stdout.trim().split("\n").filter(Boolean);
}

/** Проверить ортогональность (нет общих файлов). */
function checkFileScopeConflict(filesA: string[], filesB: string[]): {
  orthogonal: boolean;
  sharedFiles: string[];
} {
  const setA = new Set(filesA);
  const shared = filesB.filter(f => setA.has(f));
  return { orthogonal: shared.length === 0, sharedFiles: shared };
}
```

**LCA computation:**
```sh
git merge-base <nodeA.commit> <nodeB.commit>
```

**Apply diffs:**
1. provisionWorktree на LCA commit
2. `git diff <LCA> <a.commit> | git apply` (patch A)
3. `git diff <LCA> <b.commit> | git apply` (patch B)
4. Если apply падает → конфликт, вернуть ошибку
5. Benchmark
6. Commit, create node

---

## 6. TUI

### 6.1 Компоненты

| Компонент | Назначение |
|-----------|-----------|
| `TreeOverlay` | Fullscreen TUI overlay для tree view |
| `TreeRenderer` | Превращает tree.json в ASCII-дерево |
| `ListTreeToggle` | Tab-переключатель между list и tree |
| `NodeDetail` | Раскрывающиеся детали узла |

### 6.2 Tree rendering (ASCII)

```
 🌳 Experiment Tree — "parse_time_us" (lower is better)    [Tab → List view]
 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 n0  100µs  baseline
 ├── n1  92µs  ●  "AST cache"               keep   -8µs
 │    ├── n2  88µs  ●  "LRU eviction"       keep   -4µs
 │    │    ├── n3  88µs  ○  "bigger cache"  discard
 │    │    └── n4  89µs  ○  "precompute"    discard
 │    └── n5  90µs  ●  "hierarchical"       keep   -2µs
 ├── n6  81µs  ●  "lookup table"            keep  -19µs
 │    └── n7  78µs  ●  "precompute tokens"  keep   -3µs
 └── n8  72µs  ◆  "compose(n1,n7)"         keep  -28µs ★ BEST

 ─────────────────────────────────────────────────────────────────────
  ● keep   ○ discard   ✕ crash   ◆ compose   ★ best path   ← active
  ☒ exhausted
 ─────────────────────────────────────────────────────────────────────
 UCB1 suggestions:
  #1  n6  UCB1=0.81  underexplored, high reward  → explore_from("n6")
  #2  n7  UCB1=0.62  new best path
  ❌ n1  EXHAUSTED

 [↑↓ navigate] [Enter details] [e explore_from] [c compose] [Tab list]
```

### 6.3 Цвета (theme-aware)

| Элемент | Цвет |
|---------|------|
| Best path (★) | `theme.fg("success", ...)` bold |
| Keep (●) | `theme.fg("success", ...)` |
| Discard (○) | `theme.fg("dim", ...)` / `theme.fg("muted", ...)` |
| Crash (✕) | `theme.fg("danger", ...)` |
| Compose (◆) | `theme.fg("info", ...)` / blue |
| Active (←) | `theme.fg("warning", ...)` bold |
| Exhausted (☒) | `theme.fg("dim", ...)` + strikethrough |

### 6.4 Node detail view (Enter на узле)

```
 ─── n2 ──────────────────────────────────────
  Hypothesis:  LRU eviction policy for AST cache
  Status:      keep
  Metric:      88µs (baseline: 100µs, Δ -12µs)
  Commit:      def5678  (refs/exp/n2)
  Depth:       2  (n0 → n1 → n2)
  SimHash:     B7129F4A
  ASI:         { next: "try bigger cache", bottleneck: "hash" }
  Children:    n3 (discard), n4 (discard)
  Created:     2h ago
 ─────────────────────────────────────────────
```

### 6.5 Переключение List ↔ Tree

Текущий dashboard/overlay показывает плоский лог экспериментов. Добавляется:

- **Tab** (или другая клавиша) — переключение mode: `list` ↔ `tree`
- Состояние mode сохраняется в runtime (не в файл)
- При `list`: рендерится текущий список (без изменений)
- При `tree`: рендерится ASCII-дерево из tree.json
- Если tree.json не существует → tree view показывает: "No tree yet. Run init_experiment."
- **Не одновременно** — только один view за раз, как просил пользователь

### 6.6 Авто-обновление

При каждом `log_experiment` → `updateWidget()` → overlay перерисовывается.
Если активен tree view → дерево обновляется в реальном времени.

---

## 7. Observer integration

### 7.1 Stagnation → tree_status steer

Когда `observer.ts` детектирует stagnation (N runs без улучшения), вместо (или в дополнение к)
обычному stagnation steer, вызывается `tree_status`:

```
🔄 STAGNATION after 3 runs without improvement.

🌳 Tree status:
  Active node n2 EXHAUSTED (2 consecutive discards).
  Current path: n0 → n1 → n2 (dead end).
  UCB1 suggests: explore_from("n6") (UCB1=0.81, underexplored).
  Alternative: explore_from("n0") to try a new vector from baseline.

Action: call explore_from() to backtrack, or tree_status() for full map.
```

### 7.2 Новые trigger-ы

| Trigger | Условие | Steer |
|---------|---------|-------|
| **Dead end** | Active node exhausted | `explore_from` suggestion с UCB1 ranking |
| **Unexplored sibling** | Sibling node has 0 children, high UCB1 | "Consider explore_from(n_X)" |
| **Composition opportunity** | Two keep-nodes on different branches, orthogonal files | "compose(n_X, n_Y) may stack improvements" |
| **Likely repeat** | run_experiment hypothesis simhash match | Inline warning (не steer, а в output) |

---

## 8. Migration & Backward Compatibility

### 8.1 Zero-migration

- `log.jsonl` не меняется (плоский лог остается)
- `tree.json` создается при `init_experiment` (если еще не существует)
- Если сессия уже идет без tree.json → `log_experiment` продолжает работать как раньше
- BestOfN/SpaceSearch не требуют изменений (они просто не пишут в tree — это phase 2)

### 8.2 Восстановление дерева из log.jsonl (опционально)

Команда `tree_init --from-log` может построить линейное дерево из существующего log.jsonl:

```
log.jsonl: run1(keep) → run2(keep) → run3(discard) → run4(keep)
tree.json: n0 → n1(run1) → n2(run2) → n3(run3, dead) → n4(run4)
```

Это chain keep→keep→keep = linear tree. Полезно для миграции действующих сессий.

---

## 9. Файлы для создания/изменения

### Новые файлы

| Файл | LOC (est) | Назначение |
|------|-----------|-----------|
| `parallel/tree.ts` | ~200 | TreeNode, ExperimentTree, load/save, getPath, addChild |
| `parallel/simhash.ts` | ~120 | computeSimhash, hammingDistance, normalize, stem |
| `parallel/ucb1.ts` | ~180 | rankNodes, checkExhausted, isExpandable |
| `parallel/compose.ts` | ~150 | extractDiff, checkFileScopeConflict, applyPatches |
| `parallel/treeview.ts` | ~250 | ASCII tree renderer + colors |

### Изменяемые файлы

| Файл | Изменения |
|------|----------|
| `index.ts` | +3 tools (explore_from, tree_status, compose), +param hypothesis в run_experiment, +tree node creation в log_experiment/init_experiment, +TUI toggle |
| `observer.ts` | +tree-aware stagnation steer, +composition opportunity detection |

---

## 10. Этапы реализации

### Phase 1.0: Foundation (MVP tree)

**Цель:** Дерево растёт, но без interaction.

- [ ] `parallel/tree.ts` — model + persistence
- [ ] Патч `init_experiment` — создаёт root node
- [ ] Патч `log_experiment` — создаёт child nodes + refs/exp/*
- [ ] `parallel/simhash.ts` — fingerprint computation

**Результат:** Каждый эксперимент оставляет след в дереве. log.jsonl + tree.json синхронны.

### Phase 1.1: Navigation

**Цель:** Агент может перемещаться по дереву.

- [ ] `explore_from` tool
- [ ] `restore_main` tool
- [ ] `tree_status` tool (без UCB1, просто дерево)
- [ ] Detached HEAD safety

**Результат:** Backtracking работает. Агент может вернуться к любой точке.

### Phase 1.2: Intelligence

**Цель:** Дерево помогает агенту принимать решения.

- [ ] `parallel/ucb1.ts` — selection ranking
- [ ] tree_status с UCB1 suggestions
- [ ] checkExhausted integration в log_experiment
- [ ] run_experiment pre-run simhash check + warning
- [ ] Observer: stagnation → tree_status steer

**Результат:** Агент видит карту exploration, получает suggestions.

### Phase 1.3: Composition

**Ц Ortho:** Композиция идей из разных веток.

- [ ] `parallel/compose.ts` — diff merge
- [ ] `compose` tool
- [ ] Composition opportunity detection (observer)

**Результат:** `compose(n1, n7)` объединяет ортогональные улучшения.

### Phase 1.4: TUI

**Цель:** Пользователь видит дерево в терминале.

- [ ] `parallel/treeview.ts` — ASCII renderer
- [ ] TreeOverlay TUI component
- [ ] Tab toggle list ↔ tree
- [ ] Node detail view
- [ ] Color coding

**Result:** Пользователь переключается между list и tree view.

---

## 11. Открытые вопросы

1. **SimHash пороги** — нужны эксперименты на реальных гипотезах для калибровки (3/6 bits).
   Стартуем консервативно (≤3 = likely, ≤6 = maybe), корректируем по usage.

2. **UCB1 constant C** — по умолчанию 0.5. Может быть configurable через config.json.

3. **GC strategy** — когда помечать узлы как `gc: true` и удалять refs/exp/*. Phase 1 не
   делает GC (держим все refs). Phase 2 — GC старых exhausted branches.

4. **Compose merge conflicts** — Phase 1 только для orthogonal (разные файлы). Конфликты
   в одном файле = fallback на LLM-worker для ручного merge. Phase 2.

5. **Nested trees** — может ли compose-узел быть parent для новых экспериментов? Да,
   он создаётся как обычный keep-узел (activeNodeId может указывать на него).

6. **BestOfN/SpaceSearch integration** — Phase 2. Проигравшие кандидаты сохраняются как
   dead-leaf children; победитель → child-узел на main.
