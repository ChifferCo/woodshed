// Where the command line keeps its console token, one per console: the macOS Keychain, else the Secret Service on Linux
// (libsecret's secret-tool, which needs a desktop session's keyring), else a file only this user can read, whose path
// the command line prints. The token never goes in a command's arguments, where another user's `ps` would see it: the
// Keychain gets it through `security -i` on stdin, and secret-tool reads it from stdin.
//
// On Windows, a file sealed with DPAPI for this Windows account (Windows PowerShell 5.1, which ships with Windows, does
// the sealing, with the token on its stdin), else a plain file under the person's profile, in a folder icacls makes this
// account's alone, checked after it is set. Each Windows tool is run from System32 by its full path, never found on the PATH or in the current
// folder, and never through a shell.
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
const DPAPI_PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
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

/** @returns {{powershell: string, icacls: string, whoami: string}}  System32's own, by full path */
export function windowsTools(env = process.env) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  return {
    powershell: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    icacls: path.win32.join(system32, 'icacls.exe'),
    whoami: path.win32.join(system32, 'whoami.exe'),
  };
}

/** @returns {string[]}  the arguments that run a fixed script in Windows PowerShell, no profile, nothing asked */
export function powershellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** @returns {{status: number|null, stdout: string, stderr: string}} */
export function runCommand(command, args, { input, cwd } = {}) {
  const out = spawnSync(command, args, { input, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true });
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
 * The names icacls lists as holding a right on `dir`, from its output, or [] when it cannot be read as such. icacls is
 * run in the folder, on `.`, so the line it starts with is never a path to decode.
 * @returns {string[]}
 */
export function aclHolders(output, dir = '.') {
  const lines = String(output).split(/\r?\n/);
  const holders = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (i === 0) {
      // The first line is the folder, then its first entry; each other entry is on a line of its own, indented under it.
      if (!line.toLowerCase().startsWith(`${dir.toLowerCase()} `)) return [];
      line = line.slice(dir.length);
    } else if (!/^\s/.test(line)) break;
    line = line.trim();
    if (!line) break;
    const at = line.indexOf(':(');
    if (at <= 0) return [];
    holders.push(line.slice(0, at));
  }
  return holders;
}

/**
 * Makes `dir` this Windows account's alone, as 0700 is on macOS and Linux: no rights inherited from the folder above,
 * full control for this account (its SID, as whoami says it), then this account as its owner, since an owner may always
 * change who may open it; and what icacls then lists is checked to be that account alone. Entries of anyone else's
 * already on the folder are not taken off, and a folder this account cannot take is not taken: either is refused, as
 * someone else's folder is on macOS and Linux.
 * @returns {string|null}  why it could not be, or null once it is
 */
export function windowsOwnFolder(dir, run, tools) {
  const who = run(tools.whoami, ['/user', '/fo', 'csv', '/nh']);
  const me = /^"([^"]+)","(S-1-[0-9-]+)"/.exec(who.stdout.trim());
  if (who.status !== 0 || !me) return 'whoami did not say which account this is';
  const [, name, sid] = me;
  const firstLine = (out) => (out.stderr || out.stdout).trim().split(/\r?\n/)[0];
  const icacls = (args) => run(tools.icacls, ['.', ...args], { cwd: dir });
  const set = icacls(['/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  if (set.status !== 0) return `icacls could not set who may open it (${firstLine(set)})`;
  const owned = icacls(['/setowner', `*${sid}`]);
  if (owned.status !== 0) return `it is another account's, and icacls could not make it yours (${firstLine(owned)})`;
  const shown = icacls([]);
  const holders = shown.status === 0 ? aclHolders(shown.stdout) : [];
  if (!holders.length) return 'icacls did not say who may open it';
  const others = holders.filter((holder) => holder.toLowerCase() !== name.toLowerCase());
  return others.length ? `others may still open it (${others.join(', ')})` : null;
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
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error(`${dir} is not a folder: it must not be a link; or set XDG_CONFIG_HOME`);
    const why = ownFolder(dir);
    if (why) throw new Error(`${dir} could not be made a folder only you can open: ${why}; or set XDG_CONFIG_HOME`);
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

// On Windows a new file takes its folder's ACL as it is made, not a mode given with it as on macOS and Linux: someone
// able to replace a folder on the way to this one could put one of theirs in its place between the check and the write.
// So the plain token is written on Windows only in the one folder whose way there is Windows' own and private,
// <profile>\AppData\Local\woodshed, as spelled and as resolved with every link and junction followed. Anywhere else
// (an XDG_CONFIG_HOME, a LOCALAPPDATA moved elsewhere), a token is kept sealed or not at all.
// Read by the same rule as written: a plain file anywhere else could be one someone else put there, with their token.
// @returns {boolean}  `make`: the folder is made once its way there is checked, for a write
function isDefaultLocalFolder(dir, home, { make = false } = {}) {
  if (!home) return false;
  const local = (profile) => path.join(profile, 'AppData', 'Local');
  if (path.relative(path.join(local(home), 'woodshed'), path.resolve(dir)) !== '') return false;
  const real = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
  try {
    // The way there first, so nothing is made where a junction above would lead.
    const profile = real(home);
    if (path.relative(local(profile), real(path.dirname(dir))) !== '') return false;
    if (make) fs.mkdirSync(dir);
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }
  try {
    return path.relative(path.join(local(real(home)), 'woodshed'), real(dir)) === '';
  } catch {
    return false;
  }
}

function file(dir, platform, ownFolder, home) {
  const where = path.join(dir, 'credentials.json');
  const write = (data) => {
    if (platform === 'win32' && !isDefaultLocalFolder(dir, home, { make: true })) {
      throw new Error(`${dir} is not ${path.join(home, 'AppData', 'Local', 'woodshed')}, the only place a token is kept unsealed on Windows: unset XDG_CONFIG_HOME and LOCALAPPDATA's override, or sign in where DPAPI can seal it`);
    }
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
      if (platform === 'win32' && !isDefaultLocalFolder(dir, home)) return null;
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

// Each console's token sealed with DPAPI, which only this Windows account can open, and only for the console it was
// sealed for. The file holds only what was sealed, in a folder made this account's alone as the plain file's is, so
// what it says beside it (cli.json) is this account's own too.
function dpapi(dir, run, tools, ownFolder) {
  const where = path.join(dir, 'credentials-dpapi.json');
  const powershell = (script, input) => run(tools.powershell, powershellArgs(script), { input });
  const write = (data) => writeOwnFile(dir, where, data, { platform: 'win32', ownFolder });
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
      const sealed = readJson(where)[origin];
      if (typeof sealed !== 'string' || !SEALED_RE.test(sealed)) return null;
      const out = powershell(DPAPI_UNSEAL, `${origin}\n${sealed}\n`);
      const token = out.status === 0 ? out.stdout.trim() : '';
      return TOKEN_RE.test(token) ? token : null;
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
  const stores = { keychain: keychain(run), libsecret: libsecret(run), dpapi: dpapi(dir, run, tools, ownFolder), file: file(dir, platform, ownFolder, home) };
  const order = [
    ...(platform === 'darwin' && has('security') ? ['keychain'] : []),
    ...(platform === 'linux' && has('secret-tool') ? ['libsecret'] : []),
    ...(platform === 'win32' && has(tools.powershell) ? ['dpapi'] : []),
    'file',
  ];
  return {
    storeFor: (kind) => stores[kind] ?? null,
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
