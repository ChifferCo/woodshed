// The few parts of the websocket protocol (RFC 6455) a terminal over the console needs, with no dependency: the opening
// handshake's accept value, a frame to send, and a reader for frames received. `woodshed session connect` (cli/terminal.mjs)
// speaks it to the console, which passes it on to the session's ttyd (console/execPipe.mjs), and the console sends ttyd
// one frame of its own, the terminal's first message.
//
// A client's frames are masked and a server's are not (RFC 6455, 5.1); the reader takes either. Extensions such as
// compression are never asked for, so no frame here has an RSV bit set.

import crypto from 'node:crypto';

export const OP = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// A message larger than this is no terminal's: the reader stops on it rather than hold it.
export const MAX_MESSAGE = 16 * 1024 * 1024;

/** @returns {string}  a new Sec-WebSocket-Key */
export function newKey() {
  return crypto.randomBytes(16).toString('base64');
}

/** @returns {string}  the Sec-WebSocket-Accept a server answers that key with */
export function acceptFor(key) {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** @returns {boolean}  a Sec-WebSocket-Key as RFC 6455 has it: 16 bytes, base64 */
export function isKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key);
}

/**
 * One whole frame.
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {{mask?: boolean}} [opts]  mask: true for a client's frame
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + lengthBytes + (mask ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (mask ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127);
  if (lengthBytes === 2) head.writeUInt16BE(length, 2);
  if (lengthBytes === 8) head.writeBigUInt64BE(BigInt(length), 2);
  if (!mask) return Buffer.concat([head, data]);
  const key = crypto.randomBytes(4);
  key.copy(head, 2 + lengthBytes);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([head, masked]);
}

/**
 * Reads frames from chunks as they come, and hands on each message (fragments joined) and each control frame.
 * @param {(message: {opcode: number, payload: Buffer}) => void} onMessage
 * @param {{maxMessage?: number}} [opts]
 * @returns {(chunk: Buffer) => void}  throws on a frame no websocket sends, or a message over maxMessage
 */
export function createFrameReader(onMessage, { maxMessage = MAX_MESSAGE } = {}) {
  let buffered = Buffer.alloc(0);
  let parts = [];
  let partsLength = 0;
  let partsOpcode = null;
  return function read(chunk) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    for (;;) {
      if (buffered.length < 2) return;
      const fin = (buffered[0] & 0x80) !== 0;
      const opcode = buffered[0] & 0x0f;
      if (buffered[0] & 0x70) throw new Error('a frame with RSV bits set, which nothing here asked for');
      const masked = (buffered[1] & 0x80) !== 0;
      let length = buffered[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(maxMessage)) throw new Error('a frame larger than any terminal sends');
        length = Number(big);
        at = 10;
      }
      if (length > maxMessage) throw new Error('a frame larger than any terminal sends');
      const key = masked ? buffered.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buffered.length < at + length) return;
      let payload = buffered.subarray(at, at + length);
      if (key) payload = Buffer.from(payload.map((byte, i) => byte ^ key[i & 3]));
      buffered = buffered.subarray(at + length);
      if (opcode >= 0x8) {
        onMessage({ opcode, payload });
        continue;
      }
      if (opcode !== OP.continuation) {
        partsOpcode = opcode;
        parts = [];
        partsLength = 0;
      }
      if (partsOpcode === null) throw new Error('a continuation frame with no message to continue');
      parts.push(payload);
      partsLength += payload.length;
      if (partsLength > maxMessage) throw new Error('a message larger than any terminal sends');
      if (fin) {
        const message = { opcode: partsOpcode, payload: parts.length === 1 ? parts[0] : Buffer.concat(parts) };
        partsOpcode = null;
        parts = [];
        partsLength = 0;
        onMessage(message);
      }
    }
  };
}

/** @returns {number|null}  the code in a close frame's payload */
export function closeCode(payload) {
  return payload?.length >= 2 ? payload.readUInt16BE(0) : null;
}
