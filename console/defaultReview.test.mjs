import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_REVIEW, withDefaultReview } from './defaultReview.mjs';
import { withAppLogins } from './reviewLogins.mjs';

test('every repo is reviewed in a session on [woodshed-review] where its project file names no review; the file\'s own wins', () => {
  assert.deepEqual(withDefaultReview(null), { suites: [], qa: null, mergeRisk: null, review: DEFAULT_REVIEW });
  const suites = [{ name: 'CI', workflow: '.github/workflows/ci.yml', jobs: 'test', rerun: null }];
  assert.deepEqual(withDefaultReview({ review: null, suites, qa: null, mergeRisk: null, runsOn: 'a[bot]' }), { review: DEFAULT_REVIEW, suites, qa: null, mergeRisk: null, runsOn: 'a[bot]' }, 'the file\'s suites and runsOn stay');
  const own = { review: { runner: 'actions' }, suites: [] };
  assert.equal(withDefaultReview(own), own);
  assert.deepEqual([DEFAULT_REVIEW.runner, DEFAULT_REVIEW.rerun], ['woodshed', '[woodshed-review]']);
  const gates = withAppLogins(withDefaultReview(null), { reviewerLogin: 'acme-reviewer[bot]', ownLogin: 'acme-woodshed[bot]' });
  assert.deepEqual([gates.review.author, gates.review.commentAuthor], ['acme-reviewer[bot]', 'acme-woodshed[bot]'], 'trusted as the console\'s own Apps, as a file\'s session review is');
});
