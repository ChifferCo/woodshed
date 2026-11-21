// `woodshed forward <id> <port>[:<local>]` and `woodshed forward --auto <id>`: a port in the person's running session
// on this computer's localhost, as `ssh -L` gives one. Each connection made here is one request to the console,
// `UPGRADE /api/tunnel/port/<id>/<port>` (console/execPipe.mjs, then the session's statusd, session/portPipe.mjs), so a
// console restart or a dropped network cuts only the connections open then: the next one opens again by itself.
//
// --auto follows the ports the session listens on, as session/dockerPorts.mjs follows a machine's containers: it reads
// the session's own socket tables through the exec pipe every 2 seconds (one pipe, held open), forwards each new port,
// and closes the forward of one that stopped listening. A local port that is taken moves to the next free one, and it
// says which. It runs until Ctrl-C.

import net from 'node:net';

import { createUnframer, encodeLine, frame, FRAME, LINE_HEADER } from '../shared/execFrames.mjs';
import { SESSION_PORTS, listeningPorts, portNumber } from '../shared/listeningPorts.mjs';
import { openUpgrade } from './tunnel.mjs';

// The session's sockets, read every 2 seconds between markers, for as long as the pipe is open.
export const MARK = '#woodshed-ports';
export const WATCH_LINE = `while :; do echo '${MARK}'; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; sleep 2; done`;
export const ONCE_LINE = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';
// How far past a taken port the next free one is looked for.
const MOVE_TRIES = 100;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** @returns {{port: number, local: number}|null}  from `5173` or `5173:3000` */
export function parseSpec(text) {
  const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(String(text ?? ''));
  if (!match) return null;
  const port = portNumber(match[1]);
  const local = match[2] === undefined ? port : portNumber(match[2]);
  return port && local ? { port, local } : null;
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * The first port from `wanted` on that is free on both of localhost's addresses, so a browser that tries ::1 first
 * never reaches some other program on the same port.
 * @param {(socket: net.Socket) => void} onConnection
 * @returns {Promise<{servers: net.Server[], port: number}>}
 */
export async function listenFree(wanted, onConnection, { tries = MOVE_TRIES } = {}) {
  for (let port = wanted; port < wanted + tries && port <= 65_535; port++) {
    const v4 = net.createServer(onConnection);
    try {
      await listenOn(v4, port, '127.0.0.1');
    } catch (err) {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') continue;
      throw err;
    }
    const v6 = net.createServer(onConnection);
    try {
      await listenOn(v6, port, '::1');
      return { servers: [v4, v6], port };
    } catch (err) {
      // No IPv6 here: 127.0.0.1 alone is localhost.
      if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') return { servers: [v4], port };
      v4.close();
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') continue;
      throw err;
    }
  }
  throw new Error(`no free port from ${wanted} to ${Math.min(65_535, wanted + tries - 1)} here`);
}

/**
 * @param {{origin: string, token: string, session: string, specs: {port: number, local: number}[], auto: boolean,
 *          say: (text: string) => void, warn: (text: string) => void, emit: (object: object) => void,
 *          signal: AbortSignal, userAgent?: string, retryMs?: number[], lines?: {once: string, watch: string}}} args
 *   `lines` are what read the session's sockets, once and every 2 seconds: a test's stand-in for the session's /proc
 * @returns {Promise<{refused: Error}|null>}  null once stopped by `signal`; the refusal when the session could not be
 *   reached at the start
 */
export async function runForward({ origin, token, session, specs, auto, say, warn, emit, signal, userAgent = 'woodshed-cli', retryMs = RETRY_MS, lines = { once: ONCE_LINE, watch: WATCH_LINE } }) {
  const forwards = new Map(); // session port -> {servers, local, sockets}
  const failures = new Map(); // session port -> the last failure said, so each is said once until it changes
  const upgrade = (path, headers) => openUpgrade({ url: new URL(path, origin), token, headers, userAgent });

  function connection(port) {
    return (client) => {
      client.pause();
      client.on('error', () => {});
      const entry = forwards.get(port);
      entry?.sockets.add(client);
      client.on('close', () => entry?.sockets.delete(client));
      upgrade(`/api/tunnel/port/${session}/${port}`).then(({ socket: remote, head }) => {
        if (failures.delete(port)) say(`Session ${session}'s port ${port} answers again.`);
        if (client.destroyed) return remote.destroy();
        if (head?.length) client.write(head);
        remote.on('error', () => client.destroy());
        client.on('close', () => remote.destroy());
        remote.on('close', () => client.end());
        remote.pipe(client);
        client.pipe(remote);
        client.resume();
      }, (err) => {
        client.destroy();
        if (failures.get(port) === err.message) return;
        failures.set(port, err.message);
        warn(`port ${port}: ${err.message}`);
        emit({ event: 'connection-failed', session, port, error: err.message });
      });
    };
  }

  async function open(port, wanted) {
    if (forwards.has(port)) return;
    const entry = { servers: [], local: null, sockets: new Set() };
    forwards.set(port, entry);
    let listening;
    try {
      listening = await listenFree(wanted, connection(port));
    } catch (err) {
      forwards.delete(port);
      warn(`port ${port}: ${err.message}`);
      emit({ event: 'error', session, port, error: err.message });
      return;
    }
    // Stopped following while it found a port: nothing is left listening.
    if (forwards.get(port) !== entry) {
      for (const server of listening.servers) server.close();
      return;
    }
    Object.assign(entry, listening, { local: listening.port });
    const url = `http://localhost:${entry.local}`;
    if (entry.local !== wanted) say(`localhost:${wanted} is taken here, so session ${session}'s port ${port} is on ${url}`);
    else say(`Session ${session}'s port ${port} is on ${url}`);
    emit({ event: 'forwarding', session, port, local: entry.local, wanted, moved: entry.local !== wanted, url });
  }

  function close(port, why) {
    const entry = forwards.get(port);
    if (!entry) return;
    forwards.delete(port);
    failures.delete(port);
    for (const server of entry.servers) server.close();
    for (const socket of entry.sockets) socket.destroy();
    if (why) {
      say(`Session ${session}'s port ${port} ${why}: localhost:${entry.local} closed.`);
      emit({ event: 'closed', session, port, local: entry.local, why });
    }
  }

  // What the session listens on now, once, through the exec pipe: whether it can be reached at all, before anything
  // listens here.
  async function listeningNow() {
    const { socket, head } = await upgrade(`/api/tunnel/exec/${session}`, { [LINE_HEADER]: encodeLine(lines.once) });
    return new Promise((resolve) => {
      let text = '';
      const read = createUnframer((kind, data) => { if (kind === FRAME.stdout) text += data; });
      const onData = (chunk) => {
        try {
          read(chunk);
        } catch {
          socket.destroy();
        }
      };
      socket.on('data', onData);
      socket.on('error', () => {});
      socket.on('close', () => resolve(listeningPorts(text)));
      if (head?.length) onData(head);
      // Its stdin's end, as a frame: ending the connection would be a disconnect, which hangs the line up.
      socket.write(frame(FRAME.stdinEnd, Buffer.alloc(0)));
    });
  }

  let first;
  try {
    first = await listeningNow();
  } catch (err) {
    return { refused: err };
  }
  let own = null;
  for (const { port, local } of specs) {
    if (SESSION_PORTS.includes(port)) {
      own = `port ${port} is the session's own: open it from the console`;
      if (auto || specs.length > 1) warn(own);
      continue;
    }
    await open(port, local);
    if (!first.includes(port)) say(`Nothing in session ${session} listens on port ${port} yet: connections fail until something does.`);
  }

  // --auto: one exec pipe printing the session's sockets every 2 seconds, opened again when it is cut.
  let watcher = null;
  let stopped = false;
  async function watch() {
    let attempt = 0;
    let lastFailure = null;
    while (!stopped) {
      try {
        const { socket, head } = await upgrade(`/api/tunnel/exec/${session}`, { [LINE_HEADER]: encodeLine(lines.watch) });
        if (lastFailure) say(`Following session ${session}'s ports again.`);
        lastFailure = null;
        attempt = 0;
        watcher = socket;
        await new Promise((resolve) => {
          let text = '';
          const seen = (block) => {
            const now = listeningPorts(block);
            for (const port of now) open(port, port);
            for (const port of forwards.keys()) if (!now.includes(port) && !specs.some((s) => s.port === port)) close(port, 'stopped listening');
          };
          const read = createUnframer((kind, data) => {
            if (kind !== FRAME.stdout) return;
            text += data;
            const blocks = text.split(`${MARK}\n`);
            // Every block but the last is whole: a block ends where the next one's marker starts.
            for (const block of blocks.slice(1, -1)) seen(block);
            text = `${MARK}\n${blocks.at(-1)}`;
            if (blocks.length === 1) text = blocks[0];
          });
          const onData = (chunk) => {
            try {
              read(chunk);
            } catch {
              socket.destroy();
            }
          };
          socket.on('data', onData);
          socket.on('error', () => {});
          socket.on('close', resolve);
          if (head?.length) onData(head);
        });
        watcher = null;
        if (stopped) return;
        lastFailure = 'the connection to the session was cut';
        warn(`${lastFailure}: following its ports again shortly (the forwards stay open)`);
      } catch (err) {
        if (stopped) return;
        if (err.message !== lastFailure) warn(`could not follow session ${session}'s ports: ${err.message}; trying again`);
        lastFailure = err.message;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs[Math.min(attempt++, retryMs.length - 1)]));
    }
  }
  if (auto) {
    for (const port of first) await open(port, port);
    say(`Following session ${session}'s ports. Ctrl-C stops.`);
    watch();
  } else if (!forwards.size) {
    // Nothing it was asked for can be forwarded: a refusal, not a forward that ended.
    return { refused: Object.assign(new Error(own ?? 'nothing to forward'), { status: 403 }) };
  } else say('Ctrl-C stops.');

  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', resolve, { once: true });
  });
  stopped = true;
  watcher?.destroy();
  for (const port of [...forwards.keys()]) close(port, null);
  return null;
}
