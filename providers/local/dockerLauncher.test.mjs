import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDockerPort } from './dockerLauncher.mjs';

test('parseDockerPort reads the host port docker published', () => {
  assert.equal(parseDockerPort('127.0.0.1:49153'), 49153);
  assert.equal(parseDockerPort('0.0.0.0:49153\n[::]:49153'), 49153);
  assert.equal(parseDockerPort(''), null);
});
