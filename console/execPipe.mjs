// A byte pipe from a person's computer into their running session, for `woodshed tunnel <id> -- <line>` (cli/tunnel.mjs),
// which a terminal runtime's `--via` connection runs as it would `ssh`:
//
//   UPGRADE /api/tunnel/exec/<id>   `Authorization: Bearer wsc_...` (the command line's token, cliSignIn.mjs),
//                                   `Upgrade: woodshed-tunnel`, `x-woodshed-exec: <the line, base64>`
//
// The console checks the token and the session, then sends the request on to the session's statusd `/exec` with the
// session's token in place of the person's, as it reaches statusd for the terminals' viewers, and copies bytes both
// ways once statusd answers 101. statusd runs the line (session/execPipe.mjs) and frames what comes back
// (shared/execFrames.mjs). Nothing new is open: it is the console's own port, and statusd's, which the console already
// reaches.
//
// Each connection is checked as it opens, and again every 15 seconds while it lasts: the token passes cliSignIn's
// `authenticate` (live, its person still on the console and with write access on GitHub), the session is running, and the person may open it (`mayOpen`: its owner, for now). Revoking
// the token closes its pipes at once (cliSignIn's `whenEnded`), and so does a session's lockdown starting
// (fleet.onLocking): a tainted session's only way out is the console's egress proxy, so it gets no pipe at all.
// An open pipe is not activity: the session pauses when idle as it would without one, which ends the pipe.
//
// The same checks open a terminal, for `woodshed session connect` (cli/terminal.mjs):
//
//   UPGRADE /api/tunnel/term/<id>    `Upgrade: websocket`, the same token, `x-woodshed-terminal-size: <columns>x<rows>`
//   UPGRADE /api/tunnel/shell/<id>   the same, for the Terminal tab's shell rather than the agent's terminal (the TUI tab)
//
// The console sends the websocket on to the session's ttyd for that tab, as terminalProxy.mjs does the page's, with
// ttyd's credential in place of the person's token. ttyd also wants its credential in the terminal's first message,
// which a browser reads from ttyd's /token page: the console sends that message itself, with the size the command line
// asked for, so the credential never leaves the console. Then it copies bytes both ways, as for a pipe.

import net from 'node:net';

import logins from './public/logins.cjs';
import { basicAuth } from './terminalProxy.mjs';
import { LINE_HEADER, PROTOCOL, decodeLine } from '../shared/execFrames.mjs';
import { OP, encodeFrame, isKey } from '../shared/wsFrames.mjs';
const { loginKey } = logins;

const PATH_RE = /^\/api\/tunnel\/exec\/([0-9a-f]{8})$/;
const TERMINAL_RE = /^\/api\/tunnel\/(term|shell)\/([0-9a-f]{8})$/;
export const SIZE_HEADER = 'x-woodshed-terminal-size';
// The session's port for each terminal, as its endpoint names them.
const TERMINAL_PORT = { term: 'termPort', shell: 'shellPort' };

/** @returns {{columns: number, rows: number}}  the size asked for, kept to what a terminal can be; 80x24 for none */
export function terminalSize(header) {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(String(header ?? ''));
  const keep = (n, fallback) => (n >= 1 ? Math.min(n, 1000) : fallback);
  return { columns: keep(Number(match?.[1]), 80), rows: keep(Number(match?.[2]), 24) };
}
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
 *          cli: {authenticate: (headers: object) => Promise<{signedIn: {id: string, login: string|null, record: object}|null}>,
 *            whenEnded?: (fn: (ended: {id: string}) => void) => void},
 *          mayOpen?: (session: object, login: string) => boolean, now?: () => number, recheckMs?: number}} deps
 */
export function createExecPipe({ fleet, cli, mayOpen = ownerOnly, now = Date.now, recheckMs = RECHECK_MS }) {
  // Every pipe open now: {socket, upstream, tokenId, login, session, authorization, openedAt, why}.
  const pipes = new Set();
  let timer = null;

  /** @returns {{session: object}|{status: number, text: string, message: string, why: string}} */
  function check(id, login, kind = 'exec') {
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
    if (kind !== 'exec' && (!session.endpoint[TERMINAL_PORT[kind]] || !session.terminalToken)) {
      return { status: 404, text: 'Not Found', message: 'this session has no such terminal: its image is older than it\n', why: 'no terminal' };
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

  // Expiry, a person taken off the console or without write access, a session stopped or handed to someone else: each
  // is found here.
  async function recheck() {
    await Promise.all([...pipes].map(async (pipe) => {
      let signedIn = null;
      try {
        ({ signedIn } = await cli.authenticate({ authorization: pipe.authorization }));
      } catch (err) {
        console.warn('execPipe: token not checked', { login: pipe.login, session: pipe.session, message: err.message });
      }
      if (!signedIn) close(pipe, 'the token ended');
      else {
        const checked = check(pipe.session, pipe.login, pipe.kind);
        if (!checked.session) close(pipe, checked.why);
      }
    }));
  }

  function track(pipe) {
    pipes.add(pipe);
    if (!timer) {
      timer = setInterval(() => { recheck(); }, recheckMs);
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

  /** @returns {boolean}  false when the path is not the exec pipe's or a terminal's */
  function handleUpgrade(req, socket, head) {
    // The raw path, not new URL(): a path like //a:99999 makes it throw, and nothing above this catches.
    const pathname = String(req.url || '/').split('?')[0];
    const terminal = TERMINAL_RE.exec(pathname);
    const id = terminal?.[2] ?? PATH_RE.exec(pathname)?.[1];
    if (!id) return false;
    const kind = terminal?.[1] ?? 'exec';
    if (kind === 'exec' && String(req.headers.upgrade).toLowerCase() !== PROTOCOL) {
      refuse(socket, 400, 'Bad Request', `upgrade to ${PROTOCOL}\n`);
      return true;
    }
    if (kind !== 'exec' && (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !isKey(req.headers['sec-websocket-key'])
      || req.headers['sec-websocket-version'] !== '13')) {
      refuse(socket, 400, 'Bad Request', 'upgrade to a websocket (version 13)\n');
      return true;
    }
    // Asking GitHub about write access can take a moment: the socket waits, and is let go of if it closes meanwhile. A
    // reset while it waits is not an uncaught error: nothing else listens on the socket until forward().
    socket.on('error', () => socket.destroy());
    cli.authenticate(req.headers).then(({ signedIn, error }) => {
      if (socket.destroyed) return;
      if (!signedIn) {
        console.warn('execPipe: refused, no valid token', { session: id });
        refuse(socket, 401, 'Unauthorized', `${error}\n`);
        return;
      }
      const { login } = signedIn;
      const checked = check(id, login, kind);
      if (!checked.session) {
        console.warn('execPipe: refused', { login, session: id, kind, why: checked.why });
        refuse(socket, checked.status, checked.text, checked.message);
        return;
      }
      if (kind !== 'exec') {
        forward({ kind, signedIn, session: checked.session, authorization: req.headers.authorization, socket, head, key: req.headers['sec-websocket-key'], size: terminalSize(req.headers[SIZE_HEADER]) });
        return;
      }
      const line = req.headers[LINE_HEADER];
      if (!decodeLine(line)) {
        refuse(socket, 400, 'Bad Request', `no line to run in ${LINE_HEADER}, or one too long\n`);
        return;
      }
      forward({ kind, signedIn, session: checked.session, line, authorization: req.headers.authorization, socket, head });
    }).catch((err) => {
      console.warn('execPipe: token not checked', { session: id, message: err.message });
      socket.destroy();
    });
    return true;
  }

  // A terminal's request to its ttyd, and the first message ttyd wants: its credential, and the terminal's size.
  function terminalRequest({ kind, session, key, size, host, port }) {
    const lines = [`GET /${kind}/${session.id}/ws HTTP/1.1`, `host: ${host}:${port}`, 'connection: Upgrade', 'upgrade: websocket',
      `sec-websocket-key: ${key}`, 'sec-websocket-version: 13', 'sec-websocket-protocol: tty', `origin: http://${host}:${port}`,
      `authorization: ${basicAuth(session.terminalToken)}`];
    const credential = Buffer.from(`woodshed:${session.terminalToken}`).toString('base64');
    return { lines, first: encodeFrame(OP.text, JSON.stringify({ AuthToken: credential, ...size })) };
  }

  function forward({ kind, signedIn, session, line, authorization, socket, head, key, size }) {
    const { host, statusPort } = session.endpoint;
    const port = kind === 'exec' ? statusPort : session.endpoint[TERMINAL_PORT[kind]];
    const pipe = { socket, upstream: null, kind, tokenId: signedIn.id, login: signedIn.login, session: session.id, authorization, openedAt: now(), why: null };
    track(pipe);
    let answered = false;
    const terminal = kind === 'exec' ? null : terminalRequest({ kind, session, key, size, host, port });
    const upstream = net.connect(port, host);
    pipe.upstream = upstream;
    const giveUp = setTimeout(() => {
      console.warn('execPipe: the session did not answer', { login: pipe.login, session: pipe.session });
      refuse(socket, 504, 'Gateway Timeout', 'the session did not answer the console\n');
      upstream.destroy();
    }, ANSWER_MS);
    upstream.on('connect', () => {
      const lines = terminal?.lines ?? [`GET /exec HTTP/1.1`, `host: ${host}:${statusPort}`, 'connection: Upgrade', `upgrade: ${PROTOCOL}`,
        `authorization: Bearer ${session.token}`, `${LINE_HEADER}: ${line}`];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      // A websocket's client sends nothing before the 101: anything that came early follows the console's first message.
      if (head?.length && !terminal) upstream.write(head);
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
        console.warn('execPipe: refused by the session', { login: pipe.login, session: pipe.session, kind, status: status || null });
        // ttyd's refusal is of the console's credential, not the person's token: a 401 passed on would read as their
        // sign-in ending. statusd's answers to the pipe are its own (a tainted session's 409), and pass as they are.
        if (kind !== 'exec') {
          refuse(socket, 502, 'Bad Gateway', `the session's terminal did not open (it answered ${status || 'nothing'})\n`);
          upstream.destroy();
          return;
        }
        socket.write(buffered);
        upstream.pipe(socket);
        return;
      }
      upstream.setNoDelay(true);
      socket.setNoDelay?.(true);
      if (terminal) {
        upstream.write(terminal.first);
        if (head?.length) upstream.write(head);
      }
      socket.write(buffered);
      // pipe() holds each side back while the other's buffer is full.
      upstream.pipe(socket);
      socket.pipe(upstream);
      pipe.connected = true;
      console.log('execPipe: opened', { login: pipe.login, session: pipe.session, kind, token: pipe.tokenId, device: signedIn.record?.name ?? null });
    };
    upstream.on('data', readAnswer);
    upstream.on('error', (err) => {
      if (answered) return socket.destroy();
      clearTimeout(giveUp);
      console.warn('execPipe: session unreachable', { login: pipe.login, session: pipe.session, message: err.message });
      refuse(socket, 502, 'Bad Gateway', 'the session did not answer the console\n');
    });
    // The session's side closed: the computer's is ended once what is on its way is written, and read again so its
    // hang-up is seen (pipe() paused it when the session's side went), or the pipe would stay open until the session
    // stops. An upgraded socket is half open by default, so the computer hanging up first ends the console's side too.
    upstream.on('close', () => {
      clearTimeout(giveUp);
      socket.end();
      if (answered) socket.resume();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('end', () => {
      upstream.end();
      socket.end();
    });
    socket.on('close', () => {
      clearTimeout(giveUp);
      upstream.destroy();
      untrack(pipe);
      if (!pipe.connected) return;
      console.log('execPipe: closed', {
        login: pipe.login, session: pipe.session, kind, token: pipe.tokenId, seconds: Math.round((now() - pipe.openedAt) / 1000),
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
