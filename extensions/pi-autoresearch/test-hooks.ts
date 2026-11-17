/**
 * Canonical test-hook container for the autoresearch extension
 * (bd pi-autoresearch-161.3, review F-20).
 *
 * The extension creates ONE bound instance at an explicit initialization point
 * and passes it to extracted modules/adapters as a `deps` field. The `export
 * let`s in index.ts remain thin compatibility aliases for existing tests.
 * This module deliberately holds no mutable module-level state: every instance
 * is created by the factory below.
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

/** Nullable shape: the public aliases in index.ts are null before extension init. */
export interface AutoresearchTestHooks {
  closeStaleCampaign: ((dir: string) => Promise<researchState.Result<{ state: researchState.CampaignState }>>) | null;
  sendPendingResumeIfReady: ((ctx: ExtensionContext, runtime: AutoresearchRuntime) => Promise<void>) | null;
  getRuntime: ((ctx: ExtensionContext) => AutoresearchRuntime) | null;
  notifyAutoResumeLimitReachedAsync: ((ctx: ExtensionContext, reason?: string | null) => Promise<void>) | null;
  restoreExpeditionFromDisk: ((ctx: ExtensionContext) => Promise<void>) | null;
  resolveExpeditionPayload: ((workDir: string) => ExpeditionPayload | null) | null;
  stopDashboardServer: (() => void) | null;
}

/** All hooks after the single binding point; safe to hand to adapters as deps. */
export type BoundTestHooks = { [K in keyof AutoresearchTestHooks]: NonNullable<AutoresearchTestHooks[K]> };

/** Create an independent, fully bound hooks object (no shared module state). */
export function createTestHooks(bindings: BoundTestHooks): BoundTestHooks {
  return { ...bindings };
}
