// The terminal runtime `woodshed session herdr` adds a session to: Herdr's `hc` (herdr-core), run as a program with
// its documented CLI and --json, never through a shell. A session becomes one of its machines, `woodshed-<id>`, reached
// through `woodshed tunnel <id> --` (tunnel.mjs), so it shows in the Herdr app's sidebar beside this computer.
//
// Nothing here installs or updates hc: a missing or old one is said, and the person decides.

import { execFile } from 'node:child_process';
import { windowsExecutable } from '../shared/windowsExecutable.mjs';

// The oldest hc whose machines, `--via` and `--install` this was checked against (the session image pins the same).
export const HC_MINIMUM = '0.1.21';
// The terminal a session's agent runs in when its owner picked Herdr (session/agentPane.mjs, HC_TERMINAL).
export const AGENT_TERMINAL = 'claude';
// `machine add` dials the session through the console and may copy hc there: give it longer than a plain call.
const ADD_MS = 180_000;
const CALL_MS = 30_000;

/** @returns {string}  the machine a session is in hc */
export function machineName(id) {
  return `woodshed-${id}`;
}

/** @returns {string}  one word for sh: as it is when it has nothing sh reads, else in single quotes */
export function shellQuote(word) {
  const text = String(word);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `--via` line hc keeps for a session's machine: this command line's tunnel, by absolute paths, since hc's core
 * runs it later with its own environment (an app started from the Dock has no shell's PATH). The console is named, so a
 * second console signed in to since never changes where it goes, and so is the config folder when one was set.
 * @param {{node: string, script: string, origin: string, session: string, configHome?: string|null}} args
 * @returns {string}
 */
export function viaCommand({ node, script, origin, session, configHome = null }) {
  const words = [node, script, 'tunnel', '--console', origin, session, '--'].map(shellQuote);
  return [...(configHome ? [`XDG_CONFIG_HOME=${shellQuote(configHome)}`] : []), ...words].join(' ');
}

/** @returns {number}  below 0 when a is older than b */
export function compareVersions(a, b) {
  const parts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/**
 * Runs hc with these arguments and this environment (its HC_SESSION and XDG folders pick the core).
 * @returns {(args: string[], opts?: {timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string, missing?: boolean}>}
 */
export function hcRunner({ bin = 'hc', env = process.env } = {}) {
  return (args, { timeoutMs = CALL_MS } = {}) => new Promise((resolve) => {
    const executable = process.platform === 'win32' ? windowsExecutable(bin, { searchPath: env.PATH ?? env.Path ?? '' }) : bin;
    if (!executable) return resolve({ code: null, stdout: '', stderr: '', missing: true });
    execFile(executable, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT' || err?.code === 'EACCES') return resolve({ code: null, stdout: '', stderr: '', missing: true });
      const code = !err ? 0 : Number.isInteger(err.code) ? err.code : null;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', ...(err?.killed ? { timedOut: true } : {}) });
    });
  });
}

/**
 * @returns {Promise<{installed: boolean, version: string|null, minimum: string, ok: boolean}>}  ok: new enough to add a session
 */
export async function hcVersion(run) {
  const out = await run(['--version'], { timeoutMs: 10_000 });
  if (out.missing) return { installed: false, version: null, minimum: HC_MINIMUM, ok: false };
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(out.stdout)?.[1] ?? null;
  return { installed: true, version, minimum: HC_MINIMUM, ok: out.code === 0 && version !== null && compareVersions(version, HC_MINIMUM) >= 0 };
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// hc's own words for a failure, from its --json error (on either stream), else its last line.
function hcError(out) {
  const answer = parsed(out.stdout.trim()) ?? parsed(out.stderr.trim());
  if (answer?.error?.message) return { kind: String(answer.error.kind ?? ''), message: String(answer.error.message) };
  const last = `${out.stderr}\n${out.stdout}`.trim().split('\n').at(-1) || (out.timedOut ? 'it did not answer in time' : `it exited ${out.code}`);
  return { kind: out.timedOut ? 'timeout' : '', message: last };
}

async function machines(run) {
  const out = await run(['machine', 'ls', '--json']);
  const list = parsed(out.stdout)?.machines;
  if (out.code !== 0 || !Array.isArray(list)) throw Object.assign(new Error(`hc machine ls failed: ${hcError(out).message}`), { hc: true });
  return list.filter((m) => m && typeof m.name === 'string');
}

/** @returns {boolean}  whether a machine's saved line is this command line's tunnel to that session on that console */
export function isTunnelTo(machine, { origin, session }) {
  return machine?.via === true && typeof machine.target === 'string'
    && machine.target.endsWith(` tunnel --console ${shellQuote(origin)} ${session} --`);
}

/**
 * Adds the session's machine, or leaves it as it is when it is already there, connected, through this same line, and
 * not short-lived (`--temp`, which the app's sidebar hides). One found otherwise (another line, or unreachable: a
 * resumed session is a new container, whose hc core hc will not take for the one it knew) is forgotten and added
 * again; its terminals there keep running.
 * @returns {Promise<{action: 'added'|'updated'|'kept', state: string|null}>}
 */
export async function addMachine(run, { name, via }) {
  const found = (await machines(run)).find((m) => m.name === name);
  if (found && found.via === true && found.target === via && found.state === 'connected' && found.temporary !== true) return { action: 'kept', state: 'connected' };
  if (found) {
    const rm = await run(['machine', 'rm', '--json', name]);
    if (rm.code !== 0) throw Object.assign(new Error(`hc could not forget the old ${name}: ${hcError(rm).message}`), { hc: true });
  }
  const add = await run(['machine', 'add', '--json', '--name', name, '--via', via, '--install'], { timeoutMs: ADD_MS });
  if (add.code !== 0) {
    const { kind, message } = hcError(add);
    throw Object.assign(new Error(`hc could not add ${name}: ${message}`), { hc: true, kind });
  }
  const machine = parsed(add.stdout);
  return { action: found ? 'updated' : 'added', state: typeof machine?.state === 'string' ? machine.state : null };
}

/**
 * Whether the session's agent runs in hc there: its terminal is there when the owner picked Herdr on My settings, and
 * absent when the session runs it in tmux.
 * @returns {Promise<{inHerdr: boolean|null, address: string|null}>}  null: hc could not tell
 */
export async function agentOn(run, name) {
  const out = await run(['get', '--json', `${name}/${AGENT_TERMINAL}`]);
  if (out.code === 0) {
    const terminal = parsed(out.stdout);
    return { inHerdr: true, address: typeof terminal?.address === 'string' ? terminal.address : `${name}/${AGENT_TERMINAL}` };
  }
  return { inHerdr: hcError(out).kind === 'not_found' ? false : null, address: null };
}

/**
 * Forgets the session's machine: only one this command line added, whose line is the tunnel to that session on that
 * console, never another machine someone gave the same name.
 * @returns {Promise<boolean>}  whether there was such a machine to forget
 */
export async function removeMachine(run, name, { origin, session }) {
  if (!(await machines(run)).some((m) => m.name === name && isTunnelTo(m, { origin, session }))) return false;
  const rm = await run(['machine', 'rm', '--json', name]);
  if (rm.code !== 0) throw Object.assign(new Error(`hc could not forget ${name}: ${hcError(rm).message}`), { hc: true });
  return true;
}
