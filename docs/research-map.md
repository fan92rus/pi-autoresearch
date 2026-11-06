# Research map: observations, analysis and direction review

This guide covers the three research-map tools added to pi-autoresearch: `log_observation`, `record_analysis` and `direction_review`, plus the `activity_type` label on `log_experiment`. It describes the contracts as implemented in `extensions/pi-autoresearch/index.ts` and the modules it wires in. The design rationale lives in `openspec/changes/research-map/design.md`.

All three tools are gated: they refuse to run unless autoresearch mode is on (`/autoresearch on`).

---

## What the tools do and do not do

- **Observations** record preparation, diagnostic or infrastructure events about a run (warm-up passes, measurer checks, OOM during teacher generation). They are not runs: they never touch git, the working tree, `best`, streak, or `log.jsonl`.
- **Analysis records** declare how a comparison was planned (`prereg`), which runs were compared and under what control (`comparison`), which claims are backed by which references (`attribution`), and optional values added to an earlier record (`supplement`). They never change runs, git or best.
- **Direction review** writes one Markdown document under `.auto/reviews/`. It runs no experiment, chooses no direction and performs no automatic action.
- **Hints** are advisory lines appended to a tool response on a state transition. They propose a direction review; they never assert that a direction is exhausted.

Declarations made by the agent (passport components, control, subjects, noise) are recorded as declarations. The system does not verify them.

---

## Tools

### `log_observation`

Records one observation about a run. Use it instead of a fake `crash` or `explore` run for an event that is not an experiment.

| Parameter | Type | Required | Rule |
|---|---|---|---|
| `outcome` | `success` \| `technical_failure` \| `unknown` | yes | |
| `description` | string, 1–500 characters | yes | free text |
| `linked_run` | `"last"` or integer ≥ 1 | no (default `"last"`) | run the observation belongs to |
| `activity_type` | `intermediate` \| `attribution` | no (default `intermediate`) | label only |
| `metric` | finite number | no | omit when nothing was measured |
| `metrics` | object, at most 16 finite numbers | no | secondary values |
| `asi` | object | no | free-form diagnostics |
| `passport` | `{ "components": { <name>: { "ref", "declared_sha256" } } }` | no | at most 16 components; see [Passport](#passport) |
| `idempotency_key` | string matching `^[A-Za-z0-9._-]{1,64}$` | no | repeated call with the same key and same input returns `already_recorded` |

Unknown keys are rejected. In particular the agent cannot pass `run`, `status`, `commit`, `type`, `epoch`, `segment` or `observed_run`: the run binding is computed by the system from the ledger markers.

`linked_run: "last"` selects the last run marker in `log.jsonl`, which is the last marker of the shared ledger, not necessarily the caller's own run. With concurrent sessions, pass an explicit integer.

**Response** (on success):

- `status`: `appended` or `already_recorded`
- `obs_id`, `observed_run`, `observed_run_dir`, `run_started_at`
- `run_settled`, `binding` (`verified` / `unverified` / `unsettled`)
- `run_link`, `run_epoch`, `run_epoch_basis`, `epoch_at_record`
- `metric_provenance` (`none` / `output_match` / `wallclock` / `manual`), `torn_lines`, `dedup` (`key` / `none`), `warnings`
- `run_passport_view` (read-only view of the linked run's declared components)

**Errors** (nothing is written): `invalid_input`, `dangling_run`, `no_settled_run`, `run_without_artifacts`, `artifacts_missing`, `ledger_torn_tail`, `ledger_unavailable`, `observation_lock_busy`, `observation_lock_failed`, `observations_unavailable`, `idempotency_conflict`, `record_too_large`, `passport_too_large`.

### `record_analysis`

Appends one analysis record to `.auto/analysis.jsonl` under `analysis.lock`. The first field is `kind`; every other field is valid only for the kinds listed below. Unknown fields are rejected.

**`kind: "prereg"`** — pre-registration of branches and an optional exhaustion rule. Call it before the candidate run.

| Field | Rule |
|---|---|
| `axis` | `^[a-z][a-z0-9_-]{0,63}$`, optional |
| `hypothesis_id` | `^n[0-9]+$`, optional |
| `branches` | 1–8 items: `name` (`^[a-z][a-z0-9_]{0,31}$`, unique), `metric_name`, `op` (`<`, `<=`, `>`, `>=`), `threshold` (finite), `meaning` (≤ 200) |
| `noise_band` | number ≥ 0, optional |
| `noise_basis_ref` | typed reference, optional (see [References](#references)) |
| `exhaustion_rule` | `{ metric_name, direction: "lower" \| "higher", threshold_gain > 0, k: 2–10 (default 3) }`, optional |

The ledger prefix (`ledger_prefix_bytes`, `ledger_prefix_sha256`) and `content_sha256` are computed by the system, not passed in.

**`kind: "comparison"`** — declares a comparison between two runs.

| Field | Rule |
|---|---|
| `purpose` | `champion_recheck` \| `component_attribution` \| `measurement_check` \| `exploration` \| `other` (required) |
| `purpose_text` | 1–200 characters; required with `other`, forbidden otherwise |
| `baseline_run`, `candidate_run` | integers ≥ 1, must differ (required) |
| `metric_name` | optional metric name |
| `changed_components` | up to 16 unique component names; absent means "not declared" |
| `noise_band`, `noise_basis_ref` | optional context; not a noise source for the exhaustion signal |
| `prereg_id` | `pre-…` id of an existing prereg, optional |
| `axis` | optional axis label |
| `review_requested` | boolean; `true` requires `axis` |

**`kind: "attribution"`** — states a claim and the records that support it.

| Field | Rule |
|---|---|
| `claim` | 1–300 characters (required) |
| `subjects` | 1–2 unique component names, optional |
| `comparison_id` | `cmp-…` id, optional |
| `evidence_refs` | up to 8 typed references |

**`kind: "supplement"`** — fills a missing field of an earlier record, or declares it absent. It never overwrites.

| Field | Rule |
|---|---|
| `target_id` | id of a `comparison`, `attribution` or `prereg` record (required) |
| `field` | `changed_components`, `purpose_text`, `noise_band`, `noise_basis_ref` or `subjects`; must fit the target kind |
| `value` | value of the field's type; exclusive with `absent` |
| `absent` | `{ reason: "not_available" \| "not_measured" \| "owner_declined", note?: ≤ 200 }`; exclusive with `value` |

A field that is already recorded returns `field_already_recorded`; a second supplement of the same field returns `supplement_conflict`. Neither writes a record.

`passport` is accepted on every kind and validated with the same rules as `log_observation`.

**Response:** `{ "status": "appended", "id", "kind" }`. Computed fields (control, delta eligibility, prereg order) are shown for information only; they are recomputed on every read and never stored.

**Errors** (the call is rejected as a whole): `invalid_input`, `invalid_evidence` (any reference fails the checks), `unknown_reference` (`comparison_id`, `prereg_id`, `baseline_run`, `candidate_run` or `target_id` not found), `analysis_lock_busy`, `analysis_lock_failed`, `analysis_unavailable`, `ledger_torn_tail`, `ledger_unavailable`, `record_too_large` (over 16 KiB), `record_write_failed`, `field_already_recorded`, `supplement_conflict`.

### `direction_review`

No parameters: call it with `{}`.

It reads `log.jsonl`, `observations.jsonl` and `analysis.jsonl`, and writes one new file, `.auto/reviews/direction-<UTC-timestamp>.md`. If the name is taken, it adds a `-2`, `-3`, … suffix. Existing documents are never rewritten.

The document has these sections, with the headings in Russian as the code emits them:

1. `## Факты` (facts: status counts, `runsSinceBestImprovement`, best per epoch, activity and outcome tables, active scale, measurement health)
2. `## Неизвестно` (unknown: unverified, unsettled or orphan observations, unproven prereg, links that are absent or ambiguous, incomplete data)
3. `## Признаки` (signals: S_stag, S_ser, S_exh per key, S_exh_adv per axis; `not_assessed` shown as `unknown` with a code)
4. `## Альтернативы` (alternatives: continue, change axis, controlled comparison, stop; no choice is made)
5. `## Что не доказано` (what is not proven, with evidence levels)
6. `## Рекомендации (не действия)` (up to three recommendations, each pointing to a section; none is an action)

The document always contains these two phrases:

- «Надёжность алгоритма не оценивается: документ сводит факты и срабатывание признаков.» (the algorithm's reliability is not assessed: the document only summarizes facts and triggered signals)
- «Исчерпание направления и полная сопоставимость результатов не подтверждены.» (exhaustion of a direction and full comparability of results are not confirmed)

### `log_experiment`: `activity_type`

`log_experiment` accepts an optional `activity_type`:

- values: `measurement`, `intermediate`, `verification`, `attribution`
- omit it when no label applies; an invalid value is rejected with the list of allowed values
- stored in the ledger row only; it never changes `status`, keep/discard, git, best, streak or the epoch
- a row without the field is read as `unknown` by the direction review, so existing calls behave as before

---

## Data files

All files are under `.auto/`. Each one is append-only JSONL unless noted.

| File | Written by | Holds | Lock |
|---|---|---|---|
| `log.jsonl` | `run_experiment`, `log_experiment`, measurement tools (unchanged by the new tools) | runs, markers, scale changes | none (existing writers) |
| `observations.jsonl` | `log_observation` | one `observation` record per call: `v: 1`, `obs_id`, binding and epoch snapshots, `outcome`, `activity_type`, optional `metric`, `metrics`, `asi`, `passport`, `idempotency_key`, `input_sha256`, `metric_provenance` | `observations.lock` |
| `analysis.jsonl` | `record_analysis`; `run_experiment` takes the same lock to snapshot the prefix before a run starts | one `analysis` record per call: `v: 1`, `record: "analysis"`, `kind`, `id` (`pre-` / `cmp-` / `clm-` / `sup-`), `recorded_at`, `content_sha256`, plus the kind fields | `analysis.lock` |
| `run-links.jsonl` | `log_experiment`, after a successful ledger row | one record per confirmed link: `v`, `execution_id`, `run_dir`, `started_sha256`, `result_sha256`, `log_sha256`, `analysis_prefix_bytes`, `analysis_prefix_sha256` (the prefix pair is `null` when not confirmed) | `run-links.lock` |
| `reviews/direction-<UTC>.md` | `direction_review` | one Markdown document per call | none |
| `runs/<N>/` | `run_experiment` | run output (`output.txt`), declared artifacts, `manifest.json` | none |

The lock files (`observations.lock`, `analysis.lock`, `run-links.lock`) hold a token, pid and host. They are removed on normal release. A lock left by a crashed process is never stolen automatically; see the procedure below.

**Manual unlock.** A held or stale lock is reported with its path and the instruction: if no other pi processes are running in this directory, delete the lock file and retry. Nothing steals a lock automatically. Do not delete the data files to clear a lock.

**Run-link sidecar.** `run-links.jsonl` is the only file that confirms a link between a ledger row and a run directory. It is append-only. A corrupt or unreadable line makes the link of every run that has a ledger row `ambiguous` until the file is archived by hand (see [Run links](#run-links-fail-closed)).

---

## Passport

The passport describes the state of one run: `weights`, `prompt`, `dataset`, `measurer` and `code_ref` are the five components the view shows. Other components with names matching `^[a-z][a-z0-9_]{0,31}$` are accepted and stored, but the view does not display them.

Each component is one of:

- `declared`: the agent supplied `ref` and/or `declared_sha256`, and the values passed the form checks. `verified` is always `false`.
- `unknown`: nothing was supplied, or the `ref` was refused. The refused string is not stored, not even in part; only a reason code is kept.

Rules that matter for the agent:

- `declared` means "declared by the agent". It does not mean the file exists, is reproducible, or matches a hash. The system never reads passport files and never hashes them.
- A `declared_sha256` must be 64 hex characters; it is stored in lower case. Any other value rejects the whole call with `invalid_input`.
- A `ref` must be a relative path inside the project. Absolute paths, URLs and drive letters are refused (`non_local_ref`); `..`, colons, control characters and over-long values are refused (`invalid_ref`); a segment named `.auto`, `.git` or `node_modules`, a `.env*` name, `id_rsa`, or a `.pem`/`.key` suffix is refused (`denied_by_policy`). The denylist is a shape filter, not a security boundary.
- The passport view for a run is shown only when the run link is `proven`. Declarations from different observations that disagree make the component `unknown`; the system does not pick one.

---

## References

Analysis and noise references are typed objects, never file paths:

```json
{ "run": 57, "artifact": "output", "lines": [1, 40], "anchor": null }
```

- `run`: integer ≥ 1. Only `.auto/runs/<run>/` is ever read.
- `artifact`: `output` or `manifest`.
- `lines`: `null` or a two-item integer range. It selects the region shown to a reader; it does not choose the value that is compared.
- `anchor`: `null` or a string of up to 200 characters.

A path in the input is rejected. Files outside `.auto/runs/<run>/` are not opened.

---

## Run links (fail-closed)

An observation or a comparison is tied to a run only through a proven link. A link is `proven` only when all of the following hold: one valid `run-links.jsonl` record, exactly one ledger row with that `run`, one complete ledger line per recorded hash, matching `run_dir` and `started_at`, the order start < result < row, `binding = verified`, and no torn line in between.

Otherwise the link is `absent` (the ledger is intact and has no row for the run) or `ambiguous` (anything else, including an ordinary row without a sidecar record, an ambiguous tail, or a damaged sidecar).

Consequences of a link that is not `proven`:

- no trusted epoch (`run_epoch` is `null`);
- passport components are `unknown`;
- comparisons have no delta and their windows are not assessed;
- exhaustion keys that depend on the run are `unknown`, never `true`.

**Damaged sidecar.** A torn or unreadable line in `run-links.jsonl` is treated as a damaged sidecar. The reader then marks the affected links `ambiguous` and computes the warning `run_links_corrupt` (or `run_links_unavailable` for a read error). The system never repairs, deletes or copies evidence on its own. Appending after a torn line does not clear the failure.

**Recovery.** The supported procedure is to archive the whole file (move it out of `.auto/`). The next `log_experiment` that confirms a link creates a new, empty file. Archiving does not restore old links: they stay `ambiguous`. Editing or deleting a line in place is outside the trust model.

**Current limitation.** The `run_links_corrupt` and `run_links_unavailable` codes are produced by the reader, but the current tool responses do not print them yet. In that state the effect is still visible: the affected runs show as `ambiguous` or `unknown`. Check `run-links.jsonl` by hand when a run that should be proven shows as unknown.

**Observation snapshot.** The `run_link` value stored inside an observation is a snapshot written by `log_observation` at record time. The passport view returned with a `log_observation` response is recomputed from `run-links.jsonl` on each call.

---

## Hints (advisory)

A hint is one line appended to the response of the tool that wrote the record. It appears only on a transition, never on every call:

- `log_experiment`: S_stag, S_ser (by the rules of the current segment) and S_exh (a key's stage rises, or a barrier is lifted and the merged stage rises).
- `record_analysis`: S_exh and S_exh_adv (a stage rise, a counter crossing at 3 or 6, or a first `review_requested` on an axis), on the write that causes the transition.

No hint comes from `log_observation`, `run_experiment`, `init_experiment`, `direction_review` or `/autoresearch clear`. Hints do not go through the observer hooks.

**Signals and thresholds**

| Signal | Trigger | Default |
|---|---|---|
| S_stag | runs in the current segment without a `best` improvement | ≥ 8 (`K_STAG`) |
| S_ser | consecutive runs of the current segment that improve `best` | ≥ 3 (`K_SER`) |
| S_exh | per key `(axis, prereg_id, run_epoch)`: the stage of the last K eligible comparisons | K = 3 (`exhaustion_rule.k`, 2–10) |
| S_exh_adv | readable comparisons on one axis reach 3 or 6; an explicit `review_requested` | advisory only |

S_exh stages: `1` = `below_threshold_within_noise`, `2` = `beyond_noise_series`. Any window that cannot be assessed is `unknown` with a reason code (for example `window_short`, `no_noise_basis`, `prereg_order_unknown`, `post_hoc_noise`, `budget_exhausted`). `false` appears only for `not_triggered`.

S_exh needs a `prereg` with an `exhaustion_rule`, a `noise_band` and a `noise_basis_ref` (in the prereg or in an admissible supplement). Without them the signal is `not_assessed`, not `false`.

**Wording (verbatim from the code)**

Every hint carries a disclaimer. The two disclaimers are quoted here exactly as the code writes them:

- for S_stag, S_ser and S_exh: «Исчерпание направления и полная сопоставимость результатов не подтверждены.» (exhaustion of the direction and full comparability of results are not confirmed)
- for S_exh_adv: «Исчерпание направления и сопоставимость результатов не подтверждены.» (exhaustion of the direction and comparability of results are not confirmed)

Example of an S_stag line as the response shows it. The code strips the disclaimer from each cause and appends the shared disclaimer once at the end of the line:

> 💡 Предлагается обзор направлений (S_stag): это документ, а не действие. Для документа вызовите `direction_review`. Эксперименты не запускались. Исчерпание направления и полная сопоставимость результатов не подтверждены.

In English: "A direction review is proposed (S_stag): it is a document, not an action. To create the document, call `direction_review`. No experiments were run. Exhaustion of the direction and full comparability of results are not confirmed."

When several causes fire on one write, they are joined into one line with ` | `, and each disclaimer type appears once.

Rules for agents reading a hint:

- A hint proposes a review. It does not say a direction is exhausted, and it never runs an experiment.
- Do not repeat a hint's word for word as a finding. Quote the disclaimer if you cite it.
- Do not treat `unknown` as failure or as `false`.

---

## Compatibility with existing campaigns

- Existing `log.jsonl` files are read exactly as before. A row without `activity_type` is `unknown` in the direction review. Old readers ignore a row's `activity_type` key.
- `log_observation` and `record_analysis` never write `log.jsonl`. `log_experiment` adds `activity_type` to a row only when the parameter is given, so legacy calls produce the same bytes.
- `run_experiment` behaves as before. It takes `analysis.lock` only to take the prefix snapshot before the run starts.
- A run without a sidecar entry is not proven. Old runs keep their metric and status; their links, epochs and deltas for new comparisons are `unknown`.
- `/autoresearch clear` deletes the ledger (`log.jsonl` and the legacy `autoresearch.jsonl`). It does not delete `observations.jsonl`, `analysis.jsonl`, `run-links.jsonl`, `runs/` or `reviews/`.
- Rollback: remove the three new data files and `reviews/` by hand if the data should go. Without the ledger, links are not confirmed anyway. There is no automatic migration.

## Git and privacy

- A `keep` commit runs `git add -A`. It therefore captures everything under `.auto/`, including `observations.jsonl`, `analysis.jsonl`, `run-links.jsonl`, `reviews/`, and any lock file that happens to exist at that moment.
- Free text is stored as written: `description`, `asi`, `metrics`, `claim`, `meaning`, `purpose_text`, `absent.note`. The system does not scan it for secrets. Do not put credentials, tokens or private data in these fields.
- `discard`, `crash`, `checks_failed` and `budget_exceeded` do not commit, and their revert excludes `.auto/`, so these files survive a revert.
- Nothing is copied automatically. Analysis and observations keep references and short text, not the content of artifacts.

## Limits

| Limit | Value |
|---|---|
| Keys evaluated per direction report or write | 16 (the rest are `unknown`, `budget_exhausted`) |
| Eligible comparisons per key | 200 (more gives `unknown`, `budget_exhausted`) |
| Noise-reference checks per call | 20 (each key checks at most one reference per call) |
| `output.txt` read for metric provenance | 64 MiB; larger gives `manual` with `output_too_large` |
| Observation `description` | 1–500 characters |
| Observation `metrics` | 16 entries |
| Passport components | 16; serialized passport ≤ 4 KiB |
| Reference `ref` string | ≤ 512 characters |
| Analysis record | ≤ 16 KiB (`record_too_large`) |
| Claim | 1–300 characters |
| Prereg branches | 1–8 |
| Evidence references per attribution | ≤ 8 |
| Subjects per attribution | 1–2 |

## Example calls

The examples below are tool arguments as JSON. Parameter names match the registrations in `index.ts` and the parameter schemas in `research-observations.ts` and `research-analysis.ts`. Identifiers such as `pre-m3k9x2-0a1b2c3d` and the run numbers are illustrative: replace them with values returned by your own calls.

**1. Diagnostic observation instead of a fake crash run**

`log_observation`:

```json
{
  "linked_run": "last",
  "outcome": "technical_failure",
  "description": "teacher generation: CUDA OOM at batch 64",
  "idempotency_key": "tg-run3-a",
  "asi": { "stage": "teacher_gen", "error_class": "oom" }
}
```

**2. Observation with a declared passport**

`log_observation`:

```json
{
  "linked_run": 3,
  "activity_type": "attribution",
  "outcome": "success",
  "description": "weights swapped at a fixed prompt; output recorded before the comparison",
  "metric": 0.5952,
  "passport": {
    "components": {
      "weights": { "ref": "models/champion.safetensors", "declared_sha256": null },
      "measurer": { "ref": "eval/scorer.py", "declared_sha256": "9f2c0a1d4b6e8f3a7c5d2e1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6" }
    }
  }
}
```

**3. Pre-registration before the candidate run**

`record_analysis`:

```json
{
  "kind": "prereg",
  "axis": "s21_enum",
  "hypothesis_id": "n7",
  "branches": [
    { "name": "champion_stronger", "metric_name": "F1", "op": ">=", "threshold": 0.5952, "meaning": "champion branch on enum" }
  ],
  "noise_band": 0.009,
  "noise_basis_ref": { "run": 57, "artifact": "output", "lines": [1, 40], "anchor": null },
  "exhaustion_rule": { "metric_name": "F1", "direction": "higher", "threshold_gain": 0.009, "k": 3 }
}
```

**4. Comparison of two runs**

`record_analysis`:

```json
{
  "kind": "comparison",
  "purpose": "component_attribution",
  "baseline_run": 57,
  "candidate_run": 58,
  "metric_name": "F1",
  "changed_components": ["weights"],
  "prereg_id": "pre-m3k9x2-0a1b2c3d",
  "axis": "s21_enum"
}
```

**5. Attribution with evidence references**

`record_analysis`:

```json
{
  "kind": "attribution",
  "claim": "champion weights give the enum gain at a fixed prompt",
  "subjects": ["weights"],
  "comparison_id": "cmp-m3k9x3-1a2b3c4d",
  "evidence_refs": [
    { "run": 57, "artifact": "output", "lines": null, "anchor": null },
    { "run": 58, "artifact": "output", "lines": null, "anchor": null }
  ]
}
```

**6. Supplement: a noise band added after the prereg was written**

`record_analysis`:

```json
{
  "kind": "supplement",
  "target_id": "pre-m3k9x2-0a1b2c3d",
  "field": "noise_band",
  "value": 0.009
}
```

**7. Supplement: declare a field absent (never treated as zero)**

`record_analysis`:

```json
{
  "kind": "supplement",
  "target_id": "cmp-m3k9x3-1a2b3c4d",
  "field": "changed_components",
  "absent": { "reason": "not_measured", "note": "weights and prompt were edited together" }
}
```

**8. Comparison that asks for a review of an axis**

`record_analysis`:

```json
{
  "kind": "comparison",
  "purpose": "exploration",
  "baseline_run": 60,
  "candidate_run": 61,
  "axis": "s21_enum",
  "review_requested": true
}
```

**9. Label a run's activity**

`log_experiment`:

```json
{
  "commit": "abc1234",
  "metric": 0.5521,
  "status": "keep",
  "description": "verification rerun of the run 57 configuration",
  "activity_type": "verification",
  "asi": { "hypothesis": "rerun to check the noise floor" }
}
```

**10. Write a direction review**

`direction_review`:

```json
{}
```

---

## Open items

These are gaps between the design and the implementation that are known at the time of writing. They are listed here so that a reader does not assume the design text describes the current behaviour.

- The `run_links_corrupt` and `run_links_unavailable` warnings are computed but are not printed in the response of `log_observation`, `record_analysis` or `direction_review`.
- `log_observation` stores `run_link` as `absent` or `ambiguous` only. The sidecar is read at response time for the passport view, not when the record is written.
- `record_analysis` accepts `passport` on every kind; the design text specifies it only for observations.
