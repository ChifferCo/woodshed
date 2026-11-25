// The shed's review feature, run inside the session: its page, its server routes and its GitHub calls, unchanged
// (woodshed/shared/review). The console carries the requests (console/reviewProxy.mjs) and knows nothing of reviews.
// This folder is everything Woodshed adds for it: what the shed's `ctx` asks of its host, and which calls a session may
// answer (policy.mjs).
//
// The checkout is the session's own, so the shed's "worktree" kind applies. Its state goes under /tmp: a session's
// container is its whole life, and nothing here should ride along in the saved Claude home.
//
// A session can open more than one pull request (one per branch it worked on, or one stacked on another). The review of
// its checkout, `claude-<id>`, is of the branch checked out now, against its pull request's base when it has one open.
// Each other pull request it opened has a review of its own, `claude-<id>-pr<n>`: the shed's pull request kind, taken
// from GitHub's head of it into a detached worktree under /tmp, so the checkout and its branches are never touched.
// Which pull requests are the session's is the console's to say (`x-woodshed-pulls`, console/reviewProxy.mjs): the
// status call lists them (`reviews`), for the page's and the command line's switch between them.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isGithubWrite, sectionOf, withoutPullRequest, writesAllowed } from './policy.mjs';

/** statusd mounts the shed's routes here; the console maps /review and /reviews/... to this prefix. */
export const SHED_PREFIX = '/shed-review';
const REVIEWS_DIR = '/tmp/woodshed-reviews';
/** Where the review of another of the session's pull requests checks it out, one folder per review. */
export const PULL_WORKTREES_DIR = '/tmp/woodshed-review-worktrees';
const ACCOUNT_FRESH_MS = 60_000;
const CHECKOUT_PULL_FRESH_MS = 60_000;
const SESSION_ID_RE = /^[0-9a-f]{8}$/;
const REVIEW_NAME_RE = /^claude-([0-9a-f]{8})(?:-pr([1-9][0-9]{0,8}))?$/;
/** The header the console names the session's pull requests in, by number, on its repo. */
export const PULLS_HEADER = 'x-woodshed-pulls';
const MAX_PULLS = 50;

/** @returns {number[]}  the pull request numbers the console named, in its order, or [] */
export function pullsFrom(headers) {
  const raw = headers?.[PULLS_HEADER];
  if (typeof raw !== 'string') return [];
  const numbers = raw.split(',').map((n) => n.trim()).filter((n) => /^[1-9][0-9]{0,8}$/.test(n)).map(Number);
  return [...new Set(numbers)].slice(-MAX_PULLS);
}

/**
 * The reviews a session has, for the page's switch: its checkout's first, named after the pull request checked out now
 * when there is one, then one for each other pull request the console named, newest first.
 * @param {{sessionName: string, pulls: number[], checkoutPull: number|null}} args
 * @returns {{review: string, number: number|null, checkout: boolean}[]}
 */
export function reviewsOf({ sessionName, pulls, checkoutPull }) {
  const others = pulls.filter((n) => n !== checkoutPull).reverse();
  return [
    { review: sessionName, number: checkoutPull ?? null, checkout: true },
    ...others.map((n) => ({ review: `${sessionName}-pr${n}`, number: n, checkout: false })),
  ];
}

// The pull request of the branch checked out, as gh says: its number, state and base.
async function ghCheckoutPull(repoDir) {
  const out = await new Promise((resolve) => {
    execFile('gh', ['pr', 'view', '--json', 'number,state,baseRefName'], { cwd: repoDir, timeout: 20_000 }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (!out) return null;
  try {
    const pr = JSON.parse(out);
    return Number.isInteger(pr?.number) ? { number: pr.number, state: String(pr.state || '').toUpperCase(), baseRefName: typeof pr.baseRefName === 'string' ? pr.baseRefName : null } : null;
  } catch {
    return null;
  }
}

// The branch checked out, or '' for none (a detached HEAD) or a checkout git could not read.
function gitBranch(repoDir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoDir, 'branch', '--show-current'], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

// A review's own worktree goes with git's say-so, twice forced as the shed's server does: it is the review's, never the
// session's checkout.
function removePullWorktree(repoDir, pullWorktreesDir) {
  return (worktreePath) => new Promise((resolve) => {
    if (path.dirname(path.resolve(worktreePath)) !== path.resolve(pullWorktreesDir)) {
      resolve({ ok: false, stderr: 'a session\'s own checkout is not removed by a review' });
      return;
    }
    execFile('git', ['-C', repoDir, 'worktree', 'remove', '--force', '--force', worktreePath], { timeout: 60_000 }, (err, _stdout, stderr) => {
      resolve(err ? { ok: false, stderr: String(stderr || err.message) } : { ok: true });
    });
  });
}

async function loadShed(repoDir) {
  // The shed reads this when its store module loads.
  process.env.WOODSHED_REVIEWS ??= REVIEWS_DIR;
  const [{ handleReviewRequest, ensureWorktreeReview, ensurePullRequestReview, worktreeReviewBranch, startReviewAnalysisIfNone, startReviewQaIfNone, warmLivePr }, { ghAccount, personalPrImageReader }, { configurePrStatus }] = await Promise.all([
    import('../../shared/review/index.mjs'),
    import('../../shared/review/github.mjs'),
    import('../../shared/prStatus.mjs'),
  ]);
  // Without the checkout, the shed cannot name the repo, so its pull request lookup finds nothing and the page gets no PR.
  configurePrStatus({ repoRoot: repoDir, log: (event, fields) => console.log(`review: ${event}`, fields) });
  return { handleReviewRequest, ensureWorktreeReview, ensurePullRequestReview, worktreeReviewBranch, startReviewAnalysisIfNone, startReviewQaIfNone, warmLivePr, ghAccount, personalPrImageReader };
}

/**
 * @param {{repoDir: string, sessionId: string, sessionKind?: string, agent?: string, model?: string, effort?: string, load?: typeof loadShed, now?: () => number,
 *          checkoutPull?: (repoDir: string) => Promise<{number: number, state: string, baseRefName: string|null}|null>,
 *          checkoutBranch?: (repoDir: string) => Promise<string>, pullWorktreesDir?: string}} opts
 *   `checkoutPull`: the pull request of the branch checked out (gh's by default), for its base and the page's switch
 * @returns {{handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}}
 */
export function createReviewHost({
  repoDir, sessionId, sessionKind = process.env.SESSION_KIND,
  agent, model, effort,
  load = loadShed, now = Date.now, checkoutPull = ghCheckoutPull, checkoutBranch = gitBranch, pullWorktreesDir = PULL_WORKTREES_DIR,
}) {
  const sessionName = `claude-${sessionId}`;
  let shed = null;
  let account = { at: 0, login: null };
  let checkout = { at: -Infinity, branch: null, pull: null };
  // The reviews this container has already offered to start the analysis of: after that, a Discard stays discarded.
  const analysisOffered = new Set();

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function accountNow() {
    if (now() - account.at < ACCOUNT_FRESH_MS) return account.login;
    const login = await shed.ghAccount().catch(() => null);
    account = { at: now(), login };
    console.log('review: gh account checked', { sessionKind: sessionKind ?? null, person: Boolean(login) });
    return login;
  }

  // Kept a minute for the branch it was asked for, as statusd keeps its own lookup: a checkout of another branch is
  // asked again at once. A checkout during the lookup leaves its answer unkept.
  async function checkoutPullNow() {
    const branch = await checkoutBranch(repoDir).catch(() => '');
    if (now() - checkout.at < CHECKOUT_PULL_FRESH_MS && branch === checkout.branch) return checkout.pull;
    const pull = branch ? await checkoutPull(repoDir).catch(() => null) : null;
    if ((await checkoutBranch(repoDir).catch(() => '')) !== branch) return null;
    checkout = { at: now(), branch, pull };
    return pull;
  }

  /** @returns {Promise<boolean>}  whether the request was the shed's to answer */
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://statusd');
    if (!url.pathname.startsWith(`${SHED_PREFIX}/`)) return false;
    if (!SESSION_ID_RE.test(sessionId)) {
      console.warn('review: host disabled, the session has no id', { hasId: Boolean(sessionId) });
      json(res, 404, { ok: false, error: 'this session has no review' });
      return true;
    }
    const pathname = url.pathname.slice(SHED_PREFIX.length);
    // Which of the session's reviews: its checkout's, or another of its pull requests'.
    let reviewName = sessionName;
    let pr = null;
    if (pathname.startsWith('/reviews/')) {
      const name = /^\/reviews\/([^/]*)/.exec(pathname)[1];
      const match = REVIEW_NAME_RE.exec(name);
      if (!match || match[1] !== sessionId) {
        json(res, 404, { ok: false, error: 'not this session\'s review' });
        return true;
      }
      reviewName = name;
      pr = match[2] ? Number(match[2]) : null;
    }
    const pulls = pullsFrom(req.headers);
    if (pr !== null && !pulls.includes(pr)) {
      console.log('review: refused, not one of the session\'s pull requests', { pr, pulls: pulls.length });
      json(res, 404, { ok: false, error: `#${pr} is not one of this session's pull requests` });
      return true;
    }
    shed ??= await load(repoDir);
    const reqId = randomBytes(4).toString('hex');
    let readPrImage;
    if (req.method === 'GET' && sectionOf(pathname) === 'image') {
      readPrImage = sessionKind === 'private' ? await shed.personalPrImageReader() : null;
      if (!readPrImage) {
        console.log('review: image read refused', { reqId, sessionKind: sessionKind ?? null });
        json(res, 403, { ok: false, error: 'review images require a My Woodshed session with GitHub connected' });
        return true;
      }
    }
    let writable = null;
    if (isGithubWrite({ method: req.method, pathname }) || (req.method === 'GET' && pathname.startsWith('/reviews/') && !sectionOf(pathname))) {
      writable = writesAllowed({ sessionKind, account: await accountNow() });
    }
    if (writable === false && isGithubWrite({ method: req.method, pathname })) {
      console.log('review: GitHub write refused', { reqId, section: sectionOf(pathname), sessionKind: sessionKind ?? null });
      json(res, 403, { ok: false, error: 'this session cannot write to GitHub as you: open a My Woodshed session with GitHub connected' });
      return true;
    }
    const isStatus = req.method === 'GET' && pathname.startsWith('/reviews/') && !sectionOf(pathname);
    // The status call names the session's reviews, for the switch between them.
    let reviews = null;
    // The checkout's review is of the branch it was taken on. Named after the pull request checked out now only while
    // that is the same branch (or it is not taken yet): after a checkout of another branch, that pull request keeps a
    // link to a review of its own, and the checkout's says no number until a Re-review takes the new branch.
    let checkoutNumber = null;
    if (isStatus) {
      const current = (await checkoutPullNow())?.number ?? null;
      const taken = current === null ? null : shed.worktreeReviewBranch?.({ sessionName }) ?? { exists: false };
      if (taken && (!taken.exists || (taken.branch && taken.branch === checkout.branch))) checkoutNumber = current;
      reviews = reviewsOf({ sessionName, pulls, checkoutPull: checkoutNumber });
    }
    const withReviews = (body) => (reviews && body && typeof body === 'object' && body.ok !== false ? { ...body, reviews } : body);
    const ctx = {
      reqId, repoRoot: repoDir, readPrImage,
      reviewAgent: { agent, model, effort },
      json: (r, status, body) => json(r, status, withReviews(writable === false ? withoutPullRequest(body) : body)),
      log: (event, fields) => console.log(`review: ${event}`, fields),
      worktreePathFor: (name) => (name === sessionName ? repoDir : path.join(pullWorktreesDir, name)),
      removeWorktree: removePullWorktree(repoDir, pullWorktreesDir),
      // A pull request stacked on another branch is reviewed against that branch, as GitHub shows it.
      worktreeBaseRef: async () => {
        const open = await checkoutPullNow();
        return open?.state === 'OPEN' ? open.baseRefName : null;
      },
    };
    // The pull request checked out now is the checkout's review: a second, of GitHub's copy of the same branch, would
    // split its comments and verdict across two pages. Nothing is made; the caller opens that one instead. Only while
    // that review is of this branch, or not taken yet: one taken on a branch checked out before would post to that
    // branch's pull request, so the pull request asked for gets a review of its own instead.
    if (isStatus && pr !== null && pr === checkoutNumber) {
      json(res, 200, { ok: false, status: 'checkout', review: sessionName, error: `#${pr} is the branch checked out: its review is the checkout's`, reviews });
      return true;
    }
    if (isStatus) {
      // The page needs a review to open. The shed's launcher makes one; here opening the tab does, and starts the analysis.
      let made;
      if (pr === null) {
        made = await shed.ensureWorktreeReview({ ctx, sessionName });
        console.log('review: worktree review ensured', { reqId, ok: made.ok, created: made.ok ? made.created : false, status: made.ok ? null : made.status });
      } else {
        fs.mkdirSync(pullWorktreesDir, { recursive: true });
        made = await shed.ensurePullRequestReview({ ctx, sessionName: reviewName, pr });
        console.log('review: pull request review ensured', { reqId, pr, ok: made.ok, created: made.ok ? made.created : false, status: made.ok ? null : made.status });
      }
      if (!made.ok) {
        json(res, 200, { ok: false, status: 'missing', error: made.error, ...(reviews ? { reviews } : {}) });
        return true;
      }
      // Once per container, and only when the review has no analysis: a reload, a second viewer, a finished or failed
      // run, or a Discard pressed since, must not pay for another. The Q&A the same way, so it is written while the
      // reader is on the analysis rather than only once they open its tab: whichever page or terminal opened the review.
      if (!analysisOffered.has(reviewName)) {
        analysisOffered.add(reviewName);
        // Neither may fail the read that opens the page: a start that throws (qa.json unreadable, say) is logged and
        // left for the page's own button.
        const offer = (what, start) => {
          try { return start(); } catch (err) {
            console.warn(`review: ${what} not started on opening`, { reqId, error: err?.message });
            return false;
          }
        };
        const started = offer('analysis', () => shed.startReviewAnalysisIfNone({ ctx, sessionName: reviewName }));
        const qaStarted = offer('Q&A', () => shed.startReviewQaIfNone?.({ ctx, sessionName: reviewName }) ?? false);
        console.log('review: analysis on opening', { reqId, pr, started, qaStarted });
      }
      // The first read would otherwise answer before the shed has asked GitHub for the branch's pull request.
      await shed.warmLivePr?.({ sessionName: reviewName });
    }
    req.url = `${pathname}${url.search}`;
    return shed.handleReviewRequest(req, res, ctx);
  }

  return { handle };
}
