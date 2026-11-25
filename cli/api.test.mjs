import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { EXIT, runCommand } from './api.mjs';
import { argvOf, commandName, COMMANDS } from './commands.mjs';
import { createCredentials } from './credentials.mjs';
import { main } from './woodshed.mjs';

const byName = (n) => COMMANDS.find((e) => commandName(e) === n);

// The console's real handler, and a sign-in its program got for @mia-dev as the /cli page's approval makes one.
async function consoleFor(t) {
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  const config = {
    host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', consoleName: 'Acme Woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;
  const { deviceCode, userCode } = cli.start({ name: 'a program' });
  assert.ok(cli.decide({ code: userCode, login: 'mia-dev', approve: true }));
  const { token } = cli.poll(deviceCode);
  assert.match(token, /^wsc_/);
  return { origin, token, cli };
}

test('a command runs as the token\'s person, with its events and exit code, and the token never in them', async (t) => {
  const c = await consoleFor(t);
  const status = await runCommand(byName('status'), {}, c);
  assert.equal(status.code, EXIT.done);
  assert.equal(status.events[0].login, 'mia-dev');
  assert.equal(status.events[0].store, 'given');
  const list = await runCommand(byName('session list'), {}, c);
  assert.equal(list.code, EXIT.done);
  assert.deepEqual(list.events[0].sessions, []);
  const secret = await runCommand(byName('config get'), { key: 'claude-token' }, c);
  assert.equal(secret.code, EXIT.refused);
  assert.equal(secret.events[0].event, 'error');
  const none = await runCommand(byName('session get'), { id: 'aaaa0001' }, c);
  assert.equal(none.code, EXIT.failed);
  for (const r of [status, list, secret, none]) assert.ok(!JSON.stringify(r).includes(c.token));
});

test('a revoked sign-in is a person\'s to redo: exit 2', async (t) => {
  const c = await consoleFor(t);
  c.cli.revokeAll('mia-dev', 'test');
  const status = await runCommand(byName('status'), {}, c);
  assert.equal(status.code, EXIT.waiting);
});

test('what needs the person\'s computer or a terminal is refused before anything runs', async (t) => {
  const c = await consoleFor(t);
  await assert.rejects(runCommand(byName('settings push'), {}, c), /runs only on the person's own computer/);
  await assert.rejects(runCommand(byName('session connect'), { id: 'aaaa0001' }, c), /runs only on the person's own terminal/);
  await assert.rejects(runCommand(byName('session new'), { herdr: true }, c), /--herdr runs only on the person's own computer/);
  await assert.rejects(runCommand(byName('session get'), { id: '--yes' }, c), /not an option/);
});

test('its caller\'s signal stops a watch, and the run says it was stopped', async (t) => {
  const c = await consoleFor(t);
  const abort = new AbortController();
  const seen = [];
  const run = runCommand(byName('session watch'), { every: '5' }, { ...c, signal: abort.signal, onEvent: (e) => seen.push(e) });
  await new Promise((resolve) => setTimeout(resolve, 300));
  abort.abort();
  const out = await run;
  assert.equal(out.stopped, true);
  assert.equal(out.code, null);
  assert.equal(seen[0].event, 'watching');
});

test('no token is never this computer\'s: runCommand refuses it, and main given none reads no saved sign-in', async (t) => {
  const c = await consoleFor(t);
  for (const token of [undefined, null, '', 'wt_nope', 42]) {
    await assert.rejects(runCommand(byName('status'), {}, { ...c, token }), /needs the person's command line token/, String(token));
  }
  // A sign-in kept on this computer for the same console, as login keeps one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-saved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const store = credentials.save(c.origin, c.token);
  fs.writeFileSync(path.join(dir, 'woodshed', 'cli.json'), JSON.stringify({ current: c.origin, consoles: { [c.origin]: { store: store.kind ?? 'file', login: 'mia-dev' } } }));
  const run = async (deps) => {
    let out = '';
    const code = await main(['status', '--console', c.origin, '--json'], { env: { XDG_CONFIG_HOME: dir }, credentials, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} }, hc: async () => ({ missing: true }), ...deps });
    return { code, line: JSON.parse(out.trim().split('\n')[0]) };
  };
  assert.equal((await run({})).line.login, 'mia-dev', 'the saved sign-in is there');
  for (const token of [null, '']) {
    const r = await run({ token });
    assert.equal(r.code, EXIT.waiting, String(token));
    assert.equal(r.line.signedIn, false, String(token));
  }
});

test('a command that would read the checkout it runs in needs its repo named: it runs in no checkout', async (t) => {
  const c = await consoleFor(t);
  for (const name of ['review status', 'review pulls', 'review start']) {
    for (const repo of [undefined, [], ['acme/app'], '', null]) {
      await assert.rejects(runCommand(byName(name), { ...(name === 'review start' ? { pulls: ['12'] } : {}), ...(repo === undefined ? {} : { repo }) }, c), /needs repo: there is no checkout here/, `${name} ${JSON.stringify(repo)}`);
    }
  }
  assert.throws(() => argvOf(byName('review status'), { repo: [] }), /repo takes one value, not a list/);
  assert.throws(() => argvOf(byName('review start'), { pulls: [] }), /pulls needs at least one/);
  const status = await runCommand(byName('review status'), { repo: 'acme/app' }, c);
  assert.ok(!JSON.stringify(status).includes(process.cwd()), 'nothing of the folder the program runs in');
});

test('a run stopped before it starts sends nothing: a tunnel\'s line never reaches the session', async (t) => {
  const c = await consoleFor(t);
  // The console's address, counting what reaches it.
  let reached = 0;
  const server = http.createServer((req, res) => { reached += 1; res.writeHead(404).end(); });
  server.on('upgrade', (req, socket) => { reached += 1; socket.destroy(); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const abort = new AbortController();
  abort.abort();
  const out = await runCommand(byName('tunnel'), { id: 'aaaa0001', line: 'rm -rf ~/work' }, { origin: `http://localhost:${port}`, token: c.token, signal: abort.signal });
  assert.deepEqual([out.stopped, out.code], [true, null]);
  assert.equal(reached, 0);
});

test('session new takes a project\'s name for --repo, as the console does', () => {
  assert.deepEqual(argvOf(byName('session new'), { repo: 'app2' }), ['session', 'new', '--repo=app2']);
  assert.throws(() => argvOf(byName('session new'), { repo: '-x' }));
});

test('a temporary folder inside a checkout is refused, never read as the folder a command runs in', async (t) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { isolatedEnv } = await import('../test/isolatedEnv.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-checkout-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo], { env: isolatedEnv() });
  const tmp = path.join(repo, 'tmp');
  fs.mkdirSync(tmp);
  const script = `import('${new URL('./api.mjs', import.meta.url).href}').then(async ({ runCommand }) => {
    const { COMMANDS } = await import('${new URL('./commands.mjs', import.meta.url).href}');
    const status = COMMANDS.find((e) => e.path.join(' ') === 'status');
    await runCommand(status, {}, { origin: 'http://127.0.0.1:9', token: 'wsc_${'0'.repeat(64)}' });
  }).catch((err) => { console.log(err.message); process.exit(3); });`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: isolatedEnv({ TMPDIR: tmp }), encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /is inside the checkout .*set TMPDIR to a folder outside any checkout/);
});

test('a tunnel stopped while it connects closes its connection, and the run ends stopped', async (t) => {
  const c = await consoleFor(t);
  // A console that takes the tunnel's request and holds it, as one does while it reaches the session.
  const server = http.createServer(() => {});
  let socket;
  const arrived = new Promise((resolve) => server.on('upgrade', (req, s) => { socket = s; resolve(); }));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => { socket?.destroy(); server.close(); });
  const abort = new AbortController();
  const run = runCommand(byName('tunnel'), { id: 'aaaa0001', line: 'sleep 60' }, { origin: `http://localhost:${port}`, token: c.token, signal: abort.signal });
  await arrived;
  abort.abort();
  const out = await run;
  assert.deepEqual([out.stopped, out.code], [true, null]);
  assert.match(out.stderr, /could not reach|stopped before the line ran/, 'the tunnel closed its side');
});
