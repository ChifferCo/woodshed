import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addMachine, agentOn, compareVersions, hcRunner, hcVersion, removeMachine, shellQuote, viaCommand } from './hc.mjs';
import { selfCommand } from './woodshed.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-hc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the via line reaches node with each word as it was, however odd the paths, and hc\'s line last', (t) => {
  const dir = scratch(t);
  // A stand-in node that prints its arguments and the config folder it was given, one per line.
  const node = path.join(dir, "it's a $HOME `node` dir", 'node');
  fs.mkdirSync(path.dirname(node));
  fs.writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "XDG=$XDG_CONFIG_HOME" "$@"\n', { mode: 0o755 });
  const script = path.join(dir, 'with space', 'woodshed.mjs');
  const configHome = path.join(dir, 'a "config" folder');
  const via = viaCommand({ node, script, origin: 'http://localhost:7712', session: 'aaaa0001', configHome });
  // As hc runs a --via machine on Unix: an sh line, with the line for the far side as one more argument.
  const out = execFileSync('/bin/sh', ['-c', `${via} 'hc connect --session x'`], { encoding: 'utf8' });
  assert.deepEqual(out.trimEnd().split('\n'), [`XDG=${configHome}`, script, 'tunnel', '--console', 'http://localhost:7712', 'aaaa0001', '--', 'hc connect --session x']);
  assert.equal(viaCommand({ node: '/usr/local/bin/node', script: '/opt/w/cli/woodshed.mjs', origin: 'https://console.example', session: 'aaaa0001' }),
    '/usr/local/bin/node /opt/w/cli/woodshed.mjs tunnel --console https://console.example aaaa0001 --', 'plain paths stay readable');
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('this command line is named by paths that outlive an upgrade: node on the PATH over its real file, and its own link', (t) => {
  const dir = scratch(t);
  const cellar = path.join(dir, 'Cellar', 'node', '22.1.0', 'bin');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(cellar, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cellar, 'node'), '');
  fs.symlinkSync(path.join(cellar, 'node'), path.join(bin, 'node'));
  const script = fileURLToPath(new URL('./woodshed.mjs', import.meta.url));
  const link = path.join(bin, 'woodshed');
  fs.symlinkSync(script, link);
  const self = selfCommand({ execPath: path.join(cellar, 'node'), argv1: link, env: { PATH: ['relative/bin', bin].join(path.delimiter) } });
  assert.deepEqual(self, { node: path.join(bin, 'node'), script: link });
  const other = selfCommand({ execPath: path.join(cellar, 'node'), argv1: '/somewhere/else.mjs', env: { PATH: '' } });
  assert.deepEqual(other, { node: path.join(cellar, 'node'), script }, 'run some other way: the real files');
});

test('versions compare as numbers, and hc below the minimum is not ok', async () => {
  assert.ok(compareVersions('0.1.21', '0.1.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.21') > 0);
  assert.equal(compareVersions('0.1.21', '0.1.21'), 0);
  const says = (stdout, code = 0) => async () => ({ code, stdout, stderr: '' });
  assert.deepEqual(await hcVersion(says('hc 0.1.21\n')), { installed: true, version: '0.1.21', minimum: '0.1.21', ok: true });
  assert.equal((await hcVersion(says('hc 0.1.20\n'))).ok, false);
  assert.deepEqual(await hcVersion(says('hc something\n')), { installed: true, version: null, minimum: '0.1.21', ok: false });
  assert.deepEqual(await hcVersion(async () => ({ code: null, stdout: '', stderr: '', missing: true })), { installed: false, version: null, minimum: '0.1.21', ok: false });
});

test('hc is run as a program, with its environment, and its failures and absence are told apart', async (t) => {
  const dir = scratch(t);
  const bin = path.join(dir, 'hc');
  // A stand-in hc: says the core its environment names, fails `machine add` as hc does, and keeps no machines.
  fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "--version ") echo "hc 0.1.21"; echo "session=$HC_SESSION" ;;
  "machine ls") echo '{"machines":[]}' ;;
  "machine add") echo '{"error":{"kind":"unreachable","message":"the via command exited 255"}}' >&2; exit 1 ;;
  "get --json") echo '{"error":{"kind":"not_found","message":"no terminal"}}'; exit 3 ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
  const run = hcRunner({ bin, env: { PATH: process.env.PATH, HC_SESSION: 'scratch' } });
  assert.match((await run(['--version'])).stdout, /session=scratch/, 'the core the person\'s environment names');
  await assert.rejects(addMachine(run, { name: 'woodshed-aaaa0001', via: 'x' }), /hc could not add woodshed-aaaa0001: the via command exited 255/);
  assert.deepEqual(await agentOn(run, 'woodshed-aaaa0001'), { inHerdr: false, address: null }, 'no such terminal: the agent runs in tmux');
  assert.equal(await removeMachine(run, 'woodshed-aaaa0001'), false, 'nothing to forget');
  assert.deepEqual(await run(['other']), { code: 9, stdout: '', stderr: '' });
  const missing = hcRunner({ bin: path.join(dir, 'no-such-hc') });
  assert.equal((await missing(['--version'])).missing, true);
  assert.equal((await hcVersion(missing)).installed, false);
});

test('a machine hc cannot list is a failure, and an agent hc cannot look up is not known', async () => {
  const broken = async () => ({ code: 1, stdout: '', stderr: 'core not running\n' });
  await assert.rejects(addMachine(broken, { name: 'm', via: 'x' }), /hc machine ls failed: core not running/);
  await assert.rejects(removeMachine(broken, 'm'), /hc machine ls failed/);
  const unknown = async () => ({ code: 1, stdout: '{"error":{"kind":"unavailable","message":"m is unreachable"}}', stderr: '' });
  assert.deepEqual(await agentOn(unknown, 'm'), { inHerdr: null, address: null });
});
