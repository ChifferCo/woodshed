// The panes of Grok Build and OpenCode, as shared/__fixtures__/pane-<agent>-*.txt draw them. The `-idle-captured` ones
// are each agent's first screen, captured in the session image (grok 1.0.92 on a key, opencode 1.19.6) as the
// entrypoint starts them; the rest are reconstructed from each agent's source or binary strings (paneStates.mjs,
// panePrompt.mjs), and are the same screens the dev console's stand-in agent draws (console/bin/devChatAgent.mjs): no
// turn or approval of theirs has run here, which needs a real model behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyAgentPane, classifyAntigravityPane, classifyCodexPane, classifyGrokPane, classifyOpencodePane } from './paneStates.mjs';
import { answerApproval, draftInBox, opencodeHighlight, readApproval, readPrompt } from './panePrompt.mjs';

const fixture = (name) => fs.readFileSync(new URL(`../shared/__fixtures__/${name}`, import.meta.url), 'utf8');

test('Grok Build\'s pane reads as working, waiting on a person, or at its prompt', () => {
  assert.equal(classifyGrokPane(fixture('pane-grok-working.txt')), 'working');
  assert.equal(classifyGrokPane(fixture('pane-grok-approval.txt')), 'needs-you');
  assert.equal(classifyGrokPane(fixture('pane-grok-idle.txt')), 'done');
  assert.equal(classifyGrokPane('node@host:/work$ \n'), null);
});

test('each agent\'s real first screen, captured in the session image, reads as at its prompt and asking nothing', () => {
  assert.equal(classifyGrokPane(fixture('pane-grok-idle-captured.txt')), 'done');
  assert.equal(classifyAgentPane('grok', fixture('pane-grok-idle-captured.txt')), 'done');
  assert.equal(classifyOpencodePane(fixture('pane-opencode-idle-captured.txt')), 'done');
  for (const agent of ['grok', 'opencode']) assert.equal(readApproval(fixture(`pane-${agent}-idle-captured.txt`)), null, agent);
});

test('OpenCode\'s pane reads as working, waiting on a person, or at its prompt', () => {
  assert.equal(classifyOpencodePane(fixture('pane-opencode-working.txt')), 'working');
  assert.equal(classifyOpencodePane(fixture('pane-opencode-approval.txt')), 'needs-you');
  assert.equal(classifyOpencodePane(fixture('pane-opencode-idle.txt')), 'done');
  assert.equal(classifyOpencodePane(''), null);
});

test('each agent is read by its own classifier, and codex\'s is the same as before', () => {
  assert.equal(classifyAgentPane('opencode', fixture('pane-opencode-approval.txt')), 'needs-you');
  assert.equal(classifyAgentPane('grok', fixture('pane-grok-approval.txt')), 'needs-you');
  assert.equal(classifyAgentPane('codex', fixture('pane-codex-approval.txt')), classifyCodexPane(fixture('pane-codex-approval.txt')));
  assert.equal(classifyAgentPane('claude', fixture('pane-grok-idle.txt')), null);
});

test('Grok Build\'s approval: just this once is Yes, proceed, never the always-approve row; No rejects', () => {
  const a = readApproval(fixture('pane-grok-approval.txt'), 'grok');
  assert.equal(a.agent, 'grok');
  assert.equal(a.title, 'Allow `npm`?');
  assert.deepEqual(a.detail, ['$ npm run migrate']);
  assert.equal(a.options[a.approve].label, 'Yes, proceed');
  assert.equal(a.options[a.deny].label, 'No, reject (type to add feedback)');
  assert.equal(a.highlighted, 1);
  assert.equal(a.digits, true);
  assert.equal(readPrompt(fixture('pane-grok-approval.txt'), 'grok').kind, 'approval');
  // Not another agent's.
  assert.equal(readApproval(fixture('pane-grok-approval.txt'), 'claude'), null);
});

test('a numbered list Grok printed is no approval', () => {
  assert.equal(readApproval('Allow me to explain?\n\n  2. second\n  3. third\n', 'grok'), null);
});

test('OpenCode\'s approval is read through its border, and rejected with Esc', () => {
  const a = readApproval(fixture('pane-opencode-approval.txt'), 'opencode');
  assert.equal(a.agent, 'opencode');
  assert.equal(a.what, 'Shell command', 'its heading\'s mark left out');
  assert.deepEqual(a.detail, ['$ npm run migrate']);
  assert.deepEqual(a.keys, { deny: ['Escape'] }, 'Approve walks from the pick its colours show (opencodeHighlight)');
  assert.equal(a.options[a.approve].label, 'Allow once');
  assert.equal(a.options[a.deny].label, 'Reject');
});

// A pane that answers as the stand-in does: the approval gone after the right keys.
function fakePane(screen, gone) {
  const typed = [];
  let shown = screen;
  return {
    typed,
    io: {
      capture: async () => shown,
      keys: async (...keys) => { typed.push(...keys); if (gone(keys)) shown = 'done\n'; },
      literal: async (text) => { typed.push(`literal:${text}`); if (gone([text])) shown = 'done\n'; },
      sleep: async () => {},
      waitMs: 50,
    },
  };
}

test('answering Grok types the row\'s number; rejecting OpenCode presses Esc', async () => {
  const grok = fixture('pane-grok-approval.txt');
  const g = fakePane(grok, (keys) => keys.includes('2'));
  const key = readApproval(grok, 'grok').key;
  await answerApproval({ ...g.io, agent: 'grok' }, { decision: 'approve', key });
  assert.deepEqual(g.typed, ['literal:2']);

  const no = fakePane(fixture('pane-opencode-approval.txt'), (keys) => keys.includes('Escape'));
  await answerApproval({ ...no.io, agent: 'opencode' }, { decision: 'deny', key: readApproval(fixture('pane-opencode-approval.txt'), 'opencode').key });
  assert.deepEqual(no.typed, ['Escape']);
});

// OpenCode 1.19.6's real approval, captured with its colours with each choice picked: Left and Right wrap round them,
// as its permission.tsx has it.
const OPENCODE_PICKS = ['once', 'always', 'reject'].map((pick) => fixture(`pane-opencode-approval-${pick}-captured.ansi`));
const plainOf = (colored) => colored.replace(/\x1b\[[0-9;]*m/g, '');

test('OpenCode\'s pick is read from its colours, captured from the real prompt', () => {
  assert.deepEqual(OPENCODE_PICKS.map(opencodeHighlight), [0, 1, 2]);
  assert.equal(opencodeHighlight(plainOf(OPENCODE_PICKS[2])), null, 'no colours, no pick');
  assert.equal(opencodeHighlight(fixture('pane-opencode-idle-captured.txt')), null);
  const a = readApproval(plainOf(OPENCODE_PICKS[0]), 'opencode');
  assert.deepEqual([a.agent, a.what, a.detail], ['opencode', 'Shell command', ['$ echo hello']], 'the sidebar\'s footer beside it is not what it asks');
});

// A stand-in OpenCode prompt: Left and Right move the pick round the three, Enter answers the one picked.
function opencodePane(start) {
  let at = start;
  let answered = null;
  const typed = [];
  return {
    typed,
    answered: () => answered,
    io: {
      agent: 'opencode',
      capture: async () => (answered === null ? plainOf(OPENCODE_PICKS[at]) : 'done\n'),
      colored: async () => (answered === null ? OPENCODE_PICKS[at] : 'done\n'),
      keys: async (...keys) => {
        typed.push(...keys);
        for (const k of keys) {
          if (k === 'Left') at = (at + 2) % 3;
          if (k === 'Right') at = (at + 1) % 3;
          if (k === 'Enter') answered = ['once', 'always', 'reject'][at];
          if (k === 'Escape') answered = 'reject';
        }
      },
      sleep: async () => {},
      waitMs: 50,
    },
  };
}

test('approving OpenCode from Chat allows once, wherever the TUI tab left its pick', async () => {
  const key = readApproval(plainOf(OPENCODE_PICKS[0]), 'opencode').key;
  for (const [start, lefts] of [[0, 0], [1, 1], [2, 2]]) {
    const pane = opencodePane(start);
    await answerApproval(pane.io, { decision: 'approve', key });
    assert.equal(pane.answered(), 'once', `from ${start}`);
    assert.deepEqual(pane.typed, [...Array(lefts).fill('Left'), 'Enter'], `from ${start}`);
  }
  // Fixed keys (three Lefts, then Enter) answered whatever was picked: from Reject, a Reject.
  const old = opencodePane(2);
  await old.io.keys('Left', 'Left', 'Left', 'Enter');
  assert.equal(old.answered(), 'reject');
  // A read with no colours (Herdr's) cannot see the pick: nothing is typed, and the TUI tab answers.
  const herdr = opencodePane(2);
  delete herdr.io.colored;
  await assert.rejects(answerApproval(herdr.io, { decision: 'approve', key }), (err) => err.why === 'no-highlight');
  assert.deepEqual(herdr.typed, []);
  const deny = opencodePane(0);
  await answerApproval(deny.io, { decision: 'deny', key });
  assert.equal(deny.answered(), 'reject');
});

// Grok Build 1.0.92's and OpenCode 1.19.6's input boxes, captured with their colours, empty and with a draft typed in.
test('a draft left in Grok Build\'s or OpenCode\'s box is seen, so a Chat message is not typed onto it', () => {
  for (const agent of ['grok', 'opencode']) {
    assert.equal(draftInBox(fixture(`pane-${agent}-box-empty.ansi`), agent), false, `${agent}: empty, its placeholder included`);
    assert.equal(draftInBox(fixture(`pane-${agent}-box-draft.ansi`), agent), true, `${agent}: a draft`);
  }
  const plain = (name) => fixture(name).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(draftInBox(plain('pane-opencode-box-draft.ansi'), 'opencode'), null, 'OpenCode\'s placeholder is told from a draft by colour alone');
  assert.equal(draftInBox(plain('pane-grok-box-draft.ansi'), 'grok'), true);
  const sidebar = '  ┃\x1b[48;5;234m     \x1b[48;5;233;38;5;255min-image-\n'
    + '  ┃\x1b[48;5;234m  Build auto · \x1b[38;5;255mGPT-5\x1b[0m';
  assert.equal(draftInBox(sidebar, 'opencode'), false, 'branch text belongs to the sidebar');
  assert.equal(draftInBox(sidebar.replace('     ', '\x1b[38;5;255ma draft'), 'opencode'), true);
  const suggestion = '  │ ❯ \x1b[2;3mDone.\x1b[0m │\n  ╰──── grok-build ─╯';
  assert.equal(draftInBox(suggestion, 'grok'), false);
  assert.equal(draftInBox(suggestion.replace('❯ ', '❯ a draft '), 'grok'), true);
  for (const color of ['38;5;2', '38;2;65;42;23']) {
    assert.equal(draftInBox(suggestion.replace('❯ ', `❯ \x1b[${color}ma draft `), 'grok'), true);
  }
  assert.equal(draftInBox('a shell prompt $ \n', 'grok'), null, 'no box, no reading');
  assert.equal(draftInBox(fixture('pane-opencode-approval-once-captured.ansi'), 'opencode'), null, 'a prompt in its place');
});

// Antigravity CLI 1.5.18's screens, captured from the real TUI in tmux against a stand-in Gemini server (140 columns,
// altScreenMode never, the checkout drawn as /work/repo): shared/__fixtures__/pane-agy-*.
test('Antigravity CLI\'s pane reads as working, waiting on a person, or at its prompt', () => {
  assert.equal(classifyAntigravityPane(fixture('pane-agy-idle.txt')), 'done');
  assert.equal(classifyAntigravityPane(fixture('pane-agy-working.txt')), 'working');
  for (const name of ['approval-command', 'approval-create', 'approval-edit', 'question']) {
    assert.equal(classifyAntigravityPane(fixture(`pane-agy-${name}.txt`)), 'needs-you', name);
    assert.equal(classifyAgentPane('antigravity', fixture(`pane-agy-${name}.txt`)), 'needs-you', name);
  }
  assert.equal(classifyAntigravityPane('woodshed@abc:/work/app$ '), null);
  assert.equal(classifyAntigravityPane(''), null);
  assert.equal(classifyAgentPane('claude', fixture('pane-agy-idle.txt')), null);
});

test('a slash menu opened in agy\'s box is a person typing, not a question for them', () => {
  const menu = ['> /exit', '─────', '> /exit  Exit the CLI', '  ↑/↓ Navigate · enter Select · tab Complete', 'esc to cancel'].join('\n');
  assert.equal(classifyAntigravityPane(menu), 'done');
  assert.equal(readApproval(menu, 'antigravity'), null);
});

test('agy\'s approvals are read whatever they ask: a command, a new file, an edit', () => {
  const command = readApproval(fixture('pane-agy-approval-command.txt'), 'antigravity');
  assert.deepEqual([command.agent, command.what, command.title, command.detail], ['antigravity', 'Command', 'Run this command?', ['Requesting permission for:', '   echo hello-agy']]);
  assert.deepEqual(command.options.map((o) => o.label), ["Yes, run command", "Yes, and always allow in this conversation for commands that start with 'echo'", "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)", 'No, cancel']);
  // Approve is the plain Yes, never an "always allow" row; deny the No.
  assert.deepEqual([command.approve, command.deny, command.highlighted, command.complete], [0, 3, 0, true]);
  const created = readApproval(fixture('pane-agy-approval-create.txt'), 'antigravity');
  assert.deepEqual([created.what, created.title, created.detail, created.options.map((o) => o.label)], ['Create file', 'Allow creation of this file?', ['/work/repo/new-file.txt  +1', '  1  +  hello'], ['Yes, allow creation', 'No, deny creation']]);
  const edit = readApproval(fixture('pane-agy-approval-edit.txt'), 'antigravity');
  assert.deepEqual([edit.what, edit.title, edit.options.map((o) => o.label)], ['Pending edit', 'Accept this file edit?', ['Yes, accept this change', 'No, reject this change']]);
  assert.match(edit.detail.join('\n'), /-  hello\n.*\+  howdy/);
  // The key is what it asks, as drawn: another command is another approval.
  assert.notEqual(command.key, readApproval(fixture('pane-agy-approval-command.txt').replaceAll('echo hello-agy', 'echo hello-agz'), 'antigravity').key);
  // Its question picker is no approval, nor is an idle screen, nor another agent's reading of either.
  assert.equal(readApproval(fixture('pane-agy-question.txt'), 'antigravity'), null);
  assert.equal(readApproval(fixture('pane-agy-idle.txt'), 'antigravity'), null);
  assert.equal(readApproval(fixture('pane-agy-approval-command.txt'), 'codex'), null);
  assert.equal(readPrompt(fixture('pane-agy-approval-command.txt'), 'antigravity').kind, 'approval');
});

test('a numbered list agy printed above its prompt is no approval', () => {
  const printed = ['Which do you want?', '  1. first', '  2. second', '', '─────', '> ', '─────', '? for shortcuts'].join('\n');
  assert.equal(readApproval(printed, 'antigravity'), null);
});

test('answering agy moves the highlight to the row and presses Enter; a deny walks down to No', async () => {
  const screen = fixture('pane-agy-approval-command.txt');
  const key = readApproval(screen, 'antigravity').key;
  const approve = fakePane(screen, (keys) => keys.includes('Enter'));
  assert.deepEqual(await answerApproval({ ...approve.io, agent: 'antigravity' }, { decision: 'approve', key }), { moves: 0, agent: 'antigravity' });
  assert.deepEqual(approve.typed, ['Enter']);
  // The pane moves its `>` with each Down, as agy does.
  let at = 0;
  const typed = [];
  const walking = {
    capture: async () => {
      if (typed.includes('Enter')) return 'done\n';
      let n = 0;
      return screen.split('\n').map((l) => (/^\s*>? ?\d\.\s/.test(l) ? `${++n - 1 === at ? '>' : ' '} ${l.trim().replace(/^>\s*/, '')}` : l)).join('\n');
    },
    keys: async (...keys) => { for (const k of keys) { typed.push(k); if (k === 'Down') at++; } },
    sleep: async () => {}, waitMs: 50, agent: 'antigravity',
  };
  assert.deepEqual(await answerApproval(walking, { decision: 'deny', key }), { moves: 3, agent: 'antigravity' });
  assert.deepEqual(typed, ['Down', 'Down', 'Down', 'Enter']);
});

test('agy\'s box holds a draft only when something is in the colour a typed draft has, not its mode\'s hint in bright black', () => {
  assert.equal(draftInBox(fixture('pane-agy-box-idle-default.ansi'), 'antigravity'), false);
  assert.equal(draftInBox(fixture('pane-agy-box-empty.ansi'), 'antigravity'), false, 'the accept-edits hint is a placeholder');
  assert.equal(draftInBox(fixture('pane-agy-box-draft.ansi'), 'antigravity'), true);
  assert.equal(draftInBox('no box here\n', 'antigravity'), null);
});
