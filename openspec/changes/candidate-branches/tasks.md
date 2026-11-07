# Задачи реализации кандидатного MVP

Реализация выполнена в коммитах 2799b07, 8d2c8fe, 98ae1cf, 31c63fa, 896273f, 33ab1d6, 71a2fb3, 5cb3a9a и последующих fix-коммитах (ветка master). Доказательства (число тестов по файлам по последнему прогону): `tests/candidate-policy.test.mjs` (49), `tests/candidate-state.test.mjs` (40), `tests/candidate-worktree.test.mjs` (37), `tests/candidate-measure.test.mjs` (47), `tests/candidate-branch-wiring.test.mjs` (48), `tests/candidate-prompt.test.mjs` (22), `tests/candidate-council-phase4.test.mjs` (2); полный набор `tests/*.test.mjs`: 1305 прошли, 0 упали, 3 пропущены (pre-existing). Проверки интеграции и ручной разбор описаны в `docs/candidate-branches.md`.

## 1. Кампания и штатная работа

- [x] 1.1 Конфигурация кампании и интерактивное согласование policy с пользователем; отсутствие согласия блокирует запуск. (`candidate-policy.ts`, `init` в `candidate_branch`; wiring-тесты consent/no-UI/confirm=false)
- [x] 1.2 Состояние, один активный кандидат, `create`, `status`, `resume`, `pause`, `select`, `close` и `disable`; тесты двух кандидатов и запрещённых переходов. (`candidate-state.ts`; state- и wiring-тесты)
- [x] 1.3 Отдельные worktree, явная область изменений и checkpoint refs без изменения исходного дерева; тесты staged/unstaged/untracked, регрессии и переключения. (`candidate-worktree.ts`; worktree- и wiring-тесты dirty-tree)

## 2. Измерение и лидер

- [x] 2.1 Кандидатное измерение и учёт времени/шагов; тесты повторного запуска, лимита и сохранности checkpoint. (`candidate-measure.ts`, бюджет в `candidate-state.ts`; wiring B3, budget-exhaustion)
- [x] 2.2 Сравнение с повторными измерениями, проверкой методики, epoch и checks, автоматическое продвижение отдельного leader ref; тесты выигрыша, неизвестного контекста, конфликта и отказа checks. (`compareForPromotion`, `promoteLeader` CAS; measure-тесты, wiring confirm/promotion)

## 3. Минимальная защита и совместимость

- [x] 3.1 Один lock, отметка незавершённой операции и остановка с диагностикой без автоматического удаления; тесты прерывания переключения и неоднозначного продвижения. (`candidate-state.ts` lock/pending-op; state-тесты, wiring B-B crash-window и resolve)
- [x] 3.2 Блокировка несовместимого обычного цикла при включённом режиме; регресс обычных keep/discard и старых журналов. (guard в `run_experiment`/`log_experiment`; wiring 'ordinary loop', smoke 117, research-map 56)

## 4. Промпты, skills и итоговая проверка

- [x] 4.1 Обновить действующие промпты, шаблон и skills по `amendment-prompts-skills.md`; тесты обоих режимов, resume после прерывания и сохранности пользовательского prompt. (`before_agent_start` кандидатная ветка в `index.ts`; `candidate-prompt.test.mjs`; раздел в `skills/autoresearch-create/SKILL.md`)
- [x] 4.2 Описать пользовательский цикл, ручную диагностику, лимиты и границы гарантий; проверить примеры на фактическом API. (`docs/candidate-branches.md`; имена инструментов и действий сверены с кодом)
- [x] 4.3 Независимо прогнать полный набор тестов и OpenSpec validation, включая сквозной штатный цикл и негативные проверки из design §6. (полный набор 1305/0/3skip; `openspec validate candidate-branches --strict` и `--all` — проходят; сквозной цикл — wiring happy path; негативные проверки — wiring/state тесты)

## Workflow follow-up

- Синхронизация и архивирование изменения (`openspec sync`/`archive`) — по отдельному решению владельца.
- Известные ограничения, принятые в MVP и не закрытые кодом: candidate worktree живут в `os.tmpdir()/pi-ar-candidate` и не удаляются автоматически; время неудачного запуска не персистится (fail-closed маркер блокирует дальнейшие запуски до ручного разбора); проверка базы orphan-checkpoint по родителю без поля base в state.
