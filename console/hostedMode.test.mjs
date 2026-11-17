// Hosted mode (README.md, "Hosted mode"): GitHub access borrowed from the host's broker, and sign-in by a trusted
// proxy's identity header. The broker's token source and the header's checks have their own tests
// (githubBroker.test.mjs, trustedIdentity.test.mjs); these are the console's routes and websockets with them on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { loadConfig, requireClosedWhenReachable } from './config.mjs';
import { applyStored } from './githubAppSetup.mjs';
import { createConsoleUpgrade, createHandler, pageShell } from './server.mjs';
import { createUserSettings } from './userSettings.mjs';
import { createSettings } from './settings.mjs';
import { IDENTITY_HEADER, createTrustedIdentity, signIdentity } from './trustedIdentity.mjs';

const SECRET = 'the-hosts-identity-secret-0123456789abcdef';
const CONFIG = {
  host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
  maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example', launcher: { kind: 'docker' }, localLogin: 'local',
  trustedIdentitySecret: SECRET,
};

function identity(login, role, { secret = SECRET, exp = Date.now() + 60_000 } = {}) {
  return { [IDENTITY_HEADER]: signIdentity({ secret, login, role, exp }) };
}
const OWNER = () => identity('ana-owner', 'owner');
const MEMBER = () => identity('sam-member', 'member');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function send(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: 'console.example', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* a page */ }
        resolve({ status: res.statusCode, location: res.headers.location, body: json, text: raw });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const WRITE = { origin: 'https://console.example', 'x-woodshed': '1', 'content-type': 'application/json' };

// Plays a session: its statusd (the app, the editor) and its ttyd, on one port, recording what each was sent.
async function fakeSession(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('from the session');
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, seen };
}

async function hostedConsole(t, { sessions = [], extra = {} } = {}) {
  const fleet = { sessions: () => sessions, find: (id) => sessions.find((s) => s.id === id) ?? null, stop: async () => {} };
  const trusted = createTrustedIdentity({ secret: SECRET });
  const reached = [];
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(String(name)); return { secrets: [], webhook: null }; } });
  const consoleSettings = { view: () => ({}), check() {}, setMany: () => {} };
  const handle = createHandler({ config: CONFIG, fleet, trusted, settings, consoleSettings, ...extra });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('upgrade', createConsoleUpgrade({ config: CONFIG, fleet, trusted }));
  const port = await listen(server);
  t.after(() => server.close());
  return { port, reached };
}

test('behind a hosting proxy its header is the only sign-in: missing, expired, forged or on another secret, nobody gets in', async (t) => {
  const { port } = await hostedConsole(t);
  const page = { accept: 'text/html' };
  const refused = {
    missing: {},
    expired: identity('ana-owner', 'owner', { exp: Date.now() - 1 }),
    'wrong secret': identity('ana-owner', 'owner', { secret: 'some-other-secret-0123456789abcdef-xyz' }),
    forged: { [IDENTITY_HEADER]: `${OWNER()[IDENTITY_HEADER].split('.')[0]}.AAAA` },
  };
  for (const [why, headers] of Object.entries(refused)) {
    assert.equal((await send(port, { path: '/api/sessions', headers })).status, 401, why);
    assert.equal((await send(port, { path: '/settings', headers: { ...page, ...headers } })).location, '/login?next=%2Fsettings', why);
    assert.equal((await send(port, { method: 'POST', path: '/api/my/sessions', headers: { ...WRITE, ...headers }, body: {} })).status, 401, why);
    const me = (await send(port, { path: '/api/me', headers })).body;
    assert.deepEqual([me.hosted, me.signIn, me.login, me.admin], [true, true, null, false], why);
  }
  for (const open of ['/login', '/healthz']) assert.equal((await send(port, { path: open })).status, 200, open);

  assert.equal((await send(port, { path: '/api/sessions', headers: MEMBER() })).status, 200);
  assert.equal((await send(port, { path: '/settings', headers: { ...page, ...MEMBER() } })).status, 200);
  const me = (await send(port, { path: '/api/me', headers: MEMBER() })).body;
  assert.deepEqual([me.login, me.admin, me.repo], ['sam-member', false, 'o/r']);

  // GitHub's own sign-in is not there to start, finish or end.
  assert.equal((await send(port, { path: '/auth/start?next=/' })).status, 401);
  assert.equal((await send(port, { path: '/auth/start?next=/', headers: MEMBER() })).status, 404);
  assert.equal((await send(port, { path: '/auth/callback?code=c&state=s', headers: MEMBER() })).status, 404);
  assert.equal((await send(port, { path: '/auth/connect', headers: MEMBER() })).status, 404, 'no Connect GitHub');
  const cookie = { cookie: 'woodshed_session=anything; __Host-woodshed_session=anything' };
  assert.equal((await send(port, { path: '/api/sessions', headers: cookie })).status, 401, 'a session cookie is not a sign-in here');
});

test('an owner has the admin\'s pages and calls; a member has none of them', async (t) => {
  const { port, reached } = await hostedConsole(t);
  const reads = ['/api/secrets', '/api/webhook-events', '/api/console-settings'];
  for (const path of reads) assert.equal((await send(port, { path, headers: MEMBER() })).status, 403, `member GET ${path}`);
  const writes = ['/api/secrets/registry-token', '/api/secrets/registry-token/reveal', '/api/console-settings', '/api/people/invite'];
  for (const path of writes) {
    assert.equal((await send(port, { method: 'POST', path, headers: { ...WRITE, ...MEMBER() }, body: { confirm: 'x', values: {} } })).status, 403, `member POST ${path}`);
  }
  assert.deepEqual(reached, [], 'nothing behind the pages was reached for a member');
  assert.equal((await send(port, { path: '/api/me', headers: MEMBER() })).body.admin, false);

  for (const path of reads) assert.equal((await send(port, { path, headers: OWNER() })).status, 200, `owner GET ${path}`);
  assert.equal((await send(port, { path: '/api/me', headers: OWNER() })).body.admin, true);
  assert.equal((await send(port, { path: '/api/people', headers: OWNER() })).status, 404, 'the host keeps who is in: no People list here');
  // An admin whose role is taken away by the host loses it on the next request.
  assert.equal((await send(port, { path: '/api/secrets', headers: identity('ana-owner', 'member') })).status, 403);
});

test('the person the header names sees shared sessions without a People list, and only their own private ones', async (t) => {
  const sessions = [
    { id: '0a1b2c3d', status: 'running', title: 'shared', startedBy: 'someone' },
    { id: '1a1b2c3d', status: 'running', title: 'mine', owner: 'sam-member' },
    { id: '2a1b2c3d', status: 'running', title: 'theirs', owner: 'ana-owner' },
  ];
  const { port } = await hostedConsole(t, { sessions });
  const ids = (await send(port, { path: '/api/sessions', headers: MEMBER() })).body.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ['0a1b2c3d', '1a1b2c3d']);
});

test('a console that borrows its GitHub access has no /setup/github, and My settings offers no Connect GitHub', async (t) => {
  const asked = [];
  const githubSetup = { available: () => true, view: async () => { asked.push('view'); return {}; }, restart: () => { asked.push('restart'); return {}; } };
  const userSettings = {
    view: () => ({ claudeToken: { set: false }, codexAuth: { set: false }, github: { connected: false }, files: {}, setUp: false, available: true }),
  };
  const fleet = { sessions: () => [], find: () => null };
  const config = { ...CONFIG, trustedIdentitySecret: null, githubBroker: { url: 'https://host.example/t', tokenFile: '/nonexistent' } };
  const handle = createHandler({ config, fleet, githubSetup, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  for (const path of ['/setup/github', '/setup/github/created?code=x&state=y', '/api/setup/github']) {
    assert.equal((await send(port, { path, headers: { accept: 'text/html' } })).status, 404, path);
  }
  assert.equal((await send(port, { method: 'POST', path: '/api/setup/github/restart', headers: WRITE, body: {} })).status, 404);
  assert.deepEqual(asked, [], 'the setup was never reached');
  assert.equal((await send(port, { path: '/api/my' })).body.githubConnect, false, 'no App sign-in to connect through');
});

test('the header signs a terminal websocket in, and never reaches the session', async (t) => {
  const session = await fakeSession(t);
  const sessions = [{ id: '0a1b2c3d', status: 'running', token: 'tok', terminalToken: 'term', endpoint: { host: '127.0.0.1', termPort: session.port, statusPort: session.port } }];
  const { port } = await hostedConsole(t, { sessions });
  const ws = (headers) => upgrade(port, { path: '/term/0a1b2c3d/ws', host: 'console.example', headers: { origin: 'https://console.example', ...headers } });

  assert.equal(await ws({}), 'HTTP/1.1 401 Unauthorized');
  assert.equal(await ws(identity('sam-member', 'member', { exp: Date.now() - 1 })), 'HTTP/1.1 401 Unauthorized', 'expired');
  assert.equal(await ws(identity('sam-member', 'member', { secret: 'some-other-secret-0123456789abcdef-xyz' })), 'HTTP/1.1 401 Unauthorized', 'wrong secret');
  assert.equal(session.seen.length, 0);
  assert.equal(await upgrade(port, { path: '/term/0a1b2c3d/ws', host: 'console.example', headers: { origin: 'https://evil.example', ...MEMBER() } }), 'HTTP/1.1 403 Forbidden', 'another origin, header or not');
  assert.equal(await ws(MEMBER()), 'HTTP/1.1 101 Switching Protocols');
  assert.equal(session.seen.length, 1);
  assert.equal(session.seen[0].headers[IDENTITY_HEADER], undefined, 'the session never gets the header');
  assert.equal(session.seen[0].headers.authorization, `Basic ${Buffer.from('woodshed:term').toString('base64')}`);
});

test('a session\'s app takes the header on its own name, through /auth/app, its pages and its websockets, and never passes it on', async (t) => {
  const session = await fakeSession(t);
  const sessions = [{ id: '0a1b2c3d', status: 'running', token: 'tok', terminalToken: 'term', owner: 'sam-member', editor: true, endpoint: { host: '127.0.0.1', termPort: 1, statusPort: session.port } }];
  const { port } = await hostedConsole(t, { sessions });
  const app = { host: '0a1b2c3d.woodshed.example', accept: 'text/html' };

  const first = await send(port, { path: '/report?x=1', headers: app });
  assert.equal(first.location, 'https://console.example/auth/app?id=0a1b2c3d&next=%2Freport%3Fx%3D1', 'no header: sent to the console, as without one today');
  assert.equal((await send(port, { method: 'POST', path: '/api/x', headers: { host: app.host } })).status, 401);
  assert.equal(session.seen.length, 0);

  const ask = new URL(first.location);
  assert.equal((await send(port, { path: ask.pathname + ask.search, headers: { accept: 'text/html' } })).location, `/login?next=${encodeURIComponent(ask.pathname + ask.search)}`);
  const handed = new URL((await send(port, { path: ask.pathname + ask.search, headers: MEMBER() })).location);
  assert.equal(handed.origin, 'https://0a1b2c3d.woodshed.example');
  assert.deepEqual([handed.pathname, handed.searchParams.get('next'), handed.searchParams.get('code')], ['/__woodshed/auth', '/report?x=1', null], 'no code: the proxy signs the app\'s name in');
  assert.equal((await send(port, { path: '/auth/app?id=0a1b2c3d&next=/', headers: OWNER() })).status, 404, 'someone else\'s private session');

  const claimed = await send(port, { path: handed.pathname + handed.search, headers: { ...app, ...MEMBER() } });
  assert.deepEqual([claimed.status, claimed.location], [302, '/report?x=1']);
  const proxyLost = await send(port, { path: handed.pathname + handed.search, headers: app });
  assert.equal(proxyLost.status, 403, 'the console signed in but the app\'s name got nothing: said, not sent round again');
  assert.match(proxyLost.text, /did not say who you are/);
  const crafted = new URL(handed);
  crafted.searchParams.set('next', '//evil.example/x');
  assert.equal((await send(port, { path: crafted.pathname + crafted.search, headers: { ...app, ...MEMBER() } })).location, '/', 'next stays on the app');

  const page = await send(port, { path: '/report', headers: { ...app, ...MEMBER(), cookie: 'theme=dark' } });
  assert.deepEqual([page.status, page.text], [200, 'from the session']);
  const reachedApp = session.seen.at(-1);
  assert.equal(reachedApp.headers[IDENTITY_HEADER], undefined, 'the app never gets the header');
  assert.equal(reachedApp.headers.cookie, 'theme=dark');
  assert.equal((await send(port, { path: '/report', headers: { ...app, ...OWNER() } })).status, 404, 'someone else\'s private session\'s app');

  assert.equal((await send(port, { path: '/__woodshed/code/', headers: app })).status, 302, 'the editor without the header: sent to sign in');
  assert.equal((await send(port, { path: '/__woodshed/code/', headers: { ...app, ...OWNER() } })).status, 404, 'not the owner\'s editor to open');
  assert.equal((await send(port, { path: '/__woodshed/code/', headers: { ...app, ...MEMBER() } })).status, 200);
  assert.equal(session.seen.at(-1).url, '/__woodshed/code/');
  assert.equal(session.seen.at(-1).headers[IDENTITY_HEADER], undefined, 'nor does the editor');

  assert.equal(await upgrade(port, { path: '/_next/hmr', host: app.host, headers: {} }), 'HTTP/1.1 401 Unauthorized');
  assert.equal(await upgrade(port, { path: '/_next/hmr', host: app.host, headers: identity('sam-member', 'member', { exp: Date.now() - 1 }) }), 'HTTP/1.1 401 Unauthorized');
  assert.equal(await upgrade(port, { path: '/_next/hmr', host: app.host, headers: MEMBER() }), 'HTTP/1.1 101 Switching Protocols');
  assert.equal(session.seen.find((s) => s.upgrade).headers[IDENTITY_HEADER], undefined, 'nor does its websocket');
});

function upgrade(port, { path, host, headers }) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write([`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'));
    });
    let buf = '';
    client.on('data', (c) => {
      buf += c;
      if (buf.includes('\r\n\r\n')) client.end();
    });
    client.on('close', () => resolve(buf.split('\r\n')[0]));
    client.on('error', reject);
  });
}

test('the settings: the broker and an App of its own are refused together, and either half of the broker alone', () => {
  const base = { WOODSHED_REPO: 'acme/app', GH_TOKEN: 'x' };
  const broker = { WOODSHED_GITHUB_BROKER_URL: 'https://host.example/github/token', WOODSHED_GITHUB_BROKER_TOKEN_FILE: '/run/secrets/broker' };
  const app = { WOODSHED_GITHUB_APP_ID: '1', WOODSHED_GITHUB_APP_INSTALLATION_ID: '2', WOODSHED_GITHUB_APP_KEY_FILE: '/k.pem' };
  assert.throws(() => loadConfig({ ...base, ...broker, ...app }), /WOODSHED_GITHUB_APP_ID and WOODSHED_GITHUB_BROKER_URL cannot both be set/);
  assert.throws(() => loadConfig({ ...base, ...app, WOODSHED_GITHUB_BROKER_TOKEN_FILE: '/f' }), /WOODSHED_GITHUB_APP_ID and WOODSHED_GITHUB_BROKER_URL/);
  assert.throws(() => loadConfig({ ...base, WOODSHED_GITHUB_BROKER_URL: broker.WOODSHED_GITHUB_BROKER_URL }), /WOODSHED_GITHUB_BROKER_URL needs WOODSHED_GITHUB_BROKER_TOKEN_FILE too/);
  assert.throws(() => loadConfig({ ...base, WOODSHED_GITHUB_BROKER_TOKEN_FILE: '/f' }), /WOODSHED_GITHUB_BROKER_TOKEN_FILE needs WOODSHED_GITHUB_BROKER_URL too/);
  assert.throws(() => loadConfig({ ...base, ...broker, WOODSHED_GITHUB_BROKER_URL: 'ftp://host.example' }), /must be http\(s\)/);

  const hosted = loadConfig({ ...base, ...broker });
  assert.deepEqual(hosted.githubBroker, { url: 'https://host.example/github/token', tokenFile: '/run/secrets/broker' });
  assert.equal(hosted.githubApp, null);
  assert.equal(hosted.ghToken, null, 'no gh token in its place either');
  assert.equal(loadConfig(base).githubBroker, null, 'off unless set');
});

test('the identity secret is sign-in required from the first request, so a reachable console may start with it', () => {
  const base = { WOODSHED_REPO: 'acme/app', GH_TOKEN: 'x', WOODSHED_HOST: '0.0.0.0' };
  assert.throws(() => requireClosedWhenReachable(loadConfig(base)), /WOODSHED_REQUIRE_SIGN_IN=1 \(with the GitHub App\) or WOODSHED_TRUSTED_IDENTITY_SECRET/);
  const config = loadConfig({ ...base, WOODSHED_TRUSTED_IDENTITY_SECRET: SECRET });
  assert.doesNotThrow(() => requireClosedWhenReachable(config));
  assert.deepEqual([config.requireSignIn, config.trustedIdentitySecret], [true, SECRET]);
  assert.throws(() => loadConfig({ ...base, WOODSHED_TRUSTED_IDENTITY_SECRET: 'short' }), /at least 32 characters/);
  assert.equal(loadConfig({ WOODSHED_REPO: 'acme/app', GH_TOKEN: 'x' }).trustedIdentitySecret, null);
});

test('an App the setup page saved stays unused when the console borrows its GitHub access', () => {
  const store = { state: { githubAppSetup: { appId: '77', installationId: '4242' } } };
  const config = { githubApp: null, githubBroker: { url: 'https://host.example/t', tokenFile: '/f' }, ghToken: null };
  assert.equal(applyStored({ config, store, secrets: {} }), config);
});

test('the Secrets page keeps everything but the App\'s own secrets, with no webhook card, when GitHub access is borrowed', async () => {
  const list = ['anthropic-api-key', 'registry-token', 'github-app-key', 'github-webhook-secret', 'github-app-client-secret', 'slack-bot-token'].map((name) => ({ name, set: false }));
  const written = [];
  const secrets = { list: async () => list, write: async (name) => { written.push(name); }, read: async () => null };
  const config = { repo: 'acme/app', installSecrets: [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }], githubBroker: { url: 'https://host.example/t', tokenFile: '/f' } };
  const settings = createSettings({ config, secrets, appKey: null, appApi: null, webhookUrl: async () => null });
  const view = await settings.view();
  assert.deepEqual(view.secrets.map((s) => s.name), ['anthropic-api-key', 'registry-token', 'slack-bot-token']);
  assert.equal(view.webhook, null);
  await assert.rejects(settings.replace('github-app-key', 'x'), /no secret called github-app-key/);
  await assert.rejects(settings.replace('github-app-client-secret', 'x'), /no secret called github-app-client-secret/);
  for (const call of [settings.deliveries(), settings.rotateWebhookSecret(), settings.applyWebhook(), settings.setWebhookUrl('https://x.example')]) {
    await assert.rejects(call, /borrows its GitHub access from its host, so it has no GitHub App webhook/);
  }
  await settings.replace('registry-token', 'npm_x');
  assert.deepEqual(written, ['registry-token']);
});

test('a program embedding the console adds to the user menu, and only links a page may hold get through', async (t) => {
  const userMenu = (headers) => (headers['x-boom'] ? JSON.parse('{') : {
    subtitle: 'Platform team',
    groups: [
      { label: 'Workspace', items: [{ label: 'Platform team', current: true, note: 'Admin' }, { label: 'Mobile team', current: false, href: '/switch?to=mobile' }] },
      { items: [{ label: 'Billing', href: 'https://billing.example/' }, { label: 'Bad', href: 'javascript:alert(1)' }, { label: 'Odd', href: '//elsewhere.example' }, { href: '/no-label' }] },
      { label: 'Empty', items: [] },
    ],
  });
  const { port } = await hostedConsole(t, { extra: { userMenu } });
  const me = (await send(port, { path: '/api/me', headers: MEMBER() })).body;
  assert.equal(me.menuSubtitle, 'Platform team');
  assert.deepEqual(me.menuGroups, [
    { label: 'Workspace', items: [{ label: 'Platform team', href: null, current: true, note: 'Admin' }, { label: 'Mobile team', href: '/switch?to=mobile', current: false, note: null }] },
    { label: null, items: [{ label: 'Billing', href: 'https://billing.example/', note: null }] },
  ]);
  const signedOut = (await send(port, { path: '/api/me' })).body;
  assert.equal(signedOut.menuGroups, undefined, 'nothing for someone not signed in');
  t.mock.method(console, 'warn', () => {});
  const failed = (await send(port, { path: '/api/me', headers: { ...MEMBER(), 'x-boom': '1' } })).body;
  assert.deepEqual([failed.login, failed.menuGroups], ['sam-member', undefined], 'a menu that throws leaves /api/me as it was');
});

test('a page carries the console\'s link query for the links it copies, escaped as a query', () => {
  assert.match(pageShell({ title: 't', script: 'common.js', linkQuery: { place: 'a"b<c' } }), /<meta name="woodshed-link-query" content="place=a%22b%3Cc">/);
  assert.doesNotMatch(pageShell({ title: 't', script: 'common.js' }), /woodshed-link-query/);
});

test('My Woodshed\'s first look waits for the secret store, and its polls after that do not', async (t) => {
  t.mock.method(console, 'log', () => {});
  const values = new Map([['users/sam-member/claude-token', 'sk-ant-written-beside-the-console']]);
  let reads = 0;
  const secrets = { async read(name) { reads += 1; return values.get(name) ?? null; } };
  const userSettings = createUserSettings({ store: { state: {}, save() {} }, secrets });
  const { port } = await hostedConsole(t, { extra: { userSettings } });
  assert.equal((await send(port, { path: '/api/my', headers: MEMBER() })).body.claudeToken.set, true, 'the first look found it');
  assert.equal(reads, 2);
  values.delete('users/sam-member/claude-token');
  assert.equal((await send(port, { path: '/api/my', headers: MEMBER() })).body.claudeToken.set, true, 'a poll inside the minute does not ask');
  assert.equal(reads, 2);
});
