import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebhookEvents } from './webhookEvents.mjs';

const DAY_MS = 24 * 3_600_000;
const label = { source: 'github', type: 'label', number: 7, label: 'woodshed', login: 'joel', receivedAt: 't' };

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-events-')), 'webhookEvents.jsonl');
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

test('each message is one appended line, and the list is newest first', () => {
  const file = tempFile();
  const events = createWebhookEvents({ file, now: () => Date.parse('2026-11-01T10:00:00Z') });
  assert.deepEqual(events.list(), [], 'no file yet is an empty list');
  events.record({ ...label, number: 1 }, { outcome: 'started', sessionId: 'abcd1234' });
  events.record({ ...label, number: 2 }, { outcome: 'ignored', reason: 'r' });
  assert.equal(lines(file).length, 2);
  assert.deepEqual(events.list().map((e) => [e.number, e.outcome, e.sessionId, e.reason]), [[2, 'ignored', null, 'r'], [1, 'started', 'abcd1234', null]]);
});

test('the list shows the last 7 days, and the sweep takes older lines out of the file', () => {
  const file = tempFile();
  let nowMs = Date.parse('2026-11-01T10:00:00Z');
  const events = createWebhookEvents({ file, now: () => nowMs });
  events.record({ ...label, number: 1 }, { outcome: 'started' });
  nowMs += 6 * DAY_MS;
  events.record({ ...label, number: 2 }, { outcome: 'started' });
  assert.deepEqual(events.list().map((e) => e.number), [2, 1], 'six days old is still shown');

  nowMs += 2 * DAY_MS;
  assert.deepEqual(events.list().map((e) => e.number), [2], 'eight days old leaves the list');
  assert.equal(lines(file).length, 2, 'and stays in the file until the sweep');
  events.sweep();
  assert.deepEqual(lines(file).map((l) => JSON.parse(l).number), [2]);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('a half-written line is skipped, and the sweep drops it', () => {
  const file = tempFile();
  const events = createWebhookEvents({ file, now: () => Date.parse('2026-11-01T10:00:00Z') });
  events.record({ ...label, number: 1 }, { outcome: 'started' });
  fs.appendFileSync(file, '{"handledAt":"2026-11-01T10:00:00.000Z","num');
  assert.deepEqual(events.list().map((e) => e.number), [1]);
  events.sweep();
  assert.equal(lines(file).length, 1);
});

test('the log kept in state.json is moved into the file once, oldest first, and deleted from the state', () => {
  const file = tempFile();
  let saves = 0;
  const store = {
    state: { webhookEvents: [{ handledAt: '2026-11-01T09:00:00.000Z', number: 2 }, { handledAt: '2026-11-01T08:00:00.000Z', number: 1 }] },
    save() { saves++; },
  };
  const events = createWebhookEvents({ file, store, now: () => Date.parse('2026-11-01T10:00:00Z') });
  assert.equal('webhookEvents' in store.state, false);
  assert.equal(saves, 1);
  assert.deepEqual(lines(file).map((l) => JSON.parse(l).number), [1, 2]);
  events.record({ ...label, number: 3 }, { outcome: 'started' });
  assert.deepEqual(events.list().map((e) => e.number), [3, 2, 1]);

  createWebhookEvents({ file, store, now: () => Date.parse('2026-11-01T10:00:00Z') });
  assert.equal(saves, 1, 'a second start has nothing to move');
  assert.equal(lines(file).length, 3);
});
