// What an agent's pane says its session is doing, for the agents whose own word is not all there is: codex, which has
// no hooks, and the pane fallbacks of Grok Build (before its first hook) and OpenCode (no hooks, its state from its
// screen alone), and Antigravity CLI's pane, which wins over its hooks (an Esc fires none). Only the bottom of the screen is read: an agent's own printed output stays on screen and can hold any
// marker.
//
// codex's are captured from its pane (codex 0.167). The others are reconstructed from each agent's source or binary
// strings (Grok Build 1.0.45's source and 1.0.92's strings, OpenCode v1.19.6's tui/src/routes/session/*.tsx), not
// captured from a pane: shared/__fixtures__/pane-<agent>-*.txt are drawn from them. Antigravity CLI's (agy 1.5.18) are captured
// from its real TUI, as are the pane-agy-* fixtures panePrompt.mjs reads its approvals and box from.

import { readApproval } from './panePrompt.mjs';

const BOTTOM_LINES = 14;
const bottomOf = (paneText) => paneText.split('\n').filter((line) => line.trim()).slice(-BOTTOM_LINES).join('\n');

const CODEX_APPROVAL_RE = /(press enter to confirm|esc to cancel|would you like to run)/i;
const CODEX_WORKING_RE = /esc to interrupt/i;
const CODEX_COMPOSER_RE = /^\s*[›>]\s/m;

/**
 * @param {string} paneText  raw `tmux capture-pane -p` output
 * @returns {'working'|'needs-you'|'done'|null}  null when codex is not open (a bare shell, a dead pane)
 */
export function classifyCodexPane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;
  const bottom = bottomOf(paneText);
  if (CODEX_APPROVAL_RE.test(bottom)) return 'needs-you';
  if (CODEX_WORKING_RE.test(bottom)) return 'working';
  return CODEX_COMPOSER_RE.test(bottom) ? 'done' : null;
}

// OpenCode's footer while a turn runs: its spinner and `esc interrupt`, `esc again to interrupt` after one Esc
// (component/prompt/index.tsx). At its prompt the footer has neither, and shows the folder and the agent (`Build`,
// `Plan`) beside the model.
const OPENCODE_WORKING_RE = /\besc (again to )?interrupt\b/i;
const OPENCODE_ASKING_RE = /^\s*[△▲]?\s*(Permission required|Reject permission|Always allow)\s*$/m;
const OPENCODE_PROMPT_RE = /^\s*┃|\b(Build|Plan)\b.*\S|\bctrl\+p commands\b|\btab (switch )?agent\b/im;

/**
 * @param {string} paneText
 * @returns {'working'|'needs-you'|'done'|null}  null when nothing on screen is OpenCode's
 */
export function classifyOpencodePane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;
  const bottom = bottomOf(paneText);
  // Its panels are drawn inside a left border (`┃`).
  if (OPENCODE_ASKING_RE.test(bottom.replace(/^\s*┃ ?/gm, '')) || readApproval(paneText, 'opencode')) return 'needs-you';
  if (OPENCODE_WORKING_RE.test(bottom)) return 'working';
  return OPENCODE_PROMPT_RE.test(bottom) ? 'done' : null;
}

// Antigravity CLI's screen (agy 1.5.18, captured: shared/__fixtures__/pane-agy-*.txt). Its input box is `> ` between two
// rules, with the footer under it: `? for shortcuts` at its prompt, `esc to cancel` while a turn runs (a spinner line
// over the box, `⣷  Running command... 3s`), and, with a question or approval on screen, the key hint `↑/↓ Navigate · …`
// and `esc to cancel` under it. A draft typed in the box leaves the footer with only its mode.
// The slash menu a `/` opens in the box has the same hint with `tab Complete`: a person typing, not asked.
const AGY_NAVIGATE = /↑\/↓ Navigate\b(?!.*tab Complete)/;
const AGY_WORKING_RE = /^\s*esc to cancel\b/m;
const AGY_PROMPT_RE = /^\s*>(\s|$)/m;

/**
 * @param {string} paneText
 * @returns {'working'|'needs-you'|'done'|null}  null when nothing on screen is agy's prompt
 */
export function classifyAntigravityPane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;
  // An approval, its question picker, a login menu: any screen with its navigation hint asks a person.
  if (readApproval(paneText, 'antigravity') || AGY_NAVIGATE.test(bottomOf(paneText))) return 'needs-you';
  const bottom = bottomOf(paneText);
  // The slash menu, open over a draft, has `esc to cancel` too: the person is at the prompt.
  if (AGY_WORKING_RE.test(bottom) && !/tab Complete/.test(bottom)) return 'working';
  return AGY_PROMPT_RE.test(bottom) ? 'done' : null;
}

// Grok Build's turn hint (agent_view/prompt.rs: `Press {cancel_key} to cancel the turn`, the footer's `ctrl+c to
// cancel`): Ctrl+C cancels a turn, Esc never does. At its prompt, its box's `❯`.
const GROK_WORKING_RE = /\b(ctrl\+c|Ctrl\+C) to cancel\b|to cancel the turn\b/;
// Its prompt's `❯`, at the start of a line or inside its box (`│ ❯`, as 1.0.92 draws it, captured in the session image).
const GROK_PROMPT_RE = /^\s*(?:│\s*)?❯(\s|$)/m;

/**
 * Grok Build's screen, behind its hooks: an approval, a turn running, or its prompt.
 * @param {string} paneText
 * @returns {'working'|'needs-you'|'done'|null}
 */
export function classifyGrokPane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;
  if (readApproval(paneText, 'grok')) return 'needs-you';
  const bottom = bottomOf(paneText);
  if (GROK_WORKING_RE.test(bottom)) return 'working';
  return GROK_PROMPT_RE.test(bottom) ? 'done' : null;
}

/**
 * The pane's reading for any agent but claude, whose own reader is agentState.mjs's paneState.
 * @param {string} agent
 * @param {string} paneText
 * @returns {'working'|'needs-you'|'done'|null}
 */
export function classifyAgentPane(agent, paneText) {
  if (agent === 'codex') return classifyCodexPane(paneText);
  if (agent === 'opencode') return classifyOpencodePane(paneText);
  if (agent === 'grok') return classifyGrokPane(paneText);
  if (agent === 'antigravity') return classifyAntigravityPane(paneText);
  return null;
}
