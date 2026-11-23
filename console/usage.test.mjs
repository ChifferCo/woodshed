import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUsage, tokenUsageFrom } from './usage.mjs';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const store = () => ({ state: { sessions: [] }, saves: 0, save() { this.saves += 1; } });
const t = (input, output, extra = {}) => ({ input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...extra });
const report = (billing, days, { agent = 'claude', since = '2026-11-22T08:00:00Z' } = {}) => ({ agent, billing, since, days });

test('a report out of range or of an unknown shape is dropped, its bad parts left out', () => {
  assert.equal(tokenUsageFrom(null), null);
  assert.equal(tokenUsageFrom({ agent: 'gpt', billing: 'plan', since: '2026-11-22T00:00:00Z', days: {} }), null);
  assert.equal(tokenUsageFrom({ agent: 'claude', billing: 'free', since: '2026-11-22T00:00:00Z', days: {} }), null);
  const usage = tokenUsageFrom(report('key', {
    '2026-11-22': { 'claude-opus-5-5': { input: 5, output: -3, cacheRead: 'lots' }, '<script>': { input: 1 } },
    'yesterday': { 'claude-opus-5-5': { input: 1 } },
  }));
  assert.deepEqual(usage.days, { '2026-11-22': { 'claude-opus-5-5': t(5, 0) } });
});

test('each run of a session is kept, and an unchanged report saves nothing', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  const session = { id: 'aaaa1111', owner: 'sam', title: 'Fix it', repo: 'acme/web' };
  assert.equal(usage.record(session, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 1e6) } })), true);
  const saves = s.saves;
  assert.equal(usage.record(session, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 1e6) } })), false);
  assert.equal(s.saves, saves);
  usage.record(session, report('plan', { '2026-11-23': { 'claude-opus-5-5': t(1e6, 0) } }, { since: '2026-11-23T08:00:00Z' }));
  assert.deepEqual(Object.keys(s.state.tokenUsage.aaaa1111.runs), ['2026-11-22T08:00:00.000Z', '2026-11-23T08:00:00.000Z']);
  const view = usage.summary({ login: 'sam', admin: false });
  // 1M in and 1M out on Opus 5.5 (4 + 20), then 1M in (4).
  assert.equal(view.totals.plan.cost, 28);
  assert.equal(view.totals.key.cost, 0);
  assert.equal(view.bySession[0].title, 'Fix it');
});

test('a person sees their own sessions; an admin may see everyone, by person', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'a1', owner: 'sam' }, report('plan', { '2026-11-22': { 'claude-sonnet-5-5': t(1e6, 0) } }));
  usage.record({ id: 'b2', owner: 'kim', options: { agent: 'codex' } }, report('key', { '2026-11-22': { 'gpt-6.1-sol': t(1e6, 1e6) } }, { agent: 'codex' }));
  // A shared session on the team key that sam started, and one on kim's plan that sam started.
  usage.record({ id: 'c3', startedBy: 'sam' }, report('key', { '2026-11-23': { 'claude-opus-5-5': t(0, 1e6) } }));
  usage.record({ id: 'd4', startedBy: 'sam', plan: 'kim' }, report('plan', { '2026-11-23': { 'imaginary-model': t(10, 10) } }));

  const sam = usage.summary({ login: 'sam', admin: false, everyone: true });
  assert.equal(sam.everyone, false, 'only an admin sees everyone');
  assert.deepEqual(sam.bySession.map((r) => r.sessionId).sort(), ['a1', 'c3', 'd4']);
  assert.equal(sam.totals.plan.cost, 2);
  assert.equal(sam.totals.key.cost, 20);
  assert.equal(sam.totals.plan.unpriced, 20);
  assert.deepEqual(sam.unpricedModels, ['imaginary-model']);

  const kim = usage.summary({ login: 'kim', admin: false });
  assert.deepEqual(kim.bySession.map((r) => r.sessionId).sort(), ['b2', 'd4'], 'a session on her plan is hers too');

  const all = usage.summary({ login: 'sam', admin: true, everyone: true });
  assert.equal(all.everyone, true);
  assert.equal(all.bySession.length, 4);
  const people = Object.fromEntries(all.byPerson.map((p) => [p.person, p]));
  assert.equal(people.kim.key.cost, 12, 'gpt-6.1-sol: 1M in at $2, 1M out at $10');
  assert.equal(people.kim.plan.tokens, 20, 'd4 ran on her plan');
  assert.equal(people.sam.key.cost, 20);
  assert.deepEqual(all.byModel.map((m) => `${m.billing} ${m.model}`), ['key claude-opus-5-5', 'key gpt-6.1-sol', 'plan claude-sonnet-5-5', 'plan imaginary-model']);
});

test('the span picks the days, and days past the keep are dropped', () => {
  const s = store();
  let now = NOW;
  const usage = createUsage(s, { now: () => now });
  usage.record({ id: 'a1', owner: 'sam' }, report('key', {
    '2026-11-23': { 'claude-opus-5-5': t(1e6, 0) },
    '2026-11-10': { 'claude-opus-5-5': t(1e6, 0) },
  }));
  assert.equal(usage.summary({ login: 'sam', admin: false, days: 7 }).totals.key.cost, 4);
  const month = usage.summary({ login: 'sam', admin: false, days: 30 });
  assert.equal(month.totals.key.cost, 8);
  assert.equal(month.byDay.length, 30);
  assert.equal(month.byDay.at(-1).day, '2026-11-23');
  now = Date.parse('2027-02-12T12:00:00Z');
  usage.prune();
  assert.deepEqual(Object.keys(s.state.tokenUsage.a1.runs['2026-11-22T08:00:00.000Z'].days), ['2026-11-23']);
  now = Date.parse('2027-03-12T12:00:00Z');
  usage.prune();
  assert.deepEqual(s.state.tokenUsage, {}, 'a session with nothing left is dropped');
});
