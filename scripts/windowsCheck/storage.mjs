// TEMPORARY, not for merge: runs the command line's Windows token storage (cli/credentials.mjs) for real, on Windows.
// Prints PASS/FAIL per check and exits 1 on any failure. Never prints a token: the tokens here are made up for the check.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentials, runCommand, windowsTools } from '../../cli/credentials.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const token = () => `wsc_${crypto.randomBytes(32).toString('hex')}`;
const tools = windowsTools();
// What Windows says of a folder or file, by SID, read through .NET (not the code under test's script): its owner,
// whether it takes rights from above, and each rule. Run without PowerShell 7's module path.
const { PSModulePath, ...cleanEnv } = process.env;
function aclOf(target) {
  const script = [
    "$p = $env:CHECK_TARGET",
    "$acl = if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }",
    "$t = [System.Security.Principal.SecurityIdentifier]",
    "'me=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "'owner=' + $acl.GetOwner($t).Value",
    "'protected=' + $acl.AreAccessRulesProtected",
    "foreach ($r in $acl.GetAccessRules($true, $true, $t)) { 'rule=' + $r.IdentityReference.Value + '|' + $r.AccessControlType + '|inherited=' + $r.IsInherited }",
  ].join('\n');
  const out = spawnSync(tools.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...cleanEnv, CHECK_TARGET: target }, encoding: 'utf8' });
  const lines = (out.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const value = (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  return { me: value('me'), owner: value('owner'), protected: value('protected') === 'True', rules: lines.filter((l) => l.startsWith('rule=')).map((l) => l.slice(5)), error: out.status === 0 ? null : (out.stderr ?? '').trim().split(/\r?\n/)[0] };
}
const WINDOWS_OWN = ['S-1-5-18', 'S-1-5-32-544'];
const mine = (acl) => acl.owner === acl.me && acl.protected && acl.rules.length > 0
  && acl.rules.every((r) => { const [sid, type] = r.split('|'); return type !== 'Allow' || sid === acl.me || WINDOWS_OWN.includes(sid); });
const describe = (acl) => `owner ${acl.owner === acl.me ? 'me' : acl.owner}; protected ${acl.protected}; ${acl.rules.map((r) => r.replace(acl.me, 'me')).join('; ')}${acl.error ? `; ${acl.error}` : ''}`;
const me = runCommand('whoami', []).stdout.trim();

console.log(`account: ${me}; node ${process.version}; USERPROFILE=${process.env.USERPROFILE}; LOCALAPPDATA=${process.env.LOCALAPPDATA}; homedir=${os.homedir()}`);

// Every command the store runs, to check none is given the token.
const ran = [];
const run = (command, args, opts) => {
  ran.push({ command, args });
  return runCommand(command, args, opts);
};
const noTokenInArgs = (t) => ran.every((r) => !r.args.join(' ').includes(t));

const dir = path.join(process.env.LOCALAPPDATA, 'woodshed');
const ORIGIN = 'https://check.example';

// 1a. DPAPI, in the default folder.
{
  const t = token();
  const creds = createCredentials({ dir, run });
  let store = null;
  try {
    store = creds.save(ORIGIN, t);
  } catch (err) {
    check('dpapi: save', false, err.message);
  }
  if (store) {
    check('dpapi: save picks the sealed store', store.kind === 'dpapi', store.kind);
    check('dpapi: read back', store.read(ORIGIN) === t);
    const text = fs.readFileSync(store.file, 'utf8');
    check('dpapi: file holds no token', !text.includes('wsc_'));
    const sealed = JSON.parse(text);
    fs.writeFileSync(store.file, JSON.stringify({ ...sealed, 'https://other.example': sealed[ORIGIN] }));
    check('dpapi: a sealed token moved to another origin does not open', store.read('https://other.example') === null);
    check('dpapi: and still opens for its own', store.read(ORIGIN) === t);
    check('dpapi: no command was given the token in its arguments', noTokenInArgs(t));
    check('dpapi: every tool ran from System32 by full path', ran.every((r) => /^[A-Z]:\\Windows\\System32\\/i.test(r.command)), [...new Set(ran.map((r) => r.command))].join(', '));
    const folder = aclOf(dir);
    check('folder: this account owns it, nothing inherited, only this account, SYSTEM and Administrators allowed', mine(folder), describe(folder));
    const file = aclOf(store.file);
    check('dpapi file: only this account, SYSTEM and Administrators allowed', file.rules.length > 0 && file.rules.every((r) => { const [sid, type] = r.split('|'); return type !== 'Allow' || sid === file.me || WINDOWS_OWN.includes(sid); }), describe(file));
    store.remove(ORIGIN);
    store.remove('https://other.example');
    check('dpapi: remove', store.read(ORIGIN) === null);
  }
}

// 1b. The plain file, as when DPAPI cannot seal (no PowerShell offered), in the default folder.
{
  const t = token();
  const creds = createCredentials({ dir, run, has: () => false });
  let store = null;
  try {
    store = creds.save(ORIGIN, t);
  } catch (err) {
    check('plain: save in the default folder', false, err.message);
  }
  if (store) {
    check('plain: save picks the file', store.kind === 'file', store.kind);
    check('plain: read back', store.read(ORIGIN) === t);
    const file = aclOf(store.file);
    check('plain file: only this account, SYSTEM and Administrators allowed', file.rules.length > 0 && file.rules.every((r) => { const [sid, type] = r.split('|'); return type !== 'Allow' || sid === file.me || WINDOWS_OWN.includes(sid); }), describe(file));
    check('plain: no command was given the token in its arguments', noTokenInArgs(t));
    store.remove(ORIGIN);
    check('plain: remove', store.read(ORIGIN) === null);
  }
}

// 1c. Outside the default folder: no plain file, but a sealed one.
{
  const shared = path.join(process.env.CHECK_SHARED_DIR || path.join(os.tmpdir(), 'wincheck-shared'), `woodshed-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  const t = token();
  try {
    createCredentials({ dir: shared, run, has: () => false }).save(ORIGIN, t);
    check('outside: plain file refused', false, 'it was kept');
  } catch (err) {
    check('outside: plain file refused', /the only place a token is kept on Windows/.test(err.message), err.message);
  }
  check('outside: nothing made there', !fs.existsSync(shared));
  try {
    createCredentials({ dir: shared, run }).save(ORIGIN, t);
    check('outside: a sealed token is not kept there either', false, 'it was kept');
  } catch (err) {
    check('outside: a sealed token is not kept there either', /the only place a token is kept on Windows/.test(err.message), err.message);
  }
  // A blob sealed for the whole computer, which DPAPI opens for any account, planted there: not read.
  fs.mkdirSync(shared, { recursive: true });
  const machine = spawnSync(tools.powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $e = [Text.Encoding]::UTF8.GetBytes('woodshed-cli ' + $env:CHECK_ORIGIN); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:CHECK_TOKEN), $e, 'LocalMachine'))"],
    { env: { ...cleanEnv, CHECK_ORIGIN: ORIGIN, CHECK_TOKEN: t }, encoding: 'utf8' });
  fs.writeFileSync(path.join(shared, 'credentials-dpapi.json'), JSON.stringify({ [ORIGIN]: machine.stdout.trim() }));
  check('outside: a machine-sealed blob planted there is not read', createCredentials({ dir: shared, run }).storeFor('dpapi').read(ORIGIN) === null, `planted ${machine.stdout.trim().length} chars`);
  // The same blob in the default folder would open, which is why only that folder is read.
  const inDefault = createCredentials({ dir, run }).storeFor('dpapi');
  fs.writeFileSync(path.join(dir, 'credentials-dpapi.json'), JSON.stringify({ [ORIGIN]: machine.stdout.trim() }));
  console.log(`INFO a machine-sealed blob in the default folder opens: ${inDefault.read(ORIGIN) === t}`);
  fs.writeFileSync(path.join(dir, 'credentials-dpapi.json'), '{}');
  fs.rmSync(shared, { recursive: true, force: true });
}

// 1d. Spelled as the default, but a junction above it leads elsewhere.
{
  const base = path.join(os.tmpdir(), `wincheck-home-${crypto.randomBytes(4).toString('hex')}`);
  const target = path.join(os.tmpdir(), `wincheck-target-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(base, 'AppData'), { recursive: true });
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(base, 'AppData', 'Local'), 'junction');
  try {
    createCredentials({ dir: path.join(base, 'AppData', 'Local', 'woodshed'), run, has: () => false, home: base }).save(ORIGIN, token());
    check('junction: plain file refused', false, 'it was kept');
  } catch (err) {
    check('junction: plain file refused', /the only place a token is kept on Windows/.test(err.message), err.message);
  }
  check('junction: nothing made where it leads', fs.readdirSync(target).length === 0);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
