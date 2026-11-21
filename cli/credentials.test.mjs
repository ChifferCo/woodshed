import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCredentials, OWN_FOLDER, powershellArgs, windowsTools } from './credentials.mjs';
import { browserCommand } from './woodshed.mjs';
import { fakeWindows, TOOLS } from './__fixtures__/fakeWindows.mjs';

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

// A Windows config folder under the person's profile, as %LOCALAPPDATA%\\woodshed is: `home` is the profile.
function profileDir(t) {
  // Resolved: the folder written in is, and macOS's temporary folder is under a link.
  const home = fs.realpathSync(tempDir(t));
  const dir = path.join(home, 'AppData', 'Local', 'woodshed');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
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

test('on Windows the token is sealed with DPAPI by System32\'s PowerShell, given on stdin, never in its arguments', (t) => {
  const win = fakeWindows();
  const { home, dir } = profileDir(t);
  const creds = createCredentials({ platform: 'win32', run: win.run, dir, has: (c) => c === TOOLS.powershell, tools: TOOLS, home });
  const store = creds.save(ORIGIN, TOKEN);
  assert.equal(store.kind, 'dpapi');
  assert.equal(store.file, path.join(dir, 'credentials-dpapi.json'));
  assert.match(store.label, /sealed for your Windows account \(DPAPI\)/);
  assert.equal(store.read(ORIGIN), TOKEN);
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes(TOKEN), 'the file holds only what was sealed');
  const shells = win.calls.filter((c) => c.command === TOOLS.powershell);
  assert.ok(shells.length >= 2);
  for (const call of win.calls) {
    assert.ok(/^C:\\Windows\\System32\\/.test(call.command), `${call.command} is System32's, by its full path`);
    assert.ok(!call.args.join(' ').includes(TOKEN), `${call.command} was not given the token in its arguments`);
  }
  assert.equal(shells[0].input, `${ORIGIN}\n${TOKEN}\n`, 'the token goes in on stdin, after the console it is for');
  for (const call of shells) {
    assert.deepEqual(call.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
    assert.ok(!Buffer.from(call.args.at(-1), 'base64').toString('utf16le').includes('wsc_'), 'the script is fixed text, with no token in it');
  }
  assert.ok(win.owned.has(dir), 'its folder made this account\'s own, run in the folder');
  const folderCall = shells.find((c) => Buffer.from(c.args.at(-1), 'base64').toString('utf16le') === OWN_FOLDER);
  assert.equal(folderCall.cwd, dir, 'run in the folder, so its path is never on a command line');
  for (const call of shells) assert.equal(Object.keys(call.env).some((k) => k.toLowerCase() === 'psmodulepath'), false, 'no PowerShell 7 module path handed to Windows PowerShell');

  // A sealed token moved under another console's address in the file does not open for that console.
  const sealed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  fs.writeFileSync(store.file, JSON.stringify({ ...sealed, 'https://evil.example': sealed[ORIGIN] }));
  assert.equal(store.read('https://evil.example'), null, 'sealed for its own console alone');
  assert.equal(store.read(ORIGIN), TOKEN);

  store.save('https://other.example', TOKEN);
  store.remove(ORIGIN);
  assert.equal(store.read(ORIGIN), null);
  assert.equal(store.read('https://other.example'), TOKEN, 'each console keeps its own');
});

test('on Windows with DPAPI refused, as over an SSH key\'s sign-in, the token goes to a file in a folder only this account can open', (t) => {
  const win = fakeWindows({ dpapi: false });
  const { home, dir } = profileDir(t);
  const creds = createCredentials({ platform: 'win32', run: win.run, dir, has: () => true, tools: TOOLS, home });
  const store = creds.save(ORIGIN, TOKEN);
  assert.equal(store.kind, 'file');
  assert.equal(store.file, path.join(dir, 'credentials.json'));
  assert.equal(store.read(ORIGIN), TOKEN);
  assert.ok(win.owned.has(dir), 'its folder made this account\'s own first');
  assert.equal(fs.existsSync(path.join(dir, 'credentials-dpapi.json')), false);

  const other = profileDir(t);
  const none = createCredentials({ platform: 'win32', run: win.run, dir: other.dir, has: () => false, tools: TOOLS, home: other.home });
  assert.equal(none.save(ORIGIN, TOKEN).kind, 'file', 'DPAPI not offered: the file');

  // Outside the profile (XDG_CONFIG_HOME on a shared drive), a folder above could be swapped for another account's
  // between the check and the write: nothing is written there unsealed.
  const shared = tempDir(t);
  const outside = createCredentials({ platform: 'win32', run: win.run, dir: shared, has: () => true, tools: TOOLS, home: path.join(shared, 'not-above-it') });
  assert.throws(() => outside.save(ORIGIN, TOKEN), /is not .*AppData.Local.woodshed, and .* is the only place a token is kept on Windows/);
  assert.deepEqual(fs.readdirSync(shared), []);
  assert.deepEqual(fs.readdirSync(shared), [], 'not even its folder made');
  // Elsewhere under the profile (an XDG_CONFIG_HOME there): a folder on the way could be one shared with someone.
  const own = profileDir(t);
  const elsewhere = createCredentials({ platform: 'win32', run: win.run, dir: path.join(own.home, 'config', 'woodshed'), has: () => false, tools: TOOLS, home: own.home });
  assert.throws(() => elsewhere.save(ORIGIN, TOKEN), /the only place a token is kept on Windows/);
  // Spelled as the default, but a link (a junction, which needs no privilege on Windows) above it leads elsewhere.
  const profile = fs.realpathSync(tempDir(t));
  fs.mkdirSync(path.join(profile, 'AppData'));
  fs.symlinkSync(shared, path.join(profile, 'AppData', 'Local'), 'junction');
  const redirected = createCredentials({ platform: 'win32', run: win.run, dir: path.join(profile, 'AppData', 'Local', 'woodshed'), has: () => false, tools: TOOLS, home: profile });
  assert.throws(() => redirected.save(ORIGIN, TOKEN), /leads elsewhere through a link or junction, and .* is the only place a token is kept on Windows/);
  assert.deepEqual(fs.readdirSync(shared), [], 'nothing made where the junction leads, not even a folder');

  // Nor is a plain file read from anywhere but the default folder: one there could be someone else's, with their token.
  fs.mkdirSync(path.join(shared, 'woodshed'));
  fs.writeFileSync(path.join(shared, 'woodshed', 'credentials.json'), JSON.stringify({ [ORIGIN]: TOKEN }));
  assert.equal(redirected.storeFor('file').read(ORIGIN), null);
  fs.writeFileSync(path.join(shared, 'credentials.json'), JSON.stringify({ [ORIGIN]: TOKEN }));
  assert.equal(outside.storeFor('file').read(ORIGIN), null);

  // Nor a sealed one: DPAPI opens a blob sealed for the whole computer for any account, so one planted there opens.
  const sealing = fakeWindows();
  const sealed = createCredentials({ platform: 'win32', run: sealing.run, dir: shared, has: () => true, tools: TOOLS, home: path.join(shared, 'not-above-it') });
  assert.throws(() => sealed.save(ORIGIN, TOKEN), /the only place a token is kept on Windows/, 'not kept sealed there either');
  const planted = sealing.run(TOOLS.powershell, powershellArgs('[Security.Cryptography.ProtectedData]::Protect('), { input: `${ORIGIN}\n${TOKEN}\n` }).stdout;
  fs.writeFileSync(path.join(shared, 'credentials-dpapi.json'), JSON.stringify({ [ORIGIN]: planted }));
  const before = sealing.calls.length;
  assert.equal(sealed.storeFor('dpapi').read(ORIGIN), null, 'a sealed token there is not read');
  assert.equal(sealing.calls.length, before, 'nor even opened');
});

test('on Windows a folder of another account\'s that this one cannot take gets no token, sealed or not', (t) => {
  const { home, dir } = profileDir(t);
  for (const dpapi of [true, false]) {
    const win = fakeWindows({ dpapi, foreignOwner: true });
    const creds = createCredentials({ platform: 'win32', run: win.run, dir, has: () => true, tools: TOOLS, home });
    assert.throws(() => creds.save(ORIGIN, TOKEN), /could not be made a folder only you can open: it could not be made yours \(Attempted to perform an unauthorized operation\.\)/);
    assert.deepEqual(fs.readdirSync(dir), [], 'no file, sealed or plain, and no temporary one');
  }
});

test('on Windows a folder others can still open gets no token, and says who', (t) => {
  const { home, dir } = profileDir(t);
  const win = fakeWindows({ dpapi: false, others: ['S-1-5-32-545'] });
  const creds = createCredentials({ platform: 'win32', run: win.run, dir, has: () => true, tools: TOOLS, home });
  assert.throws(() => creds.save(ORIGIN, TOKEN), /could not be made a folder only you can open: others may still open it \(S-1-5-32-545\)/);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
  assert.deepEqual(fs.readdirSync(dir), [], 'not even a temporary file');

  // No Windows PowerShell to run at all: nothing can say who may open the folder, so no plain file either.
  const none = createCredentials({ platform: 'win32', run: () => ({ status: null, stdout: '', stderr: 'spawnSync powershell.exe ENOENT' }), dir, has: () => false, tools: TOOLS, home });
  assert.throws(() => none.save(ORIGIN, TOKEN), /Windows PowerShell could not set who may open it \(spawnSync powershell\.exe ENOENT\)/);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false);
});

test('Windows tools come from System32 by their full path, and the browser opens with no shell', () => {
  assert.deepEqual(windowsTools({ SystemRoot: 'D:\\WINDOWS' }), { powershell: 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  assert.equal(windowsTools({}).powershell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const url = 'https://console.example/cli?code=BCDF-GHJK&x=|calc';
  assert.deepEqual(browserCommand(url, 'win32', { SystemRoot: 'C:\\Windows' }), ['C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(powershellArgs('Write-Output 1').slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
});

test('the file is written only in a folder of yours closed to others, never through a link', (t) => {
  const base = tempDir(t);
  const open = path.join(base, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  const tightened = createCredentials({ platform: 'linux', run: fakeKeyring({ works: false }).run, dir: open, has: () => false });
  assert.equal(tightened.save(ORIGIN, TOKEN).kind, 'file');
  assert.equal(fs.statSync(open).mode & 0o777, 0o700, 'your own folder, open to others, is closed before the token goes in');
  assert.deepEqual(fs.readdirSync(open), ['credentials.json'], 'and no temporary file is left');

  const real = path.join(base, 'real');
  fs.mkdirSync(real, { mode: 0o700 });
  const linked = path.join(base, 'linked');
  fs.symlinkSync(real, linked);
  const viaLink = createCredentials({ platform: 'linux', run: fakeKeyring({ works: false }).run, dir: linked, has: () => false });
  assert.throws(() => viaLink.save(ORIGIN, TOKEN), /is not a folder only you can write to/);
  // Someone else's folder cannot be made here without root, so that refusal is the same check on `uid`, read above.
  assert.deepEqual(fs.readdirSync(real), []);
});
