// What each of the mod's actions does, apart from drawing. Each takes the two programs it runs, so
// herdr-mod/woodshed.test.mjs drives it with stand-ins and checks the calls:
//   cli(args, timeout)  runs the woodshed command line and waits: {code, stdout, stderr}, never rejects
//   core(args)          runs hc (herdr-core) and waits: {code, stdout, stderr}, never rejects
// main.js gives the real ones (the app's exec and hc).

import {
  EXIT, jsonLines, errorOf, startProgress, openForwards, terminalKind,
} from './woodshed.js';

/** @returns {Promise<string>}  a terminal's screen and history, '' when it cannot be read */
export async function readTerminal(core, name) {
  const r = await core(['read', name, '--json']);
  try {
    return r.code === 0 ? JSON.parse(r.stdout).text ?? '' : '';
  } catch {
    return '';
  }
}

/** @returns {Promise<object[]>}  every terminal of this computer's core, finished ones too */
async function allTerminals(core) {
  const r = await core(['ls', '--all', '--json']);
  try {
    return r.code === 0 ? JSON.parse(r.stdout).terminals ?? [] : [];
  } catch {
    return [];
  }
}

/** @returns {Promise<object|null>}  the terminal named so ({state, exit_code, …}), or null */
export async function terminalState(core, name) {
  return (await allTerminals(core)).find((t) => t.name === name) ?? null;
}

/**
 * Starts the command line (at `path`) in a background terminal of its own, with no parent and so no Herdr space.
 * @returns {Promise<string|null>}  an error, or null once it started
 */
export async function startInTerminal(core, { path, name, cwd, args }) {
  const r = await core(['run', '--bg', '--json', '--no-parent', '--name', name, '--cwd', cwd, '--', path, ...args]);
  return r.code === 0 ? null : (r.stderr || r.stdout || 'herdr-core did not start it').trim();
}

// ---- The panel ----

/**
 * Who is signed in, and their sessions.
 * @returns {Promise<{who: object, sessions: object[]|null, listError: string|null}>}
 *   who is {console, login}, {signedOut: text} or {missing: text}
 */
export async function readPanel(cli) {
  const status = await cli(['status', '--json'], 20_000);
  const said = jsonLines(status.stdout).pop() ?? {};
  if (status.code === EXIT.waiting) {
    const where = said.console ?? 'a console';
    return { who: { signedOut: said.ended ? `your sign-in to ${where} ended` : `not signed in to ${where}` }, sessions: null, listError: null };
  }
  if (status.code !== EXIT.done) return { who: { missing: errorOf(status) }, sessions: null, listError: null };
  const who = { console: said.name || said.console, login: said.login };
  const list = await cli(['session', 'list', '--json'], 20_000);
  const body = jsonLines(list.stdout).find((e) => Array.isArray(e.sessions));
  if (list.code === EXIT.done && body) return { who, sessions: body.sessions.filter((s) => s.mine), listError: null };
  return { who, sessions: null, listError: errorOf(list) };
}

/**
 * Removes the finished terminals of starts whose dialog was closed. A New session dialog still open reads its own
 * terminal and removes it; so one is removed here only once it was already finished at the last tidy, a pass (30 s)
 * later, never while a dialog may be about to read it.
 * @param {Set<string>} finishedBefore  names found finished at the last tidy; replaced in place
 */
export async function tidyStarts(core, finishedBefore) {
  const finished = (await allTerminals(core)).filter((t) => terminalKind(t.name)?.kind === 'new' && t.state === 'finished').map((t) => t.name);
  for (const name of finished) if (finishedBefore.has(name)) await core(['rm', name]);
  finishedBefore.clear();
  for (const name of finished) finishedBefore.add(name);
}

/** @returns {Promise<Object<string, object[]>>}  each session's open forwards, by session id, from the live terminals */
export async function readForwards(core, liveTerminals) {
  const out = {};
  for (const t of liveTerminals) {
    const kind = terminalKind(t.name);
    if (kind?.kind === 'fwd' && t.state !== 'finished') out[kind.id] = openForwards(await readTerminal(core, t.name));
  }
  return out;
}

// ---- New session ----

/** @returns {string|null}  why the form cannot start yet (the console refuses no prompt unless on a branch or PR) */
export function startRefusal({ prompt, branch }) {
  if (String(prompt ?? '').trim() || String(branch ?? '').trim()) return null;
  return 'Say what it should do, or give a branch or pull request for it to review.';
}

/**
 * One look at a start: its state first, then its output, so the output read covers everything a finished start
 * printed. A finished one's terminal is removed.
 * @returns {Promise<{progress: object, finished: {code: number}|null}>}
 */
export async function pollStart(core, name) {
  const term = await terminalState(core, name);
  const progress = startProgress(await readTerminal(core, name));
  if (term?.state !== 'finished') return { progress, finished: null };
  await core(['rm', name]);
  return { progress, finished: { code: term.exit_code } };
}

// ---- Session info ----

/** @returns {Promise<{session: object}|{error: string}>} */
export async function readSession(cli, id) {
  const r = await cli(['session', 'get', id, '--json']);
  const body = jsonLines(r.stdout).find((e) => e.session);
  return r.code === EXIT.done && body ? { session: body.session } : { error: errorOf(r) };
}

/** @returns {Promise<string|null>}  the command line's reason when the console did not extend it */
export async function extendSession(cli, id) {
  const r = await cli(['session', 'extend', id, '--json']);
  return r.code === EXIT.done ? null : errorOf(r);
}

/**
 * The session's app address, to open; a failure is told instead, and nothing opens.
 * @returns {Promise<{url: string}|{error: string, level: string}>}
 */
export async function appAddress(cli, id) {
  const r = await cli(['open', id, '--json']);
  const url = jsonLines(r.stdout).find((e) => typeof e.url === 'string')?.url;
  if (r.code === EXIT.done && url && /^https?:\/\/[^/\s]+/.test(url)) return { url };
  return { error: r.code === EXIT.done ? 'the command line gave no address' : errorOf(r), level: r.code === EXIT.waiting ? 'warning' : 'error' };
}

// ---- Forward port ----

/** One forward per session: a new one takes the place of the last. @returns {Promise<string|null>} an error */
export async function startForward(core, { path, name, cwd, args }) {
  if (await terminalState(core, name)) {
    await core(['kill', name]);
    await core(['rm', name]);
  }
  return startInTerminal(core, { path, name, cwd, args });
}

/**
 * Where a forward is: none, on with its open ports, or ended (with why, unless it was stopped). An ended one's
 * terminal is removed.
 * @returns {Promise<{state: null|'on'|{ended: string}, open: object[]}>}
 */
export async function readForward(core, name) {
  const term = await terminalState(core, name);
  if (!term) return { state: null, open: [] };
  const text = await readTerminal(core, name);
  if (term.state !== 'finished') return { state: 'on', open: openForwards(text) };
  await core(['rm', name]);
  const stopped = term.exit_code === EXIT.done || term.reason === 'killed' || term.exit_code === 130 || term.exit_code === 143;
  const said = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('{')).join('\n');
  return { state: { ended: stopped ? 'Stopped.' : errorOf({ stdout: text, stderr: said }) }, open: [] };
}

/** Ends a forward. */
export async function stopForward(core, name) {
  await core(['kill', name]);
}
