import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionDiff, shapeSessionDiff } from './sessionDiff.mjs';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// A checkout of a bare origin, on its own branch, like a session's: master has a.txt and b.txt.
function sessionCheckout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-diff-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin.git');
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'kept\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'master');
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'checkout', '-q', '-b', 'woodshed/test');
  return repo;
}

test('the diff covers commits, uncommitted edits and untracked files, and leaves the index alone', async (t) => {
  const repo = sessionCheckout(t);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');
  git(repo, 'commit', '-qam', 'committed edit');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'kept\nunstaged line\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'ignored\n');
  const statusBefore = git(repo, 'status', '--porcelain');

  const diff = await readSessionDiff({ repoDir: repo, baseRef: 'master' });

  assert.equal(diff.ok, true);
  assert.equal(diff.base, 'master');
  assert.equal(diff.branch, 'woodshed/test');
  assert.equal(diff.baseSha, git(repo, 'rev-parse', 'master'));
  assert.equal(diff.head, git(repo, 'rev-parse', 'HEAD').slice(0, 10));
  assert.equal(diff.aheadBy, 1);
  assert.equal(diff.uncommitted, true);
  assert.equal(diff.baseFetched, true);
  assert.deepEqual({ additions: diff.additions, deletions: diff.deletions }, { additions: 3, deletions: 1 });
  assert.deepEqual(diff.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ['a.txt', 'modified', 1, 1], ['b.txt', 'modified', 1, 0], ['new.txt', 'added', 1, 0],
  ]);
  assert.match(diff.files[0].patch, /^@@ .*\n one\n-two\n\+TWO$/);
  assert.match(diff.files[1].patch, /^\+unstaged line$/m);
  assert.equal(diff.files.some((f) => f.path.includes('node_modules')), false);
  assert.equal('patch' in diff, false, 'only the files carry hunks');
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'nothing was staged');
});

test('a checkout equal to master has an empty diff', async (t) => {
  const repo = sessionCheckout(t);
  const diff = await readSessionDiff({ repoDir: repo, baseRef: 'master' });
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.files, []);
  assert.equal(diff.uncommitted, false);
  assert.equal(diff.aheadBy, 0);
});

test('the files\' hunks are held to the cap too: past it a file keeps its counts and is marked too large', async (t) => {
  const repo = sessionCheckout(t);
  fs.writeFileSync(path.join(repo, 'a.txt'), `one\n${'x'.repeat(400)}\n`);
  fs.writeFileSync(path.join(repo, 'b.txt'), `kept\n${'y'.repeat(400)}\n`);
  const diff = await readSessionDiff({ repoDir: repo, baseRef: 'master', maxBytes: 600 });
  assert.deepEqual(diff.files.map((f) => [f.path, Boolean(f.patch), f.truncated, f.additions]), [
    ['a.txt', true, false, 1], ['b.txt', false, true, 1],
  ]);
});

test('a file left out for size does not count against the files after it', async (t) => {
  const repo = sessionCheckout(t);
  fs.writeFileSync(path.join(repo, 'a.txt'), `one\n${'x'.repeat(800)}\n`);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'kept\nsmall\n');
  const diff = await readSessionDiff({ repoDir: repo, baseRef: 'master', maxBytes: 600 });
  assert.deepEqual(diff.files.map((f) => [f.path, Boolean(f.patch), f.truncated]), [['a.txt', false, true], ['b.txt', true, false]]);
});

test('a checkout with no default branch is refused, not diffed', async () => {
  let called = false;
  const diff = await readSessionDiff({ repoDir: '/nowhere', baseRef: null, diff: async () => { called = true; } });
  assert.deepEqual(diff, { ok: false, status: 409, error: 'the checkout has no default branch to compare with' });
  assert.equal(called, false);
});

test('a failed read passes its status and error on', async () => {
  const diff = await readSessionDiff({
    repoDir: '/nowhere', baseRef: 'master', diff: async () => ({ ok: false, status: 409, error: 'this session no longer has a worktree' }),
  });
  assert.deepEqual(diff, { ok: false, status: 409, error: 'this session no longer has a worktree' });
});

test('shapeSessionDiff gives GitHub compare\'s file shape: removed, renamed and binary files included', () => {
  const patch = [
    'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', 'index 1111111..0000000', '--- a/gone.txt', '+++ /dev/null',
    '@@ -1 +0,0 @@', '-bye',
    'diff --git a/old.txt b/new.txt', 'similarity index 90%', 'rename from old.txt', 'rename to new.txt', '--- a/old.txt', '+++ b/new.txt',
    '@@ -1,2 +1,2 @@', ' same', '-was', '+is',
    'diff --git a/logo.png b/logo.png', 'new file mode 100644', 'index 0000000..2222222', 'Binary files /dev/null and b/logo.png differ',
    '',
  ].join('\n');
  assert.deepEqual(shapeSessionDiff(patch), {
    additions: 1,
    deletions: 2,
    files: [
      { path: 'gone.txt', previousPath: null, status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-bye', truncated: false },
      { path: 'new.txt', previousPath: 'old.txt', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n same\n-was\n+is', truncated: false },
      { path: 'logo.png', previousPath: null, status: 'added', additions: 0, deletions: 0, patch: null, truncated: false },
    ],
  });
});
