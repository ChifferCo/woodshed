import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { returnLogin } from './devChatSession.mjs';

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function logins(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = path.join(dir, 'host.json');
  const lent = path.join(dir, 'lent.json');
  fs.writeFileSync(host, '{"login":"start"}');
  fs.copyFileSync(host, lent);
  return { host, lent, startedAs: hash(host) };
}

test('the dev codex\'s refreshed login goes back to the machine, whose own is still the one it lent', (t) => {
  const files = logins(t);
  fs.writeFileSync(files.lent, '{"login":"refreshed by the dev codex"}');
  assert.equal(returnLogin(files), 'copied back');
  assert.equal(fs.readFileSync(files.host, 'utf8'), '{"login":"refreshed by the dev codex"}');
});

test('a login made on the machine after the dev session started is kept, not overwritten by the lent copy', (t) => {
  const files = logins(t);
  fs.writeFileSync(files.host, '{"login":"codex login on the machine, since"}');
  fs.writeFileSync(files.lent, '{"login":"refreshed by the dev codex"}');
  assert.equal(returnLogin(files), 'kept the newer one on the machine');
  assert.equal(fs.readFileSync(files.host, 'utf8'), '{"login":"codex login on the machine, since"}');
});

test('a lent login that never changed is not copied back over anything', (t) => {
  const files = logins(t);
  fs.writeFileSync(files.host, '{"login":"newer on the machine"}');
  assert.equal(returnLogin(files), 'unchanged');
  assert.equal(fs.readFileSync(files.host, 'utf8'), '{"login":"newer on the machine"}');
});
