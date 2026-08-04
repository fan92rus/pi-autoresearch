/**
 * PBT harness — seeded PRNG + prefix shrinking.
 *
 * Pure, no pi dependencies. Reusable in any JS/TS project.
 *
 * Usage:
 *   import { mulberry32, genInt, genPick, forAll, shrinkPrefix } from "pi-extension-testkit/pbt";
 *
 *   await forAll({
 *     seeds: 25, maxActions: 50, name: "my-property",
 *     run: async (rng, seed, maxActions) => { ... }
 *   });
 */

/** Seeded PRNG (deterministic). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] inclusive. */
export const genInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

/** Pick a random element from an array. */
export const genPick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Run a property across multiple seeds with prefix shrinking on failure. */
export async function forAll({ seeds = 25, maxActions = 50, name, run }) {
  let pbtPass = 0;
  let pbtFail = 0;
  const pbtFailures = [];

  for (let seed = 0; seed < seeds; seed++) {
    const t0 = process.env.PBT_DEBUG ? Date.now() : 0;
    try {
      await run(mulberry32(seed), seed, maxActions);
      pbtPass++;
    } catch (e) {
      pbtFail++;
      const repro = await shrinkPrefix(run, seed, maxActions);
      const fullLog = e.log ?? [];
      const log = repro?.log?.length ? repro.log : fullLog;
      pbtFailures.push({ name, seed, message: e.message, log });
      console.error(
        `  ❌ ${name} [seed=${seed}]${log.length ? `\n       actions: ${log.join(" → ")}` : ""}\n     ${e.message}`,
      );
    }
    if (process.env.PBT_DEBUG) console.error(`  [${name}] seed=${seed} done in ${Date.now() - t0}ms`);
  }

  console.log(`  PBT ${name}: ${pbtPass} pass, ${pbtFail} fail (${seeds} seeds)`);
  return { pbtPass, pbtFail, pbtFailures };
}

/** Binary-search the minimal action prefix that still fails. */
export async function shrinkPrefix(run, seed, maxActions) {
  let lo = 1;
  let hi = maxActions;
  let best = null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await run(mulberry32(seed), seed, mid);
      lo = mid + 1;
    } catch (e) {
      best = { log: e.log ?? null };
      hi = mid;
    }
  }
  return best;
}
