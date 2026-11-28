// Antigravity CLI's calls to the Gemini API from private sessions that run on the team's key, on the session API's port.
// As the OpenAI proxy does for codex (openaiProxy.mjs), the team key is added here, so the session holds only its
// SESSION_TOKEN, which nothing takes but this port, which only session tasks reach, while the session is active. A
// session that runs on its owner's own Google login (their Antigravity plan) calls Google itself and never comes here.
//
//   /gemini/<path>   x-goog-api-key: <SESSION_TOKEN>  ->  generativelanguage.googleapis.com/<path>, on the team key
//
// agy reaches it by GOOGLE_GEMINI_BASE_URL (session/bin/agy), with `modelProvider: "gemini"` in its settings.json and the
// session token as GEMINI_API_KEY. Measured with agy 1.5.18: a turn is one `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`
// with the key in `x-goog-api-key` and nothing in the query but `alt=sse`.
//
// Only an Antigravity session may use it: one started on it, or a private one whose owner started an Antigravity agent beside
// its own (fleet.allowAgent; runsAntigravity). And only what a model turn needs passes, each path with the one method it
// needs: the generate and count calls, and the model list. Not the Files API, cached contents, tuned models, batches or
// anything else the team's key can do: they would hold, or read, what other people's sessions put there.
//
// Every call is read before it goes, as JSON, and one that names something stored under the team's key is refused: a file
// (`fileData`, the Files API's or any address), a cached content (`cachedContent`) or a file search store. The proxy blocks
// those APIs' own paths, but a model call that names one by its resource name would still read it under the team's project,
// whoever put it there. A call the console cannot read as JSON does not go either.
//
// A session whose lockdown has started (fleet.isLocked) is refused at the door, and its calls on their way are cut from the
// moment each was authorized, a body still arriving included; each call is asked again, whole, just before it goes. A tainted
// session still running its own Antigravity reaches Google only through here, and its calls are also checked for what asks
// Google to reach out for it (grounding with Google Search, the URL context tool), which would take what the session saw
// past its network's lockdown, as anthropicProxy.mjs does for Anthropic's.

import http from 'node:http';
import https from 'node:https';
import { runsAntigravity } from './sessions.mjs';

const PREFIX = '/gemini';
const TEAM_KEY_SECRET = 'gemini-api-key';
// A key replaced on the Secrets page reaches sessions within this.
const TEAM_KEY_TTL_MS = 5 * 60_000;
// Ours to set, or the connection's own: never passed on. The key and project headers decide whose account a call is billed
// to and whose quota it uses: only the team key's.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key',
  'x-goog-api-key', 'x-goog-user-project', 'x-goog-request-params', 'cookie']);
// The most of a call that is read whole to check it: a long conversation with images fits.
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

// A path already in its plain form: no `.` or `..` segment, no empty one, no `%` escape and no backslash.
const UNPLAIN_PATH_RE = /[%\\]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/;
const MODEL = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
// What of the API an Antigravity session's calls may reach, each with its one method.
const CALLS = [
  { re: new RegExp(`^/v1(?:beta)?/models/${MODEL}:(?:streamGenerateContent|generateContent|countTokens)$`), method: 'POST' },
  { re: new RegExp(`^/v1(?:beta)?/models/${MODEL}$`), method: 'GET' },
  { re: /^\/v1(?:beta)?\/models$/, method: 'GET' },
];
// The one query a call carries (streaming's `alt=sse`), and a model list's paging.
const QUERY_OK_RE = /^(?:alt=sse|pageSize=\d{1,4}|pageToken=[A-Za-z0-9_-]{1,512})(?:&(?:alt=sse|pageSize=\d{1,4}|pageToken=[A-Za-z0-9_-]{1,512}))*$/;

/**
 * The Gemini path a session's call may reach, or null; what passes is what is forwarded, query and all.
 * @param {string} rawPath  the request's path and query, after /gemini
 * @param {string} method
 * @returns {string|null}
 */
export function geminiPathAllowed(rawPath, method) {
  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const search = q === -1 ? '' : rawPath.slice(q + 1);
  if (UNPLAIN_PATH_RE.test(pathname) || search.includes('#')) return null;
  if (!CALLS.some((c) => c.method === method && c.re.test(pathname))) return null;
  if (search && !QUERY_OK_RE.test(search)) return null;
  return search ? `${pathname}?${search}` : pathname;
}

// Tools Google runs on its own side, out on the internet.
const SERVER_REACH_TOOLS = new Set(['googleSearch', 'google_search', 'googleSearchRetrieval', 'google_search_retrieval', 'urlContext', 'url_context',
  'googleMaps', 'google_maps']);
// Tools that read a store of files kept under the key.
const STORE_TOOLS = new Set(['fileSearch', 'file_search']);

/**
 * What in a call names something stored under the team's key, which no session may use: a file or a cached content, anywhere
 * in the call (a count's `generateContentRequest` wraps one, and a system instruction holds parts too), or a file search
 * tool. Inline data (`inlineData`) is the session's own and passes.
 * @param {unknown} body  a call's JSON
 * @returns {string|null}
 */
export function storedResource(body) {
  if (!body || typeof body !== 'object') return null;
  return storedIn(body);
}

function storedIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 64) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = storedIn(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // A tool of a file search store, wherever the call carries its tools: a count wraps a whole request in `generateContentRequest`.
  if ([...STORE_TOOLS].some((name) => value[name] !== undefined)) return 'a file search store';
  if (value.cachedContent !== undefined || value.cached_content !== undefined) return 'cached content';
  if (value.fileData !== undefined || value.file_data !== undefined) return 'a file given by its name or address';
  for (const item of Object.values(value)) {
    const found = storedIn(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * @param {unknown} body  a call's JSON
 * @returns {string|null}  what in it would have Google reach out for the session, or null
 */
export function serverSideReach(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 64) return null;
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = serverSideReach(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Tools anywhere in the call: a count wraps a whole request in `generateContentRequest`.
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = Object.keys(tool ?? {}).find((k) => SERVER_REACH_TOOLS.has(k));
    if (name) return `the ${name} tool`;
  }
  for (const item of Object.values(body)) {
    const found = serverSideReach(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/** @returns {boolean}  whether a session API path is this proxy's */
export function isGeminiPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function refuse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { code, status: code === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED', message } }));
}

/** @returns {string|null}  the session token a request carries as its API key */
export function keyOf(headers) {
  const key = headers['x-goog-api-key'];
  return typeof key === 'string' && /^\S+$/.test(key) ? key : null;
}

/**
 * @param {{secrets?: {read: (name: string) => Promise<string|null>}|null,
 *          teamKey?: string|null,  for a program that embeds the console and keeps the key itself; never a session's environment
 *          upstream?: string, now?: () => number}} opts
 * @returns {{isProxyPath: (pathname: string) => boolean,
 *            handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, session: object|null) => Promise<void>,
 *            teamCredential: () => Promise<string|null>, cut: (sessionId: string) => void}}
 */
export function createGeminiProxy({ secrets = null, teamKey = null, upstream = 'https://generativelanguage.googleapis.com', now = Date.now } = {}) {
  const target = new URL(upstream);
  let team = null;
  let teamRead = null;
  const routed = new Set();
  // The calls on their way, by session: a lockdown cuts its session's (cut), so nothing it sends after its first relayed
  // production call rides a request opened before it.
  const open = new Map();

  // Calls that arrive while the key is being read wait for that one read.
  function teamCredential() {
    if (!secrets) return Promise.resolve(teamKey);
    if (team && now() - team.at < TEAM_KEY_TTL_MS) return Promise.resolve(team.key);
    teamRead ??= secrets.read(TEAM_KEY_SECRET).then((stored) => {
      // A console with no stored key, such as a local one whose store is not chosen yet, uses its settings'.
      const key = stored ?? teamKey;
      team = { key, at: now() };
      console.log('geminiProxy: team key read', { set: Boolean(key) });
      return key;
    }).finally(() => { teamRead = null; });
    return teamRead;
  }

  function forward(req, res, { path, key, call, body = null }) {
    const transport = target.protocol === 'http:' ? http : https;
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    Object.assign(headers, { 'x-goog-api-key': key, host: target.host });
    if (body) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path, headers,
    }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('geminiProxy: Google not reached', { path: req.url.split('?')[0], message: err?.message });
      if (!res.headersSent) return refuse(res, 502, 'the console could not reach Google');
      res.destroy();
    });
    // agy cancels a turn by closing its request: the call to Google goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    call.out = out;
    if (body) out.end(body);
    else req.pipe(out);
  }

  /**
   * A call, tracked from the moment it is authorized, before its body is read: a lockdown cuts it whatever stage it is at,
   * a body still arriving included, and `cut` marks it so nothing is forwarded after.
   */
  function track(req, res, sessionId) {
    const call = { req, res, out: null, cut: false };
    if (!open.has(sessionId)) open.set(sessionId, new Set());
    open.get(sessionId).add(call);
    res.on('close', () => {
      open.get(sessionId)?.delete(call);
      if (!open.get(sessionId)?.size) open.delete(sessionId);
    });
    return call;
  }

  /** Every call of the session's still on its way, ended: its lockdown has started (fleet.onLocking). */
  function cut(sessionId) {
    const calls = open.get(sessionId);
    if (!calls?.size) return;
    console.log('geminiProxy: calls cut at the lockdown', { sessionId, calls: calls.size });
    for (const call of calls) {
      call.cut = true;
      call.out?.destroy();
      call.req.destroy();
      call.res.destroy();
    }
    open.delete(sessionId);
  }

  // A call, read whole and checked before it goes: null when it was refused (and answered), undefined for a call with no body.
  // Every session's is, for what is stored under the team's key; a tainted session's also for what has Google reach out.
  async function checkedBody(req, res, session) {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    // Read, or not sent: a call the console cannot check never goes.
    if (req.method !== 'POST' || !/json/i.test(String(req.headers['content-type'] ?? ''))) {
      req.resume();
      console.warn('geminiProxy: refused, a call the console cannot read', { sessionId: session.id, method: req.method, tainted: Boolean(session.taintedAt) });
      refuse(res, 415, 'only JSON calls the console can check go to Google');
      return null;
    }
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          req.resume();
          refuse(res, 413, 'this call is larger than the console reads');
          return null;
        }
        chunks.push(chunk);
      }
    } catch (err) {
      // The request ended before its body did: agy gave up on the turn, or a lockdown cut it. Nothing goes, and nobody is left to answer.
      console.log('geminiProxy: call ended before its body did', { sessionId: session.id, why: err?.code ?? 'closed' });
      return null;
    }
    const body = Buffer.concat(chunks);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      refuse(res, 400, 'a call the console cannot read as JSON does not go to Google');
      return null;
    }
    const stored = storedResource(parsed);
    if (stored) {
      console.warn('geminiProxy: refused, a call named something stored under the team key', { sessionId: session.id, what: stored });
      refuse(res, 403, `${stored} is off: it would be read under the team's key, whoever stored it`);
      return null;
    }
    // Asked now, with the body read: a lockdown that started while it arrived makes this a tainted session's call.
    const reach = session.taintedAt ? serverSideReach(parsed) : null;
    if (reach) {
      console.warn('geminiProxy: refused, a tainted session asked Google to reach out', { sessionId: session.id, what: reach });
      refuse(res, 403, `this session has seen production data, so ${reach} is off: Google would reach out for it`);
      return null;
    }
    return body;
  }

  async function handle(req, res, session, isLocked = null) {
    if (!session) {
      req.resume();
      console.warn('geminiProxy: refused, no active session has that token', { from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed session');
    }
    if (!runsAntigravity(session) || isLocked?.(session)) {
      req.resume();
      console.warn('geminiProxy: refused, not an Antigravity session', { sessionId: session.id });
      return refuse(res, 403, 'only an Antigravity session may use the team\'s Gemini key');
    }
    const path = geminiPathAllowed(req.url.slice(PREFIX.length) || '/', req.method);
    if (!path) {
      req.resume();
      console.warn('geminiProxy: refused a path Antigravity does not need', { sessionId: session.id, method: req.method, path: req.url.split('?')[0].slice(0, 120) });
      return refuse(res, 404, 'not something Antigravity needs');
    }
    // From here the call is cut by a lockdown, whatever it is waiting for: the key's read, or the rest of its body.
    const call = track(req, res, session.id);
    let key;
    try {
      key = await teamCredential();
    } catch (err) {
      // Secrets Manager failing: this call fails, and agy retries it.
      req.resume();
      console.warn('geminiProxy: credential not read', { sessionId: session.id, message: err?.message });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
    if (!key) {
      req.resume();
      console.warn('geminiProxy: no team key saved', { sessionId: session.id });
      return refuse(res, 503, 'the console has no Gemini key: save your own Antigravity sign-in on My settings, or set gemini-api-key on the Secrets page');
    }
    const body = await checkedBody(req, res, session);
    if (body === null) return;
    // Asked again last, with the whole call in hand and just before it goes: a lockdown that started while the key was read or
    // the body arrived took the session's Antigravity agent's access, and a call it cut goes nowhere.
    if (call.cut || !runsAntigravity(session) || isLocked?.(session)) {
      req.resume();
      console.warn('geminiProxy: refused, the session was locked down while the call was on its way', { sessionId: session.id });
      return refuse(res, 403, 'only an Antigravity session may use the team\'s Gemini key');
    }
    if (!routed.has(session.id)) {
      routed.add(session.id);
      console.log('geminiProxy: first call on the team key', { sessionId: session.id, extra: session.options?.agent !== 'antigravity' });
    }
    return forward(req, res, { path, key, call, body: body ?? null });
  }

  return { isProxyPath: isGeminiPath, handle, teamCredential, cut };
}
