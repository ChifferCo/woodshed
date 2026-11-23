import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aboutFinding, aiReviewsOf, findAiPoint, parseAiReviewBody } from './aiReviews.mjs';

const BOT = { __typename: 'Bot', login: 'woodshed-reviewer' };
const HEAD = 'a'.repeat(40);

// As console/fleet.mjs submits a review by both reviewers: shared/codeReview/codeReview.mjs mergeVerdicts' sections.
const BOTH = [
  '## Claude Code and Codex review — REQUEST_CHANGES',
  '',
  '### Claude Code: APPROVE',
  '',
  'Looks right.',
  '',
  '### Codex: REQUEST_CHANGES',
  '',
  'The retry never stops.',
].join('\n');

function thread({ review, body, path = 'src/a.mjs', line = 12, replies = [], ...rest }) {
  return {
    path, line, originalLine: line, diffSide: 'RIGHT', isResolved: false, isOutdated: false, ...rest,
    comments: { nodes: [{ id: `c-${path}-${line}`, body, url: `https://github.com/o/r/pull/1#c${line}`, pullRequestReview: { id: review } }, ...replies] },
  };
}

test('a review by both reviewers is read into a verdict, a part from each, and findings marked with whose they are', () => {
  const [review] = aiReviewsOf({
    verdicts: [{ id: 'R1', author: BOT, state: 'CHANGES_REQUESTED', body: BOTH, url: 'https://github.com/o/r/pull/1#r1', submittedAt: '2026-11-20T10:00:00Z', commit: { oid: HEAD } }],
    threads: [
      thread({ review: 'R1', body: '**Codex:** This loops for ever.', line: 30, replies: [{ id: 'x', author: { login: 'ana' }, body: 'Fixed.', url: null }] }),
      thread({ review: 'R1', body: '**Claude Code:** Nit: name.', path: 'src/a.mjs', line: 4, isResolved: true }),
      thread({ review: 'OTHER', body: 'a person', line: 1 }),
    ],
    headSha: HEAD,
  });
  assert.equal(review.heading, 'Claude Code and Codex review');
  assert.equal(review.conclusion, 'REQUEST_CHANGES');
  assert.deepEqual(review.agents, ['Claude Code', 'Codex']);
  assert.deepEqual(review.parts, [
    { agent: 'Claude Code', conclusion: 'APPROVE', body: 'Looks right.' },
    { agent: 'Codex', conclusion: 'REQUEST_CHANGES', body: 'The retry never stops.' },
  ]);
  assert.equal(review.current, true);
  assert.deepEqual(review.findings.map((f) => [f.agent, f.path, f.line, f.body, f.resolved]), [
    ['Claude Code', 'src/a.mjs', 4, 'Nit: name.', true],
    ['Codex', 'src/a.mjs', 30, 'This loops for ever.', false],
  ]);
  assert.deepEqual(review.findings[1].replies, [{ author: 'ana', body: 'Fixed.', url: null, at: null }]);
});

test('one reviewer\'s review gives its findings to it, and folded comments are findings too', () => {
  const body = '## Codex review — COMMENT\n\nTwo things.\n\n**Inline comments**\n\n- `lib/x.mjs:7`: Unchecked.\n- `lib/y.mjs:2`: Racy.';
  const [review] = aiReviewsOf({ verdicts: [{ id: 'R2', author: { login: 'woodshed-app[bot]' }, state: 'COMMENTED', body, commit: { oid: 'b'.repeat(40) } }], threads: [], headSha: HEAD });
  assert.deepEqual(review.agents, ['Codex']);
  assert.deepEqual(review.parts, [{ agent: 'Codex', conclusion: 'COMMENT', body: 'Two things.' }]);
  assert.equal(review.current, false);
  assert.deepEqual(review.findings.map((f) => [f.id, f.agent, f.path, f.line, f.body, f.folded]), [
    ['R2:f1', 'Codex', 'lib/x.mjs', 7, 'Unchecked.', true],
    ['R2:f2', 'Codex', 'lib/y.mjs', 2, 'Racy.', true],
  ]);
});

test('a person\'s review, a hidden one, and a bot\'s that is not a review verdict are not AI reviews; newest comes first', () => {
  const verdicts = [
    { id: 'P', author: { __typename: 'User', login: 'ana' }, body: '## Claude review — APPROVE\n\nI say so.' },
    { id: 'H', author: BOT, body: '## Claude review — APPROVE', isMinimized: true },
    { id: 'C', author: BOT, body: 'Coverage went up.' },
    { id: 'OLD', author: BOT, body: '## Claude review — REQUEST_CHANGES\n\nNo.', submittedAt: '2026-11-01T00:00:00Z' },
    { id: 'NEW', author: BOT, body: '## Claude review — APPROVE\n\nYes.', submittedAt: '2026-11-02T00:00:00Z' },
  ];
  assert.deepEqual(aiReviewsOf({ verdicts, threads: [], headSha: null }).map((r) => [r.id, r.agents.join('+'), r.conclusion]), [
    ['NEW', 'Claude Code', 'APPROVE'], ['OLD', 'Claude Code', 'REQUEST_CHANGES'],
  ]);
  assert.equal(parseAiReviewBody('## Deploy notes\n\nCOMMENT'), null);
});

test('a project\'s own heading reads, whatever it is called', () => {
  const read = parseAiReviewBody('## Verdict — APPROVE\n\nFine.');
  assert.equal(read.heading, 'Verdict');
  assert.deepEqual(read.parts, [{ agent: null, conclusion: 'APPROVE', body: 'Fine.' }]);
});

test('a follow-up\'s ids find a finding only in the review they name, and a point past a partial read says so', () => {
  const reviews = aiReviewsOf({
    verdicts: [{ id: 'R1', author: BOT, body: BOTH }, { id: 'R2', author: BOT, body: '## Claude review — COMMENT\n\nHm.' }],
    threads: [thread({ review: 'R1', body: '**Codex:** Loops.', line: 30 }), thread({ review: 'R2', body: 'Name.', line: 4 })],
    headSha: null,
  });
  const found = findAiPoint(reviews, { review: 'R1', finding: 'c-src/a.mjs-30' });
  assert.equal(found.ok && found.finding.body, 'Loops.');
  assert.equal(findAiPoint(reviews, { review: 'R1', finding: null }).finding, null);
  assert.deepEqual(findAiPoint(reviews, { review: 'R1', finding: 'c-src/a.mjs-4' }), { ok: false, error: 'that finding is no longer on the pull request' }, 'R2\'s finding asked as R1\'s');
  assert.deepEqual(findAiPoint(reviews, { review: 'R9', finding: null }), { ok: false, error: 'that AI review is no longer on the pull request' });
  assert.match(findAiPoint(reviews, { review: 'R9' }, { truncated: true }).error, /past the part of this pull request the review reads/);
});

test('a project\'s own heading still reads, and its sections name the reviewers', () => {
  const read = parseAiReviewBody('## Our review — COMMENT\n\n### Claude Code: COMMENT\n\nA.\n\n### Codex: APPROVE\n\nB.');
  assert.deepEqual(read.agents, ['Claude Code', 'Codex']);
  assert.equal(read.parts.length, 2);
});

test('what a follow-up tells the agent: the finding and where it is, or the review\'s parts', () => {
  const [review] = aiReviewsOf({ verdicts: [{ id: 'R1', author: BOT, body: BOTH }], threads: [thread({ review: 'R1', body: '**Codex:** Loops.', line: 30 })], headSha: null });
  assert.deepEqual(aboutFinding(review, review.findings[0]), { id: 'c-src/a.mjs-30', label: 'Codex on src/a.mjs:30', text: 'Loops.' });
  const whole = aboutFinding(review, null);
  assert.equal(whole.id, 'R1');
  assert.equal(whole.label, 'Claude Code and Codex review, REQUEST_CHANGES');
  assert.match(whole.text, /Codex \(REQUEST_CHANGES\):\nThe retry never stops\./);
});
