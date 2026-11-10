// The reducers behind a session's pull-request chip.
//
// Only the pure parts are covered, and only where a failure would be silent.
// There is no fake `gh` here for the reason there is no fake `claude` anywhere
// in this directory: a stub emits what the test expects and passes for the
// wrong reason. The live path is verified in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWorktreeBranches,
  parseHeadBranch,
  selectPullRequests,
  reduceChecks,
  describePr,
  ttlFor,
} from './prStatus.mjs';

// ---- branches -------------------------------------------------------------

test('parseWorktreeBranches puts the current branch first, then the reflog', () => {
  const head = 'ref: refs/heads/claude/bridge-pwa-install\n';
  const reflog = [
    '0000000000000000000000000000000000000000 02c9886 Joel <j@x> 1787829438 +0000\tbranch: Created from HEAD',
    '02c9886 495b87c Joel <j@x> 1787911396 +0000\tcheckout: moving from worktree-bridge-1f399f7d to claude/first-attempt',
    '495b87c 88090a2 Joel <j@x> 1787911563 +0000\tcheckout: moving from claude/first-attempt to claude/bridge-pwa-install',
  ].join('\n');

  assert.deepEqual(parseWorktreeBranches({ head, reflog }), [
    'claude/bridge-pwa-install',
    'claude/first-attempt',
  ]);
});

// The branch every shed worktree is created on. It is renamed the moment real
// work starts, so it can never carry a pull request — and letting it through
// would cost a `gh` call a minute for every idle session on the box.
// The rail's pull-request folder says "a session here is already on this pull
// request" from this and nothing else. Answering it from the reflog instead
// sent people into a session that had moved to another branch — and offered
// no way to start one at the right head, which is the check the folder is for.
test('parseHeadBranch names only what HEAD is on now, and nothing a PR cannot be on', () => {
  assert.equal(parseHeadBranch('ref: refs/heads/claude/feat-a\n'), 'claude/feat-a');
  assert.equal(parseHeadBranch('ref: refs/heads/master\n'), null);
  assert.equal(parseHeadBranch('ref: refs/heads/worktree-bridge-1f399f7d\n'), null);
  // Detached: a bare sha, mid-bisect or after a `checkout <sha>`.
  assert.equal(parseHeadBranch('88090a2c1f0e4b7d9a3c5e6f7a8b9c0d1e2f3a4b\n'), null);
  assert.equal(parseHeadBranch(''), null);
});

test('parseWorktreeBranches drops the shed scaffolding branch', () => {
  const head = 'ref: refs/heads/worktree-bridge-fc8bf4b8\n';
  assert.deepEqual(parseWorktreeBranches({ head, reflog: '' }), []);
});

// A session that checked out somebody else's PR sits detached on a
// remote-tracking ref. The pull request is on the branch without the remote.
test('parseWorktreeBranches strips the origin/ prefix', () => {
  const reflog =
    'a1 b2 Joel <j@x> 1 +0000\tcheckout: moving from worktree-bridge-f2cfd327 to origin/nikolay/23834-chat';
  assert.deepEqual(
    parseWorktreeBranches({ head: 'a1b2c3d4\n', reflog }),
    ['nikolay/23834-chat'],
  );
});

// This value becomes argv for `gh`. There is no shell on that path, but a name
// starting with "-" is still read as an option rather than a branch.
test('parseWorktreeBranches refuses names that would be read as options', () => {
  const reflog = 'a1 b2 Joel <j@x> 1 +0000\tcheckout: moving from master to --repo';
  assert.deepEqual(parseWorktreeBranches({ head: '', reflog }), []);
});

test('parseWorktreeBranches caps a session that churned through branches', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push('a1 b2 Joel <j@x> 1 +0000\tcheckout: moving from br/' + i + ' to br/' + (i + 1));
  }
  const out = parseWorktreeBranches({ head: 'ref: refs/heads/br/head\n', reflog: lines.join('\n') });
  assert.equal(out.length, 12);
  assert.equal(out[0], 'br/head');
});

// The cap was 4, and a real session on this box put its OPEN pull request on
// the sixth branch back after rebuilding its branch twice. Everything merged
// behind it still drew a chip, so the card looked complete with the one live
// pull request missing. This pins the depth that case needs.
test('parseWorktreeBranches reaches a branch six checkouts back', () => {
  const moves = [
    ['claude/live-run-card-content-p3', 'claude/live-run-card-tools-used-p3-1'],
    ['claude/live-run-card-tools-used-p3-1', 'claude/live-run-card-spine-p3-2'],
    ['claude/live-run-card-spine-p3-2', 'claude/live-run-card-open-dataset-p3-3'],
    ['claude/live-run-card-open-dataset-p3-3', 'claude/live-run-card-content-p3'],
    ['claude/live-run-card-content-p3', 'claude/live-run-card-spine-p3-2'],
    ['claude/live-run-card-spine-p3-2', 'claude/live-run-card-open-dataset-p3-3'],
    ['claude/live-run-card-open-dataset-p3-3', 'claude/live-run-canvas-trigger-p3-4'],
    ['claude/live-run-canvas-trigger-p3-4', 'claude/live-run-card-tools-used-p3-1-rebuild'],
  ];
  const reflog = moves
    .map(([a, b]) => 'a1 b2 Joel <j@x> 1 +0000\tcheckout: moving from ' + a + ' to ' + b)
    .join('\n');
  const out = parseWorktreeBranches({
    head: 'ref: refs/heads/claude/live-run-card-tools-used-p3-1-rebuild\n',
    reflog,
  });
  assert.equal(out[0], 'claude/live-run-card-tools-used-p3-1-rebuild');
  assert.ok(
    out.includes('claude/live-run-card-tools-used-p3-1'),
    'the branch carrying the open pull request must survive the cap',
  );
});

// ---- how long an answer stays good ----------------------------------------

test('ttlFor keeps a settled answer far longer than a live one', () => {
  const merged = ttlFor({ prs: [{ state: 'merged' }, { state: 'closed' }] });
  const open = ttlFor({ prs: [{ state: 'open' }] });
  assert.ok(merged > open, 'merged and closed pull requests cannot change again');
});

// The transition the chip exists to show. Caching "no pull request" for fifteen
// minutes would mean a session that just opened one shows nothing until then.
test('ttlFor does not treat an empty answer as settled', () => {
  assert.equal(ttlFor({ prs: [] }), ttlFor({ prs: [{ state: 'open' }] }));
});

test('ttlFor backs a failed lookup off the furthest', () => {
  const failed = ttlFor({ prs: [], failedAt: Date.now() });
  assert.ok(failed > ttlFor({ prs: [] }));
});

// ---- which pull requests get drawn ----------------------------------------

// The rule Joel picked: a closed-unmerged pull request is the supersede case
// ("closed #10, opened #11") and pure noise whenever anything else of the
// session's is alive. It survives only as a last word.
test('selectPullRequests hides a closed PR that a later one superseded', () => {
  const out = selectPullRequests([
    { number: 10, state: 'closed' },
    { number: 11, state: 'open' },
  ]);
  assert.deepEqual(out.map((p) => p.number), [11]);
});

test('selectPullRequests hides a closed PR when something merged', () => {
  const out = selectPullRequests([
    { number: 10, state: 'closed' },
    { number: 11, state: 'merged' },
  ]);
  assert.deepEqual(out.map((p) => p.number), [11]);
});

// The case the chip exists for: a session that looks finished and shipped
// nothing. Nothing else on the card says so.
test('selectPullRequests keeps a closed PR that is the session last word', () => {
  const out = selectPullRequests([
    { number: 9, state: 'closed' },
    { number: 10, state: 'closed' },
  ]);
  assert.deepEqual(out.map((p) => p.number), [10, 9]);
});

test('selectPullRequests orders newest first', () => {
  const out = selectPullRequests([
    { number: 7, state: 'merged' },
    { number: 21, state: 'open' },
    { number: 14, state: 'merged' },
  ]);
  assert.deepEqual(out.map((p) => p.number), [21, 14, 7]);
});

// The real shape this got wrong: a session with eight shipped pull requests and
// one still open sorted the open one into the MIDDLE of the row, between merged
// numbers above and below it. Both the card and the rail lead with the head of
// this list, and the live one is the only one anybody can still act on.
test('selectPullRequests puts a live PR ahead of newer merged ones', () => {
  const out = selectPullRequests([
    { number: 24036, state: 'merged' },
    { number: 24005, state: 'merged' },
    { number: 23971, state: 'merged' },
    { number: 23970, state: 'open' },
    { number: 23959, state: 'merged' },
  ]);
  assert.equal(out[0].number, 23970, 'the open one leads despite a lower number');
  assert.deepEqual(out.map((p) => p.number), [23970, 24036, 24005, 23971, 23959]);
});

test('selectPullRequests ranks a draft with the live ones', () => {
  const out = selectPullRequests([
    { number: 900, state: 'merged' },
    { number: 100, state: 'draft' },
  ]);
  assert.equal(out[0].number, 100);
});

// ---- the check rollup ------------------------------------------------------

// The trap this guards: a CheckRun that has not finished carries conclusion
// null, so reading conclusion without looking at status first counts every
// running job as a pass — and a pull request mid-CI draws a green tick.
test('reduceChecks counts a running job as pending, not as a pass', () => {
  const out = reduceChecks([
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'CheckRun', status: 'QUEUED', conclusion: null },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ]);
  assert.deepEqual(out, { pass: 1, fail: 0, pending: 2, total: 3 });
});

// This repo skips most of its checks on most pull requests — the [claude-*]
// tag gates alone are a dozen. Counting SKIPPED as anything but a pass would
// leave nearly every chip permanently amber.
test('reduceChecks treats skipped and neutral as passing', () => {
  const out = reduceChecks([
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ]);
  assert.deepEqual(out, { pass: 2, fail: 0, pending: 0, total: 2 });
});

// Two shapes share the array: CheckRun has status/conclusion, StatusContext
// only has state.
test('reduceChecks reads a StatusContext through its state field', () => {
  const out = reduceChecks([
    { __typename: 'StatusContext', state: 'FAILURE' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]);
  assert.deepEqual(out, { pass: 1, fail: 1, pending: 0, total: 2 });
});

test('reduceChecks survives a missing or malformed rollup', () => {
  assert.deepEqual(reduceChecks(undefined), { pass: 0, fail: 0, pending: 0, total: 0 });
  assert.deepEqual(reduceChecks(null), { pass: 0, fail: 0, pending: 0, total: 0 });
  assert.deepEqual(reduceChecks([null]), { pass: 0, fail: 0, pending: 1, total: 1 });
});

// ---- one gh record, reduced ------------------------------------------------

test('describePr reads a draft as its own state', () => {
  const pr = describePr({ number: 24061, state: 'OPEN', isDraft: true, title: 'wip' });
  assert.equal(pr.state, 'draft');
});

// Checks on a settled branch are history. A red cross on a merged pull request
// would read as something to go and fix.
test('describePr drops the checks on a merged or closed PR', () => {
  const rollup = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }];
  assert.equal(describePr({ number: 1, state: 'MERGED', statusCheckRollup: rollup }).checks, null);
  assert.equal(describePr({ number: 2, state: 'CLOSED', statusCheckRollup: rollup }).checks, null);
  assert.deepEqual(
    describePr({ number: 3, state: 'OPEN', statusCheckRollup: rollup }).checks,
    { pass: 0, fail: 1, pending: 0, total: 1 },
  );
});

// "merged · approved" is a mark on every merged chip that adds nothing to the
// word "merged" — and it was wide enough to wrap the card's meta line.
test('describePr drops the review decision on a merged or closed PR', () => {
  const at = (state) => describePr({ number: 1, state, reviewDecision: 'APPROVED' }).review;
  assert.equal(at('MERGED'), null);
  assert.equal(at('CLOSED'), null);
  assert.equal(at('OPEN'), 'approved');
});

test('describePr maps every review decision it can be given', () => {
  const at = (d) => describePr({ number: 1, state: 'OPEN', reviewDecision: d }).review;
  assert.equal(at('APPROVED'), 'approved');
  assert.equal(at('CHANGES_REQUESTED'), 'changes');
  assert.equal(at('REVIEW_REQUIRED'), 'pending');
  assert.equal(at(''), null);
  assert.equal(at(undefined), null);
});

// The chip is an anchor pointing at whatever this field holds. A javascript:
// URL in it would be a click away from running in the page.
test('describePr refuses a url that is not a github.com https url', () => {
  assert.equal(describePr({ number: 1, state: 'OPEN', url: 'javascript:alert(1)' }).url, null);
  assert.equal(describePr({ number: 1, state: 'OPEN', url: 'http://evil.test/x' }).url, null);
  assert.equal(
    describePr({ number: 1, state: 'OPEN', url: 'https://github.com/o/r/pull/1' }).url,
    'https://github.com/o/r/pull/1',
  );
});

test('describePr rejects a record with no usable number', () => {
  assert.equal(describePr({ state: 'OPEN' }), null);
  assert.equal(describePr({ number: 'abc', state: 'OPEN' }), null);
  assert.equal(describePr(null), null);
});
