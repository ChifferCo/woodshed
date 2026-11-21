// `woodshed session connect`'s terminal: this one, put on a session's terminal over the console, as the console's TUI
// tab (the agent's terminal) or Terminal tab (a shell) does in a browser. Keys go there as typed, what it draws comes
// back, and the size follows this window.
//
// One websocket per connection, `UPGRADE /api/tunnel/term|shell/<id>` with the command line's token
// (console/execPipe.mjs), which the console hands to the session's ttyd. ttyd's messages are a byte of their kind and
// the rest: '0' input or output, '1' a new size (JSON), '2' and '3' to pause and resume its output while this terminal
// catches up. Ctrl-\ disconnects, as it detaches in Herdr's hc; the session's terminal goes on without it.

import http from 'node:http';
import https from 'node:https';

import { OP, acceptFor, closeCode, createFrameReader, encodeFrame, newKey } from '../shared/wsFrames.mjs';

export const DETACH = 0x1c;
const SIZE_HEADER = 'x-woodshed-terminal-size';
const ANSWER_MS = 20_000;
// A connection that answers no ping in this long is gone (a laptop that slept, a network that dropped).
const PING_MS = 30_000;

const plain = (text) => String(text).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 300);
const message = (kind, body) => encodeFrame(OP.binary, Buffer.concat([Buffer.from(kind), Buffer.isBuffer(body) ? body : Buffer.from(body)]));

/**
 * Opens the websocket.
 * @param {{origin: string, token: string, session: string, kind: 'term'|'shell', size: {columns: number, rows: number},
 *          userAgent?: string, answerMs?: number}} args
 * @returns {Promise<{socket: import('node:net').Socket, head: Buffer}|{refused: {status: number, message: string}}|{unreachable: string}>}
 */
export function openTerminal({ origin, token, session, kind, size, userAgent = 'woodshed-cli', answerMs = ANSWER_MS }) {
  const url = new URL(`/api/tunnel/${kind}/${session}`, origin);
  const key = newKey();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13',
        'sec-websocket-protocol': 'tty', authorization: `Bearer ${token}`, [SIZE_HEADER]: `${size.columns}x${size.rows}`, 'user-agent': userAgent,
      },
      agent: false,
    });
    req.setTimeout(answerMs, () => {
      req.destroy();
      done({ unreachable: `${url.origin} did not answer in ${Math.round(answerMs / 1000)} s` });
    });
    req.on('error', (err) => done({ unreachable: `could not reach ${url.origin}: ${err.message}` }));
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (text.length < 2000) text += chunk; });
      res.on('end', () => done({ refused: { status: res.statusCode, message: plain(text) || `${url.origin} answered ${res.statusCode}` } }));
      res.on('error', () => done({ refused: { status: res.statusCode, message: `${url.origin} answered ${res.statusCode}` } }));
    });
    req.on('upgrade', (res, socket, head) => {
      req.setTimeout(0);
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== acceptFor(key)) {
        socket.destroy();
        done({ unreachable: `${url.origin} did not open a terminal: not a websocket answer` });
        return;
      }
      done({ socket, head });
    });
    req.end();
  });
}

/**
 * Puts this terminal on the open websocket until one side ends it.
 * @param {{socket: import('node:net').Socket, head?: Buffer, stdin: import('node:stream').Readable & {setRawMode?: Function, isTTY?: boolean},
 *          stdout: import('node:stream').Writable & {columns?: number, rows?: number}, pingMs?: number}} args
 * @returns {Promise<{status: 'closed', code: number|null}|{status: 'detached'}|{status: 'cut', message: string}>}
 *   closed: the session's side ended it (its program exited: 1000); detached: Ctrl-\ here; cut: the connection broke
 */
export function attach({ socket, head = null, stdin, stdout, pingMs = PING_MS }) {
  return new Promise((resolve) => {
    let result = null;
    let paused = false;
    let awaitingPong = false;
    const send = (frame) => {
      if (!socket.destroyed) socket.write(frame);
    };
    const finish = (value) => {
      if (result) return;
      result = value;
      clearInterval(pinger);
      stdin.off('data', onInput);
      stdout.off?.('resize', onResize);
      stdout.off?.('drain', onDrain);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      stdin.pause();
      socket.destroy();
      resolve(value);
    };
    const onDrain = () => {
      if (!paused) return;
      paused = false;
      send(message('3', ''));
    };
    const read = createFrameReader(({ opcode, payload }) => {
      if (opcode === OP.ping) return send(encodeFrame(OP.pong, payload));
      if (opcode === OP.pong) {
        awaitingPong = false;
        return undefined;
      }
      if (opcode === OP.close) {
        send(encodeFrame(OP.close, payload.subarray(0, 2)));
        return finish({ status: 'closed', code: closeCode(payload) });
      }
      // '0' is what the terminal drew; '1' its title and '2' its preferences, for a browser, are left out.
      if (payload[0] !== 0x30) return undefined;
      if (!stdout.write(payload.subarray(1)) && !paused) {
        paused = true;
        send(message('2', ''));
        stdout.once('drain', onDrain);
      }
      return undefined;
    });
    const onInput = (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const at = data.indexOf(DETACH);
      const typed = at < 0 ? data : data.subarray(0, at);
      if (typed.length) send(message('0', typed));
      if (at >= 0) {
        send(encodeFrame(OP.close, Buffer.from([0x03, 0xe8])));
        finish({ status: 'detached' });
      }
    };
    const onResize = () => {
      if (stdout.columns && stdout.rows) send(message('1', JSON.stringify({ columns: stdout.columns, rows: stdout.rows })));
    };
    const pinger = setInterval(() => {
      if (awaitingPong) {
        finish({ status: 'cut', message: `no answer in ${Math.round(pingMs / 1000)} s` });
        return;
      }
      awaitingPong = true;
      send(encodeFrame(OP.ping, ''));
    }, pingMs);
    pinger.unref?.();

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (err) {
        finish({ status: 'cut', message: err.message });
      }
    });
    socket.on('error', (err) => finish({ status: 'cut', message: err.message }));
    socket.on('close', () => finish({ status: 'cut', message: 'the connection closed' }));
    if (stdin.isTTY) stdin.setRawMode?.(true);
    stdin.on('data', onInput);
    stdin.resume();
    stdout.on?.('resize', onResize);
    if (head?.length) socket.emit('data', head);
  });
}
