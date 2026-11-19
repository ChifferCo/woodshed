// The one thing a locked-down local session can reach (providers/local/dockerLauncher.mjs, lockDown): a container of
// its own beside it, on the session's isolated network and on the network the session left, that carries plain TCP
// for a fixed list of ports and nothing else. It is not a proxy: it never reads what it carries, and it cannot be told
// where to go. Run from the session image, as node, with no credentials.
//
//   WOODSHED_GATEWAY_SESSION    the session's container name, which the isolated network's DNS resolves
//   WOODSHED_GATEWAY_INBOUND    ports carried in to the session: ttyd, statusd and the shell's, which the gateway
//                               publishes for the console in place of the session's own
//   WOODSHED_GATEWAY_OUTBOUND   `<port>=<host>:<port>,...`: what the session may reach, each on the gateway's own port
//                               (the console's session API and egress proxy, its databases, the shared services)
//
//   node sessionGateway.mjs

import net from 'node:net';

import { isMain } from './isMain.mjs';

/**
 * @param {string} text  WOODSHED_GATEWAY_OUTBOUND
 * @returns {{listen: number, host: string, port: number}[]}
 */
export function parseOutbound(text) {
  return String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^(\d{1,5})=([A-Za-z0-9_.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(entry);
    if (!m) throw new Error(`WOODSHED_GATEWAY_OUTBOUND: ${entry} is not <port>=<host>:<port>`);
    return { listen: Number(m[1]), host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) };
  });
}

/** @returns {number[]} */
export function parsePorts(text) {
  return String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    if (!/^\d{1,5}$/.test(p)) throw new Error(`not a port: ${p}`);
    return Number(p);
  });
}

/**
 * @param {{routes: {listen: number, host: string, port: number}[], connect?: typeof net.connect}} opts
 * @returns {Promise<net.Server[]>}  listening, one per route
 */
export async function startGateway({ routes, connect = net.connect }) {
  const ports = routes.map((r) => r.listen);
  const twice = ports.find((p, i) => ports.indexOf(p) !== i);
  if (twice) throw new Error(`port ${twice} is carried twice`);
  return Promise.all(routes.map((route) => new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const out = connect(route.port, route.host);
      client.on('error', () => out.destroy());
      out.on('error', () => client.destroy());
      client.pipe(out);
      out.pipe(client);
    });
    server.on('error', reject);
    server.listen(route.listen, '0.0.0.0', () => resolve(server));
  })));
}

if (isMain(import.meta.url)) {
  const session = process.env.WOODSHED_GATEWAY_SESSION;
  if (!session) {
    console.error('sessionGateway: WOODSHED_GATEWAY_SESSION is not set');
    process.exit(2);
  }
  const routes = [
    ...parsePorts(process.env.WOODSHED_GATEWAY_INBOUND).map((port) => ({ listen: port, host: session, port })),
    ...parseOutbound(process.env.WOODSHED_GATEWAY_OUTBOUND),
  ];
  startGateway({ routes }).then(() => {
    console.log('sessionGateway: carrying', { session, routes: routes.map((r) => `${r.listen}->${r.host}:${r.port}`) });
  }, (err) => {
    console.error('sessionGateway: could not start', { message: err.message });
    process.exit(1);
  });
}
