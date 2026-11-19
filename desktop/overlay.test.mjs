import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BADGE_LABELS, overlayFor } from './overlay.mjs';

test('the overlay shows the count, in an image and in words, and goes at none', () => {
  assert.equal(overlayFor(0), null);
  assert.deepEqual(overlayFor(1), { image: 'badge-1.png', description: '1 session needs you' });
  assert.deepEqual(overlayFor(2), { image: 'badge-2.png', description: '2 sessions need you' });
  assert.deepEqual(overlayFor(9), { image: 'badge-9.png', description: '9 sessions need you' });
  assert.deepEqual(overlayFor(12), { image: 'badge-9plus.png', description: '12 sessions need you' });
  for (const bad of [-1, NaN, undefined, null, 'x']) assert.equal(overlayFor(bad), null, String(bad));
});

test('every image the overlay names is in badges/', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const { image } = overlayFor(n);
    assert.ok(existsSync(fileURLToPath(new URL(`./badges/${image}`, import.meta.url))), image);
  }
  assert.equal(Object.keys(BADGE_LABELS).length, 10);
});
