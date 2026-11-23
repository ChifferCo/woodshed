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

test('a follow-up names its AI review by id alone, and anything else in about is refused', async () => {
  const { validateChatRequest } = await import('./chat.mjs');
  assert.deepEqual(validateChatRequest({ payload: { question: 'q' } }).about, null);
  assert.deepEqual(validateChatRequest({ payload: { question: 'q', about: { review: 'PRR_1', finding: 'PRRC_2', text: 'ignored' } } }).about, { review: 'PRR_1', finding: 'PRRC_2' });
  assert.deepEqual(validateChatRequest({ payload: { question: 'q', about: { review: 'PRR_1' } } }).about, { review: 'PRR_1', finding: null });
  for (const about of ['PRR_1', { finding: 'x' }, { review: '' }, { review: 'x'.repeat(201) }, { review: 'a', finding: 3 }]) {
    assert.equal(validateChatRequest({ payload: { question: 'q', about } }).ok, false, JSON.stringify(about));
  }
});

test('a follow-up on an AI review fences the point, asks for it to be checked, and the history says what each was about', () => {
  const prompt = buildChatPrompt({
    meta: { title: 'T' }, files: [],
    history: [{ role: 'user', text: 'is it?', about: { id: 'c1', label: 'Codex on a.mjs:3' } }, { role: 'assistant', text: 'no.' }],
    question: 'why?',
    about: { id: 'c2', label: 'Claude Code on b.mjs:9', text: 'This drops the error.' },
  });
  const nonce = /<review-point-([0-9a-f]{12})>/.exec(prompt)?.[1];
  assert.ok(nonce, 'the point is not fenced');
  // The label is GitHub's text too, so it is inside the block, never in the instructions above it.
  assert.match(prompt, new RegExp(`<review-point-${nonce}>\\npoint: Claude Code on b\\.mjs:9\\nThis drops the error\\.\\n</review-point-${nonce}>`));
  assert.equal(prompt.split('Claude Code on b.mjs:9').length, 2, 'the label once, in the block');
  assert.match(prompt, /whether it holds/);
  assert.match(prompt, /reviewer \(following up on the AI review's point: Codex on a\.mjs:3\): is it\?/);
  assert.doesNotMatch(buildChatPrompt({ meta: {}, files: [], history: [], question: 'q' }), /review-point-/);
});
