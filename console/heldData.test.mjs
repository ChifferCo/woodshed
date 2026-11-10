import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHeldData, heldReport } from './heldData.mjs';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const MINUTE = 60_000;

function session(fields) {
  return { kind: 'issue', number: 42, title: 't', status: 'stopped', owner: null, ...fields };
}

test('a kept session is held with its database, its saved conversation and when it goes', () => {
  const { held, stalled, totals } = heldReport({
    sessions: [session({ id: 'aaaaaaaa', kept: true, stopReason: 'posted to Slack', deletesAt: '2026-11-09T12:00:00.000Z', prUrl: 'https://github.com/o/r/pull/7' })],
    records: { aaaaaaaa: { status: 'ready', action: 'clone' } },
    homes: [{ id: 'aaaaaaaa', bytes: 84_000_000 }],
    now: NOW, dropRetryMs: 10 * MINUTE,
  });
  assert.deepEqual(stalled, []);
  assert.deepEqual([held[0].database, held[0].home, held[0].stopReason, held[0].deletesAt],
    ['woodshed__aaaaaaaa', true, 'posted to Slack', '2026-11-09T12:00:00.000Z']);
  assert.deepEqual(totals, { databases: 1, homes: 1, homeBytes: 84_000_000 });
});

test('stalled: stuck stopping, a drop that failed, databases and a home with no session, never a private session', () => {
  const { held, stalled } = heldReport({
    sessions: [
      session({ id: 'bbbbbbbb', status: 'stopping', stoppingAt: new Date(NOW - 42 * MINUTE).toISOString() }),
      session({ id: 'cccccccc', kept: false, cleanedAt: new Date(NOW - 2 * 86_400_000).toISOString() }),
      session({ id: 'dddddddd', status: 'stopping', stoppingAt: new Date(NOW - 5 * MINUTE).toISOString() }),
      session({ id: 'eeeeeeee', status: 'starting', startedAt: new Date(NOW - 60 * MINUTE).toISOString(), owner: 'mia', title: 'private' }),
    ],
    records: {
      bbbbbbbb: { status: 'ready', action: 'clone' },
      cccccccc: { status: 'failed', action: 'remove', error: 'the task exited with 1' },
      ffffffff: { status: 'failed', action: 'remove' },
      '00000000': { status: 'working', action: 'remove', startedAt: new Date(NOW - MINUTE).toISOString() },
    },
    homes: [{ id: '11111111', bytes: 3_000_000 }],
    now: NOW, dropRetryMs: 10 * MINUTE,
  });
  assert.deepEqual(held, []);
  assert.deepEqual(stalled.map((r) => [r.kind, r.id]), [
    ['stuck', 'bbbbbbbb'], ['databases', 'cccccccc'], ['databases', 'ffffffff'], ['home', '11111111'],
  ], 'a fresh stop, a drop still running and a teammate\'s private session are not stalled');
  assert.match(stalled[0].why, /^Stuck in stopping for 42 min/);
  assert.match(stalled[1].why, /^Deleted 2 days ago, but its databases are still there: the drop did not work \(the task exited with 1\)/);
  assert.equal(stalled[2].orphan, true);
  assert.deepEqual(stalled[3].meta, ['_sessions/11111111/claude-home.tar.gz', '3 MB']);
});

test('a bucket that cannot be listed leaves the homes unknown, not empty', () => {
  const { held, homesListed, totals } = heldReport({
    sessions: [session({ id: 'aaaaaaaa', kept: true })], records: {}, homes: null, now: NOW, dropRetryMs: 10 * MINUTE,
  });
  assert.deepEqual([held[0].home, homesListed, totals.homes], [null, false, null]);
});

test('a fix runs only for a row that is still stalled', async () => {
  const done = [];
  const sessions = [session({ id: 'aaaaaaaa', kept: true })];
  const held = createHeldData({
    store: { state: {} },
    fleet: { sessions: () => sessions, find: () => null, async forceStop() { done.push('stop'); } },
    databases: { sessionRecords: () => ({}), DROP_RETRY_MS: 10 * MINUTE, async dropSessionNow() { done.push('drop'); } },
    homes: { async listShared() { return [{ id: 'aaaaaaaa', bytes: 1 }, { id: '22222222', bytes: 1 }]; }, async remove(name) { done.push(name); } },
    now: () => NOW,
  });
  await assert.rejects(held.clean({ kind: 'home', id: 'aaaaaaaa', by: 'joel' }), /no longer stalled/, 'a kept session\'s home is not stalled');
  await held.clean({ kind: 'home', id: '22222222', by: 'joel' });
  assert.deepEqual(done, ['_sessions/22222222']);
});
