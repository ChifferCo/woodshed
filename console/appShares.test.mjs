import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';

import { createAppShares } from './appShares.mjs';
import { canOpenApp, createAppUpgrade, createHandler } from './server.mjs';

function memoryStore() {
  return { state: {}, save() {} };
}

test('a link has an expiry in range, a hash on disk and a token that works for its own app only', () => {
  let clock = 1_000_000;
  const store = memoryStore();
  const shares = createAppShares({ store, now: () => clock });
  assert.throws(() => shares.createLink({ sessionId: '0a1b2c3d', hours: 0, by: 'joel' }), /hours must be/);
  assert.throws(() => shares.createLink({ sessionId: '0a1b2c3d', hours: 169, by: 'joel' }), /hours must be/);
  assert.throws(() => shares.createLink({ sessionId: '0a1b2c3d', hours: 1.5, by: 'joel' }), /hours must be/);
  const link = shares.createLink({ sessionId: '0a1b2c3d', hours: 2, by: 'joel' });
  assert.equal(link.expiresAt, clock + 2 * 3_600_000);
  assert.ok(!JSON.stringify(store.state).includes(link.token.split('.')[1]), 'the state file holds a hash, never the secret');

  assert.equal(shares.claim({ token: link.token, appId: 'ffffffff' }), null, 'another app\'s name');
  assert.equal(shares.claim({ token: `${link.id}.${'0'.repeat(64)}`, appId: '0a1b2c3d' }), null, 'a wrong secret');
  assert.equal(shares.claim({ token: link.id, appId: '0a1b2c3d' }), null, 'no secret');
  assert.equal(shares.claim({ token: `__proto__.${'0'.repeat(64)}`, appId: '0a1b2c3d' }), null, 'an inherited property is no link');
  assert.equal(shares.revokeLink({ sessionId: '0a1b2c3d', linkId: 'constructor', by: 'joel' }), false);
  const claimed = shares.claim({ token: link.token, appId: '0a1b2c3d' });
  assert.match(claimed.setCookie, /^__Host-woodshed_view=.*Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=7200$/);
  assert.deepEqual(shares.viewerFor({ cookieHeader: `a=1; __Host-woodshed_view=${encodeURIComponent(link.token)}`, appId: '0a1b2c3d' }), { linkId: link.id });
  assert.equal(shares.viewerFor({ cookieHeader: `woodshed_view=${link.token}`, appId: '0a1b2c3d' }), null, 'only the __Host- name counts on https');

  clock += 2 * 3_600_000;
  assert.equal(shares.claim({ token: link.token, appId: '0a1b2c3d' }), null, 'expired');
  assert.equal(shares.viewerFor({ cookieHeader: `__Host-woodshed_view=${link.token}`, appId: '0a1b2c3d' }), null, 'its cookie ends with it');
});

test('a session has at most ten links, revoking one ends it at once, and the member switch is its own', () => {
  const shares = createAppShares({ store: memoryStore() });
  const made = Array.from({ length: 10 }, () => shares.createLink({ sessionId: '0a1b2c3d', hours: 1, by: 'joel' }));
  assert.throws(() => shares.createLink({ sessionId: '0a1b2c3d', hours: 1, by: 'joel' }), /at most 10 links/);
  assert.equal(shares.revokeLink({ sessionId: '0a1b2c3d', linkId: made[0].id, by: 'joel' }), true);
  assert.equal(shares.revokeLink({ sessionId: '0a1b2c3d', linkId: made[0].id, by: 'joel' }), false, 'already gone');
  assert.equal(shares.claim({ token: made[0].token, appId: '0a1b2c3d' }), null);
  assert.ok(shares.claim({ token: made[1].token, appId: '0a1b2c3d' }), 'the others still work');

  assert.equal(shares.membersOpen('0a1b2c3d'), false);
  shares.setMembers({ sessionId: '0a1b2c3d', on: true, by: 'joel' });
  assert.equal(shares.membersOpen('0a1b2c3d'), true);
  assert.equal(shares.view('0a1b2c3d').links.length, 9, 'the link list does not change with the switch');
  shares.setMembers({ sessionId: '0a1b2c3d', on: false, by: 'joel' });
  assert.equal(shares.membersOpen('0a1b2c3d'), false);
});

test('sweep ends the shares of a session that is no longer active, and the links that ran out', () => {
  let clock = 0;
  const store = memoryStore();
  const shares = createAppShares({ store, now: () => clock });
  const kept = shares.createLink({ sessionId: 'aaaaaaaa', hours: 1, by: 'joel' });
  const lapsing = shares.createLink({ sessionId: 'aaaaaaaa', hours: 1, by: 'joel' });
  shares.setMembers({ sessionId: 'bbbbbbbb', on: true, by: 'joel' });
  shares.createLink({ sessionId: 'cccccccc', hours: 1, by: 'joel' });
  clock = 1;
  shares.sweep(['aaaaaaaa', 'cccccccc']);
  assert.equal(shares.membersOpen('bbbbbbbb'), false, 'a stopped session\'s switch is off');
  assert.deepEqual(Object.keys(store.state.appShares).sort(), ['aaaaaaaa', 'cccccccc']);
  clock = 3_600_000;
  shares.sweep(['aaaaaaaa']);
  assert.deepEqual(store.state.appShares, {}, 'expired links and the stopped session are gone');
  assert.equal(shares.claim({ token: kept.token, appId: 'aaaaaaaa' }) ?? shares.claim({ token: lapsing.token, appId: 'aaaaaaaa' }), null);
});

test('canOpenApp adds members to a shared private session\'s app and nothing to anyone else\'s', () => {
  const mine = { id: 'a', owner: 'joel' };
  const members = { isMember: (login) => login === 'mia', hasGithubSessions: () => true };
  assert.equal(canOpenApp(mine, 'joel', members, false), true, 'the owner');
  assert.equal(canOpenApp(mine, 'mia', members, false), false, 'a member, not shared');
  assert.equal(canOpenApp(mine, 'mia', members, true), true, 'a member, shared');
  assert.equal(canOpenApp(mine, 'zed', members, true), false, 'not a member');
  assert.equal(canOpenApp(mine, null, members, true), false, 'nobody signed in');
  assert.equal(canOpenApp(mine, 'zed', null, true), true, 'a console with no list tells nobody apart');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function fakeStatusd() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>the app at ${req.url}</p>`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  return { server, port: await listen(server), seen };
}

function request(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function upgrade(port, { host, cookie }) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(['GET /_next/webpack-hmr HTTP/1.1', `Host: ${host}`, cookie && `Cookie: ${cookie}`, 'Upgrade: websocket', 'Connection: Upgrade', '', ''].filter((l) => l !== undefined && l !== null && l !== false).join('\r\n'));
    });
    let buf = '';
    client.on('data', (c) => { buf += c; });
    client.on('close', () => resolve(buf.split('\r\n')[0]));
    client.on('error', reject);
  });
}

// A console with one running My Woodshed session of octocat's, a member (mia-dev), a stranger with no list place,
// and real app shares. Sign-in is a stub: `woodshed_session=<login>` is the console's cookie and `woodshed_app=<login>`
// an app's, each good only for the people on the list, as the real auth makes them.
async function sharedConsole(t) {
  const statusd = await fakeStatusd();
  const session = { id: '0a1b2c3d', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', terminalToken: 'tt', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: statusd.port, shellPort: 1 } };
  const reached = [];
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    stop: async (s) => { reached.push(`stop ${s.id}`); },
    startApp: async (s) => { reached.push(`startApp ${s.id}`); return s; },
    stopApp: async (s) => { reached.push(`stopApp ${s.id}`); return s; },
  };
  const members = { isMember: (l) => ['octocat', 'mia-dev'].includes(l), hasGithubSessions: () => true };
  const cookieOf = (header, name) => new RegExp(`(?:^|; )${name}=([\\w-]+)`).exec(String(header))?.[1] ?? null;
  const known = (login) => (login && members.isMember(login) ? { login } : null);
  const auth = {
    enabled: () => true,
    available: () => true,
    appCookie: '__Host-woodshed_app',
    sessionFor: async (cookie) => known(cookieOf(cookie, 'woodshed_session')),
    appSessionFor: async ({ cookieHeader }) => known(cookieOf(cookieHeader, '__Host-woodshed_app')),
    appCode: async () => 'code',
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example',
  };
  const store = memoryStore();
  const appShares = createAppShares({ store });
  const handle = createHandler({ config, fleet, auth, members, appShares });
  const appUpgrade = createAppUpgrade({ config, fleet, auth, members, appShares });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('upgrade', (req, socket, head) => appUpgrade(req, socket, head, '0a1b2c3d'));
  const port = await listen(server);
  t.after(() => { statusd.server.close(); server.close(); });

  const consoleCall = (login, path, { method = 'GET', body } = {}) => request(port, {
    method, path, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: 'console.example', cookie: `woodshed_session=${login}`, accept: 'application/json', 'x-woodshed': '1', origin: 'https://console.example' },
  });
  const appCall = (path, { cookie, method = 'GET' } = {}) => request(port, { method, path, headers: { host: '0a1b2c3d.woodshed.example', ...(cookie ? { cookie } : {}) } });
  return { session, statusd, reached, store, appShares, consoleCall, appCall, port };
}

test('the owner shares the app with members: they open it, and nothing else of the session', async (t) => {
  const c = await sharedConsole(t);
  const asMia = 'woodshed_app=x; __Host-woodshed_app=mia-dev';
  assert.equal((await c.appCall('/workflows', { cookie: asMia })).status, 404, 'private by default');

  assert.equal((await c.consoleCall('mia-dev', '/api/sessions/0a1b2c3d/app-share/members', { method: 'POST', body: { on: true } })).status, 404, 'a member cannot switch it on');
  assert.equal((await c.consoleCall('mia-dev', '/api/sessions/0a1b2c3d/app-share')).status, 404, 'nor read it');
  assert.equal((await c.appCall('/workflows', { cookie: asMia })).status, 404);

  const on = await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/members', { method: 'POST', body: { on: true } });
  assert.deepEqual([on.status, JSON.parse(on.body).members], [200, true]);
  const open = await c.appCall('/workflows', { cookie: asMia });
  assert.deepEqual([open.status, open.body], [200, '<p>the app at /workflows</p>']);
  assert.equal(c.statusd.seen.at(-1).headers['x-woodshed-app'], 'Bearer tok');
  assert.equal((await c.appCall('/workflows', { cookie: '__Host-woodshed_app=zed-stranger' })).status, 302, 'someone off the list is sent to sign in');
  assert.equal((await c.consoleCall('mia-dev', '/auth/app?id=0a1b2c3d&next=/')).status, 302, 'the console hands a member a code for the app');
  assert.equal(await upgrade(c.port, { host: '0a1b2c3d.woodshed.example', cookie: asMia }), 'HTTP/1.1 101 Switching Protocols', 'and its websocket');

  for (const route of [
    { path: '/api/sessions/0a1b2c3d/review' }, { path: '/term/0a1b2c3d/' }, { path: '/shell/0a1b2c3d/' }, { path: '/redis/0a1b2c3d/' }, { path: '/pg/0a1b2c3d/' },
    { path: '/api/sessions/0a1b2c3d/applog' }, { path: '/api/sessions/0a1b2c3d/image?path=a.png' },
    { method: 'POST', path: '/api/sessions/0a1b2c3d/stop' }, { method: 'POST', path: '/api/sessions/0a1b2c3d/app/start' },
    { method: 'POST', path: '/api/sessions/0a1b2c3d/app/stop' }, { method: 'POST', path: '/api/sessions/0a1b2c3d/send' },
  ]) {
    const theirs = await c.consoleCall('mia-dev', route.path, { method: route.method, body: route.method ? {} : undefined });
    const nobody = await c.consoleCall('mia-dev', route.path.replace('0a1b2c3d', 'ffffffff'), { method: route.method, body: route.method ? {} : undefined });
    assert.deepEqual([theirs.status, theirs.body], [nobody.status, nobody.body], `${route.method ?? 'GET'} ${route.path} answers as an unknown session`);
  }
  assert.deepEqual(c.reached, [], 'nothing but the app reached the session');

  await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/members', { method: 'POST', body: { on: false } });
  assert.equal((await c.appCall('/workflows', { cookie: asMia })).status, 404, 'turned off, it is private again at once');
  assert.equal(await upgrade(c.port, { host: '0a1b2c3d.woodshed.example', cookie: asMia }), 'HTTP/1.1 404 Not Found', 'and its websocket');
});

test('a link opens the app for someone with no account, until it ends, and gets nothing of the console', async (t) => {
  const c = await sharedConsole(t);
  const made = await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/links', { method: 'POST', body: { hours: 24 } });
  assert.equal(made.status, 201);
  const { url, created, links } = JSON.parse(made.body);
  assert.match(url, /^https:\/\/0a1b2c3d\.woodshed\.example\/__woodshed\/share\?t=[0-9a-f]{8}\.[0-9a-f]{64}$/);
  assert.equal(links.length, 1);
  assert.ok(!JSON.stringify(c.store.state).includes(url.split('.').pop()), 'the secret is not in the state file');
  const listed = JSON.parse((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share')).body);
  assert.ok(!JSON.stringify(listed).includes('t='), 'a listing never shows a token');

  assert.equal((await c.appCall('/workflows')).status, 302, 'no link, no cookie: sent to sign in');
  const path = new URL(url).pathname + new URL(url).search;
  const claimed = await c.appCall(path);
  assert.equal(claimed.status, 302);
  assert.equal(claimed.headers.location, '/');
  assert.equal(claimed.headers['referrer-policy'], 'no-referrer');
  assert.match(claimed.headers['set-cookie'][0], /^__Host-woodshed_view=.*HttpOnly; SameSite=Lax; Secure; Max-Age=86\d{3}$/);
  const cookie = `theirs=1; ${claimed.headers['set-cookie'][0].split(';')[0]}`;

  const open = await c.appCall('/workflows?x=1', { cookie });
  assert.deepEqual([open.status, open.body], [200, '<p>the app at /workflows?x=1</p>']);
  const forwarded = c.statusd.seen.at(-1).headers;
  assert.equal(forwarded.cookie, 'theirs=1', 'the app never sees the share cookie');
  assert.equal(await upgrade(c.port, { host: '0a1b2c3d.woodshed.example', cookie }), 'HTTP/1.1 101 Switching Protocols');

  for (const route of [
    { path: '/api/sessions' }, { path: '/api/sessions/0a1b2c3d/review' }, { path: '/term/0a1b2c3d/' }, { path: '/redis/0a1b2c3d/' },
    { method: 'POST', path: '/api/sessions/0a1b2c3d/stop' }, { method: 'POST', path: '/api/sessions/0a1b2c3d/app/start' },
    { path: '/api/sessions/0a1b2c3d/app-share' }, { method: 'POST', path: '/api/sessions/0a1b2c3d/app-share/links' },
  ]) {
    const res = await request(c.port, { method: route.method, path: route.path, headers: { host: 'console.example', cookie, accept: 'application/json', 'x-woodshed': '1', origin: 'https://console.example' } });
    assert.equal(res.status, 401, `the link's cookie on the console's ${route.method ?? 'GET'} ${route.path}`);
  }
  assert.deepEqual(c.reached, []);

  const other = await request(c.port, { path: '/workflows', headers: { host: 'ffffffff.woodshed.example', cookie } });
  assert.equal(other.status, 302, 'another session\'s app does not take it');

  const revoked = await c.consoleCall('octocat', `/api/sessions/0a1b2c3d/app-share/links/${created}/revoke`, { method: 'POST', body: {} });
  assert.deepEqual([revoked.status, JSON.parse(revoked.body).links], [200, []]);
  assert.equal((await c.appCall('/workflows', { cookie })).status, 302, 'revoked: the cookie no longer opens it');
  assert.equal(await upgrade(c.port, { host: '0a1b2c3d.woodshed.example', cookie }), 'HTTP/1.1 401 Unauthorized', 'nor its websocket');
  const again = await c.appCall(path);
  assert.equal(again.status, 403);
  assert.match(again.body, /expired or was turned off/);
});

test('only the owner makes links, and only while the session runs; a stopped session\'s link opens nothing', async (t) => {
  const c = await sharedConsole(t);
  assert.equal((await c.consoleCall('mia-dev', '/api/sessions/0a1b2c3d/app-share/links', { method: 'POST', body: { hours: 1 } })).status, 404);
  assert.equal((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/links', { method: 'POST', body: { hours: 9999 } })).status, 400);
  assert.equal((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share', { method: 'POST', body: {} })).status, 405, 'no bare post');
  assert.equal((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/members', { method: 'POST', body: { on: 'yes' } })).status, 400);
  assert.deepEqual(c.appShares.view('0a1b2c3d'), { members: false, links: [] }, 'refused requests change nothing');

  const { url } = JSON.parse((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/links', { method: 'POST', body: { hours: 1 } })).body);
  const claimed = await c.appCall(new URL(url).pathname + new URL(url).search);
  const cookie = claimed.headers['set-cookie'][0].split(';')[0];
  assert.equal((await c.appCall('/', { cookie })).status, 200);
  c.session.status = 'stopped';
  assert.equal((await c.appCall('/', { cookie })).status, 404, 'a stopped session has no app');
  const off = await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/members', { method: 'POST', body: { on: false } });
  assert.equal(off.status, 200, 'turning sharing off never needs the session running');
  assert.equal((await c.consoleCall('octocat', '/api/sessions/0a1b2c3d/app-share/links', { method: 'POST', body: { hours: 1 } })).status, 409, 'and nothing to share');
  c.appShares.sweep([]);
  c.session.status = 'running';
  assert.equal((await c.appCall('/', { cookie })).status, 302, 'resumed, the old link is gone');
});

test('a shared session\'s app has no share of its own', async (t) => {
  const c = await sharedConsole(t);
  c.session.owner = null;
  const res = await c.consoleCall('mia-dev', '/api/sessions/0a1b2c3d/app-share');
  assert.equal(res.status, 409);
});
