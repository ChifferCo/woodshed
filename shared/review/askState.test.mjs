// node --test review/askState.test.mjs
//
// The only client-side logic in the feature that is unit tested, and the only
// place where adding coverage while cutting everywhere else is clearly right:
// this area has regressed four separate times, every regression was invisible
// to `node --check`, and every one of them was a user typing a question and
// getting somebody else's back.
//
// The four, for the record — each fix introduced the next:
//   1. answers lived only in the DOM, so a re-render lost them;
//   2. drafts hung off the "currently open" object, which close() nulls;
//   3. the draft was stashed at render time and keyed off that same variable
//      AFTER the handlers had reassigned it, filing A's text under B's key;
//   4. focus was applied by the panel's own render, so any unrelated rebuild
//      stole the caret back.
//
// The invariants below have to hold SIMULTANEOUSLY. Several of those fixes
// satisfied one by breaking another, which is why they are asserted together
// rather than one per test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAskState } from './askState.mjs';

const A = 'src/a.ts|file';
const B = 'src/b.ts|file';

test('createAskState survives round-tripping through new Function', () => {
  // page.mjs ships this by interpolating createAskState.toString() into the
  // served script, exactly as it does tokenizeLine. A reference to any
  // module-scope binding parses cleanly here and throws ReferenceError in the
  // browser, so the only reliable check is to rebuild it with no scope at all.
  const rebuilt = new Function(`return (${createAskState.toString()});`)();
  const state = rebuilt();
  state.open(A);
  state.setDraft(A, 'why');
  assert.equal(state.draft(A), 'why');
  assert.equal(state.isOpen(A), true);
});

test('the round-trip check actually fails when a free variable is introduced', () => {
  // Negative control, same as highlight.test.mjs. Without it the test above
  // would pass for a function that happens not to have the bug, and keep
  // passing after someone hoisted a constant out of the body.
  const leaky = 'function leaky() { return { draft: function () { return HOISTED.x; } }; }';
  const rebuilt = new Function(`return (${leaky});`)();
  assert.throws(() => rebuilt().draft(), ReferenceError);
});

test('a draft belongs to the anchor it was typed at, permanently', () => {
  const state = createAskState();

  // Type at A, then open B: B must be empty. This is bug 3 — the draft used to
  // be filed under whichever anchor had just been opened.
  state.open(A);
  state.setDraft(A, 'what does this do');
  state.open(B);
  assert.equal(state.draft(B), '', 'B prefilled with A’s question');

  // Reopen A: its own text is still there. This is bug 2, and it is the half a
  // naive "clear the draft on close" fix breaks while passing the assertion
  // above — so both are asserted in one test on purpose.
  state.open(A);
  assert.equal(state.draft(A), 'what does this do');

  // Closing is not losing, either.
  state.close();
  assert.equal(state.openAnchor(), null);
  assert.equal(state.draft(A), 'what does this do');
});

test('an answer belongs to a question, not just to a place', () => {
  const state = createAskState();
  state.open(A);
  state.setDraft(A, 'why');
  state.setAnswer(A, 'why', { text: 'because' });

  assert.equal(state.answer(A, 'why').text, 'because');
  // Editing the question must hide an answer that no longer replies to it...
  assert.equal(state.answer(A, 'why not'), null);
  // ...and retyping the original must bring it back rather than re-running a
  // paid job.
  assert.equal(state.answer(A, 'why').text, 'because');
  // Another anchor never sees it.
  assert.equal(state.answer(B, 'why'), null);

  // A question that names something on Object.prototype is a question, not a
  // lookup: without the key prefix, asking "constructor" returned a function.
  assert.equal(state.answer(A, 'constructor'), null);
  assert.equal(state.answer(A, '__proto__'), null);
});

test('focus is a one-shot request, not a property of being open', () => {
  const state = createAskState();

  // Bug 4. render() runs on the 2s poll, on every file expand and when the
  // artifact lands; each of those rebuilds an open panel. Only the render that
  // follows the click may take the caret.
  state.open(A);
  assert.equal(state.takeFocus(A), true, 'the opening render should focus');
  assert.equal(state.takeFocus(A), false, 'a later render must not re-focus');
  assert.equal(state.takeFocus(A), false);

  // Still open — focus being spent says nothing about visibility.
  assert.equal(state.isOpen(A), true);

  // Opening another panel arms it for that one only.
  state.open(B);
  assert.equal(state.takeFocus(A), false, 'A must not steal focus back from B');
  assert.equal(state.takeFocus(B), true);

  // Toggling shut disarms it, so the render that removes the panel cannot
  // leave a request behind for the next one to consume.
  state.toggle(B);
  assert.equal(state.isOpen(B), false);
  assert.equal(state.takeFocus(B), false);
});

test('an anchor distinguishes the two halves of a modified line', () => {
  const state = createAskState();
  // Same number on the deleted and added rows of a one-line change. Sharing an
  // anchor would share a panel, a draft and an answer between them.
  assert.notEqual(state.anchorKey('a.ts', 7, 'old'), state.anchorKey('a.ts', 7, 'new'));
  assert.notEqual(state.anchorKey('a.ts', null, null), state.anchorKey('a.ts', 7, 'new'));
  assert.equal(state.anchorKey('a.ts', 7, 'new'), state.anchorKey('a.ts', 7, 'new'));
});

test('a thread keeps each anchor\'s turns in order and hands out copies', () => {
  const s = createAskState();
  s.addTurn(A, 'how does this work?', { text: 'It does X.', steps: 2 });
  s.addTurn(A, 'and why X?', { text: 'Because Y.' });
  const t = s.thread(A);
  assert.deepEqual(t.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(t[3].text, 'Because Y.');
  assert.deepEqual(s.thread(B), []);
  t.pop();
  assert.equal(s.thread(A).length, 4);
});
