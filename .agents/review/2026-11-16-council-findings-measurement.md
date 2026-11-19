# Council, findings, measurement, and precedent review

Scope reviewed: `council.ts`, `council-tools.ts`, `council-delegation.ts`, `findings.ts`, `measurement.ts`, all six `precedent-*.ts` modules, and their principal tool-wiring sites in `index.ts`. Read-only review; no tests run.

## Findings

### High risk

1. **Finding ID allocation is not atomic across simultaneous writers** — `extensions/pi-autoresearch/findings.ts:505-524, 540-610`. Both creation and transition read/fold the file before a separate append; concurrent `record_finding` calls can both choose the same next ID, and a transition can validate against stale status. Unlike council entry writes, findings have no lock or exclusive claim. Consequence: duplicate IDs corrupt the whole store (all future writes refuse), or append transition lines with the wrong `from`. Proposal: serialize load→validate→append under a per-file lock (reuse the repository's existing JSONL lock primitive if suitable), or add a small atomic ID/transition mechanism; add concurrent writer regression tests.

2. **Council consensus has divergent implementations with different semantics** — `extensions/pi-autoresearch/council-tools.ts:172-271` vs `council-delegation.ts:166-181, 443-505`. The interactive/manual blackboard path uses `detectConsensus`: it identifies the owner from the participant roster, calculates the owner’s exclusion and latest verdict per participant, and tracks missing voters. The autonomous path independently parses outputs and its `consensusReport` excludes voters based on the hypothesis letter, but does not validate that each hypothesis ID belongs to a roster letter; duplicate hypothesis IDs can overwrite titles/ownership in one path. Changes to the contract can silently make the two council modes disagree. Proposal: move common parsing, ownership validation and consensus fold to one pure module with a shared contract; test both callers against the same fixtures.

### Medium risk

3. **Measurement folds repeatedly rescan the same ledger and can drift in error policy** — `extensions/pi-autoresearch/measurement.ts:184-202, 721-832, 835-863, 1430-1538`. `measurementLedgerFacts` calls `reconstructJsonlState`, then separately walks for change count and calls `measurementVerificationState` (which runs the ledger fold again); lookup helpers each rescan for changes/completions/verification/reverts. For large ledgers, health/dashboard/tool calls multiply full-file parsing; future record semantics must be kept consistent across several folds. Proposal: parse once into a validated measurement-ledger model, then derive epoch counter, active scale, health, and references from the same fold; retain pure-text entrypoints for unit testing.

4. **Different ledger writers have incompatible append/error/concurrency behavior** — `extensions/pi-autoresearch/findings.ts:435-439, 524, 609`; `measurement.ts:1445-1460`; `index.ts:4528, 4570, 4669, 4748, 4806`. Findings appends synchronously but throws on write errors; measurement catches and returns a string; index tool adapters format results separately. Neither store serializes read-modify-append. This is especially consequential because findings IDs and measurement epochs are allocated from current ledger state. Proposal: a shared append-only JSONL service that makes `append` failure explicit and can optionally serialize read/fold/write transactions; callers retain record-specific validators.

5. **`council-tools.detectConsensus` permits malformed roster/hypothesis relationships to produce apparently settled votes** — `extensions/pi-autoresearch/council-tools.ts:209-265`. Hypothesis ownership is inferred from the ID’s letter, falling back to the speaker suffix; unknown letters become `letter-?`, so no roster participant is excluded as owner. Duplicate names or letters in `participants` also overwrite map entries. A malformed hypothesis can therefore be settled by all listed participants even though its owner is not represented. Proposal: validate unique participant names/letters and require each `H-<letter><number>` to map to exactly one roster participant; return explicit malformed/unknown-owner status rather than counting it.

6. **Council slate field parsing is substring-oriented and can accept fields embedded in explanatory prose** — `extensions/pi-autoresearch/council.ts:728-799`. `EXPECTED_GAIN_RE` and `KILL_RE` search anywhere in section body; measurement field regexes are line anchored, but accept values based on a single nonspace character. The accepted legacy aliases, bold stripping and permissive number prefix are hard to maintain as one increasingly broad regex contract. Proposal: parse sections into structured field records (one recognized field per line), preserve explicit aliases in a table, reject duplicate/ambiguous fields, and validate finite numeric gain and non-empty payloads. Keep compatibility fixtures for the chair’s observed output variants.

7. **Precedent report persistence has a TOCTOU collision surface** — `extensions/pi-autoresearch/precedent-report.ts:760-865` (report IDs combine a fingerprint prefix and 4 random bytes; persistence helper at ~688). Search results are persisted as report files, but concurrent searches can theoretically select the same path and overwrite an already-created report if persistence uses ordinary write semantics. Reports are the evidence basis for later assessment/freshness. Proposal: persist via exclusive create (`wx`) and regenerate ID/retry on collision; test with deterministic random injection.

8. **Autonomous council performs multiple redundant blackboard reads and writes a different sequence format from manual tools** — `extensions/pi-autoresearch/council-delegation.ts:166-181, 338-343, 453-505`; `council-tools.ts:101-134`. The autonomous path parses child chat text and persists only the final chair slate, using `Date.now().slice(-6)` filenames; manual blackboard entries use monotonically scanned 4-digit sequence numbers plus exclusive-create retries. The autonomous file can sort before/after manual entries incorrectly and can collide within a millisecond, while its parse rules do not share manual entry parsing. Proposal: expose a shared blackboard repository API for atomic entry creation, sequence ordering and parsing; autonomous orchestration can continue keeping dispute rounds fileless while using the same final persistence API.

### Low risk

9. **Legacy protocol builders and current autonomous orchestration duplicate the council workflow contract** — `extensions/pi-autoresearch/council.ts:~900-1046` (`participantTask`, `chairTask`, `composeFacilitatorMessage`) and `council-delegation.ts:~166-582`. The comments say manual facilitator remains the fallback, but task wording, slate field requirements, verdict semantics and retry policy are separately encoded. In particular, the manual path asks for majority acceptance while autonomous consensus treats unanimity among non-owners as settled. Proposal: declare which path is supported fallback and extract shared prompt fragments/contracts and validators; if manual is intentionally legacy-only, mark/test that compatibility boundary to prevent unintentional drift.

10. **Index wiring contains large duplicated adapters for findings and measurement tools** — `extensions/pi-autoresearch/index.ts:4490-4818`. Five tool registrations repeat mode gate, work-dir validation, resolution, domain call, error formatting, and tool response construction; council registration is separately delegated at ~7862. This makes policy changes easy to apply to one tool but miss another. Proposal: move the tool schemas/adapters into `findings-tools.ts` and `measurement-tools.ts` with injected `assertModeActive`/`resolveWorkDir` dependencies, leaving index responsible for registration and lifecycle policy.

11. **Precedent modules repeat small but consequential validation primitives** — `precedent-assess.ts:184-190`, `precedent-report.ts:216-223`, `precedent-search.ts:221-229`, `precedent-memory.ts:~160+`. `isRecord`, bounded error text, character clipping, and unknown-input parsing are implemented separately. They differ subtly (code-point vs code-unit cap, which matters for Unicode and byte output limits). Proposal: add a tiny precedent-internal `validation.ts` with deliberately named `capCodePoints`, `capUtf8Bytes`, `isRecord`, and `errorText`; only consolidate where semantics truly match.

## Top 10 summary

| # | Finding | Risk | Primary location |
|---|---|---|---|
| 1 | Findings ID/status read-modify-append is not atomic | High | `findings.ts:505-610` |
| 2 | Manual/autonomous council consensus implementations diverge | High | `council-tools.ts:209-271`; `council-delegation.ts:443-505` |
| 3 | Measurement ledger repeatedly re-folded | Medium | `measurement.ts:184-202,721-863` |
| 4 | JSONL append behavior is inconsistent and unsynchronized | Medium | `findings.ts:435-439`; `measurement.ts:1445-1460` |
| 5 | Consensus accepts unknown/duplicate roster identity | Medium | `council-tools.ts:209-265` |
| 6 | Slate regex parsing accepts ambiguous embedded fields | Medium | `council.ts:728-799` |
| 7 | Precedent report persist may overwrite on rare ID collision | Medium | `precedent-report.ts:688-~710,760-865` |
| 8 | Council blackboard ordering differs by execution mode | Medium | `council-delegation.ts:338-343`; `council-tools.ts:101-134` |
| 9 | Manual protocol and autonomous council prompt/business rules duplicated | Low | `council.ts:~900-1046`; `council-delegation.ts` |
| 10 | Findings/measurement tool adapters inflate `index.ts` | Low | `index.ts:4490-4818` |

## Counts

- Dead/legacy code: 0 confirmed dead exports; 2 active legacy/compatibility seams (manual council fallback and tolerant slate aliases).
- Duplication/consistency: 5.
- Complexity/maintainability: 3.
- Business-logic risks: 4 (overlap with above).
- Index extraction opportunities: 1.

## Residual risks / limits

- This is a static code review; concurrency findings are inferred from the explicit load-then-append sequences, not reproduced with stress tests.
- No tests or git commands were run, as instructed.
- Full six-file precedent scope reviewed by names and selected implementations; not every line in each large module was audited.
