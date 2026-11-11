// Same-origin terminals and Redis viewers, after Woodshed's terminalProxy.mjs:
//
//   GET      /term/<id>/*    ->  <session host>:<ttyd port>/term/<id>/*         the Agent tab: claude's tmux
//   UPGRADE  /term/<id>/ws   ->  the same, as a raw socket pipe
//   GET      /shell/<id>/*   ->  <session host>:<shell ttyd port>/shell/<id>/*  the Terminal tab: a plain shell
//   UPGRADE  /shell/<id>/ws  ->  the same
//   ANY      /redis/<id>/*   ->  <session host>:<statusd port>/redis/<id>/*
//   ANY      /pg/<id>/*, /mongo/<id>/*  ->  the same: a private session's own pgweb and mongo-express
//
// The path passes through unchanged because each session's ttyds run with
// `--base-path /term/<id>` and `/shell/<id>`, and its redis-commander with `--url-prefix
// /redis/<id>`; statusd forwards the Redis paths to it. The proxy adds the
// credentials (ttyd's basic auth, statusd's bearer token), so neither token
// reaches the browser, and only sessions the console knows as running resolve
// to an endpoint.

import http from 'node:http';
import net from 'node:net';

import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { IDENTITY_HEADER } from './trustedIdentity.mjs';

const throughStatusd = (s) => ({ port: s.statusPort, authorization: `Bearer ${s.sessionToken}` });
// Each database engine's viewers (shared/databases/), such as /pg/<id>/, go through statusd as Redis's does.
const DATABASE_VIEWERS = viewersOf(ENGINE_NAMES);
const UPSTREAM = {
  term: (s) => ({ port: s.termPort, authorization: basicAuth(s.terminalToken) }),
  shell: (s) => ({ port: s.shellPort, authorization: basicAuth(s.terminalToken) }),
  redis: throughStatusd,
  ...Object.fromEntries(DATABASE_VIEWERS.map((v) => [v.route, throughStatusd])),
};
const ROUTE_RE = new RegExp(`^/(${Object.keys(UPSTREAM).join('|')})/([0-9a-f]{8})(?:/.*)?$`);
const VIEWER_NAMES = { redis: 'Redis', ...Object.fromEntries(DATABASE_VIEWERS.map((v) => [v.route, v.name])) };
// A browser says where a request came from; 'none' is a typed URL or a bookmark.
const OWN_SITE = new Set(['same-origin', 'none']);
const PROXY_TIMEOUT_MS = 30_000;

/**
 * @param {string} pathname
 * @returns {{app: 'term'|'shell', id: string}|null}  null when the path is not one of the two terminals
 */
export function parseTerminalPath(pathname) {
  const route = parseSessionAppPath(pathname);
  return route?.app === 'term' || route?.app === 'shell' ? route : null;
}

/**
 * @param {string} pathname
 * @returns {{app: 'term'|'shell'|'redis'|'pg'|'mongo', id: string}|null}
 */
export function parseSessionAppPath(pathname) {
  const match = ROUTE_RE.exec(pathname || '');
  return match ? { app: match[1], id: match[2] } : null;
}

/**
 * The viewers write without a token of their own, so a page on another site
 * must not be able to send requests to it through a signed-in browser.
 *
 * @returns {boolean}
 */
export function isFromAnotherSite(headers) {
  const site = headers['sec-fetch-site'];
  return Boolean(site) && !OWN_SITE.has(String(site));
}

/**
 * @param {string} token
 * @returns {string}  the Authorization header ttyd's `--credential woodshed:<token>` expects
 */
export function basicAuth(token) {
  return `Basic ${Buffer.from(`woodshed:${token}`).toString('base64')}`;
}

function upstreamHeaders(headers, { host, port, authorization }) {
  const { authorization: fromBrowser, cookie, [IDENTITY_HEADER]: identity, ...rest } = headers;
  return {
    ...rest,
    host: `${host}:${port}`,
    origin: `http://${host}:${port}`,
    authorization,
  };
}

/**
 * @typedef {{host: string, termPort: number, statusPort: number, shellPort?: number, terminalToken: string, sessionToken: string}} SessionTarget
 *   `shellPort` is missing for a session started before its image had the Terminal tab
 */

/**
 * @param {{targetFor: (id: string) => SessionTarget|null}} ctx
 * @returns {boolean}  false when the URL is not a terminal or Redis viewer path
 */
export function handleTerminalRequest(req, res, ctx) {
  const route = parseSessionAppPath(new URL(req.url || '/', 'http://console.invalid').pathname);
  if (!route) return false;
  const { app, id } = route;
  if (isFromAnotherSite(req.headers)) {
    console.warn('terminal: request from another site refused', { app, id, site: String(req.headers['sec-fetch-site']).slice(0, 40) });
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('refused: open this from the console\n');
    return true;
  }
  const session = ctx.targetFor(id);
  if (!session || (app === 'shell' && !session.shellPort)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(VIEWER_NAMES[app] ? `no ${VIEWER_NAMES[app]} viewer for that session\n` : 'no terminal for that session\n');
    return true;
  }
  const target = { host: session.host, ...UPSTREAM[app](session) };

  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers, target),
      timeout: PROXY_TIMEOUT_MS,
    },
    (upRes) => {
      // A page that framed a terminal could type into a live claude.
      res.writeHead(upRes.statusCode || 502, { ...upRes.headers, 'content-security-policy': "frame-ancestors 'self'" });
      upRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (err) => {
    console.warn('terminal: proxy request failed', { app, id, message: err.message });
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(VIEWER_NAMES[app] ? `${VIEWER_NAMES[app]} viewer unreachable\n` : 'terminal unreachable\n');
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
  return true;
}

/**
 * @param {{targetFor: (id: string) => SessionTarget|null}} ctx
 * @returns {boolean}  false when the URL is not a terminal path
 */
export function handleTerminalUpgrade(req, socket, head, ctx) {
  const route = parseTerminalPath(new URL(req.url || '/', 'http://console.invalid').pathname);
  if (!route) return false;
  const { app, id } = route;
  const session = ctx.targetFor(id);
  if (!session || (app === 'shell' && !session.shellPort)) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return true;
  }
  const target = { host: session.host, ...UPSTREAM[app](session) };

  const upstream = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(upstreamHeaders(req.headers, target))) {
      for (const v of [value].flat()) lines.push(`${key}: ${v}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  function drop(err) {
    console.warn('terminal: websocket dropped', { id, message: err?.message });
    socket.destroy();
    upstream.destroy();
  }
  upstream.on('error', drop);
  // Without these a tab closed mid-stream leaks the pair, or becomes an uncaught exception.
  socket.on('close', () => upstream.destroy());
  socket.on('error', drop);
  return true;
}
