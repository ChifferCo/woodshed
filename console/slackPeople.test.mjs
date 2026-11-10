import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSlackPeople } from './slackPeople.mjs';

const ANA = { id: 'U01ANA00001', name: 'Ana K', handle: 'ana', reachable: true };

function setup({ byEmail = {}, byId = {}, byHandle = {} } = {}) {
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const clock = { now: 1_000_000 };
  const asked = [];
  const slack = {
    async personByEmail(email) { asked.push(email); const r = byEmail[email]; if (r instanceof Error) throw r; return r ?? null; },
    async person(id) { return byId[id] ?? null; },
    async personByHandle(h) { return byHandle[h] ?? null; },
  };
  const people = createSlackPeople({ store, slack, now: () => clock.now });
  const match = (login, emails = ['ana@example.com']) => people.matchOnSignIn({ login, emails: async () => emails });
  return { people, store, clock, asked, match };
}

test('a sign-in links the person to the Slack user with their email', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA } });
  assert.equal(ctx.people.slackUserFor('Ana-K'), null);
  assert.equal(await ctx.match('Ana-K'), 'linked');
  assert.equal(ctx.people.slackUserFor('ana-k'), 'U01ANA00001', 'handles are compared without case');
  assert.equal(ctx.store.state.slackAccounts['ana-k'].how, 'email');
  assert.deepEqual(ctx.people.links(['Ana-K']), { 'Ana-K': { slackId: 'U01ANA00001', name: 'Ana K', how: 'email' } });
  assert.equal(ctx.store.state.people, undefined, 'kept apart from the per-person settings Remove My Woodshed deletes');
});

test('no match, or a refusal such as a missing scope, leaves the person unmatched and does not throw', async () => {
  const none = setup();
  assert.equal(await none.match('ana-k'), 'unmatched');
  assert.equal(none.people.slackUserFor('ana-k'), null);

  const down = setup({ byEmail: { 'ana@example.com': new Error('fetch failed') } });
  assert.equal(await down.match('ana-k'), 'unmatched');
  assert.equal(down.people.slackUserFor('ana-k'), null);
});

test('a bot or a deactivated account is no match, and drops an earlier automatic link', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA } });
  await ctx.match('ana-k');
  ctx.clock.now += 24 * 3_600_000;
  ctx.asked.length = 0;
  ctx.people = createSlackPeople({
    store: ctx.store, now: () => ctx.clock.now,
    slack: { async personByEmail() { return { ...ANA, reachable: false }; } },
  });
  assert.equal(await ctx.people.matchOnSignIn({ login: 'ana-k', emails: async () => ['ana@example.com'] }), 'unmatched');
  assert.equal(ctx.people.slackUserFor('ana-k'), null);
});

test('a refusal on the daily re-check keeps the earlier automatic link', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA } });
  await ctx.match('ana-k');
  ctx.clock.now += 24 * 3_600_000;
  const refused = createSlackPeople({ store: ctx.store, now: () => ctx.clock.now, slack: { async personByEmail() { return null; } } });
  assert.equal(await refused.matchOnSignIn({ login: 'ana-k', emails: async () => ['ana@example.com'] }), 'unmatched');
  assert.equal(refused.slackUserFor('ana-k'), 'U01ANA00001');
});

test('automatic matching looks at most once a day, and tries every email until one matches', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA } });
  assert.equal(await ctx.match('ana-k', ['ana@home.example', 'ana@example.com']), 'linked');
  assert.deepEqual(ctx.asked, ['ana@home.example', 'ana@example.com']);
  assert.equal(await ctx.match('ana-k'), 'skipped');
  assert.equal(ctx.asked.length, 2, 'not asked again within the day');
  ctx.clock.now += 24 * 3_600_000;
  assert.equal(await ctx.match('ana-k'), 'linked');
  assert.equal(ctx.asked.length, 3);

  const missed = setup();
  await missed.match('bo');
  assert.equal(await missed.match('bo'), 'skipped', 'an unmatched person is not asked again within the day either');
});

test('a link set by hand is never overwritten by automatic matching', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA }, byId: { U02OTHER002: { id: 'U02OTHER002', name: 'Other', reachable: true } } });
  await ctx.people.setManual({ login: 'ana-k', value: 'U02OTHER002', by: 'mia' });
  assert.equal(await ctx.match('ana-k'), 'manual');
  ctx.clock.now += 7 * 24 * 3_600_000;
  assert.equal(await ctx.match('ana-k'), 'manual');
  assert.equal(ctx.people.slackUserFor('ana-k'), 'U02OTHER002');
  assert.equal(ctx.asked.length, 0, 'Slack was not even asked');
  assert.equal(ctx.people.links(['ana-k'])['ana-k'].how, 'manual');

  await ctx.people.setManual({ login: 'ana-k', value: '', by: 'mia' });
  assert.equal(ctx.people.slackUserFor('ana-k'), null, 'an empty value takes the link away');
  assert.equal(await ctx.match('ana-k'), 'linked', 'and automatic matching works again');
});

test('a manual link takes a member ID or an @handle, and rejects what Slack does not know', async () => {
  const ctx = setup({
    byId: { U01ANA00001: ANA, U09BOT0009: { id: 'U09BOT0009', name: 'bot', reachable: false } },
    byHandle: { ana: ANA },
  });
  await ctx.people.setManual({ login: 'x', value: '@ana', by: 'mia' });
  assert.equal(ctx.people.slackUserFor('x'), 'U01ANA00001');
  await ctx.people.setManual({ login: 'y', value: ' U01ANA00001 ', by: 'mia' });
  assert.equal(ctx.people.slackUserFor('y'), 'U01ANA00001');

  for (const value of ['U0NOSUCH999', '@nobody', 'not an id', 'U09BOT0009', '<@U01ANA00001>']) {
    await assert.rejects(ctx.people.setManual({ login: 'z', value, by: 'mia' }), (err) => err.shown === true, value);
  }
  assert.equal(ctx.people.slackUserFor('z'), null, 'nothing was kept');
});

test('with no Slack, nothing is matched and a manual link is refused', async () => {
  const store = { state: {}, save() {} };
  const people = createSlackPeople({ store, slack: null });
  assert.equal(await people.matchOnSignIn({ login: 'a', emails: async () => ['a@b.c'] }), 'skipped');
  await assert.rejects(people.setManual({ login: 'a', value: 'U01ANA00001', by: 'm' }), (err) => err.shown === true);
});

test('a hand-set link saved while Slack is being asked is not overwritten', async () => {
  const ctx = setup({ byEmail: { 'ana@example.com': ANA }, byId: { U02OTHER002: { id: 'U02OTHER002', name: 'Other', reachable: true } } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const matching = ctx.people.matchOnSignIn({ login: 'ana-k', emails: async () => { await gate; return ['ana@example.com']; } });
  await ctx.people.setManual({ login: 'ana-k', value: 'U02OTHER002', by: 'mia' });
  release();
  assert.equal(await matching, 'manual');
  assert.equal(ctx.people.slackUserFor('ana-k'), 'U02OTHER002');
});

test('a word that looks like an ID but has no digit is not one', async () => {
  const ctx = setup({ byHandle: { william: { id: 'U05WILLIAM5', name: 'William', reachable: true } } });
  await assert.rejects(ctx.people.setManual({ login: 'x', value: 'william', by: 'mia' }), (err) => err.shown === true, 'a bare name is no ID and no @handle');
  await ctx.people.setManual({ login: 'x', value: '@william', by: 'mia' });
  assert.equal(ctx.people.slackUserFor('x'), 'U05WILLIAM5');
});

test('a member ID typed in lowercase is accepted', async () => {
  const ctx = setup({ byId: { U01ANA00001: ANA } });
  await ctx.people.setManual({ login: 'x', value: 'u01ana00001', by: 'mia' });
  assert.equal(ctx.people.slackUserFor('x'), 'U01ANA00001');
});

test('search lists Slack members, and says so when Slack would not', async () => {
  const found = { found: [{ id: 'U01ANA00001', name: 'Ana K', handle: 'ana' }], truncated: false };
  const people = createSlackPeople({ store: { state: {}, save() {} }, slack: { async search(q) { return q === 'ana' ? found : null; } } });
  assert.deepEqual(await people.search({ query: 'ana' }), found);
  await assert.rejects(people.search({ query: 'zzz' }), (err) => err.shown === true && /users:read/.test(err.message));
  await assert.rejects(createSlackPeople({ store: { state: {}, save() {} }, slack: null }).search({ query: 'a' }), (err) => err.shown === true);
});
