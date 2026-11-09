/**
 * Subagent activity probe (openspec subagent-wait-guard, task 2.1).
 *
 * Layer-2 guard for the autoresearch drift policy: "is an async subagent
 * running?" Port of pi-goal-x `goal-subagent-probe.ts` (commit 0449563) with
 * one owner-approved refinement: a successful reply WITHOUT a usable fleet
 * count is `unknown`, not "0 active" — the caller delivers as before.
 *
 * Talks to the pi-subagents in-process event-bus RPC (docs/TZ.md §0.3):
 * request on `subagents:rpc:v1:request` (method `status`), reply on
 * `subagents:rpc:v1:reply:<requestId>`, `data.fleet.totalActive`. The
 * pi-subagents handler is async, so the probe waits a short window; no reply
 * (pi-subagents absent) → `available: false` and callers fail open.
 */

/** Probe reply window (goal-x value, owner-confirmed). */
export const SUBAGENT_PROBE_WINDOW_MS = 250;
/** Re-check interval while a drift nudge is deferred (goal-x value). */
export const SUBAGENT_DEFER_RECHECK_MS = 30_000;
/** Max continuous deferral before the nudge is delivered anyway (goal-x value). */
export const SUBAGENT_DEFER_FUSE_MS = 600_000;

export interface SubagentProbeEvents {
	on(event: string, handler: (payload: unknown) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

/**
 * `available: false` = pi-subagents absent or the RPC did not answer in the
 * window (fail open). `available: true, active: number` = authoritative count.
 * `available: true, active: null` = RPC answered but the fleet count is
 * missing or not a number (unknown → fail open).
 */
export interface SubagentProbeResult {
	available: boolean;
	active: number | null;
}

/** True when the probe answered authoritatively AND at least one run is alive. */
export function probeShowsActive(result: SubagentProbeResult): boolean {
	return result.available === true && typeof result.active === "number" && result.active > 0;
}

export async function probeSubagentActivity(
	events: SubagentProbeEvents | undefined,
	windowMs: number = SUBAGENT_PROBE_WINDOW_MS,
): Promise<SubagentProbeResult> {
	if (!events?.on || !events?.emit) return { available: false, active: null };
	const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const replyEvent = `subagents:rpc:v1:reply:${requestId}`;
	let reply: unknown;
	let done = false;
	const off = events.on(replyEvent, (payload: unknown) => {
		reply = payload;
		done = true;
	});
	try {
		events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
		if (!done) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), windowMs);
				if (done) { clearTimeout(timer); resolve(); }
			});
		}
	} finally {
		(typeof off === "function") && off();
	}
	if (!done) return { available: false, active: null };
	const rec = reply as { success?: boolean; data?: { fleet?: { totalActive?: unknown } } } | undefined;
	if (!rec || rec.success !== true) return { available: false, active: null };
	const total = rec.data?.fleet?.totalActive;
	if (typeof total !== "number") return { available: true, active: null };
	return { available: true, active: total };
}
