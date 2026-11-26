// Carries the shed's review page and its calls to the session that answers them (session/reviewShed). The page is the
// shed's own and talks to root-absolute paths, /review and /reviews/claude-<id>/..., so the console owns those two
// prefixes. It checks who is asking and that it is not another site, then forwards; it knows nothing of reviews, so a
// change to the page never lands here.
//
// `woodshed review <id>` (cli/reviewOpen.mjs) reaches the same calls, /reviews/claude-<id>/..., with the command line's
// token (`Authorization: Bearer wsc_...`, cliSignIn.mjs) and no cookie: `forCli` checks the token as the pipes and
// terminals do (execPipe.mjs), owner only, never a session that has seen production data, and never the page itself.
// What a session lets a review write to GitHub stays statusd's rule (session/reviewShed/policy.mjs).

import http from 'node:http';

import { ownerOnly } from './execPipe.mjs';
import { prUrlsOf } from './sessions.mjs';
import { isSameOrigin } from '../shared/sameOrigin.mjs';

const SHED_PREFIX = '/shed-review';
// A session's review is `claude-<id>`, of its checkout, or `claude-<id>-pr<n>`, of another pull request it opened.
const SESSION_PARAM_RE = /^claude-([0-9a-f]{8})(?:-pr[1-9][0-9]{0,8})?$/;
const REVIEWS_RE = /^\/reviews\/claude-([0-9a-f]{8})(?:-pr[1-9][0-9]{0,8})?(\/[A-Za-z0-9/-]*)?$/;
// The session's pull requests, by number, which statusd reviews one at a time (session/reviewShed/host.mjs).
const PULLS_HEADER = 'x-woodshed-pulls';

/** @returns {string}  the numbers of the session's pull requests on its own repo, oldest first, comma separated */
export function sessionPulls(session) {
  const repo = String(session?.repo ?? '').toLowerCase();
  const numbers = prUrlsOf(session).map((url) => {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d{1,9})$/i.exec(String(url));
    return match && match[1].toLowerCase() === repo ? Number(match[2]) : null;
  }).filter(Boolean);
  return [...new Set(numbers)].join(',');
}
const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 120_000;

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** @returns {{id: string, path: string}|null}  the session a request is for, and the path to ask its statusd */
export function reviewTarget(url) {
  if (url.pathname === '/review') {
    const id = SESSION_PARAM_RE.exec(url.searchParams.get('session') ?? '')?.[1];
    return id ? { id, path: `${SHED_PREFIX}/review` } : null;
  }
  const match = REVIEWS_RE.exec(url.pathname);
  return match ? { id: match[1], path: `${SHED_PREFIX}${url.pathname}${url.search}` } : null;
}

/** @returns {boolean}  whether the console owns this path */
export function isReviewPath(pathname) {
  return pathname === '/review' || pathname.startsWith('/reviews/');
}

/**
 * @param {{findFor: (id: string, login: string) => object|null, request?: typeof http.request,
 *          fleet?: {find: (id: string) => object|null, isLocked?: (session: object) => boolean}|null,
 *          cli?: {authenticate: (headers: object) => Promise<{signedIn: {id: string, login: string}|null, error?: string}>}|null}} deps
 *   `fleet` and `cli` are for the command line's calls (`forCli`); without them it refuses every one
 * @returns {((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, login: string) => void)
 *   & {forCli: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<void>}}
 */
export function createReviewProxy({ findFor, request = http.request, fleet = null, cli = null }) {
  function refuse(req, res, status, error) {
    req.resume();
    return reply(res, status, { ok: false, error });
  }

  function proxyReview(req, res, url, login) {
    if (!FORWARDED_METHODS.has(req.method)) return refuse(req, res, 405, 'method not allowed');
    // The page's own calls are same-origin. A write from another site is refused before it reaches a session.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req.headers)) {
      console.warn('console: review request refused, cross-origin', { method: req.method });
      return refuse(req, res, 403, 'cross-origin request refused');
    }
    const target = reviewTarget(url);
    if (!target) return refuse(req, res, 404, 'open this from a session\'s Review tab');
    const session = findFor(target.id, login);
    if (!session) return refuse(req, res, 404, 'no such session');
    return forward(req, res, target, session);
  }

  // The command line's way in: a token, never a cookie, so no browser check applies and a call carrying an Origin is a
  // page's and refused (cliSessions.mjs). Only the review's calls, never its page, on a running session of the token's
  // person's own, as the pipe into a session is (execPipe.mjs).
  async function forCli(req, res, url) {
    const why = (text, fields = {}) => console.warn('console: review call from the command line refused', { why: text, path: url.pathname.slice(0, 100), ...fields });
    if (!cli || !fleet) return refuse(req, res, 404, 'this console has no command line sign-in');
    if (!FORWARDED_METHODS.has(req.method)) return refuse(req, res, 405, 'method not allowed');
    if (req.headers.origin) {
      why('a browser\'s call');
      return refuse(req, res, 403, 'a command line token is for the woodshed command line, not a page');
    }
    const target = url.pathname === '/review' ? null : reviewTarget(url);
    if (!target) return refuse(req, res, 404, 'the command line reaches a review\'s calls, /reviews/claude-<id>/..., not its page');
    let checked;
    try {
      checked = await cli.authenticate(req.headers);
    } catch (err) {
      console.warn('console: review call from the command line not checked', { message: err.message });
      return refuse(req, res, 502, 'the console could not check the sign-in: try again in a moment');
    }
    if (!checked?.signedIn) {
      why('no valid token', { session: target.id });
      return refuse(req, res, 401, checked?.error || 'not signed in');
    }
    const { login, id: tokenId } = checked.signedIn;
    const session = fleet.find(target.id);
    if (!session || !ownerOnly(session, login) || session.kind === 'ask') {
      why('not theirs', { login, session: target.id });
      return refuse(req, res, 404, 'no session of yours by that id');
    }
    if (session.taintedAt || fleet.isLocked?.(session)) {
      why('tainted', { login, session: target.id });
      return refuse(req, res, 409, 'this session has seen production data: nothing reads it from outside');
    }
    // Reads are many (a poll every two seconds while an answer is on its way); the writes are each logged.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      console.log('console: review call from the command line', { login, token: tokenId, session: target.id, method: req.method, path: url.pathname.slice(0, 100) });
    }
    return forward(req, res, target, session);
  }

  function forward(req, res, target, session) {
    if (session.status !== 'running' || !session.endpoint) return refuse(req, res, 409, 'the session is not running');
    const { host, statusPort } = session.endpoint;
    const headers = { authorization: `Bearer ${session.token}`, [PULLS_HEADER]: sessionPulls(session) };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    // Node sends no body on a DELETE unless told how long it is, and the page deletes a comment with one.
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    else if (req.headers['transfer-encoding']) headers['transfer-encoding'] = 'chunked';
    const upstream = request({ host, port: statusPort, method: req.method, path: target.path, headers, timeout: TIMEOUT_MS }, (upRes) => {
      const type = upRes.headers['content-type'] || 'application/json';
      const passed = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (type.startsWith('image/')) passed['cross-origin-resource-policy'] = 'same-origin';
      // The Review tab frames the page, which the console otherwise forbids for every page.
      if (type.startsWith('text/html')) passed['content-security-policy'] = "frame-ancestors 'self'";
      res.writeHead(upRes.statusCode || 502, passed);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('statusd took too long')));
    upstream.on('error', (err) => {
      console.warn('console: statusd unreachable for a review call', { id: session.id, method: req.method, message: err.message });
      if (!res.headersSent) reply(res, 502, { ok: false, error: 'the session did not answer: try again in a moment' });
      else res.destroy();
    });
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) return;
      req.unpipe(upstream);
      upstream.destroy();
      if (!res.headersSent) reply(res, 413, { ok: false, error: 'that request is too large' });
    });
    req.pipe(upstream);
  }

  return Object.assign(proxyReview, { forCli });
}
