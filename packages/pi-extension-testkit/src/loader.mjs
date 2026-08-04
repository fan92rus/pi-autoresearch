/**
 * Configurable redirect-loader for test processes.
 *
 * Redirects bare specifiers (that block importing extension index.ts under
 * plain `node --experimental-strip-types`) to stub files.
 *
 * Usage (in a custom loader file):
 *   import { createRedirectLoader } from "pi-extension-testkit/loader";
 *
 *   const STUB_MAP = {
 *     "@sinclair/typebox": new URL("./stubs/typebox.mjs", import.meta.url).href,
 *     "@earendil-works/pi-coding-agent": new URL("./stubs/pi-core.mjs", import.meta.url).href,
 *   };
 *   const { resolve } = createRedirectLoader(STUB_MAP);
 *   export { resolve };
 */
export function createRedirectLoader(stubMap) {
  return {
    async resolve(specifier, context, next) {
      const stubUrl = stubMap[specifier];
      if (stubUrl) {
        return { url: stubUrl, shortCircuit: true };
      }
      return next(specifier, context);
    },
  };
}
