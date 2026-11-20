/** Regression: council defaults must use models available in this session's model scope. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PARTICIPANTS, DEFAULT_CHAIR_MODEL } from "../extensions/pi-autoresearch/council.ts";

// Exact ids from the live subagent registry (verified 2026-11-21). Stale ids
// make council_convene fail with "quorum failed" before any analyst runs.
const REGISTERED = new Set([
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
  "opencode-go/hy4-flash-free",
]);

test("council analyst defaults are registered models", () => {
  assert.deepEqual(DEFAULT_PARTICIPANTS.map((p) => p.name), ["AnalystA", "AnalystB", "AnalystC"]);
  for (const participant of DEFAULT_PARTICIPANTS) {
    assert.ok(
      REGISTERED.has(participant.model),
      `${participant.name} uses unregistered model ${participant.model}`,
    );
  }
});

test("council chair default is a registered model", () => {
  assert.ok(REGISTERED.has(DEFAULT_CHAIR_MODEL), `chair uses unregistered model ${DEFAULT_CHAIR_MODEL}`);
});
