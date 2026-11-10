// Carries the shed's review page and its calls to the session that answers them (session/reviewShed). The page is the
// shed's own and talks to root-absolute paths, /review and /reviews/claude-<id>/..., so the console owns those two
// prefixes. It checks who is asking and that it is not another site, then forwards; it knows nothing of reviews, so a
// change to the page never lands here.

import http from 'node:http';

import { isSameOrigin } from '../shared/sameOrigin.mjs';

const SHED_PREFIX = '/shed-review';
const SESSION_PARAM_RE = /^claude-([0-9a-f]{8})$/;
const REVIEWS_RE = /^\/reviews\/claude-([0-9a-f]{8})(\/[A-Za-z0-9/-]*)?$/;
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
 * @param {{findFor: (id: string, login: string) => object|null, request?: typeof http.request}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, login: string) => void}
 */
export function createReviewProxy({ findFor, request = http.request }) {
  return function proxyReview(req, res, url, login) {
    if (!FORWARDED_METHODS.has(req.method)) {
      req.resume();
      return reply(res, 405, { ok: false, error: 'method not allowed' });
    }
    // The page's own calls are same-origin. A write from another site is refused before it reaches a session.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req.headers)) {
      req.resume();
      console.warn('console: review request refused, cross-origin', { method: req.method });
      return reply(res, 403, { ok: false, error: 'cross-origin request refused' });
    }
    const target = reviewTarget(url);
    if (!target) {
      req.resume();
      return reply(res, 404, { ok: false, error: 'open this from a session\'s Review tab' });
    }
    const session = findFor(target.id, login);
    if (!session) {
      req.resume();
      return reply(res, 404, { ok: false, error: 'no such session' });
    }
    if (session.status !== 'running' || !session.endpoint) {
      req.resume();
      return reply(res, 409, { ok: false, error: 'the session is not running' });
    }
    const { host, statusPort } = session.endpoint;
    const headers = { authorization: `Bearer ${session.token}` };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    // Node sends no body on a DELETE unless told how long it is, and the page deletes a comment with one.
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    else if (req.headers['transfer-encoding']) headers['transfer-encoding'] = 'chunked';
    const upstream = request({ host, port: statusPort, method: req.method, path: target.path, headers, timeout: TIMEOUT_MS }, (upRes) => {
      const type = upRes.headers['content-type'] || 'application/json';
      const passed = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
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
  };
}
