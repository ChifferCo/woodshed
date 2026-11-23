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
  assert.deepEqual(usage.days, { '2026-11-22': { 'claude-opus-5-5': t(5, 0), other: t(1, 0) } }, 'a label that is no model\'s id is kept as other');
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
  assert.deepEqual(Object.keys(s.state.tokenUsage.aaaa1111.runs), ['2026-11-22T08:00:00.000Z claude', '2026-11-23T08:00:00.000Z claude']);
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
  usage.record({ id: 'd4', startedBy: 'sam', plan: 'kim' }, report('plan', { '2026-11-23': { 'gpt-imaginary': t(10, 10) } }));

  const sam = usage.summary({ login: 'sam', admin: false, everyone: true });
  assert.equal(sam.everyone, false, 'only an admin sees everyone');
  assert.deepEqual(sam.bySession.map((r) => r.sessionId).sort(), ['a1', 'c3', 'd4']);
  assert.equal(sam.totals.plan.cost, 2);
  assert.equal(sam.totals.key.cost, 20);
  assert.equal(sam.totals.plan.unpriced, 20);
  assert.deepEqual(sam.unpricedModels, ['gpt-imaginary']);

  const kim = usage.summary({ login: 'kim', admin: false });
  assert.deepEqual(kim.bySession.map((r) => r.sessionId).sort(), ['b2', 'd4'], 'a session on her plan is hers too');

  const all = usage.summary({ login: 'sam', admin: true, everyone: true });
  assert.equal(all.everyone, true);
  assert.equal(all.bySession.length, 4);
  const people = Object.fromEntries(all.byPerson.map((p) => [p.person, p]));
  assert.equal(people.kim.key.cost, 12, 'gpt-6.1-sol: 1M in at $2, 1M out at $10');
  assert.equal(people.kim.plan.tokens, 20, 'd4 ran on her plan');
  assert.equal(people.sam.key.cost, 20);
  assert.deepEqual(all.byModel.map((m) => `${m.billing} ${m.model}`), ['key claude-opus-5-5', 'key gpt-6.1-sol', 'plan claude-sonnet-5-5', 'plan gpt-imaginary']);
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
  assert.deepEqual(Object.keys(s.state.tokenUsage.a1.runs['2026-11-22T08:00:00.000Z claude'].days), ['2026-11-23']);
  now = Date.parse('2027-03-12T12:00:00Z');
  usage.prune();
  assert.deepEqual(s.state.tokenUsage, {}, 'a session with nothing left is dropped');
});

test('another person\'s private session is never named, admins included: its numbers count, its title, repo and branch stay out', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'k1', owner: 'kim', title: 'Kim\'s secret plan', repo: 'acme/web', branch: 'woodshed/k1' }, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  usage.record({ id: 's1', owner: 'sam', title: 'Sam\'s', repo: 'acme/web', branch: 'woodshed/s1' }, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  const all = usage.summary({ login: 'sam', admin: true, everyone: true });
  assert.equal(all.totals.plan.cost, 8, 'both count');
  const kims = all.bySession.find((r) => r.person === 'kim');
  assert.deepEqual([kims.hidden, kims.sessionId, kims.title, kims.repo, kims.branch, kims.kind], [true, null, null, null, null, 'private']);
  assert.ok(!JSON.stringify(all).includes('k1') && !JSON.stringify(all).includes('secret'), 'nothing of it anywhere in the answer');
  assert.equal(all.bySession.find((r) => r.person === 'sam').title, 'Sam\'s', 'the admin\'s own is named');
  assert.equal(usage.summary({ login: 'kim', admin: false }).bySession[0].title, 'Kim\'s secret plan', 'and kim sees hers');
});

test('without Sessions from GitHub a shared session is no longer yours to read here, and an admin sees only its numbers', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'sh1', startedBy: 'sam', plan: 'sam', title: 'Shared fix', repo: 'acme/web' }, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  usage.record({ id: 'p1', owner: 'sam', title: 'Mine' }, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  assert.deepEqual(usage.summary({ login: 'sam', admin: false }).bySession.map((r) => r.title).sort(), ['Mine', 'Shared fix']);
  const revoked = usage.summary({ login: 'sam', admin: false, seesShared: false });
  assert.deepEqual(revoked.bySession.map((r) => r.title), ['Mine']);
  assert.equal(revoked.totals.plan.cost, 4, 'nor in their totals');
  const admin = usage.summary({ login: 'mia', admin: true, everyone: true, seesShared: false });
  assert.equal(admin.totals.plan.cost, 8);
  assert.ok(admin.bySession.every((r) => r.hidden && !r.title), 'neither session is one the admin may open');
});

test('a report per agent: a review\'s codex is kept beside its claude, each with what pays for it', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'r1', review: { base: 'main' } }, [
    report('key', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }),
    report('plan', { '2026-11-22': { 'gpt-6.1-sol': t(1e6, 0) } }, { agent: 'codex' }),
  ]);
  const all = usage.summary({ login: 'mia', admin: true, everyone: true });
  assert.deepEqual(all.bySession.map((r) => `${r.kind} ${r.agent} ${r.billing}`).sort(), ['review claude key', 'review codex plan']);
  assert.equal(all.totals.plan.cost, 2);
  assert.equal(all.totals.key.cost, 4);
});

test('a run longer than the page\'s span keeps every day in it, and a read prunes on a console with no reports', () => {
  const days = {};
  for (let i = 0; i < 91; i++) days[new Date(NOW - i * 86_400_000).toISOString().slice(0, 10)] = { 'claude-opus-5-5': t(1e6, 0) };
  assert.equal(Object.keys(tokenUsageFrom(report('key', days)).days).length, 91);
  const s = store();
  let now = NOW;
  const usage = createUsage(s, { now: () => now });
  usage.record({ id: 'a1', owner: 'sam' }, report('key', { '2026-11-23': { 'claude-opus-5-5': t(1e6, 0) } }));
  now = Date.parse('2027-03-12T12:00:00Z');
  usage.summary({ login: 'sam', admin: false });
  assert.deepEqual(s.state.tokenUsage, {});
});

test('a session that has seen production data keeps nothing here, what it reported before its lockdown included', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  const session = { id: 'p1', owner: 'sam', title: 'Reads prod', repo: 'acme/web', branch: 'woodshed/p1' };
  usage.record(session, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  assert.ok(s.state.tokenUsage.p1);
  session.taintedAt = '2026-11-22T10:00:00Z';
  assert.equal(usage.record(session, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(2e6, 0) } })), false);
  assert.deepEqual(s.state.tokenUsage, {});
  usage.record({ id: 'q1', owner: 'sam' }, report('plan', { '2026-11-22': { 'claude-opus-5-5': t(1e6, 0) } }));
  usage.forget('q1');
  assert.deepEqual(s.state.tokenUsage, {});
});

test('a label shaped like JavaScript\'s own names is a model with no price, never an error', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'a1', owner: 'sam' }, report('key', { '2026-11-22': { constructor: t(1, 1), 'gpt-constructor': t(1, 1), __proto__: t(1, 1) } }));
  const view = usage.summary({ login: 'sam', admin: false });
  assert.deepEqual(view.byModel.map((m) => [m.model, m.priced]).sort(), [['gpt-constructor', false], ['other', false]]);
});

test('a day past the keep is not kept again from a long session\'s report, and runs past the cap are added up, not dropped', () => {
  const s = store();
  const usage = createUsage(s, { now: () => NOW });
  usage.record({ id: 'a1', owner: 'sam' }, report('key', { '2026-08-01': { 'claude-opus-5-5': t(1e6, 0) }, '2026-11-23': { 'claude-opus-5-5': t(1e6, 0) } }));
  assert.deepEqual(Object.keys(s.state.tokenUsage.a1.runs['2026-11-22T08:00:00.000Z claude'].days), ['2026-11-23']);

  const many = createUsage(store(), { now: () => NOW });
  for (let i = 0; i < 60; i++) {
    const since = new Date(Date.parse('2026-10-01T00:00:00Z') + i * 3_600_000).toISOString();
    many.record({ id: 'b2', owner: 'sam' }, report('plan', { '2026-11-01': { 'claude-opus-5-5': t(1e6, 0) } }, { since }));
  }
  const view = many.summary({ login: 'sam', admin: false, days: 90 });
  assert.equal(view.totals.plan.cost, 240, 'all 60 runs, 1M input each at $4');
  many.record({ id: 'b2', owner: 'sam' }, report('plan', { '2026-11-01': { 'claude-opus-5-5': t(1e6, 0) } }, { since: '2026-10-01T00:00:00Z' }));
  assert.equal(many.summary({ login: 'sam', admin: false, days: 90 }).totals.plan.cost, 240, 'a late copy of a run already added up counts nothing');
});
