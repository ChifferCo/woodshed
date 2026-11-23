import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addMachine, agentOn, compareVersions, hcRunner, hcVersion, isTunnelTo, removeMachine, sessionHere, shellQuote, startWatcher, tunnelMachines, viaCommand, watcherArgv,
} from './hc.mjs';
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
  assert.match((await run(['--version'], { env: { HC_SESSION: 'other' } })).stdout, /session=other/, 'a call\'s own variables over the environment\'s');
  assert.match((await run(['--version'])).stdout, /session=scratch/, 'for that call alone');
  await assert.rejects(addMachine(run, { name: 'woodshed-aaaa0001', via: 'x' }), /hc could not add woodshed-aaaa0001: the via command exited 255/);
  assert.deepEqual(await agentOn(run, 'woodshed-aaaa0001'), { inHerdr: false, address: null }, 'no such terminal: the agent runs in tmux');
  assert.equal(await removeMachine(run, 'woodshed-aaaa0001', { origin: 'http://localhost:7712', session: 'aaaa0001' }), false, 'nothing to forget');
  assert.deepEqual(await run(['other']), { code: 9, stdout: '', stderr: '' });
  const missing = hcRunner({ bin: path.join(dir, 'no-such-hc') });
  assert.equal((await missing(['--version'])).missing, true);
  assert.equal((await hcVersion(missing)).installed, false);
});

test('a machine hc cannot list is a failure, and an agent hc cannot look up is not known', async () => {
  const broken = async () => ({ code: 1, stdout: '', stderr: 'core not running\n' });
  await assert.rejects(addMachine(broken, { name: 'm', via: 'x' }), /hc machine ls failed: core not running/);
  await assert.rejects(removeMachine(broken, 'm', { origin: 'http://localhost:7712', session: 'aaaa0001' }), /hc machine ls failed/);
  const unknown = async () => ({ code: 1, stdout: '{"error":{"kind":"unavailable","message":"m is unreachable"}}', stderr: '' });
  assert.deepEqual(await agentOn(unknown, 'm'), { inHerdr: null, address: null });
});

test('a machine is this command line\'s tunnel to a session only by its saved line, for that console and session', () => {
  const target = viaCommand({ node: '/n', script: '/s', origin: 'https://console.example', session: 'aaaa0001' });
  assert.equal(isTunnelTo({ via: true, target }, { origin: 'https://console.example', session: 'aaaa0001' }), true);
  assert.equal(isTunnelTo({ via: true, target }, { origin: 'https://other.example', session: 'aaaa0001' }), false);
  assert.equal(isTunnelTo({ via: true, target }, { origin: 'https://console.example', session: 'bbbb0002' }), false);
  assert.equal(isTunnelTo({ via: false, target: 'dev-box' }, { origin: 'https://console.example', session: 'aaaa0001' }), false, 'an ssh machine');
  assert.equal(isTunnelTo({ via: true, target: 'docker exec -i box sh -c' }, { origin: 'https://console.example', session: 'aaaa0001' }), false);
});

test('the agent\'s terminal with no labels at all is placed in a space and tab; one already placed keeps its layout', async () => {
  // What hc 0.1.21's `get --json` answers for a terminal nobody labelled (its address local to the machine).
  const real = { address: 't1', argv: ['claude'], cwd: '/work/app', labels: {}, name: 'claude', state: 'live', title: '' };
  for (const terminal of [real, { ...real, labels: undefined }, { address: 't1', state: 'live' }]) {
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args[0] === 'get') return { code: 0, stdout: `${JSON.stringify(terminal)}\n`, stderr: '' };
      return { code: 0, stdout: '{}\n', stderr: '' };
    };
    assert.deepEqual(await agentOn(run, 'woodshed-aaaa0001', { place: true }), { inHerdr: true, address: 'woodshed-aaaa0001/t1' });
    assert.deepEqual(calls.at(-1), ['label', '--json', 'woodshed-aaaa0001/t1', 'herdr.space=woodshed-aaaa0001', 'herdr.tab=woodshed-aaaa0001-agent'], JSON.stringify(terminal));
  }
  const placed = [];
  const own = async (args) => {
    placed.push(args);
    return { code: 0, stdout: `${JSON.stringify({ ...real, labels: { 'herdr.space': 'sp9', 'herdr.tab': 'tb9' } })}\n`, stderr: '' };
  };
  await agentOn(own, 'woodshed-aaaa0001', { place: true });
  assert.ok(!placed.some((a) => a[0] === 'label'), 'a terminal the person placed stays where it is');
});

test('the sessions that are machines in Herdr are those whose saved line is this command line\'s tunnel, on that console', async () => {
  const origin = 'https://console.example';
  const line = (session, o = origin) => viaCommand({ node: '/n', script: '/s', origin: o, session });
  const machines = [
    { name: 'woodshed-aaaa0001', via: true, target: line('aaaa0001') },
    { name: 'woodshed-bbbb0002', via: true, target: line('bbbb0002', 'https://other.example') },
    { name: 'woodshed-cccc0003', via: true, target: 'ssh box' },
    { name: 'laptop', via: true, target: line('dddd0004') },
  ];
  const run = async () => ({ code: 0, stdout: JSON.stringify({ machines }), stderr: '' });
  assert.deepEqual([...await tunnelMachines(run, { origin })], [['aaaa0001', 'woodshed-aaaa0001']]);
  await assert.rejects(tunnelMachines(async () => ({ code: 1, stdout: '', stderr: 'no core' }), { origin }), /hc machine ls failed: no core/);
});

test('the watch\'s terminal in hc runs this command line as words, and one already running is kept', async () => {
  assert.deepEqual(watcherArgv({ node: '/n o/node', script: '/s', origin: 'https://c.example', flags: ['--herdr'], configHome: '/h/.config' }),
    ['/usr/bin/env', 'WOODSHED_WATCH_IN_HERDR=1', 'XDG_CONFIG_HOME=/h/.config', '/n o/node', '/s', 'session', 'watch', '--console', 'https://c.example', '--herdr']);
  assert.deepEqual(watcherArgv({ node: '/n', script: '/s', origin: 'https://c.example', flags: [] }).slice(0, 3), ['/usr/bin/env', 'WOODSHED_WATCH_IN_HERDR=1', '/n']);
  const calls = [];
  const answers = [
    { code: 0, stdout: '{"address":"t4","name":"woodshed-watch"}', stderr: '' },
    { code: 1, stdout: '{"error":{"kind":"name_taken","message":"a live terminal is already named \\"woodshed-watch\\""}}', stderr: '' },
    { code: 1, stdout: '{"error":{"kind":"usage","message":"no core"}}', stderr: '' },
  ];
  const run = async (args) => { calls.push(args); return answers.shift(); };
  assert.deepEqual(await startWatcher(run, ['/n', '/s']), { action: 'started', address: 't4' });
  assert.deepEqual(calls[0].slice(-3), ['--', '/n', '/s']);
  assert.deepEqual(await startWatcher(run, ['/n', '/s']), { action: 'kept', address: null });
  await assert.rejects(startWatcher(run, ['/n', '/s']), (err) => err.hc && /hc could not start woodshed-watch: no core/.test(err.message));
});

test('a Woodshed session is told by the SESSION_ID and WOODSHED_TERMINAL its entrypoint leaves, and nothing less', () => {
  assert.equal(sessionHere({ SESSION_ID: 'abcd1234', WOODSHED_TERMINAL: 'herdr', HC_TERMINAL_ID: 't1' }), 'abcd1234');
  assert.equal(sessionHere({ SESSION_ID: 'abcd1234', WOODSHED_TERMINAL: 'tmux' }), 'abcd1234');
  // A laptop's Herdr terminal, or another program's SESSION_ID, is not a session.
  assert.equal(sessionHere({ HC_TERMINAL_ID: 't4' }), null);
  assert.equal(sessionHere({ SESSION_ID: 'abcd1234' }), null);
  assert.equal(sessionHere({ SESSION_ID: 'some-tool-session', WOODSHED_TERMINAL: 'herdr' }), null);
  assert.equal(sessionHere({ SESSION_ID: 'abcd1234', WOODSHED_TERMINAL: 'screen' }), null);
  assert.equal(sessionHere(), null);
});

test('a machine added meanwhile through the same line, by another run racing this one, stands: the add is kept, not failed', async () => {
  const via = 'node woodshed.mjs tunnel --console https://c.example abcd1234 --';
  const listed = [];
  const run = async (args) => {
    if (args[1] === 'ls') return { code: 0, stdout: JSON.stringify({ machines: listed }), stderr: '' };
    // The other run's add landed between this one's ls and add.
    listed.push({ name: 'woodshed-abcd1234', via: true, target: via, state: 'connected' });
    return { code: 1, stdout: JSON.stringify({ error: { kind: 'name_taken', message: '"woodshed-abcd1234" is already a machine here' } }), stderr: '' };
  };
  assert.deepEqual(await addMachine(run, { name: 'woodshed-abcd1234', via }), { action: 'kept', state: 'connected' });
  // Through another line, it is still a failure.
  listed.length = 0;
  const other = async (args) => {
    if (args[1] === 'ls') return { code: 0, stdout: JSON.stringify({ machines: listed }), stderr: '' };
    listed.push({ name: 'woodshed-abcd1234', via: true, target: 'ssh elsewhere', state: 'connected' });
    return { code: 1, stdout: JSON.stringify({ error: { kind: 'name_taken', message: 'taken' } }), stderr: '' };
  };
  await assert.rejects(addMachine(other, { name: 'woodshed-abcd1234', via }), /hc could not add woodshed-abcd1234: taken/);
});
