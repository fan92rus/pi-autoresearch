/** File storage for bugfix campaigns. All campaign state lives under .auto/bugfix/<id>/. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_DIR } from "./paths.ts";
import {
  BUGFIX_METRIC_VERSION,
  isSafeCampaignId,
  validateBugfixConfig,
  type BugfixConfig,
  type ValidationResult,
} from "./bugfix-mode.ts";

export interface StoredConfig {
  config: BugfixConfig;
  metricVersion: string;
  scorerHashes: Record<string, string>;
  createdAt: string;
}

export const EVIDENCE_FILE = "evidence.jsonl";
export const DECISIONS_FILE = "decisions.jsonl";
export const CONFIG_FILE = "config.json";

export function campaignRoot(workDir: string): string {
  return path.join(workDir, AUTO_DIR, "bugfix");
}

export function campaignDir(workDir: string, campaignId: unknown): string | null {
  if (!isSafeCampaignId(campaignId)) return null;
  return path.join(campaignRoot(workDir), campaignId);
}

function fileHash(filePath: string): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

/** Relative paths resolve against the project; absolute paths are used as-is. */
export function hashMeasurementFiles(paths: readonly string[], workDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const filePath of paths) {
    hashes[filePath] = fileHash(path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath));
  }
  return hashes;
}

export function scorerChanged(stored: Record<string, string>, workDir: string): number {
  for (const filePath of Object.keys(stored)) {
    if (hashMeasurementFiles([filePath], workDir)[filePath] !== stored[filePath]) return 1;
  }
  return 0;
}

export function readStoredConfig(workDir: string, campaignId: unknown): ValidationResult<StoredConfig> {
  const dir = campaignDir(workDir, campaignId);
  if (dir === null) return { ok: false, error: "campaignId: expected 1-64 characters from [A-Za-z0-9._-]" };
  const filePath = path.join(dir, CONFIG_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, error: `campaign config unreadable (${filePath}): ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "campaign config: expected an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.metricVersion !== BUGFIX_METRIC_VERSION) {
    return { ok: false, error: `metric version ${String(record.metricVersion)} is not ${BUGFIX_METRIC_VERSION}` };
  }
  if (typeof record.scorerHashes !== "object" || record.scorerHashes === null || Array.isArray(record.scorerHashes)) {
    return { ok: false, error: "campaign config: scorerHashes must be an object" };
  }
  const config = validateBugfixConfig(record.config);
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      config: config.value,
      metricVersion: BUGFIX_METRIC_VERSION,
      scorerHashes: record.scorerHashes as Record<string, string>,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    },
  };
}

export function writeStoredConfig(
  workDir: string,
  campaignId: string,
  config: BugfixConfig,
  scorerHashes: Record<string, string>,
): ValidationResult<{ dir: string; filePath: string }> {
  const dir = campaignDir(workDir, campaignId);
  if (dir === null) return { ok: false, error: "invalid campaignId" };
  const filePath = path.join(dir, CONFIG_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const value: StoredConfig = {
      config,
      metricVersion: BUGFIX_METRIC_VERSION,
      scorerHashes,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    return { ok: false, error: `campaign config not written (${filePath}): ${(error as Error).message}` };
  }
  return { ok: true, value: { dir, filePath } };
}

export function appendRow(workDir: string, campaignId: string, fileName: string, row: unknown): void {
  const dir = campaignDir(workDir, campaignId);
  if (dir === null) throw new Error("invalid campaignId");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, fileName), `${JSON.stringify(row)}\n`);
}

export function readRows(workDir: string, campaignId: string, fileName: string): unknown[] {
  const dir = campaignDir(workDir, campaignId);
  if (dir === null) return [];
  try {
    return fs.readFileSync(path.join(dir, fileName), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
  } catch {
    return [];
  }
}
