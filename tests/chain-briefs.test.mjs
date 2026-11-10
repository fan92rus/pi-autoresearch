/**
 * chain-briefs (openspec/changes/research-charter, task 2.x):
 * mechanical auto-approval checks for the next chain brief and the
 * chain-sourced approval.json writer.
 *
 * Every test uses its own temporary work directory. Scenarios follow the
 * frozen spec: «Автоподтверждение брифа цепочки» (2.1–2.4).
 *
 * Run: timeout 60 node --experimental-strip-types --experimental-loader
 * ./tests/redirect-loader.mjs --test tests/chain-briefs.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as CB from "../extensions/pi-autoresearch/chain-briefs.ts";
import { sha256Hex } from "../extensions/pi-autoresearch/research-state.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function withWorkDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "chain-briefs-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertRefusal(result, reason) {
  assert.equal(result.ok, false, `expected refusal ${reason}, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason, result.message);
  assert.equal(/[\r\n]/.test(result.message), false, "refusal message must be one line");
}

const RULES = (prefix) => [
  { id: `${prefix}-yes`, verdict: "confirmed", when: "effect holds on validate data" },
  { id: `${prefix}-no`, verdict: "rejected", when: "effect absent on validate data" },
  { id: `${prefix}-unk`, verdict: "inconclusive", when: "noise exceeds the effect" },
  { id: `${prefix}-wait`, verdict: "waiting_for_data", when: "validate data missing" },
];

function validBrief(overrides = {}, questionOverrides = {}) {
  return {
    schema_version: 1,
    goal: "Decide whether the cache change affects tail latency.",
    plan_source: "docs/plan.md",
    caveat_block: "Results describe this protocol only; no generalisation is claimed.",
    data_roles: { explore: ["bench-2026-01.csv"], validate: ["bench-2026-02.csv"], confirm: [] },
    questions: [
      {
        id: "Q1",
        text: "Does the cache reduce p95 latency?",
        decision_rules: RULES("Q1"),
        needs_data: "bench-2026-02.csv",
        ...questionOverrides,
      },
    ],
    process_metrics: ["number of runs"],
    stop_rules: [{ id: "S1", when: "two consecutive rejected vectors without new data" }],
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    parentBrief: validBrief(),
    parentCampaignId: "chain1-c1",
    childBriefRaw: validBrief(undefined, { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] }),
    childBriefSha256: "a".repeat(64),
    charter: {},
    chainStatus: "awaiting_child",
    campaignJournals: [
      {
        campaignId: "chain1-c1",
        closedQuestions: [{ questionId: "Q1", verdict: "confirmed", hasEvidence: true }],
      },
    ],
    approvedBriefHashes: [],
    ...overrides,
  };
}

// ─── 2.1 The passing brief ───────────────────────────────────────────────────

test("2.1 a brief passing every check is approved with the parent snapshot", () => {
  const result = CB.approveChainBrief(baseParams());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.duplicate, undefined);
  assert.equal(result.childBrief.schema_version, 1);
  assert.deepEqual(result.snapshot, {
    caveat_block: validBrief().caveat_block,
    verdicts: ["confirmed", "inconclusive", "rejected", "waiting_for_data"],
    evidence_gate: undefined,
    campaign_id: "chain1-c1",
  });
});

test("2.1 a parent with declared verdicts yields the sorted effective set in the snapshot", () => {
  const parent = validBrief({ verdicts: ["confirmed", "rejected", "inconclusive", "waiting_for_data"] });
  const result = CB.approveChainBrief(baseParams({ parentBrief: parent }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.snapshot.verdicts, ["confirmed", "inconclusive", "rejected", "waiting_for_data"]);
});

test("2.1 writeChainApproval writes approval.json with charter provenance", async () => {
  await withWorkDir(async (dir) => {
    const written = await CB.writeChainApproval(dir, "a".repeat(64), "b".repeat(64));
    assert.equal(written.ok, true, JSON.stringify(written));
    const text = await readFile(join(dir, "approval.json"), "utf8");
    const parsed = JSON.parse(text);
    assert.equal(parsed.source, "charter");
    assert.equal(parsed.charter_sha256, "b".repeat(64));
    assert.equal(parsed.brief_sha256, "a".repeat(64));
    assert.equal(parsed.confirmed, true);
  });
});

test("2.1 writeChainApproval refuses to rewrite an existing approval.json", async () => {
  await withWorkDir(async (dir) => {
    const first = await CB.writeChainApproval(dir, "a".repeat(64), "b".repeat(64));
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await CB.writeChainApproval(dir, "c".repeat(64), "d".repeat(64));
    assertRefusal(second, "approval_invalid");
  });
});

test("2.1 writeChainApproval validates hash formats", async () => {
  await withWorkDir(async (dir) => {
    assertRefusal(await CB.writeChainApproval(dir, "nothex", "b".repeat(64)), "invalid_argument");
    assertRefusal(await CB.writeChainApproval(dir, "a".repeat(64), "UPPER".padEnd(64, "0")), "invalid_argument");
  });
});

// ─── 2.2 finding_refs ────────────────────────────────────────────────────────

test("2.2 a question without finding_refs is refused with finding_missing", () => {
  const result = CB.approveChainBrief(baseParams({ childBriefRaw: validBrief() }));
  assertRefusal(result, "finding_missing");
});

test("2.2 an empty finding_refs array is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({ childBriefRaw: validBrief(undefined, { finding_refs: [] }) }),
  );
  assertRefusal(result, "finding_missing");
});

test("2.2 a reference to a campaign outside the chain is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({
      childBriefRaw: validBrief(undefined, { finding_refs: [{ campaign: "other-chain-c9", question: "Q1" }] }),
    }),
  );
  assertRefusal(result, "finding_missing");
});

test("2.2 a reference to a not-closed question is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({
      campaignJournals: [
        { campaignId: "chain1-c1", closedQuestions: [] },
      ],
      childBriefRaw: validBrief(undefined, { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] }),
    }),
  );
  assertRefusal(result, "finding_missing");
});

test("2.2 a closure without evidence is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({
      campaignJournals: [
        { campaignId: "chain1-c1", closedQuestions: [{ questionId: "Q1", verdict: "confirmed", hasEvidence: false }] },
      ],
    }),
  );
  assertRefusal(result, "finding_missing");
});

test("2.2 waiting_for_data with evidence passes as a chain finding (owner decision)", () => {
  const result = CB.approveChainBrief(
    baseParams({
      campaignJournals: [
        { campaignId: "chain1-c1", closedQuestions: [{ questionId: "Q1", verdict: "waiting_for_data", hasEvidence: true }] },
      ],
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("2.2 a malformed finding_refs entry is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({ childBriefRaw: validBrief(undefined, { finding_refs: [{ campaign: 42 }] }) }),
  );
  assertRefusal(result, "finding_missing");
});

test("2.2 a closure with a verdict outside that campaign's effective set is refused with finding_missing", () => {
  const result = CB.approveChainBrief(
    baseParams({
      campaignJournals: [
        { campaignId: "chain1-c1", closedQuestions: [{ questionId: "Q1", verdict: "arbitrary", hasEvidence: true }] },
      ],
    }),
  );
  assertRefusal(result, "finding_missing");
});

// ─── 2.3 caveat, verdicts, evidence_gate, schema ─────────────────────────────

test("2.3 a different caveat block is refused with caveat_changed", () => {
  const result = CB.approveChainBrief(
    baseParams({ childBriefRaw: validBrief({ caveat_block: "A different caveat." }) }),
  );
  assertRefusal(result, "caveat_changed");
});

test("2.3 a parent without verdicts and a child declaring the default set match", () => {
  const child = validBrief(
    { verdicts: ["confirmed", "rejected", "inconclusive", "waiting_for_data"] },
    { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] },
  );
  const result = CB.approveChainBrief(baseParams({ childBriefRaw: child }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("2.3 a parent without verdicts and a child with a different set are refused", () => {
  const child = validBrief({
    verdicts: ["test-consistent", "rejected", "inconclusive", "waiting_for_data"],
    questions: [
      {
        id: "Q1",
        text: "Does the cache reduce p95 latency?",
        decision_rules: [
          { id: "Q1-tc", verdict: "test-consistent", when: "effect holds" },
          { id: "Q1-no", verdict: "rejected", when: "effect absent" },
          { id: "Q1-unk", verdict: "inconclusive", when: "noise exceeds effect" },
          { id: "Q1-wait", verdict: "waiting_for_data", when: "data missing" },
        ],
        needs_data: null,
        finding_refs: [{ campaign: "chain1-c1", question: "Q1" }],
      },
    ],
  });
  const result = CB.approveChainBrief(baseParams({ childBriefRaw: child }));
  assertRefusal(result, "verdicts_or_gate_changed");
});

test("2.3 the same set declared in a different order matches", () => {
  const parent = validBrief({ verdicts: ["confirmed", "rejected", "inconclusive", "waiting_for_data"] });
  const child = validBrief(
    { verdicts: ["waiting_for_data", "inconclusive", "rejected", "confirmed"] },
    { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] },
  );
  const result = CB.approveChainBrief(baseParams({ parentBrief: parent, childBriefRaw: child }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("2.3 both evidence_gate fields absent match", () => {
  const result = CB.approveChainBrief(baseParams());
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("2.3 evidence_gate blocked_globs compared as a set (order-insensitive)", () => {
  const gate = { blocked_globs: ["data/a.jsonl", "data/b.jsonl"], gate_file: "gate.txt", gate_contains: "ok" };
  const parent = validBrief({ evidence_gate: gate });
  const child = validBrief(
    {
      evidence_gate: { blocked_globs: ["data/b.jsonl", "data/a.jsonl"], gate_file: "gate.txt", gate_contains: "ok" },
    },
    { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] },
  );
  const result = CB.approveChainBrief(baseParams({ parentBrief: parent, childBriefRaw: child }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("2.3 a different gate_contains is refused with verdicts_or_gate_changed", () => {
  const parent = validBrief({
    evidence_gate: { blocked_globs: ["data/a.jsonl"], gate_file: "gate.txt", gate_contains: "ok" },
  });
  const child = validBrief({
    evidence_gate: { blocked_globs: ["data/a.jsonl"], gate_file: "gate.txt", gate_contains: "READY" },
  });
  const result = CB.approveChainBrief(baseParams({ parentBrief: parent, childBriefRaw: child }));
  assertRefusal(result, "verdicts_or_gate_changed");
});

test("2.3 a child gate where the parent has none is refused", () => {
  const child = validBrief({
    evidence_gate: { blocked_globs: ["data/a.jsonl"], gate_file: "gate.txt", gate_contains: "ok" },
  });
  const result = CB.approveChainBrief(baseParams({ childBriefRaw: child }));
  assertRefusal(result, "verdicts_or_gate_changed");
});

test("2.3 a brief failing the standard schema is refused with brief_invalid", () => {
  const raw = validBrief();
  delete raw.questions;
  const result = CB.approveChainBrief(baseParams({ childBriefRaw: raw }));
  assertRefusal(result, "brief_invalid");
});

test("2.3 duplicate blocked_globs entries collapse: gate sets still match", () => {
  const parent = validBrief({
    evidence_gate: { blocked_globs: ["data/a.jsonl"], gate_file: "gate.txt", gate_contains: "ok" },
  });
  const child = validBrief(
    {
      evidence_gate: { blocked_globs: ["data/a.jsonl", "data/a.jsonl"], gate_file: "gate.txt", gate_contains: "ok" },
    },
    { finding_refs: [{ campaign: "chain1-c1", question: "Q1" }] },
  );
  const result = CB.approveChainBrief(baseParams({ parentBrief: parent, childBriefRaw: child }));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// ─── 2.4 limits, duplicates, chain status ────────────────────────────────────

test("2.4 max_campaigns=5: five campaigns pass, six are refused with limit_reached", () => {
  const ok = CB.approveChainBrief(baseParams({ charter: { max_campaigns: 5 }, campaignCount: 5, newDepth: 4 }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const over = CB.approveChainBrief(baseParams({ charter: { max_campaigns: 5 }, campaignCount: 6, newDepth: 5 }));
  assertRefusal(over, "limit_reached");
});

test("2.4 max_depth=4: depth 4 passes, depth 5 is refused with limit_reached", () => {
  const ok = CB.approveChainBrief(baseParams({ charter: { max_depth: 4 }, newDepth: 4, campaignCount: 5 }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const over = CB.approveChainBrief(baseParams({ charter: { max_depth: 4 }, newDepth: 5, campaignCount: 5 }));
  assertRefusal(over, "limit_reached");
});

test("2.4 no limits in the charter: any depth passes", () => {
  const ok = CB.approveChainBrief(baseParams({ newDepth: 40, campaignCount: 41 }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("2.4 resubmitting an approved brief returns duplicate without a new campaign", () => {
  const sha = "a".repeat(64);
  const result = CB.approveChainBrief(baseParams({ childBriefSha256: sha, approvedBriefHashes: [sha] }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.duplicate, true);
});

test("2.4 a brief sent before the parent report is refused with parent_not_reported", () => {
  const result = CB.approveChainBrief(baseParams({ chainStatus: "active" }));
  assertRefusal(result, "parent_not_reported");
});

test("2.4 every refusal name matches the frozen spec vocabulary", () => {
  const named = [
    ["parent_not_reported", { chainStatus: "active" }],
    ["caveat_changed", { childBriefRaw: validBrief({ caveat_block: "other" }) }],
    ["finding_missing", { childBriefRaw: validBrief() }],
    ["verdicts_or_gate_changed", {
      childBriefRaw: validBrief({
        evidence_gate: { blocked_globs: ["x"], gate_file: "g.txt", gate_contains: "ok" },
      }),
    }],
    ["limit_reached", { charter: { max_depth: 4 }, newDepth: 9 }],
    ["brief_invalid", { childBriefRaw: { schema_version: 1 } }],
  ];
  for (const [reason, overrides] of named) {
    assertRefusal(CB.approveChainBrief(baseParams(overrides)), reason);
  }
});

test("round2-minor per-campaign verdict set is honored positively and cross-campaign", () => {
  // (a) campaign declares verdicts including "arbitrary", closes Q1 with
  // arbitrary + evidence -> the reference passes.
  const declaring = [{
    campaignId: "chain1-c1",
    verdicts: ["confirmed", "rejected", "inconclusive", "waiting_for_data", "arbitrary"],
    closedQuestions: [{ questionId: "Q1", verdict: "arbitrary", hasEvidence: true }],
  }];
  const okResult = CB.approveChainBrief(baseParams({ campaignJournals: declaring }));
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  // (b) campaign c1 uses the default set, child cites a closure recorded under
  // "arbitrary" -> not a finding in c1's effective set.
  const defaults = [{
    campaignId: "chain1-c1",
    closedQuestions: [{ questionId: "Q1", verdict: "arbitrary", hasEvidence: true }],
  }];
  const badResult = CB.approveChainBrief(baseParams({ campaignJournals: defaults }));
  assertRefusal(badResult, "finding_missing");
});

test("round2-minor numeric campaign in finding_refs is a malformed entry", () => {
  const params = baseParams();
  params.childBriefRaw.questions[0].finding_refs = [{ campaign: 42, question: "Q1" }];
  const result = CB.approveChainBrief(params);
  assertRefusal(result, "finding_missing");
});
