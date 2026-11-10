// Everything that talks to GitHub, via the `gh` CLI already installed and
// authenticated on the box.
//
// Every call is spawn(binary, [argv]) via exec.mjs — no shell is constructed
// anywhere here, which is why server.mjs's `shQuote` is deliberately
// unused here. `shQuote` exists for tmux's `new-session <command>` string,
// which really is handed to /bin/sh; there is no equivalent on this path.
// A PR identifier is still validated down to an integer before it reaches
// argv, because "no shell" protects against injection, not against `gh`
// receiving an argument that means something other than a PR number.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from './exec.mjs';

const GH_TIMEOUT_MS = 30_000;
// The three things a review can say, and nothing else reaches argv. A map
// rather than a check-then-interpolate, so an unknown action cannot become a
// flag.
const REVIEW_EVENTS = {
  comment: '--comment',
  approve: '--approve',
  'request-changes': '--request-changes',
};
// Bytes, not characters, because what breaks is an execve argument and Linux
// measures that in bytes: MAX_ARG_STRLEN is 128 KiB. A 60,000-CHARACTER limit
// looked safe and was not — 60,000 CJK characters is 180,000 bytes, well over
// the cap, and the failure arrives as a spawn error rather than as anything a
// reader could act on.
//
// submitPrReview dodges this by writing the body to a file; every other write
// here passes it in argv, so this is what stands between them and that. Still
// well past any real review comment.
const MAX_BODY_BYTES = 60_000;

/** The one measure that matters for something about to become an argv entry. */
function tooLong(text) {
  return Buffer.byteLength(text, 'utf-8') > MAX_BODY_BYTES;
}

function tooLongError(text) {
  return {
    ok: false,
    status: 400,
    error: `that comment is too long (${Buffer.byteLength(text, 'utf-8')} bytes, limit ${MAX_BODY_BYTES})`,
  };
}
// GitHub's own PR numbers are small; this only exists so a pasted phone number
// or a timestamp is rejected as input rather than as a 404 thirty seconds later.
const MAX_PR_NUMBER = 999_999;

/**
 * Accepts `123`, `#123`, or a github.com PR URL. Everything else is refused.
 *
 * @returns {{ok: true, pr: number, slug: string|null} | {ok: false, error: string}}
 */
export function parsePrIdentifier(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'a pull request number or URL is required' };
  }
  // Only a string or a number. Without this, String() quietly flattens an
  // array — `{"pr": [23792]}` coerced to "23792" and was accepted. Nothing
  // unsafe reached a subprocess (the regexes below still reduce it to an
  // integer), but silently accepting a shape the API does not document is how
  // the next validation gap gets missed.
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, error: 'a pull request must be given as a number or a string' };
  }
  const input = String(raw).trim();
  if (!input) return { ok: false, error: 'a pull request number or URL is required' };
  if (input.length > 300) return { ok: false, error: 'that does not look like a pull request' };

  const bare = /^#?(\d{1,7})$/.exec(input);
  if (bare) return checkNumber(parseInt(bare[1], 10), null);

  const url = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d{1,7})(?:[/?#].*)?$/.exec(
    input,
  );
  if (url) return checkNumber(parseInt(url[2], 10), url[1]);

  return {
    ok: false,
    error: 'expected a pull request number (e.g. 23792) or a github.com pull request URL',
  };
}

function checkNumber(pr, slug) {
  if (!Number.isSafeInteger(pr) || pr < 1) return { ok: false, error: 'invalid pull request number' };
  if (pr > MAX_PR_NUMBER) return { ok: false, error: `pull request number out of range (max ${MAX_PR_NUMBER})` };
  return { ok: true, pr, slug };
}

let accountCache;

/**
 * Which GitHub account `gh` on this box acts as.
 *
 * Resolved once and kept, like the origin slug: the box is signed in as one
 * account and stays that way. Worth naming rather than describing, because
 * the sentence it appears in is the last thing read before something is
 * posted publicly, and "whichever account gh is signed in as" asks the reader
 * to go and find out at exactly the moment they should not have to.
 *
 * A failure is not cached. A `gh` that cannot answer now may answer after the
 * next login, and pinning "unknown" until a restart is worse than asking
 * again.
 */
export async function ghAccount() {
  if (accountCache !== undefined) return accountCache;
  const result = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS });
  if (result.status !== 0) return null;
  const login = (result.stdout || '').trim();
  // GitHub's own rule for a login, so nothing shaped like anything else can
  // reach the page as a name.
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  accountCache = login;
  return accountCache;
}

let originCache;

/**
 * `owner/repo` for the checkout the shed serves. Resolved once — the origin
 * of a long-lived box does not change under us, and every request would
 * otherwise pay for a git invocation.
 */
export async function originSlug(repoRoot) {
  if (originCache !== undefined) return originCache;
  const result = await run('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
    timeoutMs: GH_TIMEOUT_MS,
  });
  const url = (result.stdout || '').trim();
  // Both forms the remote can take: https://github.com/owner/repo.git and
  // git@github.com:owner/repo.git. The .git suffix has to come off or the
  // pasted-URL comparison never matches and `gh --repo` 404s.
  const m = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
  // Only a success is cached. Caching the failure would pin every subsequent
  // request to "could not determine this box's repository" until a restart,
  // off the back of one timed-out git call.
  if (!m) return null;
  originCache = m[1];
  return originCache;
}

/**
 * PR metadata. `files` is GitHub's own accounting, kept so the parsed diff can
 * be checked against it rather than trusted.
 *
 * @returns {{ok: true, meta: object} | {ok: false, status: number, error: string}}
 */
export async function fetchPrMeta({ pr, slug }) {
  const result = await run(
    'gh',
    [
      'pr', 'view', String(pr),
      '--repo', slug,
      '--json', 'number,title,body,author,headRefName,headRefOid,baseRefName,isCrossRepository,state,url,isDraft,additions,deletions,changedFiles,files',
    ],
    { timeoutMs: GH_TIMEOUT_MS, maxBytes: 16 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString();
    // `gh` says "no pull requests found" / "Could not resolve" for a PR that
    // does not exist; anything else is an auth or network problem, and the two
    // deserve different status codes because only one is the caller's fault.
    const missing = /not found|no pull requests|could not resolve/i.test(stderr);
    return {
      ok: false,
      status: missing ? 404 : 502,
      error: missing
        ? `pull request #${pr} not found in ${slug}`
        : `gh pr view failed: ${stderr.trim().slice(0, 200) || `exit ${result.status}`}`,
    };
  }

  let meta;
  try {
    meta = JSON.parse(result.stdout || '{}');
  } catch (err) {
    return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
  }
  // The head SHA becomes both a filename component and the final argv of
  // `git checkout --detach <sha>`, where a value starting with `-` would be
  // read as an option. GitHub controls this field, so this is defence in
  // depth — but it is the only unvalidated string on the whole argv path.
  if (!/^[0-9a-f]{7,64}$/.test(String(meta.headRefOid || ''))) {
    return { ok: false, status: 502, error: 'gh returned no usable head SHA for this pull request' };
  }
  return { ok: true, meta };
}

// GitHub's own cap. Enforced here so an over-long title is refused with a
// sentence rather than by the API with a 422.
const MAX_TITLE_CHARS = 256;

/**
 * Rename a pull request.
 *
 * `gh pr edit` is the obvious call and is not used: it has been unreliable on
 * this box, and the REST PATCH is one request with nothing to interpret. The
 * title goes through `-f`, never `-F`, for the reason github.test.mjs exists.
 *
 * @returns {Promise<{ok: true, title: string} | {ok: false, status: number, error: string}>}
 */
export async function setPrTitle({ pr, slug, title }) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'a pull request needs a title' };
  if (text.length > MAX_TITLE_CHARS) {
    return { ok: false, status: 400, error: `that title is too long (${text.length} characters, limit ${MAX_TITLE_CHARS})` };
  }
  // A newline in a title is silently flattened by GitHub, so it is refused
  // here instead: a reader who pasted two lines should be told, not have one
  // of them quietly disappear.
  if (/[\r\n]/.test(text)) {
    return { ok: false, status: 400, error: 'a title has to be one line' };
  }

  const result = await run(
    'gh',
    ['api', '-X', 'PATCH', `repos/${slug}/pulls/${pr}`, '-f', `title=${text}`, '--jq', '.title'],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    return {
      ok: false,
      status: 502,
      error: `renaming the pull request failed: ${stderr.slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  return { ok: true, title: (result.stdout || '').trim() || text };
}

// --- pending review comments ------------------------------------------------
//
// GitHub's "Start a review": line comments that sit as a draft until you
// submit them all as one review. The draft is GitHub's own, not a note this
// page keeps — the same argument as the Viewed tick. A comment written here
// shows up in GitHub's review UI immediately, and one written there shows up
// here, because there is only ever one of them.
//
// Every viewer has at most one pending review per pull request, which is why
// `reviews(states: PENDING)` needs no filtering by author: it is already
// scoped to whoever `gh` is signed in as.

// Two selections, and both are needed.
//
// reviews(states:PENDING) is the viewer's own draft — the ids to add to, to
// delete from and to submit. reviewThreads is EVERY conversation on the pull
// request, the viewer's drafts among them, which is what the page draws: a
// page that showed only your unsent comments would hide every comment already
// on the pull request, including the ones that are the reason to be reading it.
//
// The threads also carry which SIDE of the diff a comment is on, which the
// comment itself does not: PullRequestReviewComment has line, originalLine,
// startLine and originalStartLine and no side at all. Without it a comment
// written on a deleted line is drawn beside the added one that replaced it,
// which is the wrong row and looks confident.
const PENDING_QUERY = `query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      id
      headRefOid
      body
      bodyHTML
      author{ login }
      createdAt
      url
      reviews(first:1,states:PENDING){
        nodes{
          id
          comments(first:100){
            nodes{ id path line originalLine body }
          }
        }
      }
      verdicts: reviews(first:30,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){
        nodes{ id author{ login } state body url submittedAt isMinimized viewerDidAuthor }
      }
      comments(first:30){
        nodes{ id fullDatabaseId author{ login } body url createdAt isMinimized viewerCanDelete viewerDidAuthor }
      }
      reviewThreads(first:100){
        pageInfo{ hasNextPage }
        nodes{
          id path diffSide line startLine isResolved isOutdated
          comments(first:50){
            pageInfo{ hasNextPage }
            nodes{ id fullDatabaseId author{ login } body state url createdAt viewerCanDelete viewerDidAuthor }
          }
        }
      }
    }
  }
}`;

/**
 * Everything the page needs about conversations on this pull request: the
 * viewer's own draft, and every thread anyone has left on the diff.
 *
 * @returns {Promise<{ok: true, prId: string, headSha: string|null, reviewId: string|null,
 *   comments: object[], threads: object[]} | {ok: false, status: number, error: string}>}
 */
export async function fetchReviewState({ pr, slug }) {
  const [owner, repo] = String(slug).split('/');
  const result = await run(
    'gh',
    graphqlArgv({ query: PENDING_QUERY, strings: { owner, repo }, numbers: { pr } }),
    { timeoutMs: GH_TIMEOUT_MS },
  );
  const read = readGraphql(result);
  if (!read.ok) return read;

  const node = read.data?.repository?.pullRequest;
  if (!node) return { ok: false, status: 404, error: `pull request #${pr} not found in ${slug}` };
  const review = (node.reviews?.nodes || [])[0] || null;
  const threadById = new Map();
  const threads = [];
  // Outdated threads are counted, not carried. A thread goes outdated when
  // the code it was written about has moved, so what it says is advice about
  // a diff that no longer exists — this page watched one ask for a tooltip
  // fix that had already been made two commits earlier. GitHub folds them
  // away behind "Show outdated" for the same reason; here they stay on
  // GitHub, and the page says how many it left there.
  let outdated = 0;
  // One page of each, which is plenty for any pull request a person is going
  // to sit and read. Not paginating is a choice; showing part of a
  // conversation as though it were the whole one is not. Where the cap is
  // reached the page is told, and says so.
  let truncated = !!node.reviewThreads?.pageInfo?.hasNextPage;
  for (const raw of node.reviewThreads?.nodes || []) {
    const first = (raw.comments?.nodes || [])[0];
    const side = raw.diffSide === 'LEFT' ? 'old' : 'new';
    // The side map is built from every thread, outdated ones included: a
    // pending comment of the viewer's is matched against it by id, and
    // dropping an entry here would put that comment on the wrong row.
    if (first) threadById.set(first.id, { side, startLine: raw.startLine ?? null });
    if (raw.isOutdated || raw.line === null || raw.line === undefined) {
      outdated += 1;
      continue;
    }
    // `line` is a number by the time we get here: a thread whose line has
    // gone null is outdated, and that was counted and skipped above.
    threads.push({
      id: raw.id,
      path: raw.path,
      line: raw.line,
      startLine: raw.startLine ?? null,
      side,
      resolved: !!raw.isResolved,
      more: !!raw.comments?.pageInfo?.hasNextPage,
      comments: (raw.comments?.nodes || []).map(function shapeOne(c) {
        return {
          id: c.id,
          // The REST id, which is what deleting a PUBLISHED comment needs —
          // the GraphQL mutation only takes a pending one. Comes back as a
          // string because it does not fit a GraphQL Int.
          restId: c.fullDatabaseId === null || c.fullDatabaseId === undefined ? null : String(c.fullDatabaseId),
          author: c.author?.login || 'someone',
          body: c.body || '',
          // PENDING is this account's unsent draft; anything else is on the
          // pull request for everyone to read.
          pending: c.state === 'PENDING',
          // GitHub's own answer, rather than this page comparing login names
          // and guessing: a repository admin can delete comments they did not
          // write, and an author whose comment has replies sometimes cannot.
          canDelete: !!c.viewerCanDelete,
          mine: !!c.viewerDidAuthor,
          url: c.url || null,
        };
      }),
    });
    if (raw.comments?.pageInfo?.hasNextPage) truncated = true;
  }
  // What was said about the change as a whole rather than about a line: a
  // submitted review's own body, and the plain comments on the pull request.
  //
  // A review with no body is left out. Its line comments are already drawn
  // beside the code they are about, so an entry here saying only that
  // somebody reviewed something would be a row with nothing in it.
  const said = [];
  for (const v of node.verdicts?.nodes || []) {
    const body = (v.body || '').trim();
    // Minimised means someone hid it on GitHub as outdated or off-topic.
    // Drawing it here would put back what they took down.
    if (!body || v.isMinimized) continue;
    said.push({
      id: v.id,
      kind: 'review',
      author: v.author?.login || 'someone',
      state: String(v.state || '').toLowerCase(),
      body,
      url: v.url || null,
      at: v.submittedAt || null,
      mine: !!v.viewerDidAuthor,
      // Never. A submitted review cannot be deleted, whatever GitHub's
      // viewerCanDelete says — measured on the box:
      //   addPullRequestReview(event: COMMENT) -> viewerCanDelete: true
      //   deletePullRequestReview             -> UNPROCESSABLE,
      //     "Can not delete a non-pending pull request review"
      // So that field is not read here, and no Delete is offered for one.
      restId: null,
      canDelete: false,
    });
  }
  for (const c of node.comments?.nodes || []) {
    const body = (c.body || '').trim();
    if (!body || c.isMinimized) continue;
    said.push({
      id: c.id,
      kind: 'comment',
      author: c.author?.login || 'someone',
      state: null,
      body,
      url: c.url || null,
      at: c.createdAt || null,
      mine: !!c.viewerDidAuthor,
      restId: c.fullDatabaseId === null || c.fullDatabaseId === undefined ? null : String(c.fullDatabaseId),
      // Here GitHub's answer holds: an issue comment really is deletable.
      canDelete: !!c.viewerCanDelete,
    });
  }
  // Oldest first, the order a conversation happened in. A null timestamp
  // sorts last rather than first, so a missing one cannot reorder the rest.
  said.sort(function byTime(a, b) {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  });

  const comments = ((review?.comments?.nodes) || []).map(function shape(c) {
    return {
      id: c.id,
      path: c.path,
      // `line` is null once the comment is outdated — the diff moved under it.
      // originalLine is where it was written, which is the only number this
      // page can still put it next to.
      line: c.line === null || c.line === undefined ? c.originalLine : c.line,
      side: threadById.get(c.id)?.side || 'new',
      startLine: threadById.get(c.id)?.startLine ?? null,
      outdated: c.line === null || c.line === undefined,
      body: c.body || '',
    };
  });
  return {
    ok: true,
    prId: node.id,
    headSha: node.headRefOid || null,
    reviewId: review ? review.id : null,
    // Read live rather than off the review record, so an edit on GitHub shows
    // on the next load, and so a worktree review whose branch was opened as a
    // pull request later has one at all.
    description: {
      author: node.author?.login || 'someone',
      body: (node.body || '').trim(),
      // GitHub's own rendering, which is the only way to show an image on a
      // private repository: its links come back signed for about five
      // minutes, where the markdown's point at github.com and need a login
      // cookie a cross-site image request does not carry. The page rebuilds
      // it through an allowlist rather than inserting it.
      html: node.bodyHTML || '',
      at: node.createdAt || null,
      url: node.url || null,
    },
    comments,
    threads,
    outdated,
    said,
    truncated,
  };
}

const START_REVIEW = `mutation($id:ID!){ addPullRequestReview(input:{pullRequestId:$id}){ pullRequestReview{ id } } }`;
// Two shapes, because startLine is not nullable in the way a single mutation
// could paper over: passing it as null makes GitHub read the comment as a span
// of one and reject it. A comment on one line and a comment on several are
// genuinely different requests.
const ADD_THREAD = `mutation($r:ID!,$p:String!,$l:Int!,$s:DiffSide!,$b:String!){
  addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,line:$l,side:$s,body:$b}){
    thread{ diffSide startLine comments(first:1){ nodes{ id path line originalLine body } } }
  }
}`;
const ADD_THREAD_SPAN = `mutation($r:ID!,$p:String!,$l:Int!,$sl:Int!,$s:DiffSide!,$b:String!){
  addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,line:$l,startLine:$sl,side:$s,startSide:$s,body:$b}){
    thread{ diffSide startLine comments(first:1){ nodes{ id path line originalLine body } } }
  }
}`;

/**
 * Add one line comment to the draft, starting the draft if there is not one.
 *
 * Two calls in the cold case rather than one combined mutation: addPullRequest
 * Review can take comments inline, but only at creation, so the second and
 * every later comment would need this path anyway. One code path that always
 * works beats a fast path that covers the first comment only.
 */
export async function addPendingComment({ prId, reviewId, path: filePath, line, startLine, side, body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'a comment needs something written in it' };
  if (tooLong(text)) return tooLongError(text);
  const lineNo = Number(line);
  if (!Number.isSafeInteger(lineNo) || lineNo < 1) {
    return { ok: false, status: 400, error: 'a comment needs a line to hang on' };
  }
  // A span, when the reviewer picked one out. A start equal to the end is the
  // single-line case and takes the single-line mutation.
  let startNo = null;
  if (startLine !== null && startLine !== undefined && startLine !== '') {
    const parsed = Number(startLine);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return { ok: false, status: 400, error: 'that is not a line number' };
    }
    if (parsed < lineNo) startNo = parsed;
  }

  let review = reviewId;
  if (!review) {
    const started = await run('gh', graphqlArgv({ query: START_REVIEW, strings: { id: prId } }), { timeoutMs: GH_TIMEOUT_MS });
    const read = readGraphql(started);
    if (!read.ok) return read;
    review = read.data?.addPullRequestReview?.pullRequestReview?.id;
    if (!review) return { ok: false, status: 502, error: 'GitHub did not start a draft review' };
  }

  const added = await run(
    'gh',
    graphqlArgv({
      query: startNo === null ? ADD_THREAD : ADD_THREAD_SPAN,
      strings: { r: review, p: filePath, s: side === 'old' ? 'LEFT' : 'RIGHT', b: text },
      numbers: startNo === null ? { l: lineNo } : { l: lineNo, sl: startNo },
    }),
    { timeoutMs: GH_TIMEOUT_MS },
  );
  const read = readGraphql(added);
  if (!read.ok) {
    // The one failure a person hits by accident: a line that is not part of
    // the diff GitHub is showing, which a worktree review can easily offer.
    const outside = /not part of the (pull request|diff)|must be part of|invalid line/i.test(read.error || '');
    return outside
      ? { ok: false, status: 400, error: 'GitHub will only take a comment on a line that is in the pull request diff' }
      : read;
  }
  const thread = read.data?.addPullRequestReviewThread?.thread || null;
  const made = (thread?.comments?.nodes || [])[0] || null;
  return {
    ok: true,
    reviewId: review,
    comment: made
      ? {
        id: made.id,
        path: made.path,
        line: made.line === null || made.line === undefined ? made.originalLine : made.line,
        startLine: thread?.startLine ?? null,
        side: thread?.diffSide === 'LEFT' ? 'old' : 'new',
        body: made.body,
      }
      : null,
  };
}

/**
 * Post one line comment immediately, outside any review.
 *
 * REST, and not for the usual reason. Every GraphQL route into a line comment
 * goes through a review: addPullRequestReviewThread with a bare pullRequestId
 * and no review still comes back with the comment in state PENDING, measured
 * on the box. So a comment that is meant to be published the moment it is
 * written has exactly one API, and this is it.
 *
 * The head sha is required by that API and is read live rather than taken
 * from the review record, which for a worktree review is the working tree's
 * head and not the pull request's.
 */
export async function postLineComment({ pr, slug, headSha, path: filePath, line, startLine, side, body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'a comment needs something written in it' };
  if (tooLong(text)) return tooLongError(text);
  const lineNo = Number(line);
  if (!Number.isSafeInteger(lineNo) || lineNo < 1) {
    return { ok: false, status: 400, error: 'a comment needs a line to hang on' };
  }
  if (!/^[0-9a-f]{7,64}$/.test(String(headSha || ''))) {
    return { ok: false, status: 502, error: 'GitHub gave no usable head commit for this pull request' };
  }

  // Every string through -f, every number through -F, for the reason
  // github.test.mjs exists. The body is one of those strings.
  const args = ['api', '-X', 'POST', `repos/${slug}/pulls/${pr}/comments`,
    '-f', `body=${text}`, '-f', `commit_id=${headSha}`, '-f', `path=${filePath}`,
    '-f', `side=${side === 'old' ? 'LEFT' : 'RIGHT'}`, '-F', `line=${lineNo}`];
  const startNo = Number(startLine);
  if (Number.isSafeInteger(startNo) && startNo >= 1 && startNo < lineNo) {
    args.push('-F', `start_line=${startNo}`, '-f', `start_side=${side === 'old' ? 'LEFT' : 'RIGHT'}`);
  }
  args.push('--jq', '{id: .id, node_id: .node_id, html_url: .html_url}');

  const result = await run('gh', args, { timeoutMs: GH_TIMEOUT_MS });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    const outside = /line must be part of the diff|not part of the/i.test(stderr);
    return {
      ok: false,
      status: 502,
      error: outside
        ? 'GitHub will only take a comment on a line that is in the pull request diff'
        : `posting the comment failed: ${stderr.slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  let made = null;
  try {
    made = JSON.parse(result.stdout || 'null');
  } catch (err) {
    return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
  }
  return { ok: true, comment: made };
}

const DELETE_COMMENT = `mutation($id:ID!){ deletePullRequestReviewComment(input:{id:$id}){ clientMutationId } }`;
const DELETE_REVIEW = `mutation($id:ID!){ deletePullRequestReview(input:{pullRequestReviewId:$id}){ clientMutationId } }`;
const SUBMIT_REVIEW = `mutation($id:ID!,$e:PullRequestReviewEvent!,$b:String){
  submitPullRequestReview(input:{pullRequestReviewId:$id,event:$e,body:$b}){ pullRequestReview{ state } }
}`;

/**
 * Hide something on the pull request, the way GitHub's own "Hide" does.
 *
 * This is what a submitted review has instead of deletion. It is not a
 * deletion: the text stays on GitHub, collapsed behind a reason, and anyone
 * can unfold it. It is also reversible there, which is why it is offered here
 * where a delete cannot be.
 *
 * Works on any comment subject — a review, an issue comment, a line comment —
 * so the caller passes whichever node id it has.
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function hideComment({ nodeId, reason }) {
  const classifier = HIDE_REASONS[reason] ? HIDE_REASONS[reason] : 'OUTDATED';
  const result = await run(
    'gh',
    graphqlArgv({ query: HIDE_MUTATION, strings: { id: nodeId, why: classifier } }),
    { timeoutMs: GH_TIMEOUT_MS },
  );
  const read = readGraphql(result);
  return read.ok ? { ok: true } : read;
}

// GitHub's own list, as a fixed map so an unknown reason cannot reach argv.
const HIDE_REASONS = {
  outdated: 'OUTDATED',
  resolved: 'RESOLVED',
  duplicate: 'DUPLICATE',
  'off-topic': 'OFF_TOPIC',
};
const HIDE_MUTATION = `mutation($id:ID!,$why:ReportedContentClassifiers!){
  minimizeComment(input:{subjectId:$id,classifier:$why}){ minimizedComment{ isMinimized } }
}`;

/**
 * Delete a plain comment on the pull request.
 *
 * A different endpoint from a line comment's: these are issue comments, and
 * they live under /issues/comments rather than /pulls/comments. There is no
 * equivalent for a submitted REVIEW — GitHub refuses that outright — so
 * nothing here offers one.
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function deleteIssueComment({ slug, restId }) {
  if (!/^[0-9]{1,20}$/.test(String(restId || ''))) {
    return { ok: false, status: 400, error: 'that is not a comment id' };
  }
  const result = await run(
    'gh',
    ['api', '-X', 'DELETE', `repos/${slug}/issues/comments/${restId}`],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    return {
      ok: false,
      status: 502,
      error: /403|forbidden/i.test(stderr)
        ? 'GitHub would not let this account delete that comment'
        : `deleting the comment failed: ${stderr.slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  return { ok: true };
}

/**
 * Delete a comment that has already been posted.
 *
 * REST, because deletePullRequestReviewComment is for a pending one: the
 * published case needs the numeric id, which is why the thread query asks for
 * fullDatabaseId alongside the node id. Whether the viewer may do this is
 * GitHub's answer, read from viewerCanDelete, not something inferred here.
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function deletePostedComment({ slug, restId }) {
  if (!/^[0-9]{1,20}$/.test(String(restId || ''))) {
    return { ok: false, status: 400, error: 'that is not a comment id' };
  }
  const result = await run(
    'gh',
    ['api', '-X', 'DELETE', `repos/${slug}/pulls/comments/${restId}`],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    const forbidden = /403|forbidden|not permitted/i.test(stderr);
    return {
      ok: false,
      status: 502,
      error: forbidden
        ? 'GitHub would not let this account delete that comment'
        : `deleting the comment failed: ${stderr.slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  return { ok: true };
}

/**
 * Drop one draft comment.
 *
 * Deleting the last one deletes the draft review with it — GitHub does that
 * by itself, measured on the box, so nothing here has to tidy up after.
 */
export async function deletePendingComment({ commentId }) {
  const result = await run('gh', graphqlArgv({ query: DELETE_COMMENT, strings: { id: commentId } }), { timeoutMs: GH_TIMEOUT_MS });
  const read = readGraphql(result);
  return read.ok ? { ok: true } : read;
}

/** Throw the whole draft away without posting any of it. */
export async function discardPendingReview({ reviewId }) {
  const result = await run('gh', graphqlArgv({ query: DELETE_REVIEW, strings: { id: reviewId } }), { timeoutMs: GH_TIMEOUT_MS });
  const read = readGraphql(result);
  return read.ok ? { ok: true } : read;
}

const GRAPHQL_EVENTS = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' };

/**
 * Post the draft, with its comments, as one review.
 *
 * This exists beside submitPrReview rather than replacing it because GitHub
 * allows a viewer only ONE pending review per pull request: `gh pr review`
 * creates its own and gets a 422 when a draft is already open. Which call is
 * right therefore depends on whether there are draft comments, and the caller
 * knows that.
 */
export async function submitPendingReview({ reviewId, event, body }) {
  const ghEvent = GRAPHQL_EVENTS[event];
  if (!ghEvent) return { ok: false, status: 400, error: `unknown review action: ${String(event)}` };
  const text = typeof body === 'string' ? body.trim() : '';
  if (tooLong(text)) return tooLongError(text);
  const result = await run(
    'gh',
    graphqlArgv({ query: SUBMIT_REVIEW, strings: { id: reviewId, e: ghEvent, b: text } }),
    { timeoutMs: GH_TIMEOUT_MS },
  );
  const read = readGraphql(result);
  if (!read.ok) {
    const ownPr = /can ?not approve your own/i.test(read.error || '');
    return ownPr
      ? { ok: false, status: 502, error: 'GitHub does not let you approve your own pull request' }
      : read;
  }
  return { ok: true };
}

/**
 * One shape for every GraphQL answer.
 *
 * GraphQL reports its own errors inside a 200 body, so exit 0 is not enough —
 * a caller checking only the status would read a refusal as a success.
 */
function readGraphql(result) {
  if (result.status !== 0) {
    return {
      ok: false,
      status: 502,
      error: `gh api graphql failed: ${(result.stderr || '').toString().trim().slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  let body;
  try {
    body = JSON.parse(result.stdout || '{}');
  } catch (err) {
    return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    return { ok: false, status: 502, error: String(body.errors[0]?.message || 'GitHub refused the request').slice(0, 300) };
  }
  return { ok: true, data: body.data };
}

// --- viewed files -----------------------------------------------------------
//
// GitHub's per-file "Viewed" tick is GraphQL-only: there is no REST endpoint
// and no `gh pr` verb for it. It is also per-viewer and invisible to everyone
// else, which is why it can be written without the ceremony a verdict needs.

/**
 * argv for one `gh api graphql` call, with every variable passed safely.
 *
 * `-F/--field` is the flag that looks right and is not: it does type
 * conversion AND reads a value beginning with `@` out of a FILE. Measured on
 * the box, not assumed. Every string here reaches us from an HTTP body, so
 * one `-F path=@/etc/passwd` would have the shed read a file and hand its
 * contents to GitHub. `-f/--raw-field` does no such expansion and is what
 * strings get; only a value this module has already reduced to an integer
 * goes through `-F`, where the type conversion is the whole point.
 *
 * Split out from its callers so the property can be tested: a regression here
 * would be silent, and the argv is the only place it can be seen.
 *
 * @param {{query: string, strings?: object, numbers?: object}} spec
 * @returns {string[]}
 */
export function graphqlArgv({ query, strings = {}, numbers = {} }) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(strings)) {
    if (value === null || value === undefined) continue;
    args.push('-f', `${key}=${String(value)}`);
  }
  for (const [key, value] of Object.entries(numbers)) {
    if (value === null || value === undefined) continue;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error(`graphql variable ${key} is not an integer`);
    args.push('-F', `${key}=${n}`);
  }
  return args;
}

const VIEWED_QUERY = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      id
      files(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ path viewerViewedState }
      }
    }
  }
}`;

/**
 * The pull request's node id, and which of its files this account has ticked.
 *
 * The id comes back with the state because every write needs it and asking
 * separately would double the round trips for no reason.
 *
 * @returns {Promise<{ok: true, id: string, viewed: string[]} | {ok: false, status: number, error: string}>}
 */
export async function fetchViewedFiles({ pr, slug }) {
  const [owner, repo] = String(slug).split('/');
  let id = null;
  const viewed = [];
  let after = null;
  // A pull request can have more files than one page holds, and a reviewer who
  // has ticked things on page two is exactly the reviewer this feature is for.
  // Bounded so a pathological diff cannot spin here.
  for (let page = 0; page < 30; page++) {
    const args = graphqlArgv({
      query: VIEWED_QUERY,
      strings: { owner, repo, after },
      numbers: { pr },
    });
    const result = await run('gh', args, { timeoutMs: GH_TIMEOUT_MS });
    if (result.status !== 0) {
      return {
        ok: false,
        status: 502,
        error: `gh api graphql failed: ${(result.stderr || '').toString().trim().slice(0, 200) || `exit ${result.status}`}`,
      };
    }
    let body;
    try {
      body = JSON.parse(result.stdout || '{}');
    } catch (err) {
      return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
    }
    const node = body?.data?.repository?.pullRequest;
    if (!node) return { ok: false, status: 404, error: `pull request #${pr} not found in ${slug}` };
    id = node.id;
    const files = node.files || {};
    for (const file of files.nodes || []) {
      if (file?.viewerViewedState === 'VIEWED') viewed.push(file.path);
    }
    if (!files.pageInfo?.hasNextPage) break;
    after = files.pageInfo.endCursor;
  }
  if (!id) return { ok: false, status: 502, error: 'gh returned no pull request id' };
  return { ok: true, id, viewed };
}

const MARK_MUTATION = `mutation($id:ID!,$path:String!){ markFileAsViewed(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`;
const UNMARK_MUTATION = `mutation($id:ID!,$path:String!){ unmarkFileAsViewed(input:{pullRequestId:$id,path:$path}){ clientMutationId } }`;

/**
 * Tick or untick one file for this account.
 *
 * A path the pull request does not contain is a real case here rather than a
 * bug: a worktree review shows the working tree, which can hold a file that
 * has not been pushed. GitHub answers that with an error, and it is reported
 * as what it is rather than swallowed.
 *
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function setFileViewed({ prId, path: filePath, viewed }) {
  const result = await run(
    'gh',
    graphqlArgv({
      query: viewed ? MARK_MUTATION : UNMARK_MUTATION,
      strings: { id: prId, path: filePath },
    }),
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    const unknown = /could not resolve|not find|does not exist/i.test(stderr);
    return {
      ok: false,
      status: 502,
      error: unknown
        ? 'the pull request does not contain that file, so GitHub has nothing to tick'
        : `gh api graphql failed: ${stderr.slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  // GraphQL reports its own errors in a 200 body, so exit 0 is not enough.
  try {
    const body = JSON.parse(result.stdout || '{}');
    if (Array.isArray(body.errors) && body.errors.length) {
      return { ok: false, status: 502, error: String(body.errors[0]?.message || 'GitHub refused the change').slice(0, 200) };
    }
  } catch (err) {
    return { ok: false, status: 502, error: `gh returned unparseable JSON: ${err.message}` };
  }
  return { ok: true };
}

/**
 * Post a review to a pull request. The loudest of this module's writes: it
 * carries every draft comment out with it, and an approval or a change request
 * is a verdict with someone's name on it.
 *
 * The body goes through a temporary file rather than argv. `--body <text>`
 * would work for a sentence and fail for a long one: Linux caps a single
 * argument at 128 KiB, and the failure arrives as a spawn error rather than as
 * anything a reader could act on. A file also sidesteps the question of what
 * `gh` does with a body that begins with a dash.
 *
 * @param {{pr: number, slug: string, event: string, body: string}} params
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string}>}
 */
export async function submitPrReview({ pr, slug, event, body }) {
  const flag = REVIEW_EVENTS[event];
  if (!flag) return { ok: false, status: 400, error: `unknown review action: ${String(event)}` };

  const text = typeof body === 'string' ? body.trim() : '';
  // GitHub rejects a comment or a change request with nothing in it, with a
  // message about the API rather than about what the person left blank.
  if (!text && event !== 'approve') {
    return { ok: false, status: 400, error: `a ${event === 'comment' ? 'comment' : 'change request'} needs something written in it` };
  }
  if (tooLong(text)) return tooLongError(text);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shed-review-'));
  const bodyFile = path.join(dir, 'body.md');
  try {
    await fsp.writeFile(bodyFile, text, 'utf-8');
    const args = ['pr', 'review', String(pr), '--repo', slug, flag];
    // An approval with nothing written is the normal case, and `gh` refuses an
    // empty --body-file.
    if (text) args.push('--body-file', bodyFile);
    const result = await run('gh', args, { timeoutMs: GH_TIMEOUT_MS });
    if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      // Approving your own pull request is the one failure a person hits by
      // accident, and GitHub's wording for it is not obvious.
      const ownPr = /can not approve your own|cannot approve your own/i.test(stderr);
      return {
        ok: false,
        status: 502,
        error: ownPr
          ? 'GitHub does not let you approve your own pull request'
          : `gh pr review failed: ${stderr.slice(0, 300) || `exit ${result.status}`}`,
      };
    }
    return { ok: true };
  } finally {
    // Best effort. The body is someone's review comment, not a secret, but it
    // has no reason to outlive the request either.
    await fsp.rm(dir, { recursive: true, force: true }).catch(function ignore() {});
  }
}

/**
 * The raw unified diff. Returned as text; parsing is diff.mjs's job.
 *
 * @returns {{ok: true, patch: string} | {ok: false, status: number, error: string}}
 */
export async function fetchPrDiff({ pr, slug }) {
  const result = await run('gh', ['pr', 'diff', String(pr), '--repo', slug], {
    timeoutMs: GH_TIMEOUT_MS,
    // A large PR's patch runs to megabytes; a small cap would truncate it into
    // a diff that parses cleanly but is missing files.
    maxBytes: 64 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      status: 502,
      error: `gh pr diff failed: ${(result.stderr || '').toString().trim().slice(0, 200) || `exit ${result.status}`}`,
    };
  }
  return { ok: true, patch: result.stdout || '' };
}
