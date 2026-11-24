import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';

import { createCliSignIn } from './cliSignIn.mjs';
import { createExecPipe } from './execPipe.mjs';
import { attach, openTerminal } from '../cli/terminal.mjs';
import { OP, acceptFor, createFrameReader, encodeFrame } from '../shared/wsFrames.mjs';

const TERMINAL_TOKEN = 't'.repeat(40);
const CREDENTIAL = Buffer.from(`woodshed:${TERMINAL_TOKEN}`).toString('base64');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const until = async (check, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// A session's ttyd as 1.7.7 answers: Basic auth on the upgrade, then its credential again in the first message, which
// carries the size. It echoes what is typed, says each resize, and ends (1000) when `exit` is typed.
async function standInTtyd(t) {
  const seen = { requests: [], first: null, input: '', resizes: [], pauses: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let first = null;
    seen.requests.push({ url: req.url, authorization: req.headers.authorization, protocol: req.headers['sec-websocket-protocol'], extensions: req.headers['sec-websocket-extensions'] ?? null });
    if (req.headers.authorization !== `Basic ${CREDENTIAL}`) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket', 'connection: Upgrade',
      `sec-websocket-accept: ${acceptFor(req.headers['sec-websocket-key'])}`, 'sec-websocket-protocol: tty', '', ''].join('\r\n'));
    const out = (text) => socket.write(encodeFrame(OP.binary, Buffer.from(`0${text}`), { mask: false }));
    const read = createFrameReader(({ opcode, payload }) => {
      if (opcode === OP.close) return socket.end(encodeFrame(OP.close, payload.subarray(0, 2), { mask: false }));
      if (opcode === OP.ping) return socket.write(encodeFrame(OP.pong, payload, { mask: false }));
      if (!first) {
        first = JSON.parse(payload.toString());
        seen.first = first;
        if (first.AuthToken !== CREDENTIAL) return socket.end(encodeFrame(OP.close, Buffer.from([0x03, 0xf0]), { mask: false }));
        return out(`size ${first.columns}x${first.rows}\r\n`);
      }
      const [kind, rest] = [String.fromCharCode(payload[0]), payload.subarray(1).toString()];
      if (kind === '0') {
        seen.input += rest;
        out(rest);
        if (seen.input.includes('exit\r')) socket.end(encodeFrame(OP.close, Buffer.from([0x03, 0xe8]), { mask: false }));
      } else if (kind === '1') {
        seen.resizes.push(JSON.parse(rest));
        out(`resized ${JSON.parse(rest).columns}x${JSON.parse(rest).rows}\r\n`);
      } else seen.pauses.push(kind);
      return undefined;
    });
    socket.on('data', (chunk) => read(chunk));
    socket.on('error', () => {});
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port, seen };
}

async function consoleFor(t, { termPort, shellPort = termPort }) {
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now: Date.now });
  const endpoint = { host: '127.0.0.1', statusPort: 1, termPort, shellPort };
  const base = { kind: 'task', status: 'running', endpoint, token: 's'.repeat(40), terminalToken: TERMINAL_TOKEN };
  const sessions = new Map([
    ['aaaa1111', { ...base, id: 'aaaa1111', owner: 'mia-dev' }],
    ['bbbb2222', { ...base, id: 'bbbb2222', owner: 'octocat' }],
    ['eeee5555', { ...base, id: 'eeee5555', owner: 'mia-dev', taintedAt: '2026-11-20T09:00:00Z' }],
    ['ffff6666', { ...base, id: 'ffff6666', owner: 'mia-dev', endpoint: { host: '127.0.0.1', statusPort: 1, termPort } }],
  ]);
  const locking = [];
  const fleet = { find: (id) => sessions.get(id) ?? null, isLocked: (s) => Boolean(s.taintedAt), onLocking: (fn) => locking.push(fn) };
  const pipe = createExecPipe({ fleet, cli });
  const sockets = new Set();
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (!pipe.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const signIn = (login) => {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode);
  };
  return { origin: `http://localhost:${port}`, cli, pipe, sessions, signIn, lockDown: (id) => locking.forEach((fn) => fn(id)) };
}

// This command line's side: a terminal 100x30 that can be typed into and resized.
function terminalStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.rows = 30;
  let drawn = '';
  stdout.on('data', (chunk) => { drawn += chunk; });
  return { stdin, stdout, drawn: () => drawn };
}

test('the session\'s terminal comes to this one: its size, what is typed, a resize, and its end', async (t) => {
  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: ttyd.port });
  const { token } = c.signIn('mia-dev');
  const opened = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind: 'term', size: { columns: 100, rows: 30 } });
  assert.ok(opened.socket, JSON.stringify(opened));
  const io = terminalStreams();
  const ended = attach({ socket: opened.socket, head: opened.head, stdin: io.stdin, stdout: io.stdout });
  await until(() => io.drawn().includes('size 100x30'));
  io.stdin.write('ls\r');
  await until(() => io.drawn().includes('ls\r'));
  io.stdout.columns = 120;
  io.stdout.rows = 40;
  io.stdout.emit('resize');
  await until(() => io.drawn().includes('resized 120x40'));
  io.stdin.write('exit\r');
  assert.deepEqual(await ended, { status: 'closed', code: 1000 }, 'its program ended');
  assert.deepEqual(ttyd.seen.requests, [{ url: '/term/aaaa1111/ws', authorization: `Basic ${CREDENTIAL}`, protocol: 'tty', extensions: null }],
    'ttyd gets its credential from the console, never the person\'s token, and no compression is asked for');
  assert.equal(ttyd.seen.first.AuthToken, CREDENTIAL, 'the first message, ttyd\'s credential, is the console\'s');
  await until(() => c.pipe.count() === 0);
});

test('Ctrl-\\ disconnects, sending what was typed before it, and --shell reaches the shell\'s ttyd', async (t) => {
  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: 1, shellPort: ttyd.port });
  const { token } = c.signIn('mia-dev');
  const opened = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind: 'shell', size: { columns: 80, rows: 24 } });
  const io = terminalStreams();
  const ended = attach({ socket: opened.socket, stdin: io.stdin, stdout: io.stdout });
  await until(() => io.drawn().includes('size 80x24'));
  io.stdin.write(Buffer.from('pwd\x1cnot sent'));
  assert.deepEqual(await ended, { status: 'detached' });
  await until(() => ttyd.seen.input === 'pwd');
  assert.equal(ttyd.seen.requests[0].url, '/shell/aaaa1111/ws');
});

test('a terminal is refused for no token, another person\'s session, a tainted one, and one with no such terminal', async (t) => {
  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: ttyd.port });
  const { token } = c.signIn('mia-dev');
  const open = (session, kind = 'term', as = token) => openTerminal({ origin: c.origin, token: as, session, kind, size: { columns: 80, rows: 24 } });
  assert.equal((await open('aaaa1111', 'term', `wsc_${'0'.repeat(64)}`)).refused.status, 401);
  assert.equal((await open('bbbb2222')).refused.status, 404);
  const tainted = await open('eeee5555');
  assert.equal(tainted.refused.status, 409);
  assert.match(tainted.refused.message, /production data/);
  assert.equal((await open('ffff6666', 'shell')).refused.status, 404, 'an image from before the Terminal tab');
  c.sessions.get('aaaa1111').terminalToken = 'w'.repeat(40);
  const wrong = await open('aaaa1111');
  assert.equal(wrong.refused.status, 502, 'ttyd refusing the console\'s credential is not the person\'s sign-in ending');
  assert.match(wrong.refused.message, /the session's terminal did not open \(it answered 401\)/);
  assert.equal(ttyd.seen.requests.length, 1, 'the refusals before it never reached ttyd: only the one it refused did');
});

test('revoking the sign-in, or the session\'s lockdown, cuts an open terminal', async (t) => {
  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: ttyd.port });
  for (const end of [(signed) => c.cli.revoke('mia-dev', signed.id), () => c.lockDown('aaaa1111')]) {
    const signed = c.signIn('mia-dev');
    const opened = await openTerminal({ origin: c.origin, token: signed.token, session: 'aaaa1111', kind: 'term', size: { columns: 80, rows: 24 } });
    const io = terminalStreams();
    const ended = attach({ socket: opened.socket, stdin: io.stdin, stdout: io.stdout });
    await until(() => io.drawn().includes('size'));
    end(signed);
    assert.equal((await ended).status, 'cut');
  }
});

test('a connection that answers no ping is cut, and a slow terminal pauses the session\'s output until it drains', async (t) => {
  // A server that opens the websocket and then says nothing, not even to a ping.
  const silent = net.createServer((socket) => socket.on('data', () => {}));
  const port = await listen(silent);
  t.after(() => silent.close());
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((r) => socket.on('connect', r));
  const io = terminalStreams();
  assert.equal((await attach({ socket, stdin: io.stdin, stdout: io.stdout, pingMs: 50 })).status, 'cut');

  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: ttyd.port });
  const { token } = c.signIn('mia-dev');
  const opened = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind: 'term', size: { columns: 80, rows: 24 } });
  const stdin = new PassThrough();
  const stdout = new PassThrough({ highWaterMark: 4 });
  const ended = attach({ socket: opened.socket, stdin, stdout });
  await until(() => ttyd.seen.pauses.includes('2'));
  stdout.resume();
  await until(() => ttyd.seen.pauses.includes('3'));
  stdin.write('\x1c');
  assert.equal((await ended).status, 'detached');
});

function onPath(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('the real ttyd, as a session runs it, takes the console\'s first message and the size and keys from this terminal', { skip: !onPath('ttyd') && 'no ttyd here' }, async (t) => {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const ttyd = spawn('ttyd', ['--writable', '--interface', '127.0.0.1', '--port', String(port), '--base-path', '/term/aaaa1111',
    '--credential', `woodshed:${TERMINAL_TOKEN}`, 'sh', '-c', 'stty size; read line; echo "got:$line"; stty size'], { stdio: 'ignore' });
  t.after(() => ttyd.kill());
  let listening = false;
  await until(() => {
    const probe = net.connect(port, '127.0.0.1', () => {
      listening = true;
      probe.destroy();
    });
    probe.on('error', () => {});
    return listening;
  });
  const c = await consoleFor(t, { termPort: port });
  const { token } = c.signIn('mia-dev');
  const opened = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind: 'term', size: { columns: 100, rows: 30 } });
  assert.ok(opened.socket, JSON.stringify(opened));
  const io = terminalStreams();
  const ended = attach({ socket: opened.socket, stdin: io.stdin, stdout: io.stdout });
  await until(() => io.drawn().includes('30 100'));
  io.stdout.columns = 120;
  io.stdout.rows = 40;
  io.stdout.emit('resize');
  await new Promise((r) => setTimeout(r, 200));
  io.stdin.write('hello\r');
  assert.deepEqual(await ended, { status: 'closed', code: 1000 });
  assert.match(io.drawn(), /got:hello\r\n40 120/);
});

// woodshed session connect --agent: the TUI's terminal of an agent started beside the session's own, which its ttyd
// attaches to by the URL argument it is handed (session/bin/woodshed-attach).
test('a terminal on an agent beside the session\'s own reaches its ttyd with the agent named, and nothing else does', async (t) => {
  const ttyd = await standInTtyd(t);
  const c = await consoleFor(t, { termPort: ttyd.port });
  const { token } = c.signIn('mia-dev');
  const opened = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind: 'term', size: { columns: 100, rows: 30 }, agent: 'agent-2' });
  assert.ok(opened.socket, JSON.stringify(opened));
  opened.socket.destroy();
  await until(() => ttyd.seen.requests.length === 1);
  assert.equal(ttyd.seen.requests[0].url, '/term/aaaa1111/ws?arg=agent-2');
  for (const [kind, agent] of [['term', 'agent-1'], ['term', 'claude'], ['term', 'agent-2&arg=x'], ['shell', 'agent-2']]) {
    const refused = await openTerminal({ origin: c.origin, token, session: 'aaaa1111', kind, size: { columns: 100, rows: 30 }, agent });
    assert.equal(refused.refused?.status, 400, `${kind} ${agent}`);
  }
  assert.equal(ttyd.seen.requests.length, 1, 'nothing refused reached the session');
});
