// codex's calls to OpenAI from private Codex sessions that have no sign-in of their own, on the session API's port. As the
// Anthropic proxy does for claude, the team key is added here, so the session holds only its SESSION_TOKEN, which nothing
// takes but this port, which only session tasks reach, while the session is active. A session that runs on its owner's
// own Codex sign-in calls OpenAI directly and never comes here.
//
//   /openai/<path>   Authorization: Bearer <SESSION_TOKEN>  ->  api.openai.com/<path>, on the team key
//
// Only a Codex session may use it: any other kind of session has no business with the key.

import http from 'node:http';
import https from 'node:https';

const PREFIX = '/openai';
const TEAM_KEY_SECRET = 'openai-api-key';
// A key replaced on the Secrets page reaches sessions within this.
const TEAM_KEY_TTL_MS = 5 * 60_000;
// Ours to set, or the connection's own: never passed on.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key']);

/** @returns {boolean}  whether a session API path is this proxy's */
export function isOpenAiPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function refuse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: code === 401 ? 'authentication_error' : 'permission_error', message } }));
}

/** @returns {string|null}  the session token a request carries as its bearer */
export function bearerOf(headers) {
  return /^Bearer (\S+)$/.exec(String(headers.authorization ?? ''))?.[1] ?? null;
}

/**
 * @param {{secrets?: {read: (name: string) => Promise<string|null>}|null,
 *          teamKey?: string|null,  the key itself, where there is no Secrets Manager (the docker launcher's env file)
 *          upstream?: string, now?: () => number}} opts
 * @returns {{isProxyPath: (pathname: string) => boolean,
 *            handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, session: object|null) => Promise<void>,
 *            teamCredential: () => Promise<string|null>}}
 */
export function createOpenAiProxy({ secrets = null, teamKey = null, upstream = 'https://api.openai.com', now = Date.now }) {
  const target = new URL(upstream);
  const transport = target.protocol === 'http:' ? http : https;
  let team = null;
  let teamRead = null;
  const routed = new Set();

  // Calls that arrive while the key is being read wait for that one read.
  function teamCredential() {
    if (!secrets) return Promise.resolve(teamKey);
    if (team && now() - team.at < TEAM_KEY_TTL_MS) return Promise.resolve(team.key);
    teamRead ??= secrets.read(TEAM_KEY_SECRET).then((stored) => {
      // A console with no stored key, such as a local one whose store is not chosen yet, uses its settings'.
      const key = stored ?? teamKey;
      team = { key, at: now() };
      console.log('openaiProxy: team key read', { set: Boolean(key) });
      return key;
    }).finally(() => { teamRead = null; });
    return teamRead;
  }

  function forward(req, res, key) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    Object.assign(headers, { authorization: `Bearer ${key}`, host: target.host });
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: req.url.slice(PREFIX.length) || '/', headers,
    }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('openaiProxy: OpenAI not reached', { path: req.url, message: err?.message });
      if (!res.headersSent) return refuse(res, 502, 'the console could not reach OpenAI');
      res.destroy();
    });
    // codex cancels a turn by closing its request: the call to OpenAI goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  }

  async function handle(req, res, session) {
    if (!session) {
      req.resume();
      console.warn('openaiProxy: refused, no active session has that token', { from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed Cloud session');
    }
    if (session.options?.agent !== 'codex') {
      req.resume();
      console.warn('openaiProxy: refused, not a Codex session', { sessionId: session.id });
      return refuse(res, 403, 'only a Codex session may use the team\'s OpenAI key');
    }
    let key;
    try {
      key = await teamCredential();
    } catch (err) {
      // Secrets Manager failing: this call fails, and codex retries it.
      req.resume();
      console.warn('openaiProxy: credential not read', { sessionId: session.id, message: err?.message });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
    if (!key) {
      req.resume();
      console.warn('openaiProxy: no team key saved', { sessionId: session.id });
      return refuse(res, 503, 'the console has no OpenAI key: save your own Codex sign-in on My settings, or set openai-api-key on the Secrets page');
    }
    if (!routed.has(session.id)) {
      routed.add(session.id);
      console.log('openaiProxy: first call on the team key', { sessionId: session.id });
    }
    return forward(req, res, key);
  }

  return { isProxyPath: isOpenAiPath, handle, teamCredential };
}
