# Design: brief-declared verdicts + evidence gate

## Решения (минимум)

1. **Одно новое поле брифа `verdicts`** (массив строк). Нет поля → дефолтный набор
   `confirmed, rejected, inconclusive, waiting_for_data`. Существующие брифы и
   кампании не меняются.
2. **Одно новое поле брифа `evidence_gate`** (объект или отсутствует). Нет поля →
   проверка не активна.
3. **Ветки причин и findings — по буквальным именам** (`inconclusive`,
   `waiting_for_data` требуют reason; `confirmed`/`rejected` пишут находку).
   Не параметризуем: это расширило бы scope без требования MVP.

## Изменения в коде (только необходимое)

### research-state.ts
- `BRIEF_KEYS` += `verdicts`, `evidence_gate` (необязательные: `fieldSetProblems`
  принимает их как допустимые, отсутствие не ошибка).
- `validateBrief`: вычисляет `declared = raw.verdicts ?? DEFAULT_VERDICTS`.
  Проверки: непустой массив строк, уникальные, токен `^[a-z][a-z0-9_-]{0,31}$`.
- `validateQuestion(q, …, declared)`: каждое правило `verdict ∈ declared`
  (иначе ошибка «verdict X is not declared in brief.verdicts»); для каждого
  `v ∈ declared` ≥1 правило (иначе «has no decision rule with verdict v»).
  Текущая проверка `VERDICTS.includes` заменяется проверкой против `declared`.
- `evidence_gate` валидация: `blocked_globs` — непустой массив строк; `gate_file`
  — относительный путь без `..`; `gate_contains` — непустая строка.
- Экспорт `DEFAULT_VERDICTS`; `VERDICTS` остаётся как есть (совместимость импортов).
- Матчер glob: `matchesGlob(path, glob)` — сегменты по `/`; `**` сегмент = ноль
  и более сегментов; `*` внутри сегмента = любые символы кроме `/`. ~20 строк,
  без внешних зависимостей.

### index.ts
- `research` tool schema: убрать `enum` у `verdict` (схема статична, набор
  берётся из брифа). Описание: «verdict must be one of the brief's declared verdicts».
- `close` execute: `verdict` проверяется против `brief.verdicts ?? DEFAULT`
  (вместо `VERDICTS`). Остальная логика close без изменений.
- `record` execute: после `locateEvidence` и до `appendResearchEvent`:
  если `brief.evidence_gate` есть и `matchesAny(located.path, blocked_globs)`,
  то читаем `gate_file` (резолв от workDir, та же проверка «внутри workDir»);
  нет файла или нет подстроки → `fail("evidence_gate_blocked", …)`, запись не
  делается. Проверка только на record.
- findings routing и reason-ветки не трогаются.

### research-vectors.md
- Раздел «Brief-declared verdicts and evidence gate»: поля, дефолт, ограничения
  (ветки/находки по буквальным именам; gate — механика против случайного
  раннего чтения, НЕ защита от агента, который сам создаёт gate-файл).

## Честные ограничения (в спеке и доке)

- **Gate-файл создаёт оператор или пайплайн, не агент.** Инструмент проверяет
  наличие подстроки в файле, но не может проверить, кто его записал. Агент с
  правом записи в репо может создать gate сам — это ограничение записано явно.
- Findings для `test-consistent` не создаются (буквальные имена) — ожидаемо.
- Существующие кампании с дефолтным набором ведут себя байт-в-байт как раньше.
