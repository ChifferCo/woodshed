import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KEPT_RERUN, createKeptReviews, gatesWithKeptReview, validRerun, withKeptReview } from './keptReview.mjs';
import { withAppLogins } from './reviewLogins.mjs';

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('a console of its own keeps it in its state, by repo in lower case, and takes it off again', async (t) => {
  quiet(t);
  const saves = [];
  const store = { state: {}, save() { saves.push(JSON.stringify(this.state.keptReviews)); } };
  const kept = createKeptReviews({ store, now: () => Date.parse('2026-11-22T10:00:00Z') });
  assert.equal(kept.where, 'console');
  assert.equal(await kept.of('acme/game'), null);
  const on = await kept.set('Acme/Game', { on: true, by: 'bob' });
  assert.deepEqual(on, {
    review: { author: null, heading: '## Woodshed review', workflow: null, rerun: KEPT_RERUN, commentAuthor: null, runner: 'woodshed' },
    by: 'bob', at: '2026-11-22T10:00:00.000Z',
  });
  assert.deepEqual(store.state.keptReviews, { 'acme/game': { review: { runner: 'woodshed', rerun: KEPT_RERUN }, by: 'bob', at: '2026-11-22T10:00:00.000Z' } });
  assert.deepEqual(await kept.of('ACME/game'), on);
  await kept.set('acme/game', { on: true, rerun: null, by: 'ann' });
  assert.equal((await kept.of('acme/game')).review.rerun, null, 'every commit');
  assert.equal(await kept.set('acme/game', { on: false, by: 'ann' }), null);
  assert.deepEqual(store.state.keptReviews, {});
  assert.equal(saves.length, 3);
  await assert.rejects(kept.set('acme/game', { on: true, rerun: 'two\nlines' }), /one line/);
});

test('what does not read as a kept review is none', async (t) => {
  quiet(t);
  const store = { state: { keptReviews: { 'acme/a': 'on', 'acme/b': { review: { rerun: 5 } }, 'acme/c': { review: {} } } }, save() {} };
  const kept = createKeptReviews({ store });
  assert.equal(await kept.of('acme/a'), null);
  assert.equal(await kept.of('acme/b'), null);
  assert.equal((await kept.of('acme/c')).review.rerun, KEPT_RERUN, 'no tag given is the default');
  assert.deepEqual([validRerun(null), validRerun('[x]'), validRerun(''), validRerun('x'.repeat(101))], [true, true, false, false]);
});

test('an embedding program keeps it in its own store: asked again after a minute, its last answer kept when it fails', async (t) => {
  quiet(t);
  let clock = 0;
  const program = {
    kept: new Map(), gets: 0, fail: false, sets: [],
    async get(repo) { program.gets += 1; if (program.fail) throw new Error('database gone'); return program.kept.get(repo) ?? null; },
    async set(repo, value, who) { program.sets.push([repo, value, who]); program.kept.set(repo, value); },
  };
  const store = { state: {}, save() { assert.fail('the program keeps it, not the state'); } };
  const kept = createKeptReviews({ store, host: program, now: () => clock });
  assert.equal(kept.where, 'program');
  assert.equal(await kept.of('acme/game'), null);
  assert.equal(await kept.of('acme/game'), null);
  assert.equal(program.gets, 1, 'kept a minute');
  await kept.set('acme/game', { on: true, by: 'bob' });
  assert.deepEqual(program.sets[0], ['acme/game', { review: { runner: 'woodshed', rerun: KEPT_RERUN }, by: 'bob', at: '1970-01-01T00:00:00.000Z' }, { by: 'bob' }]);
  assert.equal((await kept.of('acme/game')).review.runner, 'woodshed', 'its own change is seen at once');
  assert.equal(program.gets, 1);
  clock = 60_001;
  program.fail = true;
  assert.equal((await kept.of('acme/game')).review.runner, 'woodshed', 'the last answer, while the program fails');
  await assert.rejects(kept.of('acme/other'), /whether acme\/other's review is kept on could not be read: database gone/);
  assert.throws(() => createKeptReviews({ store, host: { get() {} } }), /reviewKeeping needs get and set/);
});

test('the fleet\'s gates: the file\'s review wins, the kept one fills in where it names none or there is no file', async () => {
  const kept = { review: { author: null, heading: '## Woodshed review', workflow: null, rerun: KEPT_RERUN, commentAuthor: null, runner: 'woodshed' } };
  assert.deepEqual(withKeptReview(null, kept), { suites: [], qa: null, mergeRisk: null, review: kept.review });
  const suites = [{ name: 'CI', workflow: '.github/workflows/ci.yml', jobs: 'test', rerun: null }];
  assert.deepEqual(withKeptReview({ review: null, suites, qa: null, mergeRisk: null, runsOn: 'a[bot]' }, kept), { review: kept.review, suites, qa: null, mergeRisk: null, runsOn: 'a[bot]' }, 'the file\'s suites and runsOn stay');
  const own = { review: { runner: 'actions' }, suites: [] };
  assert.equal(withKeptReview(own, kept), own);
  assert.equal(withKeptReview(null, null), null);

  const asked = [];
  const read = gatesWithKeptReview({ pullRequestsOf: async (name) => (name === 'own' ? own : null), keptOf: async (name) => { asked.push(name); return kept; } });
  assert.equal(await read('own'), own);
  assert.deepEqual(asked, [], 'the kept one is not read while the file names a review');
  const gates = withAppLogins(await read('bare'), { reviewerLogin: 'acme-reviewer[bot]', ownLogin: 'acme-woodshed[bot]' });
  assert.deepEqual([gates.review.runner, gates.review.author, gates.review.commentAuthor], ['woodshed', 'acme-reviewer[bot]', 'acme-woodshed[bot]'], 'trusted as the console\'s own Apps, as a file\'s session review is');
});
