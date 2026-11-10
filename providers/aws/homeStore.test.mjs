import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { byteLimit, privateSessionHomeName } from '../../console/homes.mjs';
import { createHomeStore } from './homeStore.mjs';

// A stand-in for `aws s3 cp`, which keeps what it is given and hands it back.
function fakeS3() {
  const objects = new Map();
  const calls = [];
  function spawnImpl(cmd, args) {
    calls.push(args.slice(0, 4).join(' '));
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    const [, , from, to] = args;
    if (from === '-') {
      const chunks = [];
      child.stdin.on('data', (c) => chunks.push(c));
      child.stdin.on('end', () => { objects.set(to, Buffer.concat(chunks)); child.emit('close', 0); });
    } else {
      setImmediate(() => { child.stdout.end(objects.get(from)); child.emit('close', 0); });
    }
    return child;
  }
  async function aws(args) {
    calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'list-objects-v2') {
      const prefix = `s3://b/${args[args.indexOf('--prefix') + 1]}`;
      return { Contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ Key: k.slice('s3://b/'.length) })) };
    }
    const key = `s3://b/${args[args.indexOf('--key') + 1]}`;
    if (args[1] === 'copy-object') {
      objects.set(key, objects.get(`s3://${args[args.indexOf('--copy-source') + 1]}`));
      return {};
    }
    if (args[1] === 'head-object') {
      if (!objects.has(key)) throw Object.assign(new Error('failed'), { stderr: 'An error occurred (404) when calling the HeadObject operation: Not Found' });
      return { ContentLength: objects.get(key).length };
    }
    if (args[1] === 'delete-objects') {
      for (const { Key } of JSON.parse(args[args.indexOf('--delete') + 1]).Objects) objects.delete(`s3://b/${Key}`);
      return {};
    }
    objects.delete(key);
    return null;
  }
  return { objects, calls, spawnImpl, aws };
}

test('a Claude home is kept per login, handed back whole, and deleted', async () => {
  const s3 = fakeS3();
  const homes = createHomeStore({ bucket: 'b', aws: s3.aws, spawnImpl: s3.spawnImpl });
  assert.equal(await homes.get('octocat'), null, 'nothing saved yet');
  assert.equal(await homes.put('Octocat', Readable.from([Buffer.from('tar'), Buffer.from('ball')])), 7);
  assert.deepEqual([...s3.objects.keys()], ['s3://b/octocat/claude-home.tar.gz']);
  const saved = await homes.get('octocat');
  assert.equal(saved.bytes, 7);
  const chunks = [];
  for await (const c of saved.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'tarball');
  assert.equal(await homes.get('mia-dev'), null, 'one person\'s is never another\'s');
  await homes.remove('octocat');
  assert.equal(s3.objects.size, 0);
});

test('an oversized home is refused, not stored', async () => {
  const limit = byteLimit(4);
  const out = [];
  limit.on('data', (c) => out.push(c));
  const failed = new Promise((resolve) => limit.on('error', resolve));
  limit.write(Buffer.from('abc'));
  limit.write(Buffer.from('de'));
  const err = await failed;
  assert.equal(err.shown, true);
  assert.match(err.message, /is over/);
  assert.equal(Buffer.concat(out).toString(), 'abc');
});

test('a private session keeps its own home beside its owner\'s, and forgetting the owner\'s takes every session\'s with it', async () => {
  const s3 = fakeS3();
  const homes = createHomeStore({ bucket: 'b', aws: s3.aws, spawnImpl: s3.spawnImpl });
  await homes.put(privateSessionHomeName('octocat', 'aaaaaaaa'), Readable.from([Buffer.from('first')]));
  await homes.copy(privateSessionHomeName('octocat', 'aaaaaaaa'), 'octocat');
  await homes.put(privateSessionHomeName('octocat', 'bbbbbbbb'), Readable.from([Buffer.from('second')]));
  await homes.put(privateSessionHomeName('mia-dev', 'cccccccc'), Readable.from([Buffer.from('hers')]));
  assert.equal(s3.objects.get('s3://b/octocat/claude-home.tar.gz').toString(), 'first', 'the owner\'s is a copy of the session\'s');
  assert.equal(await homes.removeSessionsOf('octocat'), 2);
  await homes.remove('octocat');
  assert.deepEqual([...s3.objects.keys()], ['s3://b/mia-dev/sessions/cccccccc/claude-home.tar.gz'], 'a teammate\'s are untouched');
});

test('a person\'s session homes go in batches of the most S3 deletes at once', async () => {
  const s3 = fakeS3();
  const homes = createHomeStore({ bucket: 'b', aws: s3.aws, spawnImpl: s3.spawnImpl });
  for (let i = 0; i < 1001; i++) s3.objects.set(`s3://b/octocat/sessions/${String(i).padStart(8, '0')}/claude-home.tar.gz`, Buffer.from('x'));
  assert.equal(await homes.removeSessionsOf('octocat'), 1001);
  assert.equal(s3.objects.size, 0);
  assert.equal(s3.calls.filter((c) => c === 's3api delete-objects').length, 2);

  s3.objects.set('s3://b/octocat/sessions/aaaaaaaa/claude-home.tar.gz', Buffer.from('x'));
  const refusing = createHomeStore({ bucket: 'b', aws: async (args) => (args[1] === 'delete-objects' ? { Errors: [{ Code: 'AccessDenied' }] } : s3.aws(args)), spawnImpl: s3.spawnImpl });
  await assert.rejects(refusing.removeSessionsOf('octocat'), /did not delete 1 session homes: AccessDenied/, 'a key S3 kept is a failure, not a count');
});

