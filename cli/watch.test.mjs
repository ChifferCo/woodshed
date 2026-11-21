import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kindOf } from './sessions.mjs';
import { changes, parseEvery, parseKinds, phaseOf } from './watch.mjs';

const fail = (message) => new Error(message);

test('phaseOf reads a session as the page words it', () => {
  assert.equal(phaseOf({ status: 'queued', owner: 'mia' }), 'pending');
  assert.equal(phaseOf({ status: 'starting' }), 'pending');
  assert.equal(phaseOf({ status: 'running', state: 'starting' }), 'working');
  assert.equal(phaseOf({ status: 'running', state: 'working' }), 'working');
  assert.equal(phaseOf({ status: 'running', state: 'needs-you' }), 'needs-you');
  assert.equal(phaseOf({ status: 'running', state: 'done' }), 'done');
  assert.equal(phaseOf({ status: 'running', state: null }), 'done', 'its agent exited: it waits for a message');
  assert.equal(phaseOf({ status: 'stopping' }), 'stopping');
  assert.equal(phaseOf({ status: 'failed' }), 'failed');
  assert.equal(phaseOf({ status: 'stopped', owner: 'mia', stopReason: 'did not start in time' }), 'failed');
  assert.equal(phaseOf({ status: 'stopped', owner: 'mia', stopReason: 'idle for 2 h' }), 'ended');
  assert.equal(phaseOf({ status: 'stopped', kept: true, prClosedAt: 'x', prMerged: true }), 'ended');
});

test('changes tells nothing on the first read, and each move into a phase that matters once', () => {
  const review = { id: 'r', trigger: 'review', review: {}, status: 'running', state: 'working' };
  const work = { id: 'w', owner: 'mia', status: 'running', state: 'working' };
  const first = changes(null, [review, work], { kindOf });
  assert.deepEqual(first.events, []);
  const second = changes(first.phases, [{ ...review, state: 'done' }, { ...work, state: 'done' }], { kindOf });
  assert.deepEqual(second.events.map((e) => [e.event, e.session.id]), [['done', 'w']], 'a review\'s turn is its own');
  const third = changes(second.phases, [{ ...review, status: 'stopping' }, { ...work, state: 'done' }], { kindOf });
  assert.deepEqual(third.events, [], 'stopping is not yet finished, and nothing moved for the other');
  const fourth = changes(third.phases, [{ ...review, status: 'stopped' }], { kindOf });
  assert.deepEqual(fourth.events.map((e) => e.event), ['finished']);
  // One that appeared and failed between two reads, and one already ended when first seen after the first read.
  const fifth = changes(fourth.phases, [{ id: 'n', status: 'failed' }, { id: 'o', status: 'stopped', kept: false }], { kindOf });
  assert.deepEqual(fifth.events.map((e) => [e.event, e.session.id]), [['failed', 'n'], ['finished', 'o']]);
  // Straight from in line to needing its person: it started, and needs them.
  const sixth = changes(new Map([['q', 'pending']]), [{ id: 'q', status: 'running', state: 'needs-you' }], { kindOf });
  assert.deepEqual(sixth.events.map((e) => e.event), ['started', 'needs-you']);
});

test('--kind and --every are checked', () => {
  assert.equal(parseKinds(undefined, fail), null);
  assert.deepEqual([...parseKinds('Review, qa', fail)], ['review', 'qa']);
  assert.throws(() => parseKinds(',', fail), /--kind takes/);
  assert.equal(parseEvery(undefined, fail), 15_000);
  assert.equal(parseEvery('5', fail), 5000);
  assert.throws(() => parseEvery('601', fail), /from 5 to 600/);
  assert.throws(() => parseEvery('soon', fail), /from 5 to 600/);
});
