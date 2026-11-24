// Same-origin terminals and Redis viewers, after Woodshed's terminalProxy.mjs:
//
//   GET      /term/<id>/*    ->  <session host>:<ttyd port>/term/<id>/*         the TUI tab: claude's tmux
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
// to an endpoint. ttyd's own credential too: the terminal's first websocket message is
// the console's, with the size the browser asked for, and ttyd's /token, which would
// hand the credential to the page, answers 404.

import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { OP, encodeFrame } from '../shared/wsFrames.mjs';
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
// The terminal's first message is its size as JSON: a few dozen bytes. A browser that sends more is not a terminal.
const MAX_FIRST_MESSAGE = 4096;
// What a browser sent before its first message: a few pings at most, then a few dozen bytes. More is no terminal.
const MAX_BEFORE_FIRST = 16 * 1024;
const TERMINALS = new Set(['term', 'shell']);
// ttyd's answer to the upgrade is a status line and a few headers.
const MAX_ANSWER_HEAD = 16 * 1024;
const TOKEN_RE = /^\/(?:term|shell)\/[0-9a-f]{8}\/token$/;

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
 * A browser's websocket compression offer, with each of its messages compressed on its own (RFC 7692's
 * client_no_context_takeover), which ttyd agrees to: the console can then read the first one and send its own in its
 * place without the rest depending on it. ttyd's output stays compressed as it was.
 * @param {string|string[]|undefined} value  Sec-WebSocket-Extensions as the browser sent it
 * @returns {string|undefined}
 */
export function offerWithoutClientContext(value) {
  if (value === undefined) return undefined;
  return [value].flat().join(', ').split(',').map((offer) => {
    const params = offer.split(';').map((p) => p.trim()).filter(Boolean);
    if (params[0]?.toLowerCase() !== 'permessage-deflate' || params.some((p) => p.toLowerCase() === 'client_no_context_takeover')) return offer.trim();
    return [params[0], 'client_no_context_takeover', ...params.slice(1)].join('; ');
  }).join(', ');
}

/**
 * Whether a request is for ttyd's own page, `/<app>/<id>/`, written plainly: no encoding, doubled slash or parameter
 * that ttyd would read as another of its paths. A query passes (`?arg=agent-2`).
 * @param {string|undefined} url  the request's target as the browser sent it
 * @returns {boolean}
 */
export function isTerminalPage(url, app, id) {
  const raw = String(url || '').split('?')[0];
  return raw === `/${app}/${id}/` || raw === `/${app}/${id}`;
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
  // Of a ttyd, only its page goes on, by its own address as the browser sent it: ttyd reads `%74oken`, `//token` and
  // `token;x` as its /token, which hands out its credential. That page asks for /token, then sends what it got as its
  // first message: the console sends that message itself (handleTerminalUpgrade), so the page goes on without one.
  if (TERMINALS.has(app) && !isTerminalPage(req.url, app, id)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(TOKEN_RE.test(new URL(req.url || '/', 'http://console.invalid').pathname)
      ? 'no token here: the console gives the terminal its credential itself\n'
      : 'not found: the console passes on only the terminal\'s page\n');
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
  // ttyd's websocket alone, by its own address as written, as only its page goes on (isTerminalPage).
  if (!session || (app === 'shell' && !session.shellPort) || String(req.url || '').split('?')[0] !== `/${app}/${id}/ws`) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return true;
  }
  const target = { host: session.host, ...UPSTREAM[app](session) };
  // Until ttyd's answer is passed on, nothing pipes ttyd's side to the browser's: ttyd closing first must end it here.
  let answered = false;
  // Until the browser's first message went on, nothing pipes the browser's side to ttyd's.
  let piped = false;

  const credential = Buffer.from(`woodshed:${session.terminalToken}`).toString('base64');
  const upstream = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = upstreamHeaders(req.headers, target);
    if (headers['sec-websocket-extensions'] !== undefined) headers['sec-websocket-extensions'] = offerWithoutClientContext(headers['sec-websocket-extensions']);
    for (const [key, value] of Object.entries(headers)) {
      for (const v of [value].flat()) lines.push(`${key}: ${v}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    // ttyd's answer is read whole and passed on with each message of the browser's compressed on its own, whatever
    // ttyd said to that, then everything after it as it came.
    let answer = Buffer.alloc(0);
    const readAnswer = (chunk) => {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (answer.length > MAX_ANSWER_HEAD) drop(new Error('an answer from ttyd with no end to its headers'));
        return;
      }
      upstream.off('data', readAnswer);
      answered = true;
      socket.write(answerWithoutClientContext(answer.subarray(0, end + 4)));
      if (answer.length > end + 4) socket.write(answer.subarray(end + 4));
      upstream.pipe(socket);
    };
    upstream.on('data', readAnswer);
    // The browser's first message is read here and sent on as the console's; everything after it passes as it came.
    let buffered = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const readFirst = (chunk) => {
      if (chunk) buffered = Buffer.concat([buffered, chunk]);
      let first;
      try {
        first = takeFirstMessage(buffered, credential);
      } catch (err) {
        console.warn('terminal: first message refused', { app, id, message: err.message });
        socket.destroy();
        upstream.destroy();
        return;
      }
      if (!first) return;
      socket.off('data', readFirst);
      upstream.write(first.forward);
      piped = true;
      socket.pipe(upstream);
    };
    socket.on('data', readFirst);
    readFirst();
  });

  function drop(err) {
    console.warn('terminal: websocket dropped', { id, message: err?.message });
    socket.destroy();
    upstream.destroy();
  }
  upstream.on('error', drop);
  // After its answer, pipe() ends the browser's side once what ttyd sent is written; before it, the browser would wait
  // on a socket nothing writes to again, rather than see it close and open a new one.
  // The browser's side already gone (a tab closed mid-handshake, a first message refused) is the console's close, not
  // ttyd's.
  upstream.on('close', () => {
    if (!answered && !socket.destroyed) drop(new Error('ttyd closed before its answer'));
  });
  // A tab closed before its first message went on only ends its side (nothing pipes it to ttyd's yet, and an upgraded
  // socket stays half open): both go, or ttyd's would wait for a message that never comes. After it, pipe() ends ttyd's.
  socket.on('end', () => {
    if (piped) return;
    socket.destroy();
    upstream.destroy();
  });
  // Without these a tab closed mid-stream leaks the pair, or becomes an uncaught exception.
  socket.on('close', () => upstream.destroy());
  socket.on('error', drop);
  return true;
}

/**
 * ttyd's answer to a terminal's upgrade, with `client_no_context_takeover` on the compression it agreed to, should it
 * leave that out: the browser then compresses each message on its own (RFC 7692 lets an answer add it unasked), so the
 * first message the console sends in place of the browser's never leaves ttyd reading the rest against bytes it did
 * not see. ttyd 1.7.7 agrees to it when asked (offerWithoutClientContext); this holds if a later one does not.
 * @param {Buffer} head  the status line and headers, through the blank line
 * @returns {Buffer}
 */
export function answerWithoutClientContext(head) {
  const text = head.toString('latin1');
  const changed = text.replace(/^(sec-websocket-extensions:[ \t]*)(.*)$/gim, (_, name, value) => `${name}${offerWithoutClientContext(value.replace(/\r$/, ''))}${value.endsWith('\r') ? '\r' : ''}`);
  return changed === text ? head : Buffer.from(changed, 'latin1');
}

/**
 * One frame at the start of what a browser sent on a terminal's websocket, unmasked.
 * @param {Buffer} buf
 * @returns {{opcode: number, payload: Buffer, length: number}|null}  null until the whole frame is there; `length` is
 *   the bytes it took
 */
function readClientFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  // RSV1 is a compressed message (permessage-deflate); nothing here offers what RSV2 or RSV3 would be.
  const compressed = (buf[0] & 0x40) !== 0;
  if (buf[0] & 0x30) throw new Error('a frame with RSV2 or RSV3 set');
  if (compressed && opcode >= 0x8) throw new Error('a compressed control frame');
  if (!(buf[1] & 0x80)) throw new Error('an unmasked frame from a browser');
  let length = buf[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    throw new Error('a first message larger than a terminal sends');
  }
  if (opcode < 0x8 && (!fin || length > MAX_FIRST_MESSAGE)) throw new Error('a first message larger than a terminal sends');
  if (buf.length < at + 4 + length) return null;
  const key = buf.subarray(at, at + 4);
  let payload = Buffer.from(buf.subarray(at + 4, at + 4 + length).map((byte, i) => byte ^ key[i & 3]));
  if (compressed) {
    // Compressed on its own (offerWithoutClientContext), so it inflates with nothing before it.
    try {
      payload = zlib.inflateRawSync(Buffer.concat([payload, Buffer.from([0x00, 0x00, 0xff, 0xff])]), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_FIRST_MESSAGE });
    } catch {
      throw new Error('a first message that does not inflate');
    }
  }
  return { opcode, payload, length: at + 4 + length };
}

/** @returns {number}  a terminal's columns or rows as asked, or `fallback` for anything that is not one */
function dimension(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : fallback;
}

/**
 * What goes to ttyd in place of the browser's first message: ttyd's credential, from the console, and the size the
 * browser asked for, uncompressed, which a compressed connection allows for any message. Whatever credential the browser put in its own (ttyd's page sends the one /token gave it, which
 * is none now) is not passed on. Control frames before it (a ping) pass as they are.
 * @param {Buffer} buf  what the browser sent so far
 * @param {string} credential  base64 of `woodshed:<terminal token>`, as ttyd's `--credential` checks it
 * @returns {{forward: Buffer}|null}  null until the first message is all there; `forward` is the console's message,
 *   then every byte that came after it
 */
export function takeFirstMessage(buf, credential) {
  const passed = [];
  let at = 0;
  for (;;) {
    const frame = readClientFrame(buf.subarray(at));
    if (!frame) {
      if (buf.length > MAX_BEFORE_FIRST) throw new Error('more before the first message than a terminal sends');
      return null;
    }
    if (frame.opcode >= 0x8) {
      passed.push(buf.subarray(at, at + frame.length));
      at += frame.length;
      continue;
    }
    if (frame.opcode !== OP.text && frame.opcode !== OP.binary) throw new Error('a continuation frame first');
    let asked;
    try {
      asked = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      throw new Error('a first message that is not JSON');
    }
    const hello = { AuthToken: credential, columns: dimension(asked?.columns, 80), rows: dimension(asked?.rows, 24) };
    return { forward: Buffer.concat([...passed, encodeFrame(OP.text, JSON.stringify(hello)), buf.subarray(at + frame.length)]) };
  }
}
