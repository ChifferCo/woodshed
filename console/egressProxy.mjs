// The way out for a session whose network was locked down (fleet.taint): an HTTP proxy on the console, on its own port
// beside the session API's, that only the session's locked network reaches. A tainted session's network leads nowhere
// else, so nothing it does inside its container can go round this: the lockdown is the network's (the docker
// launcher's isolated network, or AWS's guarded security group), and this proxy is what that network allows.
//
//   CONNECT <host>:<port>   Proxy-Authorization: Basic woodshed:<SESSION_TOKEN>
//
// A tainted session reaches GitHub's hosts alone (githubEgress.mjs): the proxy opens the TLS itself with a certificate
// of its own authority (egressCerts.mjs), reads each request, checks its repo, and sends it on to GitHub. Every other
// host is refused. A session not tainted yet, which on AWS reaches the internet only through here (a guarded session,
// providers/aws/README.md), goes wherever on the public internet it asks, untouched: no certificate, nothing read. Never
// to an address of the console's own network (loopback, link-local and so the instance's metadata, private ranges),
// checked on the address the name resolves to, which is the one connected to. Only a launcher that guards its
// sessions' egress (`passThrough`) has its sessions use it so; another's are refused. Every tunnel an untainted session
// has open is cut the moment its lockdown starts (`cut`), before anything of production reaches it.
//
// The proxy says why it refused, in a 403's body and in the console's log (`egress: refused`, once per session, host
// and reason), never with the request's path or body, which may carry what the session saw.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { GITHUB_HOSTS, MAX_GRAPHQL_BYTES, NODES_QUERY, githubRequestRule, graphqlRule, nodesRefusal, repoRefusal } from './githubEgress.mjs';
import { sessionForToken } from './sessionApi.mjs';

const VISIBILITY_TTL_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
// Hop-by-hop and the proxy's own: never sent on to GitHub.
const DROPPED = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/** @returns {string|null}  the session token a request's Proxy-Authorization carries, as `woodshed:<token>` */
export function proxyTokenOf(headers) {
  const basic = /^Basic\s+(\S+)$/i.exec(String(headers['proxy-authorization'] ?? ''))?.[1];
  if (!basic) return null;
  const decoded = Buffer.from(basic, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 ? decoded.slice(colon + 1) || null : null;
}

function splitTarget(authority) {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(authority ?? ''));
  return m ? { host: m[1].toLowerCase(), port: Number(m[2]) } : null;
}

/**
 * Whether a repo is public, from GitHub's API with no credential: 200 is public, 404 a private repo or none at all,
 * which look the same to anyone outside. Anything else (a rate limit, GitHub away) is no answer, and refuses.
 * @param {{request?: typeof https.request}} [opts]
 * @returns {(owner: string, name: string) => Promise<'public'|'unknown'>}
 */
export function anonymousVisibility({ request = https.request } = {}) {
  return (owner, name) => new Promise((resolve, reject) => {
    const req = request({ hostname: 'api.github.com', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, method: 'GET',
      headers: { 'user-agent': 'woodshed-egress', accept: 'application/vnd.github+json' }, timeout: UPSTREAM_TIMEOUT_MS }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve('public');
      else if (res.statusCode === 404) resolve('unknown');
      else reject(new Error(`GitHub answered ${res.statusCode} when asked whether ${owner}/${name} is public`));
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer whether the repo is public')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {{sessions: () => object[], isLocked: (session: object) => boolean, orgOf: (session: object) => string|null,
 *          certs: {leaf: (host: string) => Promise<{key: string, cert: string}>},
 *          visibility?: (owner: string, name: string, session: object) => Promise<string>,
 *          upstream?: {request?: typeof https.request, connect?: (port: number, host: string) => net.Socket, ca?: string|Buffer,
 *                      port?: number, lookup?: Function},
 *          now?: () => number}} opts
 *   `isLocked` is the fleet's: true from the moment a lockdown starts. `orgOf` names the owner whose private repos a
 *   session may reach: its project's. `upstream` is where calls go, the real GitHub and internet but in tests
 * @returns {http.Server}  not yet listening
 */
export function createEgressProxy({ sessions, isLocked, orgOf, certs, visibility = anonymousVisibility(), upstream = {}, now = Date.now, passThrough = () => true, lookup = dns.lookup }) {
  const request = upstream.request ?? https.request;
  const connect = upstream.connect ?? ((port, host) => net.connect(port, host));
  const plainRequest = upstream.plainRequest ?? http.request;
  // Each untainted session's open pass-through sockets, both ends, cut at its lockdown.
  const passing = new Map();

  function track(sessionId, ...sockets) {
    if (!passing.has(sessionId)) passing.set(sessionId, new Set());
    const held = passing.get(sessionId);
    for (const socket of sockets) {
      held.add(socket);
      socket.once('close', () => {
        held.delete(socket);
        if (!held.size && passing.get(sessionId) === held) passing.delete(sessionId);
      });
    }
  }

  /** Cuts every pass-through connection a session has open or opening. */
  function cut(sessionId) {
    const held = passing.get(sessionId);
    if (!held) return 0;
    passing.delete(sessionId);
    for (const socket of held) socket.destroy();
    if (held.size) console.log('egress: open connections cut at the lockdown', { sessionId, sockets: held.size });
    return held.size;
  }

  /** @returns {Promise<string>}  the public address a host resolves to, which is the one connected to; throws otherwise */
  function publicAddress(host) {
    if (net.isIP(host)) {
      if (!isPublicAddress(host)) return Promise.reject(Object.assign(new Error(`${host} is not a public address`), { shown: true }));
      return Promise.resolve(host);
    }
    return new Promise((resolve, reject) => {
      lookup(host, { all: true }, (err, addresses) => {
        if (err || !addresses?.length) return reject(new Error(`${host} not found`));
        const inside = addresses.find((a) => !isPublicAddress(a.address));
        if (inside) return reject(Object.assign(new Error(`${host} resolves to ${inside.address}, which is not a public address`), { shown: true }));
        resolve(addresses[0].address);
      });
    });
  }
  const visibilities = new Map();
  const refusals = new Set();
  const contexts = new Map();

  function noteRefusal(session, host, why) {
    const key = `${session?.id}\n${host}\n${why}`;
    if (refusals.has(key)) return;
    if (refusals.size >= 5000) refusals.clear();
    refusals.add(key);
    console.warn('egress: refused', { sessionId: session?.id ?? null, host, why });
  }

  function sessionOf(req) {
    return sessionForToken(proxyTokenOf(req.headers), sessions());
  }

  async function visibilityOf(owner, name, session) {
    const key = `${owner}/${name}`.toLowerCase();
    const held = visibilities.get(key);
    if (held && now() - held.at < VISIBILITY_TTL_MS) return held.value;
    const value = await visibility(owner, name, session);
    if (visibilities.size >= 1000) visibilities.clear();
    visibilities.set(key, { value, at: now() });
    return value;
  }

  function contextFor(host) {
    if (!contexts.has(host)) {
      contexts.set(host, certs.leaf(host).then(({ key, cert }) => tls.createSecureContext({ key, cert })).catch((err) => {
        contexts.delete(host);
        throw err;
      }));
    }
    return contexts.get(host);
  }

  // The requests inside each GitHub connection a tainted session opened.
  const inner = http.createServer((req, res) => {
    inspect(req, res).catch((err) => {
      console.error('egress: request failed', { host: req.socket.egressHost, message: err?.message });
      if (!res.headersSent) refuseHttp(res, 502, 'the console could not reach GitHub');
      else res.destroy();
    });
  });

  function refuseHttp(res, code, message) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-woodshed-egress': 'refused', connection: 'close' });
    res.end(`Woodshed: ${message}\n`);
  }

  async function inspect(req, res) {
    const { egressHost: host, egressSession: session } = req.socket;
    const path = new URL(req.url, 'https://github.invalid').pathname;
    const rule = githubRequestRule({ host, method: req.method, path });
    const refuse = (why) => {
      req.resume();
      noteRefusal(session, host, why);
      refuseHttp(res, 403, `refused by this session's lockdown: ${why}. This session has seen production data, so it reaches only its organization's private repos on GitHub.`);
    };
    if (rule.kind === 'deny') return refuse(rule.why);
    const org = orgOf(session);
    if (rule.kind === 'repo') {
      let seen;
      try {
        seen = await visibilityOf(rule.owner, rule.name, session);
      } catch (err) {
        return refuse(`could not tell whether ${rule.owner}/${rule.name} is private (${String(err?.message ?? err).split('\n')[0]})`);
      }
      const refusal = repoRefusal({ owner: rule.owner, name: rule.name, org, visibility: seen });
      if (refusal) return refuse(refusal);
      return send(req, res, host);
    }
    if (rule.kind === 'open') return send(req, res, host);
    // GraphQL: the body is read whole (it is small), checked, and sent on as it was.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_GRAPHQL_BYTES) return refuse('a GraphQL request larger than the proxy reads');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return refuse('not a GraphQL request');
    }
    const graphql = graphqlRule(parsed);
    if (graphql.kind === 'deny') return refuse(graphql.why);
    if (graphql.kind === 'mutation') {
      let answer;
      try {
        answer = await askGitHub(host, req.headers, { query: NODES_QUERY, variables: { ids: graphql.ids } });
      } catch (err) {
        return refuse(`could not check what the mutation acts on (${String(err?.message ?? err).split('\n')[0]})`);
      }
      const refusal = nodesRefusal(answer, graphql.ids.length, org);
      if (refusal) return refuse(refusal);
    }
    return send(req, res, host, body);
  }

  function upstreamHeaders(headers, host, length = null) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) if (!DROPPED.has(name)) out[name] = value;
    out.host = host;
    if (length !== null) out['content-length'] = String(length);
    return out;
  }

  // The same request, to GitHub, its answer streamed back.
  function send(req, res, host, body = null) {
    const out = request({
      hostname: host, port: upstream.port ?? 443, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, host, body ? body.length : null),
      servername: host, ...(upstream.ca ? { ca: upstream.ca } : {}), ...(upstream.lookup ? { lookup: upstream.lookup } : {}),
    }, (answer) => {
      const back = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!DROPPED.has(name)) back[name] = value;
      res.writeHead(answer.statusCode, back);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('egress: GitHub not reached', { host, message: err?.message });
      if (!res.headersSent) refuseHttp(res, 502, 'the console could not reach GitHub');
      else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    if (body) out.end(body);
    else req.pipe(out);
  }

  // One GraphQL call with the request's own credential, for what it is about to change.
  function askGitHub(host, headers, payload) {
    const text = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const out = request({
        hostname: host, port: upstream.port ?? 443, method: 'POST', path: '/graphql', servername: host, timeout: UPSTREAM_TIMEOUT_MS,
        headers: { ...upstreamHeaders(headers, host, Buffer.byteLength(text)), 'content-type': 'application/json', 'accept-encoding': 'identity' },
        ...(upstream.ca ? { ca: upstream.ca } : {}), ...(upstream.lookup ? { lookup: upstream.lookup } : {}),
      }, (answer) => {
        let data = '';
        answer.setEncoding('utf8');
        answer.on('data', (c) => { data += c; });
        answer.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`GitHub answered ${answer.statusCode}, not JSON`));
          }
        });
      });
      out.on('timeout', () => out.destroy(new Error('GitHub did not answer')));
      out.on('error', reject);
      out.end(text);
    });
  }

  const server = http.createServer((req, res) => {
    // A plain http:// request through the proxy: only an untainted session's.
    const session = sessionOf(req);
    if (!session) {
      req.resume();
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="woodshed"', 'content-type': 'text/plain' });
      return res.end('Woodshed: the egress proxy takes a session\'s own token\n');
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      req.resume();
      return refuseHttp(res, 400, 'not a proxy request');
    }
    if (isLocked(session)) {
      req.resume();
      noteRefusal(session, target.hostname, 'plain HTTP');
      return refuseHttp(res, 403, `refused by this session's lockdown: ${target.hostname} is not reachable from a session that has seen production data`);
    }
    if (target.protocol !== 'http:') {
      req.resume();
      return refuseHttp(res, 400, 'not an http:// request: use CONNECT');
    }
    if (!passThrough(session)) {
      req.resume();
      return refuseHttp(res, 403, 'this session reaches the internet itself, not through the console');
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    publicAddress(hostname).then((address) => {
      if (isLocked(session) || req.socket.destroyed) return req.socket.destroy();
      track(session.id, req.socket);
      const out = plainRequest({ hostname: address, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: upstreamHeaders(req.headers, target.host) }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      out.on('socket', (socket) => track(session.id, socket));
      out.on('error', () => { if (!res.headersSent) refuseHttp(res, 502, `${target.hostname} not reached`); else res.destroy(); });
      req.pipe(out);
    }, (err) => {
      req.resume();
      if (err.shown) noteRefusal(session, hostname, 'not a public address');
      refuseHttp(res, err.shown ? 403 : 502, err.shown ? `refused: ${err.message}` : `${target.hostname} not reached`);
    });
  });

  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const session = sessionOf(req);
    const target = splitTarget(req.url);
    const fail = (code, text, extra = '', body = `Woodshed: ${text}\n`) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\nx-woodshed-egress: refused\r\n${extra}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    if (!session) return fail(407, 'Proxy Authentication Required', 'proxy-authenticate: Basic realm="woodshed"\r\n');
    if (!target) return fail(400, 'Bad Request');
    if (!isLocked(session)) {
      // Untainted: wherever on the public internet it asks, for a session whose launcher guards its egress.
      if (!passThrough(session)) return fail(403, 'Forbidden', '', 'Woodshed: this session reaches the internet itself, not through the console\n');
      publicAddress(target.host).then((address) => {
        // Its lockdown may have started while the name resolved.
        if (isLocked(session) || socket.destroyed) return socket.destroy();
        track(session.id, socket);
        const out = connect(target.port, address);
        track(session.id, out);
        out.on('connect', () => {
          if (isLocked(session)) return socket.destroy();
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) out.write(head);
          out.pipe(socket);
          socket.pipe(out);
        });
        out.on('error', () => fail(502, 'Bad Gateway'));
        socket.on('close', () => out.destroy());
      }, (err) => {
        if (err.shown) noteRefusal(session, target.host, 'not a public address');
        fail(err.shown ? 403 : 502, err.shown ? 'Forbidden' : 'Bad Gateway', '', `Woodshed: ${err.shown ? `refused: ${err.message}` : `${target.host} not reached`}\n`);
      });
      return;
    }
    if (!GITHUB_HOSTS.has(target.host) || target.port !== 443) {
      noteRefusal(session, target.host, 'not GitHub');
      return fail(403, 'Forbidden', '', `Woodshed: refused by this session's lockdown: ${target.host} is not reachable from a session that has seen production data (only the console, its own databases and its organization's private GitHub repos are).\n`);
    }
    contextFor(target.host).then((secureContext) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.unshift(head);
      const tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      tlsSocket.egressHost = target.host;
      tlsSocket.egressSession = session;
      tlsSocket.on('error', () => socket.destroy());
      inner.emit('connection', tlsSocket);
    }, (err) => {
      console.error('egress: no certificate for GitHub', { host: target.host, message: err?.message });
      fail(502, 'Bad Gateway');
    });
  });

  server.cut = cut;
  return server;
}

// Addresses that are not the public internet's: the console's own network, its loopback, link-local (the instance's
// metadata among them), private and shared ranges, and those that are no host at all.
const INSIDE = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  INSIDE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['fec0::', 10]]) {
  INSIDE.addSubnet(address, prefix, 'ipv6');
}

/** @returns {boolean}  whether an IP address is on the public internet */
export function isPublicAddress(address) {
  const text = String(address).replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(text);
  if (!family) return false;
  if (family === 6) {
    // An IPv4 address written as IPv6 (mapped, or NAT64's) is that address.
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(text) || /^64:ff9b::/i.test(text)) return false;
    return !INSIDE.check(text, 'ipv6');
  }
  return !INSIDE.check(text, 'ipv4');
}
