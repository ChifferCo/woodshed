import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOf } from './liveTestPaging.mjs';

test('pages count from 1, and the last page holds what is left', () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(pageOf({ items, page: 1, size: 2 }), [1, 2]);
  assert.deepEqual(pageOf({ items, page: 3, size: 2 }), [5]);
  assert.deepEqual(pageOf({ items, page: 4, size: 2 }), []);
});
