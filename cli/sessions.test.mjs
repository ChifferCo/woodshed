import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { pauseText, stateOf } from './sessions.mjs';
import { EXIT, main } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const T0 = Date.parse('2026-11-20T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A console's real handler and command line sign-in over a made-up fleet: mia-dev's sessions, octocat's, and shared
// ones. A session the fleet starts or resumes takes the next of `script`'s steps each time the list is read, as a start
// moves while the command line waits. The command line is signed in as mia-dev before each test.
async function consoleFor(t, { script = [], refuse = null, claudeToken = true } = {}) {
  let clock = T0;
  const now = () => clock;
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now });
  const base = { repo: 'acme/app', project: 'app', createdAt: iso(T0 - 3_600_000), startedAt: iso(T0 - 3_600_000), options: { agent: 'claude' }, token: 'statusd-secret' };
  const sessions = [
    { ...base, id: 'aaaa0001', owner: 'mia-dev', title: 'Fix the login bug', status: 'running', state: 'working', branch: 'woodshed/aaaa0001' },
    { ...base, id: 'bbbb0002', owner: 'mia-dev', title: 'Paused one', status: 'stopped', stopReason: 'idle for 2 h', limits: { lifetimeHours: 6 } },
    { ...base, id: 'eeee0005', owner: 'octocat', title: 'Octocat\'s own', status: 'running', state: 'working' },
    { ...base, id: 'cccc0003', owner: null, title: 'Shared \x1b]0;pwned\x07work', status: 'running', state: 'needs-you', assignee: 'octocat', kept: true },
    { ...base, id: 'ffff0006', owner: null, title: 'Long done', status: 'stopped', kept: false, cleanedAt: iso(T0) },
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
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    startPrivate: async (args) => {
      calls.push(['start', args]);
      if (refuse) throw Object.assign(new Error(refuse), { shown: true });
      const s = { ...base, id: 'dddd0004', owner: args.owner, title: args.prompt, status: 'queued', startedAt: null, startSteps: null, options: { agent: args.agent, model: args.model } };
      sessions.push(s);
      moving.set(s.id, script.map((step) => ({ ...step })));
      return s;
    },
    resumePrivate: async ({ owner, id }) => {
      calls.push(['resume', { owner, id }]);
      const s = sessions.find((x) => x.id === id && x.owner === owner);
      Object.assign(s, { status: 'queued', stopReason: null, startedAt: null, startSteps: null });
      moving.set(id, script.map((step) => ({ ...step })));
      return s;
    },
    removePrivateSession: async ({ owner, id }) => {
      calls.push(['remove', { owner, id }]);
      sessions.splice(sessions.findIndex((x) => x.id === id && x.owner === owner), 1);
    },
    stop: async (session, reason, { by }) => {
      calls.push(['stop', { id: session.id, by }]);
      session.status = 'stopping';
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
    view: async () => ({ projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: 'app', saved: false }),
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
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      sleep: async (ms) => { clock += ms; }, now, hostname: 'mia-laptop', platform: 'test', credentials, confirm: async () => answer,
      // The person approves the code at once, as signed in to the console.
      openBrowser: (url) => { cli.decide({ code: new URL(url).searchParams.get('code'), login: 'mia-dev', approve: true }); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const signed = await run(['login', '--console', origin]);
  assert.equal(signed.code, EXIT.done, signed.err);
  return { origin, run, calls, sessions, cli, answer: (a) => { answer = a; } };
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
  const again = await c.run(['session', 'stop', 'bbbb0002']);
  assert.equal(again.code, EXIT.done);
  assert.match(again.out, /is not running: it is paused/);
  assert.equal(c.calls.length, 1, 'no second stop');

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
  assert.deepEqual(removed.lines, [{ event: 'removed', id: 'bbbb0002' }]);
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
