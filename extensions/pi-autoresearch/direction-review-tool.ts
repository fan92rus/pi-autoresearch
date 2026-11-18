/**
 * direction_review tool (§12.1/§12.2, D-RM-07): pure document generation.
 *
 * The tool definition, renderer and executor were moved out of index.ts
 * unchanged: document text, section order, refusal strings, guard order and
 * the one-file write contract are the same. Extension-local collaborators
 * arrive via `deps` so registration still happens in index.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeState } from "./observer.ts";
import { measurementHealthLine, measurementScaleStatusOfDir } from "./measurement.ts";
import {
  buildLedgerModel,
  classifyPreregOrder,
  computeAttributionStatus,
  computeComparisonControl,
  readAnalysis,
  type JournalFs,
  type StoredAnalysisRecord,
} from "./research-analysis.ts";
import { readObservations, type ObservationRecord } from "./research-observations.ts";
import { journalTarget } from "./research-journal.ts";
import { parseJsonlEntry, reconstructJsonlState } from "./jsonl.ts";
import { ADVISORY_THRESHOLDS, computeExhaustionState, EXHAUSTION_DISCLAIMER } from "./exhaustion-hints.ts";
import { AUTO_DIR } from "./paths.ts";

type DirectionReviewTool = Parameters<ExtensionAPI["registerTool"]>[0];
type JsonObject = Record<string, unknown>;

/** Extension-local collaborators injected by index.ts. */
export interface DirectionReviewToolDeps {
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  validateWorkDir: (cwd: string) => string | null;
  resolveWorkDir: (cwd: string) => string;
  autoresearchJsonlPath: (dir: string) => string;
  JOURNAL_FS: JournalFs;
  PASSPORT_COMPONENTS: readonly string[];
  K_STAG_RUNS: number;
  K_SER_RUNS: number;
  trailingBestImprovements: (runs: { status: string; metric: number }[], direction: "lower" | "higher") => number;
}

const DIRECTION_REVIEW_MANDATORY_RELIABILITY =
  "Надёжность алгоритма не оценивается: документ сводит факты и срабатывание признаков.";
const DIRECTION_REVIEW_MANDATORY_UNCONFIRMED = EXHAUSTION_DISCLAIMER;

export function createDirectionReviewTool(deps: DirectionReviewToolDeps): DirectionReviewTool {
  const {
    assertModeActive,
    validateWorkDir,
    resolveWorkDir,
    autoresearchJsonlPath,
    JOURNAL_FS,
    PASSPORT_COMPONENTS,
    K_STAG_RUNS,
    K_SER_RUNS,
    trailingBestImprovements,
  } = deps;

  return {
    name: "direction_review",
    label: "Direction review document",
    description:
      "Generate a direction-review document at .auto/reviews/direction-<UTC-timestamp>.md from the ledger, " +
      "observations and analysis. Pure read + one file write: no experiments run, no direction chosen, no " +
      "auto action. Sections (§12.2): Факты, Неизвестно, Признаки, Альтернативы, Что не доказано, " +
      "Рекомендации (не действия). Marks exhaustion/comparability as unconfirmed.",
    promptSnippet: "Write a direction-review document (no auto action)",
    promptGuidelines: [
      "Call after a direction-review hint (S_stag / S_ser / S_exh / S_exh_adv) or whenever you want a strategy overview.",
      "The document is informational: it never runs experiments and never picks the next direction for you.",
    ],
    parameters: {
      type: "object",
      properties: {},
    } as any,

    async execute(_toolCallId: string, _params: Record<string, never>, _signal, _onUpdate, ctx: ExtensionContext) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const autoDir = path.join(workDir, AUTO_DIR);

      const NO_DATA = "нет данных";
      const md: string[] = [];
      md.push("# Обзор направлений");
      md.push("");
      md.push(`Сформирован: ${new Date().toISOString()} (UTC).`);
      md.push("");
      md.push(DIRECTION_REVIEW_MANDATORY_RELIABILITY);
      md.push(DIRECTION_REVIEW_MANDATORY_UNCONFIRMED);
      md.push("");

      // ── Reads: ledger, observations, analysis (pure; single pass each) ──
      let ledgerText = "";
      let ledgerState: "ok" | "missing" | "unavailable" = "ok";
      try {
        ledgerText = fs.readFileSync(autoresearchJsonlPath(workDir), "utf-8");
      } catch (e) {
        ledgerState = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unavailable";
      }
      let observations: ObservationRecord[] = [];
      let obsTorn = 0;
      let obsInvalid = 0;
      let obsState: "ok" | "missing" | "unavailable" = "ok";
      try {
        const text = fs.readFileSync(journalTarget(autoDir, "observations").file, "utf8");
        const read = readObservations(text);
        observations = read.records;
        obsTorn = read.torn_lines;
        obsInvalid = read.invalid;
      } catch (e) {
        obsState = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unavailable";
      }
      let analysis: StoredAnalysisRecord[] = [];
      let analysisTorn = 0;
      let analysisInvalid = 0;
      let analysisState: "ok" | "missing" | "unavailable" = "ok";
      try {
        const text = fs.readFileSync(journalTarget(autoDir, "analysis").file, "utf8");
        const read = readAnalysis(text);
        analysis = read.records;
        analysisTorn = read.torn_lines;
        analysisInvalid = read.invalid;
      } catch (e) {
        analysisState = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unavailable";
      }

      const reconstructed = ledgerState === "ok" ? reconstructJsonlState(ledgerText) : null;
      const allRunEntries: JsonObject[] = [];
      if (ledgerState === "ok") {
        for (const line of ledgerText.split("\n")) {
          if (line.trim() === "") continue;
          const entry = parseJsonlEntry(line);
          if (entry !== null && typeof entry.run === "number") allRunEntries.push(entry);
        }
      }
      const direction = reconstructed?.bestDirection ?? "lower";
      const metricName = reconstructed?.metricName ?? "metric";
      const currentSegment = reconstructed?.currentSegment ?? 0;
      // Owner decision (spec rev.): explore rows are excluded from the S_stag/S_ser
      // counters entirely (neither increment nor reset) — see K_STAG_RUNS.
      const segRuns = reconstructed?.results.filter((r) => r.segment === currentSegment && r.status !== "explore") ?? [];
      const observerState = reconstructed !== null ? computeState(segRuns, direction) : null;
      const scaleStatus = measurementScaleStatusOfDir(workDir);
      const healthLine = measurementHealthLine(workDir);

      // Exhaustion engine (trusted stages + advisory counts) — pure reads.
      const exhaustion = computeExhaustionState(autoDir);

      // ── §12.2 п.1: Факты (current direction, counters, best per epoch) ──
      md.push("## Факты");
      md.push("");
      if (reconstructed === null) {
        md.push(`${NO_DATA} (леджер ${ledgerState === "missing" ? "отсутствует" : "нечитаем"}).`);
      } else {
        md.push(`Метрика: ${metricName}; направление лучше: ${direction === "higher" ? "больше" : "меньше"}.`);
        md.push(`Прогонов в текущем сегменте: ${segRuns.length}; без улучшения best: ${observerState?.runsSinceBestImprovement ?? "unknown"}.`);
        // Best per epoch (each epoch separately — never across scales).
        const bestByEpoch = new Map<number, { run: number; metric: number }>();
        for (const r of segRuns) {
          if (r.status !== "keep" || r.metric === 0) continue;
          const cur = bestByEpoch.get(r.epoch);
          const better = cur === undefined || (direction === "lower" ? r.metric < cur.metric : r.metric > cur.metric);
          if (better) bestByEpoch.set(r.epoch, { run: r.run, metric: r.metric });
        }
        if (bestByEpoch.size === 0) {
          md.push(`Лучший результат по эпохам: ${NO_DATA}.`);
        } else {
          for (const [epoch, best] of [...bestByEpoch.entries()].sort((a, b) => a[0] - b[0])) {
            md.push(`Лучший результат эпохи ${epoch}: прогон #${best.run}, ${metricName}=${best.metric}.`);
          }
        }
        // §11.3 activity table (runs): counts only, descriptive not evaluative.
        const ACTIVITIES = ["measurement", "intermediate", "verification", "attribution", "unknown", "invalid"];
        const STATUSES = ["keep", "discard", "crash", "checks_failed", "budget_exceeded", "explore"];
        md.push("");
        md.push("Тип деятельности (прогоны):");
        const activityTable: string[] = [`| activity_type | ${STATUSES.join(" | ")} |`, `|---|${STATUSES.map(() => "---").join("|")}|`];
        let anyActivity = false;
        for (const activity of ACTIVITIES) {
          const cells = STATUSES.map((status) => {
            let n = 0;
            for (const entry of allRunEntries) {
              const raw = entry.activity_type;
              const read = raw === undefined ? "unknown" : (ACTIVITIES.includes(String(raw)) ? String(raw) : "invalid");
              if (read === activity && entry.status === status) n++;
            }
            return String(n);
          });
          if (cells.some((c) => c !== "0")) anyActivity = true;
          activityTable.push(`| ${activity} | ${cells.join(" | ")} |`);
        }
        if (!anyActivity) md.push(`${NO_DATA} (метки activity_type не встречаются).`);
        else md.push(...activityTable);
        // §11.3 observations table.
        md.push("");
        md.push("Наблюдения (activity_type × исход):");
        const OBS_ACT = ["intermediate", "attribution"];
        const OBS_OUT = ["success", "technical_failure", "unknown"];
        const obsTable: string[] = [`| activity_type | ${OBS_OUT.join(" | ")} |`, "|---|---|---|---|"];
        let anyObs = false;
        for (const activity of OBS_ACT) {
          const cells = OBS_OUT.map((outcome) => {
            const n = observations.filter((o) => o.activity_type === activity && o.outcome === outcome).length;
            return String(n);
          });
          if (cells.some((c) => c !== "0")) anyObs = true;
          obsTable.push(`| ${activity} | ${cells.join(" | ")} |`);
        }
        if (!anyObs) md.push(`${NO_DATA}.`);
        else md.push(...obsTable);
        // Runs with technical failure (crash / checks_failed / budget_exceeded).
        const failed = segRuns.filter((r) => r.status === "crash" || r.status === "checks_failed" || r.status === "budget_exceeded").map((r) => r.run);
        md.push("");
        md.push(failed.length > 0 ? `Прогоны с техническим сбоем: ${failed.map((n) => `#${n}`).join(", ")}.` : `Прогоны с техническим сбоем: ${NO_DATA}.`);
        md.push(`Активная шкала: эпоха ${scaleStatus.epoch}.`);
        md.push(healthLine);
      }
      md.push("");

      // ── §12.2 п.1 (продолжение): счётчики записей анализа и наблюдений ──
      const comparisons = analysis.filter((r) => r.kind === "comparison");
      const attributions = analysis.filter((r) => r.kind === "attribution");
      if (comparisons.length === 0 && attributions.length === 0) {
        md.push(`${NO_DATA} (записей comparison/attribution нет).`);
      } else {
        if (comparisons.length > 0) {
          md.push(`Записей comparison: ${comparisons.length} (id: ${comparisons.map((r) => r.id).join(", ")}).`);
        }
        if (attributions.length > 0) {
          md.push(`Записей attribution: ${attributions.length} (id: ${attributions.map((r) => r.id).join(", ")}).`);
        }
      }
      if (observations.length > 0) {
        const failures = observations.filter((o) => o.outcome === "technical_failure").length;
        md.push(`Наблюдений: ${observations.length} (технических сбоев: ${failures}).`);
      }
      // Data sources (§12.1 inputs) — plain list inside Факты; §12.2 fixes the
      // section names, so there is no separate references heading.
      const refs: string[] = [];
      if (ledgerState === "ok") refs.push(".auto/log.jsonl");
      if (obsState === "ok") refs.push(".auto/observations.jsonl");
      if (analysisState === "ok") refs.push(".auto/analysis.jsonl");
      for (const comparison of comparisons.slice(-5)) {
        refs.push(`.auto/analysis.jsonl#${comparison.id}`);
      }
      if (refs.length > 0) {
        md.push("Источники данных (объявления, доступность и содержимое не проверяются документом):");
        for (const ref of refs) md.push(`- ${ref}`);
      }
      md.push("");

      // ── §12.2 п.2: Неизвестно ──
      md.push("## Неизвестно");
      md.push("");
      const unknowns: string[] = [];
      // Unverified/unsettled observations (§12.2 п.2).
      const unverifiedObs = observations.filter((o) => o.binding !== "verified");
      if (unverifiedObs.length > 0) {
        unknowns.push(`Наблюдения с непроверенной привязкой: ${unverifiedObs.map((o) => o.obs_id).join(", ")}.`);
      }
      // Comparisons without proven delta (computed per §9.2, never stored).
      if (comparisons.length > 0) {
        const model = buildLedgerModel(autoDir);
        for (const comparison of comparisons) {
          const baseline = model.runFacts(comparison.baseline_run as number);
          const candidate = model.runFacts(comparison.candidate_run as number);
          const control = computeComparisonControl(comparison, null, baseline, candidate, model);
          if (!control.delta_allowed) {
            unknowns.push(`Сравнение ${comparison.id}: дельта не разрешена (${control.delta_blocked_reason ?? "unknown"}).`);
          } else if (control.control !== "controlled") {
            unknowns.push(`Сравнение ${comparison.id}: контроль ${control.control} (${control.control_basis ?? "unknown"}).`);
          }
        }
      }
      // Causal claims (§12.2 п.5): ALL causal statuses live in «Что не доказано» —
      // unknown/unverifiable with reasons, evidence_bound as record correspondence,
      // never an established cause.
      // Prereg post_hoc/unknown (§12.2 п.2). Computed against the candidate runs of comparisons.
      const preregs = analysis.filter((r) => r.kind === "prereg");
      for (const prereg of preregs) {
        const linkedRuns = comparisons
          .filter((c) => c.prereg_id === prereg.id)
          .map((c) => c.candidate_run as number);
        const verdicts = linkedRuns.map((run) => classifyPreregOrder(autoDir, prereg, run, JOURNAL_FS));
        const seen = new Set(verdicts.map((v) => `${v.status}:${v.order_reason ?? ""}`));
        for (const marker of seen) {
          const [status, reason] = marker.split(":");
          if (status !== "pre_registered") {
            unknowns.push(`Предрегистрация ${prereg.id}: порядок ${status}${reason ? ` (${reason})` : ""}.`);
          }
        }
      }
      // Exhaustion: unknown/budget keys and barriers (§12.2 п.3 → unknowns listing).
      for (const key of exhaustion.keys) {
        if (key.display.value === "unknown") {
          unknowns.push(`Направление ${key.id}: признак исчерпания не оценён (${key.display.code}${key.display.detail ? `: ${key.display.detail}` : ""}).`);
        }
      }
      // Passport unknown components (§8.1 counters).
      let unknownComponents = 0;
      for (const o of observations) {
        if (o.passport === undefined) continue;
        for (const name of PASSPORT_COMPONENTS) {
          const component = o.passport.components[name];
          if (component === undefined || component.state !== "declared") unknownComponents++;
        }
      }
      if (unknownComponents > 0) unknowns.push(`Компонентов паспорта в состоянии unknown: ${unknownComponents}.`);
      // Damaged data.
      if (obsTorn > 0 || obsInvalid > 0) unknowns.push(`observations.jsonl: нечитаемых строк ${obsTorn}, невалидных ${obsInvalid}.`);
      if (analysisTorn > 0 || analysisInvalid > 0) unknowns.push(`analysis.jsonl: нечитаемых строк ${analysisTorn}, невалидных ${analysisInvalid}.`);
      if (obsState === "missing") unknowns.push("observations.jsonl отсутствует — наблюдений нет.");
      if (analysisState === "missing") unknowns.push("analysis.jsonl отсутствует — записей анализа нет.");
      if (unknowns.length === 0) md.push(NO_DATA);
      else for (const u of unknowns) md.push(`- ${u}`);
      md.push("");

      // ── §12.2 п.3: Признаки (S_stag/S_ser/S_exh/S_exh_adv) ──
      md.push("## Признаки");
      md.push("");
      const stagValue = observerState === null ? "unknown" : observerState.runsSinceBestImprovement >= K_STAG_RUNS ? "true" : "false";
      const serTrailing = reconstructed !== null ? trailingBestImprovements(segRuns, direction) : null;
      const serValue = serTrailing === null ? "unknown" : serTrailing >= K_SER_RUNS ? "true" : "false";
      md.push(`- S_stag (без улучшения best ≥ ${K_STAG_RUNS} прогонов сегмента): ${stagValue} (счётчик: ${observerState?.runsSinceBestImprovement ?? "unknown"}).`);
      md.push(`- S_ser (последние ${K_SER_RUNS} прогона подряд улучшают best): ${serValue} (серия: ${serTrailing ?? "unknown"}).`);
      if (exhaustion.keys.length === 0) {
        md.push(`- S_exh: ${NO_DATA} (ключей направлений нет).`);
      } else {
        for (const key of exhaustion.keys.slice(0, 16)) {
          const stage = key.display.value === "true" ? String(key.historyMax) : key.display.value;
          md.push(`- S_exh ${key.id}: ${stage}${key.display.code !== null ? ` (${key.display.code})` : ""}; элементов в текущем сегменте: ${key.segmentCount ?? "unknown"}.`);
        }
      }
      if (exhaustion.axes === null || exhaustion.axes.length === 0) {
        md.push(`- S_exh_adv: ${NO_DATA} (осей с сравнениями нет).`);
      } else {
        for (const axis of exhaustion.axes) {
          md.push(`- S_exh_adv ось ${axis.axis}: n=${axis.n} (сравнения: ${axis.ids.join(", ")}).`);
        }
      }
      md.push("Исчерпание направления и сопоставимость результатов не подтверждены; формулировки выше — предложение обзора, не вывод.");
      md.push("");

      // ── §12.2 п.4: Альтернативы (always first alternative, no selection) ──
      md.push("## Альтернативы");
      md.push("");
      md.push("Продолжить текущее направление — всегда доступная альтернатива. Другие варианты: сменить ось; провести контролируемое сравнение (один компонент); остановиться. Документ не выбирает и не запускает (FR-06.1).");
      md.push("");

      // ── §12.2 п.5: Что не доказано (causal claims, all statuses) ──
      md.push("## Что не доказано");
      md.push("");
      const unproven: string[] = [];
      for (const attribution of attributions) {
        const status = computeAttributionStatus(autoDir, attribution, analysis, JOURNAL_FS);
        if (status.status !== "evidence_bound") {
          unproven.push(`Каузальное утверждение ${attribution.id}: ${status.status} (${status.reason}); причина не установлена.`);
        } else {
          unproven.push(`Каузальное утверждение ${attribution.id}: evidence_bound — соответствие записей, не установленная причина.`);
        }
      }
      if (unproven.length === 0) md.push(NO_DATA);
      else for (const u of unproven) md.push(`- ${u}`);
      md.push("");

      // ── §12.2 п.6: Рекомендации (не действия) ──
      md.push("## Рекомендации (не действия)");
      md.push("");
      const recommendations: string[] = [];
      if (stagValue === "true") recommendations.push("Предлагается обзор направлений из-за S_stag (см. Признаки) — документ, не действие.");
      if (serValue === "true") recommendations.push("Предлагается обзор направлений из-за S_ser (см. Признаки) — документ, не действие.");
      const exhaustedKeys = exhaustion.keys.filter((k) => k.display.value === "true");
      if (exhaustedKeys.length > 0) {
        recommendations.push(`Предлагается обзор осей с доверенной ступенью (см. Признаки: ${exhaustedKeys.map((k) => k.id).join(", ")}) — это не вывод об исчерпании.`);
      }
      const advisoryAxes = (exhaustion.axes ?? []).filter((a) => a.n >= ADVISORY_THRESHOLDS[0]);
      if (advisoryAxes.length > 0) {
        recommendations.push(`Предлагается обзор осей с накопленными сравнениями (см. Признаки: ${advisoryAxes.map((a) => a.axis).join(", ")}).`);
      }
      if (recommendations.length === 0) md.push(NO_DATA);
      else for (const r of recommendations.slice(0, 3)) md.push(`- ${r} (иллюстративные примеры, не обязательный набор — FR-06.5).`);
      md.push("");

      // ── Write ONE document; never overwrite a previous one (§12.1: one file
      // per call, previous documents are never rewritten). "wx" fails on an
      // existing stamp (millisecond collisions); retry with -2, -3 … suffixes.
      const reviewsDir = path.join(autoDir, "reviews");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let reviewPath: string | null = null;
      try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        for (let attempt = 1; attempt <= 100 && reviewPath === null; attempt++) {
          const candidate = path.join(reviewsDir, attempt === 1 ? `direction-${stamp}.md` : `direction-${stamp}-${attempt}.md`);
          try {
            fs.writeFileSync(candidate, md.join("\n"), { flag: "wx" });
            reviewPath = candidate;
          } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
          }
        }
        if (reviewPath === null) throw new Error(`no free review filename for stamp ${stamp}`);
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ Failed to write review document: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
        };
      }

      const summary = md.filter((line) => line.startsWith("## ")).map((line) => line.replace("## ", "")).join(" → ");
      return {
        content: [{ type: "text", text: `📄 Direction review written: ${reviewPath}\nSections: ${summary}\nNo experiments were run; no direction was chosen (document only).` }],
        details: { path: reviewPath, sections: md.filter((line) => line.startsWith("## ")).length },
      };
    },

    renderResult(result, _options, theme) {
      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "", 0, 0);
    },
  };
}
