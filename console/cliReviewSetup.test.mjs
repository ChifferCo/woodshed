import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import { fakeGitHub } from './bin/devReviewSetup.mjs';
import { cliMayCallReviewSetup, isCliReviewSetupCall } from './cliReviewSetup.mjs';
import { createCliSignIn } from './cliSignIn.mjs';
import { appGitHub, createReviewSetup } from './reviewSetup.mjs';
import { createHandler } from './server.mjs';

const TEAM_KEY = 'sk-ant-api03-TEAMKEY-never-shown-0123456789';
const { privateKey: APP_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

// A console with the command line's sign-in and the review setup on a made-up GitHub: ann is an admin of acme/game,
// bob can write to it, and cookies sign in whoever they name.
async function consoleFor(t, { withApp = true, people = null } = {}) {
  const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
  const now = () => clock.t;
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now, allowed: (login) => !people || people.has(login) });
  const gh = fakeGitHub({ 'acme/game': { admins: ['ann'], writers: ['bob'] } }, { now });
  let handle = null;
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://localhost:${server.address().port}`;
  const config = {
    host: '127.0.0.1', publicUrl: origin, extraHosts: [], repo: 'acme/app', label: 'woodshed', consoleName: 'Acme Woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let n = 0;
  const reviewSetup = withApp ? createReviewSetup({
    store, github: appGitHub({ appId: '42', privateKey: APP_KEY, fetchImpl: gh.fetch, now }), teamKey: async () => TEAM_KEY,
    publicUrl: origin, newId: () => `${(n += 1)}`.padStart(12, 'a'), now,
  }) : null;
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli, reviewSetup });
  // A token for `login`, as woodshed login gets one.
  const tokenFor = (login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode);
  };
  const call = (p, { method = 'GET', token = null, cookie = null, body, headers = {} } = {}) => fetch(`${origin}${p}`, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie: `woodshed_session=${cookie}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { origin, cli, gh, store, call, tokenFor, clock };
}

test('the command line\'s token reaches exactly three review setup routes', () => {
  assert.ok(cliMayCallReviewSetup('GET', '/api/review-setup'));
  assert.ok(cliMayCallReviewSetup('POST', '/api/review-setup'));
  assert.ok(cliMayCallReviewSetup('GET', '/api/review-setup/0123456789ab'));
  for (const [method, path] of [
    ['POST', '/api/review-setup/0123456789ab/approve'], ['POST', '/api/review-setup/0123456789ab/refuse'], ['POST', '/api/review-setup/0123456789ab'],
    ['DELETE', '/api/review-setup'], ['GET', '/api/review-setup/0123456789ab/approve'], ['GET', '/review-setup/0123456789ab'], ['GET', '/api/sessions'],
  ]) assert.ok(!cliMayCallReviewSetup(method, path), `${method} ${path}`);
  assert.ok(isCliReviewSetupCall({ authorization: 'Bearer wsc_abc' }, '/api/review-setup/0123456789ab/approve'), 'every review setup route with a token is answered here, refused or not');
  assert.ok(!isCliReviewSetupCall({ authorization: 'Bearer wsc_abc' }, '/api/sessions'));
  assert.ok(!isCliReviewSetupCall({ cookie: 'woodshed_session=x' }, '/api/review-setup'));
});

test('a token asks and reads as its person, never as a console admin, and approves or refuses nothing', async (t) => {
  const c = await consoleFor(t);
  const { token, id: tokenId } = c.tokenFor('bob');
  const made = await c.call('/api/review-setup', { method: 'POST', token, body: { repo: 'acme/game' } });
  assert.equal(made.status, 201);
  const request = await made.json();
  assert.equal(request.status, 'pending');
  assert.equal(request.url, `${c.origin}/review-setup/${request.id}`);
  assert.deepEqual(c.store.state.reviewSetups[0].by, { login: 'bob' }, 'asked as the token\'s person');
  assert.equal(c.store.state.reviewSetups[0].history[0].by, 'bob');
  assert.ok(tokenId);

  const listed = await (await c.call('/api/review-setup', { token })).json();
  assert.deepEqual(listed.requests.map((r) => r.id), [request.id]);
  const one = await (await c.call(`/api/review-setup/${request.id}`, { token })).json();
  assert.equal(one.mine, true);
  assert.ok(one.plan, 'bob can write to the repo, so he sees what approving it would change, as on the page');
  assert.equal(one.canApprove.ok, false, 'only an admin of the repo approves');

  // Ann is an admin of the repo and, here, of the console: her token still reads as an asker's.
  const ann = c.tokenFor('ann').token;
  assert.deepEqual((await (await c.call('/api/review-setup', { token: ann })).json()).requests, [], 'a console admin\'s token lists only her own');
  for (const action of ['approve', 'refuse']) {
    const refused = await c.call(`/api/review-setup/${request.id}/${action}`, { method: 'POST', token: ann, body: { digest: one.plan.digest } });
    assert.equal(refused.status, 403, `${action} is made on the page`);
    assert.match((await refused.json()).error, /on its page/);
  }
  assert.equal(c.store.state.reviewSetups[0].status, 'pending');

  // On the page, with her cookie, she approves it.
  const shown = await (await c.call(`/api/review-setup/${request.id}`, { cookie: 'ann' })).json();
  const approved = await c.call(`/api/review-setup/${request.id}/approve`, {
    method: 'POST', cookie: 'ann', body: { digest: shown.plan.digest }, headers: { 'x-woodshed': '1', origin: c.origin },
  });
  assert.equal((await approved.json()).status, 'applied');
  const after = await (await c.call(`/api/review-setup/${request.id}`, { token })).json();
  assert.equal(after.status, 'applied');
  assert.ok(!JSON.stringify(after).includes(TEAM_KEY));
});

test('a token\'s call refused: from a page, forged, revoked, off People, someone else\'s request', async (t) => {
  const people = new Set(['bob', 'eve']);
  const c = await consoleFor(t, { people });
  const { token, id } = c.tokenFor('bob');
  const fromPage = await c.call('/api/review-setup', { method: 'POST', token, body: { repo: 'acme/game' }, headers: { origin: c.origin } });
  assert.equal(fromPage.status, 403, 'any Origin, the console\'s own too, is a page\'s call');
  assert.equal(c.store.state.reviewSetups.length, 0);
  assert.equal((await c.call('/api/review-setup', { token: `wsc_${'0'.repeat(64)}` })).status, 401);

  const mine = await (await c.call('/api/review-setup', { method: 'POST', token, body: { repo: 'acme/game' } })).json();
  const eve = c.tokenFor('eve').token;
  assert.equal((await c.call(`/api/review-setup/${mine.id}`, { token: eve })).status, 404, 'eve neither asked nor can write to the repo');

  people.delete('bob');
  assert.equal((await c.call('/api/review-setup', { token })).status, 401, 'taken off People, the token stops at once');
  people.add('bob');
  c.cli.revoke('bob', id);
  assert.equal((await c.call('/api/review-setup', { token })).status, 401);
});

test('the page\'s cookie path is as it was, and a token reaches no other route through this one', async (t) => {
  const c = await consoleFor(t);
  const { token } = c.tokenFor('bob');
  assert.equal((await c.call('/api/review-setup', { method: 'POST', cookie: 'bob', body: { repo: 'acme/game' } })).status, 403, 'a page still needs x-woodshed');
  assert.equal((await c.call('/api/review-setup', { method: 'POST', cookie: 'bob', body: { repo: 'acme/game' }, headers: { 'x-woodshed': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.call('/api/review-setup', { method: 'POST', cookie: 'bob', body: { repo: 'acme/game' }, headers: { 'x-woodshed': '1', origin: c.origin } })).status, 201);
  for (const p of ['/api/sessions', '/api/my', '/api/people']) assert.notEqual((await c.call(p, { token })).status, 200, `${p} is not signed in by a token here`);
});

test('a console with no GitHub App of its own says so to the command line', async (t) => {
  const c = await consoleFor(t, { withApp: false });
  const { token } = c.tokenFor('bob');
  const answer = await c.call('/api/review-setup', { method: 'POST', token, body: { repo: 'acme/game' } });
  assert.equal(answer.status, 404);
  assert.match((await answer.json()).error, /no GitHub App of its own/);
});
