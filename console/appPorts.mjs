// Session apps on ports of the console's own name, for a console that has one name and no wildcard: one person's
// console reached from their other devices through Tailscale's `serve`, which gives the machine a single HTTPS name.
//
//   https://<console's name>:<port>/*  ->  the app of the session that port is lent to (appProxy.mjs, as by name)
//
// WOODSHED_APP_PORTS names the ports, such as `7701-7710`. The console listens on each, on its own host (loopback),
// and the proxy in front maps the same port on the machine's name to it. A port is lent to a session when its app is
// first shown, and kept for it while the session is active, so an open tab keeps working; a stopped session's port goes
// to the next one.
//
// Only on a console nobody signs in to (isOnePersonConsole): a cookie is the name's, whatever the port, so the app
// sign-in cookie that keeps one app's viewers from another's cannot be kept apart here. The console itself stays apart:
// its writes and websockets need its own origin, and a port is part of that (shared/sameOrigin.mjs).

import { isOnePersonConsole } from './githubAppSetup.mjs';

const MAX_PORTS = 100;

/**
 * @param {string|undefined} value  `7701-7710`, `7701,7703`, or both joined by commas; empty for none
 * @returns {number[]}  the ports, in order, each once
 * @throws {Error}  for a value that is not ports
 */
export function parseAppPorts(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const ports = new Set();
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`WOODSHED_APP_PORTS must be ports such as 7701-7710, and ${part} is not`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1024 || to > 65535 || to < from) throw new Error(`WOODSHED_APP_PORTS: ${part} is not a range of ports from 1024 to 65535`);
    for (let p = from; p <= to; p += 1) ports.add(p);
    if (ports.size > MAX_PORTS) throw new Error(`WOODSHED_APP_PORTS names more than ${MAX_PORTS} ports`);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Stops a console whose app ports could not work, or could hand one app's viewers another's.
 * @param {{appPorts: number[], appDomain: string, port: number, host?: string, requireSignIn?: boolean,
 *          trustedIdentitySecret?: string|null, tlsAskPort?: number|null, sessionApi?: {port?: number}}} config
 */
export function requireAppPortsSafe(config) {
  if (!config.appPorts?.length) return;
  if (config.appDomain) throw new Error('WOODSHED_APP_PORTS and WOODSHED_APP_DOMAIN are two ways to name session apps: set one');
  if (!isOnePersonConsole(config)) {
    throw new Error('WOODSHED_APP_PORTS is for one person\'s console, on loopback with no sign-in: apps that share a name cannot keep their sign-in apart. Use WOODSHED_APP_DOMAIN');
  }
  const taken = [config.port, config.tlsAskPort, config.sessionApi?.port].filter(Boolean).map(Number);
  const clash = config.appPorts.find((p) => taken.includes(p));
  if (clash) throw new Error(`WOODSHED_APP_PORTS has ${clash}, which the console already listens on for something else`);
}

/**
 * @param {{store: {state: object, save: () => void}, config: {appPorts: number[], publicUrl: string},
 *          isActive: (id: string) => boolean}} deps  `isActive` is whether the session still holds its port
 */
export function createAppPorts({ store, config, isActive }) {
  const ports = config.appPorts;

  function lent() {
    store.state.appPorts ??= {};
    return store.state.appPorts;
  }

  /** @returns {number|null}  the port the session's app is on, lent now when it has none; null when all are taken */
  function portFor(id) {
    const map = lent();
    const held = ports.find((p) => map[p] === id);
    if (held) return held;
    const free = ports.find((p) => !map[p] || !isActive(map[p]));
    if (!free) {
      console.warn('appPorts: no port free for the session\'s app', { id, ports: ports.length });
      return null;
    }
    const before = map[free] ?? null;
    map[free] = id;
    store.save();
    console.log('appPorts: port lent', { id, port: free, from: before });
    return free;
  }

  /** @returns {string|null}  the session the port is lent to, while it is active */
  function idFor(port) {
    const id = lent()[Number(port)];
    return id && isActive(id) ? id : null;
  }

  /** @returns {boolean}  whether the console answers apps on this port */
  function owns(port) {
    return ports.includes(Number(port));
  }

  /** @returns {string|null}  the app's address on the console's own name, with `path` */
  function urlFor(id, path = '/') {
    const port = portFor(id);
    if (!port) return null;
    const url = new URL(config.publicUrl);
    url.port = String(port);
    return `${url.origin}${path}`;
  }

  return { ports, portFor, idFor, owns, urlFor };
}
