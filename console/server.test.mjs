import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { CONSOLE_FAILED, createAuth } from './auth.mjs';
import { createAddedProjects, createHostProjects } from './addedProjects.mjs';
import { createConsoleSettings, liveConfig } from './consoleSettings.mjs';
import { createProjectColors } from './projectColors.mjs';
import { createTunnel } from './dbTunnel.mjs';
import { createHandler } from './server.mjs';
import { createSlack } from './slack.mjs';
import { createUserSettings } from './userSettings.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the console refuses unknown hosts and cross-origin writes', async (t) => {
  const stopped = [];
  const session = { id: '0a1b2c3d', status: 'running', title: 't' };
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    stop: async (s) => { stopped.push(s.id); },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal(await request(port, { path: '/api/sessions', headers: { host: `localhost:${port}` } }), 200);
  assert.equal(await request(port, { path: '/api/sessions', headers: { host: 'console.example' } }), 200);
  assert.equal(await request(port, { path: '/api/sessions', headers: { host: 'rebound.evil.example' } }), 421);
  assert.equal(await request(port, { path: '/term/0a1b2c3d/', headers: { host: 'rebound.evil.example' } }), 421);

  const stop = { method: 'POST', path: '/api/sessions/0a1b2c3d/stop' };
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}` } }), 403);
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: 'https://evil.example' } }), 403);
  assert.deepEqual(stopped, []);
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: `http://localhost:${port}` } }), 200);
  assert.deepEqual(stopped, ['0a1b2c3d']);
});

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('a secrets change needs the name typed, from the console\'s own origin', async (t) => {
  const done = [];
  const settings = {
    async replace(name, value) { done.push(['replace', name, value]); },
    async reveal(name) { done.push(['reveal', name]); return 'the-value'; },
    async rotateWebhookSecret() { done.push(['rotate']); },
    async applyWebhook() { done.push(['apply']); },
    async setWebhookUrl(url) {
      done.push(['url', url]);
      throw Object.assign(new Error('GitHub must post over https'), { shown: true });
    },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, settings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal((await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' }, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'npm' }), { status: 400, body: { error: 'type registry-token to confirm' } });
  assert.equal((await post(port, '/api/webhook/rotate', { confirm: 'webhook' })).status, 400);
  assert.equal((await post(port, '/api/webhook/apply', null)).status, 400);
  assert.deepEqual(done, []);

  assert.equal((await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' })).status, 200);
  assert.deepEqual(await post(port, '/api/secrets/registry-token/reveal', {}), { status: 200, body: { value: 'the-value' } });
  assert.equal((await post(port, '/api/webhook/rotate', { confirm: 'github-webhook-secret' })).status, 200);
  assert.equal((await post(port, '/api/webhook/apply', { confirm: 'webhook' })).status, 200);
  assert.deepEqual(await post(port, '/api/webhook/url', { url: 'http://x', confirm: 'webhook' }), { status: 409, body: { error: 'GitHub must post over https' } });
  assert.deepEqual(done, [['replace', 'registry-token', 'v'], ['reveal', 'registry-token'], ['rotate'], ['apply'], ['url', 'http://x']]);
});

function getWith(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the Diff tab\'s read goes to the running session\'s statusd, with its token, and a stopped session is refused', async (t) => {
  const asked = [];
  const statusd = http.createServer((req, res) => {
    asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, base: 'master', files: [] }));
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const running = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const stopped = { id: '1b2c3d4e', status: 'stopped', title: 's', token: 'tok2' };
  const fleet = { sessions: () => [running, stopped], find: (id) => [running, stopped].find((s) => s.id === id) ?? null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/diff`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, base: 'master', files: [] });
  assert.deepEqual(asked, [{ method: 'GET', url: '/diff', authorization: 'Bearer tok' }]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/1b2c3d4e/diff`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/ffffffff/diff`)).status, 404);
  assert.equal(asked.length, 1, 'nothing asked for a stopped or unknown session');
});

test('with sign-in on, everything but the sign-in pages needs a session', async (t) => {
  const session = { id: '0a1b2c3d', status: 'running', title: 't', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 2 } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null), stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let on = true;
  let callbackError = Object.assign(new Error('That sign-in link has expired'), { shown: true });
  const auth = {
    enabled: () => on,
    available: () => true,
    sessionFor: async (cookie) => (String(cookie).includes('woodshed_session=good') ? { login: 'octo' } : null),
    start: async () => ({ location: 'https://github.com/login/oauth/authorize?x=1', setCookie: 'woodshed_oauth_state=s' }),
    callback: async () => { throw callbackError; },
    signOut: () => 'woodshed_session=; Max-Age=0',
  };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const page = { accept: 'text/html' };
  const good = { cookie: 'woodshed_session=good' };

  assert.deepEqual(await getWith(port, '/events?show=acted', page), { status: 302, location: '/login?next=%2Fevents%3Fshow%3Dacted' });
  assert.equal((await getWith(port, '/api/sessions')).status, 401);
  assert.equal((await getWith(port, '/term/0a1b2c3d/', page)).status, 302, 'a terminal frame goes to sign-in, never to the session');
  assert.equal((await getWith(port, '/redis/0a1b2c3d/')).status, 401);
  const stop = { method: 'POST', path: '/api/sessions/0a1b2c3d/stop', headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: `http://localhost:${port}` } };
  assert.equal(await request(port, stop), 401);
  for (const open of ['/login', '/api/me', '/healthz', '/static/style.css']) assert.equal((await getWith(port, open)).status, 200, open);

  assert.equal((await getWith(port, '/events', { ...page, ...good })).status, 200);
  assert.equal((await getWith(port, '/api/sessions', good)).status, 200);

  assert.deepEqual(await getWith(port, '/auth/start?next=/events'), { status: 302, location: 'https://github.com/login/oauth/authorize?x=1' });
  assert.deepEqual(await getWith(port, '/auth/callback?code=c&state=s'), { status: 302, location: '/login?error=That%20sign-in%20link%20has%20expired' });
  callbackError = Object.assign(new Error('spawn gh ENOENT'), { step: 'write access', next: '/events' });
  const failed = await getWith(port, '/auth/callback?code=c&state=s');
  assert.equal(failed.location, `/login?error=${encodeURIComponent(CONSOLE_FAILED)}&next=%2Fevents`, 'the console\'s own failure says so, and never what it was');
  const signOut = (origin) => ({ method: 'POST', path: '/auth/sign-out', headers: { host: `localhost:${port}`, origin, ...good } });
  assert.equal(await request(port, signOut('https://evil.example')), 403);
  assert.equal(await request(port, signOut(`http://localhost:${port}`)), 303);

  on = false;
  assert.equal((await getWith(port, '/api/sessions')).status, 200, 'until the client secret is set, nothing is gated');
});

test('once sign-in can be used, the bare IP sends a page to the console\'s name', async (t) => {
  const fleet = { sessions: () => [], find: () => null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: ['203.0.113.7'], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let available = false;
  let on = false;
  const auth = { enabled: () => on, available: () => available, sessionFor: async () => null };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const onIp = { host: '203.0.113.7' };

  assert.equal((await getWith(port, '/events', onIp)).status, 200, 'with no client secret the IP works as before');
  available = true;
  assert.deepEqual(await getWith(port, '/events?show=acted', onIp), { status: 302, location: 'https://console.example/events?show=acted' });
  assert.deepEqual(await getWith(port, '/login?next=%2Fs%2F0a1b2c3d', onIp), { status: 302, location: 'https://console.example/login?next=%2Fs%2F0a1b2c3d' });
  assert.equal((await getWith(port, '/healthz', onIp)).status, 200, 'health checks stay on any name');
  assert.equal((await getWith(port, '/events')).status, 200, 'localhost is not a public name');
});

// Every route the console serves, signed out, on a console that always requires sign-in. Nothing may reach
// a session, a secret or GitHub, whether the client secret is missing or set and not yet proven by a sign-in.
test('with sign-in always required, no route but sign-in\'s own answers a signed-out browser', async (t) => {
  const reached = [];
  const session = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 2 } };
  const fleet = {
    sessions: () => { reached.push('sessions'); return [session]; },
    find: (id) => { reached.push(`find ${id}`); return id === session.id ? session : null; },
    stop: async () => { reached.push('stop'); },
    startApp: async () => { reached.push('startApp'); },
    stopApp: async () => { reached.push('stopApp'); },
    create: async () => { reached.push('create'); },
  };
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const review = async () => { reached.push('review'); return {}; };
  const events = { list: () => { reached.push('events'); return []; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: ['203.0.113.7'], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example', launcher: { kind: 'ecs' },
  };

  for (const secret of [null, 'cs']) {
    const store = { state: {}, save() {} };
    const auth = createAuth({
      publicUrl: config.publicUrl, store, clientId: async () => 'Iv1.app', clientSecret: () => secret,
      canWrite: async () => true, fetchImpl: async () => { throw new Error('no GitHub call while signed out'); }, required: true,
    });
    assert.equal(auth.enabled(), true, `required with secret ${secret}`);
    auth.disarm();
    assert.equal(auth.enabled(), true, 'a new client secret never makes sign-in optional');
    const handle = createHandler({ config, fleet, settings, events, auth, review });
    const server = http.createServer((req, res) => { handle(req, res); });
    const port = await listen(server);
    t.after(() => server.close());
    const write = { host: 'console.example', 'x-woodshed': '1', origin: 'https://console.example', 'content-type': 'application/json' };

    const gets = ['/', '/s/0a1b2c3d', '/events', '/secrets', '/api/sessions', '/api/sessions/0a1b2c3d/review', '/api/sessions/0a1b2c3d/diff',
      '/api/webhook-events', '/api/secrets', '/api/webhook/deliveries', '/term/0a1b2c3d/', '/term/0a1b2c3d/token', '/shell/0a1b2c3d/',
      '/redis/0a1b2c3d/', '/pg/0a1b2c3d/', '/mongo/0a1b2c3d/', '/auth/app?id=0a1b2c3d&next=/', '/nope'];
    for (const path of gets) {
      for (const accept of ['text/html', 'application/json']) {
        const { status, location } = await getWith(port, path, { host: 'console.example', accept });
        assert.ok(status === 401 || (status === 302 && location.startsWith('/login?')), `GET ${path} (${accept}) answered ${status} ${location ?? ''}`);
      }
    }
    const posts = ['/api/sessions', '/api/sessions/0a1b2c3d/stop', '/api/sessions/0a1b2c3d/app/start', '/api/sessions/0a1b2c3d/app/stop',
      '/api/sessions/0a1b2c3d/resume', '/api/sessions/0a1b2c3d/delete',
      '/api/secrets/registry-token', '/api/secrets/registry-token/reveal', '/api/webhook/rotate', '/api/webhook/apply', '/api/webhook/url', '/term/0a1b2c3d/'];
    for (const path of posts) assert.equal(await request(port, { method: 'POST', path, headers: write }), 401, `POST ${path}`);
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal(await request(port, { method, path: '/api/sessions', headers: write }), 401, method);

    const app = { host: '0a1b2c3d.console.example', accept: 'text/html' };
    const appPage = await getWith(port, '/workflows', app);
    assert.equal(appPage.status, 302);
    assert.match(appPage.location, /^https:\/\/console\.example\/auth\/app\?id=0a1b2c3d/, 'an app page goes through the console');
    assert.equal(await request(port, { method: 'POST', path: '/api-proxy/x', headers: { host: '0a1b2c3d.console.example' } }), 401);
    assert.equal((await getWith(port, '/__woodshed/auth?code=guess&next=/', app)).status, 403, 'a made-up app code');

    for (const open of ['/login', '/api/me', '/healthz', '/static/style.css']) {
      assert.equal((await getWith(port, open, { host: 'console.example' })).status, 200, open);
    }
    const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { host: 'console.example' } })).json();
    assert.deepEqual(me, { supported: true, signIn: true, available: Boolean(secret), login: null, visitor: null, asked: null, admin: false, asking: 0, names: {}, repo: null, workflows: [] });
  }
  assert.deepEqual(reached.filter((r) => r !== 'find ffffffff'), [], 'nothing reached a session, a secret or GitHub');
});

test('an admin invites, accepts and removes on the People page, a member who is not one cannot, and a visitor can only ask to join', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const loginOf = (cookie) => /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (members.isMember(loginOf(cookie)) ? { login: loginOf(cookie) } : null),
    visitorFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
  };
  const github = { canWrite: async (login) => login !== 'outsider' };
  const revoked = [];
  const tunnel = { revoke: (login) => revoked.push(login) };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, github, tunnel });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };

  assert.equal((await getWith(port, '/api/people', sam)).status, 401, 'a visitor sees nobody on the list');
  assert.equal((await post(port, '/api/people/invite', { login: 'sam-ops' }, sam)).status, 401, 'nor changes it');
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([me.login, me.visitor, me.asked], [null, 'sam-ops', null]);
  const asked = await post(port, '/api/access/ask', {}, sam);
  assert.equal(asked.status, 200);
  assert.ok(asked.body.asked);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: mia })).json()).asking, 1, 'an admin sees someone is asking');

  const accepted = await post(port, '/api/people/accept', { login: 'sam-ops' }, mia);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.requests, []);
  const samMe = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([samMe.login, samMe.admin], ['sam-ops', false], 'accepted, they are in, as a member who is not an admin');
  assert.equal((await getWith(port, '/api/people', sam)).status, 403, 'only an admin reads the list');
  for (const action of ['invite', 'remove', 'assignable', 'github-sessions', 'admin', 'slack']) {
    assert.equal((await post(port, `/api/people/${action}`, { login: 'sam-ops', admin: true, on: true }, sam)).status, 403, `${action} is an admin's`);
  }
  assert.equal(members.isAdmin('sam-ops'), false, 'nobody makes themselves an admin');
  assert.deepEqual((await post(port, '/api/people/invite', { login: '@outsider' }, mia)).status, 400, 'a handle without write access could never sign in');
  const invited = await post(port, '/api/people/invite', { login: '@ana-k' }, mia);
  assert.equal(invited.status, 200);
  assert.deepEqual(invited.body.members.find((m) => m.login === 'ana-k'), { login: 'ana-k', addedBy: 'mia-dev', addedAt: invited.body.members.find((m) => m.login === 'ana-k').addedAt, how: 'invited' });
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: false }, mia)).status, 409, 'the last admin keeps it');
  assert.equal((await post(port, '/api/people/admin', { login: 'sam-ops', admin: true }, mia)).status, 200);
  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'made an admin, they open People');
  assert.equal((await post(port, '/api/people/remove', { login: 'mia-dev' }, mia)).status, 409, 'nobody removes themselves');
  assert.equal((await post(port, '/api/people/remove', { login: 'sam-ops' }, mia)).status, 200);
  assert.equal((await getWith(port, '/api/people', sam)).status, 401, 'removed, they are out at once');
  assert.deepEqual(revoked, ['sam-ops'], 'and their database tunnels with them, the open ones too');
  assert.equal((await post(port, '/api/access/ask', {}, { ...sam, origin: 'https://evil.example' })).status, 403);
});

test('on a console with no list of people, everyone signed in reaches the Secrets & webhooks and Webhook events pages', async (t) => {
  const reached = [];
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const events = { list: () => { reached.push('events'); return []; } };
  const fleet = {
    sessions: () => [], find: () => null,
    startManual: async () => { reached.push('startManual'); return { id: '0a1b2c3d' }; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return login ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet, settings, events, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const reads = ['/events', '/secrets', '/api/webhook-events', '/api/secrets', '/api/webhook/deliveries'];
  const writes = [['/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' }], ['/api/secrets/registry-token/reveal', {}],
    ['/api/webhook/rotate', { confirm: 'github-webhook-secret' }], ['/api/webhook/apply', { confirm: 'webhook' }],
    ['/api/webhook/url', { url: 'https://x', confirm: 'webhook' }], ['/api/sessions', { number: 1, startedBy: 'mia-dev' }]];
  for (const path of reads) assert.equal((await getWith(port, path, { ...as, accept: 'text/html' })).status, 200, `GET ${path}`);
  for (const [path, body] of writes) assert.ok([200, 201].includes((await post(port, path, body, as)).status), `POST ${path}`);
  assert.ok(reached.includes('events') && reached.includes('startManual'));
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: as })).json();
  assert.deepEqual(me, { supported: true, signIn: true, available: true, login: 'mia-dev', visitor: null, asked: null, admin: true, asking: 0, names: {}, repo: 'o/r', workflows: [] });
});

test('a member who is not an admin loads the console\'s own pages, and every call behind them answers 403', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const reached = [];
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const events = { list: () => { reached.push('events'); return []; } };
  const consoleSettings = { view: () => { reached.push('consoleSettings.view'); return {}; }, check() {}, setMany: () => { reached.push('consoleSettings.setMany'); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, settings, events, auth, members, consoleSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  for (const page of ['/people', '/secrets', '/events', '/console-settings', '/settings']) {
    assert.equal((await getWith(port, page, { ...sam, accept: 'text/html' })).status, 200, `${page} loads, and says what its calls answer`);
  }
  const reads = ['/api/people', '/api/people/slack-search?q=ana', '/api/secrets', '/api/webhook/deliveries', '/api/webhook-events', '/api/console-settings', '/api/console-settings/updates'];
  for (const path of reads) assert.equal((await getWith(port, path, sam)).status, 403, `GET ${path}`);
  const writes = ['/api/secrets/registry-token', '/api/secrets/registry-token/reveal', '/api/webhook/rotate', '/api/webhook/apply', '/api/webhook/url',
    '/api/console-settings', '/api/console-settings/clean', '/api/console-settings/projects/color', '/api/console-settings/projects/slack-channel', '/api/people/invite',
    '/api/console-settings/updates/check', '/api/console-settings/updates/update'];
  for (const path of writes) assert.equal((await post(port, path, { confirm: 'x', login: 'ana-k', values: {} }, sam)).status, 403, `POST ${path}`);
  assert.deepEqual(reached, [], 'nothing behind the pages was reached');
  const samMe = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.equal(samMe.admin, false, 'the menu hides the Console links');

  for (const path of ['/api/secrets', '/api/webhook-events', '/api/console-settings', '/api/people']) {
    assert.equal((await getWith(port, path, mia)).status, 200, `an admin reads ${path}`);
  }
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: mia })).json()).admin, true);
});

test('the setup page\'s Restart is an admin\'s, from the console\'s own origin, and says who asked', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const asked = [];
  const githubSetup = { restart: ({ by }) => { asked.push(by); return { restarting: true }; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, githubSetup });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  assert.equal((await post(port, '/api/setup/github/restart', {}, sam)).status, 403, 'a member who is not an admin');
  assert.equal((await post(port, '/api/setup/github/restart', {}, { ...mia, origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await post(port, '/api/setup/github/restart', {}, { ...mia, 'x-woodshed': '' })).status, 403, 'no x-woodshed header');
  assert.deepEqual(asked, []);
  const ok = await post(port, '/api/setup/github/restart', {}, mia);
  assert.deepEqual([ok.status, ok.body], [202, { restarting: true }]);
  assert.deepEqual(asked, ['mia-dev']);
});

test('the reviewer App\'s setup is an admin\'s: its view and its Create, from the console\'s own origin', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const started = [];
  const reviewerApp = {
    view: async () => ({ available: true, appId: null, slug: null, login: null, installUrl: null }),
    startManifest: ({ ownerType }) => { started.push(ownerType); return { url: 'https://github.com/organizations/o/settings/apps/new?state=s', manifest: {} }; },
  };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, reviewerApp });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  assert.equal((await post(port, '/api/setup/github/reviewer/manifest', { ownerType: 'Organization' }, sam)).status, 403, 'a member who is not an admin');
  assert.equal((await post(port, '/api/setup/github/reviewer/manifest', {}, { ...mia, origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.deepEqual(started, []);
  const ok = await post(port, '/api/setup/github/reviewer/manifest', { ownerType: 'Organization' }, mia);
  assert.deepEqual([ok.status, started], [200, ['Organization']]);
});

test('on a list with no admin yet every member is one, until the first is switched on', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'already using the console' }, 'sam-ops': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'already using the console' } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };

  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'nobody is an admin yet, so everyone is');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json()).admin, true);
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, mia)).status, 200, 'the first admin is switched on');
  assert.equal((await getWith(port, '/api/people', sam)).status, 403, 'from then on, only admins');
  assert.equal((await getWith(port, '/api/people', mia)).status, 200);
});

test('with sign-in available but not turned on, the menu and the server agree that everyone is an admin', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => false, available: () => true, sessionFor: async () => ({ login: 'sam-ops' }), visitorFor: async () => null };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };

  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([me.login, me.admin], ['sam-ops', true], 'a member who is not an admin still gets the Console links');
  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'because the server lets them through');
});

// A private session, swept as a teammate who is signed in: every route answers exactly as it does for an id that
// never existed, and nothing reaches the session. Its owner gets through on each.
test('a teammate gets the unknown-id answer on every route of someone\'s private session', async (t) => {
  const reached = [];
  const mine = { id: '3f9a1c20', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', terminalToken: 'tt', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 1, shellPort: 1 } };
  const shared = { id: '7c21e0d4', status: 'running', title: 'shared', owner: null, startedBy: 'sam-ops' };
  const fleet = {
    sessions: () => [mine, shared],
    find: (id) => [mine, shared].find((s) => s.id === id) ?? null,
    stop: async (s) => { reached.push(`stop ${s.id}`); },
    startApp: async (s) => { reached.push(`startApp ${s.id}`); return s; },
    stopApp: async (s) => { reached.push(`stopApp ${s.id}`); return s; },
  };
  const review = async (s) => { reached.push(`review ${s.id}`); return {}; };
  const loginOf = (cookie) => /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
    appSessionFor: async ({ cookieHeader }) => (loginOf(cookieHeader) ? { login: loginOf(cookieHeader) } : null),
    appCode: async () => { reached.push('appCode'); return 'code'; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example',
  };
  const handle = createHandler({ config, fleet, auth, review });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  async function answer(login, id, { method = 'GET', path, host = 'console.example' }) {
    const headers = { host, cookie: `woodshed_session=${login}`, accept: 'text/html', 'x-woodshed': '1', origin: 'https://console.example' };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: path.replaceAll('ID', id), headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  }
  const routes = [
    { path: '/api/sessions/ID/review' }, { path: '/term/ID/' }, { path: '/term/ID/token' }, { path: '/shell/ID/' }, { path: '/redis/ID/' },
    { path: '/auth/app?id=ID&next=/' },
    { method: 'POST', path: '/api/sessions/ID/stop' }, { method: 'POST', path: '/api/sessions/ID/app/start' }, { method: 'POST', path: '/api/sessions/ID/app/stop' },
    { method: 'POST', path: '/api/sessions/ID/resume' }, { method: 'POST', path: '/api/sessions/ID/delete' },
    { method: 'POST', path: '/api/sessions/ID/pin' }, { method: 'POST', path: '/api/sessions/ID/rename' },
    { method: 'POST', path: '/api/sessions/ID/upload?name=a.png' }, { path: '/api/sessions/ID/image?path=shot.png' }, { method: 'POST', path: '/api/sessions/ID/scroll' },
    { method: 'POST', path: '/api/sessions/ID/send' },
    { path: '/api/sessions/ID/applog' }, { path: '/api/sessions/ID/diff' }, { method: 'POST', path: '/api/sessions/ID/review/diff' }, { path: '/api/sessions/ID/review/analysis' },
    { method: 'POST', path: '/api/sessions/ID/review/chat' }, { path: '/api/sessions/ID/review/answer/0123456789abcdef' },
    { path: '/api/sessions/ID/github/draft' }, { method: 'POST', path: '/api/sessions/ID/github/merge' }, { method: 'POST', path: '/api/sessions/ID/github/comment' },
    { path: '/workflows', host: 'ID.console.example' }, { method: 'POST', path: '/api-proxy/x', host: 'ID.console.example' },
    { path: '/__woodshed/code/', host: 'ID.console.example' }, { method: 'POST', path: '/__woodshed/code/x', host: 'ID.console.example' },
  ];
  for (const route of routes) {
    const theirs = await answer('mia-dev', mine.id, { ...route, host: route.host?.replace('ID', mine.id) });
    const nobody = await answer('mia-dev', 'ffffffff', { ...route, host: route.host?.replace('ID', 'ffffffff') });
    assert.deepEqual(theirs, nobody, `${route.method ?? 'GET'} ${route.host ?? ''}${route.path}`);
  }
  assert.deepEqual(reached, [], 'nothing reached the private session for a teammate');

  const listed = JSON.parse((await answer('mia-dev', '', { path: '/api/sessions' })).body).sessions.map((s) => s.id);
  assert.deepEqual(listed, ['7c21e0d4'], 'the list leaves it out');
  const own = JSON.parse((await answer('octocat', '', { path: '/api/sessions' })).body).sessions.map((s) => s.id).sort();
  assert.deepEqual(own, ['3f9a1c20', '7c21e0d4']);

  assert.equal((await answer('octocat', mine.id, { method: 'POST', path: '/api/sessions/ID/stop' })).status, 200);
  assert.equal((await answer('octocat', mine.id, { path: '/api/sessions/ID/review' })).status, 200);
  assert.equal((await answer('octocat', mine.id, { path: '/auth/app?id=ID&next=/' })).status, 302);
  assert.notEqual((await answer('octocat', mine.id, { path: '/term/ID/' })).status, 404, 'the owner reaches the terminal');
  assert.deepEqual(reached, ['stop 3f9a1c20', 'review 3f9a1c20', 'appCode']);
});

test('pins are the signed-in person\'s, a rename is the session\'s, and the app\'s icons need no sign-in', async (t) => {
  const session = { id: '0a1b2c3d', status: 'running', title: 'Old name', owner: null, startedBy: 'octocat' };
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    rename(s, title) {
      if (!String(title ?? '').trim()) throw Object.assign(new Error('a name cannot be empty'), { shown: true });
      s.title = title;
      return s;
    },
  };
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => { const login = /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1]; return login ? { login } : null; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: `http://localhost`, extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const handle = createHandler({ config, fleet, auth, viewPrefs: createViewPrefs({ state: {}, save() {} }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = (login) => ({ cookie: `woodshed_session=${login}` });

  assert.equal((await post(port, '/api/sessions/0a1b2c3d/pin', { on: true }, as('octocat'))).status, 200);
  const sessions = async (login) => JSON.parse(await getBody(port, '/api/sessions', as(login)));
  assert.deepEqual((await sessions('octocat')).viewPrefs, { pinned: ['0a1b2c3d'] });
  assert.deepEqual((await sessions('mia-dev')).viewPrefs, { pinned: [] }, 'nobody else\'s pins');

  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: 'New name' }, as('mia-dev'))).status, 200);
  assert.equal(session.title, 'New name');
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: '  ' }, as('mia-dev'))).status, 400);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: 'x' })).status, 401, 'signed out');

  // Shared and My Woodshed are the rail's two tabs, each its own page of the same shell as a session's.
  for (const page of ['/', '/all', '/s/0a1b2c3d']) {
    const scripts = [...(await getBody(port, page, as('octocat'))).matchAll(/<script src="\/static\/([\w.]+)\?v=[0-9a-f]{12}"/g)].map((m) => m[1]);
    // Whose page it is, so the rail draws from what it kept only for the same person.
    assert.match(await getBody(port, page, as('octocat')), /<meta name="woodshed-login" content="octocat">/, `${page} names who it is for`);
    // The same scripts on each, since session.js moves between them in place.
    assert.deepEqual(scripts.slice(-7), ['terminal.js', 'dictation.js', 'launcher.js', 'sharedHome.js', 'messageBox.js', 'appShare.js', 'session.js'], `${page} is the shell`);
  }
  assert.match(await getBody(port, '/static/sharedHome.js', as('octocat')), /createSharedHome/);
  assert.match(await getBody(port, '/static/messageBox.js', as('octocat')), /createMessageBox/);
  assert.match(await getBody(port, '/static/dictation.js', as('octocat')), /W\.dictation = /);

  // The version a page names is kept by the browser; any other is asked for again, so a deploy is never stale.
  const named = /href="(\/static\/style\.css\?v=[0-9a-f]{12})"/.exec(await getBody(port, '/', as('octocat')))[1];
  const cacheOf = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: { host: `localhost:${port}`, ...as('octocat') } })).headers.get('cache-control');
  assert.equal(await cacheOf(named), 'public, max-age=31536000, immutable');
  assert.equal(await cacheOf('/static/style.css?v=000000000000'), 'no-cache', 'an old version');
  assert.equal(await cacheOf('/static/style.css'), 'no-cache', 'no version, as the woodshed-db.mjs download is');
  assert.equal(await request(port, { path: '/static/sessions.js', headers: { host: `localhost:${port}`, ...as('octocat') } }), 404, 'the old page is gone');

  const manifest = JSON.parse(await getBody(port, '/manifest.webmanifest', {}));
  assert.equal(manifest.name, 'Woodshed');
  assert.equal(await request(port, { path: '/icon-192.png', headers: { host: `localhost:${port}` } }), 200, 'icons before sign-in');
});

function getBody(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.end();
  });
}

test('My Woodshed writes act for the signed-in login, and need a saved Claude token to start', async (t) => {
  const started = [];
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }; },
  };
  const saved = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: saved.has(login), savedAt: null }, setUp: saved.has(login), available: true }),
    setClaudeToken: async (login, value) => {
      if (!String(value).startsWith('sk-ant-')) throw Object.assign(new Error('this is not a token from claude setup-token'), { shown: true });
      saved.add(login);
    },
    removeClaudeToken: async (login) => { saved.delete(login); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await post(port, '/api/my/sessions', { prompt: 'go', owner: 'octocat' }, as), { status: 409, body: { error: 'save your Claude token on My settings first' } });
  assert.equal((await post(port, '/api/my/claude-token', { value: 'nope' }, as)).status, 409);
  const set = await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-x' }, as);
  assert.equal(set.status, 200);
  assert.equal(set.body.login, 'mia-dev');
  assert.equal(set.body.claudeToken.set, true);
  assert.equal(JSON.stringify(set.body).includes('sk-ant'), false, 'the token never comes back');
  const made = await post(port, '/api/my/sessions', { prompt: 'go', owner: 'octocat', model: 'opus' }, as);
  assert.equal(made.status, 201);
  assert.equal(made.body.token, undefined, 'no session token in the answer');
  assert.equal(started[0].owner, 'mia-dev', 'the body cannot say whose it is');
  assert.equal(started[0].background, true, 'the page does not wait for the container');
  assert.equal((await post(port, '/api/my/claude-token/remove', {}, as)).body.claudeToken.set, false);
});

test('New session offers only the agents set up to run, and a Codex start needs a sign-in or the team key', async (t) => {
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => ({ id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }),
  };
  const claude = new Set(['mia-dev']);
  const codex = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: claude.has(login), savedAt: null }, codexAuth: { set: codex.has(login), savedAt: null }, setUp: true, available: true }),
    setCodexAuth: async (login) => { codex.add(login); },
  };
  let teamKey = null;
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, openaiTeamKey: async () => teamKey });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const agents = async () => JSON.parse(await getBody(port, '/api/my', as)).agents;

  assert.deepEqual(await agents(), { claude: true, codex: false }, 'no Codex sign-in and no team key');
  assert.deepEqual(await post(port, '/api/my/sessions', { prompt: 'go', agent: 'codex' }, as),
    { status: 409, body: { error: 'save your Codex sign-in on My settings first: the console has no OpenAI key' } });
  teamKey = 'sk-team';
  assert.deepEqual(await agents(), { claude: true, codex: true }, 'the team key runs Codex');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', agent: 'codex' }, as)).status, 201);
  teamKey = null;
  await post(port, '/api/my/codex-auth', { value: 'sk-own' }, as);
  assert.deepEqual(await agents(), { claude: true, codex: true }, 'their own sign-in runs Codex');
  claude.delete('mia-dev');
  assert.deepEqual(await agents(), { claude: false, codex: true }, 'no Claude token, no Claude');
});

test('the first Claude token starts your own databases, and New session waits for them', async (t) => {
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => ({ id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }),
    removePrivate: async () => ({ stopped: 0, removed: 0 }),
  };
  const saved = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: saved.has(login), savedAt: null }, setUp: saved.has(login), available: true }),
    setClaudeToken: async (login) => { saved.add(login); },
    removeAll: async (login) => { saved.delete(login); },
  };
  const states = new Map();
  const asked = [];
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: states.get(login) ?? 'none', name: `woodshed_${login}` }),
    create: async (login) => { asked.push(`create ${login}`); states.set(login, 'working'); },
    remove: async (login) => { asked.push(`remove ${login}`); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, databases });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const set = await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-x' }, as);
  assert.equal(set.body.databases.status, 'working');
  assert.deepEqual(asked, ['create mia-dev']);
  await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-y' }, as);
  assert.deepEqual(asked, ['create mia-dev'], 'a second token starts nothing more');

  const early = await post(port, '/api/my/sessions', { prompt: 'go' }, as);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /databases are not ready/);
  states.set('mia-dev', 'ready');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go' }, as)).status, 201);

  assert.deepEqual(await post(port, '/api/my/databases', {}, as), { status: 400, body: { error: 'type reset to confirm: your data goes' } });
  assert.equal((await post(port, '/api/my/databases', { confirm: 'reset' }, as)).status, 200);
  assert.deepEqual(asked, ['create mia-dev', 'create mia-dev']);

  await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as);
  assert.deepEqual(asked.at(-1), 'remove mia-dev');
});

test('a dump is restored from My settings as the signed-in person, and Apply needs the word typed', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const asked = [];
  let restoring = false;
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: 'ready', name: `woodshed_${login}` }),
    create: async (login) => { asked.push(`reset ${login}`); },
  };
  const dbRestore = {
    view: (login) => ({ available: true, status: restoring ? 'restoring' : 'none', name: `woodshed_${login}_restore` }),
    busy: () => restoring,
    upload: async (req, { login, name }) => {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      asked.push(`upload ${login} ${name} ${bytes}`);
      restoring = true;
      return dbRestore.view(login);
    },
    apply: async (login) => { asked.push(`apply ${login}`); },
    discard: async (login) => { asked.push(`discard ${login}`); },
    forget: (login) => { asked.push(`forget ${login}`); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, databases, dbRestore });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const sent = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/my/databases/restore?name=prod.dump',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/octet-stream', ...as },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(Buffer.alloc(1000));
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.restore.status, 'restoring');
  assert.deepEqual(asked, ['upload mia-dev prod.dump 1000']);

  const reset = await post(port, '/api/my/databases', { confirm: 'reset' }, as);
  assert.equal(reset.status, 409, 'no reset while a restore runs');
  restoring = false;
  assert.deepEqual(await post(port, '/api/my/databases/restore/apply', {}, as), { status: 400, body: { error: 'type apply to confirm: your database is replaced' } });
  assert.equal((await post(port, '/api/my/databases/restore/apply', { confirm: 'apply' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/databases/restore/discard', {}, as)).status, 200);
  assert.equal((await post(port, '/api/my/databases', { confirm: 'reset' }, as)).status, 200);
  assert.deepEqual(asked.slice(1), ['apply mia-dev', 'discard mia-dev', 'reset mia-dev', 'forget mia-dev'], 'a reset drops the copy with the rest');
});

test('a tunnel token comes from My settings, signed in; woodshed-db.mjs reads its details with the token alone', async (t) => {
  const fleet = { sessions: () => [], find: () => null, removePrivate: async () => ({ stopped: 0, removed: 0 }) };
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: login === 'mia-dev' ? 'ready' : 'working', name: `woodshed_${login}` }),
    credentials: async (login) => ({ user: `woodshed_${login}`, password: 'secret', name: `woodshed_${login}` }),
    remove: async () => {},
  };
  const tunnel = createTunnel({ store: { state: {}, save() {} }, targets: { pg: '127.0.0.1:1', mongo: '127.0.0.1:2' }, databases });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, databases, tunnel });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const details = (token) => fetch(`http://127.0.0.1:${port}/api/tunnel/connection`, { headers: { host: `localhost:${port}`, authorization: `Bearer ${token}` } });

  assert.equal((await post(port, '/api/my/tunnel-token', {}, { cookie: 'woodshed_session=octocat' })).status, 409, 'not before the databases are ready');
  assert.equal((await post(port, '/api/my/tunnel-token', {})).status, 401, 'signed in only');
  const made = await post(port, '/api/my/tunnel-token', {}, as);
  assert.equal(made.status, 200);
  assert.match(made.body.tunnelToken, /^wt_[0-9a-f]{64}$/);
  assert.ok(made.body.tunnel.expiresAt);
  assert.equal((await details(made.body.tunnelToken)).status, 200, 'no cookie needed with the token');
  assert.equal((await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as)).status, 200);
  assert.equal((await details(made.body.tunnelToken)).status, 401, 'Remove My Woodshed revokes it');

  const again = await post(port, '/api/my/tunnel-token', {}, as);
  const revoked = await post(port, '/api/my/tunnel-token/remove', {}, as);
  assert.equal(revoked.body.tunnel.expiresAt, null);
  assert.equal((await details(again.body.tunnelToken)).status, 401);
});

test('Remove My Woodshed needs your login typed, and removes only yours; the rail\'s pull requests are yours alone', async (t) => {
  const done = [];
  let listed = [];
  const fleet = {
    sessions: () => listed, find: () => null,
    removePrivate: async (owner) => { done.push(`sessions ${owner}`); return { stopped: 1, removed: 2 }; },
  };
  const userSettings = {
    view: () => ({ claudeToken: { set: false, savedAt: null }, setUp: false, available: true }),
    removeAll: async (login) => { done.push(`settings ${login}`); },
    noteHome: () => {},
  };
  const homes = {
    remove: async (login) => { done.push(`home ${login}`); },
    removeSessionsOf: async (login) => { done.push(`session homes ${login}`); return 0; },
  };
  const claudeSettings = { remove: async (login) => { done.push(`shared settings ${login}`); } };
  let asked = 0;
  const github = { openPullsFor: async (login) => { asked++; return [{ number: 7, title: `${login}'s PR`, why: 'yours' }]; } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const githubUser = { disconnect: async (login) => { done.push(`github ${login}`); } };
  const handle = createHandler({ config, fleet, auth, userSettings, github, homes, githubUser, claudeSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await post(port, '/api/my/remove', { confirm: 'octocat' }, as), { status: 400, body: { error: 'type mia-dev to confirm' } });
  assert.equal((await post(port, '/api/my/remove', {}, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(done, []);
  const removed = await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as);
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.body.stopped, removed.body.removed], [1, 2]);
  assert.deepEqual(done, ['github mia-dev', 'settings mia-dev', 'sessions mia-dev', 'session homes mia-dev', 'home mia-dev', 'shared settings mia-dev'],
    'GitHub is disconnected, so its token ends at GitHub, then the settings, then the sessions, and the homes last, after their stops tried to save them');

  done.length = 0;
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'running' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 409, 'a running session would save it again');
  assert.deepEqual(done, []);
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'queued' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 409, 'one waiting in line would start on the home it deletes');
  assert.deepEqual(done, []);
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'stopped' }, { id: 'bbbb2222', owner: 'octocat', status: 'running' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 200);
  assert.deepEqual(done, ['session homes mia-dev', 'home mia-dev', 'shared settings mia-dev'],
    'Forget takes every session\'s copy too, so no Resume brings it back, and the owner\'s last, so a failure leaves its size on the page true');

  const pulls = async () => (await (await fetch(`http://127.0.0.1:${port}/api/my/pulls`, { headers: as })).json()).pulls;
  assert.deepEqual(await pulls(), [{ number: 7, title: "mia-dev's PR", why: 'yours', project: 'r', repo: 'o/r' }]);
  await pulls();
  assert.equal(asked, 1, 'kept for a minute');
});

test('a person\'s files are read and written for the signed-in login only', async (t) => {
  const calls = [];
  const userSettings = {
    view: () => ({ claudeToken: { set: false }, files: {}, setUp: true, available: true }),
    file: async (login, key) => { calls.push(['file', login, key]); return { key, text: `${login}'s ${key}`, custom: true }; },
    saveFile: async (login, key, text) => { calls.push(['save', login, key, text]); },
    resetFile: async (login, key) => { calls.push(['reset', login, key]); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const read = await (await fetch(`http://127.0.0.1:${port}/api/my/files/api-env`, { headers: as })).json();
  assert.equal(read.text, "mia-dev's api-env");
  assert.equal((await post(port, '/api/my/files/api-env', { text: 'A=1', login: 'octocat' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/files/tmux-conf/reset', {}, as)).status, 200);
  assert.equal((await post(port, '/api/my/files/tmux-conf', { text: 'x' }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(calls.filter((c) => c[0] !== 'file'), [['save', 'mia-dev', 'api-env', 'A=1'], ['reset', 'mia-dev', 'tmux-conf']]);
  assert.ok(calls.every((c) => c[1] === 'mia-dev'));
});

test('a person\'s own whole files are read and saved for the signed-in login only, and a refused path says why', async (t) => {
  const calls = [];
  let failRead = false;
  const userSettings = {
    view: (login) => ({ claudeToken: { set: false }, files: {}, ownFiles: [{ path: 'app/.env.production', savedAt: 'x' }], setUp: true, available: true, login }),
    ownWholeFiles: async (login) => {
      calls.push(['read', login]);
      if (failRead) throw new Error('AccessDeniedException');
      return { 'app/.env.production': `A=${login}` };
    },
    saveOwnFile: async (login, file, text) => {
      calls.push(['save', login, file, text]);
      if (file.includes('..')) throw Object.assign(new Error('a path cannot have . or .. in it'), { shown: true });
      return { [file]: text };
    },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/my/own-files`, { headers: as })).json(), { files: { 'app/.env.production': 'A=mia-dev' } });
  const saved = await post(port, '/api/my/own-files', { path: 'app/.env.production', text: 'B=1', login: 'octocat' }, as);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.files, { 'app/.env.production': 'B=1' });
  assert.equal(saved.body.view.ownFiles[0].path, 'app/.env.production', 'the page gets its new view with the answer');
  const refused = await post(port, '/api/my/own-files', { path: '../x', text: 'x' }, as);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'a path cannot have . or .. in it');
  assert.equal((await post(port, '/api/my/own-files', { path: 'a', text: 'x' }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.ok(calls.every((c) => c[1] === 'mia-dev'), 'never the login a body names');
  failRead = true;
  const failed = await fetch(`http://127.0.0.1:${port}/api/my/own-files`, { headers: as });
  assert.equal(failed.status, 502);
  assert.equal(JSON.stringify(await failed.json()).includes('AccessDenied'), false, 'the store\'s error stays in the log');
});

test('Connect GitHub starts a sign-in that keeps its token, and the git identity is the signed-in person\'s', async (t) => {
  const started = [];
  const done = [];
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1];
      return login ? { login } : null;
    },
    start: async (next, opts) => { started.push([next, opts]); return { location: 'https://github.com/login/oauth/authorize?x=1', setCookie: 's=1' }; },
  };
  const userSettings = {
    view: () => ({ claudeToken: { set: false }, github: { connected: true }, files: {}, setUp: true, available: true }),
    setGitIdentity: async (login, identity) => {
      if (!String(identity.email).includes('@')) throw Object.assign(new Error('that is not an email address'), { shown: true });
      done.push(['identity', login, identity.name]);
    },
    forgetGitHub: async () => {},
  };
  const githubUser = { disconnect: async (login) => { done.push(['disconnect', login]); } };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings, githubUser });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await getWith(port, '/auth/connect', as), { status: 302, location: 'https://github.com/login/oauth/authorize?x=1' });
  assert.deepEqual(started, [['/settings?connected=1', { connect: true }]]);
  assert.equal((await getWith(port, '/auth/connect')).status, 401, 'only someone signed in connects');
  assert.deepEqual(await post(port, '/api/my/github/identity', { name: 'Mia', email: 'nope' }, as), { status: 409, body: { error: 'that is not an email address' } },
    'a refused identity is answered, not thrown after a 200');
  assert.equal((await post(port, '/api/my/github/identity', { name: 'Mia', email: 'mia@example.com' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/github/disconnect', {}, as)).status, 200);
  assert.deepEqual(done, [['identity', 'mia-dev', 'Mia'], ['disconnect', 'mia-dev']]);
});

test('Resume and Delete now act on a shared session, with the message, and say why they cannot', async (t) => {
  const done = [];
  const session = { id: '0a1b2c3d', status: 'stopped', title: 't', kept: true, token: 'secret' };
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    async resumeShared(s, args) { done.push(['resume', s.id, args]); return { ...s, status: 'queued' }; },
    async deleteShared() { throw Object.assign(new Error('stop the session first'), { shown: true }); },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const resumed = await post(port, '/api/sessions/0a1b2c3d/resume', { message: 'Use the URL' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'queued');
  assert.equal(resumed.body.token, undefined, 'no token goes to the browser');
  assert.deepEqual(done, [['resume', '0a1b2c3d', { text: 'Use the URL', by: 'console', why: 'console' }]]);
  const refused = await post(port, '/api/sessions/0a1b2c3d/delete', {});
  assert.deepEqual(refused, { status: 409, body: { error: 'stop the session first' } });
  assert.equal((await post(port, '/api/sessions/ffffffff/resume', {})).status, 404);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/resume', {}, { origin: 'https://evil.example' })).status, 403);
});

test('Console settings: a card\'s values and the channel saved together, refused out of bounds or cross-origin', async (t) => {
  const store = { state: {}, save() {} };
  const base = { maxRunning: 5, limits: { idleMs: 3_600_000, lifetimeMs: 8 * 3_600_000 } };
  const consoleSettings = createConsoleSettings({ store, config: base });
  const slack = createSlack({ store, secrets: { read: async () => null } });
  const cleaned = [];
  const heldData = { async report() { return { held: [], stalled: [], homesListed: true, totals: { databases: 0, homes: 0, homeBytes: 0 } }; }, async clean(args) { cleaned.push(args); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, slack, consoleSettings, heldData });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const saved = await post(port, '/api/console-settings', { values: { slackGiveUpDays: 10 }, slackChannel: 'C0123456789' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.find((x) => x.key === 'slackGiveUpDays').value, 10);
  assert.deepEqual(saved.body.slack, { channel: 'C0123456789', canPost: true });

  const bad = await post(port, '/api/console-settings', { values: { maxRunning: 50, idleHours: 2 }, slackChannel: '' });
  assert.deepEqual(bad, { status: 400, body: { error: 'Shared sessions running at once must be from 1 to 20 sessions.' } });
  assert.equal(store.state.settings.idleHours, undefined, 'nothing from a refused card is kept');
  assert.equal(store.state.settings.slackChannel, 'C0123456789', 'not even its channel');
  const name = await post(port, '/api/console-settings', { values: { idleHours: 2 }, slackChannel: '#dev-test' });
  assert.equal(name.status, 400);
  assert.equal(store.state.settings.idleHours, undefined);
  assert.equal((await post(port, '/api/console-settings', { values: { maxRunning: 6 } }, { origin: 'https://evil.example' })).status, 403);

  assert.equal((await post(port, '/api/console-settings/clean', { kind: 'all', id: 'aaaaaaaa' })).status, 400);
  assert.equal((await post(port, '/api/console-settings/clean', { kind: 'home', id: 'aaaaaaaa' })).status, 200);
  assert.deepEqual(cleaned, [{ kind: 'home', id: 'aaaaaaaa', by: 'console' }]);
});

test('Console settings: the Woodshed card reads, checks and starts an update, and says why one is refused', async (t) => {
  const calls = [];
  let refusal = null;
  const woodshedUpdate = {
    behindBy: () => 3,
    async view() { return { clone: '/srv/woodshed', behindBy: 3, job: calls.includes('update by console') ? { state: 'running' } : null }; },
    async check() { calls.push('check'); },
    async update({ by }) {
      calls.push(`update by ${by}`);
      if (refusal) throw Object.assign(new Error(refusal), { shown: true });
    },
  };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, woodshedUpdate });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.deepEqual(JSON.parse(await getBody(port, '/api/console-settings/updates')), { clone: '/srv/woodshed', behindBy: 3, job: null });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`)).json()).updates, 3, 'the menu counts the newer commits for an admin');
  assert.equal((await post(port, '/api/console-settings/updates/check', {})).status, 200);
  const started = await post(port, '/api/console-settings/updates/update', {});
  assert.equal(started.status, 202);
  assert.deepEqual(started.body.job, { state: 'running' });
  refusal = 'An update is already running.';
  assert.deepEqual(await post(port, '/api/console-settings/updates/update', {}), { status: 409, body: { error: refusal } });
  assert.equal((await post(port, '/api/console-settings/updates/update', {}, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(calls, ['check', 'update by console', 'update by console']);

  const none = createHandler({ config, fleet: { sessions: () => [] }, woodshedUpdate: { ...woodshedUpdate, view: async () => null } });
  const noneServer = http.createServer((req, res) => { none(req, res); });
  const nonePort = await listen(noneServer);
  t.after(() => noneServer.close());
  assert.match(await getBody(nonePort, '/api/console-settings/updates'), /does not run from a git clone/);
});

test('Console settings: a repo is added and removed on the page, with its sessions counted, and a refused one says why', async (t) => {
  const store = { state: { sessions: [] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  const check = async (repo) => {
    if (repo === 'o/missing') throw Object.assign(new Error('The GitHub App is not installed on o/missing.'), { shown: true });
    if (repo === 'o/uninstalled') {
      throw Object.assign(new Error('The GitHub App is not installed on o/uninstalled.'), { shown: true, link: { href: 'https://github.com/apps/w/installations/new', text: 'Install w on GitHub' } });
    }
    return { installationId: null };
  };
  const addedProjects = createAddedProjects({ store, config, check });
  const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const added = await post(port, '/api/console-settings/projects', { repo: 'o/api' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.removable]), [['r', false], ['api', true]]);
  assert.deepEqual(config.projects.map((p) => p.name), ['r', 'api'], 'the live config has it, with no restart');
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/missing' }), { status: 400, body: { error: 'The GitHub App is not installed on o/missing.' } });
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/uninstalled' }), {
    status: 400, body: { error: 'The GitHub App is not installed on o/uninstalled.', link: { href: 'https://github.com/apps/w/installations/new', text: 'Install w on GitHub' } },
  }, 'the App\'s install page goes with the reason');
  assert.equal((await post(port, '/api/console-settings/projects', { repo: 'o/api' })).status, 400, 'twice');
  assert.equal((await post(port, '/api/console-settings/projects', { repo: 'o/x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'r' })).status, 400, 'the installation\'s own stays');
  const removed = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.projects.map((p) => p.name), ['r']);
});

test('Console settings: Add a repo\'s list is the App\'s repos less the projects, null with no App, and a 502 when GitHub did not answer', async (t) => {
  const store = { state: { sessions: [] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  let fail = false;
  const list = async () => {
    if (fail) throw Object.assign(new Error('GitHub did not list the App\'s repos.'), { shown: true });
    return { repos: [{ repo: 'o/R', private: true }, { repo: 'o/web', private: false }], grant: [{ account: 'o', href: 'https://github.com/settings/installations/1' }], install: null };
  };
  const serve = (addedProjects) => {
    const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
    const server = http.createServer((req, res) => { handle(req, res); });
    t.after(() => server.close());
    return listen(server);
  };
  const port = await serve(createAddedProjects({ store, config, check: async () => ({ installationId: null }), list }));
  const ask = async (p) => {
    const res = await fetch(`http://127.0.0.1:${p}/api/console-settings/projects/repos`);
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await ask(port), { status: 200, body: { repos: [{ repo: 'o/web', private: false }], grant: [{ account: 'o', href: 'https://github.com/settings/installations/1' }], install: null } });
  fail = true;
  assert.deepEqual(await ask(port), { status: 502, body: { error: 'GitHub did not list the App\'s repos.' } });
  const noApp = await serve(createAddedProjects({ store, config, check: async () => ({ installationId: null }) }));
  assert.deepEqual(await ask(noApp), { status: 200, body: { repos: null, grant: [], install: null } });
});

test('Console settings: with an embedder\'s repos hook, its list is offered, an add and a removal go to it, and its refusal links to the fix', async (t) => {
  const store = { state: { sessions: [] }, save() { throw new Error('nothing of the repo list is the console\'s to save'); } };
  const hostProjects = createHostProjects();
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store, { hostProjects });
  const kept = ['o/r'];
  const grant = { account: 'o', href: 'https://github.com/organizations/o/settings/installations/9' };
  const repos = {
    names: false,
    list: async () => ({ repos: ['o/r', 'o/api', 'o/web'].filter((r) => !kept.includes(r)), grant: [grant], install: null }),
    async add({ repo }) {
      if (repo === 'o/secret') throw Object.assign(new Error('The App may not reach o/secret.'), { shown: true, link: { href: grant.href, text: 'Give the App access to o/secret on GitHub' } });
      kept.push(repo);
      return { name: repo.split('/')[1], repo };
    },
    async remove({ repo }) { kept.splice(kept.indexOf(repo), 1); },
  };
  const addedProjects = createAddedProjects({ store, config, check: async () => { throw new Error('not asked'); }, host: repos, hostProjects });
  const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const page = JSON.parse(await getBody(port, '/api/console-settings'));
  assert.equal(page.repoNames, false, 'the page asks for no name');
  assert.deepEqual(page.projects.map((p) => [p.name, p.source, p.removable]), [['r', 'host', false]]);
  const choices = JSON.parse(await getBody(port, '/api/console-settings/projects/repos'));
  assert.deepEqual(choices, { repos: [{ repo: 'o/api', private: false }, { repo: 'o/web', private: false }], grant: [grant], install: null, via: 'host' });

  const added = await post(port, '/api/console-settings/projects', { repo: 'o/api' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.removable]), [['r', false], ['api', true]], 'the answer has it at once');
  assert.deepEqual(kept, ['o/r', 'o/api']);
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/secret' }), {
    status: 400, body: { error: 'The App may not reach o/secret.', link: { href: grant.href, text: 'Give the App access to o/secret on GitHub' } },
  }, 'a typed repo the App cannot reach says where to give it access');
  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'r' })).status, 400, 'the default stays');
  const removed = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.projects.map((p) => p.name), ['r']);
  assert.deepEqual(kept, ['o/r']);
});

test('Console settings: a repo\'s colour is picked from the palette, never one another repo has, and the rail gets it', async (t) => {
  const store = { state: { sessions: [], addedProjects: [{ name: 'web', repo: 'o/web', default: false }] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }, { name: 'api', repo: 'o/api', default: false }],
  }, store);
  const addedProjects = createAddedProjects({ store, config, check: async () => ({ installationId: null }) });
  const handle = createHandler({
    config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects,
    projectColors: createProjectColors({ store, config }),
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const page = JSON.parse(await getBody(port, '/api/console-settings'));
  assert.deepEqual(page.projects.map((p) => [p.name, p.color]), [['r', 'teal'], ['api', 'plum'], ['web', 'sienna']], 'the environment\'s repos and the added one, each a colour of its own');
  assert.deepEqual(page.palette, ['teal', 'plum', 'sienna', 'rose', 'violet', 'moss']);

  const picked = await post(port, '/api/console-settings/projects/color', { name: 'api', color: 'moss' });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.body.projects.map((p) => [p.name, p.color]), [['r', 'teal'], ['api', 'moss'], ['web', 'sienna']]);
  assert.deepEqual(await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'teal' }), { status: 400, body: { error: 'r has teal already: pick another colour, or change r\'s first.' } });
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'red' })).status, 400, 'not in the palette');
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'gone', color: 'rose' })).status, 400, 'no such project');
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'rose' }, { origin: 'https://evil.example' })).status, 403);

  const rail = JSON.parse(await getBody(port, '/api/sessions'));
  assert.deepEqual(rail.projects, [{ name: 'r', color: 'teal', default: true }, { name: 'api', color: 'moss', default: false }, { name: 'web', color: 'sienna', default: false }]);

  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'web' })).status, 200);
  assert.deepEqual(store.state.projectColors, { r: 'teal', api: 'moss' }, 'a removed repo\'s colour is not kept for its name');
});

test('Console settings: a repo\'s own Slack channel, for the installation\'s repos and added ones, an admin\'s alone', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = {
    state: {
      sessions: [],
      members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } },
      addedProjects: [{ name: 'api', repo: 'o/api', default: false, addedBy: 'mia-dev', addedAt: '2026-10-03T00:00:00.000Z' }],
    },
    save() {},
  };
  const members = createMembers({ store });
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  const addedProjects = createAddedProjects({ store, config, check: async () => ({ installationId: null }) });
  const slack = createSlack({ store, secrets: { read: async () => null } });
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, auth, members, slack, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const path = '/api/console-settings/projects/slack-channel';

  assert.equal((await post(port, path, { name: 'api', channel: 'C0APIPRS01' }, sam)).status, 403, 'not an admin');
  assert.equal(store.state.settings?.projectSlackChannels, undefined, 'nothing kept from a refused call');
  const own = await post(port, path, { name: 'r', channel: 'C0ACMEPRS1' }, mia);
  assert.equal(own.status, 200, 'the installation\'s own repo');
  const added = await post(port, path, { name: 'api', channel: ' C0APIPRS01 ' }, mia);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.slackChannel]), [['r', 'C0ACMEPRS1'], ['api', 'C0APIPRS01']]);
  assert.deepEqual(added.body.slack, { channel: '', canPost: true }, 'the console\'s channel is left alone');
  const name = await post(port, path, { name: 'api', channel: '#acme-prs' }, mia);
  assert.equal(name.status, 400);
  assert.match(name.body.error, /channel's ID/, 'a name is refused as the console\'s channel is');
  assert.deepEqual(await post(port, path, { name: 'nope', channel: 'C0APIPRS01' }, mia), { status: 400, body: { error: 'There is no project called nope.' } });
  assert.equal((await post(port, path, { name: 'api', channel: 'C0APIPRS01' }, { ...mia, origin: 'https://evil.example' })).status, 403);
  const cleared = await post(port, path, { name: 'r', channel: '' }, mia);
  assert.deepEqual(cleared.body.projects.map((p) => p.slackChannel), ['', 'C0APIPRS01'], 'empty goes back to the console\'s channel');
  await post(port, '/api/console-settings/projects/remove', { name: 'api' }, mia);
  assert.deepEqual(store.state.settings.projectSlackChannels, {}, 'a removed repo\'s channel goes with it');
});

test('the switch for shared sessions is set for the signed-in person alone, behind the same write checks', async (t) => {
  const done = [];
  const userSettings = {
    view: () => ({ claudeToken: { set: true, savedAt: null }, ownTokenForShared: done.at(-1)?.[1] ?? false, setUp: true, available: true }),
    setOwnTokenForShared(login, on) {
      if (login === 'nobody') throw Object.assign(new Error('save your Claude token first'), { shown: true });
      done.push([login, on]);
    },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const on = await post(port, '/api/my/claude-token/shared', { on: true, login: 'joel' }, as);
  assert.equal(on.status, 200);
  assert.equal(on.body.ownTokenForShared, true);
  assert.deepEqual(done, [['mia-dev', true]], 'the body cannot say whose it is');
  assert.equal((await post(port, '/api/my/claude-token/shared', { on: 'yes' }, as)).status, 400);
  assert.equal((await post(port, '/api/my/claude-token/shared', { on: true }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await post(port, '/api/my/claude-token/shared', { on: true }, { cookie: 'woodshed_session=nobody' }),
    { status: 409, body: { error: 'save your Claude token first' } });
  assert.equal(done.length, 1);
});

test('a manual start is the signed-in person\'s, whatever login the body names', async (t) => {
  const started = [];
  const fleet = { sessions: () => [], async startManual(args) { started.push(args); return { id: '0a1b2c3d', status: 'queued', title: 't' }; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (/woodshed_session=mallory/.test(String(cookie)) ? { login: 'mallory' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await post(port, '/api/sessions', { number: 123, startedBy: 'joel' }, { cookie: 'woodshed_session=mallory' })).status, 201);
  assert.equal(started[0].startedBy, 'mallory');
});

test('the pages get the display name of each handle they show: the signed-in person, starters and plans, webhook senders', async (t) => {
  const shared = { id: '0a1b2c3d', status: 'running', title: 't', startedBy: 'joel', plan: 'joel' };
  const other = { id: '1a1b2c3d', status: 'stopped', title: 't', startedBy: 'nameless' };
  const fleet = { sessions: () => [shared, other] };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const asked = [];
  const people = {
    names(logins) {
      const list = [...logins];
      asked.push(list);
      const known = { joel: 'Mona Octocat', 'mia-dev': 'Mia', octo: 'Octo Cat' };
      return Object.fromEntries(list.filter((l) => known[l]).map((l) => [l, known[l]]));
    },
  };
  const events = { list: () => [{ login: 'octo' }] };
  const handle = createHandler({ config, fleet, auth, people, events });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: 'woodshed_session=x' } })).json();

  assert.deepEqual((await get('/api/sessions')).names, { 'mia-dev': 'Mia', joel: 'Mona Octocat' });
  assert.ok(asked.at(-1).includes('nameless'), 'a handle with no name is asked too, so a name set later shows');
  assert.deepEqual((await get('/api/me')).names, { 'mia-dev': 'Mia' });
  assert.deepEqual((await get('/api/webhook-events')).names, { octo: 'Octo Cat' });
});

test('Remove on a private session acts for the signed-in person, from the console\'s own origin', async (t) => {
  const removed = [];
  const fleet = { sessions: () => [], async removePrivateSession(args) { removed.push(args); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (/woodshed_session=joel/.test(String(cookie)) ? { login: 'joel' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=joel' };
  const answer = await post(port, '/api/my/sessions/0a1b2c3d/remove', { owner: 'mia' }, as);
  assert.deepEqual([answer.status, answer.body], [200, { removed: '0a1b2c3d' }]);
  assert.deepEqual(removed, [{ owner: 'joel', id: '0a1b2c3d' }], 'the body cannot say whose');
  assert.equal((await post(port, '/api/my/sessions/0a1b2c3d/remove', {}, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/api/my/sessions/0a1b2c3d/remove', {})).status, 401);
  assert.equal(removed.length, 1);
});

// The phone's message box: its text reaches the session's statusd as one /send, and its files are saved untyped.
test('the message box types its text into the owner\'s session, and its files are saved without typing their path', async (t) => {
  const seen = [];
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.startsWith('/upload') ? '{"path":"/tmp/uploads/1-shot.png","bytes":3}' : '{"ok":true}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const mine = { id: '3f9a1c20', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', terminalToken: 'tt', endpoint: { host: '127.0.0.1', termPort: 1, statusPort, shellPort: 1 } };
  const fleet = { sessions: () => [mine], find: (id) => (id === mine.id ? mine : null) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'octocat' }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const server = http.createServer(createHandler({ config, fleet, auth }));
  const port = await listen(server);
  t.after(() => server.close());
  const headers = { cookie: 'woodshed_session=x', 'x-woodshed': '1', origin: `http://localhost:${port}` };
  const post = (path, body, type) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { ...headers, 'content-type': type }, body });

  const text = 'Both. Polling for the watcher\n\nand the app only on Start app';
  assert.equal((await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text }), 'application/json')).status, 200);
  assert.deepEqual(seen[0], { method: 'POST', url: '/send', auth: 'Bearer tok', body: JSON.stringify({ text }) }, 'the whole text, newlines kept, as one message');

  assert.equal((await post(`/api/sessions/${mine.id}/send`, '{"text":"  "}', 'application/json')).status, 400);
  assert.equal(seen.length, 1, 'nothing to send reaches nothing');

  const up = await post(`/api/sessions/${mine.id}/upload?name=shot.png&pane=none`, 'png', 'application/octet-stream');
  assert.equal((await up.json()).path, '/tmp/uploads/1-shot.png');
  assert.equal(seen[1].url, '/upload?name=shot.png', 'no pane, so statusd types nothing');
  await post(`/api/sessions/${mine.id}/upload?name=shot.png`, 'png', 'application/octet-stream');
  assert.equal(seen[2].url, '/upload?name=shot.png&pane=agent', 'a paste on the terminal still types its path, as before');
});

test('a member links a member to a Slack user on the People page, and the page lists the link', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const { createSlackPeople } = await import('./slackPeople.mjs');
  const store = {
    state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true } } }, save() {},
  };
  const members = createMembers({ store });
  const slack = {
    person: async (id) => (id === 'U01ANA00001' ? { id, name: 'Ana K', reachable: true } : null),
    search: async (q) => (q === 'ana' ? { found: [{ id: 'U01ANA00001', name: 'Ana K', handle: 'ana' }], truncated: false } : null),
  };
  const slackPeople = createSlackPeople({ store, slack });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (/mia-dev/.test(String(cookie)) ? { login: 'mia-dev' } : null),
    visitorFor: async () => null,
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, slackPeople });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };

  const before = await (await fetch(`http://127.0.0.1:${port}/api/people`, { headers: mia })).json();
  assert.deepEqual(before.slack, {}, 'nobody linked yet');
  const bad = await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U0NOSUCH999' }, mia);
  assert.equal(bad.status, 400, 'an ID Slack does not know is refused');
  assert.equal((await post(port, '/api/people/slack', { login: 'nobody', slack: 'U01ANA00001' }, mia)).status, 404, 'only members are linked');
  const ok = await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U01ANA00001' }, mia);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.slack, { 'mia-dev': { slackId: 'U01ANA00001', name: 'Ana K', how: 'manual' } });
  assert.equal(slackPeople.slackUserFor('mia-dev'), 'U01ANA00001');
  const searched = await (await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=ana`, { headers: mia })).json();
  assert.deepEqual(searched.found, [{ id: 'U01ANA00001', name: 'Ana K', handle: 'ana' }]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=zzz`, { headers: mia })).status, 400, 'Slack refusing is said, not shown as no matches');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=ana`)).status, 401, 'a visitor cannot list the workspace');
  assert.equal((await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U01ANA00001' }, {})).status, 401);
});

test('an admin turns on sessions from GitHub, then Can be assigned, and only then is a shared session seen and assigned', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const shared = { id: '0a1b2c3d', owner: null, kind: 'issue', status: 'running', title: 'shared', startedBy: 'sam-ops' };
  const theirs = { id: '1b2c3d4e', owner: 'sam-ops', kind: 'task', status: 'running', title: 'private', startedBy: 'sam-ops' };
  const assigned = [];
  const released = [];
  const fleet = {
    releaseAssignments: (args) => { released.push(args); },
    sessions: () => [shared, theirs],
    find: (id) => [shared, theirs].find((s) => s.id === id) ?? null,
    assign: ({ id, by, to }) => {
      if (!members.isAssignable(by)) throw Object.assign(new Error('only someone who can be assigned sessions can assign one'), { shown: true });
      assigned.push({ id, by, to });
    },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (/mia-dev/.test(String(cookie)) ? { login: 'mia-dev' } : null),
    visitorFor: async () => null,
  };
  const handle = createHandler({ config, fleet, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };

  const hidden = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: mia })).json();
  assert.deepEqual([hidden.sessions.length, hidden.shared], [0, false], 'without sessions from GitHub no shared session is listed, and there is no Everyone');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia)).status, 404, 'nor found by its id');
  assert.equal((await getWith(port, `/api/sessions/${shared.id}/review`, mia)).status, 404);
  assert.equal((await post(port, '/api/sessions', { number: 7 }, mia)).status, 403, 'nor started from the console');
  const early = await post(port, '/api/people/assignable', { login: 'mia-dev', on: true }, mia);
  assert.deepEqual([early.status, early.body.error], [409, '@mia-dev needs sessions from GitHub first']);
  assert.equal((await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: 'yes' }, mia)).status, 400, 'on or off, not a word');
  assert.equal((await post(port, '/api/people/github-sessions', { login: 'nobody', on: true }, mia)).status, 409, 'only members');
  const github = await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: true }, mia);
  assert.equal(github.status, 200);
  assert.equal(github.body.members.find((m) => m.login === 'mia-dev').githubSessions, true);

  const notYet = await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia);
  assert.equal(notYet.status, 409, 'seen now, but not someone who can be assigned');
  assert.match(notYet.body.error, /only someone who can be assigned/);
  const on = await post(port, '/api/people/assignable', { login: 'mia-dev', on: true }, mia);
  assert.equal(on.status, 200);
  assert.equal(on.body.members.find((m) => m.login === 'mia-dev').assignable, true);

  const listed = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: mia })).json();
  assert.deepEqual([listed.assignables, listed.assignable, listed.shared, listed.sessions.length], [['mia-dev'], true, true, 1], 'the rail learns who may be assigned, whether you are one, and that Everyone shows');

  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia)).status, 200);
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: null }, mia)).status, 200, 'null unassigns');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 5 }, mia)).status, 400);
  assert.equal((await post(port, `/api/sessions/${theirs.id}/assign`, { to: 'mia-dev' }, mia)).status, 404, 'a private session is not even found');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, {})).status, 401);
  assert.deepEqual(assigned, [{ id: shared.id, by: 'mia-dev', to: 'mia-dev' }, { id: shared.id, by: 'mia-dev', to: null }]);

  const off = await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: false }, mia);
  assert.equal(off.status, 200);
  assert.equal(members.isAssignable('mia-dev'), false, 'off for GitHub is off for Can be assigned');
  assert.equal((await post(port, '/api/people/remove', { login: 'sam-ops' }, mia)).status, 200);
  assert.deepEqual(released, [{ login: 'mia-dev', by: 'mia-dev' }, { login: 'sam-ops', by: 'mia-dev' }], 'turning it off, or removing a member, gives their sessions back');

  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: 'yes' }, mia)).status, 400, 'Admin is on or off, not a word');
  assert.equal((await post(port, '/api/people/admin', { login: 'nobody', admin: true }, mia)).status, 409, 'only members can be admins');
  const admin = await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, mia);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.members.find((m) => m.login === 'mia-dev').admin, true);
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, {})).status, 401);
});

test('a local console with no sign-in and no GitHub App gives the person at the keyboard a login of their own', async () => {
  const { soloLoginOf } = await import('./server.mjs');
  assert.equal(soloLoginOf({ launcher: { kind: 'docker' }, githubApp: null, localLogin: 'local' }), 'local');
  assert.equal(soloLoginOf({ launcher: { kind: 'docker' }, githubApp: { appId: '1' }, localLogin: 'local' }), null, 'a GitHub App means sign-in tells people apart');
  assert.equal(soloLoginOf({ launcher: { kind: 'ecs' }, githubApp: null, localLogin: 'local' }), null, 'AWS never guesses who is asking');
});

test('My settings saves the signed-in login\'s own session limits, and refuses one out of range', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const userSettings = createUserSettings({ store: { state: {}, save() {} }, secrets: null });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 3_600_000, lifetimeMs: 8 * 3_600_000 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const set = await post(port, '/api/my/limits', { limits: { idleHours: 3 } }, as);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.limits, { idleHours: 3 });
  assert.deepEqual(set.body.limitDefaults, { idleHours: 1, lifetimeHours: 8 });
  const bad = await post(port, '/api/my/limits', { limits: { lifetimeHours: 99 } }, as);
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /from 1 to 24 hours/);
});

test('the editor is on the session\'s app name, for whoever can open the session, and never on the console\'s', async (t) => {
  let seen = null;
  const statusd = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie ?? null };
    res.end('workbench');
  });
  const statusPort = await listen(statusd);
  const session = { id: '3f9a1c20', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', editor: true, endpoint: { host: '127.0.0.1', statusPort } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null) };
  const loginOf = (cookie) => /woodshed_app=([\w-]+)/.exec(String(cookie))?.[1] ?? /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
    appSessionFor: async ({ cookieHeader }) => (/woodshed_app=/.test(String(cookieHeader)) ? { login: loginOf(cookieHeader) } : null),
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example',
  };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); statusd.close(); });
  function get(path, { host, cookie }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers: { host, cookie, accept: 'text/html', 'sec-fetch-site': 'none' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const appHost = `${session.id}.console.example`;

  const owner = await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=octocat' });
  assert.equal(owner.body, 'workbench');
  assert.deepEqual(seen, { url: '/__woodshed/code/', authorization: 'Bearer tok', cookie: null }, 'statusd\'s token, and no cookie');

  seen = null;
  const signedOut = await get('/__woodshed/code/?folder=x', { host: appHost, cookie: '' });
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.location, `https://console.example/auth/app?id=${session.id}&next=${encodeURIComponent('/__woodshed/code/?folder=x')}`);
  assert.equal((await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=mia-dev' })).status, 404, 'someone the app may be shared with, but not the session');
  assert.equal(seen, null);

  session.editor = false;
  assert.equal((await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=octocat' })).status, 404, 'a session whose statusd says it has no editor');
  assert.equal(seen, null);
  session.editor = true;

  const onConsole = await get(`/code/${session.id}/`, { host: 'console.example', cookie: 'woodshed_session=octocat' });
  assert.notEqual(onConsole.body, 'workbench', 'the console\'s own name never serves the editor');
  assert.equal(seen, null);
});

test('New session lists the projects you can write to, saves your default, and refuses a start on another', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const started = [];
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }; },
  };
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const projects = [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false },
    { name: 'secret', repo: 'acme/secret', default: false },
  ];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const asked = [];
  // Mia writes to tools, not to secret; the default's repo is what she signed in with.
  const githubFor = (project) => ({ canWrite: async (login) => { asked.push(`${login}:${project.name}`); return project.name === 'tools'; } });
  const viewPrefs = createViewPrefs({ state: {}, save() {} });
  const handle = createHandler({ config, fleet, auth, userSettings, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const get = async (path) => JSON.parse(await getBody(port, path, as));

  assert.deepEqual(await get('/api/my/projects'), {
    projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: 'app', saved: false,
  });
  await get('/api/my/projects');
  assert.deepEqual(asked.sort(), ['mia-dev:secret', 'mia-dev:tools'], 'each answer kept: GitHub is asked once');

  assert.deepEqual(await post(port, '/api/my/projects/default', { project: 'secret' }, as), { status: 403, body: { error: 'you cannot start sessions on a project named secret' } });
  const saved = await post(port, '/api/my/projects/default', { project: 'tools' }, as);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.defaultProject, 'tools');
  assert.equal(saved.body.saved, true);
  assert.equal((await get('/api/my/projects')).defaultProject, 'tools', 'kept for the next New session');

  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'secret' }, as)).status, 403);
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'nope' }, as)).status, 403);
  assert.equal(started.length, 0);
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'tools' }, as)).status, 201);
  assert.equal(started[0].project.repo, 'acme/tools');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go' }, as)).status, 201);
  assert.equal(started[1].project.name, 'app', 'a page from before projects starts on the installation\'s default');
});

test('Resume asks again whether the person may start on the session\'s project', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const sessions = {
    aaaa0001: { id: 'aaaa0001', owner: 'mia-dev', project: 'tools', status: 'paused' },
    aaaa0002: { id: 'aaaa0002', owner: 'mia-dev', project: 'secret', status: 'paused' },
    aaaa0003: { id: 'aaaa0003', owner: 'mia-dev', status: 'paused' },
    aaaa0004: { id: 'aaaa0004', owner: 'ana', project: 'secret', status: 'paused' },
  };
  const resumed = [];
  const fleet = {
    sessions: () => Object.values(sessions), find: (id) => sessions[id] ?? null,
    resumePrivate: async ({ owner, id }) => {
      if (sessions[id]?.owner !== owner) throw Object.assign(new Error('no session you can open with that id'), { shown: true });
      resumed.push(id);
      return { ...sessions[id], token: 'secret', status: 'queued' };
    },
  };
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const projects = [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false },
    { name: 'secret', repo: 'acme/secret', default: false },
  ];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  // Mia started a session on secret, then lost write access to its repo.
  const githubFor = (project) => ({ canWrite: async () => project.name === 'tools' });
  const viewPrefs = createViewPrefs({ state: {}, save() {} });
  const handle = createHandler({ config, fleet, auth, userSettings, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const refused = await post(port, '/api/my/sessions/aaaa0002/resume', {}, as);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /no longer start sessions on secret/);
  assert.equal((await post(port, '/api/my/sessions/aaaa0001/resume', {}, as)).status, 201);
  assert.equal((await post(port, '/api/my/sessions/aaaa0003/resume', {}, as)).status, 201, 'a session from before projects is on the default');
  const notMine = await post(port, '/api/my/sessions/aaaa0004/resume', {}, as);
  assert.equal(notMine.status, 409, 'someone else\'s session gets the usual answer, not its project\'s name');
  assert.equal(notMine.body.error, 'no session you can open with that id');
  assert.doesNotMatch(JSON.stringify(notMine.body), /secret/);
  assert.deepEqual(resumed, ['aaaa0001', 'aaaa0003']);
});

test('a console with one project offers it alone, and a saved default it no longer has falls back', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const viewPrefs = createViewPrefs({ state: { viewPrefs: { 'mia-dev': { pinned: [], defaultProject: 'gone' } } }, save() {} });
  const githubFor = () => assert.fail('one project needs no write check');
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  assert.deepEqual(JSON.parse(await getBody(port, '/api/my/projects', { cookie: 'woodshed_session=x' })), { projects: [{ name: 'r', repo: 'o/r' }], defaultProject: 'r', saved: false });
});

test('the session list names each session\'s project, and the projects there are, for the rail', async (t) => {
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
    projects: [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }],
  };
  const sessions = [
    { id: 'aaaa0001', status: 'running', title: 'on tools', project: 'tools', repo: 'acme/tools' },
    { id: 'aaaa0002', status: 'running', title: 'from before projects', repo: 'acme/tools' },
    { id: 'aaaa0003', status: 'running', title: 'on the default' },
  ];
  const handle = createHandler({ config, fleet: { sessions: () => sessions, find: () => null } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const body = JSON.parse(await getBody(port, '/api/sessions'));
  assert.deepEqual(body.projects, [{ name: 'app', color: 'teal', default: true }, { name: 'tools', color: 'plum', default: false }]);
  assert.deepEqual(Object.fromEntries(body.sessions.map((s) => [s.id, s.project])), { aaaa0001: 'tools', aaaa0002: 'tools', aaaa0003: 'app' });
});

test('New session\'s / list is the picked project\'s skills, or the default project\'s', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const read = [];
  const github = { skills: async () => { read.push('app'); return [{ name: 'deploy', desc: 'app skill' }]; } };
  const tools = { skills: async () => { read.push('tools'); return [{ name: 'release', desc: 'tools skill' }]; } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const names = async (path) => JSON.parse(await getBody(port, path)).skills.map((s) => s.name);
  assert.deepEqual(await names('/api/skills'), ['deploy']);
  assert.deepEqual(await names('/api/skills?project=tools'), ['release']);
  assert.deepEqual(await names('/api/skills?project=gone'), ['deploy'], 'a project the console does not have: the default\'s');
  await names('/api/skills?project=tools');
  assert.deepEqual(read, ['app', 'tools'], 'each project\'s list is kept');
});

test('another project\'s / list is only for someone who may start sessions on it', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const github = { skills: async () => [{ name: 'deploy', desc: 'app skill' }] };
  const tools = { skills: async () => [{ name: 'release', desc: 'tools skill' }] };
  const asked = [];
  // Mia writes to the default repo only.
  const projectAccess = { forStart: async (login, name) => { asked.push([login, name]); return name === 'app' ? projects[0] : null; } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null), projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const names = async (path) => JSON.parse(await getBody(port, path)).skills.map((s) => s.name);
  assert.deepEqual(await names('/api/skills?project=tools'), ['deploy'], 'refused: the default project\'s list, never the other repo\'s');
  assert.deepEqual(await names('/api/skills?project=app'), ['deploy']);
  assert.deepEqual(asked.map(([, name]) => name), ['tools', 'app']);
});

test('the rail\'s pull requests are read from each repo the person may start on, on that project\'s own client', async (t) => {
  const projects = [{ name: 'shop', repo: 'acme/shop', default: true }, { name: 'app', repo: 'acme/app' }, { name: 'ops', repo: 'acme/ops' }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/shop', projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const asked = [];
  const client = (repo, updatedAt) => ({ openPullsFor: async (login) => { asked.push(`${repo} ${login}`); return [{ number: 1, title: repo, why: 'yours', updatedAt }]; } });
  const github = client('acme/shop', '2026-11-01T00:00:00Z');
  const others = { app: client('acme/app', '2026-11-02T00:00:00Z'), ops: client('acme/ops', '2026-11-03T00:00:00Z') };
  // mia may start on shop and app, not ops.
  const projectAccess = { view: async () => ({ projects: projects.slice(0, 2).map(({ name, repo }) => ({ name, repo })), defaultProject: 'shop', saved: false }) };
  const fleet = { sessions: () => [], find: () => null };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const handle = createHandler({ config, fleet, auth, github, githubFor: (p) => others[p.name], projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const answer = await (await fetch(`http://127.0.0.1:${port}/api/my/pulls`, { headers: { cookie: 'woodshed_session=mia' } })).json();
  assert.deepEqual(asked.sort(), ['acme/app mia', 'acme/shop mia'], 'a repo the person may not start on is not asked');
  assert.deepEqual(answer.pulls.map((p) => `${p.project} ${p.repo}#${p.number}`), ['app acme/app#1', 'shop acme/shop#1'], 'newest first, each with its repo');
});
