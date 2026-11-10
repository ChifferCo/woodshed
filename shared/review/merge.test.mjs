// node --test review/merge.test.mjs
//
// Two properties, both silent when they fail:
//
// - A merge is refused unless the pull request is still at the commit the
//   review read, and every check has finished green. The repo has no required
//   checks, so GitHub merges on red; nothing but mergeBlocker stops it. And a
//   head that cannot be read has to refuse, not pass.
// - The merge and the enqueue both pin the reviewed head, or a push after the
//   check would be merged unread.
// - The typed commit title never reaches `gh` through `-F`, which would read a
//   file named by `@path` and send it to GitHub (see github.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeReadiness, enqueueArgv, mergeArgv, mergeBlocker } from './merge.mjs';

const SHA = 'f8257d8c9d0000000000000000000000000000aa';

function ready(overrides = {}) {
  return describeReadiness({
    id: 'PR_kwDOFPHKLM8AAAABFzkaDA',
    number: 24970,
    title: 'Dock the Workflow Update card',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    headRefOid: SHA,
    baseRefName: 'master',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...overrides,
  });
}

test('an approved pull request at the reviewed commit with green checks may merge', () => {
  assert.equal(mergeBlocker({ readiness: ready(), reviewedSha: SHA }), null);
});

test('a head that moved since the review refuses', () => {
  const moved = ready({ headRefOid: 'a91c04e2' + '0'.repeat(32) });
  assert.equal(mergeBlocker({ readiness: moved, reviewedSha: SHA }).code, 'moved');
});

test('a head that cannot be read refuses rather than passing', () => {
  assert.equal(mergeBlocker({ readiness: ready({ headRefOid: null }), reviewedSha: SHA }).code, 'moved');
  assert.equal(mergeBlocker({ readiness: ready(), reviewedSha: null }).code, 'moved');
});

test('a review that read uncommitted files refuses, and so does one that cannot tell', () => {
  assert.equal(mergeBlocker({ readiness: ready(), reviewedSha: SHA, uncommittedFiles: 2 }).code, 'uncommitted');
  assert.equal(mergeBlocker({ readiness: ready(), reviewedSha: SHA, uncommittedFiles: null }).code, 'uncommitted');
  assert.equal(mergeBlocker({ readiness: ready(), reviewedSha: SHA, uncommittedFiles: 0 }), null);
});

test('a failing check refuses, and so does one still running', () => {
  const red = ready({ statusCheckRollup: [
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ] });
  assert.equal(mergeBlocker({ readiness: red, reviewedSha: SHA }).code, 'checks-failing');
  const running = ready({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] });
  assert.equal(mergeBlocker({ readiness: running, reviewedSha: SHA }).code, 'checks-running');
});

test('an unapproved or draft pull request refuses', () => {
  assert.equal(mergeBlocker({ readiness: ready({ reviewDecision: 'REVIEW_REQUIRED' }), reviewedSha: SHA }).code, 'unapproved');
  assert.equal(mergeBlocker({ readiness: ready({ isDraft: true }), reviewedSha: SHA }).code, 'draft');
});

test('the commit title goes through -f, never -F', () => {
  const args = mergeArgv({ pr: 24970, slug: 'o/r', headSha: SHA, subject: '@/etc/passwd' });
  assert.ok(!args.includes('-F'));
  assert.ok(args.includes('commit_title=@/etc/passwd'));
  assert.ok(args.includes(`sha=${SHA}`));
  assert.ok(args.includes('merge_method=squash'));
});

test('the enqueue pins the reviewed head', () => {
  const args = enqueueArgv({ nodeId: ready().nodeId, headSha: SHA });
  assert.ok(args.some((a) => a.includes('expectedHeadOid: $sha')));
  assert.ok(args.includes(`sha=${SHA}`));
  assert.ok(args.includes('pr=PR_kwDOFPHKLM8AAAABFzkaDA'));
});
