# Tasks: research-tool-aliases

## 1. Alias API and delegation
- [x] 1.1 Extract/capture existing research execute callback as a private dispatcher; do not publicly register combined `research` tool
- [x] 1.2 Register `research_questions` as public campaign/question-only tool; delegate existing executor unchanged
- [x] 1.3 Register `expedition_map` as public map-only tool with top-level subaction; transform args to existing expedition action
- [x] 1.4 Add targeted cross-alias argument errors; aliases retain mode gate and renderCall always returns valid Text
- [x] 1.5 Tests: schemas disjoint; representative delegation; internal dispatcher semantics preserved; mode-off refusal; malformed/unknown alias calls; `research_questions.resolve` requires owner UI consent, clears pending-op only, and never appends map transition

## 2. Agent-facing descriptions and messages
- [x] 2.1 Update new aliases' descriptions, promptSnippet and promptGuidelines with semantic distinction
- [x] 2.2 Ensure no agent-facing description or prompt lists combined `research` as callable; document migration to the two public aliases
- [x] 2.3 Update all model-facing campaign prompts/notices (campaign resume, compaction/completion, drift/pause, approval/start, stop/report, slash-command kickoff, expedition kickoff/restart/continuation) to use the public aliases with valid action values and required arguments
- [x] 2.4 Update expedition widget next/divergence hints to name the aliases; tests assert hints don't recommend the hidden combined tool
- [x] 2.5 Add tests asserting model-facing guidance uses public aliases, one valid action per call, required stop arguments, and question-vs-direction wording

## 3. Documentation, regressions and review
- [x] 3.1 Update docs/research-vectors.md with alias schemas, examples, and removal of the public mixed tool
- [x] 3.2 Run focused alias tests and serial regression: research expedition, chain/charter, research RPC, smoke
- [x] 3.3 Independent adversarial review; fix all blockers and re-review to ГОДЕН
- [ ] 3.4 Commit only alias change files and close bd pi-autoresearch-es1.5 after green gates/review
