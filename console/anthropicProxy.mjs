// claude's calls to Anthropic from shared sessions, on the session API's port. The real credential is added here, so
// a shared session holds neither the team key nor anyone's Claude token: only its own SESSION_TOKEN, which nothing
// takes but this port, which only session tasks reach, while the session is active. A private session's claude holds
// its owner's token and calls Anthropic directly (sessionApi.mjs); one from an image before that still comes here.
// The repo's own app in a session, if it calls Anthropic, does so itself, on the key its env file has (session/bin/claude keeps
// claude's variables from it).
//
//   /anthropic/<path>   x-api-key: <SESSION_TOKEN>             ->  api.anthropic.com/<path>, on the team key
//                       Authorization: Bearer <SESSION_TOKEN>  ->  the same, on the Claude plan the session runs on:
//                                                                  a private session's owner's, or a shared one's
//                                                                  starter's (its `plan`), and 403 for any other
//
// claude sends the second form when the entrypoint gives it the session token as CLAUDE_CODE_OAUTH_TOKEN, and keeps
// the plan's own behaviour, since only the bearer changes. Its connectivity check, HEAD /api/hello, carries no
// credential and is answered here.
//
// A tainted session (mcpRelay.mjs) reaches Anthropic only through here, and its calls are read before they go: one that
// asks Anthropic to reach anywhere on its behalf (web search, web fetch, an MCP server of the API's own connector, or an
// image or document given by URL) is refused, and so is one it cannot read as JSON, since those would take what the session saw past its network's lockdown (serverSideReach).

import http from 'node:http';
import https from 'node:https';

const PREFIX = '/anthropic';
const TEAM_KEY_SECRET = 'anthropic-api-key';
// A key replaced on the Secrets page reaches sessions within this.
const TEAM_KEY_TTL_MS = 5 * 60_000;
// Ours to set, or the connection's own: never passed on.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key']);
// The most of a tainted session's call that is read whole to check it: a long conversation with images fits.
export const MAX_TAINTED_BODY_BYTES = 64 * 1024 * 1024;
// Tools Anthropic runs on its own side, out on the internet: web search and fetch, and whatever comes after them.
const SERVER_REACH_RE = /^(web_search|web_fetch)/;

/**
 * @param {unknown} body  a call's JSON
 * @returns {string|null}  what in it would have Anthropic reach the internet for the session, or null
 */
export function serverSideReach(body) {
  if (!body || typeof body !== 'object') return null;
  const calls = Array.isArray(body.requests) ? body.requests.map((r) => r?.params) : [body];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    if (call.mcp_servers !== undefined) return 'the API\'s MCP connector';
    const tool = (Array.isArray(call.tools) ? call.tools : []).find((t) => SERVER_REACH_RE.test(String(t?.type ?? '')));
    if (tool) return `the ${String(tool.type).replace(/_\d+$/, '')} tool`;
    // An image or a document given by URL, anywhere in the call (a tool result's content too): Anthropic fetches it.
    if (urlSourceIn(call)) return 'content given by URL';
  }
  return null;
}

function urlSourceIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 64) return false;
  if (Array.isArray(value)) return value.some((item) => urlSourceIn(item, depth + 1));
  if (value.source && typeof value.source === 'object' && String(value.source.type ?? '').toLowerCase() === 'url') return true;
  return Object.values(value).some((item) => urlSourceIn(item, depth + 1));
}

/** @returns {boolean}  whether a session API path is this proxy's */
export function isAnthropicPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function refuse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type: code === 401 ? 'authentication_error' : 'permission_error', message } }));
}

/** @returns {{token: string, via: 'apiKey'|'plan'}|null}  the session token a request carries, and how */
export function proxyCredential(headers) {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) return { token: apiKey, via: 'apiKey' };
  const bearer = /^Bearer (\S+)$/.exec(String(headers.authorization ?? ''))?.[1];
  return bearer ? { token: bearer, via: 'plan' } : null;
}

/** @returns {string|null}  whose Claude plan the session runs on: the fleet set `plan` from startedBy at launch */
function planOf(session) {
  if (session.owner) return session.owner;
  return session.plan && session.plan === session.startedBy ? session.plan : null;
}

/**
 * @param {{userSettings?: {claudeToken: (login: string) => Promise<string|null>, view: (login: string) => {claudeToken: {savedAt: string|null}}}|null,
 *          secrets?: {read: (name: string) => Promise<string|null>}|null,
 *          teamKey?: string|null,  the key itself, where there is no Secrets Manager (the docker launcher's env file)
 *          upstream?: string, now?: () => number}} opts
 * @returns {{isProxyPath: (pathname: string) => boolean,
 *            handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, session: object|null, via: string|null) => Promise<void>,
 *            teamCredential: () => Promise<string|null>}}  the team key, for the console's own calls too
 */
export function createAnthropicProxy({ userSettings = null, secrets = null, teamKey = null, upstream = 'https://api.anthropic.com', now = Date.now }) {
  const target = new URL(upstream);
  const transport = target.protocol === 'http:' ? http : https;
  const planTokens = new Map();
  let team = null;
  let teamRead = null;
  // Which credential each session's calls went out on, and from what, logged once per session, route and caller:
  // with Anthropic's usage per key or plan, that says where a session spent, and a caller other than claude-cli
  // (the backend's SDK says Anthropic/JS) means something besides claude got claude's variables. A few bytes a
  // session, for the console's lifetime.
  const routed = new Set();

  function noteFirstCall(req, session, via, plan = null) {
    const caller = String(req.headers['user-agent'] ?? 'none').split(/[ /]/)[0].slice(0, 40);
    const key = `${session.id}:${via}:${caller}`;
    if (routed.has(key)) return;
    routed.add(key);
    console.log('anthropicProxy: first call', { sessionId: session.id, via, plan, caller });
  }

  // Calls that arrive while the key is being read wait for that one read.
  function teamCredential() {
    if (!secrets) return Promise.resolve(teamKey);
    if (team && now() - team.at < TEAM_KEY_TTL_MS) return Promise.resolve(team.key);
    teamRead ??= secrets.read(TEAM_KEY_SECRET).then((stored) => {
      // A console with no stored key, such as a local one whose store is not chosen yet, uses its settings'.
      const key = stored ?? teamKey;
      team = { key, at: now() };
      console.log('anthropicProxy: team key read', { set: Boolean(key) });
      return key;
    }).finally(() => { teamRead = null; });
    return teamRead;
  }

  // Kept until the person saves another or removes it: the saved time is the cache key, and reading it costs no AWS.
  async function planCredential(login) {
    const savedAt = userSettings?.view(login).claudeToken.savedAt ?? null;
    if (!savedAt) return null;
    const cached = planTokens.get(login);
    if (cached?.savedAt === savedAt) return cached.token;
    const token = await userSettings.claudeToken(login);
    planTokens.set(login, { savedAt, token });
    console.log('anthropicProxy: Claude token read', { login, set: Boolean(token) });
    return token;
  }

  function forward(req, res, auth, body = null) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    Object.assign(headers, auth, { host: target.host });
    if (body) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
    }
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: req.url.slice(PREFIX.length) || '/', headers,
    }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('anthropicProxy: Anthropic not reached', { path: req.url, message: err?.message });
      if (!res.headersSent) return refuse(res, 502, 'the console could not reach Anthropic');
      res.destroy();
    });
    // claude cancels a turn by closing its request: the call to Anthropic goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    if (body) out.end(body);
    else req.pipe(out);
  }

  // A tainted session's call, read whole and checked before it goes: null when it was refused (and answered).
  async function checkedBody(req, res, session) {
    if (!session.taintedAt || req.method === 'GET' || req.method === 'HEAD') return undefined;
    // Read, or not sent: a call the console cannot check never goes.
    if (req.method !== 'POST' || !/json/i.test(String(req.headers['content-type'] ?? ''))) {
      req.resume();
      console.warn('anthropicProxy: refused, a tainted session\'s call the console cannot read', { sessionId: session.id, method: req.method });
      refuse(res, 415, 'this session has seen production data, so only JSON calls the console can check go to Anthropic');
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
      refuse(res, 400, 'this session has seen production data, so a call the console cannot read as JSON does not go to Anthropic');
      return null;
    }
    const reach = serverSideReach(parsed);
    if (reach) {
      console.warn('anthropicProxy: refused, a tainted session asked Anthropic to reach the internet', { sessionId: session.id, what: reach });
      refuse(res, 403, `this session has seen production data, so ${reach} is off: Anthropic would reach the internet for it`);
      return null;
    }
    return body;
  }

  async function handle(req, res, session, via) {
    const path = new URL(req.url, 'http://console').pathname;
    if (path === `${PREFIX}/api/hello`) {
      req.resume();
      res.writeHead(200, { 'cache-control': 'no-store' });
      return res.end();
    }
    if (!session) {
      req.resume();
      console.warn('anthropicProxy: refused, no active session has that token', { path, from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed session');
    }
    try {
      return await (via === 'apiKey' ? teamCall(req, res, session) : planCall(req, res, session));
    } catch (err) {
      // Secrets Manager failing: this call fails, and claude retries it.
      req.resume();
      console.warn('anthropicProxy: credential not read', { sessionId: session.id, via, message: err?.message });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
  }

  async function teamCall(req, res, session) {
    const key = await teamCredential();
    if (!key) {
      req.resume();
      console.warn('anthropicProxy: no team key saved', { sessionId: session.id });
      return refuse(res, 503, 'the console has no Anthropic key: set anthropic-api-key on the Secrets page');
    }
    const body = await checkedBody(req, res, session);
    if (body === null) return;
    noteFirstCall(req, session, 'teamKey');
    return forward(req, res, { 'x-api-key': key }, body);
  }

  async function planCall(req, res, session) {
    const login = planOf(session);
    if (!login) {
      req.resume();
      console.warn('anthropicProxy: refused, the session runs on no Claude plan', { sessionId: session.id });
      return refuse(res, 403, 'this session runs on the team key, not a Claude plan');
    }
    const token = await planCredential(login);
    if (!token) {
      req.resume();
      console.warn('anthropicProxy: no Claude token saved for the plan', { sessionId: session.id, plan: login });
      return refuse(res, 401, `@${login} has no Claude token saved on My settings`);
    }
    const body = await checkedBody(req, res, session);
    if (body === null) return;
    noteFirstCall(req, session, 'plan', login);
    return forward(req, res, { authorization: `Bearer ${token}` }, body);
  }

  return { isProxyPath: isAnthropicPath, handle, teamCredential };
}
