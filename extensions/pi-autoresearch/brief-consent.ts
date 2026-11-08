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
 * Consent dialog body: at most CONSENT_SUMMARY_MAX_LINES lines, first line `Brief SHA-256: <hex>`.
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
    "Полный бриф выведен выше, в строке вызова research_brief propose.",
    "Подтверждение фиксирует этот SHA-256: вопросы и правила не меняются.",
    "Подтвердить согласование?",
  ];
  if (lines.length > CONSENT_SUMMARY_MAX_LINES) throw new Error("consent summary exceeds the line budget");
  return lines.join("\n");
}
