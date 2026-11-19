// What a locked-down local session may still reach, from the environment it was started with: the console's session
// API and egress proxy, its databases and the shared services. Each becomes a port the session's gateway carries
// (shared/sessionGateway.mjs), and its host name is pointed at the gateway inside the session.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|:/;
// The session's own ports, which the gateway carries the other way.
export const INBOUND_PORTS = [7681, 7682, 7684];

function hostPort(value, fallbackPort) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const url = new URL(text);
    const port = Number(url.port) || ({ 'http:': 80, 'https:': 443, 'redis:': 6379, 'postgres:': 5432, 'postgresql:': 5432, 'mongodb:': 27017 }[url.protocol] ?? fallbackPort);
    return port ? { host: url.hostname.replace(/^\[|\]$/g, ''), port } : null;
  }
  const m = /^([^:/]+)(?::(\d{1,5}))?$/.exec(text);
  return m ? { host: m[1], port: Number(m[2] ?? fallbackPort) } : null;
}

/**
 * @param {Record<string, string>} env  the session's
 * @param {{egressUrl?: string|null}} [opts]  the console's egress proxy, as the session reaches it
 * @returns {{routes: {listen: number, host: string, port: number}[], names: string[]}}  `names` are the host names to
 *   point at the gateway inside the session
 * @throws {Error}  for a destination the gateway cannot carry: one given by address, or two hosts on one port
 */
export function lockedTargets(env, { egressUrl = null } = {}) {
  const wanted = [];
  const add = (what, value, fallbackPort) => {
    const target = hostPort(value, fallbackPort);
    if (target) wanted.push({ what, ...target });
  };
  add('the console', env.WOODSHED_CONSOLE_URL, 80);
  add('the egress proxy', egressUrl ?? env.WOODSHED_EGRESS_PROXY, 80);
  if (env.PGHOST) add('Postgres', `${env.PGHOST}:${env.PGPORT || 5432}`, 5432);
  add('Mongo', env.WOODSHED_MONGO_HOST, 27017);
  for (const name of String(env.WOODSHED_SERVICES ?? '').split(/\s+/).filter(Boolean)) add(name, env[name], 80);
  const routes = new Map();
  const names = new Set();
  for (const target of wanted) {
    // The session's own: a database it runs itself, say. Nothing to carry.
    if (LOOPBACK.has(target.host)) continue;
    if (IP_RE.test(target.host)) throw new Error(`${target.what} is given by its address (${target.host}), which a locked-down session cannot reach: give it by a host name`);
    if (INBOUND_PORTS.includes(target.port)) throw new Error(`${target.what} is on port ${target.port}, which the session's gateway carries in to the session`);
    const held = routes.get(target.port);
    if (held && held.host !== target.host) throw new Error(`${target.what} and ${held.what} are both on port ${target.port}, which a locked-down session's gateway cannot tell apart`);
    routes.set(target.port, target);
    names.add(target.host);
  }
  return { routes: [...routes.values()].map(({ host, port }) => ({ listen: port, host, port })), names: [...names] };
}

/**
 * /etc/hosts with each of `names` pointed at `ip`, and every other line as it was.
 * @param {string} text
 * @param {string[]} names
 * @param {string} ip
 * @returns {string}
 */
export function hostsPointedAt(text, names, ip) {
  const set = new Set(names);
  const kept = String(text).split('\n').filter((line) => {
    const fields = line.replace(/#.*/, '').trim().split(/\s+/);
    return !(fields.length > 1 && fields.slice(1).some((n) => set.has(n)));
  });
  while (kept.length && kept.at(-1) === '') kept.pop();
  return `${[...kept, ...(names.length ? [`${ip}\t${names.join(' ')}\t# the session's gateway (Woodshed lockdown)`] : [])].join('\n')}\n`;
}
