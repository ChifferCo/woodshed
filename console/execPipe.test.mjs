import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { createCliSignIn } from './cliSignIn.mjs';
import { createExecPipe, ownerOnly } from './execPipe.mjs';
import { handleExecUpgrade } from '../session/execPipe.mjs';
import { runTunnel } from '../cli/tunnel.mjs';

const SESSION_TOKEN = 's'.repeat(40);

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

// A session's statusd, with the real /exec, running the real sh in a checkout of its own.
async function statusdFor(t, { tainted = () => false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-exec-'));
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => handleExecUpgrade(req, socket, head, {
    isAuthorized: (header) => header === `Bearer ${SESSION_TOKEN}`, cwd, tainted,
    env: { ...process.env, SESSION_TOKEN, TERMINAL_TOKEN: 't'.repeat(40), WOODSHED_SEEN: 'yes' },
  }));
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { port, cwd };
}

// The console: the command line's real sign-in, a fleet of made-up sessions on that statusd, and the exec pipe.
async function consoleFor(t, { statusd, people = null } = {}) {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const now = () => clock;
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now, allowed: (login) => !people || people.has(login) });
  const endpoint = { host: '127.0.0.1', statusPort: statusd.port };
  const sessions = new Map([
    ['aaaa1111', { id: 'aaaa1111', owner: 'Mia-Dev', status: 'running', kind: 'task', endpoint, token: SESSION_TOKEN }],
    ['bbbb2222', { id: 'bbbb2222', owner: 'octocat', status: 'running', kind: 'task', endpoint, token: SESSION_TOKEN }],
    ['cccc3333', { id: 'cccc3333', owner: null, status: 'running', kind: 'task', endpoint, token: SESSION_TOKEN }],
    ['dddd4444', { id: 'dddd4444', owner: 'mia-dev', status: 'paused', kind: 'task', endpoint: null, token: SESSION_TOKEN }],
    ['eeee5555', { id: 'eeee5555', owner: 'mia-dev', status: 'running', kind: 'task', endpoint, token: SESSION_TOKEN, taintedAt: '2026-11-20T09:00:00Z' }],
  ]);
  const locking = [];
  const fleet = { find: (id) => sessions.get(id) ?? null, isLocked: (s) => Boolean(s.taintedAt), onLocking: (fn) => locking.push(fn) };
  const execPipe = createExecPipe({ fleet, cli, now });
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!execPipe.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  function signIn(login) {
    const { deviceCode, userCode } = cli.start({ name: `${login}-laptop` });
    cli.decide({ code: userCode, login, approve: true });
    return cli.poll(deviceCode);
  }
  return {
    origin: `http://localhost:${port}`, cli, execPipe, sessions, signIn,
    lockDown: (id) => locking.forEach((fn) => fn(id)), tick: (ms) => { clock += ms; },
  };
}

// The command line's side, as `woodshed tunnel` runs it.
async function tunnel(origin, { token, session = 'aaaa1111', line, input = '', stdin = null, stdout = null }) {
  let out = '';
  let err = '';
  const given = stdin ?? new PassThrough();
  if (!stdin) given.end(input);
  const code = await runTunnel({
    origin, token, session, line, stdin: given,
    stdout: stdout ?? { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } },
  });
  return { code, out, err };
}

test('the line runs in the owner\'s session: stdout, stderr and the exit code come back apart, and stdin goes in', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  const ran = await tunnel(c.origin, { token, line: 'echo "in $(pwd)"; echo oops >&2; exit 7' });
  assert.deepEqual(ran, { code: 7, out: `in ${fs.realpathSync(statusd.cwd)}\n`, err: 'oops\n' });
  const counted = await tunnel(c.origin, { token, line: 'wc -c', input: 'x'.repeat(12345) });
  assert.equal(counted.out.trim(), '12345', 'stdin reaches it, and its end is the line\'s stdin\'s end');
  const killed = await tunnel(c.origin, { token, line: 'kill -TERM $$' });
  assert.equal(killed.code, 128 + 15, 'a signal is 128 + its number, as a shell says it');
  const usr1 = await tunnel(c.origin, { token, line: 'kill -USR1 $$' });
  assert.equal(usr1.code, 128 + os.constants.signals.SIGUSR1, 'any signal, by the system\'s own number');
});

test('a line of 8 KiB goes through the console and statusd, and a longer one is refused before it is sent', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  const line = `echo ok #${'x'.repeat(8192 - 'echo ok #'.length)}`;
  assert.deepEqual(await tunnel(c.origin, { token, line }), { code: 0, out: 'ok\n', err: '' });
  const long = await tunnel(c.origin, { token, line: `${line}x` });
  assert.equal(long.code, 255);
  assert.match(long.err, /longer than 8 KiB/);
});

test('a disconnect hangs up everything the line started, and a quiet one too, not only its shell', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token, id } = c.signIn('mia-dev');
  const marker = path.join(statusd.cwd, 'survived');
  const stdin = new PassThrough();
  let out = '';
  const running = tunnel(c.origin, { token, line: '(sleep 1; touch survived) & echo up; wait', stdin, stdout: { write: (s) => { out += s; return true; } } });
  await until(() => out.includes('up'));
  c.cli.revoke('mia-dev', id);
  assert.equal((await running).code, 255);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.existsSync(marker), false, 'the background job was hung up with its shell');
});

test('stdin from a fast writer waits for a slow program, and arrives whole', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  const size = 40 * 1024 * 1024;
  let given = 0;
  const chunk = Buffer.alloc(64 * 1024, 0x62);
  const stdin = new Readable({
    read() {
      if (given >= size) return this.push(null);
      given += chunk.length;
      this.push(chunk);
    },
  });
  let out = '';
  const running = tunnel(c.origin, { token, line: 'sleep 1.5; wc -c', stdin, stdout: { write: (s) => { out += s; return true; } } });
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(given < size / 2, `only what the buffers on the way hold was read while the program slept (${given} bytes)`);
  assert.equal((await running).code, 0);
  assert.equal(out.trim(), String(size));
});

test('the line gets statusd\'s environment without the session\'s own credentials', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  const ran = await tunnel(c.origin, { token, line: 'echo "seen=$WOODSHED_SEEN session=${SESSION_TOKEN:-none} terminal=${TERMINAL_TOKEN:-none}"' });
  assert.equal(ran.out, 'seen=yes session=none terminal=none\n');
});

test('only the session\'s owner opens a pipe, into a running session that is not tainted', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  for (const [session, status, words] of [
    ['ffff6666', 404, 'no session of yours'],
    ['bbbb2222', 404, 'no session of yours'],
    ['cccc3333', 404, 'no session of yours'],
    ['dddd4444', 409, 'resume it first'],
    ['eeee5555', 409, 'production data'],
  ]) {
    const ran = await tunnel(c.origin, { token, session, line: 'echo ran' });
    assert.equal(ran.code, 255, session);
    assert.equal(ran.out, '', `${session}: nothing ran`);
    assert.match(ran.err, new RegExp(`refused \\(${status}\\): .*${words}`), session);
  }
  assert.equal(c.execPipe.count(), 0);
  assert.equal(ownerOnly({ owner: 'Mia-Dev' }, 'mia-dev'), true, 'logins match whatever their case');
  assert.equal(ownerOnly({ owner: null }, null), false);
});

test('a wrong, revoked or expired token, or one whose person left, opens nothing', async (t) => {
  const statusd = await statusdFor(t);
  const people = new Set(['mia-dev', 'octocat']);
  const c = await consoleFor(t, { statusd, people });
  const wrong = await tunnel(c.origin, { token: `wsc_${'0'.repeat(64)}`, line: 'echo ran' });
  assert.equal(wrong.code, 255);
  assert.match(wrong.err, /refused \(401\).*woodshed login/);
  const revoked = c.signIn('mia-dev');
  c.cli.revoke('mia-dev', revoked.id);
  assert.match((await tunnel(c.origin, { token: revoked.token, line: 'echo ran' })).err, /refused \(401\)/);
  const expired = c.signIn('mia-dev');
  c.tick(91 * 24 * 3_600_000);
  assert.match((await tunnel(c.origin, { token: expired.token, line: 'echo ran' })).err, /refused \(401\)/);
  const left = c.signIn('octocat');
  people.delete('octocat');
  const ran = await tunnel(c.origin, { token: left.token, session: 'bbbb2222', line: 'echo ran' });
  assert.equal(ran.code, 255);
  assert.equal(ran.out, '');
});

test('statusd runs nothing for a caller without the session token, or in a tainted session', async (t) => {
  let tainted = false;
  const statusd = await statusdFor(t, { tainted: () => tainted });
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  // The console's own check passes; the session refuses on its own word.
  tainted = true;
  const ran = await tunnel(c.origin, { token, line: 'echo ran' });
  assert.equal(ran.code, 255);
  assert.match(ran.err, /refused \(409\): .*production data/);
  c.sessions.get('aaaa1111').token = 'not-the-session-token';
  tainted = false;
  assert.match((await tunnel(c.origin, { token, line: 'echo ran' })).err, /refused \(401\)/);
});

// A pipe held open by a line that waits on its stdin, which is never ended here.
async function livePipe(c, token, session = 'aaaa1111') {
  const stdin = new PassThrough();
  let out = '';
  const stdout = { write: (s) => { out += s; return true; } };
  const running = tunnel(c.origin, { token, session, line: 'echo up; cat', stdin, stdout });
  await until(() => out.includes('up'));
  assert.equal(c.execPipe.count(), 1);
  // Wrapped: an async function's promise would otherwise wait for this one.
  return { running };
}

test('revoking the token closes its live pipes at once, and only its own', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const laptop = c.signIn('mia-dev');
  const desktop = c.signIn('mia-dev');
  const { running } = await livePipe(c, laptop.token);
  c.cli.revoke('mia-dev', desktop.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.execPipe.count(), 1, 'another computer\'s revoke leaves it');
  c.cli.revoke('mia-dev', laptop.id);
  const ended = await running;
  assert.equal(ended.code, 255);
  assert.match(ended.err, /closed before the line ended/);
  await until(() => c.execPipe.count() === 0);
});

test('Remove My Woodshed or People\'s Remove (revokeAll), expiry, and a lockdown each close a live pipe', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  let { running } = await livePipe(c, c.signIn('mia-dev').token);
  c.cli.revokeAll('mia-dev', 'Remove My Woodshed');
  assert.equal((await running).code, 255);

  ({ running } = await livePipe(c, c.signIn('mia-dev').token));
  c.tick(91 * 24 * 3_600_000);
  c.execPipe.recheck();
  assert.equal((await running).code, 255, 'expired, found at the next check');

  ({ running } = await livePipe(c, c.signIn('mia-dev').token));
  c.lockDown('aaaa1111');
  assert.equal((await running).code, 255, 'cut as the lockdown starts, before anything of production reaches it');

  ({ running } = await livePipe(c, c.signIn('mia-dev').token));
  c.sessions.get('aaaa1111').status = 'stopping';
  c.execPipe.recheck();
  assert.equal((await running).code, 255, 'a session no longer running');
  c.sessions.get('aaaa1111').status = 'running';
});

test('a slow reader holds the session\'s program back, end to end, and loses nothing', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const { token } = c.signIn('mia-dev');
  const size = 40 * 1024 * 1024;
  const marker = path.join(statusd.cwd, 'finished');
  // A stdout that takes nothing until it is let go.
  let held = true;
  let release;
  const letGo = new Promise((r) => { release = r; });
  let received = 0;
  let bad = false;
  const stdout = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk, _encoding, done) {
      received += chunk.length;
      if (chunk.some((byte) => byte !== 0x61)) bad = true;
      if (held) letGo.then(() => done());
      else done();
    },
  });
  const running = tunnel(c.origin, { token, line: `head -c ${size} /dev/zero | tr '\\0' a; touch finished`, stdout });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.existsSync(marker), false, 'the program is still blocked writing: nothing buffered it all');
  assert.ok(received < size / 2, `only what the buffers on the way hold has moved (${received} bytes)`);
  held = false;
  release();
  const ended = await running;
  assert.equal(ended.code, 0);
  assert.equal(received, size);
  assert.equal(bad, false, 'every byte as written, in order');
  assert.equal(fs.existsSync(marker), true);
});

test('a path that is not the exec pipe\'s is left to the rest of the console', async (t) => {
  const statusd = await statusdFor(t);
  const c = await consoleFor(t, { statusd });
  const req = { url: '/api/tunnel/pg', headers: {} };
  assert.equal(c.execPipe.handleUpgrade(req, null, null), false);
  assert.equal(c.execPipe.handleUpgrade({ url: '//a:99999', headers: {} }, null, null), false);
});
