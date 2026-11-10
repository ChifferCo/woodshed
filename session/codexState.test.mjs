import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCodexPane } from './codexState.mjs';

test('a codex pane reads as working, waiting on a person, or at its prompt', () => {
  assert.equal(classifyCodexPane('• Working (12s • esc to interrupt)\n\n› Ask Codex to do anything\n'), 'working');
  assert.equal(classifyCodexPane('Would you like to run the following command?\n  $ rm x\n› 1. Yes, proceed\nPress enter to confirm or esc to cancel\n'), 'needs-you');
  assert.equal(classifyCodexPane('done.\n\n› Ask Codex to do anything\n  gpt-5.5 · /work/app\n'), 'done');
});

test('output higher up the screen is not read as a marker, and a bare shell is not codex', () => {
  const scrolled = `esc to interrupt\n${'text\n'.repeat(30)}› Ask Codex to do anything\n`;
  assert.equal(classifyCodexPane(scrolled), 'done');
  assert.equal(classifyCodexPane('node@host:/work$ \n'), null);
  assert.equal(classifyCodexPane(''), null);
});
