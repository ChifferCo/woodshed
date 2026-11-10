// Who is allowed to change something.
//
// The shed has no authentication and is not getting any: it listens on a
// tailnet, and the tailnet is the gate. But "no auth" and "any page on the
// internet can drive it" are different claims, and only the first one is
// intended. A browser attaches an Origin header to every state-changing
// request and every websocket handshake, so requiring that Origin to name the
// same host the request arrived on closes the gap: a page you happen to visit
// can still guess this box's name, but its POST is refused before it reaches
// anything that deletes files or kills a session.
//
// Requests with no Origin at all — curl, a script, anything not a browser —
// are unaffected. They were never the case this is about.

/**
 * @param {{origin?: string, host?: string}} headers  as sent
 * @returns {boolean} whether a state-changing request may proceed
 */
export function isSameOrigin({ origin, host }) {
  if (!origin) return true;  // not a browser; not what this guards against
  // "null" is what a sandboxed iframe or a file:// page sends. It names no
  // host, so it can never match one.
  if (origin === 'null') return false;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;  // unparseable: not something to give the benefit of
  }
}

/**
 * Whether the name this request was reached by is one of ours.
 *
 * Comparing Origin to Host is not enough on its own, because both come from
 * the same browser and an attacker who owns a domain controls both. Point
 * evil.example at this box with a one-second TTL, wait for the record to flip
 * after the page loads, and every request it makes carries Origin and Host
 * that agree — on a name that is not this machine. That is DNS rebinding, and
 * it turns "no auth because the tailnet is the gate" into "no auth" for
 * anyone who can get the user to open a tab.
 *
 * So the host has to name this box: its hostname, any address one of its
 * interfaces holds, or loopback. The port is not part of it — the same server
 * answers on whichever port it was started with.
 *
 * The one inexact case is MagicDNS, which addresses this machine as
 * <hostname>.<tailnet>.ts.net. That is accepted on the first label, but only
 * under .ts.net: matching any name whose first label happens to be the
 * hostname would hand the whole check to anyone who can register
 * <hostname>.evil.example, which is the attack this function exists to stop.
 * Anything else — a reverse proxy under its own name — goes in
 * WOODSHED_HOSTS, where it is a decision someone made rather than a
 * pattern that matched.
 *
 * @param {string|undefined} host  the Host header, with or without a port
 * @param {string[]} allowed       names and addresses this box answers to
 */
const MAGIC_DNS_SUFFIX = '.ts.net';

export function isKnownHost(host, allowed) {
  if (!host) return false;
  // An IPv6 literal is bracketed, and its colons are not a port separator.
  const name = (host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0])
    .toLowerCase();
  if (!name) return false;
  const magic = name.endsWith(MAGIC_DNS_SUFFIX) ? name.split('.')[0] : null;
  return allowed.some((entry) => {
    const known = String(entry).toLowerCase();
    return name === known || (magic !== null && magic === known);
  });
}
