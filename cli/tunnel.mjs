// `woodshed tunnel <id> -- <line>`: runs <line> in the person's running session, with this command's stdin, stdout and
// stderr as its own, the way `ssh host <line>` does. A terminal runtime reaches a session through it
// (`--via 'woodshed tunnel <id> --'`), so it is a plain byte pipe: nothing is printed of its own but on stderr, and only
// when something fails.
//
// One HTTPS request, `UPGRADE /api/tunnel/exec/<id>` with the command line's token (console/execPipe.mjs). What comes
// back is framed (shared/execFrames.mjs): stdout to stdout, stderr to stderr, and the line's exit code is this command's.
// 255 is the pipe's own failure: not signed in, refused, the console or the session not reached, or the pipe cut before
// the line ended. Each of those says why on stderr; a line that exits 255 itself does too, but says nothing of its own.
// stdin goes framed, and its end as a frame of its own: the connection is never half closed, which a proxy in the way
// may take for both halves closing.

import http from 'node:http';
import https from 'node:https';

import { FRAME, LINE_HEADER, MAX_FRAME, MAX_LINE, PROTOCOL, createUnframer, encodeLine, frame } from '../shared/execFrames.mjs';

export const TUNNEL_FAILED = 255;
// The console's answer to the upgrade; once it is open, the pipe waits as long as the line runs.
const ANSWER_MS = 20_000;

// What the console says goes to a terminal: only printable text of it.
const plain = (text) => String(text).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 300);

/**
 * One upgrade request to the console, as the tunnel and `woodshed forward` make them.
 * @param {{url: URL, token: string, headers?: object, userAgent?: string, answerMs?: number}} args
 * @returns {Promise<{socket: import('node:net').Socket, head: Buffer}>}  rejects with an Error whose `status` is the
 *   console's answer (absent when it was not reached) and whose message says why, printable
 */
export function openUpgrade({ url, token, headers = {}, userAgent = 'woodshed-cli', answerMs = ANSWER_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const failed = (message, status = null) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { status }));
    };
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      headers: { connection: 'Upgrade', upgrade: PROTOCOL, authorization: `Bearer ${token}`, 'user-agent': userAgent, ...headers },
      agent: false,
    });
    req.setTimeout(answerMs, () => {
      req.destroy();
      failed(`${url.origin} did not answer in ${Math.round(answerMs / 1000)} s`);
    });
    req.on('error', (err) => failed(`could not reach ${url.origin}: ${err.message}`));
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (text.length < 4096) text += chunk; });
      res.on('end', () => {
        const hint = res.statusCode === 401 ? ' (run woodshed login)' : '';
        failed(`refused (${res.statusCode}): ${plain(text) || 'no reason given'}${hint}`, res.statusCode);
      });
      res.on('error', () => failed(`refused (${res.statusCode})`, res.statusCode));
    });
    req.on('upgrade', (res, socket, head) => {
      req.setTimeout(0);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      settled = true;
      resolve({ socket, head });
    });
    req.end();
  });
}

/**
 * @param {{origin: string, token: string, session: string, line: string,
 *          stdin: import('node:stream').Readable, stdout: {write: Function}, stderr: {write: Function},
 *          userAgent?: string, answerMs?: number}} args
 * @returns {Promise<number>}  the line's exit code, or 255
 */
export function runTunnel({ origin, token, session, line, stdin, stdout, stderr, userAgent = 'woodshed-cli', answerMs = ANSWER_MS }) {
  const url = new URL(`/api/tunnel/exec/${session}`, origin);
  const fail = (message) => {
    stderr.write(`woodshed: ${message}\n`);
    return TUNNEL_FAILED;
  };
  if (Buffer.byteLength(line) > MAX_LINE) return Promise.resolve(fail(`the line is longer than ${MAX_LINE / 1024} KiB: put it in a script in the session`));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      // Nothing more is read: a stdin left open (a terminal runtime's) does not keep this process alive.
      stdin.pause?.();
      stdin.destroy?.();
      resolve(code);
    };
    openUpgrade({ url, token, headers: { [LINE_HEADER]: encodeLine(line) }, userAgent, answerMs }).then(({ socket: remote, head }) => {
      let code = null;
      let broken = null;
      // A reader slower than the session (a full pipe) holds the socket back, and so the session's program, rather than
      // this process's memory filling.
      let waiting = 0;
      const write = (out, data) => {
        if (out.write(data) === false && typeof out.once === 'function') {
          waiting++;
          remote.pause();
          out.once('drain', () => {
            if (--waiting === 0) remote.resume();
          });
        }
      };
      const read = createUnframer((kind, data) => {
        if (kind === FRAME.stdout) write(stdout, data);
        else if (kind === FRAME.stderr) write(stderr, data);
        else code = data;
      });
      const onData = (chunk) => {
        try {
          read(chunk);
        } catch (err) {
          broken = err.message;
          remote.destroy();
        }
      };
      remote.on('data', onData);
      if (head?.length) onData(head);
      // stdin, framed, held back while the socket's buffer is full; its end is a frame too.
      stdin.on('data', (data) => {
        let full = false;
        for (let at = 0; at < data.length; at += MAX_FRAME) full = !remote.write(frame(FRAME.stdin, data.subarray(at, at + MAX_FRAME))) || full;
        if (full) {
          stdin.pause();
          remote.once('drain', () => stdin.resume());
        }
      });
      stdin.on('end', () => { if (!remote.destroyed) remote.write(frame(FRAME.stdinEnd, Buffer.alloc(0))); });
      stdin.on('error', () => {});
      stdin.resume();
      remote.on('error', () => {});
      // A reader that went away (stdout closed) ends the pipe, as it would end the line.
      for (const out of [stdout, stderr]) out.on?.('error', () => remote.destroy());
      remote.on('close', () => {
        if (code !== null) return finish(code);
        finish(fail(broken ? `the pipe broke: ${broken}` : 'the pipe closed before the line ended'));
      });
    }, (err) => finish(fail(err.message)));
  }).then((code) => new Promise((resolve) => {
    // What is still in stdout's buffer goes out first, or a reader at the far end of a pipe loses the end.
    if (typeof stdout.write === 'function' && stdout.writableLength) stdout.write('', () => resolve(code));
    else resolve(code);
  }));
}
