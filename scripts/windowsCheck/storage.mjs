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
// What Windows says of a folder or file: owner, whether inheritance is off, and each rule, from Get-Acl (not icacls,
// which the code under test reads).
function aclOf(target) {
  process.env.CHECK_TARGET = target;
  const out = runCommand(tools.powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$a = Get-Acl -LiteralPath $env:CHECK_TARGET; "owner=" + $a.Owner; "protected=" + $a.AreAccessRulesProtected; $a.Access | ForEach-Object { "rule=" + $_.IdentityReference.Value + "|" + $_.AccessControlType + "|" + $_.FileSystemRights + "|inherited=" + $_.IsInherited }']);
  const lines = out.stdout.split(/\r?\n/).filter(Boolean);
  return {
    owner: lines.find((l) => l.startsWith('owner='))?.slice(6) ?? null,
    protected: lines.find((l) => l.startsWith('protected='))?.slice(10) === 'True',
    rules: lines.filter((l) => l.startsWith('rule=')).map((l) => l.slice(5)),
    raw: out.status === 0 ? null : out.stderr.trim().split(/\r?\n/)[0],
  };
}
const me = /^"([^"]+)"/.exec(runCommand(tools.whoami, ['/user', '/fo', 'csv', '/nh']).stdout.trim())?.[1] ?? '?';
const onlyMe = (acl) => acl.rules.length > 0 && acl.rules.every((r) => r.toLowerCase().startsWith(`${me.toLowerCase()}|allow`));

console.log(`account: ${me}; node ${process.version}; USERPROFILE=${process.env.USERPROFILE}; LOCALAPPDATA=${process.env.LOCALAPPDATA}; homedir=${os.homedir()}`);

// Diagnostics: what icacls and PowerShell answer, raw, on a fresh folder like the CLI's.
{
  const diag = path.join(process.env.LOCALAPPDATA, `wincheck-diag-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(diag);
  const show = (label, out) => console.log(`DIAG ${label}: status ${out.status}\n${(out.stdout + out.stderr).trim().split(/\r?\n/).map((l) => `    ${l}`).join('\n')}`);
  const whoRaw = runCommand(tools.whoami, ['/user', '/fo', 'csv', '/nh']);
  show('whoami /user', whoRaw);
  const sid = /"(S-1-[0-9-]+)"/.exec(whoRaw.stdout)?.[1];
  show('icacls . (fresh)', runCommand(tools.icacls, ['.'], { cwd: diag }));
  show('icacls . /inheritance:r /grant:r', runCommand(tools.icacls, ['.', '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { cwd: diag }));
  show('icacls . (after)', runCommand(tools.icacls, ['.'], { cwd: diag }));
  show('icacls . /setowner', runCommand(tools.icacls, ['.', '/setowner', `*${sid}`], { cwd: diag }));
  show('icacls . (after owner)', runCommand(tools.icacls, ['.'], { cwd: diag }));
  const acl = aclOf(diag);
  console.log(`DIAG Get-Acl: owner ${acl.owner}; protected ${acl.protected}; ${acl.rules.join('; ')}`);
  const seal = (env) => {
    const out = spawnSync(tools.powershell, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Security; [Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3), $null, 'CurrentUser').Length"], { env, encoding: 'utf8' });
    return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? String(out.error ?? '') };
  };
  console.log(`DIAG PSModulePath=${process.env.PSModulePath}`);
  show('seal, PSModulePath as inherited', seal(process.env));
  const { PSModulePath, ...without } = process.env;
  show('seal, without PSModulePath', seal(without));
  fs.rmSync(diag, { recursive: true, force: true });
}

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
    check('folder: owner is this account', folder.owner?.toLowerCase() === me.toLowerCase(), `${folder.owner} vs ${me}`);
    check('folder: inheritance is off', folder.protected);
    check('folder: only this account has rules', onlyMe(folder), folder.rules.join('; ') || folder.raw);
    const file = aclOf(store.file);
    check('dpapi file: only this account has rules', onlyMe(file), file.rules.join('; ') || file.raw);
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
    check('plain file: only this account has rules', onlyMe(file), file.rules.join('; ') || file.raw);
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
    check('outside: plain file refused', /the only place a token is kept unsealed on Windows/.test(err.message), err.message);
  }
  check('outside: nothing made there', !fs.existsSync(shared));
  const sealed = createCredentials({ dir: shared, run }).save(ORIGIN, t);
  check('outside: a sealed token may be kept there', sealed.kind === 'dpapi' && sealed.read(ORIGIN) === t, sealed.kind);
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
    check('junction: plain file refused', /the only place a token is kept unsealed on Windows/.test(err.message), err.message);
  }
  check('junction: nothing made where it leads', fs.readdirSync(target).length === 0);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
