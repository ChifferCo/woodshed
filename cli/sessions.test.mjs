import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { parseSessionArgs, pauseText, stateOf } from './sessions.mjs';
import { EXIT, main } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const T0 = Date.parse('2026-11-20T10:00:00Z');

// hc as `session herdr` drives it: its machines, and whether a machine has the agent's terminal. Each call is kept.
// `waiting`: the session waits for its agent's terminal from here (started with --parent), until a run makes it, or
// `taken`: the session made it itself as that run was on its way. `local`: this computer's terminals, by name.
export function fakeHc({ version = '0.1.21', missing = false, agent = true, addFails = null, waiting = false, taken = false, local = { boss: 't9' } } = {}) {
  const machines = new Map();
  const calls = [];
  const runs = [];
  let made = false;
  const ok = (answer) => ({ code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' });
  const err = (kind, message, code = 1) => ({ code, stdout: `${JSON.stringify({ error: { kind, message } })}\n`, stderr: '' });
  const run = async (args, opts = {}) => {
    calls.push(args);
    if (missing) return { code: null, stdout: '', stderr: '', missing: true };
    const [first, second] = args;
    if (first === '--version') return { code: 0, stdout: `hc ${version}\n`, stderr: '' };
    if (first === 'machine' && second === 'ls') return ok({ machines: [...machines.values()] });
    if (first === 'machine' && second === 'rm') {
      const name = args.at(-1);
      if (!machines.delete(name)) return err('machine_unknown', `no machine "${name}"`);
      return ok({ removed: name });
    }
    if (first === 'machine' && second === 'add') {
      const name = args[args.indexOf('--name') + 1];
      if (addFails) return err('unreachable', addFails);
      if (machines.has(name)) return err('name_taken', `"${name}" is already a machine here`);
      machines.set(name, { name, target: args[args.indexOf('--via') + 1], via: true, temporary: args.includes('--temp'), state: 'connected' });
      return ok({ name, target: machines.get(name).target, via: true });
    }
    if (first === 'file' && second === 'read') {
      if (!waiting || made) return err('not_found', `no file ${args.at(-1)}`, 3);
      return ok({ text: `${JSON.stringify({ terminal: 'claude', cwd: '/work/app', waitSeconds: 300 })}\n` });
    }
    if (first === 'run') {
      runs.push({ args, env: opts.env ?? null });
      const machine = args[args.indexOf('--on') + 1];
      if (taken) return err('name_taken', 'a live terminal is already named "claude"');
      made = true;
      return ok({ address: `${machine}/t1`, name: 'claude', parent: opts.env?.HC_TERMINAL_ID ?? null, state: 'live' });
    }
    if (first === 'get' && !args.at(-1).includes('/')) {
      const name = args.at(-1);
      if (Object.values(local).includes(name)) return ok({ address: name, state: 'live' });
      return Object.hasOwn(local, name) ? ok({ address: local[name], name, state: 'live' }) : err('not_found', `no terminal "${name}"`, 3);
    }
    if (first === 'get') {
      const [machine, terminal] = args.at(-1).split('/');
      if (!machines.has(machine)) return err('machine_unknown', `no machine "${machine}"`);
      return agent ? ok({ address: `${machine}/t1`, name: terminal }) : err('not_found', `no terminal "${terminal}"`, 3);
    }
    return err('usage', `unexpected ${args.join(' ')}`);
  };
  return { run, calls, runs, machines, added: () => calls.filter((a) => a[0] === 'machine' && a[1] === 'add') };
}
const iso = (ms) => new Date(ms).toISOString();

// A console's real handler and command line sign-in over a made-up fleet: mia-dev's sessions, octocat's, and shared
// ones. A session the fleet starts or resumes takes the next of `script`'s steps each time the list is read, as a start
// moves while the command line waits. The command line is signed in as mia-dev before each test.
async function consoleFor(t, { script = [], refuse = null, claudeToken = true, savedDefault = 'app', writers = null, stopTimesOut = false, hc = fakeHc(), relativeConfig = false, tty = true, terminal = null, env = {} } = {}) {
  let clock = T0;
  const now = () => clock;
  const store = { state: {}, save() {} };
  // GitHub's answer on write access, as the console's sign-in asks it.
  const cli = createCliSignIn({ store, now, canWrite: async (login) => !writers || writers.has(login) });
  const base = { repo: 'acme/app', project: 'app', createdAt: iso(T0 - 3_600_000), startedAt: iso(T0 - 3_600_000), options: { agent: 'claude' }, token: 'statusd-secret' };
  const sessions = [
    { ...base, id: 'aaaa0001', owner: 'mia-dev', title: 'Fix the login bug', status: 'running', state: 'working', branch: 'woodshed/aaaa0001' },
    { ...base, id: 'bbbb0002', owner: 'mia-dev', title: 'Paused one', status: 'stopped', stopReason: 'idle for 2 h', limits: { lifetimeHours: 6 } },
    { ...base, id: 'eeee0005', owner: 'octocat', title: 'Octocat\'s own', status: 'running', state: 'working' },
    { ...base, id: 'cccc0003', owner: null, title: 'Shared \x1b]0;pwned\x07work', status: 'running', state: 'needs-you', assignee: 'octocat', kept: true },
    { ...base, id: 'ffff0006', owner: null, title: 'Long done', status: 'stopped', kept: false, cleanedAt: iso(T0) },
    { ...base, id: '1a1a0007', owner: null, title: 'In review', status: 'running', state: 'done', slackWaiting: true, assignee: 'mia-dev', kept: true },
    { ...base, id: '1b1b0008', owner: null, title: 'Merged one', status: 'stopped', kept: true, prClosedAt: iso(T0), prMerged: true },
    { ...base, id: '1c1c0009', owner: null, title: 'Odd fields', status: 'weird\x1b[2J', assignee: 'x\x1b]0;pwned\x07', kept: true },
  ];
  const calls = [];
  const moving = new Map();
  const move = () => {
    for (const [id, steps] of moving) {
      const s = sessions.find((x) => x.id === id);
      if (s && steps.length) Object.assign(s, steps.shift());
    }
  };
  const fleet = {
    sessions: () => { move(); return sessions; },
    // Done, with its pull request waiting for the review and suites before Slack: the page's in review.
    slackWaiting: () => new Set(['1a1a0007']),
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    startPrivate: async (args) => {
      calls.push(['start', args]);
      if (refuse) throw Object.assign(new Error(refuse), { shown: true });
      const s = { ...base, id: 'dddd0004', owner: args.owner, title: args.prompt, status: 'queued', startedAt: null, startSteps: null, options: { agent: args.agent, model: args.model } };
      sessions.push(s);
      moving.set(s.id, script.map((step) => ({ ...step })));
      return s;
    },
    resumePrivate: async ({ owner, id, herdrParent }) => {
      calls.push(['resume', { owner, id, ...(herdrParent ? { herdrParent } : {}) }]);
      const s = sessions.find((x) => x.id === id && x.owner === owner);
      Object.assign(s, { status: 'queued', stopReason: null, startedAt: null, startSteps: null });
      moving.set(id, script.map((step) => ({ ...step })));
      return s;
    },
    removePrivateSession: async ({ owner, id }) => {
      calls.push(['remove', { owner, id }]);
      sessions.splice(sessions.findIndex((x) => x.id === id && x.owner === owner), 1);
    },
    // As the fleet's: one that stopped by itself is marked stopped by the person, and waits on nobody.
    stop: async (session, reason, { by }) => {
      calls.push(['stop', { id: session.id, by }]);
      if (session.status === 'stopped' || session.status === 'failed') session.stoppedBy ??= by;
      else session.status = 'stopping';
    },
    limitsOf: (s) => ({ idleMs: (s.limits?.idleHours ?? 2) * 3_600_000, lifetimeMs: (s.limits?.lifetimeHours ?? 12) * 3_600_000 }),
    pauseOf: (s) => (s.status === 'running' ? { at: iso(T0 + (s.extendedUntil ? 102 : 42) * 60_000), why: 'idle' } : null),
    // As the fleet's: only running, only in the last 15 minutes, and a shared session's time is its assignee's.
    extend: (s, by) => {
      if (s.status !== 'running') throw Object.assign(new Error('only a running session can be extended'), { shown: true });
      if (!s.owner && s.assignee !== by) throw Object.assign(new Error(`only ${s.assignee}, who has this session, can change when it pauses or stops`), { shown: true, forbidden: true });
      if (s.tooEarly) throw Object.assign(new Error('Extend is offered in the last 15 min before it pauses'), { shown: true });
      calls.push(['extend', { id: s.id, by }]);
      s.extendedUntil = iso(clock + 102 * 60_000);
    },
    setLimits: (s, values, by) => {
      for (const v of Object.values(values)) if (v !== null && (v < 0.5 || v > 72)) throw Object.assign(new Error('idle hours must be from 0.5 to 72'), { shown: true });
      calls.push(['limits', { id: s.id, by, values }]);
      s.limits = values;
    },
  };
  const userSettings = { view: () => ({ claudeToken: { set: claudeToken } }), refresh: async () => {}, limitsFor: () => ({ idleMs: 2 * 3_600_000, lifetimeMs: 12 * 3_600_000 }) };
  const projectAccess = {
    view: async () => ({ projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: savedDefault, saved: savedDefault !== 'app' }),
    forStart: async (login, name) => (name === undefined ? { name: 'app', repo: 'acme/app' } : ['app', 'tools'].includes(name) ? { name, repo: `acme/${name}` } : null),
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, cli, userSettings, projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  let answer = null;
  const listFailures = [];
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: relativeConfig ? path.relative(process.cwd(), dir) : dir, ...env }, stdout: { write: (s) => { out += s; }, isTTY: tty },
      stdin: { isTTY: tty }, stderr: { write: (s) => { err += s; } }, terminal: terminal?.run,
      sleep: async (ms) => { clock += ms; }, now, hostname: 'mia-laptop', platform: 'test', credentials, confirm: async () => answer,
      hc: hc.run, self: { node: '/usr/local/bin/node', script: '/home/mia/woodshed/cli/woodshed.mjs' },
      // A stop the console takes longer to answer than the command line waits.
      fetch: (url, init) => {
        if (stopTimesOut && String(url).endsWith('/stop')) return Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        if (listFailures.length && String(url).endsWith('/api/sessions')) {
          const status = listFailures.shift();
          if (status === null) return Promise.reject(new TypeError('fetch failed'));
          return Promise.resolve(new Response('The upstream is unavailable', { status }));
        }
        return fetch(url, init);
      },
      // The person approves the code at once, as signed in to the console.
      openBrowser: (url) => { cli.decide({ code: new URL(url).searchParams.get('code'), login: 'mia-dev', approve: true }); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const signed = await run(['login', '--console', origin]);
  assert.equal(signed.code, EXIT.done, signed.err);
  return { origin, run, calls, sessions, cli, hc, dir, answer: (a) => { answer = a; }, listFailures, now };
}

// A start as the fleet moves it: in line, starting, each step, then running.
const START = [
  { status: 'queued' },
  { status: 'starting', startedAt: iso(T0), startSteps: { machine: iso(T0 + 2000) } },
  { startSteps: { machine: iso(T0 + 2000), container: iso(T0 + 9000), settings: iso(T0 + 10_000), branch: iso(T0 + 12_000) } },
  { startSteps: { machine: iso(T0 + 2000), container: iso(T0 + 9000), settings: iso(T0 + 10_000), branch: iso(T0 + 12_000), env: iso(T0 + 14_000), claude: iso(T0 + 20_000) } },
];

test('session new starts a private session on the repo named, and follows its start until it runs', async (t) => {
  const c = await consoleFor(t, { script: [...START, { status: 'running', state: 'working' }] });
  const out = await c.run(['session', 'new', '--repo', 'acme/tools', '--branch', 'fix-login', '--model', 'opus', '--json', 'fix the login bug']);
  assert.equal(out.code, EXIT.done, out.err);
  const [, args] = c.calls.find(([kind]) => kind === 'start');
  assert.deepEqual([args.owner, args.prompt, args.workOn, args.agent, args.model, args.project?.name], ['mia-dev', 'fix the login bug', 'fix-login', 'claude', 'opus', 'tools']);
  const events = out.lines.map((l) => l.event);
  assert.equal(events[0], 'started');
  assert.equal(out.lines[0].session.id, 'dddd0004');
  assert.equal(out.lines[0].session.url, `${c.origin}/s/dddd0004`);
  assert.deepEqual(out.lines.filter((l) => l.event === 'step').map((l) => l.step), ['machine', 'container', 'settings', 'branch', 'env', 'claude'], 'each step once, in order');
  assert.deepEqual(out.lines.filter((l) => l.event === 'status').map((l) => l.status), ['queued', 'starting']);
  assert.equal(events.at(-1), 'running');
  assert.equal(out.lines.at(-1).session.state, 'working');

  const text = await c.run(['session', 'resume', 'bbbb0002']);
  assert.equal(text.code, EXIT.done, text.err);
  assert.match(text.out, /Resuming session bbbb0002: Paused one\n/);
  assert.match(text.out, /Starting:\n {2}done {2}Getting a machine \(2s\)\n/);
  assert.match(text.out, / {2}done {2}Opening claude \(20s\)\n/);
  assert.match(text.out, /Session bbbb0002 is running: http:\/\/localhost:\d+\/s\/bbbb0002\n$/);
});

test('session new ends waiting on a person when the session needs them, and fails when its start does', async (t) => {
  const asks = await consoleFor(t, { script: [{ status: 'starting', startedAt: iso(T0) }, { status: 'running', state: 'needs-you' }] });
  const needs = await asks.run(['session', 'new', 'go']);
  assert.equal(needs.code, EXIT.waiting);
  assert.match(needs.out, /is running and needs you/);

  const fails = await consoleFor(t, { script: [{ status: 'starting', startedAt: iso(T0) }, { status: 'failed', error: 'the session\'s databases were not ready' }] });
  const failed = await fails.run(['session', 'new', '--json', 'go']);
  assert.equal(failed.code, EXIT.failed);
  assert.equal(failed.lines.at(-1).event, 'failed');
  assert.equal(failed.lines.at(-1).session.error, 'the session\'s databases were not ready');

  const noWait = await fails.run(['session', 'new', '--no-wait', 'go']);
  assert.equal(noWait.code, EXIT.done);
  assert.doesNotMatch(noWait.out, /Waiting/);
});

test('session new with no --repo starts on the default the person saved, not the console\'s', async (t) => {
  const c = await consoleFor(t, { savedDefault: 'tools', script: [{ status: 'running', state: 'working' }] });
  assert.equal((await c.run(['session', 'new', '--no-wait', 'go'])).code, EXIT.done);
  assert.equal(c.calls.find(([kind]) => kind === 'start')[1].project?.name, 'tools');
});

test('session new says what the console refuses, with its exit code', async (t) => {
  const c = await consoleFor(t, { claudeToken: false });
  const other = await c.run(['session', 'new', '--repo', 'someone/else', 'go']);
  assert.equal(other.code, EXIT.refused);
  assert.match(other.err, /You cannot start sessions on someone\/else.*Yours: acme\/app, acme\/tools/);
  const noToken = await c.run(['session', 'new', 'go']);
  assert.equal(noToken.code, EXIT.failed);
  assert.match(noToken.err, /save your Claude token on My settings first/);
  assert.equal(c.calls.length, 0, 'nothing started');
  assert.equal((await c.run(['session', 'new', '--agent', 'gpt', 'go'])).code, EXIT.failed);

  const refused = await consoleFor(t, { refuse: 'say what Claude should do' });
  const empty = await refused.run(['session', 'new', '--json']);
  assert.equal(empty.code, EXIT.failed);
  assert.deepEqual(empty.lines.at(-1), { event: 'error', status: 'error', error: 'say what Claude should do' });
});

test('session list shows your sessions and the shared ones, their state, and when each pauses', async (t) => {
  const c = await consoleFor(t);
  const text = await c.run(['session', 'list']);
  assert.equal(text.code, EXIT.done, text.err);
  const lines = text.out.trim().split('\n');
  assert.match(lines[0], /^ID +STATE +WHOSE +PAUSES +PROJECT +TITLE$/);
  assert.match(text.out, /aaaa0001 +working +mine +in 42m, idle +app +Fix the login bug/);
  assert.match(text.out, /bbbb0002 +paused +mine +- +app +Paused one/);
  assert.match(text.out, /cccc0003 +needs you +@octocat +in 42m, idle +app +Shared  ]0;pwned work/, 'no escape code reaches the terminal');
  assert.doesNotMatch(text.out, /\x1b|\x07/);
  assert.match(text.out, /1a1a0007 +in review +you /, 'the page\'s words, and yours');
  assert.match(text.out, /1b1b0008 +merged /);
  assert.match(text.out, /1c1c0009 +paused +@x ]0;pwned /, 'an assignee a console made up reaches the terminal printable');
  const odd = await c.run(['session', 'get', '1c1c0009']);
  assert.match(odd.out, /State: +paused \(weird \[2J\)\nWhose: +shared, @x ]0;pwned  has it\n/);
  assert.doesNotMatch(odd.out, /\x1b|\x07/);
  assert.doesNotMatch(text.out, /eeee0005/, 'another person\'s private session is not listed');
  assert.doesNotMatch(text.out, /ffff0006/, 'one that ended, only with --all');
  assert.match((await c.run(['session', 'list', '--all'])).out, /ffff0006 +deleted/);

  const json = await c.run(['session', 'list', '--json']);
  const [{ login, sessions }] = json.lines;
  assert.equal(login, 'mia-dev');
  const mine = sessions.find((s) => s.id === 'aaaa0001');
  assert.deepEqual(mine.pause, { at: '2026-11-20T10:42:00.000Z', why: 'idle' });
  assert.deepEqual(mine.runsOn, { idleHours: 2, lifetimeHours: 12 });
  assert.equal(mine.mine, true);
  assert.ok(!JSON.stringify(json.lines).includes('statusd-secret'));

  const one = await c.run(['session', 'get', 'aaaa0001']);
  assert.equal(one.code, EXIT.done);
  assert.match(one.out, /Pauses: +in 42m, idle \(2026-11-20 10:42 UTC\)\nRuns on: +2 h idle, 12 h lifetime\n/);
  assert.deepEqual((await c.run(['session', 'get', 'bbbb0002', '--json'])).lines[0].session.ownLimits, { idleHours: null, lifetimeHours: 6 });
  const missing = await c.run(['session', 'get', 'eeee0005']);
  assert.equal(missing.code, EXIT.failed);
  assert.match(missing.err, /No session eeee0005 that you can see/);
});

test('session stop, resume and remove act on your own sessions, and remove asks first', async (t) => {
  const c = await consoleFor(t);
  const stopped = await c.run(['session', 'stop', 'aaaa0001']);
  assert.equal(stopped.code, EXIT.done);
  assert.deepEqual(c.calls.at(-1), ['stop', { id: 'aaaa0001', by: 'mia-dev' }]);
  const paused = await c.run(['session', 'stop', 'bbbb0002']);
  assert.equal(paused.code, EXIT.done);
  assert.match(paused.out, /was already paused: it is marked stopped by you, and waits on nobody now/);
  assert.deepEqual(c.calls.at(-1), ['stop', { id: 'bbbb0002', by: 'mia-dev' }], 'sent, as the page\'s Stop on a paused session');
  const again = await c.run(['session', 'stop', 'aaaa0001']);
  assert.match(again.out, /is not running: it is stopping/);
  assert.equal(c.calls.length, 2, 'no stop of one stopping');
  assert.match((await c.run(['session', 'stop', 'bbbb0002'])).out, /is not running: it is stopped/);
  assert.equal(c.calls.length, 2, 'nor of one a person stopped');

  const shared = await c.run(['session', 'resume', 'cccc0003']);
  assert.equal(shared.code, EXIT.refused);
  assert.match(shared.err, /a shared session: the command line can resume only your own/);
  assert.equal((await c.run(['session', 'remove', 'cccc0003', '--yes'])).code, EXIT.refused);

  const unasked = await c.run(['session', 'remove', 'bbbb0002']);
  assert.equal(unasked.code, EXIT.waiting, 'no terminal to ask on: waiting on the person\'s --yes');
  assert.match(unasked.err, /add --yes/);
  c.answer(false);
  assert.match((await c.run(['session', 'remove', 'bbbb0002'])).out, /Kept/);
  c.answer(true);
  const removed = await c.run(['session', 'remove', 'bbbb0002', '--json']);
  assert.equal(removed.code, EXIT.done);
  assert.deepEqual(removed.lines, [{ event: 'removed', id: 'bbbb0002', machine: { name: 'woodshed-bbbb0002', removed: false } }], 'no machine of it in hc');
  assert.deepEqual(c.calls.at(-1), ['remove', { owner: 'mia-dev', id: 'bbbb0002' }]);
  assert.equal((await c.run(['session', 'stop', 'nothex'])).code, EXIT.failed);
});

test('session extend and limits ask for more time, where the console allows it', async (t) => {
  const c = await consoleFor(t);
  const extended = await c.run(['session', 'extend', 'aaaa0001']);
  assert.equal(extended.code, EXIT.done, extended.err);
  assert.match(extended.out, /Session aaaa0001 now pauses in 1h 42m\./);
  assert.deepEqual(c.calls.at(-1), ['extend', { id: 'aaaa0001', by: 'mia-dev' }]);

  c.sessions.find((s) => s.id === 'aaaa0001').tooEarly = true;
  const early = await c.run(['session', 'extend', 'aaaa0001', '--json']);
  assert.equal(early.code, EXIT.refused, 'outside its window is the console\'s rule');
  assert.match(early.lines.at(-1).error, /last 15 min/);
  const notMine = await c.run(['session', 'extend', 'cccc0003']);
  assert.equal(notMine.code, EXIT.refused);
  assert.match(notMine.err, /only octocat/);
  assert.equal((await c.run(['session', 'extend', 'bbbb0002'])).code, EXIT.refused, 'not running');

  const limited = await c.run(['session', 'limits', 'bbbb0002', '--idle-hours', '4', '--json']);
  assert.equal(limited.code, EXIT.done, limited.err);
  assert.deepEqual(c.calls.at(-1)[1].values, { idleHours: 4, lifetimeHours: 6 }, 'its own lifetime is kept');
  assert.deepEqual(limited.lines[0].session.runsOn, { idleHours: 4, lifetimeHours: 6 });
  await c.run(['session', 'limits', 'bbbb0002', '--lifetime-hours=default']);
  assert.deepEqual(c.calls.at(-1)[1].values, { idleHours: 4, lifetimeHours: null }, 'default goes back to the owner\'s or the console\'s');
  const outOfRange = await c.run(['session', 'limits', 'bbbb0002', '--idle-hours', '100']);
  assert.equal(outOfRange.code, EXIT.failed);
  assert.match(outOfRange.err, /from 0\.5 to 72/);
  assert.equal((await c.run(['session', 'limits', 'bbbb0002'])).code, EXIT.failed, 'nothing asked');
  assert.equal((await c.run(['session', 'limits', 'bbbb0002', '--idle-hours', 'lots'])).code, EXIT.failed);
});

test('session commands wait on a person to sign in, and say so once the sign-in ended', async (t) => {
  const c = await consoleFor(t);
  c.cli.revokeAll('mia-dev', 'test');
  const ended = await c.run(['session', 'list', '--json']);
  assert.equal(ended.code, EXIT.waiting);
  assert.equal(ended.lines[0].status, 'signed-out');
  await c.run(['logout']);
  const out = await c.run(['session', 'list']);
  assert.equal(out.code, EXIT.waiting);
  assert.match(out.out, /Not signed in/);
});

test('the state words and pause times are the page\'s', () => {
  assert.deepEqual(stateOf({ status: 'running', state: 'needs-you' }), { key: 'needs-you', word: 'needs you' });
  assert.deepEqual(stateOf({ status: 'running', state: null, options: { agent: 'codex' } }), { key: 'idle', word: 'codex exited' });
  assert.deepEqual(stateOf({ status: 'queued', owner: 'mia' }), { key: 'queued', word: 'waiting' });
  assert.deepEqual(stateOf({ status: 'stopped', owner: 'mia', stopReason: 'ran for 12 h' }), { key: 'paused', word: 'paused' });
  assert.deepEqual(stateOf({ status: 'stopped', owner: 'mia', stoppedBy: 'mia', stopReason: 'stopped from the console' }), { key: 'stopped', word: 'stopped' });
  assert.equal(pauseText({ at: iso(T0 + 125 * 60_000), why: 'lifetime' }, T0), 'in 2h 5m, lifetime');
  assert.equal(pauseText(null, T0), '');
});

test('a stop the console has not answered in time says so, and a refused sign-in says why', async (t) => {
  const slow = await consoleFor(t, { stopTimesOut: true });
  const stop = await slow.run(['session', 'stop', 'aaaa0001']);
  assert.equal(stop.code, EXIT.failed);
  assert.match(stop.err, /did not answer in time; it may still be doing it\. Check with: woodshed session get aaaa0001/);

  const gone = await consoleFor(t, { writers: new Set(['octocat']) });
  const out = await gone.run(['session', 'list']);
  assert.equal(out.code, EXIT.waiting);
  assert.match(out.err, /ended: you no longer have write access to the repository/);
});

test('an unknown session command is a usage error, even one named like an object\'s own', async () => {
  const { parseSessionArgs } = await import('./sessions.mjs');
  const fail = (message) => new Error(message);
  for (const sub of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope']) {
    assert.throws(() => parseSessionArgs(sub, ['--bad-flag'], fail), /unknown session command/, sub);
  }
});

test('session herdr makes your running session a machine in hc, through this command line\'s tunnel, once', async (t) => {
  const c = await consoleFor(t);
  const out = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(out.code, EXIT.done, out.err);
  const via = c.hc.added()[0]?.[6];
  assert.deepEqual(c.hc.added(), [['machine', 'add', '--json', '--name', 'woodshed-aaaa0001', '--via', via, '--install']], 'never --temp, which the app\'s sidebar hides');
  // By absolute paths, on this console, with the config folder this command line read its sign-in from.
  assert.match(via, new RegExp(`^XDG_CONFIG_HOME=/\\S+ /usr/local/bin/node /home/mia/woodshed/cli/woodshed\\.mjs tunnel --console ${c.origin} aaaa0001 --$`));
  const [connected] = out.lines;
  assert.equal(connected.event, 'connected');
  assert.deepEqual(connected.machine, { name: 'woodshed-aaaa0001', action: 'added', state: null });
  assert.deepEqual(connected.agent, { inHerdr: true, address: 'woodshed-aaaa0001/t1' });
  assert.equal(connected.session.id, 'aaaa0001');
  assert.ok(!c.calls.some(([kind]) => kind === 'resume'), 'a running session is not resumed');

  const again = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(again.code, EXIT.done, again.err);
  assert.match(again.out, /woodshed-aaaa0001 was already in Herdr, connected\.\nIts agent is woodshed-aaaa0001\/t1: hc attach woodshed-aaaa0001\/t1\n/);
  assert.equal(c.hc.added().length, 1, 'connected through the same line: left alone');

  // Resumed since, the session is a new container, whose core hc does not take for the one it knew.
  c.hc.machines.get('woodshed-aaaa0001').state = 'unreachable';
  assert.equal((await c.run(['session', 'herdr', 'aaaa0001'])).code, EXIT.done);
  assert.equal(c.hc.added().length, 2, 'added again');
  assert.ok(c.hc.calls.some((a) => a.join(' ') === 'machine rm --json woodshed-aaaa0001'), 'after forgetting the old one');
  c.hc.machines.get('woodshed-aaaa0001').target = 'woodshed tunnel aaaa0001 --';
  const moved = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(moved.lines[0].machine.action, 'updated', 'a line of another command line\'s is replaced');
  assert.equal(c.hc.machines.get('woodshed-aaaa0001').target, via);
  c.hc.machines.get('woodshed-aaaa0001').temporary = true;
  const temp = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(temp.lines[0].machine.action, 'updated', 'a --temp one, which the sidebar hides, is replaced');
  assert.equal(c.hc.machines.get('woodshed-aaaa0001').temporary, false);
});

test('a relative XDG_CONFIG_HOME is named absolute in the via line, since hc\'s core runs it from its own folder', async (t) => {
  const c = await consoleFor(t, { relativeConfig: true });
  assert.equal((await c.run(['session', 'herdr', 'aaaa0001'])).code, EXIT.done);
  const via = c.hc.added()[0][6];
  assert.ok(via.startsWith(`XDG_CONFIG_HOME=${c.dir} `), via);
});

test('session herdr resumes a paused session first, and waits for it to run', async (t) => {
  const c = await consoleFor(t, { script: [...START, { status: 'running', state: 'working' }] });
  const out = await c.run(['session', 'herdr', 'bbbb0002']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(c.calls.find(([kind]) => kind === 'resume'), ['resume', { owner: 'mia-dev', id: 'bbbb0002' }]);
  assert.match(out.out, /Resuming session bbbb0002: Paused one\n[\s\S]*Session bbbb0002 is running: [^\n]+\nAdding bbbb0002 to Herdr as woodshed-bbbb0002…\nwoodshed-bbbb0002 is in Herdr: it shows in the app's sidebar\.\n/);

  const fails = await consoleFor(t, { script: [{ status: 'starting', startedAt: iso(T0) }, { status: 'failed', error: 'no room' }] });
  const failed = await fails.run(['session', 'herdr', 'bbbb0002']);
  assert.equal(failed.code, EXIT.failed);
  assert.equal(fails.hc.added().length, 0, 'nothing added for a session that did not start');
});

test('session herdr says the agent runs in tmux when its owner did not pick Herdr', async (t) => {
  const c = await consoleFor(t, { hc: fakeHc({ agent: false }) });
  const out = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.match(out.out, /Its agent runs in tmux, not Herdr: Agent terminal on My settings was tmux when the session started\. New terminals and agents on woodshed-aaaa0001 work; the agent itself is at http:\/\/localhost:\d+\/s\/aaaa0001\. Pick Herdr on My settings/);
  assert.deepEqual((await c.run(['session', 'herdr', 'aaaa0001', '--json'])).lines[0].agent, { inHerdr: false, address: null });
  c.sessions.find((s) => s.id === 'aaaa0001').state = 'needs-you';
  const needs = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(needs.code, EXIT.waiting, 'connected, and waiting on you, as a start that needs you is');
  assert.match(needs.out, /It needs you: http:\/\/localhost:\d+\/s\/aaaa0001\n$/);
});

test('session herdr refuses with no hc or an old one, a shared session and one that saw production, before resuming anything', async (t) => {
  const none = await consoleFor(t, { hc: fakeHc({ missing: true }) });
  const missing = await none.run(['session', 'herdr', 'bbbb0002', '--json']);
  assert.equal(missing.code, EXIT.refused);
  assert.equal(missing.lines.at(-1).status, 'no-hc');
  assert.match(missing.lines.at(-1).error, /needs its hc, 0\.1\.21 or newer, and there is no hc on your PATH/);
  assert.ok(!none.calls.length, 'nothing resumed');
  const started = await none.run(['session', 'new', '--herdr', 'go']);
  assert.equal(started.code, EXIT.refused);
  assert.ok(!none.calls.length, 'nothing started');

  const old = await consoleFor(t, { hc: fakeHc({ version: '0.1.9' }) });
  const tooOld = await old.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(tooOld.code, EXIT.refused);
  assert.match(tooOld.err, /needs hc 0\.1\.21 or newer, and yours is 0\.1\.9\. Update it \(hc update\)/);
  assert.ok(!old.hc.calls.some((a) => a[0] !== '--version'), 'hc is only asked its version: never updated from here');

  const c = await consoleFor(t);
  const shared = await c.run(['session', 'herdr', 'cccc0003']);
  assert.equal(shared.code, EXIT.refused);
  assert.match(shared.err, /a shared session: the command line can add to Herdr only your own/);
  c.sessions.find((s) => s.id === 'aaaa0001').taintedAt = iso(T0);
  const tainted = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(tainted.code, EXIT.refused);
  assert.match(tainted.err, /has seen production data/);
  assert.equal(c.hc.added().length, 0);

  const unreachable = await consoleFor(t, { hc: fakeHc({ addFails: 'the via command exited 255: woodshed: the session is not running' }) });
  const cut = await unreachable.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(cut.code, EXIT.failed);
  assert.match(cut.lines.at(-1).error, /hc could not add woodshed-aaaa0001: the via command exited 255/);
});

test('session new --herdr starts a session and adds it to Herdr once it runs', async (t) => {
  const c = await consoleFor(t, { script: [...START, { status: 'running', state: 'working' }] });
  const out = await c.run(['session', 'new', '--herdr', '--json', 'fix the login bug']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(out.lines.map((l) => l.event).filter((e) => e !== 'step' && e !== 'status'), ['started', 'running', 'connected']);
  assert.equal(out.lines.at(-1).machine.name, 'woodshed-dddd0004');
  assert.equal(c.hc.added().length, 1);
  const noWait = await c.run(['session', 'new', '--herdr', '--no-wait', 'go']);
  assert.equal(noWait.code, EXIT.failed);
  assert.match(noWait.err, /--herdr waits for the session to run/);
});

test('session remove forgets the session\'s machine in hc too', async (t) => {
  const c = await consoleFor(t, { script: [...START, { status: 'running', state: 'working' }] });
  assert.equal((await c.run(['session', 'herdr', 'bbbb0002'])).code, EXIT.done);
  const out = await c.run(['session', 'remove', 'bbbb0002', '--yes']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.match(out.out, /Removed session bbbb0002\.\nForgot woodshed-bbbb0002 in Herdr\.\n$/);
  assert.equal(c.hc.machines.size, 0);

  // A machine of that name the person made, to somewhere else, is theirs: it stays.
  const theirs = await consoleFor(t);
  theirs.hc.machines.set('woodshed-bbbb0002', { name: 'woodshed-bbbb0002', target: 'ssh woodshed-box', via: true, state: 'connected' });
  const kept = await theirs.run(['session', 'remove', 'bbbb0002', '--yes', '--json']);
  assert.deepEqual(kept.lines.at(-1).machine, { name: 'woodshed-bbbb0002', removed: false });
  assert.ok(theirs.hc.machines.has('woodshed-bbbb0002'));

  const none = await consoleFor(t, { hc: fakeHc({ missing: true }) });
  const removed = await none.run(['session', 'remove', 'bbbb0002', '--yes', '--json']);
  assert.equal(removed.code, EXIT.done, 'no hc here: nothing to forget');
  assert.deepEqual(removed.lines, [{ event: 'removed', id: 'bbbb0002', machine: null }]);

  // hc that cannot list its machines: the session is removed, and the person is told to check before forgetting one.
  const broken = fakeHc();
  const run = broken.run;
  broken.run = async (args) => (args[1] === 'ls' ? { code: 1, stdout: '', stderr: 'core not running\n' } : run(args));
  const unsure = await consoleFor(t, { hc: broken });
  const out2 = await unsure.run(['session', 'remove', 'bbbb0002', '--yes']);
  assert.equal(out2.code, EXIT.done, 'the session is removed all the same');
  assert.match(out2.err, /hc machine ls failed: core not running\. If hc machine ls shows woodshed-bbbb0002 reached by woodshed tunnel bbbb0002, forget it with: hc machine rm woodshed-bbbb0002\n/);
});

// The session's terminal as `session connect` sees each connection end: closed by its side, detached here, refused, never
// reached, or cut once it was open. Each call is kept, and moves the next of `ends`.
function fakeTerminal(ends, { during = () => {} } = {}) {
  const calls = [];
  const run = async (session, kind) => {
    calls.push([session, kind]);
    during(calls.length);
    return ends.shift() ?? { status: 'closed', code: 1000 };
  };
  return { run, calls };
}

test('session connect puts this terminal on the session\'s agent, or with --shell its shell, until one side ends it', async (t) => {
  const terminal = fakeTerminal([{ status: 'closed', code: 1000 }, { status: 'detached' }]);
  const c = await consoleFor(t, { terminal });
  const out = await c.run(['session', 'connect', 'aaaa0001']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.match(out.err, /^Connecting to aaaa0001's claude's terminal\. Ctrl-\\ disconnects; the session goes on\.\n\r\nConnection to aaaa0001 closed\.\n$/);
  const shell = await c.run(['session', 'connect', 'aaaa0001', '--shell']);
  assert.equal(shell.code, EXIT.done);
  assert.match(shell.err, /aaaa0001's shell/);
  assert.deepEqual(terminal.calls, [['aaaa0001', 'term'], ['aaaa0001', 'shell']]);
  assert.ok(!c.calls.some(([kind]) => kind === 'resume'));
});

test('session connect resumes a paused session first, and session new --connect starts one and connects', async (t) => {
  const terminal = fakeTerminal([]);
  const c = await consoleFor(t, { terminal, script: [...START, { status: 'running', state: 'working' }] });
  const resumed = await c.run(['session', 'connect', 'bbbb0002']);
  assert.equal(resumed.code, EXIT.done, resumed.err);
  assert.deepEqual(c.calls.find(([kind]) => kind === 'resume'), ['resume', { owner: 'mia-dev', id: 'bbbb0002' }]);
  assert.match(resumed.out, /Session bbbb0002 is running/);
  const started = await c.run(['session', 'new', '--connect', 'fix the login bug']);
  assert.equal(started.code, EXIT.done, started.err);
  assert.deepEqual(terminal.calls, [['bbbb0002', 'term'], ['dddd0004', 'term']]);
  assert.match((await c.run(['session', 'new', '--connect', '--no-wait', 'go'])).err, /--connect waits for the session to run/);
  assert.match((await c.run(['session', 'new', '--connect', '--herdr', 'go'])).err, /pick one/);
});

test('a connection that drops is opened again while the session runs, and not once it stopped', async (t) => {
  const again = fakeTerminal([{ status: 'attached-then-cut', message: 'no answer in 30 s' }, { status: 'unreachable', message: 'could not reach it' }]);
  const c = await consoleFor(t, { terminal: again });
  const out = await c.run(['session', 'connect', 'aaaa0001']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.match(out.err, /the connection to aaaa0001 dropped \(no answer in 30 s\); connecting again/);
  assert.equal(again.calls.length, 3, 'cut, a try that failed, then open until it closed');

  const stopping = fakeTerminal([{ status: 'attached-then-cut', message: 'the connection closed' }], {
    during: () => {
      stopped.listFailures.push(502);
      stopped.sessions.find((s) => s.id === 'aaaa0001').status = 'stopped';
    },
  });
  const stopped = await consoleFor(t, { terminal: stopping });
  const gone = await stopped.run(['session', 'connect', 'aaaa0001', '--shell']);
  assert.equal(gone.code, EXIT.failed);
  assert.ok(gone.err.includes(`Session aaaa0001 is stopped now. Run woodshed session connect aaaa0001 --shell --console ${stopped.origin} to resume it and connect again.`));
  assert.equal(stopping.calls.length, 1);
});

test('session connect says why a terminal was not opened, and needs a terminal of its own', async (t) => {
  const never = await consoleFor(t, { terminal: fakeTerminal([{ status: 'unreachable', message: 'could not reach the console' }]) });
  const unreachable = await never.run(['session', 'connect', 'aaaa0001']);
  assert.equal(unreachable.code, EXIT.failed);
  assert.match(unreachable.err, /could not reach the console/);

  const refused = await consoleFor(t, { terminal: fakeTerminal([{ status: 'closed', code: 1008 }]) });
  const policy = await refused.run(['session', 'connect', 'aaaa0001']);
  assert.equal(policy.code, EXIT.failed, 'closed on an error is no clean end');
  assert.match(policy.err, /closed by the session's terminal with 1008/);

  const ended = await consoleFor(t, { terminal: fakeTerminal([{ status: 'refused', http: 401, message: 'the token was revoked' }]) });
  assert.equal((await ended.run(['session', 'connect', 'aaaa0001'])).code, EXIT.waiting);

  const terminal = fakeTerminal([]);
  const piped = await consoleFor(t, { tty: false, terminal });
  const noTty = await piped.run(['session', 'connect', 'bbbb0002']);
  assert.equal(noTty.code, EXIT.failed);
  assert.match(noTty.err, /needs a terminal: for a command, use woodshed tunnel <id> -- <line>/);
  assert.equal((await piped.run(['session', 'connect', 'aaaa0001', '--json'])).code, EXIT.failed);
  assert.ok(!piped.calls.length && !terminal.calls.length, 'nothing resumed, nothing opened');

  const c = await consoleFor(t, { terminal });
  assert.equal((await c.run(['session', 'connect', 'cccc0003'])).code, EXIT.refused, 'a shared session');
  c.sessions.find((s) => s.id === 'aaaa0001').taintedAt = iso(T0);
  const tainted = await c.run(['session', 'connect', 'aaaa0001']);
  assert.equal(tainted.code, EXIT.refused);
  assert.match(tainted.err, /production data/);
  assert.equal(terminal.calls.length, 0);
});

test('a connection that drops at once, again and again, is given up on a minute after the first drop', async (t) => {
  const quick = Array.from({ length: 40 }, () => ({ status: 'attached-then-cut', message: 'the connection closed', ms: 100 }));
  const terminal = fakeTerminal(quick);
  const c = await consoleFor(t, { terminal });
  const out = await c.run(['session', 'connect', 'aaaa0001', '--shell']);
  assert.equal(out.code, EXIT.failed);
  assert.match(out.err, /Could not connect to aaaa0001 again in 60 s: the connection closed/);
  assert.ok(out.err.includes(`Run woodshed session connect aaaa0001 --shell --console ${c.origin} to try again.`));
  assert.equal(out.err.match(/connecting again/g).length, 1, 'the first drop starts the minute');
  assert.match(out.err, /it dropped again at once \(the connection closed\); still trying, for up to \d+ s more/);
  assert.ok(terminal.calls.length < 15, `${terminal.calls.length} tries`);
});

test('a console out of reach while a dropped connection is opened again is tried again, not given up on', async (t) => {
  let c = null;
  const terminal = fakeTerminal([{ status: 'attached-then-cut', message: 'the connection closed', ms: 60_000 }], {
    during: (n) => {
      if (n === 1) c.listFailures.push(502, null, 503, 504);
      else assert.equal(c.listFailures.length, 0, 'checked the session again before reopening the terminal');
    },
  });
  c = await consoleFor(t, { terminal });
  const out = await c.run(['session', 'connect', 'aaaa0001']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.equal(terminal.calls.length, 2);
});

test('session connect does not start another retry at the reconnect deadline', async (t) => {
  let c;
  let droppedAt;
  const terminal = fakeTerminal([{ status: 'attached-then-cut', message: 'the connection closed' }], {
    during: () => {
      droppedAt = c.now();
      c.listFailures.push(...Array(20).fill(502));
    },
  });
  c = await consoleFor(t, { terminal });
  const out = await c.run(['session', 'connect', 'aaaa0001']);
  assert.equal(out.code, EXIT.failed);
  assert.match(out.err, /Could not connect to aaaa0001 again in 60 s: .* answered 502/);
  assert.equal(c.now() - droppedAt, 60_000, 'the last wait ends at the deadline');
  assert.equal(c.listFailures.length, 10, 'no status check starts at the deadline');
  assert.equal(terminal.calls.length, 1);
});

// Run from a Herdr terminal here, t4, as a local agent runs the command line.
const IN_HERDR = { HC_TERMINAL_ID: 't4' };

test('session new --herdr --parent makes its agent\'s terminal from here, a child of this terminal that outlives it', async (t) => {
  const hc = fakeHc({ waiting: true });
  const c = await consoleFor(t, { hc, env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  const out = await c.run(['session', 'new', '--herdr', '--parent', '--json', 'fix the login bug']);
  assert.equal(out.code, EXIT.done, out.err);
  const [, args] = c.calls.find(([kind]) => kind === 'start');
  assert.equal(args.herdrParent, true, 'the console is told the session waits for its terminal');
  assert.equal(args.prompt, 'fix the login bug');
  // The terminal the entrypoint makes with no parent: a kept shell named claude, in the checkout the session named.
  assert.deepEqual(hc.runs, [{ args: ['run', '--json', '--bg', '--on', 'woodshed-dddd0004', '--keep', '--name', 'claude', '--cwd', '/work/app', '--outlive-parent'], env: { HC_TERMINAL_ID: 't4' } }]);
  assert.ok(hc.calls.findIndex((a) => a[0] === 'machine' && a[1] === 'add') < hc.calls.findIndex((a) => a[0] === 'run'), 'once the machine is there');
  const connected = out.lines.at(-1);
  assert.equal(connected.event, 'connected');
  assert.deepEqual(connected.parent, { made: true, terminal: 't4', address: 'woodshed-dddd0004/t1', outlives: true, notify: true });

  const text = await consoleFor(t, { hc: fakeHc({ waiting: true }), env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  const said = await text.run(['session', 'new', '--herdr', '--parent', 'go']);
  assert.equal(said.code, EXIT.done, said.err);
  assert.match(said.out, /Its agent's terminal woodshed-dddd0004\/t1 is a child of t4 here, and outlives it: hc wait --children any wakes t4 when it ends a turn, blocks, errors or exits\.\n/);
});

test('--parent names another terminal here, and --no-notify and --end-with-parent pass to hc', async (t) => {
  const hc = fakeHc({ waiting: true });
  const c = await consoleFor(t, { hc, env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  const out = await c.run(['session', 'new', '--herdr', '--parent=boss', '--no-notify', '--end-with-parent', '--json', 'go']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(hc.runs[0].args.slice(-1), ['--no-notify'], 'no --outlive-parent: it ends with its parent, hc\'s default');
  assert.deepEqual(hc.runs[0].env, { HC_TERMINAL_ID: 't9' }, 'boss, by its address here');
  assert.deepEqual(out.lines.at(-1).parent, { made: true, terminal: 't9', address: 'woodshed-dddd0004/t1', outlives: false, notify: false });
});

test('--parent is refused before anything starts outside a Herdr terminal, for a terminal not here, or without --herdr', async (t) => {
  const outside = await consoleFor(t, { hc: fakeHc({ waiting: true }) });
  const noTerminal = await outside.run(['session', 'new', '--herdr', '--parent', '--json', 'go']);
  assert.equal(noTerminal.code, EXIT.refused);
  assert.equal(noTerminal.lines.at(-1).status, 'no-parent');
  assert.match(noTerminal.lines.at(-1).error, /needs this command line to run in a Herdr terminal \(HC_TERMINAL_ID is not set\)/);
  assert.ok(!outside.calls.length, 'nothing started');

  const c = await consoleFor(t, { hc: fakeHc({ waiting: true }), env: IN_HERDR });
  const remote = await c.run(['session', 'new', '--herdr', '--parent=woodshed-aaaa0001/t1', 'go']);
  assert.equal(remote.code, EXIT.refused);
  assert.match(remote.err, /--parent names a terminal on this computer, and woodshed-aaaa0001\/t1 is on a machine/);
  const unknown = await c.run(['session', 'new', '--herdr', '--parent=nope', 'go']);
  assert.equal(unknown.code, EXIT.refused);
  assert.match(unknown.err, /hc found no terminal nope here/);
  assert.match((await c.run(['session', 'new', '--parent', 'go'])).err, /--parent makes the agent's terminal in Herdr: add --herdr/);
  assert.match((await c.run(['session', 'new', '--herdr', '--no-notify', 'go'])).err, /--no-notify goes with --parent/);
  assert.match((await c.run(['session', 'herdr', 'aaaa0001', '--end-with-parent'])).err, /--end-with-parent goes with --parent/);
  assert.ok(!c.calls.length, 'nothing started');
});

test('session herdr --parent resumes a paused session waiting for its terminal, and cannot give a running one a parent', async (t) => {
  const hc = fakeHc({ waiting: true });
  const c = await consoleFor(t, { hc, env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  const out = await c.run(['session', 'herdr', 'bbbb0002', '--parent', '--json']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(c.calls.find(([kind]) => kind === 'resume'), ['resume', { owner: 'mia-dev', id: 'bbbb0002', herdrParent: true }]);
  assert.equal(out.lines.at(-1).parent.made, true);
  assert.equal(hc.runs[0].args[4], 'woodshed-bbbb0002');

  // Running, its terminal there with no parent: the machine is added all the same, and the exit says the parent was not.
  const running = await consoleFor(t, { env: IN_HERDR });
  const late = await running.run(['session', 'herdr', 'aaaa0001', '--parent', '--json']);
  assert.equal(late.code, EXIT.failed);
  assert.equal(running.hc.added().length, 1);
  assert.deepEqual(late.lines.find((l) => l.event === 'connected').parent, { made: false, why: 'not-waiting' });
  assert.match(late.lines.at(-1).error, /Its agent's terminal was already there, with no parent: hc gives a terminal its parent only as it starts\. Run woodshed session new --herdr --parent/);
  assert.equal(running.hc.runs.length, 0, 'no second terminal, and the running agent is left as it is');
  assert.ok(!running.calls.length, 'not resumed or restarted');

  // Its wait ran out as this was on its way: the session made the terminal itself.
  const raced = await consoleFor(t, { hc: fakeHc({ waiting: true, taken: true }), env: IN_HERDR });
  const lost = await raced.run(['session', 'herdr', 'aaaa0001', '--parent']);
  assert.equal(lost.code, EXIT.failed);
  assert.match(lost.err, /was started by the session itself, its wait for this one over, with no parent/);
});

test('--parent takes the next word as its terminal only when it reads as an hc address', () => {
  const fail = (m) => new Error(m);
  assert.deepEqual(parseSessionArgs('new', ['--herdr', '--parent', 't4', 'fix', 'it'], fail), { herdr: true, parent: 't4', prompt: 'fix it' });
  assert.deepEqual(parseSessionArgs('new', ['--herdr', '--parent', 'fix', 'it'], fail), { herdr: true, parent: true, prompt: 'fix it' });
  assert.deepEqual(parseSessionArgs('herdr', ['--parent=boss', 'aaaa0001'], fail), { parent: 'boss', id: 'aaaa0001' });
  assert.deepEqual(parseSessionArgs('herdr', ['aaaa0001', '--parent'], fail), { parent: true, id: 'aaaa0001' });
  assert.throws(() => parseSessionArgs('new', ['--parent=', 'go'], fail), /--parent= needs a terminal/);
});
