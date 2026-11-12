# Design: research tool aliases

## D1. API: две схемы вместо одной смешанной

```
research_questions                      expedition_map
┌─────────────────────────────┐          ┌───────────────────────────────┐
│ action: start/open/record/  │          │ subaction: open/activate/     │
│ close/stop/status/report/  │          │ resolve/reject/advisory/     │
│ resolve/chain_stop         │          │ park/reopen/pivot/status      │
│ question_id, rule_id,      │          │ dir, from, to, why, reason,   │
│ verdict, evidence_ref      │          │ refs, review_ref, sha256      │
└──────────────┬──────────────┘          └──────────────┬────────────────┘
               │                                           │
               └── adapter: map to legacy `research` execute ─┘
                                   │
                                   ▼
                 existing validation, state machine and journal

`research` remains registered as a backward-compatible legacy facade.
```

`research_questions` retains the existing campaign action field. `expedition_map` receives `subaction` at the top level and maps it internally to `{action:"expedition", subaction,...}`. Its JSON schema MUST NOT declare `rule_id` or `verdict`; `research_questions` MUST NOT declare map-only `refs`, `review_ref`, `review_sha256`, `from`, or `to`.

## D2. Implementation boundaries

- Capture the current research tool executor in a local `executeResearch` function/reference; existing `research` registration and behavior remain intact.
- Register aliases with `registerGatedTool`, preserving execution-time autoresearch mode gating.
- Alias execute delegates to the existing executor with transformed params, same context/signal/update callback. No filesystem or transition code is copied.
- Tool names, `description`, `promptSnippet`, and `promptGuidelines` explicitly state the semantic boundary: questions close via `research_questions(action="close")`; directions close via `expedition_map(subaction="resolve"|"reject", refs=...)`.
- `renderCall` accepts both legacy and alias argument shapes; each path returns a valid Text component, including malformed/unknown inputs.
- Backward compatibility: old `research` registration, accepted args, return shape, RPC/headless behavior and tool outputs remain unchanged. New instructions prefer aliases.

## D3. Messages to update

Update all agent-authored prompts that describe expedition work:
- expedition proposal confirmation reply and busy steer: activate/close/pivot through `expedition_map`; campaign question lifecycle through `research_questions`.
- `restoreExpeditionFromDisk` resume message.
- `sendChainContinuation` after a child campaign finishes.
- `expedition-finish` slash-command steer text (if present in current implementation).
- descriptions/guidelines in legacy `research` tool mark it as compatibility API and point to aliases.

Do not rewrite owner-facing slash commands such as `/autoresearch research --id`; those are not tool calls.

## D4. Compatibility and failure behavior

- Alias calls go through the exact same executor, preserving all existing refusal/error codes and journal behavior.
- Unsupported args are rejected by the alias schema/runtime adapter before delegation with a targeted hint naming the other tool when fields cross the boundary.
- Unknown subaction is rejected as invalid_argument; it must not fall through to a map event.
- Legacy direct calls continue working for existing scripts and older sessions.

## D5. Verification

Tests prove distinct schemas (question-only vs map-only), delegation equivalence for representative calls, preservation of legacy tool behavior, mode gate on aliases, clear cross-tool argument hints, alias renderCall behavior, and all expedition/charter/headless regression suites.
