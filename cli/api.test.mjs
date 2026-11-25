import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { EXIT, runCommand } from './api.mjs';
import { commandName, COMMANDS } from './commands.mjs';

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
