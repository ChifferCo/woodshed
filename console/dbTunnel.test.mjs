import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTunnel, parseTarget, tunnelTargetsFor } from './dbTunnel.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'woodshed-db.mjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function fakeDatabases(ready = ['mia-dev']) {
  return {
    available: true,
    view: (login) => ({ status: ready.includes(login.toLowerCase()) ? 'ready' : 'working' }),
    credentials: async (login) => (ready.includes(login) ? { user: `woodshed_${login.replace('-', '_')}`, password: 'p'.repeat(48), name: `woodshed_${login.replace('-', '_')}` } : null),
  };
}

// A database that answers each chunk with its name and the chunk, so a test can tell which one it reached.
async function echoServer(name) {
  const server = net.createServer((socket) => socket.on('data', (chunk) => socket.write(`${name}:${chunk}`)));
  return { server, port: await listen(server) };
}

async function consoleWith(t, { clock = { now: 0 }, ready, withMongo = true, allowed } = {}) {
  const pg = await echoServer('pg');
  const mongo = await echoServer('mongo');
  const store = { state: {}, save() {} };
  const tunnel = createTunnel({
    store, targets: { pg: `127.0.0.1:${pg.port}`, mongo: withMongo ? `127.0.0.1:${mongo.port}` : null }, databases: fakeDatabases(ready), now: () => clock.now, allowed,
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tunnel/connection') return tunnel.connection(req, res);
    res.writeHead(404);
    return res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listen(server);
  t.after(() => { server.close(); pg.server.close(); mongo.server.close(); });
  return { tunnel, store, port, clock };
}

// A raw upgrade request, then one message: what comes back, 101 and the database's answer, or a refusal.
function rawTunnel(port, { kind = 'pg', token, upgrade = 'woodshed-tunnel', message = 'hello' }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /api/tunnel/${kind} HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: ${upgrade}\r\n`
        + `${token ? `authorization: Bearer ${token}\r\n` : ''}\r\n${message}`);
    });
    let got = '';
    socket.on('data', (chunk) => {
      got += chunk;
      if (got.includes(`${kind}:${message}`)) socket.end();
    });
    socket.on('close', () => resolve(got));
    socket.on('error', reject);
  });
}

test('parseTarget reads host:port', () => {
  assert.deepEqual(parseTarget('db.abc.us-east-1.rds.amazonaws.com:5432'), { host: 'db.abc.us-east-1.rds.amazonaws.com', port: 5432 });
  assert.equal(parseTarget('nohost'), null);
  assert.equal(parseTarget(null), null);
});

test('a token is shown once, kept as a hash, lasts 12 hours, and a new one or Revoke ends it', async (t) => {
  const { tunnel, store, clock } = await consoleWith(t);
  assert.throws(() => tunnel.issue('octocat'), /not ready/, 'no token before the databases are made');
  const { token, expiresAt } = tunnel.issue('mia-dev');
  assert.match(token, /^wt_[0-9a-f]{64}$/);
  assert.equal(expiresAt, new Date(12 * 3_600_000).toISOString());
  assert.equal(JSON.stringify(store.state).includes(token), false, 'only its hash is kept');
  assert.deepEqual(tunnel.view('mia-dev'), { available: true, kinds: ['postgres', 'mongo'], expiresAt });
  clock.now = 12 * 3_600_000 + 1;
  assert.deepEqual(tunnel.view('mia-dev'), { available: true, kinds: ['postgres', 'mongo'], expiresAt: null });
  tunnel.revoke('mia-dev');
  assert.equal(store.state.tunnelTokens['mia-dev'], undefined);
});

test('connection details need a live token, and are only the token holder\'s', async (t) => {
  const { tunnel, port, clock } = await consoleWith(t);
  const ask = (token) => fetch(`http://127.0.0.1:${port}/api/tunnel/connection`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await ask(null)).status, 401);
  assert.equal((await ask(`wt_${'0'.repeat(64)}`)).status, 401);
  const { token } = tunnel.issue('mia-dev');
  const res = await ask(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { login: 'mia-dev', user: 'woodshed_mia_dev', password: 'p'.repeat(48), database: 'woodshed_mia_dev', kinds: ['postgres', 'mongo'] });
  const second = tunnel.issue('mia-dev').token;
  assert.equal((await ask(token)).status, 401, 'a new token ends the old one');
  clock.now = 13 * 3_600_000;
  assert.equal((await ask(second)).status, 401, 'expired');
});

test('a live token stops working once its person is taken off the People list', async (t) => {
  const people = new Set(['mia-dev']);
  const { tunnel, port } = await consoleWith(t, { allowed: (login) => people.has(login) });
  const ask = (token) => fetch(`http://127.0.0.1:${port}/api/tunnel/connection`, { headers: { authorization: `Bearer ${token}` } });
  const { token } = tunnel.issue('mia-dev');
  assert.equal((await ask(token)).status, 200);
  assert.match(await rawTunnel(port, { token }), /^HTTP\/1\.1 101/);
  people.delete('mia-dev');
  assert.equal((await ask(token)).status, 401, 'the connection details are refused');
  assert.match(await rawTunnel(port, { token }), /^HTTP\/1\.1 401/, 'and a new tunnel');
});

test('the tunnel pipes to the fixed database for its path, and refuses without a valid token or the protocol', async (t) => {
  const { tunnel, port } = await consoleWith(t);
  const { token } = tunnel.issue('mia-dev');
  const pg = await rawTunnel(port, { kind: 'pg', token });
  assert.match(pg, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(pg, /pg:hello$/, 'bytes sent with the request reach Postgres');
  assert.match(await rawTunnel(port, { kind: 'mongo', token }), /mongo:hello$/);
  assert.match(await rawTunnel(port, { kind: 'pg' }), /^HTTP\/1\.1 401 /);
  assert.match(await rawTunnel(port, { kind: 'pg', token: `wt_${'1'.repeat(64)}` }), /^HTTP\/1\.1 401 /);
  assert.match(await rawTunnel(port, { kind: 'pg', token, upgrade: 'websocket' }), /^HTTP\/1\.1 400 /);
  tunnel.revoke('mia-dev');
  assert.match(await rawTunnel(port, { kind: 'pg', token }), /^HTTP\/1\.1 401 /);
});

test('an installation with no Mongo has a Postgres tunnel, and refuses one to Mongo', async (t) => {
  const { tunnel, port } = await consoleWith(t, { withMongo: false });
  const { token } = tunnel.issue('mia-dev');
  assert.match(await rawTunnel(port, { kind: 'pg', token }), /pg:hello$/);
  assert.match(await rawTunnel(port, { kind: 'mongo', token }), /^HTTP\/1\.1 404 [^]*this installation runs no Mongo/);
});

test('a path new URL() cannot read is not the tunnel\'s, and does not throw', async (t) => {
  const { tunnel } = await consoleWith(t);
  assert.equal(tunnel.handleUpgrade({ url: '//a:99999', headers: {} }, null, null), false);
});

test('Revoke and a new token close the tunnels already open, whatever case GitHub spells the login in', async (t) => {
  const { tunnel, port } = await consoleWith(t);
  let token;
  const opened = () => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /api/tunnel/pg HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: woodshed-tunnel\r\n`
        + `authorization: Bearer ${token}\r\n\r\n`);
    });
    socket.once('data', (chunk) => (String(chunk).startsWith('HTTP/1.1 101') ? resolve(socket) : reject(new Error(String(chunk)))));
  });
  const closed = (socket) => new Promise((resolve) => socket.on('close', resolve));
  ({ token } = tunnel.issue('mia-dev'));
  const first = await opened();
  tunnel.revoke('mia-dev');
  await closed(first);
  ({ token } = tunnel.issue('mia-dev'));
  const second = await opened();
  tunnel.issue('Mia-Dev');
  await closed(second);
});

test('without a target or own databases there is no tunnel, and each target is a tunnel of its own', () => {
  const store = { state: {}, save() {} };
  const pgOnly = createTunnel({ store, targets: { pg: 'h:5432', mongo: null }, databases: fakeDatabases() });
  assert.deepEqual([pgOnly.available, pgOnly.kinds], [true, ['postgres']]);
  assert.equal(createTunnel({ store, targets: { pg: null, mongo: null }, databases: fakeDatabases() }).available, false);
  assert.equal(createTunnel({ store, targets: { pg: 'h:5432', mongo: 'h:27017' }, databases: { available: false } }).available, false);
});

test('a tunnel address for a database the installation does not run is dropped', () => {
  const targets = { pg: 'db:5432', mongo: 'box:27017' };
  assert.deepEqual(tunnelTargetsFor(targets, ['postgres', 'mongo']), targets);
  assert.deepEqual(tunnelTargetsFor(targets, ['postgres']), { pg: 'db:5432', mongo: null });
  assert.deepEqual(tunnelTargetsFor(targets, []), { pg: null, mongo: null });
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function sendThrough(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(message));
    socket.once('data', (chunk) => {
      resolve(String(chunk));
      socket.end();
    });
    socket.on('error', reject);
  });
}

test('woodshed-db.mjs prints the connection strings and carries a local connection to each database', async (t) => {
  const { tunnel, port } = await consoleWith(t);
  const { token } = tunnel.issue('mia-dev');
  const [pgPort, mongoPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}`, '--pg-port', String(pgPort), '--mongo-port', String(mongoPort)], {
    env: { ...process.env, WOODSHED_TOKEN: token },
  });
  t.after(() => child.kill());
  const printed = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('Ctrl-C')) resolve(out);
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  assert.match(printed, new RegExp(`postgres://woodshed_mia_dev:p{48}@localhost:${pgPort}/woodshed_mia_dev\\?sslmode=require`));
  assert.match(printed, new RegExp(`mongodb://woodshed_mia_dev:p{48}@localhost:${mongoPort}/woodshed_mia_dev\\?authSource=woodshed_mia_dev`));
  assert.equal(await sendThrough(pgPort, 'select 1'), 'pg:select 1');
  assert.equal(await sendThrough(mongoPort, 'ping'), 'mongo:ping');
});

test('woodshed-db.mjs stops with the console\'s reason when the token is wrong', async (t) => {
  const { port } = await consoleWith(t);
  const child = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}`], { env: { ...process.env, WOODSHED_TOKEN: `wt_${'2'.repeat(64)}` } });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(err, /the token is wrong or has expired/);
});
