import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crypto from 'node:crypto';

import { secretSpecs } from '../../console/secrets.mjs';
import { createSecretStore } from './secretStore.mjs';

const KEY = crypto.randomBytes(32);
const SECRETS = secretSpecs({ envFiles: [{ secret: 'api-env' }, { secret: 'web-env' }], installSecrets: [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }] });

function tmpDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-')), 'secrets');
}

test('the Secrets page lists every secret, unset until written, then set with when it changed', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS, now: () => Date.parse('2026-11-06T10:00:00Z') });
  const before = await store.list();
  assert.deepEqual(before.map((s) => s.name), SECRETS.map((s) => s.name));
  assert.ok(before.every((s) => !s.exists && !s.set && s.changedAt === null));

  await store.write('api-env', 'A=1\n');
  const entry = (await store.list()).find((s) => s.name === 'api-env');
  assert.deepEqual([entry.exists, entry.set, entry.changedAt, entry.group], [true, true, '2026-11-06T10:00:00.000Z', 'session']);
  assert.equal(await store.read('api-env'), 'A=1\n');
  assert.equal(await store.read('registry-token'), null);
});

test('a value is readable by the console\'s user alone, in a folder only it can open', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  await store.save('users/joel/claude-token', 'sk-ant-1', 'Joel’s');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'users/joel/claude-token.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'users/joel')), ['claude-token.json'], 'no temporary file is left');
});

test('save keeps the first description, replaces the value, and remove forgets it, twice without an error', async () => {
  const store = createSecretStore({ dir: tmpDir(), key: KEY, specs: SECRETS });
  await store.save('users/joel/claude-token', 'sk-ant-1', 'Joel’s');
  await store.save('users/joel/claude-token', 'sk-ant-2', 'something else');
  assert.equal(await store.read('users/joel/claude-token'), 'sk-ant-2');
  await store.remove('users/joel/claude-token');
  await store.remove('users/joel/claude-token');
  assert.equal(await store.read('users/joel/claude-token'), null);
});

test('a name that could leave the folder is refused', async () => {
  const store = createSecretStore({ dir: tmpDir(), key: KEY, specs: SECRETS });
  for (const name of ['../escape', 'users/../../x', '/etc/passwd', 'a//b', '.hidden', '']) {
    await assert.rejects(store.read(name), /not a secret name/, name);
  }
});

test('a file holds no value in the clear, and opens only with its key and under its own name', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  await store.save('users/joel/claude-token', 'sk-ant-secret-1', 'Joel’s');
  const file = path.join(dir, 'users/joel/claude-token.json');
  const bytes = fs.readFileSync(file, 'utf8');
  assert.ok(!bytes.includes('sk-ant-secret-1') && !bytes.includes('Joel'), 'neither the value nor its description is readable');
  assert.equal(JSON.parse(bytes).v, 1);

  await assert.rejects(createSecretStore({ dir, key: crypto.randomBytes(32), specs: SECRETS }).read('users/joel/claude-token'), /does not open/);
  fs.mkdirSync(path.join(dir, 'users/mia'), { recursive: true });
  fs.copyFileSync(file, path.join(dir, 'users/mia/claude-token.json'));
  await assert.rejects(store.read('users/mia/claude-token'), /does not open/, 'a file moved to another secret\'s name');
  const tampered = JSON.parse(bytes);
  tampered.data = Buffer.from('x'.repeat(20)).toString('base64');
  fs.writeFileSync(file, JSON.stringify(tampered));
  await assert.rejects(store.read('users/joel/claude-token'), /does not open/, 'a changed file');
  assert.throws(() => createSecretStore({ dir }), /needs its 32-byte key/);
});

test('a plain file from before the key is sealed: on its first read, and every one at start', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'users/mia'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry-token.json'), JSON.stringify({ value: 'npm_plain', description: '', changedAt: null }));
  fs.writeFileSync(path.join(dir, 'users/mia/database.json'), JSON.stringify({ value: 'db-plain', description: '', changedAt: null }));
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  assert.equal(await store.read('registry-token'), 'npm_plain');
  assert.ok(!fs.readFileSync(path.join(dir, 'registry-token.json'), 'utf8').includes('npm_plain'), 'sealed in its place');
  assert.equal(await store.sealPlainFiles(), 1, 'the one nothing read yet');
  assert.ok(!fs.readFileSync(path.join(dir, 'users/mia/database.json'), 'utf8').includes('db-plain'));
  assert.equal(await store.read('users/mia/database'), 'db-plain');
  assert.equal(await store.sealPlainFiles(), 0);
});

test('a secret that does not open is listed as not set with why, and replacing it puts it right', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  await store.write('registry-token', 'npm_1');
  await createSecretStore({ dir, key: crypto.randomBytes(32), specs: SECRETS }).write('api-env', 'A=1');
  const listed = await store.list();
  const broken = listed.find((s) => s.name === 'api-env');
  assert.deepEqual([broken.exists, broken.set], [true, false]);
  assert.match(broken.error, /does not open/);
  assert.equal(listed.find((s) => s.name === 'registry-token').set, true, 'the others still list');
  await assert.rejects(store.read('api-env'), /does not open/, 'a read that needs the value still says so');
  await store.write('api-env', 'A=2');
  assert.equal(await store.read('api-env'), 'A=2');
  await store.save('api-env', 'A=3', 'again');
  assert.equal(await store.read('api-env'), 'A=3');
});

test('a damaged IV or tag does not open either, rather than throwing something else', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  await store.write('registry-token', 'npm_1');
  const file = path.join(dir, 'registry-token.json');
  const sealed = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const damage of [{ iv: '' }, { tag: 'AA==' }, { iv: null }]) {
    fs.writeFileSync(file, JSON.stringify({ ...sealed, ...damage }));
    await assert.rejects(store.read('registry-token'), /does not open/, JSON.stringify(damage));
  }
});

test('two writes of one secret at once both land, and the sealing pass skips a file it cannot read', async () => {
  const dir = tmpDir();
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  await Promise.all([store.write('registry-token', 'npm_a'), store.write('registry-token', 'npm_b'), store.save('registry-token', 'npm_c', 'x')]);
  assert.ok(['npm_a', 'npm_b', 'npm_c'].includes(await store.read('registry-token')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.writeFileSync(path.join(dir, 'bad name.json'), JSON.stringify({ value: 'x' }));
  fs.writeFileSync(path.join(dir, 'web-env.json'), JSON.stringify({ value: 'plain', description: '', changedAt: null }));
  assert.equal(await store.sealPlainFiles(), 1, 'the readable plain file is sealed despite the other');
  assert.ok(!fs.readFileSync(path.join(dir, 'web-env.json'), 'utf8').includes('plain'));
});

test('a value saved while the sealing pass seals that secret\'s plain file is the one kept', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry-token.json'), JSON.stringify({ value: 'old-plain', description: '', changedAt: null }));
  const store = createSecretStore({ dir, key: KEY, specs: SECRETS });
  // Started together, as a console start and a Replace on the Secrets page can be.
  await Promise.all([store.sealPlainFiles(), store.write('registry-token', 'new-value'), store.read('registry-token')]);
  assert.equal(await store.read('registry-token'), 'new-value');
  await Promise.all([store.write('registry-token', 'a'), store.remove('registry-token')]);
  assert.equal(await store.read('registry-token'), null, 'a removal after a write, in that order, leaves nothing');
});
