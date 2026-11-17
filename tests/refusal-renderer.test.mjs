import test from "node:test";
import assert from "node:assert/strict";
import { renderRefusal, inspectionRefusalReason } from "../extensions/pi-autoresearch/refusal.ts";

// bd pi-autoresearch-161.4, review minor 2: pin the byte-exact wire format and
// the inspectCampaign status -> existing RefusalReason mapping directly.

test("renderRefusal preserves the legacy byte-exact format", () => {
  assert.equal(renderRefusal({ reason: "invalid_argument", message: "bad input" }), "⛔ invalid_argument: bad input");
  assert.equal(renderRefusal({ reason: null, message: "no reason" }), "⛔ null: no reason");
  assert.equal(renderRefusal({ reason: "evidence_gate_blocked", message: "é\n中文" }), "⛔ evidence_gate_blocked: é\n中文");
});

test("inspectionRefusalReason maps every inspectCampaign status without inventing reasons", () => {
  assert.equal(inspectionRefusalReason("ready"), null);
  assert.equal(inspectionRefusalReason("uninitialized"), "not_initialized");
  assert.equal(inspectionRefusalReason("state_unreadable"), "state_unreadable");
  assert.equal(inspectionRefusalReason("manual_check_required"), "manual_check_required");
  assert.equal(inspectionRefusalReason("invalid_argument"), "invalid_argument");
  assert.equal(inspectionRefusalReason("future_status"), null);
});
