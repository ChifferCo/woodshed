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

test('a session gets the store\'s session secrets as it starts; one the console\'s settings set stays', async () => {
  const values = { 'api-env': 'A=1', 'web-env': 'B=2' };
  const secrets = { read: async (name) => values[name] ?? null };
  const started = [];
  const launcher = { kind: 'docker', async start(id, env) { started.push([id, env]); return { ref: `woodshed-${id}` }; }, stop() {} };
  const wrapped = withSessionSecrets({ launcher, secrets, envFiles: [{ secret: 'api-env' }, { secret: 'web-env' }] });

  assert.deepEqual(await wrapped.start('aaaa1111', { SESSION_ID: 'aaaa1111', WEB_ENV: 'from settings' }), { ref: 'woodshed-aaaa1111' });
  assert.deepEqual(started[0][1], { SESSION_ID: 'aaaa1111', WEB_ENV: 'from settings', API_ENV: 'A=1' }, 'no install secrets, no WOODSHED_INSTALL_SECRETS');
  assert.equal(wrapped.kind, 'docker');

  values['api-env'] = 'A=2';
  await wrapped.start('bbbb2222', {});
  assert.equal(started[1][1].API_ENV, 'A=2', 'a replaced value reaches the next session');
});

test('an install secret reaches a session in the variable the installation names, which WOODSHED_INSTALL_SECRETS lists', async () => {
  const values = { 'registry-token': 'r1' };
  const secrets = { read: async (name) => values[name] ?? null };
  const started = [];
  const launcher = { kind: 'docker', async start(id, env) { started.push(env); return { ref: id }; }, stop() {} };
  const installSecrets = [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }, { secret: 'other-token', variable: 'OTHER_TOKEN' }];
  const wrapped = withSessionSecrets({ launcher, secrets, envFiles: [], installSecrets });
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

test('sessions use this machine\'s Docker by default only on one person\'s console; a console others sign in to needs WOODSHED_SESSION_DOCKER=1', async (t) => {
  const { loadConfig } = await import('../../console/config.mjs');
  const { localProvider } = await import('./index.mjs');
  const logs = [];
  t.mock.method(console, 'log', (...line) => logs.push(line));
  const hostDocker = (env) => loadConfig({ GH_TOKEN: 'x', ...env }).launcher.hostDocker;
  assert.equal(hostDocker({}), true, 'one person\'s laptop');
  assert.equal(hostDocker({ WOODSHED_HOST: 'localhost' }), true);
  assert.equal(hostDocker({ WOODSHED_SESSION_DOCKER: '1' }), true);
  assert.equal(hostDocker({ WOODSHED_SESSION_DOCKER: '0' }), false);
  assert.equal(hostDocker({ WOODSHED_SESSION_DOCKER: ' 0 ' }), false);
  // Root on the machine for whoever starts a session: on a console others use, never by default, nor after an Update.
  const shared = { WOODSHED_HOST: '0.0.0.0', WOODSHED_REQUIRE_SIGN_IN: '1' };
  assert.equal(hostDocker(shared), false, 'a server others sign in to');
  assert.equal(hostDocker({ WOODSHED_REQUIRE_SIGN_IN: '1' }), false, 'sign-in on loopback, as behind Tailscale shared');
  assert.equal(hostDocker({ WOODSHED_HOST: '0.0.0.0' }), false, 'a host past loopback');
  assert.equal(hostDocker({ ...shared, WOODSHED_SESSION_DOCKER: '1' }), true, 'said in its own settings');
  assert.throws(() => hostDocker({ WOODSHED_SESSION_DOCKER: 'yes' }), /WOODSHED_SESSION_DOCKER is 1 .* or 0/);

  const line = () => logs.filter(([m]) => m === 'local: sessions use this machine\'s Docker').at(-1);
  localProvider(loadConfig({ GH_TOKEN: 'x' }));
  assert.deepEqual(line(), ['local: sessions use this machine\'s Docker', { on: true, off: 'WOODSHED_SESSION_DOCKER=0' }]);
  localProvider(loadConfig({ GH_TOKEN: 'x', WOODSHED_SESSION_DOCKER: '0' }));
  assert.deepEqual(line(), ['local: sessions use this machine\'s Docker', { on: false, onWith: 'WOODSHED_SESSION_DOCKER=1' }]);
});

test('on AWS sessions never get a Docker socket, and WOODSHED_SESSION_DOCKER=1 there is said once, not refused', async (t) => {
  const { loadConfig } = await import('../../console/config.mjs');
  const warnings = [];
  t.mock.method(console, 'warn', (...line) => warnings.push(line));
  const ecs = { GH_TOKEN: 'x', WOODSHED_LAUNCHER: 'ecs' };
  assert.equal(loadConfig(ecs).launcher.hostDocker, false);
  assert.equal(warnings.length, 0, 'nothing to say when it is not asked for');
  assert.equal(loadConfig({ ...ecs, WOODSHED_SESSION_DOCKER: '1' }).launcher.hostDocker, false);
  assert.equal(loadConfig({ ...ecs, WOODSHED_SESSION_DOCKER: '1' }).launcher.hostDocker, false);
  assert.deepEqual(warnings, [['config: WOODSHED_SESSION_DOCKER=1 does nothing on AWS: a Fargate task cannot be given a Docker socket']]);
});
