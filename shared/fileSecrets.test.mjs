import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileSecretsClient, secretFile } from './fileSecrets.mjs';

test('the client reads a secret file\'s value, null for none, and refuses a name that would leave the folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-secrets-'));
  fs.mkdirSync(path.join(dir, 'users/mia'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'users/mia/database.json'), JSON.stringify({ value: 'pw', description: '', changedAt: null }));
  const client = fileSecretsClient({ dir });
  assert.equal(await client.get('users/mia/database'), 'pw');
  assert.equal(await client.get('users/joel/database'), null);
  for (const name of ['../x', 'a/../../b', '/etc/passwd', '']) assert.throws(() => secretFile(dir, name), /not a secret name/, name);
});
