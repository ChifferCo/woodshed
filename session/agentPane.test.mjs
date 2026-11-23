import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { agentPane, hcKey, hcPane, isAgentForeground, tmuxPane } from './agentPane.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, '../shared/__fixtures__', name), 'utf8');

// A stand-in execFile: records each call, and answers from `answers` by the command line's start. An Error answer is
// thrown, as execFile rejects.
function fakeRun(answers = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const line = [cmd, ...args].join(' ');
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    const out = key ? answers[key] : '{}';
    if (out instanceof Error) throw out;
    return { stdout: typeof out === 'string' ? out : JSON.stringify(out) };
  };
  return { run, calls };
}

// hc's terminal, as `hc get claude --json` gives it while claude runs: its status is claude's own 7501 record.
const CLAUDE_RUNNING = {
  address: 't1', name: 'claude', pid: 4100, state: 'live', status: { app: 'claude-code', state: 'idle' },
  foreground: { pid: 4242, name: '2.1.330', argv: ['/home/node/.local/bin/claude', '--settings', 'x'], cwd: '/work/app' },
};
const SHELL_ONLY = { ...CLAUDE_RUNNING, status: null, foreground: { pid: 4100, name: 'bash', argv: ['-bash'], cwd: '/work/app' } };
// What hc prints for a refused call: its error on stdout, with --json, and a non-zero exit.
const refused = (kind) => Object.assign(new Error('Command failed: hc send'), { code: 1, stdout: JSON.stringify({ error: { kind, message: kind } }) });

test('tmux\'s key names become hc\'s, and one hc has no name for is refused before anything is typed', () => {
  assert.deepEqual(['Enter', 'Escape', 'Up', 'Down', 'Space', 'Tab', 'BSpace', 'C-j', 'C-u'].map(hcKey),
    ['enter', 'esc', 'up', 'down', 'space', 'tab', 'backspace', 'ctrl+j', 'ctrl+u']);
  assert.throws(() => hcKey('M-x'), /no Herdr name for the key M-x/);
});

test('the tmux pane is read and typed into as statusd always has', async () => {
  const { run, calls } = fakeRun({ 'tmux display -p -t claude #{pane_pid}': '4242\n', 'tmux display': '1\n', 'tmux capture-pane': 'screen' });
  const pane = tmuxPane(run);
  assert.deepEqual([pane.terminal, pane.colours, pane.typesText], ['tmux', true, true]);
  assert.equal(await pane.capture(), 'screen');
  await pane.capture({ ansi: true, back: 30 });
  await pane.keys('Up', 'Enter');
  await pane.literal('hello');
  await pane.paste('pasted');
  await pane.line('claude --resume x');
  assert.equal(await pane.agentRunning(), true);
  assert.equal(await pane.shellPid(), 4242);
  assert.equal(await pane.agent(), null);
  assert.deepEqual(calls.slice(0, 8), [
    ['tmux', 'capture-pane', '-p', '-t', 'claude'],
    ['tmux', 'capture-pane', '-e', '-p', '-S', '-30', '-t', 'claude'],
    ['tmux', 'send-keys', '-t', 'claude', 'Up', 'Enter'],
    ['tmux', 'send-keys', '-t', 'claude', '-l', 'hello'],
    ['tmux', 'set-buffer', '-b', 'woodshed-send', '--', 'pasted'],
    ['tmux', 'paste-buffer', '-p', '-d', '-b', 'woodshed-send', '-t', 'claude'],
    ['tmux', 'send-keys', '-t', 'claude', '-l', 'claude --resume x'],
    ['tmux', 'send-keys', '-t', 'claude', 'Enter'],
  ]);
});

test('the Herdr terminal is read as text and pressed keys through hc, and types no text without its Enter', async () => {
  const { run, calls } = fakeRun({ 'hc read': { text: 'screen\n', complete: true, how: 'screen' } });
  const pane = hcPane(run);
  assert.deepEqual([pane.terminal, pane.colours, pane.typesText], ['herdr', false, false]);
  assert.equal(await pane.capture({ ansi: true }), 'screen\n');
  await pane.capture({ back: 40 });
  await pane.keys('Down', 'Enter');
  await pane.line('/opt/woodshed/session/bin/claude --resume x');
  await assert.rejects(pane.literal('hi'), /no text without its Enter/);
  await assert.rejects(pane.paste('hi'), /no text without its Enter/);
  assert.deepEqual(calls, [
    ['hc', 'read', '--lines', '0', '--json', '--', 'claude'],
    ['hc', 'read', '--lines', '40', '--json', '--', 'claude'],
    ['hc', 'keys', '--json', '--', 'claude', 'down', 'enter'],
    ['hc', 'send', '--json', '--', 'claude', '/opt/woodshed/session/bin/claude --resume x'],
  ]);
});

test('a key hc cannot name types nothing at all', async () => {
  const { run, calls } = fakeRun();
  await assert.rejects(hcPane(run).keys('Up', 'M-x'), /no Herdr name/);
  assert.deepEqual(calls, []);
});

// codex as `hc read` gives it: plain text, the same screen tmux captured.
const CODEX = { ...CLAUDE_RUNNING, status: null, foreground: { ...CLAUDE_RUNNING.foreground, argv: ['codex'] } };
const CODEX_AT_PROMPT = ['╭───────────────────────╮', '│ >_ OpenAI Codex       │', '╰───────────────────────╯', '', '› ', '', '  gpt-5.5 · 100% left'].join('\n');
const read = (text) => ({ text, complete: true, how: 'screen' });
const sends = (calls) => calls.filter((c) => c[1] === 'send' || c[1] === 'keys');

test('a message goes in through hc only while claude says it is idle or done, and codex, which says nothing, by its screen', async () => {
  let { run, calls } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(fixture('pane-done.txt')) });
  assert.deepEqual(await hcPane(run).send('fix it\nplease'), { sent: true });
  assert.deepEqual(calls.at(-1), ['hc', 'send', '--if', 'idle', '--json', '--', 'claude', 'fix it\nplease']);
  // After a finished turn claude says `done`, which hc's `--if idle` refuses (`t1 is done, not idle`): sent with no --if.
  ({ run, calls } = fakeRun({ 'hc get': { ...CLAUDE_RUNNING, status: { app: 'claude-code', state: 'done' } }, 'hc read': read(fixture('pane-done.txt')) }));
  assert.deepEqual(await hcPane(run).send('how can i test it'), { sent: true });
  assert.deepEqual(calls.at(-1), ['hc', 'send', '--json', '--', 'claude', 'how can i test it']);
  for (const state of ['working', 'blocked', 'error']) {
    ({ run, calls } = fakeRun({ 'hc get': { ...CLAUDE_RUNNING, status: { app: 'claude-code', state } }, 'hc read': read(fixture('pane-done.txt')) }));
    assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'status_mismatch' }, state);
    assert.deepEqual(sends(calls), [], state);
  }
  ({ run, calls } = fakeRun({ 'hc get': CODEX, 'hc read': read(CODEX_AT_PROMPT) }));
  assert.deepEqual(await hcPane(run).send('go on'), { sent: true });
  assert.deepEqual(calls.at(-1), ['hc', 'send', '--json', '--', 'claude', 'go on'], 'no record: codex read at its prompt');
});

// claude's record after each turn: `done`, kept until its next turn starts (measured, claude 2.1.330 on hc 0.1.21).
const CLAUDE_DONE = { ...CLAUDE_RUNNING, status: { app: 'claude-code', state: 'done' } };

test('a done record is not enough while the screen shows claude working or asking: nothing goes in', async () => {
  for (const [name, screen, why] of [['working', fixture('pane-working.txt'), 'not-at-prompt'], ['approval', fixture('pane-permission.txt'), 'prompt-open']]) {
    const { run, calls } = fakeRun({ 'hc get': CLAUDE_DONE, 'hc read': read(screen) });
    assert.equal((await hcPane(run).send('hi')).why, why, name);
    assert.deepEqual(sends(calls), [], name);
  }
});

test('a message that starts with a dash is the message, never one of hc\'s options', async () => {
  const { run, calls } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(fixture('pane-done.txt')) });
  assert.deepEqual(await hcPane(run).send('- first\n- second'), { sent: true });
  const sent = calls.at(-1);
  assert.equal(sent.at(-1), '- first\n- second');
  assert.ok(sent.indexOf('--') < sent.indexOf('- first\n- second') && sent.indexOf('--json') < sent.indexOf('--'), 'every option before --');
});

test('nothing goes in through hc while codex shows an approval, which has no record to say so: no paste, no Enter', async () => {
  const { run, calls } = fakeRun({ 'hc get': CODEX, 'hc read': read(fixture('pane-codex-approval.txt')) });
  assert.deepEqual(await hcPane(run).send('looks good'), { sent: false, why: 'prompt-open', kind: 'approval' });
  assert.deepEqual(sends(calls), []);
});

test('nothing goes in through hc while claude asks a question or shows a numbered menu, whatever its record says', async () => {
  // A numbered menu typeMessage refuses in tmux, as panePrompt.test.mjs draws it.
  const menu = [' Do you trust the files in this folder?', '', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to exit'].join('\n');
  for (const [name, kind, screen] of [['question', 'question', fixture('pane-askquestion.txt')], ['approval', 'approval', fixture('pane-permission.txt')], ['menu', 'menu', menu]]) {
    const { run, calls } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(screen) });
    assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'prompt-open', kind }, name);
    assert.deepEqual(sends(calls), [], name);
  }
});

test('with no record and neither agent at its prompt on screen, nothing goes in through hc', async () => {
  const { run, calls } = fakeRun({ 'hc get': CODEX, 'hc read': read(fixture('pane-shell.txt')) });
  assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'not-at-prompt' });
  assert.deepEqual(sends(calls), []);
});

test('hc\'s refusal is said by its kind: a prompt open, or an agent no longer idle', async () => {
  let { run } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(fixture('pane-done.txt')), 'hc send': refused('blocked') });
  assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'blocked' });
  ({ run } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(fixture('pane-done.txt')), 'hc send': refused('status_mismatch') }));
  assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'status_mismatch' });
  ({ run } = fakeRun({ 'hc get': CLAUDE_RUNNING, 'hc read': read(fixture('pane-done.txt')), 'hc send': new Error('spawn hc ENOENT') }));
  assert.deepEqual(await hcPane(run).send('hi'), { sent: false, why: 'not-sent' });
});

test('the agent runs in the Herdr terminal while claude or codex is its foreground, whose OS name for claude is its version', async () => {
  assert.equal(isAgentForeground(CLAUDE_RUNNING.foreground), true);
  assert.equal(isAgentForeground({ pid: 1, name: 'node', argv: ['node', '/usr/local/bin/codex', '--sandbox'] }), true);
  assert.equal(isAgentForeground(SHELL_ONLY.foreground), false);
  assert.equal(isAgentForeground({ pid: 1, name: 'node', argv: ['node', 'server.js'] }), false);
  assert.equal(isAgentForeground(null), false, 'a finished terminal');
  let { run } = fakeRun({ 'hc get': CLAUDE_RUNNING });
  assert.equal(await hcPane(run).agentRunning(), true);
  ({ run } = fakeRun({ 'hc get': SHELL_ONLY }));
  assert.equal(await hcPane(run).agentRunning(), false, 'claude exited: its shell would run the text');
});

test('hc\'s word on the agent is its terminal\'s status, and the shell under it is the terminal\'s own program', async () => {
  const { run, calls } = fakeRun({ '/usr/local/bin/hc get': CLAUDE_RUNNING });
  const pane = hcPane(run, { bin: '/usr/local/bin/hc' });
  assert.deepEqual(await pane.agent(), { app: 'claude-code', state: 'idle' });
  assert.equal(await pane.shellPid(), 4100);
  assert.deepEqual(calls[0], ['/usr/local/bin/hc', 'get', '--json', '--', 'claude']);
  const { run: quiet } = fakeRun({ 'hc get': SHELL_ONLY });
  assert.equal(await hcPane(quiet).agent(), null, 'nothing reported: the agent\'s own reader stands alone');
});

test('the session\'s pane is tmux\'s unless the entrypoint said Herdr', async (t) => {
  const { run, calls } = fakeRun();
  // Unset, as the entrypoint leaves it in a session that is not Herdr's: not this run's own, which a Herdr session sets.
  const own = process.env.WOODSHED_TERMINAL;
  delete process.env.WOODSHED_TERMINAL;
  t.after(() => { if (own !== undefined) process.env.WOODSHED_TERMINAL = own; });
  assert.equal(agentPane(run).terminal, 'tmux');
  assert.equal(agentPane(run, { terminal: undefined }).terminal, 'tmux');
  assert.equal(agentPane(run, { terminal: 'tmux' }).terminal, 'tmux');
  const pane = agentPane(run, { terminal: 'herdr', bin: 'hc' });
  assert.equal(pane.terminal, 'herdr');
  await pane.keys('Escape');
  assert.deepEqual(calls, [['hc', 'keys', '--json', '--', 'claude', 'esc']]);
});
