import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { createAttachments } from './attachments.mjs';

function body(text) {
  return Readable.from([Buffer.from(text)]);
}

test('files sent for New session move under it in order, go out as one tar at each start, and go with drop', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-attach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const attachments = createAttachments({ dir });
  const a = await attachments.stage(body('first'), { login: 'joel', name: 'Screen Shot.png' });
  const b = await attachments.stage(body('second'), { login: 'joel', name: 'notes.md' });
  await assert.rejects(attachments.claim({ login: 'mia', ids: [a.id], sessionId: '0a1b2c3d' }), /gone/, 'only the sender\'s');
  assert.equal(await attachments.claim({ login: 'joel', ids: [b.id, a.id], sessionId: '0a1b2c3d' }), 2);

  assert.equal(await attachments.has('0a1b2c3d'), true);
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  out.writeHead = () => {};
  await attachments.send('0a1b2c3d', out);
  const tarFile = path.join(dir, 'got.tar');
  await fs.writeFile(tarFile, Buffer.concat(chunks));
  assert.deepEqual(execFileSync('tar', ['tf', tarFile], { encoding: 'utf8' }).trim().split('\n').sort(), ['1-notes.md', '2-Screen-Shot.png']);
  assert.equal(await attachments.has('0a1b2c3d'), true, 'kept for a Resume');
  await attachments.drop('0a1b2c3d');
  assert.equal(await attachments.has('0a1b2c3d'), false);
});

test('a tar that fails cuts the connection, so the session does not take a short archive as whole', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-attach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const attachments = createAttachments({ dir });
  const a = await attachments.stage(body('secret'), { login: 'joel', name: 'locked.txt' });
  await attachments.claim({ login: 'joel', ids: [a.id], sessionId: '0a1b2c3d' });
  await fs.chmod(path.join(dir, 'sessions', '0a1b2c3d', '1-locked.txt'), 0o000);
  t.after(() => fs.chmod(path.join(dir, 'sessions', '0a1b2c3d', '1-locked.txt'), 0o600).catch(() => {}));
  const out = new PassThrough();
  out.resume();
  out.writeHead = () => {};
  let ended = false;
  out.on('finish', () => { ended = true; });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await attachments.send('0a1b2c3d', out);
  } finally {
    console.warn = warn;
  }
  assert.equal(out.destroyed, true);
  assert.equal(ended, false, 'never ended as if whole');
});

test('the limits: 25 MB a file, 40 MB waiting per person, 8 a session, and upload ids only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-attach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const attachments = createAttachments({ dir });
  const mb = (n) => Readable.from([Buffer.alloc(n * 1024 * 1024)]);
  await assert.rejects(attachments.stage(mb(26), { login: 'joel', name: 'big.zip' }), /over 25 MB/);
  await attachments.stage(mb(24), { login: 'joel', name: 'a.zip' });
  await assert.rejects(attachments.stage(mb(20), { login: 'joel', name: 'b.zip' }), /over 40 MB/);
  await assert.rejects(attachments.stage(body(''), { login: 'joel', name: 'c.txt' }), /empty/);
  await assert.rejects(attachments.claim({ login: 'joel', ids: Array.from({ length: 9 }, (_, i) => `${i}`.padStart(16, '0')), sessionId: '0a1b2c3d' }), /at most 8/);
  await assert.rejects(attachments.claim({ login: 'joel', ids: ['../../x'], sessionId: '0a1b2c3d' }), /upload ids/);
  await assert.rejects(attachments.stage(body('x'), { login: '../x', name: 'a' }), /sign-in/);
});

test('files nobody started a session with are swept after a day', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-attach-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let clock = Date.now();
  const attachments = createAttachments({ dir, now: () => clock });
  await attachments.stage(body('x'), { login: 'joel', name: 'a.txt' });
  await attachments.sweep();
  assert.equal((await fs.readdir(path.join(dir, 'staged', 'joel'))).length, 2, 'kept within the day');
  clock += 25 * 3_600_000;
  await attachments.sweep();
  assert.deepEqual(await fs.readdir(path.join(dir, 'staged', 'joel')), []);
});
