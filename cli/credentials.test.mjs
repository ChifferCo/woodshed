import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCredentials } from './credentials.mjs';

const TOKEN = `wsc_${'ab'.repeat(32)}`;
const ORIGIN = 'https://console.example';

// A stand-in for `security` and `secret-tool`: a keyring in memory, and every call kept to check what it was given.
function fakeKeyring({ works = true } = {}) {
  const items = new Map();
  const calls = [];
  const run = (command, args, { input } = {}) => {
    calls.push({ command, args, input });
    if (!works) return { status: 1, stdout: '', stderr: 'no keyring' };
    if (command === 'security' && args[0] === '-i') {
      const m = /^add-generic-password -U -a (\S+) -s (\S+) -l \S+ -w (\S+)\n$/.exec(input);
      items.set(`${m[2]} ${m[1]}`, m[3]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'security') {
      const key = `${args[args.indexOf('-s') + 1]} ${args[args.indexOf('-a') + 1]}`;
      if (args[0] === 'delete-generic-password') items.delete(key);
      const value = items.get(key);
      return value ? { status: 0, stdout: `${value}\n`, stderr: '' } : { status: 44, stdout: '', stderr: 'not found' };
    }
    const key = args.slice(-4).join(' ');
    if (args[0] === 'store') items.set(key, input);
    if (args[0] === 'clear') items.delete(key);
    const value = items.get(key);
    return value ? { status: 0, stdout: value, stderr: '' } : { status: 1, stdout: '', stderr: '' };
  };
  return { run, calls, items };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-creds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('on macOS the token goes in the Keychain through stdin, never in a command\'s arguments', (t) => {
  const keyring = fakeKeyring();
  const creds = createCredentials({ platform: 'darwin', run: keyring.run, dir: tempDir(t), has: (c) => c === 'security' });
  const store = creds.save(ORIGIN, TOKEN);
  assert.equal(store.kind, 'keychain');
  assert.equal(store.read(ORIGIN), TOKEN);
  for (const call of keyring.calls) assert.ok(!call.args.join(' ').includes(TOKEN), `${call.command} ${call.args[0]} was not given the token in its arguments`);
  store.remove(ORIGIN);
  assert.equal(store.read(ORIGIN), null);
});

test('on Linux it goes to secret-tool on stdin, and with no keyring to a file only this user can read', (t) => {
  const keyring = fakeKeyring();
  const linux = createCredentials({ platform: 'linux', run: keyring.run, dir: tempDir(t), has: (c) => c === 'secret-tool' });
  const store = linux.save(ORIGIN, TOKEN);
  assert.equal(store.kind, 'libsecret');
  assert.equal(store.read(ORIGIN), TOKEN);
  assert.ok(keyring.calls.every((call) => !call.args.join(' ').includes(TOKEN)));

  // A headless box: secret-tool is installed, but there is no Secret Service to answer it.
  const dir = tempDir(t);
  const headless = createCredentials({ platform: 'linux', run: fakeKeyring({ works: false }).run, dir, has: () => true });
  const fallback = headless.save(ORIGIN, TOKEN);
  assert.equal(fallback.kind, 'file');
  assert.equal(fallback.file, path.join(dir, 'credentials.json'));
  assert.equal(fs.statSync(fallback.file).mode & 0o777, 0o600);
  assert.equal(fallback.read(ORIGIN), TOKEN);
  fallback.save('https://other.example', TOKEN);
  fallback.remove(ORIGIN);
  assert.equal(fallback.read(ORIGIN), null);
  assert.equal(fallback.read('https://other.example'), TOKEN, 'each console keeps its own');
});

test('nothing but a command line token, for a console address, reaches a store', (t) => {
  const keyring = fakeKeyring();
  const creds = createCredentials({ platform: 'darwin', run: keyring.run, dir: tempDir(t), has: () => true });
  assert.throws(() => creds.save(ORIGIN, 'wsc_short'), /not a woodshed command line token/);
  assert.throws(() => creds.save('https://x.example -w evil', TOKEN), /not a console address/);
  assert.deepEqual(keyring.calls, []);
});

test('on Windows no token is written to a file, which has no mode to keep others out', (t) => {
  const dir = tempDir(t);
  const creds = createCredentials({ platform: 'win32', run: fakeKeyring().run, dir, has: () => false });
  assert.throws(() => creds.save(ORIGIN, TOKEN), /cannot keep a token safely on Windows/);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
});
