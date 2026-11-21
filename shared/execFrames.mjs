// The exec pipe's frames (cli/tunnel.mjs and session/execPipe.mjs, with the console copying bytes between them). Both
// ways are framed, so the far end can tell a program's stdout from its stderr and learn its exit code, as `ssh` or
// `docker exec` give them, and so its stdin can end without the connection's own half ending: a proxy in the way
// (Caddy) may close both halves of an upgraded connection when one ends, and a connection that ends is a disconnect.
//
//   [kind: 1 byte][length: 4 bytes, big-endian][that many bytes]
//
// From the session: 1 stdout, 2 stderr, 3 the exit code (4 bytes, signed: 128+n for signal n), after which the session
// closes the connection. To the session: 4 stdin, 5 stdin's end (no bytes).

export const PROTOCOL = 'woodshed-tunnel';
export const LINE_HEADER = 'x-woodshed-exec';
export const FRAME = Object.freeze({ stdout: 1, stderr: 2, exit: 3, stdin: 4, stdinEnd: 5 });
// The kinds each way.
export const FROM_SESSION = Object.freeze([FRAME.stdout, FRAME.stderr, FRAME.exit]);
export const TO_SESSION = Object.freeze([FRAME.stdin, FRAME.stdinEnd]);
// A frame never carries more than this; a reader refuses a longer one, as a stream gone wrong.
export const MAX_FRAME = 1 << 20;
// The line to run, before it is base64'd into its header: with the base64 and the request's other headers it stays under
// the 16 KiB of headers Node's HTTP server takes, at statusd and at the console.
export const MAX_LINE = 8192;

/** @returns {Buffer}  one frame of `kind`, for at most MAX_FRAME bytes of `data` */
export function frame(kind, data) {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

/** @returns {Buffer}  the exit code's frame */
export function exitFrame(code) {
  const data = Buffer.alloc(4);
  data.writeInt32BE(code, 0);
  return frame(FRAME.exit, data);
}

/**
 * A reader for one way of the stream: hand it each chunk as it arrives, in any sizes, and it calls `onFrame(kind, data)`
 * once per whole frame, the exit code as a number.
 * @param {(kind: number, data: Buffer|number) => void} onFrame
 * @param {{kinds?: readonly number[]}} [opts]  the kinds this way carries: FROM_SESSION, or TO_SESSION
 * @returns {(chunk: Buffer) => void}  throws on a frame that is not one: a kind not of this way, or too long
 */
export function createUnframer(onFrame, { kinds = FROM_SESSION } = {}) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 5) {
      const kind = buffered[0];
      const length = buffered.readUInt32BE(1);
      if (!kinds.includes(kind) || length > MAX_FRAME || (kind === FRAME.exit && length !== 4) || (kind === FRAME.stdinEnd && length !== 0)) {
        throw new Error(`not an exec pipe frame (kind ${kind}, ${length} bytes)`);
      }
      if (buffered.length < 5 + length) break;
      const data = buffered.subarray(5, 5 + length);
      buffered = buffered.subarray(5 + length);
      onFrame(kind, kind === FRAME.exit ? data.readInt32BE(0) : data);
    }
  };
}

/** @returns {string}  the line, as its header carries it */
export function encodeLine(line) {
  return Buffer.from(String(line), 'utf8').toString('base64');
}

/** @returns {string|null}  the line a header carries, or null for none, one too long, or one holding a NUL */
export function decodeLine(header) {
  const raw = String(header ?? '');
  if (!raw || raw.length > Math.ceil(MAX_LINE / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const line = Buffer.from(raw, 'base64').toString('utf8');
  return line.trim() && Buffer.byteLength(line) <= MAX_LINE && !line.includes('\0') ? line : null;
}
