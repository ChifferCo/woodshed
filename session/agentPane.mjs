// The terminal the session's agent runs in, as statusd reads it and types into it: tmux's `claude` session, as every
// session has, or the Herdr terminal the entrypoint started it in, a terminal named `claude` on the session's own
// herdr-core (`hc`). Both answer the same calls where they can, so statusd's reading, answering and lockdown reopen do
// not care which it is; where hc cannot (it types no text without an Enter, and reads no colours), the pane says so
// (`typesText`, `colours`) and statusd takes hc's own way instead.
//
// The entrypoint decides which, and hands it to statusd and to what claude runs as WOODSHED_TERMINAL. Only a private
// coding session's agent can be in Herdr, when its owner picked it on My settings (Agent terminal): a shared session, a
// question, a review and a QA run, and the Terminal tab's shell, are in tmux always.

import path from 'node:path';

import { paneState } from './agentState.mjs';
import { classifyCodexPane } from './codexState.mjs';
import { asking } from './panePrompt.mjs';

// What tmux names the pane's command while claude or codex runs in it, and what hc names the program in its terminal.
export const AGENT_NAMES = Object.freeze(['claude', 'codex']);
// tmux's own test of the pane's command: 1 while the agent runs in it, read just before an agentOnly send types.
export const AGENT_PANE_FORMAT = `#{||:${AGENT_NAMES.map((c) => `#{==:#{pane_current_command},${c}}`).join(',')}}`;
// The Herdr terminal's name on the session's core: names are unique among its live terminals.
export const HC_TERMINAL = 'claude';

// tmux's key names, as statusd and panePrompt.mjs send them, in hc's (`hc keys --help`). hc refuses tmux's own `C-u` and
// `BSpace`, and names no key for most punctuation: text goes in with `hc send`.
const HC_KEYS = { Enter: 'enter', Escape: 'esc', Up: 'up', Down: 'down', Left: 'left', Right: 'right', Tab: 'tab', Space: 'space', BSpace: 'backspace' };

/**
 * @param {string} key  a tmux key name: `Enter`, `Up`, `C-j`
 * @returns {string}  hc's: `enter`, `up`, `ctrl+j`
 * @throws {Error}  for a key it has no name for, before anything is typed
 */
export function hcKey(key) {
  if (Object.hasOwn(HC_KEYS, key)) return HC_KEYS[key];
  const ctrl = /^C-([a-z])$/.exec(key);
  if (ctrl) return `ctrl+${ctrl[1]}`;
  throw new Error(`no Herdr name for the key ${key}`);
}

/**
 * Whether what runs in the terminal now is the agent: hc's `foreground`, whose OS name for claude is its version
 * (`2.1.330`), so its command line is read too.
 * @param {{name?: string, argv?: string[]}|null|undefined} foreground
 */
export function isAgentForeground(foreground) {
  if (!foreground) return false;
  const names = [foreground.name, ...(foreground.argv ?? []).slice(0, 2)].filter((n) => typeof n === 'string');
  return names.some((n) => AGENT_NAMES.includes(path.basename(n)));
}

/**
 * The agent's tmux session.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} run  execFile, promisified
 */
export function tmuxPane(run, target = 'claude') {
  const literal = (text) => run('tmux', ['send-keys', '-t', target, '-l', text]);
  return {
    terminal: 'tmux',
    colours: true,
    typesText: true,
    /** The screen, or with `back` lines of scrollback over it; `ansi` keeps its colours. */
    async capture({ ansi = false, back = 0 } = {}) {
      const scroll = back > 0 ? ['-S', String(-Math.min(back, 10_000))] : [];
      return (await run('tmux', ['capture-pane', ...(ansi ? ['-e'] : []), '-p', ...scroll, '-t', target])).stdout;
    },
    /** tmux's key names: `Enter`, `Up`, `C-j`. */
    keys: (...keys) => run('tmux', ['send-keys', '-t', target, ...keys]),
    literal,
    /** A bracketed paste, where the program asked for them. */
    async paste(text) {
      await run('tmux', ['set-buffer', '-b', 'woodshed-send', '--', text]);
      await run('tmux', ['paste-buffer', '-p', '-d', '-b', 'woodshed-send', '-t', target]);
    },
    /** A command at the shell's prompt, once claude is gone from it. */
    async line(text) {
      await literal(text);
      await run('tmux', ['send-keys', '-t', target, 'Enter']);
    },
    agentRunning: async () => (await run('tmux', ['display', '-p', '-t', target, AGENT_PANE_FORMAT])).stdout.trim() === '1',
    /** The pane's shell, whose child is the agent. */
    shellPid: async () => Number((await run('tmux', ['display', '-p', '-t', target, '#{pane_pid}'])).stdout.trim()),
    /** Nothing more to say about the agent than the pane does. */
    agent: async () => null,
  };
}

/**
 * The agent's Herdr terminal, through `hc`'s CLI on the session's own core.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} run  execFile, promisified
 * @param {{terminal?: string, bin?: string}} [where]
 */
export function hcPane(run, { terminal = HC_TERMINAL, bin = 'hc' } = {}) {
  // Options first, then `--`, then the terminal and anything else as it is: a message that starts with a dash (a pasted
  // Markdown bullet) is the message, never one of hc's options.
  const hc = async (command, options, ...args) => JSON.parse((await run(bin, [command, ...options, '--json', '--', terminal, ...args])).stdout);
  const get = () => hc('get', []);
  const read = async (back = 0) => (await hc('read', ['--lines', String(Math.min(back, 10_000))])).text;
  return {
    terminal: 'herdr',
    // hc reads the screen as text, without its colours, and types text only as a paste with its Enter (`hc send`).
    colours: false,
    typesText: false,
    /** The screen, or with `back` lines of history over it. hc keeps no colours: `ansi` reads the same text. */
    capture: ({ back = 0 } = {}) => read(back),
    // Every key named before any is sent: one hc has no name for types nothing.
    keys: async (...keys) => hc('keys', [], ...keys.map(hcKey)),
    literal: async () => { throw new Error('hc types no text without its Enter: use send or line'); },
    paste: async () => { throw new Error('hc types no text without its Enter: use send or line'); },
    /**
     * A message, pasted and sent with its Enter, never into a prompt: not while the screen asks a person anything (a
     * question, an approval, a numbered menu: what typeMessage refuses in tmux), and only while the agent says it is idle
     * or done (hc's own `send --if idle` for idle; hc's send also refuses a blocked program and waits for a person's
     * unsent draft in an attached client). codex sends no 7501 records, so hc never calls it idle: with no record, and
     * with done, which `--if` cannot name, the screen must show the agent at its prompt.
     * @returns {Promise<{sent: true}|{sent: false, why: string, kind?: string|null}>}
     */
    async send(text) {
      try {
        const [screen, { status }] = await Promise.all([read(), get()]);
        const kind = asking(screen);
        if (kind) return { sent: false, why: 'prompt-open', kind };
        // claude's record says idle only before its first turn, and done after every turn until the next starts. hc's
        // `--if` takes only idle or working, so a done record is checked against the screen as no record is, and sent
        // without it: hc's own send still refuses a blocked program and waits for a person's draft.
        const state = status?.state ?? null;
        if (state && state !== 'idle' && state !== 'done') return { sent: false, why: state === 'blocked' ? 'blocked' : 'status_mismatch' };
        if (state !== 'idle' && classifyCodexPane(screen) !== 'done' && paneState(screen) !== 'done') return { sent: false, why: 'not-at-prompt' };
        await hc('send', state === 'idle' ? ['--if', 'idle'] : [], text);
        return { sent: true };
      } catch (err) {
        return { sent: false, why: refusedSend(err) };
      }
    },
    /** A command at the shell's prompt, once claude is gone from it (the lockdown's reopen, woodshed-login's). */
    line: (text) => hc('send', [], text),
    async agentRunning() {
      return isAgentForeground((await get()).foreground);
    },
    /** The terminal's own program: the shell the entrypoint started, whose child is the agent. */
    shellPid: async () => Number((await get()).pid),
    /** hc's word on the agent: its 7501 record (`{app, state}`), or null when the program never gave one. */
    agent: async () => (await get()).status ?? null,
  };
}

// hc's error, from `--json` on stdout or its message, as what statusd answers: the agent was not idle, or blocked.
function refusedSend(err) {
  let kind = '';
  try {
    kind = JSON.parse(err?.stdout || err?.stderr || '{}')?.error?.kind ?? '';
  } catch {
    // Not hc's JSON: said by its exit alone.
  }
  return kind || 'not-sent';
}

/**
 * The agent's pane in this session.
 * @param {(cmd: string, args: string[]) => Promise<{stdout: string}>} run
 * @param {{terminal?: string, bin?: string}} [opts]  terminal: WOODSHED_TERMINAL
 */
export function agentPane(run, { terminal = process.env.WOODSHED_TERMINAL, bin = process.env.WOODSHED_HC_BIN || 'hc' } = {}) {
  return terminal === 'herdr' ? hcPane(run, { bin }) : tmuxPane(run);
}
