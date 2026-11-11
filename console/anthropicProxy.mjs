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

import http from 'node:http';
import https from 'node:https';

const PREFIX = '/anthropic';
const TEAM_KEY_SECRET = 'anthropic-api-key';
// A key replaced on the Secrets page reaches sessions within this.
const TEAM_KEY_TTL_MS = 5 * 60_000;
// Ours to set, or the connection's own: never passed on.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key']);

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

  function forward(req, res, auth) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    Object.assign(headers, auth, { host: target.host });
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
    req.pipe(out);
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
      return refuse(res, 401, 'not an active Woodshed Cloud session');
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
    noteFirstCall(req, session, 'teamKey');
    return forward(req, res, { 'x-api-key': key });
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
    noteFirstCall(req, session, 'plan', login);
    return forward(req, res, { authorization: `Bearer ${token}` });
  }

  return { isProxyPath: isAnthropicPath, handle, teamCredential };
}
