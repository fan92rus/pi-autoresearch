# Research vectors

Metric-free research campaigns for pi-autoresearch: the agent answers
pre-agreed questions autonomously instead of optimizing a number. The
ordinary `run_experiment` / `log_experiment` loop is unchanged when no
research campaign is active.

## Two-phase start

**Phase 1 — brief agreement (interactive).**

1. `research_brief draft` — create or edit the brief draft
   (`<workDir>/.auto/research/<campaign_id>/brief.json`). The brief
   holds: goal, plan source, a required verbatim caveat block, data
   roles (explore / validate / confirm), questions with text decision
   rules for every verdict (`confirmed`, `rejected`, `inconclusive`,
   `waiting_for_data`), process metrics and stop rules.
2. `research_brief propose` — the owner dialog. The dialog shows the
   brief JSON and its SHA-256 (hashed from the same bytes that are
   displayed). Only a literal `true` from `ctx.ui.confirm` approves;
   no UI or any other answer means the brief stays unapproved. The
   model cannot approve it itself: approval fields in the tool call
   are rejected.
3. The agreed brief + its hash go into the launch prompt for phase 2.

**Phase 2 — autonomous research.**

4. `research start` with `expected_sha256` from phase 1. A mismatch is
   a `brief_changed` refusal. Only one campaign may be in the research
   phase at a time.
5. `research open` — open a vector for a question id from the brief
   (one open vector at a time; closed vectors never reopen).
6. `research record` — store the conclusion with an `evidence_ref`
   (`path:lines` or `path#anchor`); the file's SHA-256 is recorded.
7. `research close` — a verdict plus the `rule_id` of that question
   with the matching verdict; `inconclusive` and `waiting_for_data`
   need a reason. The journal keeps the question and rule text.
8. `research stop` — a stop rule from the brief; after it, no new
   vectors open.
9. `research status` / `report` — question statuses, evidence hash
   checks, the caveat block verbatim. No target metric exists by
   design; available after stop as well.
10. The operator receives the report.

## Guarantees

- The brief is frozen after approval: every action re-checks its hash
  and refuses with `brief_changed` on any byte change. A new brief
  means a new campaign in its own directory; nothing is overwritten.
- Questions and rules come only from the approved brief; phase 2 never
  adds or edits them.
- Closure follows a brief rule with recorded evidence; the verdict
  must match the rule. `waiting_for_data` is used when the brief
  requires independent confirming data that does not exist (owner
  decision 5): nothing is confirmed on the old data.
- No Git operations in this mode: the tools never call git, and a
  command-position `git` in bash/powershell is blocked while a
  campaign is active (including wrappers like `env git`, `command
  git`, `bash -c '… git …'`).
- While the research phase runs, the ordinary loop (`init_experiment`,
  `run_experiment`, `log_experiment`, `propose_hypothesis`,
  `finalize_research`), `candidate_branch`, all `council_*` tools and
  the legacy `/autoresearch` flows (council, finalize, parallel-*) are
  refused. Note-taking, measurement, analysis and precedent tools
  (`inspect_results`, `tree_status`, `record_finding`,
  `update_finding`, `log_observation`, `log_measurement_change`,
  `verify_measurement_change`, `revert_measurement_change`,
  `record_analysis`, `direction_review`, `search_precedents`,
  `assess_precedents`) stay open: they write only under `.auto/`.
- Auto-continuation counts research turns as work and uses
  research-only wording; on `manual_check_required` or a stopped
  campaign nothing auto-runs.

## Agent judgment (what the system does not verify)

- Whether a rule's condition is actually met is the agent's judgment;
  the tool only checks that the rule exists in the brief for that
  question, the verdict matches and evidence is recorded.
- Evidence hashes detect later file changes (`status`/`report` mark a
  changed file as not reproducible); they do not prove reproducibility
  of the research itself.
- Data sufficiency for `waiting_for_data` is judged by the agent.

## Manual recovery

An interrupted operation leaves `pending-op.json` and blocks the
campaign (`manual_check_required`). `research resolve` is
operator-only: a dialog (`ctx.ui.confirm === true`) clears the marker;
`state.json` is never auto-repaired, and a failed or absent dialog
leaves the marker in place. A stale lock is likewise never removed
automatically. `resolve` is deliberately exempt from the
`brief_changed` refusal (owner decision): the operator resolves after
inspecting the files by hand, and their explicit dialog consent is the
recovery path.

## Not promised

- This is not an OS sandbox: the Git block works at the Pi command
  layer (tool interception). Arbitrary child processes, `/usr/bin/git`
  style paths, quoting tricks and other shell-parsing bypasses are
  documented residuals. State files under `.auto/research/` are plain
  files — protection against hand-editing them is rule-based, not
  enforced. Specifically, the interception regex is best-effort
  (owner decision after three review rounds): blocked forms cover
  command-position git, path-prefixed/case/.exe variants, quoted
  Windows paths, cmd(.exe) /c, powershell(.exe)/pwsh(.exe) with flags
  (-NoProfile -Command, quoted payloads), sh/bash/zsh/dash -c,
  env/command/xargs with options, sudo with -u/-g targets, nice with
  flag/number adjustments, and `VAR=x` prefixes. Known residuals:
  `find . -exec git ...`, nested quoting tricks (`{ git; }`, payload
  quoting inside `/bin/sh -c`). A regex cannot fully parse shell;
  review acceptance criterion is the documented boundary, not
  absolute coverage.
- Campaign phases: `briefing` (draft, not yet approved) does not
  block the ordinary loop — the block starts with the research phase
  (accepted residual). `stopped` blocks the ordinary loop and Git
  until the operator manually removes the campaign directory (no
  completion action by design; accepted residual).
- No per-question time or token limit (owner decision 3).
- No automatic computation of rule conditions; no new data collection.

## Brief-declared verdicts and evidence gate

Two optional brief fields (openspec change `brief-verdicts-and-evidence-gate`).
Absent fields keep the behaviour above unchanged.

- `verdicts` — an array of verdict names the brief declares, e.g.
  `["test-consistent", "rejected", "inconclusive", "waiting_for_data"]`.
  Absent means `confirmed, rejected, inconclusive, waiting_for_data`.
  Names are tokens `^[a-z][a-z0-9_-]{0,31}$`, unique and non-empty. Every
  decision rule's `verdict` must be declared, and every question needs a
  rule for every declared verdict. `research close` accepts only declared
  verdicts.
- `evidence_gate` — `{blocked_globs, gate_file, gate_contains}`. A `record`
  whose evidence path matches a `blocked_globs` pattern is refused with
  `evidence_gate_blocked` until `gate_file` exists inside the work directory and
  contains `gate_contains`. `gate_file` must be relative and must not contain
  `..`. Glob syntax: `*` matches inside one path segment, `**` matches zero or
  more whole segments; backslashes and a leading `./` are normalised, and matching
  is case-insensitive. The gate matches both the evidence path as written and
  its resolved path, so a symlink or junction into the blocked split is refused.

Limits of this MVP:

- Branch reasons and findings routing use the literal names only:
  `inconclusive` and `waiting_for_data` require a reason, and only
  `confirmed` and `rejected` write to `findings.jsonl`. A brief that declares
  `test-consistent` therefore writes no findings for it. This is deliberate.
- The gate file is created by the operator or the pipeline, not by the agent.
  The tool checks for the marker substring; it cannot check who wrote the file.
  The gate stops an accidental early read of the test split, not an agent that
  writes the gate file itself.
- Hard links to a blocked file are not detected: the resolved path of a hard
  link is its own name. Keep the test split out of reach of agent-written links.

## Headless launch (research)

`scripts/research-rpc.mjs` launches a research campaign without an interactive
session. It spawns `pi --mode rpc` in the target directory, activates the mode
with one message (`/autoresearch research`), sends the campaign details as a
second message after the kickoff settles, answers the brief-confirm dialog
itself, and writes a full JSONL session log.

```
node scripts/research-rpc.mjs \
  --mode research \
  --brief D:/path/brief.json \
  --approve-sha <sha256-of-brief-bytes> \
  --campaign-id bench-20261108 \
  --cwd D:/path/target \
  [--pi <path>] [--timeout-sec 3600] [--stage1-timeout-sec 30] [--log <path>]
```

Exit codes: `0` campaign reached an accepted `research report`; `1` brief-hash
refusal (session aborted) or a wrapper protocol error; `2` argument errors
(missing options, non-canonical brief) or stage-1 refusal; `3` timeout or an
unexpected pi exit (the reason is in the log).

### Consent model

The wrapper confirms the brief proposal only when all three hashes match AT THE
MOMENT of the dialog: the hash shown in the dialog, `--approve-sha`, and the
hash of the brief file re-read from disk. Any mismatch (including the file
being modified or deleted while the dialog is pending) answers `confirmed:false`,
aborts the session, exits 1. `--approve-sha` is the operator's fixed consent: the
model cannot alter its own argv. Non-brief dialogs are always refused.

### Canonical brief recipe (important)

The brief file must be in canonical form: its bytes must equal
`JSON.stringify(JSON.parse(bytes), null, 2) + "\n"`. More importantly, the bytes
must match what the agent will TYPE into `research_brief draft`: an LLM
re-serializing JSON typically sorts keys alphabetically and coerces strings
into arrays where the schema allows lists, so a hand-written brief usually FAILS
the hash check (verified live: the first bench run was refused with exit 1 -
this is the documented fail-closed behaviour, not a bug). Reliable recipe:

1. Run the wrapper once; let the agent build the draft (`research_brief draft`).
   The refusal (if any) happens at `propose`, after the draft is written.
2. Copy `.auto/research/<campaign>/brief.json` - the agent's own draft bytes -
   over your `--brief` file and compute its sha256 (e.g. via python hashlib).
3. Delete the campaign directory and rerun the wrapper with the new `--brief`
   and `--approve-sha`; the dialog hash now matches and the campaign proceeds.

### Auto-adopt retry (--auto-adopt-draft)

`--auto-adopt-draft` automates the recipe above on the SAME live pi process:
on a brief-hash refusal the wrapper reads `.auto/research/<campaign>/brief.json`,
adopts it only when the file's sha256 equals the hash shown in the dialog AND
the bytes are canonical JSON (else `auto_adopt_skipped`, exit 1), then re-sends
stage 2 with the adopted path/sha and a verbatim-transcription instruction after
the refused turn settles. Exactly one retry per run; a second refusal logs
`auto_adopt_exhausted` and exits 1. The JSONL log carries a
`{type:"auto_adopt",from_sha,to_sha}` audit event. Without the flag the refusal
path is byte-identical to the pre-flag behaviour. Trade-off to know: the adopted
brief is the AGENT's transcription, not the operator's intended text - the
dialog consent now certifies the agent's bytes. Review them before relying on
the run's verdicts.

### Projects with their own research protocol (--state-root)

Some target repos forbid writing outside a designated directory (e.g. a
protocol that allows only `runs/<run-id>/`). `--state-root <dir>` (also accepted
by `/autoresearch research --id <id> --state-root <dir>` in-session) moves where
the campaign state lives: `researchRoot(base)` becomes `<state-root>/.auto/research/<id>/`
instead of `<workDir>/.auto/research/<id>/`. Constraints:

- The state root must be a directory INSIDE the work directory (refused before
  any activation otherwise: `..`, absolute-outside and cross-drive paths).
- Evidence citations still resolve from the work directory, so the agent can
  record `lob/...` or `audit/...` artifacts while all campaign writes land
  under `runs/<run-id>/.auto/research/<id>/` - satisfying write-constrained
  protocols without losing the ability to cite source data.
- Without `--state-root` the default flow is byte-identical to the pre-flag
  behaviour (state in `<workDir>/.auto/research/`).
- Within one session the pin is honoured by the launch guard, the ordinary-loop
  block, auto-resume suppression and resume composers; a SECOND pi session must
  pass the same `--state-root` to see the campaign (accepted limitation: the
  default-root scan does not know about custom roots). A research/candidate
  campaign in a custom root still blocks the ordinary loop in its own session;
  after `/autoresearch off` the pin clears and the block lifts.

### Report and findings artifacts

`research report` now also writes `<campaign dir>/report.md` (the tool text is
returned as before, with a saved-to line; a write failure warns but does not
fail the report; report does not require a prior `stop`). `research close` with
verdict `confirmed` or `rejected` additionally appends a compact finding to
`.auto/findings.jsonl` in the work directory (theme `behavior`, status `open`,
evidence_ref from the vector's first evidence), so research verdicts become
visible to ordinary-loop tooling that reads findings; a findings write failure
warns and does not fail the close.

### Boundaries

- Headless-optimize (candidate campaigns) is NOT part of this build: the wrapper
  rejects `--mode optimize` with a scope-split message. Headless consent for
  candidate policy dialogs would need its own mechanism.
- Briefing phase does not block git or the ordinary loop (accepted residual);
  the wrapper is not an OS sandbox - command interception stays best-effort
  (see Not promised below).
- `research` is a reserved word in the `/autoresearch` parser: `/autoresearch
  research <desc>` starts a campaign; `optimize ...` free-text goals keep the
  legacy metric-loop flow unchanged.

Tests: `node --test tests/research-rpc-wrapper.test.mjs` (16, includes a real
win32 `.cmd`-shim end-to-end) and `tests/research-subcommand.test.mjs` (11).
## Finished campaigns and leaving research mode

A finished campaign (`phase: stopped`) is kept, never deleted.

- **Archive on a new draft.** `research_brief draft` that creates a new campaign directory first checks the brief. Then every finished campaign under the research root moves to `.auto/research-archive/<id>-<stamp>/` as a whole: report, log, briefs and state. This applies to the unpinned draft and to a pinned new id (`/autoresearch research --id <new>`).
- **Refusal.** If another campaign is briefing, researching or unreadable, the draft refuses and nothing moves. A single briefing campaign found without a pinned id is reused, as before.
- **Launch.** A bare `/autoresearch research <description>` is not refused by a finished campaign. It is refused only by a briefing, researching or unreadable one.
- **Stop does not leave the mode.** `research stop` keeps research mode on, so `status` and `report` still work.
- **Exit after the report.** `research report` of a stopped campaign writes `report.md` first. Only after a successful save does autoresearch mode go OFF: the OFF activation is recorded in the session, the pin is released and no automatic continuation follows. If the save fails, the mode stays on and the report says so.
- **Restoring an archived campaign** is manual: move its directory back under `.auto/research/`.

Spec: `openspec/changes/research-exit-and-archive/`.

## Stale campaigns: closure at launch

A bare `/autoresearch research <description>` (without `--id`) closes existing
blocking campaigns before launching. This is not timer-driven; `--id` resumes
never trigger it, and a campaign pinned to the current session is never closed
by the guard.

A campaign is closable only when its phase is `briefing` or `research`, it is
not pinned to this session, has no `pending-op.json`, has readable and valid
`state.json`, and is not part of an active charter chain. Otherwise the launch
fails closed and gives a reason for each blocking campaign. This includes a
pending operation, unreadable or invalid state, active-chain membership, and
an approved brief whose hash no longer matches `brief.json` (`brief_changed`).
A pinned campaign follows the existing “resume it …, or finish it first” refusal.
Closable campaigns already handled in the same pass remain stopped if another
campaign refuses the launch; an active-chain campaign's journal is untouched.

Closure appends `{event:"abandon", reason:"stale"}` as the final journal event,
then changes the phase to `stopped` through the atomic update protocol. The
saved `report.md` reflects actual state: open questions remain open, with no
verdicts, and it explicitly says the campaign was not completed (closed as
stale). For a briefing campaign without an approved brief, the report embeds
the draft brief verbatim and omits question-status and stop sections. No
verdicts or success wording are fabricated. Any journal event after `abandon`
makes replay unreadable (fail-closed).

Stopped campaigns are moved, never deleted, by the next `research_brief draft`
archive flow into `.auto/research-archive/`.

Reminders follow campaign state: closing the last open question points to
`research stop <rule_id>` and `research report`; auto-resume and drift reminders
suggest continuing research only while questions remain open, and suggest
`research stop <rule_id>` plus `research report` when all are closed (never
“open”). No reminder is delivered for pending-op, unreadable, or stopped
campaigns. The auto-resume-limit notification names a questions-complete but
unfinalized campaign.

## Run: `node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-state.test.mjs tests/research-branch-wiring.test.mjs`

Module and wiring suites: `tests/research-state.test.mjs` (52),
`tests/research-branch-wiring.test.mjs` (22).

## Research chain (research-charter)

A charter lets the agent run a chain of research campaigns without an owner
dialog per brief. Spec: `openspec/changes/research-charter/`.

- **Launch**: `/autoresearch research --charter <path>` shows the charter in a
  dialog whose first line is `Charter SHA-256: <hex>`; only the owner's `true`
  starts the chain. The charter file must live outside the work directory.
- **Charter fields** (JSON allowlist): `max_campaigns`, `max_depth` (root = 0),
  `stop_rules`. All optional; no limits means an unlimited chain (owner decision
  2026-11-10). Verdicts, `evidence_gate` and the caveat block cannot be changed
  inside a chain.
- **Child briefs** are approved without a dialog when every check passes:
  caveat verbatim, effective verdict set, evidence_gate, and `finding_refs` that
  each point at a question closed with evidence under a declared verdict in a
  campaign of this chain. Approval is written with `source: charter`.
- **Pause and stop**: an intermediate report keeps research mode ON and gives one
  continuation. `research chain_stop` needs the operator's dialog (the model
  cannot stop the chain). Reaching a charter limit sets `limit_reached` and turns
  research mode OFF.
- **Journal**: `.auto/research-chain/<id>/chain.json` (append-only, hash-linked)
  with the head in `chain-head`. A broken or missing journal blocks chain actions
  until manual check.

Known limits: the agent writes its own findings and stop-rule self-reports
(residual risk, see design.md).

## Экспедиция

Экспедиция — это цепочка исследовательских кампаний с картой направлений
(векторов), сохранённой в журнале цепочки. Она позволяет агенту выбирать и
обосновывать следующие этапы исследования, а владельцу — следить за картой в
TUI и получить общий отчёт. Экспедиция использует механизм charter-цепочки;
карта не означает, что территория исчерпывающе исследована.

### Запуск и проектирование

Владелец запускает проектирование командой `/autoresearch expedition <цель>`.
В обычном диалоге агент выясняет недостающие данные о территории, критериях,
ограничениях и стартовых направлениях одним пакетом вопросов, без серии
промежуточных подтверждений. Пока документ не подтверждён, цепочка и её журнал
не создаются. Если предыдущий черновик сохранился после потери сессии, агент
может использовать его для предложения.

Документ формируется через `expedition_brief draft` и включает:

- `charter` — правила и лимиты цепочки;
- `goal` — цель экспедиции;
- `directions` — непустой список направлений с именами и обоснованиями;
- `campaign0` — бриф стартовой кампании.

Черновик хранится в `<state-root>/research-expedition-drafts/`. Предлагаемый на
подтверждение документ должен находиться вне рабочей директории. Команда
`expedition_brief propose` проверяет его состав и показывает цель, направления,
вопросы кампании №0, стоп-правила и лимиты. В первой строке диалога указан
`Expedition SHA-256: <hex>`; подтверждение принимает только `true`. Это одно
подтверждение фиксирует документ целиком, включая хартию и стартовый бриф —
отдельных подтверждений Charter и Brief №0 нет. Система повторно сверяет хеш
файла в момент ответа. Отказ или изменение файла не создаёт цепочку.

После подтверждения в журнал записываются `chain_created`,
`expedition_created`, события открытия стартовых направлений и
`campaign_added` для кампании №0, которая запускается. Подтверждённый SHA-256
документа далее используется как хеш-якорь хартии.

Рабочий цикл экспедиции: подтверждение документа → `research expedition
activate` выбранного направления → работа кампании (open/record/close) →
закрытие направления (resolve/reject/advisory/park) → activate следующего →
бриф следующей кампании. Системные сообщения (после propose и в continuation
после отчёта кампании) предписывают именно этот порядок, чтобы направления
не оставались в статусе open при работающей кампании. Виджет подсвечивает
расхождение «кампания в фазе research, активного направления нет» строкой
с предупреждением и подсказкой команды, а `next:` в футере показывает
следующее действие, а не сырой статус цепочки.

### Переживание рестарта

Привязка экспедиции к сессии живёт в памяти процесса, но экспедиция
переживает перезапуск pi. При создании цепочки рядом с `chain.json` пишется
маркер `expedition.json` (цель, путь и SHA-256 документа, кампания, хартия).
При старте новой сессии расширение сканирует `.auto/research-chain/`:
самая свежая цепочка со статусом `active`/`awaiting_child` и валидным
маркером (дайджест совпадает с журналом) восстанавливается — виджет,
режим и сообщение-возобновление с срезом карты возвращаются без участия
владельца. Цепочка без маркера, с повреждённым маркером, несовпадающим
дайджестом или файлом `manual-check` не восстанавливается (fail-closed):
владелец видит обычный дашборд и может возобновить кампанию вручную через
`/autoresearch research --id <кампанию>`. Если активных цепочек на диске
несколько, восстанавливается самая свежая, остальные перечисляются в
сообщении как невосстановленные.

### Карта направлений и решения агента

Карта вычисляется повторным проигрыванием проверенного append-only журнала.
Последнее событие по направлению определяет его статус. События несут
обоснование, а решения, меняющие карту, валидируются до записи: отказ не
меняет журнал.

| Статус | Значение |
|---|---|
| `open` | Направление открыто и ожидает выбора для исследования. |
| `active` | По направлению идёт кампания. Одновременно активно не более одного. |
| `resolved` | Направление закрыто находками с доказательствами и ссылками на вердикты. |
| `rejected` | Направление отклонено находками с доказательствами и ссылками на вердикты. |
| `advisory_exhausted` | Агент считает направление исчерпанным по обзору; это самоотчёт, НЕ доказательство. |
| `parked` | Направление отложено с указанной причиной; оно остаётся незавершённым. |

Допустимые переходы: `open` → `active` или `parked`; `active` → `resolved`,
`rejected`, `advisory_exhausted` или `parked`; из `parked`, `advisory_exhausted`,
`resolved` и `rejected` можно вернуться в `open` через `reopen`. `resolved` и
`rejected` требуют ссылок на закрытые с доказательствами вопросы кампаний этой
цепочки. `advisory_exhausted` требует существующий обзор с записанным SHA-256,
но основание всё равно не является доказательством. `park` и `reopen` требуют
причины. Второе направление нельзя активировать, пока первое активно.

Обычный рабочий цикл агента выглядит так:

1. Прочитать срез карты, результаты и открытые вопросы текущей кампании.
2. Обосновать выбор следующего направления в рамках цели, хартии и лимитов.
   Агент может активировать `open`-направление; при смене приоритета — атомарно
   выполнить `pivot`, закрывая текущее активное и открывая/активируя целевое.
3. Создать и запустить следующую кампанию предусмотренным механизмом цепочки.
   После промежуточного отчёта агент получает продолжение с бриф-указанием и
   текущим срезом карты; обычная цепочка продолжает работать без среза карты.
4. На основании результатов выбрать закрытие с доказательствами, advisory по
   обзору или парковку с причиной. Решение и основание остаются в журнале;
   затем цикл выбора следующего этапа повторяется.

Переходы `open` → `active`, `active` → `resolved|rejected|advisory_exhausted|parked`,
а также `pivot` фиксируют явный выбор агента. `resolved`/`rejected` нельзя
использовать как оценку «на глаз»: проверяются ссылки на доказательные
вердикты. Владелец может остановить экспедицию в любой момент через диалог
`chain_stop`; остановка не зависит от значения предиката.

Пример фрагмента `chain.json` (события append-only; при создании перед ними
идёт общее `chain_created`, после них — `campaign_added` для кампании №0):

```jsonc
{"type":"expedition_created","goal":"Понять поведение векторов","doc_sha256":"9f2a…"}
{"type":"direction_opened","dir":"D2","why":"Проверить обработку отрицательных векторов"}
{"type":"direction_activated","dir":"D2","campaign":"c1","why":"Начать с наиболее рискованной гипотезы"}
{"type":"direction_resolved","dir":"D2","refs":[{"campaign":"c1","question":"Q2"}],"why":"Вопрос закрыт вердиктом с доказательством"}
{"type":"pivot","from":"D2","to":"D5","reason":"Новая находка сместила приоритет","refs":[]}
{"type":"expedition_stop","rule":"territory_complete","basis":"predicate"}
```

`pivot` атомарно переводит активное направление и целевое в новые состояния;
если любой элемент перехода невалиден, запись целиком отклоняется. Действие
карты на обычной charter-цепочке отказывает как `not_an_expedition`. Повреждённый
журнал блокирует действия и требует ручной проверки.

### Предикат остановки `territory_complete`

Предикат истинен, если открыто хотя бы одно направление исторически, сейчас
нет направлений `open` или `active`, и после последнего закрывающего события
нет более позднего `pivot`. В противном случае он ложен. Поэтому припаркованные
и `advisory_exhausted` направления сами по себе не мешают истинности, но должны
быть явно перечислены как незавершённые. Агентское самоотмечание правила
`territory_complete` при ложном предикате отклоняется с перечнем открытых
направлений (или указанием на pivot после закрытия); при истинном цепочка
останавливается по правилу. Тексты говорят «предикат выполнен»: это только
механическое отсутствие открытых направлений, не утверждение полноты
исследования. Владелец может остановить цепочку при любом
значении предиката.

### Виджет TUI

При активной экспедиционной цепочке и доступном UI виджет `autoresearch`
показывает цель и текущую кампанию/статус, по строке на направление, а также
счётчики направлений и кампаний и следующий статус цепочки. Глифы статусов:
`○` open, `🔄` active, `✅` resolved, `❌` rejected, `❓` advisory_exhausted,
`💤` parked. Для активного направления показываются кампания и её открытые
вопросы; для остальных — обоснование. Advisory помечается как самоотчёт, не
доказательство. Виджет строится из файлов и replay журнала. Вне экспедиции
обычный дашборд не меняется; без UI виджет не отображается.

### Отчёт экспедиции

При любом финальном статусе экспедиционной цепочки создаётся
`expedition-report.md` в каталоге цепочки и включается ссылка на него в ответ
финального отчёта. В нём есть разделы `Map (final)` (карта финальных статусов,
основания и ссылки на доказательства), `Timeline` (хронология решений, включая
открытия, активации и pivot) и `Unfinished`, вычисленное значение
`territory_complete` и ссылки на отчёты кампаний. Незавершённые parked-направления указываются как «не
исследовано», advisory — как «не доказательство»; если активная кампания
остановилась без результата, расхождение также указывается. Отчёт экспедиции
дополняет, но не заменяет и не архивирует отчёты кампаний.

### Headless-запуск

`scripts/research-rpc.mjs` принимает пару параметров:

```text
--expedition-doc <path> --approve-expedition-sha <64 lowercase hex>
```

Пара взаимоисключающая с `--brief`, `--approve-sha` и `--charter`. Документ
должен быть существующим каноническим JSON: его байты равны
`JSON.stringify(JSON.parse(bytes), null, 2) + "\\n"`. Хеш сверяется по трём
значениям: показанный `Expedition SHA-256`, заданный оператором хеш и заново
прочитанный хеш файла в момент диалога. Любое несовпадение отвечает отказом и
не создаёт состояния. Подтверждение документа покрывает кампанию №0; отдельные
флаги или диалог подтверждения брифа не нужны. Промежуточный отчёт не завершает
запуск: обёртка доставляет продолжение, а завершение хода в `awaiting_child` —
штатный код 0. Коды: `2` — ошибка аргументов/каноничности до запуска pi;
`3` — несовпадение хеша или отказ подтверждения; `0` — штатное завершение,
включая паузу `awaiting_child`. Другие существующие сценарии обёртки сохраняют
свои коды выхода.
