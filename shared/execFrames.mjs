// The exec pipe's return stream (session/execPipe.mjs writes it, cli/tunnel.mjs reads it). What a program in a session
// writes comes back framed, so the far end can tell its stdout from its stderr and learn its exit code, as `ssh` or
// `docker exec` give them:
//
//   [kind: 1 byte][length: 4 bytes, big-endian][that many bytes]
//
// kind 1 is stdout, 2 stderr, 3 the exit code (4 bytes, signed: 128+n for signal n), after which nothing more comes.
// What goes the other way, into the program's stdin, is raw.

export const PROTOCOL = 'woodshed-tunnel';
export const LINE_HEADER = 'x-woodshed-exec';
export const FRAME = Object.freeze({ stdout: 1, stderr: 2, exit: 3 });
// A frame never carries more than this; a reader refuses a longer one, as a stream gone wrong.
export const MAX_FRAME = 1 << 20;
// The line to run, before it is base64'd into its header.
export const MAX_LINE = 16_384;

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
 * A reader for the stream: hand it each chunk as it arrives, in any sizes, and it calls `onFrame(kind, data)` once per
 * whole frame, the exit code as a number.
 * @param {(kind: number, data: Buffer|number) => void} onFrame
 * @returns {(chunk: Buffer) => void}  throws on a frame that is not one: an unknown kind, or too long
 */
export function createUnframer(onFrame) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 5) {
      const kind = buffered[0];
      const length = buffered.readUInt32BE(1);
      if (!Object.values(FRAME).includes(kind) || length > MAX_FRAME || (kind === FRAME.exit && length !== 4)) {
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
