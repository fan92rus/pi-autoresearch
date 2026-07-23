/**
 * config-ui.ts — Interactive TUI configuration for parallel mode.
 *
 * Uses pi's ExtensionUIContext dialogs (select, input, confirm)
 * to let users configure models, concurrency, and budget without
 * editing .auto/config.json manually.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
    `  fast:   ${cfg.tiers.fast}`,
    `  mid:    ${cfg.tiers.mid}`,
    `  strong: ${cfg.tiers.strong}`,
    `  concurrency: ${conc}`,
    `  budget: ${cfg.budgetSeconds}s`,
  ].join("\n");
}

function tierLabel(tier: Tier): string {
  return tier;
}

// ─── Sub-menus ───────────────────────────────────────────────────────────────

async function configurePresets(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const currentModels = `${cfg.tiers.fast} / ${cfg.tiers.mid} / ${cfg.tiers.strong}`;

  const options = [
    ...PRESETS.map((p) => `${p.label} — ${p.description}`),
    "↩️ Back",
  ];

  const choice = await ctx.ui.select(
    `Choose a preset (current: ${currentModels})`,
    options,
  );

  if (!choice || choice === "↩️ Back") return false;

  const preset = PRESETS.find((p) => choice.startsWith(p.label));
  if (!preset) return false;

  // Apply
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  (raw.parallel as Record<string, unknown>).tiers = { ...preset.tiers };
  writeConfig(workDir, raw);
  ctx.ui.notify(`${preset.label} preset applied`, "info");
  return true;
}

async function configureModels(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const tiers: Tier[] = ["fast", "mid", "strong"];

  const options = tiers.map((t) => `${t} (current: ${cfg.tiers[t]})`).concat(["↩️ Back"]);
  const choice = await ctx.ui.select("Which tier to change?", options);

  if (!choice || choice === "↩️ Back") return false;

  const tier = tiers.find((t) => choice.startsWith(t));
  if (!tier) return false;

  const current = cfg.tiers[tier];
  const newModel = await ctx.ui.input(
    `Model for ${tierLabel(tier)}`,
    current,
  );

  if (!newModel || !newModel.trim() || newModel.trim() === current) {
    ctx.ui.notify("No change", "info");
    return false;
  }

  // Apply
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  if (!(raw.parallel as Record<string, unknown>).tiers) {
    (raw.parallel as Record<string, unknown>).tiers = { ...cfg.tiers };
  }
  ((raw.parallel as Record<string, unknown>).tiers as Record<string, string>)[tier] = newModel.trim();
  writeConfig(workDir, raw);
  ctx.ui.notify(`${tier} → ${newModel.trim()}`, "info");
  return true;
}

async function configureConcurrency(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.concurrency?.toString() ?? "auto";

  const input = await ctx.ui.input(
    `Concurrency (current: ${current}, or "auto")`,
    current,
  );

  if (!input || !input.trim()) return false;

  const trimmed = input.trim();
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};

  if (trimmed.toLowerCase() === "auto" || trimmed === "0") {
    delete (raw.parallel as Record<string, unknown>).concurrency;
    writeConfig(workDir, raw);
    ctx.ui.notify("Concurrency: auto (min(CPU-1, 4))", "info");
  } else {
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 1 || n > 16) {
      ctx.ui.notify("Invalid number (1-16)", "error");
      return false;
    }
    (raw.parallel as Record<string, unknown>).concurrency = n;
    writeConfig(workDir, raw);
    ctx.ui.notify(`Concurrency: ${n}`, "info");
  }
  return true;
}

async function configureBudget(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.budgetSeconds.toString();

  const input = await ctx.ui.input(
    `Budget per measure in seconds (current: ${current})`,
    current,
  );

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
  ctx.ui.notify(`Budget: ${n}s`, "info");
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
  ctx.ui.notify(`Parallel Config:\n${formatCurrent(cfg)}`, "info");

  // Main menu loop
  while (true) {
    const current = getConfigParallel(workDir);
    const header = `Parallel Configuration\n\nCurrent:\n${formatCurrent(current)}\n`;

    const choice = await ctx.ui.select(header, [
      "📦 Presets...",
      "🔧 Models (individual)...",
      "⚡ Concurrency...",
      "⏱️  Budget...",
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
      }
    } catch (e) {
      ctx.ui.notify(`Error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Final summary
  const finalCfg = getConfigParallel(workDir);
  ctx.ui.notify(`Config saved.\n${formatCurrent(finalCfg)}`, "info");
}
