import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OP, acceptFor, closeCode, createFrameReader, encodeFrame, isKey, newKey } from './wsFrames.mjs';

function readAll(chunks) {
  const got = [];
  const read = createFrameReader((m) => got.push({ opcode: m.opcode, text: m.payload.toString() }));
  for (const chunk of chunks) read(chunk);
  return got;
}

test('the accept value is RFC 6455\'s, and a key is 16 bytes of base64', () => {
  assert.equal(acceptFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.ok(isKey(newKey()));
  assert.equal(isKey('short=='), false);
  assert.equal(isKey(undefined), false);
});

test('frames of each length size read back whole, masked or not, a byte at a time too', () => {
  for (const size of [0, 1, 125, 126, 65535, 65536, 200_000]) {
    const text = 'x'.repeat(size);
    for (const mask of [true, false]) {
      const frame = encodeFrame(OP.binary, text, { mask });
      assert.equal((frame[1] & 0x80) !== 0, mask);
      assert.deepEqual(readAll([frame]), [{ opcode: OP.binary, text }], `${size} ${mask}`);
    }
  }
  const frame = encodeFrame(OP.text, 'hello');
  assert.deepEqual(readAll([...frame].map((b) => Buffer.from([b]))), [{ opcode: OP.text, text: 'hello' }]);
});

test('a fragmented message is joined, with a ping between its fragments handed on first', () => {
  const first = encodeFrame(OP.text, 'hel', { mask: false });
  first[0] &= 0x7f;
  const ping = encodeFrame(OP.ping, 'p', { mask: false });
  const last = encodeFrame(OP.continuation, 'lo', { mask: false });
  assert.deepEqual(readAll([Buffer.concat([first, ping, last])]), [{ opcode: OP.ping, text: 'p' }, { opcode: OP.text, text: 'hello' }]);
});

test('a close frame says its code, and frames no terminal sends are refused', () => {
  assert.equal(closeCode(Buffer.from([0x03, 0xe8])), 1000);
  assert.equal(closeCode(Buffer.alloc(0)), null);
  const rsv = encodeFrame(OP.text, 'x');
  rsv[0] |= 0x40;
  assert.throws(() => readAll([rsv]), /RSV/);
  assert.throws(() => createFrameReader(() => {}, { maxMessage: 10 })(encodeFrame(OP.binary, 'x'.repeat(11))), /larger/);
  assert.throws(() => readAll([encodeFrame(OP.continuation, 'x')]), /continuation/);
});
