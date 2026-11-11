// The shed's review feature, run inside the session: its page, its server routes and its GitHub calls, unchanged
// (woodshed/shared/review). The console carries the requests (console/reviewProxy.mjs) and knows nothing of reviews.
// This folder is everything Woodshed adds for it: what the shed's `ctx` asks of its host, and which calls a session may
// answer (policy.mjs).
//
// The checkout is the session's own, so the shed's "worktree" kind applies. Its state goes under /tmp: a session's
// container is its whole life, and nothing here should ride along in the saved Claude home.

import { randomBytes } from 'node:crypto';

import { isGithubWrite, sectionOf, withoutPullRequest, writesAllowed } from './policy.mjs';

/** statusd mounts the shed's routes here; the console maps /review and /reviews/... to this prefix. */
export const SHED_PREFIX = '/shed-review';
const REVIEWS_DIR = '/tmp/woodshed-reviews';
const ACCOUNT_FRESH_MS = 60_000;
const SESSION_ID_RE = /^[0-9a-f]{8}$/;

async function loadShed(repoDir) {
  // The shed reads this when its store module loads.
  process.env.WOODSHED_REVIEWS ??= REVIEWS_DIR;
  const [{ handleReviewRequest, ensureWorktreeReview, startReviewAnalysis, warmLivePr }, { ghAccount }, { configurePrStatus }] = await Promise.all([
    import('../../shared/review/index.mjs'),
    import('../../shared/review/github.mjs'),
    import('../../shared/prStatus.mjs'),
  ]);
  // Without the checkout, the shed cannot name the repo, so its pull request lookup finds nothing and the page gets no PR.
  configurePrStatus({ repoRoot: repoDir, log: (event, fields) => console.log(`review: ${event}`, fields) });
  return { handleReviewRequest, ensureWorktreeReview, startReviewAnalysis, warmLivePr, ghAccount };
}

/**
 * @param {{repoDir: string, sessionId: string, sessionKind?: string, reviewOnly?: boolean, load?: typeof loadShed,
 *          now?: () => number}} opts  `reviewOnly`: the session was started only to read a review, so opening it starts the analysis
 * @returns {{handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}}
 */
export function createReviewHost({
  repoDir, sessionId, sessionKind = process.env.SESSION_KIND, reviewOnly = process.env.REVIEW_ONLY === '1', load = loadShed, now = Date.now,
}) {
  const sessionName = `claude-${sessionId}`;
  let shed = null;
  let account = { at: 0, login: null };

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
    if (pathname.startsWith('/reviews/') && pathname !== `/reviews/${sessionName}` && !pathname.startsWith(`/reviews/${sessionName}/`)) {
      json(res, 404, { ok: false, error: 'not this session\'s review' });
      return true;
    }
    shed ??= await load(repoDir);
    const reqId = randomBytes(4).toString('hex');
    let writable = null;
    if (isGithubWrite({ method: req.method, pathname }) || (req.method === 'GET' && pathname.startsWith('/reviews/') && !sectionOf(pathname))) {
      writable = writesAllowed({ sessionKind, account: await accountNow() });
    }
    if (writable === false && isGithubWrite({ method: req.method, pathname })) {
      console.log('review: GitHub write refused', { reqId, section: sectionOf(pathname), sessionKind: sessionKind ?? null });
      json(res, 403, { ok: false, error: 'this session cannot write to GitHub as you: open a My Woodshed session with GitHub connected' });
      return true;
    }
    const ctx = {
      reqId, repoRoot: repoDir,
      json: (r, status, body) => json(r, status, writable === false ? withoutPullRequest(body) : body),
      log: (event, fields) => console.log(`review: ${event}`, fields),
      worktreePathFor: () => repoDir,
      removeWorktree: async () => ({ ok: false, error: 'a session\'s own checkout is not removed by a review' }),
    };
    if (req.method === 'GET' && pathname.startsWith('/reviews/') && !sectionOf(pathname)) {
      // The page needs a review to open. The shed's launcher makes one; here opening the tab does, and starts the analysis only for a review-only session.
      const made = await shed.ensureWorktreeReview({ ctx, sessionName });
      console.log('review: worktree review ensured', { reqId, ok: made.ok, created: made.ok ? made.created : false, status: made.ok ? null : made.status });
      if (!made.ok) {
        json(res, 200, { ok: false, status: 'missing', error: made.error });
        return true;
      }
      // Only on the review's first taking: a reload, or a second viewer, must not pay for another run.
      if (reviewOnly && made.created) {
        shed.startReviewAnalysis({ ctx, sessionName });
        console.log('review: analysis started for a review-only session', { reqId });
      }
      // The first read would otherwise answer before the shed has asked GitHub for the branch's pull request.
      await shed.warmLivePr?.({ sessionName });
    }
    req.url = `${pathname}${url.search}`;
    return shed.handleReviewRequest(req, res, ctx);
  }

  return { handle };
}
