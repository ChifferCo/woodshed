import { test } from 'node:test';
import assert from 'node:assert/strict';

import setup from './public/setupSteps.cjs';

const { setupSteps, setupDone } = setup;
const me = ({ token = false, db = null } = {}) => ({ login: 'mia-dev', claudeToken: { set: token }, databases: db });
const rows = (m) => setupSteps(m).map((s) => `${s.key}:${s.done ? 'done' : s.todo ? 'todo' : 'waiting'}`);

test('the setup card lists only what is left: the token, then the databases once the token is saved', () => {
  assert.deepEqual(rows(me({ db: { available: true, status: 'none' } })), ['token:waiting'], 'nothing about databases before the token');
  assert.deepEqual(rows(me({ token: true, db: { available: true, status: 'working' } })), ['token:done', 'databases:waiting'], 'a copy in progress is progress');
  assert.deepEqual(rows(me({ token: true, db: { available: true, status: 'ready' } })), ['token:done', 'databases:done']);
  assert.deepEqual(rows(me({ token: true, db: { available: false, status: 'none' } })), ['token:done'], 'a console with no databases of their own leaves the row out');
});

test('a copy that failed, or never started after the token, is something to do, so the card never sits empty', () => {
  assert.deepEqual(rows(me({ token: true, db: { available: true, status: 'failed' } })), ['token:done', 'databases:todo']);
  assert.deepEqual(rows(me({ token: true, db: { available: true, status: 'none' } })), ['token:done', 'databases:todo']);
});

test('setup is done with the token and ready databases, or the token alone on a console with none', () => {
  assert.equal(setupDone(me({ token: true, db: { available: true, status: 'ready' } })), true);
  assert.equal(setupDone(me({ token: true, db: { available: false } })), true);
  assert.equal(setupDone(me({ token: true, db: null })), true, 'an answer with no databases at all');
  assert.equal(setupDone(me({ token: true, db: { available: true, status: 'working' } })), false, 'the server refuses a start until they are ready');
  assert.equal(setupDone(me({ token: false, db: { available: true, status: 'ready' } })), false);
});

test('a console with no GitHub App puts connecting one first, and is not done until it has', () => {
  const m = { ...me({ token: true, db: { available: true, status: 'ready' } }), githubSetupNeeded: true };
  assert.deepEqual(rows(m), ['github:waiting', 'token:done', 'databases:done']);
  assert.equal(setupDone(m), false);
});
