import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, enabledKinds, hasFailed, isMine, NOTIFICATION_KINDS, pausedFor, waitsFor } from './attention.mjs';

const running = (id, state, more = {}) => ({ id, title: `Session ${id}`, status: 'running', state, ...more });

test('what a running session waits on its person for', () => {
  assert.equal(waitsFor(running('a', 'needs-you')), 'needs-you');
  assert.equal(waitsFor(running('a', 'done')), 'done');
  assert.equal(waitsFor(running('a', 'working')), null);
  // In review, or waiting on a background job on its pull request: nobody yet.
  assert.equal(waitsFor(running('a', 'done', { slackWaiting: true })), null);
  assert.equal(waitsFor(running('a', 'done', { shells: 1, prUrl: 'https://github.com/o/r/pull/1' })), null);
  assert.equal(waitsFor({ id: 'a', status: 'stopped', state: 'needs-you' }), null);
});

test('whose sessions count, as on the rail\'s Mine', () => {
  assert.ok(isMine({ owner: 'Octocat' }, 'octocat'));
  assert.ok(!isMine({ owner: 'ana-dev' }, 'octocat'));
  assert.ok(isMine({ assignee: 'octocat' }, 'octocat'));
  assert.ok(isMine({ startedBy: 'octocat', assignee: 'ana-dev' }, 'octocat'));
  assert.ok(!isMine({ startedBy: 'ana-dev', assignee: null }, 'octocat'));
  // A console nobody signs in to: every session is the one person's.
  assert.ok(isMine({ startedBy: 'ana-dev' }, null));
  // A console one person uses: every session is theirs, as its one list shows.
  assert.ok(isMine({ startedBy: 'ana-dev', assignee: 'priya-dev' }, 'octocat', { onePerson: true }));
  assert.ok(isMine({ owner: 'local' }, 'octocat', { onePerson: true }));
});

test('the first read sets the badge and notifies about nothing', () => {
  const body = { login: 'octocat', sessions: [running('a', 'needs-you', { owner: 'octocat' }), running('b', 'done', { owner: 'octocat' }), running('c', 'needs-you', { owner: 'ana-dev' })] };
  const { badge, now, notify } = attention(body, null, { first: true });
  assert.equal(badge, 1);
  assert.deepEqual([...now.sessions].map(([id, m]) => [id, m.waiting]), [['a', 'needs-you'], ['b', 'done']]);
  assert.deepEqual(notify, []);
});

test('a session that starts waiting is notified once', () => {
  const body = (state) => ({ login: 'octocat', sessions: [running('a', state, { owner: 'octocat', title: 'Fix CSV upload' })] });
  let seen = attention(body('working'), null, { first: true }).now;
  const asked = attention(body('needs-you'), seen);
  assert.deepEqual(asked.notify, [{ id: 'a', kind: 'needs-you', title: 'Fix CSV upload', body: 'Needs you: claude is asking a question.' }]);
  assert.equal(asked.badge, 1);
  seen = asked.now;
  assert.deepEqual(attention(body('needs-you'), seen).notify, []);
  const done = attention(body('done'), seen);
  assert.deepEqual(done.notify.map((n) => n.body), ['Done: claude finished its turn.']);
  assert.equal(done.badge, 0);
  // Working again, then done again: a new turn, a new notification.
  seen = attention(body('working'), done.now).now;
  assert.equal(attention(body('done'), seen).notify.length, 1);
});

test('questions from Slack, reviews and QA runs are nobody\'s to answer', () => {
  const body = { login: null, sessions: [
    running('q', 'needs-you', { kind: 'ask' }),
    running('r', 'needs-you', { trigger: 'review' }),
    running('t', 'done', { trigger: 'qa' }),
  ] };
  const seen = attention(body, null, { first: true }).now;
  const later = attention({ login: null, sessions: body.sessions.map((s) => ({ ...s, state: s.state === 'done' ? 'needs-you' : 'done' })) }, seen);
  assert.deepEqual([later.badge, later.notify], [0, []]);
  assert.deepEqual(attention(null, null), { badge: 0, now: { sessions: new Map(), prs: new Map() }, notify: [] });
});

// Each kind: from `before` to `after`, notified once with `text`, never on a first read, and not when switched off.
function checkKind(kind, { before, after, text, login = 'octocat', names }) {
  const read = (sessions) => ({ login, names, sessions });
  const all = NOTIFICATION_KINDS.map((k) => k.key);
  const on = new Set(all);
  const seen = attention(read(before), null, { first: true }).now;
  const changed = attention(read(after), seen, { enabled: on });
  assert.deepEqual(changed.notify.map((n) => [n.kind, n.body]), [[kind, text]], kind);
  assert.deepEqual(attention(read(after), changed.now, { enabled: on }).notify, [], `${kind} twice`);
  assert.deepEqual(attention(read(after), null, { first: true, enabled: on }).notify, [], `${kind} on the first read`);
  const off = new Set(all.filter((k) => k !== kind));
  assert.deepEqual(attention(read(after), seen, { enabled: off }).notify, [], `${kind} switched off`);
}

const mine = (id, more = {}) => ({ id, title: `Session ${id}`, owner: 'octocat', status: 'running', state: 'working', ...more });
const shared = (id, more = {}) => ({ id, title: `Session ${id}`, owner: null, startedBy: 'ana-dev', status: 'running', state: 'working', ...more });
const PR = 'https://github.com/o/r/pull/12';
const chip = (more = {}) => ({ number: 12, title: 'Fix CSV upload', state: 'open', review: null, checks: null, queuePosition: null, ...more });
const withPr = (pr, more = {}) => mine('a', { prUrl: PR, prs: [{ url: PR, pr }], ...more });

test('which kinds are on by default, and a saved choice wins', () => {
  assert.deepEqual([...enabledKinds()], ['needs-you', 'done', 'failed', 'assigned', 'pr-opened', 'merged', 'review', 'qa']);
  const saved = enabledKinds({ done: false, checks: true, paused: 'yes' });
  assert.ok(!saved.has('done') && saved.has('checks') && !saved.has('paused'));
});

test('a session that failed', () => {
  checkKind('failed', { before: [mine('a', { status: 'starting', state: null })], after: [mine('a', { status: 'failed', state: null, error: 'CannotPullContainerError: no image.\nmore' })], text: 'Failed: CannotPullContainerError: no image.' });
  checkKind('failed', { before: [mine('a', { status: 'starting' })], after: [mine('a', { status: 'stopped', stopReason: 'did not start in time' })], text: 'Failed: it did not start in time.' });
  // One that failed between two reads, never seen starting, is news too.
  checkKind('failed', { before: [], after: [mine('a', { status: 'failed' })], text: 'Failed.' });
  assert.ok(!hasFailed(shared('s', { status: 'stopped', stopReason: 'did not start in time' })), 'a shared one the page calls stopped');
});

test('a session the console paused, not one a person stopped', () => {
  checkKind('paused', { before: [mine('a', { state: 'done' })], after: [mine('a', { status: 'stopped', stopReason: 'idle for 2 h' })], text: 'Paused: idle 2 h. Resume it from the console.' });
  assert.equal(pausedFor(mine('a', { status: 'stopped', stopReason: 'ran for 8 h' })), 'ran 8 h');
  assert.equal(pausedFor(mine('a', { status: 'stopped', stopReason: 'stopped from the console', stoppedBy: 'octocat' })), null);
  assert.equal(pausedFor(mine('a', { status: 'stopped', stopReason: 'idle for 2 h', stoppedBy: 'octocat' })), null);
});

test('a shared session handed to you, not one you took or started', () => {
  const names = { 'ana-dev': 'Ana Dev' };
  checkKind('assigned', { names, before: [shared('s')], after: [shared('s', { assignee: 'octocat', assignedBy: 'ana-dev' })], text: 'Assigned to you by Ana Dev.' });
  checkKind('assigned', { before: [], after: [shared('s', { assignee: 'octocat', assignedBy: 'priya-dev' })], text: 'Assigned to you by @priya-dev.' });
  const read = (s) => ({ login: 'octocat', sessions: [s] });
  const seen = attention(read(shared('s', { startedBy: 'octocat' })), null, { first: true }).now;
  assert.deepEqual(attention(read(shared('s', { startedBy: 'octocat', assignee: 'octocat', assignedBy: 'octocat' })), seen).notify, []);
});

test('a pull request a session opened', () => {
  checkKind('pr-opened', { before: [mine('a')], after: [withPr(chip())], text: 'Pull request opened: PR 12, Fix CSV upload.' });
  checkKind('pr-opened', { before: [mine('a')], after: [withPr(null)], text: 'Pull request opened: PR 12.' });
  const read = (s) => ({ login: 'octocat', sessions: [s] });
  // A session started on that pull request (Work on, or a label on it) reports it, but did not open it.
  const onIt = { kind: 'pr', number: 12 };
  const seen = attention(read(mine('a', onIt)), null, { first: true }).now;
  assert.deepEqual(attention(read(withPr(chip(), onIt)), seen).notify, []);
  // Nor a new session that comes with one, nor the same pull request on a second session of yours.
  const one = attention(read(mine('b')), null, { first: true }).now;
  assert.deepEqual(attention({ login: 'octocat', sessions: [withPr(chip()), mine('b')] }, one).notify, []);
  const both = attention({ login: 'octocat', sessions: [withPr(chip()), mine('b')] }, null, { first: true }).now;
  assert.deepEqual(attention({ login: 'octocat', sessions: [withPr(chip()), mine('b', { prUrl: PR, prs: [{ url: PR, pr: chip() }] })] }, both).notify, []);
});

test('a pull request merged or closed', () => {
  checkKind('merged', { before: [withPr(chip())], after: [withPr(chip({ state: 'merged' }))], text: 'Merged: PR 12, Fix CSV upload.' });
  checkKind('merged', { before: [withPr(chip({ state: 'draft' }))], after: [withPr(chip({ state: 'closed' }))], text: 'Closed without merging: PR 12, Fix CSV upload.' });
});

test('a pull request\'s checks failing or passing, once each', () => {
  const checks = (pass, fail, pending) => chip({ checks: { pass, fail, pending, total: pass + fail + pending } });
  checkKind('checks', { before: [withPr(checks(3, 0, 2))], after: [withPr(checks(4, 1, 0))], text: 'Checks failing: 1 of 5 on PR 12, Fix CSV upload.' });
  checkKind('checks', { before: [withPr(checks(3, 0, 2))], after: [withPr(checks(5, 0, 0))], text: 'Checks passing: all 5 on PR 12, Fix CSV upload.' });
  const read = (pr) => ({ login: 'octocat', sessions: [withPr(pr)] });
  const on = enabledKinds({ checks: true });
  // Still running, or the chip read for the first time: nothing.
  const seen = attention(read(chip()), null, { first: true }).now;
  assert.deepEqual(attention(read(checks(5, 0, 0)), seen, { enabled: on }).notify, []);
  const passing = attention(read(checks(5, 0, 0)), null, { first: true }).now;
  assert.deepEqual(attention(read(checks(4, 0, 1)), passing, { enabled: on }).notify, []);
  // Off unless switched on.
  const pending = attention(read(checks(4, 0, 1)), null, { first: true }).now;
  assert.deepEqual(attention(read(checks(4, 1, 0)), pending).notify, []);
});

test('a review or QA run on your pull request finishing, with its verdict', () => {
  const review = (more = {}) => shared('r', { startedBy: 'octocat', trigger: 'review', kind: 'pr', number: 12, title: 'Review: Fix CSV upload', review: { heading: 'Woodshed review', ...more } });
  checkKind('review', { before: [review()], after: [review({ reported: true, conclusion: 'REQUEST_CHANGES' })], text: 'Review finished: changes requested.' });
  checkKind('review', { before: [review()], after: [review({ reported: true, conclusion: 'APPROVE', held: { sha: 'abc' } })], text: 'Review finished: approved, held until QA reports.' });
  checkKind('review', { before: [review()], after: [review({ reported: true, conclusion: null })], text: 'Review finished without a verdict.' });
  const qa = (more = {}) => shared('q', { startedBy: 'octocat', trigger: 'qa', kind: 'pr', number: 12, title: 'QA: Fix CSV upload', qa: { check: 'QA', ...more } });
  checkKind('qa', { before: [qa()], after: [qa({ conclusion: 'failure', title: '2 of 6 checks failed' })], text: 'QA failed: 2 of 6 checks failed.' });
  checkKind('qa', { before: [qa()], after: [qa({ conclusion: 'success', title: 'All 6 passed' })], text: 'QA passed: All 6 passed.' });
  // A run that started and finished between two reads (asleep, offline) still rings, but never on the first read.
  checkKind('review', { before: [], after: [review({ reported: true, conclusion: 'APPROVE' })], text: 'Review finished: approved.' });
  checkKind('qa', { before: [], after: [qa({ conclusion: 'success', title: 'All 6 passed' })], text: 'QA passed: All 6 passed.' });
  const finished = { login: 'octocat', sessions: [review({ reported: true, conclusion: 'APPROVE' })] };
  assert.deepEqual(attention(finished, null, { first: true }).notify, []);
  assert.deepEqual(attention(finished, attention(finished, null, { first: true }).now).notify, [], 'and once');
  // Someone else's pull request's run is not yours.
  const theirs = { login: 'octocat', sessions: [{ ...qa({ conclusion: 'success' }), startedBy: 'ana-dev' }] };
  assert.deepEqual(attention(theirs, attention({ ...theirs, sessions: [{ ...qa(), startedBy: 'ana-dev' }] }, null, { first: true }).now).notify, []);
});

test('one notification per session per read, the most pressing', () => {
  const before = { login: 'octocat', sessions: [shared('s')] };
  const seen = attention(before, null, { first: true }).now;
  const after = { login: 'octocat', sessions: [shared('s', { state: 'needs-you', assignee: 'octocat', assignedBy: 'ana-dev' })] };
  assert.deepEqual(attention(after, seen).notify.map((n) => n.kind), ['needs-you']);
  // With needs-you off, the assignment shows instead.
  assert.deepEqual(attention(after, seen, { enabled: enabledKinds({ 'needs-you': false }) }).notify.map((n) => n.kind), ['assigned']);
});
