// Promise-wrapped spawn, for everything on this box that is not fast.
//
// It lives in review/ because that is where the need first arose, and it is
// also used by the root-level prStatus.mjs — anything reaching for git or `gh`
// wants exactly this and should not grow a second copy of it.
//
// server.mjs uses spawnSync almost everywhere, and rightly: its calls are tmux
// and /proc reads that finish in milliseconds. These calls are not — `git
// worktree add` of a 130 MB tree takes tens of seconds, and `gh pr diff` or
// `gh pr list` take about a second. spawnSync blocks the event loop for the
// whole duration, so doing this the house way would freeze every other tab's
// /sessions poll while a checkout ran.
//
// Deliberately argv-only: there is no shell option and no string form, so
// there is no way for a caller to accidentally introduce one.

import { spawn } from 'node:child_process';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * @param {string} file binary to run, resolved via PATH
 * @param {string[]} args argv, passed through without shell interpretation
 * @param {{cwd?: string, timeoutMs?: number, maxBytes?: number, env?: object}} [opts]
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 *   Never rejects for a non-zero exit; a failed spawn resolves with status null
 *   and the error in stderr, so callers have exactly one shape to handle.
 */
export function run(file, args, opts = {}) {
  const { cwd, timeoutMs = 60_000, maxBytes = DEFAULT_MAX_BYTES, env } = opts;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: String(err.message), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(function onTimeout() {
      timedOut = true;
      child.kill('SIGTERM');
      // A process ignoring SIGTERM still has to go; without this the promise
      // never settles and the caller waits forever.
      setTimeout(function hard() {
        child.kill('SIGKILL');
      }, 5_000).unref();
    }, timeoutMs);

    // Decode as a stream, not per chunk: a multi-byte character straddling a
    // chunk boundary would otherwise become two U+FFFD, and for a patch that
    // corruption is cached and then rendered as if it were the real diff.
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', function onOut(chunk) {
      // Byte length explicitly: `chunk` is a string now, and the cap is a
      // memory bound, not a character count.
      stdoutBytes += Buffer.byteLength(chunk, 'utf-8');
      // Truncate rather than buffer without bound: a runaway command must not
      // be able to exhaust the shed's memory.
      if (stdoutBytes <= maxBytes) stdout += chunk;
    });
    child.stderr.on('data', function onErr(chunk) {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    function finish(status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut, truncated: stdoutBytes > maxBytes });
    }

    child.on('error', function onSpawnError(err) {
      stderr += String(err.message);
      finish(null);
    });
    child.on('close', function onClose(code) {
      finish(code);
    });
  });
}
