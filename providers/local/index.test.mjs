import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withSessionSecrets } from './index.mjs';
import { writeNewKey } from './secretKey.mjs';

function keyFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-key-')), 'secrets.key');
  writeNewKey(file);
  return file;
}

test('a session gets the store\'s session secrets as it starts; one the console\'s settings set stays; no env file\'s', async () => {
  const values = { 'registry-token': 'r1', 'api-env': 'A=1' };
  const secrets = { read: async (name) => values[name] ?? null };
  const started = [];
  const launcher = { kind: 'docker', async start(id, env) { started.push([id, env]); return { ref: `woodshed-${id}` }; }, stop() {} };
  // A caller from before still passing the env files: they are a session's repo settings now, never its variables.
  const wrapped = withSessionSecrets({ launcher, secrets, envFiles: [{ secret: 'api-env' }], installSecrets: [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }] });

  assert.deepEqual(await wrapped.start('aaaa1111', { SESSION_ID: 'aaaa1111', REGISTRY_TOKEN: 'from settings' }), { ref: 'woodshed-aaaa1111' });
  assert.deepEqual(started[0][1], { WOODSHED_INSTALL_SECRETS: 'REGISTRY_TOKEN', SESSION_ID: 'aaaa1111', REGISTRY_TOKEN: 'from settings' });
  assert.equal(wrapped.kind, 'docker');

  values['registry-token'] = 'r2';
  await wrapped.start('bbbb2222', {});
  assert.equal(started[1][1].REGISTRY_TOKEN, 'r2', 'a replaced value reaches the next session');
  assert.ok(!('API_ENV' in started[1][1]));
});

test('an install secret reaches a session in the variable the installation names, which WOODSHED_INSTALL_SECRETS lists', async () => {
  const values = { 'registry-token': 'r1' };
  const secrets = { read: async (name) => values[name] ?? null };
  const started = [];
  const launcher = { kind: 'docker', async start(id, env) { started.push(env); return { ref: id }; }, stop() {} };
  const installSecrets = [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }, { secret: 'other-token', variable: 'OTHER_TOKEN' }];
  const wrapped = withSessionSecrets({ launcher, secrets, installSecrets });
  await wrapped.start('aaaa1111', { SESSION_ID: 'aaaa1111' });
  assert.deepEqual(started[0], { WOODSHED_INSTALL_SECRETS: 'OTHER_TOKEN REGISTRY_TOKEN', SESSION_ID: 'aaaa1111', REGISTRY_TOKEN: 'r1' },
    'an unset one adds no variable, and is still listed');
});

test('own databases need each database\'s settings and the secrets folder; without them there are none', async () => {
  const { loadConfig } = await import('../../console/config.mjs');
  const { localProvider } = await import('./index.mjs');
  const pg = { WOODSHED_LOCAL_DB_POSTGRES_HOST: 'postgres', WOODSHED_LOCAL_DB_POSTGRES_ROOT_USER: 'postgres' };
  const db = { ...pg, WOODSHED_LOCAL_DB_MONGO_HOST: 'mongo:27017' };
  const none = localProvider(loadConfig({ GH_TOKEN: 'x' }));
  assert.deepEqual([none.dbAdmin, none.databases, none.words.databasesPlace], [null, [], null]);
  assert.throws(() => loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_DB_POSTGRES_HOST: 'postgres' }),
    /WOODSHED_LOCAL_DB_POSTGRES_HOST needs WOODSHED_LOCAL_DB_POSTGRES_ROOT_USER too/);
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', ...db })), /needs WOODSHED_LOCAL_SECRETS_DIR/);
  const secrets = { WOODSHED_REPO: 'o/app', WOODSHED_LOCAL_SECRETS_DIR: '/tmp/never-written', WOODSHED_LOCAL_SECRETS_KEY_FILE: keyFile() };
  const provider = localProvider(loadConfig({ GH_TOKEN: 'x', ...db, ...secrets }));
  assert.deepEqual([typeof provider.dbAdmin.start, provider.databases, provider.words.databasesPlace], ['function', ['postgres', 'mongo'], 'Postgres and Mongo']);
  const pgOnly = localProvider(loadConfig({ GH_TOKEN: 'x', ...pg, ...secrets }));
  assert.deepEqual([typeof pgOnly.dbAdmin.start, pgOnly.databases, pgOnly.words.databasesPlace], ['function', ['postgres'], 'Postgres']);
  // Each engine on its own: Mongo without Postgres.
  const mongoOnly = localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_DB_MONGO_HOST: 'mongo:27017', ...secrets }));
  assert.deepEqual([mongoOnly.databases, mongoOnly.words.databasesPlace], [['mongo'], 'Mongo']);
});

test('webhooks need the secrets folder; the Settings page\'s URL is the public one, at /github', async () => {
  const { loadConfig } = await import('../../console/config.mjs');
  const { localProvider } = await import('./index.mjs');
  const hooks = { WOODSHED_LOCAL_WEBHOOK_PORT: '7697', WOODSHED_LOCAL_WEBHOOK_URL: 'https://woodshed.example.com/hooks/' };
  assert.equal(localProvider(loadConfig({ GH_TOKEN: 'x' })).webhooks, null);
  assert.throws(() => loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_WEBHOOK_PORT: 'many' }), /not a port/);
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', ...hooks })), /needs WOODSHED_LOCAL_SECRETS_DIR/);
  const provider = localProvider(loadConfig({ GH_TOKEN: 'x', ...hooks, WOODSHED_LOCAL_SECRETS_DIR: '/tmp/never-written', WOODSHED_LOCAL_SECRETS_KEY_FILE: keyFile() }));
  assert.equal(typeof provider.webhooks.run, 'function');
  assert.equal(await provider.webhookUrl(), 'https://woodshed.example.com/hooks/github');
});

test('a secrets folder needs its key, from a file only its owner reads and kept outside the folder', async () => {
  const { loadConfig } = await import('../../console/config.mjs');
  const { localProvider } = await import('./index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-secrets-'));
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_SECRETS_DIR: dir })), /needs WOODSHED_LOCAL_SECRETS_KEY_FILE/);
  const loose = keyFile();
  fs.chmodSync(loose, 0o644);
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_SECRETS_DIR: dir, WOODSHED_LOCAL_SECRETS_KEY_FILE: loose })), /can be read by others/);
  const inside = path.join(dir, 'secrets.key');
  writeNewKey(inside);
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_SECRETS_DIR: dir, WOODSHED_LOCAL_SECRETS_KEY_FILE: inside })), /inside the secrets folder/);
  assert.throws(() => localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_SECRETS_DIR: dir, WOODSHED_LOCAL_SECRETS_KEY_FILE: path.join(os.tmpdir(), 'no-such.key') })), /no secrets key at/);
  const provider = localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_LOCAL_SECRETS_DIR: dir, WOODSHED_LOCAL_SECRETS_KEY_FILE: keyFile() }));
  assert.equal(typeof provider.secrets.read, 'function');
});
