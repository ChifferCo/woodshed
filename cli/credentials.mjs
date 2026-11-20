// Where the command line keeps its console token, one per console: the macOS Keychain, else the Secret Service on Linux
// (libsecret's secret-tool, which needs a desktop session's keyring), else a file only this user can read, whose path
// the command line prints. The token never goes in a command's arguments, where another user's `ps` would see it: the
// Keychain gets it through `security -i` on stdin, and secret-tool reads it from stdin.
//
// Each store is keyed by the console's origin (https://console.example), so signing in to a second console keeps the
// first's token. cli.json (config.mjs) says which store holds each console's, so a read never guesses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SERVICE = 'woodshed-cli';
const TOKEN_RE = /^wsc_[0-9a-f]{64}$/;
// What may follow `-a` in a `security -i` line: an origin has no spaces or quotes, and anything else is refused.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/** @returns {{status: number|null, stdout: string, stderr: string}} */
export function runCommand(command, args, { input } = {}) {
  const out = spawnSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
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

function file(dir) {
  const where = path.join(dir, 'credentials.json');
  const all = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(where, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${where}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's mode applies only to a new file, and a umask can narrow it: set it outright before it is in place.
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, where);
  };
  return {
    kind: 'file',
    label: where,
    file: where,
    save(origin, token) {
      checkArgs(origin, token);
      write({ ...all(), [origin]: token });
      return true;
    },
    read(origin) {
      const token = all()[origin];
      return TOKEN_RE.test(String(token)) ? token : null;
    },
    remove(origin) {
      const data = all();
      if (!(origin in data)) return;
      delete data[origin];
      write(data);
    },
  };
}

/**
 * @param {{platform?: string, run?: typeof runCommand, dir: string, has?: (command: string) => boolean}} opts
 *   `dir` is the command line's config folder, for the file; `has` says whether a command is on the PATH
 * @returns {{storeFor: (kind: string) => object, save: (origin: string, token: string) => object}}
 *   `save` keeps the token in the first store that takes it and gives back that store
 */
export function createCredentials({ platform = process.platform, run = runCommand, dir, has = (command) => onPath(command) }) {
  const stores = { keychain: keychain(run), libsecret: libsecret(run), file: file(dir) };
  const order = [
    ...(platform === 'darwin' && has('security') ? ['keychain'] : []),
    ...(platform === 'linux' && has('secret-tool') ? ['libsecret'] : []),
    'file',
  ];
  return {
    storeFor: (kind) => stores[kind] ?? null,
    save(origin, token) {
      for (const kind of order) {
        if (stores[kind].save(origin, token)) return stores[kind];
      }
      throw new Error('the token could not be kept anywhere');
    },
  };
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
