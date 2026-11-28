import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { SILENT_TURN_MS, STARTING_MS, codexState, herdrState, qaState, stateReader, withHerdr } from './agentState.mjs';

const NOW = 10 * 60_000;
// claude at its prompt, between turns, as tmux and Herdr both read it (the mode footer under the box).
const CLAUDE_AT_PROMPT = ['╭───╮', '❯ ', '╰───╯', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
const CODEX_WORKING = ['• Working (3s • esc to interrupt)', '', '› ', ''].join('\n');
const SHELL = 'woodshed@abc:/work/app$ ';
const input = (over = {}) => ({
  paneText: CLAUDE_AT_PROMPT, hook: null, interruptedAt: null, transcriptAt: null, openTools: 0, now: NOW, startedAt: 0,
  qaRunning: false, herdrStatus: null, ...over,
});
const hook = (state, event = state === 'done' ? 'Stop' : 'PreToolUse') => ({ state, event, at: NOW - 1000 });
// hc's status for its terminal: the agent's last OSC 7501 record (claude names itself claude-code).
const herdr = (state, app = 'claude-code') => ({ app, state });

test('Herdr\'s agent states are statusd\'s: idle and done are done, working is working, blocked needs a person', () => {
  assert.deepEqual(herdrState(input({ herdrStatus: herdr('idle') })), { state: 'done', source: 'herdr' });
  assert.deepEqual(herdrState(input({ herdrStatus: herdr('done') })), { state: 'done', source: 'herdr' });
  assert.deepEqual(herdrState(input({ herdrStatus: herdr('working') })), { state: 'working', source: 'herdr' });
  assert.deepEqual(herdrState(input({ herdrStatus: herdr('blocked') })), { state: 'needs-you', source: 'herdr' });
});

test('Herdr says nothing when no agent reported, or one said it failed', () => {
  assert.equal(herdrState(input({ herdrStatus: herdr('error') })), null, 'an error is not a person needed');
  assert.equal(herdrState(input({ herdrStatus: null })), null, 'a shell, or codex, which sends no records');
  assert.equal(herdrState(input({ herdrStatus: { app: 'claude-code' } })), null);
  assert.equal(herdrState(input({ herdrStatus: herdr('asleep') })), null, 'a word of a later agent\'s');
});

test('Herdr\'s reading wins unless the agent\'s own says more: a person needed, then work going on', () => {
  const own = (state) => ({ state, source: 'hook' });
  const fromHerdr = (state) => ({ state, source: 'herdr' });
  assert.deepEqual(withHerdr(fromHerdr('working'), own('done')), fromHerdr('working'), 'a turn Herdr sees going');
  assert.deepEqual(withHerdr(fromHerdr('needs-you'), own('working')), fromHerdr('needs-you'), 'a prompt Herdr knows');
  assert.deepEqual(withHerdr(fromHerdr('done'), own('done')), fromHerdr('done'));
  assert.deepEqual(withHerdr(fromHerdr('done'), own('needs-you')), own('needs-you'), 'a prompt Herdr does not know yet');
  assert.deepEqual(withHerdr(fromHerdr('done'), own('working')), own('working'), 'a background agent after claude\'s Stop');
  assert.deepEqual(withHerdr(null, own('starting')), own('starting'), 'no agent yet: the agent\'s own reader alone');
  assert.deepEqual(withHerdr(fromHerdr('done'), own('not-running')), fromHerdr('done'));
});

test('a session in tmux reads claude from its hooks and codex from its pane, as before Herdr', () => {
  const claude = stateReader({});
  assert.deepEqual(claude(input({ hook: hook('working') })), { state: 'working', source: 'hook' });
  assert.deepEqual(claude(input({ hook: hook('working'), herdrStatus: herdr('blocked') })), { state: 'working', source: 'hook' }, 'tmux never asks Herdr');
  const codex = stateReader({ codex: true });
  assert.deepEqual(codex(input({ paneText: CODEX_WORKING })), { state: 'working', source: 'pane' });
});

test('an agent in Herdr is read by Herdr first, with its own reader behind it', () => {
  const claude = stateReader({ terminal: 'herdr' });
  assert.deepEqual(claude(input({ hook: hook('done'), herdrStatus: herdr('blocked') })), { state: 'needs-you', source: 'herdr' });
  assert.deepEqual(claude(input({ hook: hook('working'), herdrStatus: herdr('working') })), { state: 'working', source: 'herdr' });
  assert.deepEqual(claude(input({ hook: hook('needs-you', 'PermissionRequest'), herdrStatus: herdr('idle') })), { state: 'needs-you', source: 'hook' });
  assert.deepEqual(claude(input({ hook: hook('done'), herdrStatus: herdr('error') })), { state: 'done', source: 'hook' });
  // claude still opening: a shell on screen, no hook, and nothing on the pane Herdr knows as an agent.
  assert.deepEqual(claude(input({ paneText: SHELL, now: STARTING_MS - 1 })), { state: 'starting', source: 'pane' });
  assert.deepEqual(claude(input({ paneText: SHELL, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
  // Esc ended the turn: claude's transcript says so, and Herdr sees it idle.
  const interrupted = input({ hook: hook('working'), interruptedAt: NOW - 500, herdrStatus: herdr('idle') });
  assert.deepEqual(claude(interrupted), { state: 'done', source: 'herdr' });
  const silent = input({ hook: { state: 'working', event: 'UserPromptSubmit', at: NOW - SILENT_TURN_MS - 1 }, herdrStatus: herdr('idle') });
  assert.deepEqual(claude(silent), { state: 'done', source: 'herdr' });

  const codex = stateReader({ codex: true, terminal: 'herdr' });
  assert.deepEqual(codex(input({ paneText: CODEX_WORKING, herdrStatus: herdr('blocked', 'codex') })), { state: 'needs-you', source: 'herdr' });
  assert.deepEqual(codex(input({ paneText: SHELL, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
});

test('a QA run is read from its marker, whatever the terminal', () => {
  for (const terminal of ['tmux', 'herdr']) {
    const qa = stateReader({ qa: true, terminal });
    assert.deepEqual(qa(input({ qaRunning: true, herdrStatus: herdr('idle') })), { state: 'working', source: 'qa' });
    assert.deepEqual(qa(input({ qaRunning: false })), { state: 'done', source: 'qa' });
  }
  assert.deepEqual(qaState({ qaRunning: true }), { state: 'working', source: 'qa' });
});

test('codex with nothing on its pane is starting for its first minutes, then not running', () => {
  assert.deepEqual(codexState(input({ paneText: SHELL, now: 1000 })), { state: 'starting', source: 'pane' });
  assert.deepEqual(codexState(input({ paneText: SHELL, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
});

test('Grok Build: its hooks, its pane for an approval and before the first hook, and whether it runs at all', () => {
  const grok = stateReader({ agent: 'grok' });
  const pane = (name) => readFileSync(new URL(`../shared/__fixtures__/${name}`, import.meta.url), 'utf8');
  assert.deepEqual(grok(input({ paneText: SHELL, agentOpen: false, startedAt: NOW - 1000 })), { state: 'starting', source: 'pane' });
  assert.deepEqual(grok(input({ paneText: SHELL, agentOpen: false, startedAt: 0, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
  assert.deepEqual(grok(input({ paneText: pane('pane-grok-working.txt'), agentOpen: true })), { state: 'working', source: 'pane' });
  assert.deepEqual(grok(input({ paneText: pane('pane-grok-idle.txt'), agentOpen: true, hook: hook('working') })), { state: 'working', source: 'hook' });
  assert.deepEqual(grok(input({ paneText: pane('pane-grok-approval.txt'), agentOpen: true, hook: hook('working') })), { state: 'needs-you', source: 'pane' });
  // An earlier Grok's last hook, before this statusd started, says nothing.
  assert.deepEqual(grok(input({ paneText: 'grok', agentOpen: true, hook: hook('working'), startedAt: NOW })), { state: 'done', source: 'pane' });
});

test('OpenCode: its pane, while it runs', () => {
  const oc = stateReader({ agent: 'opencode' });
  const pane = (name) => readFileSync(new URL(`../shared/__fixtures__/${name}`, import.meta.url), 'utf8');
  assert.deepEqual(oc(input({ paneText: pane('pane-opencode-working.txt'), agentOpen: true })), { state: 'working', source: 'pane' });
  assert.deepEqual(oc(input({ paneText: pane('pane-opencode-approval.txt'), agentOpen: true })), { state: 'needs-you', source: 'pane' });
  assert.deepEqual(oc(input({ paneText: pane('pane-opencode-idle.txt'), agentOpen: true })), { state: 'done', source: 'pane' });
  assert.deepEqual(oc(input({ paneText: SHELL, agentOpen: false, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
});

test('Antigravity CLI: its screen first, its hooks where the screen says nothing, and whether it runs at all', () => {
  const agy = stateReader({ agent: 'antigravity' });
  const pane = (name) => readFileSync(new URL(`../shared/__fixtures__/${name}`, import.meta.url), 'utf8');
  assert.deepEqual(agy(input({ paneText: SHELL, agentOpen: false, startedAt: NOW - 1000 })), { state: 'starting', source: 'pane' });
  assert.deepEqual(agy(input({ paneText: SHELL, agentOpen: false, startedAt: 0, now: STARTING_MS + 1 })), { state: 'not-running', source: 'pane' });
  assert.deepEqual(agy(input({ paneText: pane('pane-agy-working.txt'), agentOpen: true })), { state: 'working', source: 'pane' });
  assert.deepEqual(agy(input({ paneText: pane('pane-agy-idle.txt'), agentOpen: true })), { state: 'done', source: 'pane' });
  // Esc ends a turn with no hook, so the last one still says working: the screen at its prompt says it is done.
  assert.deepEqual(agy(input({ paneText: pane('pane-agy-idle.txt'), agentOpen: true, hook: hook('working') })), { state: 'done', source: 'pane' });
  // PreToolUse fires before the approval does, and the hook still says working under it.
  for (const name of ['approval-command', 'approval-create', 'approval-edit', 'question']) {
    assert.deepEqual(agy(input({ paneText: pane(`pane-agy-${name}.txt`), agentOpen: true, hook: hook('working') })), { state: 'needs-you', source: 'pane' }, name);
  }
  // A screen this cannot read (a trace in the scrollback, a dialog of its own): the hook's word, if it is this run's.
  assert.deepEqual(agy(input({ paneText: 'agy is drawing', agentOpen: true, hook: hook('working') })), { state: 'working', source: 'hook' });
  assert.deepEqual(agy(input({ paneText: 'agy is drawing', agentOpen: true, hook: hook('working'), startedAt: NOW })), { state: 'done', source: 'pane' });
});
