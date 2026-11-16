import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { matchPulls, workOnFor, pullsNote } = createRequire(import.meta.url)('./public/openPulls.cjs');

const pulls = [
  { number: 26030, title: 'Fix the login redirect', branch: 'fix-login', author: 'ann' },
  { number: 2612, title: 'Billing currency', branch: 'woodshed/bob-1234', author: 'bob' },
  { number: 311, title: 'Docs', branch: 'docs', author: null },
];

test('nothing typed lists every open pull request, in its order', () => {
  assert.deepEqual(matchPulls(pulls, '  '), pulls);
});

test('a number, with or without # or PR, matches pull requests whose number starts with it', () => {
  for (const typed of ['26', '#26', 'PR #26', 'pr 26', 'PR#26']) {
    assert.deepEqual(matchPulls(pulls, typed).map((p) => p.number), [26030, 2612], typed);
  }
  assert.deepEqual(matchPulls(pulls, 'PR #26030').map((p) => p.number), [26030]);
});

test('words match the title, branch or author, any case, every word', () => {
  assert.deepEqual(matchPulls(pulls, 'LOGIN').map((p) => p.number), [26030]);
  assert.deepEqual(matchPulls(pulls, 'bob').map((p) => p.number), [2612]);
  assert.deepEqual(matchPulls(pulls, 'woodshed/').map((p) => p.number), [2612]);
  assert.deepEqual(matchPulls(pulls, 'fix ann').map((p) => p.number), [26030]);
  assert.deepEqual(matchPulls(pulls, 'fix bob'), []);
});

test('a picked pull request goes into Work on as PR #<number>', () => {
  assert.equal(workOnFor(pulls[0]), 'PR #26030');
});

test('the note says when nothing is open, nothing matches, the list is cut short or old', () => {
  assert.equal(pullsNote({ shown: 3, listed: 3, total: 3, stale: false }), '');
  assert.equal(pullsNote({ shown: 0, listed: 0, total: 0, stale: false }), 'No open pull requests');
  assert.equal(pullsNote({ shown: 0, listed: 0, total: 0, stale: true }), 'GitHub did not answer, so no open pull requests to show');
  assert.equal(pullsNote({ shown: 0, listed: 3, total: 3, stale: false }), 'No open pull request matches. Start takes what is typed, a branch too');
  assert.equal(pullsNote({ shown: 5, listed: 100, total: 140, stale: false }), 'The 100 updated last of 140 open; Start takes any number typed');
  assert.equal(pullsNote({ shown: 2, listed: 2, total: 2, stale: true }), 'GitHub did not answer, so this is the list from before');
});
