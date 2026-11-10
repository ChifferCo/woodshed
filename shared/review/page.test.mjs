// node --test review/page.test.mjs
//
// The whole review document lives inside one template literal, so a backtick
// anywhere in it — including inside a comment, which is where it keeps
// happening — ends the literal and the page stops parsing.
//
// `install.sh --check` already catches this, by booting an instance, fetching
// the page and re-parsing its inline script. That takes seconds and needs a
// free port. This takes milliseconds and needs neither, which is the whole
// point: the mistake is cheap to make and should be cheap to catch.
//
// The same goes for `${`, which would be read as an interpolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'page.mjs'), 'utf-8');

/** The body of the one template literal this file is. */
function literalBody() {
  const open = 'export const REVIEW_HTML = `';
  const start = source.indexOf(open);
  assert.notEqual(start, -1, 'REVIEW_HTML is not declared the way this test expects');
  const body = source.slice(start + open.length);
  const end = body.lastIndexOf('`;');
  assert.notEqual(end, -1, 'REVIEW_HTML has no closing backtick');
  return body.slice(0, end);
}

test('no bare backtick inside the page literal', () => {
  const body = literalBody();
  const lines = body.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    // An escaped one is deliberate and fine; a bare one is the bug.
    if (/(^|[^\\])`/.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  assert.deepEqual(offenders, [], `backtick inside REVIEW_HTML:\n${offenders.join('\n')}`);
});

// The three shapes the file means (DARK_PALETTE appears twice). Everything else in it is literal text, so a fifth
// is a mistake rather than a feature: a `${...}` written by accident inside
// what looks like plain CSS or JavaScript runs at module load and disappears
// into the page.
const MEANT = ['${DARK_PALETTE}', '${tokenizeLine.toString()}', '${createAskState.toString()}'];

test('the only interpolations are the ones the file means', () => {
  const body = literalBody();
  const found = body.match(/(?<!\\)\$\{[^}]*\}/g) || [];
  const unexpected = [...new Set(found)].filter((one) => !MEANT.includes(one));
  assert.deepEqual(unexpected, [], `unexpected interpolation in REVIEW_HTML: ${unexpected.join(', ')}`);
});

test('the literal is closed exactly once', () => {
  // Two would mean the parser sees a second literal somewhere, which is how a
  // stray backtick presents when it happens to pair up with another.
  assert.equal(source.split('export const REVIEW_HTML = `').length, 2);
});
