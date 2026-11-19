// The console's MCP relay: a session's claude reaches each MCP server the console hands it (mcpServers.mjs) here, with
// its own session token, and the console sends the call on with what the server takes, which the session never sees.
//
//   *  /mcp/<name>[/...]   Authorization: Bearer <SESSION_TOKEN>  ->  the server's URL[/...], Streamable HTTP, with
//                          the server's auth: a token the console signs (oidc, audience as set, sub private:<login> or
//                          session:<id>), a header from the secret store (header), or nothing (none)
//   *  /prod-mcp[/...]     the same, for the installation's environment's server (woodshed-prod)
//
// A production server's first call from a session, of any kind (initialize and tools/list included), taints the
// session before the call goes on: the fleet locks its network down and only then is the call forwarded (fleet.taint).
// A session that cannot be locked down is refused and stays untainted. Nothing ever makes a session untainted again,
// and a tainted session's calls to any other server are refused.

import http from 'node:http';
import https from 'node:https';

import { ENVIRONMENT_SERVER_NAME, isLinkLocal, mcpLookup, serverEligibility } from './mcpServers.mjs';

const PREFIX = '/mcp/';
const LEGACY = '/prod-mcp';
// Each token lasts this long; the relay makes a new one when less than a minute is left.
const TOKEN_TTL_SECONDS = 5 * 60;
const TOKEN_MARGIN_MS = 60_000;
// A header's value is read from the secret store at most this often.
const HEADER_CACHE_MS = 60_000;
// What a call may carry on to the MCP server and what comes back: Streamable HTTP's own headers, never the session's
// Authorization, a cookie or anything hop-by-hop.
const REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'user-agent'];
const RESPONSE_DROPPED = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'proxy-authenticate', 'www-authenticate']);

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** @returns {boolean}  whether a session API path is the relay's */
export function isMcpPath(pathname) {
  return pathname === LEGACY || pathname.startsWith(`${LEGACY}/`) || (pathname.startsWith(PREFIX) && pathname.length > PREFIX.length);
}

/** @returns {{name: string, suffix: string}|null}  which server a path is for, and the rest of it */
export function serverOfPath(pathname) {
  if (pathname === LEGACY || pathname.startsWith(`${LEGACY}/`)) return { name: ENVIRONMENT_SERVER_NAME, suffix: pathname.slice(LEGACY.length) };
  if (!pathname.startsWith(PREFIX)) return null;
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  const name = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  return name ? { name, suffix: slash === -1 ? '' : rest.slice(slash) } : null;
}

/** The token's subject: the person for a My Woodshed session, the session for a shared one. */
function subjectOf(session) {
  return session.owner ? `private:${session.owner.toLowerCase()}` : `session:${session.id}`;
}

/**
 * @param {{servers: ReturnType<typeof import('./mcpServers.mjs').createMcpServers>, issuer: {sign: Function},
 *          fleet: {taint: (session: object, opts: object) => Promise<object>, isLocked?: (session: object) => boolean},
 *          repoOf: (session: object) => string|null, now?: () => number}} opts
 *   `repoOf` names the session's project's repo; `fleet.taint` locks the session down and marks it, or throws
 */
export function createMcpRelay({ servers, issuer, fleet, repoOf, now = Date.now }) {
  const tokens = new Map();
  const headers = new Map();
  // The first relayed call of each session to each server, logged once.
  const relayed = new Set();
  // Each session's calls to ordinary servers in flight, cut the moment its lockdown starts (cut).
  const ordinary = new Map();

  /** Cuts a session's calls to ordinary servers, open or opening: called as its lockdown starts. */
  function cut(sessionId) {
    const held = ordinary.get(sessionId);
    if (!held) return 0;
    ordinary.delete(sessionId);
    for (const destroy of held) destroy();
    if (held.size) console.log('mcpRelay: ordinary calls cut at the lockdown', { sessionId, calls: held.size });
    return held.size;
  }

  function hold(session, destroy) {
    if (!ordinary.has(session.id)) ordinary.set(session.id, new Set());
    const held = ordinary.get(session.id);
    held.add(destroy);
    return () => {
      held.delete(destroy);
      if (!held.size && ordinary.get(session.id) === held) ordinary.delete(session.id);
    };
  }

  async function tokenFor(session, server) {
    const key = `${session.id}\n${server.name}\n${server.audience}`;
    const held = tokens.get(key);
    if (held && held.expiresAt - now() > TOKEN_MARGIN_MS) return held.token;
    const repo = repoOf(session);
    const login = session.owner ? session.owner.toLowerCase() : null;
    const made = await issuer.sign({
      audience: server.audience,
      subject: subjectOf(session),
      ttlSeconds: TOKEN_TTL_SECONDS,
      claims: { ...(login && { login }), session_id: session.id, session_kind: session.owner ? 'private' : 'shared', repo },
    });
    if (tokens.size >= 1000) tokens.clear();
    tokens.set(key, made);
    return made.token;
  }

  async function headerFor(server) {
    const key = `${server.name}\n${server.headerSavedAt}`;
    const held = headers.get(key);
    if (held && now() - held.at < HEADER_CACHE_MS) return held.value;
    const value = await servers.headerValue(server);
    if (headers.size >= 200) headers.clear();
    headers.set(key, { value, at: now() });
    return value;
  }

  async function authOf(session, server) {
    if (server.auth === 'oidc') return { authorization: `Bearer ${await tokenFor(session, server)}` };
    if (server.auth === 'header') {
      const value = await headerFor(server);
      if (!value) throw Object.assign(new Error(`${server.name}'s ${server.header} header has no value yet: an admin sets it on Console settings`), { shown: true, status: 503 });
      return { [server.header]: value };
    }
    return {};
  }

  function forward(req, res, session, server, suffix, added) {
    const target = new URL(server.url);
    const transport = target.protocol === 'http:' ? http : https;
    const url = new URL(req.url, 'http://console');
    // The server's own query (a tenant, say) is kept; the client's parameters are added, never over one of its.
    const query = new URLSearchParams(target.search);
    for (const [key, value] of url.searchParams) if (!query.has(key)) query.append(key, value);
    const search = query.size ? `?${query}` : '';
    const out = {};
    for (const name of REQUEST_HEADERS) if (req.headers[name] !== undefined) out[name] = req.headers[name];
    Object.assign(out, added);
    out.host = target.host;
    if (isLinkLocal(target.hostname)) {
      req.resume();
      console.warn('mcpRelay: refused, a link-local address', { sessionId: session.id, server: server.name });
      return reply(res, 502, { error: `${server.name}'s address is link-local, which the console never calls` });
    }
    const call = transport.request({
      lookup: mcpLookup,
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: `${`${target.pathname.replace(/\/+$/, '')}${suffix}` || '/'}${search}`, headers: out,
    }, (answer) => {
      const back = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!RESPONSE_DROPPED.has(name)) back[name] = value;
      if (answer.statusCode === 401 || answer.statusCode === 403) {
        console.warn('mcpRelay: the MCP server refused what the console added', { sessionId: session.id, server: server.name, auth: server.auth, status: answer.statusCode });
      }
      res.writeHead(answer.statusCode, back);
      answer.pipe(res);
    });
    call.on('error', (err) => {
      console.warn('mcpRelay: MCP server not reached', { sessionId: session.id, server: server.name, message: err?.message });
      if (!res.headersSent) return reply(res, 502, { error: `the console could not reach the MCP server ${server.name}` });
      res.destroy();
    });
    // claude closes a stream it no longer wants (a cancelled call, the server's SSE on its way out): the call goes with it.
    const release = server.production ? () => {} : hold(session, () => { call.destroy(); res.destroy(); req.destroy(); });
    res.on('close', () => {
      release();
      if (!res.writableFinished) call.destroy();
    });
    req.pipe(call);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {object|null} session  the active session whose token the call carries
   */
  async function handle(req, res, session) {
    const refuse = (code, error, log = null) => {
      req.resume();
      if (log) console.warn(log.message, log.fields);
      return reply(res, code, { error });
    };
    if (!session) return refuse(401, 'not an active Woodshed session', { message: 'mcpRelay: refused, no active session has that token', fields: { from: req.socket.remoteAddress } });
    const path = serverOfPath(new URL(req.url, 'http://console').pathname);
    const server = path ? servers.get(path.name) : null;
    if (!server) return refuse(404, `this console has no MCP server called ${path?.name ?? ''}`, { message: 'mcpRelay: refused, no such server', fields: { sessionId: session.id, server: path?.name ?? null } });
    const allowed = serverEligibility(server, session, repoOf(session));
    if (!allowed.ok) {
      return refuse(403, allowed.why, { message: 'mcpRelay: refused', fields: { sessionId: session.id, server: server.name, production: server.production, owner: session.owner ?? null, why: allowed.why } });
    }
    // An ordinary server while the session's lockdown is under way: it is as good as tainted.
    if (!server.production && fleet.isLocked?.(session)) {
      return refuse(403, 'this session is being locked down for production data, so only its production servers are open to it',
        { message: 'mcpRelay: refused', fields: { sessionId: session.id, server: server.name, production: false, owner: session.owner ?? null, why: 'locking down' } });
    }
    // A production server's taint comes first, whatever the call: the body is not read until the session is locked down.
    if (server.production && !session.taintedAt) {
      try {
        await fleet.taint(session, { why: `production MCP call (${server.name})` });
      } catch (err) {
        const why = err?.shown ? err.message : 'the session could not be locked down';
        if (!err?.shown) console.error('mcpRelay: taint failed', { sessionId: session.id, message: err?.message });
        return refuse(503, `${why}. Production access needs the session locked down first, so this call was not sent.`,
          { message: 'mcpRelay: refused, the session was not locked down', fields: { sessionId: session.id, server: server.name, owner: session.owner, why } });
      }
    }
    let added;
    try {
      added = await authOf(session, server);
    } catch (err) {
      return refuse(err?.status ?? 503, err?.shown ? err.message : `the console could not make what ${server.name} takes`,
        { message: 'mcpRelay: auth not added', fields: { sessionId: session.id, server: server.name, auth: server.auth, message: err?.message } });
    }
    const key = `${session.id}\n${server.name}`;
    if (!relayed.has(key)) {
      if (relayed.size >= 5000) relayed.clear();
      relayed.add(key);
      console.log('mcpRelay: first call relayed', { sessionId: session.id, server: server.name, production: server.production, owner: session.owner ?? null, repo: repoOf(session), taintedAt: session.taintedAt ?? null });
    }
    // A lockdown that started while the auth was made: the call does not go.
    if (!server.production && (session.taintedAt || fleet.isLocked?.(session))) {
      return refuse(403, 'this session is being locked down for production data, so only its production servers are open to it');
    }
    return forward(req, res, session, server, path.suffix, added);
  }

  return { isProxyPath: isMcpPath, handle, cut };
}
