import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePi, makeCtx } from "./fake-pi.ts";

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expedition-rendercall-"));
  const { pi, tool } = createFakePi({ dir, sessionId: "expedition-rendercall", realGit: false });
  const ctx = makeCtx(dir, "expedition-rendercall", pi);
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  return { tool: tool("research"), ctx };
}

function render(tool, args) {
  // The frame contract: renderCall returns a Text component ALWAYS (never undefined).
  // This harness mirrors the real TUI consumer: pi-tui MouseRegion renders its child
  // unguarded, so undefined would throw "Cannot read properties of undefined" (review R1).
  const component = tool.renderCall(args, { fg: (_color, text) => text, bold: (text) => text }, {});
  if (component == null) throw new TypeError(`renderCall returned ${component} — must always return a Text component`);
  const output = component.render(1000);
  return Array.isArray(output) ? output.join("\n") : String(output);
}

test("research expedition activate renders direction and single-line rationale", async () => {
  const { tool } = await harness();
  const output = render(tool, { action: "expedition", subaction: "activate", dir: "Seed-ensemble", why: "three seeds\nfor honest comparison" });
  assert.match(output, /🔄 activate «Seed-ensemble»/);
  assert.match(output, /why: three seeds for honest comparison/);
  assert.equal(output.includes("\n"), false);
});

test("research expedition resolve and reject render evidence refs", async () => {
  const { tool } = await harness();
  const resolved = render(tool, { action: "expedition", subaction: "resolve", dir: "Tape", refs: [
    { campaign: "exp-a", question: "Q1" }, { campaign: "exp-b", question: "Q2" },
    { campaign: "exp-c", question: "Q3" }, { campaign: "exp-d", question: "Q4" },
  ] });
  assert.match(resolved, /✅ resolve «Tape»/);
  assert.match(resolved, /exp-a\/Q1, exp-b\/Q2, exp-c\/Q3 \+1 more/);
  const rejected = render(tool, { action: "expedition", subaction: "reject", dir: "Tape", refs: [{ campaign: "exp-a", question: "Q1" }] });
  assert.match(rejected, /✗ reject «Tape» ← exp-a\/Q1/);
});

test("research expedition pivot renders source, target, and reason", async () => {
  const { tool } = await harness();
  const output = render(tool, { action: "expedition", subaction: "pivot", from: "A", to: "B", reason: "pivot rationale" });
  assert.match(output, /🔀 pivot «A» → «B»/);
  assert.match(output, /reason: pivot rationale/);
});

test("remaining expedition actions render readable labels", async () => {
  const { tool } = await harness();
  assert.match(render(tool, { action: "expedition", subaction: "advisory", dir: "A", review_ref: "review.md#L2" }), /❓ advisory «A» ← review\.md#L2/);
  assert.match(render(tool, { action: "expedition", subaction: "park", dir: "A", reason: "later" }), /💤 park «A» └ reason: later/);
  assert.match(render(tool, { action: "expedition", subaction: "reopen", dir: "A", reason: "new data" }), /🔓 reopen «A» └ reason: new data/);
  assert.equal(render(tool, { action: "expedition", subaction: "expedition_stop" }), "🏁 expedition stop");
});

test("non-expedition research actions render the plain default header", async () => {
  const { tool } = await harness();
  assert.match(render(tool, { action: "start", expected_sha256: "abc" }), /^research /);
  assert.match(render(tool, { action: "status" }), /^research /);
});

test("missing, malformed, and incomplete args fail soft to the default header", async () => {
  const { tool } = await harness();
  assert.doesNotThrow(() => render(tool, undefined));
  assert.match(render(tool, undefined), /^research /);
  assert.match(render(tool, { action: "expedition", subaction: "activate" }), /^research /);
  assert.match(render(tool, { action: "expedition", subaction: "pivot", from: "A" }), /^research /);
  assert.match(render(tool, { action: "expedition", subaction: "unknown", dir: "A" }), /^research /);
});

test("dynamic fields are bounded and sanitized", async () => {
  const { tool } = await harness();
  const output = render(tool, { action: "expedition", subaction: "activate", dir: "D".repeat(200), why: "line\r\nbreak" });
  assert.ok(output.length <= 260, `renderer output unexpectedly long: ${output.length}`);
  assert.equal(output.includes("\r"), false);
  assert.equal(output.includes("\n"), false);
  assert.match(output, /why: line break/);
});
