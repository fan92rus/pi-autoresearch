import test from "node:test";
import assert from "node:assert/strict";
import * as expedition from "../extensions/pi-autoresearch/expedition.ts";

const created = { type: "expedition_created", goal: "Explore", doc_sha256: "a".repeat(64), at: "0" };
const refs = [{ campaign: "c1", question: "Q1" }];
const review = { review_ref: "D:/tmp/review.md", review_sha256: "review-digest" };

const replay = (events) => {
  const result = expedition.replayExpeditionMap([created, ...events]);
  assert.equal(result.ok, true);
  return result.map;
};

test("reopen keeps the recorded basis, campaign, refs and review metadata", () => {
  const map = replay([
    { type: "direction_opened", dir: "D1", why: "Original basis", at: "1" },
    { type: "direction_activated", dir: "D1", why: "Activation basis", campaign: "c1", at: "2" },
    { type: "direction_resolved", dir: "D1", refs, at: "3" },
    { type: "direction_advisory", dir: "D1", ...review, at: "4" },
    { type: "direction_reopened", dir: "D1", reason: "Reopen for a new signal", at: "5" },
  ]);
  const d1 = map.directions.get("D1");
  assert.equal(d1.status, "open");
  assert.equal(d1.why, "Activation basis", "the transition reason must not replace the basis");
  assert.equal(d1.campaign, "c1");
  assert.deepEqual(d1.refs, refs);
  assert.equal(d1.reviewRef, review.review_ref);
  assert.equal(d1.reviewSha256, review.review_sha256);
  assert.equal(d1.reason, "Reopen for a new signal");
  assert.match(expedition.mapSliceText(map), /○ D1 — open: Activation basis \[refs c1\/Q1\]/);
});

test("pivot preserves source and existing target metadata; a new target uses the reason", () => {
  const map = replay([
    { type: "direction_opened", dir: "A", why: "Basis A", at: "1" },
    { type: "direction_opened", dir: "B", why: "Basis B", at: "2" },
    { type: "direction_activated", dir: "B", why: "Activation B", campaign: "cB", at: "3" },
    { type: "direction_parked", dir: "B", reason: "Defer B", at: "4" },
    { type: "direction_activated", dir: "A", why: "Activation A", campaign: "c1", at: "5" },
    { type: "direction_resolved", dir: "A", refs, at: "6" },
    { type: "direction_advisory", dir: "A", ...review, at: "7" },
    { type: "direction_reopened", dir: "A", reason: "Revisit A", at: "8" },
    { type: "direction_activated", dir: "A", why: "Reactivation A", campaign: "c1b", at: "9" },
    { type: "pivot", from: "A", to: "B", reason: "Pivot to B", at: "10" },
    { type: "pivot", from: "B", to: "C", reason: "Pivot to C", campaign: "cC", at: "11" },
  ]);

  const a = map.directions.get("A");
  assert.equal(a.status, "parked");
  assert.equal(a.why, "Reactivation A", "pivot must not replace the source basis with its reason");
  assert.equal(a.campaign, "c1b");
  assert.deepEqual(a.refs, refs);
  assert.equal(a.reviewRef, review.review_ref);
  assert.equal(a.reviewSha256, review.review_sha256);
  assert.equal(a.reason, "Pivot to B");

  const b = map.directions.get("B");
  assert.equal(b.status, "parked");
  assert.equal(b.why, "Activation B", "pivot must not replace an existing target basis");
  assert.equal(b.campaign, "cB");
  assert.equal(b.reason, "Pivot to C");

  const c = map.directions.get("C");
  assert.equal(c.status, "active");
  assert.equal(c.why, "Pivot to C", "a new target falls back to the pivot reason");
  assert.equal(c.campaign, "cC");

  const slice = expedition.mapSliceText(map);
  assert.match(slice, /💤 A — parked: Reactivation A \[refs c1\/Q1\]/);
  assert.match(slice, /💤 B — parked: Activation B/);
  assert.match(slice, /🔄 C — active: Pivot to C \[campaign cC\]/);
  assert.doesNotMatch(slice, /parked: Pivot to (?:B|C)/);

  const report = expedition.expeditionReportText(map, { chainId: "chain", finalStatus: "awaiting_child", campaigns: [], computedAt: "now" });
  assert.match(report, /\| A \| parked \| Reactivation A \| c1\/Q1 \|/);
  assert.match(report, /\| B \| parked \| Activation B \|/);
});

test("tool-shaped reopen and park (why and reason) keep the original basis in map, slice and report", () => {
  // research-dispatch writes both why and reason from the same tool argument.
  const map = replay([
    { type: "direction_opened", dir: "D1", why: "Original basis D1", at: "1" },
    { type: "direction_activated", dir: "D1", why: "Activation basis D1", campaign: "c1", at: "2" },
    { type: "direction_resolved", dir: "D1", refs, at: "3" },
    { type: "direction_reopened", dir: "D1", why: "Reopen for a new signal", reason: "Reopen for a new signal", at: "4" },
    { type: "direction_opened", dir: "D2", why: "Original basis D2", at: "5" },
    { type: "direction_parked", dir: "D2", why: "Park for a new signal", reason: "Park for a new signal", at: "6" },
  ]);

  const d1 = map.directions.get("D1");
  assert.equal(d1.status, "open");
  assert.equal(d1.why, "Activation basis D1", "tool reopen reason must not replace the basis");
  assert.equal(d1.reason, "Reopen for a new signal");
  assert.deepEqual(d1.refs, refs);

  const d2 = map.directions.get("D2");
  assert.equal(d2.status, "parked");
  assert.equal(d2.why, "Original basis D2", "tool park reason must not replace the basis");
  assert.equal(d2.reason, "Park for a new signal");

  const slice = expedition.mapSliceText(map);
  assert.match(slice, /○ D1 — open: Activation basis D1/);
  assert.match(slice, /💤 D2 — parked: Original basis D2/);
  assert.doesNotMatch(slice, /open: Reopen for a new signal|parked: Park for a new signal/);

  const report = expedition.expeditionReportText(map, { chainId: "chain", finalStatus: "awaiting_child", campaigns: [], computedAt: "now" });
  assert.match(report, /\| D1 \| open \| Activation basis D1 \|/);
  assert.match(report, /\| D2 \| parked \| Original basis D2 \|/);
  assert.doesNotMatch(report, /\| D[12] \| (?:open|parked) \| (?:Reopen|Park) for a new signal \|/);
});
