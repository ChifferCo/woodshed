import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRecordingStore } from '../providers/local/recordingStore.mjs';
import { QA_POSTER_RE, QA_PUBLIC_VIDEO_RE, QA_RECORDING_DAYS, QA_VIDEO_RE, createQaRecordings, isPng, newRecordingSecret, opensPublicVideo, qaPublicVideoPath, qaVideoPath } from './qaRecordings.mjs';

const ID = 'ab12cd34';
const DAY = 86_400_000;

async function serving(t, recordings) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const video = QA_VIDEO_RE.exec(url.pathname);
    if (video) return recordings.serveVideo(req, res, { id: video[1], n: Number(video[2]) });
    const poster = QA_POSTER_RE.exec(url.pathname);
    if (poster) return recordings.servePoster(req, res, { id: poster[1], secret: poster[2] });
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return async (pathname, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { headers, redirect: 'manual' });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  };
}

function local(t, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-recordings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, recordings: createQaRecordings({ store: createRecordingStore({ dir }), now }) };
}

test('a video is kept under its session and served with ranges, so a browser plays it and seeks in it', async (t) => {
  const { dir, recordings } = local(t);
  const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  assert.deepEqual(await recordings.saveVideo(ID, 1, video), { key: `${ID}/video-1.webm` });
  assert.equal(fs.statSync(path.join(dir, ID, 'video-1.webm')).mode & 0o777, 0o600, 'the console\'s user alone reads it');
  const get = await serving(t, recordings);

  const whole = await get(qaVideoPath(ID, 1));
  assert.deepEqual([whole.status, whole.headers.get('content-type'), whole.headers.get('accept-ranges')], [200, 'video/webm', 'bytes']);
  assert.ok(whole.body.equals(video));
  const part = await get(qaVideoPath(ID, 1), { range: 'bytes=100-199' });
  assert.deepEqual([part.status, part.headers.get('content-range')], [206, 'bytes 100-199/1000']);
  assert.ok(part.body.equals(video.subarray(100, 200)));
  const tail = await get(qaVideoPath(ID, 1), { range: 'bytes=-10' });
  assert.ok(tail.body.equals(video.subarray(990)));
  assert.equal((await get(qaVideoPath(ID, 1), { range: 'bytes=5000-' })).status, 416);
  const missing = await get(qaVideoPath(ID, 2));
  assert.equal(missing.status, 410);
  assert.match(missing.body.toString(), /deleted 14 days after their run/);
});

test('the still is served at its unguessable name alone', async (t) => {
  const { recordings } = local(t);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 3)]);
  assert.ok(isPng(png));
  const { path: posterPath } = await recordings.savePoster(ID, png);
  const [, id, secret] = QA_POSTER_RE.exec(posterPath);
  assert.equal(id, ID);
  assert.equal(secret.length, 32);
  const get = await serving(t, recordings);
  const found = await get(posterPath);
  assert.deepEqual([found.status, found.headers.get('content-type')], [200, 'image/png']);
  assert.ok(found.body.equals(png));
  assert.equal((await get(`/qa-poster/${ID}/${'0'.repeat(32)}.png`)).status, 410, 'another secret finds nothing');
  assert.notEqual((await recordings.savePoster(ID, png)).path, posterPath, 'each still gets a name of its own');
});

test(`recordings are deleted ${QA_RECORDING_DAYS} days after they were kept, and nothing sooner`, async (t) => {
  let clock = Date.now();
  const { dir, recordings } = local(t, () => clock);
  await recordings.saveVideo(ID, 1, Buffer.from('old'));
  await recordings.savePoster(ID, Buffer.from('old poster'));
  await recordings.saveVideo('cd34ef56', 1, Buffer.from('new'));
  // The first run's files, written 15 days before the clock.
  const past = new Date(clock - 15 * DAY);
  for (const name of fs.readdirSync(path.join(dir, ID))) fs.utimesSync(path.join(dir, ID, name), past, past);

  assert.equal(await recordings.sweep(), 2);
  assert.equal(fs.existsSync(path.join(dir, ID)), false, 'the run\'s folder goes with its files');
  assert.ok(fs.existsSync(path.join(dir, 'cd34ef56', 'video-1.webm')));
  clock += (QA_RECORDING_DAYS - 1) * DAY;
  assert.equal(await recordings.sweep(), 0, 'thirteen days on, still kept');
  clock += 2 * DAY;
  assert.equal(await recordings.sweep(), 1);
});

test('a key that is not a recording\'s never reaches the folder', async (t) => {
  const { recordings } = local(t);
  await assert.rejects(recordings.saveVideo('../../etc', 1, Buffer.from('x')), /not a session id/);
  const store = createRecordingStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'qa-recordings-')) });
  await assert.rejects(store.put('ab12cd34/../../x.webm', Buffer.from('x')), /not a recording name/);
});

test('a public video\'s name opens only its own run\'s videos, by the secret the run keeps', () => {
  const share = newRecordingSecret();
  assert.match(share, /^[0-9a-f]{32}$/);
  assert.notEqual(newRecordingSecret(), share);
  const session = { qa: { share, videos: [{ n: 1, bytes: 1 }, { n: 2, bytes: 1 }] } };
  assert.equal(opensPublicVideo(session, { secret: share, n: 2 }), true);
  assert.equal(opensPublicVideo(session, { secret: share, n: 3 }), false, 'a video it never sent');
  assert.equal(opensPublicVideo(session, { secret: newRecordingSecret(), n: 1 }), false, 'another secret');
  assert.equal(opensPublicVideo(session, { secret: share.slice(0, 31), n: 1 }), false, 'a secret cut short');
  assert.equal(opensPublicVideo({ qa: { videos: [{ n: 1 }] } }, { secret: share, n: 1 }), false, 'a signed-in run has no public name');
  assert.equal(opensPublicVideo(null, { secret: share, n: 1 }), false);
  const path = qaPublicVideoPath('0a1b2c3d', share, 1);
  assert.equal(path, `/qa-video/0a1b2c3d/${share}/1.webm`);
  assert.deepEqual(QA_PUBLIC_VIDEO_RE.exec(path).slice(1), ['0a1b2c3d', share, '1']);
});

test('a video whose file fails to read once found ends its response, and the console keeps serving', async (t) => {
  // The file went between the store's look and the read, as a sweep or a disk's error can make it.
  const gone = path.join(os.tmpdir(), `qa-recordings-missing-${process.pid}`, 'video-1.webm');
  const recordings = createQaRecordings({ store: { put() {}, get() {}, list() {}, remove() {}, file: async () => ({ path: gone, bytes: 10 }) } });
  const get = await serving(t, recordings);
  const failed = await get(qaVideoPath(ID, 1)).then(() => 'answered', (err) => `ended: ${err.cause?.code ?? err.message}`);
  assert.match(failed, /ended/);
  assert.equal((await get('/nothing')).status, 404, 'the server still answers');
});
