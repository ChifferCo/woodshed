import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAppLogins } from './reviewLogins.mjs';

const SESSION = { author: null, heading: '## Claude review', workflow: null, rerun: null, commentAuthor: null, runner: 'woodshed' };
const LOGINS = { reviewerLogin: 'acme-reviewer[bot]', ownLogin: 'acme-console[bot]' };

test('a review session that names no App is the reviewer App\'s verdict and the console App\'s comment', () => {
  const { review } = withAppLogins({ review: SESSION, suites: [] }, LOGINS);
  assert.equal(review.author, 'acme-reviewer[bot]');
  assert.equal(review.commentAuthor, 'acme-console[bot]');
});

test('with no reviewer App the verdict is the console App\'s, as it is submitted', () => {
  assert.equal(withAppLogins({ review: SESSION }, { ...LOGINS, reviewerLogin: null }).review.author, 'acme-console[bot]');
});

test('a login the project file names wins', () => {
  const named = { ...SESSION, author: 'other[bot]', commentAuthor: 'bot[bot]' };
  assert.deepEqual(withAppLogins({ review: named }, LOGINS).review, named);
});

test('a review in Actions, or no review, is left as the project file says', () => {
  const actions = { ...SESSION, runner: 'actions', author: 'ci[bot]' };
  assert.deepEqual(withAppLogins({ review: actions }, LOGINS).review, actions);
  assert.deepEqual(withAppLogins({ review: null, suites: [] }, LOGINS), { review: null, suites: [] });
  assert.equal(withAppLogins(null, LOGINS), null);
});
