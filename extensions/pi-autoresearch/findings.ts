/**
 * Findings store (openspec add-result-reflection, task 1.6; spec findings/spec.md).
 *
 * A finding is a durable, campaign-level claim about the results ("the scorer
 * penalises correct forms twice"), backed by a concrete, checkable example
 * (`evidence_ref`). Records live in `.auto/findings.jsonl`, which is
 * APPEND-ONLY: a creation is one `finding` line, every status change is one
 * `finding_transition` line appended after it, and no existing byte is ever
 * rewritten. The current state of a finding is the fold of its lines.
 *
 * Pure-ish module: the only side effects are reading/appending the findings
 * file and reading evidence files under workDir. No tool registration here —
 * index.ts wires `record_finding` / `update_finding` to these functions.
 *
 * Transition map (spec "Жизненный цикл находки"):
 *   open     → verified | revised | deferred
 *   revised  → verified | deferred
 *   deferred → open                      (reopen)
 *   verified → revised                   (counterexample appeared)
 * Any other transition is rejected with the list of allowed ones. `verified`
 * and `revised` always require an `evidence_ref`.
 *
 * evidence_ref formats (spec "Обязательность доказательной базы"):
 *   `путь:строки`  — `.auto/runs/45/output.txt:120-134` or `…:120` (1-based, inclusive)
 *   `путь#якорь`   — anchor is a literal substring that must occur in the file
 * The form is chosen by the presence of `#` (first one splits path/anchor);
 * otherwise the trailing `:N` / `:N-M` is the line range. Paths are resolved
 * against workDir and must stay inside it (symlinks included).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AUTO_DIR } from "./paths.ts";

export const FINDINGS_FILE = "findings.jsonl";

export const FINDING_THEMES = ["measurement", "behavior", "capability", "tradeoff"] as const;
export type FindingTheme = (typeof FINDING_THEMES)[number];

export const FINDING_STATUSES = ["open", "verified", "revised", "deferred"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The only legal status changes. Absent key / absent entry = no outgoing transition. */
export const FINDING_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  open: ["verified", "revised", "deferred"],
  revised: ["verified", "deferred"],
  deferred: ["open"],
  verified: ["revised"],
};

/** Statuses whose transition must carry an evidence_ref (verification or counterexample). */
const EVIDENCE_REQUIRED_STATUSES: readonly FindingStatus[] = ["verified", "revised"];

/** Shown verbatim in rejections so the agent sees a concrete, correct example. */
export const EVIDENCE_REF_EXAMPLE =
  '".auto/runs/45/output.txt:120-134" (строки) или ".auto/runs/45/output.txt#MISMATCH gold=" (якорная подстрока)';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type LineEvidenceRef = { kind: "lines"; path: string; start: number; end: number };
export type AnchorEvidenceRef = { kind: "anchor"; path: string; anchor: string };
export type EvidenceRef = LineEvidenceRef | AnchorEvidenceRef;

/** Creation line in findings.jsonl. */
export interface FindingRecord {
  type: "finding";
  id: string;
  run?: number;
  theme: FindingTheme;
  description: string;
  evidence_ref: string;
  estimated_impact?: string;
  status: "open";
  created: string;
}

/** Status-change line in findings.jsonl (appended, never edits a previous line). */
export interface FindingTransitionRecord {
  type: "finding_transition";
  id: string;
  from: FindingStatus;
  status: FindingStatus;
  evidence_ref?: string;
  note?: string;
  updated: string;
}

/** Current view of one finding after folding its lines. */
export interface FindingView {
  id: string;
  run?: number;
  theme: FindingTheme;
  description: string;
  evidence_ref: string;
  estimated_impact?: string;
  status: FindingStatus;
  created: string;
  /** Timestamp of the latest status change (absent while still open). */
  updated?: string;
}

export interface FindingsState {
  findings: Map<string, FindingView>;
  /** Next free id ("f<n>"), above every id ever written. */
  nextId: string;
}

export interface RecordFindingInput {
  theme: unknown;
  description: unknown;
  evidence_ref?: unknown;
  estimated_impact?: unknown;
  run?: unknown;
}

export interface UpdateFindingInput {
  id: unknown;
  status: unknown;
  evidence_ref?: unknown;
  note?: unknown;
}

export type FindingResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ──────────────────────────────────────────────────────────────────────────
// Paths and small helpers
// ──────────────────────────────────────────────────────────────────────────

export function findingsFilePath(workDir: string): string {
  return path.join(workDir, AUTO_DIR, FINDINGS_FILE);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

// ──────────────────────────────────────────────────────────────────────────
// evidence_ref: parsing
// ──────────────────────────────────────────────────────────────────────────

const LINE_SUFFIX = /^(.+):(\d+)(?:-(\d+))?$/;

/**
 * Syntactic parse only (no filesystem access). Rejections name the expected
 * formats and the example, so the agent can fix the call in one step.
 */
export function parseEvidenceRef(raw: string): FindingResult<EvidenceRef> {
  const ref = raw.trim();
  const hash = ref.indexOf("#");
  if (hash !== -1) {
    const refPath = ref.slice(0, hash).trim();
    const anchor = ref.slice(hash + 1);
    if (refPath.length === 0) {
      return { ok: false, errors: [`evidence_ref "${raw}": путь до "#" пуст; пример: ${EVIDENCE_REF_EXAMPLE}`] };
    }
    if (anchor.length === 0) {
      return { ok: false, errors: [`evidence_ref "${raw}": якорь после "#" пуст; пример: ${EVIDENCE_REF_EXAMPLE}`] };
    }
    return { ok: true, value: { kind: "anchor", path: refPath, anchor } };
  }
  const match = LINE_SUFFIX.exec(ref);
  if (!match) {
    return {
      ok: false,
      errors: [`evidence_ref "${raw}": ожидается путь:строки или путь#якорь; пример: ${EVIDENCE_REF_EXAMPLE}`],
    };
  }
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (start < 1 || end < start) {
    return {
      ok: false,
      errors: [`evidence_ref "${raw}": диапазон строк должен быть 1-based и start ≤ end (получено ${start}-${end})`],
    };
  }
  return { ok: true, value: { kind: "lines", path: match[1].trim(), start, end } };
}

// ──────────────────────────────────────────────────────────────────────────
// evidence_ref: validation against the workDir
// ──────────────────────────────────────────────────────────────────────────

/** Number of lines in a text: a trailing newline does not start a new line. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\r?\n$/, "").split("\n").length;
}

/**
 * Full evidence check: format, path inside workDir, file exists and is a
 * regular file, line range inside the file / anchor present in the file.
 * Returns the parsed reference on success.
 */
export function checkEvidenceRef(workDir: string, raw: string): FindingResult<EvidenceRef> {
  const parsed = parseEvidenceRef(raw);
  if (!parsed.ok) return parsed;
  const ref = parsed.value;

  const root = path.resolve(workDir);
  const abs = path.resolve(root, ref.path);
  if (!isInside(root, abs)) {
    return { ok: false, errors: [`evidence_ref "${raw}": путь "${ref.path}" вне workDir (${root})`] };
  }

  let realFile: string;
  let realRoot: string;
  try {
    realFile = fs.realpathSync(abs);
  } catch {
    return { ok: false, errors: [`evidence_ref "${raw}": файл не найден: ${ref.path}`] };
  }
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, errors: [`evidence_ref "${raw}": workDir недоступен: ${root}`] };
  }
  if (!isInside(realRoot, realFile)) {
    return { ok: false, errors: [`evidence_ref "${raw}": путь "${ref.path}" ведёт вне workDir (symlink)`] };
  }

  let content: string;
  try {
    if (!fs.statSync(realFile).isFile()) {
      return { ok: false, errors: [`evidence_ref "${raw}": путь не является файлом: ${ref.path}`] };
    }
    content = fs.readFileSync(realFile, "utf-8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`evidence_ref "${raw}": файл не читается (${reason})`] };
  }

  if (ref.kind === "lines") {
    const total = countLines(content);
    if (ref.end > total) {
      return {
        ok: false,
        errors: [
          `evidence_ref "${raw}": строки ${ref.start}-${ref.end} выходят за пределы файла (в ${ref.path} ${total} строк)`,
        ],
      };
    }
    return { ok: true, value: ref };
  }

  if (!content.includes(ref.anchor)) {
    return {
      ok: false,
      errors: [`evidence_ref "${raw}": якорь "${ref.anchor}" не найден в ${ref.path} (подстрока должна встречаться буквально)`],
    };
  }
  return { ok: true, value: ref };
}

// ──────────────────────────────────────────────────────────────────────────
// Ledger: reading and folding
// ──────────────────────────────────────────────────────────────────────────

function isFindingStatus(v: unknown): v is FindingStatus {
  return typeof v === "string" && (FINDING_STATUSES as readonly string[]).includes(v);
}

function isFindingTheme(v: unknown): v is FindingTheme {
  return typeof v === "string" && (FINDING_THEMES as readonly string[]).includes(v);
}

function findingIdNumber(id: string): number | null {
  const m = /^f(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * Fold findings.jsonl into the current state. Any malformed line, unknown
 * type, duplicate id, transition on an unknown id, or transition that does
 * not start from the current status makes the whole store invalid: writes are
 * refused with the list of problems instead of building on a corrupted base.
 * A missing file is an empty, valid store.
 */
export function loadFindings(workDir: string): FindingResult<FindingsState> {
  const file = findingsFilePath(workDir);
  const findings = new Map<string, FindingView>();
  const errors: string[] = [];
  let maxId = 0;

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: { findings, nextId: "f1" } };
    }
    return { ok: false, errors: [`${file}: не читается (${e instanceof Error ? e.message : String(e)})`] };
  }

  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    const where = `${FINDINGS_FILE} строка ${index + 1}`;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      errors.push(`${where}: не JSON`);
      return;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      errors.push(`${where}: ожидался JSON-объект`);
      return;
    }
    const r = rec as Record<string, unknown>;
    if (typeof r["id"] !== "string") {
      errors.push(`${where}: поле id отсутствует или не строка`);
      return;
    }
    const id = r["id"];

    if (r["type"] === "finding") {
      if (findings.has(id)) {
        errors.push(`${where}: id ${id} уже создан ранее`);
        return;
      }
      const num = findingIdNumber(id);
      if (num === null) {
        errors.push(`${where}: id "${id}" не соответствует формату f<n>`);
        return;
      }
      if (!isFindingTheme(r["theme"])) {
        errors.push(`${where}: неизвестная тема ${describeType(r["theme"])} (ожидается одна из ${FINDING_THEMES.join(", ")})`);
        return;
      }
      if (r["status"] !== "open") {
        errors.push(`${where}: создание находки должно иметь статус open`);
        return;
      }
      if (!isNonEmptyString(r["description"]) || !isNonEmptyString(r["evidence_ref"]) || !isNonEmptyString(r["created"])) {
        errors.push(`${where}: в записи отсутствуют description, evidence_ref или created`);
        return;
      }
      const view: FindingView = {
        id,
        theme: r["theme"],
        description: r["description"],
        evidence_ref: r["evidence_ref"],
        status: "open",
        created: r["created"],
      };
      if (typeof r["run"] === "number") view.run = r["run"];
      if (typeof r["estimated_impact"] === "string") view.estimated_impact = r["estimated_impact"];
      findings.set(id, view);
      maxId = Math.max(maxId, num);
      return;
    }

    if (r["type"] === "finding_transition") {
      const current = findings.get(id);
      if (!current) {
        errors.push(`${where}: переход для неизвестной находки ${id}`);
        return;
      }
      if (r["from"] !== current.status) {
        errors.push(`${where}: переход ${id} начинается из ${String(r["from"])}, а текущий статус ${current.status}`);
        return;
      }
      if (!isFindingStatus(r["status"]) || !FINDING_TRANSITIONS[current.status].includes(r["status"])) {
        errors.push(`${where}: запрещённый переход ${current.status} → ${String(r["status"])} для ${id}`);
        return;
      }
      if (!isNonEmptyString(r["updated"])) {
        errors.push(`${where}: в переходе отсутствует updated`);
        return;
      }
      current.status = r["status"];
      current.updated = r["updated"];
      return;
    }

    errors.push(`${where}: неизвестный type ${String(r["type"])}`);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { findings, nextId: `f${maxId + 1}` } };
}

// ──────────────────────────────────────────────────────────────────────────
// Append-only writes
// ──────────────────────────────────────────────────────────────────────────

function appendLine(workDir: string, record: FindingRecord | FindingTransitionRecord): void {
  const file = findingsFilePath(workDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

function storeErrors(loaded: { ok: false; errors: string[] }): FindingResult<never> {
  return {
    ok: false,
    errors: [`${FINDINGS_FILE} не читается как хранилище находок — запись отклонена:`, ...loaded.errors],
  };
}

/**
 * Create a finding (status open) and append it. Rejections collect every
 * problem at once. `now` is injectable for deterministic tests.
 */
export function recordFinding(
  workDir: string,
  input: RecordFindingInput,
  now: Date = new Date(),
): FindingResult<FindingRecord> {
  const errors: string[] = [];

  let theme: FindingTheme | null = null;
  if (!isFindingTheme(input.theme)) {
    errors.push(
      `theme: ${JSON.stringify(input.theme)} не входит в допустимые темы {${FINDING_THEMES.join(", ")}}`,
    );
  } else {
    theme = input.theme;
  }

  let description: string | null = null;
  if (!isNonEmptyString(input.description)) {
    errors.push("description: обязательное непустое описание находки");
  } else {
    description = input.description.trim();
  }

  let evidenceRef: string | null = null;
  if (input.evidence_ref === undefined || input.evidence_ref === null || !isNonEmptyString(input.evidence_ref)) {
    errors.push(
      `evidence_ref: отсутствует или пуст — находка без конкретного проверяемого примера отклонена. ` +
        `Укажите случай из результатов, например ${EVIDENCE_REF_EXAMPLE}`,
    );
  } else {
    const checked = checkEvidenceRef(workDir, input.evidence_ref.trim());
    if (checked.ok) evidenceRef = input.evidence_ref.trim();
    else errors.push(...checked.errors);
  }

  let estimatedImpact: string | undefined;
  if (input.estimated_impact !== undefined) {
    if (typeof input.estimated_impact !== "string") {
      errors.push(`estimated_impact: ожидается строка, получено ${describeType(input.estimated_impact)}`);
    } else if (input.estimated_impact.trim().length > 0) {
      estimatedImpact = input.estimated_impact.trim();
    }
  }

  let run: number | undefined;
  if (input.run !== undefined) {
    if (typeof input.run === "number" && Number.isInteger(input.run) && input.run >= 1) {
      run = input.run;
    } else {
      errors.push(`run: ожидается целое число >= 1, получено ${describeType(input.run)}`);
    }
  }

  const loaded = loadFindings(workDir);
  if (!loaded.ok) return storeErrors(loaded);

  if (errors.length > 0 || theme === null || description === null || evidenceRef === null) {
    return { ok: false, errors };
  }

  const record: FindingRecord = {
    type: "finding",
    id: loaded.value.nextId,
    ...(run !== undefined ? { run } : {}),
    theme,
    description,
    evidence_ref: evidenceRef,
    ...(estimatedImpact !== undefined ? { estimated_impact: estimatedImpact } : {}),
    status: "open",
    created: now.toISOString(),
  };
  appendLine(workDir, record);
  return { ok: true, value: record };
}

/**
 * Change a finding's status by appending a `finding_transition` line.
 * Enforces FINDING_TRANSITIONS; `verified`/`revised` require evidence_ref,
 * and any evidence_ref given (for any target) must pass checkEvidenceRef.
 */
export function updateFinding(
  workDir: string,
  input: UpdateFindingInput,
  now: Date = new Date(),
): FindingResult<FindingTransitionRecord> {
  const errors: string[] = [];

  const loaded = loadFindings(workDir);
  if (!loaded.ok) return storeErrors(loaded);

  let finding: FindingView | undefined;
  if (!isNonEmptyString(input.id)) {
    errors.push("id: обязательный идентификатор находки (например f1)");
  } else {
    finding = loaded.value.findings.get(input.id.trim());
    if (!finding) errors.push(`id: находка ${input.id.trim()} не найдена в ${FINDINGS_FILE}`);
  }

  let target: FindingStatus | null = null;
  if (!isFindingStatus(input.status)) {
    errors.push(`status: ${JSON.stringify(input.status)} не входит в статусы {${FINDING_STATUSES.join(", ")}}`);
  } else {
    target = input.status;
  }

  if (finding && target) {
    const allowed = FINDING_TRANSITIONS[finding.status];
    if (!allowed.includes(target)) {
      const list = allowed.length > 0 ? allowed.join(", ") : "нет (статус терминальный для переходов)";
      errors.push(
        `status: переход ${finding.status} → ${target} запрещён. Допустимо из ${finding.status}: ${list}`,
      );
    }
  }

  let evidenceRef: string | undefined;
  if (input.evidence_ref !== undefined) {
    if (!isNonEmptyString(input.evidence_ref)) {
      errors.push(`evidence_ref: ожидается непустая строка, получено ${describeType(input.evidence_ref)}`);
    } else {
      const checked = checkEvidenceRef(workDir, input.evidence_ref.trim());
      if (checked.ok) evidenceRef = input.evidence_ref.trim();
      else errors.push(...checked.errors);
    }
  }
  if (target && EVIDENCE_REQUIRED_STATUSES.includes(target) && evidenceRef === undefined) {
    errors.push(
      `evidence_ref: переход в ${target} требует доказательство — ` +
        (target === "verified"
          ? "ссылку на независимую проверку (вердикт challenge-фазы, повторное чтение артефакта)"
          : "ссылку на контрпример с координатами") +
        `. Пример: ${EVIDENCE_REF_EXAMPLE}`,
    );
  }

  let note: string | undefined;
  if (input.note !== undefined) {
    if (typeof input.note !== "string") {
      errors.push(`note: ожидается строка, получено ${describeType(input.note)}`);
    } else if (input.note.trim().length > 0) {
      note = input.note.trim();
    }
  }

  if (errors.length > 0 || !finding || !target) return { ok: false, errors };

  const record: FindingTransitionRecord = {
    type: "finding_transition",
    id: finding.id,
    from: finding.status,
    status: target,
    ...(evidenceRef !== undefined ? { evidence_ref: evidenceRef } : {}),
    ...(note !== undefined ? { note } : {}),
    updated: now.toISOString(),
  };
  appendLine(workDir, record);
  return { ok: true, value: record };
}
