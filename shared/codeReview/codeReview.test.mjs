import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPrompt, writePrompt, verdictIn, mergeRiskIn } from './codeReview.mjs';

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('the prompt fills in the session paths and the pull request facts', (t) => {
  const d = dir(t);
  const p = reviewPrompt({ dir: d, pr: 7, head: 'abc123', server: 'https://github.com', repo: 'acme/app' });
  assert.match(p, new RegExp(`${d}/context\\.md`), 'points at the session dir');
  assert.match(p, /gh pr diff 7/);
  assert.match(p, /blob\/abc123\/path#L10-L24/);
  assert.match(p, /acme\/app/);
  assert.doesNotMatch(p, /\{\{/, 'every placeholder is filled');
  writePrompt({ dir: d, pr: 7, head: 'abc123', server: 'https://github.com', repo: 'acme/app' });
  assert.ok(fs.existsSync(path.join(d, 'review-prompt.md')));
});

test('the verdict reads back the conclusion, summary, comment and merge risk', (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 'verdict.txt'), 'APPROVE\n');
  fs.writeFileSync(path.join(d, 'summary.md'), 'Looks good.\n');
  fs.writeFileSync(path.join(d, 'review-comment.md'), '> [!TIP]\n> **Merge risk: Low**\n\n<details><summary>Claude review</summary>\n…\n</details>\n');
  fs.writeFileSync(path.join(d, 'merge-risk.md'), 'LOW\nOnly changes a docs page.\n- nothing else\n');
  const v = verdictIn(d);
  assert.equal(v.conclusion, 'APPROVE');
  assert.equal(v.summary, 'Looks good.');
  assert.match(v.comment, /Claude review/);
  assert.deepEqual(v.mergeRisk, { tier: 'Low', reason: 'Only changes a docs page.', summary: 'LOW\nOnly changes a docs page.\n- nothing else' });
});

test('a lowercase or messy verdict is normalised, and REQUEST_CHANGES is kept', (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 'verdict.txt'), ' request_changes \n');
  fs.writeFileSync(path.join(d, 'merge-risk.md'), 'High\nChanges who can see an org\'s data.\n');
  const v = verdictIn(d);
  assert.equal(v.conclusion, 'REQUEST_CHANGES');
  assert.equal(v.mergeRisk.tier, 'High');
});

test('no verdict file means no conclusion, so the console submits nothing', (t) => {
  const d = dir(t);
  assert.equal(verdictIn(d).conclusion, null);
  assert.deepEqual(mergeRiskIn(d), { tier: null, reason: '', summary: '' });
});
