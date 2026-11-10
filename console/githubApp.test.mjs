import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { appJwt, createAppApi, createTokenSource } from './githubApp.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('appJwt is an RS256 JWT for the App, backdated and under ten minutes', () => {
  const jwt = appJwt({ appId: '123', privateKey: PEM, nowMs: 1_000_000_000 });
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(claims, { iat: 1_000_000 - 60, exp: 1_000_000 + 540, iss: '123' });
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
});

function fakeGitHub({ status = 201, lifetimeMs = 3_600_000, clock }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    const ok = status < 300;
    return {
      ok,
      status,
      json: async () => (ok
        ? { token: `ghs_${calls.length}`, expires_at: new Date(clock.now + lifetimeMs).toISOString() }
        : { message: 'Bad credentials' }),
    };
  };
  return { calls, fetchImpl };
}

test('a token source asks for this repo only, narrowed, and reuses the token until 10 minutes before it expires', async () => {
  const clock = { now: Date.parse('2026-10-22T10:00:00Z') };
  const github = fakeGitHub({ clock });
  const source = createTokenSource({
    appId: '1', installationId: '99', privateKey: PEM, repo: 'acme/app', label: 'test',
    permissions: { contents: 'write' }, fetchImpl: github.fetchImpl, now: () => clock.now,
  });

  const [a, b] = await Promise.all([source.token(), source.token()]);
  assert.equal(github.calls.length, 1, 'two callers at once share one mint');
  assert.equal(a.token, 'ghs_1');
  assert.equal(b.token, 'ghs_1');
  assert.equal(github.calls[0].url, 'https://api.github.com/app/installations/99/access_tokens');
  assert.deepEqual(github.calls[0].body, { repositories: ['app'], permissions: { contents: 'write' } });
  assert.match(github.calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  clock.now += 49 * 60_000;
  assert.equal((await source.token()).token, 'ghs_1', '11 minutes left: still reused');
  clock.now += 2 * 60_000;
  assert.equal((await source.token()).token, 'ghs_2', '9 minutes left: a new one');
});

test('a token source without permissions asks for everything the App has', async () => {
  const clock = { now: 0 };
  const github = fakeGitHub({ clock });
  const source = createTokenSource({ appId: '1', installationId: '99', privateKey: PEM, repo: 'o/r', label: 'test', fetchImpl: github.fetchImpl, now: () => clock.now });
  await source.token();
  assert.deepEqual(github.calls[0].body, { repositories: ['r'] });
});

test('a refused mint throws with GitHub\'s reason, and the next call tries again', async () => {
  const clock = { now: 0 };
  const github = fakeGitHub({ status: 401, clock });
  const source = createTokenSource({ appId: '1', installationId: '99', privateKey: PEM, repo: 'o/r', label: 'test', fetchImpl: github.fetchImpl, now: () => clock.now });
  await assert.rejects(source.token(), /HTTP 401 Bad credentials/);
  await assert.rejects(source.token(), /HTTP 401/);
  assert.equal(github.calls.length, 2);
});

test('an App whose webhook is switched off reads as inactive with no deliveries, not as an error', async () => {
  const notFound = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  const api = createAppApi({ appId: '1', privateKey: PEM, fetchImpl: notFound });
  assert.deepEqual(await api.hookConfig(), { active: false, url: '', contentType: '', insecureSsl: '' });
  assert.deepEqual(await api.deliveries(), []);
  await assert.rejects(api.app(), (err) => err.status === 404 && /HTTP 404/.test(err.message));
  await assert.rejects(api.setHookConfig({ secret: 's' }), (err) => err.status === 404);
});

test('deliveries reads the App webhook\'s last ten deliveries with the App JWT', async () => {
  const seen = [];
  async function fetchImpl(url, { method, headers }) {
    seen.push({ url, method, auth: headers.authorization });
    return new Response(JSON.stringify([
      { id: 7, guid: 'g-1', delivered_at: '2026-10-22T21:00:00Z', redelivery: false, status: 'Unauthorized', status_code: 401, event: 'issues', action: 'labeled' },
      { id: 6, guid: 'g-0', delivered_at: '2026-10-22T20:00:00Z', redelivery: true, status: 'OK', status_code: 202, event: 'ping' },
    ]), { status: 200 });
  }
  const api = createAppApi({ appId: '1', privateKey: PEM, fetchImpl });
  assert.deepEqual(await api.deliveries(), [
    { id: 7, guid: 'g-1', deliveredAt: '2026-10-22T21:00:00Z', event: 'issues', action: 'labeled', statusCode: 401, status: 'Unauthorized', redelivery: false },
    { id: 6, guid: 'g-0', deliveredAt: '2026-10-22T20:00:00Z', event: 'ping', action: null, statusCode: 202, status: 'OK', redelivery: true },
  ]);
  assert.equal(seen[0].url, 'https://api.github.com/app/hook/deliveries?per_page=10');
  assert.equal(seen[0].method, 'GET');
  assert.match(seen[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});
