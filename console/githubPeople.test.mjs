import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubPeople } from './githubPeople.mjs';

function setup(users = {}) {
  const store = { state: {}, save() {} };
  const clock = { now: 1_000_000 };
  const asked = [];
  const github = {
    async user(login) {
      asked.push(login);
      const user = users[login];
      if (user instanceof Error) throw user;
      if (!user) throw new Error('gh: Not Found (HTTP 404)');
      return { login, ...user };
    },
  };
  return { people: createGitHubPeople({ store, github, now: () => clock.now }), store, clock, asked, users };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('names answers what it knows and looks up the rest once, for the next answer', async () => {
  const ctx = setup({ octo: { id: 1, name: 'Octo Cat' }, plain: { id: 2, name: null } });
  assert.deepEqual(ctx.people.names(['octo', 'plain', 'octo', null]), {}, 'nothing known yet: every handle shows as @handle');
  assert.deepEqual(ctx.people.names(['octo']), {}, 'a lookup in flight is not asked twice');
  await settle();
  assert.deepEqual(ctx.asked, ['octo', 'plain']);
  assert.deepEqual(ctx.people.names(['octo', 'plain']), { octo: 'Octo Cat' }, 'a handle with no display name stays out');
  await settle();
  assert.equal(ctx.asked.length, 2, 'not asked again within the day');

  ctx.users.octo.name = 'Octo Renamed';
  ctx.clock.now += 24 * 3_600_000;
  assert.deepEqual(ctx.people.names(['octo']), { octo: 'Octo Cat' }, 'the old name until the refresh lands');
  await settle();
  assert.deepEqual(ctx.people.names(['octo']), { octo: 'Octo Renamed' });
});

test('a failed lookup keeps the last name and is not asked again for 15 minutes', async () => {
  const ctx = setup({ octo: new Error('gh: HTTP 502') });
  ctx.people.names(['octo']);
  await settle();
  ctx.people.names(['octo']);
  await settle();
  assert.equal(ctx.asked.length, 1);
  ctx.clock.now += 15 * 60_000;
  ctx.people.names(['octo']);
  await settle();
  assert.equal(ctx.asked.length, 2);
});

test('check refuses a handle that another account now holds, keeping the first account, and lets a failed lookup through', async () => {
  const ctx = setup({ octo: { id: 1, name: 'Octo Cat' } });
  assert.equal(await ctx.people.check('octo'), true);
  assert.equal(await ctx.people.check('Octo'), true, 'handles are compared without case');

  ctx.users.octo = { id: 2, name: 'Someone Else' };
  ctx.clock.now += 24 * 3_600_000;
  assert.equal(await ctx.people.check('octo'), false);
  assert.deepEqual(ctx.store.state.githubAccounts.octo, { id: 1, name: 'Octo Cat', checkedAt: ctx.clock.now }, 'the first account is kept');
  const asked = ctx.asked.length;
  ctx.people.names(['octo']);
  await settle();
  assert.equal(ctx.asked.length, asked, 'checked just now: the pages do not ask again on every load');

  ctx.users.octo = new Error('gh: HTTP 502');
  assert.equal(await ctx.people.check('octo'), true, 'write access was already checked; GitHub down must not stop a label');
});
