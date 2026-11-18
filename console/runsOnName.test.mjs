import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config.mjs';

test('WOODSHED_RUNS_ON_NAME names this one of an App\'s consoles for pullRequests.runsOn, and must be a plain name', () => {
  assert.equal(loadConfig({ WOODSHED_RUNS_ON_NAME: 'acme-2' }, { readGhToken: false }).runsOnName, 'acme-2');
  assert.equal(loadConfig({}, { readGhToken: false }).runsOnName, null);
  for (const bad of ['Acme', 'a b', 'a/b', '-a']) {
    assert.throws(() => loadConfig({ WOODSHED_RUNS_ON_NAME: bad }, { readGhToken: false }), /WOODSHED_RUNS_ON_NAME must be lowercase letters/, bad);
  }
});
