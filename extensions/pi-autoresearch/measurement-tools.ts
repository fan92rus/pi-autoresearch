/**
 * Measurement-change tool schemas and adapters.
 *
 * Registration and lifecycle policy (gated tool tracking, mode gating and
 * work-dir policy) stays in index.ts; the policy hooks are injected via deps
 * so every measurement tool goes through exactly the same gates.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { loadFindings } from "./findings.ts";
import { refusalDetails } from "./refusal.ts";
import {
  formatMeasurementScale,
  logMeasurementChange,
  measurementChangeId,
  measurementScaleStatusOfDir,
  measurementVerificationStateOfDir,
  revertMeasurementChange,
  verifyMeasurementChange,
} from "./measurement.ts";

export interface RegisterToolLike {
  registerTool(tool: unknown): void;
}

const FINDING_ID_RE = /^f\d+$/;

/**
 * A finding-shaped justification ("f7") must name an existing finding with
 * theme measurement; anything else stays ordinary free text (bd tj0.8).
 * The ledger format and the store's own validation are untouched.
 */
export function measurementJustificationProblem(workDir: string, justification: unknown): string | null {
  if (typeof justification !== "string") return null;
  const id = justification.trim();
  if (!FINDING_ID_RE.test(id)) return null;
  const loaded = loadFindings(workDir);
  if (!loaded.ok) {
    return `justification: "${id}" — находка не может быть проверена (${loaded.errors.join("; ")}); укажите существующий id или опишите причину словами`;
  }
  const finding = loaded.value.findings.get(id);
  if (!finding) {
    return `justification: "${id}" — находка с таким id не найдена в .auto/findings.jsonl; укажите существующий id или опишите причину словами`;
  }
  if (finding.theme !== "measurement") {
    return `justification: "${id}" — тема находки ${finding.theme}, а не measurement; изменение измерителя должно ссылаться на находку с темой measurement`;
  }
  return null;
}

export interface GatedToolDeps {
  assertModeActive: (ctx: ExtensionContext) => { content: { type: "text"; text: string }[] } | undefined;
  validateWorkDir: (cwd: string) => string | null;
  resolveWorkDir: (cwd: string) => string;
}

const LogMeasurementChangeParams = Type.Object({
  diff_ref: Type.Optional(Type.String({
    description:
      "New change: path to the diff, inside .auto/measurement/ (e.g. .auto/measurement/e2_gold_v16.diff). The diff must exist there — it is what survives a revert.",
  })),
  rescore_ref: Type.Optional(Type.String({
    description:
      'Path to the rescore artifact inside .auto/measurement/ (JSON: {"anchor", "commands", "old_scale_score", "new_scale_score"}). The scores are parsed FROM this file — they are never accepted as tool arguments.',
  })),
  justification: Type.Optional(Type.String({
    description: 'New change: the finding id this fixes (e.g. "f7") or the reason in words.',
  })),
  rescore_pending: Type.Optional(Type.Boolean({
    description:
      "New change: true when the rescore has not run yet — the artifact must exist (anchor + commands) but may lack the scores; the new scale stays provisional until completed.",
  })),
  change_ref: Type.Optional(Type.String({
    description:
      'Completion of a pending change: its id ("e2" or bare "2"). Requires rescore_ref pointing at a FULL artifact (both scores); appends measurement_change_completed in the SAME epoch.',
  })),
});

const VerifyMeasurementChangeParams = Type.Object({
  change_ref: Type.String({
    description: 'The change being verified ("e2" or bare "2").',
  }),
  proof_ref: Type.String({
    description:
      'Path to the proof artifact inside .auto/measurement/ (JSON: {"anchor", "commands", "outputs", "old_scale_score", "new_scale_score"}): the re-run of the SAME commands/inputs with their outputs and the reproduced scores. Scores are machine-checked against the ledger — a mismatch is a refutation, not a confirmation.',
  }),
});

const RevertMeasurementChangeParams = Type.Object({
  change_ref: Type.Optional(Type.String({
    description: 'The change being refuted ("e2" or bare "2") — must be the latest change.',
  })),
  rescore_ref: Type.Optional(Type.String({
    description:
      'Path to the counter-rescore artifact inside .auto/measurement/ (JSON with anchor, commands, old_scale_score, new_scale_score): the re-run of the SAME commands/inputs whose scores DIFFER from the change\'s.',
  })),
  justification: Type.Optional(Type.String({
    description: 'The refuting finding id (e.g. "f9") or the reason in words.',
  })),
});

/**
 * Registers log_measurement_change / verify_measurement_change /
 * revert_measurement_change behind the injected mode, work-dir and
 * resolution gates. Tool names, descriptions, schemas and response text are
 * the adapter contract — change them only deliberately.
 */
export function registerMeasurementTools(pi: RegisterToolLike, deps: GatedToolDeps): void {
  const { assertModeActive, validateWorkDir, resolveWorkDir } = deps;

  // -----------------------------------------------------------------------
  // log_measurement_change tool (openspec add-result-reflection, task 2.1)
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "log_measurement_change",
    label: "Log Measurement Change",
    description:
      "Register a change of the measurer itself (gold, scorer or metric) in the measurement ledger: a new change " +
      "{diff_ref, rescore_ref, justification, rescore_pending?} opens the next scale epoch with the scores parsed from the rescore artifact; " +
      "a pending change is completed later with {change_ref, rescore_ref} (same epoch, scores from the full artifact). " +
      "The change stays needs_verification until independently verified.",
    promptSnippet: "Register a measurer change (gold/scorer/metric) with mandatory accounting",
    promptGuidelines: [
      "NEVER edit the scorer, gold or metric silently in the model track: a measurer change without a log_measurement_change record is benchmark gaming — the ledger would compare numbers from different scales.",
      'A finding with theme "measurement" is resolved through log_measurement_change: the diff and a reproducible rescore artifact go to .auto/measurement/, justification = the finding id; the change stays provisional (needs_verification: true) until independently verified.',
      "Scores are never arguments: write old_scale_score/new_scale_score into the rescore artifact file and the tool parses them from there — ledger numbers stay as reproducible as the artifact.",
    ],
    parameters: LogMeasurementChangeParams,

    async execute(_toolCallId, params: Static<typeof LogMeasurementChangeParams>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const justificationProblem = measurementJustificationProblem(workDir, params.justification);
      if (justificationProblem) {
        return {
          content: [{ type: "text", text: `❌ log_measurement_change rejected:\n  ${justificationProblem}` }],
          details: refusalDetails("invalid_argument"),
        };
      }
      const res = logMeasurementChange(workDir, params);
      if (!res.ok) {
        return { content: [{ type: "text", text: `❌ log_measurement_change rejected:\n  ${res.errors.join("\n  ")}` }], details: {} };
      }
      const record = res.value;
      if (record.type === "measurement_change") {
        const scores = record.old_scale_score !== undefined && record.new_scale_score !== undefined
          ? `: ${record.old_scale_score} → ${record.new_scale_score}`
          : ", rescore pending — the new scale is provisional";
        return {
          content: [{
            type: "text",
            text: `📏 Measurement change ${measurementChangeId(record.epoch)} recorded (epoch ${record.epoch}${scores}, needs_verification: true).\n${formatMeasurementScale(measurementScaleStatusOfDir(workDir))}`,
          }],
          details: {
            change_ref: measurementChangeId(record.epoch),
            epoch: record.epoch,
            needs_verification: record.needs_verification,
            rescore_pending: record.rescore_pending === true,
            provisional: true,
          },
        };
      }
      return {
        content: [{
          type: "text",
          text: `📏 Measurement change ${record.change_ref} completed (epoch ${record.epoch}: ${record.old_scale_score} → ${record.new_scale_score}).`,
        }],
        details: {
          change_ref: record.change_ref,
          epoch: record.epoch,
          old_scale_score: record.old_scale_score,
          new_scale_score: record.new_scale_score,
        },
      };
    },
  });

  // -----------------------------------------------------------------------
  // verify_measurement_change / revert_measurement_change tools (openspec
  // add-result-reflection, task 2.8): the independent check's verdicts, next
  // to log_measurement_change behind the same gates. Without this surface the
  // needs_verification / provisional marks could never lift in a live campaign
  // (review blocker B2).
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "verify_measurement_change",
    label: "Verify Measurement Change",
    description:
      "Record the independent CONFIRMATION of a measurer change: re-run the rescore of the anchor set " +
      "(same commands/inputs), save the proof artifact (commands, outputs, reproduced scores) in .auto/measurement/ " +
      "and append the measurement_change_verified ledger record — needs_verification and the provisional mark lift. " +
      "Anchor, commands and scores are machine-checked against the change's rescore artifact; refuted scores are rejected here — use revert_measurement_change instead.",
    promptSnippet: "Record the independent confirmation of a measurer change (needs_verification lifted)",
    promptGuidelines: [
      "A measurer change stays provisional (needs_verification: true) until independently verified: re-run the rescore of the anchor set with the SAME commands, write the proof (commands, outputs, reproduced scores) to .auto/measurement/ and call verify_measurement_change {change_ref, proof_ref}.",
      "The proof is machine-checked: same anchor, same commands, and scores equal to the change's ledger scores — otherwise the tool refuses (different scores mean the change is refuted: call revert_measurement_change, not verify).",
    ],
    parameters: VerifyMeasurementChangeParams,

    async execute(_toolCallId, params: Static<typeof VerifyMeasurementChangeParams>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const res = verifyMeasurementChange(workDir, params);
      if (!res.ok) {
        return { content: [{ type: "text", text: `❌ verify_measurement_change rejected:\n  ${res.errors.join("\n  ")}` }], details: {} };
      }
      const record = res.value;
      const scaleStatus = measurementScaleStatusOfDir(workDir);
      const verification = measurementVerificationStateOfDir(workDir);
      return {
        content: [{
          type: "text",
          text: `✅ Measurement change ${record.change_ref} verified (epoch ${record.epoch}, needs_verification lifted; proof: ${record.proof_ref}).\n📏 ${formatMeasurementScale(scaleStatus, verification)}`,
        }],
        details: {
          change_ref: record.change_ref,
          epoch: record.epoch,
          proof_ref: record.proof_ref,
          verified: true,
        },
      };
    },
  });

  pi.registerTool({
    name: "revert_measurement_change",
    label: "Revert Measurement Change",
    description:
      "Record the independent REFUTATION of a measurer change: re-run the rescore of the anchor set " +
      "(same commands/inputs), save the counter-rescore artifact (scores that differ) in .auto/measurement/ and append " +
      "the compensating measurement_change_reverted ledger record — the active scale is restored to the last confirmed epoch, " +
      "the rejected epoch's runs become incomparable (cross-epoch) and its id is never reused.",
    promptSnippet: "Record the independent refutation of a measurer change (scale restored, runs of the rejected epoch incomparable)",
    promptGuidelines: [
      "When the independent re-run of a measurer change's rescore yields DIFFERENT scores, the change is refuted: save the counter-rescore in .auto/measurement/ and call revert_measurement_change {change_ref, rescore_ref, justification} — original records are never rewritten and the epoch id is never reused.",
      "The counter-rescore is machine-checked: same anchor, same commands, scores different from the change's ledger scores — matching scores mean the change is CONFIRMED: call verify_measurement_change, not revert.",
    ],
    parameters: RevertMeasurementChangeParams,

    async execute(_toolCallId, params: Static<typeof RevertMeasurementChangeParams>, _signal, _onUpdate, ctx) {
      const modeGate = assertModeActive(ctx);
      if (modeGate) return modeGate;
      const workDirError = validateWorkDir(ctx.cwd);
      if (workDirError) {
        return { content: [{ type: "text", text: `❌ ${workDirError}` }], details: {} };
      }
      const workDir = resolveWorkDir(ctx.cwd);
      const justificationProblem = measurementJustificationProblem(workDir, params.justification);
      if (justificationProblem) {
        return {
          content: [{ type: "text", text: `❌ revert_measurement_change rejected:\n  ${justificationProblem}` }],
          details: refusalDetails("invalid_argument"),
        };
      }
      const res = revertMeasurementChange(workDir, params);
      if (!res.ok) {
        return { content: [{ type: "text", text: `❌ revert_measurement_change rejected:\n  ${res.errors.join("\n  ")}` }], details: {} };
      }
      const record = res.value;
      const scaleStatus = measurementScaleStatusOfDir(workDir);
      const verification = measurementVerificationStateOfDir(workDir);
      return {
        content: [{
          type: "text",
          text: `↩️ Measurement change ${record.change_ref} reverted (epoch ${record.epoch} refuted — active scale restored to epoch ${scaleStatus.epoch}; ` +
            `runs of epoch ${record.epoch} are incomparable).\n📏 ${formatMeasurementScale(scaleStatus, verification)}`,
        }],
        details: {
          change_ref: record.change_ref,
          epoch: record.epoch,
          rescore_ref: record.rescore_ref,
          active_epoch: scaleStatus.epoch,
          rejected_epochs: verification.rejected_epochs,
          reverted: true,
        },
      };
    },
  });
}
