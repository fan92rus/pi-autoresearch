/**
 * Canonical test-hook container for the autoresearch extension
 * (bd pi-autoresearch-161.3, review F-20; bd tj0.10).
 *
 * The extension creates ONE bound instance at an explicit initialization point
 * and registers it in a per-instance registry keyed by the fake/real `pi` it
 * was initialized with. The named exports in index.ts are now accessor
 * FUNCTIONS that resolve a hook through this registry: there is no module-level
 * mutable binding and no last-writer-wins when several extension instances
 * live in the same process.
 *
 * This module's only state is the immutable registry object holding WeakMaps;
 * every hooks object is created by the factory below.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExpeditionView } from "./expedition-view.ts";
import type { ExpeditionWebCampaign } from "./dashboard-web.ts";
import type * as researchState from "./research-state.ts";
import type { AutoresearchRuntime } from "./index.ts";

export type ExpeditionPayload = ExpeditionView & {
  schema_version: number;
  campaigns: ExpeditionWebCampaign[];
  chainStatus: string | null;
};

/** Nullable shape: the public accessors in index.ts are null before extension init. */
export interface AutoresearchTestHooks {
  closeStaleCampaign: ((dir: string) => Promise<researchState.Result<{ state: researchState.CampaignState }>>) | null;
  sendPendingResumeIfReady: ((ctx: ExtensionContext, runtime: AutoresearchRuntime) => Promise<void>) | null;
  getRuntime: ((ctx: ExtensionContext) => AutoresearchRuntime) | null;
  notifyAutoResumeLimitReachedAsync: ((ctx: ExtensionContext, reason?: string | null) => Promise<void>) | null;
  restoreExpeditionFromDisk: ((ctx: ExtensionContext) => Promise<void>) | null;
  resolveExpeditionPayload: ((workDir: string) => ExpeditionPayload | null) | null;
  stopDashboardServer: (() => void) | null;
  /** bd tj0.3: extension-local research policy resolvers, bound at init. */
  blockingCampaignIds: ((bases: string[]) => Promise<string[]>) | null;
  archiveFinishedCampaigns: ((workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<string[] | null>) | null;
  archiveOutcome: ((workDir: string, stateBase: string, ctx?: ExtensionContext, opts?: { includeChainCampaigns?: boolean }) => Promise<researchState.ResearchArchiveOutcome>) | null;
}

/** All hooks after the single binding point; safe to hand to adapters as deps. */
export type BoundTestHooks = { [K in keyof AutoresearchTestHooks]-?: NonNullable<AutoresearchTestHooks[K]> };

/** Create an independent, fully bound hooks object (no shared module state). */
export function createTestHooks(bindings: BoundTestHooks): BoundTestHooks {
  return { ...bindings };
}

/**
 * Test-only link from an ExtensionContext to the pi instance that owns it.
 * `fake-pi.ts` sets this in makeCtx; a symbol (rather than a property name)
 * keeps the production context surface untouched and survives `{...ctx}`.
 */
export const TEST_PI_KEY = Symbol.for("pi-autoresearch.test.pi");

export interface TestHooksRegistry {
  /** Register one instance's bound hooks. Re-binding the SAME pi refreshes it. */
  bind(pi: object, hooks: BoundTestHooks): BoundTestHooks;
  forPi(pi: object | null | undefined): BoundTestHooks | null;
  forContext(ctx: object | null | undefined): BoundTestHooks | null;
  /** Resolve the hooks for an explicit pi/ctx target, or the sole bound instance. */
  forTarget(target?: object | null): BoundTestHooks;
  registerContext(ctx: object, pi: object): void;
  count(): number;
}

export function createTestHooksRegistry(): TestHooksRegistry {
  const byPi = new WeakMap<object, BoundTestHooks>();
  const owners: object[] = [];
  const asRecord = (value: object): Record<PropertyKey, unknown> => value as Record<PropertyKey, unknown>;
  const piOf = (ctx: object | null | undefined): object | null => {
    if (!ctx) return null;
    const pi = asRecord(ctx)[TEST_PI_KEY];
    return pi && typeof pi === "object" ? pi as object : null;
  };
  return {
    bind(pi, hooks) {
      if (!byPi.has(pi)) owners.push(pi);
      byPi.set(pi, hooks);
      return hooks;
    },
    forPi(pi) {
      return pi ? byPi.get(pi) ?? null : null;
    },
    forContext(ctx) {
      const pi = piOf(ctx) ?? (owners.length === 1 ? owners[0] : null);
      return pi ? byPi.get(pi) ?? null : null;
    },
    forTarget(target) {
      const pi = target ? piOf(target) ?? target : owners.length === 1 ? owners[0] : null;
      const hooks = pi ? byPi.get(pi) : undefined;
      if (!hooks) {
        throw new Error(
          "No autoresearch test hooks for this target. Pass the pi/ctx that initialized the extension " +
          `(registered instances: ${owners.length}).`,
        );
      }
      return hooks;
    },
    registerContext(ctx, pi) {
      asRecord(ctx)[TEST_PI_KEY] = pi;
    },
    count() {
      return owners.length;
    },
  };
}

/** Module-level registry object: its bindings are per instance, never reassigned. */
export const testHookRegistry = createTestHooksRegistry();

/** Instance-bound accessor preferred by tests that create more than one fake pi. */
export function testHooksForPi(pi: object): BoundTestHooks {
  return testHookRegistry.forTarget(pi);
}
