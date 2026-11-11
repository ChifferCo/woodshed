// openServiceStore: the console's {state, save} over a store something else keeps, with async load and save.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openServiceStore } from './store.mjs';

test('a service\'s store is loaded once, and every save writes the whole state in order, the latest once', async () => {
  const written = [];
  let release;
  const store = await openServiceStore({
    load: async () => ({ sessions: [{ id: 'a' }], people: { x: 1 } }),
    save: async (state) => { written.push(state); if (written.length === 1) await new Promise((r) => { release = r; }); },
  });
  assert.deepEqual(store.state, { sessions: [{ id: 'a' }], github: null, people: { x: 1 } });
  store.state.sessions.push({ id: 'b' });
  store.save();
  store.state.sessions.push({ id: 'c' });
  store.save();
  store.state.sessions.push({ id: 'd' });
  store.save();
  release();
  await store.flush();
  assert.deepEqual(written.map((s) => s.sessions.map((x) => x.id).join('')), ['ab', 'abcd'], 'the two while one was writing went as one');
  written[1].sessions.push({ id: 'z' });
  assert.equal(store.state.sessions.length, 4, 'the service got a copy');
});

test('a save the service refused is tried again, and a closed store saves nothing more', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  let fail = true;
  const written = [];
  const store = await openServiceStore({ load: async () => null, save: async (state) => { if (fail) throw new Error('down'); written.push(state); } }, { retryMs: 10 });
  store.save();
  await store.flush();
  assert.equal(written.length, 0);
  fail = false;
  await new Promise((r) => setTimeout(r, 30));
  await store.flush();
  assert.equal(written.length, 1, 'the retry wrote it');
  await store.close();
  store.state.sessions.push({ id: 'late' });
  store.save();
  await store.flush();
  assert.equal(written.length, 1);
  await assert.rejects(openServiceStore({ load: async () => [], save: async () => {} }), /not a state object/);
});
