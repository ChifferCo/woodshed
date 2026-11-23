// The terminal runtime `woodshed session herdr` adds a session to: Herdr's `hc` (herdr-core), run as a program with
// its documented CLI and --json, never through a shell. A session becomes one of its machines, `woodshed-<id>`, reached
// through `woodshed tunnel <id> --` (tunnel.mjs), so it shows in the Herdr app's sidebar beside this computer.
//
// Nothing here installs or updates hc: a missing or old one is said, and the person decides.

import { execFile } from 'node:child_process';
import path from 'node:path';

import { failureOf } from './moveLayout.mjs';
import { windowsExecutable } from '../shared/windowsExecutable.mjs';

// The oldest hc whose machines, `--via` and `--install` this was checked against (the session image pins the same).
export const HC_MINIMUM = '0.1.21';
// The terminal a session's agent runs in when its owner picked Herdr (session/agentPane.mjs, HC_TERMINAL).
export const AGENT_TERMINAL = 'claude';
// Where a session started with a parent (`session new --herdr --parent`) says it waits for its agent's terminal: the
// entrypoint writes it (startHerdr) and takes it away once the terminal is there, or once it stopped waiting.
export const AGENT_WAIT_FILE = '/tmp/woodshed-agent-terminal.json';
// `machine add` dials the session through the console and may copy hc there: give it longer than a plain call.
const ADD_MS = 180_000;
const CALL_MS = 30_000;

/**
 * The Woodshed session this command line runs inside, if any: SESSION_ID (the launcher's, which the entrypoint requires)
 * and WOODSHED_TERMINAL (which the entrypoint exports before the agent starts, so the agent and what it runs have it),
 * both set as the entrypoint sets them. Inside one, `hc` reaches the session container's own Herdr core, never the
 * person's computer's: a machine added there is nested in a machine, which the computer's Herdr sidebar never shows.
 * @returns {string|null}  the session's id
 */
export function sessionHere(env = {}) {
  const id = typeof env.SESSION_ID === 'string' ? env.SESSION_ID : '';
  return /^[0-9a-f]{8}$/.test(id) && ['tmux', 'herdr'].includes(env.WOODSHED_TERMINAL) ? id : null;
}

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

/**
 * What hc runs for `session watch --herdr`: this command line's watch, by absolute paths as `--via` names them, through
 * `/usr/bin/env` so its environment says it is the copy that reports (sessions.mjs, WATCH_IN_HERDR), and names the config
 * folder when one was set. Never a shell line: hc runs it as these words.
 * @param {{node: string, script: string, origin: string, flags: string[], configHome?: string|null}} args
 * @returns {string[]}
 */
export function watcherArgv({ node, script, origin, flags, configHome = null }) {
  return ['/usr/bin/env', 'WOODSHED_WATCH_IN_HERDR=1', ...(configHome ? [`XDG_CONFIG_HOME=${configHome}`] : []),
    node, script, 'session', 'watch', '--console', origin, ...flags];
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
export function hcRunner({ bin = 'hc', env: base = process.env } = {}) {
  // `env`: variables over the environment's for this one call (HC_TERMINAL_ID, for the parent of a terminal it starts).
  return (args, { timeoutMs = CALL_MS, env: over = null } = {}) => new Promise((resolve) => {
    const env = over ? { ...base, ...over } : base;
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
    // Added meanwhile by another run of this command line through the same line (`session watch --add` and
    // `session new --herdr` both add a session as it starts running): that one stands.
    const now = await machines(run).then((list) => list.find((m) => m.name === name), () => null);
    if (now && now.via === true && now.target === via && now.state === 'connected') return { action: 'kept', state: 'connected' };
    throw Object.assign(new Error(`hc could not add ${name}: ${message}`), { hc: true, kind });
  }
  const machine = parsed(add.stdout);
  return { action: found ? 'updated' : 'added', state: typeof machine?.state === 'string' ? machine.state : null };
}

/**
 * Find the session's agent in hc. When requested, give an unplaced agent a space and tab for the app to show.
 * @returns {Promise<{inHerdr: boolean|null, address: string|null, placementError?: string}>}  null: hc could not tell
 */
export async function agentOn(run, name, { place = false } = {}) {
  const out = await run(['get', '--json', `${name}/${AGENT_TERMINAL}`]);
  if (out.code !== 0) return { inHerdr: hcError(out).kind === 'not_found' ? false : null, address: null };
  const terminal = parsed(out.stdout);
  const reported = typeof terminal?.address === 'string' ? terminal.address : AGENT_TERMINAL;
  const address = reported.startsWith(`${name}/`) ? reported : `${name}/${reported}`;
  const agent = { inHerdr: true, address };
  if (place && terminal && terminal.state !== 'finished' && !terminal.labels?.['herdr.space'] && !terminal.labels?.['herdr.tab']) {
    // Stable ids let the app adopt the terminal again when the machine reconnects.
    const labels = await run(['label', '--json', address, `herdr.space=${name}`, `herdr.tab=${name}-agent`]);
    if (labels.code !== 0) return { ...agent, placementError: hcError(labels).message };
  }
  return agent;
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

/**
 * The machines this command line added for sessions on that console that are no longer on its list: a session removed
 * on the console's page, or cleaned up by the console, whose machine nothing forgot. Only a machine named
 * `woodshed-<id>` whose saved line is this command line's tunnel to that same session on that console; a paused or
 * stopped session is still on the list, so its machine stays for `session herdr` to bring back.
 * @param {(id: string) => boolean} exists  whether the console still lists a session by that id
 * @returns {Promise<{name: string, session: string, state: string|null}[]>}
 */
export async function leftoverMachines(run, { origin, exists }) {
  const out = [];
  for (const m of await machines(run)) {
    const session = /^woodshed-([0-9a-f]{8})$/.exec(m.name)?.[1];
    if (!session || exists(session) || !isTunnelTo(m, { origin, session })) continue;
    out.push({ name: m.name, session, state: typeof m.state === 'string' ? m.state : null });
  }
  return out;
}

/**
 * The sessions on that console that are machines in Herdr, added by this command line: `woodshed-<id>` whose saved line
 * is its tunnel to that session. What `session watch` checks when a session pauses or stops, to say its machine is
 * unreachable until `session herdr` brings it back.
 * @returns {Promise<Map<string, string>>}  each session's machine name, by session id
 */
export async function tunnelMachines(run, { origin }) {
  const out = new Map();
  for (const m of await machines(run)) {
    const session = /^woodshed-([0-9a-f]{8})$/.exec(m.name)?.[1];
    if (session && isTunnelTo(m, { origin, session })) out.set(session, m.name);
  }
  return out;
}

// The hc terminal `session watch --herdr` runs in, reporting each session as an OSC 7501 record, and where the Herdr app
// shows it.
export const WATCH_TERMINAL = 'woodshed-watch';
export const WATCH_SPACE = 'woodshed';

/**
 * Starts the watch in a terminal of hc's own, with no parent, so it runs on once this command returns, in a space the
 * Herdr app shows. One already running under that name is left as it is.
 * @param {string[]} argv  the command line's own, from the program on
 * @returns {Promise<{action: 'started'|'kept', address: string|null}>}
 */
export async function startWatcher(run, argv) {
  const out = await run(['run', '--bg', '--json', '--name', WATCH_TERMINAL, '--no-parent',
    '--label', `herdr.space=${WATCH_SPACE}`, '--label', `herdr.tab=${WATCH_TERMINAL}`, '--', ...argv]);
  if (out.code === 0) return { action: 'started', address: parsed(out.stdout)?.address ?? null };
  const { kind, message } = hcError(out);
  if (kind === 'name_taken') return { action: 'kept', address: null };
  throw Object.assign(new Error(`hc could not start ${WATCH_TERMINAL}: ${message}`), { hc: true, kind });
}

// Labels on the agent's terminal holding the names this command line last gave its space and tab, so a later run can
// tell a name of its own (which a later title replaces) from one the person gave (which it never touches).
export const NAMED_SPACE_LABEL = 'woodshed.space-name';
export const NAMED_TAB_LABEL = 'woodshed.tab-name';
// The app's window learns of a terminal adopted by its labels a moment after they are written.
const WINDOW_TRIES = 20;
const WINDOW_WAIT_MS = 250;

/**
 * Names the Herdr space the session's agent is in after the session's title, and its tab after the agent, with the Herdr
 * app's own commands (`herdr-app ls`, `herdr-app do space.rename`, `tab.rename`). A space or tab is renamed only while
 * it has Herdr's default name (none, the checkout's folder, or a tab's number) or the name this command line gave it
 * last: never one the person renamed. With no herdr-app, or no window open, nothing is named and nothing is said.
 * @param {{machine: string, address: string, title: string|null, agent: string, sleep: (ms: number) => Promise<void>}} args
 * @returns {Promise<{space: string|null, tab: string|null, error?: string}>}  the names given now (null: left as it was)
 */
export async function nameAgentPlace(hc, app, { machine, address, title, agent, sleep }) {
  const none = { space: null, tab: null };
  const qualified = (id) => (String(id).startsWith(`${machine}/`) ? String(id) : `${machine}/${id}`);
  const got = await hc(['get', '--json', address]);
  const terminal = got.code === 0 ? parsed(got.stdout) : null;
  if (!terminal) return none;
  const labels = terminal.labels && typeof terminal.labels === 'object' ? terminal.labels : {};
  // Where the window shows the agent: waited for, since it adopts a newly labelled terminal a moment later.
  let place = null;
  for (let i = 0; i < WINDOW_TRIES && !place; i++) {
    if (i) await sleep(WINDOW_WAIT_MS);
    const ls = await app(['ls'], { timeoutMs: 10_000 });
    if (ls.missing || ls.code !== 0) return none;
    const spaces = parsed(ls.stdout)?.spaces;
    for (const space of Array.isArray(spaces) ? spaces : []) {
      for (const tab of Array.isArray(space?.tabs) ? space.tabs : []) {
        const shown = (Array.isArray(tab?.terminals) ? tab.terminals : []).some((t) => t && (t.terminal === address || qualified(t.terminal ?? '') === address));
        if (shown && typeof space.id === 'string' && typeof tab.id === 'string') place = { space, tab };
      }
    }
  }
  if (!place) return none;
  const nameOf = (x) => (typeof x.name === 'string' ? x.name : '');
  const folders = new Set([place.space.folder, terminal.cwd].filter((f) => typeof f === 'string' && f).map((f) => path.posix.basename(f)));
  const spaceFree = (n) => n === '' || folders.has(n) || n === labels[NAMED_SPACE_LABEL];
  const tabFree = (n) => /^\d*$/.test(n) || n === labels[NAMED_TAB_LABEL];
  const out = { ...none };
  const rename = async (command, id, name, label) => {
    const done = await app(['do', command, JSON.stringify({ id: qualified(id), name })], { timeoutMs: 30_000 });
    const answer = parsed(done.stdout);
    if (done.missing) return false;
    if (done.code !== 0 || !answer || answer.error) throw new Error(`herdr-app ${command}: ${failureOf(done)}`);
    const marked = await hc(['label', '--json', address, `${label}=${name}`]);
    if (marked.code !== 0) throw new Error(`hc label ${address}: ${hcError(marked).message}`);
    return true;
  };
  try {
    const spaceName = nameOf(place.space);
    if (title && spaceName !== title && spaceFree(spaceName) && await rename('space.rename', place.space.id, title, NAMED_SPACE_LABEL)) out.space = title;
    const tabName = nameOf(place.tab);
    if (tabName !== agent && tabFree(tabName) && await rename('tab.rename', place.tab.id, agent, NAMED_TAB_LABEL)) out.tab = agent;
  } catch (err) {
    return { ...out, error: err.message };
  }
  return out;
}

/**
 * The terminal here that `--parent` names: the one this command line runs in (HC_TERMINAL_ID) when it names none, else
 * a terminal of this computer's by its address or name. hc takes a parent on another machine only from its caller, so
 * this command line must run in a Herdr terminal either way.
 * @param {(args: string[]) => Promise<object>} run
 * @param {{env: object, named?: string|null}} args
 * @returns {Promise<string>}  its address on this computer's core: `t7`
 * @throws {Error & {hc?: boolean, usage?: boolean}}
 */
export async function parentTerminal(run, { env, named = null }) {
  const own = typeof env.HC_TERMINAL_ID === 'string' ? env.HC_TERMINAL_ID.trim() : '';
  if (!own) {
    throw Object.assign(new Error('--parent needs this command line to run in a Herdr terminal (HC_TERMINAL_ID is not set): hc gives a session\'s terminal a parent here only when it is asked from one'), { usage: true });
  }
  if (!named) return own;
  if (named.includes('/')) throw Object.assign(new Error(`--parent names a terminal on this computer, and ${named} is on a machine`), { usage: true });
  const out = await run(['get', '--json', '--', named]);
  const terminal = parsed(out.stdout);
  if (out.code !== 0 || typeof terminal?.address !== 'string') {
    throw Object.assign(new Error(`hc found no terminal ${named} here: ${hcError(out).message}`), { hc: true, usage: hcError(out).kind === 'not_found' });
  }
  if (terminal.state && terminal.state !== 'live') throw Object.assign(new Error(`${named} is ${terminal.state}: a parent must be a live terminal`), { usage: true });
  return terminal.address;
}

/**
 * The session's agent's terminal, made from here as a child of `parent`, when the session waits for one: started with
 * `--parent`, it makes no terminal of its own, and types its agent into the one this makes, as into its own. The
 * terminal is the one the entrypoint makes otherwise (a kept login shell, named `claude`, in the checkout), on the
 * session's core and in its environment, with a parent here.
 * @param {(args: string[], opts?: object) => Promise<object>} run
 * @param {{machine: string, parent: string, notify?: boolean, outlive?: boolean}} args
 * @returns {Promise<{made: true, address: string, parent: string|null}|{made: false, why: 'not-waiting'|'taken', there: boolean, parent: string|null}>}
 *   not-waiting: the session made its terminal itself (started without --parent, an image from before it, or its wait
 *   ran out), or a run of this made it already; taken: it was made while this was on its way. `parent`, then: the one
 *   the terminal there has (as the session's core names it, `<core>/t7`), null for none or not read; `there`: false
 *   when the session has no agent's terminal in Herdr at all (its agent runs in tmux)
 */
export async function startAgentTerminal(run, { machine, parent, notify = true, outlive = true }) {
  // The terminal already there: its parent as it is, never assumed.
  const existing = async (why) => {
    const got = await run(['get', '--json', `${machine}/${AGENT_TERMINAL}`]);
    const terminal = got.code === 0 ? parsed(got.stdout) : null;
    // Not there at all: a session that never waited runs its agent in tmux (Agent terminal on My settings).
    return { made: false, why, there: Boolean(terminal), parent: typeof terminal?.parent === 'string' ? terminal.parent : null };
  };
  const read = await run(['file', 'read', '--json', '--on', machine, AGENT_WAIT_FILE]);
  if (read.code !== 0) {
    if (hcError(read).kind === 'not_found') return existing('not-waiting');
    throw Object.assign(new Error(`hc could not read whether ${machine} waits for its agent's terminal: ${hcError(read).message}`), { hc: true });
  }
  const waiting = parsed(parsed(read.stdout)?.text ?? '');
  if (typeof waiting?.cwd !== 'string' || !waiting.cwd.startsWith('/')) {
    throw Object.assign(new Error(`${machine}'s ${AGENT_WAIT_FILE} does not say where its agent works`), { hc: true });
  }
  const name = typeof waiting.terminal === 'string' && /^[a-z0-9_-]{1,32}$/.test(waiting.terminal) ? waiting.terminal : AGENT_TERMINAL;
  const args = ['run', '--json', '--bg', '--on', machine, '--keep', '--name', name, '--cwd', waiting.cwd,
    ...(outlive ? ['--outlive-parent'] : []), ...(notify ? [] : ['--no-notify'])];
  const out = await run(args, { env: { HC_TERMINAL_ID: parent } });
  if (out.code !== 0) {
    if (hcError(out).kind === 'name_taken') return existing('taken');
    throw Object.assign(new Error(`hc could not start ${machine}'s agent terminal: ${hcError(out).message}`), { hc: true });
  }
  const started = parsed(out.stdout);
  return { made: true, address: typeof started?.address === 'string' ? started.address : `${machine}/${name}`, parent: typeof started?.parent === 'string' ? started.parent : null };
}
