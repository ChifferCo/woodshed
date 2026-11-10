// A review that sits on the pull request's own branch shares that branch with
// the rest of the box. Every test here is a case where getting it wrong loses
// somebody's commits, silently: a branch moved or deleted under them, or a
// session's unpushed work deleted by Kill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createReviewWorktree, removeReviewWorktree } from './worktree.mjs';
import { run } from './exec.mjs';

const BRANCH = 'someone/feature';

function git(cwd, args) {
  return run('git', ['-C', cwd, ...args], { timeoutMs: 30_000 });
}

async function sha(cwd, ref) {
  return ((await git(cwd, ['rev-parse', ref])).stdout || '').trim();
}

// An origin with BRANCH one commit ahead of master, and a clone of it standing
// in for the box's checkout.
async function originAndClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prb-test-'));
  const origin = path.join(dir, 'origin');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(origin);
  for (const args of [
    ['init', '-q', '-b', 'master'],
    ['config', 'user.email', 't@t'],
    ['config', 'user.name', 't'],
    ['commit', '-q', '--allow-empty', '-m', 'root'],
    ['checkout', '-q', '-b', BRANCH],
    ['commit', '-q', '--allow-empty', '-m', 'feature'],
    ['checkout', '-q', 'master'],
  ]) await git(origin, args);
  await run('git', ['clone', '-q', origin, clone], { timeoutMs: 30_000 });
  await git(clone, ['config', 'user.email', 't@t']);
  await git(clone, ['config', 'user.name', 't']);
  return { dir, origin, clone };
}

function create(clone, dir, name) {
  return createReviewWorktree({
    repoRoot: clone,
    sessionId: 'a1b2c3d4',
    target: { kind: 'branch', branch: BRANCH },
    baseRef: 'master',
    worktreePath: path.join(dir, name),
    branchName: BRANCH,
    onPrBranch: true,
  });
}

test('a review creates the pull request branch, tracking origin, and owns it', async () => {
  const { dir, origin, clone } = await originAndClone();
  const got = await create(clone, dir, 'wt');
  assert.equal(got.ok, true, got.error);
  assert.equal(got.ownsBranch, true);
  const wt = path.join(dir, 'wt');
  assert.equal(((await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '').trim(), BRANCH);
  // What makes a plain `git push` from the session reach the pull request.
  assert.equal(((await git(wt, ['rev-parse', '--abbrev-ref', '@{upstream}'])).stdout || '').trim(), `origin/${BRANCH}`);
  assert.equal(await sha(wt, 'HEAD'), await sha(origin, BRANCH));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a local branch with commits the pull request lacks is refused and left alone', async () => {
  const { dir, clone } = await originAndClone();
  await git(clone, ['branch', BRANCH, 'master']);
  await git(clone, ['checkout', '-q', BRANCH]);
  await git(clone, ['commit', '-q', '--allow-empty', '-m', 'local only']);
  await git(clone, ['checkout', '-q', 'master']);
  const before = await sha(clone, BRANCH);

  const got = await create(clone, dir, 'wt');
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.equal(await sha(clone, BRANCH), before, 'the local commit was moved off its branch');
  assert.equal(fs.existsSync(path.join(dir, 'wt')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a branch checked out in another worktree is refused, naming where', async () => {
  const { dir, clone } = await originAndClone();
  const other = path.join(dir, '.claude', 'worktrees', 'bridge-deadbeef');
  await git(clone, ['worktree', 'add', '-q', '-b', BRANCH, other, 'master']);

  const got = await create(clone, dir, 'wt');
  assert.equal(got.ok, false);
  assert.equal(got.status, 409);
  assert.match(got.error, /claude-deadbeef/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Kill deletes a review-created branch only when nothing on it would be lost', async () => {
  const { dir, clone } = await originAndClone();
  const got = await create(clone, dir, 'wt');
  const wt = path.join(dir, 'wt');
  await git(wt, ['commit', '-q', '--allow-empty', '-m', 'unpushed']);

  const removeWorktree = async (p) => git(clone, ['worktree', 'remove', '--force', p]).then((r) => ({ ok: r.status === 0, stderr: r.stderr }));
  const kept = await removeReviewWorktree({
    repoRoot: clone, worktreePath: wt, branchName: BRANCH, ownsBranch: true,
    reviewedSha: got.headSha, removeWorktree,
  });
  assert.equal(kept.worktreeRemoved, true);
  assert.equal(kept.branchKept, true);
  assert.equal(kept.keptUnpushed, true);
  assert.equal(kept.failed, null, 'keeping the branch on purpose is not a failure');
  assert.equal((await git(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`])).status, 0,
    'an unpushed commit was deleted with its branch');

  // Once pushed, the same removal lets the branch go.
  await git(clone, ['push', '-q', 'origin', BRANCH]);
  const gone = await removeReviewWorktree({
    repoRoot: clone, worktreePath: null, branchName: BRANCH, ownsBranch: true,
    reviewedSha: got.headSha, removeWorktree,
  });
  assert.equal(gone.branchRemoved, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Kill never deletes a pull request branch the review did not create', async () => {
  const { dir, clone } = await originAndClone();
  await git(clone, ['branch', BRANCH, `origin/${BRANCH}`]);
  const got = await removeReviewWorktree({
    repoRoot: clone, worktreePath: null, branchName: BRANCH, ownsBranch: false,
    reviewedSha: await sha(clone, BRANCH), removeWorktree: async () => ({ ok: true }),
  });
  assert.equal(got.branchKept, true);
  assert.equal(got.failed, null);
  assert.equal((await git(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`])).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
