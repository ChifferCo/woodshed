// node --test review/highlight.test.mjs
//
// Three tests, deliberately. The tokenizer's wrong answers are wrong COLOURS —
// visible, harmless and instantly obvious — so the dialect tables and the
// individual comment styles are not worth guarding. What is guarded is the one
// failure mode that is neither visible nor harmless: the function is shipped to
// the browser as source text, where a free variable throws at runtime having
// parsed perfectly here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenizeLine } from './highlight.mjs';

function joined(text, dialect) {
  return tokenizeLine(text, dialect).map((s) => s.text).join('');
}
// --- the constraint that makes the client copy work -------------------------

test('tokenizeLine survives round-tripping through new Function', () => {
  // page.mjs ships this function by interpolating `tokenizeLine.toString()`
  // into the served script. A reference to any module-scope constant would
  // parse cleanly there and then throw ReferenceError in the browser, so the
  // only reliable check is to rebuild it with no scope at all and run it.
  const rebuilt = new Function(`return (${tokenizeLine.toString()});`)();
  const spans = rebuilt("const a = 'x'; // note", 'c');
  assert.deepEqual(
    spans.map((s) => [s.cls, s.text]),
    [
      ['k', 'const'],
      ['', ' a = '],
      ['s', "'x'"],
      ['', '; '],
      ['c', '// note'],
    ],
  );
});

test('the round-trip check actually fails when a free variable is introduced', () => {
  // Negative control. Without this, the test above would pass for a function
  // that happens not to have the bug, and keep passing if someone later hoists
  // a constant out of the body.
  const leaky = 'function leaky(t) { return HOISTED_TABLE.test(t); }';
  const rebuilt = new Function(`return (${leaky});`)();
  assert.throws(() => rebuilt('x'), ReferenceError);
});

// --- correctness ------------------------------------------------------------

test('never drops or reorders characters, whatever the dialect', () => {
  const samples = [
    "const s = 'a\\'b'; // trailing",
    'x = "unterminated',
    '/* block */ code /* another',
    '#!/usr/bin/env bash',
    'SELECT * FROM t -- note',
    'plain text with no syntax at all',
    '',
    '`template ${with} parts`',
  ];
  for (const dialect of ['c', 'h', 'q', '']) {
    for (const s of samples) {
      assert.equal(joined(s, dialect), s, `${dialect}: ${JSON.stringify(s)}`);
    }
  }
});
