/**
 * Test-process loader hook: redirects bare specifiers that block importing
 * extensions/pi-autoresearch/index.ts under plain `node --experimental-strip-types`.
 *
 * Production (pi loading the extension via jiti) never sees this hook.
 *
 * Redirected packages (4):
 *   @sinclair/typebox               → typebox-stub.mjs
 *   @earendil-works/pi-coding-agent → pi-core-stub.mjs
 *   @earendil-works/pi-ai           → pi-ai-stub.mjs
 *   @earendil-works/pi-tui          → pi-tui-stub.mjs
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));

const STUB_MAP = {
  "@sinclair/typebox": pathToFileURL(join(testsDir, "typebox-stub.mjs")).href,
  "@earendil-works/pi-coding-agent": pathToFileURL(join(testsDir, "pi-core-stub.mjs")).href,
  "@earendil-works/pi-ai": pathToFileURL(join(testsDir, "pi-ai-stub.mjs")).href,
  "@earendil-works/pi-tui": pathToFileURL(join(testsDir, "pi-tui-stub.mjs")).href,
};

export async function resolve(specifier, context, next) {
  const stubUrl = STUB_MAP[specifier];
  if (stubUrl) {
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
