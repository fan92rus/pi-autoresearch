/**
 * config-ui.ts — Interactive TUI configuration for parallel mode.
 *
 * Uses pi's ExtensionUIContext dialogs (select, input, confirm)
 * to let users configure models, concurrency, and budget without
 * editing .auto/config.json manually.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { DEFAULT_CONFIG, resolveConfig, type ParallelConfig, type Tier } from "./config.ts";

// ─── Types (duck-typed from ExtensionCommandContext) ─────────────────────────

interface UIContext {
  select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface ConfigCtx {
  ui: UIContext;
  cwd: string;
}

// ─── Autocomplete ────────────────────────────────────────────────────────────

export interface AutocompleteEntry {
  value: string;
  label: string;
  description?: string;
}

/** Subcommands offered by `/autoresearch` for tab-completion. */
export const AUTORESEARCH_SUBCOMMANDS: AutocompleteEntry[] = [
  { value: "off", label: "off", description: "Turn autoresearch mode off" },
  { value: "clear", label: "clear", description: "Delete session log and reset state" },
  { value: "config", label: "config", description: "Interactive parallel mode configuration (models, concurrency, budget)" },
  { value: "export", label: "export", description: "Open live dashboard in browser" },
  { value: "parallel-best-of-n", label: "parallel-best-of-n", description: "Try N hypotheses at once, keep the best" },
  { value: "parallel-stack", label: "parallel-stack", description: "Stack independent file-scoped optimizations" },
  { value: "parallel-search", label: "parallel-search", description: "Beam search (K states × M candidates)" },
];

/**
 * Filter subcommands by prefix — used by the command's `getArgumentCompletions`.
 * Returns all subcommands when prefix is empty.
 */
export function filterSubcommands(prefix: string): AutocompleteEntry[] {
  if (!prefix) return AUTORESEARCH_SUBCOMMANDS;
  const lower = prefix.toLowerCase();
  return AUTORESEARCH_SUBCOMMANDS.filter((s) => s.value.toLowerCase().startsWith(lower));
}

// ─── Presets ─────────────────────────────────────────────────────────────────

interface Preset {
  label: string;
  description: string;
  tiers: Record<Tier, string>;
}

const PRESETS: Preset[] = [
  {
    label: "💰 Budget",
    description: "All deepseek-flash — cheapest, good for simple tasks",
    tiers: {
      fast: "opencode-go/deepseek-v4-flash:low",
      mid: "opencode-go/deepseek-v4-flash:xhigh",
      strong: "opencode-go/deepseek-v4-flash:xhigh",
    },
  },
  {
    label: "⚖️ Balanced",
    description: "Flash for workers + GLM for complex — recommended",
    tiers: {
      fast: "opencode-go/deepseek-v4-flash:low",
      mid: "opencode-go/deepseek-v4-flash:xhigh",
      strong: "zai-glm/glm-5.2:high",
    },
  },
  {
    label: "🚀 Premium",
    description: "GLM everywhere — best quality, highest cost",
    tiers: {
      fast: "zai-glm/glm-5.2:low",
      mid: "zai-glm/glm-5.2:high",
      strong: "zai-glm/glm-5.2:high",
    },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApproximateCpuCount(): number {
  return os.cpus().length;
}

function readConfig(workDir: string): Record<string, unknown> {
  const configPath = path.join(workDir, ".auto", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function writeConfig(workDir: string, config: Record<string, unknown>): void {
  const configDir = path.join(workDir, ".auto");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getConfigParallel(workDir: string): ParallelConfig {
  const raw = readConfig(workDir);
  return resolveConfig(raw);
}

function formatCurrent(cfg: ParallelConfig): string {
  const conc = cfg.concurrency ?? "auto";
  return [
    "  fast:   " + cfg.tiers.fast,
    "  mid:    " + cfg.tiers.mid,
    "  strong: " + cfg.tiers.strong,
    "  concurrency: " + conc,
    "  budget: " + cfg.budgetSeconds + "s",
  ].join("\n");
}

// ─── Sub-menus ───────────────────────────────────────────────────────────────

async function configurePresets(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const currentModels = cfg.tiers.fast + " / " + cfg.tiers.mid + " / " + cfg.tiers.strong;

  const options = PRESETS.map(function (p) { return p.label + " — " + p.description; }).concat(["↩️ Back"]);

  const choice = await ctx.ui.select(
    "Choose a preset (current: " + currentModels + ")",
    options,
  );

  if (!choice || choice === "↩️ Back") return false;

  const preset = PRESETS.find(function (p) { return choice.startsWith(p.label); });
  if (!preset) return false;

  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  (raw.parallel as Record<string, unknown>).tiers = { ...preset.tiers };
  writeConfig(workDir, raw);
  ctx.ui.notify(preset.label + " preset applied", "info");
  return true;
}

async function configureModels(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const tiers: Tier[] = ["fast", "mid", "strong"];

  const options = tiers.map(function (t) { return t + " (current: " + cfg.tiers[t] + ")"; }).concat(["↩️ Back"]);
  const choice = await ctx.ui.select("Which tier to change?", options);

  if (!choice || choice === "↩️ Back") return false;

  const tier = tiers.find(function (t) { return choice.startsWith(t); });
  if (!tier) return false;

  const current = cfg.tiers[tier];
  const newModel = await ctx.ui.input(
    "Model for " + tier + " tier (format: provider/model:thinking)\n  e.g. opencode-go/deepseek-v4-flash:low\n  e.g. anthropic/claude-sonnet-4:medium\n  e.g. zai-glm/glm-5.2:high",
    current,
  );

  if (!newModel || !newModel.trim() || newModel.trim() === current) {
    ctx.ui.notify("No change", "info");
    return false;
  }

  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  if (!(raw.parallel as Record<string, unknown>).tiers) {
    (raw.parallel as Record<string, unknown>).tiers = { ...cfg.tiers };
  }
  ((raw.parallel as Record<string, unknown>).tiers as Record<string, string>)[tier] = newModel.trim();
  writeConfig(workDir, raw);
  ctx.ui.notify(tier + " → " + newModel.trim(), "info");
  return true;
}

async function configureConcurrency(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.concurrency?.toString() ?? "auto";
  const cpuCount = getApproximateCpuCount();
  const autoVal = Math.max(1, Math.min(cpuCount - 1, 4));

  const title = [
    "Concurrency (current: " + current + ")",
    "",
    "Number of worker subagents running in parallel during",
    "BestOfN, SpaceSearch, valleyProbe, CheckOrthogonal.",
    "",
    "Each worker clones a git worktree and runs measure.sh",
    "independently. Higher = faster exploration, but more CPU load.",
    "",
    "Recommended values:",
    "  auto   = min(CPU-1, 4) = " + autoVal + " on your " + cpuCount + "-core machine",
    "  1-2    = safe if measure.sh is CPU-heavy (compile, train)",
    "  3-4    = good for lightweight scripts (parsing, tests)",
    "  5+     = only if measure.sh is I/O or network-bound",
    "",
    "Enter a number (1-16) or \"auto\":",
  ].join("\n");

  const input = await ctx.ui.input(title, current);

  if (!input || !input.trim()) return false;

  const trimmed = input.trim();
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};

  if (trimmed.toLowerCase() === "auto" || trimmed === "0") {
    delete (raw.parallel as Record<string, unknown>).concurrency;
    writeConfig(workDir, raw);
    ctx.ui.notify("Concurrency: auto (min(CPU-1, 4) = " + autoVal + ")", "info");
  } else {
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 1 || n > 16) {
      ctx.ui.notify("Invalid number (1-16)", "error");
      return false;
    }
    (raw.parallel as Record<string, unknown>).concurrency = n;
    writeConfig(workDir, raw);
    ctx.ui.notify("Concurrency: " + n, "info");
  }
  return true;
}

async function configureBudget(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.budgetSeconds.toString();

  const title = [
    "Budget per measure in seconds (current: " + current + "s)",
    "",
    "Maximum wall-clock time for a single measure.sh execution.",
    "If exceeded, the run is killed and logged as budget_exceeded.",
    "",
    "This budget applies to BOTH paths:",
    "  Worker measurements (BENCH_MODE=quick) — fast subset",
    "  Parent re-measurement (BENCH_MODE=full) — complete benchmark",
    "",
    "If the baseline itself exceeds this, parallel rounds will",
    "refuse to start. Fix measure.sh (add BENCH_MODE=quick subset)",
    "rather than raising the budget indefinitely.",
    "",
    "Typical values:",
    "  60s    = quick scripts (parsing, small unit tests)",
    "  120s   = moderate (integration tests, medium datasets)",
    "  300s   = default (build + test suites, training)",
    "  600s   = heavy (full training epochs, large benchmarks)",
    "",
    "Enter a number (30-600):",
  ].join("\n");

  const input = await ctx.ui.input(title, current);

  if (!input || !input.trim()) return false;

  const n = parseInt(input.trim(), 10);
  if (isNaN(n) || n < 30 || n > 600) {
    ctx.ui.notify("Invalid budget (30-600 seconds)", "error");
    return false;
  }

  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  (raw.parallel as Record<string, unknown>).budgetSeconds = n;
  writeConfig(workDir, raw);
  ctx.ui.notify("Budget: " + n + "s", "info");
  return true;
}

// ─── Observer settings ─────────────────────────────────────────────────────

function readObserverSection(workDir: string): Record<string, unknown> {
  const raw = readConfig(workDir);
  const obs = (raw as Record<string, unknown>).observer;
  return (typeof obs === "object" && obs !== null ? obs : {}) as Record<string, unknown>;
}

function writeObserverField(workDir: string, key: string, value: number): void {
  const raw = readConfig(workDir);
  if (!(raw as Record<string, unknown>).observer) {
    (raw as Record<string, unknown>).observer = {};
  }
  ((raw as Record<string, unknown>).observer as Record<string, unknown>)[key] = value;
  writeConfig(workDir, raw);
}

function resetObserverConfig(ctx: ConfigCtx, workDir: string): void {
  const raw = readConfig(workDir);
  delete (raw as Record<string, unknown>).observer;
  writeConfig(workDir, raw);
  ctx.ui.notify("Observer settings reset to defaults", "info");
}

interface ObserverField {
  key: string;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
}

const OBSERVER_FIELDS: ObserverField[] = [
  {
    key: "finalize_strong_threshold",
    label: "Finalize: strong confidence",
    description: "Agent confidence above this → strong /autoresearch off recommendation.",
    default: 0.8, min: 0.5, max: 1.0,
  },
  {
    key: "finalize_advisory_threshold",
    label: "Finalize: advisory confidence",
    description: "Agent confidence above this → advisory finalize steer.",
    default: 0.5, min: 0.0, max: 0.8,
  },
  {
    key: "floor_streak_threshold",
    label: "Floor: min streak",
    description: "Non-improving runs before floor detection can trigger.",
    default: 15, min: 3, max: 50,
  },
  {
    key: "floor_cv_threshold",
    label: "Floor: variance threshold (CV)",
    description: "Coefficient of variation below which metric is considered plateaued.",
    default: 0.15, min: 0.01, max: 0.5,
  },
  {
    key: "noise_gate_margin",
    label: "Noise gate: margin",
    description: "System noise must exceed best metric × this factor to warn.",
    default: 1.10, min: 1.0, max: 2.0,
  },
  {
    key: "stagnation_threshold",
    label: "Stagnation: interval",
    description: "Non-improving runs between each stagnation escalation steer.",
    default: 5, min: 3, max: 20,
  },
];

async function configureObserver(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const obsConfig = readObserverSection(workDir);

  const options = OBSERVER_FIELDS.map(function (f) {
    const current = typeof obsConfig[f.key] === "number" ? obsConfig[f.key] as number : f.default;
    return f.label + " (current: " + current + ")";
  }).concat(["♻️ Reset to defaults", "↩️ Back"]);

  const choice = await ctx.ui.select("Observer Settings — what to configure?", options);

  if (!choice || choice === "↩️ Back") return false;

  if (choice === "♻️ Reset to defaults") {
    const confirmed = await ctx.ui.confirm("Reset observer", "Reset all observer thresholds to defaults?");
    if (confirmed) resetObserverConfig(ctx, workDir);
    return true;
  }

  const field = OBSERVER_FIELDS.find(function (f) { return choice.startsWith(f.label); });
  if (!field) return false;

  const currentValue = typeof obsConfig[field.key] === "number" ? obsConfig[field.key] as number : field.default;

  const title = [
    field.label + " (current: " + currentValue + ")",
    "",
    field.description,
    "",
    "Range: " + field.min + " - " + field.max + "  |  Default: " + field.default,
    "",
    "Enter new value:",
  ].join("\n");

  const input = await ctx.ui.input(title, String(currentValue));
  if (!input || !input.trim()) return false;

  const n = parseFloat(input.trim());
  if (isNaN(n) || n < field.min || n > field.max) {
    ctx.ui.notify("Invalid value (range: " + field.min + " - " + field.max + ")", "error");
    return false;
  }

  writeObserverField(workDir, field.key, n);
  ctx.ui.notify(field.label + " → " + n, "info");
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Interactive configuration dialog for parallel mode settings.
 * Called from `/autoresearch config` command handler.
 */
export async function interactiveParallelConfig(ctx: ConfigCtx, workDir: string): Promise<void> {
  const cfg = getConfigParallel(workDir);

  // Show current config
  ctx.ui.notify("Parallel Config:\n" + formatCurrent(cfg), "info");

  // Main menu loop
  while (true) {
    const current = getConfigParallel(workDir);
    const header = "Parallel Configuration\n\nCurrent:\n" + formatCurrent(current) + "\n";

    const choice = await ctx.ui.select(header, [
      "📦 Presets...",
      "🔧 Models (individual)...",
      "⚡ Concurrency...",
      "⏱️  Budget...",
      "📊 Observer settings...",
      "✅ Done",
    ]);

    if (!choice || choice === "✅ Done") break;

    try {
      switch (choice) {
        case "📦 Presets...":
          await configurePresets(ctx, workDir);
          break;
        case "🔧 Models (individual)...":
          await configureModels(ctx, workDir);
          break;
        case "⚡ Concurrency...":
          await configureConcurrency(ctx, workDir);
          break;
        case "⏱️  Budget...":
          await configureBudget(ctx, workDir);
          break;
        case "📊 Observer settings...":
          await configureObserver(ctx, workDir);
          break;
      }
    } catch (e) {
      ctx.ui.notify("Error: " + (e instanceof Error ? e.message : String(e)), "error");
    }
  }

  // Final summary
  const finalCfg = getConfigParallel(workDir);
  ctx.ui.notify("Config saved.\n" + formatCurrent(finalCfg), "info");
}
