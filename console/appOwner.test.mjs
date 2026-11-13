import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appOwnerCheck } from './appOwner.mjs';

function fakeApi({ account, membership = null, refuse = null }) {
  const asked = [];
  return {
    asked,
    async installationAccount(id) { asked.push(['account', id]); return account; },
    async orgMembership(id, org, login) {
      asked.push(['membership', id, org, login]);
      if (refuse) throw Object.assign(new Error('refused'), { status: refuse });
      return typeof membership === 'function' ? membership(login) : membership;
    },
  };
}

test('on a user\'s installation, that user is the owner, whatever the case of the login', async () => {
  const appApi = fakeApi({ account: { login: 'Mia-Dev', type: 'User' } });
  const owns = appOwnerCheck({ appApi, installationId: '42' });
  assert.equal(await owns('mia-dev'), true);
  assert.equal(await owns('octocat'), false);
  assert.deepEqual(appApi.asked, [['account', '42']], 'the account is read once, and a user needs no membership read');
});

test('on an organization\'s installation, its active admins are owners, and members are not', async () => {
  const roles = { boss: { role: 'admin', state: 'active' }, invited: { role: 'admin', state: 'pending' }, dev: { role: 'member', state: 'active' } };
  const appApi = fakeApi({ account: { login: 'acme', type: 'Organization' }, membership: (login) => roles[login] ?? null });
  const owns = appOwnerCheck({ appApi, installationId: '42' });
  assert.equal(await owns('boss'), true);
  assert.equal(await owns('invited'), false, 'an invitation not accepted yet is no membership');
  assert.equal(await owns('dev'), false);
  assert.equal(await owns('stranger'), false);
  assert.deepEqual(appApi.asked[1], ['membership', '42', 'acme', 'boss']);
});

test('an App that may not read the org\'s members says what to grant, on the login page', async () => {
  for (const status of [403, 422]) {
    const owns = appOwnerCheck({ appApi: fakeApi({ account: { login: 'acme', type: 'Organization' }, refuse: status }), installationId: '42' });
    await assert.rejects(owns('boss'), (err) => err.shown === true && /Organization permissions, Members: read/.test(err.message));
  }
  const owns = appOwnerCheck({ appApi: fakeApi({ account: { login: 'acme', type: 'Organization' }, refuse: 502 }), installationId: '42' });
  await assert.rejects(owns('boss'), (err) => !err.shown, 'GitHub failing is the console\'s, not something to tell the person');
});

test('with no installation there is nobody to ask about', async () => {
  await assert.rejects(appOwnerCheck({ appApi: fakeApi({ account: null }), installationId: null })('boss'), /no GitHub App installation/);
});
