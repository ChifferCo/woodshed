import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason } from './failureReason.mjs';
import { mergeVerdicts } from './codeReview.mjs';

test('names a usage limit, a sign-in, a timeout, and never quotes the log', () => {
  assert.match(failureReason({ log: 'You exceeded your current quota sk-SECRET123', exit: 1 }), /usage limit/);
  assert.doesNotMatch(failureReason({ log: 'quota sk-SECRET123' }), /SECRET/);
  assert.match(failureReason({ log: '{"message":"@joel\'s sign-in expired"}', exit: 1 }), /sign-in/);
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
