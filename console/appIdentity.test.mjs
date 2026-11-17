import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppIdentity, hostAppIdentity } from './appIdentity.mjs';

test('the App\'s login is <slug>[bot], read from GitHub once and kept', async () => {
  let reads = 0;
  const identity = createAppIdentity({ appApi: { app: async () => { reads++; return { slug: 'acme-woodshed' }; } } });
  assert.equal(identity.available, true);
  assert.equal(identity.known(), null, 'nothing known before the first read');
  const [a, b] = await Promise.all([identity.login(), identity.login()]);
  assert.deepEqual([a, b], ['acme-woodshed[bot]', 'acme-woodshed[bot]']);
  assert.equal(await identity.login(), 'acme-woodshed[bot]');
  assert.equal(reads, 1, 'one read, shared by the calls that came at once');
  assert.deepEqual(identity.known(), { slug: 'acme-woodshed', login: 'acme-woodshed[bot]' });
});

test('a failed read answers null and is tried again; with no App there is nothing to read', async () => {
  let fail = true;
  const identity = createAppIdentity({ appApi: { app: async () => { if (fail) throw new Error('HTTP 502'); return { slug: 'acme-woodshed' }; } } });
  assert.equal(await identity.login(), null);
  fail = false;
  assert.equal(await identity.login(), 'acme-woodshed[bot]');
  const none = createAppIdentity({ appApi: null });
  assert.deepEqual([none.available, await none.login(), none.known()], [false, null, null]);
});

test('an App the host lends is the host\'s to name, asked each time, so a rename shows at once', async () => {
  let login = 'woodshed-cloud[bot]';
  const identity = hostAppIdentity(() => login);
  assert.equal(identity.available, true);
  assert.equal(await identity.login(), 'woodshed-cloud[bot]');
  assert.deepEqual(identity.known(), { slug: 'woodshed-cloud', login: 'woodshed-cloud[bot]' });
  login = 'acme-cloud[bot]';
  assert.deepEqual(identity.known(), { slug: 'acme-cloud', login: 'acme-cloud[bot]' });
  login = null;
  assert.deepEqual([await identity.login(), identity.known()], [null, null], 'not known yet');
});
