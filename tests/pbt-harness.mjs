/**
 * PBT harness — local re-export from pi-extension-testkit package.
 * Provides seeded PRNG + prefix shrinking for property-based testing.
 */
export { mulberry32, genInt, genPick, forAll, shrinkPrefix } from "../packages/pi-extension-testkit/src/pbt.mjs";
