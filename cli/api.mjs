// The command line as a program calls it: one command of the catalogue (commands.mjs), run by the command line's own
// code (woodshed.mjs, main) with a sign-in the program holds, its --json events handed back, and nothing of a person's
// computer touched. A server that offers the commands to someone (an MCP server) runs them here, so each command's
// checks, console calls, events and exit codes are the command line's own, with no second copy of them.
//
// What it gives the command in place of a computer: no terminal (nothing asks a question: what needs the person exits
// 2), no browser, no Herdr (`hc` is not there), no file of its own (the token is the caller's, for this run alone, never
// written down), and its stdin from the caller. A command or option that needs the computer or a terminal
// (`needs` in the catalogue) is refused before anything runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { argvOf, commandName } from './commands.mjs';
import { EXIT, main } from './woodshed.mjs';

export { EXIT };

/** A command's run stopped by its caller (its signal): not an answer of the command's. */
export class Stopped extends Error {}

// The folder a command runs in: an empty one of its own, never a checkout, so a command that would read the checkout
// it is run in (review status with no --repo) finds none, whatever folder the program itself runs in.
let emptyDir = null;
const noCheckout = () => (emptyDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-api-')));

/**
 * Runs one command as the person whose `token` it is, on the console at `origin`.
 * @param {object} entry  one of COMMANDS, whose `needs` is null
 * @param {Record<string, any>} args  its arguments by name, as argvOf takes them
 * @param {{origin: string, token: string, fetch?: typeof fetch, signal?: AbortSignal, stdin?: string,
 *          onEvent?: (event: object|string) => void, maxOutput?: number}} p
 * @returns {Promise<{code: number|null, events: Array<object|string>, stdout: string, stderr: string, stopped: boolean,
 *          truncated: boolean}>}  `code` is the command's exit code (null when it was stopped); `events` its --json
 *          lines (a line that is not JSON as its text); a tunnel's `stdout` is its line's
 */
export async function runCommand(entry, args, { origin, token, fetch: fetchFn = globalThis.fetch, signal = null, stdin = '', onEvent = () => {}, maxOutput = 1_000_000 }) {
  // The caller's sign-in, always: never none, which the command line would take for this computer's own.
  if (typeof token !== 'string' || !/^wsc_[0-9a-f]{64}$/.test(token)) throw new Error('runCommand needs the person\'s command line token');
  if (entry.needs) throw new Error(`${commandName(entry)} runs only on the person's own ${entry.needs}`);
  for (const o of [...(entry.options ?? []), ...(entry.args ?? [])]) {
    if (o.needs && args[o.name] !== undefined && args[o.name] !== false) throw new Error(`--${o.name} runs only on the person's own ${o.needs}`);
  }
  // A command that reads a checkout here when it is given none (--dir, which needs the computer) needs its repo named.
  const repoOption = (entry.options ?? []).find((o) => o.name === 'repo');
  if (repoOption && (entry.options ?? []).some((o) => o.name === 'dir') && !args.repo) throw new Error(`${commandName(entry)} needs repo: there is no checkout here`);
  const tunnel = entry.waits === 'line';
  // Stopped before it started: nothing is sent, a tunnel's line least of all, which could change the session.
  if (signal?.aborted) return { code: null, events: [], stdout: '', stderr: '', stopped: true, truncated: false };
  const argv = argvOf(entry, args, ['--console', origin, ...(tunnel ? [] : ['--json'])]);
  const out = { code: null, events: [], stdout: '', stderr: '', stopped: false, truncated: false };

  let partial = '';
  const take = (line) => {
    if (!line.trim()) return;
    let event = line;
    if (line.startsWith('{')) {
      try {
        event = JSON.parse(line);
      } catch {
        // Kept as the text it is.
      }
    }
    if (out.events.length < 5000) out.events.push(event);
    onEvent(event);
  };
  // A character split across two writes is kept whole.
  const decoder = new StringDecoder('utf8');
  const stdout = new Writable({
    write(chunk, _enc, done) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (out.stdout.length + text.length > maxOutput) out.truncated = true;
      if (out.stdout.length < maxOutput) out.stdout += text.slice(0, maxOutput - out.stdout.length);
      if (!tunnel) {
        const parts = (partial + text).split('\n');
        partial = parts.pop();
        for (const line of parts) take(line);
      }
      done();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, done) {
      out.stderr = (out.stderr + chunk.toString()).slice(-64_000);
      done();
    },
  });

  // Once stopped, what the command still writes goes nowhere, and says so to no one.
  stdout.on('error', () => {});
  const stop = () => {
    out.stopped = true;
    // A tunnel ends when its reader goes (tunnel.mjs); a wait at its next sleep or call.
    stdout.destroy(new Stopped('stopped'));
  };
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const sleep = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped('stopped'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Stopped('stopped')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    return undefined;
  });
  const fetchWith = (url, init = {}) => {
    if (signal?.aborted) return Promise.reject(new Stopped('stopped'));
    return fetchFn(url, { ...init, signal: signal ? AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) : init.signal });
  };
  const nothing = async () => ({ code: null, stdout: '', stderr: '', missing: true });

  try {
    out.code = await main(argv, {
      env: {}, stdout, stderr, stdin: Readable.from(stdin ? [Buffer.from(stdin)] : []), fetch: fetchWith, sleep, signal,
      token, hc: nothing, openBrowser: () => {}, isTerminal: false,
      // Nobody to ask (null), as with no terminal: a confirmation the command needs waits on the person, exit 2.
      cwd: noCheckout(), confirm: async () => null, terminal: async () => ({ status: 'refused', message: 'no terminal here' }), interactive: false,
    });
  } catch (err) {
    if (!out.stopped && !(err instanceof Stopped)) throw err;
    out.stopped = true;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  if (out.stopped) out.code = null;
  const rest = decoder.end();
  if (rest && out.stdout.length < maxOutput) out.stdout += rest;
  if (!tunnel) partial += rest;
  if (partial && !tunnel) take(partial);
  return out;
}
