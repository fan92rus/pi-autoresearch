/**
 * Campaign `analysis` configuration (openspec add-result-reflection, task 1.2).
 *
 * The `analysis` section of `.auto/config.json` declares how the result lens
 * reads a campaign's outputs (design.md decision 5: "правила «что читать» —
 * часть «как измеряем»"). It is parsed and validated once, at init_experiment
 * time, and stored (normalized, snake_case) in the `.auto/log.jsonl` config
 * header; tasks 1.3 (artifact copying) and 1.5 (inspect_results) consume the
 * persisted header afterwards.
 *
 * Section shape (snake_case, as written by the campaign author):
 * ```jsonc
 * { "analysis": {
 *     "artifacts": ["eval_output.json"],            // declared artifacts (manifest, task 1.3)
 *     "measurement_files": ["eval/scorer.py"],      // declared measurer files (hash control, task 2.7)
 *     "extractors": {                               // campaign extractors (task 1.5)
 *       "failures": { "regex": "MISMATCH\\s+gold=(.*?)\\s+pred=(.*)", "sample": 10 },
 *       "hotspots": { "timing_line": true, "top": 10 },
 *       "records":  { "json_path": "results.items", "sample": 20 } },
 *     "copy_limit_mb": 32 } }
 * ```
 *
 * Validation is explicit, never silent: an invalid section in a READABLE
 * config — including a non-compiling regex — fails init_experiment with the
 * offending config path (`analysis.extractors.failures.regex`). A missing
 * section is generic mode (current behavior, unchanged). A config file that
 * cannot be parsed AT ALL is also generic mode, but init_experiment must say
 * so with an explicit warning ("⚠️ config.json не распарсился — analysis не
 * применена"): a hard failure there would block every campaign that never
 * opted into analysis, against the repo convention "malformed config →
 * defaults" (cf. readCouncilConfig). All errors are collected, not just the
 * first.
 *
 * Regex flag contract (single source of truth, consumed by task 1.5): the
 * patterns validated here MUST be compiled at extraction time exactly as
 * validated — `new RegExp(pattern)` with NO flags. See the comment at the
 * validation site below.
 */

import * as fs from "node:fs";
import { sessionFilePath } from "./paths.ts";

/** Ceiling for copying declared artifacts into `.auto/runs/<n>/` (task 1.3). */
export const DEFAULT_COPY_LIMIT_MB = 32;

export interface RegexExtractor {
  name: string;
  /** Source of a regular expression that must compile (validated at init). */
  regex: string;
  /** Max matches kept per run. */
  sample?: number;
}

export interface TimingExtractor {
  name: string;
  timingLine: true;
  /** Top-N timing lines by normalized duration. */
  top?: number;
}

export interface JsonPathExtractor {
  name: string;
  /** Dot path into JSONL artifact records. */
  jsonPath: string;
  /** Max records kept per run. */
  sample?: number;
}

export type AnalysisExtractor = RegexExtractor | TimingExtractor | JsonPathExtractor;

export interface AnalysisConfig {
  /** Artifacts to copy into `.auto/runs/<n>/` after each run (task 1.3). */
  artifacts: string[];
  /** Measurer files whose hashes are pinned into the run manifest (task 2.7). */
  measurementFiles: string[];
  /** Campaign extractors, in declaration order. */
  extractors: AnalysisExtractor[];
  /** Copy ceiling for one artifact, in MB. */
  copyLimitMb: number;
}

export type AnalysisParseResult =
  | { status: "absent" }
  | { status: "ok"; config: AnalysisConfig }
  | { status: "invalid"; errors: string[] };

// ──────────────────────────────────────────────────────────────────────────
// Reading .auto/config.json
// ──────────────────────────────────────────────────────────────────────────

export type CampaignConfigResult =
  /** No config file — generic mode, nothing to say. */
  | { status: "missing" }
  /** File read and parsed as a JSON object. */
  | { status: "ok"; config: Record<string, unknown> }
  /**
   * File exists but cannot be read/parsed (broken JSON, non-object root,
   * I/O error). NOT an init failure (spec-owner decision on review B3):
   * analysis presence cannot be confirmed, so init proceeds in generic mode
   * and must surface the explicit warning "⚠️ config.json не распарсился —
   * analysis не применена" instead of blocking campaigns that never used
   * the section.
   */
  | { status: "unparseable"; error: string };

/**
 * Read `.auto/config.json` (the campaign config). DIRECTORY CONTRACT: the
 * caller passes ctx.cwd — the config is always read from ctx.cwd (same
 * convention as readConfig/readMaxExperiments), never from the redirected
 * workingDir: workingDir redirects where the ledger goes, not where the
 * config that declares `analysis` lives.
 *
 * Error policy (spec-owner decision on review B3):
 *  - missing file          → "missing" (generic mode, no warning);
 *  - readable file with an INVALID `analysis` section → parseAnalysisConfig
 *    reports the errors and init_experiment FAILS explicitly, never silent;
 *  - unparseable file      → "unparseable": init proceeds in generic mode with
 *    an explicit warning (repo convention "malformed config → defaults"),
 *    because a hard failure would block campaigns without an analysis section.
 */
export function readCampaignConfig(ctxCwd: string): CampaignConfigResult {
  const configPath = sessionFilePath(ctxCwd, "config");
  let raw: string;
  try {
    if (!fs.existsSync(configPath)) return { status: "missing" };
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (e) {
    return { status: "unparseable", error: `Cannot read ${configPath}: ${errorMessage(e)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "unparseable", error: `${configPath}: top-level value must be a JSON object` };
    }
    return { status: "ok", config: parsed as Record<string, unknown> };
  } catch (e) {
    return { status: "unparseable", error: `Cannot parse ${configPath} as JSON: ${errorMessage(e)}` };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Parsing + validation
// ──────────────────────────────────────────────────────────────────────────

const ANALYSIS_KEYS = ["artifacts", "measurement_files", "extractors", "copy_limit_mb"];
const EXTRACTOR_KEYS = ["regex", "json_path", "timing_line", "sample", "top"];
/** Names that would resolve to Object.prototype members via plain assignment. */
const RESERVED_EXTRACTOR_NAMES = ["__proto__", "constructor", "prototype"];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * Parse and validate the `analysis` section. Returns one of:
 *  - absent  — no section; generic mode, header unchanged;
 *  - ok      — normalized config, ready to persist;
 *  - invalid — every problem found, each message prefixed with its config path.
 */
export function parseAnalysisConfig(section: unknown): AnalysisParseResult {
  if (section === undefined) return { status: "absent" };

  if (!isPlainObject(section)) {
    return {
      status: "invalid",
      errors: [
        `analysis: expected an object with optional keys ${ANALYSIS_KEYS.join(", ")}, got ${describeType(section)}`,
      ],
    };
  }

  const errors: string[] = [];

  for (const key of Object.keys(section)) {
    if (!ANALYSIS_KEYS.includes(key)) {
      errors.push(`analysis.${key}: unknown key (allowed: ${ANALYSIS_KEYS.join(", ")})`);
    }
  }

  const artifacts = parseStringList(section["artifacts"], "analysis.artifacts", errors);

  const measurementFiles = parseStringList(
    section["measurement_files"], "analysis.measurement_files", errors,
  );

  const extractors: AnalysisExtractor[] = [];
  const rawExtractors = section["extractors"];
  if (rawExtractors !== undefined) {
    if (!isPlainObject(rawExtractors)) {
      errors.push(
        `analysis.extractors: expected an object mapping extractor names to specs, got ${describeType(rawExtractors)}`,
      );
    } else {
      for (const name of Object.keys(rawExtractors)) {
        parseExtractor(name, rawExtractors[name], extractors, errors);
      }
    }
  }

  let copyLimitMb = DEFAULT_COPY_LIMIT_MB;
  const rawLimit = section["copy_limit_mb"];
  if (rawLimit !== undefined) {
    if (typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0) {
      copyLimitMb = rawLimit;
    } else {
      errors.push(
        `analysis.copy_limit_mb: expected a positive finite number, got ${describeType(rawLimit)}`,
      );
    }
  }

  if (errors.length > 0) return { status: "invalid", errors };
  return { status: "ok", config: { artifacts, measurementFiles, extractors, copyLimitMb } };
}

/** `artifacts` / `measurement_files`: arrays of non-empty strings, verbatim (unicode-safe). */
function parseStringList(value: unknown, path: string, errors: string[]): string[] {
  const out: string[] = [];
  if (value === undefined) return out;
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of non-empty strings, got ${describeType(value)}`);
    return out;
  }
  value.forEach((item, i) => {
    if (isNonEmptyString(item)) out.push(item);
    else errors.push(`${path}[${i}]: expected a non-empty string, got ${describeType(item)}`);
  });
  return out;
}

function parseExtractor(name: string, spec: unknown, out: AnalysisExtractor[], errors: string[]): void {
  if (name.trim().length === 0) {
    errors.push("analysis.extractors: extractor names must be non-empty strings");
    return;
  }
  if (RESERVED_EXTRACTOR_NAMES.includes(name)) {
    errors.push(`analysis.extractors.${name}: extractor name is reserved`);
    return;
  }
  const specPath = `analysis.extractors.${name}`;
  if (!isPlainObject(spec)) {
    errors.push(`${specPath}: expected an object spec, got ${describeType(spec)}`);
    return;
  }

  for (const key of Object.keys(spec)) {
    if (!EXTRACTOR_KEYS.includes(key)) {
      errors.push(`${specPath}: unknown key "${key}" (allowed: ${EXTRACTOR_KEYS.join(", ")})`);
    }
  }

  const errorsBefore = errors.length;

  const rawRegex = spec["regex"];
  const rawJsonPath = spec["json_path"];
  const rawTimingLine = spec["timing_line"];
  const rawSample = spec["sample"];
  const rawTop = spec["top"];

  // Exactly one extractor kind.
  const kinds: string[] = [];
  if (rawRegex !== undefined) kinds.push("regex");
  if (rawJsonPath !== undefined) kinds.push("json_path");
  if (rawTimingLine !== undefined) kinds.push("timing_line");
  if (kinds.length === 0) {
    errors.push(`${specPath}: declare one of regex, json_path, timing_line`);
  } else if (kinds.length > 1) {
    errors.push(`${specPath}: declare exactly one of regex, json_path, timing_line (got: ${kinds.join(", ")})`);
  }

  let regex: string | undefined;
  if (rawRegex !== undefined) {
    if (!isNonEmptyString(rawRegex)) {
      errors.push(`${specPath}.regex: expected a non-empty string, got ${describeType(rawRegex)}`);
    } else {
      // The actual regex validation happens HERE, at init time: a pattern
      // that does not compile is a configuration error, never silence.
      //
      // FLAG CONTRACT for task 1.5 (single source of truth): extractors MUST
      // compile the stored pattern exactly as validated here —
      // `new RegExp(pattern)` with NO flags (no "u", no "g", nothing).
      // Validating with flags the extractor does not use (or vice versa)
      // would let init accept patterns that explode or match differently at
      // runtime — exactly the silence this module exists to prevent. If 1.5
      // ever needs flags, change THIS validation and the extractor
      // compilation in lens-extractors.ts in the same commit.
      try {
        new RegExp(rawRegex);
        regex = rawRegex;
      } catch (e) {
        errors.push(`${specPath}.regex: invalid regular expression (${errorMessage(e)})`);
      }
    }
  }

  let jsonPath: string | undefined;
  if (rawJsonPath !== undefined) {
    if (isNonEmptyString(rawJsonPath)) jsonPath = rawJsonPath;
    else errors.push(`${specPath}.json_path: expected a non-empty string, got ${describeType(rawJsonPath)}`);
  }

  if (rawTimingLine !== undefined && rawTimingLine !== true) {
    errors.push(`${specPath}.timing_line: expected true when present, got ${describeType(rawTimingLine)}`);
  }

  if (rawSample !== undefined) {
    if (rawTimingLine !== undefined) {
      errors.push(`${specPath}.sample: "sample" applies to regex/json_path extractors; use "top" for timing_line`);
    } else if (!isPositiveInt(rawSample)) {
      errors.push(`${specPath}.sample: expected an integer >= 1, got ${describeType(rawSample)}`);
    }
  }

  if (rawTop !== undefined) {
    if (rawTimingLine === undefined) {
      errors.push(`${specPath}.top: "top" applies to timing_line extractors`);
    } else if (!isPositiveInt(rawTop)) {
      errors.push(`${specPath}.top: expected an integer >= 1, got ${describeType(rawTop)}`);
    }
  }

  if (errors.length !== errorsBefore) return; // invalid spec — nothing to keep
  if (regex !== undefined) {
    const extractor: RegexExtractor = { name, regex };
    if (isPositiveInt(rawSample)) extractor.sample = rawSample;
    out.push(extractor);
  } else if (jsonPath !== undefined) {
    const extractor: JsonPathExtractor = { name, jsonPath };
    if (isPositiveInt(rawSample)) extractor.sample = rawSample;
    out.push(extractor);
  } else {
    const extractor: TimingExtractor = { name, timingLine: true };
    if (isPositiveInt(rawTop)) extractor.top = rawTop;
    out.push(extractor);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Serialization (config-header shape)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize back to the snake_case section shape stored in the config header
 * (`analysis` key of the `type: "config"` ledger entry). All four keys are
 * always present; per-extractor specs carry only their own fields. Both the
 * header writer (init_experiment) and the header comparison on re-init use
 * this function, so its key order is deterministic by construction.
 */
export function serializeAnalysisConfig(config: AnalysisConfig): Record<string, unknown> {
  const extractors: Record<string, unknown> = {};
  for (const extractor of config.extractors) {
    const spec: Record<string, unknown> = {};
    if ("regex" in extractor && typeof extractor.regex === "string") {
      spec["regex"] = extractor.regex;
      if (extractor.sample !== undefined) spec["sample"] = extractor.sample;
    } else if ("jsonPath" in extractor && typeof extractor.jsonPath === "string") {
      spec["json_path"] = extractor.jsonPath;
      if (extractor.sample !== undefined) spec["sample"] = extractor.sample;
    } else {
      spec["timing_line"] = true;
      if ("top" in extractor && extractor.top !== undefined) spec["top"] = extractor.top;
    }
    extractors[extractor.name] = spec;
  }
  return {
    artifacts: [...config.artifacts],
    measurement_files: [...config.measurementFiles],
    extractors,
    copy_limit_mb: config.copyLimitMb,
  };
}
