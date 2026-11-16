import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewReport } from './reviewSessions.mjs';

const SHA = 'a'.repeat(40);
const body = (over = {}) => JSON.stringify({
  conclusion: 'APPROVE', summary: 'Looks good.', comment: '> [!TIP]\n…',
  mergeRisk: { tier: 'Low', reason: 'Only a docs page.', summary: 'LOW\nOnly a docs page.' }, sha: SHA, costUsd: 0.5, ...over,
});

test('a well-formed review report parses', () => {
  assert.deepEqual(parseReviewReport(body()), {
    conclusion: 'APPROVE', summary: 'Looks good.', comment: '> [!TIP]\n…',
    mergeRisk: { tier: 'Low', reason: 'Only a docs page.', summary: 'LOW\nOnly a docs page.' }, inlineComments: [], resolved: [],
    sha: SHA, costUsd: 0.5,
  });
});

test('inline comments keep only a file in the repo and a line of it, and resolved ids only whole numbers', () => {
  const r = parseReviewReport(body({
    inlineComments: [
      { path: 'console/a.mjs', line: 12, body: 'This throws on an empty list.' },
      { path: '../etc/passwd', line: 1, body: 'x' }, { path: '/abs.mjs', line: 1, body: 'x' },
      { path: 'b.mjs', line: 0, body: 'x' }, { path: 'b.mjs', line: 2.5, body: 'x' }, { path: 'b.mjs', line: 3, body: ' ' },
    ],
    resolved: [101, 101, '202', -1, 303],
  }));
  assert.deepEqual(r.inlineComments, [{ path: 'console/a.mjs', line: 12, body: 'This throws on an empty list.' }]);
  assert.deepEqual(r.resolved, [101, 303]);
  assert.deepEqual(parseReviewReport(body({ inlineComments: 'nope', resolved: {} })).inlineComments, []);
});

test('it rejects a bad conclusion, a non-commit sha, and non-JSON', () => {
  assert.throws(() => parseReviewReport(body({ conclusion: 'LGTM' })), /conclusion must be/);
  assert.throws(() => parseReviewReport(body({ sha: 'main' })), /sha must be a commit/);
  assert.throws(() => parseReviewReport('nope'), /body must be JSON/);
});

test('an unknown tier and a non-number cost come back null', () => {
  const r = parseReviewReport(body({ mergeRisk: { tier: 'Lowish', reason: 'x', summary: 'y' }, costUsd: 'free' }));
  assert.equal(r.mergeRisk.tier, null);
  assert.equal(r.costUsd, null);
});
