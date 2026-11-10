// Public surface of the review feature. server.mjs imports exactly what is
// exported here and nothing from any other module in this directory.
//
// Shape of the feature, since it changed: a review is not a thing with its own
// lifecycle any more. It is an aspect of a SESSION. `/run` creates the session's
// worktree at a pull request's head instead of off the default branch, records what it is
// reviewing, and kicks off the analysis; from then on the review lives and dies
// with the session, and `/review?session=claude-<8hex>` renders it.
//
// Route conventions are server.mjs's, deliberately: regex-matched paths, the
// json(res, status, body) helper, log('namespace.event', {...}), 400 for bad
// input, 404 for an unknown id, 409 for the wrong state, 429/503 for pressure,
// and {ok: false, error} on every failure.
//
// Dependencies that live in server.mjs (repoRoot, removeWorktree, readProcTable,
// readMeminfo, json, log) are passed in as `ctx` rather than imported, because
// server.mjs imports this module — the reverse import would be a cycle. It also
// keeps removeWorktree's hard-won double-`--force` as the single copy.

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { parseUnifiedDiff } from './diff.mjs';
import {
  originSlug, fetchPrMeta, fetchPrDiff, submitPrReview, fetchViewedFiles, setFileViewed, ghAccount,
  setPrTitle, fetchReviewState, addPendingComment, deletePendingComment, discardPendingReview,
  submitPendingReview, postLineComment, deletePostedComment, deleteIssueComment, hideComment,
} from './github.mjs';
import { parseTarget, prBranchFor, reviewBranchFor, describeTarget } from './target.mjs';
import {
  createReviewWorktree, removeReviewWorktree, defaultBranch, branchDiff, commitSubject,
  legacyReviewRefs, deleteLegacyRef, worktreeDiff, worktreeState,
  fetchTargetHead, dropStagingRef, moveReviewWorktree,
} from './worktree.mjs';
import { REVIEW_HTML } from './page.mjs';
import {
  readDiff, writeDiff, readArtifact, writeArtifact,
  writeSessionReview, readSessionReview, hasSessionReview, listReviewSessions,
  removeReviewState, hasJobBreadcrumb, answerKey, isSessionName, legacyStatePaths,
  removeArtifact, readChat, appendChat, discardReviewWork,
} from './store.mjs';
import {
  startJob, findJob, sweepOrphans, cancelJobsForSession, availableBytes, MIN_AVAILABLE_BYTES,
} from './jobs.mjs';
import {
  analysisArgv, buildAnalysisPrompt, onAnalysisLine, extractArtifact, reconcileArtifact,
} from './analyze.mjs';
import {
  validateExplainRequest, explainArgv, buildExplainPrompt, extractAnswer,
} from './explain.mjs';
import { validateChatRequest, buildChatPrompt } from './chat.mjs';
import { enqueuePr, fetchMergeReadiness, mergeBlocker, mergePr } from './merge.mjs';
import { pullRequestsFor, schedulePrRefresh } from '../prStatus.mjs';

// Set by install.sh's throwaway verify instance, which boots the server purely
// to check that the pages parse and must never spawn a model or touch a repo.
const DISABLED = process.env.WOODSHED_REVIEW_DISABLED === '1';

/**
 * Whether the dollar figures on the artifact mean anything.
 *
 * This box authenticates with an OAuth Max subscription, where `total_cost_usd`
 * from the harness is a notional API-rate valuation and not a charge. Showing
 * "$0.081" to someone on a subscription implies a bill that does not exist, so
 * the page hides it — but the figure is still captured and still logged, where
 * it is exactly what you want when diagnosing an expensive run.
 *
 * Read once: an environment variable does not change under a running process.
 */
const SHOW_COSTS = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const MAX_INFLIGHT_REQUESTS = 4;

// Admission control for creating a worktree. `git worktree add` of this repo
// writes ~130 MB and the SessionStart hook hardlinks ~2 GB of node_modules on
// top; N simultaneous launches buy N of each. This is the replacement for the
// old MAX_INFLIGHT_CHECKOUTS gate, moved to where creation now happens.
const MAX_INFLIGHT_CHECKOUTS = 2;

let inflightRequests = 0;
let inflightCheckouts = 0;

function delay(ms) {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Run a handler holding one admission slot, or 503. Only the routes that can
 * reach a `claude` spawn need it; everything else here reads files this process
 * already wrote.
 */
async function gated(res, ctx, route, handler) {
  const busy = tooBusy(ctx);
  if (busy) {
    ctx.log('review.busy', { reqId: ctx.reqId, route, inflight: inflightRequests });
    return ctx.json(res, 503, { ok: false, error: busy });
  }
  inflightRequests += 1;
  try {
    return await handler();
  } finally {
    inflightRequests -= 1;
  }
}

function tooBusy(ctx) {
  if (inflightRequests >= MAX_INFLIGHT_REQUESTS) {
    return 'too many reviews in flight — try again in a moment';
  }
  if (availableBytes(ctx.readMeminfo) < MIN_AVAILABLE_BYTES) {
    return 'the box is low on memory — try again once a session or app frees some';
  }
  return null;
}

/** session -> {status, error, review, gen}. Mirrors what is on disk. */
const reviewState = new Map();

/**
 * Identity of an analysis run, so a run that is unwinding cannot write over a
 * newer one's state.
 *
 * It is a number in the state object rather than the object's own identity,
 * which is what this was first written as — and that was wrong in a way only
 * fault injection found: the run's own progress updates (`waiting`, a retry
 * reason) build a NEW state object, so the very next identity check compared
 * the run against something it had itself replaced, decided the session had
 * gone, and abandoned the analysis silently. Simulated memory pressure made it
 * reproducible: the analysis deferred once and then never came back.
 *
 * Every write to reviewState from inside a run therefore carries `gen`, and
 * every check compares `gen` rather than the object.
 */
let analysisGen = 0;

function claimIsLive(session, gen) {
  return reviewState.get(session)?.gen === gen;
}
/** session -> the live analysis job, for the progress strip. */
const progressBySession = new Map();
/** askId -> job, for the duration of the run only. */
const explainJobs = new Map();
const EXPLAIN_JOB_TTL_MS = 2 * 60_000;
/** session -> the chat turn in flight. One at a time: a turn replays the
 *  transcript, so two at once would each answer without the other. */
const chatJobs = new Map();

// --- what server.mjs calls at launch ----------------------------------------

/**
 * Parse the launch form's "PR or branch" field.
 *
 * Exported so /run can reject bad input with a 400 before it has generated a
 * session id or touched anything.
 */
export function parseReviewTarget(raw) {
  const parsed = parseTarget(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, target: parsed };
}

/** True when this session has a review to show. Drives the Review link. */
export function hasReviewFor(session) {
  if (DISABLED) return false;
  return hasSessionReview(session);
}

/**
 * Whether killing this session takes its branch with it: 'always' for a
 * private review/* branch, 'ifPushed' for a pull request branch this review
 * created (see removeReviewWorktree), and false otherwise.
 *
 * Distinct from hasReviewFor, and the distinction is the whole point: Kill's
 * confirmation copy has to say whether commits survive, and "a review exists"
 * stopped being the same question as "the review owns the branch" the moment a
 * session could review its own worktree. Branching the copy on the wrong one
 * tells someone their work is about to be deleted when it is not — or, if the
 * two ever diverge the other way, the reverse.
 *
 * Absent on records written before ownsWorktree existed, and all of those were
 * bridge-created, so the default has to be owned. Same default as
 * removeReviewSession's, and for the same reason.
 */
export function reviewOwnsBranch(session) {
  if (DISABLED) return false;
  const review = readSessionReview(session);
  if (!review) return false;
  if (review.ownsWorktree === false) return false;
  // Records written before ownsBranch existed were all on review/* branches.
  if (review.ownsBranch === undefined || /^review\//.test(review.reviewBranch || '')) return 'always';
  return review.ownsBranch === true ? 'ifPushed' : false;
}

/**
 * Turn a fresh session id into a review: fetch the target, create the worktree
 * at its head, and record what is being reviewed.
 *
 * Called by /run BEFORE it spawns tmux, because the tmux command line has to
 * `cd` into a worktree that already exists. The caller owns the failure path —
 * if tmux then fails, it must call removeReviewSession to give the 130 MB back.
 *
 * @returns {Promise<{ok: true, review: object} | {ok: false, status: number, error: string, stderr?: string}>}
 */
export async function createReviewSession({ ctx, sessionName, sessionId, target, worktreePath }) {
  const { log, reqId } = ctx;
  if (DISABLED) return { ok: false, status: 503, error: 'the review feature is disabled in this instance' };

  if (inflightCheckouts >= MAX_INFLIGHT_CHECKOUTS) {
    log('review.checkout_busy', { reqId, session: sessionName, inflight: inflightCheckouts });
    return {
      ok: false,
      status: 503,
      error: 'two review worktrees are already being created — try again in a moment',
    };
  }
  if (availableBytes(ctx.readMeminfo) < MIN_AVAILABLE_BYTES) {
    return { ok: false, status: 503, error: 'the box is low on memory — try again once a session or app frees some' };
  }

  inflightCheckouts += 1;
  try {
    return await prepareReview({ ctx, sessionName, sessionId, target, worktreePath });
  } finally {
    inflightCheckouts -= 1;
  }
}

async function prepareReview({ ctx, sessionName, sessionId, target, worktreePath }) {
  const { log, repoRoot, reqId } = ctx;

  const slug = await originSlug(repoRoot);
  if (!slug) return { ok: false, status: 500, error: 'could not determine this box’s GitHub repository' };
  // A pasted URL must name this box's repo. Reviewing another repository would
  // need a clone rather than a worktree, which is a different feature.
  if (target.kind === 'pr' && target.slug && target.slug.toLowerCase() !== slug.toLowerCase()) {
    return { ok: false, status: 400, error: `this shed only reviews pull requests in ${slug}` };
  }

  // Pull request metadata first: it names the base branch, which the fetch
  // wants, and it is the cheapest thing here to fail on.
  let prMeta = null;
  let baseRef;
  if (target.kind === 'pr') {
    const fetched = await fetchPrMeta({ pr: target.pr, slug });
    if (!fetched.ok) return { ok: false, status: fetched.status, error: fetched.error };
    prMeta = fetched.meta;
    baseRef = prMeta.baseRefName;
  } else {
    baseRef = await defaultBranch(repoRoot);
  }

  // The pull request's own branch when it can be, so the session pushes to the
  // pull request and the rail finds it like any other session's. A fork's pull
  // request, or a branch target, gets a private review/* branch instead.
  const prBranch = prBranchFor(prMeta);
  const branchName = prBranch || reviewBranchFor({ target, sessionId });
  const created = await createReviewWorktree({
    repoRoot, sessionId, target, baseRef, worktreePath, branchName, onPrBranch: !!prBranch,
  });
  if (!created.ok) return created;

  // From here on a failure has to give the worktree back, so every exit below
  // goes through undo().
  async function undo(reason) {
    log('review.prepare_failed', { reqId, session: sessionName, reason });
    // State as well as the worktree. Without this a failure between
    // writeSessionReview and here leaves session.json behind, hasReviewFor()
    // answers true for a review that was never created, and nothing collects
    // it — the GC that used to is gone by design.
    removeReviewState(sessionName);
    await removeReviewWorktree({
      repoRoot, worktreePath, branchName, ownsBranch: created.ownsBranch,
      reviewedSha: created.headSha, removeWorktree: ctx.removeWorktree,
    });
  }

  const patch = target.kind === 'pr'
    ? await fetchPrDiff({ pr: target.pr, slug })
    : await branchDiff({ repoRoot, baseRef, headSha: created.headSha });
  if (!patch.ok) {
    await undo(patch.error);
    return { ok: false, status: patch.status, error: patch.error };
  }

  const diff = parseUnifiedDiff(patch.patch);
  const meta = prMeta
    ? publicPrMeta(prMeta, created.headSha)
    : await branchMeta({ repoRoot, target, baseRef, headSha: created.headSha, diff });

  // GitHub's own file count and git's can disagree — rename detection is the
  // usual reason, and `gh pr diff` and `gh pr view` do not always agree with
  // each other either. Not worth failing a review over, absolutely worth
  // knowing about when a file seems to be missing from one.
  if (typeof meta.changedFiles === 'number' && meta.changedFiles !== diff.files.length) {
    log('review.file_count_mismatch', {
      reqId, session: sessionName, fromGithub: meta.changedFiles, fromDiff: diff.files?.length,
    });
  }
  // What the page shows has to be what the page renders, whatever GitHub said.
  meta.changedFiles = diff.files.length;

  const review = {
    session: sessionName,
    kind: target.kind,
    pr: target.kind === 'pr' ? target.pr : null,
    branch: target.kind === 'branch' ? target.branch : null,
    baseRef,
    headSha: created.headSha,
    reviewBranch: branchName,
    // Whether this review created reviewBranch. Only read for a pull request's
    // own branch: a review/* branch is always the review's.
    ownsBranch: created.ownsBranch,
    worktree: worktreePath,
    meta,
    createdAt: new Date().toISOString(),
  };

  try {
    writeSessionReview({ session: sessionName, review });
    writeDiff({ session: sessionName, diff });
  } catch (err) {
    await undo(`could not write review state: ${err?.message}`);
    return { ok: false, status: 500, error: `could not write review state: ${err?.message}` };
  }

  log('review.prepared', {
    reqId,
    session: sessionName,
    target: describeTarget(target),
    headSha: created.headSha.slice(0, 8),
    branch: branchName,
    files: diff.files?.length,
    lines: diff.totalLines,
    truncated: diff.truncated,
    baseFetched: created.baseFetched,
  });
  return { ok: true, review };
}

/**
 * Review the work sitting in a session's own worktree, against the default branch.
 *
 * The other two kinds of review begin by making a worktree; this one begins
 * with one that already exists and belongs to somebody. Three consequences,
 * and they are the whole of why this is a separate path rather than a third
 * branch inside prepareReview:
 *
 *  1. Nothing is created, so nothing is undone on failure. There is no 130 MB
 *     to give back and no review/* branch to delete.
 *  2. The record says `ownsWorktree: false`, and removeReviewSession reads it.
 *     Deleting a session's own worktree and branch because its review went
 *     away would destroy the work being reviewed.
 *  3. It is re-runnable by design. A pull request head is fixed; a session
 *     under active development is not, and a review of it is a snapshot that
 *     goes stale the moment the next edit lands. Calling this again replaces
 *     the diff and re-runs the analysis.
 *
 * @returns {Promise<{ok: true, review: object} | {ok: false, status: number, error: string, stderr?: string}>}
 */
async function createWorktreeReview({ ctx, sessionName, worktreePath }) {
  const { log, repoRoot, reqId } = ctx;
  if (DISABLED) return { ok: false, status: 503, error: 'the review feature is disabled in this instance' };
  if (!isSessionName(sessionName)) return { ok: false, status: 400, error: 'not a session name' };

  // A session launched at a pull request already has a review, and it answers
  // a different question — that one is of a commit that was pushed somewhere,
  // this one is whatever is in the tree now. Replacing it silently would be the
  // wrong kind of helpful; /refresh is how that one is taken again.
  const existing = readSessionReview(sessionName);
  if (existing && existing.kind !== 'worktree') {
    return {
      ok: false,
      status: 409,
      error: `this session is already reviewing ${existing.kind === 'pr' ? `#${existing.pr}` : existing.branch}`,
    };
  }

  const baseRef = await defaultBranch(repoRoot);
  // Unique per call, not per session. Two overlapping reviews of the same
  // session are reachable — nothing serialises them, and a double-click is
  // enough — and a shared scratch index means one `add -A` lands in the other's
  // diff. That failure is silent and produces a plausible wrong answer, which
  // is the worst kind to leave in.
  const indexFile = path.join(
    os.tmpdir(),
    `woodshed-review-index-${sessionName}-${randomBytes(6).toString('hex')}`,
  );
  const patch = await worktreeDiff({ repoRoot, worktreePath, baseRef, indexFile });
  if (!patch.ok) return patch;

  const diff = parseUnifiedDiff(patch.patch);
  if (!diff.files.length) {
    return {
      ok: false,
      status: 409,
      error: `nothing to review — this worktree matches ${baseRef}`,
    };
  }

  const state = await worktreeState({ worktreePath, baseSha: patch.baseSha });
  const meta = worktreeMeta({ baseRef, state, diff, headSha: patch.headSha });

  const review = {
    session: sessionName,
    kind: 'worktree',
    pr: null,
    branch: state.branch,
    baseRef,
    headSha: patch.headSha,
    baseSha: patch.baseSha,
    // Nothing here to take away. removeReviewSession keys off this.
    reviewBranch: null,
    ownsWorktree: false,
    worktree: worktreePath,
    meta,
    dirtyFiles: state.dirtyFiles,
    createdAt: new Date().toISOString(),
  };

  try {
    writeSessionReview({ session: sessionName, review });
    writeDiff({ session: sessionName, diff });
  } catch (err) {
    // No undo in the prepareReview sense: this created no worktree and no
    // branch, so there is nothing to hand back. Clearing the state keeps
    // hasReviewFor from claiming a review that was never written.
    //
    // On a RE-review that costs more than it sounds. writeSessionReview has
    // already replaced the previous record, so a throw from writeDiff takes
    // the working review with it — the row falls back to "Review work" and the
    // page 404s until someone presses it again. Left as is: it needs a disk
    // error to reach, one press to undo, and the alternative is holding the
    // old record while the new diff may or may not be on disk beside it, which
    // is the pairing this whole path exists to keep straight.
    removeReviewState(sessionName);
    return { ok: false, status: 500, error: `could not write review state: ${err?.message}` };
  }

  log('review.worktree_prepared', {
    reqId,
    session: sessionName,
    baseRef,
    branch: state.branch,
    headSha: patch.headSha.slice(0, 8),
    baseSha: patch.baseSha.slice(0, 8),
    commits: state.commits,
    dirtyFiles: state.dirtyFiles,
    files: diff.files?.length,
    lines: diff.totalLines,
    truncated: diff.truncated,
    baseFetched: patch.baseFetched,
    refreshed: !!existing,
  });
  return { ok: true, review };
}

/**
 * Take a review of the session's own worktree if it has none, without starting the analysis.
 *
 * For a host that opens the review page on a session nobody launched a review for (the launcher's Review button
 * does this and the analysis together, which spends a model run). The page then offers the analysis itself.
 *
 * @returns {Promise<{ok: true, created: boolean} | {ok: false, status: number, error: string}>}
 */
export async function ensureWorktreeReview({ ctx, sessionName }) {
  if (readSessionReview(sessionName)) return { ok: true, created: false };
  const made = await createWorktreeReview({ ctx, sessionName, worktreePath: ctx.worktreePathFor(sessionName) });
  return made.ok ? { ok: true, created: true } : { ok: false, status: made.status, error: made.error };
}

/**
 * Fill the pull request cache for a session's branch before its first status read, so the page opens with the pull
 * request instead of getting one only after a Re-review. The launcher's own polling does this for the standalone shed.
 */
export async function warmLivePr({ sessionName }) {
  const review = readSessionReview(sessionName);
  const branch = review?.branch || review?.meta?.headRefName || null;
  if (branch) await schedulePrRefresh([branch]);
}

/**
 * Take a pull request or branch review again, at whatever origin has now.
 *
 * The premise this feature was built on — "a session reviews exactly one
 * commit, fixed when it was launched; a pull request that moves gets a new
 * session" — turned out to be the wrong trade. A review session costs a 130 MB
 * worktree and a launch, and the commonest thing that happens to a pull request
 * under review is that it gains commits.
 *
 * Three things have to end up in step — the worktree, the diff and the record —
 * and the order they are done in below is what gets them there:
 *
 *  1. **The diff first**, because taking it changes nothing. A pull request
 *     that cannot be fetched or diffed leaves the review exactly as it was
 *     rather than half-refreshed.
 *  2. **Then the worktree**, which is the first thing here that is destructive.
 *     Everything downstream reads the code IN it — the analysis and every "ask
 *     about this line" run with it as their cwd — so a refreshed diff over an
 *     unmoved tree would have the model reading one commit while the page shows
 *     another. moveReviewWorktree refuses rather than resets when the tree has
 *     anything of its own in it; see its header.
 *  3. **The record last**, after the diff is on disk, because it is what names
 *     the head the analysis will run against. A half-applied write that leaves
 *     the NEW diff under the OLD header is survivable; the reverse has the
 *     model reordering a diff of code that is not there.
 *
 * Nothing is written at all when the head has not moved: the button is one
 * press away from a paid run, and "no new commits" is the honest answer to it.
 *
 * @returns {Promise<{ok: true, review?: object, unchanged?: boolean, headSha: string, moved?: boolean}
 *                 | {ok: false, status: number, error: string, stderr?: string}>}
 */
async function refreshTargetReview({ ctx, sessionName }) {
  const { log, repoRoot, reqId } = ctx;
  if (DISABLED) return { ok: false, status: 503, error: 'the review feature is disabled in this instance' };
  if (!isSessionName(sessionName)) return { ok: false, status: 400, error: 'not a session name' };

  const review = readSessionReview(sessionName);
  if (!review) return { ok: false, status: 404, error: 'no review for this session' };
  // A worktree review is re-taken by POST /reviews/<session>, which rebuilds it
  // from the tree. Silently doing that here would answer a question the caller
  // did not ask, in the direction that costs money.
  if (review.kind === 'worktree') {
    return {
      ok: false,
      status: 409,
      error: 'this is a review of the session’s own working tree — re-take it with Re-review',
    };
  }

  // The stored target back through the parser it came from. It cannot fail for
  // a record this module wrote, which is the point: if it ever does, something
  // has rewritten the record and the value is about to reach a `git fetch`
  // refspec and a `gh` argv.
  const parsed = parseTarget(review.kind === 'pr' ? review.pr : review.branch);
  if (!parsed.ok || parsed.kind !== review.kind) {
    return { ok: false, status: 500, error: 'this review’s target is no longer readable' };
  }
  const target = parsed;

  const slug = await originSlug(repoRoot);
  if (!slug) return { ok: false, status: 500, error: 'could not determine this box’s GitHub repository' };

  // Metadata first, exactly as at launch: it is the cheapest thing to fail on,
  // and it names the base branch — which a pull request can be retargeted onto
  // after it was launched, so this reads it again rather than trusting the
  // record.
  let prMeta = null;
  let baseRef;
  if (target.kind === 'pr') {
    const fetched = await fetchPrMeta({ pr: target.pr, slug });
    if (!fetched.ok) return { ok: false, status: fetched.status, error: fetched.error };
    prMeta = fetched.meta;
    baseRef = prMeta.baseRefName;
  } else {
    baseRef = await defaultBranch(repoRoot);
  }

  const sessionId = sessionName.slice('claude-'.length);
  const head = await fetchTargetHead({ repoRoot, sessionId, target, baseRef });
  if (!head.ok) return head;

  try {
    if (head.headSha === review.headSha) {
      log('review.refresh_unchanged', {
        reqId, session: sessionName, target: describeTarget(target), headSha: head.headSha.slice(0, 8),
      });
      return { ok: true, unchanged: true, headSha: head.headSha };
    }

    const patch = target.kind === 'pr'
      ? await fetchPrDiff({ pr: target.pr, slug })
      : await branchDiff({ repoRoot, baseRef, headSha: head.headSha });
    if (!patch.ok) return { ok: false, status: patch.status, error: patch.error };

    // Nothing above this line has changed anything, which is deliberate: a
    // pull request that cannot be diffed leaves the existing review exactly as
    // it was rather than half-refreshed.
    const moved = await moveReviewWorktree({
      worktreePath: review.worktree,
      recordedSha: review.headSha,
      targetSha: head.headSha,
    });
    if (!moved.ok) return moved;

    const diff = parseUnifiedDiff(patch.patch);
    const meta = prMeta
      ? publicPrMeta(prMeta, head.headSha)
      : await branchMeta({ repoRoot, target, baseRef, headSha: head.headSha, diff });
    if (typeof meta.changedFiles === 'number' && meta.changedFiles !== diff.files.length) {
      log('review.file_count_mismatch', {
        reqId, session: sessionName, fromGithub: meta.changedFiles, fromDiff: diff.files?.length,
      });
    }
    meta.changedFiles = diff.files.length;

    const next = {
      ...review,
      baseRef,
      headSha: head.headSha,
      meta,
      // What the header means by "as of": when THIS diff was taken, not when
      // the session was launched. The page compares it against when the reader
      // last looked, so a refreshed review that kept the launch time would be
      // telling them the change they are looking at is hours old.
      createdAt: new Date().toISOString(),
      // Only for the log and for anyone reading session.json after the fact.
      // Nothing renders it: the page's job is to describe the code as it is now.
      previousHeadSha: review.headSha,
    };

    try {
      // The diff before the record, because the record is what says which
      // commit the analysis is about. See the header.
      writeDiff({ session: sessionName, diff });
      writeSessionReview({ session: sessionName, review: next });
    } catch (err) {
      // Deliberately NOT removeReviewState: this record is the only thing that
      // names the review/* branch, and dropping it strands that branch — and
      // the 130 MB it pins — for a garbage collector that no longer exists.
      // The worktree has moved by now, so the review on screen is stale; one
      // more press of the same button puts it right, because the tree already
      // being at the new head is the one case moveReviewWorktree calls a no-op.
      log('review.refresh_write_failed', {
        reqId, session: sessionName, headSha: head.headSha.slice(0, 8), error: err?.message,
      });
      return { ok: false, status: 500, error: `could not write review state: ${err?.message}` };
    }

    log('review.refreshed', {
      reqId,
      session: sessionName,
      target: describeTarget(target),
      from: review.headSha?.slice(0, 8),
      to: head.headSha.slice(0, 8),
      movedWorktree: moved.moved,
      baseRef,
      files: diff.files?.length,
      lines: diff.totalLines,
      truncated: diff.truncated,
    });
    return { ok: true, review: next, headSha: head.headSha, moved: moved.moved };
  } finally {
    // The staging ref has done its job either way: on success the worktree's
    // own branch holds the objects, and on every failure above nothing should
    // be holding them. fetchTargetHead's contract is that its caller drops it.
    await dropStagingRef({ repoRoot, sessionId });
  }
}

/**
 * Kick the analysis off in the background. Fire and forget: /run answers as
 * soon as tmux is up, and the page reports progress from there.
 */
export function startReviewAnalysis({ ctx, sessionName }) {
  if (DISABLED) return;
  const review = readSessionReview(sessionName);
  if (!review) return;
  beginAnalysis({ ctx, session: sessionName, review });
}

/**
 * Everything a killed session's review owns: its jobs, its state on disk, its
 * worktree and its branch.
 *
 * The worktree removal is here rather than in server.mjs's kill path because
 * the BRANCH has to go with it and only this module knows the branch's name.
 * server.mjs still removes the worktree itself for a non-review session.
 */
export async function removeReviewSession({ ctx, sessionName }) {
  if (!isSessionName(sessionName)) return { removed: false };
  const review = readSessionReview(sessionName);
  if (!review) return { removed: false };

  const killed = cancelJobsForSession(sessionName);
  // In-memory state first and synchronously: a SIGTERM'd child's close fires
  // during the await below and runAnalysis resumes, guarded by these maps.
  reviewState.delete(sessionName);
  progressBySession.delete(sessionName);

  // A review of a session's OWN worktree owns nothing. The worktree and the
  // branch are the user's work, and the review is a read of them — taking
  // either away because the review is going away would delete the thing the
  // review was about. Absent on records written before this existed, and those
  // were all bridge-created, so the default has to be true.
  if (review.ownsWorktree === false) {
    removeReviewState(sessionName);
    ctx.log('review.session_removed', {
      session: sessionName, jobsKilled: killed, kind: review.kind, ownsWorktree: false,
    });
    // `removed: false` tells the caller to dispose of the worktree its own
    // usual way, which for this session is the only correct way.
    return { removed: false };
  }

  const cleaned = await removeReviewWorktree({
    repoRoot: ctx.repoRoot,
    worktreePath: review.worktree,
    branchName: review.reviewBranch,
    ownsBranch: review.ownsBranch,
    reviewedSha: review.headSha,
    removeWorktree: ctx.removeWorktree,
  });
  // The on-disk record LAST, and only once the thing it records is gone. It
  // names the review/* branch, and nothing else does; dropping it before the
  // removal succeeded meant the caller's 500 was unrecoverable, because the
  // retry read no session.json, took the plain-worktree path and left the
  // branch behind for a GC that no longer exists. Note the two failures come
  // together rather than independently: `git branch -D` refuses a branch that
  // is still checked out, so a worktree that would not go takes the branch
  // with it.
  //
  // One expression, computed once and returned, because the caller needs the
  // same answer and the two drifting apart is a silent leak rather than a
  // visible failure: a route reporting success on the worktree alone answers
  // 200, the session leaves the list, and the state kept here for a retry that
  // will now never come is the only thing still naming the orphaned branch.
  const complete = cleaned.worktreeRemoved && (cleaned.branchRemoved || cleaned.branchKept);
  if (complete) removeReviewState(sessionName);

  ctx.log('review.session_removed', {
    session: sessionName,
    jobsKilled: killed,
    stateKept: !complete,
    worktreeRemoved: cleaned?.worktreeRemoved,
    branchRemoved: cleaned?.branchRemoved,
    branchKept: cleaned?.branchKept,
    branch: review.reviewBranch,
  });
  return { removed: true, ...cleaned, complete, branch: review.reviewBranch };
}

// --- HTTP -------------------------------------------------------------------

/**
 * Handle anything under /review or /reviews. Returns false when the URL is not
 * ours, so server.mjs can fall through to its own routes.
 *
 * @param {{repoRoot: string, removeWorktree: Function, readProcTable: Function,
 *          readMeminfo: Function, json: Function, log: Function, reqId: string}} ctx
 */
export async function handleReviewRequest(req, res, ctx) {
  const url = new URL(req.url || '/', 'http://shed.invalid');
  const pathname = url.pathname;
  const { json } = ctx;

  // Bare /review has to stay a 200. install.sh fetches it with `curl -fsS` and
  // re-parses its inline script, and a redirect or a 404 there fails the
  // install rather than the check it is actually making. It renders an empty
  // state pointing back at the session list.
  if (req.method === 'GET' && pathname === '/review') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The launcher frames this page beside a terminal, and nothing else
      // should be able to: a page that framed it invisibly could put a bait
      // button under one of its controls.
      'Content-Security-Policy': "frame-ancestors 'self'",
    });
    res.end(REVIEW_HTML);
    return true;
  }

  if (!pathname.startsWith('/reviews')) return false;

  if (DISABLED) {
    json(res, 503, { ok: false, error: 'the review feature is disabled in this instance' });
    return true;
  }

  // The askId tail is bounded: unbounded, a long segment produced
  // ENAMETOOLONG rather than a miss and echoed an absolute path back in a 500.
  const match = /^\/reviews\/(claude-[0-9a-f]{8})(\/[a-z]+)?(\/[A-Za-z0-9-]{1,64})?$/.exec(pathname);
  if (!match) {
    json(res, 404, { ok: false, error: 'not found' });
    return true;
  }

  const session = match[1];
  const section = match[2] || '';
  const tail = match[3] ? match[3].slice(1) : '';

  if (req.method === 'GET' && !section) {
    json(res, 200, statusPayload(session));
    return true;
  }
  // Review this session's own worktree against the default branch, or re-take a review
  // already there. POST rather than PUT even though it is idempotent-ish:
  // it spends money, and the second press means "do it again with what I have
  // now", which is a request to act rather than to set a value.
  if (req.method === 'POST' && !section) {
    await gated(res, ctx, 'worktree-review', () => handleWorktreeReview(res, ctx, session));
    return true;
  }
  // Take this pull request or branch again at whatever origin has now. A
  // separate route from the bare POST rather than making that one polymorphic:
  // the bare POST means "review this session's own working tree", which is a
  // different question with a different answer, and the 409 it answers a target
  // session with is the thing that says so.
  if (req.method === 'POST' && section === '/refresh') {
    await gated(res, ctx, 'refresh', () => handleRefreshReview(res, ctx, session));
    return true;
  }
  if (req.method === 'GET' && section === '/diff') {
    handleDiff(res, ctx, session);
    return true;
  }
  if (req.method === 'POST' && section === '/analyze') {
    await gated(res, ctx, 'analyze', () => handleAnalyze(res, ctx, session));
    return true;
  }
  if (req.method === 'POST' && section === '/explain') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await gated(res, ctx, 'explain', () => handleExplain(body.payload, res, ctx, session));
    return true;
  }
  if (req.method === 'GET' && section === '/explain' && tail) {
    handleExplainPoll(res, ctx, session, tail);
    return true;
  }
  // The one route in the shed whose effect other people see. It is not behind
  // `gated`: a `gh pr review` is one short call, not a claude run, and queuing
  // it behind memory pressure would leave a person staring at a sheet they
  // have already pressed.
  if (req.method === 'POST' && section === '/submit') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleSubmitReview(body.payload, res, ctx, session);
    return true;
  }
  // The draft review: its line comments, adding one, dropping one, and
  // throwing the lot away. The draft lives on GitHub, not here, so all four
  // are thin wrappers over it.
  if (req.method === 'GET' && section === '/comments') {
    await handleCommentsRead(res, ctx, session);
    return true;
  }
  if (req.method === 'POST' && section === '/comments') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleCommentAdd(body.payload, res, ctx, session);
    return true;
  }
  if (req.method === 'DELETE' && section === '/comments') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleCommentDelete(body.payload, res, ctx, session);
    return true;
  }
  // Rename the pull request. PATCH rather than POST: it sets a value, and
  // pressing it twice with the same text is the same pull request.
  if (req.method === 'PATCH' && section === '/title') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleRetitle(body.payload, res, ctx, session);
    return true;
  }
  // Which files this account has ticked on the pull request, and ticking one.
  // Read and write rather than a local note, because the tick belongs to the
  // pull request: ticking here has to be the same act as ticking on GitHub, or
  // the two disagree and neither can be trusted.
  if (req.method === 'GET' && section === '/viewed') {
    await handleViewedRead(res, ctx, session);
    return true;
  }
  if (req.method === 'POST' && section === '/viewed') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleViewedWrite(body.payload, res, ctx, session);
    return true;
  }
  // Whether this pull request can be merged from here, and merging it. The
  // read is what the confirmation sheet draws; the write asks GitHub again
  // rather than trusting the page, because the sheet may have sat open.
  if (req.method === 'GET' && section === '/merge') {
    await handleMergeRead(res, ctx, session);
    return true;
  }
  if (req.method === 'POST' && section === '/merge') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await handleMerge(body.payload, res, ctx, session);
    return true;
  }
  // Empty this review: the analysis and the conversation, not the worktree.
  // POST rather than DELETE because it does not remove the review — the page
  // is still on it afterwards, with the diff and an offer to read it again.
  if (req.method === 'POST' && section === '/discard') {
    handleDiscardReview(res, ctx, session);
    return true;
  }
  if (req.method === 'GET' && section === '/chat') {
    handleChatRead(res, ctx, session);
    return true;
  }
  if (req.method === 'POST' && section === '/chat') {
    const body = await readJsonBody(req, res, ctx);
    if (!body.ok) return true;
    await gated(res, ctx, 'chat', () => handleChat(body.payload, res, ctx, session));
    return true;
  }

  json(res, 404, { ok: false, error: 'not found' });
  return true;
}

/**
 * Post the reader's verdict to the pull request.
 *
 * Only a pull-request review has anywhere to send one. A branch or worktree
 * review is a reading of code that GitHub has never been told about, so the
 * page does not offer the control at all and this is the floor under that
 * rather than the thing a person meets.
 */
async function handleSubmitReview(payload, res, ctx, session) {
  const { json, log, repoRoot, reqId } = ctx;
  const review = readSessionReview(session);
  if (!review) {
    json(res, 404, { ok: false, error: 'no review for this session' });
    return;
  }
  // Not `review.kind === 'pr'`: a worktree review whose branch has since been
  // opened as a pull request has somewhere to post, and the page offers it.
  // The floor is whether a pull request exists, not what the review was
  // launched as.
  const live = livePrFor(review);
  if (!live || live.state === 'merged' || live.state === 'closed') {
    json(res, 409, {
      ok: false,
      error: live
        ? `pull request #${live.number} is ${live.state}, so there is nothing left to review`
        : 'this branch has no open pull request to post a review to',
    });
    return;
  }

  const slug = await originSlug(repoRoot);
  if (!slug) {
    json(res, 500, { ok: false, error: 'could not determine this box’s GitHub repository' });
    return;
  }

  const event = typeof payload.event === 'string' ? payload.event : '';
  // A viewer gets ONE pending review per pull request, so `gh pr review` —
  // which opens its own — is a 422 the moment a draft exists. Which call is
  // right depends on whether there are draft comments waiting to go with the
  // verdict, so that is what decides it.
  const draft = await fetchReviewState({ pr: live.number, slug });
  if (!draft.ok) {
    json(res, draft.status, { ok: false, error: draft.error });
    return;
  }
  const posted = draft.reviewId
    ? await submitPendingReview({ reviewId: draft.reviewId, event, body: payload.body })
    : await submitPrReview({ pr: live.number, slug, event, body: payload.body });
  if (!posted.ok) {
    log('review submit failed', { reqId, session, pr: live?.number, event, error: posted.error });
    json(res, posted.status, { ok: false, error: posted.error });
    return;
  }
  log('review submitted', { reqId, session, pr: live?.number, event, comments: draft.comments.length });
  json(res, 200, { ok: true, event, pr: live.number, url: live.url, comments: draft.comments.length });
}

/**
 * What GitHub says now, and whether that allows a merge from this page.
 * Shared by the sheet's read and the merge itself.
 */
async function mergeContextFor(ctx, session) {
  const got = await prContextFor(ctx, session);
  if (!got.ok) return got;
  const fresh = await fetchMergeReadiness({ pr: got.live.number, slug: got.slug });
  if (!fresh.ok) return fresh;
  const blocker = mergeBlocker({
    readiness: fresh.readiness,
    reviewedSha: got.review.headSha,
    // Only a worktree review reads files that are not in a commit.
    uncommittedFiles: got.review.kind === 'worktree' ? (got.review.dirtyFiles ?? null) : 0,
  });
  return { ok: true, ...got, readiness: fresh.readiness, blocker };
}

async function handleMergeRead(res, ctx, session) {
  const got = await mergeContextFor(ctx, session);
  if (!got.ok) return ctx.json(res, got.status, { ok: false, error: got.error });
  ctx.json(res, 200, {
    ok: true,
    readiness: got.readiness,
    reviewedSha: got.review.headSha || null,
    blocker: got.blocker,
  });
}

/**
 * Merge the pull request this review is of: into the merge queue when GitHub
 * says its base branch has one, otherwise a squash-merge now.
 *
 * Every rule is checked again here, against a fresh read. The page hiding the
 * button is the common case and this is the floor under it.
 */
async function handleMerge(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const got = await mergeContextFor(ctx, session);
  if (!got.ok) return json(res, got.status, { ok: false, error: got.error });
  if (got.blocker) {
    return json(res, 409, { ok: false, code: got.blocker.code, error: got.blocker.error });
  }
  const { baseRef, headSha, mergeQueue, nodeId } = got.readiness;
  if (mergeQueue) {
    const queued = await enqueuePr({ nodeId, headSha });
    if (!queued.ok) {
      log('review.enqueue_failed', { reqId, session, pr: got.live?.number, error: queued.error });
      return json(res, queued.status, { ok: false, code: queued.code || null, error: queued.error });
    }
    log('review.enqueued', { reqId, session, pr: got.live?.number, position: queued.position });
    return json(res, 200, { ok: true, queued: true, pr: got.live.number, position: queued.position, baseRef });
  }
  const merged = await mergePr({ pr: got.live.number, slug: got.slug, headSha, subject: payload.subject });
  if (!merged.ok) {
    log('review.merge_failed', { reqId, session, pr: got.live?.number, error: merged.error });
    return json(res, merged.status, { ok: false, code: merged.code || null, error: merged.error });
  }
  log('review.merged', { reqId, session, pr: got.live?.number, sha: merged.sha?.slice(0, 8) });
  json(res, 200, { ok: true, queued: false, pr: got.live.number, sha: merged.sha, baseRef });
}

/**
 * Throw away what a review has accumulated, and keep the review.
 *
 * Nothing here touches a worktree or a branch. Removing those is the session's
 * Kill, which does it in the one order that cannot leave a branch behind; a
 * second half-way version of it on this page would be a delete whose blast
 * radius a reader cannot see from where they press it.
 */
function handleDiscardReview(res, ctx, session) {
  const { json, log, reqId } = ctx;
  const review = readSessionReview(session);
  if (!review) {
    json(res, 404, { ok: false, error: 'no review for this session' });
    return;
  }
  // In-memory first and synchronously, the way removeReviewSession does it: a
  // killed child's close fires later and runAnalysis resumes, guarded by these
  // maps. Clearing disk first would let that run write a fresh artifact over
  // the discard.
  const killed = cancelJobsForSession(session);
  reviewState.delete(session);
  progressBySession.delete(session);
  discardReviewWork(session);
  log('review.discarded', { reqId, session, jobsKilled: killed, kind: review?.kind });
  json(res, 200, { ok: true });
}

/**
 * A review's pull request, and the slug to reach it by, or the reason not to.
 * Shared by the three routes that all need the same two facts first.
 */
async function prContextFor(ctx, session) {
  const review = readSessionReview(session);
  if (!review) return { ok: false, status: 404, error: 'no review for this session' };
  const live = livePrFor(review);
  if (!live) {
    return { ok: false, status: 409, error: 'this branch has no pull request' };
  }
  const slug = await originSlug(ctx.repoRoot);
  if (!slug) return { ok: false, status: 500, error: 'could not determine this box’s GitHub repository' };
  return { ok: true, review, live, slug };
}

/**
 * Rename the pull request this review can post to.
 *
 * The record's own `meta.title` is deliberately left alone. It says what the
 * pull request was called when the review was taken, and the page already
 * prefers the live title over it — so the rename shows immediately without a
 * second write, and a re-review picks the new one up on its own.
 */
async function handleRetitle(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const got = await prContextFor(ctx, session);
  if (!got.ok) return json(res, got.status, { ok: false, error: got.error });

  const done = await setPrTitle({ pr: got.live.number, slug: got.slug, title: payload.title });
  if (!done.ok) {
    log('review.retitle_failed', { reqId, session, pr: got.live?.number, error: done.error });
    return json(res, done.status, { ok: false, error: done.error });
  }
  log('review.retitled', { reqId, session, pr: got.live?.number });
  json(res, 200, { ok: true, title: done.title });
}

async function handleCommentsRead(res, ctx, session) {
  const got = await prContextFor(ctx, session);
  // No pull request means no draft, which is an empty answer rather than an
  // error: the page draws no comment controls either.
  if (!got.ok) {
    if (got.status === 409) return ctx.json(res, 200, { ok: true, prId: null, reviewId: null, comments: [] });
    return ctx.json(res, got.status, { ok: false, error: got.error });
  }
  const draft = await fetchReviewState({ pr: got.live.number, slug: got.slug });
  if (!draft.ok) return ctx.json(res, draft.status, { ok: false, error: draft.error });
  ctx.json(res, 200, {
    ok: true,
    prId: draft.prId,
    headSha: draft.headSha,
    reviewId: draft.reviewId,
    description: draft.description,
    comments: draft.comments,
    threads: draft.threads,
    outdated: draft.outdated,
    said: draft.said,
    truncated: draft.truncated,
  });
}

async function handleCommentAdd(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const got = await prContextFor(ctx, session);
  if (!got.ok) return json(res, got.status, { ok: false, error: got.error });

  // The ids ride along from the page's read so the common case is one round
  // trip. Re-read only when something is missing, which is the first comment
  // on a page that loaded before the draft did.
  let prId = typeof payload.prId === 'string' ? payload.prId : '';
  let reviewId = typeof payload.reviewId === 'string' ? payload.reviewId : '';
  let headSha = typeof payload.headSha === 'string' ? payload.headSha : '';
  const now = payload.mode === 'now';
  if (!prId || (now && !headSha)) {
    const draft = await fetchReviewState({ pr: got.live.number, slug: got.slug });
    if (!draft.ok) return json(res, draft.status, { ok: false, error: draft.error });
    prId = draft.prId;
    headSha = draft.headSha || '';
    reviewId = draft.reviewId || '';
  }

  const where = {
    path: typeof payload.path === 'string' ? payload.path : '',
    line: payload.line,
    startLine: payload.startLine,
    side: payload.side === 'old' ? 'old' : 'new',
    body: payload.body,
  };

  // Two different acts. One goes out now and everyone watching the pull
  // request hears about it; the other waits with the rest of the review.
  if (now) {
    const posted = await postLineComment({ pr: got.live.number, slug: got.slug, headSha, ...where });
    if (!posted.ok) {
      log('review.comment_failed', { reqId, session, pr: got.live?.number, mode: 'now', error: posted.error });
      return json(res, posted.status, { ok: false, error: posted.error });
    }
    log('review.comment_posted', { reqId, session, pr: got.live?.number });
    return json(res, 200, { ok: true, posted: true, url: posted.comment?.html_url || null });
  }

  const added = await addPendingComment({ prId, reviewId: reviewId || null, ...where });
  if (!added.ok) {
    log('review.comment_failed', { reqId, session, pr: got.live?.number, mode: 'draft', error: added.error });
    return json(res, added.status, { ok: false, error: added.error });
  }
  log('review.comment_added', { reqId, session, pr: got.live?.number });
  json(res, 200, { ok: true, reviewId: added.reviewId, comment: added.comment });
}

async function handleCommentDelete(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const got = await prContextFor(ctx, session);
  if (!got.ok) return json(res, got.status, { ok: false, error: got.error });

  // The ids come off the wire, so they are checked against this session's own
  // draft before anything is deleted by them. `gh` would refuse someone else's
  // draft anyway and the tailnet is the trust boundary, so this is not what
  // stands between a caller and damage — it is what makes the route mean what
  // its path says. A route named for one session should not be able to act on
  // another one's review because a caller pasted the wrong id.
  const draft = await fetchReviewState({ pr: got.live.number, slug: got.slug });
  if (!draft.ok) return json(res, draft.status, { ok: false, error: draft.error });

  // Dropping the whole draft, or one comment out of it. GitHub removes an
  // empty draft review by itself, so the single-comment path never has to.
  if (payload.all) {
    if (!draft.reviewId) return json(res, 409, { ok: false, error: 'there is no draft review to discard' });
    const gone = await discardPendingReview({ reviewId: draft.reviewId });
    if (!gone.ok) return json(res, gone.status, { ok: false, error: gone.error });
    log('review.draft_discarded', { reqId, session, pr: got.live?.number, comments: draft.comments.length });
    return json(res, 200, { ok: true });
  }

  const commentId = typeof payload.id === 'string' ? payload.id : '';
  if (!commentId) return json(res, 400, { ok: false, error: 'a comment id is required' });

  // Hiding rather than deleting. GitHub's own fallback for something that
  // cannot be removed: it collapses behind a reason and anyone can unfold it
  // again, there. Checked against this review's own conversation first, so a
  // route named for one session cannot hide another's.
  if (payload.hide) {
    const subject = draft.said.find((x) => x.id === commentId);
    if (!subject) return json(res, 404, { ok: false, error: 'that is not on this pull request' });
    const hidden = await hideComment({ nodeId: commentId, reason: payload.reason });
    if (!hidden.ok) return json(res, hidden.status, { ok: false, error: hidden.error });
    log('review.said_hidden', { reqId, session, pr: got.live?.number });
    return json(res, 200, { ok: true, id: commentId, hidden: true });
  }

  // Unsent or posted: two different deletions, and only one of them is
  // visible to anyone else. Which it is comes from what GitHub said about
  // this comment, not from what the caller claims it is.
  const pending = draft.comments.find((c) => c.id === commentId);
  if (pending) {
    const gone = await deletePendingComment({ commentId });
    if (!gone.ok) return json(res, gone.status, { ok: false, error: gone.error });
    return json(res, 200, { ok: true, id: commentId });
  }

  // A plain comment on the pull request, rather than one on a line. Only
  // this kind: a submitted review cannot be deleted at all, and the page
  // offers no button for one.
  const plain = draft.said.find((x) => x.kind === 'comment' && x.restId === commentId);
  if (plain) {
    if (!plain.canDelete) {
      return json(res, 403, { ok: false, error: 'GitHub does not let this account delete that comment' });
    }
    const dropped = await deleteIssueComment({ slug: got.slug, restId: plain.restId });
    if (!dropped.ok) return json(res, dropped.status, { ok: false, error: dropped.error });
    log('review.said_deleted', { reqId, session, pr: got.live?.number });
    return json(res, 200, { ok: true, id: commentId });
  }

  let posted = null;
  for (const thread of draft.threads) {
    const found = thread.comments.find((c) => c.id === commentId);
    if (found) { posted = found; break; }
  }
  if (!posted) {
    return json(res, 404, { ok: false, error: 'that comment is not on this pull request' });
  }
  if (!posted.canDelete) {
    return json(res, 403, { ok: false, error: 'GitHub does not let this account delete that comment' });
  }
  const gone = await deletePostedComment({ slug: got.slug, restId: posted.restId });
  if (!gone.ok) return json(res, gone.status, { ok: false, error: gone.error });
  log('review.comment_deleted', { reqId, session, pr: got.live?.number });
  json(res, 200, { ok: true, id: commentId });
}

async function handleViewedRead(res, ctx, session) {
  const got = await prContextFor(ctx, session);
  if (!got.ok) {
    // Not an error a reader should see: a review with no pull request simply
    // has no ticks, and the page draws no control for them either.
    if (got.status === 409) return ctx.json(res, 200, { ok: true, viewed: [], prId: null });
    return ctx.json(res, got.status, { ok: false, error: got.error });
  }
  const state = await fetchViewedFiles({ pr: got.live.number, slug: got.slug });
  if (!state.ok) return ctx.json(res, state.status, { ok: false, error: state.error });
  ctx.json(res, 200, { ok: true, viewed: state.viewed, prId: state.id });
}

async function handleViewedWrite(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const filePath = typeof payload.path === 'string' ? payload.path : '';
  if (!filePath) return json(res, 400, { ok: false, error: 'a file path is required' });

  const got = await prContextFor(ctx, session);
  if (!got.ok) return json(res, got.status, { ok: false, error: got.error });

  // The node id travels with the page rather than being re-fetched per tick:
  // the read handed it over, and a tick should cost one round trip, not two.
  let prId = typeof payload.prId === 'string' ? payload.prId : '';
  if (!prId) {
    const state = await fetchViewedFiles({ pr: got.live.number, slug: got.slug });
    if (!state.ok) return json(res, state.status, { ok: false, error: state.error });
    prId = state.id;
  }
  const done = await setFileViewed({ prId, path: filePath, viewed: !!payload.viewed });
  if (!done.ok) {
    log('review.viewed_failed', { reqId, session, pr: got.live?.number, error: done.error });
    return json(res, done.status, { ok: false, error: done.error });
  }
  json(res, 200, { ok: true, path: filePath, viewed: !!payload.viewed });
}

async function handleWorktreeReview(res, ctx, session) {
  const { json, log, reqId } = ctx;
  // No existence check here: worktreePathFor only computes a path, and whether
  // anything is at it is worktreeDiff's first question — which answers with a
  // 409 and a sentence rather than a bare 404.
  const worktreePath = ctx.worktreePathFor(session);

  const made = await createWorktreeReview({ ctx, sessionName: session, worktreePath });
  if (!made.ok) {
    log('review.worktree_failed', { reqId, session, status: made.status, error: made.error });
    return json(res, made.status, { ok: false, error: made.error, stderr: made.stderr });
  }

  // Everything below is the re-review case, and the order is the point.
  //
  // The new diff is already on disk by now; createWorktreeReview writes it, and
  // it fails before writing anything if it fails at all, so nothing here has to
  // be undone. What is left is an analysis that may still be running against
  // the diff that was just replaced, and an artifact describing it.
  const cancelled = cancelJobsForSession(session, 'replaced by a newer review of this worktree');
  // The old artifact goes too. restoreState treats one on disk as
  // authoritative, so leaving it means the page can show the previous ordering
  // and preamble against the new code — wrong, and confident about it.
  //
  // Caught rather than allowed to escape: removeArtifact rethrows anything that
  // is not ENOENT, and a throw here rejects the route with the NEW diff already
  // written and the OLD artifact still authoritative — the exact state this
  // ordering exists to prevent, arrived at by way of the line meant to prevent
  // it. Continuing leaves the stale artifact, but the analysis below overwrites
  // it, and a logged line beats a 500 that has already half-applied.
  try {
    removeArtifact(session);
  } catch (err) {
    log('review.artifact_remove_failed', { reqId, session, error: err?.message });
  }
  // And the in-memory claim, because beginAnalysis declines to start when the
  // session is already 'running'. Without this a re-review during an analysis
  // silently keeps the stale one and the user is told it worked.
  reviewState.delete(session);
  progressBySession.delete(session);
  beginAnalysis({ ctx, session, review: made.review });

  log('review.worktree_started', { reqId, session, cancelled, files: made.review.meta.changedFiles });
  return json(res, 200, {
    ok: true,
    session,
    kind: 'worktree',
    files: made.review.meta.changedFiles,
    dirtyFiles: made.review.dirtyFiles,
  });
}

/**
 * Re-take a pull request or branch review at origin's current head.
 *
 * Everything after the refresh itself is handleWorktreeReview's ending, for
 * handleWorktreeReview's reasons: the new diff is on disk, so what is left is
 * an analysis that may still be running against the diff it replaced, an
 * artifact describing that diff, and an in-memory claim that would make
 * beginAnalysis decline to start. The one addition is the unchanged case, which
 * touches none of it — there is nothing to replace, so nothing is cancelled and
 * no run is paid for.
 */
async function handleRefreshReview(res, ctx, session) {
  const { json, log, reqId } = ctx;

  const done = await refreshTargetReview({ ctx, sessionName: session });
  if (!done.ok) {
    log('review.refresh_failed', { reqId, session, status: done.status, error: done.error });
    return json(res, done.status, { ok: false, error: done.error, stderr: done.stderr });
  }
  if (done.unchanged) {
    return json(res, 200, { ok: true, session, unchanged: true, headSha: done.headSha });
  }

  const what = done.review?.kind === 'pr' ? 'pull request' : 'branch';
  const cancelled = cancelJobsForSession(session, `replaced by a newer review of this ${what}`);
  try {
    removeArtifact(session);
  } catch (err) {
    log('review.artifact_remove_failed', { reqId, session, error: err?.message });
  }
  reviewState.delete(session);
  progressBySession.delete(session);
  beginAnalysis({ ctx, session, review: done.review });

  log('review.refresh_started', {
    reqId, session, cancelled, headSha: done.headSha?.slice(0, 8), files: done.review?.meta?.changedFiles,
  });
  return json(res, 200, {
    ok: true,
    session,
    unchanged: false,
    kind: done.review?.kind,
    headSha: done.headSha,
    movedWorktree: done.moved,
    files: done.review?.meta?.changedFiles,
  });
}

/**
 * The open pull request this review can post a verdict to, if there is one.
 *
 * A review's target is fixed when it is launched, but a branch's relationship
 * to GitHub is not: the common shape here is a session reviewing its own work,
 * where the pull request is opened HOURS later, from that same session. The
 * record still says kind 'worktree' and pr null, and it should — that is what
 * was reviewed. What changes is whether there is now somewhere to send a
 * verdict, and that is a question to answer each time the page is opened
 * rather than once at launch.
 *
 * Read out of prStatus's cache, which the launcher's own polling keeps warm,
 * so this costs nothing per request. The refresh is scheduled rather than
 * awaited and is TTL-guarded inside prStatus; a review opened on its own, with
 * no launcher tab polling beside it, therefore has its answer by the next
 * load rather than blocking this one.
 *
 * Only an open pull request counts. A merged or closed one has nothing left to
 * approve, and offering it would be the page inviting a request that GitHub
 * will refuse.
 */
function livePrFor(review) {
  // A pull request review knows its number but stores only what was true at
  // launch. A branch review knows no number at all. Both look the same way
  // first, so a title edited or a check that turned red since is current.
  const branch = review?.branch || review?.meta?.headRefName || null;
  const want = review?.kind === 'pr' ? review.pr : null;
  if (branch) {
    schedulePrRefresh([branch]);
    const found = pullRequestsFor([branch]);
    const match = want
      ? found.find((pr) => pr.number === want)
      : found.find((pr) => pr.state === 'open' || pr.state === 'draft');
    if (match) {
      return {
        number: match.number,
        url: match.url,
        title: match.title || '',
        state: match.state,
        review: match.review,
        checks: match.checks,
      };
    }
  }
  // The launch-time record, so a pull request review draws its state on the
  // first paint rather than after the cache fills. Nothing here can be stale
  // in a way that matters: it is replaced by the block above on the next load.
  if (want) {
    return {
      number: want,
      url: review.meta?.url || null,
      title: review.meta?.title || '',
      state: prStateFromMeta(review.meta),
      review: null,
      checks: null,
    };
  }
  return null;
}

/** The same mapping describePr makes, over what `gh pr view` stored at launch. */
function prStateFromMeta(meta) {
  const raw = String(meta?.state || '').toUpperCase();
  if (raw === 'MERGED') return 'merged';
  if (raw === 'CLOSED') return 'closed';
  return meta?.isDraft ? 'draft' : 'open';
}

// Asked once at boot, so the first review page to open already knows whose
// name goes on a verdict.
//
// statusPayload is synchronous and must stay that way for a string that is
// already in memory, so the answer is kept here rather than awaited there.
// Null until it lands, and on a box whose `gh` cannot say — the page has a
// vaguer sentence for that case, which is better than a made-up name.
let ghAccountName = null;
if (!DISABLED) {
  void ghAccount().then(function keep(login) { ghAccountName = login; });
}

function statusPayload(session) {
  const review = readSessionReview(session);
  if (!review) return { ok: false, status: 'missing', error: 'no review for this session' };

  const state = reviewState.get(session) || restoreState(session);
  const job = progressBySession.get(session);
  const progress =
    state.status === 'running' && job && job.phase === 'running'
      ? {
          toolCalls: job.toolCalls,
          currentFile: job.currentFile,
          elapsedMs: Date.now() - (job.startedAt || Date.now()),
        }
      : null;

  return {
    ok: true,
    session,
    kind: review.kind,
    // What the review is OF, unchanged, and separately where a verdict can go
    // now. A worktree review whose branch has since been opened as a pull
    // request has both: it read the working tree, and there is a pull request
    // to say so on.
    pr: review.pr,
    livePr: livePrFor(review),
    branch: review.branch,
    baseRef: review.baseRef,
    headSha: review.headSha,
    reviewBranch: review.reviewBranch,
    meta: onTheWire(review.meta),
    // When the diff was taken — at launch, or at the last Re-review. Every kind
    // displays it now: a worktree review because it is a snapshot of something
    // that keeps moving, and the other two because a refreshed one has to say
    // which pass of the pull request is on screen.
    createdAt: review.createdAt || null,
    showCosts: SHOW_COSTS,
    ghAccount: ghAccountName,
    status: state.status,
    review: state.review || null,
    error: state.error || null,
    // Set while the analysis is queued behind memory pressure rather than
    // actually running. Without it a launch on a loaded box shows a spinner
    // with no explanation for up to ten minutes.
    waiting: state.waiting || null,
    progress,
  };
}

/**
 * Rebuild in-memory status from disk. The shed restarts; a review launched
 * before that restart still has its artifact, and reporting it as `unknown`
 * because this process has not seen it would be a lie the user can disprove by
 * scrolling.
 */
function restoreState(session) {
  const artifact = readArtifact(session);
  if (artifact) {
    const state = { status: 'ready', review: artifact, error: null };
    reviewState.set(session, state);
    return state;
  }
  // A breadcrumb with no artifact means a run was cut off mid-flight.
  const state = hasJobBreadcrumb(session)
    ? { status: 'interrupted', review: null, error: null }
    : { status: 'unknown', review: null, error: null };
  reviewState.set(session, state);
  return state;
}

function handleDiff(res, ctx, session) {
  const diff = readDiff(session);
  if (!diff) return ctx.json(res, 404, { ok: false, error: 'no diff stored for this session' });
  return ctx.json(res, 200, { ok: true, session, ...diff });
}

async function handleAnalyze(res, ctx, session) {
  const { json, log } = ctx;
  const review = readSessionReview(session);
  if (!review) return json(res, 404, { ok: false, error: 'no review for this session' });

  log('review.retry', { session, headSha: review.headSha?.slice(0, 8) });
  const started = beginAnalysis({ ctx, session, review });
  return json(res, 200, { ok: true, session, status: started.status });
}

// --- analysis ---------------------------------------------------------------

function beginAnalysis({ ctx, session, review }) {
  const { log } = ctx;

  // Claim the session synchronously. The job-based check cannot do it alone:
  // the job is not created until after an await, so every request arriving in
  // that window used to pass the guard and start its own paid run.
  if (reviewState.get(session)?.status === 'running') return { status: 'running' };
  analysisGen += 1;
  const gen = analysisGen;
  // `!j.cancelled` is load-bearing on the re-review path: cancelJobsForSession
  // has SIGTERM'd the old run but its phase stays 'running' until the child
  // closes, and without this the replacement silently never starts — artifact
  // already deleted, diff already replaced, session claimed 'running' for good.
  if (findJob((j) => j.session === session && j.kind === 'analysis'
    && !j.cancelled && j.phase !== 'failed' && j.phase !== 'done')) {
    reviewState.set(session, { status: 'running', review: null, error: null, gen });
    return { status: 'running' };
  }

  const diff = readDiff(session);
  if (!diff || !diff.files?.length) {
    // Nothing to order or explain. Not a failure — just nothing to do.
    const empty = { overview: '', architecture: '', decisions: [], groups: [] };
    writeArtifact({ session, artifact: empty });
    reviewState.set(session, { status: 'ready', review: empty, error: null, gen });
    return { status: 'ready' };
  }

  reviewState.set(session, { status: 'running', review: null, error: null, gen });
  runAnalysis({ ctx, session, review, diff, gen }).catch(function unexpected(err) {
    log('review.analysis_crashed', { session, error: err?.message });
    if (claimIsLive(session, gen)) {
      reviewState.set(session, { status: 'failed', review: null, error: err?.message, gen });
    }
  });
  return { status: 'running' };
}

// A launch on a loaded box must not silently produce no analysis. startJob
// answers 503 below MIN_AVAILABLE_BYTES and 429 when the queue is full, and
// nothing is waiting on this run — so it waits the pressure out rather than
// giving up, for long enough to cover a couple of dev servers starting.
const START_RETRIES = 20;
const START_RETRY_MS = 30_000;

async function runAnalysis({ ctx, session, review, diff, gen }) {
  const { log } = ctx;

  // One retry of the model itself, and only one: the harness already injects
  // its own correction when a run answers in prose instead of calling the
  // structured-output tool, so a second failure is a real failure.
  //
  // try/finally rather than a release at each exit: there are several ways out
  // of this loop plus a throw, and an earlier version released at three of them.
  let tracked = null;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!claimIsLive(session, gen)) {
        log('review.abandoned', { session, attempt: attempt + 1 });
        return;
      }
      const reason = attempt === 0 ? null : reviewState.get(session)?.retryReason || 'no structured output';
      const prompt = buildAnalysisPrompt({ meta: review.meta, files: diff.files, retryReason: reason });

      const started = await startWithBackoff({ ctx, session, review, prompt, gen });
      if (!started) return;
      if (!started.ok) {
        reviewState.set(session, { status: 'failed', review: null, error: started.error, gen });
        return;
      }

      tracked = started.job;
      progressBySession.set(session, tracked);
      // The run is actually going now, so stop saying it is waiting for the
      // box. Without this the strip keeps reporting memory pressure that has
      // already passed, for the whole ten minutes of the run.
      const queued = reviewState.get(session);
      if (queued?.waiting && claimIsLive(session, gen)) {
        reviewState.set(session, { ...queued, waiting: null, gen });
      }
      const job = await started.job.done;

      if (job.phase === 'failed') {
        if (claimIsLive(session, gen)) {
          reviewState.set(session, { status: 'failed', review: null, error: job.error, gen });
        }
        return;
      }
      if (job.exitNote) log('review.nonzero_exit', { session, note: job.exitNote });

      const extracted = extractArtifact(job);
      if (!extracted.ok) {
        log('review.bad_output', { session, attempt: attempt + 1, reason: extracted.reason });
        // Do not re-create an entry that no longer exists: a `|| {}` here wrote
        // the review back into the map after the session was killed, so the
        // guard at the top of the next iteration passed and a second paid run
        // started for a session that had gone.
        if (!claimIsLive(session, gen)) {
          log('review.abandoned', { session, attempt: attempt + 1, stage: 'retry-reason' });
          return;
        }
        const state = reviewState.get(session);
        reviewState.set(session, { ...state, retryReason: extracted.reason, gen });
        if (attempt === 1) {
          reviewState.set(session, { status: 'failed', review: null, error: extracted.reason, gen });
          return;
        }
        continue;
      }

      if (!claimIsLive(session, gen)) {
        log('review.abandoned', { session, attempt: attempt + 1, stage: 'post-run' });
        return;
      }

      const artifact = reconcileArtifact({ artifact: extracted.artifact, files: diff.files, log });

      // Schema-valid but useless: a run can return well-formed JSON in which
      // every path is invented, and reconciliation then sweeps the real files
      // into "Not classified". That is a failed analysis, not a finished one —
      // without this it was reported ready, with no ordering and nothing to
      // say anything had gone wrong.
      if (!artifact.classified) {
        log('review.nothing_classified', { session, attempt: attempt + 1, groups: artifact.groups?.length });
        if (!claimIsLive(session, gen)) {
          log('review.abandoned', { session, attempt: attempt + 1, stage: 'unclassified' });
          return;
        }
        const state = reviewState.get(session);
        if (attempt === 0) {
          reviewState.set(session, {
            ...state, retryReason: 'none of the paths you returned were in the diff', gen,
          });
          continue;
        }
        reviewState.set(session, {
          status: 'failed',
          review: null,
          error: 'the analysis did not recognise any of the changed files',
          gen,
        });
        return;
      }

      artifact.costUsd = job.costUsd ?? null;
      artifact.generatedAt = new Date().toISOString();
      writeArtifact({ session, artifact });
      reviewState.set(session, { status: 'ready', review: artifact, error: null, gen });
      log('review.job_done', {
        session,
        headSha: review.headSha?.slice(0, 8),
        groups: artifact.groups?.length,
        architecture: artifact.architecture?.length,
        decisions: artifact.decisions?.length,
        toolCalls: job.toolCalls,
        // Kept even though the page may not show it: this is the line you read
        // when a run cost more than it should have.
        costUsd: job.costUsd,
      });
      return;
    }
  } finally {
    // Only if it is still OUR job. A session killed and a new analysis started
    // while an old run unwinds would otherwise have the old run's finally
    // delete the new run's progress, leaving the strip counter-less.
    if (tracked && progressBySession.get(session) === tracked) progressBySession.delete(session);
  }
}

/**
 * startJob, waiting out the two pressure answers.
 *
 * Nothing is blocking on the analysis, so 503 (low memory) and 429 (queue full)
 * are both conditions that pass on their own — and a launch that silently
 * produced no analysis because two dev servers happened to be booting is
 * exactly the failure this feature would never be forgiven for.
 *
 * @returns the startJob result, or null when the session went away while waiting.
 */
async function startWithBackoff({ ctx, session, review, prompt, gen }) {
  const { log } = ctx;
  for (let tries = 0; tries < START_RETRIES; tries += 1) {
    if (!claimIsLive(session, gen)) return null;
    const started = startJob({
      kind: 'analysis',
      session,
      argv: analysisArgv({ prompt }),
      cwd: review.worktree,
      log,
      onLine: onAnalysisLine,
      readMeminfo: ctx.readMeminfo,
    });
    if (started.ok) return started;
    if (started.status !== 503 && started.status !== 429) return started;

    log('review.analysis_waiting', { session, attempt: tries + 1, reason: started.error });
    // Carrying `gen` through is what keeps this run alive: an update that drops
    // it makes the very next claimIsLive() call decide the run has been
    // superseded by itself.
    const state = reviewState.get(session);
    reviewState.set(session, { ...state, waiting: started.error, gen });
    // No sleep after the last attempt — it would delay the failure and change
    // nothing.
    if (tries < START_RETRIES - 1) await delay(START_RETRY_MS);
  }
  return {
    ok: false,
    status: 503,
    error: 'the box stayed too busy to run the analysis — press Retry when something frees up',
  };
}

// --- explain ----------------------------------------------------------------

async function handleExplain(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const review = readSessionReview(session);
  if (!review) return json(res, 404, { ok: false, error: 'no review for this session' });

  const diff = readDiff(session);
  if (!diff) return json(res, 409, { ok: false, error: 'no diff stored for this session' });

  const valid = validateExplainRequest({ payload, files: diff.files });
  if (!valid.ok) {
    log('review.explain_rejected', { reqId, session, error: valid.error });
    return json(res, 400, { ok: false, error: valid.error });
  }

  const key = answerKey({
    session,
    filePath: valid.filePath,
    line: valid.endLine && valid.endLine !== valid.line ? `${valid.line}-${valid.endLine}` : valid.line,
    side: valid.side,
    question: valid.question + '\0' + valid.history.map((m) => m.text).join('\0'),
  });

  // The same question already running: join it rather than paying twice. With
  // no on-disk answer cache (see store.mjs) this is the only thing standing
  // between a page rebuild mid-question and a second billed run.
  const running = explainJobs.get(key);
  if (running && !running.cancelled && (running.phase === 'queued' || running.phase === 'running')) {
    log('review.explain_joined', { reqId, session, path: valid.filePath, line: valid.line });
    return json(res, 200, { ok: true, askId: key, status: 'running' });
  }

  const prompt = buildExplainPrompt({
    meta: review.meta, file: valid.file, filePath: valid.filePath,
    line: valid.line, endLine: valid.endLine, side: valid.side, question: valid.question, history: valid.history,
  });
  const started = startJob({
    kind: 'explain',
    session,
    argv: explainArgv({ prompt }),
    cwd: review.worktree,
    log,
    readMeminfo: ctx.readMeminfo,
  });
  if (!started.ok) return json(res, started.status, { ok: false, error: started.error });

  explainJobs.set(key, started.job);
  log('review.explain', {
    reqId, session, path: valid.filePath, line: valid.line,
    question: valid.question.slice(0, 80), jobId: started.job.jobId,
  });

  // Whatever the outcome, stop holding the job after a grace period: it carries
  // the run's full stdout, and this map previously grew for the process
  // lifetime. The delay lets a poll arriving just after completion still find
  // the outcome rather than a 404.
  started.job.done
    .then(function settled(job) {
      // The cost is logged even though the page may not show it — see
      // SHOW_COSTS. This line is what you read when a run cost more than it
      // should have, and it is the only record of an explain's price.
      const answer = job.phase === 'done' ? extractAnswer(job) : null;
      log('review.explain_done', {
        session,
        jobId: job.jobId,
        phase: job.phase,
        ms: (job.endedAt || Date.now()) - (job.startedAt || Date.now()),
        steps: answer?.steps,
        costUsd: answer?.costUsd,
        error: job.error || (answer && !answer.ok ? answer.error : undefined),
      });
      setTimeout(function forget() {
        // Only if it is still OUR job: a re-ask under the same key replaces the
        // entry, and an unconditional delete here would evict the newer run,
        // 404-ing a poll for an answer already paid for.
        if (explainJobs.get(key) === started.job) explainJobs.delete(key);
      }, EXPLAIN_JOB_TTL_MS).unref();
    })
    .catch(function neverHappens(err) {
      log('review.explain_settle_failed', { session, error: err?.message });
    });

  return json(res, 200, { ok: true, askId: key, status: 'running' });
}

function handleExplainPoll(res, ctx, session, askId) {
  const { json } = ctx;
  const job = explainJobs.get(askId);
  if (!job) return json(res, 404, { ok: false, error: 'unknown question' });
  // The key contains the session, so a mismatch should be impossible — which is
  // exactly why it is worth asserting rather than assuming. Serving one
  // session's answer to another is silent and wrong, not loud and wrong.
  if (job.session !== session) {
    return json(res, 404, { ok: false, error: 'unknown question' });
  }
  if (!job.cancelled && (job.phase === 'queued' || job.phase === 'running')) {
    return json(res, 200, { ok: true, status: 'running' });
  }
  // A cancelled job is going to fail; saying 'running' until its child closes
  // leaves the panel spinning on an answer that is not coming.
  if (job.cancelled && job.phase !== 'done') {
    return json(res, 200, { ok: true, status: 'failed', error: 'this question was cancelled' });
  }
  if (job.phase === 'failed') {
    return json(res, 200, { ok: true, status: 'failed', error: job.error });
  }

  const answer = extractAnswer(job);
  if (!answer.ok) return json(res, 200, { ok: true, status: 'failed', error: answer.error });
  // costUsd rides along and the client decides whether to show it, from
  // showCosts on the status payload. How long it took is measured here rather
  // than in extractAnswer, which only sees the run's output.
  return json(res, 200, {
    ok: true,
    status: 'ready',
    answer: { ...answer, durationMs: (job.endedAt || Date.now()) - (job.startedAt || Date.now()) },
  });
}

// --- chat -------------------------------------------------------------------

/** The askId of this session's chat turn in flight, or null. */
function chatInFlight(session) {
  const job = chatJobs.get(session);
  if (!job || job.cancelled) return null;
  return job.phase === 'queued' || job.phase === 'running' ? job.jobId : null;
}

// The transcript, plus whether a turn is still being answered — a page that
// reloads mid-answer needs the askId to pick the poll back up rather than
// showing an idle box with the question missing from it.
function handleChatRead(res, ctx, session) {
  const { json } = ctx;
  if (!readSessionReview(session)) return json(res, 404, { ok: false, error: 'no review for this session' });
  return json(res, 200, { ok: true, messages: readChat(session), running: chatInFlight(session) });
}

async function handleChat(payload, res, ctx, session) {
  const { json, log, reqId } = ctx;
  const review = readSessionReview(session);
  if (!review) return json(res, 404, { ok: false, error: 'no review for this session' });
  const diff = readDiff(session);
  if (!diff) return json(res, 409, { ok: false, error: 'no diff stored for this session' });

  const valid = validateChatRequest({ payload });
  if (!valid.ok) return json(res, 400, { ok: false, error: valid.error });

  const inFlight = chatInFlight(session);
  if (inFlight) return json(res, 409, { ok: false, error: 'still answering the previous message' });

  const prompt = buildChatPrompt({
    meta: review.meta,
    artifact: readArtifact(session),
    files: diff.files,
    history: readChat(session),
    question: valid.question,
  });
  const started = startJob({
    kind: 'chat',
    session,
    argv: explainArgv({ prompt }),
    cwd: review.worktree,
    log,
    readMeminfo: ctx.readMeminfo,
  });
  if (!started.ok) return json(res, started.status, { ok: false, error: started.error });

  const job = started.job;
  chatJobs.set(session, job);
  // Polled through the explain endpoint, which already knows how to turn a
  // finished job into an answer. The jobId is a valid askId by construction.
  explainJobs.set(job.jobId, job);
  log('review.chat', { reqId, session, question: valid.question.slice(0, 80), jobId: job.jobId });

  job.done
    .then(function settled(done) {
      const answer = done.phase === 'done' ? extractAnswer(done) : null;
      const durationMs = (done.endedAt || Date.now()) - (done.startedAt || Date.now());
      log('review.chat_done', {
        session, jobId: done.jobId, phase: done.phase, ms: durationMs,
        steps: answer?.steps, costUsd: answer?.costUsd,
        error: done.error || (answer && !answer.ok ? answer.error : undefined),
      });
      // Only a turn that was answered goes on the record. A failed one is
      // reported to the page, which hands the text back for another try;
      // writing it here would replay a question with no answer forever.
      if (answer?.ok) {
        const at = new Date().toISOString();
        appendChat({
          session,
          entries: [
            { role: 'user', text: valid.question, at },
            { role: 'assistant', text: answer.text, at, steps: answer.steps, durationMs, costUsd: answer.costUsd },
          ],
        });
      }
      setTimeout(function forget() {
        if (explainJobs.get(job.jobId) === job) explainJobs.delete(job.jobId);
        if (chatJobs.get(session) === job) chatJobs.delete(session);
      }, EXPLAIN_JOB_TTL_MS).unref();
    })
    .catch(function neverHappens(err) {
      log('review.chat_settle_failed', { session, error: err?.message });
    });

  return json(res, 200, { ok: true, askId: job.jobId, status: 'running' });
}

// --- startup ----------------------------------------------------------------

/**
 * Called once from server.mjs at boot.
 *
 * Three jobs: reap `claude -p` children the last restart orphaned (KillMode=process
 * means they outlive us), mark any session whose analysis was cut off, and
 * clear away the previous design's state.
 */
export function reviewStartupSweep(ctx) {
  if (DISABLED) return;
  const { log, readProcTable } = ctx;

  // Which sessions were mid-run has to be read BEFORE the sweep, because
  // reaping an orphan clears its breadcrumb — checking afterwards would find
  // nothing and report a genuinely interrupted review as merely unknown.
  //
  // Inside the try, because readJson deliberately rethrows anything that is not
  // a missing or corrupt file. This runs in the server.listen callback, where
  // nothing catches and the unit restarts on failure, so one unreadable
  // breadcrumb must not be able to crash-loop the shed.
  let interrupted = [];
  try {
    interrupted = listReviewSessions().filter(hasJobBreadcrumb);
    const orphans = sweepOrphans({ log, readProcTable });
    if (orphans) log('review.sweep', { orphansKilled: orphans });
  } catch (err) {
    log('review.sweep_failed', { error: err?.message });
  }

  for (const session of interrupted) {
    if (reviewState.has(session)) continue;
    reviewState.set(session, { status: 'interrupted', review: null, error: null });
  }

  migrateLegacyState(ctx).catch(function failed(err) {
    log('review.migrate_failed', { error: err?.message });
  });
}

/**
 * Delete everything the PR-keyed design left on disk and in the repo.
 *
 * It has to exist, and it has to run unconditionally at boot. The old feature
 * kept `refs/bridge-review/<n>` refs and `$REVIEWS_DIR/pr-<n>` worktrees alive
 * on a 7-day TTL / 8-entry LRU, and this change deletes both the TTL and the
 * LRU — so without a migration that state is stranded forever: 130 MB per
 * checkout, plus a ref pinning an entire pull request head's objects, with
 * nothing left in the codebase that so much as knows the names.
 *
 * Idempotent by construction — after the first run there are no refs to list
 * and no directories to match — so there is no "have I run yet" flag to get
 * wrong.
 */
async function migrateLegacyState(ctx) {
  const { log, repoRoot, removeWorktree } = ctx;

  let refsDeleted = 0;
  for (const ref of await legacyReviewRefs(repoRoot)) {
    if (await deleteLegacyRef({ repoRoot, ref })) refsDeleted += 1;
  }

  let pathsRemoved = 0;
  for (const entry of legacyStatePaths()) {
    // A `pr-<n>` directory was a registered worktree: deleting it without
    // telling git leaves an admin entry behind that makes a future `worktree
    // add` on that path refuse permanently. Scoped to the one path on purpose —
    // `git worktree prune` would reach across the dozens of live session
    // worktrees this repo has registered.
    if (entry.isCheckout) {
      await removeReviewWorktree({
        repoRoot, worktreePath: entry.path, branchName: null, removeWorktree,
      });
    } else {
      try {
        fs.rmSync(entry.path, { recursive: true, force: true });
      } catch (err) {
        log('review.migrate_path_failed', { path: entry.path, error: err?.message });
        continue;
      }
    }
    pathsRemoved += 1;
  }

  if (refsDeleted || pathsRemoved) {
    log('review.migrated', { refsDeleted, pathsRemoved });
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * Strip the pull request body on its way to a browser.
 *
 * The page's Discussion tab shows the description, but reads it live from
 * GitHub with the comments, so this recorded copy — the one written when the
 * review was taken — has no use there, and the smaller the untrusted surface
 * reaching a browser the better. It cannot simply be left out
 * of the record, which is where master's version of this went wrong: the
 * analysis prompt reads it back off disk (analyze.mjs), so the record needs it
 * and only the wire does not. Dropping it here rather than at the point the
 * record is built is what keeps those two facts from being one decision.
 *
 * Exported only so a test can hold it to that: the field was excluded on
 * master, reintroduced by this feature's rework, and caught in review. Once
 * is an accident.
 */
export function onTheWire(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const { body, ...rest } = meta;
  return rest;
}

// Only what the page needs, plus the body that the analysis prompt reads back
// off the record. onTheWire() removes it again before any of this is served.
function publicPrMeta(meta, headSha) {
  return {
    number: meta.number,
    title: meta.title,
    body: meta.body,
    author: meta.author ? { login: meta.author.login } : null,
    headRefName: meta.headRefName,
    headRefOid: headSha,
    baseRefName: meta.baseRefName,
    state: meta.state,
    url: meta.url,
    isDraft: !!meta.isDraft,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
  };
}

/**
 * The same shape, for a branch that has no pull request behind it.
 *
 * additions/deletions/changedFiles come from `gh pr view` for a pull request
 * and have no `gh` source at all here, so they are counted off the parsed diff
 * — which is what the page renders anyway, and therefore the number that
 * cannot disagree with what is on screen.
 */
/**
 * The header for a worktree review. No GitHub behind it, so every field is
 * derived from the tree itself.
 *
 * `state: 'WORKTREE'` rather than 'BRANCH' because the page has to be able to
 * tell them apart: a branch review is a fixed commit, this is a tree someone
 * is still typing into, and saying so is the single most useful thing the
 * header can do.
 */
function worktreeMeta({ baseRef, state, diff, headSha }) {
  let additions = 0;
  let deletions = 0;
  for (const file of diff.files || []) {
    additions += file.additions || 0;
    deletions += file.deletions || 0;
  }
  const parts = [];
  if (state.commits) parts.push(`${state.commits} commit${state.commits === 1 ? '' : 's'}`);
  if (state.dirtyFiles) parts.push(`${state.dirtyFiles} uncommitted file${state.dirtyFiles === 1 ? '' : 's'}`);
  return {
    number: null,
    title: `Work in progress on ${state.branch || 'this worktree'}`,
    // Not a description so much as the one thing a reader needs to calibrate
    // on: how much of this is committed and how much is still loose.
    body: parts.length ? `This worktree is ${parts.join(' and ')} ahead of ${baseRef}.` : '',
    author: null,
    headRefName: state.branch || 'worktree',
    headRefOid: headSha,
    baseRefName: baseRef,
    state: 'WORKTREE',
    url: null,
    isDraft: false,
    additions,
    deletions,
    changedFiles: (diff.files || []).length,
    // On meta rather than only in `body`, because onTheWire strips the body
    // and the page needs these: they are what tells a reader this is a
    // snapshot of something still moving.
    commits: state.commits,
    dirtyFiles: state.dirtyFiles,
  };
}

async function branchMeta({ repoRoot, target, baseRef, headSha, diff }) {
  let additions = 0;
  let deletions = 0;
  for (const file of diff.files || []) {
    additions += file.additions || 0;
    deletions += file.deletions || 0;
  }
  const subject = await commitSubject({ repoRoot, headSha });
  return {
    number: null,
    title: subject || target.branch,
    body: '',
    author: null,
    headRefName: target.branch,
    headRefOid: headSha,
    baseRefName: baseRef,
    state: 'BRANCH',
    url: null,
    isDraft: false,
    additions,
    deletions,
    changedFiles: (diff.files || []).length,
  };
}

/**
 * Read and parse a JSON body, answering the client directly on failure.
 * Returns {ok:false} once a response has been sent.
 */
async function readJsonBody(req, res, ctx) {
  try {
    return { ok: true, payload: JSON.parse(await readRequestBody(req)) };
  } catch (err) {
    if (err.tooLarge) {
      ctx.json(res, 413, { ok: false, error: 'request body too large' });
    } else if (err.timedOut) {
      ctx.json(res, 408, { ok: false, error: 'timed out reading the request body' });
    } else {
      ctx.json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    return { ok: false };
  }
}

const MAX_BODY_BYTES = 64 * 1024;
// A body that never finishes arriving must not tie anything up indefinitely.
const BODY_TIMEOUT_MS = 15_000;

function readRequestBody(req) {
  return new Promise(function collect(resolve, reject) {
    // Same reason as exec.mjs: a question containing a multi-byte character
    // must not be corrupted by where the chunks happen to fall.
    req.setEncoding('utf-8');
    let body = '';
    // Once we have decided to reject, stop accumulating — but do NOT destroy
    // the socket. Destroying races the 413/408 write and the caller gets a
    // bare dropped connection instead of a status.
    let done = false;
    const timer = setTimeout(function tooSlow() {
      const err = new Error('timed out reading the request body');
      err.timedOut = true;
      done = true;
      reject(err);
    }, BODY_TIMEOUT_MS);
    req.on('data', function onChunk(chunk) {
      if (done) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        done = true;
        clearTimeout(timer);
        const err = new Error('request body too large');
        err.tooLarge = true;
        reject(err);
      }
    });
    req.on('end', function onEnd() {
      if (done) return;
      clearTimeout(timer);
      resolve(body);
    });
    req.on('error', function onError(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}
