import test from "node:test";
import assert from "node:assert/strict";
import { createTestHooks } from "../extensions/pi-autoresearch/test-hooks.ts";

const stub = () => undefined;

/** bd pi-autoresearch-161.3: the canonical hooks object is a plain factory
 *  product, not shared mutable module state. */
test("createTestHooks binds all seven hooks and returns independent objects", () => {
  const bindings = {
    closeStaleCampaign: async () => ({ ok: true, state: {} }),
    sendPendingResumeIfReady: async () => {},
    getRuntime: () => ({}),
    notifyAutoResumeLimitReachedAsync: async () => {},
    restoreExpeditionFromDisk: async () => {},
    resolveExpeditionPayload: () => null,
    stopDashboardServer: stub,
  };
  const first = createTestHooks(bindings);
  const second = createTestHooks(bindings);
  assert.deepEqual(Object.keys(first).sort(), Object.keys(bindings).sort());
  for (const key of Object.keys(bindings)) assert.equal(typeof first[key], "function", key);
  assert.notEqual(first, second);
  first.stopDashboardServer = () => "changed";
  assert.equal(second.stopDashboardServer, stub);
  assert.notEqual(bindings.stopDashboardServer, first.stopDashboardServer);
});
