import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakePi, makeCtx } from './fake-pi.ts';
import * as expedition from '../extensions/pi-autoresearch/expedition.ts';

const extensionModule = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href);
// Register one test-hook instance at load time; bd tj0.10 made the module
// exports accessors, so the accessor calls below pass this pi explicitly.
const bootstrapPi = (() => {
  const { pi } = createFakePi({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'expweb-init-')), sessionId: 'expweb-init', realGit: false });
  extensionModule.default(pi);
  return pi;
})();

/** Sources of every current extension module: index.ts plus extracted files. */
function extensionModules() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts')) found.push({ file: path.basename(abs), src: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch'));
  return found;
}
const allExtensionSources = () => extensionModules().map((m) => m.src).join('\n');
const moduleContaining = (needle) => {
  const found = extensionModules().find((m) => m.src.includes(needle));
  assert.ok(found, `expected a current module containing ${needle}`);
  return found.src;
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
const brief = {
  schema_version: 1, goal: 'g', plan_source: 'p', caveat_block: 'c',
  data_roles: { explore: [], validate: [], confirm: [] },
  questions: [{ id: 'Q1', text: 'Question one?', decision_rules: [], needs_data: null }],
  process_metrics: [], stop_rules: [],
};

/** Seeds a full expedition workDir: chain journal + marker + research root with
 *  two campaigns (one healthy research campaign with a closed question, one
 *  stopped). Returns the workDir and the important paths. */
const seedExpeditionWorkDir = () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expweb-'));
  const chainId = 'exp-test-chain';
  const chainDir = path.join(workDir, '.auto', 'research-chain', chainId);
  fs.mkdirSync(chainDir, { recursive: true });
  const entries = [
    { type: 'chain_created', root_campaign_id: 'c0', at: '2026-11-12T03:03:00.000Z' },
    { type: 'expedition_created', goal: 'Explore the lens', doc_sha256: 'a'.repeat(64), at: '2026-11-12T03:03:10.000Z' },
    { type: 'direction_opened', dir: 'D1', why: 'first basis', at: '2026-11-12T03:04:00.000Z' },
    { type: 'direction_activated', dir: 'D1', campaign: 'c0', why: 'start', at: '2026-11-12T03:05:00.000Z' },
    { type: 'campaign_added', campaign_id: 'c0', at: '2026-11-12T03:05:10.000Z' },
    { type: 'direction_resolved', dir: 'D1', refs: [{ campaign: 'c0', question: 'Q1' }], at: '2026-11-12T04:00:00.000Z' },
    { type: 'direction_opened', dir: 'D2', why: 'second basis', at: '2026-11-12T04:01:00.000Z' },
    { type: 'direction_activated', dir: 'D2', campaign: 'c2', why: 'next', at: '2026-11-12T04:02:00.000Z' },
    { type: 'campaign_added', campaign_id: 'c2', at: '2026-11-12T04:02:10.000Z' },
    { type: 'status_change', status: 'active', at: '2026-11-12T04:03:00.000Z' },
  ];
  fs.writeFileSync(path.join(chainDir, 'chain.json'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  expedition.writeExpeditionMarker(chainDir, { goal: 'Explore the lens', docPath: 'doc.json', docSha256: 'a'.repeat(64), campaignId: 'c2', charter: { max_campaigns: 7, stop_rules: [] } });
  // Research root: c0 (stopped, Q1 confirmed), c2 (research, Q2 open)
  const researchRoot = path.join(workDir, '.auto', 'research');
  const seeds = [
    ['c0', 'stopped', [{ id: 'Q1', text: 'Question one?' }], [{ event: 'open', question_id: 'Q1', at: '1' }, { event: 'close', question_id: 'Q1', verdict: 'confirmed', rule_id: 'r1', at: '2' }]],
    ['c2', 'research', [{ id: 'Q2', text: 'Second?' }], [{ event: 'open', question_id: 'Q2', at: '3' }]],
  ];
  for (const [id, phase, qs, log] of seeds) {
    const dir = path.join(researchRoot, id);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schema_version: 1, campaign_id: id, created_at: 't', phase }) + '\n');
    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify({ ...brief, questions: qs }) + '\n');
    fs.writeFileSync(path.join(dir, 'log.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'evidence', 'eval.json'), '{}');
  }
  return { workDir, chainDir, chainId, researchRoot };
};

// ── resolveExpeditionPayload ─────────────────────────────────────────────────
const payloadOf = () => (workDir) => extensionModule.resolveExpeditionPayload(workDir, bootstrapPi);
test('resolveExpeditionPayload: full journal → dirs/campaigns/verdicts per the contract', () => {
  const f = seedExpeditionWorkDir();
  const payload = extensionModule.resolveExpeditionPayload(f.workDir, bootstrapPi);
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.fail, null);
  assert.equal(payload.goal, 'Explore the lens');
  // dirs: D1 resolved (campaign c0), D2 active (campaign c2)
  const d1 = payload.dirs.find((d) => d.name === 'D1');
  const d2 = payload.dirs.find((d) => d.name === 'D2');
  assert.equal(d1.status, 'resolved');
  assert.equal(d1.campaign, 'c0');
  assert.equal(d2.status, 'active');
  assert.equal(d2.campaign, 'c2');
  // campaigns: both chain campaigns, phase + questions + verdicts
  assert.deepEqual(payload.campaigns.map((c) => c.id).sort(), ['c0', 'c2']);
  const c0 = payload.campaigns.find((c) => c.id === 'c0');
  assert.equal(c0.phase, 'stopped');
  assert.equal(c0.q.length, 1);
  assert.equal(c0.q[0].verdict, 'confirmed');
  assert.equal(c0.evidenceCount, 1);
  const c2 = payload.campaigns.find((c) => c.id === 'c2');
  assert.equal(c2.phase, 'research');
  assert.equal(c2.q[0].verdict, null);
  // counters from the view
  assert.equal(payload.counters.total, 2);
  assert.equal(payload.counters.done, 1);
  assert.equal(payload.counters.campaignsUsed, 2);
});

test('resolveExpeditionPayload: broken campaign state.json → phase null, questions kept from the healthy brief (fail-soft per file)', () => {
  const f = seedExpeditionWorkDir();
  fs.writeFileSync(path.join(f.researchRoot, 'c2', 'state.json'), '{broken');
  const payload = payloadOf()(f.workDir);
  const c2 = payload.campaigns.find((c) => c.id === 'c2');
  assert.equal(c2.phase, null);
  // The brief is healthy: questions survive (independent try per file — same
  // fail-soft stance as expedition-view.ts). Verdicts stay null for the open Q2.
  assert.equal(c2.q.length, 1);
  assert.equal(c2.q[0].verdict, null);
  // the healthy campaign is unaffected
  const c0 = payload.campaigns.find((c) => c.id === 'c0');
  assert.equal(c0.phase, 'stopped');
  assert.equal(c0.q[0].verdict, 'confirmed');
});

test('resolveExpeditionPayload: damaged chain.json → null; the open-page route answers with the fail journal JSON (source-verified)', () => {
  const f = seedExpeditionWorkDir();
  fs.writeFileSync(path.join(f.chainDir, 'chain.json'), '\x00binary garbage\n');
  // A fully unreadable journal hides the chain from the scan: nothing active
  // to serve, so the direct payload is null (not a damage document).
  assert.equal(payloadOf()(f.workDir), null);
  // The spec damage scenario is about the ROUTE while the expedition page is
  // open: dashboardServerExpedition makes /expedition answer with the honest
  // fail:"journal" JSON instead of 404.
  const source = allExtensionSources();
  assert.match(source, /dashboardServerExpedition[\s\S]{0,600}fail: "journal"/, 'expedition route must answer damage with fail journal JSON');
});

test('resolveExpeditionPayload: no expedition on disk → null (not an error payload)', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expweb-none-'));
  assert.equal(extensionModule.resolveExpeditionPayload(workDir, bootstrapPi), null);
});

test('resolveExpeditionPayload: fully broken campaign dir → {phase:null, q:[], evidenceCount:0}', () => {
  const f = seedExpeditionWorkDir();
  fs.writeFileSync(path.join(f.researchRoot, 'c2', 'state.json'), '{broken');
  fs.writeFileSync(path.join(f.researchRoot, 'c2', 'brief.json'), '{broken');
  fs.writeFileSync(path.join(f.researchRoot, 'c2', 'log.jsonl'), '\x00garbage');
  fs.rmSync(path.join(f.researchRoot, 'c2', 'evidence'), { recursive: true, force: true });
  const payload = payloadOf()(f.workDir);
  const c2 = payload.campaigns.find((c) => c.id === 'c2');
  assert.deepEqual(c2, { id: 'c2', phase: null, q: [], evidenceCount: 0 });
});

// ── resolveServedFile /expedition route ──────────────────────────────────────
test('resolveServedFile: /expedition returns a non-null JSON-mode marker', () => {
  const source = allExtensionSources();
  assert.match(source, /json:\/expedition/, 'route must be answered with a json: marker');
});

// ── Command wiring ───────────────────────────────────────────────────────────
/** Loads the real extension and runs /autoresearch dashboard in a seeded expedition workDir. */
const runDashboardCommand = async (workDir, label, { hasUI = true } = {}) => {
  const { pi, tool, command } = createFakePi({ dir: workDir, sessionId: `expweb-${label}`, realGit: false });
  const ctx = makeCtx(workDir, `expweb-${label}`, pi);
  ctx.hasUI = hasUI;
  const { default: autoresearchExtension } = await import(
    pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href
  );
  autoresearchExtension(pi);
  await command('autoresearch').handler('dashboard', ctx);
  return { pi, ctx, command };
};

test('dashboard command with an active expedition + hasUI → web dashboard (page written, server up, URL notify)', async (t) => {
  const f = seedExpeditionWorkDir();
  const { pi } = await runDashboardCommand(f.workDir, 'active');
  t.after(() => { extensionModule.stopDashboardServerForTest(pi); }); // release THIS instance's listen socket
  const notified = pi.notifications.map((n) => n.text).join('\n');
  assert.match(notified, /Expedition dashboard at http:\/\/127\.0\.0\.1:\d+/);
  // The live route answers with the expedition JSON payload on the same server.
  const url = notified.match(/Expedition dashboard at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  const res = await fetch(`${url}/expedition`);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.fail, null);
  assert.equal(payload.campaigns.length, 2);
  assert.deepEqual(payload.dirs.map((d) => d.status).sort(), ['active', 'resolved']);
});

test('dashboard command headless (hasUI=false) with an active expedition → refusal, no server', async () => {
  const f = seedExpeditionWorkDir();
  const { pi } = await runDashboardCommand(f.workDir, 'headless', { hasUI: false });
  const notified = pi.notifications.map((n) => n.text).join('\n');
  assert.match(notified, /Expedition web dashboard requires a TUI session/);
  assert.doesNotMatch(notified, /Expedition dashboard at/);
});

test('dashboard command outside an expedition → the ordinary fullscreen path (no web server)', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expweb-plain-'));
  fs.mkdirSync(path.join(workDir, '.auto'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.auto', 'log.jsonl'), '');
  const { pi } = await runDashboardCommand(workDir, 'plain');
  const notified = pi.notifications.map((n) => n.text).join('\n');
  // Ordinary path: the fullscreen gate notices mode is not active / no UI custom is attempted; a web URL must NOT appear.
  assert.doesNotMatch(notified, /Expedition dashboard at/);
});

test('export command stays the ordinary ledger path inside an expedition (no expedition branch)', () => {
  // exportDashboard may move to an extracted module; find its current owner.
  const source = moduleContaining('async function exportDashboard');
  // exportDashboard must NOT branch to the expedition page: the spec keeps the ledger dashboard for export.
  // Slice precisely: from the exportDashboard signature to the next helper (the expedition detector).
  const start = source.indexOf('async function exportDashboard');
  const nextHelper = source.indexOf('/** Detects an expedition', start);
  const end = nextHelper >= 0 ? nextHelper : source.length;
  const exportFn = source.slice(start, end);
  assert.ok(exportFn.includes('Export failed'), 'slice captured the real exportDashboard body');
  assert.doesNotMatch(exportFn, /buildExpeditionHtml/, 'export must not render the expedition page');
  assert.doesNotMatch(exportFn, /openExpeditionWebDashboard/, 'export must not branch to the expedition dashboard');
});

test('no new broadcast points: broadcastDashboardUpdate call sites unchanged', () => {
  // Count across all current modules: extraction must not relax the pin, and
  // a new broadcast on the expedition path must be caught wherever it lands.
  const owners = extensionModules().flatMap((m) =>
    [...(m.src.match(/broadcastDashboardUpdate\(/g) ?? [])].map(() => m.file));
  const callSites = owners.length;
  // 4 legacy sites (ledger/config writes) + 1 definition = 5. es1.7/es1.8
  // adds one intentional broadcast after the mode-switch finalize entry so
  // an open dashboard sees the new ledger row; the expedition branch adds none.
  // The count now spans extracted modules too (index.ts 6 + finalize 1 + log 1).
  assert.equal(callSites, 8);
  const expeditionFiles = new Set(['expedition.ts', 'expedition-view.ts', 'dashboard-web.ts']);
  assert.deepEqual(owners.filter((file) => expeditionFiles.has(file)), [],
    'the expedition path must not add dashboard broadcasts');
});
