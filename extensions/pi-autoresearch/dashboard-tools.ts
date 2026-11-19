/** Dashboard overlay + local HTTP server (extracted from index.ts, bd tj0.13).
 *
 *  Every value mutable across an extension session (template/logo caches,
 *  server handle/port/workdir/html path, expedition flag, SSE clients and the
 *  fullscreen spinner/overlay pointers) lives INSIDE createDashboardTools, so
 *  two fake-pi instances in one process never share dashboard state. Extension
 *  collaborators arrive through getter-backed `deps` and are read at the point
 *  of use — never destructured into a local snapshot. All user-visible strings
 *  and the wire behavior of /, /events and /expedition are unchanged.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { extractAutoresearchSessionName } from "./jsonl.ts";
import { buildExpeditionView, type ExpeditionView } from "./expedition-view.ts";
import { type ExpeditionWebCampaign } from "./dashboard-web.ts";

type ExpeditionPayload = ExpeditionView & {
  schema_version: number;
  campaigns: ExpeditionWebCampaign[];
  chainStatus: string | null;
};

/** Extension-local collaborators injected by index.ts (getter-backed there). */
export interface DashboardToolsDeps {
  readonly getRuntime: (ctx: ExtensionContext) => any;
  readonly resolveWorkDir: (cwd: string) => string;
  readonly autoresearchJsonlPath: (dir: string) => string;
  readonly renderDashboardLines: (state: any, width: number, theme: Theme, maxRows: number, headerHints: string[], scale: any, floor: any) => string[];
  readonly measurementScaleStatusOfDir: (dir: string) => any;
  readonly noiseFloorStatusOfDir: (dir: string) => any;
  readonly formatElapsed: (ms: number) => string;
  readonly SPINNER: readonly string[];
  readonly getTuiSize: (tui: any) => { width: number; height: number };
  readonly truncateToWidth: (text: string, width: number, ellipsis: string, pad: boolean) => string;
  readonly visibleWidth: (text: string) => number;
  readonly matchesKey: (data: string, key: string) => boolean;
  readonly clamp: (value: number, min: number, max: number) => number;
  readonly truncateDisplayText: (text: string, width: number) => string;
  readonly buildExpeditionView: (chainDir: string, campaignDir: string | null) => ExpeditionView;
  readonly buildExpeditionHtml: (view: ExpeditionView, campaigns: ExpeditionWebCampaign[]) => string;
  readonly scanExpeditionChains: (root: string) => any;
  readonly researchRoot: (workDir: string) => string;
  readonly overlayTui: { requestRender: () => void } | null;
  readonly setOverlayTui: (tui: { requestRender: () => void } | null) => void;
  readonly spinnerInterval: ReturnType<typeof setInterval> | null;
  readonly setSpinnerInterval: (interval: ReturnType<typeof setInterval> | null) => void;
  readonly spinnerFrame: number;
  readonly setSpinnerFrame: (frame: number) => void;
  readonly clearOverlay: () => void;
}

export interface DashboardTools {
  canOpenFullscreenDashboard: (ctx: ExtensionContext) => boolean;
  openFullscreenDashboard: (ctx: ExtensionContext) => Promise<void>;
  stopDashboardServer: () => void;
  broadcastDashboardUpdate: (workDir: string) => void;
  buildExpeditionPayload: (workDir: string) => ExpeditionPayload | null;
  exportDashboard: (ctx: ExtensionContext) => Promise<void>;
  expeditionForWeb: (ctx: ExtensionContext) => boolean;
  openExpeditionWebDashboard: (ctx: ExtensionContext) => Promise<void>;
}

export function createDashboardTools(deps: DashboardToolsDeps): DashboardTools {
  // -----------------------------------------------------------------------
  // Fullscreen scrollable dashboard overlay
  // -----------------------------------------------------------------------

  function canOpenFullscreenDashboard(ctx: ExtensionContext): boolean {
    const mode = (ctx as ExtensionContext & { mode?: string }).mode;
    return mode === undefined ? ctx.hasUI : mode === "tui";
  }

  async function openFullscreenDashboard(ctx: ExtensionContext): Promise<void> {
    if (!canOpenFullscreenDashboard(ctx)) {
      ctx.ui.notify("The fullscreen dashboard is only available in TUI mode", "info");
      return;
    }

    const runtime = deps.getRuntime(ctx);
    const state = runtime.state;
    if (!runtime.autoresearchMode) {
      ctx.ui.notify("Autoresearch mode is not active", "info");
      return;
    }
    if (state.results.length === 0) {
      ctx.ui.notify("No experiments yet", "info");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
      let scrollOffset = 0;
      let lastViewportRows = 8;
      let lastTotalRows = 0;
      deps.setOverlayTui(tui);

      deps.setSpinnerInterval(setInterval(() => {
        deps.setSpinnerFrame((deps.spinnerFrame + 1) % deps.SPINNER.length);
        if (runtime.runningExperiment) tui.requestRender();
      }, 80));

      const buildOverlayContent = (renderWidth: number): string[] => {
        const content = deps.renderDashboardLines(state, renderWidth, theme, 0, [], deps.measurementScaleStatusOfDir(deps.resolveWorkDir(ctx.cwd)), deps.noiseFloorStatusOfDir(deps.resolveWorkDir(ctx.cwd)));
        if (runtime.runningExperiment) {
          const elapsed = deps.formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
          const frame = deps.SPINNER[deps.spinnerFrame % deps.SPINNER.length];
          const nextIdx = state.results.length + 1;
          content.push(
            deps.truncateToWidth(
              `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                theme.fg("warning", `${frame} running… ${elapsed}`),
              renderWidth,
              "…",
              true
            )
          );
        }
        return content;
      };

      return {
        render(width: number): string[] {
          const { height } = deps.getTuiSize(tui);
          const safeWidth = Math.max(1, width || deps.getTuiSize(tui).width);
          // Match overlayOptions.maxHeight so pi doesn't clip the footer.
          const overlayRows = Math.max(4, Math.floor(height * 0.9));
          const viewportRows = Math.max(1, overlayRows - 3);
          const content = buildOverlayContent(Math.max(4, safeWidth - 2));

          const totalRows = content.length;
          const maxScroll = Math.max(0, totalRows - viewportRows);
          scrollOffset = deps.clamp(scrollOffset, 0, maxScroll);
          lastViewportRows = viewportRows;
          lastTotalRows = totalRows;

          const out: string[] = [];

          // Full box border: the overlay floats over the transcript, so every
          // row must be padded to full width or the background bleeds through.
          const innerWidth = Math.max(4, safeWidth - 2);
          const border = (text: string) => theme.fg("border", text);
          const boxRow = (line: string): string => {
            const clipped = deps.truncateToWidth(line, innerWidth, "…", true);
            const pad = " ".repeat(Math.max(0, innerWidth - deps.visibleWidth(clipped)));
            return border("│") + clipped + pad + border("│");
          };

          const title = deps.truncateDisplayText(
            `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, innerWidth - 2)
          );

          out.push(border(`╭${"─".repeat(innerWidth)}╮`));
          out.push(boxRow(` ${theme.fg("accent", title)}`));

          const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
          for (const line of visible) out.push(boxRow(line));
          for (let i = visible.length; i < viewportRows; i++) out.push(boxRow(""));

          const scrollInfo = totalRows > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
            : "";
          const helpText = safeWidth >= 85
            ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
            : ` j/k scroll • esc close${scrollInfo} `;
          const footFill = Math.max(0, safeWidth - 2 - deps.visibleWidth(helpText));

          out.push(
            deps.truncateToWidth(
              border("╰" + "─".repeat(footFill)) + theme.fg("dim", helpText) + border("╯"),
              safeWidth,
              "…",
              true
            )
          );

          return out;
        },

        handleInput(data: string): void {
          const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

          if (deps.matchesKey(data, "escape") || data === "q") {
            done(undefined);
            return;
          }
          if (deps.matchesKey(data, "up") || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if (deps.matchesKey(data, "down") || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if (deps.matchesKey(data, "pageUp") || data === "u") {
            scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
          } else if (deps.matchesKey(data, "pageDown") || data === "d") {
            scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          tui.requestRender();
        },

        invalidate(): void { try { tui.requestRender(); } catch { /* headless */ } },

        dispose(): void {
          deps.clearOverlay();
        },
      };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center" as const,
        },
      }
    );
  }

  // -----------------------------------------------------------------------
  // Export: local live dashboard
  // -----------------------------------------------------------------------

  const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
  const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

  let cachedPackageRoot: string | null = null;

  function packageRoot(): string {
    if (cachedPackageRoot) return cachedPackageRoot;
    const extensionDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    cachedPackageRoot = path.resolve(extensionDir, "../..");
    return cachedPackageRoot;
  }

  function templatePath(): string {
    return path.join(packageRoot(), "assets/template.html");
  }

  function readTemplate(): string {
    return fs.readFileSync(templatePath(), "utf-8");
  }

  let cachedLogoDataUrl: string | null = null;

  function logoDataUrl(): string {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    const logoPath = path.join(packageRoot(), "assets/logo.webp");
    const bytes = fs.readFileSync(logoPath);
    cachedLogoDataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
    return cachedLogoDataUrl;
  }

  function readJsonlContent(workDir: string): string {
    return fs.readFileSync(deps.autoresearchJsonlPath(workDir), "utf-8").trim();
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectDataIntoTemplate(template: string, title: string): string {
    const escapedTitle = escapeHtml(title);
    return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
  }

  let dashboardServer: Server | null = null;
  let dashboardServerPort: number | null = null;
  let dashboardServerWorkDir: string | null = null;
  let dashboardServerHtmlPath: string | null = null;
  /** True while the running dashboard serves the expedition page: the
   *  /expedition route then answers with the honest damage payload instead
   *  of 404 when the chain journal breaks while the page is open (spec). */
  let dashboardServerExpedition = false;
  const dashboardSseClients = new Set<ServerResponse>();

  function openInBrowser(url: string): void {
    // bd pi-autoresearch-dif: npm test executed the dashboard handler and
    // REALLY opened Firefox on a port that died with the test process —
    // every test run popped a console window and a dead-port tab. The env
    // guard makes the side effect opt-out for tests/CI; the URL is still
    // printed via notify so nothing is lost.
    if (process.env.PI_AUTORESEARCH_NO_BROWSER) return;
    const child = process.platform === "win32"
      // rundll32 without shell: no console window flash (windowsHide alone
      // does not help with `cmd /c start`, the shell IS the console).
      ? spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
    // Swallow launcher errors (e.g. xdg-open missing); caller prints the URL
    // so the user can open it manually.
    child.on("error", () => { /* ignore */ });
    child.unref();
  }

  function stopDashboardServer(): void {
    for (const client of dashboardSseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    dashboardSseClients.clear();

    if (dashboardServer) {
      try { dashboardServer.close(); } catch { /* ignore */ }
    }

    dashboardServer = null;
    dashboardServerPort = null;
    dashboardServerWorkDir = null;
    dashboardServerHtmlPath = null;
    dashboardServerExpedition = false;
  }

  function writeDashboardFile(workDir: string): string {
    const jsonlContent = readJsonlContent(workDir);
    const sessionName = extractAutoresearchSessionName(jsonlContent);
    const html = injectDataIntoTemplate(readTemplate(), sessionName)
      .replace(LOGO_PLACEHOLDER, logoDataUrl());
    const exportDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-dashboard-"));
    const dest = path.join(exportDir, "index.html");
    fs.writeFileSync(dest, html);
    return dest;
  }

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".jsonl": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
  };

  function fileContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  function resolveServedFile(workDir: string, requestPath: string): string | null {
    if (requestPath === "/") return dashboardServerHtmlPath;
    if (requestPath === "/autoresearch.jsonl") return deps.autoresearchJsonlPath(workDir);
    // Expedition live JSON: not a file — the request handler builds it on
    // the fly when it sees this marker (see the "json:/expedition" branch
    // inside startStaticServer).
    if (requestPath === "/expedition") return "json:/expedition";
    return null;
  }

  /** One campaign entry of the /expedition payload (fail-soft per campaign:
   *  a broken directory degrades to phase null, empty questions, zero
   *  evidence — never to a damaged whole payload). */
  function expeditionCampaignPayload(campaignRoot: string, id: string): ExpeditionWebCampaign {
    const dir = path.join(campaignRoot, id);
    let phase: string | null = null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
      if (typeof state?.phase === "string") phase = state.phase;
    } catch { /* unreadable state → phase null */ }
    let q: ExpeditionWebCampaign["q"] = [];
    try {
      const brief = JSON.parse(fs.readFileSync(path.join(dir, "brief.json"), "utf8"));
      q = (Array.isArray(brief?.questions) ? brief.questions : []).map((question: { id?: unknown; text?: unknown }) => ({
        id: typeof question?.id === "string" ? question.id : "",
        text: typeof question?.text === "string" ? question.text : "",
        verdict: null as string | null,
        rule: null as string | null,
        reason: null as string | null,
      })).filter((question: ExpeditionWebCampaign["q"][number]) => question.id.length > 0);
    } catch { /* broken brief → empty questions */ }
    if (q.length > 0 || phase !== null) {
      try {
        const log = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8");
        const verdicts = new Map<string, string>();
        const rules = new Map<string, string>();
        const reasons = new Map<string, string>();
        for (const line of log.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let ev: { event?: unknown; question_id?: unknown; verdict?: unknown; rule_id?: unknown; reason?: unknown } | null = null;
          try { ev = JSON.parse(line); } catch { continue; }
          const id = typeof ev?.question_id === "string" ? ev.question_id : null;
          if (id === null) continue;
          const action = typeof ev?.event === "string" ? ev.event : "";
          if (action === "close") {
            verdicts.set(id, typeof ev?.verdict === "string" ? ev.verdict : "");
            if (typeof ev?.rule_id === "string" && ev.rule_id !== "") rules.set(id, ev.rule_id);
            if (typeof ev?.reason === "string" && ev.reason !== "") reasons.set(id, ev.reason);
          }
          else if (action === "open") { verdicts.delete(id); rules.delete(id); reasons.delete(id); }
        }
        q = q.map((question: ExpeditionWebCampaign["q"][number]) => ({ ...question, verdict: verdicts.get(question.id) ?? null, rule: rules.get(question.id) ?? null, reason: reasons.get(question.id) ?? null }));
      } catch { /* unreadable log → verdicts stay null */ }
    }
    let evidenceCount = 0;
    try { evidenceCount = fs.readdirSync(path.join(dir, "evidence")).filter((name) => fs.statSync(path.join(dir, "evidence", name)).isFile()).length; } catch { /* missing evidence dir → 0 */ }
    return { id, phase, q, evidenceCount };
  }

  /** The /expedition JSON payload: ExpeditionView + the per-campaign array
   *  (expedition-tui spec group 4 + the wiring contract). One shared builder
   *  serves BOTH the initial page and the live route, so they can never drift.
   *  Returns null when NO expedition chain exists on disk at all (any final
   *  status qualifies: the dashboard opens for stopped/completed chains too,
   *  bd pi-autoresearch owner request 2026-11-12). */
  function buildExpeditionPayload(workDir: string): ExpeditionPayload | null {
    // ANY final status: the dashboard opens for stopped/completed expeditions
    // too (owner request 2026-11-12); null only when no expedition exists at all.
    const scan = deps.scanExpeditionChains(path.join(workDir, ".auto", "research-chain"));
    if (scan === "root_missing" || scan.chains.length === 0) return null;
    const chain = scan.chains[0];
    const chainDir = path.join(workDir, ".auto", "research-chain", chain.chainId);
    // The pinned campaign only affects the CAMPAIGN section; the map timeline
    // and the campaign strip come from the journal, so a null pin is fine.
    let campaignDir: string | null = null;
    if (chain.campaignId) {
      const dir = path.join(deps.researchRoot(workDir), chain.campaignId);
      if (fs.existsSync(dir)) campaignDir = dir;
    }
    const view = deps.buildExpeditionView(chainDir, campaignDir);
    // Presentation refinement (web only): the replay keeps `campaign` only on
    // events that carry it, so closed directions lose the activation campaign.
    // The close refs always name the proven campaign — use it for the card
    // meta when the direction itself no longer has one.
    const dirs = view.dirs.map((d) =>
      d.campaign === null && d.refs.length > 0 && typeof d.refs[0]?.campaign === "string"
        ? { ...d, campaign: d.refs[0].campaign }
        : d
    );
    const campaignRoot = deps.researchRoot(workDir);
    let campaignIds: string[] = [];
    try {
      const journal = fs.readFileSync(path.join(chainDir, "chain.json"), "utf8");
      for (const line of journal.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; campaign_id?: unknown };
          if (entry?.type === "campaign_added" && typeof entry.campaign_id === "string" && !campaignIds.includes(entry.campaign_id)) campaignIds.push(entry.campaign_id);
        } catch { /* broken line: skipped, the scan already proved the chain usable */ }
      }
    } catch { /* unreadable journal here → the view's own fail payload already reports damage */ }
    if (view.fail === "journal") campaignIds = [];
    const campaigns = campaignIds.map((id) => expeditionCampaignPayload(campaignRoot, id));
    return { schema_version: 1, ...view, dirs, campaigns, chainStatus: chain.status };
  }

  function registerSseClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    dashboardSseClients.add(res);
    res.on("close", () => dashboardSseClients.delete(res));
  }

  function broadcastDashboardUpdate(workDir: string): void {
    if (!dashboardServer || dashboardServerWorkDir !== workDir) return;
    for (const res of dashboardSseClients) {
      try {
        res.write("event: jsonl-updated\n");
        res.write(`data: ${Date.now()}\n\n`);
      } catch {
        dashboardSseClients.delete(res);
      }
    }
  }

  function startStaticServer(workDir: string, dashboardHtmlPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const resolvedWorkDir = path.resolve(workDir);
      const resolvedDashboardHtmlPath = path.resolve(dashboardHtmlPath);

      if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
        dashboardServerHtmlPath = resolvedDashboardHtmlPath;
        resolve(dashboardServerPort);
        return;
      }

      stopDashboardServer();
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/events") {
          registerSseClient(res);
          return;
        }

        const filePath = resolveServedFile(resolvedWorkDir, url.pathname);
        if (!filePath) {
          res.writeHead(404);
          res.end();
          return;
        }

        // Live expedition JSON: built on the fly from the current files
        // (spec: "JSON текущего view, собранного на лету"). A damaged journal
        // yields the fail payload, never a 500 — the page shows the damage
        // banner. Outside an expedition session the route 404s like any
        // unknown path (the server then serves the ordinary ledger page).
        if (filePath === "json:/expedition") {
          const payload = buildExpeditionPayload(resolvedWorkDir);
          if (payload === null) {
            if (dashboardServerExpedition) {
              // The dashboard was opened for an expedition whose journal
              // cannot be read anymore (damage while the page was open):
              // serve the honest damage payload (spec scenario).
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ schema_version: 1, fail: "journal", mapError: null, goal: "", dirs: [], timeline: [], timelineTotal: 0, campaignId: null, campaignState: "none", campaignPhase: null, questions: [], evidence: [], counters: { done: 0, total: 0, campaignsUsed: 0, campaignsMax: null, qClosed: 0, qTotal: 0, next: "" }, campaigns: [], chainStatus: null }));
              return;
            }
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload));
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": fileContentType(filePath) });
          res.end(data);
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to bind dashboard server"));
          return;
        }
        dashboardServer = server;
        dashboardServerPort = address.port;
        dashboardServerWorkDir = resolvedWorkDir;
        resolve(address.port);
      });

      server.on("error", reject);
    });
  }

  async function exportDashboard(ctx: ExtensionContext): Promise<void> {
    const workDir = deps.resolveWorkDir(ctx.cwd);
    const jsonlPath = deps.autoresearchJsonlPath(workDir);

    if (!fs.existsSync(jsonlPath)) {
      ctx.ui.notify(`No ${path.basename(jsonlPath)} found \u2014 run some experiments first`, "error");
      return;
    }

    try {
      const dashboardHtmlPath = writeDashboardFile(workDir);
      const port = await startStaticServer(workDir, dashboardHtmlPath);
      dashboardServerExpedition = false; // this server now serves the ledger page
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(`Dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  /** Detects an expedition for the web dashboard: the runtime pin first, then
   *  the fail-closed disk scan over ALL expedition chains regardless of the
   *  final status — the dashboard opens for stopped/completed expeditions too
   *  (owner request 2026-11-12). A restart loses the pin but the chain stays
   *  on disk — same fallback as the widget restore. */
  const expeditionForWeb = (ctx: ExtensionContext): boolean => {
    const runtime = deps.getRuntime(ctx);
    if (runtime.researchChain?.expedition === true) return true;
    const workDir = deps.resolveWorkDir(ctx.cwd);
    const scan = deps.scanExpeditionChains(path.join(workDir, ".auto", "research-chain"));
    return scan !== "root_missing" && scan.chains.length > 0;
  };

  /** Expedition branch of the web dashboard (expedition-tui spec group 4).
   *  NEW headless gate — only this branch refuses without UI; the ordinary
   *  ledger export keeps its existing behaviour untouched. Reuses the same
   *  static server (same workDir → same URL; different workDir → replacement)
   *  and the existing SSE «jsonl-updated» + the page's own 10s polling: no new
   *  broadcast points. */
  async function openExpeditionWebDashboard(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Expedition web dashboard requires a TUI session", "info");
      return;
    }
    try {
      const workDir = deps.resolveWorkDir(ctx.cwd);
      const payload = buildExpeditionPayload(workDir);
      // The ANY-STATUS expedition check made the branch (stopped/completed
      // chains included); a damaged journal still shows the honest damage
      // banner on the page (spec scenario), so we proceed.
      const viewForPage: ExpeditionView = payload ?? {
        fail: "journal", mapError: null, goal: "", dirs: [], timeline: [], timelineTotal: 0,
        campaignId: null, campaignState: "none", campaignPhase: null, questions: [], evidence: [],
        counters: { done: 0, total: 0, campaignsUsed: 0, campaignsMax: null, qClosed: 0, qTotal: 0, next: "" },
      };
      const campaignsForPage: ExpeditionWebCampaign[] = payload?.campaigns ?? [];
      const html = deps.buildExpeditionHtml(viewForPage, campaignsForPage);
      const exportDir = fs.mkdtempSync(path.join(tmpdir(), "pi-autoresearch-expedition-"));
      const htmlPath = path.join(exportDir, "expedition.html");
      fs.writeFileSync(htmlPath, html);
      const port = await startStaticServer(workDir, htmlPath);
      dashboardServerExpedition = true; // both fresh and reused server: the route serves expedition JSON
      const url = `http://127.0.0.1:${port}`;
      openInBrowser(url);
      ctx.ui.notify(`Expedition dashboard at ${url} (live updates)`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Expedition dashboard failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  return {
    canOpenFullscreenDashboard,
    openFullscreenDashboard,
    stopDashboardServer,
    broadcastDashboardUpdate,
    buildExpeditionPayload,
    exportDashboard,
    expeditionForWeb,
    openExpeditionWebDashboard,
  };
}
