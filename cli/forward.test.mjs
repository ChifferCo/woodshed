import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createExecPipe } from '../console/execPipe.mjs';
import { createHandler } from '../console/server.mjs';
import { handleExecUpgrade } from '../session/execPipe.mjs';
import { handlePortUpgrade } from '../session/portPipe.mjs';
import { createCredentials } from './credentials.mjs';
import { MARK, parseSpec, runForward } from './forward.mjs';
import { openUpgrade } from './tunnel.mjs';
import { main } from './woodshed.mjs';

const SESSION_TOKEN = 's'.repeat(40);

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

const until = async (check, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// One GET on a connection of its own, so a cut never leaves a kept-alive one behind.
function get(port, pathname = '/') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}

// /proc/net/tcp as the kernel writes it, with these ports listening on 127.0.0.1.
function procTcp(ports) {
  return ['  sl  local_address rem_address   st tx_queue', ...ports.map((port, i) => `   ${i}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000`)].join('\n');
}

// A session's statusd (the real /exec and /port), its app, a console in front, and @mia-dev signed in.
async function setup(t) {
  const app = http.createServer((req, res) => res.end(`app ${req.url}`));
  const appPort = await listen(app);
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-forward-'));
  const table = path.join(dir, 'tcp');
  const listening = (ports) => fs.writeFileSync(table, procTcp(ports));
  listening([appPort]);
  const statusd = http.createServer((req, res) => res.writeHead(404).end());
  statusd.on('upgrade', (req, socket, head) => {
    const isAuthorized = (h) => h === `Bearer ${SESSION_TOKEN}`;
    if (req.url === '/exec') return handleExecUpgrade(req, socket, head, { isAuthorized, cwd: dir });
    return handlePortUpgrade(req, socket, head, { isAuthorized, host: '127.0.0.1' });
  });
  const statusPort = await listen(statusd);
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  const sessions = new Map([
    ['aaaa1111', { id: 'aaaa1111', owner: 'mia-dev', status: 'running', kind: 'task', endpoint: { host: '127.0.0.1', statusPort }, token: SESSION_TOKEN }],
    ['bbbb2222', { id: 'bbbb2222', owner: 'octocat', status: 'running', kind: 'task', endpoint: { host: '127.0.0.1', statusPort }, token: SESSION_TOKEN }],
  ]);
  const execPipe = createExecPipe({ fleet: { find: (id) => sessions.get(id) ?? null }, cli });
  const consoleServer = http.createServer((req, res) => res.writeHead(404).end());
  // Every stream the console holds, for a test to cut them all as a console restart does.
  const held = new Set();
  consoleServer.on('upgrade', (req, socket, head) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
    if (!execPipe.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const cut = () => { for (const socket of held) socket.destroy(); };
  const origin = `http://localhost:${await listen(consoleServer)}`;
  const { deviceCode, userCode } = cli.start({ name: 'mia-laptop' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const signedIn = cli.poll(deviceCode);
  t.after(() => {
    for (const server of [app, echo, statusd, consoleServer]) {
      server.closeAllConnections?.();
      server.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lines = { once: `cat ${table}`, watch: `while :; do echo '${MARK}'; cat ${table}; echo; sleep 0.1; done` };
  // runForward as the command runs it, with what it says kept.
  function forward({ specs = [], auto = false, token = signedIn.token, session = 'aaaa1111' } = {}) {
    const said = [];
    const warned = [];
    const events = [];
    const stop = new AbortController();
    const done = runForward({
      origin, token, session, specs, auto, signal: stop.signal, lines, retryMs: [50],
      say: (text) => said.push(text), warn: (text) => warned.push(text), emit: (object) => events.push(object),
    });
    t.after(() => stop.abort());
    return { said, warned, events, done, stop: () => { stop.abort(); return done; } };
  }
  return { origin, cli, signedIn, appPort, echoPort, listening, cut, forward };
}

test('a port and an optional local port, each 1 to 65535', () => {
  assert.deepEqual(parseSpec('5173'), { port: 5173, local: 5173 });
  assert.deepEqual(parseSpec('5173:3000'), { port: 5173, local: 3000 });
  for (const bad of ['', 'x', '0', '70000', '5173:', ':3000', '5173:0']) assert.equal(parseSpec(bad), null, bad);
});

test('a session\'s port comes to localhost, moved to the next free one when taken here, and says so', async (t) => {
  const s = await setup(t);
  // The app listens on its port on this same machine, so here that port is taken.
  const run = s.forward({ specs: [{ port: s.appPort, local: s.appPort }] });
  await until(() => run.events.some((e) => e.event === 'forwarding'));
  const [forwarding] = run.events;
  assert.equal(forwarding.moved, true);
  assert.ok(forwarding.local > s.appPort);
  assert.ok(run.said.includes(`localhost:${s.appPort} is taken here, so session aaaa1111's port ${s.appPort} is on http://localhost:${forwarding.local}`));
  assert.equal(await get(forwarding.local, '/hello'), 'app /hello');

  // A console restart cuts the connections open then; the next one opens again.
  s.cut();
  assert.equal(await get(forwarding.local, '/again'), 'app /again');

  assert.equal(await run.stop(), null);
  await assert.rejects(get(forwarding.local), /ECONNREFUSED/, 'Ctrl-C closes it');
});

test('a local port named is used when free, and nothing listening in the session is said, not hidden', async (t) => {
  const s = await setup(t);
  const local = await freePort();
  const run = s.forward({ specs: [{ port: s.appPort, local }] });
  await until(() => run.events.some((e) => e.event === 'forwarding'));
  assert.equal(run.events[0].local, local);
  assert.equal(run.events[0].moved, false);
  assert.equal(await get(local, '/'), 'app /');
  await run.stop();

  // Here the session and this computer are one machine: the local port differs, or the forward would reach itself.
  const idle = await freePort();
  const idleHere = await freePort();
  const quiet = s.forward({ specs: [{ port: idle, local: idleHere }] });
  await until(() => quiet.events.some((e) => e.event === 'forwarding'));
  assert.ok(quiet.said.some((text) => text.includes(`listens on port ${idle} yet`)));
  await assert.rejects(get(idleHere, '/'));
  await until(() => quiet.warned.length > 0);
  assert.match(quiet.warned[0], new RegExp(`port ${idle}: refused \\(502\\): nothing answers on port ${idle}`));
  await quiet.stop();
});

test('--auto forwards each port as the session starts listening, closes it when it stops, and keeps them through a cut', async (t) => {
  const s = await setup(t);
  s.listening([]);
  const run = s.forward({ auto: true });
  await until(() => run.said.some((text) => text.startsWith('Following')));
  assert.equal(run.events.length, 0, 'nothing listens yet');
  s.listening([s.appPort]);
  await until(() => run.events.some((e) => e.event === 'forwarding'));
  const { local } = run.events.find((e) => e.event === 'forwarding');
  assert.equal(await get(local, '/auto'), 'app /auto');

  // The pipe that follows the ports is cut, as a console restart cuts it: the forward stays, and it follows again.
  s.cut();
  await until(() => run.said.includes('Following session aaaa1111\'s ports again.'));
  assert.equal(await get(local, '/still'), 'app /still');

  s.listening([]);
  await until(() => run.events.some((e) => e.event === 'closed'));
  assert.deepEqual(run.events.find((e) => e.event === 'closed'), { event: 'closed', session: 'aaaa1111', port: s.appPort, local, why: 'stopped listening' });
  await assert.rejects(get(local), /ECONNREFUSED/);
  await run.stop();
});

test('a session that is not the person\'s, a token that ended, or the session\'s own port forward nothing', async (t) => {
  const s = await setup(t);
  const other = await s.forward({ session: 'bbbb2222', specs: [{ port: s.appPort, local: s.appPort }] }).done;
  assert.equal(other.refused.status, 404);
  s.cli.revoke('mia-dev', s.signedIn.id);
  const ended = await s.forward({ specs: [{ port: s.appPort, local: s.appPort }] }).done;
  assert.equal(ended.refused.status, 401);
  assert.match(ended.refused.message, /woodshed login/);

  const t2 = await setup(t);
  const own = await t2.forward({ specs: [{ port: 7682, local: 7682 }] }).done;
  assert.equal(own.refused.status, 403, 'nothing it can forward: refused, so the command exits 3');
  assert.match(own.refused.message, /port 7682 is the session's own/);
  await assert.rejects(openUpgrade({ url: new URL('/api/tunnel/port/aaaa1111/7682', t2.origin), token: t2.signedIn.token }), (err) => err.status === 403);
});

test('revoking the token closes a live port stream', async (t) => {
  const s = await setup(t);
  const { socket, head } = await openUpgrade({ url: new URL(`/api/tunnel/port/aaaa1111/${s.echoPort}`, s.origin), token: s.signedIn.token });
  let got = head.toString();
  socket.on('data', (chunk) => { got += chunk; });
  socket.write('ping');
  await until(() => got === 'ping');
  const closed = new Promise((resolve) => socket.on('close', resolve));
  s.cli.revoke('mia-dev', s.signedIn.id);
  await closed;
});

// `woodshed open` and `forward` through main: the console's real handler answers /api/cli/me.
async function signedInCli(t, { appDomain }) {
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', consoleName: 'Acme Woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain,
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth: { enabled: () => false, available: () => false }, cli });
  const execPipe = createExecPipe({ fleet: { find: () => null }, cli });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('upgrade', (req, socket, head) => { if (!execPipe.handleUpgrade(req, socket, head)) socket.destroy(); });
  const origin = `http://localhost:${await listen(server)}`;
  config.publicUrl = origin;
  const { deviceCode, userCode } = cli.start({ name: 'mia-laptop' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const { token, id } = cli.poll(deviceCode);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const kept = credentials.save(origin, token);
  fs.writeFileSync(path.join(dir, 'woodshed', 'cli.json'), JSON.stringify({ current: origin, consoles: { [origin]: { login: 'mia-dev', store: kept.kind, tokenId: id } } }));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } },
      platform: 'test', credentials, signal: AbortSignal.abort(),
    });
    return { code, out, err };
  };
  return { run, cli, id };
}

test('woodshed open prints the session app\'s address, and says plainly when the console has none', async (t) => {
  const { run, cli, id } = await signedInCli(t, { appDomain: 'apps.example.com' });
  assert.deepEqual(await run(['open', 'aaaa1111']), { code: 0, out: 'https://aaaa1111.apps.example.com/\n', err: '' });
  assert.deepEqual(await run(['open', 'aaaa1111', '--json']), { code: 0, out: '{"session":"aaaa1111","url":"https://aaaa1111.apps.example.com/"}\n', err: '' });
  assert.equal((await run(['open', 'nope'])).code, 1);
  cli.revoke('mia-dev', id);
  assert.equal((await run(['open', 'aaaa1111'])).code, 2, 'a sign-in that ended waits on the person');

  const none = await signedInCli(t, { appDomain: '' });
  const ran = await none.run(['open', 'aaaa1111']);
  assert.equal(ran.code, 1);
  assert.match(ran.err, /serves no session app at a name of its own/);
});

test('woodshed forward\'s exit codes: a usage error 1, refused 3, a sign-in that ended 2', async (t) => {
  const { run, cli, id } = await signedInCli(t, { appDomain: '' });
  for (const args of [['forward'], ['forward', 'aaaa1111'], ['forward', 'aaaa1111', 'x'], ['forward', 'nope', '5173']]) {
    assert.equal((await run(args)).code, 1, args.join(' '));
  }
  const refused = await run(['forward', 'aaaa1111', '5173']);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /refused \(404\)/);
  cli.revoke('mia-dev', id);
  assert.equal((await run(['forward', '--auto', 'aaaa1111'])).code, 2);
});
