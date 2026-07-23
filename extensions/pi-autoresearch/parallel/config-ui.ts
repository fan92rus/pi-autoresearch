/**
 * config-ui.ts — Interactive TUI configuration for parallel mode.
 *
 * Uses pi's ExtensionUIContext dialogs (select, input, confirm)
 * to let users configure models, concurrency, budget, and observer
 * thresholds without editing .auto/config.json manually.
 *
 * Localized: auto-detects Russian locale (ru-RU) and shows Russian UI.
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

export const AUTORESEARCH_SUBCOMMANDS: AutocompleteEntry[] = [
  { value: "off", label: "off", description: "Turn autoresearch mode off" },
  { value: "clear", label: "clear", description: "Delete session log and reset state" },
  { value: "config", label: "config", description: "Interactive parallel mode configuration (models, concurrency, budget)" },
  { value: "export", label: "export", description: "Open live dashboard in browser" },
  { value: "parallel-best-of-n", label: "parallel-best-of-n", description: "Try N hypotheses at once, keep the best" },
  { value: "parallel-stack", label: "parallel-stack", description: "Stack independent file-scoped optimizations" },
  { value: "parallel-search", label: "parallel-search", description: "Beam search (K states × M candidates)" },
];

export function filterSubcommands(prefix: string): AutocompleteEntry[] {
  if (!prefix) return AUTORESEARCH_SUBCOMMANDS;
  const lower = prefix.toLowerCase();
  return AUTORESEARCH_SUBCOMMANDS.filter(function (s) { return s.value.toLowerCase().startsWith(lower); });
}

// ─── i18n ────────────────────────────────────────────────────────────────────

function detectRu(): boolean {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
  return locale.toLowerCase().startsWith("ru");
}

const RU = detectRu();

const L = {
  // Main menu
  presets: RU ? "📦 Пресеты..." : "📦 Presets...",
  models: RU ? "🔧 Модели (индивидуально)..." : "🔧 Models (individual)...",
  concurrency: RU ? "⚡ Конкурентность..." : "⚡ Concurrency...",
  budget: RU ? "⏱️  Бюджет..." : "⏱️  Budget...",
  observer: RU ? "📊 Настройки наблюдателя..." : "📊 Observer settings...",
  done: RU ? "✅ Готово" : "✅ Done",
  back: RU ? "↩️ Назад" : "↩️ Back",
  reset: RU ? "♻️ Сбросить к дефолтам" : "♻️ Reset to defaults",

  // Headers
  configTitle: RU ? "Конфигурация параллельного режима" : "Parallel Configuration",
  currentLabel: RU ? "Текущие:" : "Current:",
  observerTitle: RU ? "Настройки наблюдателя — что настроить?" : "Observer Settings — what to configure?",
  choosePreset: RU ? "Выберите пресет" : "Choose a preset",
  whichTier: RU ? "Какой тир изменить?" : "Which tier to change?",
  modelFor: RU ? "Модель для тира" : "Model for",
  tier: RU ? "тир" : "tier",

  // Presets
  presetBudget: RU ? "💰 Бюджет" : "💰 Budget",
  presetBudgetDesc: RU ? "Везде deepseek-flash — дешевле всего" : "All deepseek-flash — cheapest",
  presetBalanced: RU ? "⚖️ Сбалансированный" : "⚖️ Balanced",
  presetBalancedDesc: RU ? "Flash для воркеров + GLM для сложного — рекомендуется" : "Flash for workers + GLM for complex — recommended",
  presetPremium: RU ? "🚀 Премиум" : "🚀 Premium",
  presetPremiumDesc: RU ? "GLM везде — лучшее качество, выше цена" : "GLM everywhere — best quality, highest cost",
  presetApplied: RU ? "пресет применён" : "preset applied",
  noChange: RU ? "Без изменений" : "No change",
  configSaved: RU ? "Конфиг сохранён." : "Config saved.",

  // Concurrency
  concAuto: RU ? "авто" : "auto",
  concEnter: RU ? "Введите число (1-16) или \"auto\":" : "Enter a number (1-16) or \"auto\":",

  // Budget
  budgetEnter: RU ? "Введите число (30-600):" : "Enter a number (30-600):",
  budgetInvalid: RU ? "Неверный бюджет (30-600 секунд)" : "Invalid budget (30-600 seconds)",

  // Observer
  observerReset: RU ? "Сбросить пороги наблюдателя к дефолтам?" : "Reset all observer thresholds to defaults?",
  observerResetTitle: RU ? "Сброс наблюдателя" : "Reset observer",
  observerResetDone: RU ? "Настройки наблюдателя сброшены" : "Observer settings reset to defaults",
  observerRange: RU ? "Диапазон" : "Range",
  observerDefault: RU ? "Дефолт" : "Default",
  observerEnter: RU ? "Введите новое значение:" : "Enter new value:",
  observerInvalid: RU ? "Неверное значение" : "Invalid value",

  // Errors
  errorPrefix: RU ? "Ошибка: " : "Error: ",
  requiresTui: RU ? "Интерактивная настройка требует TUI режим. Отредактируйте .auto/config.json вручную." : "Interactive config requires TUI mode. Edit .auto/config.json manually.",
};

// ─── Presets ─────────────────────────────────────────────────────────────────

interface Preset {
  label: string;
  description: string;
  tiers: Record<Tier, string>;
}

function getPresets(): Preset[] {
  return [
    { label: L.presetBudget, description: L.presetBudgetDesc, tiers: { fast: "opencode-go/deepseek-v4-flash:low", mid: "opencode-go/deepseek-v4-flash:xhigh", strong: "opencode-go/deepseek-v4-flash:xhigh" } },
    { label: L.presetBalanced, description: L.presetBalancedDesc, tiers: { fast: "opencode-go/deepseek-v4-flash:low", mid: "opencode-go/deepseek-v4-flash:xhigh", strong: "zai-glm/glm-5.2:high" } },
    { label: L.presetPremium, description: L.presetPremiumDesc, tiers: { fast: "zai-glm/glm-5.2:low", mid: "zai-glm/glm-5.2:high", strong: "zai-glm/glm-5.2:high" } },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readConfig(workDir: string): Record<string, unknown> {
  const configPath = path.join(workDir, ".auto", "config.json");
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

function writeConfig(workDir: string, config: Record<string, unknown>): void {
  const configDir = path.join(workDir, ".auto");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getConfigParallel(workDir: string): ParallelConfig {
  return resolveConfig(readConfig(workDir));
}

function formatCurrent(cfg: ParallelConfig): string {
  const conc = cfg.concurrency ?? L.concAuto;
  return [
    "  fast:   " + cfg.tiers.fast,
    "  mid:    " + cfg.tiers.mid,
    "  strong: " + cfg.tiers.strong,
    "  " + (RU ? "конкурентность" : "concurrency") + ": " + conc,
    "  " + (RU ? "бюджет" : "budget") + ": " + cfg.budgetSeconds + "s",
  ].join("\n");
}

// ─── Sub-menus ───────────────────────────────────────────────────────────────

async function configurePresets(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const presets = getPresets();
  const options = presets.map(function (p) { return p.label + " — " + p.description; }).concat([L.back]);
  const choice = await ctx.ui.select(L.choosePreset + " (current: " + cfg.tiers.fast + " / " + cfg.tiers.mid + " / " + cfg.tiers.strong + ")", options);
  if (!choice || choice === L.back) return false;
  const preset = presets.find(function (p) { return choice.startsWith(p.label); });
  if (!preset) return false;
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  (raw.parallel as Record<string, unknown>).tiers = { ...preset.tiers };
  writeConfig(workDir, raw);
  ctx.ui.notify(preset.label + " " + L.presetApplied, "info");
  return true;
}

async function configureModels(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const tiers: Tier[] = ["fast", "mid", "strong"];
  const options = tiers.map(function (t) { return t + " (" + (RU ? "текущий" : "current") + ": " + cfg.tiers[t] + ")"; }).concat([L.back]);
  const choice = await ctx.ui.select(L.whichTier, options);
  if (!choice || choice === L.back) return false;
  const tier = tiers.find(function (t) { return choice.startsWith(t); });
  if (!tier) return false;
  const current = cfg.tiers[tier];
  const newModel = await ctx.ui.input(
    L.modelFor + " " + tier + " " + L.tier + "\n  format: provider/model:thinking",
    current,
  );
  if (!newModel || !newModel.trim() || newModel.trim() === current) {
    ctx.ui.notify(L.noChange, "info");
    return false;
  }
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  if (!(raw.parallel as Record<string, unknown>).tiers) (raw.parallel as Record<string, unknown>).tiers = { ...cfg.tiers };
  ((raw.parallel as Record<string, unknown>).tiers as Record<string, string>)[tier] = newModel.trim();
  writeConfig(workDir, raw);
  ctx.ui.notify(tier + " → " + newModel.trim(), "info");
  return true;
}

async function configureConcurrency(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.concurrency?.toString() ?? L.concAuto;
  const cpuCount = os.cpus().length;
  const autoVal = Math.max(1, Math.min(cpuCount - 1, 4));

  const title = [
    (RU ? "Конкурентность (текущая: " : "Concurrency (current: ") + current + ")",
    "",
    RU ? "Количество воркер-субагентов, работающих параллельно в" : "Number of worker subagents running in parallel during",
    "BestOfN, SpaceSearch, valleyProbe, CheckOrthogonal.",
    "",
    RU ? "Каждый воркер клонирует git worktree и независимо" : "Each worker clones a git worktree and runs measure.sh",
    RU ? "запускает measure.sh. Больше = быстрее, но больше нагрузка на CPU." : "independently. Higher = faster exploration, but more CPU load.",
    "",
    RU ? "Рекомендуемые значения:" : "Recommended values:",
    "  auto   = min(CPU-1, 4) = " + autoVal + " (" + (RU ? "ваши ядра" : "your cores") + ": " + cpuCount + ")",
    "  1-2    = " + (RU ? "безопасно для CPU-тяжёлых measure.sh (компиляция, обучение)" : "safe if measure.sh is CPU-heavy (compile, train)"),
    "  3-4    = " + (RU ? "хорошо для лёгких скриптов (парсинг, тесты)" : "good for lightweight scripts (parsing, tests)"),
    "  5+     = " + (RU ? "только если measure.sh I/O-bound или network-bound" : "only if measure.sh is I/O or network-bound"),
    "",
    L.concEnter,
  ].join("\n");

  const input = await ctx.ui.input(title, current);
  if (!input || !input.trim()) return false;
  const trimmed = input.trim();
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};

  if (trimmed.toLowerCase() === "auto" || trimmed === "0") {
    delete (raw.parallel as Record<string, unknown>).concurrency;
    writeConfig(workDir, raw);
    ctx.ui.notify((RU ? "Конкурентность: авто (min(CPU-1, 4) = " : "Concurrency: auto (min(CPU-1, 4) = ") + autoVal + ")", "info");
  } else {
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 1 || n > 16) { ctx.ui.notify(RU ? "Неверное число (1-16)" : "Invalid number (1-16)", "error"); return false; }
    (raw.parallel as Record<string, unknown>).concurrency = n;
    writeConfig(workDir, raw);
    ctx.ui.notify((RU ? "Конкурентность: " : "Concurrency: ") + n, "info");
  }
  return true;
}

async function configureBudget(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const cfg = getConfigParallel(workDir);
  const current = cfg.budgetSeconds.toString();

  const title = [
    (RU ? "Бюджет на замер в секундах (текущий: " : "Budget per measure in seconds (current: ") + current + "s)",
    "",
    RU ? "Максимальное время выполнения одного measure.sh." : "Maximum wall-clock time for a single measure.sh execution.",
    RU ? "При превышении запуск убивается (budget_exceeded)." : "If exceeded, the run is killed and logged as budget_exceeded.",
    "",
    RU ? "Бюджет применяется к обоим путям:" : "This budget applies to BOTH paths:",
    "  Worker (BENCH_MODE=quick) — " + (RU ? "быстрый subset" : "fast subset"),
    "  Parent (BENCH_MODE=full) — " + (RU ? "полный benchmark" : "complete benchmark"),
    "",
    RU ? "Если baseline превышает бюджет — параллельные раунды не стартуют." : "If the baseline itself exceeds this, parallel rounds will refuse to start.",
    RU ? "Лучше ускорить measure.sh (добавить BENCH_MODE=quick subset)." : "Fix measure.sh (add BENCH_MODE=quick subset) rather than raising the budget.",
    "",
    RU ? "Типичные значения:" : "Typical values:",
    "  60s    = " + (RU ? "быстрые скрипты (парсинг, unit-тесты)" : "quick scripts (parsing, small unit tests)"),
    "  120s   = " + (RU ? "умеренные (интеграционные тесты)" : "moderate (integration tests, medium datasets)"),
    "  300s   = " + (RU ? "дефолт (сборка + тесты, обучение)" : "default (build + test suites, training)"),
    "  600s   = " + (RU ? "тяжёлые (полные эпохи, большие benchmark)" : "heavy (full training epochs, large benchmarks)"),
    "",
    L.budgetEnter,
  ].join("\n");

  const input = await ctx.ui.input(title, current);
  if (!input || !input.trim()) return false;
  const n = parseInt(input.trim(), 10);
  if (isNaN(n) || n < 30 || n > 600) { ctx.ui.notify(L.budgetInvalid, "error"); return false; }
  const raw = readConfig(workDir);
  if (!raw.parallel) (raw as Record<string, unknown>).parallel = {};
  (raw.parallel as Record<string, unknown>).budgetSeconds = n;
  writeConfig(workDir, raw);
  ctx.ui.notify((RU ? "Бюджет: " : "Budget: ") + n + "s", "info");
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
  if (!(raw as Record<string, unknown>).observer) (raw as Record<string, unknown>).observer = {};
  ((raw as Record<string, unknown>).observer as Record<string, unknown>)[key] = value;
  writeConfig(workDir, raw);
}

function resetObserverConfig(ctx: ConfigCtx, workDir: string): void {
  const raw = readConfig(workDir);
  delete (raw as Record<string, unknown>).observer;
  writeConfig(workDir, raw);
  ctx.ui.notify(L.observerResetDone, "info");
}

interface ObserverField {
  key: string;
  label: string; labelRu: string;
  description: string; descriptionRu: string;
  default: number; min: number; max: number;
}

const OBSERVER_FIELDS: ObserverField[] = [
  { key: "finalize_strong_threshold", label: "Finalize: strong confidence", labelRu: "Финализация: строгая уверенность",
    description: "Agent confidence above this → strong /autoresearch off recommendation.", descriptionRu: "Уверенность агента выше этого → строгая рекомендация /autoresearch off.",
    default: 0.8, min: 0.5, max: 1.0 },
  { key: "finalize_advisory_threshold", label: "Finalize: advisory confidence", labelRu: "Финализация:Soft-уверенность",
    description: "Agent confidence above this → advisory finalize steer.", descriptionRu: "Уверенность агента выше этого → рекомендация финализации.",
    default: 0.5, min: 0.0, max: 0.8 },
  { key: "floor_streak_threshold", label: "Floor: min streak", labelRu: "Пол: мин. серия",
    description: "Non-improving runs before floor detection can trigger.", descriptionRu: "Серия без улучшений до проверки пола.",
    default: 15, min: 3, max: 50 },
  { key: "floor_cv_threshold", label: "Floor: variance threshold (CV)", labelRu: "Пол: порог вариативности (CV)",
    description: "Coefficient of variation below which metric is considered plateaued.", descriptionRu: "Коэффициент вариации, ниже которого метрика считается вышедшей на плато.",
    default: 0.15, min: 0.01, max: 0.5 },
  { key: "noise_gate_margin", label: "Noise gate: margin", labelRu: "Шумовой фильтр: запас",
    description: "System noise must exceed best metric × this factor to warn.", descriptionRu: "Системный шум должен превысить лучшую метрику × этот фактор.",
    default: 1.10, min: 1.0, max: 2.0 },
  { key: "stagnation_threshold", label: "Stagnation: interval", labelRu: "Стагнация: интервал",
    description: "Non-improving runs between each stagnation escalation steer.", descriptionRu: "Серия без улучшений между эскалациями стагнации.",
    default: 5, min: 3, max: 20 },
];

async function configureObserver(ctx: ConfigCtx, workDir: string): Promise<boolean> {
  const obsConfig = readObserverSection(workDir);
  const options = OBSERVER_FIELDS.map(function (f) {
    const label = RU ? f.labelRu : f.label;
    const current = typeof obsConfig[f.key] === "number" ? obsConfig[f.key] as number : f.default;
    return label + " (" + (RU ? "текущий" : "current") + ": " + current + ")";
  }).concat([L.reset, L.back]);

  const choice = await ctx.ui.select(L.observerTitle, options);
  if (!choice || choice === L.back) return false;

  if (choice === L.reset) {
    const confirmed = await ctx.ui.confirm(L.observerResetTitle, L.observerReset);
    if (confirmed) resetObserverConfig(ctx, workDir);
    return true;
  }

  const field = OBSERVER_FIELDS.find(function (f) { const label = RU ? f.labelRu : f.label; return choice.startsWith(label); });
  if (!field) return false;

  const label = RU ? field.labelRu : field.label;
  const desc = RU ? field.descriptionRu : field.description;
  const currentValue = typeof obsConfig[field.key] === "number" ? obsConfig[field.key] as number : field.default;

  const title = [
    label + " (" + (RU ? "текущий" : "current") + ": " + currentValue + ")",
    "",
    desc,
    "",
    L.observerRange + ": " + field.min + " - " + field.max + "  |  " + L.observerDefault + ": " + field.default,
    "",
    L.observerEnter,
  ].join("\n");

  const input = await ctx.ui.input(title, String(currentValue));
  if (!input || !input.trim()) return false;
  const n = parseFloat(input.trim());
  if (isNaN(n) || n < field.min || n > field.max) {
    ctx.ui.notify(L.observerInvalid + " (" + L.observerRange + ": " + field.min + " - " + field.max + ")", "error");
    return false;
  }
  writeObserverField(workDir, field.key, n);
  ctx.ui.notify(label + " → " + n, "info");
  return true;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function interactiveParallelConfig(ctx: ConfigCtx, workDir: string): Promise<void> {
  const cfg = getConfigParallel(workDir);
  ctx.ui.notify((RU ? "Конфигурация:\n" : "Parallel Config:\n") + formatCurrent(cfg), "info");

  while (true) {
    const current = getConfigParallel(workDir);
    const header = L.configTitle + "\n\n" + L.currentLabel + "\n" + formatCurrent(current) + "\n";

    const choice = await ctx.ui.select(header, [L.presets, L.models, L.concurrency, L.budget, L.observer, L.done]);
    if (!choice || choice === L.done) break;

    try {
      switch (choice) {
        case L.presets: await configurePresets(ctx, workDir); break;
        case L.models: await configureModels(ctx, workDir); break;
        case L.concurrency: await configureConcurrency(ctx, workDir); break;
        case L.budget: await configureBudget(ctx, workDir); break;
        case L.observer: await configureObserver(ctx, workDir); break;
      }
    } catch (e) {
      ctx.ui.notify(L.errorPrefix + (e instanceof Error ? e.message : String(e)), "error");
    }
  }

  const finalCfg = getConfigParallel(workDir);
  ctx.ui.notify(L.configSaved + "\n" + formatCurrent(finalCfg), "info");
}
