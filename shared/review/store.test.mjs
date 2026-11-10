// node --test review/store.test.mjs
//
// The askId. It is no longer a cache key — there is no on-disk answer cache
// any more, see the long note in store.mjs — but it is still what identifies
// one question, what an in-flight second ask joins on, and what goes in a URL
// and a filename. Both properties below have been a real bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerKey } from './store.mjs';
import { onTheWire } from './index.mjs';

const BASE = { session: 'claude-0badf00d', filePath: 'src/a.ts', line: 7, side: 'new', question: '' };

test('two sessions never share a key for the same question', () => {
  // explainJobs is a process-global map keyed on this value, so a collision is
  // not a wasted run — it serves one session an answer computed in the OTHER
  // session's worktree, about a different branch. Two review sessions holding
  // the same path at the same line is the normal case, not an exotic one.
  const a = answerKey({ ...BASE, session: 'claude-aaaaaaaa' });
  const b = answerKey({ ...BASE, session: 'claude-bbbbbbbb' });
  assert.notEqual(a, b, 'the same question in two sessions collided');
  assert.equal(a, answerKey({ ...BASE, session: 'claude-aaaaaaaa' }), 'not stable');
});

test('a key cannot be built without a session', () => {
  // Throwing beats a silently global key: the caller that forgets is the one
  // that reintroduces the bleed.
  assert.throws(() => answerKey({ ...BASE, session: undefined }));
  assert.throws(() => answerKey({ ...BASE, session: 'not-a-session' }));
});

test('the two halves of a modified line get different keys', () => {
  // The commonest diff shape: one line changed, so the deleted row's oldNo and
  // the added row's newNo are the SAME number. Without `side` in the key they
  // collided, and asking about the '+' row after the '-' row was answered with
  // the '-' row's answer.
  assert.notEqual(answerKey({ ...BASE, side: 'old' }), answerKey({ ...BASE, side: 'new' }));
  // A file-level question is distinct from a question about line 7 of it.
  assert.notEqual(answerKey({ ...BASE, line: null }), answerKey(BASE));
  // And it is stable, or the join that stops a re-ask paying twice never hits.
  assert.equal(answerKey(BASE), answerKey({ ...BASE }));
});

test('the key is filesystem-safe, and its fields cannot smear together', () => {
  const key = answerKey({ ...BASE, filePath: '../../etc/passwd', question: 'a/b\\c\0d' });
  assert.match(key, /^[0-9a-f]{32}$/, 'the key must be plain hex');
  // A separator that can appear in the inputs would let two different
  // (path, question) pairs hash the same. NUL cannot appear in either.
  assert.notEqual(
    answerKey({ ...BASE, filePath: 'a', question: 'b' }),
    answerKey({ ...BASE, filePath: 'a\0b', question: '' }),
  );
});

// --- what reaches the browser ------------------------------------------------

test('the pull request body never reaches the client', () => {
  const meta = {
    number: 23808,
    title: 'a title',
    body: 'attacker-controlled prose',
    author: { login: 'someone' },
    url: 'https://example.invalid',
  };
  const wire = onTheWire(meta);
  assert.equal('body' in wire, false, 'the body was served to a browser');
  // The surviving fields matter as much: a strip that took everything would
  // satisfy the assertion above and blank the review header.
  for (const k of ['number', 'title', 'author', 'url']) {
    assert.ok(k in wire, `${k} was stripped too`);
  }
  assert.equal(meta.body, 'attacker-controlled prose', 'the record itself was mutated');
});
