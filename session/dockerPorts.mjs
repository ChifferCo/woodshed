// In a session given this machine's Docker (WOODSHED_SESSION_DOCKER=1, providers/local/dockerLauncher.mjs): the ports
// the machine's containers publish, forwarded to the same port on this session's 127.0.0.1.
//
// A container claude starts runs beside this one, on the machine, so the ports it publishes are the machine's, reached
// from here at host.docker.internal:<port>. Tools that start a stack and then talk to it, such as Supabase's CLI, dial
// 127.0.0.1:<port> instead, and find nothing. So each published TCP port is listened on here and piped there. A port
// something in the session already listens on is left to it, and a forward ends when its container's port goes.
// Sessions' own containers are left out: their ports are the console's to reach.
//
// The entrypoint starts it (startDockerPorts), logging to /tmp/woodshed-docker-ports.log. It reads `docker ps` when
// `docker events` says a container started or stopped, and every few seconds besides.

import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

import { isMain } from '../shared/isMain.mjs';

const execFileAsync = promisify(execFile);

export const POLL_MS = 5_000;
// The session's own: its Redis, then its terminals, status, viewers and editor (entrypoint.sh's header). A container
// publishing one of these is not forwarded, even before the session listens on it.
export const SESSION_PORTS = Object.freeze([6379, 7681, 7682, 7683, 7684, 7685, 7686, 7687, 7688]);
const SESSION_LABEL = 'woodshed.session';
const OLD_SESSION_LABEL = 'woodshed-cloud.session';
// One line a container: its id, either session label, then its ports as `docker ps` writes them.
export const PS_FORMAT = `{{.ID}}\t{{.Label "${SESSION_LABEL}"}}{{.Label "${OLD_SESSION_LABEL}"}}\t{{.Ports}}`;

/**
 * @param {string} ports  `docker ps`'s Ports column, as `0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp, 9000/tcp`
 * @returns {number[]}  the machine's TCP ports it publishes, each once
 */
export function publishedPorts(ports) {
  const found = new Set();
  for (const match of String(ports ?? '').matchAll(/:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp/g)) {
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    for (let p = from; p <= to && p - from < 1000; p += 1) if (p > 0 && p < 65_536) found.add(p);
  }
  return [...found];
}

/**
 * @param {string} output  `docker ps --format PS_FORMAT`
 * @returns {Map<number, string>}  each published port, by the container (short id) publishing it; sessions' left out
 */
export function portsFrom(output) {
  const ports = new Map();
  for (const line of String(output ?? '').split('\n')) {
    const [id, session, column] = line.split('\t');
    if (!id || session) continue;
    for (const port of publishedPorts(column)) if (!ports.has(port)) ports.set(port, id.slice(0, 12));
  }
  return ports;
}

/**
 * @param {{listContainers: () => Promise<string>, target?: (port: number) => {host: string, port: number},
 *          bindHost?: string, skip?: number[], log?: (message: string, fields: object) => void}} deps
 *   `listContainers` is `docker ps --format PS_FORMAT`'s output; `target` where a port's connections go
 */
export function createDockerPorts({ listContainers, target = (port) => ({ host: 'host.docker.internal', port }), bindHost = '127.0.0.1', skip = SESSION_PORTS, log = (m, f) => console.log(m, f) }) {
  const forwards = new Map(); // port -> net.Server
  const leftOut = new Map(); // port -> why it is not forwarded, while it stays published
  let refreshing = null;
  let again = false;

  function forward(port, container) {
    return new Promise((resolve) => {
      const server = net.createServer((client) => {
        const to = target(port);
        const upstream = net.connect(to.port, to.host);
        client.pipe(upstream).pipe(client);
        const end = () => { client.destroy(); upstream.destroy(); };
        client.on('error', end);
        upstream.on('error', end);
        client.on('close', end);
        upstream.on('close', end);
      });
      server.once('error', (err) => {
        const why = err.code === 'EADDRINUSE' ? 'something in the session listens on it' : err.code || err.message;
        // Tried again at each read, in case it lets go, and said once.
        if (leftOut.get(port) !== why) log('dockerPorts: port not forwarded', { port, container, why });
        leftOut.set(port, why);
        resolve();
      });
      server.listen(port, bindHost, () => {
        forwards.set(port, server);
        leftOut.delete(port);
        const to = target(port);
        log('dockerPorts: port forwarded', { port, container, to: `${to.host}:${to.port}` });
        resolve();
      });
    });
  }

  async function once() {
    let ports;
    try {
      ports = portsFrom(await listContainers());
    } catch (err) {
      log('dockerPorts: containers not read', { message: String(err?.stderr || err?.message || err).trim().split('\n')[0] });
      return;
    }
    for (const [port, server] of forwards) {
      if (ports.has(port)) continue;
      forwards.delete(port);
      server.close();
      log('dockerPorts: forward ended, the port is no longer published', { port });
    }
    for (const port of leftOut.keys()) if (!ports.has(port)) leftOut.delete(port);
    for (const [port, container] of ports) {
      if (forwards.has(port)) continue;
      if (skip.includes(port)) {
        if (!leftOut.has(port)) log('dockerPorts: port not forwarded', { port, container, why: 'the session uses it' });
        leftOut.set(port, 'the session uses it');
        continue;
      }
      await forward(port, container);
    }
  }

  /** Reads the containers and forwards what changed; a call during a read makes one more read after it. */
  async function refresh() {
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function close() {
    for (const server of forwards.values()) server.close();
    forwards.clear();
  }

  return { refresh, close, forwarded: () => [...forwards.keys()].sort((a, b) => a - b), leftOut: () => new Map(leftOut) };
}

// `docker events` for containers starting and stopping, each a reason to read `docker ps` again; started anew when it ends.
function watchEvents(onEvent) {
  const child = spawn('docker', ['events', '--filter', 'type=container', '--filter', 'event=start', '--filter', 'event=die', '--format', '{{.Status}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', () => onEvent());
  child.on('close', () => setTimeout(() => watchEvents(onEvent), POLL_MS).unref());
  child.on('error', () => {});
}

if (isMain(import.meta.url)) {
  const ports = createDockerPorts({
    listContainers: async () => (await execFileAsync('docker', ['ps', '--format', PS_FORMAT])).stdout,
  });
  console.log('dockerPorts: watching this machine\'s containers', { docker: process.env.DOCKER_HOST || 'default' });
  let timer = null;
  // A burst of events (a stack of ten containers) is one read.
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { ports.refresh(); }, 200);
  };
  watchEvents(soon);
  ports.refresh();
  setInterval(() => { ports.refresh(); }, POLL_MS);
}
