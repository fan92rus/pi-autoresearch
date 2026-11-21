/**
 * /autoresearch bugfix: reserved subcommand that turns the gated bugfix_mode
 * tools on and sends a self-contained defect-hunting kickoff. Drives the real
 * extension through the fake pi harness.
 *
 * Run:
 *   timeout 120 node --experimental-strip-types --env-file=./tests/test.env \
 *     --experimental-loader ./tests/redirect-loader.mjs --test tests/bugfix-command.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi, makeCtx } from "./fake-pi.ts";
import { SUBCOMMANDS, renderAutoresearchHelp } from "../extensions/pi-autoresearch/commands.ts";
import { filterSubcommands } from "../extensions/pi-autoresearch/parallel/config-ui.ts";

const text = (r) => r?.content?.[0]?.text ?? "";
const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-command-"));

async function harness(dir) {
  const { pi, tool, command } = createFakePi({ dir, sessionId: `bugfix-command-${path.basename(dir)}`, realGit: false });
  const ctx = makeCtx(dir, `bugfix-command-${path.basename(dir)}`, pi);
  const ext = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-autoresearch", "index.ts")).href);
  ext.default(pi);
  return { pi, tool, command, ctx };
}

test("bugfix is registered in help and TAB completion", () => {
  const entry = SUBCOMMANDS.find((s) => s.name === "bugfix");
  assert.ok(entry, "bugfix is in the help list");
  assert.match(entry.description, /bugfix_mode/);
  assert.match(renderAutoresearchHelp(), /^Usage: .*\|bugfix\|/m);
  assert.ok(filterSubcommands("bug").some((s) => s.value === "bugfix"), "TAB completion offers bugfix");
  assert.equal(filterSubcommands("bugfix").at(-1).value, "bugfix");
});

test("/autoresearch bugfix turns on the gated tools and sends the proof-cycle kickoff", async () => {
  const dir = workdir();
  const h = await harness(dir);
  const before = await h.tool("bugfix_mode").execute("id", { action: "prepare", campaignId: "bad id" }, null, null, h.ctx);
  assert.match(text(before), /mode is OFF/, "gated tool is off before the command");

  await h.command("autoresearch").handler("bugfix find the null dereference", h.ctx);

  assert.ok(h.pi.notifications.some((n) => /Bugfix mode ON/.test(n.text)), "user sees that the mode is on");
  const kickoff = h.pi.sentMessages.map((m) => m.text).join("\n");
  assert.match(kickoff, /bugfix_mode\(action="prepare"/);
  assert.match(kickoff, /phase="discover"/);
  assert.match(kickoff, /phase="proof"/);
  assert.match(kickoff, /status="keep\|discard"/);
  assert.match(kickoff, /run_experiment/);
  assert.match(kickoff, /log_experiment/);
  assert.match(kickoff, /Goal: find the null dereference/);
  assert.doesNotMatch(kickoff, /\/skill:autoresearch-create|\/autoresearch on/, "no optimization setup skill in a bugfix kickoff");

  const after = await h.tool("bugfix_mode").execute("id", { action: "prepare", campaignId: "bad id" }, null, null, h.ctx);
  assert.equal(after.details?.reason, "invalid_campaign_id", "the gated tool is callable after the command");
});

test("bugfix refuses to activate when the ledger header cannot be written", async () => {
  const dir = workdir();
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "occupied\n");
  const h = await harness(dir);
  const blockedCtx = makeCtx(blocker, `bugfix-command-${path.basename(dir)}`, h.pi);

  await h.command("autoresearch").handler("bugfix write failure", blockedCtx);

  assert.ok(h.pi.notifications.some((n) => /Failed to start bugfix experiment ledger/.test(n.text)), "user sees the write failure");
  assert.equal(h.pi.sentMessages.length, 0, "no kickoff is sent after a failed start");
  const after = await h.tool("bugfix_mode").execute("id", { action: "prepare", campaignId: "bad id" }, null, null, blockedCtx);
  assert.match(text(after), /mode is OFF/, "mode is not activated on a failed header write");
});

test("bugfix works with no goal and is re-entrant while optimization mode is already on", async () => {
  const dir = workdir();
  const h = await harness(dir);
  await h.command("autoresearch").handler("bugfix", h.ctx);
  assert.ok(h.pi.sentMessages.length >= 1, "a bare bugfix still sends the kickoff");
  assert.doesNotMatch(h.pi.sentMessages.at(-1).text, /Goal:/);
  const ledgerPath = path.join(dir, ".auto", "log.jsonl");
  const headers = () => fs.readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.includes('"type":"config"')).length;
  const headersAfterFirst = headers();
  assert.equal(headersAfterFirst, 1, "first bugfix launch seeds one session header");

  const count = h.pi.sentMessages.length;
  await h.command("autoresearch").handler("bugfix second pass", h.ctx);
  assert.equal(h.pi.sentMessages.length, count + 1, "re-entry sends another kickoff instead of 'already active'");
  assert.match(h.pi.sentMessages.at(-1).text, /Goal: second pass/);
  assert.ok(!h.pi.notifications.some((n) => /already active/i.test(n.text)));
  assert.equal(headers(), headersAfterFirst, "re-entry does not reset the active session or append another header");
});
