// removeReviewSession's one contract: the answer it gives the caller and the
// decision it makes about the on-disk state must be the same answer.
//
// They were two expressions for two rounds of review. When they disagreed the
// failure was silent in the worst direction — the route answered 200, the
// session left the list, and the state kept here for a retry that would now
// never come was the only thing still naming the orphaned review/* branch.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// REVIEWS_DIR is read once at module load, so this has to precede the import.
const REVIEWS = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-state-'));
process.env.WOODSHED_REVIEWS = REVIEWS;

const { run } = await import('./exec.mjs');
const { writeSessionReview, readSessionReview, removeReviewState } = await import('./store.mjs');
const { removeReviewSession, reviewOwnsBranch } = await import('./index.mjs');

const BRANCH_FOR = (session) => `review/pr-23808-${session.slice('claude-'.length)}`;

function git(root, ...args) {
  return run('git', ['-C', root, ...args], { timeoutMs: 60_000 });
}

/** A repo with the review branch checked out in a worktree, and state on disk. */
async function fixture(session) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rm-repo-')));
  await git(root, 'init', '-q', '-b', 'master');
  await git(root, 'config', 'user.email', 't@t');
  await git(root, 'config', 'user.name', 't');
  await git(root, 'commit', '-q', '--allow-empty', '-m', 'root');
  const worktree = path.join(root, 'wt');
  const branch = BRANCH_FOR(session);
  await git(root, 'worktree', 'add', '-q', '-b', branch, worktree);
  writeSessionReview({
    session,
    review: { kind: 'pr', pr: 23808, worktree, reviewBranch: branch, headSha: 'a'.repeat(40) },
  });
  return { root, worktree, branch };
}

const ctx = (repoRoot, removeWorktree) => ({ repoRoot, removeWorktree, log() {} });

test("a review of the session's own worktree takes neither with it", async () => {
  const session = 'claude-6666ffff';
  const { root, worktree, branch } = await fixture(session);
  // What createWorktreeReview writes. The worktree and the branch are the
  // user's work and this review is only a read of them, so the removal that
  // is right for the other two kinds is destructive here.
  const record = readSessionReview(session);
  writeSessionReview({
    session,
    review: { ...record, kind: 'worktree', reviewBranch: null, ownsWorktree: false },
  });

  let asked = false;
  const got = await removeReviewSession({
    ctx: ctx(root, function removeWorktree() {
      asked = true;
      return { ok: true, stderr: '' };
    }),
    sessionName: session,
  });

  assert.equal(asked, false, 'it tried to remove a worktree it does not own');
  assert.equal(fs.existsSync(worktree), true, "the session's worktree was deleted");
  const alive = await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  assert.equal(alive.status, 0, "the session's branch was deleted — that is the work itself");
  // `removed: false` is the contract: the caller disposes of the worktree its
  // own usual way, which for this session is the only correct way.
  assert.equal(got.removed, false, 'the caller was told the review had handled the worktree');
  assert.equal(readSessionReview(session), null, 'the review state should still be cleared');

  await git(root, 'worktree', 'remove', '--force', '--force', worktree);
  fs.rmSync(root, { recursive: true, force: true });
});

// The Kill confirmation and its tooltip branch on this, so a wrong answer
// tells someone their work is about to be deleted when it is not. It is not
// the same question as "does a review exist", which is what they used to ask.
test('reviewOwnsBranch answers for the branch, not for the review', async () => {
  const session = 'claude-7777aaaa';
  const { root } = await fixture(session);
  const base = readSessionReview(session);

  assert.equal(reviewOwnsBranch(session), 'always', 'a bridge-created review owns its branch');

  writeSessionReview({ session, review: { ...base, kind: 'worktree', ownsWorktree: false } });
  assert.equal(reviewOwnsBranch(session), false, "a session's own worktree is not the review's to delete");

  // Records written before ownsWorktree existed were all bridge-created, so
  // the missing case has to read as owned.
  const { ownsWorktree, ...legacy } = { ...base, ownsWorktree: undefined };
  writeSessionReview({ session, review: legacy });
  assert.equal(reviewOwnsBranch(session), 'always', 'a pre-existing record must not read as unowned');

  // On the pull request's own branch, Kill deletes it only when the review
  // created it, and then only once everything on it is pushed.
  const onPr = { ...base, reviewBranch: 'someone/feature', ownsWorktree: true };
  writeSessionReview({ session, review: { ...onPr, ownsBranch: true } });
  assert.equal(reviewOwnsBranch(session), 'ifPushed');
  writeSessionReview({ session, review: { ...onPr, ownsBranch: false } });
  assert.equal(reviewOwnsBranch(session), false, 'a branch that predates the review is never its to delete');

  removeReviewState(session);
  assert.equal(reviewOwnsBranch(session), false, 'no review, nothing owned');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean removal reports complete and drops the state', async () => {
  const session = 'claude-1111aaaa';
  const { root, worktree } = await fixture(session);
  const got = await removeReviewSession({
    // What server.mjs's removeWorktree does: deregister as well as delete —
    // await accepts both the legacy synchronous helper and the async helper.
    ctx: ctx(root, function removeWorktree(p) {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', '--force', p]);
      return { ok: true, stderr: '' };
    }),
    sessionName: session,
  });
  assert.equal(got.complete, true, 'a clean removal was not reported complete');
  assert.equal(readSessionReview(session), null, 'state outlived a complete removal');
  assert.equal(fs.existsSync(worktree), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('review removal waits for async git before fallback deletion or dropping state', async (t) => {
  const session = 'claude-7777eeee';
  const { root, worktree } = await fixture(session);
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const pending = removeReviewSession({
    ctx: ctx(root, async function removeWorktree(p) {
      await gate;
      assert.equal(fs.existsSync(p), true, 'fallback raced the pending git removal');
      const result = await git(root, 'worktree', 'remove', '--force', '--force', p);
      return { ok: result.status === 0, stderr: result.stderr };
    }),
    sessionName: session,
  });
  t.after(async function () { release(); await pending; fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(setImmediate);
  assert.equal(fs.existsSync(worktree), true, 'worktree was deleted before git completed');
  assert.notEqual(readSessionReview(session), null, 'recovery state was removed too soon');
  release();
  assert.equal((await pending).complete, true);
  assert.equal(readSessionReview(session), null);
});

test('the rmSync fallback still lets the branch go', async () => {
  const session = 'claude-2222bbbb';
  const { root, worktree, branch } = await fixture(session);
  // git declines, the directory is deleted by hand. Before deregisterWorktree
  // this left the administrative entry behind and `git branch -D` refused with
  // "used by worktree" — forever, on every retry, because the registration is
  // the thing that outlives the directory.
  const got = await removeReviewSession({
    ctx: ctx(root, function removeWorktree() {
      return { ok: false, stderr: 'contains modified or untracked files' };
    }),
    sessionName: session,
  });
  assert.equal(fs.existsSync(worktree), false, 'the fallback did not delete it');
  assert.equal(got.branchRemoved, true, 'the branch was unreachable behind a stale registration');
  assert.equal(got.complete, true);
  assert.equal(got.failed, null, 'a complete removal named a failure');
  assert.equal(readSessionReview(session), null);
  const still = await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  assert.notEqual(still.status, 0, 'the branch is still in the repo');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the fallback deregisters only its own worktree', async () => {
  const session = 'claude-4444dddd';
  const { root, worktree } = await fixture(session);
  // A bystander. This box carries thirty-odd live session worktrees, and the
  // reason the entry is matched by its recorded gitdir rather than by name —
  // and the reason this is not `git worktree prune` — is that either shortcut
  // takes somebody else's work with it.
  const other = path.join(root, 'wt-other');
  const otherBranch = 'review/pr-1-eeeeeeee';
  await git(root, 'worktree', 'add', '-q', '-b', otherBranch, other);

  // And one whose directory is missing right now. This is the case that makes
  // `git worktree prune` the wrong tool rather than merely a blunt one: prune
  // judges an entry stale by exactly this, and a live session whose directory
  // is momentarily absent looks identical to a dead one.
  const absent = path.join(root, 'wt-absent');
  const absentBranch = 'review/pr-2-ffffffff';
  await git(root, 'worktree', 'add', '-q', '-b', absentBranch, absent);
  fs.rmSync(absent, { recursive: true, force: true });

  await removeReviewSession({
    ctx: ctx(root, function removeWorktree() {
      return { ok: false, stderr: 'contains modified or untracked files' };
    }),
    sessionName: session,
  });

  assert.equal(fs.existsSync(worktree), false, 'ours should be gone');
  assert.equal(fs.existsSync(other), true, "the bystander's directory was deleted");
  // Named entries rather than "the bystander survived": with only a count, or
  // only the other one checked, an implementation that removed an arbitrary
  // entry passes whenever readdir happens to hand it ours first.
  const admin = path.join(root, '.git', 'worktrees');
  const left = fs.readdirSync(admin).sort();
  assert.deepEqual(left, ['wt-absent', 'wt-other'], 'exactly our own entry should have gone');
  for (const b of [otherBranch, absentBranch]) {
    const alive = await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`);
    assert.equal(alive.status, 0, `${b} was deleted`);
  }

  await git(root, 'worktree', 'remove', '--force', '--force', other);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a branch left behind by a removed worktree says so', async () => {
  const session = 'claude-5555eeee';
  const { root, worktree, branch } = await fixture(session);
  // git refuses to delete a branch checked out anywhere, including the main
  // working tree — so this removes the worktree cleanly and still cannot take
  // the branch. That combination is what made the 500 read "git worktree
  // remove failed" about a worktree that is gone.
  //
  // The worktree has to let go of the branch before the main tree can take it;
  // without the detach the checkout below fails with "already checked out",
  // the branch stays free, and the test passes for the wrong reason.
  await git(worktree, 'checkout', '-q', '--detach');
  const claimed = await git(root, 'checkout', '-q', branch);
  assert.equal(claimed.status, 0, 'the main tree never took the branch');

  const got = await removeReviewSession({
    ctx: ctx(root, function removeWorktree(p) {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', '--force', p]);
      return { ok: true, stderr: '' };
    }),
    sessionName: session,
  });

  assert.equal(fs.existsSync(worktree), false, 'the worktree should be gone');
  assert.equal(got.worktreeRemoved, true);
  assert.equal(got.branchRemoved, false);
  assert.equal(got.complete, false);
  assert.match(got.failed, /the worktree is gone but its branch/, 'the 500 would misreport this');
  assert.ok(got.failed.includes(branch), 'the message must name the branch left behind');
  assert.ok(got.stderr, "git's account of why was dropped");
  assert.ok(readSessionReview(session), 'the record of the orphaned branch was deleted');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a branch left behind is not reported as a complete removal', async () => {
  const session = 'claude-3333cccc';
  const { root, worktree, branch } = await fixture(session);
  // Defeat the git removal AND the rmSync fallback, so the worktree survives —
  // which is also what stops `git branch -D`, since git refuses a branch that
  // is still checked out. The two failures arrive together.
  const got = await removeReviewSession({
    ctx: ctx(root, function removeWorktree() {
      fs.chmodSync(root, 0o500);
      return { ok: false, stderr: 'contains modified or untracked files' };
    }),
    sessionName: session,
  });
  fs.chmodSync(root, 0o700);

  assert.equal(fs.existsSync(worktree), true, 'the setup did not actually fail');
  assert.equal(got.branchRemoved, false, 'the branch is still there');
  assert.equal(got.complete, false, 'a half-removal reported as complete');
  // The caller turns this into a 500 body. It said "git worktree remove
  // failed" for both halves, which is a lie about a worktree that is gone.
  assert.match(got.failed, /worktree remove failed/);
  // The part the route depends on: something still names the branch.
  const kept = readSessionReview(session);
  assert.ok(kept, 'the only record of the orphaned branch was deleted');
  assert.equal(kept.reviewBranch, branch);
  fs.rmSync(root, { recursive: true, force: true });
});
