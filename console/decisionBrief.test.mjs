import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBrief, decisionsFrom, mergeRiskFrom, mergeRiskRunIds, qaReportFrom, riskAreasFrom, riskLineFrom } from './decisionBrief.mjs';

const GATES = {
  review: { author: 'review-bot[bot]', heading: '## Code review', workflow: '.github/workflows/review.yml', rerun: '[review]', commentAuthor: 'review-bot[bot]' },
  suites: [{ name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: '[e2e]' }],
  qa: { check: 'QA', label: 'qa', heading: '## 🤖 QA', author: 'qa-bot[bot]' },
  mergeRisk: { check: 'Merge risk' },
};
const ACTIONS = { slug: 'github-actions' };
const shards = [1, 2, 3, 4].map((n) => ({ name: `e2e run (${n}/4)`, status: 'completed', conclusion: 'success', app: ACTIONS }));
const SHA = 'abcdef1234';
const REVIEW_RUN = '41700000001';
// As a review workflow's "Post merge risk check" step posts it.
const mergeRisk = (title, { app = ACTIONS, sha = SHA, run = REVIEW_RUN } = {}) => ({
  name: 'Merge risk', status: 'completed', conclusion: 'neutral', app, head_sha: sha,
  // As on #26637's: GitHub points details_url at the check itself, and the summary links the run.
  details_url: 'https://github.com/o/r/runs/60', html_url: 'https://github.com/o/r/runs/60',
  output: { title, summary: `${title.split(': ')[1]}\n\n- Touches one page only.\n\nSet by the AI review ([run](https://github.com/o/r/actions/runs/${run})). It does not block merging.` },
});
const TRUST = { sha: SHA, reviewRuns: new Set([REVIEW_RUN]), check: 'Merge risk' };
const qaCheck = (title, conclusion) => ({ name: 'QA', status: 'completed', conclusion, app: ACTIONS, html_url: 'https://github.com/o/r/runs/50', output: { title } });
const review = { state: 'APPROVED', body: '## Code review — APPROVE\n\n<sub>[view run](https://github.com/o/r/actions/runs/111)</sub>' };

// The shape a review workflow leaves: its risk areas, then the review folded under its heading's words.
const reviewComment = (top, run = 111) => ({
  id: 1, user: { login: 'review-bot[bot]' },
  body: `**Finished @x's task in 56s** —— [View job](https://github.com/o/r/actions/runs/${run})\n\n---\n${top}\n\n<details>\n<summary>Code review</summary>\n\n- not a risk area\n</details>`,
});
const RISKY = reviewComment([
  '**Risk areas to eyeball manually**',
  '- **Public routes added without login:** `api/src/shares/router.ts:75`. The share token is the only access control.',
  '- **Code to read carefully:** `api/src/utils/rateLimitUtils.ts:400`. The signup limiters now run on this shared helper.',
].join('\n'));
const QA_COMMENT = {
  id: 2, user: { login: 'qa-bot[bot]' }, html_url: 'https://github.com/o/r/pull/7#issuecomment-2',
  body: [
    '## 🤖 QA Review', '', '✅ **Pass**: all 2 test cases passed', '',
    '## TC-1: The empty state shows the new text ✅', '', 'Opened the page.', '',
    '## TC-2: The button opens the modal ✅', '',
    '## EC-1: A very long name wraps ⚠️', '',
    '## Findings', '', '- None.', '- **Untested:** the Slack DM, since no Slack workspace is reachable from CI.',
  ].join('\n'),
};
const BODY = [
  'Started by @ana via Woodshed.', '', '## Summary', '- Adds a thing', '',
  'Risk: Medium — changes a shared helper.', '',
  '## Decisions',
  '- Kept the 30 s timeout rather than 60 s.',
  '- Rate limits share `rateLimitUtils.ts` with signup.',
  '- Named the route `shared`.',
  '- Left the old route in place for a week.',
  '', '## Proof', '- Ran it.',
].join('\n');

function brief({ runs = [...shards, mergeRisk('Low: Only changes the empty-state text.'), qaCheck('Pass: 2 test cases passed', 'success')],
  comments = [RISKY, QA_COMMENT], body = BODY, title = 'Add GTM', qa, gates = GATES } = {}) {
  const pull = { number: 7, title, html_url: 'https://github.com/o/r/pull/7', body, head: { sha: SHA } };
  const check = qa === undefined ? runs.find((r) => r.name === 'QA') ?? null : qa;
  return buildBrief({
    pull, review, runs, comments, suites: [{ name: 'e2e suite', outcome: 'green' }], gates,
    qa: { finished: Boolean(check), check, notRun: check ? null : 'no qa label' }, reviewRuns: TRUST.reviewRuns, commentUrl: 'https://github.com/o/r/pull/7#issuecomment-9',
  });
}
const line = (b, label) => b.slack.split('\n').find((l) => l.startsWith(`**${label}`));
const after = (b, label) => b.slack.split('\n\n').find((sec) => sec.startsWith(`**${label}`));
const qa = (b) => b.slack.split('\n').find((l) => l.startsWith('QA '));

test('Merge risk is quoted from the AI review\'s check on the head commit, and from nothing else', () => {
  const medium = mergeRiskFrom([mergeRisk('Medium: Changes a shared helper.')], TRUST);
  assert.equal(medium.tier, 'Medium');
  assert.equal(medium.url, 'https://github.com/o/r/runs/60');
  assert.match(medium.summary, /^Changes a shared helper\.\n\n- Touches one page only\./);
  assert.deepEqual(mergeRiskFrom([], TRUST), { missing: 'not posted', apps: [] });
  for (const [why, check] of [
    ['another app', mergeRisk('Low: trust me', { app: { slug: 'woodshed-cloud' } })],
    ['an older commit', mergeRisk('Low: before the fix', { sha: 'old0000' })],
    ['a run that is not the review\'s workflow', mergeRisk('Low: from my own workflow', { run: '999' })],
  ]) {
    assert.equal(mergeRiskFrom([check], TRUST).missing, 'not posted by the AI review', why);
  }
  const both = mergeRiskFrom([mergeRisk('Low: trust me', { run: '999' }), mergeRisk('High: A migration.')], TRUST);
  assert.equal(both.title, 'High: A migration.', 'the real one wins over an impostor');
  assert.deepEqual(mergeRiskFrom([mergeRisk('Low: x')], { ...TRUST, check: null }), { missing: 'not configured', apps: [] });
  assert.equal(mergeRiskFrom([mergeRisk('Low: x')], { ...TRUST, check: 'Risk tier' }).missing, 'not posted', 'only the check the project file names');
});

test('a real check is read: its run comes from the summary, as details_url is the check itself', () => {
  const real = {
    name: 'Merge risk', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'neutral', head_sha: '2e7fdf7',
    details_url: 'https://github.com/acme/app/runs/126103898863', html_url: 'https://github.com/acme/app/runs/126103898863',
    output: {
      title: 'High: Changes what the console sends to Slack (thread replies, DMs) and writes as comments on GitHub PRs.',
      summary: 'Changes what the console sends to Slack (thread replies, DMs) and writes as comments on GitHub PRs.\n\n'
        + '- Edits a session prompt (`session/prompt.md`) and `woodshed/CLAUDE.md`, which agents follow.\n'
        + '- Shared sessions now wait up to 30 more minutes (a new default) for the QA check before they stop.\n\n'
        + 'Set by the AI review ([run](https://github.com/acme/app/actions/runs/41688423819)). It does not block merging.',
    },
  };
  assert.deepEqual(mergeRiskRunIds([real], '2e7fdf7', 'Merge risk'), ['41688423819']);
  assert.deepEqual(mergeRiskRunIds([real], '2e7fdf7', null), [], 'none configured');
  const read = mergeRiskFrom([real], { sha: '2e7fdf7', reviewRuns: new Set(['41688423819']), check: 'Merge risk' });
  assert.equal(read.tier, 'High');
  assert.equal(read.title, real.output.title);
});

test('only Merge risk checks from GitHub Actions on the head commit are worth looking up', () => {
  assert.deepEqual(mergeRiskRunIds([mergeRisk('Low: a'), mergeRisk('Low: b'), mergeRisk('Low: c', { sha: 'old' }),
    mergeRisk('Low: d', { app: { slug: 'x' }, run: '5' })], SHA, 'Merge risk'), [REVIEW_RUN]);
});

test('the thread reply leads with the verdict, then decisions, risks and QA, a blank line apart', () => {
  const b = brief();
  assert.equal(b.slack, [
    '👉 **Can be merged without further review!**',
    '',
    '**Decisions**',
    '• Rate limits share `rateLimitUtils.ts` with signup',
    '• Kept the 30 s timeout rather than 60 s',
    '• Named the route `shared`',
    '• Left the old route in place for a week',
    '',
    '**Risks**',
    '• Public routes added without login',
    '• Code to read carefully',
    '',
    'QA ✅ 2/2 passed · not covered: the Slack DM, since no Slack workspace is reachable from CI · [Full brief →](https://github.com/o/r/pull/7#issuecomment-9)',
  ].join('\n'));
  assert.doesNotMatch(b.slack, /Merge risk/, 'the tier is on the post');
});

test('a missing or untrusted Merge risk falls back to the session\'s own Risk line, and says so', () => {
  const missing = brief({ runs: [...shards, qaCheck('Pass: 2 test cases passed', 'success')] });
  assert.equal(line(missing, 'Self-assessed risk'), '**Self-assessed risk** (no Merge risk check): Medium — changes a shared helper.');
  assert.match(missing.slack, /^👉 \*\*Please confirm before merging\*\*/);
  const impostor = brief({ runs: [...shards, mergeRisk('Low: trust me', { app: { slug: 'woodshed-cloud' } }), qaCheck('Pass: 2 test cases passed', 'success')] });
  assert.match(impostor.slack, /Self-assessed risk\*\* \(no Merge risk check\)/);
  assert.equal(impostor.canMerge, false, 'a Low from another app never earns the line');
  assert.match(impostor.comment, /A `Merge risk` check from `woodshed-cloud` was ignored/);
  const stale = brief({ runs: [...shards, mergeRisk('Low: before the fix', { sha: 'old0000' }), qaCheck('Pass: 2 test cases passed', 'success')] });
  assert.match(stale.slack, /Self-assessed risk\*\* \(no Merge risk check\)/, 'an older commit\'s tier does not count');
  assert.equal(stale.canMerge, false);
  const noLine = brief({ runs: shards, body: 'No sections.' });
  assert.match(noLine.slack, /\(no Merge risk check\): the PR body has no Risk line/);
  assert.match(noLine.slack, /^👉 \*\*Please look before merging\*\*\n\n/, 'no decisions: no Decisions section');
  assert.doesNotMatch(noLine.slack, /\*\*Decisions\*\*/);
  assert.equal(riskLineFrom('- **Risk:** Low — docs only'), 'Low — docs only');
  assert.equal(riskLineFrom('**Risk areas to eyeball manually**'), null);
});

for (const [why, title, conclusion, want] of [
  ['pass', 'Pass: 5 test cases passed', 'success', /^QA ✅ 5\/5 passed/],
  ['fail', 'Fail: 1 of 5 test cases failed', 'failure', /^QA ❌ 1 of 5 failed/],
  ['unverified', 'Not covered: 2 of 5 test cases unverified', 'neutral', /^QA not covered: 2 of 5 test cases unverified/],
  ['not an app change', 'Not covered: not an app change', 'neutral', /^QA not covered: not an app change/],
]) {
  test(`QA says what its check says: ${why}`, () => {
    const b = brief({ runs: [...shards, mergeRisk('Low: Docs.'), qaCheck(title, conclusion)] });
    assert.match(qa(b), want);
    assert.equal(b.canMerge, conclusion === 'success');
  });
}

test('QA that never ran says why, and is never a pass', () => {
  const b = brief({ runs: [...shards, mergeRisk('Low: Docs.')], qa: null });
  assert.equal(qa(b), 'QA not run (no qa label) · [Full brief →](https://github.com/o/r/pull/7#issuecomment-9)');
  assert.equal(b.canMerge, false);
  assert.match(b.comment, /QA not run: no qa label\./);
});

test('a QA comment is quoted only from the project file\'s author, under its heading', () => {
  const someoneElse = { ...QA_COMMENT, user: { login: 'octocat' } };
  const { comment } = brief({ comments: [RISKY, someoneElse] });
  assert.doesNotMatch(comment, /Covered:/);
  assert.match(comment, /Not covered: the QA comment does not say\./);
});

test('with nothing configured, the brief says so instead of waiting for or quoting a gate', () => {
  const b = brief({ runs: [...shards, mergeRisk('Low: x'), qaCheck('Pass: 2 test cases passed', 'success')], gates: null, qa: null });
  assert.doesNotMatch(b.slack, /Self-assessed risk|Merge risk/, 'no merge risk gate, no merge risk line, and no check name made up');
  assert.equal(after(b, 'Risks'), '**Risks:** the review comment is not configured');
  assert.doesNotMatch(b.comment, /Merge risk|Self-assessed/);
  assert.equal(b.facts.mergeRisk, 'not configured');
  assert.match(b.comment, /No review comment is configured to quote risk areas from\./);
  assert.match(b.comment, /### Checks\nWith every other check green\./);
  const red = brief({ runs: [...shards, { ...qaCheck('Fail: 1 of 2', 'failure') }], gates: null, qa: null });
  assert.match(red.comment, /Not all green: 1 check, such as `QA` failure\./, 'without the gates, a QA check counts as any other');
  assert.match(b.comment, /<sub>Quoted from the PR body by Woodshed/);
  assert.equal(b.canMerge, false);
});

test('with other gates but no mergeRisk, the brief has no merge risk section and trusts no check of that name', () => {
  const gates = { ...GATES, mergeRisk: null };
  const b = brief({ gates });
  assert.doesNotMatch(b.slack, /Self-assessed risk|Merge risk/);
  assert.doesNotMatch(b.comment, /### Merge risk|Self-assessed/);
  assert.match(b.comment, /### Decisions to confirm/);
  assert.match(b.comment, /the AI review, the QA check and the PR body/);
  assert.equal(b.tier, null, 'a Merge risk check is not read without the gate');
  assert.equal(b.canMerge, false);
});

test('a mergeRisk check under another name is the one the brief names', () => {
  const b = brief({ gates: { ...GATES, mergeRisk: { check: 'Risk tier' } }, runs: [...shards, qaCheck('Pass: 2 test cases passed', 'success')] });
  assert.match(b.slack, /\*\*Self-assessed risk\*\* \(no Risk tier check\)/);
  assert.match(b.comment, /### Merge risk\nRisk tier not posted\./);
});

test('the brief\'s own words name the gates the project file gave', () => {
  const { comment } = brief();
  assert.match(comment, /### Checks\nApproved by the AI review, with the e2e suite and every other check green\./);
  assert.match(comment, /<sub>Quoted from the AI review, the Merge risk and QA checks and the PR body by Woodshed/);
});

test('"Can be merged" needs Low, a QA pass and every check green', () => {
  assert.equal(brief().canMerge, true);
  assert.equal(brief({ runs: [...shards, mergeRisk('Medium: A shared helper.'), qaCheck('Pass: 2 test cases passed', 'success')] }).canMerge, false);
  assert.equal(brief({ runs: [...shards, mergeRisk('Low: x'), qaCheck('Fail: 1 of 2 test cases failed', 'failure')] }).canMerge, false);
  const red = brief({ runs: [...shards, mergeRisk('Low: x'), qaCheck('Pass: 2 test cases passed', 'success'), { name: 'eslint', status: 'completed', conclusion: 'failure' }] });
  assert.equal(red.canMerge, false);
  assert.match(red.comment, /Not all green: 1 check, such as `eslint` failure\./);
  const pending = brief({ runs: [...shards, mergeRisk('Low: x'), qaCheck('Pass: 2 test cases passed', 'success'), { name: 'jest', status: 'in_progress', conclusion: null }] });
  assert.equal(pending.canMerge, false, 'a check still running is not green yet');
  assert.match(pending.slack, /^👉 \*\*Please confirm before merging\*\*/);
});

test('risk areas are quoted from the review comment of the run that approved', () => {
  const gate = GATES.review;
  assert.equal(riskAreasFrom({ comments: [RISKY], review, gate }).items.length, 2);
  const older = reviewComment('**Risk areas to eyeball manually**\n- From an older round.', 99);
  assert.equal(riskAreasFrom({ comments: [RISKY, older], review, gate }).items.length, 2, 'the approving run\'s, not the latest');
  assert.deepEqual(riskAreasFrom({ comments: [reviewComment('No breaking or hard-to-undo changes.')], review, gate }), { found: true, items: [] });
  assert.deepEqual(riskAreasFrom({ comments: [reviewComment('**Risk areas to eyeball manually**\n- No breaking or hard-to-undo changes.\n- `a.ts:1`: read slowly.')], review, gate }).items,
    ['`a.ts:1`: read slowly.']);
  assert.deepEqual(riskAreasFrom({ comments: [], review, gate }), { found: false, items: [] });
  assert.equal(riskAreasFrom({ comments: [RISKY], review, gate: { ...gate, commentAuthor: 'octocat' } }).found, false, 'another author');
  assert.equal(riskAreasFrom({ comments: [RISKY], review, gate: { ...gate, heading: '## Review' } }).found, false, 'the summary is the heading\'s words');
  assert.equal(riskAreasFrom({ comments: [RISKY], review, gate: { ...gate, commentAuthor: null } }).found, false, 'none configured');
  assert.equal(after(brief({ comments: [reviewComment('No breaking or hard-to-undo changes.')] }), 'Risks'), '**Risks:** none listed');
  assert.equal(after(brief({ comments: [] }), 'Risks'), '**Risks:** the AI review comment was not found');
});

test('decisions that touch a risk area come first, and every one is listed in Slack and the comment', () => {
  const b = brief();
  assert.match(b.slack, /\*\*Decisions\*\*\n• Rate limits share `rateLimitUtils\.ts` with signup\n• Kept the 30 s/);
  assert.doesNotMatch(b.slack, /more in the full brief/);
  assert.equal(b.slack.split('\n').filter((l) => l.startsWith('• ')).length, decisionsFrom(BODY).length + 2, 'four decisions and two risks');
  for (const d of decisionsFrom(BODY)) assert.ok(b.comment.includes(d), d);
  assert.deepEqual(decisionsFrom('## Decisions\n\n1. One\n   still one\n2. Two\n\n## Proof\n- x'), ['One still one', 'Two']);
});

test('nothing quoted from GitHub can become a Slack link or mention, or a GitHub mention', () => {
  const body = '## Decisions\n- Pinged <!channel> and @here, see [docs](https://evil.example) <https://evil|ok>\n- Asked @ana-dev to look';
  const b = brief({ title: 'Fix <@U123> *bold*', body });
  assert.doesNotMatch(b.slack, /[<>]|\]\(https:\/\/evil/);
  assert.match(b.slack, /‹!channel› and @​here, see \[docs\] \(https:\/\/evil\.example\)/);
  assert.match(b.comment, /Asked @\u200bana-dev to look/, 'nobody is notified, and no bot reacts to its name');
});

test('the PR comment has every decision, the proof link, all of QA, every risk area and the Merge risk reasons', () => {
  const { comment } = brief();
  assert.match(comment, /^## 🧭 Decision brief\n/);
  assert.match(comment, /\*\*Low: Only changes the empty-state text\.\*\* \(\[check\]\(https:\/\/github\.com\/o\/r\/runs\/60\)\)\n\nOnly changes the empty-state text\.\n\n- Touches one page only\./);
  assert.match(comment, /See \[## Proof\]\(https:\/\/github\.com\/o\/r\/pull\/7#proof\) in the PR body\./);
  assert.match(comment, /Covered:\n- ✅ The empty state shows the new text\n- ✅ The button opens the modal/);
  assert.match(comment, /Edge cases tried:\n- ⚠️ A very long name wraps/);
  assert.match(comment, /Not covered: the Slack DM/);
  assert.match(comment, /- \*\*Code to read carefully:\*\* `api\/src\/utils\/rateLimitUtils\.ts:400`/);
  const bare = brief({ body: 'none', runs: [...shards, mergeRisk('Medium: x'), qaCheck('Pass: 2 test cases passed', 'success')] });
  assert.match(bare.comment, /The PR body has no `## Proof` section\./);
  assert.match(bare.comment, /\*\*Please look before merging\.\*\*/, 'no decisions to confirm');
});

test('a risk with no bold lead shows its first sentence whole, without the file references it opens with', () => {
  const item = '`console/prAnnouncer.mjs:638-648` with `console/decisionBrief.mjs:189-226`: whether the tier is trusted depends on a run id '
    + 'read from the check\'s own summary, then confirmed against GitHub\'s workflow `path` and `head_sha`. This is the security boundary.';
  const b = brief({ comments: [reviewComment(`**Risk areas to eyeball manually**\n- ${item}`)] });
  assert.equal(after(b, 'Risks'), '**Risks**\n• Whether the tier is trusted depends on a run id read from the check\'s own summary, '
    + 'then confirmed against GitHub\'s workflow `path` and `head_sha`');
  assert.match(b.comment, /- `console\/prAnnouncer\.mjs:638-648` with/, 'the comment keeps the references');
});

test('the QA report is read from the headings a QA workflow counts', () => {
  const r = qaReportFrom(QA_COMMENT.body);
  assert.deepEqual(r.cases.map((c) => c.mark), ['✅', '✅']);
  assert.deepEqual(r.edges, [{ title: 'A very long name wraps', mark: '⚠️' }]);
  assert.match(r.untested, /^the Slack DM/);
  assert.equal(qa(brief({ comments: [RISKY, { ...QA_COMMENT, body: QA_COMMENT.body.replace(/Untested:\*\* .*/, 'Untested:** nothing; every test case ran.') }] })),
    'QA ✅ 2/2 passed · [Full brief →](https://github.com/o/r/pull/7#issuecomment-9)', 'nothing untested adds nothing');
});
