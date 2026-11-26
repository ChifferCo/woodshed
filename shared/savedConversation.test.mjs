import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CONVERSATION_ENTRIES, fitConversation, parseSavedConversation } from './savedConversation.mjs';

const entry = (i, text = `message ${i}`) => ({ role: i % 2 ? 'assistant' : 'user', text, at: null });

test('a conversation is sent whole when it fits, and loses its oldest entries first when it does not', () => {
  const read = { agent: 'claude', entries: [entry(0), entry(1)], partial: false, writtenAt: 5 };
  assert.deepEqual(JSON.parse(fitConversation(read)), read);

  const big = { agent: 'codex', entries: Array.from({ length: 40 }, (_, i) => entry(i, `${i}:${'x'.repeat(1000)}`)), partial: false, writtenAt: 9 };
  const fitted = JSON.parse(fitConversation(big, 10_000));
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 10_000);
  assert.equal(fitted.partial, true, 'says that older ones were left out');
  assert.equal(fitted.entries.at(-1).text, big.entries.at(-1).text, 'the newest stays');
  assert.ok(fitted.entries.length >= 1 && fitted.entries.length < 40);

  const many = { agent: 'claude', entries: Array.from({ length: MAX_CONVERSATION_ENTRIES + 5 }, (_, i) => entry(i)), writtenAt: 1 };
  const capped = JSON.parse(fitConversation(many));
  assert.equal(capped.entries.length, MAX_CONVERSATION_ENTRIES);
  assert.equal(capped.partial, true);

  assert.equal(fitConversation({ agent: 'claude', entries: [], writtenAt: 1 }), null, 'nothing to keep');
  assert.equal(fitConversation(null), null);
  assert.equal(fitConversation({ agent: 'claude', entries: [entry(0, 'x'.repeat(500))], writtenAt: 1 }, 100), null, 'one entry over the limit: nothing fits');
});

test('the console takes only the shape the Chat reads', () => {
  const good = { agent: 'grok', entries: [entry(0), { role: 'tool', tool: 'Bash', text: 'ls', error: true, at: null }], partial: true, writtenAt: 3 };
  assert.deepEqual(parseSavedConversation(JSON.stringify(good)), { ...good, savedAt: null });
  assert.equal(parseSavedConversation(JSON.stringify({ ...good, savedAt: '2026-11-25T10:00:00.000Z' })).savedAt, '2026-11-25T10:00:00.000Z');
  assert.equal(parseSavedConversation(JSON.stringify({ ...good, savedAt: 'yesterday' })).savedAt, null);
  assert.equal(parseSavedConversation(JSON.stringify({ ...good, writtenAt: null })).writtenAt, null);
  for (const bad of ['', 'nope', '[]', 'null', JSON.stringify({ ...good, agent: 'gemini' }), JSON.stringify({ ...good, entries: [] }),
    JSON.stringify({ ...good, entries: [null] }), JSON.stringify({ ...good, entries: [{ role: 'user' }] }),
    JSON.stringify({ ...good, entries: Array.from({ length: MAX_CONVERSATION_ENTRIES + 1 }, (_, i) => entry(i)) }),
    JSON.stringify({ ...good, writtenAt: 'x' })]) {
    assert.equal(parseSavedConversation(bad), null, bad.slice(0, 60));
  }
});
