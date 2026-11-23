import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createExecPipe } from '../console/execPipe.mjs';
import { handleExecUpgrade } from '../session/execPipe.mjs';
import { createCredentials } from './credentials.mjs';
import { main } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A console with one running session of @mia-dev's, whose statusd runs the real sh, and this computer signed in to it.
async function signedIn(t) {
  const sessionToken = 's'.repeat(40);
  const statusd = http.createServer();
  statusd.on('upgrade', (req, socket, head) => handleExecUpgrade(req, socket, head, { isAuthorized: (h) => h === `Bearer ${sessionToken}`, cwd: os.tmpdir() }));
  const statusPort = await listen(statusd);
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  const session = { id: 'aaaa1111', owner: 'mia-dev', status: 'running', kind: 'task', endpoint: { host: '127.0.0.1', statusPort }, token: sessionToken };
  const execPipe = createExecPipe({ fleet: { find: (id) => (id === session.id ? session : null) }, cli });
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => { if (!execPipe.handleUpgrade(req, socket, head)) socket.destroy(); });
  const origin = `http://localhost:${await listen(server)}`;
  const { deviceCode, userCode } = cli.start({ name: 'mia-laptop' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const { token, id } = cli.poll(deviceCode);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-'));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const store = credentials.save(origin, token);
  fs.writeFileSync(path.join(dir, 'woodshed', 'cli.json'), JSON.stringify({ current: origin, consoles: { [origin]: { login: 'mia-dev', store: store.kind, tokenId: id } } }));
  t.after(() => {
    for (const s of [server, statusd]) {
      s.closeAllConnections?.();
      s.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = async (args, input = '') => {
    let out = '';
    let err = '';
    const stdin = new PassThrough();
    stdin.end(input);
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdin, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } },
      platform: 'test', credentials,
    });
    return { code, out, err };
  };
  return { origin, run, cli, id, session };
}

test('woodshed tunnel runs the words after -- as one line in the session, with the line\'s exit code', async (t) => {
  const { run } = await signedIn(t);
  assert.deepEqual(await run(['tunnel', 'aaaa1111', '--', 'echo', '"$((6 * 7))";', 'exit', '3']), { code: 3, out: '42\n', err: '' });
  assert.deepEqual(await run(['tunnel', 'aaaa1111', '--', 'tr', 'a-z', 'A-Z'], 'piped\n'), { code: 0, out: 'PIPED\n', err: '' });
  // A --via command gets the far side's options after --: they are the line's, never the command line's.
  assert.deepEqual(await run(['tunnel', 'aaaa1111', '--', 'echo', '--json', '--console', 'x']), { code: 0, out: '--json --console x\n', err: '' });
});

test('every failure of the pipe itself exits 255, and says why on stderr only', async (t) => {
  const { run, origin, cli, id } = await signedIn(t);
  for (const [args, words] of [
    [['tunnel', '--', 'true'], /usage: woodshed tunnel <session id> -- <line>/],
    [['tunnel', 'aaaa1111'], /usage/],
    [['tunnel', 'aaaa1111', '--'], /usage/],
    [['tunnel', 'not-an-id', '--', 'true'], /usage/],
    [['tunnel', 'aaaa1111', 'extra', '--', 'true'], /usage/],
    [['tunnel', 'ffff0000', '--', 'true'], /refused \(404\): no session of yours/],
    [['tunnel', 'aaaa1111', '--console', 'http://example.com', '--', 'true'], /plain http/],
    [['tunnel', 'aaaa1111', '--console', 'http://localhost:1', '--', 'true'], /not signed in to http:\/\/localhost:1/],
  ]) {
    const ran = await run(args);
    assert.equal(ran.code, 255, args.join(' '));
    assert.equal(ran.out, '', `${args.join(' ')}: stdout is the line's alone`);
    assert.match(ran.err, words, args.join(' '));
  }
  cli.revoke('mia-dev', id);
  const ended = await run(['tunnel', 'aaaa1111', '--console', origin, '--', 'true']);
  assert.equal(ended.code, 255);
  assert.match(ended.err, /refused \(401\).*woodshed login/);
});

test('a session that is not running says how to bring its Herdr machine back; one that saw production says only that', async (t) => {
  const { run, origin, session } = await signedIn(t);
  Object.assign(session, { status: 'stopped' });
  const stopped = await run(['tunnel', 'aaaa1111', '--console', origin, '--', 'true']);
  assert.equal(stopped.code, 255);
  assert.equal(stopped.out, '');
  assert.equal(stopped.err, `woodshed: refused (409): the session is stopped, not running. To reconnect it in Herdr, run: woodshed session herdr aaaa1111 --console ${origin} (it resumes the session and adds its machine again; resuming alone leaves the machine unreachable)\n`);
  assert.doesNotMatch(stopped.err, /resume it first/, 'a resume alone leaves the machine unreachable');

  Object.assign(session, { status: 'running', taintedAt: new Date().toISOString() });
  const tainted = await run(['tunnel', 'aaaa1111', '--console', origin, '--', 'true']);
  assert.equal(tainted.code, 255);
  assert.equal(tainted.err, 'woodshed: refused (409): this session has seen production data: nothing runs in it from outside\n');
});
