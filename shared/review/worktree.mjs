// The git side of a review session: put the pull request (or branch) head into
// an ordinary session worktree, and take it apart again.
//
// This replaces the feature's old private checkout under $REVIEWS_DIR. The
// worktree is now <repo>/.claude/worktrees/bridge-<sessionId>, exactly like
// every other shed session's, and its lifetime is the session's. Three
// consequences worth stating out loud, because the previous design existed to
// avoid all three:
//
//  1. The repo's SessionStart hook DOES run in it, hardlinking node_modules and
//     writing the app's env files. That is now wanted: a real `claude` runs here
//     and `Start app` has to work.
//  2. The session appears in the shed's own session list. Also wanted — that
//     list is how you reach the review.
//  3. The tree is live. Whoever is reviewing can edit it. Everything downstream
//     that assumed "the tree is exactly the head SHA" had to be revisited; see
//     the note on the answer cache in index.mjs.
//
// The shed creates the worktree itself rather than letting `claude
// --worktree` do it, because claude would branch off the repo's default branch
// and there is no flag to tell it otherwise.
//
// Everything here is async, via exec.mjs's run(). A `git worktree add` of this
// repo copies ~130 MB and takes tens of seconds; doing it with spawnSync the
// way the rest of server.mjs does its subprocess work would freeze every other
// tab's /sessions poll for the duration.

import fs from 'node:fs';
import path from 'node:path';

import { defaultBranchOf } from '../defaultBranch.mjs';
import { run } from './exec.mjs';

const GIT_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 180_000;

// Where the head is parked between `fetch` and `worktree add`. Per session, so
// two launches cannot collide, and deleted immediately afterwards — the
// worktree's own branch is what keeps the objects alive from then on.
function stagingRef(sessionId) {
  return `refs/bridge-session/${sessionId}`;
}

// `repoRoot` is really "whatever directory to run in" — the worktree review
// passes a session's own worktree, which is a git directory in its own right.
function git(repoRoot, args, timeoutMs = GIT_TIMEOUT_MS, env) {
  return run('git', ['-C', repoRoot, ...args], env ? { timeoutMs, env } : { timeoutMs });
}

/**
 * Fetch the target's head into this session's staging ref and resolve it.
 *
 * Split out of createReviewWorktree because a re-review needs this and nothing
 * else, and because the refspec is the one piece of knowledge here that must
 * not be written down twice: a second copy that fetched `refs/heads/<branch>`
 * for a pull request would work on every PR from this repo and fail on every
 * fork's, which is the kind of bug that ships.
 *
 * The staging ref is LEFT IN PLACE on success. What keeps the fetched objects
 * alive from here on is the caller's next step — a `worktree add` on a new
 * branch, or a `reset --hard` of one — so only the caller knows when it is safe
 * to drop, and every caller must drop it. Failure exits clean up after
 * themselves.
 *
 * @param {{repoRoot: string, sessionId: string, target: object, baseRef: string}} params
 * @returns {Promise<{ok: true, headSha: string, ref: string, baseFetched: boolean}
 *                 | {ok: false, status: number, error: string, stderr?: string}>}
 */
export async function fetchTargetHead({ repoRoot, sessionId, target, baseRef }) {
  const ref = stagingRef(sessionId);
  // refs/pull/<n>/head is what GitHub publishes for every pull request,
  // including ones from forks — which is why this needs to know nothing about
  // the contributor's remote.
  const headSpec = target.kind === 'pr'
    ? `+refs/pull/${target.pr}/head:${ref}`
    : `+refs/heads/${target.branch}:${ref}`;
  // The base is only needed to compute a branch's diff, so a failure to fetch
  // it must not fail the launch. Asked for in the same round trip when it can
  // be, and retried alone when the combined fetch fails for either reason.
  const baseSpec = baseRef ? `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}` : null;

  const specs = baseSpec ? [headSpec, baseSpec] : [headSpec];
  let baseFetched = !!baseSpec;
  let fetched = await git(repoRoot, ['fetch', '--no-tags', '--force', 'origin', ...specs], FETCH_TIMEOUT_MS);
  if (fetched.status !== 0 && baseSpec) {
    baseFetched = false;
    fetched = await git(repoRoot, ['fetch', '--no-tags', '--force', 'origin', headSpec], FETCH_TIMEOUT_MS);
  }
  if (fetched.status !== 0) {
    return {
      ok: false,
      status: 502,
      error: target.kind === 'pr'
        ? `could not fetch refs/pull/${target.pr}/head — is that pull request visible to this box?`
        : `could not fetch branch "${target.branch}" from origin — does it exist?`,
      stderr: (fetched.stderr || '').trim().slice(0, 400),
    };
  }

  const resolved = await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const headSha = (resolved.stdout || '').trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
    await deleteRef(repoRoot, ref);
    return { ok: false, status: 502, error: 'the fetched ref did not resolve to a commit' };
  }

  return { ok: true, headSha, ref, baseFetched };
}

/**
 * Drop the staging ref once the objects are held by something else.
 *
 * Exported because fetchTargetHead's contract is that its caller does this, and
 * the re-review path is a caller that lives in another module.
 */
export function dropStagingRef({ repoRoot, sessionId }) {
  return deleteRef(repoRoot, stagingRef(sessionId));
}

/**
 * Fetch the target and check it out as a session worktree.
 *
 * `onPrBranch` says `branchName` is the pull request's own branch on origin
 * (see prBranchFor) rather than a private review/* branch. `ownsBranch` in the
 * answer says whether this call created the branch, which is what decides
 * whether Kill may ever delete it.
 *
 * @param {{repoRoot: string, sessionId: string, target: object, baseRef: string,
 *          worktreePath: string, branchName: string, onPrBranch?: boolean}} params
 * @returns {Promise<{ok: true, headSha: string, baseFetched: boolean, ownsBranch: boolean}
 *                 | {ok: false, status: number, error: string, stderr?: string}>}
 */
export async function createReviewWorktree({
  repoRoot, sessionId, target, baseRef, worktreePath, branchName, onPrBranch = false,
}) {
  const fetched = await fetchTargetHead({ repoRoot, sessionId, target, baseRef });
  if (!fetched.ok) return fetched;
  const { ref, headSha, baseFetched } = fetched;

  try {
    // A leftover directory that git does not know about makes `worktree add`
    // fail with "already exists". A fresh 8-hex session id makes this all but
    // impossible; it costs one statSync to not care.
    if (fs.existsSync(worktreePath)) {
      return { ok: false, status: 500, error: `${worktreePath} already exists` };
    }

    let ownsBranch = true;
    let addArgs = ['worktree', 'add', '-b', branchName, worktreePath, ref];
    if (onPrBranch) {
      const prepared = await preparePrBranch({ repoRoot, branchName, headSha });
      if (!prepared.ok) return prepared;
      ownsBranch = !prepared.existed;
      if (prepared.existed) addArgs = ['worktree', 'add', worktreePath, branchName];
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const added = await git(repoRoot, addArgs);
    if (added.status !== 0) {
      return {
        ok: false,
        status: 500,
        error: 'git worktree add failed',
        stderr: (added.stderr || '').trim().slice(0, 400),
      };
    }
    if (onPrBranch) await trackOrigin({ repoRoot, branchName });
    return { ok: true, headSha, baseFetched, ownsBranch };
  } finally {
    // Whatever happened, the staging ref has done its job: on success the
    // branch holds the objects, and on failure nothing should hold them.
    await deleteRef(repoRoot, ref);
  }
}

/**
 * Whether the pull request's branch can be checked out here, and whether it
 * already exists locally.
 *
 * Two refusals, both instead of a fallback to a private branch. A second
 * checkout of the same pull request would split one piece of work across two
 * places to push from, and the person is better served by being sent to the
 * session that already has it.
 *
 *  - The branch is checked out in another worktree. git would refuse anyway;
 *    this names where, so the message can say which session to open.
 *  - A local branch of that name has commits the pull request does not. Moving
 *    it to the pull request head would drop them, and they may exist nowhere
 *    else.
 *
 * A local branch that is behind the pull request, or at it, is fast-forwarded
 * to the head and reused. It predates this review, so Kill never deletes it.
 *
 * @returns {Promise<{ok: true, existed: boolean} | {ok: false, status: number, error: string}>}
 */
async function preparePrBranch({ repoRoot, branchName, headSha }) {
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain'], 30_000);
  if (listed.status !== 0) {
    return { ok: false, status: 500, error: 'could not list this repository’s worktrees' };
  }
  const holder = worktreeHoldingBranch({ porcelain: listed.stdout, branchName });
  if (holder) {
    return {
      ok: false,
      status: 409,
      error: `${branchName} is already checked out in ${describeHolder(holder)} — `
        + 'open that session to work on this pull request',
    };
  }

  const local = `refs/heads/${branchName}`;
  const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', local], 30_000);
  if (exists.status !== 0) return { ok: true, existed: false };

  const behind = await git(repoRoot, ['merge-base', '--is-ancestor', local, headSha], 30_000);
  if (behind.status !== 0) {
    return {
      ok: false,
      status: 409,
      error: `the local branch ${branchName} has commits the pull request does not — `
        + 'push or delete them before reviewing it here',
    };
  }
  const moved = await git(repoRoot, ['update-ref', local, headSha], 30_000);
  if (moved.status !== 0) return { ok: false, status: 500, error: `could not move ${branchName} to the pull request head` };
  return { ok: true, existed: true };
}

/**
 * The worktree that has `branchName` checked out, from `git worktree list
 * --porcelain`. Pure so the parsing can be tested against recorded output.
 *
 * @returns {string|null} that worktree's path
 */
export function worktreeHoldingBranch({ porcelain, branchName }) {
  let current = null;
  for (const line of String(porcelain || '').split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branchName}`) return current;
  }
  return null;
}

function describeHolder(worktreePath) {
  const slug = /\/\.claude\/worktrees\/bridge-([0-9a-f]{8})$/.exec(worktreePath);
  return slug ? `session claude-${slug[1]}` : worktreePath;
}

/**
 * Point the branch at origin's branch of the same name, so `git push` and `git
 * status` in the session talk about the pull request.
 *
 * Best effort. The config is what makes `git push` work, and it cannot fail in
 * any way worth refusing a review over; the fetch only gives `git status` its
 * ahead/behind count and gives Kill a record of what is already pushed.
 */
async function trackOrigin({ repoRoot, branchName }) {
  await git(repoRoot, ['config', `branch.${branchName}.remote`, 'origin'], 30_000);
  await git(repoRoot, ['config', `branch.${branchName}.merge`, `refs/heads/${branchName}`], 30_000);
  await git(
    repoRoot,
    ['fetch', '--no-tags', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
    FETCH_TIMEOUT_MS,
  );
}

/**
 * Drop one worktree's administrative entry, the way `git worktree prune` would
 * for all of them.
 *
 * Scoped to a single entry on purpose. This box carries thirty-odd live session
 * worktrees and a blanket prune is a footgun aimed at every one of them whose
 * directory happens to be missing at the moment it runs.
 *
 * The entry is matched by the path recorded in its own `gitdir` file rather
 * than by basename, because git disambiguates colliding basenames by appending
 * a number and the wrong guess deregisters somebody else's worktree.
 */
async function deregisterWorktree(repoRoot, worktreePath) {
  const dir = await git(repoRoot, ['rev-parse', '--absolute-git-dir'], 30_000);
  const adminRoot = path.join((dir.stdout || '').trim(), 'worktrees');
  if (!dir.stdout || !fs.existsSync(adminRoot)) return;
  const want = path.resolve(worktreePath);
  for (const name of fs.readdirSync(adminRoot)) {
    const entry = path.join(adminRoot, name);
    let recorded = '';
    try {
      recorded = fs.readFileSync(path.join(entry, 'gitdir'), 'utf-8').trim();
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      continue;
    }
    // The file holds <worktree>/.git, so the worktree is its parent.
    if (path.dirname(path.resolve(recorded)) !== want) continue;
    fs.rmSync(entry, { recursive: true, force: true });
    return;
  }
}

function deleteRef(repoRoot, ref) {
  return git(repoRoot, ['update-ref', '-d', ref], 30_000);
}

/**
 * Undo createReviewWorktree.
 *
 * `removeWorktree` is server.mjs's and is injected rather than re-implemented:
 * it passes `--force` twice, the second overriding the worktree LOCK that
 * claude leaves behind, and a second copy of that would not know why.
 *
 * The branch goes with the worktree, which is a departure from Kill's usual
 * "commits are kept" contract and is deliberate. `git worktree remove` leaves a branch behind, and
 * a `review/*` branch left behind pins the whole of the pull request head's
 * objects with nothing left to collect it: the TTL/LRU garbage collector that
 * used to do that job no longer exists, because a review's lifetime is now its
 * session's.
 *
 * A review that sits on the pull request's own branch is the exception: see
 * the branch handling below, and `ownsBranch` / `reviewedSha` from the record.
 *
 * @returns {Promise<{worktreeRemoved: boolean, branchRemoved: boolean, branchKept: boolean,
 *                    keptUnpushed: boolean}>}
 */
export async function removeReviewWorktree({
  repoRoot, worktreePath, branchName, ownsBranch, reviewedSha, removeWorktree,
}) {
  // Both flags answer "is it gone", not "did my command succeed". The caller
  // decides whether to keep the state that names this branch on the strength of
  // them, and an already-removed worktree exits git non-zero exactly like a
  // removal that failed — reading those as the same thing would strand the
  // state forever on the commonest retry there is.
  let stderr = '';
  if (worktreePath && fs.existsSync(worktreePath)) {
    const attempt = await removeWorktree(worktreePath);
    stderr = attempt.ok ? '' : (attempt.stderr || '');
    // git declining — an unregistered leftover, typically — must not leave
    // 130 MB that nothing will ever reclaim.
    if (!attempt.ok && fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (err) {
        if (err.code !== 'ENOENT') stderr = stderr || err.message;
      }
      // Taking the directory away is not the same as telling git it is gone,
      // and the difference is not cosmetic: git refuses to delete a branch
      // "used by worktree" on the strength of the registration alone, so
      // without this the branch could never be removed on this path — not on
      // a retry either, since the registration is what outlives everything.
      //
      // Only once the directory really has gone, though. Deregistering one
      // that is still there frees the branch to be deleted and lets the whole
      // removal report success, which drops the state that is the only record
      // that 130 MB is still sitting on the disk.
      if (!fs.existsSync(worktreePath)) await deregisterWorktree(repoRoot, worktreePath);
    }
  }
  const worktreeRemoved = !worktreePath || !fs.existsSync(worktreePath);

  // Only ever the exact branch this review created. Deriving a name to delete
  // from anything less specific than recorded state is how a tool deletes
  // somebody's work.
  let branchRemoved = false;
  // Deliberately left in place, which settles the branch as fully as deleting
  // it does: the caller must not keep state around for a retry that has
  // nothing to do.
  let branchKept = false;
  let keptUnpushed = false;
  if (branchName && /^review\/[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(branchName)) {
    const deleted = await deleteBranch(repoRoot, branchName);
    branchRemoved = deleted.removed;
    stderr = stderr || deleted.stderr;
  } else if (branchName && ownsBranch === true) {
    // The pull request's own branch, created by this review. It goes only when
    // nothing on it would be lost; a commit made in the session and not yet
    // pushed keeps it, because the branch is then the only copy.
    const pushed = await everythingPushed({ repoRoot, branchName, reviewedSha });
    if (pushed === null) {
      branchRemoved = true;
    } else if (pushed) {
      const deleted = await deleteBranch(repoRoot, branchName);
      branchRemoved = deleted.removed;
      stderr = stderr || deleted.stderr;
    } else {
      branchKept = true;
      keptUnpushed = true;
    }
  } else if (branchName) {
    // The pull request's branch existed before this review, so it was never
    // the review's to delete.
    branchKept = true;
  }

  // Which half failed, in the caller's words rather than left to be inferred
  // from two booleans. A worktree that went and a branch that did not was
  // reported as "git worktree remove failed", about a worktree that is gone.
  let failed = null;
  if (!worktreeRemoved) failed = 'git worktree remove failed';
  else if (!branchRemoved && !branchKept) failed = `the worktree is gone but its branch ${branchName} could not be deleted`;

  return { worktreeRemoved, branchRemoved, branchKept, keptUnpushed, stderr, failed };
}

async function deleteBranch(repoRoot, branchName) {
  const deleted = await git(repoRoot, ['branch', '-D', branchName], 30_000);
  if (deleted.status === 0) return { removed: true, stderr: '' };
  // `git branch -D` also exits non-zero for a branch that is already gone,
  // which is what a retry after a partial failure sees. Ask, rather than
  // infer, before reporting the branch as left behind. It also refuses a
  // branch still checked out, so this stays false while the worktree does —
  // the two failures arrive together, and the retry needs both.
  const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], 30_000);
  if (exists.status !== 0) return { removed: true, stderr: '' };
  // git's complaint is the only account of why, and the caller's 500 has been
  // carrying an empty string in its place.
  return { removed: false, stderr: (deleted.stderr || '').trim() };
}

/**
 * Whether every commit on a review-created pull request branch exists
 * somewhere other than that branch. Null when the branch is already gone.
 *
 * Two places count: the head the review last took from GitHub, and the
 * remote-tracking copy of the branch, which a `git push` from the session
 * updates. A stale remote-tracking ref can only make this answer false, which
 * keeps a branch that could have gone. That is the safe direction.
 */
async function everythingPushed({ repoRoot, branchName, reviewedSha }) {
  const local = `refs/heads/${branchName}`;
  const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', local], 30_000);
  if (exists.status !== 0) return null;
  const candidates = [reviewedSha, `refs/remotes/origin/${branchName}`].filter(Boolean);
  for (const other of candidates) {
    const within = await git(repoRoot, ['merge-base', '--is-ancestor', local, other], 30_000);
    if (within.status === 0) return true;
  }
  return false;
}

/**
 * The repo's default branch, as shared/defaultBranch.mjs tells it: a session's
 * DEFAULT_BRANCH (asked of the remote at its start, so it follows a rename the
 * clone's origin/HEAD missed), else origin/HEAD, else whichever of main and
 * master origin has. Used as the base for a branch target, where there is no
 * pull request to name one. `master`, git's old default, only when none answers.
 */
export async function defaultBranch(repoRoot, env = process.env) {
  const name = defaultBranchOf(repoRoot, env);
  if (name && /^[A-Za-z0-9._/-]+$/.test(name)) return name;
  return 'master';
}

/**
 * The unified diff for a branch target: what the branch adds on top of where it
 * forked from, which is what a pull request would show.
 *
 * Three dots, not two: `git diff base...head` diffs the merge base against the
 * head, so commits landing on the base after the branch forked do not turn up
 * as reversed changes in someone's review.
 */
export async function branchDiff({ repoRoot, baseRef, headSha }) {
  const result = await git(
    repoRoot,
    ['diff', '--no-color', '--find-renames', `refs/remotes/origin/${baseRef}...${headSha}`],
    GIT_TIMEOUT_MS,
  );
  if (result.status !== 0) {
    return {
      ok: false,
      status: 500,
      error: `could not diff the branch against ${baseRef}`,
      stderr: (result.stderr || '').trim().slice(0, 400),
    };
  }
  return { ok: true, patch: result.stdout || '' };
}

/** The commit subject of the head, used as a branch review's title. */
export async function commitSubject({ repoRoot, headSha }) {
  const result = await git(repoRoot, ['log', '-1', '--format=%s', headSha], 30_000);
  return result.status === 0 ? (result.stdout || '').trim().slice(0, 300) : '';
}

// --- moving a review worktree to a new head ----------------------------------

/**
 * Whether a review worktree may be moved onto a new head, and why not.
 *
 * Pure, and separate from the git that carries it out, because the whole risk
 * of re-reviewing a pull request is concentrated here: the move is a
 * `git reset --hard`, and running one on a tree that has anything of its own in
 * it destroys work that exists nowhere else. Every refusal below is a case
 * where someone would have lost something.
 *
 * The three answers:
 *
 *  - `none` — the tree is already at the head being reviewed. This is the case
 *    after a session pushes its own fixes to the pull request: the branch moved
 *    on origin and the worktree moved with it, so there is nothing to do but
 *    take the diff again. Reached whether or not the tree is dirty, because a
 *    live tree is the normal state of a review session and the reviewed commit
 *    is what the diff is of.
 *  - `move` — the tree is clean and sits exactly on the commit the record says
 *    was reviewed, so nothing has happened in it that a reset would take away.
 *  - `refuse` — anything else, including "could not tell". `dirtyFiles` is null
 *    when `git status` itself failed, and an unreadable tree must read as a
 *    tree with something in it.
 *
 * @param {{currentSha: string, recordedSha: string, targetSha: string,
 *          dirtyFiles: number|null}} params
 * @returns {{action: 'none'|'move'|'refuse', reason?: string}}
 */
export function planWorktreeMove({ currentSha, recordedSha, targetSha, dirtyFiles }) {
  if (!/^[0-9a-f]{40}$/.test(String(targetSha || ''))) {
    return { action: 'refuse', reason: 'the new head did not resolve to a commit' };
  }
  if (currentSha === targetSha) return { action: 'none' };
  if (dirtyFiles === null || dirtyFiles === undefined) {
    return { action: 'refuse', reason: 'could not tell whether this worktree has uncommitted changes' };
  }
  if (dirtyFiles > 0) {
    return {
      action: 'refuse',
      reason: `this worktree has ${dirtyFiles} uncommitted file${dirtyFiles === 1 ? '' : 's'} — `
        + `moving it to the new head would throw ${dirtyFiles === 1 ? 'it' : 'them'} away. `
        + `Commit or discard ${dirtyFiles === 1 ? 'it' : 'them'} first`,
    };
  }
  if (currentSha !== recordedSha) {
    return {
      action: 'refuse',
      reason: `this worktree is at ${short(currentSha)}, which is neither the commit that was `
        + `reviewed (${short(recordedSha)}) nor the new head (${short(targetSha)}) — `
        + 'it has commits of its own, so moving it would throw them away',
    };
  }
  return { action: 'move' };
}

function short(sha) {
  return String(sha || 'unknown').slice(0, 8);
}

/**
 * Put a review worktree onto a new head, if it is safe to.
 *
 * A review of a pull request is read IN the worktree — the analysis and every
 * "ask about this line" run with it as their cwd — so refreshing the diff
 * without moving the tree would have the model reading one commit and the page
 * showing another. That is why this exists and why it is not optional.
 *
 * `reset --hard` rather than `checkout`: the worktree's branch (the pull
 * request's own, or a private `review/<stem>-<id>`) is what holds the objects
 * and what Kill reads by name, and it has to keep both jobs. Untracked and ignored
 * files are left alone, which is what keeps the 2 GB of hardlinked
 * node_modules and the env files the hook writes in place.
 *
 * @param {{worktreePath: string, recordedSha: string, targetSha: string}} params
 * @returns {Promise<{ok: true, moved: boolean} | {ok: false, status: number, error: string, stderr?: string}>}
 */
export async function moveReviewWorktree({ worktreePath, recordedSha, targetSha }) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { ok: false, status: 409, error: 'this session no longer has a worktree' };
  }

  const resolved = await git(worktreePath, ['rev-parse', 'HEAD'], 30_000);
  const currentSha = (resolved.stdout || '').trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(currentSha)) {
    return { ok: false, status: 500, error: 'could not resolve this worktree’s HEAD' };
  }
  const dirty = await git(worktreePath, ['status', '--porcelain'], 30_000);
  const dirtyFiles = dirty.status === 0
    ? (dirty.stdout || '').split('\n').filter(Boolean).length
    : null;

  const plan = planWorktreeMove({ currentSha, recordedSha, targetSha, dirtyFiles });
  if (plan.action === 'refuse') return { ok: false, status: 409, error: plan.reason };
  if (plan.action === 'none') return { ok: true, moved: false };

  const reset = await git(worktreePath, ['reset', '--hard', targetSha]);
  if (reset.status !== 0) {
    return {
      ok: false,
      status: 500,
      error: 'could not move this worktree to the new head',
      stderr: (reset.stderr || '').trim().slice(0, 400),
    };
  }
  return { ok: true, moved: true };
}

/**
 * Every `refs/bridge-review/<n>` left in the repo by the previous design.
 *
 * A ref is a few bytes, but it pins the entire pull request head, and the
 * garbage collector that used to remove these is gone. This is the input to
 * the one-shot boot migration.
 */
export async function legacyReviewRefs(repoRoot) {
  const result = await git(
    repoRoot,
    ['for-each-ref', '--format=%(refname)', 'refs/bridge-review/'],
    30_000,
  );
  if (result.status !== 0) return [];
  return (result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^refs\/bridge-review\/\d+$/.test(line));
}

/** Delete one legacy ref. Separate so the migration can log each one. */
export async function deleteLegacyRef({ repoRoot, ref }) {
  if (!/^refs\/bridge-review\/\d+$/.test(ref)) return false;
  const result = await git(repoRoot, ['update-ref', '-d', ref], 30_000);
  return result.status === 0;
}

// --- reviewing a session's own worktree --------------------------------------

// `git add -A` of a tree this size is a few seconds, and it has to stat every
// path git does not already know about.
const INDEX_TIMEOUT_MS = 120_000;

/**
 * The work in a session's own worktree, as a diff against its merge base with
 * `baseRef`.
 *
 * Not the same question as branchDiff's, and the difference is the whole point
 * of this path: a session that is mid-feature has uncommitted edits and
 * untracked new files, and a commit-to-commit diff shows neither. What a
 * reviewer wants to see is the tree as it stands.
 *
 * The mechanism is a throwaway index. `read-tree HEAD` then `add -A` into a
 * GIT_INDEX_FILE of our own gives one ordinary unified diff covering commits,
 * staged and unstaged edits, deletions and untracked files together, with
 * .gitignore honoured so the 2 GB of hardlinked node_modules stays out. The
 * session's real index is never touched, which matters because someone is
 * working in this tree right now and a review must not stage their files.
 *
 * Against the merge base rather than the tip of `baseRef`, so that commits
 * landing on the default branch while the session works do not show up as the session's
 * own changes reversed.
 *
 * @param {{repoRoot: string, worktreePath: string, baseRef: string, indexFile: string}} params
 * @returns {Promise<{ok: true, patch: string, baseSha: string, headSha: string, baseFetched: boolean}
 *                 | {ok: false, status: number, error: string, stderr?: string}>}
 */
export async function worktreeDiff({ repoRoot, worktreePath, baseRef, indexFile }) {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, status: 409, error: 'this session no longer has a worktree' };
  }

  // Best effort, exactly as createReviewWorktree treats it: a box that cannot
  // reach origin can still review against the base it already knows, and
  // saying so is better than refusing.
  const fetched = await git(
    repoRoot,
    ['fetch', '--no-tags', '--force', 'origin', `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
    FETCH_TIMEOUT_MS,
  );
  const baseFetched = fetched.status === 0;

  const merged = await git(worktreePath, ['merge-base', `refs/remotes/origin/${baseRef}`, 'HEAD'], 30_000);
  const baseSha = (merged.stdout || '').trim();
  if (merged.status !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
    return {
      ok: false,
      status: 409,
      error: `this worktree has no common history with ${baseRef}`,
      stderr: (merged.stderr || '').trim().slice(0, 400),
    };
  }

  const resolved = await git(worktreePath, ['rev-parse', 'HEAD'], 30_000);
  const headSha = (resolved.stdout || '').trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
    return { ok: false, status: 500, error: 'could not resolve this worktree’s HEAD' };
  }

  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const read = await git(worktreePath, ['read-tree', 'HEAD'], INDEX_TIMEOUT_MS, env);
    if (read.status !== 0) {
      return {
        ok: false,
        status: 500,
        error: 'could not build a scratch index for this worktree',
        stderr: (read.stderr || '').trim().slice(0, 400),
      };
    }
    // `.` rather than `-A` alone: both are repository-wide from the top level,
    // but the explicit pathspec keeps this honest if the cwd ever changes.
    const staged = await git(worktreePath, ['add', '-A', '.'], INDEX_TIMEOUT_MS, env);
    if (staged.status !== 0) {
      return {
        ok: false,
        status: 500,
        error: 'could not read this worktree’s working tree',
        stderr: (staged.stderr || '').trim().slice(0, 400),
      };
    }
    const diffed = await git(
      worktreePath,
      ['diff', '--cached', '--no-color', '--find-renames', baseSha],
      INDEX_TIMEOUT_MS,
      env,
    );
    if (diffed.status !== 0) {
      return {
        ok: false,
        status: 500,
        error: 'git diff failed for this worktree',
        stderr: (diffed.stderr || '').trim().slice(0, 400),
      };
    }
    return { ok: true, patch: diffed.stdout || '', baseSha, headSha, baseFetched };
  } finally {
    // The scratch index is ours alone and is worthless the moment the diff is
    // taken. Leaving it would cost a few MB per review on a box that runs
    // dozens.
    try {
      fs.rmSync(indexFile, { force: true });
    } catch {
      // Nothing useful to do about it, and the diff already succeeded.
    }
  }
}

/**
 * Bring a session's own checkout up to what origin has on its branch, before a Re-review reads it.
 *
 * A session's branch also moves on GitHub: a push from another session, a laptop, or a suggestion committed on the
 * pull request. A Re-review that only re-read the tree would read the old code again and say nothing about it.
 *
 * Only ever a fast-forward. This is somebody's working tree, so anything else is theirs to decide: a branch that has
 * moved both here and there, or a pull git refuses because it would overwrite an uncommitted file, is left as it was
 * and the reason handed back for the page to say. No branch, or none on origin yet, is nothing to pull and says
 * nothing: the review is of the tree, as before.
 *
 * @param {{worktreePath: string}} params
 * @returns {Promise<{pulled: number, from?: string, to?: string, branch?: string, refused?: string}>}
 */
export async function pullWorktreeBranch({ worktreePath }) {
  const named = await git(worktreePath, ['symbolic-ref', '--short', '-q', 'HEAD'], 30_000);
  const branch = named.status === 0 ? (named.stdout || '').trim() : '';
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) return { pulled: 0 };
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetched = await git(
    worktreePath,
    ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteRef}`],
    FETCH_TIMEOUT_MS,
  );
  if (fetched.status !== 0) {
    // Most often a branch never pushed. A fetch that failed for another reason is said, since the review then reads
    // a tree that may be behind.
    const stderr = (fetched.stderr || '').trim();
    if (/couldn't find remote ref|could not find remote ref/i.test(stderr)) return { pulled: 0, branch };
    return { pulled: 0, branch, refused: `origin could not be reached (${firstLine(stderr) || 'git fetch failed'})` };
  }
  const head = (await git(worktreePath, ['rev-parse', 'HEAD'], 30_000)).stdout?.trim() || '';
  const remote = (await git(worktreePath, ['rev-parse', '--verify', '--quiet', remoteRef], 30_000)).stdout?.trim() || '';
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(remote)) return { pulled: 0, branch };
  if (head === remote) return { pulled: 0, branch };
  // origin is behind or equal: the session has commits it has not pushed, which is not a reason to touch anything.
  const remoteWithin = await git(worktreePath, ['merge-base', '--is-ancestor', remote, head], 30_000);
  if (remoteWithin.status === 0) return { pulled: 0, branch };
  const headWithin = await git(worktreePath, ['merge-base', '--is-ancestor', head, remote], 30_000);
  if (headWithin.status !== 0) {
    const ours = await git(worktreePath, ['rev-list', '--count', `${remote}..${head}`], 30_000);
    const theirs = await git(worktreePath, ['rev-list', '--count', `${head}..${remote}`], 30_000);
    const here = (ours.stdout || '?').trim();
    return {
      pulled: 0,
      branch,
      refused: `this checkout and origin/${branch} have both moved (${here} commit${here === '1' ? '' : 's'} here, `
        + `${(theirs.stdout || '?').trim()} there): pull or rebase it in the session`,
    };
  }
  const counted = await git(worktreePath, ['rev-list', '--count', `${head}..${remote}`], 30_000);
  const merged = await git(worktreePath, ['merge', '--ff-only', '--quiet', remote]);
  if (merged.status !== 0) {
    return {
      pulled: 0,
      branch,
      refused: `git would not fast-forward to origin/${branch} (${firstLine((merged.stderr || '').trim()) || 'merge failed'})`,
    };
  }
  return { pulled: Number((counted.stdout || '').trim()) || 1, branch, from: head, to: remote };
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim())?.replace(/^(error|fatal):\s*/i, '').trim().slice(0, 200) || '';
}

/** One-line summary of where a worktree stands, for the review header. */
export async function worktreeState({ worktreePath, baseSha }) {
  const dirty = await git(worktreePath, ['status', '--porcelain'], 30_000);
  const dirtyFiles = dirty.status === 0
    ? (dirty.stdout || '').split('\n').filter(Boolean).length
    : null;
  const counted = await git(worktreePath, ['rev-list', '--count', `${baseSha}..HEAD`], 30_000);
  const commits = counted.status === 0 ? Number((counted.stdout || '').trim()) : null;
  // `--abbrev-ref HEAD` answers the literal string "HEAD" on a detached head,
  // which would render as "Work in progress on HEAD". A session part-way
  // through a rebase is the realistic way to land here, so say what is true
  // and give the sha, which is the only identifier there is.
  const named = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], 30_000);
  const raw = named.status === 0 ? (named.stdout || '').trim() : '';
  let branch = raw;
  if (!raw || raw === 'HEAD') {
    // Inside the branch, not above it: the attached case is the common one and
    // would otherwise pay for a spawn whose answer it throws away.
    const short = await git(worktreePath, ['rev-parse', '--short', 'HEAD'], 30_000);
    const sha = short.status === 0 ? (short.stdout || '').trim() : '';
    branch = sha ? `a detached HEAD at ${sha}` : 'a detached HEAD';
  }
  // No separate `detached` flag. It had no reader, and a returned field with no
  // reader is the next person's false lead — `branch` already carries the whole
  // answer, which is the only thing anything here displays.
  return { dirtyFiles, commits: Number.isFinite(commits) ? commits : null, branch };
}
