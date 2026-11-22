import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAppShares } from '../console/appShares.mjs';
import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { viaCommand } from './hc.mjs';
import { appText, appUrlOf, parseSessionArgs, pauseText, startCommand, stateOf, summary } from './sessions.mjs';
import { EXIT, main } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const T0 = Date.parse('2026-11-20T10:00:00Z');

// hc as `session herdr` drives it: its machines, and whether a machine has the agent's terminal. Each call is kept.
// `waiting`: the session waits for its agent's terminal from here (started with --parent), until a run makes it, or
// `taken`: the session made it itself as that run was on its way. `local`: this computer's terminals, by name.
export function fakeHc({ version = '0.1.21', missing = false, agent = true, addFails = null, waiting = false, taken = false, local = { boss: 't9' }, hasParent = null } = {}) {
  const machines = new Map();
  const labels = new Map();
  const terminals = new Map();
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
    // A terminal here, as session watch --herdr starts its own: no --on.
    if (first === 'run' && !args.includes('--on')) {
      const name = args[args.indexOf('--name') + 1];
      if (terminals.has(name)) return err('name_taken', `a live terminal is already named "${name}"`);
      terminals.set(name, args);
      return ok({ address: `t${terminals.size + 8}`, name, state: 'live' });
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
      const address = `${machine}/t1`;
      // The agent's terminal's parent as the session's core names it: the one this run gave it, or `hasParent`.
      const parent = made ? 'core1/t4' : hasParent;
      return agent ? ok({ address, name: terminal, cwd: '/work/app', state: 'live', labels: labels.get(address) ?? {}, parent }) : err('not_found', `no terminal "${terminal}"`, 3);
    }
    if (first === 'label') {
      const [, , address, ...pairs] = args;
      // As hc does: each pair sets its label, the others are kept.
      labels.set(address, { ...labels.get(address), ...Object.fromEntries(pairs.map((pair) => pair.split(/=(.*)/s).slice(0, 2))) });
      return ok({ address, labels: labels.get(address) });
    }
    return err('usage', `unexpected ${args.join(' ')}`);
  };
  return { run, calls, runs, machines, labels, terminals, added: () => calls.filter((a) => a[0] === 'machine' && a[1] === 'add') };
}

// The Herdr app's window, as `herdr-app ls` and `do space.rename|tab.rename` answer: it shows a machine's terminal in the
// space and tab its labels name, on Herdr's default names (the checkout's folder, the tab's number), once it has seen
// it `seenAfter` times. Each call is kept.
export function fakeApp(hc, { missing = false, window = true, seenAfter = 2, renameFails = null } = {}) {
  const names = new Map();
  const calls = [];
  let looks = 0;
  const run = async (args) => {
    calls.push(args);
    if (missing) return { code: null, stdout: '', stderr: '', missing: true };
    if (!window) return { code: 2, stdout: '', stderr: 'herdr-app: no Herdr window at /x/herdr-app.sock\n' };
    if (args[0] === 'ls') {
      const spaces = [];
      if (++looks >= seenAfter) {
        for (const [terminal, l] of hc.labels) {
          if (!l['herdr.space'] || !l['herdr.tab']) continue;
          const machine = terminal.split('/')[0];
          const space = `${machine}/${l['herdr.space']}`;
          const tab = `${machine}/${l['herdr.tab']}`;
          spaces.push({ id: space, name: names.get(space) ?? 'app', machine, tabs: [{ id: tab, name: names.get(tab) ?? '1', terminals: [{ terminal, pane: 'p1' }] }] });
        }
      }
      return { code: 0, stdout: `${JSON.stringify({ spaces })}\n`, stderr: '' };
    }
    const [, command, body] = args;
    if (args[0] === 'do' && ['space.rename', 'tab.rename'].includes(command)) {
      if (renameFails) return { code: 1, stdout: `${JSON.stringify({ error: renameFails })}\n`, stderr: '' };
      const { id, name } = JSON.parse(body);
      names.set(id, name);
      return { code: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    return { code: 1, stdout: `{"error":"unknown command ${command}"}`, stderr: '' };
  };
  return { run, calls, names, renamed: () => calls.filter((a) => a[0] === 'do') };
}
const iso = (ms) => new Date(ms).toISOString();

// A console's real handler and command line sign-in over a made-up fleet: mia-dev's sessions, octocat's, and shared
// ones. A session the fleet starts or resumes takes the next of `script`'s steps each time the list is read, as a start
// moves while the command line waits. The command line is signed in as mia-dev before each test.
async function consoleFor(t, { script = [], refuse = null, claudeToken = true, savedDefault = 'app', writers = null, stopTimesOut = false, hc = fakeHc(), app = fakeApp(null, { missing: true }), relativeConfig = false, tty = true, terminal = null, extra = [], onSleep = null, signal = undefined, githubSessions = null, appDomain = null, appScript = [], env = {} } = {}) {
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
    ...extra.map((s) => ({ ...base, ...s })),
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
    // As the fleet's: the session's statusd runs the project file's app.start, and the next status checks say how it
    // goes, which `appScript` plays one step per list read.
    startApp: async (session, { app = null, said = {} } = {}) => {
      if (session.status !== 'running') throw Object.assign(new Error('the session is not running'), { notRunning: true });
      if (app !== null && !session.apps?.some((a) => a.name === app)) throw Object.assign(new Error(`the project has no app named ${app}`), { refused: true });
      calls.push(['startApp', { id: session.id, app }]);
      // As statusd: no start is taken while the stop script runs, and it answers with the app still stopping.
      // `stopScript`: the list read before it still said otherwise.
      if (session.app === 'stopping' || session.stopScript) {
        said.started = false;
        return Object.assign(session, { app: 'stopping' });
      }
      said.started = true;
      // A switch from a running app with a stop command: taken, and stopping while the running one stops.
      const to = app ?? session.apps?.[0]?.name ?? null;
      const switching = to !== null && session.app === 'running' && session.appName && session.appName !== to;
      Object.assign(session, { app: switching ? 'stopping' : 'starting' }, app !== null && { appName: app });
      moving.set(session.id, appScript.map((step) => ({ ...step })));
      return session;
    },
    stopApp: async (session, { said = {} } = {}) => {
      calls.push(['stopApp', { id: session.id }]);
      // As statusd: an app with no stop command (`noStop`) is left as it is, and no stop runs.
      said.stopping = !session.noStop && session.app !== 'stopping';
      if (!session.noStop) session.app = 'stopping';
      return session;
    },
    setLimits: (s, values, by) => {
      for (const v of Object.values(values)) if (v !== null && (v < 0.5 || v > 72)) throw Object.assign(new Error('idle hours must be from 0.5 to 72'), { shown: true });
      calls.push(['limits', { id: s.id, by, values }]);
      s.limits = values;
    },
  };
  const userSettings = { view: () => ({ claudeToken: { set: claudeToken }, codexAuth: { set: true } }), refresh: async () => {}, limitsFor: () => ({ idleMs: 2 * 3_600_000, lifetimeMs: 12 * 3_600_000 }) };
  const projectAccess = {
    view: async () => ({ projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: savedDefault, saved: savedDefault !== 'app' }),
    forStart: async (login, name) => (name === undefined ? { name: 'app', repo: 'acme/app' } : ['app', 'tools'].includes(name) ? { name, repo: `acme/${name}` } : null),
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, ...(appDomain && { appDomain }) };
  // Who may see shared sessions, as People's Sessions from GitHub says; with none, everyone may.
  const members = githubSessions ? { hasGithubSessions: (login) => githubSessions.has(login), isMember: () => true, isAssignable: () => false, assignables: () => [], view: () => ({ members: [{ login: 'mia-dev' }, { login: 'octocat' }] }) } : undefined;
  // Real app shares, as the page's Share the app keeps them, on a console that serves session apps.
  const appShares = appDomain ? createAppShares({ store, now }) : null;
  const handle = createHandler({ config, fleet, auth, cli, userSettings, projectAccess, ...(members ? { members } : {}), ...(appShares && { appShares }) });
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
      sleep: async (ms) => { clock += ms; await onSleep?.(ms); }, now, signal, hostname: 'mia-laptop', platform: 'test', credentials, confirm: async () => answer,
      hc: hc.run, app: app.run, self: { node: '/usr/local/bin/node', script: '/home/mia/woodshed/cli/woodshed.mjs' },
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
  return { origin, run, calls, sessions, cli, hc, app, dir, answer: (a) => { answer = a; }, listFailures, now, appShares };
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
  assert.match(lines[0], /^ID +STATE +KIND +WHOSE +PAUSES +PROJECT +TITLE$/);
  assert.match(text.out, /aaaa0001 +working +private +mine +in 42m, idle +app +Fix the login bug/);
  assert.match(text.out, /bbbb0002 +paused +private +mine +- +app +Paused one/);
  assert.match(text.out, /cccc0003 +needs you +shared +@octocat +in 42m, idle +app +Shared  ]0;pwned work/, 'no escape code reaches the terminal');
  assert.doesNotMatch(text.out, /\x1b|\x07/);
  assert.match(text.out, /1a1a0007 +in review +shared +you /, 'the page\'s words, and yours');
  assert.match(text.out, /1b1b0008 +merged /);
  assert.match(text.out, /1c1c0009 +paused +shared +@x ]0;pwned /, 'an assignee a console made up reaches the terminal printable');
  const odd = await c.run(['session', 'get', '1c1c0009']);
  assert.match(odd.out, /State: +paused \(weird \[2J\)\nKind: +shared\nWhose: +shared, @x ]0;pwned  has it\n/);
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

test('session get and a start say whether the app runs and where it opens, on a console that serves session apps', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test', script: [{ status: 'running', state: 'working', app: 'stopped' }] });
  const port = new URL(c.origin).port;
  Object.assign(c.sessions.find((s) => s.id === 'aaaa0001'), { app: 'running', appName: 'web', apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }] });
  const got = await c.run(['session', 'get', 'aaaa0001', '--json']);
  assert.equal(got.code, EXIT.done, got.err);
  assert.deepEqual(
    [got.lines[0].session.app, got.lines[0].session.appName, got.lines[0].session.apps, got.lines[0].session.appUrl],
    ['running', 'web', ['web', 'admin'], `http://aaaa0001.apps.example.test:${port}/`],
    'on the console\'s scheme and port, as the page links it',
  );
  const text = await c.run(['session', 'get', 'aaaa0001']);
  assert.match(text.out, new RegExp(`App: {7}running \\(web\\): http://aaaa0001\\.apps\\.example\\.test:${port}/\n`));

  const paused = await c.run(['session', 'get', 'bbbb0002', '--json']);
  assert.deepEqual([paused.lines[0].session.app, paused.lines[0].session.appUrl], [null, null], 'nothing to open while it is not running');
  assert.doesNotMatch((await c.run(['session', 'get', 'bbbb0002'])).out, /App:/);

  const started = await c.run(['session', 'new', 'go']);
  assert.equal(started.code, EXIT.done, started.err);
  assert.match(started.out, /Session dddd0004 is running: .*\nIts app: not running\. Start it: woodshed session app dddd0004 start\n$/);

  // A console with no app domain and no app ports serves no session apps: nothing is said of one.
  const none = await consoleFor(t);
  none.sessions.find((s) => s.id === 'aaaa0001').app = 'running';
  const plain = await none.run(['session', 'get', 'aaaa0001', '--json']);
  assert.deepEqual([plain.lines[0].session.app, plain.lines[0].session.appUrl], [null, null]);
  const refused = await none.run(['session', 'app', 'aaaa0001', 'start']);
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.err, /serves no session apps/);
  assert.equal(none.calls.length, 0);
});

test('session app starts a running session\'s app and waits until it is up, and stops it', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'starting' }, { app: 'stopped' }, { app: 'frontend-down' }, { app: 'running' }] });
  const s = c.sessions.find((x) => x.id === 'aaaa0001');
  s.app = 'stopped';
  const asked = await c.run(['session', 'app', 'aaaa0001']);
  assert.equal(asked.code, EXIT.done, asked.err);
  assert.match(asked.out, /^Its app: not running\. Start it: woodshed session app aaaa0001 start\n$/);

  const up = await c.run(['session', 'app', 'aaaa0001', 'start', '--json']);
  assert.equal(up.code, EXIT.done, up.err);
  assert.deepEqual(c.calls.at(-1), ['startApp', { id: 'aaaa0001', app: null }]);
  assert.deepEqual(up.lines.map((l) => l.event), ['app-starting', 'app-running'], 'stopped and half up in between are waited through');
  assert.match(up.lines.at(-1).session.appUrl, /^http:\/\/aaaa0001\.apps\.example\.test:\d+\/$/);
  assert.equal(up.lines.at(-1).session.appLink, 'domain', 'opens signed in to the console, and Share the app shares it');

  s.apps = [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }];
  const picked = await c.run(['session', 'app', 'aaaa0001', 'start', '--app', 'admin', '--no-wait']);
  assert.equal(picked.code, EXIT.done, picked.err);
  assert.deepEqual(c.calls.at(-1), ['startApp', { id: 'aaaa0001', app: 'admin' }]);
  assert.match(picked.out, /Starting session aaaa0001's app \(admin\): one to three minutes\.\n$/);
  const unknown = await c.run(['session', 'app', 'aaaa0001', 'start', '--app', 'nope']);
  assert.equal(unknown.code, EXIT.refused, 'the session\'s own refusal');
  assert.match(unknown.err, /no app named nope/);

  const stopped = await c.run(['session', 'app', 'aaaa0001', 'stop']);
  assert.equal(stopped.code, EXIT.done, stopped.err);
  assert.deepEqual(c.calls.at(-1), ['stopApp', { id: 'aaaa0001' }]);
  assert.equal((await c.run(['session', 'app', 'aaaa0001', 'stop', '--app', 'web'])).code, EXIT.failed, '--app is for start');
  const before = c.calls.length;
  const noAction = await c.run(['session', 'app', 'aaaa0001', '--app', 'admin']);
  assert.equal(noAction.code, EXIT.failed, 'not ignored with no action');
  assert.match(noAction.err, /--app picks the app to start/);
  assert.equal((await c.run(['session', 'app', 'aaaa0001', '--no-wait'])).code, EXIT.failed, '--no-wait is for start');
  assert.equal((await c.run(['session', 'app', 'aaaa0001', 'stop', '--no-wait'])).code, EXIT.failed);
  const swallowed = await c.run(['session', 'app', 'aaaa0001', 'start', '--app', '--no-wait']);
  assert.equal(swallowed.code, EXIT.failed);
  assert.match(swallowed.err, /--app needs an app's name.*not --no-wait/);
  assert.equal(c.calls.length, before, 'nothing asked of the session');
});

test('session app says why it cannot start the app, and gives up on one that does not come up', async (t) => {
  const failing = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'starting' }, { app: 'failed' }] });
  failing.sessions.find((x) => x.id === 'aaaa0001').app = 'stopped';
  const failed = await failing.run(['session', 'app', 'aaaa0001', 'start']);
  assert.equal(failed.code, EXIT.failed);
  assert.match(failed.out, /its start failed\. Its log is \/tmp\/woodshed-app\.log in the session/);

  const slow = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'starting' }] });
  const t0 = slow.now();
  const late = await slow.run(['session', 'app', 'aaaa0001', 'start', '--json']);
  assert.equal(late.code, EXIT.failed);
  assert.equal(late.lines.at(-1).event, 'app-not-up');
  assert.ok(slow.now() - t0 >= 300_000, 'it waited the five minutes');

  const c = await consoleFor(t, { appDomain: 'apps.example.test' });
  c.sessions.find((x) => x.id === 'aaaa0001').app = 'none';
  const none = await c.run(['session', 'app', 'aaaa0001', 'start', '--json']);
  assert.equal(none.code, EXIT.waiting, 'Set up app is the person\'s, on the page');
  assert.match(none.lines.at(-1).error, /names no app yet\. Set up app on http:\/\/localhost:\d+\/s\/aaaa0001/);
  const paused = await c.run(['session', 'app', 'bbbb0002', 'start']);
  assert.equal(paused.code, EXIT.refused);
  assert.match(paused.err, /Its app runs only while it does: woodshed session resume bbbb0002 first/);
  assert.equal(c.calls.length, 0, 'nothing asked of a session that cannot start its app');
  assert.equal((await c.run(['session', 'app', 'aaaa0001', 'restart'])).code, EXIT.failed);
  assert.equal((await c.run(['session', 'app'])).code, EXIT.failed);
});

test('a start right after a stop, while the stop script runs, is not taken: session app says so and when to try again', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'running' }] });
  const s = c.sessions.find((x) => x.id === 'aaaa0001');
  s.app = 'running';
  assert.equal((await c.run(['session', 'app', 'aaaa0001', 'stop'])).code, EXIT.done);
  // The list still says running, as it can until the next status check: the console's answer says stopping.
  Object.assign(s, { app: 'running', stopScript: true });
  const raced = await c.run(['session', 'app', 'aaaa0001', 'start', '--json']);
  assert.equal(raced.code, EXIT.failed, raced.err);
  assert.ok(!raced.lines.some((l) => l.event === 'app-starting'), 'never says it is starting');
  assert.match(raced.lines.at(-1).error, /still stopping, so it was not started\. Try again in a few seconds, once `woodshed session app aaaa0001` says it is not running/);

  // Seen stopping in the list already: refused before anything is asked.
  Object.assign(s, { app: 'stopping', stopScript: false });
  const before = c.calls.length;
  const early = await c.run(['session', 'app', 'aaaa0001', 'start']);
  assert.equal(early.code, EXIT.failed);
  assert.match(early.err, /still stopping/);
  assert.equal(c.calls.length, before, 'nothing asked of the session');
});

test('a switch to another app, queued behind the running one\'s stop, is waited for; a stop with no stop command says so', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'stopping' }, { app: 'starting' }, { app: 'running' }] });
  const s = c.sessions.find((x) => x.id === 'aaaa0001');
  Object.assign(s, { app: 'running', appName: 'web', apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }] });
  const switched = await c.run(['session', 'app', 'aaaa0001', 'start', '--app', 'admin']);
  assert.equal(switched.code, EXIT.done, switched.err);
  assert.match(switched.out, /^Switching session aaaa0001's app \(admin\): the running one stops first/);
  assert.match(switched.out, /Its app is up: /);

  Object.assign(s, { app: 'running', noStop: true });
  const noStop = await c.run(['session', 'app', 'aaaa0001', 'stop', '--json']);
  assert.equal(noStop.code, EXIT.refused, noStop.err);
  assert.ok(!noStop.lines.some((l) => l.event === 'app-stopping'), 'never says it is stopping');
  assert.match(noStop.lines.at(-1).error, /has no stop command in the project file \(app\.stop\), so nothing was stopped/);

  Object.assign(s, { app: 'stopping', noStop: false });
  const again = await c.run(['session', 'app', 'aaaa0001', 'stop']);
  assert.equal(again.code, EXIT.done, again.err);
  assert.match(again.out, /already stopping/);

  // Back to the default with no --app: named as the default, which the console's answer does not name yet.
  Object.assign(s, { app: 'running', appName: 'admin' });
  const back = await c.run(['session', 'app', 'aaaa0001', 'start', '--no-wait']);
  assert.equal(back.code, EXIT.done, back.err);
  assert.match(back.out, /^Switching session aaaa0001's app \(web\)/m);
});

test('with several apps, another one still running is not the one asked for up', async (t) => {
  // admin's start fails before it listens, and statusd still reads web's servers, which had no stop command.
  const c = await consoleFor(t, { appDomain: 'apps.example.test', appScript: [{ app: 'running', appName: 'web' }] });
  const s = c.sessions.find((x) => x.id === 'aaaa0001');
  Object.assign(s, { app: 'stopped', appName: 'web', apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }] });
  const t0 = c.now();
  const other = await c.run(['session', 'app', 'aaaa0001', 'start', '--app', 'admin', '--json']);
  assert.equal(other.code, EXIT.failed, other.err);
  assert.ok(!other.lines.some((l) => l.event === 'app-running'), 'never says admin is up');
  assert.ok(c.now() - t0 >= 300_000, 'it waited for admin');
  assert.equal(other.lines.at(-1).event, 'app-not-up');
});

test('restart hints name the app that went down when it is not the default, and the link says where it opens', () => {
  const x = { id: 'aaaa0001', apps: ['web', 'admin'], appUrl: 'https://aaaa0001.apps.example.test/', url: 'https://c.example.test/s/aaaa0001' };
  assert.equal(startCommand({ ...x, appName: 'web' }), 'woodshed session app aaaa0001 start', 'the default needs no --app');
  assert.equal(startCommand({ ...x, appName: 'admin' }), 'woodshed session app aaaa0001 start --app admin');
  assert.equal(startCommand({ ...x, apps: ['web'], appName: 'web' }), 'woodshed session app aaaa0001 start');
  assert.equal(startCommand({ ...x, appName: "it's", apps: ['web', "it's"] }), "woodshed session app aaaa0001 start --app 'it'\\''s'");
  for (const app of ['frontend-down', 'failed', 'stopped']) assert.match(appText({ ...x, app, appName: 'admin' }), /start --app admin$/, app);
  assert.match(appText({ ...x, app: 'stopped', appName: 'web' }), /start$/);
});

test('with app ports the app opens on the port the console lent it, or through the console, which lends one', () => {
  const origin = 'http://mac.tail1.ts.net';
  const appsOn = { domain: 'mac.tail1.ts.net', ports: true };
  const s = { id: 'aaaa0001', status: 'running', app: 'running', appUrl: 'http://mac.tail1.ts.net:7701/' };
  assert.equal(appUrlOf(s, { origin, appsOn }), 'http://mac.tail1.ts.net:7701/');
  assert.equal(summary(s, { origin, login: null, appsOn }).appLink, 'port', 'opens for anyone who reaches the console, with no Share the app');
  assert.equal(summary(s, { origin, login: null, appsOn }).appSignIn, false, 'nobody signs in to a console with app ports');
  const loopback = { domain: null, ports: true, signIn: false };
  assert.equal(appUrlOf(s, { origin: 'http://[::1]:7690', appsOn: loopback }), 'http://mac.tail1.ts.net:7701/', 'app ports need no DNS name');
  assert.equal(summary(s, { origin: 'http://[::1]:7690', login: null, appsOn: loopback }).app, 'running');
  assert.equal(appUrlOf(s, { origin, appsOn: { domain: null, ports: false } }), null, 'no domain and no ports: no session apps');
  const onDomain = { id: 'aaaa0001', status: 'running', app: 'running' };
  const domainOn = (signIn) => summary(onDomain, { origin: 'https://c.example.test', login: null, appsOn: { domain: 'apps.example.test', ports: false, signIn } });
  assert.deepEqual([domainOn(true).appSignIn, domainOn(false).appSignIn, domainOn(null).appSignIn], [true, false, null], 'as the console says, or null from one that does not');
  assert.equal(domainOn(false).appLink, 'domain');
  assert.equal(appUrlOf({ ...s, app: 'stopped', appUrl: null }, { origin, appsOn }), 'http://mac.tail1.ts.net/auth/app?id=aaaa0001&next=/');
  assert.equal(appUrlOf({ ...s, appUrl: 'javascript:alert(1)' }, { origin, appsOn }), 'http://mac.tail1.ts.net/auth/app?id=aaaa0001&next=/', 'only a web link');
  assert.equal(appUrlOf({ ...s, app: 'none' }, { origin, appsOn }), null);
  assert.equal(appUrlOf({ ...s, kind: 'ask' }, { origin, appsOn }), null, 'a question from Slack has no app');
  assert.equal(appUrlOf(s, { origin: 'https://console.example.test', appsOn: { domain: 'apps.example.test', ports: false } }), 'https://aaaa0001.apps.example.test/');
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

test('session list names Herdr machines of sessions gone from the console, and prune forgets only those', async (t) => {
  const c = await consoleFor(t);
  // This command line's own line to a session on this console, as session herdr writes it.
  const ours = (session, origin = c.origin) => viaCommand({ node: '/usr/local/bin/node', script: '/home/mia/woodshed/cli/woodshed.mjs', origin, session, configHome: c.dir });
  const machine = (name, target, more = {}) => c.hc.machines.set(name, { name, target, via: true, temporary: false, state: 'unreachable', ...more });
  machine('woodshed-aaaa0001', ours('aaaa0001'), { state: 'connected' });
  machine('woodshed-bbbb0002', ours('bbbb0002'));
  machine('woodshed-ffff0006', ours('ffff0006'));
  machine('woodshed-9999aaaa', ours('9999aaaa'));
  machine('woodshed-8888bbbb', ours('8888bbbb', 'https://other-console.example'));
  machine('woodshed-7777cccc', 'mia@dev-box', { via: false });
  machine('woodshed-6666dddd', ours('9999aaaa'));
  machine('woodshed-5555eeee', 'docker exec -i box sh -c');
  machine('dev-box', 'mia@dev-box', { via: false, state: 'connected' });
  const before = [...c.hc.machines.keys()];

  const text = await c.run(['session', 'list']);
  assert.equal(text.code, EXIT.done, text.err);
  assert.match(text.out, /aaaa0001 +working/);
  assert.ok(text.out.endsWith(`\nHerdr still has a machine of a session no longer on ${c.origin}: woodshed-9999aaaa. Forget it with: woodshed session prune\n`), text.out);
  const json = await c.run(['session', 'list', '--json']);
  assert.deepEqual(json.lines[0].herdrLeftovers, ['woodshed-9999aaaa'], 'not a paused, a stopped or a deleted session still listed; not another console\'s, an ssh or docker one, or one whose line is another session\'s');
  assert.deepEqual([...c.hc.machines.keys()], before, 'list forgets nothing');
  assert.ok(!c.hc.calls.some((a) => a[1] === 'rm'));

  const pruned = await c.run(['session', 'prune', '--json']);
  assert.equal(pruned.code, EXIT.done, pruned.err);
  assert.deepEqual(pruned.lines, [{ event: 'pruned', forgot: ['woodshed-9999aaaa'], failed: [] }]);
  assert.deepEqual([...c.hc.machines.keys()], before.filter((n) => n !== 'woodshed-9999aaaa'));
  assert.deepEqual(c.hc.calls.filter((a) => a[1] === 'rm'), [['machine', 'rm', '--json', 'woodshed-9999aaaa']]);

  const again = await c.run(['session', 'prune']);
  assert.equal(again.code, EXIT.done);
  assert.equal(again.out, `Herdr has no machine of a session no longer on ${c.origin}.\n`);
  assert.doesNotMatch((await c.run(['session', 'list'])).out, /Herdr still has/);
  assert.equal((await c.run(['session', 'list', '--json'])).lines[0].herdrLeftovers.length, 0);

  // Two gone at once, said in the plural.
  machine('woodshed-9999aaab', ours('9999aaab'));
  machine('woodshed-9999aaac', ours('9999aaac'));
  assert.match((await c.run(['session', 'list'])).out, /Herdr still has 2 machines of sessions no longer on .*: woodshed-9999aaab, woodshed-9999aaac\. Forget them with: woodshed session prune\n$/);
  assert.equal((await c.run(['session', 'prune', 'aaaa0001'])).code, EXIT.failed, 'prune takes no session id');
});

test('session list says nothing of Herdr with no hc, or one that cannot list its machines, and prune touches nothing', async (t) => {
  const none = await consoleFor(t, { hc: fakeHc({ missing: true }) });
  const list = await none.run(['session', 'list', '--json']);
  assert.equal(list.code, EXIT.done);
  assert.equal(list.lines[0].herdrLeftovers, undefined);
  const prune = await none.run(['session', 'prune']);
  assert.equal(prune.code, EXIT.done);
  assert.match(prune.out, /No hc on your PATH: there is no machine in Herdr to forget/);

  const hc = fakeHc();
  const broken = { ...hc, run: async (args) => (args[0] === 'machine' ? { code: 1, stdout: '', stderr: 'core not running\n' } : hc.run(args)) };
  const c = await consoleFor(t, { hc: broken });
  const text = await c.run(['session', 'list']);
  assert.equal(text.code, EXIT.done, 'the list is still shown');
  assert.doesNotMatch(text.out, /Herdr/);
  const failed = await c.run(['session', 'prune']);
  assert.equal(failed.code, EXIT.failed);
  assert.match(failed.err, /hc machine ls failed: core not running/);
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
  assert.deepEqual(c.hc.labels.get(connected.agent.address), { 'herdr.space': 'woodshed-aaaa0001', 'herdr.tab': 'woodshed-aaaa0001-agent' });
  assert.equal(connected.session.id, 'aaaa0001');
  assert.ok(!c.calls.some(([kind]) => kind === 'resume'), 'a running session is not resumed');

  const again = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.equal(again.code, EXIT.done, again.err);
  assert.match(again.out, /woodshed-aaaa0001 was already in Herdr, connected\.\nIts agent is woodshed-aaaa0001\/t1: hc attach woodshed-aaaa0001\/t1\n/);
  assert.equal(c.hc.added().length, 1, 'connected through the same line: left alone');
  assert.equal(c.hc.calls.filter(([command]) => command === 'label').length, 1, 'the existing space and tab are kept');

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

test('session herdr names the agent\'s space after the session and its tab after the agent, never over the person\'s names', async (t) => {
  const hc = fakeHc();
  const app = fakeApp(hc);
  const c = await consoleFor(t, { hc, app });
  const out = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(out.lines[0].agent, { inHerdr: true, address: 'woodshed-aaaa0001/t1', named: { space: 'Fix the login bug', tab: 'claude' } });
  assert.deepEqual(app.renamed(), [
    ['do', 'space.rename', JSON.stringify({ id: 'woodshed-aaaa0001/woodshed-aaaa0001', name: 'Fix the login bug' })],
    ['do', 'tab.rename', JSON.stringify({ id: 'woodshed-aaaa0001/woodshed-aaaa0001-agent', name: 'claude' })],
  ], 'once the window showed the newly placed terminal, by the app\'s own commands');
  assert.equal(c.hc.machines.get('woodshed-aaaa0001').name, 'woodshed-aaaa0001', 'the machine keeps its name');
  assert.deepEqual(hc.labels.get('woodshed-aaaa0001/t1'), {
    'herdr.space': 'woodshed-aaaa0001', 'herdr.tab': 'woodshed-aaaa0001-agent', 'woodshed.space-name': 'Fix the login bug', 'woodshed.tab-name': 'claude',
  });

  // Run again: nothing to do. Then the console's title changes, and a later run picks it up, the tab left as it is.
  assert.equal((await c.run(['session', 'herdr', 'aaaa0001'])).out.includes('Named'), false);
  assert.equal(app.renamed().length, 2);
  c.sessions.find((x) => x.id === 'aaaa0001').title = 'Herdr session recovery fixes';
  const retitled = await c.run(['session', 'herdr', 'aaaa0001']);
  assert.match(retitled.out, /Named its Herdr space "Herdr session recovery fixes"\./);
  assert.equal(app.names.get('woodshed-aaaa0001/woodshed-aaaa0001'), 'Herdr session recovery fixes');
  assert.equal(app.renamed().length, 3);

  // The person renames both in the app: a later title never goes over their names.
  app.names.set('woodshed-aaaa0001/woodshed-aaaa0001', 'My work');
  app.names.set('woodshed-aaaa0001/woodshed-aaaa0001-agent', 'main');
  c.sessions.find((x) => x.id === 'aaaa0001').title = 'Yet another title';
  const theirs = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(theirs.code, EXIT.done);
  assert.equal(theirs.lines[0].agent.named, undefined);
  assert.equal(app.renamed().length, 3);
  assert.equal(app.names.get('woodshed-aaaa0001/woodshed-aaaa0001'), 'My work');
});

test('session herdr names a codex session\'s tab codex, leaves an untitled one\'s space on Herdr\'s name, and names a space the person placed only while it has the default', async (t) => {
  const hc = fakeHc();
  const app = fakeApp(hc, { seenAfter: 1 });
  const c = await consoleFor(t, { hc, app });
  Object.assign(c.sessions.find((x) => x.id === 'aaaa0001'), { title: null, options: { agent: 'codex' } });
  const out = await c.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(out.lines[0].agent.named, { space: null, tab: 'codex' });
  assert.equal(app.names.get('woodshed-aaaa0001/woodshed-aaaa0001'), undefined, 'no title yet: the space keeps Herdr\'s name');

  // A terminal the person had already placed in a space of their own (on Herdr's default name) is named; once they
  // have named that space, it is not.
  const placed = fakeHc();
  const mine = fakeApp(placed, { seenAfter: 1 });
  const p = await consoleFor(t, { hc: placed, app: mine });
  placed.labels.set('woodshed-aaaa0001/t1', { 'herdr.space': 'sp9', 'herdr.tab': 'tb9' });
  mine.names.set('woodshed-aaaa0001/sp9', 'Their space');
  const kept = await p.run(['session', 'herdr', 'aaaa0001', '--json']);
  assert.deepEqual(kept.lines[0].agent.named, { space: null, tab: 'claude' }, 'their space keeps its name; the tab was still on its number');
  assert.deepEqual(placed.labels.get('woodshed-aaaa0001/t1')['herdr.space'], 'sp9', 'their layout is kept');
});

test('session herdr names nothing, and still succeeds, with no herdr-app, no window, or a rename the app refuses', async (t) => {
  for (const [opts, words] of [[{ missing: true }, null], [{ window: false }, null], [{ renameFails: 'no such space', seenAfter: 1 }, /Could not name its Herdr space or tab: herdr-app space\.rename: no such space/]]) {
    const hc = fakeHc();
    const app = fakeApp(hc, opts);
    const c = await consoleFor(t, { hc, app });
    const out = await c.run(['session', 'herdr', 'aaaa0001']);
    assert.equal(out.code, EXIT.done, JSON.stringify(opts));
    assert.match(out.out, /woodshed-aaaa0001 is in Herdr/);
    assert.doesNotMatch(out.out, /Named/);
    if (words) assert.match(out.out, words);
    else assert.doesNotMatch(out.out, /Could not name/, 'quietly');
    assert.equal(app.calls.filter((a) => a[0] === 'ls').length, 1, 'asked once, not waited on');
  }
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

// Review and QA runs the console started on pull requests (pullRequests.review and .qa with runner: woodshed): shared,
// with nobody assigned, started as the pull request's author or the QA label's.
const PULL_RUNS = [
  { id: '7e7e0010', owner: null, kind: 'pr', number: 145, trigger: 'review', startedBy: 'mia-dev', title: 'Review: Fix the login bug', status: 'running', state: 'working', review: { base: 'main', sha: 'f00d145' } },
  { id: '7f7f0011', owner: null, kind: 'pr', number: 144, trigger: 'review', startedBy: 'octocat', title: 'Review: Pin a session', status: 'stopped', stopReason: 'Review finished: APPROVE', review: { base: 'main', sha: 'f00d144', conclusion: 'APPROVE', reported: true } },
  { id: '9a9a0012', owner: null, kind: 'pr', number: 146, trigger: 'qa', startedBy: 'octocat', title: 'QA: Make the App optional', status: 'running', state: 'working', qa: { base: 'main', sha: 'beef146' } },
  { id: 'a5a50013', owner: null, kind: 'ask', number: null, trigger: 'slack', startedBy: 'octocat', title: 'How do labels work?', status: 'running', state: 'done' },
];

test('session list, get and --json name review and QA runs, and the pull request each is for', async (t) => {
  const c = await consoleFor(t, { extra: PULL_RUNS });
  const text = await c.run(['session', 'list']);
  assert.equal(text.code, EXIT.done, text.err);
  assert.match(text.out, /7e7e0010 +working +review #145 +you +in 42m, idle +app +Review: Fix the login bug/, 'a review of your pull request is yours');
  assert.match(text.out, /9a9a0012 +working +qa #146 +@octocat +in 42m, idle +app +QA: Make the App optional/);
  assert.match(text.out, /a5a50013 +done +ask +shared /, 'a question from Slack is not a plain shared session');
  assert.doesNotMatch(text.out, /7f7f0011/, 'a finished review is not kept, so it has ended: --all lists it');
  assert.match((await c.run(['session', 'list', '--all'])).out, /7f7f0011 +stopped +review #144 +@octocat /);

  const [{ sessions }] = (await c.run(['session', 'list', '--all', '--json'])).lines;
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(byId).map(([id, s]) => [id, s.kind])),
    { aaaa0001: 'private', bbbb0002: 'private', cccc0003: 'shared', ffff0006: 'shared', '1a1a0007': 'shared', '1b1b0008': 'shared', '1c1c0009': 'shared', '7e7e0010': 'review', '7f7f0011': 'review', '9a9a0012': 'qa', a5a50013: 'ask' },
  );
  assert.deepEqual(byId['7e7e0010'].pullRequest, { number: 145, repo: 'acme/app', url: 'https://github.com/acme/app/pull/145', title: null, state: null, review: null, checks: null },
    'the pull request it was started on, in the chip\'s shape, unread');
  assert.deepEqual([byId['7e7e0010'].mine, byId['7e7e0010'].inMine, byId['7e7e0010'].shared, byId['7e7e0010'].startedBy], [false, true, true, 'mia-dev'],
    'not a private session of yours, and on your Mine as the page has it');
  assert.equal(byId['9a9a0012'].inMine, false);
  assert.equal(byId['7f7f0011'].verdict, 'APPROVE');
  assert.equal(byId['7e7e0010'].verdict, null, 'no verdict before it reports');
  assert.equal(byId['1a1a0007'].inMine, true, 'a shared session assigned to you is on Mine');
  assert.equal(byId.cccc0003.inMine, false);
  assert.equal(byId.aaaa0001.pullRequest, null);

  const one = await c.run(['session', 'get', '7f7f0011']);
  assert.equal(one.code, EXIT.done);
  assert.match(one.out, /Kind: +a review of pull request #144, started by the console\nWhose: +for @octocat\n/);
  assert.match(one.out, /Pull req\.: +https:\/\/github\.com\/acme\/app\/pull\/144\nVerdict: +APPROVE\nStopped: +Review finished: APPROVE\n/);
  assert.match((await c.run(['session', 'get', '9a9a0012'])).out, /Kind: +QA of pull request #146, started by the console\n/);
  assert.equal((await c.run(['session', 'get', '9a9a0012', '--json'])).lines[0].session.kind, 'qa');
});

test('session list shows review and QA runs only to those the console\'s page shows them to', async (t) => {
  // Shared sessions, reviews and QA among them, are for members with Sessions from GitHub on People.
  const c = await consoleFor(t, { extra: PULL_RUNS, githubSessions: new Set(['octocat']) });
  const [{ sessions }] = (await c.run(['session', 'list', '--all', '--json'])).lines;
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['aaaa0001', 'bbbb0002'], 'only their own private sessions');
});

// A watch over a fleet whose sessions move between its reads: `moves[n]` is applied before the read after the n-th wait.
async function watching(t, { extra = PULL_RUNS, moves = [], args = [], hc = undefined, env = undefined, before = null }) {
  const controller = new AbortController();
  let waits = 0;
  let c;
  c = await consoleFor(t, {
    extra,
    ...(hc ? { hc } : {}),
    ...(env ? { env } : {}),
    signal: controller.signal,
    onSleep: async () => {
      // Only the watch's own waits count: a sign-in's happen before it.
      if (!c?.watchingNow) return;
      const move = moves[waits++];
      if (move === undefined) controller.abort();
      else await move(c.sessions, c);
    },
  });
  await before?.(c);
  c.watchingNow = true;
  const out = await c.run(['session', 'watch', ...args]);
  return { ...out, c };
}

const at = (sessions, id) => sessions.find((s) => s.id === id);

test('session watch says when a review or QA run starts, needs you, finishes with its verdict, or fails', async (t) => {
  const reviewOf = (number, id, startedBy = 'mia-dev') => ({ id, owner: null, kind: 'pr', number, trigger: 'review', startedBy, title: `Review: #${number}`, status: 'queued', review: { base: 'main', sha: 'abc' } });
  const out = await watching(t, {
    args: ['--kind', 'review,qa', '--json'],
    moves: [
      // A new review is in line, then runs; QA's needs the person.
      (s) => { s.push({ ...s[0], ...reviewOf(150, 'b0b00020'), options: { agent: 'claude' } }); at(s, '9a9a0012').startedBy = 'mia-dev'; at(s, '9a9a0012').state = 'needs-you'; },
      (s) => { Object.assign(at(s, 'b0b00020'), { status: 'starting' }); },
      (s) => { Object.assign(at(s, 'b0b00020'), { status: 'running', state: 'working' }); },
      // Its turn done: a review runs by itself, so that is not told.
      (s) => { Object.assign(at(s, 'b0b00020'), { state: 'done' }); },
      // It reports, and stops: told once it has stopped, with its verdict.
      (s) => { Object.assign(at(s, 'b0b00020'), { status: 'stopping', review: { ...at(s, 'b0b00020').review, conclusion: 'REQUEST_CHANGES', reported: true } }); },
      (s) => { Object.assign(at(s, 'b0b00020'), { status: 'stopped', stopReason: 'Review finished: REQUEST_CHANGES' }); },
      // The one already running finishes; QA fails; a plain session of yours is done with its turn, which --kind leaves out.
      (s) => {
        Object.assign(at(s, '7e7e0010'), { status: 'stopped', stopReason: 'Review finished: APPROVE', review: { ...at(s, '7e7e0010').review, conclusion: 'APPROVE', reported: true } });
        Object.assign(at(s, '9a9a0012'), { status: 'failed', error: 'the session\'s databases were not ready' });
        Object.assign(at(s, 'aaaa0001'), { state: 'done' });
      },
      // Someone else's review, not on Mine.
      (s) => { s.push({ ...s[0], ...reviewOf(151, 'b1b10021', 'octocat'), status: 'running', state: 'working', options: { agent: 'claude' } }); },
    ],
  });
  assert.equal(out.code, EXIT.done, out.err);
  const [first, ...events] = out.lines;
  assert.deepEqual([first.event, first.kinds, first.everyone, first.everySeconds, first.sessions, first.login], ['watching', ['review', 'qa'], false, 15, 1, 'mia-dev'],
    'the first read tells nothing of what was already there: on Mine, only the review of mia-dev\'s pull request');
  // In the order they happened; those of one read in the list's order.
  assert.deepEqual(events.map((e) => [e.event, e.session.id]), [
    ['starting', 'b0b00020'],
    ['needs-you', '9a9a0012'],
    ['started', 'b0b00020'],
    ['finished', 'b0b00020'],
    ['failed', '9a9a0012'],
    ['finished', '7e7e0010'],
  ]);
  const finished = events.find((e) => e.event === 'finished');
  assert.deepEqual([finished.session.kind, finished.session.verdict, finished.session.pullRequest.number, finished.session.url], ['review', 'REQUEST_CHANGES', 150, `${out.c.origin}/s/b0b00020`]);
  assert.equal(events.find((e) => e.event === 'failed').session.error, 'the session\'s databases were not ready');
  assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.at))));
  assert.ok(!out.out.includes('statusd-secret'));
});

test('session watch --everyone tells others\' runs too, says done for a session with a person, and prints lines', async (t) => {
  const out = await watching(t, {
    args: ['--everyone', '--every', '30'],
    moves: [
      (s) => { Object.assign(at(s, '9a9a0012'), { status: 'stopped', qa: { ...at(s, '9a9a0012').qa, conclusion: 'success' } }); Object.assign(at(s, 'aaaa0001'), { state: 'done' }); },
      (s) => { Object.assign(at(s, 'aaaa0001'), { state: 'working' }); },
      (s) => { Object.assign(at(s, 'aaaa0001'), { state: 'needs-you' }); Object.assign(at(s, 'bbbb0002'), { status: 'running', state: 'working', stopReason: null }); },
      // Another person's private session is never seen, whatever it does.
      (s) => { Object.assign(at(s, 'eeee0005'), { state: 'needs-you' }); },
    ],
  });
  assert.equal(out.code, EXIT.done, out.err);
  const lines = out.out.trim().split('\n');
  assert.match(lines[0], /^Watching every session you can see on http:\/\/localhost:\d+, kinds: all, every 30 s\. Ctrl-C stops\.$/);
  assert.match(lines[1], /^10:00:35 {2}9a9a0012 {2}finished \(success\) {2}qa #146 {2}QA: Make the App optional {2}http:\/\/localhost:\d+\/s\/9a9a0012$/);
  assert.match(lines[2], /^10:00:35 {2}aaaa0001 {2}done {2}private {2}Fix the login bug /);
  assert.match(lines[3], /^10:01:35 {2}bbbb0002 {2}started {2}private {2}Paused one /, 'a resumed session starts again');
  assert.match(lines[4], /^10:01:35 {2}aaaa0001 {2}needs-you {2}private /);
  assert.equal(lines.length, 5);
  assert.doesNotMatch(out.out, /eeee0005/);
});

test('session watch rides out a console it cannot reach, and stops when the sign-in ends', async (t) => {
  const out = await watching(t, {
    args: ['--json'],
    moves: [
      (s, c) => { c.listFailures.push(500, null); Object.assign(at(s, 'aaaa0001'), { state: 'needs-you' }); },
      () => {},
      () => {},
    ],
  });
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(out.lines.map((l) => l.event), ['watching', 'unreachable', 'reachable', 'needs-you'], 'a 500 is the console away too: told once each way, and what changed meanwhile after');

  // Revoked on My settings: the watch says so and ends, waiting on the person to sign in again.
  const ended = await watching(t, { args: ['--json'], moves: [(s, c) => { c.cli.revokeAll('mia-dev', 'My settings'); }, () => {}] });
  assert.equal(ended.code, EXIT.waiting);
  assert.deepEqual(ended.lines.map((l) => [l.event, l.status ?? null]), [['watching', null], ['error', 'signed-out']]);
});

// A session of mia-dev's that `session herdr` made a machine: its saved line is this command line's tunnel to it.
function herdrMachine(c, id) {
  const via = viaCommand({ node: '/usr/local/bin/node', script: '/home/mia/woodshed/cli/woodshed.mjs', origin: c.origin, session: id });
  c.hc.machines.set(`woodshed-${id}`, { name: `woodshed-${id}`, target: via, via: true, temporary: false, state: 'connected' });
}

test('session watch tells your private sessions starting, running, pausing when idle, stopping at their lifetime, and failing', async (t) => {
  const out = await watching(t, {
    extra: [],
    args: ['--kind', 'private', '--json'],
    before: (c) => herdrMachine(c, 'aaaa0001'),
    moves: [
      // The one that is a machine in Herdr pauses when idle; the paused one is resumed.
      (s) => { Object.assign(at(s, 'aaaa0001'), { status: 'stopped', state: null, stopReason: 'idle for 2 h' }); Object.assign(at(s, 'bbbb0002'), { status: 'queued', stopReason: null }); },
      (s) => { Object.assign(at(s, 'bbbb0002'), { status: 'starting' }); },
      (s) => { Object.assign(at(s, 'bbbb0002'), { status: 'running', state: 'working' }); },
      (s) => { Object.assign(at(s, 'bbbb0002'), { state: 'done' }); },
      // It stops at its lifetime; a new one fails to start; octocat's own is never seen.
      (s) => {
        Object.assign(at(s, 'bbbb0002'), { status: 'stopped', state: null, stopReason: 'ran for 6 h' });
        s.push({ ...at(s, 'aaaa0001'), id: 'dddd0009', title: 'New one', status: 'queued', stopReason: null });
        Object.assign(at(s, 'eeee0005'), { status: 'stopped', stopReason: 'idle for 2 h' });
      },
      (s) => { Object.assign(at(s, 'dddd0009'), { status: 'failed', error: 'AWS has no room' }); },
      // The one you stop yourself.
      (s) => { Object.assign(at(s, 'aaaa0001'), { status: 'queued', stopReason: null }); },
      (s) => { Object.assign(at(s, 'aaaa0001'), { status: 'stopped', stoppedBy: 'mia-dev', stopReason: 'stopped by @mia-dev' }); },
    ],
  });
  assert.equal(out.code, EXIT.done, out.err);
  const [first, ...events] = out.lines;
  assert.equal(first.sessions, 2, 'your two private sessions, not octocat\'s');
  assert.deepEqual(events.map((e) => [e.session.id, e.event, e.why ?? null]), [
    ['bbbb0002', 'starting', null],
    ['aaaa0001', 'paused', 'idle'],
    ['bbbb0002', 'started', null],
    ['bbbb0002', 'done', null],
    ['dddd0009', 'starting', null],
    ['bbbb0002', 'stopped', 'lifetime'],
    ['dddd0009', 'failed', null],
    ['aaaa0001', 'starting', null],
    ['aaaa0001', 'stopped', 'person'],
  ]);
  assert.deepEqual(events[1].machine, { name: 'woodshed-aaaa0001', unreachable: true, bringBack: 'woodshed session herdr aaaa0001' },
    'its machine in Herdr is unreachable until session herdr brings it back');
  assert.equal(events[5].machine, undefined, 'one that is no machine in Herdr says nothing of one');
  assert.equal(events.at(-1).session.stoppedBy, 'mia-dev');
  assert.equal(events[6].session.error, 'AWS has no room');
});

test('session watch prints a pause, and says a machine in Herdr is unreachable until session herdr brings it back', async (t) => {
  const out = await watching(t, {
    extra: [],
    before: (c) => herdrMachine(c, 'aaaa0001'),
    moves: [(s) => { Object.assign(at(s, 'aaaa0001'), { status: 'stopped', state: null, stopReason: 'idle for 2 h' }); }],
  });
  assert.equal(out.code, EXIT.done, out.err);
  const lines = out.out.trim().split('\n');
  assert.match(lines[1], /^10:00:\d\d {2}aaaa0001 {2}paused \(idle\) {2}private {2}Fix the login bug {2}http:\/\/localhost:\d+\/s\/aaaa0001$/);
  assert.equal(lines[2], '          woodshed-aaaa0001 in Herdr is unreachable until it runs again: woodshed session herdr aaaa0001 brings it back');
});

test('session watch --herdr starts the watch in a terminal of hc\'s own, once', async (t) => {
  const c = await consoleFor(t);
  const out = await c.run(['session', 'watch', '--herdr', '--kind', 'private,review', '--every', '30', '--json']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.deepEqual(out.lines, [{ event: 'herdr', action: 'started', terminal: 'woodshed-watch', address: 't9' }]);
  const run = c.hc.calls.find((a) => a[0] === 'run');
  assert.deepEqual(run.slice(0, run.indexOf('--') + 1), ['run', '--bg', '--json', '--name', 'woodshed-watch', '--no-parent',
    '--label', 'herdr.space=woodshed', '--label', 'herdr.tab=woodshed-watch', '--']);
  assert.deepEqual(run.slice(run.indexOf('--') + 1), ['/usr/bin/env', 'WOODSHED_WATCH_IN_HERDR=1', `XDG_CONFIG_HOME=${c.dir}`,
    '/usr/local/bin/node', '/home/mia/woodshed/cli/woodshed.mjs', 'session', 'watch', '--console', c.origin,
    '--kind', 'private,review', '--every', '30', '--herdr'], 'the same watch, on this console and sign-in, as words hc runs with no shell');
  const again = await c.run(['session', 'watch', '--herdr']);
  assert.equal(again.code, EXIT.done);
  assert.match(again.out, /Herdr already has woodshed-watch watching: .*hc kill woodshed-watch/);
  assert.equal(c.hc.calls.filter((a) => a[0] === 'run').length, 2, 'asked once more, and hc kept the one it had');
});

test('session watch --herdr needs hc, as session herdr does', async (t) => {
  const c = await consoleFor(t, { hc: fakeHc({ missing: true }) });
  const out = await c.run(['session', 'watch', '--herdr']);
  assert.equal(out.code, EXIT.refused);
  assert.match(out.err, /needs its hc, 0\.1\.21 or newer, and there is no hc on your PATH/);
});

test('session watch in its Herdr terminal reports each session as an OSC 7501 record, and clears one gone', async (t) => {
  const out = await watching(t, {
    extra: [],
    args: ['--herdr'],
    env: { WOODSHED_WATCH_IN_HERDR: '1' },
    before: (c) => herdrMachine(c, 'aaaa0001'),
    moves: [
      (s) => { Object.assign(at(s, 'aaaa0001'), { state: 'needs-you' }); },
      // Answered, and at work again: told to Herdr's record alone, never as a line.
      (s) => { Object.assign(at(s, 'aaaa0001'), { state: 'working' }); },
      (s) => { Object.assign(at(s, 'aaaa0001'), { status: 'stopped', state: null, stopReason: 'ran for 12 h' }); },
      (s) => { s.splice(s.findIndex((x) => x.id === 'aaaa0001'), 1); },
    ],
  });
  assert.equal(out.code, EXIT.done, out.err);
  // eslint-disable-next-line no-control-regex
  const records = [...out.out.matchAll(/\x1b\]7501;([^\x07]*)\x07/g)].map((m) => Object.fromEntries(m[1].split(':').map((p) => {
    const [k, v] = p.split(/=(.*)/s);
    return [k, ['msg', 'title'].includes(k) ? Buffer.from(v, 'base64').toString() : v];
  })));
  assert.deepEqual(records.map((r) => [r.id, r.state, r.kind ?? null]), [['aaaa0001', 'blocked', 'question'], ['aaaa0001', 'working', null], ['aaaa0001', 'done', null], ['aaaa0001', 'clear', null]]);
  assert.doesNotMatch(out.out, /aaaa0001 {2}working/, 'no line for it');
  assert.equal(records[2].msg, 'aaaa0001 stopped (at its lifetime). woodshed-aaaa0001 in Herdr is unreachable until it runs again: woodshed session herdr aaaa0001 brings it back');
  assert.equal(records[0].title, 'Fix the login bug');
  assert.match(out.out, /^Watching your sessions \(Mine\) on .*, for Herdr\. Ctrl-C stops\.$/m, 'its terminal shows the lines too');
});

test('session watch refuses kinds and paces it does not know', async (t) => {
  const c = await consoleFor(t);
  const kind = await c.run(['session', 'watch', '--kind', 'review,bogus']);
  assert.equal(kind.code, EXIT.failed);
  assert.match(kind.err, /--kind takes private, shared, review, qa, ask, separated by commas: not bogus/);
  const fast = await c.run(['session', 'watch', '--every', '1']);
  assert.equal(fast.code, EXIT.failed);
  assert.match(fast.err, /--every is a number of seconds, from 5 to 600/);
  assert.equal((await c.run(['session', 'watch', 'extra'])).code, EXIT.failed);
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
  assert.deepEqual(connected.parent, { made: true, terminal: 't4', address: 'woodshed-dddd0004/t1', outlives: true, notify: true, reportsStatus: true });

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
  assert.deepEqual(out.lines.at(-1).parent, { made: true, terminal: 't9', address: 'woodshed-dddd0004/t1', outlives: false, notify: false, reportsStatus: true });
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
  assert.deepEqual(late.lines.find((l) => l.event === 'connected').parent, { made: false, why: 'not-waiting', there: true, has: null });
  assert.match(late.lines.at(-1).error, /Could not make t4 the parent of its agent's terminal: it was already there, with no parent, and hc gives a terminal its parent only as it starts\. Run woodshed session new --herdr --parent/);
  assert.equal(running.hc.runs.length, 0, 'no second terminal, and the running agent is left as it is');
  assert.ok(!running.calls.length, 'not resumed or restarted');

  // Its wait ran out as this was on its way: the session made the terminal itself.
  const raced = await consoleFor(t, { hc: fakeHc({ waiting: true, taken: true }), env: IN_HERDR });
  const lost = await raced.run(['session', 'herdr', 'aaaa0001', '--parent']);
  assert.equal(lost.code, EXIT.failed);
  assert.match(lost.err, /Could not make t4 the parent of its agent's terminal: it was made while this was on its way, with no parent/);

  // Already a child, of an earlier run's terminal: said as it is, never as having none.
  const earlier = await consoleFor(t, { hc: fakeHc({ hasParent: 'core1/t2' }), env: IN_HERDR });
  const again = await earlier.run(['session', 'herdr', 'aaaa0001', '--parent', '--json']);
  assert.equal(again.code, EXIT.failed);
  assert.deepEqual(again.lines.find((l) => l.event === 'connected').parent, { made: false, why: 'not-waiting', there: true, has: 'core1/t2' });
  assert.match(again.lines.at(-1).error, /it was already there, a child of core1\/t2, and hc gives/);

  // Its agent in tmux (its owner's Agent terminal, a session that never waited): no Herdr terminal at all, said so.
  const tmux = await consoleFor(t, { hc: fakeHc({ agent: false }), env: IN_HERDR });
  const inTmux = await tmux.run(['session', 'herdr', 'aaaa0001', '--parent', '--json']);
  assert.equal(inTmux.code, EXIT.failed);
  assert.deepEqual(inTmux.lines.find((l) => l.event === 'connected').parent, { made: false, why: 'not-waiting', there: false, has: null });
  assert.match(inTmux.lines.at(-1).error, /Could not make t4 the parent of its agent's terminal: the session did not wait for one, and its agent runs in tmux, not Herdr\./);
});

test('--parent takes the next word as its terminal only when it reads as an hc address', () => {
  const fail = (m) => new Error(m);
  assert.deepEqual(parseSessionArgs('new', ['--herdr', '--parent', 't4', 'fix', 'it'], fail), { herdr: true, parent: 't4', prompt: 'fix it' });
  assert.deepEqual(parseSessionArgs('new', ['--herdr', '--parent', 'fix', 'it'], fail), { herdr: true, parent: true, prompt: 'fix it' });
  assert.deepEqual(parseSessionArgs('herdr', ['--parent=boss', 'aaaa0001'], fail), { parent: 'boss', id: 'aaaa0001' });
  assert.deepEqual(parseSessionArgs('herdr', ['aaaa0001', '--parent'], fail), { parent: true, id: 'aaaa0001' });
  assert.throws(() => parseSessionArgs('new', ['--parent=', 'go'], fail), /--parent= needs a terminal/);
  assert.deepEqual(parseSessionArgs('herdr', ['--parent', 't1b', 'aaaa0001'], fail), { parent: 't1b', id: 'aaaa0001' });
  assert.deepEqual(parseSessionArgs('new', ['--herdr', '--parent', `t${'0'.repeat(40)}`], fail), { herdr: true, parent: true, prompt: `t${'0'.repeat(40)}` }, 'past hc\'s 32 characters: the prompt\'s');
});

test('a codex child wakes its parent only by exiting: the pinned codex tells Herdr nothing of its turns', async (t) => {
  const c = await consoleFor(t, { hc: fakeHc({ waiting: true }), env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  const out = await c.run(['session', 'new', '--agent', 'codex', '--herdr', '--parent', 'go']);
  assert.equal(out.code, EXIT.done, out.err);
  assert.match(out.out, /is a child of t4 here, and outlives it: hc wait --children any wakes t4 only when it exits: codex tells Herdr nothing of its turns\.\n/);
  const json = await consoleFor(t, { hc: fakeHc({ waiting: true }), env: IN_HERDR, script: [...START, { status: 'running', state: 'starting' }] });
  assert.equal((await json.run(['session', 'new', '--agent', 'codex', '--herdr', '--parent', '--json', 'go'])).lines.at(-1).parent.reportsStatus, false);
});

test('session app share shows who can open the app, switches members, makes a link once, and revokes it', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test' });
  const none = await c.run(['session', 'app', 'aaaa0001', 'share']);
  assert.equal(none.code, EXIT.done, none.err);
  assert.equal(none.out, 'Session aaaa0001\'s app, https://aaaa0001.apps.example.test/:\n  Members of this console: off\n  Links: none\n  Only you can open it.\n');

  const on = await c.run(['session', 'app', 'aaaa0001', 'share', '--members', 'on', '--json']);
  assert.equal(on.code, EXIT.done, on.err);
  assert.deepEqual([on.lines[0].event, on.lines[0].share.members], ['members', true]);
  assert.equal(c.appShares.membersOpen('aaaa0001'), true);

  const made = await c.run(['session', 'app', 'aaaa0001', 'share', '--link']);
  assert.equal(made.code, EXIT.done, made.err);
  const [linkId] = /Link ([0-9a-f]{8}) to session aaaa0001's app, for 1 day, ending 2026-11-21 10:00 UTC:/.exec(made.out).slice(1);
  const url = /\n {2}(https:\/\/aaaa0001\.apps\.example\.test\/__woodshed\/share\?t=[0-9a-f.]+)\n/.exec(made.out)?.[1];
  assert.ok(url, made.out);
  assert.match(made.out, /This link is a secret, shown only now: anyone who has it can open the app .* until it expires, you revoke it \(woodshed session app aaaa0001 share --revoke [0-9a-f]{8}\), or the session pauses or stops\. Give it to the person it is for; do not post it anywhere\.\n/);
  assert.match(made.out, /Sharing ends when the session pauses or stops \(it pauses in 42m\): woodshed session limits aaaa0001 keeps it up longer\.\n$/);

  const week = await c.run(['session', 'app', 'aaaa0001', 'share', '--link', '--hours', '168', '--path', '/landing-a', '--json']);
  assert.equal(week.code, EXIT.done, week.err);
  const [event] = week.lines;
  assert.equal(event.event, 'link');
  assert.equal(new URL(event.url).searchParams.get('next'), '/landing-a');
  assert.equal(event.path, '/landing-a');
  assert.equal(event.link.expiresAt, c.now() + 168 * 3_600_000);
  assert.equal(event.link.by, 'mia-dev');

  const home = await c.run(['session', 'app', 'aaaa0001', 'share', '--link', '--hours', '1', '--path', '/']);
  assert.equal(home.code, EXIT.done, home.err);
  assert.doesNotMatch(home.out, /does not take a page/, 'the home page is where it lands anyway');
  const homeId = /Link ([0-9a-f]{8}) /.exec(home.out)[1];
  assert.equal((await c.run(['session', 'app', 'aaaa0001', 'share', '--revoke', homeId])).code, EXIT.done);

  const listed = await c.run(['session', 'app', 'aaaa0001', 'share']);
  assert.match(listed.out, /Members of this console: on, anyone signed in to the console can open it\n/);
  assert.match(listed.out, new RegExp(` {2}Link ${linkId}: made by @mia-dev 2026-11-20 10:00 UTC, ends 2026-11-21 10:00 UTC\\n`));
  assert.ok(!listed.out.includes('t='), 'a listing never shows a link\'s token');
  const listedJson = await c.run(['session', 'app', 'aaaa0001', 'share', '--json']);
  assert.deepEqual(Object.keys(listedJson.lines[0].share.links[0]).sort(), ['by', 'createdAt', 'expiresAt', 'id']);

  const revoked = await c.run(['session', 'app', 'aaaa0001', 'share', '--revoke', linkId]);
  assert.equal(revoked.code, EXIT.done, revoked.err);
  assert.match(revoked.out, new RegExp(`^Revoked link ${linkId}: it opens nothing now\\.\\n`));
  assert.doesNotMatch(revoked.out, new RegExp(`Link ${linkId}:`));
  const again = await c.run(['session', 'app', 'aaaa0001', 'share', '--revoke', linkId]);
  assert.equal(again.code, EXIT.failed);
  assert.match(again.err, /has no live link/);

  const off = await c.run(['session', 'app', 'aaaa0001', 'share', '--members', 'off']);
  assert.equal(off.code, EXIT.done, off.err);
  assert.equal(c.appShares.membersOpen('aaaa0001'), false);
});

test('session app share refuses expiries the page does not offer, and mixed options, before asking the console', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test' });
  for (const args of [
    ['--link', '--hours', '2'], ['--link', '--hours', '0'], ['--link', '--hours', '24.0'], ['--link', '--hours', '9999'], ['--hours', '24'],
    ['--members', 'yes'], ['--members', 'on', '--link'], ['--link', '--revoke', '1a2b3c4d'], ['--revoke', 'nope'],
    ['--link', '--path', 'landing'], ['--link', '--path', '//evil.example'], ['--path', '/x'], ['--link', '--path', '/a\x1b]0;x\x07'],
    ['--link', '--app', 'web'], ['--members', 'on', '--no-wait'],
  ]) {
    const out = await c.run(['session', 'app', 'aaaa0001', 'share', ...args]);
    assert.equal(out.code, EXIT.failed, args.join(' '));
  }
  assert.match((await c.run(['session', 'app', 'aaaa0001', 'share', '--link', '--hours', '2'])).err, /--hours must be 1, 24 or 168/);
  // Share's options belong to share: with start, stop or none, they would be ignored without a word.
  for (const args of [['--members', 'on'], ['start', '--link'], ['stop', '--revoke', '1a2b3c4d'], ['--path', '/x']]) {
    const out = await c.run(['session', 'app', 'aaaa0001', ...args]);
    assert.equal(out.code, EXIT.failed, args.join(' '));
    assert.match(out.err, /is for share: woodshed session app <id> share/);
  }
  assert.equal((await c.run(['session', 'share', 'aaaa0001'])).code, EXIT.failed, 'no session share: sharing is the app\'s');
  assert.deepEqual(c.appShares.view('aaaa0001'), { members: false, links: [] }, 'nothing was made');
});

test('session app share is refused for a shared session, another person\'s, a paused one, one that saw production, and a console with no apps', async (t) => {
  const c = await consoleFor(t, { appDomain: 'apps.example.test', extra: [{ id: '7a7a0007', owner: 'mia-dev', title: 'Saw prod', status: 'running', state: 'working', taintedAt: iso(T0) }] });
  const shared = await c.run(['session', 'app', '1a1a0007', 'share', '--link', '--json']);
  assert.equal(shared.code, EXIT.refused);
  assert.match(shared.lines.at(-1).error, /shared session: the command line can share the app of only your own My Woodshed sessions/);
  const theirs = await c.run(['session', 'app', 'eeee0005', 'share']);
  assert.equal(theirs.code, EXIT.failed, 'someone else\'s private session is not on her list');
  assert.match(theirs.err, /No session eeee0005 that you can see/);
  const paused = await c.run(['session', 'app', 'bbbb0002', 'share', '--link']);
  assert.equal(paused.code, EXIT.refused);
  assert.match(paused.err, /not running/);
  const prod = await c.run(['session', 'app', '7a7a0007', 'share', '--members', 'on']);
  assert.equal(prod.code, EXIT.refused);
  assert.match(prod.err, /seen production data/);
  assert.equal((await c.run(['session', 'app', '7a7a0007', 'share', '--members', 'off'])).code, EXIT.done, 'turning it off is always allowed');
  // The console holds to it on its own too, as it does for the page.
  c.sessions.find((x) => x.id === '7a7a0007').taintedAt = null;
  const appShared = await c.run(['session', 'app', '7a7a0007', 'share', '--link']);
  assert.equal(appShared.code, EXIT.done, appShared.err);
  for (const id of ['1a1a0007', 'bbbb0002']) assert.deepEqual(c.appShares.view(id), { members: false, links: [] });

  const plain = await consoleFor(t);
  const none = await plain.run(['session', 'app', 'aaaa0001', 'share']);
  assert.equal(none.code, EXIT.refused);
  assert.match(none.err, /serves no session apps/);
});
