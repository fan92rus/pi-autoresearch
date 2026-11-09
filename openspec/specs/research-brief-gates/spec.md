# research-brief-gates Specification

## Purpose
Вердикты, объявленные брифом, и gate на чтение тестового сплита (evidence_gate) при записи доказательств.

## Requirements

### Requirement: Брифом объявляются имена вердиктов

Бриф SHALL принимать необязательное поле `verdicts` — непустой массив уникальных
строк-токенов. Если поле отсутствует, набор SHALL быть `confirmed, rejected,
inconclusive, waiting_for_data`. Каждое decision rule вопроса SHALL ссылаться на
вердикт из объявленного набора, и каждый объявленный вердикт SHALL иметь хотя бы
одно правило у каждого вопроса.

#### Scenario: Бриф с собственными вердиктами lob
- **WHEN** бриф объявляет `verdicts: ["test-consistent","rejected","inconclusive","waiting_for_data"]`
  и у каждого вопроса есть правило на каждый из них
- **THEN** draft принимает бриф; `confirmed` в правилах отвергается с ошибкой
  «verdict confirmed is not declared in brief.verdicts»

#### Scenario: Бриф без поля verdicts
- **WHEN** поле `verdicts` отсутствует
- **THEN** валидация и поведение совпадают с текущими (четыре дефолтных вердикта)

#### Scenario: Пропущенный вердикт
- **WHEN** объявлен `test-consistent`, но у вопроса нет правила на него
- **THEN** draft отказывает с ошибкой «has no decision rule with verdict test-consistent»

### Requirement: Close принимает только объявленные вердикты

`research close` SHALL принимать `verdict` только из `brief.verdicts` (или из дефолтного
набора, если поле отсутствует). Правило (`rule_id`) SHALL иметь тот же вердикт.
Ветки reason-обязательности SHALL работать по буквальным именам `inconclusive`
и `waiting_for_data`.

#### Scenario: Close объявленным вердиктом
- **WHEN** бриф объявил `test-consistent`, close отправлен с `verdict: "test-consistent"` и правилом этого вердикта
- **THEN** close записан, вектор закрыт

#### Scenario: Close недекларированным вердиктом
- **WHEN** close отправлен с `verdict: "confirmed"` в брифе, который его не объявляет
- **THEN** отказ `invalid_argument`, в log.jsonl нет события close

### Requirement: Gate на чтение тестового сплита

Бриф MAY содержать `evidence_gate` с полями `blocked_globs` (непустой массив
glob-шаблонов), `gate_file` (относительный путь внутри рабочего каталога без `..`)
и `gate_contains` (непустая строка). Если поле присутствует, `research record`
SHALL отказать с `evidence_gate_blocked` для evidence, чей путь матчит любой из
`blocked_globs`, пока `gate_file` не существует или не содержит `gate_contains`.
Без поля проверка SHALL не выполняться.

#### Scenario: Запись из test-файла до gate
- **WHEN** `blocked_globs: ["data/episodes_test*.jsonl"]`, `gate_file` отсутствует,
  и агент делает record с `evidence_ref: "data/episodes_test_v1.jsonl:3-5"`
- **THEN** отказ `evidence_gate_blocked`, в log.jsonl нет события record

#### Scenario: Запись из test-файла после gate
- **WHEN** `gate_file` существует и содержит `gate_contains`
- **THEN** record проходит, событие записано с sha256 как обычно

#### Scenario: Запись не из заблокированного пути
- **WHEN** evidence путь не матчит ни один `blocked_globs`
- **THEN** record проходит без проверки gate-файла

#### Scenario: Gate-файл вне рабочего каталога
- **WHEN** `gate_file` указывает наружу (`../x` или абсолютный путь вне workDir)
- **THEN** бриф отвергается при draft с ошибкой о пути

### Requirement: Обратная совместимость

Брифы без полей `verdicts` и `evidence_gate` SHALL давать тот же результат, что до
этого изменения, включая уже существующие суиты research-*.

#### Scenario: Существующие суиты
- **WHEN** запускаются tests/research-state.test.mjs, research-branch-wiring, research-subcommand, research-state-root, research-report-persist
- **THEN** все тесты проходят без изменения их ожиданий
