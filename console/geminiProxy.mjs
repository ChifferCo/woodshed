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
// A session that has seen production data (a tainted one) reaches Google only through here, and each call is read before it
// goes: one that asks Google to reach out for it (grounding with Google Search, the URL context tool, a file given by URL)
// is refused, and so is one the console cannot read as JSON, since those would take what the session saw past its
// network's lockdown, as anthropicProxy.mjs does for Anthropic's.

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
// The most of a tainted session's call that is read whole to check it: a long conversation with images fits.
export const MAX_TAINTED_BODY_BYTES = 64 * 1024 * 1024;

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
  'googleMaps', 'google_maps', 'fileSearch', 'file_search']);

/**
 * @param {unknown} body  a call's JSON
 * @returns {string|null}  what in it would have Google reach out for the session, or null
 */
export function serverSideReach(body) {
  if (!body || typeof body !== 'object') return null;
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = Object.keys(tool ?? {}).find((k) => SERVER_REACH_TOOLS.has(k));
    if (name) return `the ${name} tool`;
  }
  if (body.cachedContent !== undefined || body.cached_content !== undefined) return 'cached content';
  if (fileByUrlIn(body)) return 'a file given by its address';
  return null;
}

// A part that names a file by address (`fileData.fileUri`: a URL, a YouTube link, a stored file), anywhere in the call.
function fileByUrlIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 64) return false;
  if (Array.isArray(value)) return value.some((item) => fileByUrlIn(item, depth + 1));
  const file = value.fileData ?? value.file_data;
  if (file && typeof file === 'object' && (file.fileUri ?? file.file_uri)) return true;
  return Object.values(value).some((item) => fileByUrlIn(item, depth + 1));
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
 *          teamKey?: string|null,  the key itself, where there is no Secrets Manager (the docker launcher's env file)
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

  function forward(req, res, { path, key, sessionId, body = null }) {
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
    if (!open.has(sessionId)) open.set(sessionId, new Set());
    const call = { req, res, out };
    open.get(sessionId).add(call);
    res.on('close', () => {
      open.get(sessionId)?.delete(call);
      if (!open.get(sessionId)?.size) open.delete(sessionId);
    });
    if (body) out.end(body);
    else req.pipe(out);
  }

  /** Every call of the session's still on its way, ended: its lockdown has started (fleet.onLocking). */
  function cut(sessionId) {
    const calls = open.get(sessionId);
    if (!calls?.size) return;
    console.log('geminiProxy: calls cut at the lockdown', { sessionId, calls: calls.size });
    for (const { req, res, out } of calls) {
      out.destroy();
      req.destroy();
      res.destroy();
    }
    open.delete(sessionId);
  }

  // A tainted session's call, read whole and checked before it goes: null when it was refused (and answered).
  async function checkedBody(req, res, session) {
    if (!session.taintedAt || req.method === 'GET' || req.method === 'HEAD') return undefined;
    if (req.method !== 'POST' || !/json/i.test(String(req.headers['content-type'] ?? ''))) {
      req.resume();
      console.warn('geminiProxy: refused, a tainted session\'s call the console cannot read', { sessionId: session.id, method: req.method });
      refuse(res, 415, 'this session has seen production data, so only JSON calls the console can check go to Google');
      return null;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_TAINTED_BODY_BYTES) {
        req.resume();
        refuse(res, 413, 'this call is larger than the console reads for a session that has seen production data');
        return null;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      refuse(res, 400, 'this session has seen production data, so a call the console cannot read as JSON does not go to Google');
      return null;
    }
    const reach = serverSideReach(parsed);
    if (reach) {
      console.warn('geminiProxy: refused, a tainted session asked Google to reach out', { sessionId: session.id, what: reach });
      refuse(res, 403, `this session has seen production data, so ${reach} is off: Google would reach out for it`);
      return null;
    }
    return body;
  }

  async function handle(req, res, session) {
    if (!session) {
      req.resume();
      console.warn('geminiProxy: refused, no active session has that token', { from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed session');
    }
    if (!runsAntigravity(session)) {
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
    // Asked again after the key's read: a lockdown that started meanwhile took the session's Antigravity agent's access.
    if (!runsAntigravity(session)) {
      req.resume();
      console.warn('geminiProxy: refused, not an Antigravity session', { sessionId: session.id });
      return refuse(res, 403, 'only an Antigravity session may use the team\'s Gemini key');
    }
    const body = await checkedBody(req, res, session);
    if (body === null) return;
    if (!routed.has(session.id)) {
      routed.add(session.id);
      console.log('geminiProxy: first call on the team key', { sessionId: session.id, extra: session.options?.agent !== 'antigravity' });
    }
    return forward(req, res, { path, key, sessionId: session.id, body: body ?? null });
  }

  return { isProxyPath: isGeminiPath, handle, teamCredential, cut };
}
