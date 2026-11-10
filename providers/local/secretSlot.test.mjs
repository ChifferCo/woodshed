import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { secretSpecs } from '../../console/secrets.mjs';
import { createSecretSlot } from './secretSlot.mjs';

const specs = secretSpecs({ envFiles: [{ secret: 'api-env', path: 'api/.env' }], installSecrets: [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }] });

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'secret-slot-'));
}

test('until a store is chosen a read finds nothing and a write says to choose one', async () => {
  const slot = createSecretSlot({ stateDir: stateDir(), specs });
  assert.equal(slot.configured(), false);
  assert.equal(await slot.read('api-env'), null);
  await assert.rejects(slot.save('users/a/claude-token', 'x', 'd'), (err) => err.shown && /choose one/.test(err.message));
});

test('the local store is sealed, and the choice and its secrets come back after a restart', async () => {
  const dir = stateDir();
  const slot = createSecretSlot({ stateDir: dir, specs });
  assert.equal((await slot.configure({ kind: 'local' })).kind, 'local');
  await slot.save('users/a/claude-token', 'sk-ant-oat01-secret', 'a token');
  const raw = fs.readFileSync(path.join(dir, 'secrets', 'users', 'a', 'claude-token.json'), 'utf8');
  assert.ok(!raw.includes('sk-ant-oat01-secret'), 'the file holds no plain value');

  const again = createSecretSlot({ stateDir: dir, specs });
  assert.equal(again.configured(), true);
  assert.equal(await again.read('users/a/claude-token'), 'sk-ant-oat01-secret');
});

test('AWS is tried before it is kept, and a first write creates the secret', async () => {
  const dir = stateDir();
  const calls = [];
  const failing = async () => { throw Object.assign(new Error('x'), { stderr: 'Unable to locate credentials' }); };
  const slot = createSecretSlot({ stateDir: dir, specs, aws: failing });
  await assert.rejects(slot.configure({ kind: 'aws' }), (err) => err.shown && /could not be reached: Unable to locate credentials/.test(err.message));
  assert.equal(slot.configured(), false);
  assert.equal(fs.existsSync(path.join(dir, 'secrets-manager.json')), false);

  const aws = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[1] === 'list-secrets') return { SecretList: [] };
    if (args[1] === 'put-secret-value') throw Object.assign(new Error('x'), { stderr: 'ResourceNotFoundException' });
    return null;
  };
  const ok = createSecretSlot({ stateDir: dir, specs, aws });
  assert.equal((await ok.configure({ kind: 'aws', prefix: 'mine/' })).prefix, 'mine/');
  await ok.write('api-env', 'A=1');
  assert.deepEqual(calls, ['secretsmanager list-secrets', 'secretsmanager put-secret-value', 'secretsmanager create-secret']);
  await assert.rejects(ok.configure({ kind: 'aws', prefix: 'bad prefix!' }), /prefix may hold/);
  await assert.rejects(ok.configure({ kind: 'ftp' }), /choose local or aws/);
});
