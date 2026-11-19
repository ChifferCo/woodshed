// Production debugging for My Woodshed sessions: the console relays a session's MCP calls to the installation's
// woodshed-prod-mcp, which gives read-only, masked, audited access to production (its databases, logs, errors and
// the like). The session never holds a credential the MCP server takes: the relay adds a short-lived token the console
// signs as its OpenID Connect issuer (oidcIssuer.mjs), which woodshed-prod-mcp's `auth.oidc` trusts.
//
//   *  /prod-mcp[/...]   Authorization: Bearer <SESSION_TOKEN>  ->  WOODSHED_PROD_MCP_URL[/...], Streamable HTTP, with
//                        Authorization: Bearer <a token for audience woodshed-prod-mcp, sub private:<login>>
//
// The session's first call of any kind (initialize and tools/list included) taints it, before the call goes on: the
// fleet locks its network down and only then is the call forwarded (fleet.taint). A session that cannot be locked
// down is refused and stays untainted. Nothing ever makes a session untainted again.
//
// Off unless the installation sets WOODSHED_PROD_MCP_URL, and then only for the people and repos it lists. Only a
// private (My Woodshed) session of an allowed person, on an allowed repo, running claude, gets it: never a shared
// session, a question from Slack, a QA run or a review.

import http from 'node:http';
import https from 'node:https';

import { issuerFrom } from './oidcIssuer.mjs';
import { isAsk, isQa, isReview } from './sessions.mjs';

const PREFIX = '/prod-mcp';
export const PROD_MCP_AUDIENCE = 'woodshed-prod-mcp';
// The name claude knows the server by, in the session's --mcp-config and its disabled list (session/entrypoint.sh).
export const PROD_MCP_SERVER_NAME = 'woodshed-prod';
// Each token lasts this long; the relay makes a new one when less than a minute is left.
const TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_MARGIN_MS = 60_000;
// After this long stopped, a tainted session is removed, and with it everything it kept (fleet.mjs, removeTainted).
export const DEFAULT_TAINTED_REMOVE_HOURS = 24;
// What a call may carry on to the MCP server and what comes back: Streamable HTTP's own headers, never the session's
// Authorization, a cookie or anything hop-by-hop.
const REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'user-agent'];
const RESPONSE_DROPPED = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'proxy-authenticate', 'www-authenticate']);

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// `*` for anyone or any repo, otherwise a comma-separated list, compared without case. Empty is nobody.
function listOf(value) {
  const text = String(value ?? '').trim();
  if (text === '*') return '*';
  return new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function inList(list, value) {
  return list === '*' || Boolean(value && list.has(String(value).toLowerCase()));
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} publicUrl  the console's, the issuer unless WOODSHED_OIDC_ISSUER says otherwise
 * @returns {{url: string, people: Set<string>|'*', repos: Set<string>|'*', issuer: string, removeAfterMs: number}|null}
 *   null with no WOODSHED_PROD_MCP_URL, which keeps the relay, the issuer and every lockdown off
 */
export function prodMcpSettings(env, publicUrl) {
  const raw = String(env.WOODSHED_PROD_MCP_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`WOODSHED_PROD_MCP_URL is not a URL: ${raw.slice(0, 100)}`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('WOODSHED_PROD_MCP_URL must be an http(s) URL with no credentials in it');
  const hours = Number(env.WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS ?? DEFAULT_TAINTED_REMOVE_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS must be a number of hours above 0');
  return {
    url: url.toString().replace(/\/+$/, ''),
    people: listOf(env.WOODSHED_PROD_MCP_PEOPLE),
    repos: listOf(env.WOODSHED_PROD_MCP_REPOS),
    issuer: issuerFrom(env.WOODSHED_OIDC_ISSUER || publicUrl),
    removeAfterMs: hours * 3_600_000,
  };
}

/**
 * Whether a session may use production at all. Decided from the session and the settings alone, so the fleet asks it
 * at launch (to hand the session the MCP server, and on AWS a guarded network) and the relay at every call.
 * @param {object} session
 * @param {ReturnType<typeof prodMcpSettings>} settings
 * @param {string|null} repo  the session's project's repo, owner/name
 * @returns {{ok: true}|{ok: false, why: string}}
 */
export function prodMcpEligibility(session, settings, repo) {
  if (!settings) return { ok: false, why: 'this console gives no production access' };
  if (!session?.owner || isAsk(session) || isQa(session) || isReview(session)) return { ok: false, why: 'only a My Woodshed session can use production access' };
  if (session.options?.agent === 'codex') return { ok: false, why: 'a Codex session cannot use production access yet' };
  if (!inList(settings.people, session.owner)) return { ok: false, why: `@${session.owner} is not allowed production access on this console` };
  if (!inList(settings.repos, repo)) return { ok: false, why: `${repo ?? 'this repo'} is not allowed production access on this console` };
  return { ok: true };
}

/** @returns {boolean}  whether a session API path is the relay's */
export function isProdMcpPath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/**
 * @param {{settings: NonNullable<ReturnType<typeof prodMcpSettings>>, issuer: {sign: Function},
 *          fleet: {taint: (session: object, opts: object) => Promise<object>},
 *          repoOf: (session: object) => string|null, now?: () => number}} opts
 *   `repoOf` names the session's project's repo; `fleet.taint` locks the session down and marks it, or throws
 */
export function createProdMcpRelay({ settings, issuer, fleet, repoOf, now = Date.now }) {
  const target = new URL(settings.url);
  const transport = target.protocol === 'http:' ? http : https;
  const tokens = new Map();
  // The first relayed call of each session, logged once: every call after it is the same session's investigation.
  const relayed = new Set();

  async function tokenFor(session) {
    const held = tokens.get(session.id);
    if (held && held.expiresAt - now() > TOKEN_MARGIN_MS) return held.token;
    const repo = repoOf(session);
    const made = await issuer.sign({
      audience: PROD_MCP_AUDIENCE,
      subject: `private:${session.owner.toLowerCase()}`,
      ttlSeconds: TOKEN_TTL_SECONDS,
      claims: { login: session.owner.toLowerCase(), session_id: session.id, session_kind: 'private', repo },
    });
    if (tokens.size >= 500) tokens.clear();
    tokens.set(session.id, made);
    return made.token;
  }

  function forward(req, res, session, token) {
    const url = new URL(req.url, 'http://console');
    const suffix = url.pathname.slice(PREFIX.length);
    const headers = {};
    for (const name of REQUEST_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    headers.authorization = `Bearer ${token}`;
    headers.host = target.host;
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: `${target.pathname.replace(/\/+$/, '')}${suffix}${url.search}` || '/', headers,
    }, (answer) => {
      const back = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!RESPONSE_DROPPED.has(name)) back[name] = value;
      if (answer.statusCode === 401 || answer.statusCode === 403) {
        console.warn('prodMcp: the MCP server refused the console\'s token', { sessionId: session.id, status: answer.statusCode });
      }
      res.writeHead(answer.statusCode, back);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('prodMcp: MCP server not reached', { sessionId: session.id, message: err?.message });
      if (!res.headersSent) return reply(res, 502, { error: 'the console could not reach the production MCP server' });
      res.destroy();
    });
    // claude closes a stream it no longer wants (a cancelled call, the server's SSE on its way out): the call goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object|null} session  the active session whose token the call carries
   */
  async function handle(req, res, session) {
    if (!session) {
      req.resume();
      console.warn('prodMcp: refused, no active session has that token', { from: req.socket.remoteAddress });
      return reply(res, 401, { error: 'not an active Woodshed session' });
    }
    const allowed = prodMcpEligibility(session, settings, repoOf(session));
    if (!allowed.ok) {
      req.resume();
      console.warn('prodMcp: refused', { sessionId: session.id, owner: session.owner ?? null, why: allowed.why });
      return reply(res, 403, { error: allowed.why });
    }
    // The taint comes first, whatever the call: the body is not read until the session is locked down.
    if (!session.taintedAt) {
      try {
        await fleet.taint(session, { why: 'production MCP call' });
      } catch (err) {
        req.resume();
        const why = err?.shown ? err.message : 'the session could not be locked down';
        if (!err?.shown) console.error('prodMcp: taint failed', { sessionId: session.id, message: err?.message });
        console.warn('prodMcp: refused, the session was not locked down', { sessionId: session.id, owner: session.owner, why });
        return reply(res, 503, { error: `${why}. Production access needs the session locked down first, so this call was not sent.` });
      }
    }
    let token;
    try {
      token = await tokenFor(session);
    } catch (err) {
      req.resume();
      console.warn('prodMcp: token not signed', { sessionId: session.id, message: err?.message });
      return reply(res, err?.status ?? 503, { error: err?.shown ? err.message : 'the console could not sign a token for the MCP server' });
    }
    if (!relayed.has(session.id)) {
      if (relayed.size >= 2000) relayed.clear();
      relayed.add(session.id);
      console.log('prodMcp: first call relayed', { sessionId: session.id, owner: session.owner, repo: repoOf(session), taintedAt: session.taintedAt });
    }
    return forward(req, res, session, token);
  }

  return { isProxyPath: isProdMcpPath, handle };
}
