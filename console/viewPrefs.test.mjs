import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createViewPrefs } from './viewPrefs.mjs';

test('pins are each person\'s own, and only sessions they can still see come back', () => {
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const prefs = createViewPrefs(store);
  prefs.setPinned('joel', '0a1b2c3d', true);
  prefs.setPinned('joel', '7c21e0d4', true);
  prefs.setPinned('joel', '0a1b2c3d', false);

  assert.deepEqual(prefs.view('joel'), { pinned: ['7c21e0d4'] });
  assert.deepEqual(prefs.view('mia'), { pinned: [] });
  assert.deepEqual(prefs.view('joel', new Set(['0a1b2c3d'])), { pinned: [] }, 'a removed session is left out');

  assert.throws(() => prefs.setPinned('joel', '../x', true), /session id/);
  assert.ok(store.saves >= 3);
});

test('the list stays bounded', () => {
  const prefs = createViewPrefs({ state: {}, save() {} });
  for (let i = 0; i < 230; i += 1) {
    const id = i.toString(16).padStart(8, '0');
    prefs.setPinned('joel', id, true);
  }
  const view = prefs.view('joel');
  assert.equal(view.pinned.length, 200);
  assert.equal(view.pinned.at(-1), (229).toString(16).padStart(8, '0'), 'the newest pin is kept');
});

test('the old fold choices are dropped from the stored state, and the pins stay', () => {
  const store = { state: { viewPrefs: { joel: { pinned: ['0a1b2c3d'], folded: { '0a1b2c3d': true }, startFolded: true } } }, saves: 0, save() { this.saves += 1; } };
  const prefs = createViewPrefs(store);
  assert.deepEqual(store.state.viewPrefs.joel, { pinned: ['0a1b2c3d'] });
  assert.deepEqual(prefs.view('joel'), { pinned: ['0a1b2c3d'] });
  assert.equal(store.saves, 1);
  createViewPrefs(store);
  assert.equal(store.saves, 1, 'nothing left to drop the second time');
});
