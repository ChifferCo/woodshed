import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubUser } from './githubUser.mjs';
import { createUserSettings } from './userSettings.mjs';

const HOUR = 3_600_000;

function setup({ secret = 'cs', removeMs = 0 } = {}) {
  let clock = Date.parse('2026-10-23T10:00:00Z');
  const values = new Map();
  const secrets = {
    read: async (name) => values.get(name) ?? null,
    save: async (name, value) => { values.set(name, value); },
    remove: async (name) => {
      if (removeMs) await new Promise((resolve) => setTimeout(resolve, removeMs));
      values.delete(name);
    },
  };
  const store = { state: {}, save() {} };
  const userSettings = createUserSettings({ store, secrets, now: () => clock });
  const github = { refreshes: [], refuse: false, issued: 0, revoked: [], revokeStatus: 204, onRefresh: null, scoped: [], scopeStatus: 200, scopeDown: false };
  async function fetchImpl(url, init) {
    if (url.endsWith('/applications/Iv1.app/token/scoped')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('Iv1.app:cs').toString('base64')}`);
      if (github.scopeDown) throw new TypeError('fetch failed');
      const body = JSON.parse(init.body);
      github.scoped.push(body);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const ok = github.scopeStatus < 300;
      return { ok, status: github.scopeStatus, json: async () => (ok ? { token: `ghu_scoped_${github.scoped.length}`, expires_at: '2026-10-23T18:00:00Z' } : { message: 'Validation Failed' }) };
    }
    if (url.endsWith('/applications/Iv1.app/token')) {
      assert.equal(init.method, 'DELETE');
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('Iv1.app:cs').toString('base64')}`);
      github.revoked.push(JSON.parse(init.body).access_token);
      return { ok: github.revokeStatus < 300, status: github.revokeStatus, json: async () => ({}) };
    }
    if (url.endsWith('/user')) {
      const ok = init.headers.authorization.startsWith('Bearer ghu_');
      return { ok, status: ok ? 200 : 401, json: async () => ({ login: 'Octocat', id: 42, name: 'Mona Octocat' }) };
    }
    const body = JSON.parse(init.body);
    github.refreshes.push(body.refresh_token);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await github.onRefresh?.();
    if (github.refuse) return { ok: true, status: 200, json: async () => ({ error: 'bad_refresh_token' }) };
    github.issued += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: `ghu_${github.issued}`, expires_in: 28800, refresh_token: `ghr_${github.issued}` }) };
  }
  const user = createGitHubUser({ clientId: async () => 'Iv1.app', clientSecret: () => secret, userSettings, fetchImpl, now: () => clock });
  return { user, userSettings, values, github, advance: (ms) => { clock += ms; } };
}

test('Connect GitHub keeps the token and who GitHub says they are, for commits', async () => {
  const { user, userSettings, values } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  assert.deepEqual(JSON.parse(values.get('users/octocat/github')).refreshToken, 'ghr_first');
  assert.deepEqual(userSettings.gitIdentity('octocat'), { name: 'Mona Octocat', email: '42+Octocat@users.noreply.github.com' });
  assert.equal(userSettings.view('octocat').github.connected, true);
  assert.deepEqual(await user.tokenFor('octocat'), { token: 'ghu_first', expiresAt: Date.parse('2026-10-23T18:00:00Z') });
  assert.equal(await user.tokenFor('mia-dev'), null, 'not connected: the session pushes as the App');
  await assert.rejects(user.connect({ login: 'mia-dev', answer: { access_token: 'ghu_x' } }), /did not say who connected/);
});

test('an expiring token is refreshed once for everyone asking, and the new refresh token saved first', async () => {
  const { user, values, github, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  advance(8 * HOUR - 5 * 60_000);
  const [a, b] = await Promise.all([user.tokenFor('octocat'), user.tokenFor('octocat')]);
  assert.equal(a.token, 'ghu_1');
  assert.equal(b.token, 'ghu_1');
  assert.deepEqual(github.refreshes, ['ghr_first'], 'a refresh token works once, so two sessions share one refresh');
  assert.equal(JSON.parse(values.get('users/octocat/github')).refreshToken, 'ghr_1');
  advance(8 * HOUR);
  assert.equal((await user.tokenFor('octocat')).token, 'ghu_2');
  assert.deepEqual(github.refreshes, ['ghr_first', 'ghr_1'], 'each refresh spends the last one handed back');
});

test('a refresh GitHub refuses disconnects them, and says so', async () => {
  const { user, userSettings, values, github, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  advance(9 * HOUR);
  github.refuse = true;
  await assert.rejects(user.tokenFor('octocat'), (err) => err.shown && /connect GitHub again/.test(err.message));
  assert.equal(values.has('users/octocat/github'), false);
  assert.equal(userSettings.view('octocat').github.connected, false);
  assert.equal(await user.tokenFor('octocat'), null, 'their sessions then push as the App again');
});

test('a token that never expires is kept as it is', async () => {
  const { user, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_forever' } });
  advance(100 * HOUR);
  const own = await user.tokenFor('octocat');
  assert.equal(own.token, 'ghu_forever');
  assert.ok(own.expiresAt > Date.parse('2026-10-23T10:00:00Z') + 100 * HOUR, 'a session still asks again later');
  await user.disconnect('octocat');
  assert.equal(await user.tokenFor('octocat'), null);
});

test('Remove My Woodshed ends a cached token at once, and no refresh brings the connection back', async () => {
  const { user, userSettings, values, github, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  assert.equal((await user.tokenFor('octocat')).token, 'ghu_first');
  await userSettings.removeAll('octocat');
  assert.equal(await user.tokenFor('octocat'), null, 'not the token still in memory');
  advance(9 * 3_600_000);
  assert.equal(await user.tokenFor('octocat'), null);
  assert.deepEqual(github.refreshes, [], 'nothing refreshed');
  assert.equal(values.has('users/octocat/github'), false, 'and nothing written back');
});

test('GitHub having a moment keeps the connection, and the next ask refreshes', async () => {
  const { user, userSettings, values, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  advance(9 * 3_600_000);
  const down = createGitHubUser({
    clientId: async () => 'Iv1.app', clientSecret: () => 'cs', userSettings, now: () => Date.parse('2026-10-23T19:30:00Z'),
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
  });
  await assert.rejects(down.tokenFor('octocat'), (err) => !err.shown && /answered 502/.test(err.message));
  assert.equal(userSettings.view('octocat').github.connected, true, 'still connected');
  assert.equal(JSON.parse(values.get('users/octocat/github')).refreshToken, 'ghr_first', 'the refresh token is kept');
  assert.equal((await user.tokenFor('octocat')).token, 'ghu_1');
});

test('Disconnect ends the token at GitHub too, so a session that cached it cannot push with it', async () => {
  const { user, userSettings, values, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  await user.disconnect('octocat');
  assert.deepEqual(github.revoked, ['ghu_first']);
  assert.equal(values.has('users/octocat/github'), false);
  assert.equal(userSettings.view('octocat').github.connected, false);
});

test('a revoke GitHub refuses still disconnects', async () => {
  const { user, userSettings, values, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  github.revokeStatus = 502;
  await user.disconnect('octocat');
  assert.deepEqual(github.revoked, ['ghu_first']);
  assert.equal(values.has('users/octocat/github'), false);
  assert.equal(userSettings.view('octocat').github.connected, false);
  assert.equal(await user.tokenFor('octocat'), null);
});

test('a Disconnect while a refresh waits on GitHub stays disconnected, and the new token is ended', async () => {
  const { user, userSettings, values, github, advance } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  advance(9 * HOUR);
  github.onRefresh = () => user.disconnect('octocat');
  assert.equal(await user.tokenFor('octocat'), null, 'the session pushes as the App');
  assert.deepEqual(github.refreshes, ['ghr_first']);
  assert.deepEqual(github.revoked, ['ghu_first', 'ghu_1'], 'the held token and the one GitHub just answered with both end');
  assert.equal(values.has('users/octocat/github'), false, 'and nothing is written back');
  assert.equal(userSettings.view('octocat').github.connected, false);
});

test('a Disconnect that starts while a refresh waits on GitHub, and still deletes the stored token when it answers, keeps nothing', async () => {
  const { user, userSettings, values, github, advance } = setup({ removeMs: 30 });
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  advance(9 * HOUR);
  let disconnecting;
  github.onRefresh = () => { disconnecting = user.disconnect('octocat'); };
  assert.equal(await user.tokenFor('octocat'), null, 'the record still says connected, and still the new token is not handed out');
  await disconnecting;
  assert.ok(github.revoked.includes('ghu_1'), 'the token GitHub just answered with ends');
  assert.equal(values.has('users/octocat/github'), false, 'nothing is written back after the delete');
  assert.equal(userSettings.view('octocat').github.connected, false);
});

const TOOLS = { repo: 'acme/tools', permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } };

test('a scoped token reaches one repo with the given permissions, is made once and kept until it nears its expiry', async () => {
  const { user, github, advance } = setup();
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null, 'not connected: nothing to scope, the caller uses the App');
  assert.deepEqual(github.scoped, []);
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });

  const [a, b] = await Promise.all([user.scopedTokenFor('octocat', TOOLS), user.scopedTokenFor('Octocat', TOOLS)]);
  assert.deepEqual(a, { token: 'ghu_scoped_1', expiresAt: Date.parse('2026-10-23T18:00:00Z') });
  assert.deepEqual(b, a, 'two sessions asking at once share one request');
  assert.deepEqual(github.scoped, [{ access_token: 'ghu_first', target: 'acme', repositories: ['tools'], permissions: TOOLS.permissions }]);
  assert.equal((await user.scopedTokenFor('octocat', TOOLS)).token, 'ghu_scoped_1', 'kept: GitHub is not asked again');
  assert.equal(github.scoped.length, 1);

  await user.scopedTokenFor('octocat', { ...TOOLS, repo: 'acme/other' });
  assert.equal(github.scoped.length, 2, 'another repo gets its own');

  advance(8 * HOUR - 5 * 60_000);
  assert.equal((await user.scopedTokenFor('octocat', TOOLS)).token, 'ghu_scoped_3', 'near its expiry the token is refreshed, and a new one scoped from it');
  assert.equal(github.scoped.at(-1).access_token, 'ghu_1');
});

test('a scoped token GitHub refuses, cannot be reached for, or a console with no client secret, leaves the caller the App', async () => {
  const { user, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  github.scopeStatus = 422;
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null);
  github.scopeStatus = 200;
  github.scopeDown = true;
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null);
  github.scopeDown = false;
  assert.equal((await user.scopedTokenFor('octocat', TOOLS)).token, 'ghu_scoped_2', 'a refusal is not kept: the next ask tries again');

  const noSecret = setup({ secret: null });
  await noSecret.user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  assert.equal(await noSecret.user.scopedTokenFor('octocat', TOOLS), null);
  assert.deepEqual(noSecret.github.scoped, [], 'GitHub is not asked without the secret');
});

test('Disconnect ends the scoped tokens at GitHub too, so a session that cached one cannot push with it', async () => {
  const { user, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  await user.scopedTokenFor('octocat', TOOLS);
  await user.scopedTokenFor('octocat', { ...TOOLS, repo: 'acme/other' });
  await user.disconnect('octocat');
  assert.deepEqual(github.revoked, ['ghu_first', 'ghu_scoped_1', 'ghu_scoped_2']);
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null);
  assert.equal(github.scoped.length, 2, 'no new one after Disconnect');
});

test('a scoped token GitHub makes while Disconnect runs is ended, and never handed out', async () => {
  const { user, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  const asking = user.scopedTokenFor('octocat', TOOLS);
  await user.disconnect('octocat');
  assert.equal(await asking, null);
  assert.deepEqual(github.revoked, ['ghu_first', 'ghu_scoped_1']);
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null, 'nothing kept for the next ask');
});

test('a scoped token GitHub returns while Disconnect still deletes the stored token is ended too', async () => {
  const { user, github } = setup({ removeMs: 30 });
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  const asking = user.scopedTokenFor('octocat', TOOLS);
  const disconnecting = user.disconnect('octocat');
  assert.equal(await asking, null, 'GitHub answered before the record was gone: still not handed out');
  await disconnecting;
  assert.deepEqual([...github.revoked].sort(), ['ghu_first', 'ghu_scoped_1']);
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null);
});

test('a scoped token asked for after Disconnect starts, while it still deletes the stored token, is not made', async () => {
  const { user, github } = setup({ removeMs: 30 });
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  const disconnecting = user.disconnect('octocat');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null, 'the record still says connected, and still nothing is handed out');
  await disconnecting;
  assert.deepEqual(github.scoped, [], 'GitHub was not asked');
  assert.deepEqual(github.revoked, ['ghu_first']);
  assert.equal(await user.scopedTokenFor('octocat', TOOLS), null);
});

test('after a Disconnect ends, connecting again scopes tokens again', async () => {
  const { user, github } = setup();
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first' } });
  await user.disconnect('octocat');
  await user.connect({ login: 'octocat', answer: { access_token: 'ghu_again', expires_in: 28800, refresh_token: 'ghr_again' } });
  assert.equal((await user.scopedTokenFor('octocat', TOOLS)).token, 'ghu_scoped_1');
  assert.equal(github.scoped[0].access_token, 'ghu_again');
});
