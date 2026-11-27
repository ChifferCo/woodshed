import { test } from 'node:test';
import assert from 'node:assert/strict';

import kept from './public/keptMachine.cjs';

test('a machine that is not outdated, or was not read, offers nothing more than Resume', () => {
  for (const machine of [null, undefined, { kept: false, outdated: false }, { kept: true, outdated: false }]) {
    assert.equal(kept.offer({ status: 'failed' }, machine), null);
    assert.equal(kept.offer({ status: 'stopped' }, machine), null);
  }
});

test('a failed session on an outdated machine leads with the latest image and says the failure may be the image', () => {
  const offer = kept.offer({ status: 'failed' }, { kept: true, outdated: true });
  assert.equal(offer.lead, 'latest');
  assert.match(offer.head, /failed on its machine.s older image/);
  assert.match(offer.note, /Resume on the latest image/);
});

test('a stopped session on an outdated machine keeps Resume first, with the quiet note', () => {
  const offer = kept.offer({ status: 'stopped' }, { kept: true, outdated: true });
  assert.equal(offer.lead, 'resume');
  assert.match(offer.note, /older image/);
});
