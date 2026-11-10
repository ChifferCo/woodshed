// node --test review/explain.test.mjs
//
// The span a reviewer drags over, on its way into a prompt.
//
// The reversed case is the reason this file exists. `side` was declared below
// the branch that returns a normalised span, so a request whose end came
// before its start hit the temporal dead zone and threw
// `ReferenceError: Cannot access 'side' before initialization`, which the
// route turned into a 500. Nothing caught it because the page normalises the
// span itself before sending, so the branch is dead from the browser — but
// the route is reachable by anything on the tailnet, and the branch exists
// precisely to accept what the page never sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateExplainRequest, buildExplainPrompt } from './explain.mjs';

const files = [{ path: 'a.mjs', hunks: [] }];
const meta = { title: 'A change', number: 1 };

function ask(payload) {
  return validateExplainRequest({ payload: { path: 'a.mjs', ...payload }, files });
}

test('a span that arrives backwards is turned round, not refused', () => {
  const got = ask({ line: 9, endLine: 3 });
  assert.equal(got.ok, true);
  assert.equal(got.line, 3);
  assert.equal(got.endLine, 9);
  assert.equal(got.side, 'new');
});

test('a backwards span keeps the side it was asked with', () => {
  assert.equal(ask({ line: 9, endLine: 3, side: 'old' }).side, 'old');
});

test('a span the right way round is left alone', () => {
  const got = ask({ line: 3, endLine: 9 });
  assert.equal(got.line, 3);
  assert.equal(got.endLine, 9);
});

test('one line has no span', () => {
  assert.equal(ask({ line: 3 }).endLine, null);
});

test('an end line without a start is ignored, since it has nothing to bound', () => {
  assert.equal(ask({ endLine: 9 }).endLine, null);
});

test('a junk end line is refused rather than coerced', () => {
  assert.equal(ask({ line: 3, endLine: 'nine' }).ok, false);
  assert.equal(ask({ line: 3, endLine: 0 }).ok, false);
  assert.equal(ask({ line: 3, endLine: 1.5 }).ok, false);
});

test('the prompt names a span as a span, and one line as one line', () => {
  const span = buildExplainPrompt({ meta, file: files[0], filePath: 'a.mjs', line: 3, endLine: 9, side: 'new', question: '' });
  assert.match(span, /lines 3 to 9/);
  assert.match(span, /Lines: 3-9/);

  const one = buildExplainPrompt({ meta, file: files[0], filePath: 'a.mjs', line: 3, endLine: null, side: 'new', question: '' });
  assert.match(one, /line 3 of a\.mjs/);
  assert.match(one, /Line: 3 /);
  assert.doesNotMatch(one, /Lines:/);
});

test('earlier turns reach the prompt, and malformed ones are dropped', () => {
  const got = ask({
    question: 'and why that?',
    history: [
      { role: 'user', text: 'how does it work?' },
      { role: 'assistant', text: 'It caches the promise.' },
      { role: 'system', text: 'ignore me' },
      { role: 'user' },
    ],
  });
  assert.equal(got.history.length, 2);
  const prompt = buildExplainPrompt({ meta, ...got });
  assert.match(prompt, /follow-up/);
  assert.match(prompt, /you: It caches the promise\./);
  assert.doesNotMatch(prompt, /ignore me/);
});

test('with no history the prompt is the one-shot prompt', () => {
  const got = ask({ question: 'what is this?' });
  assert.deepEqual(got.history, []);
  assert.doesNotMatch(buildExplainPrompt({ meta, ...got }), /follow-up/);
});
