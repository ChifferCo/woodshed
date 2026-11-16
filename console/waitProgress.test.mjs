// A start waiting for room, with the steps its launcher reports: what the fleet keeps of a launcher's answer
// (sessions.mjs, waitProgressFrom) and how the session page reads them (public/common.js, waitProgress).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { waitProgressFrom } from './sessions.mjs';

const require = createRequire(import.meta.url);

function loadCommon() {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console,
    document: { addEventListener() {}, createElement: () => ({}) },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8'), context);
  return window.Woodshed;
}

const W = loadCommon();
const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
// Plain values from the page's realm, so deepEqual compares what they hold.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the fleet keeps the steps it can show, each value cut to a size the page lays out', () => {
  assert.equal(waitProgressFrom(null), null);
  assert.equal(waitProgressFrom({ steps: 'not a list' }), null);
  assert.equal(waitProgressFrom({ steps: [{ label: 'x', state: 'skipped' }] }), null, 'no step it knows is no progress');
  const { steps } = waitProgressFrom({ steps: [
    { label: 'A '.repeat(100), state: 'done', at: 'yesterday' },
    { label: 'Second', state: 'current', note: 'n'.repeat(500), at: at(5), extra: 'dropped' },
    { label: 'Third', state: 'failed', note: 42 },
  ] });
  assert.equal(steps[0].label.length, 80);
  assert.ok(steps[0].label.endsWith('…'));
  assert.equal(steps[0].at, null, 'a time it cannot read is left out');
  assert.equal(steps[1].note.length, 200);
  assert.deepEqual(Object.keys(steps[1]), ['label', 'state', 'note', 'at']);
  assert.equal(steps[2].note, null);
  assert.equal(waitProgressFrom({ steps: Array.from({ length: 30 }, (_, i) => ({ label: `Step ${i}`, state: 'pending' })) }).steps.length, 20);
});

test('the page times each step from its start to the next one\'s, the current one to now, and the wait from the first', () => {
  const s = { waitProgress: { steps: [
    { label: 'Creating a machine', state: 'done', note: null, at: at(0) },
    { label: 'Installing Docker', state: 'done', note: null, at: at(12) },
    { label: 'Building the image', state: 'current', note: 'step 4 of 9', at: at(40) },
    { label: 'Starting the databases', state: 'pending', note: null, at: null },
  ] } };
  const { steps, since } = W.waitProgress(s, T0 + 47_000);
  assert.deepEqual(plain(steps), [
    { label: 'Creating a machine', note: null, state: 'done', seconds: 12 },
    { label: 'Installing Docker', note: null, state: 'done', seconds: 28 },
    { label: 'Building the image', note: 'step 4 of 9', state: 'now', seconds: 7 },
    { label: 'Starting the databases', note: null, state: 'next', seconds: null },
  ]);
  assert.equal(since, at(0));
  assert.equal(W.clock(since, T0 + 47_000), '0:47');
});

test('a failed step shows as failed with its note, and the wait\'s clock stops showing', () => {
  const s = { waitProgress: { steps: [
    { label: 'Creating a machine', state: 'done', note: null, at: at(0) },
    { label: 'Installing Docker', state: 'failed', note: 'apt-get exited 100', at: at(12) },
  ] } };
  const { steps, since } = W.waitProgress(s, T0 + 60_000);
  assert.deepEqual(plain(steps[1]), { label: 'Installing Docker', note: 'apt-get exited 100', state: 'failed', seconds: null });
  assert.equal(since, null);
});

test('a done step with no later start, or none given, has no seconds', () => {
  const s = { waitProgress: { steps: [{ label: 'Only', state: 'done', note: null, at: at(0) }] } };
  assert.equal(W.waitProgress(s, T0 + 5_000).steps[0].seconds, null);
  assert.deepEqual(plain(W.waitProgress({}, T0)), { steps: [], since: null });
});
