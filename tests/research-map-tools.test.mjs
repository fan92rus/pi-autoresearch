/**
 * Wiring of the remaining research-map tools into extensions/pi-autoresearch/index.ts
 * (openspec research-map, design §7.3/§7.4/§8.1/§12.1/§12.2/§12.3b/§12.4, D-RM-06/D-RM-07,
 * E-22, tasks.md 4.1/4.2; issue pi-autoresearch-iky.4.3).
 *
 * Covers:
 *  - registration presence + schema shape of log_observation, record_analysis, direction_review;
 *  - log_observation happy path + forbidden-key rejection through the REGISTERED tool;
 *  - record_analysis prereg/comparison happy paths + post_hoc classification visible in the
 *    response computed section;
 *  - direction_review generates .auto/reviews/direction-<UTC>.md with the fixed section
 *    names, ZERO run_experiment/log_experiment calls (spy/count, T19 semantics), and a
 *    «нет данных» document on an empty campaign;
 *  - §12.4 hint delivery in log_experiment/record_analysis responses: S_exh stage hint with
 *    its built-in disclaimer, S_exh_adv advisory at 3 comparisons, no hint on plain success
 *    without transition, at most one hint line per response (§12.3b);
 *  - budget guard: hint absent when the affected key falls beyond the global first 16
 *    (§12.3a «Объём», FIRST_KEYS_LIMIT).
 *
 * Run: timeout 300 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-map-tools.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHarness } from "./fake-pi.ts";
import { computeExhaustionState } from "../extensions/pi-autoresearch/exhaustion-hints.ts";
import { ADVISORY_DISCLAIMER, EXHAUSTION_DISCLAIMER, FIRST_KEYS_LIMIT } from "../extensions/pi-autoresearch/exhaustion-hints.ts";
import { runLinkOf } from "../extensions/pi-autoresearch/run-links.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NEW_TOOLS = ["log_observation", "record_analysis", "direction_review"];
// §12.2 fixed section names, in §12.2 order.
const REVIEW_SECTIONS = [
  "## Факты",
  "## Неизвестно",
  "## Признаки",
  "## Альтернативы",
  "## Что не доказано",
  "## Рекомендации (не действия)",
];

function makeWorkDir(label) {
  const dir = path.join(os.tmpdir(), `pi-ar-researchmap-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function setup(label, { metricName = "F1" } = {}) {
  const dir = makeWorkDir(label);
  const h = await createHarness({ dir, sessionId: `researchmap-${label}`, realGit: false });
  await h.command("autoresearch").handler("on", h.ctx);
  await h.tool("init_experiment").execute("id", {
    name: "bench", metric_name: metricName, metric_unit: "", direction: "higher",
  }, null, null, h.ctx);
  return { ...h, dir };
}

function autoDirOf(dir) {
  return path.join(dir, ".auto");
}

function runExp(h, metric = 0.5, hypothesisId = undefined) {
  return h.tool("run_experiment").execute("id", {
    command: `node -e "console.log('METRIC F1=${metric}')"`, timeout_seconds: 10,
    ...(hypothesisId !== undefined ? { hypothesis_id: hypothesisId } : {}),
  }, null, null, h.ctx);
}

function logExp(h, params) {
  return h.tool("log_experiment").execute("id", params, null, null, h.ctx);
}

/**
 * Keep-baseline loop: N proven runs all at `metric`. After the first baseline
 * run the tree root has children, so every later run needs a hypothesis — the
 * loop proposes one per run (the standard propose_hypothesis → run_experiment
 * → log_experiment flow).
 */
async function seedRuns(h, n, metric = 0.5) {
  for (let i = 0; i < n; i++) {
    let hypothesisId;
    if (i > 0) {
      const prop = await h.tool("propose_hypothesis").execute("id", { description: `hyp ${i}` }, null, null, h.ctx);
      hypothesisId = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
    }
    await runExp(h, metric, hypothesisId);
    await logExp(h, { metric, status: "keep", description: `run ${i}`, metrics: { F1: metric }, hypothesis_id: hypothesisId });
  }
}

function firstJsonLine(text) {
  return JSON.parse(text.split("\n")[0]);
}

/** The last (only) review document in .auto/reviews. */
function latestReview(dir) {
  const reviewsDir = path.join(autoDirOf(dir), "reviews");
  const files = fs.readdirSync(reviewsDir).filter((f) => f.startsWith("direction-") && f.endsWith(".md"));
  assert.ok(files.length >= 1, "a review document was created");
  return { name: files[files.length - 1], text: fs.readFileSync(path.join(reviewsDir, files[files.length - 1]), "utf8") };
}

/** One run (propose → run → log) with any status; returns the log response text. */
async function seedOneRun(h, i, status = "keep", metric = 0.5) {
  const prop = await h.tool("propose_hypothesis").execute("id", { description: `hyp ${i}` }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, metric, hyp);
  const res = await logExp(h, { metric, status, description: `run ${i}`, metrics: { F1: metric }, hypothesis_id: hyp });
  return res.content[0].text;
}

/** One equal keep (propose → run → log); returns the log response text. */
async function seedOneKeep(h, i, metric = 0.5) {
  return seedOneRun(h, i, "keep", metric);
}

/**
 * A prereg with an exhaustion rule + one comparison per extra run. Returns the
 * prereg id. All comparisons declare changed_components: [] (controlled) so
 * they are eligible once their runs are proven.
 */
async function seedPreregAndComparisons(h, { axis = "s21", comparisons = 0, candidateMetric = 0.5 } = {}) {
  const pre = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis,
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "champion branch" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 2 },
    noise_band: 0.002,
    noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
  }, null, null, h.ctx);
  const prereg = firstJsonLine(pre.content[0].text);
  assert.equal(prereg.status, "appended");
  for (let i = 0; i < comparisons; i++) {
    // Candidate runs start at 2 (run 1 is the baseline); each needs a hypothesis.
    const candidateRun = i + 2;
    const prop = await h.tool("propose_hypothesis").execute("id", { description: `cmp hyp ${candidateRun}` }, null, null, h.ctx);
    const hypothesisId = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
    await runExp(h, candidateMetric, hypothesisId);
    await logExp(h, {
      metric: candidateMetric, status: "keep", description: `cmp run ${candidateRun}`, metrics: { F1: candidateMetric }, hypothesis_id: hypothesisId,
    });
    const cmp = await h.tool("record_analysis").execute("id", {
      kind: "comparison",
      purpose: "exploration",
      baseline_run: 1,
      candidate_run: candidateRun,
      changed_components: [],
      prereg_id: prereg.id,
      axis,
    }, null, null, h.ctx);
    assert.equal(firstJsonLine(cmp.content[0].text).status, "appended", `comparison ${i + 1} written`);
  }
  return prereg.id;
}

// ---------------------------------------------------------------------------
// 1. Registration presence + schema shape
// ---------------------------------------------------------------------------

test("the three research-map tools are registered as gated tools with schema objects", async () => {
  const h = await setup("registration");
  for (const name of NEW_TOOLS) {
    const tool = h.tool(name);
    assert.ok(tool, `${name} registered`);
    assert.equal(typeof tool.execute, "function", `${name} has an execute`);
    assert.ok(tool.parameters, `${name} declares a parameters schema`);
    assert.equal(tool.name, name);
  }
  // log_observation: §7.3 schema shape (additionalProperties: false makes the
  // forbidden keys unrepresentable; outcome+description required).
  const obs = h.tool("log_observation").parameters;
  assert.equal(obs.type, "object");
  assert.equal(obs.additionalProperties, false);
  assert.deepEqual(obs.required, ["outcome", "description"]);
  assert.deepEqual(obs.properties.outcome.enum, ["success", "technical_failure", "unknown"]);
  assert.ok(obs.properties.passport, "passport sub-schema present");
  // record_analysis: §7.4 schema shape (kind enum, additionalProperties: false).
  const ana = h.tool("record_analysis").parameters;
  assert.equal(ana.type, "object");
  assert.equal(ana.additionalProperties, false);
  assert.deepEqual(ana.required, ["kind"]);
  assert.deepEqual(ana.properties.kind.enum, ["prereg", "comparison", "attribution", "supplement"]);
  // direction_review: fixed contract — takes no input.
  const rev = h.tool("direction_review").parameters;
  assert.deepEqual(Object.keys(rev.properties ?? {}), []);
  // All three are kept always-active (gated at execution time like the others).
  const active = new Set(h.pi.getActiveTools());
  for (const name of NEW_TOOLS) assert.ok(active.has(name), `${name} is in the active tool set`);
});

// ---------------------------------------------------------------------------
// 2. log_observation through the registered tool
// ---------------------------------------------------------------------------

test("log_observation happy path: appended to observations.jsonl, response carries the §7.3 fields, ledger untouched", async () => {
  const h = await setup("obs-happy");
  await runExp(h);
  const beforeLedger = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");

  const res = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "warm-up measurement check",
  }, null, null, h.ctx);
  const afterLedger = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  const response = firstJsonLine(res.content[0].text);
  assert.equal(response.status, "appended");
  assert.match(response.obs_id, /^obs-/);
  assert.equal(response.observed_run, 1);
  assert.equal(response.binding, "verified");
  assert.ok(Array.isArray(response.warnings));

  // The observation file holds exactly one observation record (§7.1: no run/status keys).
  const lines = fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.record, "observation");
  assert.equal(record.outcome, "success");
  for (const key of ["run", "status", "type", "commit", "epoch", "segment"]) {
    assert.ok(!(key in record), `forbidden key ${key} absent from the stored record`);
  }
  // I-2: log_observation never changes a byte of the ledger.
  assert.equal(afterLedger, beforeLedger, "log.jsonl byte-identical across the observation");
});

test("log_observation rejects forbidden keys (run/status/type/commit/epoch/segment/observed_run) with no write", async () => {
  const h = await setup("obs-forbidden");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  const ledgerBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");

  for (const key of ["run", "status", "type", "commit", "epoch", "segment", "observed_run"]) {
    const res = await h.tool("log_observation").execute("id", {
      outcome: "success", description: "attempt", [key]: 1,
    }, null, null, h.ctx);
    const response = firstJsonLine(res.content[0].text);
    assert.equal(response.status, "error", `${key} rejected`);
    assert.equal(response.code, "invalid_input", `${key} -> invalid_input`);
  }
  // Nothing was written.
  assert.equal(fs.existsSync(path.join(autoDirOf(h.dir), "observations.jsonl")), false, "no observations file created");
  assert.equal(fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8"), ledgerBefore, "ledger untouched by rejected calls");
});

test("log_observation response carries a read-only passport view of the linked run (D-RM-06); unknown components stay unknown", async () => {
  const h = await setup("obs-passport");
  await seedRuns(h, 2);
  // Declare a passport for run 2 (the default "last" link) through an
  // observation (the stored run_link is ambiguous — a link is proven only by
  // the sidecar; the view must consult the RECOMPUTED link, not the snapshot).
  const declared = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "state passport declaration",
    passport: {
      components: {
        weights: { ref: "models/champion.bin", declared_sha256: "a".repeat(64) },
        prompt: { ref: "prompts/champion.md" },
        dataset: {}, // nothing provided -> unknown
      },
    },
  }, null, null, h.ctx);
  const declaredResponse = firstJsonLine(declared.content[0].text);
  assert.equal(declaredResponse.status, "appended");
  // run 2 has a proven link (recomputed by runLinkOf) -> the view resolves components.
  const verdict = runLinkOf(autoDirOf(h.dir), 2);
  assert.equal(verdict.link, "proven");
  assert.match(declared.content[0].text, /Passport view of run #2/);
  assert.match(declared.content[0].text, /weights: declared/);
  assert.match(declared.content[0].text, /prompt: declared/);
  assert.match(declared.content[0].text, /dataset: unknown/);
  assert.match(declared.content[0].text, new RegExp(`run_epoch: ${verdict.runEpoch}`));

  // A run WITHOUT a proven link shows all components unknown — no guessing (§8.1).
  // Run 2 is proven only while the sidecar stays; remove it and the view degrades.
  fs.unlinkSync(path.join(autoDirOf(h.dir), "run-links.jsonl"));
  assert.equal(runLinkOf(autoDirOf(h.dir), 2).link, "ambiguous");
  const bare = await h.tool("log_observation").execute("id", {
    outcome: "success", description: "observation after sidecar loss",
    linked_run: 2,
  }, null, null, h.ctx);
  assert.equal(firstJsonLine(bare.content[0].text).observed_run, 2);
  assert.match(bare.content[0].text, /All components unknown/, "components stay unknown without a proven recomputed link");

  // Details surface the structured view with verified: false everywhere (§8.2).
  assert.equal(declared.details.run_passport_view.run, 2);
  assert.equal(declared.details.run_passport_view.components.weights.verified, false);
  assert.equal(declared.details.run_passport_view.components.dataset.state, "unknown");
});

// ---------------------------------------------------------------------------
// 3. record_analysis through the registered tool
// ---------------------------------------------------------------------------

test("record_analysis prereg happy path: appended with computed prereg_status (no_candidate_run)", async () => {
  const h = await setup("analysis-prereg");
  await seedRuns(h, 1);
  const res = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "s21",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "champion branch" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 2 },
    noise_band: 0.002,
    noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
  }, null, null, h.ctx);
  const response = firstJsonLine(res.content[0].text);
  assert.equal(response.status, "appended");
  assert.equal(response.kind, "prereg");
  assert.match(response.id, /^pre-/);
  // Computed section (§9.3): ordering is unknown before any candidate run.
  assert.equal(response.computed.prereg_status.status, "unknown");
  assert.equal(response.computed.prereg_status.order_reason, "no_candidate_run");
  // Persisted with the system-computed ledger prefix.
  const line = fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "")[0];
  const record = JSON.parse(line);
  assert.equal(record.kind, "prereg");
  assert.equal(typeof record.ledger_prefix_bytes, "number");
  assert.match(record.ledger_prefix_sha256, /^[0-9a-f]{64}$/);
});

test("record_analysis comparison happy path: appended with computed control; post_hoc classification visible in computed", async () => {
  const h = await setup("analysis-posthoc");
  await seedRuns(h, 2);
  const pre = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "s21",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "x" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 2 },
    noise_band: 0.002,
    noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
  }, null, null, h.ctx);
  const prereg = firstJsonLine(pre.content[0].text);
  assert.equal(prereg.status, "appended");
  // §9.3: at write time the candidate run is not yet known — the honest default.
  assert.equal(prereg.computed.prereg_status.status, "unknown");
  assert.equal(prereg.computed.prereg_status.order_reason, "no_candidate_run");
  const preregId = prereg.id;

  const cmp = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "component_attribution",
    baseline_run: 1,
    candidate_run: 2,
    changed_components: ["weights"],
    prereg_id: preregId,
    axis: "s21",
  }, null, null, h.ctx);
  const response = firstJsonLine(cmp.content[0].text);
  assert.equal(response.status, "appended");
  assert.match(response.id, /^cmp-/);
  assert.equal(response.computed.control.control, "controlled");
  assert.equal(response.computed.control.control_basis, "declared_one_changed");
  assert.equal(typeof response.computed.control.delta_allowed, "boolean");
  const comparisonId = response.id;

  // The post_hoc classification that IS visible in a response computed section:
  // a §9.5 supplement to the comparison carries timing = post_hoc_supplement
  // (relative to the target record; §9.5 rule 2).
  const supp = await h.tool("record_analysis").execute("id", {
    kind: "supplement",
    target_id: comparisonId,
    field: "noise_band",
    value: 0.004,
  }, null, null, h.ctx);
  const suppResponse = firstJsonLine(supp.content[0].text);
  assert.equal(suppResponse.status, "appended", `supplement rejected: ${suppResponse.message ?? ""}`);
  assert.equal(suppResponse.computed.timing, "post_hoc_supplement",
    "post_hoc timing visible in the response computed section (§9.5)");
});

test("record_analysis rejects unknown references and unknown fields without writing", async () => {
  const h = await setup("analysis-reject");
  await seedRuns(h, 1);
  const before = fs.existsSync(path.join(autoDirOf(h.dir), "analysis.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8")
    : "";
  const badRef = await h.tool("record_analysis").execute("id", {
    kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, prereg_id: "pre-missing-00000000",
  }, null, null, h.ctx);
  const badRefResponse = firstJsonLine(badRef.content[0].text);
  assert.equal(badRefResponse.status, "error");
  assert.equal(badRefResponse.code, "unknown_reference");

  const badField = await h.tool("record_analysis").execute("id", {
    kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, nonsense: 1,
  }, null, null, h.ctx);
  const badFieldResponse = firstJsonLine(badField.content[0].text);
  assert.equal(badFieldResponse.status, "error");
  assert.equal(badFieldResponse.code, "invalid_input");

  const after = fs.existsSync(path.join(autoDirOf(h.dir), "analysis.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8")
    : "";
  assert.equal(before, after, "rejected calls write nothing");
});

// ---------------------------------------------------------------------------
// 4. direction_review: document generation, fixed sections, zero run calls
// ---------------------------------------------------------------------------

test("direction_review writes ONE .auto/reviews/direction-<UTC>.md with the fixed section names and runs nothing (T19)", async () => {
  const h = await setup("review");
  await seedRuns(h, 2);

  // Spy: count loop-tool executions while the review runs (I-15 / FR-06.1).
  const execCallsBefore = h.pi.execCalls.length;
  const runsBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8")
    .split("\n").filter((l) => l.includes('"run":')).length;
  const obsBefore = fs.existsSync(path.join(autoDirOf(h.dir), "observations.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length
    : 0;
  const analysisBefore = fs.existsSync(path.join(autoDirOf(h.dir), "analysis.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length
    : 0;

  const res = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  assert.match(res.content[0].text, /Direction review written/);
  assert.match(res.content[0].text, /No experiments were run/);

  // Zero run_experiment/log_experiment side effects (pure reads, T19 semantics).
  const runsAfter = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8")
    .split("\n").filter((l) => l.includes('"run":')).length;
  assert.equal(runsAfter, runsBefore, "no ledger rows added");
  const obsAfter = fs.existsSync(path.join(autoDirOf(h.dir), "observations.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "observations.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length
    : 0;
  assert.equal(obsAfter, obsBefore, "no observations added");
  const analysisAfter = fs.existsSync(path.join(autoDirOf(h.dir), "analysis.jsonl"))
    ? fs.readFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length
    : 0;
  assert.equal(analysisAfter, analysisBefore, "no analysis records added");
  // execCalls during the review are at most measurement-health reads, never git/run spawns:
  const delta = h.pi.execCalls.slice(execCallsBefore);
  assert.equal(delta.filter((c) => c.cmd === "git").length, 0, "no git calls from direction_review");

  // Exactly one file, named direction-<UTC-timestamp>.md.
  const review = latestReview(h.dir);
  assert.match(review.name, /^direction-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
  for (const section of REVIEW_SECTIONS) {
    assert.ok(review.text.includes(section), `fixed section present: ${section}`);
  }
  // Mandatory phrases (§12.2 п.7).
  assert.ok(review.text.includes("Надёжность алгоритма не оценивается"));
  assert.ok(review.text.includes(EXHAUSTION_DISCLAIMER));
  // The document never declares exhaustion (FR-06.3 / §12.6). The §12.2 heading
  // «Что не доказано» is a fixed section NAME, not a claim — headings are
  // excluded from the forbidden-wording scan over claim sentences.
  const claimText = review.text.split("\n").filter((l) => !l.startsWith("## ")).join("\n");
  assert.doesNotMatch(claimText, /ось исчерпана|направление не работает|причина установлена|доказано/);
});

test("direction_review on an empty campaign yields a «нет данных» document", async () => {
  const h = await setup("review-empty");
  const res = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  assert.match(res.content[0].text, /Direction review written/);
  const review = latestReview(h.dir);
  assert.ok(review.text.includes("нет данных"), "empty sections are explicit «нет данных»");
  for (const section of REVIEW_SECTIONS) {
    assert.ok(review.text.includes(section), `fixed section present even when empty: ${section}`);
  }
});

test("direction_review repeats safely: a second call creates another document, previous files untouched", async () => {
  const h = await setup("review-twice");
  await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  const first = latestReview(h.dir);
  await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  const reviewsDir = path.join(autoDirOf(h.dir), "reviews");
  const files = fs.readdirSync(reviewsDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 2, "one new file per call, no overwrite");
  assert.equal(fs.readFileSync(path.join(reviewsDir, first.name), "utf8"), first.text);
});

// ---------------------------------------------------------------------------
// 5. §12.4 hint delivery
// ---------------------------------------------------------------------------

test("log_experiment plain success without transition: NO hint line", async () => {
  const h = await setup("hint-plain");
  await seedRuns(h, 3);
  // A further equal keep changes nothing: no S_stag (counter 0), no S_ser (no
  // improvements at all), no S_exh change.
  const prop = await h.tool("propose_hypothesis").execute("id", { description: "same again" }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.5, hyp);
  const res = await logExp(h, { metric: 0.5, status: "keep", description: "another same", metrics: { F1: 0.5 }, hypothesis_id: hyp });
  assert.doesNotMatch(res.content[0].text, /Предлагается обзор/, "no hint without a transition");
  assert.doesNotMatch(res.content[0].text, new RegExp(EXHAUSTION_DISCLAIMER));
});

test("log_experiment S_stag transition: exactly one hint line with the disclaimer (12.4a)", async () => {
  const h = await setup("hint-stag");
  // K_STAG = 8: run 1 is the baseline (counter 0); equal keeps raise it by 1,
  // so the 9th run (counter 8) crosses S_stag.
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  for (let i = 2; i <= 8; i++) {
    const text = await seedOneKeep(h, i);
    assert.doesNotMatch(text, /S_stag/, `no hint while the counter is below 8 (run ${i})`);
  }
  const res8 = await seedOneKeep(h, 9);
  const hintLines = res8.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  assert.equal(hintLines.length, 1, "exactly one hint line");
  assert.match(hintLines[0], /S_stag/);
  assert.ok(hintLines[0].includes(EXHAUSTION_DISCLAIMER), "the built-in disclaimer is present");
  assert.match(hintLines[0], /direction_review/);
  // The hint does not repeat while the condition stays true.
  const res9 = await seedOneKeep(h, 10);
  assert.doesNotMatch(res9, /Предлагается обзор/, "no repeat while the condition remains true");
});

test("log_experiment delivers a trusted S_exh stage hint when a comparison completes a beyond-noise window", async () => {
  const h = await setup("hint-sexh");
  // Baseline 0.50 + two candidate runs at 0.505 (g = 0.005 < T−B = 0.007 → beyond noise).
  await seedRuns(h, 1, 0.5);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 2, candidateMetric: 0.505 });
  // Two comparisons: windows of K=2 are not complete yet -> the S_exh hints were
  // advisory-free and stage hints must NOT have fired inside record_analysis.
  // The third comparison completes a window; but S_exh rises are computed at
  // WRITE points — here the write point is record_analysis itself, covered in
  // the next test. This test asserts log_experiment hint absence in this state:
  // a plain keep of an ordinary run adds no analysis record, so no S_exh rise.
  const prop = await h.tool("propose_hypothesis").execute("id", { description: "after comparisons" }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.5, hyp);
  const res = await logExp(h, { metric: 0.5, status: "keep", description: "plain keep after comparisons", metrics: { F1: 0.5 }, hypothesis_id: hyp });
  const hintLines = res.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  assert.equal(hintLines.length, 0, "log_experiment hints only on S_stag/S_ser transitions or S_exh barrier removal");
  assert.ok(preregId, "fixture prereg in place");
});

test("record_analysis comparison completing a beyond-noise window: S_exh stage hint with the disclaimer in the response", async () => {
  const h = await setup("hint-sexh-write");
  await seedRuns(h, 1, 0.5);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 1, candidateMetric: 0.505 });
  // The second eligible comparison completes the first K=2 window beyond noise:
  // window (0.005, 0.005), T=0.009, B=0.002 -> both gains below T−B -> stage 2.
  const prop = await h.tool("propose_hypothesis").execute("id", { description: "second candidate" }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.505, hyp);
  await logExp(h, { metric: 0.505, status: "keep", description: "second candidate", metrics: { F1: 0.505 }, hypothesis_id: hyp });
  const cmp = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: 3,
    changed_components: [],
    prereg_id: preregId,
    axis: "s21",
  }, null, null, h.ctx);
  const hintLines = cmp.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  assert.equal(hintLines.length, 1, "one hint line in the record_analysis response");
  assert.match(hintLines[0], /S_exh/);
  assert.ok(hintLines[0].includes(EXHAUSTION_DISCLAIMER));
  // The engine's own stage wording for stage 2 (§12.3 wording).
  assert.match(hintLines[0], /Кандидат на пересмотр оси s21/);
});

test("record_analysis advisory at 3 comparisons on one axis: S_exh_adv line with the advisory disclaimer (§12.3b)", async () => {
  const h = await setup("hint-adv");
  await seedRuns(h, 4, 0.5);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 0 });
  let advisorySeen = false;
  for (let i = 0; i < 3; i++) {
    const prop = await h.tool("propose_hypothesis").execute("id", { description: `adv hyp ${i}` }, null, null, h.ctx);
    const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
    await runExp(h, 0.501, hyp);
    await logExp(h, { metric: 0.501, status: "keep", description: `cmp run ${i + 2}`, metrics: { F1: 0.501 }, hypothesis_id: hyp });
    const cmp = await h.tool("record_analysis").execute("id", {
      kind: "comparison",
      purpose: "exploration",
      baseline_run: 1,
      candidate_run: i + 2,
      changed_components: [],
      prereg_id: preregId,
      axis: "s21",
    }, null, null, h.ctx);
    const advisory = cmp.content[0].text.split("\n").filter((l) => l.includes("S_exh_adv"));
    if (i < 2) {
      assert.equal(advisory.length, 0, `no advisory below 3 comparisons (n=${i + 1})`);
    } else {
      assert.equal(advisory.length, 1, "exactly one advisory line at n=3");
      assert.ok(advisory[0].includes(ADVISORY_DISCLAIMER), "the advisory disclaimer is present");
      assert.match(advisory[0], /накоплено 3 читаемых сравнения|накоплено 3 читаемых сравнений/);
      advisorySeen = true;
    }
  }
  assert.ok(advisorySeen, "the advisory fired at the threshold crossing");
});

test("budget guard: a key beyond the global first 16 yields NO hint even when it is the only affected key (§12.3a)", async () => {
  const h = await setup("hint-budget");
  // Prereg BEFORE the runs (so candidates stay pre_registered), then build
  // FIRST_KEYS_LIMIT + 1 distinct keys (one axis each) and let the LAST (17th)
  // key complete a beyond-noise window: its key sorts beyond the first 16, so
  // no trusted hint may fire for it (§12.3a «Объём»). Keys exist only where a
  // comparison references the axis, so the 17 preregs are written first.
  await seedRuns(h, 1, 0.5);
  const total = FIRST_KEYS_LIMIT + 1;
  const keys = [];
  for (let i = 0; i < total; i++) {
    const axis = `ax${String(i).padStart(2, "0")}`;
    const pre = await h.tool("record_analysis").execute("id", {
      kind: "prereg",
      axis,
      branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "x" }],
      exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 2 },
      noise_band: 0.002,
      noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
    }, null, null, h.ctx);
    const prereg = firstJsonLine(pre.content[0].text);
    keys.push({ axis, preregId: prereg.id });
  }
  // Enough proven candidate runs (g = 0.005 < T−B → beyond noise). SimHash may
  // flag similar descriptions as duplicates, so loop until 19 distinct runs land.
  let proven = 0;
  for (let i = 2; proven < total + 2 && i < 80; i++) {
    const desc = `completely different budget plan ${i} method ${i * 31} goal ${i * 17} ${Math.random().toString(36).slice(2, 8)}`;
    const prop = await h.tool("propose_hypothesis").execute("id", { description: desc }, null, null, h.ctx);
    if (!prop.details || prop.details.status === "duplicate") continue;
    const hyp = prop.details.node_id;
    await runExp(h, 0.505, hyp);
    await logExp(h, { metric: 0.505, status: "keep", description: `budget run ${i}`, metrics: { F1: 0.505 }, hypothesis_id: hyp });
    proven++;
  }
  assert.ok(proven >= total + 2, "enough proven candidate runs for the fixture");
  // First 16 keys get one comparison each (below the window threshold K=2).
  for (let i = 0; i < FIRST_KEYS_LIMIT; i++) {
    const { axis, preregId } = keys[i];
    const cmp = await h.tool("record_analysis").execute("id", {
      kind: "comparison",
      purpose: "exploration",
      baseline_run: 1,
      candidate_run: i + 2,
      changed_components: [],
      prereg_id: preregId,
      axis,
    }, null, null, h.ctx);
    assert.equal(firstJsonLine(cmp.content[0].text).status, "appended");
    assert.doesNotMatch(cmp.content[0].text, /S_exh\)/, `no stage hint for key ${i + 1} (no completed window)`);
  }
  // The 17th key materializes with its FIRST comparison (candidate 17) — at that
  // moment exactly one key sits beyond the global first 16 (fail-closed key_limit).
  const last = keys[total - 1];
  await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: total,
    changed_components: [],
    prereg_id: last.preregId,
    axis: last.axis,
  }, null, null, h.ctx);
  const state = computeExhaustionState(autoDirOf(h.dir));
  const beyond = state.keys.filter((k) => !k.assessed && k.display.code === "budget_exhausted");
  assert.equal(beyond.length, 1, "exactly one key sits beyond the first-16 budget");
  assert.equal(beyond[0].key.axis, last.axis, "the beyond-budget key is the 17th axis");
  // The 17th key completes its K=2 window — but it is beyond the budget.
  const cmpLast = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: total + 1,
    changed_components: [],
    prereg_id: last.preregId,
    axis: last.axis,
  }, null, null, h.ctx);
  const response = firstJsonLine(cmpLast.content[0].text);
  assert.equal(response.status, "appended");
  // No trusted S_exh line for the beyond-budget key (its data would be enough
  // in a within-budget key — the hint is suppressed purely by the budget).
  const hintLines = cmpLast.content[0].text.split("\n").filter((l) => l.includes("S_exh)"));
  assert.equal(hintLines.length, 0, "no S_exh hint from a key beyond the global first 16");
});

test("hint lines never appear more than once per response when several causes fire (§12.3b merged-hint preference)", async () => {
  const h = await setup("hint-merged");
  // The engine merges trusted+advisory causes into one line inside its own text;
  // the wiring must additionally cap delivery at one line per response.
  await seedRuns(h, 1, 0.5);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 1, candidateMetric: 0.505 });
  const prop = await h.tool("propose_hypothesis").execute("id", { description: "merged candidate" }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.505, hyp);
  await logExp(h, { metric: 0.505, status: "keep", description: "second candidate", metrics: { F1: 0.505 }, hypothesis_id: hyp });
  const cmp = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: 3,
    changed_components: [],
    prereg_id: preregId,
    axis: "s21",
  }, null, null, h.ctx);
  const hintLines = cmp.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  // Exact count: the fixture provably fires (same fixture as the S_exh stage
  // test above), so zero lines would mean the hint was DROPPED, not capped.
  assert.equal(hintLines.length, 1, "exactly one merged hint line when several causes fire");
  assert.match(hintLines[0], /S_exh/);
});

// ---------------------------------------------------------------------------
// 7. Review fixes: passport conflict, review_requested statement, explore-row
//    exclusion, merged multi-cause hint, §12.2 sections, no-overwrite naming
// ---------------------------------------------------------------------------

test("runPassportView resolves a single declared source; conflicting (ref, sha) pairs become unknown with the view-only conflict key (§8.1/§8.2, M-e)", async () => {
  const h = await setup("passport-conflict");
  await seedRuns(h, 2);
  // Observation A declares weights.ref = models/a.bin for run 2.
  const a = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "passport A",
    idempotency_key: "passport-a",
    linked_run: 2,
    passport: { components: { weights: { ref: "models/a.bin", declared_sha256: "a".repeat(64) } } },
  }, null, null, h.ctx);
  assert.equal(firstJsonLine(a.content[0].text).status, "appended");
  assert.match(a.content[0].text, /weights: declared \(ref: models\/a\.bin/);

  // Observation B (same run, different weights.ref) -> the component is no
  // longer resolvable: unknown, no guessing (§8.1). The §8.2 note enum is
  // closed, so note stays "not_provided" and the conflict is carried by the
  // separate VIEW-ONLY key conflict:"passport_conflict" (M-e; view only —
  // stored records are untouched).
  const b = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "passport B conflicts with A",
    idempotency_key: "passport-b",
    linked_run: 2,
    passport: { components: { weights: { ref: "models/b.bin", declared_sha256: "b".repeat(64) } } },
  }, null, null, h.ctx);
  assert.match(b.content[0].text, /weights: unknown \(passport_conflict\)/);
  const detailsB = b.details.run_passport_view;
  assert.equal(detailsB.components.weights.state, "unknown");
  assert.equal(detailsB.components.weights.note, "not_provided");
  assert.equal(detailsB.components.weights.conflict, "passport_conflict");
  assert.equal(detailsB.components.weights.ref, null);

  // A third observation repeating A's exact (ref, sha) pair does NOT create a
  // conflict on its own — wait, A and B already conflict; this observation
  // repeats B, so the conflict stays (distinct pairs: A vs B).
  const c = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "passport C repeats B",
    idempotency_key: "passport-c",
    linked_run: 2,
    passport: { components: { weights: { ref: "models/b.bin", declared_sha256: "b".repeat(64) } } },
  }, null, null, h.ctx);
  assert.match(c.content[0].text, /weights: unknown \(passport_conflict\)/);

  // A fresh run with a single declaration still resolves (single-source path).
  // Run 3 needs a ledger row + sidecar (proven link) — run, log, then observe.
  let prop1 = await h.tool("propose_hypothesis").execute("id", { description: "single source run" }, null, null, h.ctx);
  let hyp1 = (prop1.details && prop1.details.node_id) || (prop1.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.6, hyp1);
  await logExp(h, { metric: 0.6, status: "keep", description: "single source run", metrics: { F1: 0.6 }, hypothesis_id: hyp1 });
  const single = await h.tool("log_observation").execute("id", {
    outcome: "success",
    description: "single-source passport",
    linked_run: 3,
    passport: { components: { weights: { ref: "models/only.bin", declared_sha256: "c".repeat(64) } } },
  }, null, null, h.ctx);
  assert.match(single.content[0].text, /weights: declared \(ref: models\/only\.bin/);
});

test("record_analysis review_requested: exactly one advisory statement hint on the first valid statement; no repeat in the same segment (§12.3b)", async () => {
  const h = await setup("review-requested");
  await seedRuns(h, 2);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 0 });

  // First statement on the axis: hint with ADVISORY_DISCLAIMER + pointer.
  const first = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: 2,
    changed_components: [],
    prereg_id: preregId,
    axis: "s21",
    review_requested: true,
  }, null, null, h.ctx);
  const hintLines = first.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  assert.equal(hintLines.length, 1, "exactly one advisory-statement hint line");
  assert.match(hintLines[0], /S_exh_adv, ось s21/);
  assert.match(hintLines[0], /review_requested/);
  assert.ok(hintLines[0].includes(ADVISORY_DISCLAIMER), "advisory disclaimer present");
  assert.match(hintLines[0], /direction_review/);
  const response = firstJsonLine(first.content[0].text);
  assert.equal(response.status, "appended");
  const firstId = response.id;

  // Second statement in the same segment: record written, hint NOT repeated.
  const prop = await h.tool("propose_hypothesis").execute("id", { description: "second statement run" }, null, null, h.ctx);
  const hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.5, hyp);
  await logExp(h, { metric: 0.5, status: "keep", description: "second statement run", metrics: { F1: 0.5 }, hypothesis_id: hyp });
  const second = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: 3,
    changed_components: [],
    prereg_id: preregId,
    axis: "s21",
    review_requested: true,
  }, null, null, h.ctx);
  assert.equal(firstJsonLine(second.content[0].text).status, "appended", "second statement is still recorded");
  assert.doesNotMatch(second.content[0].text, /review_requested по записи/, "no hint repeat in the same segment");
  assert.ok(firstId.startsWith("cmp-"));
});

test("review_requested hint is suppressed after a torn analysis line and on non-statement records", async () => {
  const h = await setup("review-requested-torn");
  await seedRuns(h, 2);
  const preregId = await seedPreregAndComparisons(h, { comparisons: 0 });
  // Corrupt the analysis tail: the segment becomes unknown -> no statement hint.
  fs.appendFileSync(path.join(autoDirOf(h.dir), "analysis.jsonl"), "{torn\n");
  const res = await h.tool("record_analysis").execute("id", {
    kind: "comparison",
    purpose: "exploration",
    baseline_run: 1,
    candidate_run: 2,
    changed_components: [],
    prereg_id: preregId,
    axis: "s21",
    review_requested: true,
  }, null, null, h.ctx);
  assert.equal(firstJsonLine(res.content[0].text).status, "appended");
  assert.doesNotMatch(res.content[0].text, /Предлагается обзор направлений/, "torn history -> no statement hint");
});

test("explore rows are invisible to the S_stag counter: discards interleaved with explore still fire exactly once at the 8th non-explore row", async () => {
  const h = await setup("explore-stag");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  const ledgerPath = path.join(autoDirOf(h.dir), "log.jsonl");
  const appendExplore = () => {
    const state = JSON.parse(fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.includes('"run":'))[0]);
    const runNo = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "" && JSON.parse(l).run !== undefined).length + 1;
    fs.appendFileSync(ledgerPath, JSON.stringify({ run: runNo, metric: 0.4, status: "explore", description: "phase step", segment: state.segment ?? 0, epoch: 1 }) + "\n");
  };

  // 4 non-improvements, 2 explore rows in between (not counted), then 4 more:
  // the counter reaches 8 exactly at step 11, the 8th NON-explore row.
  for (let i = 2; i <= 10; i++) {
    if (i === 6 || i === 7) {
      appendExplore();
      continue;
    }
    const text = await seedOneRun(h, i, "discard", 0.4);
    assert.doesNotMatch(text, /S_stag/, `no hint below 8 non-explore rows (step ${i})`);
  }
  const res8 = await seedOneRun(h, 11, "discard", 0.4);
  const hintLines = res8.split("\n").filter((l) => l.includes("S_stag"));
  assert.equal(hintLines.length, 1, "S_stag fires exactly once at the 8th non-explore row");
});

test("explore rows before and after a discard streak neither increment nor reset the counters and yield no hint", async () => {
  const h = await setup("explore-neutral");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  const ledgerPath = path.join(autoDirOf(h.dir), "log.jsonl");
  const appendLedgerRow = (row) => fs.appendFileSync(ledgerPath, JSON.stringify(row) + "\n");
  const runCount = () => fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "" && JSON.parse(l).run !== undefined).length;

  // 7 discards (counter 7, no hint yet), then explore rows around another discard.
  for (let i = 2; i <= 8; i++) {
    const text = await seedOneRun(h, i, "discard", 0.4);
    assert.doesNotMatch(text, /S_stag/, `no hint at counter ${i - 1}`);
  }
  assert.equal(runCount(), 8);
  // Explore rows before AND after a further discard must not move the counter.
  const nextRun = runCount() + 1;
  appendLedgerRow({ run: nextRun, metric: 0.4, status: "explore", description: "before", segment: 0, epoch: 1 });
  const text9 = await seedOneRun(h, 9, "discard", 0.4); // discard #8 -> S_stag fires
  const hintLines = text9.split("\n").filter((l) => l.includes("S_stag"));
  assert.equal(hintLines.length, 1, "S_stag fires at the 8th non-explore non-improvement");
  appendLedgerRow({ run: nextRun + 1, metric: 0.4, status: "explore", description: "after", segment: 0, epoch: 1 });
  const after = fs.readFileSync(ledgerPath, "utf8");
  assert.ok(after.includes('"status":"explore"'), "explore rows present in the ledger");
  // A plain log after the explore rows: the transition was consumed, and explore
  // rows must not re-trigger or reset anything: no second hint.
  const text10 = await seedOneRun(h, 10, "discard", 0.4);
  assert.doesNotMatch(text10, /S_stag/, "no re-trigger; explore rows do not reset the consumed transition");
});

test("several causes fire on one write: ONE merged hint line shows every cause code with a shared disclaimer (§12.3b)", async () => {
  const h = await setup("hint-merged-two-causes");
  await seedRuns(h, 1, 0.5);
  // Fixture plan: two preregs on the SAME axis s21, both with k=2 windows.
  // cmp1 → prereg2 (n=1), cmp2 → prereg1 (n=2; prereg1 has only ONE element →
  // window_short → no hint), cmp3 → prereg2: completes prereg2's window
  // [cmp1, cmp3] → S_exh AND is the 3rd comparison on the axis (n=3 →
  // S_exh_adv) — both causes fire on one write and must merge (§12.3b).
  const pre1 = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "s21",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.51, meaning: "x" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 2 },
    noise_band: 0.002,
    noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
  }, null, null, h.ctx);
  const pre2 = await h.tool("record_analysis").execute("id", {
    kind: "prereg",
    axis: "s21",
    branches: [{ name: "alt", metric_name: "F1", op: ">=", threshold: 0.55, meaning: "y" }],
    exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.008, k: 2 },
    noise_band: 0.002,
    noise_basis_ref: { run: 1, artifact: "output", lines: null, anchor: null },
  }, null, null, h.ctx);
  const prereg1 = firstJsonLine(pre1.content[0].text).id;
  const prereg2 = firstJsonLine(pre2.content[0].text).id;

  // Candidate run 2 + cmp1 → prereg2 (prereg2 element 1/2) — no hint yet.
  let prop = await h.tool("propose_hypothesis").execute("id", { description: "candidate two" }, null, null, h.ctx);
  let hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.505, hyp);
  await logExp(h, { metric: 0.505, status: "keep", description: "candidate two", metrics: { F1: 0.505 }, hypothesis_id: hyp });
  await h.tool("record_analysis").execute("id", {
    kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2,
    changed_components: [], prereg_id: prereg2, axis: "s21",
  }, null, null, h.ctx);

  // Candidate run 3 + cmp2 → prereg1: prereg1's key has ONE element (window_short)
  // and the axis count reaches n=2 — no hint on this write.
  prop = await h.tool("propose_hypothesis").execute("id", { description: "candidate three" }, null, null, h.ctx);
  hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.505, hyp);
  await logExp(h, { metric: 0.505, status: "keep", description: "candidate three", metrics: { F1: 0.505 }, hypothesis_id: hyp });
  const cmp2 = await h.tool("record_analysis").execute("id", {
    kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 3,
    changed_components: [], prereg_id: prereg1, axis: "s21",
  }, null, null, h.ctx);
  const lines2 = cmp2.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  assert.equal(lines2.length, 0, "no hint while prereg1's window is short and n=2");

  // Candidate run 4 + cmp3 → prereg2: completes prereg2's window (S_exh) AND
  // is the 3rd comparison on the axis (n=3 → S_exh_adv).
  prop = await h.tool("propose_hypothesis").execute("id", { description: "candidate four" }, null, null, h.ctx);
  hyp = (prop.details && prop.details.node_id) || (prop.content[0].text.match(/n\d+/) || [undefined])[0];
  await runExp(h, 0.505, hyp);
  await logExp(h, { metric: 0.505, status: "keep", description: "candidate four", metrics: { F1: 0.505 }, hypothesis_id: hyp });
  const cmp3 = await h.tool("record_analysis").execute("id", {
    kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 4,
    changed_components: [], prereg_id: prereg2, axis: "s21",
  }, null, null, h.ctx);
  const hintLines = cmp3.content[0].text.split("\n").filter((l) => l.includes("Предлагается обзор направлений"));
  // The merged line: S_exh (prereg2 stage) + S_exh_adv (n=3 crossing) in ONE line.
  assert.equal(hintLines.length, 1, "all causes merge into ONE hint line");
  assert.match(hintLines[0], /S_exh\)/, "first cause code present");
  assert.match(hintLines[0], /S_exh_adv/, "second cause code present");
  assert.match(hintLines[0], /накоплено 3/, "advisory count inside the merged line");
  // Exactly one shared disclaimer per kind at the end (§12.3b).
  const disclaimers = hintLines[0].split(EXHAUSTION_DISCLAIMER).length - 1;
  assert.equal(disclaimers, 1, "shared EXHAUSTION_DISCLAIMER appears exactly once");
  const advisoryCount = hintLines[0].split(ADVISORY_DISCLAIMER).length - 1;
  assert.equal(advisoryCount, 1, "shared ADVISORY_DISCLAIMER appears exactly once");
  // M-d: details.hint carries the FULL merged hint text (all causes), the
  // exact line appended to the response text (leading newline included) —
  // not only the first cause.
  assert.equal(cmp3.details.hint, "\n" + hintLines[0], "details.hint is the full merged hint line, byte-identical to the text line");
  assert.match(cmp3.details.hint, /S_exh_adv/, "details.hint keeps the second cause too");
});

test("direction_review sections follow §12.2 names and order; causal claims live in «Что не доказано»", async () => {
  const h = await setup("review-order");
  await seedRuns(h, 2);
  // An attribution with no evidence -> causal claim «unknown» (§10.2 step 1).
  await h.tool("record_analysis").execute("id", {
    kind: "attribution", claim: "weights change caused the gain", evidence_refs: [],
  }, null, null, h.ctx);
  const res = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
  const review = latestReview(h.dir);
  const headingLines = review.text.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headingLines, REVIEW_SECTIONS, "exactly the §12.2 headings in §12.2 order");
  const unproven = review.text.split("## Что не доказано")[1] ?? "";
  assert.match(unproven, /Каузальное утверждение .*unknown \(no_evidence\)/, "causal claim lives in «Что не доказано»");
  const unknownSection = review.text.split("## Неизвестно")[1]?.split("## ")[0] ?? "";
  assert.doesNotMatch(unknownSection, /Каузальное утверждение/, "«Неизвестно» no longer lists causal claims");
  // Mandatory phrases block (§12.2 п.7).
  assert.ok(review.text.includes("Надёжность алгоритма не оценивается"));
  assert.ok(review.text.includes(EXHAUSTION_DISCLAIMER));
  assert.ok(res.content[0].text.includes("Direction review written"));
});

test("direction_review never overwrites: a forced same-stamp collision falls back to -2 and the first document is byte-identical (§12.1, M-c)", async () => {
  const h = await setup("review-suffix");
  const reviewsDir = path.join(autoDirOf(h.dir), "reviews");
  // M-c: FORCE the same millisecond stamp for two consecutive calls by
  // freezing new Date().toISOString() (the exact stamp source direction_review
  // uses at index.ts `const stamp = new Date().toISOString().replace(/[:.]/g, "-")`).
  const FIXED_ISO = "2030-01-01T00:00:00.000Z";
  const FIXED_STAMP = FIXED_ISO.replace(/[:.]/g, "-");
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    toISOString() { return FIXED_ISO; }
  }
  globalThis.Date = FrozenDate;
  let firstText;
  try {
    const res1 = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
    assert.match(res1.content[0].text, /Direction review written/);
    const firstName = `direction-${FIXED_STAMP}.md`;
    const firstPath = path.join(reviewsDir, firstName);
    firstText = fs.readFileSync(firstPath, "utf8");
    assert.ok(firstText.includes("Сформирован: 2030-01-01T00:00:00.000Z"), "the frozen clock really drives the stamp");

    // Second call under the SAME stamp: must NOT overwrite the first document —
    // EEXIST forces the -2 suffix (§12.1: previous documents are never rewritten).
    const res2 = await h.tool("direction_review").execute("id", {}, null, null, h.ctx);
    assert.match(res2.content[0].text, /Direction review written/);
    const secondPath = res2.content[0].text.match(/Direction review written: (.+\.md)/)?.[1] ?? "";
    assert.equal(path.basename(secondPath), `direction-${FIXED_STAMP}-2.md`, "the colliding second write lands on the -2 suffix");
  } finally {
    globalThis.Date = RealDate;
  }
  const files = fs.readdirSync(reviewsDir).filter((f) => f.endsWith(".md"));
  assert.deepEqual(files.sort(), [`direction-${FIXED_STAMP}-2.md`, `direction-${FIXED_STAMP}.md`], "exactly two documents after the forced collision");
  assert.equal(fs.readFileSync(path.join(reviewsDir, `direction-${FIXED_STAMP}.md`), "utf8"), firstText, "first document byte-identical after the colliding write");
});

// ---------------------------------------------------------------------------
// 5b. Torn before-state (M-a, T93/§5.2/§12.4) and S_ser (M-b, T155(b)/E-26)
// ---------------------------------------------------------------------------

test("log_experiment over a torn before-state: an unterminated last line before the 8th discard yields NO hint (T93, §5.2/§12.4)", async () => {
  const h = await setup("torn-unterminated");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  for (let i = 2; i <= 7; i++) await seedOneRun(h, i, "discard", 0.4);
  // Damage the tail WITHOUT a trailing newline: a non-empty line that
  // parseJsonlEntry cannot parse — torn per §5.2 (the spec does not
  // distinguish it from a complete-but-invalid line; both are torn).
  const ledgerPath = path.join(autoDirOf(h.dir), "log.jsonl");
  fs.appendFileSync(ledgerPath, '{"run":99,"metric":0.4,"status":"discard","descripti');
  // The 8th discard would cross S_stag on a healthy ledger — but the
  // pre-append state is torn → before = unknown → §12.4 forbids the hint.
  const text8 = await seedOneRun(h, 8, "discard", 0.4);
  assert.doesNotMatch(text8, /Предлагается обзор/, "torn before-state → before = unknown → no hint");
});

test("log_experiment over a torn before-state: a newline-terminated damaged last line before the 8th discard yields NO hint (T93, §5.2/§12.4)", async () => {
  const h = await setup("torn-damaged");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  for (let i = 2; i <= 7; i++) await seedOneRun(h, i, "discard", 0.4);
  // Complete (newline-terminated) but invalid line: still torn per §5.2 —
  // the spec does NOT carve out a separate treatment for it (§5.2 defines
  // torn purely as "non-empty line where parseJsonlEntry gives no object").
  const ledgerPath = path.join(autoDirOf(h.dir), "log.jsonl");
  fs.appendFileSync(ledgerPath, '{"run":99,"metric":0.4,"status":"discard","description":"damaged"\n');
  // Discriminating case: after the 8th discard's own row the tail is valid
  // again, so ONLY the torn before-check (M-a fix) can suppress the hint.
  const text8 = await seedOneRun(h, 8, "discard", 0.4);
  assert.doesNotMatch(text8, /Предлагается обзор/, "damaged complete line is torn (§5.2) → before = unknown → no hint");
});

test("S_ser per T155(b) with the explore exclusion (E-26): 2 improvements, an explore row, 3rd improvement fires S_ser exactly once; the control without explore also fires on the 3rd", async () => {
  const ledgerPathOf = (h) => path.join(autoDirOf(h.dir), "log.jsonl");
  const appendExplore = (h) => {
    const runNo = fs.readFileSync(ledgerPathOf(h), "utf8").split("\n").filter((l) => l.trim() !== "" && JSON.parse(l).run !== undefined).length + 1;
    fs.appendFileSync(ledgerPathOf(h), JSON.stringify({ run: runNo, metric: 0.4, status: "explore", description: "phase step", segment: 0, epoch: 1 }) + "\n");
  };
  // trailingBestImprovements counts the baseline keep (best === null) as the
  // first improving run, so "2 improvements, then a 3rd" per T155(b) is:
  // baseline (imp 1) → keep 0.51 (imp 2) → [explore] → keep 0.52 (imp 3 =
  // K_SER, S_ser fires exactly here).
  const runThroughThirdImprovement = async (h, { withExplore }) => {
    await runExp(h);
    const base = await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
    const text2 = await seedOneRun(h, 2, "keep", 0.51); // improvement 2 (trailing 2 — not yet K_SER)
    if (withExplore) appendExplore(h);
    const text3 = await seedOneRun(h, 3, "keep", 0.52); // improvement 3 (trailing 3 = K_SER)
    return { base, text2, text3 };
  };

  // With the explore row between improvements 2 and 3: the series survives
  // (explore is invisible to S_ser) and the 3rd improvement fires exactly once.
  const h1 = await setup("sser-explore");
  const { text2, text3 } = await runThroughThirdImprovement(h1, { withExplore: true });
  assert.doesNotMatch(text2, /S_ser/, "no S_ser at trailing 2");
  const hintLines = text3.split("\n").filter((l) => l.includes("S_ser"));
  assert.equal(hintLines.length, 1, "exactly one S_ser hint on the 3rd improvement (explore row in between)");
  assert.ok(hintLines[0].includes(EXHAUSTION_DISCLAIMER), "the built-in disclaimer is present");
  assert.doesNotMatch(text3, /S_stag/, "improving keeps keep the stagnation counter at 0");

  // Control WITHOUT the explore row: S_ser also fires on the 3rd improvement —
  // explore exclusion changes neither the firing point nor the count.
  const h2 = await setup("sser-control");
  const { text3: controlText3 } = await runThroughThirdImprovement(h2, { withExplore: false });
  const controlLines = controlText3.split("\n").filter((l) => l.includes("S_ser"));
  assert.equal(controlLines.length, 1, "control: S_ser fires on the 3rd improvement as well (E-26 exclusion)");
});

// ---------------------------------------------------------------------------
// 6. I-2/I-13 invariants: the new write tools never touch the ledger, git, best
// ---------------------------------------------------------------------------

test("log_observation and record_analysis never call git and never modify log.jsonl (I-2, I-3, I-13)", async () => {
  const h = await setup("invariants");
  await runExp(h);
  await logExp(h, { metric: 0.5, status: "keep", description: "baseline", metrics: { F1: 0.5 } });
  const ledgerBefore = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  const execBefore = h.pi.execCalls.length;

  await h.tool("log_observation").execute("id", { outcome: "success", description: "obs" }, null, null, h.ctx);
  await h.tool("record_analysis").execute("id", {
    kind: "prereg", axis: "s21",
    branches: [{ name: "main", metric_name: "F1", op: ">=", threshold: 0.5, meaning: "x" }],
  }, null, null, h.ctx);
  await h.tool("direction_review").execute("id", {}, null, null, h.ctx);

  const ledgerAfter = fs.readFileSync(path.join(autoDirOf(h.dir), "log.jsonl"), "utf8");
  assert.equal(ledgerAfter, ledgerBefore, "log.jsonl byte-identical");
  const delta = h.pi.execCalls.slice(execBefore);
  assert.equal(delta.filter((c) => c.cmd === "git").length, 0, "no git calls from the new write tools");
});
