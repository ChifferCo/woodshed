import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';

import { createAppPorts, parseAppPorts, requireAppPortsSafe } from './appPorts.mjs';
import { createConsoleUpgrade, createHandler } from './server.mjs';

test('WOODSHED_APP_PORTS reads ranges and single ports, each once, and refuses anything else', () => {
  assert.deepEqual(parseAppPorts(''), []);
  assert.deepEqual(parseAppPorts(undefined), []);
  assert.deepEqual(parseAppPorts('7701-7703'), [7701, 7702, 7703]);
  assert.deepEqual(parseAppPorts('7705, 7701-7702,7701'), [7701, 7702, 7705]);
  for (const bad of ['77a1', '80', '7703-7701', '7701-70000', '7000-7200']) assert.throws(() => parseAppPorts(bad), /WOODSHED_APP_PORTS/, bad);
});

test('app ports are only for one person\'s console, never beside an app domain or on a port the console uses', () => {
  const base = { appPorts: [7701, 7702], appDomain: '', port: 7690, host: '127.0.0.1', tlsAskPort: null, sessionApi: { port: 7691 } };
  requireAppPortsSafe(base);
  requireAppPortsSafe({ ...base, appPorts: [], requireSignIn: true });
  assert.throws(() => requireAppPortsSafe({ ...base, appDomain: 'apps.example' }), /set one/);
  assert.throws(() => requireAppPortsSafe({ ...base, requireSignIn: true }), /one person's console/);
  assert.throws(() => requireAppPortsSafe({ ...base, trustedIdentitySecret: 's' }), /one person's console/);
  assert.throws(() => requireAppPortsSafe({ ...base, host: '0.0.0.0' }), /one person's console/);
  assert.throws(() => requireAppPortsSafe({ ...base, appPorts: [7691] }), /already listens on/);
});

function store() {
  return { state: {}, saves: 0, save() { this.saves += 1; } };
}

test('a session keeps its port while active, and a stopped one\'s port goes to the next', () => {
  const active = new Set(['aaaa1111', 'bbbb2222']);
  const s = store();
  const ports = createAppPorts({ store: s, config: { appPorts: [7701, 7702], publicUrl: 'https://mac.tail1.ts.net' }, isActive: (id) => active.has(id) });
  assert.equal(ports.portFor('aaaa1111'), 7701);
  assert.equal(ports.portFor('bbbb2222'), 7702);
  assert.equal(ports.portFor('aaaa1111'), 7701, 'kept');
  assert.equal(ports.urlFor('bbbb2222', '/x?y=1'), 'https://mac.tail1.ts.net:7702/x?y=1');
  active.add('cccc3333');
  assert.equal(ports.portFor('cccc3333'), null, 'all lent');
  active.delete('aaaa1111');
  assert.equal(ports.idFor(7701), null, 'a stopped session\'s app is not answered');
  assert.equal(ports.portFor('cccc3333'), 7701);
  assert.equal(ports.idFor(7701), 'cccc3333');
  assert.deepEqual(s.state.appPorts, { 7701: 'cccc3333', 7702: 'bbbb2222' }, 'kept in the state, so a restart keeps them');
  assert.equal(ports.owns(7702), true);
  assert.equal(ports.owns(7690), false);
  const local = createAppPorts({ store: store(), config: { appPorts: [7701], publicUrl: 'http://localhost:7690' }, isActive: () => true });
  assert.equal(local.urlFor('aaaa1111'), 'http://localhost:7701/');
});

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The console on its own port and two app ports, as startConsole listens; one session runs with a statusd behind it.
async function consoleWithAppPorts(t) {
  const statusd = http.createServer((req, res) => {
    if (req.headers['x-woodshed-app'] !== 'Bearer tok') {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`the app at ${req.url}`);
  });
  statusd.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  const statusPort = await listen(statusd);
  const session = { id: '0a1b2c3d', status: 'running', kind: 'pr', app: 'running', token: 'tok', terminalToken: 'term', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null), stop: async () => {}, slackWaiting: () => new Set() };
  const appPortList = [await freePort(), await freePort()];
  const config = {
    host: '127.0.0.1', port: 0, publicUrl: 'https://mac.tail1.ts.net', extraHosts: [], repo: 'o/r', label: 'woodshed',
    projects: [{ name: 'r', repo: 'o/r', default: true }],
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1, askIdleMs: 1 }, appDomain: '', appPorts: appPortList,
  };
  const appPorts = createAppPorts({ store: store(), config, isActive: (id) => fleet.find(id)?.status === 'running' });
  const handle = createHandler({ config, fleet, appPorts });
  const upgrade = createConsoleUpgrade({ config, fleet, appPorts });
  const servers = [statusd];
  const serve = async (port) => {
    const server = http.createServer((req, res) => { handle(req, res); });
    server.on('upgrade', upgrade);
    servers.push(server);
    return listen(server, port);
  };
  const consolePort = await serve(0);
  for (const p of appPortList) await serve(p);
  t.after(() => servers.forEach((s) => s.close()));
  return { consolePort, appPortList, session };
}

test('a running session gets an app URL on a port of the console\'s name, and that port answers its app alone', async (t) => {
  const { consolePort, appPortList } = await consoleWithAppPorts(t);
  const list = await request(consolePort, '/api/sessions', { headers: { host: 'mac.tail1.ts.net' } });
  assert.equal(list.status, 200);
  const body = JSON.parse(list.body);
  assert.equal(body.appDomain, 'mac.tail1.ts.net', 'apps are on, on the console\'s own name');
  assert.equal(body.appPorts, true);
  assert.equal(body.sessions[0].appUrl, `https://mac.tail1.ts.net:${appPortList[0]}/`);

  const app = await request(appPortList[0], '/page?x=1', { headers: { host: `mac.tail1.ts.net:${appPortList[0]}` } });
  assert.deepEqual([app.status, app.body], [200, 'the app at /page?x=1']);
  const consoleOnAppPort = await request(appPortList[0], '/api/sessions', { headers: { host: `mac.tail1.ts.net:${appPortList[0]}` } });
  assert.equal(consoleOnAppPort.body, 'the app at /api/sessions', 'the console\'s own API is never served on an app port');
  const unlent = await request(appPortList[1], '/', { headers: { host: `mac.tail1.ts.net:${appPortList[1]}` } });
  assert.equal(unlent.status, 404, 'a port lent to nobody answers nothing');
});

test('the console refuses a write from an app port\'s page: the port is part of its origin', async (t) => {
  const { consolePort, appPortList } = await consoleWithAppPorts(t);
  const res = await request(consolePort, '/api/sessions/0a1b2c3d/stop', {
    method: 'POST', headers: { host: 'mac.tail1.ts.net', origin: `https://mac.tail1.ts.net:${appPortList[0]}`, 'x-woodshed': '1' },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /cross-origin/);
});

test('an app port\'s websocket reaches its app, and a port lent to nobody refuses one', async (t) => {
  const { consolePort, appPortList } = await consoleWithAppPorts(t);
  await request(consolePort, '/api/sessions', { headers: { host: 'mac.tail1.ts.net' } });
  const upgrade = (port) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/_hmr', headers: { host: `mac.tail1.ts.net:${port}`, connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await upgrade(appPortList[0]), 101);
  assert.equal(await upgrade(appPortList[1]), 404);
});

test('a running session whose app is not up gets no port: the page opens it through /auth/app, which lends one', async (t) => {
  const { consolePort, appPortList, session } = await consoleWithAppPorts(t);
  session.app = 'none';
  const list = JSON.parse((await request(consolePort, '/api/sessions', { headers: { host: 'mac.tail1.ts.net' } })).body);
  assert.equal(list.sessions[0].appUrl, null);
  const open = await request(consolePort, '/auth/app?id=0a1b2c3d&next=/__woodshed/code/', { headers: { host: 'mac.tail1.ts.net' } });
  assert.equal(open.status, 302);
  assert.equal(open.headers.location, `https://mac.tail1.ts.net:${appPortList[0]}/__woodshed/code/`);
});

test('an app port refuses a name that is not the console\'s, for requests and websockets: a rebinding page cannot reach the app', async (t) => {
  const { consolePort, appPortList } = await consoleWithAppPorts(t);
  await request(consolePort, '/api/sessions', { headers: { host: 'mac.tail1.ts.net' } });
  const rebound = await request(appPortList[0], '/', { headers: { host: `evil.example:${appPortList[0]}` } });
  assert.equal(rebound.status, 421);
  const socketStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: appPortList[0], path: '/__woodshed/code/', headers: { host: 'evil.example', connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(socketStatus, 421);
  const own = await request(appPortList[0], '/', { headers: { host: `mac.tail1.ts.net:${appPortList[0]}` } });
  assert.equal(own.status, 200, 'its own name still opens the app');
});
