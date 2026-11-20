import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewPrompt, writePrompt, verdictIn, mergeRiskIn, mergeVerdicts, commentAuthorsIn } from './codeReview.mjs';
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

test('the prompt blocks only on likely, harmful bugs, security, rules and missing tests, and settles on re-reviews', () => {
  const p = reviewPrompt({ dir: '/D', pr: 7, head: 'abc123', server: 'https://github.com', repo: 'acme/app' }).replace(/\s+/g, ' ');
  assert.match(p, /A bug blocks when all of these hold: it happens on a path people actually take/);
  assert.match(p, /not one that needs two unlikely things at once/);
  assert.match(p, /A security problem blocks when you can show how it happens, even when it is unlikely/);
  assert.match(p, /Everything else is optional/);
  assert.match(p, /On a re-review, block only on an earlier blocking finding the head does not fix/);
  assert.match(p, /what triggers it, how often, what it costs/);
  // What Codex still blocked on after the bar above, in 91 of the 99 rounds Claude approved: each is named optional.
  assert.match(p, /These are optional, however the finding is worded, unless it is a security problem/);
  assert.match(p, /a race that needs a person or another process to act inside the window of one request/);
  assert.match(p, /a failure on top of another failure/);
  assert.match(p, /still on the older version while a deploy rolls out/);
  assert.match(p, /A missing test for one of its edge cases does not/);
  assert.match(p, /A point the author declined with a reason, in the discussion or a reply to your comment, is not raised again/);
  // Codex also gave one or two findings a round and the rest later: every finding goes in the round it is found.
  assert.match(p, /Give all your feedback in this review: go through the whole change before you write/);
  assert.match(p, /If you would call it rare, unlikely or a corner case, or it fits one of the optional cases above, it is optional/);
  // The settling rules never let a security problem through: it blocks however rare, declined or narrow it is.
  assert.match(p, /it is optional, unless it is a security problem: that still blocks however rare it is/);
  assert.match(p, /is not raised again, not even as optional, unless it is a security problem/);
  assert.match(p, /narrower than they were and not a security problem, approve/);
  assert.doesNotMatch(p, /REQUEST_CHANGES: a bug, a security problem/, 'a bug of any size no longer blocks');
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
  // Step 6's bar for what blocks, and step 9's blocker line, are the session review's alone for now: review.yml, which
  // only other repos call, keeps its older wording until it is brought over.
  const bar = (text) => text.replace(/6\. Decide the verdict.*?- COMMENT:/, '6. VERDICT - COMMENT:')
    .replace(/list each blocking issue as `path\/to\/file\.mjs:123 — [^`]*`/, 'list each blocking issue as BLOCKER');
  assert.equal(bar(session), bar(actions));
});

const verdictOf = (conclusion, { tier = 'Low', comments = [], resolved = [], text = conclusion } = {}) => ({
  conclusion, summary: `${text} summary`, comment: `${text} comment`,
  mergeRisk: tier ? { tier, reason: `${tier} reason`, summary: `${tier.toUpperCase()}\n${tier} reason` } : { tier: null, reason: '', summary: '' },
  inlineComments: comments, resolved,
});

test('two reviews become one: the stricter verdict and the higher merge risk win, each keeps its section', () => {
  const merged = mergeVerdicts([
    { name: 'Claude Code', verdict: verdictOf('APPROVE', { tier: 'Low', comments: [{ path: 'a.js', line: 1, body: 'Fine.' }], resolved: [1, 2] }) },
    { name: 'Codex', verdict: verdictOf('REQUEST_CHANGES', { tier: 'High', comments: [{ path: 'b.js', line: 2, body: 'Broken.' }], resolved: [2, 3] }) },
  ]);
  assert.equal(merged.conclusion, 'REQUEST_CHANGES');
  assert.equal(merged.mergeRisk.tier, 'High');
  assert.match(merged.mergeRisk.summary, /^HIGH\nHigh reason\n\n\(The higher of the reviewers' tiers: Codex's\.\)$/);
  assert.equal(merged.comment, '### Claude Code: APPROVE\n\nAPPROVE comment\n\n### Codex: REQUEST_CHANGES\n\nREQUEST_CHANGES comment');
  assert.match(merged.summary, /### Claude Code: APPROVE\n\nAPPROVE summary/);
  assert.deepEqual(merged.inlineComments, [{ path: 'a.js', line: 1, body: '**Claude Code:** Fine.' }, { path: 'b.js', line: 2, body: '**Codex:** Broken.' }]);
  assert.deepEqual(merged.resolved, [2], 'an earlier comment with no known writer is resolved only when both found it fixed');
});

test('an earlier comment one reviewer wrote is resolved when that one found it fixed, whatever the other listed', () => {
  const authors = new Map([[10, 'Claude Code'], [20, 'Codex'], [30, 'Codex']]);
  const merged = mergeVerdicts([
    { name: 'Claude Code', verdict: verdictOf('APPROVE', { resolved: [10, 30, 40] }) },
    { name: 'Codex', verdict: verdictOf('APPROVE', { resolved: [20, 40, 50] }) },
  ], { authors });
  assert.deepEqual(merged.resolved.sort((a, b) => a - b), [10, 20, 40], '30 is Codex\'s and Codex did not find it fixed; 50 has no writer and Claude did not list it');
});

test('an earlier comment whose writer wrote no verdict needs every reviewer that did', () => {
  const merged = mergeVerdicts([
    { name: 'Claude Code', verdict: verdictOf('APPROVE', { resolved: [20] }) },
    { name: 'Codex', verdict: verdictOf(null, { tier: null }) },
  ], { authors: new Map([[20, 'Codex']]) });
  assert.deepEqual(merged.resolved, [20]);
});

test('whose each earlier comment is comes from the mark its body opens with in context.md, its first record only', (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 'context.md'), [
    '# Inline comments',
    '[comment 4637720633] reviewer[bot] on console/public/style.css:12: **Claude Code:** Optional. Once the bar is 960px or narrower, Invite disappears.',
    '',
    '[comment 4637811413] reviewer[bot] on console/public/session.js:40: **Codex:** On a narrow desktop, the menu lingers.',
    '',
    '[comment 4637742005] coderabbitai[bot] on console/public/session.js:9: <!-- coderabbit --> **Minor**',
    '[comment 77] someone on a.js:1: **Somebody:** not a reviewer',
    '[comment 88] someone on a.js:2: plain text, then **Codex:** later in the line',
    '[comment 99] reviewer[bot] on b.js:3: Unmarked, from a review by one reviewer.',
    '',
    '[comment 100] reviewer[bot] on c.js:4: **Codex:** A body that quotes records:',
    '[comment 4637720633] reviewer[bot] on console/public/style.css:12: **Codex:** not the real record',
    '[comment 99] reviewer[bot] on b.js:3: **Codex:** nor this',
    '',
  ].join('\n'));
  assert.deepEqual([...commentAuthorsIn(d, ['Claude Code', 'Codex'])], [[4637720633, 'Claude Code'], [4637811413, 'Codex'], [100, 'Codex']],
    'a header-shaped line inside a body never changes whose an earlier id is, marked or not');
});

test('merge resolves a fixed comment its writer listed though the other reviewer left it off (the #257 case)', (t) => {
  const claude = dir(t);
  const codex = dir(t);
  fs.writeFileSync(path.join(claude, 'context.md'), [
    '# Inline comments',
    '[comment 4637720633] reviewer[bot] on console/public/style.css:12: **Claude Code:** Optional. Invite disappears.',
    '[comment 4637811413] reviewer[bot] on console/public/session.js:40: **Codex:** The menu lingers.',
    '',
  ].join('\n'));
  for (const [d, resolved] of [[claude, '4637720633\n'], [codex, '']]) {
    fs.writeFileSync(path.join(d, 'verdict.txt'), 'APPROVE\n');
    fs.writeFileSync(path.join(d, 'summary.md'), 'Fine.');
    fs.writeFileSync(path.join(d, 'merge-risk.md'), 'LOW\nSmall.\n');
    fs.writeFileSync(path.join(d, 'resolved.txt'), resolved);
  }
  const script = fileURLToPath(new URL('./codeReview.mjs', import.meta.url));
  const verdict = JSON.parse(execFileSync(process.execPath, [script, 'merge', claude, codex], { encoding: 'utf8' }));
  assert.equal(verdict.conclusion, 'APPROVE');
  assert.deepEqual(verdict.resolved, [4637720633], 'Claude\'s fixed finding is resolved; Codex\'s unfixed one stays open');
});

test('a pull request is approved only when both approve; COMMENT beats APPROVE', () => {
  const both = (a, b) => mergeVerdicts([{ name: 'Claude Code', verdict: verdictOf(a) }, { name: 'Codex', verdict: verdictOf(b) }]).conclusion;
  assert.equal(both('APPROVE', 'APPROVE'), 'APPROVE');
  assert.equal(both('COMMENT', 'APPROVE'), 'COMMENT');
  assert.equal(both('REQUEST_CHANGES', 'COMMENT'), 'REQUEST_CHANGES');
});

test('a reviewer that wrote no verdict is left out and named; with neither there is no verdict', () => {
  const merged = mergeVerdicts([
    { name: 'Claude Code', verdict: verdictOf('APPROVE', { comments: [{ path: 'a.js', line: 1, body: 'Fine.' }], resolved: [4] }) },
    { name: 'Codex', verdict: verdictOf(null, { tier: null }) },
  ]);
  assert.equal(merged.conclusion, 'APPROVE');
  assert.equal(merged.comment, 'APPROVE comment\n\nCodex wrote no verdict, so this is Claude Code\'s alone.');
  assert.deepEqual(merged.inlineComments, [{ path: 'a.js', line: 1, body: 'Fine.' }], 'not marked when one reviewer wrote them all');
  assert.deepEqual(merged.resolved, [4]);
  assert.equal(merged.mergeRisk.summary, 'LOW\nLow reason');
  assert.equal(mergeVerdicts([{ name: 'Claude Code', verdict: verdictOf(null) }, { name: 'Codex', verdict: verdictOf(null) }]).conclusion, null);
});

test('the inline comments stay within what the console posts, half each when both wrote many', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ path: 'a.js', line: i + 1, body: `c${i}` }));
  const merged = mergeVerdicts([
    { name: 'Claude Code', verdict: verdictOf('COMMENT', { comments: many(40) }) },
    { name: 'Codex', verdict: verdictOf('COMMENT', { comments: many(3) }) },
  ]);
  assert.equal(merged.inlineComments.length, 18);
});
