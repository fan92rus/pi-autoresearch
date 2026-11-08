# Tasks: brief-declared verdicts + evidence gate

## 1. Валидация брифа (research-state.ts)
- [ ] 1.1 Поля `verdicts`, `evidence_gate` в BRIEF_KEYS; дефолтный набор; экспорт DEFAULT_VERDICTS.
- [ ] 1.2 validateBrief/validateQuestion: правила сверяются с declared-набором; тесты: собственный набор принят; confirmed отвергнут; пропущенный вердикт отвергнут; без поля — дефолт без изменений.
- [ ] 1.3 validateEvidenceGate + matchesGlob (`*`, `**`); тесты матчера (5+ кейсов); gate_file вне workDir — ошибка при draft.

## 2. Close и record (index.ts)
- [ ] 2.1 Схема research: убрать enum у verdict; close проверяет против brief.verdicts.
- [ ] 2.2 record: evidence_gate-проверка после locateEvidence и до appendResearchEvent; код отказа `evidence_gate_blocked`.
- [ ] 2.3 Тесты: close объявленным вердиктом принят; недекларированным отвергнут; record по test-глобу до gate — отказ, после gate — проход; путь вне globs — без проверки gate.

## 3. Документация
- [ ] 3.1 docs/research-vectors.md: раздел про verdicts и evidence_gate; ограничения (буквальные имена для веток и findings; gate-файл создаёт оператор, а не агент).

## 4. Гейты
- [ ] 4.1 Существующие research-суиты зелёные без правок ожиданий.
- [ ] 4.2 Полный npm test зелёный.
- [ ] 4.3 `openspec validate brief-verdicts-and-evidence-gate --strict` зелёный.

## 5. Операционные шаги (владелец, не код)
- [ ] 5.1 Поставить на паузу goal mw58qmdm-ctc7hr перед первой lob-кампанией.
- [ ] 5.2 Подготовить lob-бриф с verdicts и evidence_gate и вручную проверить его до propose.
