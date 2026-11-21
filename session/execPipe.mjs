// A byte pipe into the session for a program on its owner's computer: `woodshed tunnel <id> -- <line>`, which a
// terminal runtime's `--via` connection runs as it would `ssh host <line>`.
//
//   UPGRADE /exec   `Authorization: Bearer <SESSION_TOKEN>`, `Upgrade: woodshed-tunnel`, `x-woodshed-exec: <line, base64>`
//
// Only the console holds the token, and it opens this for whoever the session's person allows alone
// (console/execPipe.mjs). statusd answers 101 and runs `sh -c <line>` as the session's user, in the checkout, in a
// process group of its own. Both ways are framed (shared/execFrames.mjs): stdin and its end come in, stdout, stderr and
// then the exit code go out, after which statusd closes the connection. A connection that ends or closes before the
// line does is a disconnect, not the end of stdin: the line's whole process group is hung up (SIGHUP), as a terminal
// closing hangs up what runs in it.
//
// The program gets statusd's environment without the session's own credentials, SESSION_TOKEN and TERMINAL_TOKEN: what
// runs here (an agent runtime's core, and every agent it starts) never holds them. A tainted session runs nothing for
// anyone off it: its only way out is the console's egress proxy, and a pipe would be another.

import { spawn } from 'node:child_process';
import os from 'node:os';

import { FRAME, LINE_HEADER, MAX_FRAME, PROTOCOL, TO_SESSION, createUnframer, decodeLine, exitFrame, frame } from '../shared/execFrames.mjs';

export const EXEC_PATH = '/exec';
// What the program never gets of statusd's environment.
export const WITHHELD_ENV = Object.freeze(['SESSION_TOKEN', 'TERMINAL_TOKEN']);

function refuse(socket, status, text, message) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\n`
    + `connection: close\r\n\r\n${message}`);
}

/** @returns {object}  statusd's environment without the session's credentials */
export function execEnv(env = process.env) {
  const out = { ...env };
  for (const name of WITHHELD_ENV) delete out[name];
  return out;
}

/** @returns {number}  a shell's exit status for a child that ended by `signal`: 128 + its number */
export function signalStatus(signal) {
  return 128 + (os.constants.signals[signal] ?? 0);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{isAuthorized: (header: string|undefined) => boolean, cwd: string, tainted?: () => boolean, ask?: boolean,
 *          env?: object, shell?: string}} ctx
 */
export function handleExecUpgrade(req, socket, head, { isAuthorized, cwd, tainted = () => false, ask = false, env = process.env, shell = 'sh' }) {
  socket.on('error', () => socket.destroy());
  if (!isAuthorized(req.headers.authorization)) return refuse(socket, 401, 'Unauthorized', 'not the console\n');
  if (String(req.headers.upgrade).toLowerCase() !== PROTOCOL) return refuse(socket, 400, 'Bad Request', `upgrade to ${PROTOCOL}\n`);
  // The console refuses both first; this is the session's own word on it.
  if (ask) return refuse(socket, 404, 'Not Found', 'a question from Slack runs nothing for anyone\n');
  if (tainted()) {
    console.warn('statusd: exec refused, the session is tainted');
    return refuse(socket, 409, 'Conflict', 'this session has seen production data: nothing runs in it from outside\n');
  }
  const line = decodeLine(req.headers[LINE_HEADER]);
  if (!line) return refuse(socket, 400, 'Bad Request', 'no line to run, or one too long\n');
  const opened = Date.now();
  let child;
  try {
    // Its own process group, so a hang-up reaches all it started (a pipeline, `cd x && npm run dev`), not sh alone.
    child = spawn(shell, ['-c', line], { cwd, env: execEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } catch (err) {
    return refuse(socket, 500, 'Internal Server Error', `could not start a shell: ${err.message}\n`);
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: ${PROTOCOL}\r\n\r\n`);
  socket.setNoDelay(true);
  console.log('statusd: exec opened', { pid: child.pid ?? null, bytes: Buffer.byteLength(line) });

  let ended = false;
  const hangUp = () => {
    // Whatever it still writes is dropped, never left blocking it.
    for (const stream of outputs) stream.resume();
    if (ended || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGHUP');
    } catch {
      child.kill('SIGHUP');
    }
  };

  // The program's output waits while the socket's buffer is full, so a slow reader slows the program instead of
  // filling statusd's memory.
  const outputs = [child.stdout, child.stderr];
  const send = (kind, data) => {
    if (socket.destroyed) return;
    let full = false;
    for (let at = 0; at < data.length; at += MAX_FRAME) full = !socket.write(frame(kind, data.subarray(at, at + MAX_FRAME))) || full;
    if (full) for (const stream of outputs) stream.pause();
  };
  socket.on('drain', () => { for (const stream of outputs) stream.resume(); });
  child.stdout.on('data', (data) => send(FRAME.stdout, data));
  child.stderr.on('data', (data) => send(FRAME.stderr, data));

  // stdin, framed: the socket waits while the program is not reading.
  child.stdin.on('error', () => {});
  const read = createUnframer((kind, data) => {
    if (kind === FRAME.stdinEnd) return child.stdin.end();
    if (!child.stdin.writable) return;
    if (!child.stdin.write(data)) {
      socket.pause();
      child.stdin.once('drain', () => socket.resume());
    }
  }, { kinds: TO_SESSION });
  const onData = (chunk) => {
    try {
      read(chunk);
    } catch {
      socket.destroy();
    }
  };
  socket.on('data', onData);
  if (head?.length) onData(head);
  // The far end gone before the line ended: a disconnect.
  socket.on('end', hangUp);
  socket.on('close', hangUp);

  child.on('error', (err) => {
    // A shell that could not start: said the way a shell says a missing command.
    if (ended) return;
    ended = true;
    send(FRAME.stderr, Buffer.from(`statusd: ${err.message}\n`));
    if (!socket.destroyed) socket.end(exitFrame(127));
    console.warn('statusd: exec failed', { message: err.message });
  });
  // 'close', not 'exit': stdout and stderr are drained by then.
  child.on('close', (code, signal) => {
    if (ended) return;
    ended = true;
    if (!socket.destroyed) socket.end(exitFrame(code ?? signalStatus(signal)));
    console.log('statusd: exec closed', { pid: child.pid ?? null, code, signal, seconds: Math.round((Date.now() - opened) / 1000) });
  });
}
