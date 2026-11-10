// A session's editor (VS Code, openvscode-server in the session), on the session's own app name:
//
//   ANY      https://<id>.<app domain>/__woodshed/code/*  ->  <session host>:<statusd port>/__woodshed/code/*
//   UPGRADE  the same, as a raw socket pipe: the workbench runs over a websocket
//
// Never on the console's own name: the workbench runs code the session controls (its extensions, and whatever answers
// on the editor's port), which on the console's origin would act with the console cookie of whoever opened it. The
// app's name already runs the session's own code, and its sign-in cookie is that one session's alone.
//
// Only someone who can open the session itself gets in: an app shared with members or by a link opens the app, never
// the editor. The proxy adds statusd's bearer token, which statusd drops before it forwards, and passes no cookie on.

import http from 'node:http';
import net from 'node:net';

import { isSameOrigin } from '../shared/sameOrigin.mjs';
import { IDENTITY_HEADER } from './trustedIdentity.mjs';

export const EDITOR_PATH = '/__woodshed/code';
// A browser says where a request came from; 'none' is a typed URL or a bookmark. A sibling session's app is
// 'same-site', and must not drive this one's editor.
const OWN_SITE = new Set(['same-origin', 'none']);
const PROXY_TIMEOUT_MS = 30_000;

/** @returns {boolean}  whether the path is the editor's, on a session's app name */
export function isEditorPath(pathname) {
  return pathname === EDITOR_PATH || String(pathname).startsWith(`${EDITOR_PATH}/`);
}

/**
 * Opening the editor is a navigation from the console, another name: that alone changes nothing. Everything after it
 * (its files, its calls) comes from the editor's own page.
 * @returns {boolean}
 */
export function isFromAnotherSite({ method, headers }) {
  const site = headers['sec-fetch-site'];
  if (!site || OWN_SITE.has(String(site))) return false;
  return !((method === 'GET' || method === 'HEAD') && headers['sec-fetch-mode'] === 'navigate');
}

/**
 * @typedef {{host: string, statusPort: number, sessionToken: string}} EditorTarget
 */

function upstreamHeaders(headers, { host, statusPort, sessionToken }) {
  const { authorization, cookie, [IDENTITY_HEADER]: identity, ...rest } = headers;
  // VS Code refuses a websocket whose Origin names another host than the one it was reached on.
  return { ...rest, host: `${host}:${statusPort}`, origin: `http://${host}:${statusPort}`, authorization: `Bearer ${sessionToken}` };
}

function refuse(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/**
 * @param {{id: string, target: EditorTarget|null}} ctx  `target` null when the viewer cannot open the session or it is
 *   not running
 */
export function handleEditorRequest(req, res, { id, target }) {
  if (isFromAnotherSite(req)) {
    const site = req.headers['sec-fetch-site'];
    console.warn('editor: request from another site refused', { id, site: String(site).slice(0, 40) });
    return refuse(res, 403, 'refused: open the editor from the console\n');
  }
  if (!target) return refuse(res, 404, 'no editor for that session\n');
  const upstream = http.request(
    { host: target.host, port: target.statusPort, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, target), timeout: PROXY_TIMEOUT_MS },
    (upRes) => {
      // A second policy, so the editor's own still holds: a browser enforces each.
      const own = upRes.headers['content-security-policy'];
      res.writeHead(upRes.statusCode || 502, { ...upRes.headers, 'content-security-policy': [own, "frame-ancestors 'self'"].flat().filter(Boolean) });
      upRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (err) => {
    console.warn('editor: proxy request failed', { id, message: err.message });
    if (res.headersSent) return res.destroy();
    refuse(res, 502, 'the session is unreachable\n');
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

/** @param {{id: string, target: EditorTarget|null}} ctx */
export function handleEditorUpgrade(req, socket, head, { id, target }) {
  // A websocket is not covered by the same-origin policy, and this one runs commands in the session.
  if (!isSameOrigin(req.headers)) {
    console.warn('editor: websocket from another origin refused', { id, origin: String(req.headers.origin).slice(0, 100) });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (!target) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const upstream = net.connect(target.statusPort, target.host, () => {
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
    console.warn('editor: websocket dropped', { id, message: err?.message });
    socket.destroy();
    upstream.destroy();
  }
  upstream.on('error', drop);
  socket.on('error', drop);
  socket.on('close', () => upstream.destroy());
}
