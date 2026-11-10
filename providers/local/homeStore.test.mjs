import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { MAX_HOME_BYTES, privateSessionHomeName, sharedHomeName } from '../../console/homes.mjs';
import { createHomeStore } from './homeStore.mjs';

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-homes-')), 'homes');
}

test('a home saved is the home restored, at the S3 store\'s names, in a folder only the console can open', async () => {
  const dir = tmpDir();
  const homes = createHomeStore({ dir });
  assert.equal(await homes.get('Joel'), null);
  assert.equal(await homes.put('Joel', Readable.from([Buffer.from('tar-bytes')])), 9);
  const got = await homes.get('joel');
  assert.equal(got.bytes, 9);
  assert.equal(await text(got.stream), 'tar-bytes');
  assert.ok(fs.existsSync(path.join(dir, 'joel/claude-home.tar.gz')));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'joel/claude-home.tar.gz')).mode & 0o777, 0o600);
});

test('a save over the limit fails and keeps the last good home', async () => {
  const homes = createHomeStore({ dir: tmpDir() });
  await homes.put('joel', Readable.from([Buffer.from('good')]));
  const big = Readable.from((function* () { for (let i = 0; i <= MAX_HOME_BYTES / 65_536; i++) yield Buffer.alloc(65_536); })());
  await assert.rejects(homes.put('joel', big));
  assert.equal(await text((await homes.get('joel')).stream), 'good');
});

test('a private session\'s home is copied, listed with no shared ones, and removed with all of its owner\'s', async () => {
  const dir = tmpDir();
  const homes = createHomeStore({ dir });
  await homes.put('joel', Readable.from(['mine']));
  await homes.copy('joel', privateSessionHomeName('joel', '0a1b2c3d'));
  await homes.copy('joel', privateSessionHomeName('joel', '1b2c3d4e'));
  assert.equal(await text((await homes.get(privateSessionHomeName('joel', '0a1b2c3d'))).stream), 'mine');
  assert.equal(await homes.removeSessionsOf('joel'), 2);
  assert.equal(await homes.removeSessionsOf('joel'), 0, 'a second time finds none');
  assert.ok(await homes.get('joel'), 'their own home stays');
  await homes.remove('joel');
  await homes.remove('joel');
  assert.equal(await homes.get('joel'), null);
});

test('shared sessions\' homes are listed by id, with size and when they were saved', async () => {
  const homes = createHomeStore({ dir: tmpDir() });
  assert.deepEqual(await homes.listShared(), []);
  await homes.put(sharedHomeName('0a1b2c3d'), Readable.from(['abc']));
  const [entry] = await homes.listShared();
  assert.deepEqual([entry.id, entry.bytes, typeof entry.savedAt], ['0a1b2c3d', 3, 'string']);
});

test('the settings file beside a home is written, read and removed, and a name that leaves the folder is refused', async () => {
  const homes = createHomeStore({ dir: tmpDir() });
  assert.equal(await homes.getText('joel/claude-settings.json'), null);
  await homes.putText('joel/claude-settings.json', '{"a":1}');
  assert.equal(await homes.getText('joel/claude-settings.json'), '{"a":1}');
  await homes.removeKey('joel/claude-settings.json');
  assert.equal(await homes.getText('joel/claude-settings.json'), null);
  for (const key of ['../x', 'joel/../../x', '/etc/passwd', 'a//b']) await assert.rejects(homes.getText(key), /not a home name/, key);
});
