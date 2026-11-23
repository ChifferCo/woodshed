// Opening a web address in the person's browser, from the command line: `woodshed login`'s approval page, and the
// review's pull request (reviewTui.mjs). The address is the opener's argument, never a shell's: on Windows that is
// rundll32's FileProtocolHandler, which opens it as `start` would, without cmd.exe reading the address.

import { spawn } from 'node:child_process';
import path from 'node:path';

/** The opener and its arguments for `url` on `platform`. On Windows, the full System32 path to rundll32. */
export function browserCommand(url, platform, env = process.env) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return [path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/**
 * Whether a browser could open on this person's screen: not over SSH (it would open on the far machine, if anywhere),
 * and on Linux and the BSDs only with a display to open it on.
 */
export function canOpenBrowser(platform, env = process.env) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Starts the opener for `url`, detached, and calls `failed` when it could not be started or said it failed.
 * @param {{platform?: string, env?: object, spawnFn?: typeof spawn, failed?: (why: string) => void}} [opts]
 */
export function openBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn, failed = () => {} } = {}) {
  const [command, args] = browserCommand(url, platform, env);
  try {
    const child = spawnFn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', (err) => failed(err.code === 'ENOENT' ? `${command} is not installed` : err.message));
    child.on('exit', (code) => { if (code) failed(`${path.basename(command)} exited with ${code}`); });
    child.unref();
  } catch (err) {
    failed(err.message);
  }
}
