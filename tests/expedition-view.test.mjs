import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as view from '../extensions/pi-autoresearch/expedition-view.ts';

// ─── Fixtures (no valid hash chain needed: the view is read-only presentation) ──
const brief = {
  schema_version: 1, goal: 'g', plan_source: 'p', caveat_block: 'c',
  data_roles: { explore: [], validate: [], confirm: [] },
  questions: [
    { id: 'T1', text: 'Tape question?', decision_rules: [{ id: 'r1', verdict: 'confirmed', when: 'y' }], needs_data: null },
    { id: 'T2', text: 'Ensemble question?', decision_rules: [{ id: 'r1', verdict: 'confirmed', when: 'y' }], needs_data: null },
    { id: 'T3', text: 'Arch question?', decision_rules: [{ id: 'r1', verdict: 'confirmed', when: 'y' }], needs_data: null },
    { id: 'T4', text: 'Atlas question?', decision_rules: [{ id: 'r1', verdict: 'confirmed', when: 'y' }], needs_data: null },
  ],
  process_metrics: [], stop_rules: [],
};
const marker = (goal = 'Explore', maxCampaigns = 7) => ({ schema_version: 1, expedition: true, goal, doc_path: 'doc.json', doc_sha256: 'a'.repeat(64), campaign_id: 'c1', charter: { max_campaigns: maxCampaigns, stop_rules: ['territory_complete'] } });
const entries = [
  { type: 'chain_created', root_campaign_id: 'c1', at: '2026-11-12T03:03:00.000Z' },
  { type: 'expedition_created', goal: 'Explore the lens', doc_sha256: 'a'.repeat(64), at: '2026-11-12T03:03:10.000Z' },
  { type: 'direction_opened', dir: 'D1', why: 'first basis', at: '2026-11-12T03:04:00.000Z' },
  { type: 'direction_opened', dir: 'D2', why: 'second basis', at: '2026-11-12T03:04:10.000Z' },
  { type: 'direction_activated', dir: 'D1', campaign: 'c1', why: 'start', at: '2026-11-12T03:05:00.000Z' },
  { type: 'campaign_added', campaign_id: 'c1', at: '2026-11-12T03:05:10.000Z' },
];
const log = [
  { at: 'a', event: 'open', question_id: 'T1', question_text: 'Tape question?' },
  { at: 'b', event: 'record', question_id: 'T1', evidence_ref: 'x' },
  { at: 'c', event: 'close', question_id: 'T1', verdict: 'rejected', rule_id: 't1-r', reason: 'noise' },
  { at: 'd', event: 'open', question_id: 'T2' },
  { at: 'e', event: 'close', question_id: 'T2', verdict: 'confirmed' },
  { at: 'f', event: 'open', question_id: 'T3' },
  { at: 'g', event: 'close', question_id: 'T3', verdict: 'waiting_for_data' },
  { at: 'h', event: 'open', question_id: 'T4' },
  { at: 'i', event: 'close', question_id: 'T4', verdict: 'custom_verdict' },
  { at: 'j', event: 'open', question_id: 'T5', question_text: 'Unlisted?' },
];
const writeJournal = (dir, es) => writeFileSync(join(dir, 'chain.json'), es.map((e) => JSON.stringify(e)).join('\n') + '\n');
const seed = (withCampaign = true) => {
  const chainDir = join(mkdtempSync(join(tmpdir(), 'expview-')), 'ch');
  mkdirSync(chainDir, { recursive: true });
  writeJournal(chainDir, entries);
  writeFileSync(join(chainDir, 'expedition.json'), JSON.stringify(marker()) + '\n');
  let campaignDir = null;
  if (withCampaign) {
    campaignDir = join(mkdtempSync(join(tmpdir(), 'expcamp-')), 'c1');
    mkdirSync(join(campaignDir, 'evidence'), { recursive: true });
    writeFileSync(join(campaignDir, 'state.json'), JSON.stringify({ schema_version: 1, campaign_id: 'c1', created_at: 't', phase: 'research' }) + '\n');
    writeFileSync(join(campaignDir, 'brief.json'), JSON.stringify(brief) + '\n');
    writeFileSync(join(campaignDir, 'log.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(campaignDir, 'evidence', 'eval.json'), '{}');
    writeFileSync(join(campaignDir, 'evidence', 'script.py'), 'pass');
  }
  return { chainDir, campaignDir };
};

// ─── (a) Each file broken separately ────────────────────────────────────────
test('garbage chain.json fails journal; missing expedition_created fails not_expedition', () => {
  const { chainDir } = seed(false);
  writeFileSync(join(chainDir, 'chain.json'), '\x00binary garbage not json');
  const damaged = view.buildExpeditionView(chainDir, null);
  assert.equal(damaged.fail, 'journal');
  assert.deepEqual(view.toFullscreenLines(damaged, 80), ['(expedition: journal damaged)']);
  writeJournal(chainDir, [{ type: 'chain_created', root_campaign_id: 'c1', at: '0' }]);
  const plain = view.buildExpeditionView(chainDir, null);
  assert.equal(plain.fail, 'not_expedition');
  assert.deepEqual(view.toFullscreenLines(plain, 80), ['(expedition: not an expedition)']);
});
test('missing chain.json file is journal damage; empty journal is not', () => {
  const { chainDir } = seed(false);
  const missing = view.buildExpeditionView(join(chainDir, 'nope'), null);
  assert.equal(missing.fail, 'journal');
  writeJournal(chainDir, []);
  assert.equal(view.buildExpeditionView(chainDir, null).fail, 'not_expedition'); // zero entries → no expedition_created
});
test('broken state.json → unavailable with banner; broken brief → id texts; broken log → no verdicts; missing evidence dir → []', () => {
  const { chainDir, campaignDir } = seed();
  writeFileSync(join(campaignDir, 'state.json'), '{broken');
  let v = view.buildExpeditionView(chainDir, campaignDir);
  assert.equal(v.campaignState, 'unavailable');
  assert.equal(v.questions.length, 0);
  assert.match(view.toFullscreenLines(v, 200).join('\n'), /\(campaign data unavailable\)/);
  writeFileSync(join(campaignDir, 'state.json'), JSON.stringify({ phase: 'research' }) + '\n');
  writeFileSync(join(campaignDir, 'brief.json'), '{broken');
  v = view.buildExpeditionView(chainDir, campaignDir);
  assert.equal(v.campaignState, 'ok');
  assert.deepEqual(v.questions.map((q) => q.text), ['T1', 'T2', 'T3', 'T4', 'T5']); // ids from the log, log discovery order
  assert.equal(v.counters.qTotal, 5);
  writeFileSync(join(campaignDir, 'brief.json'), JSON.stringify(brief) + '\n');
  writeFileSync(join(campaignDir, 'log.jsonl'), 'not json at all');
  v = view.buildExpeditionView(chainDir, campaignDir);
  assert.deepEqual(v.questions.map((q) => q.id), ['T1', 'T2', 'T3', 'T4']); // brief order survives
  assert.ok(v.questions.every((q) => !q.closed && q.verdict === null));
  assert.equal(view.toWidgetVerdicts(v), null);
  rmSync(join(campaignDir, 'evidence'), { recursive: true, force: true });
  v = view.buildExpeditionView(chainDir, campaignDir);
  assert.deepEqual(v.evidence, []);
});

// ─── (b, c) Verdict glyphs and brief question order ─────────────────────────
test('full happy view: brief order, verdict glyphs, evidence sorted, counters from journal+marker', () => {
  const { chainDir, campaignDir } = seed();
  const v = view.buildExpeditionView(chainDir, campaignDir);
  assert.equal(v.fail, null);
  assert.deepEqual(v.questions.map((q) => q.id), ['T1', 'T2', 'T3', 'T4']); // brief order, T5 unknown to the brief ignored
  assert.equal(v.campaignState, 'ok');
  assert.equal(v.campaignPhase, 'research');
  assert.equal(v.campaignId, 'c1');
  assert.deepEqual(v.evidence, ['eval.json', 'script.py']);
  assert.deepEqual(v.counters, { done: 0, total: 2, campaignsUsed: 1, campaignsMax: 7, qClosed: 4, qTotal: 4, next: 'expedition_map(subaction=activate, dir=<name>, why=<rationale>)' });
  const q = Object.fromEntries(v.questions.map((x) => [x.id, x]));
  assert.equal(q.T1.closed && q.T1.verdict === 'rejected' && q.T1.hasEvidence && q.T1.ruleId === 't1-r' && q.T1.reason === 'noise', true);
  assert.equal(q.T2.verdict, 'confirmed');
  assert.equal(q.T4.verdict, 'custom_verdict');
  const lines = view.toFullscreenLines(v, 200).join('\n');
  assert.match(lines, /T1 ✗ rejected/);
  assert.match(lines, /T2 ✓ confirmed/);
  assert.match(lines, /T3 ⏳ waiting_for_data/);
  assert.match(lines, /T4 \* custom_verdict/);
  assert.match(lines, /Q 4\/4/);
  assert.match(lines, /campaigns 1\/7/);
  assert.match(lines, /territory ░░ done\/2/);
});

// ─── (d) Advisory disclosure ────────────────────────────────────────────────
test('advisory direction carries the unproven mark in fullscreen lines', () => {
  const { chainDir, campaignDir } = seed();
  writeJournal(chainDir, [...entries, { type: 'direction_advisory', dir: 'D2', review_ref: 'x', review_sha256: 'h', at: '2026-11-12T03:06:00.000Z' }]);
  const lines = view.toFullscreenLines(view.buildExpeditionView(chainDir, campaignDir), 300).join('\n');
  assert.match(lines, /❓ D2/);
  assert.match(lines, /самоотчёт, не доказательство/);
});

// ─── (e) Timeline limit ─────────────────────────────────────────────────────
test('timeline keeps the last 200 events and reports the hidden tail', () => {
  const { chainDir, campaignDir } = seed();
  const many = [];
  for (let i = 0; i < 210; i++) many.push({ type: 'direction_opened', dir: 'D' + i, why: 'w' + i, at: '2026-11-12T04:00:00.000Z' });
  writeJournal(chainDir, [...entries, ...many]);
  const v = view.buildExpeditionView(chainDir, campaignDir);
  // `entries` carries 3 map events (2 opened + 1 activated); +210 = 213 map
  // events; the expedition_created root row is always kept → total 214.
  assert.equal(v.timelineTotal, 214);
  assert.equal(v.timeline.length, 200);
  assert.equal(v.timeline[0].type, 'expedition_created'); // the root survives the window
  const lines = view.toFullscreenLines(v, 200);
  const moreRow = lines.find((l) => l.startsWith('… '));
  assert.ok(moreRow && moreRow.includes('more'), 'hidden-tail row expected');
  assert.match(moreRow, /… 14 more/); // 214 − 200
  assert.equal(lines.filter((l) => l.includes('direction_opened')).length, 199); // window minus the root row
});

// ─── (f) Narrow width clipping (code-point safe, never throws) ──────────────
test('every fullscreen line fits the width, including emoji rows', () => {
  const { chainDir, campaignDir } = seed();
  const lines = view.toFullscreenLines(view.buildExpeditionView(chainDir, campaignDir), 24);
  assert.ok(lines.length > 10);
  for (const l of lines) assert.ok(Array.from(l).length <= 24, JSON.stringify(l));
  const emojiRow = lines.find((l) => l.includes('🧭'));
  assert.ok(emojiRow && Array.from(emojiRow).length <= 24);
});

// ─── (g) null-campaign vs unavailable ───────────────────────────────────────
test('null campaignDir → campaign none with hint; unavailable never leaks questions', () => {
  const { chainDir } = seed(false);
  const v = view.buildExpeditionView(chainDir, null);
  assert.equal(v.campaignState, 'none');
  assert.equal(v.campaignId, 'c1'); // journal-derived pin still shown
  const lines = view.toFullscreenLines(v, 200).join('\n');
  assert.match(lines, /нет активной кампании/);
  assert.match(lines, /next: expedition_map\(subaction=activate, dir=<name>, why=<rationale>\)/);
});

// ─── (h) Widget verdicts line ───────────────────────────────────────────────
test('toWidgetVerdicts: glyph per closed question in brief order, null when none open→closed empty', () => {
  const { chainDir, campaignDir } = seed();
  const v = view.buildExpeditionView(chainDir, campaignDir);
  assert.equal(view.toWidgetVerdicts(v), 'Q: ✗T1 ✓T2 ⏳T3 *T4');
  const noClosed = { ...v, questions: v.questions.map((q) => ({ ...q, closed: false, verdict: null })) };
  assert.equal(view.toWidgetVerdicts(noClosed), null);
});

// ─── Sanitization: CR/LF never break a line ─────────────────────────────────
test('CR/LF in goal/why/reason texts are collapsed to one visual line', () => {
  const { chainDir, campaignDir } = seed();
  writeJournal(chainDir, [...entries, { type: 'direction_opened', dir: 'Bad\r\nName', why: 'multi\nline\r\nwhy', at: '2026-11-12T05:00:00.000Z' }]);
  const lines = view.toFullscreenLines(view.buildExpeditionView(chainDir, campaignDir), 400);
  assert.ok(lines.every((l) => !/[\r\n]/.test(l)));
  assert.ok(lines.some((l) => l.includes('Bad Name') && l.includes('multi line why')));
});

// ─── Status-aware next hint (review minor 2026-11-12, blind spot closed) ────
test('counters.next is status-aware: active/awaiting_child → activate hint, stopped_* → report', () => {
  const f = seed(false);
  try {
    const active = view.buildExpeditionView(f.chainDir, null);
    assert.equal(active.counters.next, 'expedition_map(subaction=activate, dir=<name>, why=<rationale>)');
    const stopped = [...entries, { type: 'status_change', status: 'stopped_by_rule', at: '2026-11-12T03:06:00.000Z' }];
    writeJournal(f.chainDir, stopped);
    const v = view.buildExpeditionView(f.chainDir, null);
    assert.equal(v.counters.next, 'research_questions(action=report)',
      'a stopped chain refuses every map action; the hint must be the report');
    writeJournal(f.chainDir, [...entries, { type: 'status_change', status: 'completed', at: '2026-11-12T03:06:00.000Z' }]);
    assert.equal(view.buildExpeditionView(f.chainDir, null).counters.next, 'research_questions(action=report)');
    writeJournal(f.chainDir, [...entries, { type: 'status_change', status: 'awaiting_child', at: '2026-11-12T03:06:00.000Z' }]);
    assert.equal(view.buildExpeditionView(f.chainDir, null).counters.next, 'expedition_map(subaction=activate, dir=<name>, why=<rationale>)');
  } finally {
    rmSync(f.chainDir, { recursive: true, force: true });
  }
});

test('directions carry the closing reason (result note): rejected has it, open is null', () => {
  const chainDir = join(mkdtempSync(join(tmpdir(), 'ev-')), 'ch');
  mkdirSync(chainDir, { recursive: true });
  const entries2 = [
    { type: 'chain_created', root_campaign_id: 'c1', at: '2026-11-12T03:03:00.000Z' },
    { type: 'expedition_created', goal: 'G', doc_sha256: 'a'.repeat(64), at: '2026-11-12T03:03:10.000Z' },
    { type: 'direction_opened', dir: 'D1', why: 'basis one', at: '2026-11-12T03:04:00.000Z' },
    { type: 'direction_activated', dir: 'D1', campaign: 'c1', why: 'start', at: '2026-11-12T03:05:00.000Z' },
    { type: 'direction_rejected', dir: 'D1', reason: 'signal broke on fresh', at: '2026-11-12T03:06:00.000Z' },
    { type: 'direction_opened', dir: 'D2', why: 'basis two', at: '2026-11-12T03:07:00.000Z' },
  ];
  writeFileSync(join(chainDir, 'chain.json'), entries2.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const v = view.buildExpeditionView(chainDir, null);
  const d1 = v.dirs.find((d) => d.name === 'D1');
  const d2 = v.dirs.find((d) => d.name === 'D2');
  assert.equal(d1.reason, 'signal broke on fresh', 'rejected direction carries its closing reason');
  assert.equal(d2.reason, null, 'open direction has no result note');
});
