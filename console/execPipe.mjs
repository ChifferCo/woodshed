// A byte pipe from a person's computer into their running session, for `woodshed tunnel <id> -- <line>` (cli/tunnel.mjs),
// which a terminal runtime's `--via` connection runs as it would `ssh`:
//
//   UPGRADE /api/tunnel/exec/<id>   `Authorization: Bearer wsc_...` (the command line's token, cliSignIn.mjs),
//                                   `Upgrade: woodshed-tunnel`, `x-woodshed-exec: <the line, base64>`
//   UPGRADE /api/tunnel/port/<id>/<port>   the same token: a TCP stream to that port in the session, for
//                                   `woodshed forward` (cli/forward.mjs), through statusd's /port/<port>
//
// The console checks the token and the session, then sends the request on to the session's statusd `/exec` with the
// session's token in place of the person's, as it reaches statusd for the terminals' viewers, and copies bytes both
// ways once statusd answers 101. statusd runs the line (session/execPipe.mjs) and frames what comes back
// (shared/execFrames.mjs). Nothing new is open: it is the console's own port, and statusd's, which the console already
// reaches.
//
// Each connection is checked as it opens, and again every 15 seconds while it lasts: the token is live and its person
// still on the console, the session is running, and the person may open it (`mayOpen`: its owner, for now). Revoking
// the token closes its pipes at once (cliSignIn's `whenEnded`), and so does a session's lockdown starting
// (fleet.onLocking): a tainted session's only way out is the console's egress proxy, so it gets no pipe at all.
// An open pipe is not activity: the session pauses when idle as it would without one, which ends the pipe.

import net from 'node:net';

import logins from './public/logins.cjs';
import { LINE_HEADER, PROTOCOL, decodeLine } from '../shared/execFrames.mjs';
import { SESSION_PORTS, portNumber } from '../shared/listeningPorts.mjs';
const { loginKey } = logins;

// /api/tunnel/exec/<id>, or /api/tunnel/port/<id>/<port>: a TCP stream to that port in the session, for `woodshed
// forward` (cli/forward.mjs), through statusd's /port/<port> (session/portPipe.mjs), on the same checks.
const PATH_RE = /^\/api\/tunnel\/(?:exec\/([0-9a-f]{8})|port\/([0-9a-f]{8})\/(\d{1,5}))$/;
const RECHECK_MS = 15_000;
// statusd's answer to the upgrade, before the console gives up on it.
const ANSWER_MS = 15_000;
const MAX_ANSWER_HEAD = 16_384;

function refuse(socket, status, text, message) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\n`
    + `connection: close\r\n\r\n${message}`);
}

/**
 * Who may open a pipe into a session: its owner. A later change adds whoever holds a current share of it here.
 * @returns {boolean}
 */
export function ownerOnly(session, login) {
  return Boolean(session?.owner && login) && loginKey(session.owner) === loginKey(login);
}

/**
 * @param {{fleet: {find: (id: string) => object|null, isLocked?: (session: object) => boolean,
 *            onLocking?: (fn: (id: string) => void) => void},
 *          cli: {tokenFor: (headers: object) => {id: string, login: string|null, record: object}|null,
 *            whenEnded?: (fn: (ended: {id: string}) => void) => void},
 *          mayOpen?: (session: object, login: string) => boolean, now?: () => number, recheckMs?: number}} deps
 */
export function createExecPipe({ fleet, cli, mayOpen = ownerOnly, now = Date.now, recheckMs = RECHECK_MS }) {
  // Every pipe open now: {socket, upstream, tokenId, login, session, authorization, openedAt, why}.
  const pipes = new Set();
  let timer = null;

  /** @returns {{session: object}|{status: number, text: string, message: string, why: string}} */
  function check(id, login) {
    const session = fleet.find(id);
    if (!session || !mayOpen(session, login) || session.kind === 'ask') {
      return { status: 404, text: 'Not Found', message: 'no session of yours by that id\n', why: 'not theirs' };
    }
    if (session.taintedAt || fleet.isLocked?.(session)) {
      return { status: 409, text: 'Conflict', message: 'this session has seen production data: nothing runs in it from outside\n', why: 'tainted' };
    }
    if (session.status !== 'running' || !session.endpoint?.statusPort || !session.token) {
      return { status: 409, text: 'Conflict', message: `the session is ${session.status ?? 'not running'}, not running: resume it first\n`, why: 'not running' };
    }
    return { session };
  }

  function close(pipe, why) {
    pipe.why ??= why;
    pipe.socket.destroy();
    pipe.upstream?.destroy();
  }

  function closeWhere(test, why) {
    for (const pipe of pipes) if (test(pipe)) close(pipe, why);
  }

  // Expiry, a person taken off the console, a session stopped or handed to someone else: each is found here.
  function recheck() {
    for (const pipe of pipes) {
      if (!cli.tokenFor({ authorization: pipe.authorization })) close(pipe, 'the token ended');
      else {
        const checked = check(pipe.session, pipe.login);
        if (!checked.session) close(pipe, checked.why);
      }
    }
  }

  function track(pipe) {
    pipes.add(pipe);
    if (!timer) {
      timer = setInterval(recheck, recheckMs);
      timer.unref?.();
    }
  }

  function untrack(pipe) {
    pipes.delete(pipe);
    if (!pipes.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  cli.whenEnded?.(({ id }) => closeWhere((pipe) => pipe.tokenId === id, 'the token was revoked'));
  fleet.onLocking?.((id) => closeWhere((pipe) => pipe.session === id, 'the session is being locked down'));

  /** @returns {boolean}  false when the path is neither the exec pipe's nor a port's */
  function handleUpgrade(req, socket, head) {
    // The raw path, not new URL(): a path like //a:99999 makes it throw, and nothing above this catches.
    const match = PATH_RE.exec(String(req.url || '/').split('?')[0]);
    if (!match) return false;
    const id = match[1] ?? match[2];
    const port = match[2] ? portNumber(match[3]) : null;
    if (String(req.headers.upgrade).toLowerCase() !== PROTOCOL) {
      refuse(socket, 400, 'Bad Request', `upgrade to ${PROTOCOL}\n`);
      return true;
    }
    const signedIn = cli.tokenFor(req.headers);
    if (!signedIn) {
      console.warn('execPipe: refused, no valid token', { session: id });
      refuse(socket, 401, 'Unauthorized', 'not signed in, or the sign-in ended: run woodshed login\n');
      return true;
    }
    const { login } = signedIn;
    const checked = check(id, login);
    if (!checked.session) {
      console.warn('execPipe: refused', { login, session: id, why: checked.why });
      refuse(socket, checked.status, checked.text, checked.message);
      return true;
    }
    if (match[2]) {
      if (!port) {
        refuse(socket, 400, 'Bad Request', 'not a port\n');
        return true;
      }
      if (SESSION_PORTS.includes(port)) {
        refuse(socket, 403, 'Forbidden', `port ${port} is the session's own: open it from the console\n`);
        return true;
      }
      forward({ signedIn, session: checked.session, kind: 'port', port, path: `/port/${port}`, headers: [], authorization: req.headers.authorization, socket, head });
      return true;
    }
    const line = req.headers[LINE_HEADER];
    if (!decodeLine(line)) {
      refuse(socket, 400, 'Bad Request', `no line to run in ${LINE_HEADER}, or one too long\n`);
      return true;
    }
    forward({ signedIn, session: checked.session, kind: 'exec', port: null, path: '/exec', headers: [`${LINE_HEADER}: ${line}`], authorization: req.headers.authorization, socket, head });
    return true;
  }

  function forward({ signedIn, session, kind, port, path, headers, authorization, socket, head }) {
    const { host, statusPort } = session.endpoint;
    const pipe = { socket, upstream: null, tokenId: signedIn.id, login: signedIn.login, session: session.id, authorization, openedAt: now(), why: null };
    const named = kind === 'port' ? { port } : {};
    track(pipe);
    let answered = false;
    const upstream = net.connect(statusPort, host);
    pipe.upstream = upstream;
    const giveUp = setTimeout(() => {
      console.warn('execPipe: the session did not answer', { login: pipe.login, session: pipe.session });
      refuse(socket, 504, 'Gateway Timeout', 'the session did not answer the console\n');
      upstream.destroy();
    }, ANSWER_MS);
    upstream.on('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`, `host: ${host}:${statusPort}`, 'connection: Upgrade', `upgrade: ${PROTOCOL}`,
        `authorization: Bearer ${session.token}`, ...headers];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
    });
    // statusd's answer is read whole before anything goes to the computer: a 101 opens the pipe, anything else is
    // passed on as the refusal it is.
    let buffered = Buffer.alloc(0);
    const readAnswer = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffered.length > MAX_ANSWER_HEAD) upstream.destroy();
        return;
      }
      upstream.off('data', readAnswer);
      clearTimeout(giveUp);
      answered = true;
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1]);
      if (status !== 101) {
        console.warn('execPipe: refused by the session', { login: pipe.login, session: pipe.session, kind, ...named, status: status || null });
        socket.write(buffered);
        upstream.pipe(socket);
        return;
      }
      upstream.setNoDelay(true);
      socket.setNoDelay?.(true);
      socket.write(buffered);
      // pipe() holds each side back while the other's buffer is full.
      upstream.pipe(socket);
      socket.pipe(upstream);
      pipe.connected = true;
      console.log('execPipe: opened', { login: pipe.login, session: pipe.session, kind, ...named, token: pipe.tokenId, device: signedIn.record?.name ?? null });
    };
    upstream.on('data', readAnswer);
    upstream.on('error', (err) => {
      if (answered) return socket.destroy();
      clearTimeout(giveUp);
      console.warn('execPipe: session unreachable', { login: pipe.login, session: pipe.session, message: err.message });
      refuse(socket, 502, 'Bad Gateway', 'the session did not answer the console\n');
    });
    upstream.on('close', () => {
      clearTimeout(giveUp);
      if (!answered) socket.end();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => {
      clearTimeout(giveUp);
      upstream.destroy();
      untrack(pipe);
      if (!pipe.connected) return;
      console.log('execPipe: closed', {
        login: pipe.login, session: pipe.session, kind, ...named, token: pipe.tokenId, seconds: Math.round((now() - pipe.openedAt) / 1000),
        sent: upstream.bytesWritten, received: upstream.bytesRead, why: pipe.why ?? 'ended',
      });
    });
  }

  /** @returns {number}  the pipes open now */
  function count() {
    return pipes.size;
  }

  return { handleUpgrade, count, recheck };
}
