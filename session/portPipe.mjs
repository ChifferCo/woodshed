// A TCP stream to a port in the session, for `woodshed forward` (cli/forward.mjs): a dev server's port on its owner's
// computer, as `ssh -L` would give it.
//
//   UPGRADE /port/<port>   `Authorization: Bearer <SESSION_TOKEN>`, `Upgrade: woodshed-tunnel`
//
// Only the console holds the token, and it opens this for the session's person alone (console/execPipe.mjs). statusd
// connects to localhost:<port> in the session, and once that connects answers 101 and copies bytes both ways, raw:
// each connection on the computer is one of these. The session's own ports (its terminals, statusd, the viewers, the
// editor, Redis) are refused: the console reaches those itself, behind its sign-in. A tainted session forwards nothing,
// as it runs nothing for anyone off it (execPipe.mjs).

import net from 'node:net';

import { PROTOCOL } from '../shared/execFrames.mjs';
import { SESSION_PORTS, portNumber } from '../shared/listeningPorts.mjs';

export const PORT_PATH_RE = /^\/port\/(\d{1,5})$/;
const CONNECT_MS = 10_000;

function refuse(socket, status, text, message) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\n`
    + `connection: close\r\n\r\n${message}`);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{isAuthorized: (header: string|undefined) => boolean, tainted?: () => boolean, ask?: boolean, host?: string}} ctx
 */
export function handlePortUpgrade(req, socket, head, { isAuthorized, tainted = () => false, ask = false, host = 'localhost' }) {
  socket.on('error', () => socket.destroy());
  if (!isAuthorized(req.headers.authorization)) return refuse(socket, 401, 'Unauthorized', 'not the console\n');
  if (String(req.headers.upgrade).toLowerCase() !== PROTOCOL) return refuse(socket, 400, 'Bad Request', `upgrade to ${PROTOCOL}\n`);
  if (ask) return refuse(socket, 404, 'Not Found', 'a question from Slack forwards nothing\n');
  if (tainted()) {
    console.warn('statusd: port refused, the session is tainted');
    return refuse(socket, 409, 'Conflict', 'this session has seen production data: nothing in it is reached from outside\n');
  }
  const port = portNumber(PORT_PATH_RE.exec(String(req.url || '/').split('?')[0])?.[1]);
  if (!port) return refuse(socket, 400, 'Bad Request', 'not a port\n');
  if (SESSION_PORTS.includes(port)) return refuse(socket, 403, 'Forbidden', `port ${port} is the session's own: open it from the console\n`);
  // localhost, not 127.0.0.1: a dev server that listens on ::1 alone (Node's default for `localhost`) is reached too.
  const upstream = net.connect({ port, host, autoSelectFamily: true, timeout: CONNECT_MS });
  let connected = false;
  upstream.on('connect', () => {
    connected = true;
    upstream.setTimeout(0);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: ${PROTOCOL}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    // pipe() holds each side back while the other's buffer is full.
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
  upstream.on('error', (err) => {
    if (connected) return socket.destroy();
    refuse(socket, 502, 'Bad Gateway', `nothing answers on port ${port} in the session (${err.code ?? err.message})\n`);
  });
  socket.on('close', () => upstream.destroy());
}
