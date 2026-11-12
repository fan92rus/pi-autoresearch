# Tasks: research-tool-aliases

## 1. Alias API and delegation
- [ ] 1.1 Extract/capture existing research execute callback without changing legacy behavior
- [ ] 1.2 Register `research_questions` alias with campaign/question-only schema; delegate existing executor unchanged
- [ ] 1.3 Register `expedition_map` alias with top-level subaction and map-only schema; transform args to existing expedition action
- [ ] 1.4 Add targeted cross-alias argument errors; aliases retain mode gate and renderCall always returns valid Text
- [ ] 1.5 Tests: schemas disjoint; representative delegation; legacy compatibility; mode-off refusal; malformed/unknown alias calls; `research_questions.resolve` requires owner UI consent, clears pending-op only, and never appends map transition

## 2. Agent-facing descriptions and messages
- [ ] 2.1 Update new aliases' descriptions, promptSnippet and promptGuidelines with semantic distinction
- [ ] 2.2 Mark legacy `research` as backward-compatible and recommend aliases for new calls
- [ ] 2.3 Update expedition kickoff reply/steer, restart restore, child campaign continuation and finish instructions to use aliases
- [ ] 2.4 Add tests asserting the correct tool names and question-vs-direction wording in each injected message

## 3. Documentation, regressions and review
- [ ] 3.1 Update docs/research-vectors.md with alias schemas, examples, and legacy compatibility
- [ ] 3.2 Run focused alias tests and serial regression: research expedition, chain/charter, research RPC, smoke
- [ ] 3.3 Independent adversarial review; fix all blockers and re-review to ГОДЕН
- [ ] 3.4 Commit only alias change files and close bd pi-autoresearch-es1.5 after green gates/review
