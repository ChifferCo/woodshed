import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createRecordingStore } from './recordingStore.mjs';

// A stand-in for the aws CLI's S3 calls: `s3 cp` in and out, `s3 presign`, and the s3api calls the store makes.
function fakeS3() {
  const objects = new Map();
  const calls = [];
  function spawnImpl(cmd, args) {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (args[1] === 'presign') {
      setImmediate(() => { child.stdout.end(`https://b.s3.amazonaws.com/${args[2].slice('s3://b/'.length)}?X-Amz-Expires=${args[4]}\n`); child.emit('close', 0); });
    } else if (args[2] === '-') {
      const chunks = [];
      const type = args[args.indexOf('--content-type') + 1];
      child.stdin.on('data', (c) => chunks.push(c));
      child.stdin.on('end', () => { objects.set(args[3].slice('s3://b/'.length), { body: Buffer.concat(chunks), type, at: '2026-11-01T00:00:00.000Z' }); child.emit('close', 0); });
    } else {
      setImmediate(() => { child.stdout.end(objects.get(args[2].slice('s3://b/'.length)).body); child.emit('close', 0); });
    }
    return child;
  }
  async function aws(args) {
    calls.push(args);
    if (args[1] === 'list-objects-v2') {
      const prefix = args[args.indexOf('--prefix') + 1];
      return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([Key, o]) => ({ Key, LastModified: o.at })) };
    }
    if (args[1] === 'head-object') {
      const found = objects.get(args[args.indexOf('--key') + 1]);
      if (!found) throw Object.assign(new Error('failed'), { stderr: 'An error occurred (404) when calling the HeadObject operation: Not Found' });
      return { ContentLength: found.body.length };
    }
    if (args[1] === 'delete-objects') {
      for (const { Key } of JSON.parse(args[args.indexOf('--delete') + 1]).Objects) objects.delete(Key);
      return {};
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  }
  return { objects, calls, spawnImpl, aws };
}

test('recordings go beside the homes under _qa/, with their type, and a browser gets a five-minute link to a video', async () => {
  const s3 = fakeS3();
  const store = createRecordingStore({ bucket: 'b', aws: s3.aws, spawnImpl: s3.spawnImpl });
  await store.put('ab12cd34/video-1.webm', Buffer.from('webm'), 'video/webm');
  assert.deepEqual([...s3.objects.keys()], ['_qa/ab12cd34/video-1.webm']);
  assert.equal(s3.objects.get('_qa/ab12cd34/video-1.webm').type, 'video/webm', 'S3 answers the link with it, so the browser plays it');

  assert.equal(await store.link('ab12cd34/video-1.webm'), 'https://b.s3.amazonaws.com/_qa/ab12cd34/video-1.webm?X-Amz-Expires=300');
  assert.equal(await store.link('ab12cd34/video-2.webm'), null, 'gone: no link to a missing object');

  await store.put('ab12cd34/poster-x.png', Buffer.from('png'), 'image/png');
  const poster = await store.get('ab12cd34/poster-x.png');
  assert.equal(poster.bytes, 3);
  const chunks = [];
  for await (const c of poster.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'png');
  assert.equal(await store.get('ab12cd34/poster-y.png'), null);
});

test('the list is the recordings alone, by their own keys, and removing them deletes them from S3', async () => {
  const s3 = fakeS3();
  const store = createRecordingStore({ bucket: 'b', aws: s3.aws, spawnImpl: s3.spawnImpl });
  s3.objects.set('joel/claude-home.tar.gz', { body: Buffer.from('home'), at: '2026-01-01T00:00:00.000Z' });
  await store.put('ab12cd34/video-1.webm', Buffer.from('webm'), 'video/webm');
  assert.deepEqual(await store.list(), [{ key: 'ab12cd34/video-1.webm', modifiedAt: '2026-11-01T00:00:00.000Z' }], 'never a Claude home');
  await store.remove(['ab12cd34/video-1.webm']);
  assert.deepEqual([...s3.objects.keys()], ['joel/claude-home.tar.gz']);
});
