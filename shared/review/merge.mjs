// Merging a pull request from the review page: straight in, or through the
// merge queue when its base branch has one.
//
// Its own file rather than more of github.mjs because it is the one write here
// that cannot be taken back from the page, and the rules for when it is allowed
// are the part worth reading on their own. They live in `mergeBlocker`, a pure
// function, so the refusals are tested without a `gh` in sight.
//
// The rules, all checked against a fresh `gh pr view` taken right before the
// merge rather than prStatus's cache, which can be minutes old:
//
// - The pull request is open, not a draft, and approved.
// - Its head is the commit this review read, and for a worktree review there
//   were no uncommitted files in what was read. Anything pushed since has not been
//   on this page, so the answer is Re-review, not merge. The same sha then goes
//   to GitHub with the merge (`sha`) or the enqueue (`expectedHeadOid`), which
//   closes the gap between this check and the write: GitHub refuses if the
//   head moved in between.
// - It is not already in the merge queue.
// - Every check has finished and none failed. A repo may require no checks, or
//   only a queue gate that passes on the pull request without running, so
//   GitHub would merge or queue on red; this is the only thing that will not.
// - GitHub does not report a conflict or a block.
//
// Which write it is comes from GitHub, per pull request: a base branch with a
// merge queue refuses the direct merge endpoint with a 405, so there the page
// enqueues and GitHub merges later, under its own commit title, once the
// queue's checks pass. Anywhere else it squash-merges at once with the title
// typed on the page. Never `--admin`, and no bypass: an admin override is not
// something a page on the tailnet should be able to ask for.

import { run } from './exec.mjs';
import { reduceChecks } from '../prStatus.mjs';

const GH_TIMEOUT_MS = 30_000;

const ENQUEUE_MUTATION = `mutation($pr: ID!, $sha: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $pr, expectedHeadOid: $sha}) { mergeQueueEntry { position } }
}`;
// Asked apart from `gh pr view` because the gh on the box (2.45) has neither
// field.
const QUEUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { isMergeQueueEnabled isInMergeQueue } }
}`;
// GitHub's own cap on a commit subject is looser; this matches the title rule
// in setPrTitle, which is what a squash subject starts as.
const MAX_SUBJECT_CHARS = 256;

/**
 * What GitHub says about the pull request right now, reduced to what the
 * merge rules read.
 *
 * @returns {Promise<{ok: true, readiness: object} | {ok: false, status: number, error: string}>}
 */
export async function fetchMergeReadiness({ pr, slug }) {
  const result = await run(
    'gh',
    [
      'pr', 'view', String(pr), '--repo', slug,
      '--json', 'id,number,title,state,isDraft,reviewDecision,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup',
    ],
    { timeoutMs: GH_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    return { ok: false, status: 502, error: `gh pr view failed: ${stderr.slice(0, 200) || `exit ${result.status}`}` };
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout || '{}');
  } catch (err) {
    return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
  }
  const queue = await fetchQueueState({ pr, slug });
  if (!queue.ok) return queue;
  return { ok: true, readiness: describeReadiness({ ...raw, ...queue.state }) };
}

async function fetchQueueState({ pr, slug }) {
  const [owner, name] = slug.split('/');
  const result = await run(
    'gh',
    [
      'api', 'graphql', '-f', `query=${QUEUE_QUERY}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(pr)}`,
      '--jq', '.data.repository.pullRequest',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  let state = null;
  try {
    state = JSON.parse(result.stdout || 'null');
  } catch {
    // Falls through to the refusal below, with gh's stderr.
  }
  // Unknown is a refusal, not "no queue": guessing wrong either way is a 405
  // or an enqueue on a repo that has none.
  if (result.status !== 0 || typeof state?.isMergeQueueEnabled !== 'boolean') {
    const stderr = (result.stderr || '').toString().trim();
    return { ok: false, status: 502, error: `could not read the merge queue: ${stderr.slice(0, 200) || `exit ${result.status}`}` };
  }
  return { ok: true, state };
}

/** The `gh pr view` record, plus the two queue fields, reduced. Exported for the tests. */
export function describeReadiness(raw) {
  const checks = reduceChecks(raw?.statusCheckRollup);
  return {
    nodeId: typeof raw?.id === 'string' && raw.id ? raw.id : null,
    number: Number(raw?.number) || null,
    title: typeof raw?.title === 'string' ? raw.title : '',
    state: String(raw?.state || '').toUpperCase(),
    isDraft: !!raw?.isDraft,
    reviewDecision: String(raw?.reviewDecision || '').toUpperCase(),
    headSha: /^[0-9a-f]{7,64}$/.test(String(raw?.headRefOid || '')) ? raw.headRefOid : null,
    baseRef: typeof raw?.baseRefName === 'string' ? raw.baseRefName : '',
    mergeState: String(raw?.mergeStateStatus || '').toUpperCase(),
    checks: checks.total ? checks : null,
    mergeQueue: !!raw?.isMergeQueueEnabled,
    queued: !!raw?.isInMergeQueue,
  };
}

/**
 * Why this pull request may not be merged from the page, or null when it may.
 *
 * `code` is what the page keys its wording and its next step on; `error` is
 * the sentence a person reads.
 *
 * @returns {{code: string, error: string} | null}
 */
export function mergeBlocker({ readiness, reviewedSha, uncommittedFiles = 0 }) {
  const r = readiness;
  if (r.state === 'MERGED') return { code: 'merged', error: 'this pull request is already merged' };
  if (r.state !== 'OPEN') return { code: 'closed', error: 'this pull request is closed' };
  if (r.queued) return { code: 'queued', error: 'this pull request is already in the merge queue' };
  if (r.isDraft) return { code: 'draft', error: 'this pull request is a draft' };
  if (r.reviewDecision !== 'APPROVED') return { code: 'unapproved', error: 'this pull request has not been approved' };
  // A missing sha on either side is a refusal, not a pass: "could not tell
  // whether the head moved" must not read as "it did not".
  if (!r.headSha || !reviewedSha || r.headSha !== reviewedSha) {
    return { code: 'moved', error: 'there are new commits since this review' };
  }
  // A worktree review read the working tree, and `reviewedSha` is only its
  // HEAD, so uncommitted files were on the page but are not in the pull
  // request. Unknown counts as dirty, for the same reason as the sha above.
  if (uncommittedFiles !== 0) {
    return { code: 'uncommitted', error: 'this review read uncommitted changes that are not in the pull request' };
  }
  if (r.checks?.fail) {
    return { code: 'checks-failing', error: `${r.checks.fail} of ${r.checks.total} checks failing` };
  }
  if (r.checks?.pending) {
    return { code: 'checks-running', error: `${r.checks.pending} of ${r.checks.total} checks still running` };
  }
  if (r.mergeState === 'DIRTY') {
    return { code: 'conflicts', error: `this branch has conflicts with ${r.baseRef || 'its base'}` };
  }
  if (r.mergeState === 'BLOCKED') {
    return { code: 'blocked', error: 'GitHub is blocking this merge: a branch rule is not met' };
  }
  return null;
}

/**
 * The argv for the merge. Every value goes through `-f`, never `-F`: the
 * subject is typed on the page, and `-F subject=@/some/file` would have `gh`
 * read that file and send it to GitHub (see github.test.mjs).
 */
export function mergeArgv({ pr, slug, headSha, subject }) {
  return [
    'api', '-X', 'PUT', `repos/${slug}/pulls/${pr}/merge`,
    '-f', 'merge_method=squash',
    '-f', `sha=${headSha}`,
    '-f', `commit_title=${subject}`,
    '--jq', '.sha',
  ];
}

/**
 * Squash-merge at exactly `headSha`.
 *
 * @returns {Promise<{ok: true, sha: string} | {ok: false, status: number, code?: string, error: string}>}
 */
export async function mergePr({ pr, slug, headSha, subject }) {
  const text = typeof subject === 'string' ? subject.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'the commit needs a title' };
  if (text.length > MAX_SUBJECT_CHARS) {
    return { ok: false, status: 400, error: `that title is too long (${text.length} characters, limit ${MAX_SUBJECT_CHARS})` };
  }
  if (/[\r\n]/.test(text)) return { ok: false, status: 400, error: 'the commit title has to be one line' };

  const result = await run('gh', mergeArgv({ pr, slug, headSha, subject: text }), { timeoutMs: GH_TIMEOUT_MS });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    // The race the pre-check cannot close: a push between it and this call.
    if (/HTTP 409/.test(stderr)) {
      return { ok: false, status: 409, code: 'moved', error: 'new commits arrived while you were merging' };
    }
    return { ok: false, status: 502, error: `the merge failed: ${stderr.slice(0, 300) || `exit ${result.status}`}` };
  }
  return { ok: true, sha: (result.stdout || '').trim() };
}

/**
 * The argv for the enqueue. `expectedHeadOid` is what makes GitHub refuse a
 * head that moved after the page's check, so it is never optional.
 */
export function enqueueArgv({ nodeId, headSha }) {
  return [
    'api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`,
    '-f', `pr=${nodeId}`,
    '-f', `sha=${headSha}`,
    '--jq', '.data.enqueuePullRequest.mergeQueueEntry.position',
  ];
}

/**
 * Add the pull request to the merge queue, at exactly `headSha`.
 *
 * @returns {Promise<{ok: true, position: number | null} | {ok: false, status: number, code?: string, error: string}>}
 */
export async function enqueuePr({ nodeId, headSha }) {
  if (!nodeId) return { ok: false, status: 502, error: 'GitHub did not say which pull request this is' };
  const result = await run('gh', enqueueArgv({ nodeId, headSha }), { timeoutMs: GH_TIMEOUT_MS });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    // The race the pre-check cannot close: a push between it and this call.
    if (/expected head/i.test(stderr)) {
      return { ok: false, status: 409, code: 'moved', error: 'new commits arrived while you were merging' };
    }
    return { ok: false, status: 502, error: `adding to the merge queue failed: ${stderr.slice(0, 300) || `exit ${result.status}`}` };
  }
  const position = Number((result.stdout || '').toString().trim());
  return { ok: true, position: Number.isFinite(position) && position > 0 ? position : null };
}
