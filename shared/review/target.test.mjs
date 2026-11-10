// node --test review/target.test.mjs
//
// What the launch form's "PR or branch" field is allowed to become. This is
// the only place in the feature where a user-supplied string turns into
// something that reaches an argv, a git refspec and a branch name, so the
// tests here are the adversarial ones: what must be REFUSED.
//
// The happy-path enumeration is deliberately thin — one test that the two
// accepted forms are accepted. A regex that stops recognising `23808` is not a
// bug that ships unnoticed.
//
// github.test.mjs used to live beside this and covered parsePrIdentifier, which
// parseTarget delegates to; the two are one input funnel and are tested as one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTarget, reviewBranchFor } from './target.mjs';
import { parsePrIdentifier } from './github.mjs';

test('accepts the two pull request forms and reports the repo of a URL', () => {
  assert.deepEqual(parseTarget('23808'), { ok: true, kind: 'pr', pr: 23808, slug: null });
  assert.deepEqual(parseTarget(' #23808 '), { ok: true, kind: 'pr', pr: 23808, slug: null });
  assert.deepEqual(parseTarget('https://github.com/acme/app/pull/23808'),
    { ok: true, kind: 'pr', pr: 23808, slug: 'acme/app' });
  // The slug is what lets the caller refuse a pull request in another repo,
  // which would need a clone rather than a worktree.
  assert.equal(parseTarget('https://github.com/other/repo/pull/1').slug, 'other/repo');
  // A host that merely CONTAINS github.com is not github.com.
  assert.equal(parseTarget('https://github.com.evil.tld/a/b/pull/1').ok, false);
});

test('accepts a branch, and strips the origin/ people paste', () => {
  assert.deepEqual(parseTarget('claude/bridge-pr-review'),
    { ok: true, kind: 'branch', branch: 'claude/bridge-pr-review' });
  assert.deepEqual(parseTarget('origin/master'), { ok: true, kind: 'branch', branch: 'master' });
});

test('refuses everything that could mean something other than a target', () => {
  const refused = [
    // Shell metacharacters and command substitution. There is no shell on this
    // path, but a value that looks like one reaching argv is not something to
    // find out about later.
    '23808; rm -rf /', '$(whoami)', '`id`', 'a|b', 'a&b', 'a>b', "a'b", 'a"b',
    // Flag-shaped. `git branch -D --force` is a different command.
    '-x', '--force', '--x',
    // Range operators and path traversal: `..` is how a refspec becomes a
    // revision range, and `../../etc/passwd` is the obvious one.
    'a..b', '../../etc/passwd', 'refs/heads/../../x',
    // git's own check-ref-format rules, which a legal-LOOKING string can break.
    '/leading', 'trailing/', 'a//b', 'a.lock', 'trailing.', '.hidden/x', 'HEAD',
    // Control characters and whitespace.
    'a\nb', 'a\tb', 'a b', 'a\0b',
    // Nothing, and far too much.
    '', '   ', 'x'.repeat(400),
    // A number outside GitHub's range is a phone number or a timestamp, and
    // must report THAT rather than fall through and be tried as a branch.
    '99999999',
  ];
  for (const input of refused) {
    const got = parseTarget(input);
    assert.equal(got.ok, false, `accepted ${JSON.stringify(input)}`);
    assert.ok(got.error.length > 0, `no reason given for ${JSON.stringify(input)}`);
  }
});

test('refuses a non-scalar rather than coercing it', () => {
  // String() flattens an array quietly: {"target": ["master"]} used to arrive
  // as "master". Nothing unsafe got through, but silently accepting a shape
  // the API does not document is how the next gap gets missed.
  for (const input of [['master'], { branch: 'master' }, null, undefined, true]) {
    assert.equal(parseTarget(input).ok, false, `accepted ${JSON.stringify(input)}`);
  }
  assert.equal(parsePrIdentifier([23808]).ok, false);
});

test('the review branch cannot collide with a branch already checked out', () => {
  // `git worktree add <path> <existing-branch>` fails outright when that
  // branch is checked out in another worktree, and this box routinely has
  // thirty of them. A new branch carrying the session id cannot collide — and
  // the name must survive being built from a branch full of slashes.
  const fromPr = reviewBranchFor({ target: { kind: 'pr', pr: 23808 }, sessionId: 'a1b2c3d4' });
  assert.equal(fromPr, 'review/pr-23808-a1b2c3d4');

  const fromBranch = reviewBranchFor({
    target: { kind: 'branch', branch: 'claude/bridge-pr-review' },
    sessionId: 'a1b2c3d4',
  });
  // No slashes past the first: git refuses refs/heads/a/b when refs/heads/a
  // exists, and the source branch name is full of them.
  assert.equal(fromBranch.split('/').length, 2);
  assert.ok(fromBranch.endsWith('-a1b2c3d4'));

  // The kill path only deletes a branch matching this exact shape, so every
  // name this produces has to match it or the branch leaks.
  const shape = /^review\/[A-Za-z0-9._-]+-[0-9a-f]{8}$/;
  const long = reviewBranchFor({
    target: { kind: 'branch', branch: 'feature/' + 'x'.repeat(120) },
    sessionId: 'deadbeef',
  });
  for (const name of [fromPr, fromBranch, long]) {
    assert.match(name, shape, name);
  }
});
