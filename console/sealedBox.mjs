// libsodium's sealed box (crypto_box_seal), which GitHub takes an Actions secret in: the value is encrypted to the
// repo's public key with a key pair made for this one value, whose secret half is dropped at once, so nothing the
// console keeps can open it again. GitHub documents only libsodium, and Woodshed has no dependencies, so the pieces
// node:crypto lacks are here: HSalsa20 and XSalsa20, Poly1305, and BLAKE2b with a 24-byte output. X25519 is node's.
//
//   sealed = ephemeral public key (32) || Poly1305 tag (16) || XSalsa20 ciphertext
//   nonce  = BLAKE2b-24(ephemeral public key || recipient public key)
//   key    = HSalsa20(X25519(ephemeral secret, recipient public), 0)
//
// sealedBox.test.mjs checks it against vectors made with tweetnacl and Python's hashlib.blake2b.

import crypto from 'node:crypto';

const KEY_BYTES = 32;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function words(bytes, offset, count) {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = bytes.readUInt32LE(offset + 4 * i);
  return out;
}

// Salsa20's 20 rounds over its 16-word state, in place.
function rounds(x) {
  for (let i = 0; i < 20; i += 2) {
    x[4] ^= rotl((x[0] + x[12]) >>> 0, 7); x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl((x[8] + x[4]) >>> 0, 13); x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotl((x[5] + x[1]) >>> 0, 7); x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl((x[13] + x[9]) >>> 0, 13); x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotl((x[10] + x[6]) >>> 0, 7); x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl((x[2] + x[14]) >>> 0, 13); x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotl((x[15] + x[11]) >>> 0, 7); x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl((x[7] + x[3]) >>> 0, 13); x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotl((x[0] + x[3]) >>> 0, 7); x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl((x[2] + x[1]) >>> 0, 13); x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotl((x[5] + x[4]) >>> 0, 7); x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl((x[7] + x[6]) >>> 0, 13); x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotl((x[10] + x[9]) >>> 0, 7); x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl((x[8] + x[11]) >>> 0, 13); x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotl((x[15] + x[14]) >>> 0, 7); x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl((x[13] + x[12]) >>> 0, 13); x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
  }
}

// The state for a 32-byte key and 16 bytes of input (a nonce and counter, or HSalsa20's input).
function state(key, input) {
  const k = words(key, 0, 8);
  const n = words(input, 0, 4);
  return new Uint32Array([SIGMA[0], k[0], k[1], k[2], k[3], SIGMA[1], n[0], n[1], n[2], n[3], SIGMA[2], k[4], k[5], k[6], k[7], SIGMA[3]]);
}

/** @returns {Buffer}  HSalsa20 of a 32-byte key and 16-byte input: a 32-byte key */
export function hsalsa20(key, input) {
  const x = state(key, input);
  rounds(x);
  const out = Buffer.alloc(32);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((w, i) => out.writeUInt32LE(x[w], 4 * i));
  return out;
}

// Salsa20's keystream for a 32-byte key and 8-byte nonce, from block 0.
function salsa20Stream(key, nonce8, length) {
  const out = Buffer.alloc(length);
  const input = Buffer.alloc(16);
  nonce8.copy(input, 0);
  for (let block = 0, at = 0; at < length; block += 1, at += 64) {
    input.writeUInt32LE(block >>> 0, 8);
    input.writeUInt32LE(Math.floor(block / 2 ** 32), 12);
    const start = state(key, input);
    const x = Uint32Array.from(start);
    rounds(x);
    const bytes = Buffer.alloc(64);
    for (let i = 0; i < 16; i += 1) bytes.writeUInt32LE((x[i] + start[i]) >>> 0, 4 * i);
    bytes.copy(out, at, 0, Math.min(64, length - at));
  }
  return out;
}

/** @returns {Buffer}  XSalsa20's keystream for a 32-byte key and 24-byte nonce */
export function xsalsa20Stream(key, nonce, length) {
  return salsa20Stream(hsalsa20(key, nonce.subarray(0, 16)), nonce.subarray(16, 24), length);
}

function leBig(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** @returns {Buffer}  the 16-byte Poly1305 tag of `message` under a 32-byte one-time key */
export function poly1305(message, key) {
  const p = (1n << 130n) - 5n;
  const r = leBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key.subarray(16, 32));
  let acc = 0n;
  for (let at = 0; at < message.length; at += 16) {
    const block = message.subarray(at, at + 16);
    acc = ((acc + leBig(block) + (1n << BigInt(8 * block.length))) * r) % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return out;
}

const MASK64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64(x, n) {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

/** @returns {Buffer}  BLAKE2b of `message`, unkeyed, `outLength` bytes long (1 to 64) */
export function blake2b(message, outLength) {
  const h = BLAKE2B_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLength);
  const blocks = Math.max(1, Math.ceil(message.length / 128));
  for (let b = 0; b < blocks; b += 1) {
    const chunk = Buffer.alloc(128);
    message.copy(chunk, 0, b * 128, Math.min(message.length, (b + 1) * 128));
    const m = Array.from({ length: 16 }, (_, i) => chunk.readBigUInt64LE(8 * i));
    const last = b === blocks - 1;
    const v = [...h, ...BLAKE2B_IV];
    v[12] ^= BigInt(last ? message.length : (b + 1) * 128);
    if (last) v[14] ^= MASK64;
    const g = (a, bb, c, d, x, y) => {
      v[a] = (v[a] + v[bb] + x) & MASK64; v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK64; v[bb] = rotr64(v[bb] ^ v[c], 24n);
      v[a] = (v[a] + v[bb] + y) & MASK64; v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK64; v[bb] = rotr64(v[bb] ^ v[c], 63n);
    };
    for (let round = 0; round < 12; round += 1) {
      const s = BLAKE2B_SIGMA[round % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i += 1) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((word, i) => out.writeBigUInt64LE(word, 8 * i));
  return out.subarray(0, outLength);
}

function x25519Shared(secretKey, publicKey) {
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secretKey]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, publicKey]), format: 'der', type: 'spki' }),
  });
}

/** @returns {Buffer}  the public half of a 32-byte X25519 secret key */
export function x25519PublicKey(secretKey) {
  const der = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secretKey]), format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - KEY_BYTES);
}

function boxKey(secretKey, publicKey) {
  return hsalsa20(x25519Shared(secretKey, publicKey), Buffer.alloc(16));
}

/**
 * @param {Buffer|string} message
 * @param {Buffer} publicKey  the recipient's 32-byte X25519 public key
 * @param {{ephemeralSecretKey?: Buffer}} [opts]  only for tests: a fixed ephemeral key, so the output is known
 * @returns {Buffer}  the sealed box
 */
export function sealedBox(message, publicKey, { ephemeralSecretKey = null } = {}) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== KEY_BYTES) throw new Error('the public key must be 32 bytes');
  const plain = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  const esk = ephemeralSecretKey ?? crypto.randomBytes(KEY_BYTES);
  const epk = x25519PublicKey(esk);
  const nonce = blake2b(Buffer.concat([epk, publicKey]), 24);
  const stream = xsalsa20Stream(boxKey(esk, publicKey), nonce, 32 + plain.length);
  const cipher = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) cipher[i] = plain[i] ^ stream[32 + i];
  esk.fill(0);
  return Buffer.concat([epk, poly1305(cipher, stream.subarray(0, 32)), cipher]);
}

/**
 * Opens a sealed box: only tests need it, to show what GitHub would read.
 * @returns {Buffer|null}  the message, or null when the tag does not match
 */
export function openSealedBox(sealed, publicKey, secretKey) {
  if (sealed.length < KEY_BYTES + 16) return null;
  const epk = sealed.subarray(0, KEY_BYTES);
  const tag = sealed.subarray(KEY_BYTES, KEY_BYTES + 16);
  const cipher = sealed.subarray(KEY_BYTES + 16);
  const nonce = blake2b(Buffer.concat([epk, publicKey]), 24);
  const stream = xsalsa20Stream(boxKey(secretKey, epk), nonce, 32 + cipher.length);
  if (!crypto.timingSafeEqual(tag, poly1305(cipher, stream.subarray(0, 32)))) return null;
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i += 1) plain[i] = cipher[i] ^ stream[32 + i];
  return plain;
}
