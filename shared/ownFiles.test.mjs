import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { secretFile } from './fileSecrets.mjs';
import {
  DEFAULT_MAX_VALUE_BYTES, GZIP_MARKER, MAX_OWN_FILE_BYTES, ownFileKey, ownFilePathProblem, packOwnFile, sizeWords, storeValueLimit, unpackOwnFile,
} from './ownFiles.mjs';

test('an own file is a plain path inside the repo, outside .git', () => {
  for (const ok of ['app/.env.production', '.env', 'tools/mcp/config.json', 'a/b-c_d@e+f.txt']) assert.equal(ownFilePathProblem(ok), null, ok);
  for (const bad of ['', '  ', '/etc/passwd', '~/.ssh/config', '../up', 'a/../b', './a', 'a//b', 'a/', '.git/hooks/pre-commit', '.git', 'a b', 'a\nb', 'a;b', 42, null, 'x'.repeat(201)]) {
    assert.ok(ownFilePathProblem(bad), JSON.stringify(bad));
  }
});

test('each path has a key of its own that every store\'s names take', () => {
  assert.equal(ownFileKey('app/.env.production'), 'app_s.env.production');
  assert.equal(ownFileKey('.env'), '_denv');
  assert.equal(ownFileKey('tools/config.toml'), 'tools_sconfig.toml');
  const paths = ['a/b', 'a_b', 'a_sb', 'a-b', 'a+b', 'a@b', '_db', '.db', 'a.b', 'notes/design.md', 'notes/design-md', 'x'.repeat(200), `${'x'.repeat(199)}y`];
  const keys = paths.map(ownFileKey);
  assert.equal(new Set(keys).size, paths.length, 'no two paths share a key');
  for (const key of keys) {
    assert.ok(key.length <= 122, key);
    assert.doesNotMatch(key, /[/-]/, 'no folder, and no `-` Secrets Manager could read as an ARN\'s suffix');
    assert.doesNotThrow(() => secretFile('/tmp/store', `users/octocat/own-files/${key}`), 'the local store\'s names take it');
    assert.ok(Buffer.byteLength(`${key}.json`) < 255, 'a file name a disk takes');
  }
});

test('a file is gzipped behind the marker only when that is smaller, and a value without it is the text', () => {
  const doc = `# Design notes\n\n${'The session writes each file where git ignores it.\n'.repeat(4000)}`;
  const packed = packOwnFile(doc);
  assert.ok(packed.startsWith(GZIP_MARKER));
  assert.ok(Buffer.byteLength(packed) < Buffer.byteLength(doc) / 10);
  assert.equal(unpackOwnFile(packed), doc, 'it round-trips');

  const noise = crypto.randomBytes(30_000).toString('base64');
  assert.equal(packOwnFile(noise), noise, 'text gzip does not shrink stays as it is');
  assert.equal(packOwnFile('A=1\n'), 'A=1\n', 'and so does a short file');
  assert.equal(unpackOwnFile('EXAMPLE_TOKEN=a\n'), 'EXAMPLE_TOKEN=a\n', 'a value from before packing is read as plain text');

  const looksPacked = `${GZIP_MARKER}not really`;
  assert.ok(packOwnFile(looksPacked).startsWith(GZIP_MARKER) && packOwnFile(looksPacked) !== looksPacked, 'text that starts with the marker is always packed');
  assert.equal(unpackOwnFile(packOwnFile(looksPacked)), looksPacked);

  const bomb = GZIP_MARKER + zlib.gzipSync(Buffer.alloc(MAX_OWN_FILE_BYTES + 1, 'a')).toString('base64');
  assert.throws(() => unpackOwnFile(bomb), 'a value that unpacks past the cap is refused');
});

test('a store\'s limit on one value is its own, and 64 KB when it does not say', () => {
  assert.equal(storeValueLimit({ maxValueBytes: 65_536 }), 65_536);
  assert.equal(storeValueLimit({ maxValueBytes: 1_048_576 }), 1_048_576);
  assert.equal(storeValueLimit({}), DEFAULT_MAX_VALUE_BYTES);
  assert.equal(storeValueLimit({ maxValueBytes: 'lots' }), 65_536);
  assert.equal(storeValueLimit(null), 65_536);
  assert.deepEqual([sizeWords(65_536), sizeWords(102_400), sizeWords(1_048_576), sizeWords(1_572_864)], ['64 KB', '100 KB', '1 MB', '1.5 MB']);
});
