// The question a reverse proxy asks before it gets a certificate for a name on demand (Caddy's `on_demand_tls { ask }`):
//
//   GET http://127.0.0.1:<WOODSHED_TLS_ASK_PORT>/tls-ask?domain=<name>   ->  200 yes, 403 no
//
// It is for a console with no wildcard certificate, such as one on a plain VM named through sslip.io, where each
// session app's name needs a certificate of its own. Without the question anyone could have the proxy ask Let's
// Encrypt for any number of made-up names and use up its rate limit.
//
// It has a listener of its own, on loopback only, never the console's port. Caddy reaches the console's port from
// loopback too, so a check of the caller's address there would let every public request through; on a port Caddy
// does not proxy to, the address is the machine's own caller. A request with a forwarding header is refused as well,
// since that is a proxy in front of this port by mistake.

import http from 'node:http';

import { appIdFor } from './appProxy.mjs';

export const TLS_ASK_PATH = '/tls-ask';
const NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'];
const REFUSAL_LOG_MS = 60_000;

/** @param {string|undefined} address  a socket's remoteAddress */
export function isLoopback(address) {
  if (typeof address !== 'string') return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Sessions that exist and are not deleted count, stopped ones too: an app runs only while its session is active, but
 * a kept session resumes at the same name, and a certificate got early costs nothing. The names are bounded by the
 * session list, which only people who can start sessions grow.
 * @param {{domain: unknown, publicUrl: string, extraHosts: string[], appDomain: string, sessionIds: Set<string>}} args
 * @returns {{allowed: boolean, why: 'console host'|'extra host'|'session'|'unknown'}}
 */
export function tlsAskVerdict({ domain, publicUrl, extraHosts, appDomain, sessionIds }) {
  const name = typeof domain === 'string' ? domain.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!NAME_RE.test(name)) return { allowed: false, why: 'unknown' };
  if (name === hostnameOf(publicUrl)) return { allowed: true, why: 'console host' };
  if (extraHosts.some((h) => h.toLowerCase() === name)) return { allowed: true, why: 'extra host' };
  const id = appIdFor(name, appDomain);
  if (id && sessionIds.has(id)) return { allowed: true, why: 'session' };
  return { allowed: false, why: 'unknown' };
}

/**
 * @param {{config: {publicUrl: string, extraHosts: string[], appDomain: string}, sessions: () => {id: string, cleanedAt?: string|null}[], now?: () => number}} args
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function createTlsAskHandler({ config, sessions, now = Date.now }) {
  let refused = 0;
  let lastRefusalLog = -Infinity;

  // Anyone can make the proxy ask about any name, so refusals are counted and logged at most once a minute.
  function logRefusal(why, domain) {
    refused += 1;
    if (now() - lastRefusalLog < REFUSAL_LOG_MS) return;
    console.log('tls: certificate asked', { allowed: false, why, refused, domain: String(domain ?? '').slice(0, 100) });
    lastRefusalLog = now();
    refused = 0;
  }

  function answer(res, status) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(status === 200 ? 'yes\n' : 'no\n');
  }

  return function handleTlsAsk(req, res) {
    if (!isLoopback(req.socket?.remoteAddress) || FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) {
      logRefusal('not loopback', null);
      return answer(res, 403);
    }
    const url = new URL(req.url || '/', 'http://tls-ask.invalid');
    if (url.pathname !== TLS_ASK_PATH) return answer(res, 404);
    if (req.method !== 'GET') return answer(res, 405);
    const domain = url.searchParams.get('domain');
    const sessionIds = new Set(sessions().filter((s) => !s.cleanedAt).map((s) => s.id));
    const { allowed, why } = tlsAskVerdict({ domain, ...config, sessionIds });
    if (!allowed) {
      logRefusal(why, domain);
      return answer(res, 403);
    }
    console.log('tls: certificate asked', { allowed, why, domain });
    return answer(res, 200);
  };
}

/**
 * Listens on 127.0.0.1 alone: the setting names a port, never an address.
 * @param {{config: {tlsAskPort: number|null, publicUrl: string, extraHosts: string[], appDomain: string}, sessions: () => object[]}} args
 * @returns {Promise<http.Server|null>}
 */
export function startTlsAsk({ config, sessions }) {
  if (!config.tlsAskPort) return Promise.resolve(null);
  const server = http.createServer(createTlsAskHandler({ config, sessions }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.tlsAskPort, '127.0.0.1', () => {
      console.log('tls: ask listening', { host: '127.0.0.1', port: server.address().port, appDomain: config.appDomain || null });
      resolve(server);
    });
  });
}
