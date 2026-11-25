import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DOCUMENT_BYTES, MAX_NOTE_CHARS, agentName, handoffDocument, handoffNote, handoffPrompt } from './handoff.mjs';

const from = { id: 'aaaa1111', title: 'Fix the login', agent: 'claude', branch: 'woodshed/joel-aaaa1111' };

test('the hand-off file has the conversation in order, each tool on a line of its own, and keeps fences whole', () => {
  const doc = handoffDocument({
    from, to: { agent: 'codex' }, at: '2026-11-23T10:00:00.000Z',
    entries: [
      { role: 'user', text: 'Fix the login', at: '2026-11-23T09:00:00.000Z' },
      { role: 'tool', tool: 'Bash', text: 'npm test ``` oops', error: true, at: null },
      { role: 'tool', tool: 'Edit', text: 'src/login.js', diffs: [{ path: 'src/login.js' }], at: null },
      { role: 'assistant', text: 'The token check was inverted.', at: null },
    ],
  });
  assert.match(doc, /^# Hand-off from Claude Code/);
  assert.match(doc, /## The conversation\n\n### The person/);
  assert.match(doc, /handed the work to Codex/);
  assert.match(doc, /`woodshed\/joel-aaaa1111`/);
  assert.ok(doc.indexOf('Fix the login (') < doc.indexOf('Ran `Bash` (failed)'), 'oldest first');
  assert.match(doc, /````\nnpm test ``` oops\n````/, 'a fence longer than any run of backticks inside it');
  assert.match(doc, /Changed: `src\/login.js`/);
  assert.match(doc, /### The agent\n\nThe token check was inverted\./);
});

test('a hand-off file over its size leaves out the oldest entries, and says so', () => {
  const big = 'x'.repeat(7000);
  const entries = Array.from({ length: 400 }, (_, i) => ({ role: 'assistant', text: `${i} ${big}`, at: null }));
  const doc = handoffDocument({ from, to: { agent: 'codex' }, at: 'now', entries });
  assert.ok(Buffer.byteLength(doc) <= MAX_DOCUMENT_BYTES);
  assert.match(doc, /_\d+ earlier entries were left out/);
  assert.match(doc, /399 x/, 'the newest stays');
  assert.doesNotMatch(doc, /\n0 x/, 'the oldest goes');
  assert.match(handoffDocument({ from, to: { agent: 'codex' }, at: 'now', entries: [] }), /had no conversation/);
});

test('the prompt puts the person\'s note first and says whether the conversation came', () => {
  const withIt = handoffPrompt({ from, note: 'Only the tests are left.', conversation: true });
  assert.ok(withIt.startsWith('Only the tests are left.\n'));
  assert.match(withIt, /from a Claude Code session \(aaaa1111, "Fix the login"\)/);
  assert.match(withIt, /attached handoff\.md/);
  const without = handoffPrompt({ from: { ...from, agent: 'codex' }, note: '', conversation: false });
  assert.match(without, /^You are taking over work from a Codex session/);
  assert.match(without, /was not handed over/);
});

test('a note is trimmed, and refused rather than cut when too long; agents are called by their products\' names', () => {
  assert.equal(handoffNote('  hi  '), 'hi');
  assert.equal(handoffNote(undefined), '');
  assert.throws(() => handoffNote('x'.repeat(MAX_NOTE_CHARS + 1)), { shown: true });
  assert.throws(() => handoffNote(42), { shown: true });
  assert.deepEqual(['claude', 'codex', 'grok', 'opencode', undefined].map(agentName), ['Claude Code', 'Codex', 'Grok Build', 'OpenCode', 'Claude Code']);
});
