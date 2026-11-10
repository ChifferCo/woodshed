// Two contracts, both about not destroying something that exists nowhere else.
//
// removeReviewWorktree's two flags look like "did the command work" and are
// not: the caller keeps or drops the only record of the review/* branch on the
// strength of them, so reading an already-removed thing as a failure strands
// that record forever — on a retry, which is exactly when it matters.
//
// moveReviewWorktree carries out a `git reset --hard` on a live session
// worktree. Every case below where it refuses is a case where someone would
// have lost work, and the failure is silent: the reset succeeds, the review
// looks right, and the edits are gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeReviewWorktree, moveReviewWorktree, defaultBranch } from './worktree.mjs';
import { run } from './exec.mjs';

const BRANCH = 'review/pr-23808-a1b2c3d4';

async function repoWithBranch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  const setup = [
    ['init', '-q', '-b', 'master'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 't'],
    ['commit', '-q', '--allow-empty', '-m', 'root'],
    ['branch', BRANCH],
  ];
  for (const args of setup) await run('git', ['-C', root, ...args], { timeoutMs: 30_000 });
  return root;
}

async function branchExists(root) {
  const seen = await run(
    'git',
    ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`],
    { timeoutMs: 30_000 },
  );
  return seen.status === 0;
}

test('a worktree that is already gone reports removed, not failed', async () => {
  const root = await repoWithBranch();
  let called = false;
  const got = await removeReviewWorktree({
    repoRoot: root,
    worktreePath: path.join(root, 'never-existed'),
    branchName: BRANCH,
    removeWorktree() {
      called = true;
      return { ok: false, stderr: 'should not run' };
    },
  });
  assert.equal(called, false, 'nothing to remove, so git should not have been asked');
  assert.equal(got.worktreeRemoved, true, 'an absent worktree is a removed worktree');
  assert.equal(got.branchRemoved, true);
  assert.equal(await branchExists(root), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a branch already deleted reports removed, so a retry can finish', async () => {
  const root = await repoWithBranch();
  await run('git', ['-C', root, 'branch', '-D', BRANCH], { timeoutMs: 30_000 });
  const got = await removeReviewWorktree({
    repoRoot: root,
    worktreePath: null,
    branchName: BRANCH,
    removeWorktree() {
      return { ok: true, stderr: '' };
    },
  });
  // `git branch -D` exits non-zero here. Believing that would leave the caller
  // holding state for a branch that does not exist, with nothing left to clear.
  assert.equal(got.branchRemoved, true, 'a missing branch was read as left behind');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a worktree that would not go is reported, with the reason', async () => {
  const root = await repoWithBranch();
  const stuck = path.join(root, 'stuck');
  fs.mkdirSync(stuck);
  fs.writeFileSync(path.join(stuck, 'f'), 'x');
  const got = await removeReviewWorktree({
    repoRoot: root,
    worktreePath: stuck,
    branchName: BRANCH,
    // git declines AND the rmSync fallback is defeated, which is the only way
    // the directory survives both attempts.
    removeWorktree() {
      fs.chmodSync(root, 0o500);
      return { ok: false, stderr: 'is not a working tree' };
    },
  });
  fs.chmodSync(root, 0o700);
  assert.equal(got.worktreeRemoved, false, 'the directory is still there');
  assert.match(got.stderr, /not a working tree/, 'the caller gets an empty 500 without this');
  fs.rmSync(root, { recursive: true, force: true });
});

// --- moveReviewWorktree ------------------------------------------------------

const MOVE_BRANCH = 'review/pr-24683-0a1b2c3d';

async function git(root, args) {
  return run('git', ['-C', root, ...args], { timeoutMs: 30_000 });
}

/**
 * A repo with two commits on master, and a review worktree checked out at the
 * first of them — the shape a pull request review is in when the pull request
 * gains a commit.
 */
async function repoWithReviewWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-move-'));
  for (const args of [
    ['init', '-q', '-b', 'master'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 't'],
  ]) await git(root, args);
  fs.writeFileSync(path.join(root, 'file.txt'), 'one\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'one']);
  const first = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  fs.writeFileSync(path.join(root, 'file.txt'), 'two\n');
  await git(root, ['commit', '-q', '-am', 'two']);
  const second = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const worktreePath = path.join(root, 'wt');
  await git(root, ['worktree', 'add', '-q', '-b', MOVE_BRANCH, worktreePath, first]);
  return { root, worktreePath, first, second };
}

async function headOf(worktreePath) {
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
}

test('a clean worktree sitting on the reviewed commit moves to the new head', async () => {
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, true, got.error);
  assert.equal(got.moved, true);
  assert.equal(await headOf(worktreePath), second);
  assert.equal(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8'), 'two\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a worktree already at the new head is a no-op, not a reset', async () => {
  // The case after a session pushes its own fixes to the pull request: origin
  // moved and the tree moved with it, and the tree may well be dirty. Resetting
  // it here would throw away edits that are not on the new head yet.
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  await git(worktreePath, ['reset', '--hard', '-q', second]);
  fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'three\n');
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, true, got.error);
  assert.equal(got.moved, false);
  assert.equal(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8'), 'three\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('uncommitted changes refuse the move and survive it', async () => {
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'edited\n');
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.match(got.error, /uncommitted/);
  assert.equal(await headOf(worktreePath), first, 'the worktree must not have moved');
  assert.equal(fs.readFileSync(path.join(worktreePath, 'file.txt'), 'utf-8'), 'edited\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an untracked file refuses the move', async () => {
  // git status --porcelain reports it, and it is the likeliest thing to be
  // sitting in a review worktree: a scratch file someone wrote while reading.
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  fs.writeFileSync(path.join(worktreePath, 'notes.md'), 'what I found\n');
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.equal(fs.existsSync(path.join(worktreePath, 'notes.md')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a commit of the session own making refuses the move', async () => {
  // Clean tree, so the dirty check passes — this is the one a naive
  // implementation gets wrong, and the commit exists nowhere but here.
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  fs.writeFileSync(path.join(worktreePath, 'fix.txt'), 'a fix\n');
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-q', '-m', 'a fix from the review session']);
  const mine = await headOf(worktreePath);
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.match(got.error, /commits of its own/);
  assert.equal(await headOf(worktreePath), mine, 'the session commit must still be checked out');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a worktree that is gone is refused rather than recreated', async () => {
  const { root, worktreePath, first, second } = await repoWithReviewWorktree();
  fs.rmSync(worktreePath, { recursive: true, force: true });
  const got = await moveReviewWorktree({ worktreePath, recordedSha: first, targetSha: second });
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- defaultBranch -----------------------------------------------------------

test('a branch review is based on the repo\'s default branch, not on master', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root'],
    ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
  ]) await git(root, args);
  assert.equal(await defaultBranch(root, {}), 'main', 'a clone with no origin/HEAD, whose remote has main');
  assert.equal(await defaultBranch(root, { DEFAULT_BRANCH: 'trunk' }), 'trunk', 'a session\'s DEFAULT_BRANCH, asked of the remote at its start, wins');
});
