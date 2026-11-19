import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* bd pi-autoresearch-dif regression: npm test must NEVER spawn a real browser.
 * The loader sets PI_AUTORESEARCH_NO_BROWSER=1 before any extension import;
 * openInBrowser must honour it (no child_process spawn at all), and on Windows
 * the launcher must not be `cmd /c start` with shell:true (console window
 * flash) even when the guard is absent. */

const LOADER = path.join(import.meta.dirname, "redirect-loader.mjs");

/** Sources of every current extension module: index.ts plus extracted files (bd tj0.13). */
function extensionModules() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) found.push({ file: path.basename(abs), src: fs.readFileSync(abs, "utf8") });
    }
  };
  walk(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch"));
  return found;
}
const moduleContaining = (needle) => {
  const found = extensionModules().find((m) => m.src.includes(needle));
  assert.ok(found, `expected a current module containing ${needle}`);
  return found;
};

test("redirect-loader sets PI_AUTORESEARCH_NO_BROWSER before extension imports", () => {
  const source = fs.readFileSync(LOADER, "utf8");
  assert.match(source, /PI_AUTORESEARCH_NO_BROWSER\s*=\s*"1"/, "loader must set the guard env var");
});

test("openInBrowser honours PI_AUTORESEARCH_NO_BROWSER: no spawn at all", async () => {
  const guard = process.env.PI_AUTORESEARCH_NO_BROWSER;
  process.env.PI_AUTORESEARCH_NO_BROWSER = "1";
  const spawned = [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dif-guard-"));
  try {
    fs.writeFileSync(path.join(dir, "evidence.txt"), "x\n");
    // Import the extension module fresh with a child_process monkey-patch via
    // the loader-driven module cache: we assert indirectly — the guard branch
    // returns before spawn, so no browser process can appear. To make the
    // assertion mechanical we check the source: the guard returns early.
    // openInBrowser may live in an extracted module (bd tj0.13); find its
    // current owner across every extension source instead of pinning index.ts.
    const owner = moduleContaining("function openInBrowser");
    assert.equal(owner.file, "dashboard-tools.ts", "openInBrowser must live in the dashboard module");
    const source = owner.src;
    assert.match(
      source,
      /if\s*\(process\.env\.PI_AUTORESEARCH_NO_BROWSER\)\s*return;/,
      "openInBrowser must return before spawn when the guard is set",
    );
    assert.doesNotMatch(
      source,
      /spawn\("cmd",\s*\["\/c",\s*"start"/,
      "cmd /c start (console flash) must not be the Windows launcher",
    );
    assert.match(source, /rundll32/, "Windows launcher must be rundll32 (no shell window)");
    assert.match(source, /windowsHide:\s*true/, "spawn must hide windows");
    void spawned;
  } finally {
    if (guard === undefined) delete process.env.PI_AUTORESEARCH_NO_BROWSER;
    else process.env.PI_AUTORESEARCH_NO_BROWSER = guard;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("npm test scripts run under the guard via --env-file", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
  for (const script of ["test", "test:ext"]) {
    assert.match(
      String(pkg.scripts[script]),
      /--env-file=\.\/tests\/test\.env/,
      `${script} must load tests/test.env (PI_AUTORESEARCH_NO_BROWSER=1)`,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(import.meta.dirname, "test.env"), "utf8").trim(),
    "PI_AUTORESEARCH_NO_BROWSER=1",
    "test.env must set the browser guard",
  );
});
