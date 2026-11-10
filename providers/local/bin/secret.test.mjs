import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { runSecretCommand } from './secret.mjs';

test('put saves a value from stdin, list shows set or unset and never a value', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cli-'));
  const dir = path.join(base, 'secrets');
  const keyFile = path.join(base, 'secrets.key');
  assert.match(await runSecretCommand({ argv: ['new-key', keyFile], env: {}, stdin: Readable.from([]) }), /keep a copy apart/);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  await assert.rejects(runSecretCommand({ argv: ['new-key', keyFile], env: {}, stdin: Readable.from([]) }), /there already/);
  const env = { WOODSHED_LOCAL_SECRETS_DIR: dir, WOODSHED_LOCAL_SECRETS_KEY_FILE: keyFile, WOODSHED_CLOUD_ENV_FILES: 'api-env=api/.env', WOODSHED_CLOUD_INSTALL_SECRETS: 'registry-token=REGISTRY_TOKEN' };
  assert.equal(await runSecretCommand({ argv: ['put', 'db-root/postgres'], env, stdin: Readable.from(['pg-root-pw\n']) }), 'db-root/postgres saved (10 bytes)');
  assert.ok(!fs.readFileSync(path.join(dir, 'db-root/postgres.json'), 'utf8').includes('pg-root-pw'), 'sealed');
  await runSecretCommand({ argv: ['put', 'registry-token'], env, stdin: Readable.from(['npm_x']) });
  const listed = await runSecretCommand({ argv: ['list'], env, stdin: Readable.from([]) });
  assert.match(listed, /^set +registry-token$/m);
  assert.match(listed, /^unset api-env$/m);
  assert.ok(!listed.includes('npm_x'));
  await assert.rejects(runSecretCommand({ argv: ['put', 'x'], env, stdin: Readable.from(['']) }), /no value on stdin/);
  await assert.rejects(runSecretCommand({ argv: ['get', 'x'], env, stdin: Readable.from([]) }), /usage/);
  await assert.rejects(runSecretCommand({ argv: ['list'], env: {}, stdin: Readable.from([]) }), /WOODSHED_LOCAL_SECRETS_DIR/);
  await assert.rejects(runSecretCommand({ argv: ['list'], env: { WOODSHED_LOCAL_SECRETS_DIR: dir }, stdin: Readable.from([]) }), /WOODSHED_LOCAL_SECRETS_KEY_FILE/);
});
