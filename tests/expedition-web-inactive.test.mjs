import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakePi, makeCtx } from './fake-pi.ts';
import * as expedition from '../extensions/pi-autoresearch/expedition.ts';

const extensionModule = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href);
// Bind the module-level test hooks (resolveExpeditionPayload etc.): the
// extension binds them inside autoresearchExtension(), so initialize it once
// on a throwaway fake pi at load time.
{
  const { pi } = createFakePi({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'expinact-init-')), sessionId: 'expinact-init', realGit: false });
  (await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href)).default(pi);
}

// ── Fixtures (mirrors tests/expedition.test.mjs seed helpers) ────────────────
const doc = { charter: { max_campaigns: 3, stop_rules: ['territory_complete'] }, goal: 'Explore', directions: [{ name: 'D1', why: 'Initial basis' }], campaign0: { schema_version: 1, goal: 'g', plan_source: 'p', caveat_block: 'c', data_roles: { explore: [], validate: [], confirm: [] }, questions: [], process_metrics: [], stop_rules: [] } };
const jentries = (docSha = 'a'.repeat(64)) => [
  { type: 'chain_created', root_campaign_id: 'exp-1', at: '0' },
  { type: 'expedition_created', goal: 'Explore', doc_sha256: docSha, at: '1' },
  { type: 'direction_opened', dir: 'D1', why: 'Initial basis', at: '2' },
  { type: 'campaign_added', campaign_id: 'exp-1', at: '3' },
];
const chainRoot = () => fs.mkdtempSync(join(tmpdir(), 'expinact-'));
const writeJournal = (dir, es) => fs.writeFileSync(join(dir, 'chain.json'), es.map((e) => JSON.stringify(e)).join('\n') + '\n');
const seedChain = (root, chainId, es, status = 'active') => {
  const dir = join(root, chainId);
  fs.mkdirSync(dir, { recursive: true });
  writeJournal(dir, es);
  if (status) writeJournal(dir, [...es, { type: 'status_change', status, at: '9' }]);
  return dir;
};

// ── scanExpeditionChains: any status, same fail-closed integrity ─────────────
test('scanExpeditionChains finds stopped_by_rule, stopped_by_owner and completed chains', () => {
  const root = chainRoot();
  const stopped = seedChain(root, 'stopped-chain', jentries('b'.repeat(64)), 'stopped_by_rule');
  expedition.writeExpeditionMarker(stopped, { goal: 'G1', docPath: 'd1.json', docSha256: 'b'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  const owner = seedChain(root, 'owner-chain', jentries('c'.repeat(64)), 'stopped_by_owner');
  expedition.writeExpeditionMarker(owner, { goal: 'G2', docPath: 'd2.json', docSha256: 'c'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  const done = seedChain(root, 'done-chain', jentries('d'.repeat(64)), 'completed');
  expedition.writeExpeditionMarker(done, { goal: 'G3', docPath: 'd3.json', docSha256: 'd'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  const scan = expedition.scanExpeditionChains(root);
  assert.deepEqual(scan.chains.map((c) => c.chainId).sort(), ['done-chain', 'owner-chain', 'stopped-chain']);
  const byId = new Map(scan.chains.map((c) => [c.chainId, c]));
  assert.equal(byId.get('stopped-chain').status, 'stopped_by_rule');
  assert.equal(byId.get('done-chain').status, 'completed');
  // goal/campaign fields survive for the header
  assert.equal(byId.get('stopped-chain').goal, 'Explore');
  assert.equal(byId.get('stopped-chain').campaignId, 'exp-1');
});

test('scanExpeditionChains still fails closed: no-marker, digest mismatch, manual-check and unreadable journal are skipped', () => {
  const root = chainRoot();
  const nm = seedChain(root, 'nomarker-chain', jentries('1'.repeat(64)), 'stopped_by_rule');
  void nm;
  const mm = seedChain(root, 'mismatch-chain', jentries('2'.repeat(64)), 'stopped_by_rule');
  expedition.writeExpeditionMarker(mm, { goal: 'G', docPath: 'p.json', docSha256: '3'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  const mc = seedChain(root, 'mc-chain', jentries('4'.repeat(64)), 'stopped_by_rule');
  expedition.writeExpeditionMarker(mc, { goal: 'G', docPath: 'p.json', docSha256: '4'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  fs.writeFileSync(join(mc, 'manual-check'), 'x');
  const bad = seedChain(root, 'bad-chain', jentries('5'.repeat(64)), 'stopped_by_rule');
  expedition.writeExpeditionMarker(bad, { goal: 'G', docPath: 'p.json', docSha256: '5'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  fs.writeFileSync(join(bad, 'chain.json'), '\x00\x01binary-garbage-without-json');
  const scan = expedition.scanExpeditionChains(root);
  assert.deepEqual(scan.chains, []);
  assert.equal(expedition.scanExpeditionChains(join(root, 'missing')), 'root_missing');
});

test('scanActiveExpeditionChains unchanged: a stopped chain is NOT in the active scan (regression)', () => {
  const root = chainRoot();
  const stopped = seedChain(root, 'stopped-chain', jentries('b'.repeat(64)), 'stopped_by_rule');
  expedition.writeExpeditionMarker(stopped, { goal: 'G1', docPath: 'd1.json', docSha256: 'b'.repeat(64), campaignId: 'exp-1', charter: doc.charter });
  const scan = expedition.scanActiveExpeditionChains(root);
  assert.deepEqual(scan.chains, []);
});

// ── buildExpeditionPayload: stopped expedition → honest payload + chainStatus
test('resolveExpeditionPayload: stopped expedition → full payload with chainStatus (dashboard must open for inactive expeditions)', () => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'expinact-wd-'));
  const chainDir = join(workDir, '.auto', 'research-chain', 'exp-stopped-chain');
  fs.mkdirSync(chainDir, { recursive: true });
  const entries = [
    { type: 'chain_created', root_campaign_id: 'c0', at: '0' },
    { type: 'expedition_created', goal: 'Frozen lens', doc_sha256: 'a'.repeat(64), at: '1' },
    { type: 'direction_opened', dir: 'D1', why: 'first basis', at: '2' },
    { type: 'direction_resolved', dir: 'D1', refs: [{ campaign: 'c0', question: 'Q1' }], at: '3' },
    { type: 'campaign_added', campaign_id: 'c0', at: '4' },
    { type: 'expedition_stop', rule: 'r', basis: 'rule', at: '5' },
    { type: 'status_change', status: 'stopped_by_rule', at: '6' },
  ];
  fs.writeFileSync(join(chainDir, 'chain.json'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  expedition.writeExpeditionMarker(chainDir, { goal: 'Frozen lens', docPath: 'doc.json', docSha256: 'a'.repeat(64), campaignId: 'c0', charter: doc.charter });
  const payload = extensionModule.resolveExpeditionPayload(workDir);
  assert.notEqual(payload, null);
  assert.equal(payload.chainStatus, 'stopped_by_rule');
  assert.equal(payload.goal, 'Frozen lens');
  assert.deepEqual(payload.dirs.map((d) => d.status), ['resolved']);
  assert.equal(payload.campaigns.length, 1);
});

test('resolveExpeditionPayload: active expedition → chainStatus "active"; no expedition on disk → null', () => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'expinact-wd2-'));
  const chainDir = join(workDir, '.auto', 'research-chain', 'exp-live-chain');
  fs.mkdirSync(chainDir, { recursive: true });
  const entries = [
    { type: 'chain_created', root_campaign_id: 'c0', at: '0' },
    { type: 'expedition_created', goal: 'Live', doc_sha256: 'a'.repeat(64), at: '1' },
    { type: 'status_change', status: 'active', at: '2' },
  ];
  fs.writeFileSync(join(chainDir, 'chain.json'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  expedition.writeExpeditionMarker(chainDir, { goal: 'Live', docPath: 'doc.json', docSha256: 'a'.repeat(64), campaignId: 'c0', charter: doc.charter });
  const payload = extensionModule.resolveExpeditionPayload(workDir);
  assert.equal(payload.chainStatus, 'active');
  const empty = fs.mkdtempSync(join(tmpdir(), 'expinact-wd3-'));
  fs.mkdirSync(join(empty, '.auto', 'research-chain'), { recursive: true });
  assert.equal(extensionModule.resolveExpeditionPayload(empty), null);
});

// ── Command wiring: stopped expedition opens the WEB dashboard ──────────────
/** Seeds a minimal stopped-expedition workDir for the command test. */
const seedStoppedWorkDir = () => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'expinact-cmd-'));
  const chainDir = join(workDir, '.auto', 'research-chain', 'exp-stopped-cmd');
  fs.mkdirSync(chainDir, { recursive: true });
  const entries = [
    { type: 'chain_created', root_campaign_id: 'c0', at: '0' },
    { type: 'expedition_created', goal: 'Stopped cmd', doc_sha256: 'a'.repeat(64), at: '1' },
    { type: 'expedition_stop', rule: 'r', basis: 'rule', at: '2' },
    { type: 'status_change', status: 'stopped_by_rule', at: '3' },
  ];
  fs.writeFileSync(join(chainDir, 'chain.json'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  expedition.writeExpeditionMarker(chainDir, { goal: 'Stopped cmd', docPath: 'doc.json', docSha256: 'a'.repeat(64), campaignId: 'c0', charter: doc.charter });
  return { workDir };
};

test('dashboard command with a STOPPED expedition + hasUI → web dashboard (not the fullscreen path)', async (t) => {
  const f = seedStoppedWorkDir();
  const { pi, command } = (() => {
    const fake = createFakePi({ dir: f.workDir, sessionId: 'expinact-cmd1', realGit: false });
    return fake;
  })();
  const ctx = makeCtx(f.workDir, 'expinact-cmd1', pi);
  ctx.hasUI = true;
  const { default: autoresearchExtension } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href);
  autoresearchExtension(pi);
  await command('autoresearch').handler('dashboard', ctx);
  t.after(() => { extensionModule.stopDashboardServerForTest?.(); });
  const notified = pi.notifications.map((n) => n.text).join('\n');
  assert.match(notified, /Expedition dashboard at http:\/\/127\.0\.0\.1:\d+/);
  // The live route serves the stopped-expedition payload with an honest chainStatus.
  const url = notified.match(/Expedition dashboard at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  const res = await fetch(`${url}/expedition`);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.chainStatus, 'stopped_by_rule');
});

test('dashboard command outside any expedition → the ordinary fullscreen path (regression)', async () => {
  const workDir = fs.mkdtempSync(join(tmpdir(), 'expinact-plain-'));
  fs.mkdirSync(path.join(workDir, '.auto'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.auto', 'log.jsonl'), '');
  const { pi, command } = createFakePi({ dir: workDir, sessionId: 'expinact-plain', realGit: false });
  const ctx = makeCtx(workDir, 'expinact-plain', pi);
  ctx.hasUI = true;
  const { default: autoresearchExtension } = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'extensions', 'pi-autoresearch', 'index.ts')).href);
  autoresearchExtension(pi);
  await command('autoresearch').handler('dashboard', ctx);
  const notified = pi.notifications.map((n) => n.text).join('\n');
  assert.doesNotMatch(notified, /Expedition dashboard at/);
});

// node:path import used by the command fixtures above
import * as path from 'node:path';
