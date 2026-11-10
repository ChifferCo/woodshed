import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCommand, publicSession, sharedRunningCount, routeTrigger, sessionsToStart, statusUpdate, stopReason, canSee, activePrivateCount, parseWorkOn, sessionOptions,
  keptIds, pullNumber, planUsageFrom,
} from './sessions.mjs';

const HOUR = 3_600_000;
const LIMITS = { idleMs: 2 * HOUR, lifetimeMs: 8 * HOUR, startTimeoutMs: 15 * 60_000 };

function session(fields) {
  return { id: 'aaaaaaaa', kind: 'issue', number: 1, status: 'running', createdAt: '2026-10-21T10:00:00.000Z', ...fields };
}

test('parseCommand reads /woodshed at the start of a comment', () => {
  assert.deepEqual(parseCommand('/woodshed go with option 1'), { text: 'go with option 1' });
  assert.deepEqual(parseCommand('  /woodshed\nline one\nline two'), { text: 'line one\nline two' });
  assert.deepEqual(parseCommand('/woodshed'), { text: '' });
  assert.deepEqual(parseCommand('/Woodshed please'), { text: 'please' });
});

test('parseCommand ignores everything else', () => {
  assert.equal(parseCommand('please run /woodshed'), null);
  assert.equal(parseCommand('/woodshedding is fun'), null);
  assert.equal(parseCommand('Started a Woodshed Cloud session. Comment `/woodshed <message>` here.'), null);
  assert.equal(parseCommand(undefined), null);
});

test('routeTrigger starts a session for a label on an idle issue', () => {
  assert.deepEqual(routeTrigger({ sessions: [], number: 7, trigger: 'label' }), { action: 'start', resumeBranch: null });
});

test('routeTrigger starts nothing for a label on a pull request, and still takes a comment there', () => {
  const label = routeTrigger({ sessions: [], number: 7, trigger: 'label', kind: 'pr' });
  assert.equal(label.action, 'ignore');
  assert.match(label.reason, /comment \/woodshed/);
  assert.equal(routeTrigger({ sessions: [], number: 7, trigger: 'comment', kind: 'pr', text: 'fix the review' }).action, 'start');
});

test('routeTrigger ignores a second label while a session is active', () => {
  const sessions = [session({ number: 7, status: 'queued' })];
  assert.equal(routeTrigger({ sessions, number: 7, trigger: 'label' }).action, 'ignore');
});

test('routeTrigger sends a comment to the active session', () => {
  const sessions = [session({ id: 'bbbbbbbb', number: 7 })];
  assert.deepEqual(routeTrigger({ sessions, number: 7, trigger: 'comment', text: 'option 1' }), { action: 'send', sessionId: 'bbbbbbbb' });
  assert.equal(routeTrigger({ sessions, number: 7, trigger: 'comment', text: '' }).action, 'ignore');
});

test('routeTrigger ignores triggers while a session is stopping', () => {
  const sessions = [session({ number: 7, status: 'stopping' })];
  assert.equal(routeTrigger({ sessions, number: 7, trigger: 'comment', text: 'hello' }).action, 'ignore');
});

test('routeTrigger resumes the latest branch of a stopped issue session', () => {
  const sessions = [
    session({ number: 7, status: 'stopped', branch: 'woodshed/7-old', createdAt: '2026-10-20T10:00:00.000Z' }),
    session({ number: 7, status: 'stopped', branch: 'woodshed/7-new', createdAt: '2026-10-21T10:00:00.000Z' }),
    session({ number: 8, status: 'stopped', branch: 'woodshed/8-other' }),
  ];
  assert.deepEqual(routeTrigger({ sessions, number: 7, trigger: 'comment', text: 'again' }), { action: 'start', resumeBranch: 'woodshed/7-new' });
});

test('sessionsToStart fills free slots with the oldest queued sessions', () => {
  const sessions = [
    session({ id: 'r1', status: 'running' }),
    session({ id: 'q2', status: 'queued', createdAt: '2026-10-21T10:02:00.000Z' }),
    session({ id: 'q1', status: 'queued', createdAt: '2026-10-21T10:01:00.000Z' }),
    session({ id: 'q3', status: 'queued', createdAt: '2026-10-21T10:03:00.000Z' }),
  ];
  assert.deepEqual(sessionsToStart(sessions, { maxRunning: 3, maxPrivate: 3 }).map((s) => s.id), ['q1', 'q2']);
  assert.deepEqual(sessionsToStart(sessions, { maxRunning: 1, maxPrivate: 3 }), []);
});

test('sessionsToStart leaves a session AWS had no room for until its retry time', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const sessions = [
    { id: 'later', status: 'queued', createdAt: '2026-10-26T09:00:00Z', retryAt: '2026-10-26T10:00:30Z' },
    { id: 'due', status: 'queued', createdAt: '2026-10-26T09:01:00Z', retryAt: '2026-10-26T09:59:59Z' },
  ];
  assert.deepEqual(sessionsToStart(sessions, { maxRunning: 5, maxPrivate: 3 }, now).map((s) => s.id), ['due']);
});

test('sessionsToStart keeps a line per person for My Woodshed, apart from the shared slots', () => {
  const sessions = [
    session({ id: 'r1', status: 'running' }),
    session({ id: 'p1', status: 'running', owner: 'joel' }),
    session({ id: 'p2', status: 'queued', owner: 'mia', createdAt: '2026-10-21T10:01:00.000Z' }),
    session({ id: 'q1', status: 'queued', createdAt: '2026-10-21T10:02:00.000Z' }),
    session({ id: 'j3', status: 'queued', owner: 'joel', createdAt: '2026-10-21T10:04:00.000Z' }),
    session({ id: 'j2', status: 'queued', owner: 'joel', createdAt: '2026-10-21T10:03:00.000Z' }),
  ];
  assert.deepEqual(sessionsToStart(sessions, { maxRunning: 1, maxPrivate: 1 }).map((s) => s.id), ['p2'],
    'joel\'s one task fills his limit, so his wait; mia has none running');
  assert.deepEqual(sessionsToStart(sessions, { maxRunning: 2, maxPrivate: 2 }).map((s) => s.id), ['p2', 'q1', 'j2'],
    'joel\'s oldest in line takes his one free slot');
  const stopping = sessions.map((s) => (s.id === 'p1' ? { ...s, status: 'stopping' } : s));
  assert.deepEqual(sessionsToStart(stopping, { maxRunning: 1, maxPrivate: 1 }).map((s) => s.id), ['p2'], 'a stopping task still counts');
  const resumed = sessions.map((s) => (s.id === 'j2' ? { ...s, queuedAt: '2026-10-21T10:05:00.000Z' } : s));
  assert.deepEqual(sessionsToStart(resumed, { maxRunning: 2, maxPrivate: 2 }).map((s) => s.id), ['p2', 'q1', 'j3'],
    'a session resumed into the line joins it at the back');
});

test('stopReason stops a session idle past the limit', () => {
  const now = Date.parse('2026-10-21T13:00:00.000Z');
  const idle = session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T10:30:00.000Z' });
  const busy = session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T12:59:00.000Z' });
  assert.equal(stopReason(idle, now, LIMITS), 'idle for 2 h');
  assert.equal(stopReason(busy, now, LIMITS), null);
});

test('stopReason stops a session past its lifetime, and a start that hangs', () => {
  const now = Date.parse('2026-10-21T19:00:00.000Z');
  assert.equal(stopReason(session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T18:59:00.000Z' }), now, LIMITS), 'ran for 8 h');
  assert.equal(stopReason(session({ status: 'starting', startedAt: '2026-10-21T18:00:00.000Z' }), now, LIMITS), 'did not start in time');
  assert.equal(stopReason(session({ status: 'stopped', startedAt: '2026-10-21T01:00:00.000Z' }), now, LIMITS), null);
});

test('statusUpdate marks a starting session running and only working counts as activity', () => {
  const nowIso = '2026-10-21T12:00:00.000Z';
  const starting = statusUpdate(session({ status: 'starting' }), { state: 'done', branch: 'b', head: 'abc' }, nowIso);
  assert.equal(starting.status, 'running');
  assert.equal(starting.lastActiveAt, nowIso);

  const waiting = statusUpdate(session({ lastActiveAt: '2026-10-21T11:00:00.000Z' }), { state: 'needs-you' }, nowIso);
  assert.equal(waiting.lastActiveAt, undefined);
  assert.equal(statusUpdate(session({}), { state: 'working' }, nowIso).lastActiveAt, nowIso);
});

test('statusUpdate says the session has an editor only when statusd says true', () => {
  assert.equal(statusUpdate(session({}), { state: 'done', editor: true }, 'now').editor, true);
  assert.equal(statusUpdate(session({}), { state: 'done', editor: 'yes' }, 'now').editor, false);
  assert.equal(statusUpdate(session({}), { state: 'done' }, 'now').editor, false, 'an image from before the editor');
});

test('statusUpdate says the session has Redis unless statusd says it has none', () => {
  assert.equal(statusUpdate(session({}), { state: 'done', redis: true }, 'now').redis, true);
  assert.equal(statusUpdate(session({}), { state: 'done', redis: false }, 'now').redis, false);
  assert.equal(statusUpdate(session({}), { state: 'done' }, 'now').redis, true, 'an image from before statusd said');
});

test('statusUpdate keeps a running shell count that is a small whole number', () => {
  assert.equal(statusUpdate(session({}), { state: 'done', shells: 2 }, 'now').shells, 2);
  assert.equal(statusUpdate(session({}), { state: 'done', shells: 5000 }, 'now').shells, 99);
  assert.equal(statusUpdate(session({}), { state: 'done' }, 'now').shells, 0);
  assert.equal(statusUpdate(session({}), { state: 'done', shells: '2' }, 'now').shells, 0);
  assert.equal(statusUpdate(session({}), { state: 'done', shells: -1 }, 'now').shells, 0);
});

test('statusUpdate keeps a private session\'s plan usage, and its last one when statusd has none', () => {
  const reading = { asOf: '2026-11-05T15:37:29.000Z', fiveHour: null, sevenDay: { usedPercent: 11, resetsAt: '2026-11-08T13:20:00.000Z' } };
  const mine = session({ owner: 'joel' });
  assert.deepEqual(statusUpdate(mine, { state: 'done', planUsage: reading }, 'now').planUsage, reading);
  assert.deepEqual(statusUpdate({ ...mine, planUsage: reading }, { state: 'done' }, 'now').planUsage, reading);
  assert.equal(statusUpdate(mine, { state: 'done' }, 'now').planUsage, null);
  assert.equal(statusUpdate(session({}), { state: 'done', planUsage: reading }, 'now').planUsage, null);
});

test('planUsageFrom keeps numbers in range and real times only', () => {
  assert.deepEqual(planUsageFrom({ asOf: 'soon', fiveHour: { usedPercent: 140, resetsAt: '2026-11-05T18:53:20Z' }, sevenDay: { usedPercent: '9' } }), {
    asOf: null, fiveHour: { usedPercent: 100, resetsAt: '2026-11-05T18:53:20.000Z' }, sevenDay: null,
  });
  assert.equal(planUsageFrom({ asOf: '2026-11-05T15:37:29Z' }), null);
  assert.equal(planUsageFrom('42%'), null);
});

test('statusUpdate keeps only a pull request link on this repo', () => {
  const s = session({ repo: 'o/r' });
  assert.equal(statusUpdate(s, { state: 'done', prUrl: 'https://github.com/o/r/pull/12' }, 'now').prUrl, 'https://github.com/o/r/pull/12');
  assert.equal(statusUpdate(s, { state: 'done', prUrl: 'javascript:alert(1)' }, 'now').prUrl, null);
  assert.equal(statusUpdate(s, { state: 'done', prUrl: 'https://github.com/evil/r/pull/1' }, 'now').prUrl, null);
});

test('publicSession drops the token and the endpoint', () => {
  const view = publicSession(session({ token: 'secret', terminalToken: 'term', endpoint: { host: 'h' }, pendingMessages: ['a', 'b'] }));
  assert.equal(view.token, undefined);
  assert.equal(view.endpoint, undefined);
  assert.equal(view.terminalToken, undefined);
  assert.equal(view.pendingMessages, 2);
});

test('statusUpdate keeps the app\'s state only when statusd says one the console knows', () => {
  const nowIso = '2026-10-23T12:00:00.000Z';
  const base = { status: 'running', repo: 'o/r', lastMessage: null };
  assert.equal(statusUpdate(base, { state: 'done', app: 'running' }, nowIso).app, 'running');
  assert.equal(statusUpdate(base, { state: 'done', app: '<b>up</b>' }, nowIso).app, null);
  assert.equal(statusUpdate(base, { state: 'done' }, nowIso).app, null, 'a statusd from an older image says nothing');
  for (const app of ['api-down', 'frontend-down', 'stopping']) assert.equal(statusUpdate(base, { state: 'done', app }, nowIso).app, app);
});

test('statusUpdate keeps which of the app\'s servers answer only as two booleans, with their ports when statusd said', () => {
  const base = { status: 'running', repo: 'o/r', lastMessage: null };
  const servers = (appServers) => statusUpdate(base, { state: 'done', appServers }, 'now').appServers;
  const NO_PORTS = { frontendPort: null, backendPort: null };
  assert.deepEqual(servers({ frontend: true, backend: false }), { frontend: true, backend: false, ...NO_PORTS });
  assert.deepEqual(servers({ frontend: true, backend: false, extra: '<b>' }), { frontend: true, backend: false, ...NO_PORTS });
  assert.deepEqual(servers({ frontend: true, backend: false, frontendPort: 5173, backendPort: 8080 }), { frontend: true, backend: false, frontendPort: 5173, backendPort: 8080 });
  assert.deepEqual(servers({ frontend: true, backend: false, frontendPort: '<b>', backendPort: 70000 }), { frontend: true, backend: false, ...NO_PORTS });
  assert.equal(servers({ frontend: 'yes', backend: false }), null);
  assert.equal(servers(undefined), null, 'a statusd from an older image says nothing');
});

test('a private session is its owner\'s alone, and GitHub triggers never route to it', () => {
  const mine = { id: 'p', number: 42, status: 'running', owner: 'joel', branch: 'woodshed/42-p', kind: 'issue', createdAt: '2026-10-21T09:00:00Z' };
  assert.equal(canSee(mine, 'joel'), true);
  assert.equal(canSee(mine, 'mia'), false);
  assert.equal(canSee(mine, null), false, 'a console with no sign-in shows nobody\'s private sessions');
  assert.equal(canSee({ id: 's', owner: null }, 'mia'), true);
  assert.deepEqual(routeTrigger({ sessions: [mine], number: 42, trigger: 'comment', text: 'hi' }), { action: 'start', resumeBranch: null },
    'a /woodshed comment starts a shared session rather than typing into a private one, or resuming its branch');
  assert.equal(activePrivateCount([mine, { ...mine, status: 'stopping' }, { ...mine, status: 'queued' }, { ...mine, status: 'stopped' }, { ...mine, owner: 'mia' }], 'joel'), 2,
    'only sessions with a Fargate task count: one waiting in line has none');
});

test('the New session form\'s Work on names an issue or PR by number, or a branch', () => {
  assert.deepEqual(parseWorkOn(''), { kind: 'task' });
  assert.deepEqual(parseWorkOn(' #25812 '), { kind: 'number', number: 25812, pr: false });
  assert.deepEqual(parseWorkOn('PR #26030'), { kind: 'number', number: 26030, pr: true });
  assert.deepEqual(parseWorkOn('https://github.com/o/r/pull/7'), { kind: 'number', number: 7, pr: true });
  assert.deepEqual(parseWorkOn('woodshed-cloud/my-woodshed'), { kind: 'branch', branch: 'woodshed-cloud/my-woodshed' });
  assert.throws(() => parseWorkOn('trunk', { defaultBranch: 'trunk' }), /not a branch name/, 'the default branch, whatever its name');
  assert.deepEqual(parseWorkOn('master', { defaultBranch: 'main' }), { kind: 'branch', branch: 'master' }, 'only the repo\'s own default branch is refused');
  for (const bad of ['a b', '../x', 'x..y', 'x/', '-x', 'x.lock', 'a;rm']) assert.throws(() => parseWorkOn(bad), /not a branch name/, bad);
  assert.deepEqual(sessionOptions({}), { agent: 'claude', model: '', effort: '', permissionMode: 'auto' });
  assert.deepEqual(sessionOptions({ agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan' }), { agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan' });
  assert.throws(() => sessionOptions({ agent: 'codex', model: 'opus' }), /the model must be one of/);
  assert.throws(() => sessionOptions({ agent: 'codex', permissionMode: 'acceptEdits' }), /permission mode/);
  assert.throws(() => sessionOptions({ agent: 'gemini' }), /the agent must be one of/);
  assert.throws(() => sessionOptions({ model: 'gpt' }), /the model must be one of/);
  assert.throws(() => sessionOptions({ permissionMode: 'bypassPermissions' }), /permission mode/);
});

test('statusd\'s claude session id is kept only when it looks like one', () => {
  const s = { repo: 'o/r', status: 'running', claudeSession: null };
  assert.equal(statusUpdate(s, { state: 'working', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c' }, 'now').claudeSession, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');
  assert.equal(statusUpdate(s, { state: 'working', claudeSession: 'x; rm -rf /' }, 'now').claudeSession, null, 'it ends up on a command line');
  assert.equal(statusUpdate({ ...s, claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c' }, { state: 'idle' }, 'now').claudeSession, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');
});

test('routeTrigger resumes the latest kept session, found by its issue or by the pull request it opened', () => {
  const sessions = [
    session({ id: 'a1a1a1a1', number: 7, status: 'stopped', kept: true, prUrl: 'https://github.com/o/r/pull/70', createdAt: '2026-10-20T10:00:00.000Z' }),
    session({ id: 'b2b2b2b2', number: 7, status: 'stopped', kept: true, createdAt: '2026-10-21T10:00:00.000Z' }),
  ];
  assert.deepEqual(routeTrigger({ sessions, number: 7, trigger: 'comment', text: 'again' }), { action: 'resume', sessionId: 'b2b2b2b2' });
  assert.deepEqual(routeTrigger({ sessions, number: 7, trigger: 'label' }), { action: 'resume', sessionId: 'b2b2b2b2' });
  assert.deepEqual(routeTrigger({ sessions, number: 70, trigger: 'comment', text: 'again' }), { action: 'resume', sessionId: 'a1a1a1a1' });
  const running = [session({ id: 'c3c3c3c3', number: 7, status: 'running', prUrl: 'https://github.com/o/r/pull/70' })];
  assert.deepEqual(routeTrigger({ sessions: running, number: 70, trigger: 'comment', text: 'hi' }), { action: 'send', sessionId: 'c3c3c3c3' });
  const cleaned = [session({ number: 7, status: 'stopped', kept: false, cleanedAt: '2026-10-22T10:00:00.000Z', branch: 'woodshed/7-x' })];
  assert.deepEqual(routeTrigger({ sessions: cleaned, number: 7, trigger: 'comment', text: 'again' }), { action: 'start', resumeBranch: 'woodshed/7-x' });
  const mine = [session({ number: 7, status: 'stopped', kept: true, owner: 'joel' })];
  assert.equal(routeTrigger({ sessions: mine, number: 7, trigger: 'comment', text: 'again' }).action, 'start', 'never someone\'s private session');
});

test('keptIds keeps the active sessions and the stopped shared ones still kept', () => {
  const ids = keptIds([
    session({ id: 'aaaaaaaa', status: 'running' }),
    session({ id: 'bbbbbbbb', status: 'stopped', kept: true }),
    session({ id: 'cccccccc', status: 'stopped', kept: false }),
    session({ id: 'dddddddd', status: 'failed' }),
    session({ id: 'eeeeeeee', status: 'stopped', kept: true, owner: 'joel' }),
  ]);
  assert.deepEqual([...ids].sort(), ['aaaaaaaa', 'bbbbbbbb']);
});

test('pullNumber reads a pull request URL that ends at its number', () => {
  assert.equal(pullNumber('https://github.com/o/r/pull/77'), 77);
  assert.equal(pullNumber('https://github.com/o/r/pull/77> <!channel'), null);
  assert.equal(pullNumber(null), null);
});

test('questions from Slack take no shared slot, and have maxAsks of their own', () => {
  const asks = Array.from({ length: 3 }, (_, i) => session({
    id: `a${i}`, kind: 'ask', status: 'queued', createdAt: `2026-10-21T10:0${i}:00.000Z`,
  }));
  const sessions = [session({ id: 'r1', status: 'running' }), session({ id: 'q1', status: 'queued', createdAt: '2026-10-21T09:00:00.000Z' }), ...asks];
  const limits = { maxRunning: 1, maxPrivate: 2, maxAsks: 2 };
  assert.deepEqual(sessionsToStart(sessions, limits).map((s) => s.id), ['a0', 'a1']);
  for (const a of asks.slice(0, 2)) a.status = 'running';
  assert.deepEqual(sessionsToStart(sessions, limits), [], 'the last question waits for one of its own slots');
  assert.deepEqual(sessionsToStart(sessions, { ...limits, maxAsks: 3 }).map((s) => s.id), ['a2']);
  assert.equal(sharedRunningCount(sessions), 1);
});

test('stopReason stops a question by its own limits, and by the defaults when none are set', () => {
  const ask = (fields) => session({ kind: 'ask', startedAt: '2026-10-21T10:00:00.000Z', ...fields });
  const at = (iso) => Date.parse(`2026-10-21T${iso}:00.000Z`);
  assert.equal(stopReason(ask({ lastActiveAt: '2026-10-21T10:00:00.000Z' }), at('10:06'), LIMITS), 'idle for 5 min');
  assert.equal(stopReason(ask({ lastActiveAt: '2026-10-21T12:00:00.000Z' }), at('12:01'), LIMITS), 'ran for 2 h');
  const own = { ...LIMITS, askIdleMs: 20 * 60_000, askLifetimeMs: 3 * HOUR };
  assert.equal(stopReason(ask({ lastActiveAt: '2026-10-21T10:00:00.000Z' }), at('10:06'), own), null);
  assert.equal(stopReason(ask({ lastActiveAt: '2026-10-21T10:00:00.000Z' }), at('10:21'), own), 'idle for 20 min');
  assert.equal(stopReason(ask({ lastActiveAt: '2026-10-21T12:00:00.000Z' }), at('12:01'), own), null);
  assert.equal(stopReason(session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T10:00:00.000Z' }), at('10:21'), own), null,
    'a shared session keeps its own limits');
});
