// Readable views of a research brief for owner consent (openspec: brief-consent-summary).
// Pure functions: no I/O. The chat message carries the full brief; the dialog carries
// a short summary. Both are derived from the same validated brief and the same SHA-256.

import type { ResearchBrief } from "./research-state.ts";

/** Max lines in the consent dialog body (the first line is the SHA line). */
export const CONSENT_SUMMARY_MAX_LINES = 10;

const CLIP_GOAL = 160;
const CLIP_LIST = 160;

/** One line, no newlines, at most `max` characters. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function verdictsOf(brief: ResearchBrief): string[] {
  return brief.verdicts ?? ["confirmed", "rejected", "inconclusive", "waiting_for_data"];
}

/** Recursively sorts object keys; arrays keep their order. Shared by every brief that is written as JSON. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Keys of `obj` outside `allowed`, in input order. Used to refuse unknown fields, never to drop them. */
export function unknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(obj).filter((key) => !allowed.has(key));
}

/** Every character that starts a new physical line in a dialog or a Markdown list. */
const LINE_BREAK_RE = /[\n\r\u0085\u2028\u2029]/;

export function hasLineBreak(text: string): boolean {
  return LINE_BREAK_RE.test(text);
}

export type ConsentOutcome<F> =
  | { status: "no_ui" }
  | { status: "refused" }
  | { status: "recorded" }
  | { status: "write_failed"; failure: F };

/**
 * The consent flow shared by both modes, after each mode has validated its brief and computed its hash.
 * Without a UI nothing is asked and nothing is recorded. The owner's answer is recorded either way
 * (`record(false)` for a refusal; a mode may ignore a refusal). A confirmation goes through `record(true)`,
 * which each mode implements with its own binding check (the brief the owner saw must still be on disk).
 */
export async function askConsent<F extends { ok: boolean }>(deps: {
  hasUi: boolean;
  title: string;
  body: string;
  confirm: (title: string, body: string) => Promise<boolean>;
  record: (confirmed: boolean) => Promise<F>;
}): Promise<ConsentOutcome<F & { ok: false }>> {
  if (!deps.hasUi) return { status: "no_ui" };
  const confirmed = (await deps.confirm(deps.title, deps.body)) === true;
  if (!confirmed) {
    await deps.record(false);
    return { status: "refused" };
  }
  const written = await deps.record(true);
  if (!written.ok) return { status: "write_failed", failure: written as F & { ok: false } };
  return { status: "recorded" };
}

/** Full brief as readable Markdown for the chat transcript (not JSON). */
export function briefChatMarkdown(brief: ResearchBrief, sha256: string, campaignId: string): string {
  const lines: string[] = [];
  lines.push(`## Бриф кампании ${campaignId} — на согласование`);
  lines.push("");
  lines.push(`SHA-256 брифа: \`${sha256}\``);
  lines.push("");
  lines.push(`**Цель.** ${brief.goal}`);
  lines.push("");
  lines.push(`**План:** ${brief.plan_source}`);
  lines.push("");
  lines.push(`> ${brief.caveat_block.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push(`**Вердикты:** ${verdictsOf(brief).join(", ")}`);
  lines.push("");
  lines.push("**Данные по ролям**");
  lines.push(`- explore: ${brief.data_roles.explore.join(", ") || "—"}`);
  lines.push(`- validate: ${brief.data_roles.validate.join(", ") || "—"}`);
  lines.push(`- confirm: ${brief.data_roles.confirm.join(", ") || "—"}`);
  lines.push("");
  lines.push("**Вопросы**");
  brief.questions.forEach((q, i) => {
    lines.push(`${i + 1}. **${q.id}.** ${q.text}`);
    for (const rule of q.decision_rules) {
      lines.push(`   - \`${rule.verdict}\` (${rule.id}): ${rule.when}`);
    }
    if (q.needs_data) lines.push(`   - нужны данные: ${q.needs_data}`);
  });
  lines.push("");
  lines.push("**Стоп-правила**");
  for (const stop of brief.stop_rules) lines.push(`- ${stop.id}: ${stop.when}`);
  lines.push("");
  lines.push("**Метрики процесса**");
  for (const metric of brief.process_metrics) lines.push(`- ${metric}`);
  if (brief.evidence_gate) {
    const gate = brief.evidence_gate;
    lines.push("");
    lines.push("**Замок тестовых данных**");
    lines.push(`- заблокированные пути: ${gate.blocked_globs.join(", ")}`);
    lines.push(`- файл-маркер: ${gate.gate_file} (должен содержать «${gate.gate_contains}»)`);
  }
  return lines.join("\n");
}

/**
 * Shared consent dialog body for every brief mode (research campaigns and the ordinary loop):
 * the first line is `Brief SHA-256: <hex>`, the rest is the mode's summary. Enforces the line budget.
 */
export function consentDialogBody(sha256: string, summaryLines: string[], question: string): string {
  const body = [`Brief SHA-256: ${sha256}`, ...summaryLines, "Подтверждение фиксирует этот SHA-256: поля брифа не меняются.", question].join("\n");
  // Budget counts physical lines, not array items: an embedded newline must not slip past it.
  if (body.split(/\r\n|[\n\r\u2028\u2029\u0085]/).length > CONSENT_SUMMARY_MAX_LINES) throw new Error("consent summary exceeds the line budget");
  return body;
}

/**
 * Research consent dialog body: at most CONSENT_SUMMARY_MAX_LINES lines, first line `Brief SHA-256: <hex>`.
 * The owner approves the SHA; the full brief is in the chat message sent before the dialog.
 */
export function briefConsentSummary(brief: ResearchBrief, sha256: string, campaignId: string): string {
  const verdicts = verdictsOf(brief);
  const rules = brief.questions.reduce((n, q) => n + q.decision_rules.length, 0);
  const questionIds = brief.questions.map((q) => q.id).join(", ");
  const gate = brief.evidence_gate
    ? `есть (${clip(brief.evidence_gate.blocked_globs.join(", "), CLIP_LIST)})`
    : "нет";
  const lines = [
    `Brief SHA-256: ${sha256}`,
    `Кампания: ${campaignId}`,
    `Цель: ${clip(brief.goal, CLIP_GOAL)}`,
    `Вопросов: ${brief.questions.length} (${clip(questionIds, CLIP_LIST)}); правил: ${rules}`,
    `Вердикты: ${clip(verdicts.join(", "), CLIP_LIST)}`,
    `Стоп-правил: ${brief.stop_rules.length}; метрик процесса: ${brief.process_metrics.length}`,
    `Замок тестовых данных: ${gate}`,
    "Подтверждение фиксирует этот SHA-256: вопросы и правила не меняются.",
    "Подтвердить согласование?",
  ];
  if (lines.length > CONSENT_SUMMARY_MAX_LINES) throw new Error("consent summary exceeds the line budget");
  return lines.join("\n");
}
