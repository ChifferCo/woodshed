import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesReviewHeading, parseReviewReport, reviewEndedComment, reviewHeading, reviewRunningComment } from './reviewSessions.mjs';

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

test('a woodshed review\'s heading names whoever wrote its verdict, and the gate knows each such heading', () => {
  const heading = '## Claude review';
  assert.equal(reviewHeading(heading, ['claude']), heading);
  assert.equal(reviewHeading(heading, ['codex']), '## Codex review');
  assert.equal(reviewHeading(heading, ['claude', 'codex']), '## Claude Code and Codex review');
  assert.equal(reviewHeading(heading, ['claude', 'grok', 'opencode']), '## Claude Code, Grok Build and OpenCode review');
  assert.equal(reviewHeading('## Verdict', ['grok']), '## Verdict', 'a project\'s own heading stays');
  const review = { runner: 'woodshed', heading };
  for (const h of ['## Grok Build review', '## Claude Code, Codex, Grok Build and OpenCode review', '## Codex and OpenCode review']) {
    assert.ok(matchesReviewHeading(`${h} — APPROVE`, review), h);
  }
  assert.ok(!matchesReviewHeading('## Someone else review — APPROVE', review));
  assert.match(reviewRunningComment({ sessionUrl: null, agents: ['grok'] }), /Reviewing\*\* with Grok Build in/);
  assert.deepEqual(parseReviewReport(body({ agents: ['grok', 'opencode', 'mystery'] })).agents, ['grok', 'opencode']);
});

test('a review that did not finish quotes its reason as code, so nothing in it renders as a link, a tag or a mention', () => {
  const reason = 'the project file could not be read: unknown key "[click](https://evil.example) <img src=x> @ada ``x``"';
  const body = reviewEndedComment({ reason, sessionUrl: 'https://console.example/s/1' });
  assert.equal(body, `⚠️ **The review did not finish** ([session](https://console.example/s/1)): \`\`\` ${reason} \`\`\`. A new commit starts another.\n`);
  assert.equal(reviewEndedComment({ reason: 'idle\nfor 2 h', sessionUrl: null }),
    '⚠️ **The review did not finish**: ` idle for 2 h `. A new commit starts another.\n', 'one line, the fence one backtick');
});
