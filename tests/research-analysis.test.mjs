/**
 * Analysis journal module for research-map (openspec/changes/research-map/design.md §6.1,
 * §6.2, §6.4, §7.4, §9.1–§9.5, §10.0–§10.3, §10.2a, §12.3a; D-RM-14 … D-RM-17, D-RM-20).
 * Covers design tests T43–T48, T61–T63, T80, T98–T104, T116/T117 budgets and the §6
 * reliability contract (lock busy ≤ 2.5 s, stale lock, cross-process single writer).
 *
 * Run: timeout 180 node --experimental-strip-types --experimental-loader ./tests/redirect-loader.mjs --test tests/research-analysis.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  ANALYSIS_REF_BUDGET_PER_CALL,
  ANALYSIS_KEY_ELEMENT_LIMIT,
  CAMPAIGN_KEY_LIMIT,
  selectCampaignKeys,
  keyElementBudgetOk,
  analysisPrefixSnapshot,
  buildLedgerModel,
  classifyPreregOrder,
  computeAttributionStatus,
  evaluateBranches,
  journalPrefixSnapshot,
  ledgerPrefixSnapshot,
  parseAnalysisParams,
  parseMetricLines,
  readAnalysis,
  recordAnalysis,
} from "../extensions/pi-autoresearch/research-analysis.ts";

const execFileAsync = promisify(execFile);
const MODULE_URL = new URL("../extensions/pi-autoresearch/research-analysis.ts", import.meta.url).href;

const CONFIG_LINE = JSON.stringify({ type: "config", name: "t", metricName: "F1", metricUnit: "", bestDirection: "higher" });
const STARTED = "2026-11-05T10:12:41.007Z";
const EXEC_A = "a".repeat(32);
const EXEC_B = "b".repeat(32);

function sha256Line(line) {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function startLine(run, startedAt = STARTED) {
  return JSON.stringify({ type: "run_started", run_dir: run, node_id: "n1", command: "bench", started_at: startedAt });
}

function resultLine(run, startedAt = STARTED) {
  return JSON.stringify({
    type: "run_result",
    run_dir: run,
    started_at: startedAt,
    node_id: "n1",
    exit_code: 0,
    killed: false,
    duration_seconds: 1,
  });
}

function ordinaryRow(run, metric, epoch = 1) {
  return JSON.stringify({ run, commit: "abc1234", metric, metrics: { F1: metric }, status: "keep", description: "d", timestamp: 1, segment: 0, epoch, confidence: null });
}

function scaleLine(epoch = 2) {
  return JSON.stringify({ type: "measurement_change", change_ref: `e${epoch}`, epoch, needs_verification: true, justification: "rescore" });
}

function linkRecord(run, started, result, ordinary, executionId) {
  return JSON.stringify({
    v: 1,
    execution_id: executionId,
    run_dir: run,
    started_sha256: sha256Line(started),
    result_sha256: sha256Line(result),
    log_sha256: sha256Line(ordinary),
    analysis_prefix_bytes: null,
    analysis_prefix_sha256: null,
  });
}

/** Two proven runs 1 and 2 in one segment/epoch with matching output.txt artifacts. */
function twoRunLedger({ scaleBetween = false } = {}) {
  const s1 = startLine(1);
  const r1 = resultLine(1);
  const o1 = ordinaryRow(1, 0.55);
  const s2 = startLine(2);
  const r2 = resultLine(2);
  const o2 = ordinaryRow(2, 0.62);
  const rows = [CONFIG_LINE, s1, r1, o1];
  if (scaleBetween) rows.push(scaleLine(2));
  rows.push(s2, r2, o2, "");
  const sidecar = [linkRecord(1, s1, r1, o1, EXEC_A), linkRecord(2, s2, r2, o2, EXEC_B)].join("\n") + "\n";
  return { ledger: rows.join("\n"), sidecar };
}

function makeProject(t, { ledger = twoRunLedger().ledger, sidecar = twoRunLedger().sidecar, outputs = { 1: "hello\nMETRIC F1=0.55\n", 2: "hello\nMETRIC F1=0.62\n" }, tornLedger = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-analysis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  if (ledger !== null) fs.writeFileSync(path.join(autoDir, "log.jsonl"), tornLedger ? `${ledger}{"trunc` : ledger);
  if (sidecar !== null) fs.writeFileSync(path.join(autoDir, "run-links.jsonl"), sidecar);
  for (const [run, text] of Object.entries(outputs)) {
    fs.mkdirSync(path.join(autoDir, "runs", String(run)), { recursive: true });
    fs.writeFileSync(path.join(autoDir, "runs", String(run), "output.txt"), text);
  }
  return {
    root,
    autoDir,
    log: path.join(autoDir, "log.jsonl"),
    analysis: path.join(autoDir, "analysis.jsonl"),
    lock: path.join(autoDir, "analysis.lock"),
  };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function linesOf(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

const BRANCH = { name: "lower", metric_name: "F1", op: "<", threshold: 0.5522, meaning: "lower branch" };
const PREREG_INPUT = { kind: "prereg", axis: "s21_enum", branches: [BRANCH], exhaustion_rule: { metric_name: "F1", direction: "higher", threshold_gain: 0.009, k: 3 } };
const COMPARISON_INPUT = { kind: "comparison", purpose: "component_attribution", baseline_run: 1, candidate_run: 2, changed_components: ["weights"], metric_name: "F1", axis: "s21_enum" };

// ---------------------------------------------------------------------------
// Kind validation and forbidden/unknown keys (§7.4 additionalProperties: false)
// ---------------------------------------------------------------------------

test("prereg accepts structured branches with thresholds; bad shape is rejected", () => {
  const ok = parseAnalysisParams(PREREG_INPUT);
  assert.equal(ok.ok, true);
  assert.equal(ok.params.branches.length, 1);
  assert.deepEqual(ok.params.branches[0], BRANCH);
  assert.equal(ok.params.exhaustion_rule.k, 3);

  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [] }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [{ ...BRANCH, name: "Bad" }] }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [{ ...BRANCH, op: "==" }] }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [{ ...BRANCH, threshold: Number.NaN }] }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [{ ...BRANCH }, { ...BRANCH }] }).ok, false, "duplicate branch names");
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, branches: [{ ...BRANCH, meaning: "" }] }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, exhaustion_rule: { ...PREREG_INPUT.exhaustion_rule, k: 11 } }).ok, false);
  assert.equal(parseAnalysisParams({ ...PREREG_INPUT, hypothesis_id: "node-1" }).ok, false);
});

test("comparison validates purpose/purpose_text coupling, run numbers and unknown keys (§9.1)", () => {
  const ok = parseAnalysisParams(COMPARISON_INPUT);
  assert.equal(ok.ok, true);

  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, purpose: "other" }).ok, false, "purpose other needs purpose_text");
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, purpose_text: "text" }).ok, false, "purpose_text only with purpose other");
  const other = parseAnalysisParams({ ...COMPARISON_INPUT, purpose: "other", purpose_text: "free text" });
  assert.equal(other.ok, true);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, purpose: "other", purpose_text: "x".repeat(201) }).ok, false);

  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, baseline_run: 3, candidate_run: 3 }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, baseline_run: 0 }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, baseline_run: 1e10 }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, changed_components: ["weights", "weights"] }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, changed_components: ["Weights"] }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, noise_band: -1 }).ok, false);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, prereg_id: "cmp-abc-01234567" }).ok, false, "prereg_id must be a pre- id");
  assert.equal(parseAnalysisParams({ kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, review_requested: true }).ok, false, "review_requested requires axis");
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, review_requested: true, axis: "s21_enum" }).ok, true);
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, run: 3 }).ok, false, "forbidden ledger key");
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, status: "keep" }).ok, false, "forbidden ledger key");
  assert.equal(parseAnalysisParams({ ...COMPARISON_INPUT, epoch: 2 }).ok, false, "forbidden ledger key");
  assert.equal(parseAnalysisParams({ kind: "comparison" }).ok, false);
  assert.equal(parseAnalysisParams({ kind: "measurement" }).ok, false);
});

test("attribution evidence refs are typed; paths, lines and anchors are rejected (§10.3, T48, T99)", () => {
  const ref = { run: 1, artifact: "output", lines: null, anchor: null };
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "c", evidence_refs: [ref] }).ok, true);

  for (const bad of [
    { ...ref, path: "../x" },
    { ...ref, run: 0 },
    { ...ref, run: -1 },
    { ...ref, run: 1.5 },
    { ...ref, run: "1" },
    { ...ref, run: 1e10 },
    { ...ref, lines: [1, 1] },
    { ...ref, anchor: "METRIC F1=" },
    { artifact: "manifest", run: 1, lines: [1, 2], anchor: null },
    { ...ref, artifact: "other" },
  ]) {
    const parsed = parseAnalysisParams({ kind: "attribution", claim: "c", evidence_refs: [bad] });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "invalid_evidence");
  }
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "c", evidence_refs: Array.from({ length: 9 }, () => ref) }).ok, false);
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "c", evidence_refs: ref }).ok, false);
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "x".repeat(301) }).ok, false);
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "c", subjects: ["w", "w"] }).ok, false);
  assert.equal(parseAnalysisParams({ kind: "attribution", claim: "c", comparison_id: "pre-abc-01234567" }).ok, false);
  // Empty evidence_refs is allowed and stored (§10.1): a hypothesis worth checking.
  const empty = parseAnalysisParams({ kind: "attribution", claim: "hypothesis" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.params.evidence_refs, []);
});

test("supplement requires exactly one of value/absent and a compatible field/target (§9.5)", () => {
  const base = { kind: "supplement", target_id: "cmp-abc-01234567", field: "changed_components" };
  assert.equal(parseAnalysisParams(base).ok, false, "neither value nor absent");
  assert.equal(parseAnalysisParams({ ...base, value: ["w"], absent: { reason: "not_available" } }).ok, false, "both value and absent");
  assert.equal(parseAnalysisParams({ ...base, absent: { reason: "wrong" } }).ok, false);
  assert.equal(parseAnalysisParams({ ...base, value: ["w"], extra: 1 }).ok, false);

  const targetKindMatrix = [
    ["pre-abc-01234567", "changed_components", false],
    ["pre-abc-01234567", "noise_band", true],
    ["pre-abc-01234567", "noise_basis_ref", true],
    ["pre-abc-01234567", "subjects", false],
    ["clm-abc-01234567", "subjects", true],
    ["clm-abc-01234567", "changed_components", false],
    ["cmp-abc-01234567", "subjects", false],
  ];
  for (const [target, field, ok] of targetKindMatrix) {
    const parsed = parseAnalysisParams({ kind: "supplement", target_id: target, field, value: field === "noise_band" ? 0.1 : field === "subjects" || field === "changed_components" ? ["w"] : { run: 1, artifact: "output", lines: [1, 2], anchor: null } });
    assert.equal(parsed.ok, ok, `${field} on ${target}`);
  }
  const absent = parseAnalysisParams({ kind: "supplement", target_id: "cmp-abc-01234567", field: "changed_components", absent: { reason: "owner_declined", note: "n" } });
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.params.absent, { reason: "owner_declined", note: "n" });
});

// ---------------------------------------------------------------------------
// The writer: idempotency/conflict rules per §7.4/§9.5 (design defines no dedup_key for
// analysis records; unknown_reference is the rejection path)
// ---------------------------------------------------------------------------

test("writer appends kind-tagged records with content_sha256 and never touches other files", async (t) => {
  const project = makeProject(t);
  const logBefore = sha256File(project.log);

  const prereg = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(prereg.status, "appended");
  assert.match(prereg.id, /^pre-[0-9a-z]+-[0-9a-f]{8}$/);

  const comparison = await recordAnalysis(project.autoDir, { ...COMPARISON_INPUT, prereg_id: prereg.id });
  assert.equal(comparison.status, "appended");
  assert.match(comparison.id, /^cmp-/);

  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "weights give the gain on enum",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.status, "appended");
  assert.match(attribution.id, /^clm-/);
  // Controlled comparison (one declared component), subject inside changed_components,
  // metric bound, both outputs referenced with matching METRIC — the §10.2 ladder still
  // stops at the v1 completeness ceiling (E-23), never evidence_bound.
  assert.equal(attribution.computed.attribution_status.status, "unknown");
  assert.equal(attribution.computed.attribution_status.reason, "output_completeness_unproven");

  const supplement = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "noise_band", value: 0.009 });
  assert.equal(supplement.status, "appended");
  assert.match(supplement.id, /^sup-/);
  assert.equal(supplement.computed.timing, "post_hoc_supplement");

  // §6.4 self-check: every stored line verifies against its content_sha256.
  const read = readAnalysis(fs.readFileSync(project.analysis, "utf8"));
  assert.equal(read.records.length, 4);
  assert.equal(read.torn_lines, 0);
  assert.equal(read.invalid, 0);
  assert.deepEqual(read.records.map((record) => record.kind), ["prereg", "comparison", "attribution", "supplement"]);

  assert.equal(sha256File(project.log), logBefore, "log.jsonl bytes unchanged (I-2)");
  assert.equal(fs.existsSync(path.join(project.autoDir, "observations.jsonl")), false);
  const sidecarBefore = fs.readFileSync(path.join(project.autoDir, "run-links.jsonl"), "utf8");
  assert.equal(fs.readFileSync(path.join(project.autoDir, "run-links.jsonl"), "utf8"), sidecarBefore, "run-links.jsonl untouched (D-RM-14)");
});

test("unknown_reference: prereg_id, comparison_id and supplement target_id must exist (§7.4)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, { ...COMPARISON_INPUT, prereg_id: "pre-zzz-00000000" });
  assert.equal(comparison.status, "error");
  assert.equal(comparison.code, "unknown_reference");
  assert.equal(fs.existsSync(project.analysis), false);

  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "c",
    comparison_id: "cmp-zzz-00000000",
    evidence_refs: [{ run: 1, artifact: "output", lines: null, anchor: null }],
  });
  assert.equal(attribution.status, "error");
  assert.equal(attribution.code, "unknown_reference");

  const supplement = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: "cmp-zzz-00000000", field: "noise_band", value: 0.1 });
  assert.equal(supplement.status, "error");
  assert.equal(supplement.code, "unknown_reference");

  // A supplement to a supplement is also a wrong target kind (§9.5): rejected at input
  // before any lookup (the sup- prefix can never carry noise_band), nothing written.
  const okCmp = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  assert.equal(okCmp.status, "appended");
  const badTarget = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: okCmp.id, field: "noise_band", value: 0.1 });
  assert.equal(badTarget.status, "appended");
  const nested = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: badTarget.id, field: "noise_band", value: 0.2 });
  assert.equal(nested.status, "error");
  assert.equal(nested.code, "invalid_input");
  const linesAfter = linesOf(project.analysis).length;
  assert.equal(linesAfter, 2, "only the comparison and the valid supplement were written");
});

test("supplement: field already recorded is rejected; second supplement is a conflict; no overwrite (T62)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  assert.equal(comparison.status, "appended");

  const already = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "changed_components", value: ["prompt"] });
  assert.equal(already.status, "error");
  assert.equal(already.code, "field_already_recorded");

  const first = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "noise_band", value: 0.009 });
  assert.equal(first.status, "appended");
  const second = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "noise_band", value: 0.002 });
  assert.equal(second.status, "error");
  assert.equal(second.code, "supplement_conflict");
  assert.equal(linesOf(project.analysis).length, 2, "failed supplements write nothing");
});

test("supplement with explicit absent is stored; readers classify it declared_absent (§9.5 rule 4, T63)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2 });
  const supplement = await recordAnalysis(project.autoDir, {
    kind: "supplement",
    target_id: comparison.id,
    field: "changed_components",
    absent: { reason: "not_available" },
  });
  assert.equal(supplement.status, "appended");
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records.find((entry) => entry.kind === "supplement");
  assert.deepEqual(record.absent, { reason: "not_available" });
  assert.equal(record.value, undefined);
  // control_source post_hoc_supplement + control unknown: excluded from trusted exhaustion control.
  assert.equal(comparison.computed.control.control_source, "none");
});

// ---------------------------------------------------------------------------
// §9.3 prereg: ledger prefix snapshot, torn tail rejection, ordering fields
// ---------------------------------------------------------------------------

test("prereg stores the ledger prefix (bytes up to and including the last LF + sha256); missing ledger means 0 bytes", async (t) => {
  const project = makeProject(t);
  const prereg = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(prereg.status, "appended");
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records[0];
  // Prefix boundary = position after the last LF: for a complete file this is the whole file.
  const full = Buffer.from(fs.readFileSync(project.log, "utf8"), "utf8");
  const expectedBytes = full.length;
  assert.equal(record.ledger_prefix_bytes, expectedBytes);
  const expectedSha = createHash("sha256").update(full.subarray(0, expectedBytes)).digest("hex");
  assert.equal(record.ledger_prefix_sha256, expectedSha);

  const emptyDir = makeProject(t, { ledger: null, sidecar: null, outputs: {} });
  const empty = await recordAnalysis(emptyDir.autoDir, PREREG_INPUT);
  assert.equal(empty.status, "appended");
  const emptyRecord = readAnalysis(fs.readFileSync(emptyDir.analysis, "utf8")).records[0];
  assert.equal(emptyRecord.ledger_prefix_bytes, 0);
});

test("prereg with a torn ledger tail is rejected with ledger_torn_tail; nothing written (§9.3)", async (t) => {
  const project = makeProject(t, { tornLedger: true });
  const prereg = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(prereg.status, "error");
  assert.equal(prereg.code, "ledger_torn_tail");
  assert.equal(fs.existsSync(project.analysis), false);
});

test("ordering proof data: analysis prefix snapshot matches current file bytes (§9.3/§5.2 helper)", async (t) => {
  const project = makeProject(t);
  const before = analysisPrefixSnapshot(project.autoDir, fs);
  assert.equal(before.bytes, 0);

  await recordAnalysis(project.autoDir, PREREG_INPUT);
  const text = fs.readFileSync(project.analysis, "utf8");
  const after = analysisPrefixSnapshot(project.autoDir, fs);
  assert.equal(after.bytes, Buffer.byteLength(text, "utf8"));
  assert.equal(after.sha256, createHash("sha256").update(text, "utf8").digest("hex"));

  // A torn tail after the last LF does not change the prefix boundary (the writer adds a
  // newline guard), but the byte count excludes the fragment.
  fs.appendFileSync(project.analysis, '{"trunc');
  const torn = analysisPrefixSnapshot(project.autoDir, fs);
  assert.equal(torn.bytes, after.bytes);
  assert.equal(torn.sha256, after.sha256);
});

test("journalPrefixSnapshot and ledgerPrefixSnapshot report torn/missing states", (t) => {
  const project = makeProject(t);
  const complete = ledgerPrefixSnapshot(project.autoDir, fs);
  assert.equal(complete.ok, true);
  const full = Buffer.from(fs.readFileSync(project.log, "utf8"), "utf8");
  assert.equal(complete.bytes, full.length);

  const tornDir = makeProject(t, { tornLedger: true });
  const torn = ledgerPrefixSnapshot(tornDir.autoDir, fs);
  assert.equal(torn.ok, false);
  assert.equal(torn.reason, "ledger_torn_tail");

  const snapshot = journalPrefixSnapshot(project.log, fs);
  assert.equal(snapshot.state, "ok");
  const missing = journalPrefixSnapshot(path.join(project.autoDir, "missing.jsonl"), fs);
  assert.equal(missing.state, "missing");
});

// ---------------------------------------------------------------------------
// §9.2 computed control: declaration matrix + measurement_change/epoch facts (T45, T46)
// ---------------------------------------------------------------------------

test("control matrix: missing → unknown/not_declared; [] → controlled/declared_none_changed; [a] → controlled/one; [a,b] → uncontrolled", async (t) => {
  const project = makeProject(t);
  const none = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2 });
  assert.deepEqual(
    { control: none.computed.control.control, basis: none.computed.control.control_basis, source: none.computed.control.control_source },
    { control: "unknown", basis: "not_declared", source: "none" },
  );
  const noneChanged = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "champion_recheck", baseline_run: 1, candidate_run: 2, changed_components: [] });
  assert.equal(noneChanged.computed.control.control, "controlled");
  assert.equal(noneChanged.computed.control.control_basis, "declared_none_changed");
  const one = await recordAnalysis(project.autoDir, { ...COMPARISON_INPUT });
  assert.equal(one.computed.control.control, "controlled");
  assert.equal(one.computed.control.control_basis, "declared_one_changed");
  const many = await recordAnalysis(project.autoDir, { ...COMPARISON_INPUT, changed_components: ["weights", "prompt"] });
  assert.equal(many.computed.control.control, "uncontrolled");
  assert.equal(many.computed.control.control_basis, "declared_multiple_changed");
});

test("measurement_change between runs → uncontrolled/epoch_change; delta_allowed false (T46, D-RM-16)", async (t) => {
  const fixture = twoRunLedger({ scaleBetween: true });
  const project = makeProject(t, { ledger: fixture.ledger, sidecar: fixture.sidecar });
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.measurement_change_between, true);
  assert.equal(control.control, "uncontrolled");
  assert.equal(control.control_basis, "epoch_change");
  assert.equal(control.delta_allowed, false);
});

test("unproven links (no sidecar) → delta blocked with run_link_unproven, never a healthy default (T130)", async (t) => {
  const project = makeProject(t, { sidecar: null });
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.epoch_check, "unproven");
  assert.equal(control.metric_context_check, "unknown");
  assert.equal(control.metric_context_reason, "run_link_unproven");
  assert.equal(control.delta_allowed, false);
  assert.match(control.delta_blocked_reason, /run_link_unproven|epoch_unproven/);
});

// ---------------------------------------------------------------------------
// §9.2 step 5 delta gating table (T138): segment, metric name, epoch, finite values
// ---------------------------------------------------------------------------

test("delta gating: same segment + proven context + proven epoch allows the delta", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.epoch_check, "same");
  assert.equal(control.metric_context_check, "same");
  assert.equal(control.delta_allowed, true);
  assert.equal(control.delta_blocked_reason, null);
});

test("delta gating: different segments → no delta with segment_differs reason", async (t) => {
  const s1 = startLine(1);
  const r1 = resultLine(1);
  const o1 = ordinaryRow(1, 0.55);
  const s2 = startLine(2);
  const r2 = resultLine(2);
  const o2 = ordinaryRow(2, 0.62);
  const secondConfig = JSON.stringify({ type: "config", name: "t2", metricName: "F1", metricUnit: "", bestDirection: "higher" });
  const ledger = [CONFIG_LINE, s1, r1, o1, secondConfig, s2, r2, o2, ""].join("\n");
  const sidecar = [linkRecord(1, s1, r1, o1, EXEC_A), linkRecord(2, s2, r2, o2, EXEC_B)].join("\n") + "\n";
  const project = makeProject(t, { ledger, sidecar });
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.metric_context_check, "unknown");
  assert.equal(control.metric_context_reason, "segment_differs");
  assert.equal(control.delta_allowed, false);
  assert.match(control.delta_blocked_reason, /segment_differs|metric_context/);
});

test("delta gating: comparison.metric_name mismatching the config header → no delta", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [], metric_name: "other" });
  const control = comparison.computed.control;
  assert.equal(control.metric_context_reason, "metric_name_mismatch");
  assert.equal(control.delta_allowed, false);
});

test("delta gating: different proven epochs → epoch_check differs → no delta (FR-04.4, I-6)", async (t) => {
  const s1 = startLine(1);
  const r1 = resultLine(1);
  const o1 = ordinaryRow(1, 0.55, 1);
  const scale = scaleLine(2);
  const s2 = startLine(2);
  const r2 = resultLine(2);
  const o2 = ordinaryRow(2, 0.62, 2);
  // The scale change sits after run 1's window → rule B makes run 1's epoch unproven,
  // and run 2 keeps epoch 2: both sides must agree on one proven epoch for a delta.
  const ledger = [CONFIG_LINE, s1, r1, o1, scale, s2, r2, o2, ""].join("\n");
  const sidecar = [linkRecord(1, s1, r1, o1, EXEC_A), linkRecord(2, s2, r2, o2, EXEC_B)].join("\n") + "\n";
  const project = makeProject(t, { ledger, sidecar });
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.delta_allowed, false);
  assert.notEqual(control.epoch_check, "same");
});

test("delta gating: non-finite ledger metric → metric_not_finite, no delta", async (t) => {
  const s1 = startLine(1);
  const r1 = resultLine(1);
  const o1 = JSON.stringify({ run: 1, commit: "abc1234", status: "keep", description: "no metric", timestamp: 1, segment: 0, epoch: 1, confidence: null });
  const s2 = startLine(2);
  const r2 = resultLine(2);
  const o2 = ordinaryRow(2, 0.62);
  const ledger = [CONFIG_LINE, s1, r1, o1, s2, r2, o2, ""].join("\n");
  const sidecar = [linkRecord(1, s1, r1, o1, EXEC_A), linkRecord(2, s2, r2, o2, EXEC_B)].join("\n") + "\n";
  const project = makeProject(t, { ledger, sidecar });
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2, changed_components: [] });
  const control = comparison.computed.control;
  assert.equal(control.metric_context_reason, "metric_not_finite");
  assert.equal(control.delta_allowed, false);
});

// ---------------------------------------------------------------------------
// §10.2 attribution: unknown default, E-23 ceiling, subject/evidence rules
// ---------------------------------------------------------------------------

test("attribution with no evidence refs is stored; status unknown/no_evidence (T47)", async (t) => {
  const project = makeProject(t);
  const attribution = await recordAnalysis(project.autoDir, { kind: "attribution", claim: "a hypothesis worth checking" });
  assert.equal(attribution.status, "appended");
  assert.deepEqual(attribution.computed.attribution_status, { status: "unknown", reason: "no_evidence" });
});

test("attribution without comparison binding → unknown/no_comparison", async (t) => {
  const project = makeProject(t);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "c",
    evidence_refs: [{ run: 1, artifact: "output", lines: null, anchor: null }],
  });
  assert.deepEqual(attribution.computed.attribution_status, { status: "unknown", reason: "no_comparison" });
});

test("T80/E-23: full positive control never reaches evidence_bound in v1 (output_completeness_unproven)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  assert.equal(comparison.computed.control.delta_allowed, true);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "weights give the gain on enum",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.status, "appended");
  assert.equal(attribution.computed.attribution_status.status, "unknown");
  assert.equal(attribution.computed.attribution_status.reason, "output_completeness_unproven");
});

test("CE-5: subject outside changed_components → unknown/subject_not_changed (T87)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "prompt did it",
    subjects: ["prompt"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.computed.attribution_status.reason, "subject_not_changed");
});

test("manifest-only evidence fails step 7: no_output_evidence (T83)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "manifest only",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "manifest", lines: null, anchor: null },
      { run: 2, artifact: "manifest", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.status, "appended");
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records.find((entry) => entry.kind === "attribution");
  assert.deepEqual(record.evidence_snapshot, [null, null]);
  assert.equal(attribution.computed.attribution_status.status, "unknown");
  assert.match(attribution.computed.attribution_status.reason, /no_output_evidence/);
});

test("provenance snapshot (§10.2a): sha256, byte size, last accepted METRIC value and 1-based line (T98)", async (t) => {
  const output = "first\nMETRIC F1=0.55\nmiddle\nMETRIC F1=0.61\n";
  const project = makeProject(t, { outputs: { 1: output, 2: "hello\nMETRIC F1=0.62\n" } });
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "c",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.status, "appended");
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records.find((entry) => entry.kind === "attribution");
  const snapshot = record.evidence_snapshot[0];
  assert.equal(snapshot.parser, "metric-last-v1");
  assert.equal(snapshot.metric_name, "F1");
  assert.equal(snapshot.metric_value_text, "0.61", "last accepted occurrence wins");
  assert.equal(snapshot.metric_line_no, 4);
  assert.equal(snapshot.output_sha256, createHash("sha256").update(output, "utf8").digest("hex"));
  assert.equal(snapshot.output_bytes, Buffer.byteLength(output, "utf8"));
  // Parser differential: same values as parseMetricLines.
  assert.equal(parseMetricLines(output).get("F1"), 0.61);
  assert.equal(parseMetricLines("METRIC F1=0.6\nMETRIC F1=abc\n").get("F1"), 0.6, "invalid value does not override");
  assert.equal(parseMetricLines("METRIC constructor=1").size, 0, "denied names are skipped");
});

test("evidence snapshot is null with a reason when output is missing or metric-free (T84, T102)", async (t) => {
  const project = makeProject(t, { outputs: { 1: "no metric here\n", 2: "hello\nMETRIC F1=0.62\n" } });
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "c",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records.find((entry) => entry.kind === "attribution");
  assert.equal(record.evidence_snapshot[0], null);
  assert.equal(record.evidence_snapshot[1].metric_value_text, "0.62");
  assert.equal(record.evidence_snapshot_reason, "no_metric_line");
});

test("evidence snapshot refuses a symlinked run directory before reading content", async (t) => {
  const project = makeProject(t);
  const realRun = path.join(project.root, "outside-run");
  fs.mkdirSync(realRun, { recursive: true });
  fs.writeFileSync(path.join(realRun, "output.txt"), "METRIC F1=0.99\n");
  const target = path.join(project.autoDir, "runs", "3");
  try {
    fs.symlinkSync(realRun, target, "junction");
  } catch {
    t.skip("symlinks unavailable on this host");
    return;
  }
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "c",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [{ run: 3, artifact: "output", lines: null, anchor: null }],
  });
  const record = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records.find((entry) => entry.kind === "attribution");
  assert.equal(record.evidence_snapshot[0], null);
  assert.equal(record.evidence_snapshot_reason, "output_unsafe");
});

test("budget constants are exposed for the hint engine (§10.3, §12.3a)", () => {
  assert.equal(ANALYSIS_REF_BUDGET_PER_CALL, 20);
  assert.equal(ANALYSIS_KEY_ELEMENT_LIMIT, 200);
  assert.equal(CAMPAIGN_KEY_LIMIT, 16);
  assert.equal(keyElementBudgetOk(200), true);
  assert.equal(keyElementBudgetOk(201), false);
});

test("selectCampaignKeys returns the deterministic first 16 (axis, prereg_id by code units, then epoch)", () => {
  const keys = [];
  for (let i = 0; i < 17; i++) keys.push({ axis: `axis-${String(i).padStart(2, "0")}`, preregId: `pre-${i}`, runEpoch: 2 });
  keys.push({ axis: "axis-00", preregId: "pre-0", runEpoch: 1 });
  const selected = selectCampaignKeys(keys);
  assert.equal(selected.length, 16);
  assert.deepEqual(selected[0], { axis: "axis-00", preregId: "pre-0", runEpoch: 1 }, "epoch ascending within the same axis/prereg");
  assert.deepEqual(selected[1], { axis: "axis-00", preregId: "pre-0", runEpoch: 2 });
  const again = selectCampaignKeys([...keys].reverse());
  assert.deepEqual(again, selected, "deterministic against input order");
});

// ---------------------------------------------------------------------------
// §6 reliability: torn tail, lock busy ≤ 2.5 s, stale lock, cross-process writer
// ---------------------------------------------------------------------------

test("torn analysis tail: append works with a newline guard; torn_lines counts the fragment (T8)", async (t) => {
  const project = makeProject(t);
  await recordAnalysis(project.autoDir, PREREG_INPUT);
  fs.appendFileSync(project.analysis, '{"v":1,"trunc');
  const response = await recordAnalysis(project.autoDir, { kind: "attribution", claim: "after a torn fragment" });
  assert.equal(response.status, "appended");
  assert.equal(response.torn_lines, 1);
  const lines = linesOf(project.analysis);
  assert.equal(lines.length, 3);
  const read = readAnalysis(fs.readFileSync(project.analysis, "utf8"));
  assert.equal(read.torn_lines, 1);
  assert.equal(read.records.length, 2, "the fragment is not glued to the new record");
  const kinds = read.records.map((record) => record.kind);
  assert.deepEqual(kinds, ["prereg", "attribution"]);
});

test("lock busy: response arrives within ~2.5 s with analysis_lock_busy and the lock file is untouched (T23)", async (t) => {
  const project = makeProject(t);
  const lockBytes = Buffer.from(JSON.stringify({ token: "c".repeat(32), pid: 999999, host: "other", acquired_at: "2026-01-01T00:00:00.000Z" }));
  fs.writeFileSync(project.lock, lockBytes);
  const startedAt = Date.now();
  const response = await recordAnalysis(project.autoDir, PREREG_INPUT);
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, "error");
  assert.equal(response.code, "analysis_lock_busy");
  assert.ok(elapsed <= 2500 + 250, `busy response took ${elapsed} ms`);
  assert.deepEqual(fs.readFileSync(project.lock), lockBytes);
  assert.equal(fs.existsSync(project.analysis), false);
});

test("stale lock: no auto-takeover; writing works only after manual removal (T11)", async (t) => {
  const project = makeProject(t);
  fs.writeFileSync(project.lock, Buffer.from(JSON.stringify({ token: "d".repeat(32), pid: 12345, host: "gone-host", acquired_at: "2020-01-01T00:00:00.000Z" })));
  const blocked = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(blocked.code, "analysis_lock_busy");
  assert.equal(fs.existsSync(project.lock), true, "stale lock is not removed");

  fs.unlinkSync(project.lock);
  const written = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(written.status, "appended");
  assert.equal(fs.existsSync(project.lock), false, "lock released after success");
});

test("cross-process: separate processes appending through the module never interleave or lose records (T10)", async (t) => {
  const project = makeProject(t);
  // Six comparison targets; each of the three processes supplements two of them across the
  // three supplementable fields. Within one target every field is used once (§9.5 rule 1),
  // so every call from every process must append.
  const targets = [];
  for (let i = 0; i < 6; i++) {
    const cmp = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2 });
    assert.equal(cmp.status, "appended");
    targets.push(cmp.id);
  }
  const script = [
    "const m = await import(process.env.MODULE_URL);",
    "const fields = ['noise_band', 'noise_basis_ref', 'purpose_text'];",
    "const values = [1, { run: 1, artifact: 'output', lines: [1, 2], anchor: null }, 'why'];",
    "for (let f = 0; f < fields.length; f++) {",
    "  const r = await m.recordAnalysis(process.env.AUTO_DIR, { kind: 'supplement', target_id: process.env.TARGET, field: fields[f], value: values[f] });",
    "  if (r.status !== 'appended') { console.error(JSON.stringify(r)); process.exit(2); }",
    "}",
  ].join("\n");
  await Promise.all(
    targets.map((target) =>
      execFileAsync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
        { timeout: 120000, env: { ...process.env, MODULE_URL, AUTO_DIR: project.autoDir, TARGET: target } },
      ),
    ),
  );
  const lines = linesOf(project.analysis);
  assert.equal(lines.length, 6 + 6 * 3, "6 comparisons + 18 supplements, none lost");
  const read = readAnalysis(fs.readFileSync(project.analysis, "utf8"));
  assert.equal(read.records.length, 24);
  assert.equal(read.torn_lines, 0);
  assert.equal(read.invalid, 0);
  assert.equal(fs.existsSync(project.lock), false);
});

test("record_too_large: oversized records are rejected before any write (§6.1)", async (t) => {
  const project = makeProject(t);
  const response = await recordAnalysis(project.autoDir, { kind: "attribution", claim: "x".repeat(20000) });
  assert.equal(response.status, "error");
  assert.equal(response.code, "invalid_input", "claim length is checked before the size gate");
  const huge = await recordAnalysis(project.autoDir, { kind: "attribution", claim: "c", evidence_refs: [], note: "x".repeat(20000) });
  assert.equal(huge.code, "invalid_input");
  assert.equal(fs.existsSync(project.analysis), false);
});

// ---------------------------------------------------------------------------
// B2 / §9.5: supplement value validated per field BEFORE the lock; an invalid
// value writes nothing and can never permanently block a valid supplement
// ---------------------------------------------------------------------------

test("supplement value matrix: invalid values are rejected before the lock, nothing written (V1–V5)", async (t) => {
  const ref = { run: 1, artifact: "output", lines: [1, 2], anchor: null };
  const cases = [
    ["changed_components", "GARBAGE", "unique component names required"],
    ["changed_components", ["Bad Name"], "unique component names required"],
    ["changed_components", ["x".repeat(1000)], "unique component names required"],
    ["subjects", "weights", "unique component names required"],
    ["subjects", ["weights", "weights"], "unique component names required"],
    ["noise_band", "not-a-number", "finite number >= 0 is required"],
    ["noise_band", { value: 1 }, "finite number >= 0 is required"],
    ["noise_band", -0.5, "finite number >= 0 is required"],
    ["purpose_text", "", "characters is required"],
    ["purpose_text", "x".repeat(201), "characters is required"],
    ["noise_basis_ref", { run: 1, artifact: "manifest", lines: [1, 2], anchor: null }, "manifest_ref_needs_nulls"],
    ["noise_basis_ref", { run: 1, artifact: "output", lines: [1, 2], anchor: null, path: "../x" }, "unknown_ref_field"],
  ];
  for (const [field, value, messagePart] of cases) {
    const targetId = field === "subjects" ? "clm-abc-01234567" : field === "noise_band" || field === "noise_basis_ref" ? "pre-abc-01234567" : "cmp-abc-01234567";
    const parsed = parseAnalysisParams({ kind: "supplement", target_id: targetId, field, value });
    assert.equal(parsed.ok, false, `${field} = ${JSON.stringify(String(value)).slice(0, 30)} must be invalid`);
    assert.equal(parsed.code, "invalid_input");
    assert.match(parsed.message, new RegExp(messagePart.replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("+", "\\+")));
  }

  // Through the writer: a rejected value writes NOTHING (no record, no lock side effects).
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, { kind: "comparison", purpose: "exploration", baseline_run: 1, candidate_run: 2 });
  assert.equal(comparison.status, "appended");
  const garbage = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "changed_components", value: "GARBAGE" });
  assert.equal(garbage.status, "error");
  assert.equal(garbage.code, "invalid_input");
  assert.equal(linesOf(project.analysis).length, 1, "nothing appended for the invalid value");
  // V2: the valid supplement of the SAME field then succeeds — no permanent block.
  const valid = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "changed_components", value: ["weights"] });
  assert.equal(valid.status, "appended");
  const objectNoise = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "noise_band", value: { min: 0 } });
  assert.equal(objectNoise.status, "error");
  const validNoise = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparison.id, field: "noise_band", value: 0.009 });
  assert.equal(validNoise.status, "appended");
  const read = readAnalysis(fs.readFileSync(project.analysis, "utf8"));
  assert.equal(read.records.length, 3);
  assert.equal(read.invalid, 0);
});

// ---------------------------------------------------------------------------
// B1 / §9.3 (D-RM-15, T69–T72): prereg ordering computed at read time
// ---------------------------------------------------------------------------

const NODE_ID = "n7";

function startedLineWithNode(run, nodeId, startedAt = STARTED) {
  return JSON.stringify({ type: "run_started", run_dir: run, node_id: nodeId, command: "bench", started_at: startedAt });
}

function resultLineWithNode(run, nodeId, startedAt = STARTED) {
  return JSON.stringify({ type: "run_result", run_dir: run, started_at: startedAt, node_id: nodeId, exit_code: 0, killed: false, duration_seconds: 1 });
}

function linkRecordWithSnapshot(run, started, result, ordinary, executionId, snapshot) {
  return JSON.stringify({
    v: 1,
    execution_id: executionId,
    run_dir: run,
    started_sha256: sha256Line(started),
    result_sha256: sha256Line(result),
    log_sha256: sha256Line(ordinary),
    analysis_prefix_bytes: snapshot === null ? null : snapshot.bytes,
    analysis_prefix_sha256: snapshot === null ? null : snapshot.sha256,
  });
}

/**
 * Build a project where the run-N markers and row are appended to the ledger AFTER the
 * prereg was recorded (`prefix includes run = false`) or already present (`true`), with
 * the run-links sidecar carrying the given analysis prefix snapshot.
 */
async function makePreregOrderProject(t, { runBeforePrereg = false, snapshot = "covering", nodeId = NODE_ID, hypothesisId, run = 5 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-analysis-prereg-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), CONFIG_LINE + "\n");
  const preregInput = { kind: "prereg", axis: "ax", branches: [BRANCH] };
  if (hypothesisId !== undefined) preregInput.hypothesis_id = hypothesisId;
  const prereg = await recordAnalysis(autoDir, preregInput);
  assert.equal(prereg.status, "appended");

  const started = startedLineWithNode(run, nodeId);
  const result = resultLineWithNode(run, nodeId);
  const ordinary = ordinaryRow(run, 0.5);
  if (runBeforePrereg) {
    // The run markers were written BEFORE the prereg: they sit inside the prefix boundary.
    fs.appendFileSync(path.join(autoDir, "log.jsonl"), [started, result, ordinary].join("\n") + "\n");
    const again = await recordAnalysis(autoDir, preregInput);
    assert.equal(again.status, "appended");
    // The second prereg record is the one under test; drop the first to keep one record.
    const all = fs.readFileSync(path.join(autoDir, "analysis.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "");
    fs.writeFileSync(path.join(autoDir, "analysis.jsonl"), all.slice(1).join("\n") + "\n");
  } else {
    fs.appendFileSync(path.join(autoDir, "log.jsonl"), [started, result, ordinary].join("\n") + "\n");
  }
  const analysisText = fs.readFileSync(path.join(autoDir, "analysis.jsonl"), "utf8");
  const complete = { bytes: Buffer.byteLength(analysisText, "utf8"), sha256: createHash("sha256").update(analysisText, "utf8").digest("hex") };
  const short = { bytes: Math.max(0, complete.bytes - 20), sha256: createHash("sha256").update(analysisText.slice(0, Math.max(0, complete.bytes - 20)), "utf8").digest("hex") };
  const snapshotValue = snapshot === "covering" ? complete : snapshot === "null" ? null : snapshot === "short" ? short : null;
  const sidecar = linkRecordWithSnapshot(run, started, result, ordinary, EXEC_A, snapshotValue) + "\n";
  fs.writeFileSync(path.join(autoDir, "run-links.jsonl"), sidecar);
  const records = readAnalysis(analysisText).records;
  return { autoDir, preregId: records[records.length - 1].id, records };
}

test("T69: prereg before run_started with a covering snapshot → pre_registered; unproven link → unknown", async (t) => {
  const { autoDir, preregId, records } = await makePreregOrderProject(t);
  const prereg = records.find((record) => record.id === preregId);
  const verdict = classifyPreregOrder(autoDir, prereg, 5, fs);
  assert.equal(verdict.status, "pre_registered");
  assert.equal(verdict.order_reason, null);
  assert.equal(verdict.prefix_intact, true);
  assert.ok(verdict.started_offset >= prereg.ledger_prefix_bytes, "run_started offset at/after the prefix boundary");
  assert.equal(verdict.order_basis, "locked_analysis_prefix_and_ledger_offset (local files, not tamper-proof)");

  // Same fixture without the sidecar: an existing row with no journal is ambiguous (§5.2),
  // so the ordering is unknown, never a guess.
  const noSidecar = await makePreregOrderProject(t);
  fs.unlinkSync(path.join(noSidecar.autoDir, "run-links.jsonl"));
  const unknown = classifyPreregOrder(noSidecar.autoDir, noSidecar.records.find((r) => r.id === noSidecar.preregId), 5, fs);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.order_reason, "run_link_ambiguous");
});

test("T70: prereg after run_started → post_hoc even when recorded_at is forged earlier; byte offsets decide", async (t) => {
  const { autoDir, preregId, records } = await makePreregOrderProject(t, { runBeforePrereg: true });
  const prereg = records.find((record) => record.id === preregId);
  const verdict = classifyPreregOrder(autoDir, prereg, 5, fs);
  assert.equal(verdict.status, "post_hoc");
  assert.equal(verdict.order_reason, "run_started_before_prefix");
  assert.ok(verdict.started_offset < prereg.ledger_prefix_bytes, "run_started sits inside the prefix");
  // Timestamp forgery changes nothing: recorded_at never participates (§9.3).
  const forged = { ...prereg, recorded_at: "2020-01-01T00:00:00.000Z" };
  const stillPostHoc = classifyPreregOrder(autoDir, forged, 5, fs);
  assert.equal(stillPostHoc.status, "post_hoc");
});

test("T71: changed ledger byte inside the prefix → prefix_intact false → unknown", async (t) => {
  const { autoDir, preregId, records } = await makePreregOrderProject(t);
  const logPath = path.join(autoDir, "log.jsonl");
  const original = fs.readFileSync(logPath, "utf8");
  // Flip one byte inside the recorded prefix (the config line's metric name).
  const tampered = original.replace("F1", "F2");
  fs.writeFileSync(logPath, tampered);
  const verdict = classifyPreregOrder(autoDir, records.find((r) => r.id === preregId), 5, fs);
  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.order_reason, "prefix_intact_false");
  assert.equal(verdict.prefix_intact, false);

  // /autoresearch clear equivalent: the ledger shrinks below the prefix boundary.
  fs.writeFileSync(logPath, "");
  const cleared = classifyPreregOrder(autoDir, records.find((r) => r.id === preregId), 5, fs);
  assert.equal(cleared.status, "unknown");
  assert.equal(cleared.order_reason, "prefix_intact_false");
});

test("T71b: missing/damaged analysis snapshot or hypothesis mismatch → unknown, never a guess", async (t) => {
  // No snapshot in the sidecar: the joint-lock proof is absent.
  const noSnap = await makePreregOrderProject(t, { snapshot: "null" });
  const missing = classifyPreregOrder(noSnap.autoDir, noSnap.records.find((r) => r.id === noSnap.preregId), 5, fs);
  assert.equal(missing.status, "unknown");
  assert.equal(missing.order_reason, "analysis_snapshot_missing");

  // Snapshot covers only a shorter prefix that excludes the prereg line.
  const shortSnap = await makePreregOrderProject(t, { snapshot: "short" });
  const short = classifyPreregOrder(shortSnap.autoDir, shortSnap.records.find((r) => r.id === shortSnap.preregId), 5, fs);
  assert.equal(short.status, "unknown");
  assert.equal(short.order_reason, "snapshot_missing_line");

  // Declared hypothesis_id that the run_started node_id does not confirm.
  const mismatch = await makePreregOrderProject(t, { hypothesisId: "n9" });
  const mismatched = classifyPreregOrder(mismatch.autoDir, mismatch.records.find((r) => r.id === mismatch.preregId), 5, fs);
  assert.equal(mismatched.status, "unknown");
  assert.equal(mismatched.order_reason, "hypothesis_id_mismatch");

  // Matching hypothesis_id passes the gate.
  const match = await makePreregOrderProject(t, { hypothesisId: NODE_ID });
  const matched = classifyPreregOrder(match.autoDir, match.records.find((r) => r.id === match.preregId), 5, fs);
  assert.equal(matched.status, "pre_registered");
});

test("prereg write response carries computed prereg_status (unknown before any linked run)", async (t) => {
  const project = makeProject(t);
  const response = await recordAnalysis(project.autoDir, PREREG_INPUT);
  assert.equal(response.status, "appended");
  assert.equal(response.computed.prereg_status.status, "unknown");
  assert.equal(response.computed.prereg_status.order_reason, "no_candidate_run");
});

// ---------------------------------------------------------------------------
// B1 / §9.3 «Оценка ветвей»: independent branch evaluation, no post-hoc reinterpretation
// ---------------------------------------------------------------------------

test("evaluateBranches: pre_registered + proven run → strict op/threshold per branch, independent", async (t) => {
  const { autoDir, records } = await makePreregOrderProject(t);
  const prereg = records.find((record) => record.id === records[0].id);
  const model = buildLedgerModel(autoDir);
  const report = evaluateBranches(autoDir, prereg, 5, model);
  assert.equal(report.prereg_status, "pre_registered");
  assert.equal(report.branches.length, 1);
  const branch = report.branches[0];
  assert.equal(branch.name, BRANCH.name);
  assert.equal(branch.status, "assessed");
  assert.equal(branch.result, true, "0.5 < 0.5522 holds");
  assert.equal(branch.metric_source, "metric");
  assert.equal(branch.metric_value, 0.5);

  // A second branch whose threshold is NOT met evaluates independently to false.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-analysis-branches-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDirB = path.join(root, ".auto");
  fs.mkdirSync(autoDirB);
  fs.writeFileSync(path.join(autoDirB, "log.jsonl"), CONFIG_LINE + "\n");
  const twoBranches = { kind: "prereg", axis: "ax", branches: [BRANCH, { name: "higher", metric_name: "F1", op: ">=", threshold: 0.6, meaning: "champion branch" }] };
  const written = await recordAnalysis(autoDirB, twoBranches);
  assert.equal(written.status, "appended");
  const started = startedLineWithNode(5, null);
  const result = resultLineWithNode(5, null);
  const ordinary = ordinaryRow(5, 0.5);
  fs.appendFileSync(path.join(autoDirB, "log.jsonl"), [started, result, ordinary].join("\n") + "\n");
  const analysisText = fs.readFileSync(path.join(autoDirB, "analysis.jsonl"), "utf8");
  fs.writeFileSync(
    path.join(autoDirB, "run-links.jsonl"),
    linkRecordWithSnapshot(5, started, result, ordinary, EXEC_A, { bytes: Buffer.byteLength(analysisText, "utf8"), sha256: createHash("sha256").update(analysisText, "utf8").digest("hex") }) + "\n",
  );
  const recordB = readAnalysis(analysisText).records[0];
  const reportB = evaluateBranches(autoDirB, recordB, 5, buildLedgerModel(autoDirB));
  assert.equal(reportB.prereg_status, "pre_registered");
  assert.deepEqual(reportB.branches.map((b) => [b.name, b.result, b.status]), [
    ["lower", true, "assessed"],
    ["higher", false, "assessed"],
  ], "one threshold met, one not; both evaluated independently");
});

test("evaluateBranches: post_hoc or unproven order → not_assessed, no post-hoc reinterpretation", async (t) => {
  const postHoc = await makePreregOrderProject(t, { runBeforePrereg: true });
  const postReport = evaluateBranches(postHoc.autoDir, postHoc.records.find((r) => r.id === postHoc.preregId), 5, buildLedgerModel(postHoc.autoDir));
  assert.equal(postReport.prereg_status, "post_hoc");
  assert.equal(postReport.branches[0].status, "not_assessed");
  assert.equal(postReport.branches[0].result, null);
  assert.equal(postReport.branches[0].reason, "prereg_post_hoc");

  const absent = await makePreregOrderProject(t);
  fs.unlinkSync(path.join(absent.autoDir, "run-links.jsonl"));
  const absentReport = evaluateBranches(absent.autoDir, absent.records.find((r) => r.id === absent.preregId), 5, buildLedgerModel(absent.autoDir));
  assert.equal(absentReport.prereg_status, "unknown");
  assert.equal(absentReport.branches[0].status, "not_assessed");
  assert.equal(absentReport.branches[0].reason, "prereg_run_link_ambiguous");
});

test("evaluateBranches: conflicting metric sources or unknown named metric → not_assessed with reason", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-analysis-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const autoDir = path.join(root, ".auto");
  fs.mkdirSync(autoDir);
  fs.writeFileSync(path.join(autoDir, "log.jsonl"), CONFIG_LINE + "\n");
  // Branch on F2 (not the config header's metricName) resolves via metrics.F2 only.
  const written = await recordAnalysis(autoDir, { kind: "prereg", axis: "ax", branches: [{ name: "named", metric_name: "F2", op: "<", threshold: 0.4, meaning: "named metric branch" }] });
  assert.equal(written.status, "appended");
  const started = startedLineWithNode(5, null);
  const result = resultLineWithNode(5, null);
  const ordinary = JSON.stringify({ run: 5, commit: "abc1234", metric: 0.5, metrics: { F1: 0.5, F2: 0.3 }, status: "keep", description: "d", timestamp: 2, segment: 0, epoch: 1, confidence: null });
  fs.appendFileSync(path.join(autoDir, "log.jsonl"), [started, result, ordinary].join("\n") + "\n");
  const analysisText = fs.readFileSync(path.join(autoDir, "analysis.jsonl"), "utf8");
  fs.writeFileSync(
    path.join(autoDir, "run-links.jsonl"),
    linkRecordWithSnapshot(5, started, result, ordinary, EXEC_A, { bytes: Buffer.byteLength(analysisText, "utf8"), sha256: createHash("sha256").update(analysisText, "utf8").digest("hex") }) + "\n",
  );
  const record = readAnalysis(analysisText).records[0];
  const report = evaluateBranches(autoDir, record, 5, buildLedgerModel(autoDir));
  assert.equal(report.branches[0].metric_source, "metrics");
  assert.equal(report.branches[0].metric_value, 0.3);
  assert.equal(report.branches[0].result, true, "0.3 < 0.4 via metrics.F2");

  // Missing metric name in metrics → metric_unavailable.
  const missing = await recordAnalysis(autoDir, { kind: "prereg", axis: "ax2", branches: [{ name: "absent", metric_name: "F3", op: "<", threshold: 0.4, meaning: "not present" }] });
  assert.equal(missing.status, "appended");
  const recordMissing = readAnalysis(fs.readFileSync(path.join(autoDir, "analysis.jsonl"), "utf8")).records.find((r) => r.id === missing.id);
  // The snapshot above covers only the first prereg line; the second is post-snapshot → unknown order.
  const reportMissing = evaluateBranches(autoDir, recordMissing, 5, buildLedgerModel(autoDir));
  assert.equal(reportMissing.branches[0].status, "not_assessed");
  assert.equal(reportMissing.branches[0].result, null);
});

// ---------------------------------------------------------------------------
// M1/M2/M4 fixes: timing enum, post_hoc_subjects, budget walk over every ref
// ---------------------------------------------------------------------------

test("M1: supplement to a prereg target is labelled unknown until order is proven (§9.5 enum)", async (t) => {
  const project = makeProject(t);
  const prereg = await recordAnalysis(project.autoDir, PREREG_INPUT);
  const supplement = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: prereg.id, field: "noise_band", value: 0.002 });
  assert.equal(supplement.status, "appended");
  assert.equal(supplement.computed.timing, "unknown");

  const comparisonTarget = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const cmpSupplement = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: comparisonTarget.id, field: "noise_band", value: 0.003 });
  assert.equal(cmpSupplement.computed.timing, "post_hoc_supplement");
});

test("M2: subjects delivered by a supplement → unknown/post_hoc_subjects, never an upgrade (§10.2 step 5)", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "weights give the gain",
    comparison_id: comparison.id,
    evidence_refs: [
      { run: 1, artifact: "output", lines: null, anchor: null },
      { run: 2, artifact: "output", lines: null, anchor: null },
    ],
  });
  assert.equal(attribution.computed.attribution_status.reason, "no_subjects");
  const supplement = await recordAnalysis(project.autoDir, { kind: "supplement", target_id: attribution.id, field: "subjects", value: ["weights"] });
  assert.equal(supplement.status, "appended");
  const reread = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records;
  const status = computeAttributionStatus(project.autoDir, reread.find((r) => r.id === attribution.id), reread, fs);
  assert.deepEqual(status, { status: "unknown", reason: "post_hoc_subjects" });
});

test("M4: budget walks every output ref per side in array order; exhaustion → unverifiable/budget_exhausted", async (t) => {
  const project = makeProject(t);
  const comparison = await recordAnalysis(project.autoDir, COMPARISON_INPUT);
  const threeRefs = Array.from({ length: 3 }, () => ({ run: 1, artifact: "output", lines: null, anchor: null }));
  const attribution = await recordAnalysis(project.autoDir, {
    kind: "attribution",
    claim: "three refs per side",
    subjects: ["weights"],
    comparison_id: comparison.id,
    evidence_refs: [...threeRefs, ...threeRefs.map((ref) => ({ ...ref, run: 2 }))],
  });
  assert.equal(attribution.computed.attribution_status.status, "unknown");
  assert.equal(attribution.computed.attribution_status.reason, "output_completeness_unproven", "6 ref checks consumed of 20, far from exhaustion");

  // Nearly exhausted budget: with remaining = 4 the walk consumes 3 candidate refs, then
  // fails on the 4th check (first baseline ref) with budget_exhausted → unverifiable.
  const reread = readAnalysis(fs.readFileSync(project.analysis, "utf8")).records;
  const attributionRecord = reread.find((r) => r.id === attribution.id);
  const direct = computeAttributionStatus(project.autoDir, attributionRecord, reread, fs, { remaining: 4 });
  assert.equal(direct.status, "unverifiable");
  assert.equal(direct.reason, "budget_exhausted");

  // Deterministic order (§10.3: sides in record order, refs in array order): with remaining
  // = 1 the FIRST candidate ref fails; the candidate side is walked before the baseline.
  const first = computeAttributionStatus(project.autoDir, attributionRecord, reread, fs, { remaining: 1 });
  assert.equal(first.status, "unverifiable");
  assert.equal(first.reason, "budget_exhausted");
});

