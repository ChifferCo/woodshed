import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSecretStore } from './secretStore.mjs';

test('the store declares Secrets Manager\'s 64 KB limit on one value', () => {
  assert.equal(createSecretStore({ prefix: 'demo/', aws: async () => ({}), specs: [] }).maxValueBytes, 65_536);
});
