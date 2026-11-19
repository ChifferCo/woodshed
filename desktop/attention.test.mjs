import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, isMine, waitsFor } from './attention.mjs';

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
  const { badge, now, notify } = attention(body, new Map(), { first: true });
  assert.equal(badge, 1);
  assert.deepEqual([...now], [['a', 'needs-you'], ['b', 'done']]);
  assert.deepEqual(notify, []);
});

test('a session that starts waiting is notified once', () => {
  const body = (state) => ({ login: 'octocat', sessions: [running('a', state, { owner: 'octocat', title: 'Fix CSV upload' })] });
  let seen = attention(body('working'), new Map(), { first: true }).now;
  const asked = attention(body('needs-you'), seen);
  assert.deepEqual(asked.notify, [{ id: 'a', title: 'Fix CSV upload', body: 'Needs you: claude is asking a question.' }]);
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
  assert.deepEqual(attention(body, new Map()), { badge: 0, now: new Map(), notify: [] });
  assert.deepEqual(attention(null, new Map()), { badge: 0, now: new Map(), notify: [] });
});
