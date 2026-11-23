import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCommand, publicSession, sharedRunningCount, routeQa, routeTrigger, sessionsToStart, statusUpdate, woodshedRunsOn, stopReason, pauseAt, withSessionLimits, canSee, activePrivateCount, parseWorkOn, sessionOptions,
  keptIds, pullNumber, planUsageFrom, sessionLink,
  agentsFrom, runsCodex,
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
  assert.equal(parseCommand('Started a Woodshed session. Comment `/woodshed <message>` here.'), null);
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

test('routeTrigger never sends a comment to a review session on the pull request, nor resumes one', () => {
  const review = session({ id: 'rrrrrrrr', kind: 'pr', number: 7, trigger: 'review', review: { sha: 'a' } });
  assert.deepEqual(routeTrigger({ sessions: [review], number: 7, trigger: 'comment', kind: 'pr', text: 'rename the flag' }),
    { action: 'start', resumeBranch: null }, 'a running review reviews: the work starts a session of its own');
  const working = session({ id: 'wwwwwwww', kind: 'issue', number: 3, prUrl: 'https://github.com/o/r/pull/7' });
  assert.deepEqual(routeTrigger({ sessions: [working, review], number: 7, trigger: 'comment', kind: 'pr', text: 'rename the flag' }),
    { action: 'send', sessionId: 'wwwwwwww' }, 'the session that opened the pull request gets it, the review beside it does not');
  const kept = { ...review, status: 'stopped', kept: true };
  assert.equal(routeTrigger({ sessions: [kept], number: 7, trigger: 'comment', kind: 'pr', text: 'x' }).action, 'start', 'a kept review is not resumed with work');
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

test('an Extend holds the pause and the lifetime back, only for the run it was pressed in', () => {
  const base = { startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T10:30:00.000Z' };
  const at = (hhmm) => Date.parse(`2026-10-21T${hhmm}:00.000Z`);
  assert.deepEqual(pauseAt(session(base), LIMITS), { at: at('12:30'), why: 'idle', ms: LIMITS.idleMs });
  const extended = session({ ...base, extendedAt: '2026-10-21T12:20:00.000Z', extendedUntil: '2026-10-21T13:30:00.000Z' });
  assert.equal(stopReason(extended, at('13:00'), LIMITS), null, 'held to 13:30');
  assert.equal(stopReason(extended, at('13:31'), LIMITS), 'idle for 3 h', 'says how long it really waited');
  const lifetime = session({ ...base, lastActiveAt: '2026-10-21T17:59:00.000Z', extendedAt: '2026-10-21T17:50:00.000Z', extendedUntil: '2026-10-21T19:00:00.000Z' });
  assert.equal(stopReason(lifetime, at('18:30'), LIMITS), null, 'past its 8 hours, but extended');
  const stale = session({ ...base, startedAt: '2026-10-21T12:00:00.000Z', lastActiveAt: '2026-10-21T12:00:00.000Z', extendedAt: '2026-10-21T11:00:00.000Z', extendedUntil: '2026-10-21T20:00:00.000Z' });
  assert.equal(stopReason(stale, at('14:01'), LIMITS), 'idle for 2 h', 'an Extend from before a resume counts for nothing');
  assert.equal(pauseAt(session({ ...base, status: 'stopped' }), LIMITS), null);
});

test('an idle session extended past its lifetime still pauses for being idle', () => {
  // Idle due 17:30, lifetime 18:00, both held to 18:30: the one due first says why.
  const held = session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T15:30:00.000Z', extendedAt: '2026-10-21T17:20:00.000Z', extendedUntil: '2026-10-21T18:30:00.000Z' });
  assert.equal(pauseAt(held, LIMITS).why, 'idle');
  assert.equal(pauseAt(held, LIMITS).at, Date.parse('2026-10-21T18:30:00.000Z'));
});

test('a session\'s own limits replace the ones it runs on, a key at a time', () => {
  const limits = withSessionLimits(LIMITS, { idleHours: 0.5 });
  assert.deepEqual([limits.idleMs, limits.lifetimeMs, limits.startTimeoutMs], [30 * 60_000, LIMITS.lifetimeMs, LIMITS.startTimeoutMs]);
  assert.equal(withSessionLimits(LIMITS, null), LIMITS);
  const s = session({ startedAt: '2026-10-21T10:00:00.000Z', lastActiveAt: '2026-10-21T10:00:00.000Z' });
  assert.equal(stopReason(s, Date.parse('2026-10-21T10:31:00.000Z'), limits), 'idle for 30 min');
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

test('statusUpdate keeps the engines whose viewers statusd says the session runs, and null when it says nothing', () => {
  assert.deepEqual(statusUpdate(session({}), { state: 'done', viewers: ['mongo', 'postgres', 'mysql', 7] }, 'now').viewers, ['postgres', 'mongo']);
  assert.deepEqual(statusUpdate(session({}), { state: 'done', viewers: [] }, 'now').viewers, [], 'a session with no database of its own');
  assert.equal(statusUpdate(session({}), { state: 'done' }, 'now').viewers, null, 'an image from before statusd said');
  assert.equal(statusUpdate(session({}), { state: 'done', viewers: 'postgres' }, 'now').viewers, null);
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

test('statusUpdate keeps the machine\'s numbers in range, the peak and the disk with them', () => {
  const usage = { cpuPercent: 42, memoryBytes: 5, memoryLimitBytes: 10, memoryPeakBytes: 8, cores: 2, diskUsedBytes: 3, diskTotalBytes: 20 };
  assert.deepEqual(statusUpdate(session({}), { state: 'done', usage }, 'now').usage, usage);
  const bad = statusUpdate(session({}), { state: 'done', usage: { ...usage, memoryPeakBytes: -1, diskUsedBytes: '3', diskTotalBytes: Infinity } }, 'now').usage;
  assert.deepEqual([bad.memoryPeakBytes, bad.diskUsedBytes, bad.diskTotalBytes], [null, null, null]);
  assert.equal(statusUpdate(session({}), { state: 'done', usage: {} }, 'now').usage, null);
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

test('statusUpdate keeps every pull request the session reported, oldest first, each once', () => {
  const url = (n) => `https://github.com/o/r/pull/${n}`;
  assert.deepEqual(statusUpdate(session({ repo: 'o/r', prUrl: null }), { state: 'done' }, 'now').prUrls, []);
  const before = session({ repo: 'o/r', prUrl: url(10) });
  assert.deepEqual(statusUpdate(before, { state: 'done' }, 'now').prUrls, [url(10)], 'one from before the list is its prUrl');
  const second = statusUpdate(before, { state: 'done', prUrl: url(11) }, 'now');
  assert.deepEqual(second.prUrls, [url(10), url(11)]);
  assert.equal(second.prUrl, url(11));
  const again = statusUpdate(session({ repo: 'o/r', prUrl: url(11), prUrls: second.prUrls }), { state: 'done', prUrl: url(10) }, 'now');
  assert.deepEqual(again.prUrls, [url(10), url(11)], 'one reported again keeps its place');
  assert.deepEqual(statusUpdate(session({ repo: 'o/r', prUrl: url(10) }), { state: 'done', prUrl: 'https://github.com/evil/r/pull/1' }, 'now').prUrls, [url(10)]);
});

test('statusUpdate takes the pull requests of the session\'s other branches, in number order', () => {
  const url = (n) => `https://github.com/o/r/pull/${n}`;
  const first = statusUpdate(session({ repo: 'o/r', prUrl: null }), { state: 'done', prUrl: url(12), prUrls: [url(11), url(12), url(14)] }, 'now');
  assert.deepEqual(first.prUrls, [url(11), url(12), url(14)]);
  assert.equal(first.prUrl, url(12), 'prUrl stays the checked-out branch\'s');
  const later = statusUpdate(session({ repo: 'o/r', prUrl: url(12), prUrls: [url(12)] }), { state: 'done', prUrl: url(12), prUrls: [url(11)] }, 'now');
  assert.deepEqual(later.prUrls, [url(11), url(12)], 'an older one found later goes before');
  const gone = statusUpdate(session({ repo: 'o/r', prUrl: url(12), prUrls: first.prUrls }), { state: 'done', prUrl: null, prUrls: [] }, 'now');
  assert.deepEqual(gone.prUrls, first.prUrls, 'a branch deleted since keeps its pull request');
  const odd = statusUpdate(session({ repo: 'o/r', prUrl: null }), { state: 'done', prUrls: ['https://github.com/evil/r/pull/1', 7, `${url(5)}/files`, url(6)] }, 'now');
  assert.deepEqual(odd.prUrls, [url(6)]);
  assert.deepEqual(statusUpdate(session({ repo: 'o/r', prUrl: null }), { state: 'done', prUrls: 'no' }, 'now').prUrls, []);
  const many = Array.from({ length: 30 }, (_, i) => url(i + 1));
  assert.deepEqual(statusUpdate(session({ repo: 'o/r', prUrl: null }), { state: 'done', prUrls: many }, 'now').prUrls, many.slice(-20), 'the 20 newest');
});

test('a pull request says which of Woodshed\'s review and QA are at work on it', () => {
  const url = (n) => `https://github.com/o/r/pull/${n}`;
  const run = (number, extra) => session({ repo: 'o/r', kind: 'pr', number, status: 'running', ...extra });
  const runsOn = woodshedRunsOn([
    run(7, { review: { sha: 'a' } }), run(7, { qa: { sha: 'a' }, status: 'queued' }),
    run(8, { qa: { sha: 'b' } }),
    run(9, { review: { sha: 'c', conclusion: 'APPROVE' }, status: 'stopped' }),
    run(10, {}),
    session({ repo: 'o/other', kind: 'pr', number: 11, status: 'running', review: {} }),
  ]);
  assert.deepEqual(runsOn(url(7)), ['review', 'qa'], 'one waiting in line counts');
  assert.deepEqual(runsOn(url(8)), ['qa']);
  assert.deepEqual(runsOn(url(9)), [], 'a finished review is in the checks');
  assert.deepEqual(runsOn(url(10)), [], 'a session working on the pull request is no reviewer');
  assert.deepEqual(runsOn(url(11)), [], 'another repo\'s pull request of that number');
  assert.deepEqual(runsOn('https://github.com/O/R/pull/8'), ['qa']);
  assert.deepEqual(runsOn(null), []);
});

test('publicSession drops the token and the endpoint', () => {
  const view = publicSession(session({ token: 'secret', terminalToken: 'term', endpoint: { host: 'h' }, pendingMessages: ['a', 'b'] }));
  assert.equal(view.token, undefined);
  assert.equal(view.endpoint, undefined);
  assert.equal(view.terminalToken, undefined);
  assert.equal(view.pendingMessages, 2);
  assert.deepEqual(view.heldIds, []);
  const held = publicSession(session({ pendingMessages: ['console own', { id: 'page-id-0001', text: 'secret words' }] }));
  assert.deepEqual(held.heldIds, ['page-id-0001'], 'the page\'s ids of held messages');
  assert.ok(!JSON.stringify(held).includes('secret words'), 'never their text');
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

test('statusUpdate keeps the apps Start app can pick and the one running, and none from an older statusd', () => {
  const base = { status: 'running', repo: 'o/r', lastMessage: null };
  const apps = (status) => {
    const u = statusUpdate(base, { state: 'done', ...status }, 'now');
    return [u.appName, u.apps];
  };
  const two = [{ name: 'web', label: 'Web app' }, { name: 'admin', label: 'Admin' }];
  assert.deepEqual(apps({ appName: 'admin', apps: two }), ['admin', two]);
  assert.deepEqual(apps({}), [null, null], 'a statusd from before several apps says nothing');
  assert.deepEqual(apps({ appName: 'mobile', apps: two }), [null, two], 'a running app that is not one of them is none');
  assert.deepEqual(apps({ appName: 'web', apps: [{ name: '<b>' }, { name: 'web', label: 3 }, { name: 'admin', label: `  ${'x'.repeat(80)} ` }] }),
    ['web', [{ name: 'web', label: 'web' }, { name: 'admin', label: 'x'.repeat(60) }]], 'a bad name is dropped, a bad label is the name, a long one cut');
  assert.deepEqual(apps({ appName: null, apps: 'web' }), [null, null]);
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
  assert.deepEqual(sessionOptions({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'plan' }), { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'plan' });
  // Which Codex models and efforts exist is OpenAI's catalog's to say (codexModels.mjs): here only their shape.
  assert.deepEqual(sessionOptions({ agent: 'codex', model: 'gpt-7-nova', effort: 'ultra' }).model, 'gpt-7-nova', 'a model the console has never heard of');
  for (const bad of ['gpt 6', '-x', 'gpt;rm', 'a'.repeat(65), 'GPT-6']) assert.throws(() => sessionOptions({ agent: 'codex', model: bad }), /not a Codex model name/, bad);
  for (const bad of ['x"y', 'HIGH', 'a'.repeat(17)]) assert.throws(() => sessionOptions({ agent: 'codex', effort: bad }), /not a Codex effort name/, bad);
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

test('sessionLink carries the console\'s link query, and is the plain page without one', () => {
  assert.equal(sessionLink('https://console.example', 'aaaa1111'), 'https://console.example/s/aaaa1111');
  assert.equal(sessionLink('https://console.example', 'aaaa1111', { place: 'a b', empty: '' }), 'https://console.example/s/aaaa1111?place=a+b');
});

test('routeQa starts QA on a pull request unless a QA session is testing it, and routeTrigger never picks a QA session', () => {
  const qa = { id: 'q', kind: 'pr', number: 7, qa: { base: 'main' }, status: 'running', createdAt: '2026-10-21T10:00:00Z' };
  assert.deepEqual(routeQa({ sessions: [], number: 7 }), { action: 'start' });
  assert.deepEqual(routeQa({ sessions: [qa], number: 7 }), { action: 'ignore', reason: 'QA is already running on it' });
  assert.deepEqual(routeQa({ sessions: [{ ...qa, status: 'stopped' }], number: 7 }), { action: 'start' });
  assert.deepEqual(routeQa({ sessions: [{ ...qa, qa: undefined }], number: 7 }), { action: 'start' }, 'a coding session on it is no QA');
  assert.deepEqual(routeTrigger({ sessions: [qa], number: 7, trigger: 'comment', kind: 'pr', text: 'go' }), { action: 'start', resumeBranch: null });
});

test('planUsageFrom preserves Codex attribution through status updates', () => {
  const usage = { agent: 'codex', asOf: '2026-11-12T12:00:00.000Z', fiveHour: { usedPercent: 12, resetsAt: null }, sevenDay: { usedPercent: 28, resetsAt: null } };
  assert.deepEqual(planUsageFrom(usage), usage);
  assert.deepEqual(statusUpdate({ ...session({}), owner: 'octocat', options: { agent: 'codex' } }, { state: 'done', planUsage: usage }, 'now').planUsage, usage);
});

test('statusUpdate keeps whether text waits in the agent\'s box, for Chat to say so, and nothing else as true', () => {
  const nowIso = '2026-10-21T12:00:00.000Z';
  assert.equal(statusUpdate(session(), { state: 'done', boxText: true }, nowIso).boxText, true);
  assert.equal(statusUpdate(session(), { state: 'done', boxText: 'yes' }, nowIso).boxText, false);
  assert.equal(statusUpdate(session(), { state: 'done' }, nowIso).boxText, false);
});

test('statusUpdate keeps whether the session\'s statusd sends with the guards', () => {
  const nowIso = '2026-10-21T12:00:00.000Z';
  assert.equal(statusUpdate(session(), { state: 'done', safeSend: true }, nowIso).safeSend, true);
  assert.equal(statusUpdate(session(), { state: 'done' }, nowIso).safeSend, false, 'an older statusd says nothing of it');
});

test('the agents beside a session\'s own are read from statusd field by field, and none from a session that starts none', () => {
  assert.equal(agentsFrom(undefined), null, 'an older image, or a shared session');
  const read = agentsFrom([
    { id: 'agent-2', agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan', startedAt: '2026-11-23T10:00:00.000Z', state: 'working',
      heldIds: ['msg-00000001', 'x', 42], deliveredIds: [], refusedIds: [], leftInBox: { id: 'msg-00000002' }, extra: 'dropped' },
    { id: 'agent-3', agent: 'bash', state: 'done' },
    { id: '../claude', agent: 'claude' },
    { id: 'agent-4', agent: 'claude', model: '$(id)', state: 'sleeping', leftInBox: { id: '<b>' } },
  ]);
  assert.deepEqual(read, [
    { id: 'agent-2', agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan', startedAt: '2026-11-23T10:00:00.000Z', state: 'working',
      heldIds: ['msg-00000001'], deliveredIds: [], refusedIds: [], leftInBox: { id: 'msg-00000002' } },
    { id: 'agent-4', agent: 'claude', model: null, effort: null, permissionMode: null, startedAt: null, state: null,
      heldIds: [], deliveredIds: [], refusedIds: [], leftInBox: null },
  ]);
  assert.equal(agentsFrom(Array.from({ length: 9 }, (_, i) => ({ id: `agent-${(i % 8) + 2}`, agent: 'claude' }))).length, 3);
});

test('codex runs in a Codex session, and in a private one whose owner started a Codex agent in it', () => {
  assert.equal(runsCodex({ options: { agent: 'codex' } }), true);
  assert.equal(runsCodex({ owner: 'octocat', extraAgents: ['codex'] }), true);
  assert.equal(runsCodex({ owner: 'octocat', extraAgents: ['claude'] }), false);
  assert.equal(runsCodex({ owner: null, extraAgents: ['codex'] }), false, 'a shared session starts no other agent');
  assert.equal(runsCodex({ owner: 'octocat', extraAgents: ['codex'], taintedAt: '2026-11-23T10:00:00Z' }), false, 'nor one that has seen production data');
  assert.equal(runsCodex({}), false);
});
