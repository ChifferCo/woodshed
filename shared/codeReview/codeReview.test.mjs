import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPrompt, writePrompt, verdictIn, mergeRiskIn } from './codeReview.mjs';
import { parseYaml } from '../yamlLite.mjs';

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

test('the session\'s inline comments and the earlier comments it found fixed are read back', (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 'verdict.txt'), 'APPROVE\n');
  fs.writeFileSync(path.join(d, 'inline-comments.json'), JSON.stringify([
    { path: './console/a.mjs', line: 12, body: 'Throws on an empty list.' }, { path: 'b.mjs', line: 'x', body: 'dropped' },
  ]));
  fs.writeFileSync(path.join(d, 'resolved.txt'), '101\n101\nnot an id\n202\n');
  const v = verdictIn(d);
  assert.deepEqual(v.inlineComments, [{ path: 'console/a.mjs', line: 12, body: 'Throws on an empty list.' }]);
  assert.deepEqual(v.resolved, [101, 202]);
  fs.writeFileSync(path.join(d, 'inline-comments.json'), 'not json');
  assert.deepEqual(verdictIn(d).inlineComments, []);
});

// The two runners must review the same way: the session's prompt is the Actions review's, with the session's paths, and
// its inline comments written to a file for the console instead of posted through the action's tool.
test('the session\'s review prompt is the Actions review\'s, apart from where things are and how inline comments go out', () => {
  const workflow = parseYaml(fs.readFileSync(new URL('../../.github/workflows/review.yml', import.meta.url), 'utf8'));
  const step = workflow.jobs.review.steps.find((s) => s.with?.prompt);
  const words = (text) => text.replace(/\s+/g, ' ').trim();
  const actions = words(step.with.prompt)
    .replace(/5\. Inline comments \(mcp__github_inline_comment__create_inline_comment\):.*?Before you comment/, '5. INLINE Before you comment');
  const session = words(reviewPrompt({ dir: '/D', pr: '${{ github.event.pull_request.number }}', head: '${{ github.event.pull_request.head.sha }}',
    server: '${{ github.server_url }}', repo: '${{ github.repository }}', reviewer: 'github-actions[bot]' }))
    .replace(/5\. Inline comments, written to .*?Before you comment/, '5. INLINE Before you comment')
    .replaceAll('/D/context.md', '/tmp/review-context.md').replaceAll('/D/base-rules/', '/tmp/base-rules/')
    .replaceAll('/D/instructions.md', '/tmp/review-instructions.md').replaceAll('/D/risk-areas.md', '/tmp/risk-areas.md')
    .replaceAll('/D/review-comment.md', '/tmp/review-comment.md').replaceAll('/D/verdict.txt', '/tmp/claude-verdict.txt')
    .replaceAll('/D/summary.md', '/tmp/review-summary.md').replaceAll('/D/merge-risk.md', '/tmp/merge-risk.md')
    .replaceAll('/D/resolved.txt', '/tmp/claude-resolved.txt')
    .replace('The console puts it', 'The next step puts it').replace('so the console submits them', 'so the next steps submit them');
  assert.equal(session, actions);
});
