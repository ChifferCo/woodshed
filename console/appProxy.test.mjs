import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';

import { appIdFor, withoutCookie } from './appProxy.mjs';
import { createAuth } from './auth.mjs';
import { createAppUpgrade, createHandler } from './server.mjs';

test('appIdFor reads the session id from `<id>.<app domain>` and nothing else', () => {
  assert.equal(appIdFor('0a1b2c3d.woodshed.example', 'woodshed.example'), '0a1b2c3d');
  assert.equal(appIdFor('0A1B2C3D.Woodshed.Example:443', 'woodshed.example'), '0a1b2c3d');
  for (const host of ['woodshed.example', 'x.0a1b2c3d.woodshed.example', '0a1b2c3.woodshed.example', '0a1b2c3d.woodshed.example.evil', '0a1b2c3d-woodshed.example', undefined]) {
    assert.equal(appIdFor(host, 'woodshed.example'), null, String(host));
  }
  assert.equal(appIdFor('0a1b2c3d.woodshed.example', ''), null, 'no app domain, no apps');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Plays a session's statusd: answers app requests the way statusd does, and records what it was sent.
async function fakeStatusd({ appUp = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.headers['x-woodshed-app'] !== 'Bearer tok') {
      res.writeHead(401);
      return res.end();
    }
    if (!appUp) {
      res.writeHead(503, { 'content-type': 'application/json', 'x-woodshed-app': 'down' });
      return res.end('{"error":"the app is not running"}');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>the app at ${req.url}</p>`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  return { server, port: await listen(server), seen };
}

async function consoleFor(statusPort, { status = 'running' } = {}) {
  const session = { id: '0a1b2c3d', status, token: 'tok', terminalToken: 'term', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null), stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example',
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, port: await listen(server) };
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a request for `<id>.<app domain>` reaches that session\'s app through statusd, with the app\'s own Authorization kept', async (t) => {
  const statusd = await fakeStatusd();
  const consoleServer = await consoleFor(statusd.port);
  t.after(() => { statusd.server.close(); consoleServer.server.close(); });

  const res = await get(consoleServer.port, '/workflows?x=1', { host: '0a1b2c3d.woodshed.example', authorization: 'Bearer session-token', cookie: 'app=1' });
  assert.deepEqual(res, { status: 200, body: '<p>the app at /workflows?x=1</p>' });
  const sent = statusd.seen.at(-1).headers;
  assert.equal(sent['x-woodshed-app'], 'Bearer tok');
  assert.equal(sent.authorization, 'Bearer session-token');
  assert.equal(sent.host, '0a1b2c3d.woodshed.example', 'Next sees the app\'s own name, for its dev-origin check');
  assert.equal(sent['x-forwarded-proto'], 'https');

  assert.equal((await get(consoleServer.port, '/', { host: 'ffffffff.woodshed.example' })).status, 404, 'an unknown session');
  assert.equal((await get(consoleServer.port, '/api/sessions', { host: 'woodshed.example' })).status, 421, 'the bare app domain is not the console');
});

test('a stopped app gets a page that links to its session, and a stopped session has no app', async (t) => {
  const statusd = await fakeStatusd({ appUp: false });
  const running = await consoleFor(statusd.port);
  const stopped = await consoleFor(statusd.port, { status: 'stopped' });
  t.after(() => { statusd.server.close(); running.server.close(); stopped.server.close(); });

  const res = await get(running.port, '/', { host: '0a1b2c3d.woodshed.example' });
  assert.equal(res.status, 503);
  assert.match(res.body, /This session's app is not running/);
  assert.match(res.body, /href="https:\/\/console\.example\/s\/0a1b2c3d"/);
  assert.equal((await get(stopped.port, '/', { host: '0a1b2c3d.woodshed.example' })).status, 404);
});

test('an app websocket goes through to statusd with the session token, whatever its origin', async (t) => {
  const statusd = await fakeStatusd();
  const consoleServer = await consoleFor(statusd.port);
  // createHandler serves HTTP only; main() wires upgrades the same way, which this reproduces.
  const { handleAppUpgrade } = await import('./appProxy.mjs');
  consoleServer.server.on('upgrade', (req, socket, head) => handleAppUpgrade(req, socket, head, {
    id: appIdFor(req.headers.host, 'woodshed.example'),
    targetFor: () => ({ host: '127.0.0.1', statusPort: statusd.port, sessionToken: 'tok' }),
  }));
  t.after(() => { statusd.server.close(); consoleServer.server.close(); });

  const got = await new Promise((resolve, reject) => {
    const client = net.connect(consoleServer.port, '127.0.0.1', () => {
      client.write(['GET /_next/webpack-hmr HTTP/1.1', 'Host: 0a1b2c3d.woodshed.example', 'Origin: https://0a1b2c3d.woodshed.example',
        'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'));
    });
    let buf = '';
    client.on('data', (c) => {
      buf += c;
      if (buf.includes('\r\n\r\n') && !buf.includes('hello')) client.write('hello');
      if (buf.includes('hello')) client.end();
    });
    client.on('close', () => resolve(buf));
    client.on('error', reject);
  });
  assert.match(got, /^HTTP\/1\.1 101/);
  assert.match(got, /hello/);
  const upgrade = statusd.seen.find((s) => s.upgrade);
  assert.equal(upgrade.url, '/_next/webpack-hmr');
  assert.equal(upgrade.headers['x-woodshed-app'], 'Bearer tok');
});

test('Start app says why it could not start: not running, an image without it, or no answer', async (t) => {
  const failures = [
    Object.assign(new Error('the session is not running'), { notRunning: true }),
    new Error('statusd /app/start answered 404'),
    new Error('The operation was aborted due to timeout'),
  ];
  const session = { id: '0a1b2c3d', status: 'running' };
  const fleet = { sessions: () => [session], find: () => session, startApp: async () => { throw failures.shift(); } };
  const config = { host: '127.0.0.1', publicUrl: 'http://localhost', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const post = () => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/sessions/0a1b2c3d/app/start',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, error: JSON.parse(body).error }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(await post(), { status: 409, error: 'the session is not running' });
  assert.deepEqual(await post(), { status: 409, error: 'this session\'s image predates Start app: start a new session to get it' });
  assert.deepEqual(await post(), { status: 502, error: 'the session did not answer: try again in a moment' });
});

test('until sign-in is required, an app opens with no cookie, as before', async (t) => {
  const statusd = await fakeStatusd();
  const session = { id: '0a1b2c3d', status: 'running', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: statusd.port } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example' };
  const auth = { enabled: () => false, available: () => true, appCookie: '__Host-woodshed_app' };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { statusd.server.close(); server.close(); });
  assert.equal((await get(port, '/', { host: '0a1b2c3d.woodshed.example' })).status, 200);
});

test('withoutCookie drops one cookie and keeps the rest', () => {
  assert.equal(withoutCookie('a=1; __Host-woodshed_app=x; b=2', '__Host-woodshed_app'), 'a=1; b=2');
  assert.equal(withoutCookie('__Host-woodshed_app=x', '__Host-woodshed_app'), undefined);
  assert.equal(withoutCookie('a=1', undefined), 'a=1');
  assert.equal(withoutCookie(undefined, '__Host-woodshed_app'), undefined);
});

// The console with real sign-in, already required, and a browser signed in to it.
async function signedInConsole(statusPort) {
  const session = { id: '0a1b2c3d', status: 'running', token: 'tok', terminalToken: 'term', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null), stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example',
  };
  const clock = { now: 1_000_000 };
  async function fetchImpl(url) {
    if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_user' }));
    return new Response(JSON.stringify({ login: 'octo' }));
  }
  const auth = createAuth({
    publicUrl: config.publicUrl, store: { state: {}, save() {} }, clientId: async () => 'Iv1.app', clientSecret: () => 'cs',
    canWrite: async () => true, fetchImpl, now: () => clock.now,
  });
  const started = await auth.start('/');
  const done = await auth.callback({ code: 'c', state: new URL(started.location).searchParams.get('state'), cookieHeader: started.setCookie.split(';')[0] });
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const appUpgrade = createAppUpgrade({ config, fleet, auth });
  server.on('upgrade', (req, socket, head) => appUpgrade(req, socket, head, appIdFor(req.headers.host, config.appDomain)));
  return { server, port: await listen(server), clock, consoleCookie: done.setCookies[0].split(';')[0] };
}

function send(port, { method = 'GET', path, headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, setCookie: res.headers['set-cookie']?.[0] }));
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(port, cookie) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(['GET /_next/webpack-hmr HTTP/1.1', 'Host: 0a1b2c3d.woodshed.example', 'Upgrade: websocket', 'Connection: Upgrade',
        ...(cookie ? [`Cookie: ${cookie}`] : []), '', ''].join('\r\n'));
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

test('with sign-in required, an app sends the browser through the console for a cookie of its own, which never reaches the app', async (t) => {
  const statusd = await fakeStatusd();
  const c = await signedInConsole(statusd.port);
  t.after(() => { statusd.server.close(); c.server.close(); });
  const app = (headers = {}) => ({ host: '0a1b2c3d.woodshed.example', accept: 'text/html', ...headers });
  const onConsole = (headers = {}) => ({ host: 'console.example', accept: 'text/html', ...headers });

  const first = await send(c.port, { path: '/workflows?x=1', headers: app() });
  assert.deepEqual(first, { status: 302, location: 'https://console.example/auth/app?id=0a1b2c3d&next=%2Fworkflows%3Fx%3D1', setCookie: undefined });
  assert.equal((await send(c.port, { method: 'POST', path: '/api/x', headers: app() })).status, 401, 'only a navigation is sent to sign in');
  assert.equal(await upgrade(c.port), 'HTTP/1.1 401 Unauthorized', 'a websocket without the cookie');
  assert.equal(statusd.seen.length, 0, 'nothing reached the session yet');

  const askPath = new URL(first.location).pathname + new URL(first.location).search;
  const signedOut = await send(c.port, { path: askPath, headers: onConsole() });
  assert.deepEqual(signedOut.location, `/login?next=${encodeURIComponent(askPath)}`, 'not signed in to the console: sign in there first');
  const handed = await send(c.port, { path: askPath, headers: onConsole({ cookie: c.consoleCookie }) });
  const claim = new URL(handed.location);
  assert.equal(claim.origin, 'https://0a1b2c3d.woodshed.example');
  assert.equal(claim.pathname, '/__woodshed/auth');
  assert.equal(claim.searchParams.get('next'), '/workflows?x=1');

  const claimed = await send(c.port, { path: claim.pathname + claim.search, headers: app() });
  assert.equal(claimed.status, 302);
  assert.equal(claimed.location, '/workflows?x=1');
  assert.match(claimed.setCookie, /^__Host-woodshed_app=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/);
  assert.equal((await send(c.port, { path: claim.pathname + claim.search, headers: app() })).status, 403, 'a code works once');

  const appCookie = claimed.setCookie.split(';')[0];
  assert.equal((await send(c.port, { path: '/workflows', headers: app({ cookie: `theme=dark; ${appCookie}; app=1` }) })).status, 200);
  assert.equal(statusd.seen.at(-1).headers.cookie, 'theme=dark; app=1', 'the app gets its own cookies, never the sign-in one');
  assert.equal(await upgrade(c.port, appCookie), 'HTTP/1.1 101 Switching Protocols');
  assert.equal(statusd.seen.find((s) => s.upgrade).headers.cookie, undefined);

  const elsewhere = await send(c.port, { path: '/', headers: { host: 'ffffffff.woodshed.example', cookie: appCookie } });
  assert.equal(elsewhere.status, 302, 'one app\'s cookie does not open another');
  assert.match(elsewhere.location, /^https:\/\/console\.example\/auth\/app\?id=ffffffff/);
  assert.equal((await send(c.port, { path: '/auth/app?id=ffffffff&next=/', headers: onConsole({ cookie: c.consoleCookie }) })).status, 404, 'no code for an unknown session');

  const open = new URL((await send(c.port, { path: '/auth/app?id=0a1b2c3d&next=//evil.example/x', headers: onConsole({ cookie: c.consoleCookie }) })).location);
  assert.equal(open.searchParams.get('next'), '/', 'next stays a path on the app');
  const crafted = new URL((await send(c.port, { path: askPath, headers: onConsole({ cookie: c.consoleCookie }) })).location);
  crafted.searchParams.set('next', '/\\evil.example');
  assert.equal((await send(c.port, { path: crafted.pathname + crafted.search, headers: app() })).location, '/', 'a next edited on the way stays on the app too');

  const late = new URL((await send(c.port, { path: askPath, headers: onConsole({ cookie: c.consoleCookie }) })).location);
  c.clock.now += 61_000;
  assert.equal((await send(c.port, { path: late.pathname + late.search, headers: app() })).status, 403, 'a code lives a minute');
});

test('Stop app goes to the fleet behind the same checks as Start app, and says why it could not stop', async (t) => {
  const session = { id: '0a1b2c3d', status: 'running', app: 'running' };
  const failures = [null, Object.assign(new Error('the session is not running'), { notRunning: true }), new Error('statusd /app/stop answered 404')];
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    startApp: async () => { throw new Error('not this one'); },
    stopApp: async (s) => {
      const failure = failures.shift();
      if (failure) throw failure;
      s.app = 'stopping';
      return s;
    },
  };
  const config = { host: '127.0.0.1', publicUrl: 'http://localhost', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const post = (id, headers = { 'x-woodshed': '1' }) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/sessions/${id}/app/stop`,
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await post('0a1b2c3d', {})).status, 403, 'a write without the x-woodshed header');
  assert.equal((await post('ffffffff')).status, 404);
  const stopped = await post('0a1b2c3d');
  assert.deepEqual([stopped.status, stopped.body.app], [200, 'stopping']);
  assert.deepEqual(await post('0a1b2c3d'), { status: 409, body: { error: 'the session is not running' } });
  assert.deepEqual(await post('0a1b2c3d'), { status: 409, body: { error: 'this session\'s image predates Stop app: start a new session to get it' } });
});
