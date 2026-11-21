#!/usr/bin/env node
// The woodshed command line: signs in to a Woodshed console, says who is signed in, starts and manages sessions, opens
// a pipe or terminal into a running session, moves work from Herdr into a session, reads and sets choices on My
// settings, and syncs Claude settings.
// Plain Node 22 with no dependencies (cli/README.md).
//
//   woodshed login  [--console <url>] [--no-browser]   a code to approve in the browser, then a token kept in the keychain
//   woodshed logout [--console <url>]                  ends that token at the console and forgets it here
//   woodshed status [--console <url>]                  the console, its org, and who is signed in
//   woodshed tunnel <id> -- <line>                     runs <line> in your session, piped to this terminal (tunnel.mjs)
//   woodshed session connect <id> [--shell]            this terminal on your session's agent, or its shell (terminal.mjs)
//   woodshed session new|list|get|herdr|stop|resume|remove|extend|limits   sessions (sessions.mjs); herdr makes one
//                                                     a machine in Herdr's hc (hc.mjs)
//   woodshed move --from herdr [--terminal T|--tab T|--space S] --to <id>|new   terminals moved into a session (move.mjs)
//   woodshed review enable|status                      review this checkout's pull requests in Woodshed sessions (review.mjs)
//   woodshed config list|get|set                       your choices on My settings, never a secret (config.mjs)
//   woodshed settings plan|push|pull [...]            Claude settings and a checkout's ignored files (settings.mjs)
//
// Every command takes --json. Exit codes: 0 done, 2 waiting on a person (a sign-in or an approval), 3 refused, 1 any
// other failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCredentials } from './credentials.mjs';
import { reviewCommand } from './review.mjs';
import { runTunnel, TUNNEL_FAILED } from './tunnel.mjs';
import { sessionCommand } from './sessions.mjs';
import { repoCommand } from './repos.mjs';
import { configCommand } from './config.mjs';
import { hcRunner, hcVersion, viaCommand } from './hc.mjs';
import { moveCommand } from './move.mjs';
import { programRunner } from './moveLayout.mjs';
import { gitRunner } from './moveCode.mjs';
import { settingsCommand } from './settings.mjs';
import { setupCommand, SETUP_USAGE } from './setup.mjs';
import { attach, openTerminal } from './terminal.mjs';

export const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const DEFAULT_CONSOLE = 'https://console.woodshed.run';
// Each call to the console, its answer read included.
const REQUEST_MS = 20_000;
export const EXIT = Object.freeze({ done: 0, failed: 1, waiting: 2, refused: 3 });

// Commands that read their own options: what follows them, but --console, --json and --help, is theirs (in `args`).
const OWN_ARGS = new Set(['session', 'move', 'config', 'repo', 'settings', 'setup']);

const USAGE = `Usage: woodshed <command> [--console <url>] [--json]

Commands:
  setup     get signed in, choose repos and reviews, and start your first session
  login     sign in to a Woodshed console: approve the code it shows in your browser; --no-wait returns before approval
  logout    sign out of the console, here and at the console
  status    the console, its org, who is signed in, and the hc found here (Herdr's, for session herdr)
  repo      list, add and remove repos: woodshed repo --help
  tunnel <id> -- <line>
            run <line> in your running session, with this command's stdin, stdout and stderr; exits with its
            exit code, or 255 when the pipe could not open or broke
  session   start, list, connect to, add to Herdr, stop, resume and remove sessions, and give them more time:
            woodshed session --help
  move      move work into a session from a supported source: woodshed move --help
  review    review this checkout's pull requests in Woodshed sessions: woodshed review --help
  config    your choices on My settings (terminal, reviews, default repo, …), never a secret: woodshed config --help
  settings  plan|push|pull [--only <what>,...] [--own-files <checkout>] [--replace]
            sync your Claude settings and ignored checkout files with private sessions. MCP definitions
            pushed from a computer stay between computers. plan lists items and sends nothing

Options:
  --console <url>  the console to use (default: the one you last signed in to, else ${DEFAULT_CONSOLE};
                   WOODSHED_CONSOLE sets it too)
  --no-browser     print addresses to open instead of opening them
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
 *            commands that parse their own options, `args` includes those options. `rest` can hold a session's prompt,
 *            a config value, or a tunnel command.
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
    else if (out.command === 'review' && arg !== '--console' && !arg.startsWith('--console=')) out.args.push(arg);
    else if (arg === '--console') {
      if (!argv[i + 1]) throw new CliError('--console needs a URL');
      out.console = argv[++i];
    } else if (arg.startsWith('--console=')) out.console = arg.slice('--console='.length);
    else if (out.command === 'setup' && arg === '--prompt') {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('--') || value === '-h') throw new CliError('--prompt needs text. For a prompt that starts with an option, use --prompt=TEXT.');
      out.args.push(arg, value);
    } else if (OWN_ARGS.has(out.command)) out.args.push(arg);
    else if (out.command === 'login' && arg === '--no-wait') out.args.push(arg);
    else if (arg.startsWith('-')) throw new CliError(`unknown option ${arg}\n\n${USAGE}`);
    else if (!out.command) out.command = arg;
    else if (out.command === 'tunnel') out.args.push(arg);
    else throw new CliError(`unexpected ${arg}\n\n${USAGE}`);
  }
  return out;
}

/**
 * The command word of argv, for when parseArgs refuses it: the first word that is not an option or --console's value.
 * @returns {string|null}
 */
function commandWord(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return null;
    if (argv[i] === '--console') i++;
    else if (!argv[i].startsWith('-')) return argv[i];
  }
  return null;
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

// On Windows, %LOCALAPPDATA%\woodshed: the local folder, not %APPDATA%, which a roaming profile copies to a server at
// each sign-out, token and all. XDG_CONFIG_HOME is a Unix convention, and not read there: a token is kept only in that
// folder on Windows (credentials.mjs), and cli.json beside it.
function configDir(env, platform) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'woodshed');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'woodshed');
  return path.join(os.homedir(), '.config', 'woodshed');
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

// This command line as hc's core will run it for a session's machine (hc.mjs, viaCommand): node and this script by
// absolute paths, since the core has its own PATH. A path on the PATH that leads to the same node is kept over its real
// one (Homebrew's /opt/homebrew/bin/node over its Cellar's), so the line outlives an upgrade; so is the script's own
// link, when it was run by one (~/.local/bin/woodshed).
export function selfCommand({ execPath = process.execPath, argv1 = process.argv[1], env = process.env } = {}) {
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return null;
    }
  };
  const script = fileURLToPath(import.meta.url);
  const nodeReal = real(execPath);
  const onPath = String(env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, 'node')).find((file) => nodeReal && real(file) === nodeReal);
  const linked = argv1 && path.isAbsolute(argv1) && real(argv1) === real(script) ? argv1 : null;
  return { node: onPath ?? execPath, script: linked ?? script };
}

// Open a checked web address without a shell. On Windows, use the full System32 path to rundll32.
export function browserCommand(url, platform, env = process.env) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return [path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openBrowser(url, platform) {
  const [command, args] = browserCommand(url, platform);
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
  const stdin = deps.stdin ?? process.stdin;
  const stderr = deps.stderr ?? process.stderr;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const dir = configDir(env, platform);
  const credentials = deps.credentials ?? createCredentials({ platform, dir });
  const pendingSignIns = () => deps.pendingCredentials ?? createCredentials({ platform, dir, pending: true });
  const open = deps.openBrowser ?? ((url) => openBrowser(url, platform));
  // Herdr's hc, as the person's shell finds it, on the core their environment names (HC_SESSION and the XDG folders).
  const hc = deps.hc ?? hcRunner({ bin: env.WOODSHED_HC_BIN || 'hc', env });
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
    return { status: res.status, body: answer, retryAfter: res.headers.get('retry-after') };
  }

  // Too many sign-ins waiting, from this address or on the whole console: said here, with the console's Retry-After as a
  // wait in minutes, so a console's text never decides what is printed.
  function busy(origin, answer) {
    const seconds = /^\d{1,6}$/.test(String(answer.retryAfter ?? '').trim()) ? Number(answer.retryAfter) : null;
    const minutes = seconds ? Math.min(60, Math.ceil(seconds / 60)) : null;
    const later = minutes ? `in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'in a few minutes';
    // Sign-ins from this address left unanswered (a login stopped part way) wait out their 10 minutes at the console.
    if (answer.body?.scope === 'client') return new CliError(`Too many sign-ins from this address are waiting at ${origin}. Try again ${later}.`, { status: 'busy' });
    return new CliError(`${origin} has too many sign-ins waiting. Try again ${later}.`, { status: 'busy' });
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

  async function login(origin, { browser, noWait }) {
    const before = signedIn(origin);
    const pending = noWait ? pendingSignIns() : null;
    let { store: pendingStore, token: saved } = pending?.find(origin) ?? {};
    let [deviceCode, userCode, expiry] = saved?.slice(4).split('.') ?? [];
    let expiresAt = Number(expiry);
    let wait = 0;
    function showCode(openPage) {
      const verificationUrlComplete = approvalUrl(origin, userCode);
      if (!verificationUrlComplete) throw consoleNoCli(origin, 200);
      if (json) emit({ event: 'code', console: origin, userCode, verificationUrl: `${origin}/cli`, verificationUrlComplete, expiresAt: new Date(expiresAt).toISOString() });
      say(`Your code: ${userCode}`);
      say(openPage ? `Opening ${verificationUrlComplete}` : `Open ${verificationUrlComplete}`);
      say(`Check the page shows the same code, then press Sign in the CLI. ${noWait ? 'Then run woodshed login --no-wait again.' : 'Waiting…'}`);
      if (openPage) open(verificationUrlComplete);
    }
    async function start() {
      const started = await call(origin, '/api/cli/device', { method: 'POST', body: { name: deps.hostname ?? os.hostname() } });
      if (started.status === 429) throw busy(origin, started);
      if (started.status !== 200 || !/^[0-9a-f]{64}$/.test(started.body?.deviceCode ?? '') || !approvalUrl(origin, started.body?.userCode)) {
        throw consoleNoCli(origin, started.status);
      }
      ({ deviceCode, userCode } = started.body);
      const { expiresIn, interval } = started.body;
      const lasts = Number(expiresIn) > 0 ? Math.min(Number(expiresIn), 600) : 600;
      expiresAt = Math.floor(now() + lasts * 1000);
      wait = Math.max(1, Number(interval) || 5) * 1000;
      if (pending) {
        try {
          pending.save(origin, `wsd_${deviceCode}.${userCode}.${expiresAt}`);
        } catch {
          throw new CliError('This computer could not keep the pending sign-in. Run woodshed login and leave it open while you approve.');
        }
      }
      showCode(browser);
      return EXIT.waiting;
    }
    if (!saved || now() >= expiresAt) {
      pendingStore?.remove(origin);
      await start();
      if (noWait) return EXIT.waiting;
    }
    for (;;) {
      if (wait) await sleep(wait);
      if (now() >= expiresAt) break;
      let polled;
      try {
        polled = await call(origin, '/api/cli/token', { method: 'POST', body: { deviceCode }, timeoutMs: expiresAt - now() });
      } catch (err) {
        if (noWait) throw err;
        // A network that drops while the person approves (a laptop's Wi-Fi) is asked again until the code expires.
        if (!json) stderr.write(`woodshed: ${err.message}; trying again\n`);
        continue;
      }
      if (noWait && (polled.status === 202 || polled.status === 429)) {
        showCode(false);
        return EXIT.waiting;
      }
      if (polled.status === 202) continue;
      if (polled.status === 429) {
        wait += 5000;
        continue;
      }
      if (polled.status === 403 || polled.status === 410) {
        pendingStore?.remove(origin);
        if (polled.status === 403) throw new CliError('The sign-in was denied in the browser.', { code: EXIT.refused, status: 'denied' });
        if (noWait) return start();
        break;
      }
      if (polled.status !== 200 || !polled.body?.token) throw consoleNoCli(origin, polled.status);
      const { token, id } = polled.body;
      const [who, org, name, tokenExpiresAt] = [polled.body.login, polled.body.org, polled.body.console, polled.body.expiresAt].map(plain);
      if (!/^wsc_[0-9a-f]{64}$/.test(String(token))) throw consoleNoCli(origin, polled.status);
      let store;
      try {
        store = credentials.save(origin, token);
      } catch (err) {
        // Nothing here can use it: it is ended at the console, so no sign-in is left there for nobody.
        const out = await call(origin, '/api/cli/logout', { method: 'POST', token }).catch(() => null);
        const ended = out?.status === 200 || out?.status === 401;
        throw new CliError(`Signed in, but the token could not be kept: ${err.message}. ${ended ? 'It was ended at the console.' : 'Revoke this sign-in on My settings, under Command line.'}`);
      }
      const config = readConfig(dir);
      config.current = origin;
      config.consoles[origin] = { login: who ?? null, store: store.kind, tokenId: id, signedInAt: new Date(now()).toISOString() };
      writeConfig(dir, config);
      // A successful ordinary login also supersedes an earlier setup awaiting approval.
      pendingSignIns().remove(origin);
      // The token this computer held before is ended at the console, so My settings lists one sign-in for it.
      let earlierEnded = null;
      if (before.token && before.token !== token) {
        const out = await call(origin, '/api/cli/logout', { method: 'POST', token: before.token }).catch(() => null);
        earlierEnded = out?.status === 200 || out?.status === 401;
      } else if (!before.token && before.store?.holds?.(origin)) {
        // One kept here that could not be read (sealed for a desktop sign-in, read over SSH): nothing can end it here.
        earlierEnded = false;
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
    pendingSignIns().remove(origin);
    if (!token && store?.holds?.(origin)) {
      // Kept here but not readable now (sealed with DPAPI at a desktop sign-in, and this is an SSH one, which DPAPI
      // cannot open): left as it is, so a sign-out where it can be read still ends it at the console.
      if (json) emit({ event: 'signed-out', console: origin, wasSignedIn: true, endedAtConsole: false, unreadable: true });
      say(`This computer's sign-in to ${origin} could not be read here (${store.label}), so it was left as it is. Sign out where you signed in, or revoke it on My settings, under Command line.`);
      return EXIT.refused;
    }
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
    // Said whether or not anyone is signed in: whether session herdr can run here.
    const herdr = await hcVersion(hc);
    const herdrText = !herdr.installed ? `not found: session herdr needs hc ${herdr.minimum} or newer`
      : herdr.ok ? `hc ${herdr.version}` : `hc ${herdr.version ?? '(no version)'}, older than the ${herdr.minimum} session herdr needs: hc update`;
    if (!token) {
      if (json) emit({ console: origin, signedIn: false, hc: herdr });
      say(`Not signed in to ${origin}. Run: woodshed login${origin === DEFAULT_CONSOLE ? '' : ` --console ${origin}`}`);
      say(`${'Herdr:'.padEnd(11)}${herdrText}`);
      return EXIT.waiting;
    }
    const me = await call(origin, '/api/cli/me', { token });
    if (me.status === 401) {
      if (json) emit({ console: origin, signedIn: false, ended: true, hc: herdr });
      say(`The sign-in to ${origin} ended: it was revoked, or it expired. Run: woodshed login --console ${origin}`);
      say(`${'Herdr:'.padEnd(11)}${herdrText}`);
      return EXIT.waiting;
    }
    if (me.status !== 200 || !me.body) throw consoleNoCli(origin, me.status);
    const [who, org, name] = [me.body.login, me.body.org, me.body.console].map(plain);
    const about = { name: plain(me.body.token?.name), expiresAt: plain(me.body.token?.expiresAt) };
    if (json) {
      emit({
        console: origin, name: name ?? null, org: org ?? null, signedIn: true, login: who ?? null, store: entry.store,
        ...(store.file ? { credentialsFile: store.file } : {}), expiresAt: about?.expiresAt ?? null, device: about?.name ?? null, hc: herdr,
        ...(me.body.sessionSignIns ? { sessionSignIns: { claude: me.body.sessionSignIns.claude === true, codex: me.body.sessionSignIns.codex === true } } : {}),
      });
      return EXIT.done;
    }
    const rows = [
      ['Console', `${name ?? ''}${name ? ' ' : ''}(${origin})`],
      ['Org', org ?? 'none yet: the console has no repo'],
      ['Signed in', who ? `@${who}` : 'yes (this console has no GitHub sign-in)'],
      ['Token', `in ${store.label}, until ${about?.expiresAt ? about.expiresAt.slice(0, 10) : 'unknown'}`],
      ['Herdr', herdrText],
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
    return runTunnel({ origin, token, session, line: args.rest.join(' '), stdin, stdout, stderr, userAgent: `woodshed-cli/${VERSION}` });
  }

  // The command as typed, for the catch below: only the tunnel's failures exit 255, whatever the other commands' words.
  let command = commandWord(argv);
  try {
    const args = parseArgs(argv);
    command = args.command;
    json = args.json;
    if (args.command === 'setup' && args.help) { stdout.write(`${SETUP_USAGE}\n`); return EXIT.done; }
    if (args.command === 'repo' && args.help) return repoCommand(args, { stdout, EXIT });
    if (args.command === 'session' && args.help) return await sessionCommand({ origin: null, rest: ['help'] }, { stdout, EXIT });
    if (args.command === 'move' && args.help) return await moveCommand({ origin: null, rest: ['help'] }, { stdout, EXIT });
    if (args.command === 'review' && args.help) return await reviewCommand({ origin: null, rest: ['help'] }, { stdout, EXIT });
    if (args.command === 'config' && args.help) return await configCommand({ origin: null, rest: ['help'] }, { stdout, EXIT });
    if (args.help || !args.command || args.command === 'help') {
      stdout.write(`${USAGE}\n`);
      return args.command || args.help ? EXIT.done : EXIT.failed;
    }
    const chosen = args.console ?? env.WOODSHED_CONSOLE ?? readConfig(dir).current ?? DEFAULT_CONSOLE;
    const origin = consoleOrigin(chosen);
    if (args.command === 'login') return await login(origin, { browser: args.browser, noWait: args.args.includes('--no-wait') });
    if (args.command === 'setup') return await setupCommand({ ...args, origin }, { env, stdout, stderr, open, EXIT, emit, say, fail: (message) => new CliError(message), self: deps.self ?? selfCommand({ env }), platform });
    if (args.command === 'logout') return await logout(origin);
    if (args.command === 'status') return await status(origin);
    if (args.command === 'tunnel') return await tunnel(origin, args);
    if (args.command === 'repo') return await repoCommand({ ...args, origin }, {
      stdout, call, token: signedIn(origin).token, open, isTerminal: deps.isTerminal ?? Boolean(stdout.isTTY), json, emit, say, EXIT,
      fail: (message, opts) => new CliError(message, opts),
    });
    if (args.command === 'session' || args.command === 'move') {
      // The session prompt may follow `--`, so a word of it is never read as an option.
      const moving = args.command === 'move';
      const command = moving ? moveCommand : sessionCommand;
      const rest = [...args.args, ...(args.rest ? ['--', ...args.rest] : [])];
      return await command({ origin, rest }, {
        call, ...(moving ? { getToken: () => signedIn(origin).token } : { token: signedIn(origin).token }),
        stdout, stderr, say, emit, json, sleep, now, EXIT, platform, hc,
        // The line hc keeps for a session's machine: this command line's tunnel into it, on this console.
        // A relative config folder is made absolute: hc's core runs the line from a folder of its own.
        // This terminal on the session's, once: closed, detached, refused, unreachable, or cut once it was open.
        tty: Boolean(stdin.isTTY && stdout.isTTY),
        terminal: deps.terminal ?? (async (session, kind) => {
          const size = { columns: stdout.columns || 80, rows: stdout.rows || 24 };
          const opened = await openTerminal({ origin, token: signedIn(origin).token, session, kind, size, userAgent: `woodshed-cli/${VERSION}` });
          if (opened.refused) return { status: 'refused', http: opened.refused.status, message: opened.refused.message };
          if (opened.unreachable) return { status: 'unreachable', message: opened.unreachable };
          const openedAt = now();
          const out = await attach({ socket: opened.socket, head: opened.head, stdin, stdout });
          return out.status === 'cut' ? { status: 'attached-then-cut', message: out.message, ms: now() - openedAt } : out;
        }),
        via: (session) => viaCommand({ ...(deps.self ?? selfCommand({ env })), origin, session, configHome: env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : null }),
        fail: (message, opts) => new CliError(message, opts),
        confirm: deps.confirm ?? ((question) => confirmOnTerminal(question, stderr)),
        // move's own: the Herdr app, git, and `session connect` to call.
        // hc as move runs it, with what is piped to it (hc file write).
        ...(moving && !deps.hc ? { hc: programRunner({ bin: env.WOODSHED_HC_BIN || 'hc', env }) } : {}),
        app: deps.app ?? programRunner({ bin: env.WOODSHED_HERDR_APP_BIN || 'herdr-app', env }), git: deps.git ?? gitRunner({ env }), env,
        hostname: deps.hostname ?? os.hostname(), session: sessionCommand, ...(deps.moveId ? { moveId: deps.moveId } : {}),
      });
    }
    if (args.command === 'review') {
      return await reviewCommand({ origin, rest: args.args }, {
        call, token: signedIn(origin).token, stdout, say, emit, json, EXIT, cwd: deps.cwd, fail: (message, opts) => new CliError(message, opts),
      });
    }
    if (args.command === 'config') {
      // A value may follow `--`, so one that starts with - is never read as an option.
      return await configCommand({ origin, rest: [...args.args, ...(args.rest ?? [])] }, {
        call, token: signedIn(origin).token, stdout, say, emit, json, EXIT, fail: (message, opts) => new CliError(message, opts),
      });
    }
    if (args.command === 'settings') {
      const { token } = signedIn(origin);
      if (!token) throw new CliError(`Not signed in to ${origin}. Run: woodshed login${origin === DEFAULT_CONSOLE ? '' : ` --console ${origin}`}`, { code: EXIT.waiting, status: 'signed-out' });
      return await settingsCommand({
        rest: args.args, origin, token, dir, env, json, call, say, emit, EXIT, home: deps.home, interactive: deps.interactive, ask: deps.ask,
        warn: (text) => stderr.write(`woodshed: ${text}\n`), fail: (message, opts) => new CliError(message, opts),
      });
    }
    throw new CliError(`unknown command ${args.command}\n\n${USAGE}`);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (command === 'tunnel') {
      stderr.write(`woodshed: ${err.message}\n`);
      return TUNNEL_FAILED;
    }
    if (json) emit({ event: 'error', status: err.status, error: err.message.split('\n')[0] });
    else stderr.write(`woodshed: ${err.message}\n`);
    return err.code;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `woodshed session list | head`: a reader that stops early is no failure of this command. Not the tunnel's: a reader
  // that goes away cuts its pipe, which tunnel.mjs answers itself, with 255.
  let command = null;
  try {
    ({ command } = parseArgs(process.argv.slice(2)));
  } catch {
    // Said by main below.
  }
  if (command !== 'tunnel') {
    process.stdout.on('error', (err) => {
      if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw err;
    });
  }
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`woodshed: ${err?.stack ?? err}\n`);
    process.exitCode = EXIT.failed;
  });
}
