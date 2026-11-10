// node --test review/chat.test.mjs
//
// The chat replays its transcript into every turn's prompt, so the one thing
// that can go quietly and expensively wrong is that replay growing without
// bound. The tests guard the bound, not the wording.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trimHistory, buildChatPrompt } from './chat.mjs';

function turn(i, text) {
  return { role: i % 2 ? 'assistant' : 'user', text: text || `turn ${i}` };
}

test('a long transcript is cut to a bounded tail, newest kept', () => {
  const history = Array.from({ length: 40 }, (_, i) => turn(i));
  const kept = trimHistory(history);
  assert.ok(kept.length < history.length, 'nothing was trimmed');
  assert.equal(kept[kept.length - 1].text, 'turn 39', 'the newest turn was not kept');
  assert.equal(kept[0].text, `turn ${40 - kept.length}`, 'the kept tail is not contiguous');
});

test('a transcript of huge turns is cut by characters, not just by count', () => {
  const big = 'x'.repeat(5_000);
  const history = Array.from({ length: 6 }, (_, i) => turn(i, big));
  const kept = trimHistory(history);
  const chars = kept.reduce((n, m) => n + m.text.length, 0);
  assert.ok(chars <= 12_000, `replayed ${chars} characters`);
  assert.ok(kept.length >= 1, 'the newest turn must always fit');
});

test('the prompt fences the message with a per-request nonce and carries the history', () => {
  const args = {
    meta: { title: 'T', number: 7, headRefName: 'f', baseRefName: 'master' },
    artifact: { overview: 'does a thing' },
    files: [{ path: 'a.ts', additions: 1, deletions: 0, status: 'modified' }],
    history: [turn(0, 'first?'), turn(1, 'first.')],
    question: 'and second?',
  };
  const a = buildChatPrompt(args);
  const b = buildChatPrompt(args);
  const tag = /<message-([0-9a-f]{12})>\nand second\?\n<\/message-\1>/;
  assert.match(a, tag);
  assert.notEqual(tag.exec(a)[1], tag.exec(b)[1], 'the nonce did not change between requests');
  assert.match(a, /reviewer: first\?\nyou: first\./);
  assert.match(a, /a\.ts {2}\+1 -0/);
});
