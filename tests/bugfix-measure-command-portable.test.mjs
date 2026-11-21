/**
 * The prepared bugfix command is copied verbatim into run_experiment by an
 * agent. On Windows, JSON.stringify of a backslash path emits doubled
 * backslashes, which are routinely collapsed when that string is serialised
 * again in a tool call. Node accepts POSIX-style paths on Windows, so the
 * generated command must use forward slashes to be copy-stable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { bugfixMeasureCommand } from "../extensions/pi-autoresearch/bugfix-mode-store.ts";

const cli = "C:\\Users\\user\\.pi\\agent\\git\\github.com\\fan92rus\\pi-autoresearch\\extensions\\pi-autoresearch\\bugfix-mode-measure.ts";
const dir = "D:\\Documents\\Repositories\\pi-autoresearch";

test("prepared command uses copy-stable POSIX-style Windows paths", () => {
  const command = bugfixMeasureCommand(cli, "campaign1", dir);
  assert.match(command, /"C:\/Users\/user\/.pi\/agent\/git\/github\.com\/fan92rus\/pi-autoresearch\/extensions\/pi-autoresearch\/bugfix-mode-measure\.ts"/);
  assert.match(command, /"D:\/Documents\/Repositories\/pi-autoresearch"/);
  assert.doesNotMatch(command, /\\\\[Uu]sers/, "doubled backslashes are collapsed by tool-call serialisation");
});
