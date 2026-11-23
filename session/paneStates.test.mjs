// The panes of Grok Build, Antigravity and OpenCode, as shared/__fixtures__/pane-<agent>-*.txt draw them. The
// `-idle-captured` ones are each agent's first screen, captured in the session image (grok 1.0.92 on a key, agy 1.5.14
// on a key, opencode 1.19.6) as the entrypoint starts them; the rest are reconstructed from each agent's source or
// binary strings (paneStates.mjs, panePrompt.mjs), and are the same screens the dev console's stand-in agent draws
// (console/bin/devChatAgent.mjs): no turn or approval of theirs has run here, which needs a real model behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyAgentPane, classifyCodexPane, classifyGrokPane, classifyOpencodePane } from './paneStates.mjs';
import { answerApproval, readApproval, readPrompt } from './panePrompt.mjs';

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
  // Antigravity's state is its status line's (agentStatusLine.mjs); its screen only says when it asks.
  assert.equal(classifyAgentPane('antigravity', fixture('pane-antigravity-idle-captured.txt')), null);
  for (const agent of ['grok', 'antigravity', 'opencode']) assert.equal(readApproval(fixture(`pane-${agent}-idle-captured.txt`)), null, agent);
});

test('OpenCode\'s pane reads as working, waiting on a person, or at its prompt', () => {
  assert.equal(classifyOpencodePane(fixture('pane-opencode-working.txt')), 'working');
  assert.equal(classifyOpencodePane(fixture('pane-opencode-approval.txt')), 'needs-you');
  assert.equal(classifyOpencodePane(fixture('pane-opencode-idle.txt')), 'done');
  assert.equal(classifyOpencodePane(''), null);
});

test('each agent is read by its own classifier, and codex\'s is the same as before', () => {
  assert.equal(classifyAgentPane('antigravity', fixture('pane-antigravity-approval.txt')), 'needs-you');
  assert.equal(classifyAgentPane('antigravity', fixture('pane-grok-idle.txt')), null);
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

test('OpenCode\'s approval is read through its border, and answered with fixed keys', () => {
  const a = readApproval(fixture('pane-opencode-approval.txt'), 'opencode');
  assert.equal(a.agent, 'opencode');
  assert.equal(a.what, '# Shell command');
  assert.deepEqual(a.detail, ['$ npm run migrate']);
  assert.deepEqual(a.keys, { approve: ['Left', 'Left', 'Left', 'Enter'], deny: ['Escape'] });
  assert.equal(a.options[a.approve].label, 'Allow once');
  assert.equal(a.options[a.deny].label, 'Reject');
});

test('Antigravity\'s approval, from its binary\'s words', () => {
  const a = readApproval(fixture('pane-antigravity-approval.txt'), 'antigravity');
  assert.equal(a.title, 'Run this command?');
  assert.equal(a.options[a.approve].label, 'Yes, allow tool call');
  assert.equal(a.options[a.deny].label, 'No, deny permission');
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

test('answering Grok types the row\'s number; OpenCode walks left and presses Enter, or Esc', async () => {
  const grok = fixture('pane-grok-approval.txt');
  const g = fakePane(grok, (keys) => keys.includes('2'));
  const key = readApproval(grok, 'grok').key;
  await answerApproval({ ...g.io, agent: 'grok' }, { decision: 'approve', key });
  assert.deepEqual(g.typed, ['literal:2']);

  const oc = fixture('pane-opencode-approval.txt');
  const ocKey = readApproval(oc, 'opencode').key;
  const yes = fakePane(oc, (keys) => keys.includes('Enter'));
  await answerApproval({ ...yes.io, agent: 'opencode' }, { decision: 'approve', key: ocKey });
  assert.deepEqual(yes.typed, ['Left', 'Left', 'Left', 'Enter']);
  const no = fakePane(oc, (keys) => keys.includes('Escape'));
  await answerApproval({ ...no.io, agent: 'opencode' }, { decision: 'deny', key: ocKey });
  assert.deepEqual(no.typed, ['Escape']);
});
