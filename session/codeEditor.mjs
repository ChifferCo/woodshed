// The console's Editor: VS Code in the browser (openvscode-server) on the checkout, started by statusd on the first
// request for it rather than at every session start, so a session nobody opens it in neither fetches its files
// through SOCI nor keeps it in memory.
//
// It listens on loopback with no connection token of its own: statusd forwards to it only after checking the session
// token, as it does for the database viewers. Its terminals get statusd's environment, the session's, as the
// Terminal tab's shell does.

import { existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';

const LOG_FILE = `${process.env.WOODSHED_TMP || '/tmp'}/openvscode-server.log`;
// It answered in about 2 s on a dev box; this leaves room for SOCI fetching its files on a cold start.
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

export const EDITOR_BASE_PATH = '/__woodshed/code';

/**
 * @param {{port: number, repoDir: string}} options
 * @returns {string[]}  openvscode-server's arguments: served under EDITOR_BASE_PATH, on the session's app name, so a
 *   path passes through unchanged
 */
export function editorArgs({ port, repoDir }) {
  return [
    '--host', '127.0.0.1', '--port', String(port), '--server-base-path', EDITOR_BASE_PATH,
    '--without-connection-token', '--accept-server-license-terms', '--telemetry-level', 'off',
    '--disable-workspace-trust', '--default-folder', repoDir,
  ];
}

/**
 * @param {{bin: string, port: number, repoDir: string, listening: (port: number) => Promise<boolean>,
 *   logFile?: string, timeoutMs?: number}} options
 *   `listening` says whether something accepts a connection on the port
 * @returns {{ensure: () => Promise<boolean>, forget: () => void}}  `ensure` resolves true once the editor answers,
 *   false when this image has none or it did not come up; `forget` makes the next `ensure` look again, after a
 *   request found it gone
 */
export function createCodeEditor({ bin, port, repoDir, listening, logFile = LOG_FILE, timeoutMs = START_TIMEOUT_MS }) {
  let starting = null;
  // Known to answer, so the workbench's hundreds of requests skip the probe.
  let up = false;

  async function start() {
    if (await listening(port)) return true;
    if (!existsSync(bin)) {
      console.log('statusd: no editor in this image', { bin });
      return false;
    }
    const startedAt = Date.now();
    const out = openSync(logFile, 'a');
    const child = spawn(bin, editorArgs({ port, repoDir }), { cwd: repoDir, detached: true, stdio: ['ignore', out, out] });
    child.on('error', (err) => console.warn('statusd: editor did not start', { message: err.message }));
    child.unref();
    console.log('statusd: editor starting', { port, pid: child.pid });
    while (Date.now() - startedAt < timeoutMs) {
      if (child.exitCode !== null) break;
      if (await listening(port)) {
        console.log('statusd: editor started', { seconds: Math.round((Date.now() - startedAt) / 1000) });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    console.warn('statusd: editor did not come up', { exitCode: child.exitCode, seconds: Math.round((Date.now() - startedAt) / 1000) });
    return false;
  }

  // One start at a time: the workbench's first page load asks for several files at once.
  function ensure() {
    if (up) return Promise.resolve(true);
    starting ??= start().then((answered) => { up = answered; return answered; }).finally(() => { starting = null; });
    return starting;
  }

  function forget() {
    up = false;
  }

  return { ensure, forget };
}
