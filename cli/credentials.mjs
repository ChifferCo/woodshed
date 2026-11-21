// Where the command line keeps its console token, one per console: the macOS Keychain, else the Secret Service on Linux
// (libsecret's secret-tool, which needs a desktop session's keyring), else a file only this user can read, whose path
// the command line prints. The token never goes in a command's arguments, where another user's `ps` would see it: the
// Keychain gets it through `security -i` on stdin, and secret-tool reads it from stdin.
//
// On Windows, a file sealed with DPAPI for this Windows account (Windows PowerShell 5.1, which ships with Windows, does
// the sealing, with the token on its stdin), else a plain file, either only in <profile>\AppData\Local\woodshed. Its folder is
// made this account's own and closed to every other account but Windows' own (SYSTEM and Administrators, as root on
// macOS and Linux), and that is checked by SID once it is set. PowerShell is run from System32 by its full path, never
// found on the PATH or in the current folder, and never through a shell.
//
// Each store is keyed by the console's origin (https://console.example), so signing in to a second console keeps the
// first's token. cli.json (config.mjs) says which store holds each console's, so a read never guesses.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SERVICE = 'woodshed-cli';
const TOKEN_RE = /^wsc_[0-9a-f]{64}$/;
// What may follow `-a` in a `security -i` line: an origin has no spaces or quotes, and anything else is refused.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

// DPAPI's seal and unseal, for this Windows account: the console's origin and then what is sealed or opened are read
// from stdin, one a line, and what comes out is written to stdout, so none is ever in the command line. The scripts are
// fixed text, sent base64'd as -EncodedCommand asks. The entropy is the service and the origin: another program's
// casual Unprotect of the same account does not open it, and a token sealed for one console does not open for another,
// whatever the file says it is for.
// Only .NET's own types, no cmdlet of a module: a PowerShell 7 terminal hands its module path down, from which Windows
// PowerShell cannot load its modules. Loaded by name, as Add-Type would, without Add-Type's module.
const DPAPI_PRELUDE = `$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$lines = [Console]::In.ReadToEnd().Split([char]10)
$origin = $lines[0].Trim()
$given = $lines[1].Trim()
$entropy = [Text.Encoding]::UTF8.GetBytes('${SERVICE} ' + $origin)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser`;
const DPAPI_SEAL = `${DPAPI_PRELUDE}
$sealed = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($given), $entropy, $scope)
[Console]::Out.Write([Convert]::ToBase64String($sealed))`;
const DPAPI_UNSEAL = `${DPAPI_PRELUDE}
$opened = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($given), $entropy, $scope)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($opened))`;
const SEALED_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** @returns {{powershell: string}}  System32's own, by full path */
export function windowsTools(env = process.env) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  return { powershell: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
}

// Run in the folder (its path is never decoded or quoted): makes this account its owner, takes nothing from the folder
// above, and gives full control to this account and to Windows' own SYSTEM and Administrators alone, then reads it back
// and checks each, by SID. Names and the console's code page never come into it: Jürgen's name prints as J?rgen there.
// SYSTEM and Administrators are on every new folder of a profile as entries of its own, not inherited, and may open
// anything on the computer whatever its ACL says, as root on macOS and Linux may. Prints `ok`, or `refused: <why>`.
export const OWN_FOLDER = `$ErrorActionPreference = 'Stop'
$dir = [Environment]::CurrentDirectory
$sidType = [System.Security.Principal.SecurityIdentifier]
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$windows = @('S-1-5-18', 'S-1-5-32-544')
try {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($me))
  $acl.SetAccessRuleProtection($true, $false)
  $flags = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($me) + $windows) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), [System.Security.AccessControl.FileSystemRights]::FullControl, $flags, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  [System.IO.Directory]::SetAccessControl($dir, $acl)
} catch {
  'refused: it could not be made yours (' + $_.Exception.Message.Split([char]10)[0].Trim() + ')'
  exit 3
}
$now = [System.IO.Directory]::GetAccessControl($dir)
$owner = $now.GetOwner($sidType).Value
if ($owner -ne $me) { 'refused: it belongs to ' + $owner + ', not to you'; exit 4 }
if (-not $now.AreAccessRulesProtected) { 'refused: it still takes rights from the folder above'; exit 4 }
$others = @()
foreach ($rule in $now.GetAccessRules($true, $true, $sidType)) {
  $sid = $rule.IdentityReference.Value
  if ($rule.AccessControlType -eq 'Allow' -and $sid -ne $me -and $windows -notcontains $sid) { $others += $sid }
}
if ($others.Count) { 'refused: others may still open it (' + ($others -join ', ') + ')'; exit 4 }
'ok'`;

// Windows PowerShell's environment: this process's, without PSModulePath, which a PowerShell 7 terminal sets to its own
// modules, which Windows PowerShell cannot load (it builds its own when the variable is not set).
function powershellEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
}

/** @returns {string[]}  the arguments that run a fixed script in Windows PowerShell, no profile, nothing asked */
export function powershellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** @returns {{status: number|null, stdout: string, stderr: string}} */
export function runCommand(command, args, { input, cwd, env } = {}) {
  const out = spawnSync(command, args, { input, cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true });
  if (out.error) return { status: null, stdout: '', stderr: out.error.message };
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

function checkArgs(origin, token) {
  if (!ORIGIN_RE.test(origin)) throw new Error(`not a console address: ${origin}`);
  if (token !== undefined && !TOKEN_RE.test(token)) throw new Error('not a woodshed command line token');
}

function keychain(run) {
  return {
    kind: 'keychain',
    label: 'the macOS Keychain',
    save(origin, token) {
      checkArgs(origin, token);
      // -U replaces an item of the same account and service.
      run('security', ['-i'], { input: `add-generic-password -U -a ${origin} -s ${SERVICE} -l ${SERVICE} -w ${token}\n` });
      return this.read(origin) === token;
    },
    read(origin) {
      checkArgs(origin);
      const out = run('security', ['find-generic-password', '-a', origin, '-s', SERVICE, '-w']);
      const token = out.status === 0 ? out.stdout.trim() : '';
      return TOKEN_RE.test(token) ? token : null;
    },
    remove(origin) {
      checkArgs(origin);
      run('security', ['delete-generic-password', '-a', origin, '-s', SERVICE]);
    },
  };
}

function libsecret(run) {
  const attrs = (origin) => ['service', SERVICE, 'console', origin];
  return {
    kind: 'libsecret',
    label: 'the Secret Service keyring (libsecret)',
    save(origin, token) {
      checkArgs(origin, token);
      const out = run('secret-tool', ['store', `--label=Woodshed command line (${origin})`, ...attrs(origin)], { input: token });
      return out.status === 0 && this.read(origin) === token;
    },
    read(origin) {
      checkArgs(origin);
      const out = run('secret-tool', ['lookup', ...attrs(origin)]);
      const token = out.status === 0 ? out.stdout.trim() : '';
      return TOKEN_RE.test(token) ? token : null;
    },
    remove(origin) {
      checkArgs(origin);
      run('secret-tool', ['clear', ...attrs(origin)]);
    },
  };
}

function readJson(where) {
  try {
    const parsed = JSON.parse(fs.readFileSync(where, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Makes `dir` this Windows account's own and closed to every other account but Windows' own (OWN_FOLDER), as 0700 is on
 * macOS and Linux. A folder this account cannot take, or that someone else may still open, is refused.
 * @returns {string|null}  why it could not be, or null once it is
 */
export function windowsOwnFolder(dir, run, tools) {
  const out = run(tools.powershell, powershellArgs(OWN_FOLDER), { cwd: dir, env: powershellEnv() });
  const lines = `${out.stdout}`.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (out.status === 0 && lines.at(-1) === 'ok') return null;
  const said = lines.find((line) => line.startsWith('refused: '));
  if (said) return said.slice('refused: '.length);
  return `Windows PowerShell could not set who may open it (${(out.stderr || out.stdout).trim().split(/\r?\n/)[0] || `exit ${out.status}`})`;
}

/**
 * Writes `data` to `where`, in `dir`, made new and only then renamed over the old: never through a link, and only in a
 * folder that is this account's alone. On Windows, `ownFolder` makes it so, and says why it could not.
 */
function writeOwnFile(dir, where, data, { platform, ownFolder }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A folder another account can write to could hold a file or a link of theirs where the token is about to go.
  if (platform === 'win32') {
    // No file mode here, and no uid: the folder's ACL is what keeps others out.
    const folder = fs.lstatSync(dir);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error(`${dir} is not a folder: it must not be a link`);
    const why = ownFolder(dir);
    if (why) throw new Error(`${dir} could not be made a folder only you can open: ${why}`);
  } else {
    // Ours but open to others (a umask of 002 makes that), it is closed first; anyone else's, or a link, is refused.
    let folder = fs.lstatSync(dir);
    const own = typeof process.getuid !== 'function' || folder.uid === process.getuid();
    if (folder.isDirectory() && own && (folder.mode & 0o077)) {
      fs.chmodSync(dir, 0o700);
      folder = fs.lstatSync(dir);
    }
    if (!folder.isDirectory() || !own || (folder.mode & 0o022)) {
      throw new Error(`${dir} is not a folder only you can write to: it must be yours, and not a link; or set XDG_CONFIG_HOME`);
    }
  }
  // Made new and owner-only before a byte of the token is in it: `wx` refuses a file or link already there, and the
  // name cannot be guessed ahead. On Windows it takes the folder's ACL.
  const temp = `${where}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, where);
}

// On Windows a token, sealed or not, is kept and read only in the one folder whose way there is Windows' own and
// private, <profile>\AppData\Local\woodshed, as spelled and as resolved with every link and junction followed.
// - A new file takes its folder's ACL as it is made, not a mode given with it as on macOS and Linux: someone able to
//   replace a folder on the way could put one of theirs in its place between the check and the write.
// - What is read anywhere else could be someone else's: a plain token of theirs, or a blob they sealed for the whole
//   computer (CRYPTPROTECT_LOCAL_MACHINE), which DPAPI opens for any account, whatever scope the unseal asks for, and
//   whose entropy is no secret.
// Anywhere else (a LOCALAPPDATA moved elsewhere), no token is kept at all.
// @returns {string|null}  null for the default folder; else why not: `elsewhere`, or `led away` when it is spelled as
//   the default but a link or junction on the way leads somewhere else. `make`: it is made once its way there is checked
function notDefaultLocalFolder(dir, home, { make = false } = {}) {
  if (!home) return 'elsewhere';
  const local = (profile) => path.join(profile, 'AppData', 'Local');
  if (path.relative(path.join(local(home), 'woodshed'), path.resolve(dir)) !== '') return 'elsewhere';
  const real = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
  try {
    // The way there first, so nothing is made where a junction above would lead.
    const profile = real(home);
    if (path.relative(local(profile), real(path.dirname(dir))) !== '') return 'led away';
    if (make) fs.mkdirSync(dir);
  } catch (err) {
    if (err.code !== 'EEXIST') return 'led away';
  }
  try {
    return path.relative(path.join(local(real(home)), 'woodshed'), real(dir)) === '' ? null : 'led away';
  } catch {
    return 'led away';
  }
}

/** Throws unless `dir` is the one folder a Windows token may be kept in, making it once its way there is checked. */
function windowsOnlyDefault(dir, home) {
  const why = notDefaultLocalFolder(dir, home, { make: true });
  if (!why) return;
  const only = path.join(home, 'AppData', 'Local', 'woodshed');
  throw new Error(`${why === 'led away' ? `${dir} leads elsewhere through a link or junction` : `${dir} is not ${only}`}, and ${only} is the only place a token is kept on Windows: unset LOCALAPPDATA's override`);
}

function file(dir, platform, ownFolder, home) {
  const where = path.join(dir, 'credentials.json');
  const write = (data) => {
    if (platform === 'win32') windowsOnlyDefault(dir, home);
    return writeOwnFile(dir, where, data, { platform, ownFolder });
  };
  return {
    kind: 'file',
    label: where,
    file: where,
    save(origin, token) {
      checkArgs(origin, token);
      write({ ...readJson(where), [origin]: token });
      return true;
    },
    read(origin) {
      if (platform === 'win32' && notDefaultLocalFolder(dir, home)) return null;
      const token = readJson(where)[origin];
      return TOKEN_RE.test(String(token)) ? token : null;
    },
    remove(origin) {
      const data = readJson(where);
      if (!(origin in data)) return;
      delete data[origin];
      write(data);
    },
  };
}

// Each console's token sealed with DPAPI for this Windows account, and only for the console it was sealed for. The
// file holds only what was sealed, kept and read in the default folder alone as the plain file is, made this account's
// as the plain file's is, so what it says beside it (cli.json) is this account's own too.
function dpapi(dir, run, tools, ownFolder, home) {
  const where = path.join(dir, 'credentials-dpapi.json');
  const powershell = (script, input) => run(tools.powershell, powershellArgs(script), { input, env: powershellEnv() });
  const write = (data) => {
    windowsOnlyDefault(dir, home);
    return writeOwnFile(dir, where, data, { platform: 'win32', ownFolder });
  };
  return {
    kind: 'dpapi',
    label: `${where}, sealed for your Windows account (DPAPI)`,
    file: where,
    save(origin, token) {
      checkArgs(origin, token);
      const out = powershell(DPAPI_SEAL, `${origin}\n${token}\n`);
      const sealed = out.status === 0 ? out.stdout.trim() : '';
      if (!SEALED_RE.test(sealed)) return false;
      write({ ...readJson(where), [origin]: sealed });
      return this.read(origin) === token;
    },
    read(origin) {
      checkArgs(origin);
      if (notDefaultLocalFolder(dir, home)) return null;
      const sealed = readJson(where)[origin];
      if (typeof sealed !== 'string' || !SEALED_RE.test(sealed)) return null;
      const out = powershell(DPAPI_UNSEAL, `${origin}\n${sealed}\n`);
      const token = out.status === 0 ? out.stdout.trim() : '';
      return TOKEN_RE.test(token) ? token : null;
    },
    /** @returns {boolean}  a sealed token for `origin` is kept here, whether or not it can be opened now */
    holds(origin) {
      return !notDefaultLocalFolder(dir, home) && typeof readJson(where)[origin] === 'string';
    },
    remove(origin) {
      const data = readJson(where);
      if (!(origin in data)) return;
      delete data[origin];
      write(data);
    },
  };
}

/**
 * @param {{platform?: string, run?: typeof runCommand, dir: string, has?: (command: string) => boolean,
 *          tools?: ReturnType<typeof windowsTools>, home?: string}} opts  `home`: the person's profile, on Windows
 *   `dir` is the command line's config folder, for the files; `has` says whether a command is on the PATH, or for a
 *   Windows tool's full path, whether it is there
 * @returns {{storeFor: (kind: string) => object, save: (origin: string, token: string) => object}}
 *   `save` keeps the token in the first store that takes it and gives back that store
 */
export function createCredentials({ platform = process.platform, run = runCommand, dir, has = (command) => hasCommand(command), tools = windowsTools(), home = os.homedir() }) {
  const ownFolder = (folder) => windowsOwnFolder(folder, run, tools);
  const stores = { keychain: keychain(run), libsecret: libsecret(run), dpapi: dpapi(dir, run, tools, ownFolder, home), file: file(dir, platform, ownFolder, home) };
  const ownKinds = { darwin: ['keychain', 'file'], linux: ['libsecret', 'file'], win32: ['dpapi', 'file'] }[platform] ?? ['file'];
  const order = [
    ...(platform === 'darwin' && has('security') ? ['keychain'] : []),
    ...(platform === 'linux' && has('secret-tool') ? ['libsecret'] : []),
    ...(platform === 'win32' && has(tools.powershell) ? ['dpapi'] : []),
    'file',
  ];
  return {
    // This platform's own stores alone, whatever cli.json names: one it does not use is never run (on Windows a bare
    // `security` or `secret-tool` could be found in the current folder, and cli.json is no proof of who wrote it).
    storeFor: (kind) => (Object.hasOwn(stores, kind) && ownKinds.includes(kind) ? stores[kind] : null),
    save(origin, token) {
      let refused = null;
      for (const kind of order) {
        try {
          if (stores[kind].save(origin, token)) return stores[kind];
        } catch (err) {
          // The last store's reason is the one said; one before it that throws gives way to the next, as one that
          // answers false does.
          if (kind === order.at(-1)) throw err;
          refused = err;
        }
      }
      throw new Error(`the token could not be kept anywhere${refused ? ` (${refused.message})` : ''}`);
    },
  };
}

/** @returns {boolean}  a Windows tool by its full path is there, or another command is on the PATH */
function hasCommand(command) {
  if (/^[A-Za-z]:\\/.test(command)) return fs.existsSync(command);
  return onPath(command);
}

/** @returns {boolean}  whether `command` is a file on the PATH */
export function onPath(command, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((d) => {
    try {
      fs.accessSync(path.join(d, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
