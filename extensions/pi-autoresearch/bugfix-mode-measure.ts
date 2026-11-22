/**
 * CLI measurer for bugfix-mode. Bundled with the extension; a campaign only
 * stores its own parameters and evidence under .auto/bugfix/<id>/.
 *
 * Usage: node --experimental-strip-types bugfix-mode-measure.ts --campaign <id> [--cwd <dir>]
 * Prints METRIC lines on success. A missing/unparseable suite result is a hard
 * failure (exit 2), never a score of zero.
 */

import { spawnSync } from "node:child_process";
import {
  BUGFIX_METRIC_VERSION,
  computeBugfixScore,
  evaluateCredit,
  formatMetricLines,
  parseTestSummary,
} from "./bugfix-mode.ts";
import {
  DECISIONS_FILE,
  EVIDENCE_FILE,
  readRowsStrict,
  readStoredConfig,
  scorerChanged,
} from "./bugfix-mode-store.ts";

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function run(command: string, args: string[], cwd: string, shell: boolean, timeout: number): {
  code: number; stdout: string; stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd, shell, encoding: "utf8", timeout, windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function changedLineCount(config: {
  baseRef: string;
  scopePaths: string[];
}, workDir: string): number {
  const diff = run("git", ["diff", "--numstat", config.baseRef, "--", ...config.scopePaths], workDir, false, 60_000);
  if (diff.code !== 0) {
    throw new Error(`git diff failed (exit ${diff.code}): ${(diff.stderr || diff.stdout).slice(0, 500)}`);
  }
  return diff.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").reduce((total, line) => {
    const columns = line.split("\t");
    if (columns.length < 3) return total;
    const added = columns[0] === "-" ? 0 : Number(columns[0]);
    const deleted = columns[1] === "-" ? 0 : Number(columns[1]);
    return total + (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
  }, 0);
}

export function measure(argv: string[]): { code: number; lines: string[]; error?: string } {
  const campaignId = optionValue(argv, "--campaign");
  if (campaignId === null) return { code: 2, lines: [], error: "--campaign <id> is required" };
  const workDir = optionValue(argv, "--cwd") ?? process.cwd();
  const stored = readStoredConfig(workDir, campaignId);
  if (!stored.ok) return { code: 2, lines: [], error: stored.error };

  const suite = run(stored.value.config.testCommand, [], workDir, true, 600_000);
  const summary = parseTestSummary(`${suite.stdout}\n${suite.stderr}`);
  if (!summary.ok) {
    return { code: 2, lines: [], error: `${summary.error}; suite exit ${suite.code}` };
  }
  let changedLines: number;
  try {
    changedLines = changedLineCount(stored.value.config, workDir);
  } catch (error) {
    return { code: 2, lines: [], error: (error as Error).message };
  }
  let credit;
  try {
    credit = evaluateCredit(
      readRowsStrict(workDir, campaignId, EVIDENCE_FILE),
      readRowsStrict(workDir, campaignId, DECISIONS_FILE),
    );
  } catch (error) {
    return { code: 2, lines: [], error: (error as Error).message };
  }
  const result = computeBugfixScore({
    config: stored.value.config,
    summary: summary.value,
    credit,
    changedLines,
    scorerChanged: scorerChanged(stored.value.scorerHashes, workDir),
  });
  return {
    code: 0,
    lines: [
      `METRIC metric_version=${BUGFIX_METRIC_VERSION}`,
      `METRIC suite_exit=${suite.code}`,
      ...formatMetricLines(result),
    ],
  };
}

const isCli = typeof process.argv[1] === "string" && /bugfix-mode-measure\.ts$/.test(process.argv[1]);
if (isCli) {
  const outcome = measure(process.argv.slice(2));
  for (const line of outcome.lines) console.log(line);
  if (outcome.error) {
    console.error(`bugfix_mode measure failed: ${outcome.error}`);
    process.exit(outcome.code);
  }
}
