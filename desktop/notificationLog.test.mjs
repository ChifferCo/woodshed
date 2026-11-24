import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationLog } from './notificationLog.mjs';

const ring = (id, kind = 'needs-you') => ({ id, kind, title: `Session ${id}`, body: 'Needs you: claude is asking a question.' });

test('the log lists the newest first, each with a key of its own, and counts what was not seen', () => {
  let t = 1000;
  const log = createNotificationLog({ now: () => t++ });
  log.add(ring('aaaa1111'));
  log.add(ring('aaaa1111', 'done'));
  log.add(ring('bbbb2222'), { read: true });
  const { items, unread } = log.list();
  assert.deepEqual(items.map((e) => [e.id, e.kind, e.at, e.read]), [['bbbb2222', 'needs-you', 1002, true], ['aaaa1111', 'done', 1001, false], ['aaaa1111', 'needs-you', 1000, false]]);
  assert.equal(new Set(items.map((e) => e.key)).size, 3, 'two rings of one session are two entries');
  assert.equal(unread, 2);
});

test('the log keeps at most its max, dropping the oldest', () => {
  const log = createNotificationLog({ max: 2 });
  for (const id of ['a', 'b', 'c']) log.add(ring(id));
  assert.deepEqual(log.list().items.map((e) => e.id), ['c', 'b']);
});

test('marking read: one entry, one session\'s, or all, and saying whether anything changed', () => {
  const log = createNotificationLog();
  const first = log.add(ring('a'));
  log.add(ring('b'));
  log.add(ring('b', 'done'));
  assert.equal(log.markRead(first.key), true);
  assert.equal(log.markRead(first.key), false, 'already read');
  assert.equal(log.list().unread, 2);
  assert.equal(log.markSessionRead('b'), true);
  assert.equal(log.list().unread, 0);
  log.add(ring('c'));
  assert.equal(log.markRead(), true);
  assert.equal(log.markRead(), false);
});

test('a copy is handed out, and clear empties it', () => {
  const log = createNotificationLog();
  log.add(ring('a'));
  log.list().items[0].read = true;
  assert.equal(log.list().unread, 1, 'changing the copy changes nothing');
  assert.equal(log.clear(), true);
  assert.equal(log.clear(), false);
  assert.deepEqual(log.list(), { items: [], unread: 0 });
});
