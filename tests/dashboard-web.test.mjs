import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpeditionHtml } from '../extensions/pi-autoresearch/dashboard-web.ts';
import { buildExpeditionView } from '../extensions/pi-autoresearch/expedition-view.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A representative healthy view (built through the real reader from disk
// fixtures so the page contract is exercised against actual view shapes).
const brief = {
  schema_version: 1, goal: 'g', plan_source: 'p', caveat_block: 'c',
  data_roles: { explore: [], validate: [], confirm: [] },
  questions: [{ id: 'Q1', text: 'Вопрос?', decision_rules: [], needs_data: null }],
  process_metrics: [], stop_rules: [],
};
const entries = [
  { type: 'chain_created', root_campaign_id: 'c1', at: '2026-11-12T03:03:00.000Z' },
  { type: 'expedition_created', goal: 'Explore the lens', doc_sha256: 'a'.repeat(64), at: '2026-11-12T03:03:10.000Z' },
  { type: 'direction_opened', dir: 'D1', why: 'first basis', at: '2026-11-12T03:04:00.000Z' },
  { type: 'direction_activated', dir: 'D1', campaign: 'c1', why: 'start', at: '2026-11-12T03:05:00.000Z' },
  { type: 'campaign_added', campaign_id: 'c1', at: '2026-11-12T03:05:10.000Z' },
];
const campaignLog = [
  { at: 'a', event: 'open', question_id: 'Q1' },
  { at: 'b', event: 'close', question_id: 'Q1', verdict: 'confirmed' },
];

const seedView = () => {
  const chainDir = join(mkdtempSync(join(tmpdir(), 'dashweb-')), 'ch');
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(join(chainDir, 'chain.json'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(chainDir, 'expedition.json'), JSON.stringify({ schema_version: 1, expedition: true, goal: 'Explore', doc_path: 'doc.json', doc_sha256: 'a'.repeat(64), campaign_id: 'c1', charter: { max_campaigns: 7, stop_rules: [] } }) + '\n');
  const campaignDir = join(mkdtempSync(join(tmpdir(), 'dashcamp-')), 'c1');
  mkdirSync(join(campaignDir, 'evidence'), { recursive: true });
  writeFileSync(join(campaignDir, 'state.json'), JSON.stringify({ schema_version: 1, campaign_id: 'c1', created_at: 't', phase: 'research' }) + '\n');
  writeFileSync(join(campaignDir, 'brief.json'), JSON.stringify(brief) + '\n');
  writeFileSync(join(campaignDir, 'log.jsonl'), campaignLog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(campaignDir, 'evidence', 'eval.json'), '{}');
  return buildExpeditionView(chainDir, campaignDir);
};

const campaigns = [
  { id: 'c1', phase: 'research', q: [{ id: 'Q1', text: 'Вопрос?', verdict: 'confirmed' }], evidenceCount: 1 },
  { id: 'exp-x-chain-c2', phase: 'stopped', q: [], evidenceCount: 0 },
];

test('healthy view: page contains the K2 kanban markers (6 columns, /expedition fetch, SSE, polling)', () => {
  const html = buildExpeditionHtml(seedView(), campaigns);
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'full standalone page');
  // six domain columns in DIRS_ORDER
  for (const s of ['open', 'active', 'resolved', 'rejected', 'advisory_exhausted', 'parked']) {
    assert.ok(html.includes(`"${s}"`), `column ${s} present`);
  }
  assert.ok(html.includes('DIR_LABEL'), 'column labels');
  // data comes from /expedition at runtime, not baked in
  assert.ok(html.includes("fetch(\"/expedition\""), 'fetches /expedition');
  // live updates: existing SSE signal + 10s polling
  assert.ok(html.includes('new EventSource("/events")'), 'SSE /events');
  assert.ok(html.includes('jsonl-updated'), 'listens to jsonl-updated');
  assert.ok(html.includes('POLL_MS = 10000'), '10s polling');
  assert.ok(html.includes('setInterval(load,POLL_MS)'), 'poll timer wired');
  // a11y / interaction basics
  assert.ok(html.includes('aria-expanded'), 'aria-expanded');
  assert.ok(html.includes('focus-visible'), 'focus-visible');
  assert.ok(html.includes('Escape'), 'Esc closes inline');
});

test('fail views produce the same static page — damage banner is rendered client-side from JSON', () => {
  const ok = seedView();
  const damaged = { ...ok, fail: 'journal' };
  const notExp = { ...ok, fail: 'not_expedition' };
  const h1 = buildExpeditionHtml(ok, campaigns);
  const h2 = buildExpeditionHtml(damaged, campaigns);
  const h3 = buildExpeditionHtml(notExp, []);
  // the page template must carry the banner texts so the client can show them
  assert.ok(h1.includes('Журнал экспедиции повреждён'), 'journal damage banner present in template');
  assert.ok(h1.includes('не экспедиционная цепочка'), 'not_expedition banner present in template');
  // banner logic keys off payload.fail at runtime
  assert.ok(h1.includes('fail==="journal"'), 'journal branch');
  assert.ok(h1.includes('fail==="not_expedition"'), 'not_expedition branch');
  assert.ok(h1.includes('campaignState==="none"'), 'campaign none banner');
  assert.ok(h1.includes('campaignState==="unavailable"'), 'campaign unavailable banner');
});

test('no payload data is embedded into the static HTML (XSS-proof by construction)', () => {
  const poisoned = seedView();
  poisoned.goal = '<script>alert(1)</script>';
  poisoned.dirs = poisoned.dirs.map((d) => ({ ...d, why: '<script>alert(2)</script>' }));
  const html = buildExpeditionHtml(poisoned, [
    { id: '<script>', phase: 'research', q: [{ id: '"><img>', text: '<script>', verdict: null }], evidenceCount: 0 },
  ]);
  // static HTML must not contain the poisoned literals anywhere
  assert.ok(!html.includes('alert(1)'), 'goal not baked in');
  assert.ok(!html.includes('alert(2)'), 'why not baked in');
  assert.ok(!html.includes('<script>alert'), 'no raw script from payload');
  // the page escapes payload strings when rendering
  assert.ok(html.includes('function esc('), 'esc() present');
});

test('deterministic: identical arguments produce bit-identical pages; page is view-independent', () => {
  const a = buildExpeditionHtml(seedView(), campaigns);
  const b = buildExpeditionHtml({ ...seedView(), goal: 'different goal' }, []);
  assert.equal(a, b, 'page string does not depend on view/campaigns content');
  const c = buildExpeditionHtml(seedView(), campaigns);
  assert.equal(a, c, 'same arguments → bit-identical');
});

test('chain-status badge: stopped chain badge + live badge wiring in the page source', () => {
  const html = buildExpeditionHtml(seedView(), campaigns);
  // The badge renders client-side from payload.chainStatus (data-agnostic page).
  assert.ok(html.includes('chainChip'), 'badge element present');
  assert.ok(html.includes('цепочка остановлена'), 'stopped badge text');
  assert.ok(html.includes('цепочка: '), 'live badge text');
  assert.ok(html.includes('chainStatus'), 'badge reads payload.chainStatus');
  assert.ok(html.includes('classList.toggle("live",live)'), 'live class toggle');
});

test('K2 UX essentials carried over from the approved mockup', () => {
  const html = buildExpeditionHtml(seedView(), campaigns);
  // campaign strip chips with flash wiring + unbound-campaign chip response
  assert.ok(html.includes('data-camp'), 'chips/cards carry data-camp');
  assert.ok(html.includes('noflash'), 'unbound campaign chip feedback');
  // inline question accordion per card
  assert.ok(html.includes('class="inline" hidden'), 'hidden inline accordion');
  // history section with type coloring
  assert.ok(html.includes('История'), 'history toggle');
  assert.ok(html.includes('dir-event') && html.includes('campaign-event') && html.includes('stop-event'), 'history type classes');
  // counters with mini-bars
  assert.ok(html.includes('mbar'), 'mini progress bars');
  // next hint with copy fallback
  assert.ok(html.includes('navigator.clipboard'), 'clipboard copy');
  assert.ok(html.includes('execCommand("copy")'), 'textarea fallback');
  // WIP invariant on active column
  assert.ok(html.includes('wip-ok') && html.includes('wip-bad'), 'WIP invariant classes');
  // empty columns: narrow ~96px, title on top, no popups
  assert.ok(html.includes('kcol-empty'), 'collapsed empty columns');
  assert.ok(html.includes('min-width:96px'), '96px minimum');
  // no expeditions tabs: single-expedition page
  assert.ok(!html.includes('role="tablist"'), 'no tab list (single expedition)');
});
