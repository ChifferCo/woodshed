import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FRAME, MAX_LINE, createUnframer, decodeLine, encodeLine, exitFrame, frame } from './execFrames.mjs';

test('frames come back whole and in order, however the stream is cut', () => {
  const stream = Buffer.concat([frame(FRAME.stdout, Buffer.from('out')), frame(FRAME.stderr, Buffer.from('err')), frame(FRAME.stdout, Buffer.alloc(0)), exitFrame(-7)]);
  for (const size of [1, 2, 5, 7, stream.length]) {
    const got = [];
    const read = createUnframer((kind, data) => got.push([kind, Buffer.isBuffer(data) ? data.toString() : data]));
    for (let at = 0; at < stream.length; at += size) read(stream.subarray(at, at + size));
    assert.deepEqual(got, [[FRAME.stdout, 'out'], [FRAME.stderr, 'err'], [FRAME.stdout, ''], [FRAME.exit, -7]], `cut every ${size} bytes`);
  }
});

test('a stream that is not frames is refused, not read as some', () => {
  assert.throws(() => createUnframer(() => {})(Buffer.from('HTTP/1.1 200 OK\r\n')), /not an exec pipe frame/);
  const huge = Buffer.alloc(5);
  huge.writeUInt8(FRAME.stdout, 0);
  huge.writeUInt32BE(2 ** 31, 1);
  assert.throws(() => createUnframer(() => {})(huge), /not an exec pipe frame/, 'no frame larger than MAX_FRAME is waited for');
  assert.throws(() => createUnframer(() => {})(frame(FRAME.exit, Buffer.from('12345'))), /not an exec pipe frame/, 'an exit code is 4 bytes');
});

test('the line goes in its header as base64, and nothing else is taken for one', () => {
  const line = 'printf "%s\\n" "é ✓"; exec herdr-core connect';
  assert.equal(decodeLine(encodeLine(line)), line);
  assert.equal(decodeLine(''), null);
  assert.equal(decodeLine(undefined), null);
  assert.equal(decodeLine(encodeLine('   ')), null, 'a blank line runs nothing');
  assert.equal(decodeLine(encodeLine('a\0b')), null, 'no NUL');
  assert.equal(decodeLine('not base64!'), null);
  assert.equal(decodeLine(encodeLine('x'.repeat(MAX_LINE))), 'x'.repeat(MAX_LINE));
  assert.equal(decodeLine(encodeLine('x'.repeat(MAX_LINE + 1))), null, 'too long');
});
