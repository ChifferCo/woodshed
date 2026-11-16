import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOf } from './liveTestPaging.mjs';

test('a page has at most size items', () => {
  assert.ok(pageOf({ items: [1, 2, 3, 4, 5], page: 1, size: 2 }).length <= 2);
});
