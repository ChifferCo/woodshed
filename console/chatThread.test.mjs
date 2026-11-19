import { test } from 'node:test';
import assert from 'node:assert/strict';

import chat from './public/chatThread.cjs';

const at = '2026-11-19T10:00:00.000Z';

test('a run of tool calls between messages is one work log, keyed by where it starts', () => {
  const entries = [
    { role: 'user', text: 'Fix the login bug', at },
    { role: 'assistant', text: 'Looking at it.', at },
    { role: 'tool', tool: 'Read', text: 'login.js', at },
    { role: 'tool', tool: 'Bash', text: 'npm test', at, error: true },
    { role: 'tool', tool: 'Edit', text: 'login.js', at },
    { role: 'assistant', text: 'Fixed.', at },
    { role: 'user', text: '[Request interrupted by user]', at },
    { role: 'tool', tool: 'Bash', text: 'ls', at },
  ];
  const items = chat.items(entries);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'work', 'assistant', 'note', 'work']);
  assert.equal(items[2].key, 2);
  assert.equal(items[2].tools.length, 3);
  assert.equal(items[2].failed, 1);
  assert.equal(items[4].text, 'Interrupted');
  assert.equal(items[5].key, 7);
  // An entry added after a work log leaves its key where it was, so a fold the person opened stays open.
  assert.equal(chat.items([...entries, { role: 'tool', tool: 'Read', text: 'b', at }])[5].key, 7);
});

test('a work log is summed up by what its tools did, claude\'s names and codex\'s', () => {
  const tools = ['Bash', 'Bash', 'Edit', 'Read', 'Grep', 'shell', 'apply_patch', 'TodoWrite', 'mcp__slack__send'].map((tool) => ({ tool }));
  assert.equal(chat.workSummary(tools), 'Ran 3 commands, edited 2 files, read 1 file, searched 1 time, updated the plan, used 1 other tool');
  assert.equal(chat.workSummary([{ tool: 'exec_command' }]), 'Ran 1 command');
  assert.equal(chat.workSummary([]), '');
});

test('a question the agent asked is its own item, out of the work log around it', () => {
  const q = [{ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }];
  const list = chat.items([
    { role: 'tool', tool: 'Bash', text: 'ls' },
    { role: 'tool', tool: 'AskUserQuestion', text: 'Tabs or spaces?', questions: q, answered: true },
    { role: 'tool', tool: 'Read', text: 'a.js' },
  ]);
  assert.deepEqual(list.map((i) => i.kind), ['work', 'ask', 'work']);
  assert.deepEqual(list[1], { kind: 'ask', questions: q, answered: true, declined: false, at: undefined });
});

test('markdown reads into blocks: paragraphs, headings, lists, quotes, tables, rules and fenced code', () => {
  const blocks = chat.markdown([
    '## Plan', '', 'First **this**, then `that`.', 'Same paragraph.', '',
    '- one', '- two', '  wrapped', '', '1. first', '2) second', '',
    '> quoted', '', '---', '',
    '| File | Lines |', '| --- | ---: |', '| a.js | 3 |', '',
    '```js', 'const x = 1;', '', 'x++;', '```', 'after',
  ].join('\n'));
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'ul', 'ol', 'quote', 'hr', 'table', 'code', 'p']);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].inline, [
    { t: 'text', v: 'First ' }, { t: 'b', v: 'this' }, { t: 'text', v: ', then ' }, { t: 'code', v: 'that' }, { t: 'text', v: '.\nSame paragraph.' },
  ]);
  assert.deepEqual(blocks[2].items, [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two\nwrapped' }]]);
  assert.equal(blocks[3].items.length, 2);
  assert.deepEqual(blocks[6].head.map((c) => c[0].v), ['File', 'Lines']);
  assert.deepEqual(blocks[6].rows, [[[{ t: 'text', v: 'a.js' }], [{ t: 'text', v: '3' }]]]);
  assert.deepEqual(blocks[7], { type: 'code', lang: 'js', text: 'const x = 1;\n\nx++;' });
});

test('a table cell keeps an escaped pipe, and a pipe inside code, as one cell', () => {
  // As a real claude wrote it: GFM's `\|` in a code span. Some models leave the pipe in code unescaped.
  const [table] = chat.markdown([
    '| What | Source |', '| --- | --- |',
    "| count | `find console -name '*.mjs' \\| wc -l` |",
    '| raw | `a | b` and c \\| d |',
  ].join('\n'));
  assert.equal(table.head.length, 2);
  assert.deepEqual(table.rows.map((r) => r.length), [2, 2]);
  assert.deepEqual(table.rows[0][1], [{ t: 'code', v: "find console -name '*.mjs' | wc -l" }]);
  assert.deepEqual(table.rows[1][1], [{ t: 'code', v: 'a | b' }, { t: 'text', v: ' and c | d' }]);
});

test('a fence left open runs to the end, and markup inside code stays text', () => {
  assert.deepEqual(chat.markdown('```\n**not bold**\n<b>x</b>'), [{ type: 'code', lang: '', text: '**not bold**\n<b>x</b>' }]);
  assert.deepEqual(chat.inline('`**x**`'), [{ t: 'code', v: '**x**' }]);
});

test('only http, https and mailto become links: a reply cannot make a javascript: link', () => {
  assert.deepEqual(chat.inline('[docs](https://example.com/a) and [bad](javascript:alert(1))'), [
    { t: 'a', v: 'docs', href: 'https://example.com/a' }, { t: 'text', v: ' and ' }, { t: 'text', v: '[bad](javascript:alert(1)' }, { t: 'text', v: ')' },
  ]);
  assert.deepEqual(chat.inline('see https://github.com/o/r/pull/12.'), [
    { t: 'text', v: 'see ' }, { t: 'a', v: 'https://github.com/o/r/pull/12', href: 'https://github.com/o/r/pull/12' }, { t: 'text', v: '.' },
  ]);
  assert.deepEqual(chat.inline('snake_case_name and 2*3*4'), [{ t: 'text', v: 'snake_case_name and 2*3*4' }], 'no emphasis inside words');
});

test('a sent message waits until the record holds it, then goes; one never seen goes after ten minutes', () => {
  const now = Date.parse(at);
  const pending = [{ text: 'Run the tests', sentAt: now - 2000 }, { text: 'Then  push', sentAt: now - 1000 }];
  assert.equal(chat.stillPending(pending, [], now).length, 2);
  const held = [{ role: 'user', text: 'Run the tests', at: new Date(now - 1500).toISOString() }];
  assert.deepEqual(chat.stillPending(pending, held, now).map((p) => p.text), ['Then  push']);
  // The record can add to it (a file's path) and squash its spaces.
  const both = [...held, { role: 'user', text: 'Then push\n/tmp/uploads/a.png', at: new Date(now).toISOString() }];
  assert.deepEqual(chat.stillPending(pending, both, now), []);
  // The same words asked an hour ago are not this message.
  assert.equal(chat.stillPending(pending, [{ role: 'user', text: 'Run the tests', at: new Date(now - 3_600_000).toISOString() }], now).length, 2);
  assert.deepEqual(chat.stillPending(pending, [], now + 11 * 60_000), []);
});

test('the working clock counts from the newest message the person sent', () => {
  const t0 = Date.parse(at);
  assert.equal(chat.turnStart([{ role: 'user', text: 'a', at }, { role: 'tool', tool: 'Bash', text: 'x', at: null }]), t0);
  assert.equal(chat.turnStart([]), null);
  assert.equal(chat.elapsed(t0, t0 + 8_000), '8s');
  assert.equal(chat.elapsed(t0, t0 + 125_000), '2m 05s');
  assert.equal(chat.elapsed(t0, t0 + 3_780_000), '1h 03m');
});

test('a record that moved in the last 90 s and ends on the person or a tool is a turn still running', () => {
  const now = Date.parse(at);
  const rec = (role, ago) => ({ entries: [{ role: 'user', text: 'a' }, { role }], writtenAt: now - ago });
  assert.equal(chat.midTurn(rec('tool', 5_000), 0, now), true);
  assert.equal(chat.midTurn(rec('user', 5_000), 0, now), true);
  assert.equal(chat.midTurn(rec('assistant', 5_000), 0, now), false, 'it replied: the turn is over');
  assert.equal(chat.midTurn(rec('tool', 120_000), 0, now), false, 'stopped mid-turn: the console\'s state says so');
  assert.equal(chat.midTurn(rec('tool', 5_000), now - 2_000, now), false, 'the console said it settled after this was written: Esc stopped it');
  const interrupted = { entries: [{ role: 'tool' }, { role: 'user', text: '[Request interrupted by user]' }], writtenAt: now - 1000 };
  assert.equal(chat.midTurn(interrupted, 0, now), false, 'claude\'s note of an Esc ends the turn');
  assert.equal(chat.endedByStop(interrupted), true, 'the page stops saying Working before the console reads the state');
  assert.equal(chat.endedByStop(rec('tool', 5_000)), false);
  assert.equal(chat.endedByStop(null), false);
  assert.equal(chat.midTurn(null, 0, now), false);
  assert.equal(chat.midTurn({ entries: [], writtenAt: now }, 0, now), false);
});
