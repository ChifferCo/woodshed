// What the session's agent is doing, for statusd's `state`: one reading from what statusd gathered (the agent's pane,
// claude's hooks and transcript, Herdr's word on the agent). Each source is a reader, which says a state or that it
// cannot tell (null); stateReader picks the ones a session has and puts them together.
//
//   claude  its own hooks (hookState.mjs), the transcript for a turn ended by Esc, the pane until the first hook
//   codex   its pane alone (codexState.mjs): codex has no hooks
//   qa      the QA run's marker file: the run is a script, not an agent
//   herdr   for an agent run in Herdr (its owner's Agent terminal on My settings): the status herdr-core keeps for its
//           terminal (`hc get claude`), the agent's own word in an OSC 7501 record (claude sends them; codex 0.167
//           does not, and is read from its pane), mapped onto statusd's states
//
// Kept apart from statusd.mjs, which starts a server on import, so each reader is tested on its own.

import { classifyPane } from '../shared/sessionState.mjs';
import { classifyCodexPane } from './codexState.mjs';

/** @typedef {'starting'|'working'|'needs-you'|'done'|'not-running'} AgentState */
/** @typedef {{state: AgentState, source: string}} Reading */
/**
 * What the readers read, gathered by statusd once per status read.
 * @typedef {{paneText: string, hook: {state: string, event: string, at: number}|null, interruptedAt: number|null,
 *   transcriptAt: number|null, openTools: number|null, now: number, startedAt: number, qaRunning?: boolean,
 *   herdrStatus?: {app?: string, state?: string}|null}} StateInput
 */

// No hook yet and a shell on screen reads as starting for this long after the container started; after it, the agent
// has exited (or never opened).
export const STARTING_MS = 2 * 60_000;
// A prompt or a finished tool call followed by this long with no transcript write and no tool call open: the turn was
// ended by Esc before its first word, which fires no hook.
export const SILENT_TURN_MS = 5 * 60_000;
const WAITING_ON_REPLY = new Set(['UserPromptSubmit', 'PostToolUse']);
const MODE_FOOTER = /(auto mode|bypass permissions|accept edits|plan mode|manual mode) on/;

/**
 * @param {string} paneText  the pane's screen as plain text (`tmux capture-pane -p`, `herdr pane read`)
 * @returns {'working'|'needs-you'|'done'|'not-running'}  not-running = the pane
 *   holds a shell: claude has not opened yet, or it has exited
 */
export function paneState(paneText) {
  const state = classifyPane(paneText);
  if (state) return state;
  // classifyPane wants an empty composer line to call a turn done, but claude
  // greys a suggested next prompt into it after most turns.
  return typeof paneText === 'string' && MODE_FOOTER.test(paneText) ? 'done' : 'not-running';
}

/**
 * What claude is doing, from its own hooks. The pane only says whether claude is open at all, and stands in until
 * the first hook fires.
 * @param {StateInput} input  transcriptAt: when the transcript was last written, in ms. openTools: from
 *   openToolCalls; null, unknown, counts as open. startedAt: when statusd started, with the container
 * @returns {{state: AgentState, source: 'pane'|'hook'|'interrupt'|'silent'}}
 */
export function claudeState({ paneText, hook, interruptedAt, transcriptAt, openTools, now, startedAt }) {
  const pane = paneState(paneText);
  // SessionStart writes the state file as claude opens, so with no file and no claude on screen it is still opening,
  // its first prompt queued behind it. Not for ever: a claude that never opens has exited.
  if (pane === 'not-running' && !hook && now - startedAt < STARTING_MS) return { state: 'starting', source: 'pane' };
  if (pane === 'not-running' || !hook?.state) return { state: pane, source: 'pane' };
  if (hook.state !== 'done' && interruptedAt !== null && interruptedAt >= hook.at) return { state: 'done', source: 'interrupt' };
  // Esc before the first word of a reply writes no interrupt record either: the prompt or the tool result, then
  // nothing. A turn that is going writes to the transcript, or has a tool call open: the last PostToolUse can be
  // the quick one of a parallel batch.
  const lastSign = Math.max(hook.at, transcriptAt ?? 0);
  const silent = WAITING_ON_REPLY.has(hook.event) && openTools === 0 && now - lastSign > SILENT_TURN_MS;
  if (silent) return { state: 'done', source: 'silent' };
  return { state: hook.state, source: 'hook' };
}

/**
 * Codex writes no hooks: its pane is all there is, and a pane with no codex on it is starting or has ended.
 * @param {StateInput} input
 * @returns {Reading}
 */
export function codexState({ paneText, now, startedAt }) {
  const state = classifyCodexPane(paneText);
  if (state) return { state, source: 'pane' };
  return { state: now - startedAt < STARTING_MS ? 'starting' : 'not-running', source: 'pane' };
}

/** @param {StateInput} input @returns {Reading} */
export function qaState({ qaRunning }) {
  return { state: qaRunning ? 'working' : 'done', source: 'qa' };
}

// A 7501 record's states (`hc schema`, Status: idle, working, done, blocked or error), as statusd's. `idle` and `done`
// both mean at its prompt. `error` says the agent failed, not whether it waits on a person: it says nothing here.
const FROM_HERDR = { idle: 'done', done: 'done', working: 'working', blocked: 'needs-you' };

/**
 * Herdr's word on the agent in the session's terminal: its status, the agent's last 7501 record.
 * @param {StateInput} input
 * @returns {Reading|null}  null when no agent has reported (a shell, claude still opening, codex), or said `error`
 */
export function herdrState({ herdrStatus }) {
  const state = FROM_HERDR[herdrStatus?.state];
  return state ? { state, source: 'herdr' } : null;
}

// Which says more, when Herdr and the agent's own reader differ: a person is needed over work going on, and work over
// a turn that is done.
const WEIGHT = { 'needs-you': 3, working: 2, done: 1 };

/**
 * Herdr's reading beside the agent's own. Neither side is dropped: Herdr's state wins unless the agent's own says more
 * (claude's PermissionRequest hook on a prompt its record does not call blocked, a background agent still running after
 * its Stop, which statusd counts as work). With nothing from Herdr, the agent's own reader stands alone, starting and
 * not-running included.
 * @param {Reading|null} herdr
 * @param {Reading} own
 * @returns {Reading}
 */
export function withHerdr(herdr, own) {
  if (!herdr) return own;
  return (WEIGHT[own.state] ?? 0) > WEIGHT[herdr.state] ? own : herdr;
}

/**
 * The reader for this session's agent.
 * @param {{qa?: boolean, codex?: boolean, terminal?: 'tmux'|'herdr'}} session
 * @returns {(input: StateInput) => Reading}
 */
export function stateReader({ qa = false, codex = false, terminal = 'tmux' } = {}) {
  // A QA run is a script in tmux whatever the project file says, as a question and a review are.
  if (qa) return qaState;
  const own = codex ? codexState : claudeState;
  if (terminal !== 'herdr') return own;
  return (input) => withHerdr(herdrState(input), own(input));
}

// What claude writes when Esc ends a turn, mid-turn ("…by user]") or on a dialog ("…by user for tool use]").
const INTERRUPT_RECORD = '[Request interrupted by user';

/**
 * @param {string} tailText  the tail of a transcript
 * @returns {number|null}  when the last turn was cut short with Esc, mid-turn or on a dialog, in ms
 */
export function lastInterruptAt(tailText) {
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(INTERRUPT_RECORD)) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((b) => b?.text) : [];
    const at = Date.parse(rec?.timestamp);
    if (rec?.type === 'user' && !Number.isNaN(at) && texts.some((t) => typeof t === 'string' && t.startsWith(INTERRUPT_RECORD))) return at;
  }
  return null;
}

/**
 * @param {string} tailText  the tail of a transcript
 * @param {{partial: boolean}} opts  partial: the tail starts mid-file, so a walk that runs off its start has not
 *   seen the whole turn
 * @returns {number|null}  tool calls since the last prompt with no result yet: still running, in parallel with the
 *   last one to finish, or a subagent at work. null when the tail ends before the prompt does: one large tool
 *   result can fill it, and the call it ran beside may be further back
 */
export function openToolCalls(tailText, { partial }) {
  const results = new Set();
  let open = 0;
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (rec?.type === 'user') {
      if (!Array.isArray(content)) return open;
      const resultIds = content.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id);
      if (!resultIds.length) return open;
      resultIds.forEach((id) => results.add(id));
    } else if (rec?.type === 'assistant' && Array.isArray(content)) {
      open += content.filter((b) => b?.type === 'tool_use' && !results.has(b.id)).length;
    }
  }
  return partial ? null : open;
}
