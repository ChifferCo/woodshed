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

test('installationOf asks for the App\'s installation on a repo, and says null when it has none', async () => {
  const seen = [];
  async function fetchImpl(url, { headers }) {
    seen.push({ url, auth: headers.authorization });
    return url.includes('/acme/yes/')
      ? new Response(JSON.stringify({ id: 4242 }), { status: 200 })
      : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  const api = createAppApi({ appId: '1', privateKey: PEM, fetchImpl });
  assert.equal(await api.installationOf('acme/yes'), '4242');
  assert.equal(await api.installationOf('acme/no'), null);
  assert.equal(seen[0].url, 'https://api.github.com/repos/acme/yes/installation');
  assert.match(seen[0].auth, /^Bearer /, 'as the App itself');
  const broken = createAppApi({ appId: '1', privateKey: PEM, fetchImpl: async () => new Response('{}', { status: 502 }) });
  await assert.rejects(broken.installationOf('acme/yes'), /HTTP 502/);
});

test('a token source with no repo asks for the installation\'s token, as a key check does on a console with no repo yet', async () => {
  const clock = { now: Date.parse('2026-10-22T10:00:00Z') };
  const github = fakeGitHub({ clock });
  const source = createTokenSource({ appId: '1', installationId: '99', privateKey: PEM, repo: '', label: 'new key check', fetchImpl: github.fetchImpl, now: () => clock.now });
  await source.token();
  assert.deepEqual(github.calls[0].body, {}, 'no repositories: an empty name would be refused');
});

test('installations and their repos: the App\'s installations with their settings pages, and each one\'s repos page by page', async () => {
  const seen = [];
  async function fetchImpl(url, { method = 'GET', headers, body }) {
    seen.push([method, url.replace('https://api.github.com', ''), headers.authorization.startsWith('Bearer ey') ? 'jwt' : headers.authorization, body ?? null]);
    if (url.endsWith('/app/installations?per_page=100')) {
      return Response.json([{ id: 5, account: { login: 'acme' }, html_url: 'https://github.com/organizations/acme/settings/installations/5' }]);
    }
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_x' }, { status: 201 });
    const page = Number(new URL(url).searchParams.get('page'));
    const n = page === 1 ? 100 : 2;
    return Response.json({ repositories: Array.from({ length: n }, (_, i) => ({ full_name: `acme/r${page}-${i}`, private: i === 0 })) });
  }
  const api = createAppApi({ appId: '1', privateKey: PEM, fetchImpl });
  assert.deepEqual(await api.installations(), [{ id: '5', account: 'acme', settingsUrl: 'https://github.com/organizations/acme/settings/installations/5' }]);
  const repos = await api.installationRepos('5');
  assert.equal(repos.length, 102);
  assert.deepEqual(repos[0], { repo: 'acme/r1-0', private: true });
  assert.deepEqual(seen.slice(1).map((c) => c.slice(0, 3)), [
    ['POST', '/app/installations/5/access_tokens', 'jwt'],
    ['GET', '/installation/repositories?per_page=100&page=1', 'Bearer ghs_x'],
    ['GET', '/installation/repositories?per_page=100&page=2', 'Bearer ghs_x'],
  ]);
  assert.deepEqual(JSON.parse(seen[1][3]), { permissions: { metadata: 'read' } }, 'narrowed to reading metadata');
});
