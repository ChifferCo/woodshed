import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createTerminalCache } = createRequire(import.meta.url)('./public/terminalCache.js');

test('the oldest terminal goes when a fifth is visited, and the one on screen stays', () => {
  const cache = createTerminalCache({ max: 4 });
  for (const k of ['a', 'b', 'c', 'd']) assert.deepEqual(cache.touch(k), []);
  assert.deepEqual(cache.touch('e'), ['a']);
  assert.deepEqual(cache.keys(), ['b', 'c', 'd', 'e']);
});

test('coming back to a kept terminal drops nothing and makes it the newest', () => {
  const cache = createTerminalCache({ max: 3 });
  for (const k of ['a', 'b', 'c']) cache.touch(k);
  assert.deepEqual(cache.touch('a'), []);
  assert.deepEqual(cache.keys(), ['b', 'c', 'a']);
});

test('retain drops terminals whose session stopped or restarted', () => {
  const cache = createTerminalCache({ max: 4 });
  for (const k of ['a:1', 'b:1']) cache.touch(k);
  assert.deepEqual(cache.retain(new Set(['a:2', 'b:1'])), ['a:1']);
  assert.deepEqual(cache.keys(), ['b:1']);
});
