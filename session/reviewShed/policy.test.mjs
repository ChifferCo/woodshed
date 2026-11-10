import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isGithubWrite, sectionOf, withoutPullRequest, writesAllowed } from './policy.mjs';

test('every call that writes to GitHub is recognised, and reads are not', () => {
  const s = '/reviews/claude-0a1b2c3d';
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}/comments` }), true);
  assert.equal(isGithubWrite({ method: 'DELETE', pathname: `${s}/comments` }), true);
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}/submit` }), true);
  assert.equal(isGithubWrite({ method: 'PATCH', pathname: `${s}/title` }), true);
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}/viewed` }), true);
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}/merge` }), true);
  assert.equal(isGithubWrite({ method: 'GET', pathname: `${s}/comments` }), false);
  assert.equal(isGithubWrite({ method: 'GET', pathname: `${s}/merge` }), false);
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}/chat` }), false);
  assert.equal(isGithubWrite({ method: 'POST', pathname: `${s}` }), false);
});

test('sectionOf is empty for the status call', () => {
  assert.equal(sectionOf('/reviews/claude-0a1b2c3d'), '');
  assert.equal(sectionOf('/reviews/claude-0a1b2c3d/explain/abc'), 'explain');
  assert.equal(sectionOf('/review'), '');
});

test('only a private session whose gh is a person may write', () => {
  assert.equal(writesAllowed({ sessionKind: 'private', account: 'octocat' }), true);
  assert.equal(writesAllowed({ sessionKind: 'private', account: null }), false);
  assert.equal(writesAllowed({ sessionKind: 'shared', account: 'someone' }), false);
  assert.equal(writesAllowed({ sessionKind: undefined, account: 'someone' }), false);
});

test('a read-only status hides the pull request and the account, and leaves everything else', () => {
  const body = { ok: true, status: 'ready', livePr: { number: 7 }, ghAccount: 'x', kind: 'worktree' };
  assert.deepEqual(withoutPullRequest(body), { ok: true, status: 'ready', livePr: null, ghAccount: null, kind: 'worktree' });
  assert.deepEqual(withoutPullRequest({ ok: true, files: [] }), { ok: true, files: [] });
});
