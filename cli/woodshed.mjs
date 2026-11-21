#!/usr/bin/env node
// The woodshed command line: signs in to a Woodshed console, says who is signed in, starts and manages sessions, and
// opens a pipe into one's own running session. Later commands (settings) are added here. Plain Node 22, no
// dependencies, as the rest of Woodshed (cli/README.md).
//
//   woodshed login  [--console <url>] [--no-browser]   a code to approve in the browser, then a token kept in the keychain
//   woodshed logout [--console <url>]                  ends that token at the console and forgets it here
//   woodshed status [--console <url>]                  the console, its org, and who is signed in
//   woodshed tunnel <id> -- <line>                     runs <line> in your session, piped to this terminal (tunnel.mjs)
//   woodshed session new|list|get|stop|resume|remove|extend|limits   sessions (sessions.mjs)
//
// Every command takes --json. Exit codes: 0 done, 2 waiting on a person (a sign-in or an approval), 3 refused, 1 any
// other failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCredentials } from './credentials.mjs';
import { runTunnel, TUNNEL_FAILED } from './tunnel.mjs';
import { sessionCommand } from './sessions.mjs';

export const VERSION = '0.1.0';
export const DEFAULT_CONSOLE = 'https://console.woodshed.run';
// Each call to the console, its answer read included.
const REQUEST_MS = 20_000;
export const EXIT = Object.freeze({ done: 0, failed: 1, waiting: 2, refused: 3 });

const USAGE = `Usage: woodshed <command> [--console <url>] [--json]

Commands:
  login     sign in to a Woodshed console: approve the code it shows in your browser
  logout    sign out of the console, here and at the console
  status    the console, its org, and who is signed in
  tunnel <id> -- <line>
            run <line> in your running session, with this command's stdin, stdout and stderr; exits with its
            exit code, or 255 when the pipe could not open or broke
  session   start, list, stop, resume and remove sessions, and give them more time: woodshed session --help

Options:
  --console <url>  the console to use (default: the one you last signed in to, else ${DEFAULT_CONSOLE};
                   WOODSHED_CONSOLE sets it too)
  --no-browser     login prints the address to open instead of opening it
  --json           machine-readable output: one JSON object per line
  --help           this text

Exit codes: 0 done, 2 waiting on a person (sign in, or approve), 3 refused, 1 anything else.`;

class CliError extends Error {
  constructor(message, { code = EXIT.failed, status = 'error' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @returns {{command: string|null, args: string[], rest: string[]|null, console: string|null, json: boolean,
 *            browser: boolean, help: boolean}}  `args` follow the command; `rest` is everything after `--`. For
 *            `session`, `args` also takes its own options (sessions.mjs reads them), and `rest` its prompt
 */
export function parseArgs(argv) {
  const out = { command: null, args: [], rest: null, console: null, json: false, browser: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.rest = argv.slice(i + 1);
      break;
    } else if (arg === '--json') out.json = true;
    else if (arg === '--no-browser') out.browser = false;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--console') {
      if (!argv[i + 1]) throw new CliError('--console needs a URL');
      out.console = argv[++i];
    } else if (arg.startsWith('--console=')) out.console = arg.slice('--console='.length);
    else if (out.command === 'session') out.args.push(arg);
    else if (arg.startsWith('-')) throw new CliError(`unknown option ${arg}\n\n${USAGE}`);
    else if (!out.command) out.command = arg;
    else if (out.command === 'tunnel') out.args.push(arg);
    else throw new CliError(`unexpected ${arg}\n\n${USAGE}`);
  }
  return out;
}

/**
 * The console's origin from what the person typed: a bare name gets https, a path is dropped. Plain http only to this
 * machine: the token would otherwise cross the network in the clear.
 * @returns {string}
 */
export function consoleOrigin(typed) {
  const text = String(typed ?? '').trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new CliError(`not a console address: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CliError(`not a console address: ${text}`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol === 'http:' && !loopback) throw new CliError(`${url.origin} is plain http: use its https address, so the token is not sent in the clear`, { code: EXIT.refused, status: 'refused' });
  return url.origin;
}

function configDir(env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'woodshed');
}

// cli.json: the console used last, and for each console who is signed in and which store holds the token. Never a token.
function readConfig(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'cli.json'), 'utf8'));
    return { current: parsed.current ?? null, consoles: parsed.consoles && typeof parsed.consoles === 'object' ? parsed.consoles : {} };
  } catch {
    return { current: null, consoles: {} };
  }
}

function writeConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const where = path.join(dir, 'cli.json');
  const temp = `${where}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, where);
}

// Only an address this command line built (approvalUrl), and never through a shell: cmd's `start` would read & and | in
// it as commands of their own.
function openBrowser(url, platform) {
  const [command, args] = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser to open: the address is printed anyway.
  }
}

// A yes or no from the person at the terminal, asked on stderr so --json's stdout stays one object per line. Null
// where nobody can answer: no terminal on stdin.
async function confirmOnTerminal(question, stderr) {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * The page the code is approved on, on the console the person named. Built here from the code alone, never taken from
 * the console's answer: what is opened or printed is then always an https (or loopback http) page of that console, never
 * an option to `open` or another program's address.
 * @returns {string|null}  null for a code that is not one
 */
export function approvalUrl(origin, userCode) {
  if (!/^[A-Z]{4}-[A-Z]{4}$/.test(String(userCode))) return null;
  const url = new URL('/cli', origin);
  url.searchParams.set('code', userCode);
  return url.href;
}

/**
 * @param {string[]} argv
 * @param {{env?: object, stdout?: {write: Function}, stderr?: {write: Function}, fetch?: typeof fetch,
 *          sleep?: (ms: number) => Promise<void>, credentials?: ReturnType<typeof createCredentials>,
 *          openBrowser?: (url: string) => void, hostname?: string, platform?: string, now?: () => number}} [deps]
 * @returns {Promise<number>}  the exit code
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const dir = configDir(env);
  const credentials = deps.credentials ?? createCredentials({ platform, dir });
  const open = deps.openBrowser ?? ((url) => openBrowser(url, platform));
  let json = argv.includes('--json');

  const emit = (object) => stdout.write(`${JSON.stringify(object)}\n`);
  const say = (text) => { if (!json) stdout.write(`${text}\n`); };

  // `deadlineMs` in place of the usual 20 s, for a write the console answers only once it is done (a session's stop).
  async function call(origin, pathname, { method = 'GET', body, token, timeoutMs = REQUEST_MS, deadlineMs = null } = {}) {
    let res;
    try {
      res = await fetchFn(`${origin}${pathname}`, {
        method,
        // No Origin: a browser's call is what the console refuses at /api/cli/device and /api/cli/token.
        headers: {
          'user-agent': `woodshed-cli/${VERSION}`, accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        // The answer too, read below: a console that stalls never holds a login past its code's expiry.
        signal: AbortSignal.timeout(deadlineMs ?? Math.max(1, Math.min(REQUEST_MS, timeoutMs))),
      });
    } catch (err) {
      // Marked, so a wait can tell a network that dropped from the console's own answer.
      // A timeout is marked too: the console may still be doing what was asked.
      throw Object.assign(new CliError(`could not reach ${origin}: ${err.cause?.message ?? err.message}`), { unreachable: true, timedOut: err?.name === 'TimeoutError' });
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      // A proxy's page, or a console from before the command line: said by the status below.
    }
    return { status: res.status, body: answer };
  }

  function consoleNoCli(origin, status) {
    if (status >= 500) return new CliError(`${origin} answered ${status}: the console failed. Try again, or ask whoever runs it to look at its log`);
    return new CliError(`${origin} answered ${status}: it is not a Woodshed console, or one from before the command line could sign in`);
  }

  // What the console says goes to a terminal: only printable text of it, so a console cannot move the cursor or retitle
  // the window with escape codes.
  const plain = (text) => (text === null || text === undefined ? null : String(text).replace(/[^\x20-\x7e]/g, '').slice(0, 100));

  function signedIn(origin) {
    const config = readConfig(dir);
    const entry = config.consoles[origin];
    const store = entry && credentials.storeFor(entry.store);
    const token = store ? store.read(origin) : null;
    return { config, entry, store, token };
  }

  async function login(origin, { browser }) {
    // Before any code is asked for, so no sign-in is left at the console that nothing here could keep.
    if (platform === 'win32') throw new CliError('woodshed login does not run on Windows yet: it has nowhere to keep the token safely', { code: EXIT.refused, status: 'refused' });
    const before = signedIn(origin);
    const started = await call(origin, '/api/cli/device', { method: 'POST', body: { name: deps.hostname ?? os.hostname() } });
    if (started.status !== 200 || !started.body?.deviceCode) {
      if (started.status === 429) throw new CliError(plain(started.body?.error) ?? 'the console is busy: try again in a few minutes');
      throw consoleNoCli(origin, started.status);
    }
    const { deviceCode, userCode, expiresIn, interval } = started.body;
    const verificationUrlComplete = approvalUrl(origin, userCode);
    if (!verificationUrlComplete) throw consoleNoCli(origin, started.status);
    const verificationUrl = `${origin}/cli`;
    // A console that is not one could send anything: never wait longer than the console's own 10 minutes.
    const lasts = Number(expiresIn) > 0 ? Math.min(Number(expiresIn), 600) : 600;
    const expiresAt = now() + lasts * 1000;
    if (json) emit({ event: 'code', console: origin, userCode, verificationUrl, verificationUrlComplete, expiresAt: new Date(expiresAt).toISOString() });
    say(`Your code: ${userCode}`);
    say(browser ? `Opening ${verificationUrlComplete}` : `Open ${verificationUrlComplete}`);
    say('Check the page shows the same code, then press Sign in the CLI. Waiting…');
    if (browser) open(verificationUrlComplete);
    let wait = Math.max(1, Number(interval) || 5) * 1000;
    for (;;) {
      await sleep(wait);
      if (now() >= expiresAt) break;
      let polled;
      try {
        polled = await call(origin, '/api/cli/token', { method: 'POST', body: { deviceCode }, timeoutMs: expiresAt - now() });
      } catch (err) {
        // A network that drops while the person approves (a laptop's Wi-Fi) is asked again until the code expires.
        if (!json) stderr.write(`woodshed: ${err.message}; trying again\n`);
        continue;
      }
      if (polled.status === 202) continue;
      if (polled.status === 429) {
        wait += 5000;
        continue;
      }
      if (polled.status === 403) throw new CliError('The sign-in was denied in the browser.', { code: EXIT.refused, status: 'denied' });
      if (polled.status === 410) break;
      if (polled.status !== 200 || !polled.body?.token) throw consoleNoCli(origin, polled.status);
      const { token, id } = polled.body;
      const [who, org, name, tokenExpiresAt] = [polled.body.login, polled.body.org, polled.body.console, polled.body.expiresAt].map(plain);
      if (!/^wsc_[0-9a-f]{64}$/.test(String(token))) throw consoleNoCli(origin, polled.status);
      let store;
      try {
        store = credentials.save(origin, token);
      } catch (err) {
        throw new CliError(`Signed in, but the token could not be kept: ${err.message}. Revoke this sign-in on My settings.`);
      }
      const config = readConfig(dir);
      config.current = origin;
      config.consoles[origin] = { login: who ?? null, store: store.kind, tokenId: id, signedInAt: new Date(now()).toISOString() };
      writeConfig(dir, config);
      // The token this computer held before is ended at the console, so My settings lists one sign-in for it.
      let earlierEnded = null;
      if (before.token && before.token !== token) {
        const out = await call(origin, '/api/cli/logout', { method: 'POST', token: before.token }).catch(() => null);
        earlierEnded = out?.status === 200 || out?.status === 401;
      }
      if (before.store && before.store.kind !== store.kind) before.store.remove(origin);
      const result = {
        event: 'signed-in', console: origin, name: name ?? null, org: org ?? null, login: who ?? null, expiresAt: tokenExpiresAt ?? null,
        store: store.kind, ...(store.file ? { credentialsFile: store.file } : {}), ...(earlierEnded === false ? { earlierSignInEnded: false } : {}),
      };
      if (json) emit(result);
      say(`Signed in to ${name ?? origin}${who ? ` as @${who}` : ''}.`);
      say(`The token is kept in ${store.label}.`);
      if (earlierEnded === false) say('This computer\'s earlier sign-in could not be ended: revoke it on My settings, under Command line.');
      return EXIT.done;
    }
    throw new CliError('The code expired before anyone approved it. Run woodshed login again.', { code: EXIT.waiting, status: 'expired' });
  }

  async function logout(origin) {
    const { config, entry, store, token } = signedIn(origin);
    let atConsole = null;
    if (token) {
      try {
        const out = await call(origin, '/api/cli/logout', { method: 'POST', token });
        atConsole = out.status === 200 || out.status === 401;
      } catch {
        atConsole = false;
      }
    }
    store?.remove(origin);
    if (entry) {
      delete config.consoles[origin];
      if (config.current === origin) config.current = null;
      writeConfig(dir, config);
    }
    if (json) emit({ event: 'signed-out', console: origin, wasSignedIn: Boolean(token), endedAtConsole: atConsole });
    if (!token) say(`Not signed in to ${origin}.`);
    else if (atConsole) say(`Signed out of ${origin}.`);
    else say(`Signed out here. ${origin} did not answer, so the sign-in still shows on its My settings: revoke it there.`);
    return EXIT.done;
  }

  async function status(origin) {
    const { entry, store, token } = signedIn(origin);
    if (!token) {
      if (json) emit({ console: origin, signedIn: false });
      say(`Not signed in to ${origin}. Run: woodshed login${origin === DEFAULT_CONSOLE ? '' : ` --console ${origin}`}`);
      return EXIT.waiting;
    }
    const me = await call(origin, '/api/cli/me', { token });
    if (me.status === 401) {
      if (json) emit({ console: origin, signedIn: false, ended: true });
      say(`The sign-in to ${origin} ended: it was revoked, or it expired. Run: woodshed login --console ${origin}`);
      return EXIT.waiting;
    }
    if (me.status !== 200 || !me.body) throw consoleNoCli(origin, me.status);
    const [who, org, name] = [me.body.login, me.body.org, me.body.console].map(plain);
    const about = { name: plain(me.body.token?.name), expiresAt: plain(me.body.token?.expiresAt) };
    if (json) {
      emit({
        console: origin, name: name ?? null, org: org ?? null, signedIn: true, login: who ?? null, store: entry.store,
        ...(store.file ? { credentialsFile: store.file } : {}), expiresAt: about?.expiresAt ?? null, device: about?.name ?? null,
      });
      return EXIT.done;
    }
    const rows = [
      ['Console', `${name ?? ''}${name ? ' ' : ''}(${origin})`],
      ['Org', org ?? 'none yet: the console has no repo'],
      ['Signed in', who ? `@${who}` : 'yes (this console has no GitHub sign-in)'],
      ['Token', `in ${store.label}, until ${about?.expiresAt ? about.expiresAt.slice(0, 10) : 'unknown'}`],
    ];
    for (const [label, value] of rows) say(`${`${label}:`.padEnd(11)}${value}`);
    return EXIT.done;
  }

  // The pipe's own failures exit 255, as ssh's do, so a program that runs it tells them from the line's exit codes.
  async function tunnel(origin, args) {
    const [session, ...extra] = args.args;
    if (!/^[0-9a-f]{8}$/.test(session ?? '') || extra.length || !args.rest?.length) {
      stderr.write('woodshed: usage: woodshed tunnel <session id> -- <line>\n');
      return TUNNEL_FAILED;
    }
    const { token } = signedIn(origin);
    if (!token) {
      stderr.write(`woodshed: not signed in to ${origin}. Run: woodshed login${origin === DEFAULT_CONSOLE ? '' : ` --console ${origin}`}\n`);
      return TUNNEL_FAILED;
    }
    // As ssh does: the words after -- are one line, joined by spaces, for the session's sh -c.
    return runTunnel({ origin, token, session, line: args.rest.join(' '), stdin: deps.stdin ?? process.stdin, stdout, stderr, userAgent: `woodshed-cli/${VERSION}` });
  }

  try {
    const args = parseArgs(argv);
    json = args.json;
    if (args.command === 'session' && args.help) return await sessionCommand({ origin: null, rest: ['help'] }, { stdout, EXIT });
    if (args.help || !args.command || args.command === 'help') {
      stdout.write(`${USAGE}\n`);
      return args.command || args.help ? EXIT.done : EXIT.failed;
    }
    const chosen = args.console ?? env.WOODSHED_CONSOLE ?? readConfig(dir).current ?? DEFAULT_CONSOLE;
    const origin = consoleOrigin(chosen);
    if (args.command === 'login') return await login(origin, { browser: args.browser });
    if (args.command === 'logout') return await logout(origin);
    if (args.command === 'status') return await status(origin);
    if (args.command === 'tunnel') return await tunnel(origin, args);
    if (args.command === 'session') {
      // Its prompt may follow `--`, so a word of it is never read as an option.
      return await sessionCommand({ origin, rest: [...args.args, ...(args.rest ? ['--', ...args.rest] : [])] }, {
        call, token: signedIn(origin).token, stdout, stderr, say, emit, json, sleep, now, EXIT,
        fail: (message, opts) => new CliError(message, opts),
        confirm: deps.confirm ?? ((question) => confirmOnTerminal(question, stderr)),
      });
    }
    throw new CliError(`unknown command ${args.command}\n\n${USAGE}`);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length).includes('tunnel')) {
      stderr.write(`woodshed: ${err.message}\n`);
      return TUNNEL_FAILED;
    }
    if (json) emit({ event: 'error', status: err.status, error: err.message.split('\n')[0] });
    else stderr.write(`woodshed: ${err.message}\n`);
    return err.code;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`woodshed: ${err?.stack ?? err}\n`);
    process.exitCode = EXIT.failed;
  });
}
