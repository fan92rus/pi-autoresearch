<div align="center">
<img  height="120" alt="result" src="https://github.com/user-attachments/assets/c66cbd02-4491-4833-a63a-142cfd7530c1" />

# pi-autoresearch
### Autonomous experiment loop for pi
**[Website](https://davebcn87.github.io/pi-autoresearch/)** · **[Documentation](https://davebcn87.github.io/pi-autoresearch/configuration.html)** · **[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

</div>

*Try an idea, measure it, keep what works, discard what doesn't, repeat forever.*

An extension for **[pi](https://pi.dev/)** — an AI coding agent that runs in your terminal. pi-autoresearch gives pi the tools and workflow to run autonomous optimization loops: try an idea, benchmark it, keep improvements, revert regressions, repeat.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Works for any optimization target: test speed, bundle size, LLM training, build times, Lighthouse scores.

---

<img width="1736" height="518" alt="pi-autoresearch" src="https://github.com/user-attachments/assets/5078aa31-3530-406a-85fc-bdeff98679a6" />

---

## Quick start

```bash
pi install npm:pi-autoresearch
pi
```

Or load the package for one session only with `pi -e npm:pi-autoresearch`.

Then start the loop inside pi:

```text
/autoresearch optimize unit test runtime, monitor correctness
```

## What's included

| | |
|---|---|
| **Extension** | Tools + live widget + `/autoresearch` dashboard |
| **Skill** | Gathers what to optimize, writes session files, starts the loop |

### Extension tools

| Tool | Description |
|------|-------------|
| `optimize_brief` | Phase 1 of the session start. `draft` saves the brief (name, metric_name, metric_unit, direction, cwd; unknown fields refused); `propose` shows it for owner approval. The benchmark command and timeout stay in `run_experiment`. See [docs/optimize-two-phase-start.md](docs/optimize-two-phase-start.md). |
| `init_experiment` | Phase 2 of the session start. Starts the session with arguments that equal the approved brief (a resumed session with a matching config header needs no new brief). |
| `run_experiment` | Runs any command, times wall-clock duration, captures output |
| `log_experiment` | Records result, auto-commits, updates widget and dashboard |
| `tree_status` | Show experiment tree + UCB1 suggestions for exploration |
| `explore_from`, `restore_main`, `compose` | *Removed from this build; not registered as tools.* |
| `search_precedents` | Searches this project's past ledger, tree, ideas and council archives for similar problems (memory only when the host provides it); returns candidates with per-source coverage. See [Research precedents](#research-precedents). |
| `assess_precedents` | Records the agent's assessment (`supports` or `contradicts` with references, plus an action) of a candidate in a search report |
| `finalize_research` | Signals that optimization is complete (the agent keeps control). Writes the campaign report to `.auto/report.md` after the finalize record; a report failure is reported and does not fail the finalize. |
| `record_finding` | Records a result finding (`measurement`, `behavior`, `capability` or `tradeoff`) with a checkable `evidence_ref` into `.auto/findings.jsonl`. Rejected without one. See [Result lens and findings](#result-lens-and-findings). |
| `update_finding` | Moves a finding along the allowed transitions. `verified` and `revised` require `evidence_ref`. |
| `inspect_results` | Reads persisted run outputs in `.auto/runs/<n>/` in bounded pages (200 lines / 8 KiB): METRIC, error/warn, timing, delta against the best keep of the same epoch, campaign extractors. |
| `log_measurement_change` | Registers a change of the measurer (gold, scorer or metric) with its diff and rescore artifact. Opens a new scale epoch that stays provisional until verified. See [Measurement track](#measurement-track). |
| `verify_measurement_change` | Records the independent confirmation of a measurer change with a proof artifact that is checked against the ledger. |
| `revert_measurement_change` | Records the independent refutation of a measurer change with a counter-rescore; restores the last confirmed scale. |
| `log_observation` | Records a preparation, diagnostic or infrastructure event about a run (`success`, `technical_failure`, `unknown`) in `.auto/observations.jsonl`. Not a run: no git, best, streak or ledger change. See [Research map](#research-map). |
| `record_analysis` | Appends a `prereg`, `comparison`, `attribution` or `supplement` record to `.auto/analysis.jsonl`. Never changes runs, git or best. See [Research map](#research-map). |
| `direction_review` | Writes one document to `.auto/reviews/direction-<UTC>.md` with facts, unknowns, signals, alternatives and what is not proven. Runs no experiment and chooses no direction. |

### Waiting for async subagents

When the agent launches an async subagent (pi-subagents), the loop does not push its "Resume the cycle now" nudge into the turn while the subagent is still alive: the nudge is deferred.

- The guard re-checks the live subagent count every 30 seconds. The nudge is delivered as soon as no async subagent is alive, or after a 10-minute fuse even if one still is.
- A deferral does not count toward the drift limit or the auto-resume counter; those counters move once, at delivery.
- The prompt tells the agent to hold the turn with `bg_wait` rather than end it with a "waiting" reply. A user message always interrupts the wait.
- Without pi-subagents the guard fails open: nudges are delivered as before.
- An owner pause of the candidate campaign, turning autoresearch mode off, compaction, a session switch or shutdown cancels a pending deferral.

The guard covers the ordinary loop, including campaigns that block it. Partial-cycle turns (a loop tool was used) are not deferred.

### `/autoresearch` command

| Subcommand | Description |
|------------|-------------|
| `/autoresearch` or `/autoresearch help` | Show help without activating autoresearch mode. `--help` and `-h` work too. |
| `/autoresearch <text>` | Enter autoresearch mode. If `.auto/prompt.md` exists, resumes the loop with `<text>` as context. Otherwise, sets up a new session. |
| `/autoresearch off` | Leave autoresearch mode. Stops auto-resume and clears runtime state but keeps `.auto/log.jsonl` intact. |
| `/autoresearch finalize` | Stop the loop like `off` (aborting a run in progress), then load the `autoresearch-finalize` skill to turn kept experiments into reviewable branches. |
| `/autoresearch report` | Write the campaign report to `.auto/report.md` from the current ledger, findings and measurement state. Works with the loop on or off and does not stop it; each call overwrites the file. `report` is a reserved subcommand: a goal of exactly `report` no longer starts a session. |
| `/autoresearch clear` | Delete `.auto/log.jsonl`, reset all state, and turn autoresearch mode off. Use this for a clean start. |
| `/autoresearch tree` | Toggle between list view and experiment tree view in the dashboard widget. |
| `/autoresearch export` | Open a live dashboard in your browser. Auto-updates as experiments run. |
| `/autoresearch dashboard` | Open the fullscreen scrollable dashboard overlay in the terminal. Navigate with `↑`/`↓`/`j`/`k`, `PageUp`/`PageDown`/`u`/`d`, `g`/`G` for top/bottom, `Escape` or `q` to close. |

Subcommands autocomplete: type `/autoresearch ` and pick one from the list, or start typing (`/autoresearch fi` → `finalize`).

**Examples:**

```
/autoresearch optimize unit test runtime, monitor correctness
/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target
/autoresearch export
/autoresearch dashboard
/autoresearch off
/autoresearch finalize
/autoresearch report
/autoresearch clear
```

### Keyboard shortcuts (opt-in)

No shortcuts are bound by default — pi's built-in keymap grows with every release,
so any default chord eventually collides with it (this happened with `ctrl+shift+f`
vs. pi's transcript search). Every action is available as a `/autoresearch`
subcommand instead.

To opt in, add chords to `<agent-dir>/extensions/pi-autoresearch.json`
(`<agent-dir>` is usually `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set).
Omitted or `null` keys stay unbound:

```json
{
  "shortcuts": {
    "fullscreenDashboard": "ctrl+shift+y",
    "export": "alt+shift+e",
    "off": null
  }
}
```

Each key binds its `/autoresearch` subcommand: `fullscreenDashboard` → `dashboard`,
`export` → `export`, `off` → `off`.

Pick a chord that's free in [pi's built-in keybindings](https://github.com/badlogic/pi-mono/blob/main/docs/keybindings.md)
and your `<agent-dir>/keybindings.json` — extension shortcuts win conflicts, so a
clashing chord hijacks the built-in action.

#### Picking a free chord (guidance for agents)

Don't guess a chord — check it against the installed pi's built-in keymap first:

```bash
PI_ROOT=$(ls -d ~/.pi/pkg/pi-* 2>/dev/null | sort -V | tail -1)
[ -n "$PI_ROOT" ] || PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
node --input-type=module -e '
const { KEYBINDINGS } = await import(process.argv[1] + "/dist/core/keybindings.js");
const taken = new Set(Object.values(KEYBINDINGS).flatMap(({ defaultKeys }) => defaultKeys).map((key) => key.toLowerCase()));
console.log(taken.has(process.argv[2].toLowerCase()) ? "TAKEN" : "FREE");
' "$PI_ROOT" ctrl+shift+y
```

Chords in `<agent-dir>/keybindings.json` values are also taken. Write a
verified-free chord into `<agent-dir>/extensions/pi-autoresearch.json`, then
`/reload` pi and confirm no `Extension shortcut conflict` warning appears.

`ctrl+shift+y`, `ctrl+shift+u`, `alt+shift+f`, and `ctrl+alt+d` are free as of
pi 0.84.x. Always re-verify — pi's keymap grows over time, which is why this
extension binds nothing by default.

### UI

- **Dashboard widget** — always visible above the editor: a full results table with columns for commit, metric, status, and description.
- **Confidence score** — after 3+ runs, shows how the best improvement compares to the session noise floor. ≥2.0× (green) = likely real, 1.0–2.0× (yellow) = above noise but marginal, <1.0× (red) = within noise.
- **Fullscreen overlay** — `/autoresearch dashboard` opens a scrollable full-terminal dashboard. Shows a live spinner with elapsed time for running experiments.

### Skills

**`autoresearch-create`** asks a few questions (or infers from context) about your goal, command, metric, and files in scope — then writes two files and starts the loop immediately:

**`autoresearch-finalize`** turns a noisy autoresearch branch into clean, independent branches — one per logical change, each starting from the merge-base. Groups must not share files, so each branch can be reviewed and merged independently.

**`autoresearch-hooks`** *(optional)* helps author `.auto/hooks/before.sh` and `.auto/hooks/after.sh` for a session. It ships with ten reference scripts in [`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples/) (external search, learnings journal, native notifications, anti-thrash, idea rotation, and more) — the skill handles the contract, you pick the inspiration. The core autoresearch loop has no hook awareness.

All session files live in a single `.auto/` subfolder at the working-directory root — one folder to preserve across reverts, gitignore, and clean up. (Legacy flat `autoresearch.*` files are still read for in-flight sessions.)

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Session document — objective, metrics, files in scope, what's been tried. A fresh agent can resume from this alone. |
| `.auto/measure.sh` | Benchmark script — pre-checks, runs the workload, outputs `METRIC name=number` lines. |
| `.auto/log.jsonl` | Append-only log of every run (written by the tools). |
| `.auto/checks.sh` | *(optional)* Backpressure checks — tests, types, lint. Runs after each passing benchmark. Failures block `keep`. |
| `.auto/hooks/` | *(optional)* Executable scripts (`before.sh`, `after.sh`) that fire around iterations. Stdout is delivered to the agent as a steer message. |
| `.auto/observations.jsonl` | *(optional)* Observations about preparation and diagnostic events, written by `log_observation`. |
| `.auto/analysis.jsonl` | *(optional)* Analysis records (prereg, comparison, attribution, supplement), written by `record_analysis`. |
| `.auto/run-links.jsonl` | *(optional)* Confirmed links between ledger rows and run directories, written by `log_experiment`. Do not edit by hand. |
| `.auto/reviews/` | *(optional)* Direction-review documents, written by `direction_review`. |

---

## Install

```bash
pi install npm:pi-autoresearch
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-autoresearch ~/.pi/agent/extensions/
cp -r skills/autoresearch-create ~/.pi/agent/skills/
```

Then `/reload` in pi.

</details>

---

## Usage

### 1. Start autoresearch

```text
/autoresearch optimize unit test runtime, monitor correctness
```

This activates autoresearch mode and makes the experiment tools available. If `.auto/prompt.md` does not exist, it also loads the `autoresearch-create` skill. Calling `/skill:autoresearch-create` directly does not activate the mode, so the tools remain unavailable in a fresh session.

The agent asks about your goal, command, metric, and files in scope — or infers them from context. It then creates a branch, writes `.auto/prompt.md` and `.auto/measure.sh`, runs the baseline, and starts looping immediately.

### 2. The loop

The agent runs autonomously: edit → commit → `run_experiment` → `log_experiment` → keep or revert → repeat. It never stops unless interrupted.

Every result is appended to `.auto/log.jsonl` in your project — one line per run. This means:

- **Survives restarts** — the agent can resume a session by reading the file
- **Survives context resets** — `.auto/prompt.md` captures what's been tried so a fresh agent has full context
- **Human readable** — open it anytime to see the full history
- **Branch-aware** — each branch has its own session

### 3. Finalize into reviewable branches

```
/autoresearch finalize
```

This stops the loop (aborting a run in progress) and loads the `autoresearch-finalize` skill. Loading the skill directly with `/skill:autoresearch-finalize` leaves autoresearch mode on, so a running loop keeps going.

The agent reads `.auto/log.jsonl`, groups kept experiments into logical changesets, proposes the grouping for your approval, then creates independent branches from the merge-base. Each commit includes metric improvements in the message. Groups must not share files, so branches can be reviewed and merged independently.

### 4. Monitor progress

- **Widget** — full results table, always visible above the editor
- **`/autoresearch dashboard`** — fullscreen scrollable dashboard overlay (optional chord: `shortcuts.fullscreenDashboard`)
- **`/autoresearch export`** — open a live browser dashboard with chart and share card
- **`Escape`** — interrupt anytime and ask for a summary

---

## Example domains

| Domain | Metric | Command |
|--------|--------|---------|
| Test speed | seconds ↓ | `pnpm test` |
| Bundle size | KB ↓ | `pnpm build && du -sb dist` |
| LLM training | val_bpb ↓ | `uv run train.py` |
| Build speed | seconds ↓ | `pnpm build` |
| Lighthouse | perf score ↑ | `lighthouse http://localhost:3000 --output=json` |

---

## How it works

The **extension** is domain-agnostic infrastructure. The **skill** encodes domain knowledge. This separation means one extension serves unlimited domains.

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Extension (global)  │     │  Skill (per-domain)       │
│                      │     │                           │
│  run_experiment      │◄────│  command: pnpm test       │
│  log_experiment      │     │  metric: seconds (lower)  │
│  widget + dashboard  │     │  scope: vitest configs    │
│                      │     │  ideas: pool, parallel…   │
└──────────────────────┘     └──────────────────────────┘
```

Two files keep the session alive across restarts and context resets:

```
.auto/log.jsonl   — append-only log of every run (metric, status, commit, description)
.auto/tree.json   — experiment tree (parent→child structure, SimHash, UCB1 rankings)
.auto/prompt.md   — living document: objective, what's been tried, dead ends, key wins
```

A fresh agent with no memory can read these files and continue exactly where the previous session left off.

### Experiment tree

Since v1.7, autoresearch maintains an **experiment tree** — a parent→child hierarchy of every hypothesis tried. This gives the agent (and you) a map of the exploration:

```
n0  100µs  baseline
├── n1  92µs  ●  "AST cache"        keep   -8µs
│    └── n2  88µs  ●  "LRU eviction" keep   -4µs
└── n3  81µs  ●  "lookup table"     keep  -19µs ★ BEST
```

**Key capabilities:**
- **Repeat detection** — before running an experiment, SimHash checks if a similar hypothesis was already tried
- **UCB1 ranking** — the agent sees which nodes are most promising to expand (balance of exploitation + exploration)

The tree is **enabled by default** and stored in `.auto/tree.json`. Toggle the tree view in the dashboard with `/autoresearch tree`.

📚 **Full documentation:** [Agent Guide](docs/AGENT-GUIDE.md) · [User Guide](docs/USER-GUIDE.md)

---

## Configuration (optional)

Create `.auto/config.json` in your pi session directory to customize behavior:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

| Field | Type | Description |
|-------|------|-------------|
| `workingDir` | string | Override the directory for all autoresearch operations — file I/O, command execution, and git. Supports absolute or relative paths (resolved against the pi session cwd). The config file itself always stays under the session cwd. Fails if the directory doesn't exist. |
| `maxIterations` | number | Maximum experiments before auto-stopping. The agent is told to stop and won't run more experiments until a new segment is initialized. |
| `experiment_max_minutes` | number | Per-project cap (minutes) for a single experiment's `timeout_seconds`. When set, `run_experiment` rejects bigger timeouts with a reminder to adapt the experiment (smaller workload, quick subset) — the agent is expected to fit experiments into the cap, not raise it. Unset = no cap. |
| `parallel.ucb1C` | number | UCB1 exploration constant for tree node ranking (default: 0.5). Higher = more exploration (favor unexplored nodes); lower = more exploitation (favor proven territory). |

### Observer settings

The built-in observer runs before each iteration and emits **steer messages** (advisory only — it never force-stops the session). Three mechanisms can recommend finalization; each can be toggled on/off in `.auto/config.json` under the `observer` key (all default to `true`):

```json
{
  "observer": {
    "finalize_enabled": true,
    "floor_detection_enabled": true,
    "stagnation_finalize_enabled": true,
    "finalize_strong_threshold": 0.8,
    "finalize_advisory_threshold": 0.5,
    "floor_streak_threshold": 15,
    "floor_cv_threshold": 0.15,
    "stagnation_threshold": 5
  }
}
```

| Toggle | Default | What it controls |
|--------|---------|------------------|
| `finalize_enabled` | `true` | The finalize trigger — fires when the agent calls `finalize_research()`. Disable if the agent signals completion too eagerly. |
| `floor_detection_enabled` | `true` | Floor detection (variance plateau + ASI proof). Disable to stop the observer from claiming a structural limit was reached. |
| `stagnation_finalize_enabled` | `true` | Finalize hints inside stagnation escalations (ASI floor/exhausted, critical level). Disable to keep stagnation advice actionable without stop recommendations. |

Numeric thresholds (`finalize_strong_threshold`, `floor_cv_threshold`, `stagnation_threshold`, etc.) can also be tuned interactively via `/autoresearch config` → **Observer settings** → **Toggles**.

Set or clear the experiment time limit without editing the config by hand:
`/autoresearch limit 5` — 5 minutes per `run_experiment`; `/autoresearch limit off` — remove; `/autoresearch limit` — interactive dialog (also available as the first item of the `/autoresearch config` menu). The active limit is shown to the agent in the mode prompt on every turn, so it always knows the time budget it must fit.

**Stale-finalize protection.** If the agent calls `finalize_research()` but then continues working and finds an improvement (a `keep` run after the finalize entry), the observer automatically suppresses the finalize signal — the claim was premature. This prevents the observer from nagging the agent to stop when work is clearly still productive.

**Anti-nagging & priority reordering.** The finalize signal is now the **lowest-priority** observer trigger. The trigger order is: noise gate → parallel opportunity → stagnation → floor detection → progress milestone → finalize (fallback). This means concrete actionable advice (BestOfN with real hypotheses, stagnation reflection) always takes priority over the abstract "stop" recommendation. Additionally, once the agent continues working after calling `finalize_research()` (any run after the finalize entry), the observer **goes completely quiet** about finalize — the tool already sent a one-time confirmation steer when called, and repeating it every iteration creates counterproductive pressure. Actionable triggers take over steering instead.

**Floor detection untried-ideas guard.** Floor detection now checks `.auto/ideas/` before claiming a structural limit: if ≥2 untried idea files remain, it downgrades to a nudge ("try the ideas before concluding the limit is structural") instead of the full floor-reached block. This is consistent with the finalize trigger's untried-ideas check.

**File-per-idea tracking.** Ideas are stored as individual `.md` files in `.auto/ideas/` (e.g. `cache-ast.md`, `bit-packed.md`). Each file can contain rich content — title, explanation, code snippets, multi-line notes. When you test an idea, add `"idea_id": "filename"` (with or without `.md` extension) to the `asi` parameter of `log_experiment`; the idea file is automatically deleted so the untried count stays accurate. The ideas directory is cleared on new segment (`init_experiment` re-init) and on `/autoresearch clear`.

### Research precedents

Before choosing a new direction, especially on stagnation, search this project's own history for earlier solutions and failures to the same problem. The observer's stagnation steer asks for this search; it is not required after every run.

```
search_precedents({ problem: "<current problem, 1-2 sentences>", keywords: ["up to 5"], finding_ref: "<optional finding id>" })
assess_precedents({ report_id, primary_ref, claim: "supports" | "contradicts", follow_up_ref, action })
```

- **Sources (local, current project only):** `.auto/log.jsonl` (or legacy `autoresearch.jsonl` when the current ledger is absent), `.auto/tree.json`, `.auto/ideas/` and `.auto/councils/`. Paths outside the project root are never opened. Other projects and sessions are never scanned automatically.
- **Memory:** a memory source is used only when the host passes a memory adapter. Otherwise it is reported as `unavailable`, not as searched. The agent may run its own session memory search and cite the references in its report.
- **Coverage:** each source is `searched`, `unavailable` (an optional source is missing, or memory is not configured), `error` or `truncated`. The outcome is `matches`, `no-matches` (only with complete coverage) or `incomplete` (an error, truncation or missing ledger). `incomplete` is never "nothing found".
- **Limits per search:** 10 seconds, 10 MiB read, 2000 files and directory entries, at most 20 candidates and 8 KiB of output. Exceeding a limit is reported as `truncated`.
- **Candidates are leads, not evidence.** Each candidate is `supported`, `contradicted`, `conflicting` or `unknown`. The default is `unknown`, including for old `keep` records: a keep is not a success, and no found refutation is not validity. Text similarity is never proof. Later ledger records are found by run, node id and commit references, and shown with up to 10 neighbouring records on each side.
- **Assessment:** the agent reads the original and the later records and records them with `assess_precedents`. The tool checks that the references exist and are in range, not that the interpretation is correct. Actions are `reuse`, `adapt-and-test`, `avoid` or `insufficient-evidence`. A metric delta is never computed across unequal or unknown scales.
- **Reports:** `.auto/precedents/<id>.json` (versioned). A report is current only while the normalized query, the segment and the hashes of the fully read sources are unchanged. A `stale` or `unknown` report must be searched again before it is relied on. Old logs and trees are not modified.

#### Precedent privacy and the council

- **Default (metadata only):** the council brief gets the report id, outcome, source statuses and candidate counts per status. Candidate texts, source paths and the agent's judgments are withheld.
- **Opt-in:** `.auto/config.json`:

  ```json
  {
    "council": {
      "share_precedent_details": true
    }
  }
  ```

  With `true`, record text, source paths and assessments enter council briefs, and the council's models are external providers. Enable it only for data you are allowed to share.
- **Secrets:** the problem text and keywords go to the local search only. Do not put secrets into them: the extension cannot reliably remove secrets from arbitrary text.
- **Untrusted content:** text found in the history is data. The extension never executes commands from it, never follows links and never uses it as tool arguments.
- **Advisor:** the stagnation and reflection steers ask the agent to put the report id, its freshness (`current`, `stale` or `unknown`) and statuses into its own advisor message, with the same metadata-only default. A stale or unknown report is not current evidence. The extension does not control the context of the advisor plugin.

### Result lens and findings

The result lens keeps each run's raw output, lets the agent read it in bounded pages, and turns what it shows into durable findings. Findings feed the council brief and the campaign report. Everything is stored locally under `.auto/`.

**Run outputs.** Every `run_experiment` writes its complete combined output to `.auto/runs/<n>/output.txt`, including crashed, timed-out and aborted runs. The response to the agent is tail-truncated; the file is not. Declared artifacts (`analysis.artifacts`) are copied into the same run directory, and `manifest.json` lists each one with its size, a short hash (`sha16`) and, where applicable, a `missing` or `size_only` mark (`size_only` = the file exceeds `copy_limit_mb`). Declared measurer files (`analysis.measurement_files`) are hashed into the manifest too.

**The `analysis` config.** Campaigns that do not declare the section run in generic mode, as before. The section lives in `.auto/config.json`, is validated by `init_experiment`, and is stored in the ledger's config header; later edits apply from the next `init_experiment`.

```json
{
  "analysis": {
    "artifacts": ["eval_output.json"],
    "measurement_files": ["eval/scorer.py"],
    "extractors": {
      "failures": { "regex": "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", "sample": 10 },
      "hotspots": { "timing_line": true, "top": 10 },
      "records": { "json_path": "results.items", "sample": 20 }
    },
    "copy_limit_mb": 32
  }
}
```

- Each extractor declares exactly one of `regex`, `json_path` or `timing_line`. `sample` applies to `regex` and `json_path`, `top` to `timing_line`. The names `__proto__`, `constructor` and `prototype` are reserved.
- A `regex` is compiled once, without flags, at `init_experiment`. A pattern that does not compile fails `init_experiment` and names its config path (for example `analysis.extractors.failures.regex`).
- An invalid `analysis` section fails `init_experiment` and lists all errors. A `config.json` that cannot be parsed at all keeps the campaign in generic mode, and `init_experiment` warns that the analysis was not applied.
- `copy_limit_mb` defaults to 32.

**Generic extractors** need no configuration: METRIC lines, error/warn lines, timing top-N (ms, µs, us and s are normalized to ms), delta against the best keep of the same epoch, and a head/tail of the raw output when nothing else matched.

**`inspect_results`** reads only the persisted files (`.auto/log.jsonl` and `.auto/runs/<n>/`), never the original artifacts. Arguments: `run` (default: the best keep of the current epoch), `extractor` (`metric`, `errors`, `timing`, `delta`, `raw`, or a name from `analysis.extractors`) and `page`. A page is at most 200 lines and 8 KiB. Lines longer than 500 characters are clamped; the full text stays in `output.txt`.

**Findings.** `record_finding({theme, description, evidence_ref, estimated_impact?, run?})` appends a finding to `.auto/findings.jsonl`. The file is append-only: a status change is a new `finding_transition` line, never an edit. The loop routes each theme as follows:

| Theme | Meaning | Route |
|-------|---------|-------|
| `behavior` | The model or code does the wrong thing | An ordinary hypothesis: propose_hypothesis (what you noticed, what changes, what you will learn; optionally pass finding_id), citing the finding id |
| `capability` | The system cannot do it yet (new data, resources or abilities) | Not a hypothesis and not a run: an owner-input idea that waits for the owner's go-ahead |
| `tradeoff` | Gaining on one side costs another | A question to the owner; the cost is tracked as a secondary metric until answered |
| `measurement` | The scorer, gold or metric itself is wrong | `log_measurement_change` (see [Measurement track](#measurement-track)) |

`evidence_ref` is required and must point at a concrete case: `path:start-end` (or `path:N`; 1-based, inclusive) or `path#anchor`, where the anchor is a literal substring that must occur in the file. Paths must stay inside the project (symlinks included) and line ranges must lie inside the file. Generalizations without an example are rejected.

`update_finding({id, status, evidence_ref?, note?})` changes a status along these transitions only:

| From | To |
|------|----|
| `open` | `verified`, `revised`, `deferred` |
| `revised` | `verified`, `deferred` |
| `deferred` | `open` |
| `verified` | `revised` |

`verified` and `revised` require `evidence_ref`: the independent check, or the counterexample.

**Needs verification.** A finding whose description claims unreachability or zero coverage is flagged `needs_verification`. The claim patterns are: `unreachable`, `impossible`, `никогда не`, `recall 0` and a standalone `0/N` ratio. The flag is advisory: it never blocks a write and never needs an owner. The tool never clears it; the verifying evidence is the `evidence_ref` of the transition that follows.

**Privacy.** Findings stay local, but their text reaches the council: the brief's `## Open findings` section carries each open finding's theme, description, estimated impact and `evidence_ref` (not the run output). This is **not** gated by `council.share_precedent_details`. The council's models may be external providers, so keep secrets out of findings.

**Campaign report.** `.auto/report.md` is written by `finalize_research` and by `/autoresearch report`, which can be run at any time. Each call overwrites the file from the current state, so repeated calls never duplicate content. The report has seven sections: 1. runs and metrics, with an inventory of reusable artifacts; 2. findings by theme; 3. measurement track (epochs, scores, verification status); 4. noise and confidence; 5. ideas and dead ends; 6. limits and owner-input gates; 7. summary. An empty section is marked explicitly, and a campaign that never used the lens is marked «линза не применялась». Measurement findings with `needs_verification` are listed under «Требуют независимой проверки». That queue is a verification work queue, not an owner gate: checking pauses nothing and needs no owner approval.

### Measurement track

The measurer is the gold set, the scorer and the metric. Changing it silently in the model track would compare numbers from different scales, which is benchmark gaming. Every change is registered:

- **`log_measurement_change({diff_ref, rescore_ref, justification})`.** `diff_ref` (the diff) and `rescore_ref` (a rescore artifact, JSON with `anchor`, `commands`, `old_scale_score`, `new_scale_score`) must be files in `.auto/measurement/`. The scores are read from the artifact and are never tool arguments. The change opens a new scale epoch and stays `needs_verification: true`. If the rescore has not run yet, pass `rescore_pending: true`: the artifact then needs only the anchor and the commands, and the new scale stays provisional. Complete it later with `log_measurement_change({change_ref, rescore_ref})`; the completion stays in the same epoch.
- **`verify_measurement_change({change_ref, proof_ref})`.** The independent re-run of the same anchor and commands, saved as a proof artifact in `.auto/measurement/` (`anchor`, `commands`, `outputs`, `old_scale_score`, `new_scale_score`). The scores are checked against the ledger; the verification mark lifts only when they match.
- **`revert_measurement_change({change_ref, rescore_ref, justification})`.** A counter-rescore whose scores differ refutes the change. The active scale returns to the last confirmed epoch, the runs of the refuted epoch become incomparable, and its epoch id is never reused. Ledger records are never rewritten.

**Epochs.** Ledger entries without an `epoch` belong to epoch 1, so existing logs read as before. The confidence score and best deltas are never computed across epochs. The tree view shows the current epoch; an earlier epoch's best appears only as a labelled cross-epoch reference, with both values and no delta. A measurement change also marks the calibrated noise floor as stale; the confidence score is suppressed while a rescore is pending.

**Measurer control.** Hashes of the files listed in `analysis.measurement_files` are stored in every run manifest. A change between runs that no later `measurement_change` accounts for is reported as unaccounted. A missing `analysis` section, or a declared file that is missing or unreadable, is reported as an explicit limit, never as a clean state. Limit: a change that is reverted between two runs leaves identical hashes and stays invisible.

**Measurement health.** One line, shared by the council brief and the observer's periodic messages, summarizes the epoch, the stale-floor flag, the open measurement findings and the measurer control state.

**Council.** A measurement experiment in a council slate has a `TRACK: measurement` line inside its section. It carries a plan (`DIFF`, `RESCORE`, `JUSTIFY`) instead of an `EXPECTED_GAIN` number. A slate with an incomplete plan is rejected, and the error names the missing field.

### Long-running loops and context

The loop is designed to run unattended across context limits. When pi's [auto-compaction](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) summarizes the older portion of the conversation, autoresearch detects the resulting idle and re-prompts the agent to re-read `.auto/prompt.md`, the tail of `.auto/log.jsonl`, `.auto/ideas/`, and `git log` before continuing. All progress is persisted in those files, so the post-summary turn rehydrates from the source of truth instead of relying on whatever survived compaction. No tuning required — if pi's auto-compaction is enabled (the default), this just works.

---

## Research map

Research map adds tools for the parts of a campaign that are not plain runs: preparation and diagnostic events, comparison records and direction reviews. Everything is stored locally under `.auto/`, and every read recomputes its state from the files, so a restart gives the same answers. The full contract, data formats, limits and example calls are in [docs/research-map.md](docs/research-map.md).

- **`log_observation`** records a preparation, diagnostic or infrastructure event about a run. Use it instead of a fake `crash` or `explore` run. Outcome is `success`, `technical_failure` or `unknown`. `linked_run` defaults to the last run marker in the ledger; pass an integer when sessions run concurrently.
- **`record_analysis`** records a `prereg` before a candidate run (branches, an optional exhaustion rule, a noise band with a reference), then `comparison` (purpose, baseline, candidate, declared changed components), `attribution` (a claim with typed references into `.auto/runs/<N>/`) and `supplement` (fills a missing field or declares it absent; never overwrites). A comparison written after results is never a prereg.
- **`direction_review`** takes no arguments and writes a document. It proposes, it does not decide.
- **`log_experiment` `activity_type`** is an optional label (`measurement`, `intermediate`, `verification`, `attribution`). It is stored in the ledger only and never changes status, keep/discard, git, best or the epoch.

**Hints.** Some `log_experiment` and `record_analysis` responses end with a 💡 line that proposes `direction_review`: no best improvement for 8 runs in a segment, 3 improvements in a row, or a stage rise of a direction's exhaustion signal. Hints are advisory. They never say that a direction is exhausted, never run an experiment, and always state that exhaustion and comparability are not confirmed. `unknown` means not assessed, never failure.

**Passport.** Observations can carry declared components (`weights`, `prompt`, `dataset`, `measurer`, `code_ref`) as a relative `ref` and an optional `declared_sha256`. They are stored as declared with `verified: false`. The system never reads or hashes the referenced files.

**Run links.** An observation or a comparison is tied to a run only through a proven link recorded in `.auto/run-links.jsonl`. A torn or unreadable line in that file makes the affected links `ambiguous`: no trusted epoch, no delta, and no trusted exhaustion for those runs. The system never repairs the file; archiving it is a manual step.

**Privacy.** A `keep` commit runs `git add -A`, so `.auto/` (observations, analysis, run links, reviews) is committed with the run. Free-text fields are not scanned for secrets. The tools copy no artifact content into their records.

**Compatibility.** Existing `log.jsonl` files are read as before, and the new tools never write to it. Rows without `activity_type` read as `unknown`. The new data files are separate; `/autoresearch clear` removes the ledger only.

---

## Confidence scoring

After 3+ experiments in a session, pi-autoresearch computes a **confidence score** — how the best improvement compares to the session's noise floor. This helps distinguish real gains from benchmark jitter, especially on noisy signals like ML training, Lighthouse scores, or flaky benchmarks.

**How it works:**

- Uses [Median Absolute Deviation (MAD)](https://en.wikipedia.org/wiki/Median_absolute_deviation) of all metric values in the current segment as a robust noise estimator.
- Confidence = `|best_improvement| / MAD`. A score of 2.0× means the best improvement is twice the noise floor.
- Shown in the widget, fullscreen dashboard, and `log_experiment` output.
- Persisted to `.auto/log.jsonl` on each result for post-hoc analysis.
- **Advisory only** — never auto-discards. The agent is guided to re-run experiments when confidence is low, but the final keep/discard decision stays with the agent.

| Confidence | Color | Meaning |
|-----------|-------|---------|
| ≥ 2.0× | 🟢 green | Improvement is likely real |
| 1.0–2.0× | 🟡 yellow | Above noise but marginal |
| < 1.0× | 🔴 red | Within noise — consider re-running to confirm |

---

## Backpressure checks (optional)

Create `.auto/checks.sh` to run correctness checks (tests, types, lint) after every passing benchmark. This ensures optimizations don't break things.

```bash
#!/bin/bash
set -euo pipefail
pnpm test --run
pnpm typecheck
```

**How it works:**

- If the file doesn't exist, everything behaves exactly as before — no changes to the loop.
- If it exists, it runs automatically after every benchmark that exits 0.
- Checks execution time does **not** affect the primary metric.
- If checks fail, the experiment is logged as `checks_failed` (same behavior as a crash — no commit, revert changes).
- The `checks_failed` status is shown separately in the dashboard so you can distinguish correctness failures from benchmark crashes.
- Checks have a separate timeout (default 300s, configurable via `checks_timeout_seconds` in `run_experiment`).

---

## Hooks (optional)

Drop executable scripts in `.auto/hooks/` to run code at iteration boundaries. Hooks are **transparent to the agent** — the agent calls tools and sees results; hooks run alongside without any agent-facing surface.

- `.auto/hooks/before.sh` — fires before every iteration (at `/autoresearch` activation and at the end of every `log_experiment`, after `after.sh`). Use for prospective work: fetch research, prime context for the next attempt.
- `.auto/hooks/after.sh` — fires at the end of every `log_experiment`. Use for retrospective work: annotate learnings, send notifications.

**Contract:**

- Must be executable (`chmod +x`). Preserved on revert — the entire `.auto/` folder survives (as do legacy `autoresearch.*` artefacts).
- **Stdin** — a JSON object on a single line. Shape depends on the stage (see below). Extract fields with `jq`.
- **Stdout** is delivered to the agent as a steer message (capped at 8 KB). Empty stdout = silent.
- Non-zero exit or >30s timeout surfaces an error steer to the agent.
- Each fire appends a `{"type":"hook",…}` entry to `.auto/log.jsonl` for observability.

**`before.sh` stdin** (on fresh activation `last_run` is `null`):

```json
{
  "event": "before",
  "cwd": "/path/to/workdir",
  "next_run": 6,
  "last_run": {
    "run": 5, "status": "discard", "metric": 42.1,
    "description": "…",
    "asi": { "hypothesis": "…", "next_focus": "…" }
  },
  "session": {
    "metric_name": "total_ms", "metric_unit": "ms", "direction": "lower",
    "baseline_metric": 40.7, "best_metric": 33.5,
    "run_count": 5, "goal": "optimize sort speed"
  }
}
```

**`after.sh` stdin:**

```json
{
  "event": "after",
  "cwd": "/path/to/workdir",
  "run_entry": {
    "run": 6, "status": "discard", "metric": 38.9,
    "description": "…",
    "asi": { "hypothesis": "…", "learned": "…" }
  },
  "session": { "metric_name": "total_ms", "direction": "lower", "baseline_metric": 40.7, "best_metric": 33.5, "run_count": 6, "goal": "…" }
}
```

**Agent signal.** The agent writes `description` and `asi.*` fields in its `log_experiment` calls for its own future-self reasoning. The hook opportunistically mines whichever fields the agent naturally uses — `asi.hypothesis`, `asi.next_focus`, `description`, etc. There is no dedicated "hook input" field; the agent is unaware the hook exists.

**Examples.** Reference scripts for both stages live at [`skills/autoresearch-hooks/examples/`](skills/autoresearch-hooks/examples/) — external search, qmd document search, persistent learnings, native notifications, git tagging, anti-thrash, idea rotator, hypothesis reflection, context rotation. Copy one to your session's `.auto/hooks/` directory, adapt, `chmod +x`.

---

## Prerequisites

1. **Install pi** — follow the instructions at [pi.dev](https://pi.dev/)
2. **An API key** for your preferred LLM provider (configured in pi)

## Security and trust

Pi packages run with your full user permissions. Review this repository before installing it, and run autoresearch in a dedicated branch or worktree with a clean working tree.

Autoresearch intentionally edits files, creates and reverts commits, and executes the commands in `.auto/measure.sh`, `.auto/checks.sh`, and `.auto/hooks/`. Treat those files as executable code: review them before each session, keep credentials and sensitive files out of scope, and use a sandbox or restricted environment for untrusted projects.

For reproducible installs, pin a version you have reviewed, for example `pi install npm:pi-autoresearch@1.7.0`. Published npm releases include provenance attestations.

## Controlling costs

Autoresearch loops run autonomously and can burn through tokens. Two ways to cap spend:

- **API key limits** — most providers let you set per-key or monthly budgets. Check your provider's dashboard.
- **`maxIterations`** — cap experiments per session in `.auto/config.json`:
   ```json
   {
     "maxIterations": 30
   }
   ```

## Development

Run the test suite with:

```bash
npm test
```

## License

MIT
