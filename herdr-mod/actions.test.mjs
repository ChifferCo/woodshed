import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readPanel, tidyStarts, readForwards, startRefusal, pollStart, readSession, extendSession, appAddress, startForward,
  readForward, stopForward, startInTerminal,
} from './woodshed/actions.js';
import { terminalName, newSessionArgs, forwardArgs } from './woodshed/woodshed.js';

// Each of the mod's actions, driven with a stand-in command line and a stand-in herdr-core, checking what it runs
// and what it makes of the answers. The command line's lines are what it prints with --json (cli/sessions.mjs,
// cli/forward.mjs, cli/woodshed.mjs).

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const line = (value) => `${JSON.stringify(value)}\n`;

/** A command line that answers from a table of `args joined by spaces` -> result, and records each call. */
function fakeCli(answers) {
  const calls = [];
  const cli = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (!(key in answers)) throw new Error(`unexpected woodshed ${key}`);
    return answers[key];
  };
  return { cli, calls };
}

/** A herdr-core holding terminals by name: {state, exit_code, reason, text}. */
function fakeCore(terminals = {}) {
  const calls = [];
  const core = async (args) => {
    calls.push(args);
    const [verb, ...rest] = args;
    if (verb === 'ls') return ok(JSON.stringify({ terminals: Object.entries(terminals).map(([name, t]) => ({ name, state: t.state, exit_code: t.exit_code, reason: t.reason })) }));
    if (verb === 'read') return terminals[rest[0]] ? ok(JSON.stringify({ text: terminals[rest[0]].text ?? '' })) : { code: 1, stdout: '', stderr: 'no such terminal' };
    if (verb === 'rm') { delete terminals[rest[0]]; return ok('{}'); }
    if (verb === 'kill') { if (terminals[rest[0]]) Object.assign(terminals[rest[0]], { state: 'finished', reason: 'killed', exit_code: null }); return ok('{}'); }
    if (verb === 'run') {
      const name = rest[rest.indexOf('--name') + 1];
      if (terminals[name]?.state === 'live') return { code: 1, stdout: '', stderr: `the name ${name} is taken` };
      terminals[name] = { state: 'live', text: '', argv: rest.slice(rest.indexOf('--') + 1) };
      return ok(JSON.stringify({ address: 't9', name, state: 'live' }));
    }
    throw new Error(`unexpected hc ${args.join(' ')}`);
  };
  return { core, calls, terminals };
}

const session = { id: 'ab12cd34', title: 'Fix the login loop', status: 'running', mine: true, url: 'https://console.example.com/s/ab12cd34' };

test('the panel reads who is signed in, then lists only their own sessions', async () => {
  const { cli, calls } = fakeCli({
    'status --json': ok(line({ console: 'https://console.example.com', name: 'Acme', signedIn: true, login: 'ana' })),
    'session list --json': ok(line({ console: 'https://console.example.com', login: 'ana', sessions: [session, { ...session, id: 'cd34ef56', mine: false }] })),
  });
  const panel = await readPanel(cli);
  assert.deepEqual(calls, [['status', '--json'], ['session', 'list', '--json']]);
  assert.deepEqual(panel.who, { console: 'Acme', login: 'ana' });
  assert.deepEqual(panel.sessions.map((s) => s.id), ['ab12cd34']);
});

test('signed out, or a sign-in that ended, lists nothing and says which', async () => {
  for (const [said, want] of [
    [{ console: 'https://c.example', signedIn: false }, 'not signed in to https://c.example'],
    [{ console: 'https://c.example', signedIn: false, ended: true }, 'your sign-in to https://c.example ended'],
  ]) {
    const { cli, calls } = fakeCli({ 'status --json': { code: 2, stdout: line(said), stderr: '' } });
    const panel = await readPanel(cli);
    assert.deepEqual(calls, [['status', '--json']], 'no list asked for');
    assert.deepEqual(panel.who, { signedOut: want });
    assert.equal(panel.sessions, null);
  }
  const { cli } = fakeCli({ 'status --json': { code: 1, stdout: '', stderr: 'woodshed: spawn woodshed ENOENT\n' } });
  assert.deepEqual((await readPanel(cli)).who, { missing: 'spawn woodshed ENOENT' });
});

test('a list the console refused keeps who is signed in and says why', async () => {
  const { cli } = fakeCli({
    'status --json': ok(line({ console: 'https://c.example', signedIn: true, login: 'ana' })),
    'session list --json': { code: 1, stdout: line({ event: 'error', status: 'error', error: 'the console did not answer' }), stderr: '' },
  });
  const panel = await readPanel(cli);
  assert.equal(panel.who.login, 'ana');
  assert.equal(panel.sessions, null);
  assert.equal(panel.listError, 'the console did not answer');
});

test('a finished start is tidied a pass after it was first seen finished, so an open dialog reads it first', async () => {
  const done = terminalName('new', 'k1');
  const { core, terminals } = fakeCore({ [done]: { state: 'finished', exit_code: 0 }, 'woodshed-new-k2': { state: 'live' }, other: { state: 'finished' } });
  const seen = new Set();
  await tidyStarts(core, seen);
  assert.ok(terminals[done], 'kept at the first look');
  await tidyStarts(core, seen);
  assert.equal(terminals[done], undefined, 'removed at the next');
  assert.ok(terminals['woodshed-new-k2'] && terminals.other, 'a live start and others\' terminals are never removed');
});

test('New session refuses no prompt unless on a branch or pull request, and passes the form as arguments', async () => {
  assert.ok(startRefusal({ prompt: ' ', branch: '' }));
  assert.equal(startRefusal({ prompt: '', branch: 'pr 12' }), null);
  assert.equal(startRefusal({ prompt: 'fix it', branch: '' }), null);
  const { core, terminals } = fakeCore();
  const name = terminalName('new', 'k3');
  const args = newSessionArgs({ repo: 'acme/app', agent: 'claude', prompt: 'fix the login loop' });
  assert.equal(await startInTerminal(core, { path: '/usr/local/bin/woodshed', name, cwd: '/home/ana', args }), null);
  assert.deepEqual(terminals[name].argv, ['/usr/local/bin/woodshed', 'session', 'new', '--json', '--repo', 'acme/app', '--agent', 'claude', '--', 'fix the login loop']);
});

test('a start is followed to its end, its last lines read after it finished, and its terminal removed', async () => {
  const name = terminalName('new', 'k4');
  const { core, terminals, calls } = fakeCore({ [name]: { state: 'live', text: line({ event: 'started', session }) + line({ event: 'step', label: 'Getting a machine' }) } });
  let look = await pollStart(core, name);
  assert.equal(look.finished, null);
  assert.deepEqual(look.progress.steps, ['Getting a machine']);
  // It finishes, and prints its last line, between two looks.
  Object.assign(terminals[name], { state: 'finished', exit_code: 0, text: terminals[name].text + line({ event: 'running', session }) });
  calls.length = 0;
  look = await pollStart(core, name);
  assert.deepEqual(calls.map((c) => c[0]), ['ls', 'read', 'rm'], 'state first, then output, then removed');
  assert.deepEqual(look.finished, { code: 0 });
  assert.equal(look.progress.end, 'running');
  assert.equal(look.progress.session.url, session.url);
  assert.equal(terminals[name], undefined);
});

test('Session info reads the session, and Extend sends that session\'s id and reports a refusal', async () => {
  const { cli, calls } = fakeCli({
    'session get ab12cd34 --json': ok(line({ session })),
    'session extend ab12cd34 --json': ok(line({ event: 'extended', session })),
    'session extend cd34ef56 --json': { code: 3, stdout: line({ event: 'error', status: 'refused', error: 'Only in its last 15 minutes' }), stderr: '' },
    'session get cd34ef56 --json': { code: 1, stdout: line({ event: 'error', status: 'error', error: 'No session cd34ef56 you can see' }), stderr: '' },
  });
  assert.deepEqual(await readSession(cli, 'ab12cd34'), { session });
  assert.equal(await extendSession(cli, 'ab12cd34'), null);
  assert.equal(await extendSession(cli, 'cd34ef56'), 'Only in its last 15 minutes');
  assert.deepEqual(await readSession(cli, 'cd34ef56'), { error: 'No session cd34ef56 you can see' });
  assert.deepEqual(calls.filter((c) => c[1] === 'extend'), [['session', 'extend', 'ab12cd34', '--json'], ['session', 'extend', 'cd34ef56', '--json']]);
});

test('Open app opens the address only when the command line gave one, and says why otherwise', async () => {
  const { cli } = fakeCli({
    'open ab12cd34 --json': ok(line({ session: 'ab12cd34', url: 'https://ab12cd34.apps.example.com/' })),
    'open cd34ef56 --json': { code: 1, stdout: line({ event: 'error', status: 'error', error: 'this console\'s apps have no names of their own' }), stderr: '' },
    'open ef56ab12 --json': { code: 2, stdout: line({ event: 'error', status: 'signed-out', error: 'not signed in' }), stderr: '' },
    'open 00000000 --json': ok(line({ session: '00000000', url: 'file:///etc/passwd' })),
  });
  assert.deepEqual(await appAddress(cli, 'ab12cd34'), { url: 'https://ab12cd34.apps.example.com/' });
  assert.deepEqual(await appAddress(cli, 'cd34ef56'), { error: 'this console\'s apps have no names of their own', level: 'error' });
  assert.deepEqual(await appAddress(cli, 'ef56ab12'), { error: 'not signed in', level: 'warning' });
  assert.equal((await appAddress(cli, '00000000')).url, undefined, 'never anything but http(s)');
});

test('Forward port starts one forward per session, lists its ports, and Stop ends that one only', async () => {
  const name = terminalName('fwd', 'ab12cd34');
  const { core, terminals } = fakeCore({ [name]: { state: 'live', text: '' }, [terminalName('fwd', 'cd34ef56')]: { state: 'live', text: '' } });
  const args = forwardArgs('ab12cd34', { auto: true });
  assert.equal(await startForward(core, { path: '/usr/local/bin/woodshed', name, cwd: '/home/ana', args }), null, 'the last forward is replaced, not refused');
  assert.deepEqual(terminals[name].argv, ['/usr/local/bin/woodshed', 'forward', '--auto', 'ab12cd34', '--json']);
  terminals[name].text = line({ event: 'forwarding', session: 'ab12cd34', port: 5173, local: 5174, wanted: 5173, moved: true, url: 'http://localhost:5174' });
  assert.deepEqual(await readForward(core, name), { state: 'on', open: [{ port: 5173, local: 5174, wanted: 5173, url: 'http://localhost:5174', moved: true }] });
  const panel = await readForwards(core, Object.entries(terminals).map(([n, t]) => ({ name: n, state: t.state })));
  assert.deepEqual(Object.keys(panel).sort(), ['ab12cd34', 'cd34ef56']);
  await stopForward(core, name);
  assert.deepEqual(await readForward(core, name), { state: { ended: 'Stopped.' }, open: [] });
  assert.equal(terminals[name], undefined, 'an ended forward\'s terminal is removed');
  assert.equal(terminals[terminalName('fwd', 'cd34ef56')].state, 'live', 'the other session\'s forward is left alone');
});

test('a forward that failed says the command line\'s reason', async () => {
  const name = terminalName('fwd', 'ab12cd34');
  const { core } = fakeCore({ [name]: { state: 'finished', exit_code: 3, text: line({ event: 'error', status: 'refused', error: 'not your session' }) } });
  assert.deepEqual(await readForward(core, name), { state: { ended: 'not your session' }, open: [] });
  assert.deepEqual(await readForward(core, name), { state: null, open: [] });
});
