// A session's running app (the repo's own), on a name of its own:
//
//   ANY      https://<id>.<app domain>/*  ->  <session host>:<statusd port>/*, with `x-woodshed-app`
//   UPGRADE  the same, as a raw socket pipe (Next's hot reload, the agent's live updates)
//
// statusd checks the session token in `x-woodshed-app`, drops it and forwards to the app's frontend on
// the session's loopback, so no new port opens on a session. The app runs at `/` as it does locally;
// its own Authorization header and cookies pass through untouched, except the console's app sign-in and share cookies,
// and a hosting proxy's identity header (trustedIdentity.mjs) never does.

import http from 'node:http';
import net from 'node:net';

import { IDENTITY_HEADER } from './trustedIdentity.mjs';

const APP_HEADER = 'x-woodshed-app';
const ID_RE = /^([0-9a-f]{8})$/;
const PROXY_TIMEOUT_MS = 120_000;

/**
 * @param {string|undefined} hostHeader
 * @param {string} appDomain  e.g. `woodshed.example.com`; empty turns session apps off
 * @returns {string|null}  the session id when the request is for `<id>.<appDomain>`
 */
export function appIdFor(hostHeader, appDomain) {
  if (!appDomain || typeof hostHeader !== 'string') return null;
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  const suffix = `.${appDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  return ID_RE.exec(hostname.slice(0, -suffix.length))?.[1] ?? null;
}

/**
 * @param {string|undefined} header  the request's Cookie header
 * @param {string|string[]|undefined} names  the cookies the app must not see
 * @returns {string|undefined}  the header without them, or undefined when nothing is left
 */
export function withoutCookie(header, names) {
  const dropped = [names].flat().filter(Boolean);
  if (!header || !dropped.length) return header;
  const kept = String(header).split(';').filter((part) => !dropped.includes(part.split('=')[0].trim())).map((part) => part.trim());
  return kept.filter(Boolean).join('; ') || undefined;
}

function upstreamHeaders(headers, session, dropCookie) {
  const { [IDENTITY_HEADER]: identity, ...rest } = headers;
  const out = { ...rest, [APP_HEADER]: `Bearer ${session.sessionToken}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': headers.host };
  const cookie = withoutCookie(headers.cookie, dropCookie);
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  return out;
}

function notRunningPage(id, publicUrl) {
  const sessionUrl = `${publicUrl}/s/${id}`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>App not running</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">This session's app is not running</h1>
<p>Start it from the session's page in the console, then reload this page.</p>
<p><a href="${sessionUrl}">Open session ${id} in the console</a></p>`;
}

/**
 * @typedef {{host: string, statusPort: number, sessionToken: string}} AppTarget
 * @param {{id: string, targetFor: (id: string) => AppTarget|null, publicUrl: string, dropCookie?: string|string[]}} ctx
 */
export function handleAppRequest(req, res, { id, targetFor, publicUrl, dropCookie }) {
  const session = targetFor(id);
  if (!session) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no running session with that id\n');
    return;
  }
  const upstream = http.request(
    { host: session.host, port: session.statusPort, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, session, dropCookie), timeout: PROXY_TIMEOUT_MS },
    (upRes) => {
      if (upRes.statusCode === 503 && upRes.headers[APP_HEADER] === 'down') {
        upRes.resume();
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(notRunningPage(id, publicUrl));
        return;
      }
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (err) => {
    console.warn('app: proxy request failed', { id, message: err.message });
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('the session is unreachable\n');
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

/** @param {{id: string, targetFor: (id: string) => AppTarget|null, dropCookie?: string|string[]}} ctx */
export function handleAppUpgrade(req, socket, head, { id, targetFor, dropCookie }) {
  const session = targetFor(id);
  if (!session) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const upstream = net.connect(session.statusPort, session.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(upstreamHeaders(req.headers, session, dropCookie))) {
      for (const v of [value].flat()) lines.push(`${key}: ${v}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  function drop(err) {
    console.warn('app: websocket dropped', { id, message: err?.message });
    socket.destroy();
    upstream.destroy();
  }
  upstream.on('error', drop);
  socket.on('error', drop);
  socket.on('close', () => upstream.destroy());
}
