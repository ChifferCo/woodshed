import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, isKnownReason } from './failureReason.mjs';
import { mergeVerdicts } from './codeReview.mjs';

test('names a usage limit, a sign-in, a timeout, and never quotes the log', () => {
  assert.match(failureReason({ log: 'Error: You exceeded your current quota sk-SECRET123', exit: 1 }), /usage limit/);
  assert.doesNotMatch(failureReason({ log: 'Error: quota sk-SECRET123' }), /SECRET/);
  assert.match(failureReason({ log: '{"type":"error","message":"@joel\'s sign-in expired"}', exit: 1 }), /sign-in/);
  assert.match(failureReason({ log: '', exit: 124 }), /time limit/);
  assert.match(failureReason({ log: 'x', exit: 2 }), /exited with 2/);
});

test('the merged note says why a reviewer wrote no verdict', () => {
  const v = (conclusion) => ({ conclusion, summary: 's', comment: 'c', mergeRisk: { tier: null, reason: '', summary: '' }, inlineComments: [], resolved: [] });
  const m = mergeVerdicts([{ name: 'Claude Code', verdict: v('APPROVE') }, { name: 'Codex', verdict: v(null) }], { reasons: { Codex: 'its usage limit looks used up' } });
  assert.match(m.comment, /Codex \(its usage limit looks used up\) wrote no verdict/);
  const none = mergeVerdicts([{ name: 'Codex', verdict: v(null) }], { reasons: { Codex: 'x' } });
  assert.equal(none.why, 'Codex: x');
});

test('only what the agent reports as a failure is read, not the transcript it worked through', () => {
  const log = [
    JSON.stringify({ type: 'user', message: { content: 'the diff mentions quota, sign-in, 403 and billing' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'PR #401 and an expired login' } }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }),
  ].join('\n');
  assert.match(failureReason({ log, exit: 1 }), /ran out of turns/);
  assert.match(failureReason({ log: log.split('\n').slice(0, 2).join('\n'), exit: 2 }), /exited with 2/);
});

test('only the sentences it makes are known', () => {
  for (const log of ['Error: quota', '', 'x']) for (const exit of [null, 1, 124]) assert.ok(isKnownReason(failureReason({ log, exit })));
  assert.ok(!isKnownReason('sk-SECRET123'));
  assert.ok(!isKnownReason('it exited with 1 sk-SECRET'));
});
