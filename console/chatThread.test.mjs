import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import chat from './public/chatThread.cjs';
import { parseCodexRollout } from '../session/sessionTranscript.mjs';

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

test("codex's turn cut short is a note, Denied with the command for a refused approval, and ends Working", () => {
  // statusd's reading of a real codex 0.167 rollout: No at an approval, then ■ Stop mid-reply.
  const entries = parseCodexRollout(fs.readFileSync(new URL('../shared/__fixtures__/rollout-codex-interrupted.jsonl', import.meta.url), 'utf8'));
  assert.deepEqual(chat.items(entries).filter((i) => i.kind === 'note').map((i) => i.text),
    ['Denied: echo hi > hello-codexfix.txt', 'Interrupted', 'Interrupted']);
  const now = Date.parse('2026-11-19T17:15:25.000Z');
  const denied = { entries: entries.slice(0, 4), writtenAt: now - 1000 };
  assert.equal(chat.endedByStop(denied), true, 'the page stops saying Working before the console reads the state');
  assert.equal(chat.midTurn(denied, 0, now), false);
  const before = { entries: entries.slice(0, 3), writtenAt: now - 1000 };
  assert.equal(chat.midTurn(before, 0, now), true, 'the record ends on the call that asks: still its turn, as the record says');
  assert.equal(chat.endedByStop({ entries: entries.slice(0, 5), writtenAt: now }), false, 'a new message starts a turn again');
});

test("a turn's changes are its files, each once, under its last work log that edited one, and no other turn's", () => {
  const diff = (path, op, add, del, lines) => ({ path, op, add, del, hunks: [{ head: '@@', lines }] });
  const list = chat.items([
    { role: 'user', text: 'Make two edits, then a new file', at },
    { role: 'tool', tool: 'Read', text: 'a.js', at },
    { role: 'tool', tool: 'Edit', text: 'a.js', at, diffs: [diff('a.js', 'edit', 1, 1, ['-one', '+two'])] },
    { role: 'assistant', text: 'One done.', at },
    { role: 'tool', tool: 'Edit', text: 'a.js', at, diffs: [diff('a.js', 'edit', 2, 0, ['+x', '+y'])] },
    { role: 'tool', tool: 'Write', text: 'b.js', at, diffs: [{ ...diff('b.js', 'add', 1, 0, ['+b']), cut: true }] },
    { role: 'tool', tool: 'Bash', text: 'npm test', at },
    { role: 'tool', tool: 'Edit', text: 'c.js', at, error: true },
    { role: 'assistant', text: 'Done.', at },
    { role: 'user', text: 'Now the docs', at },
    { role: 'tool', tool: 'apply_patch', text: 'README.md', at, diffs: [diff('README.md', 'edit', 1, 0, ['+docs']), diff('old.md', 'delete', 0, 0, [])] },
    { role: 'user', text: 'Just run the tests', at },
    { role: 'tool', tool: 'Bash', text: 'npm test', at },
  ]);
  const changes = chat.turnChanges(list);
  assert.deepEqual([...changes.keys()], [4, 10]);
  const first = changes.get(4);
  assert.equal(first.turn, 1, 'kept by its first work log, which stays put as the turn goes on');
  assert.deepEqual(first.files.map((f) => [f.path, f.op, f.add, f.del, f.edits.length, f.cut]), [['a.js', 'edit', 3, 1, 2, false], ['b.js', 'add', 1, 0, 1, true]]);
  assert.deepEqual(first.files[0].edits.map((e) => e.hunks[0].lines), [['-one', '+two'], ['+x', '+y']]);
  assert.deepEqual([first.add, first.del, first.commands, first.cut], [4, 1, true, true]);
  const second = changes.get(10);
  assert.deepEqual(second.files.map((f) => [f.path, f.op]), [['README.md', 'edit'], ['old.md', 'delete']]);
  assert.equal(second.commands, false, 'only its own commands count');
  // A file made and then edited stays new; one edited and then written whole was rewritten.
  const again = chat.turnChanges(chat.items([
    { role: 'tool', tool: 'Write', diffs: [diff('n.js', 'add', 1, 0, ['+a'])] },
    { role: 'tool', tool: 'Edit', diffs: [diff('n.js', 'edit', 1, 1, ['-a', '+b'])] },
    { role: 'tool', tool: 'Edit', diffs: [diff('m.js', 'edit', 1, 1, ['-a', '+b'])] },
    { role: 'tool', tool: 'Write', diffs: [diff('m.js', 'add', 1, 0, ['+c'])] },
  ]));
  assert.deepEqual(again.get(0).files.map((f) => [f.path, f.op]), [['n.js', 'add'], ['m.js', 'rewrite']]);
});

test('a question the agent asked is its own item, out of the work log around it', () => {
  const q = [{ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }];
  const list = chat.items([
    { role: 'tool', tool: 'Bash', text: 'ls' },
    { role: 'tool', tool: 'AskUserQuestion', text: 'Tabs or spaces?', questions: q, answered: true },
    { role: 'tool', tool: 'Read', text: 'a.js' },
  ]);
  assert.deepEqual(list.map((i) => i.kind), ['work', 'ask', 'work']);
  assert.deepEqual(list[1], { kind: 'ask', key: 1, questions: q, answered: true, declined: false, at: undefined });
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

test('a question is answered from the page while it is open and each takes one option, with a pick for every question', () => {
  const two = { kind: 'ask', answered: false, declined: false, questions: [
    { question: 'Which colour?', options: ['Red', 'Blue'] }, { question: 'Which size?', options: ['S', 'M', 'L'] },
  ] };
  assert.equal(chat.canAnswer(two), true);
  assert.equal(chat.canAnswer({ ...two, answered: true }), false);
  assert.equal(chat.canAnswer({ ...two, declined: true }), false);
  assert.equal(chat.canAnswer({ ...two, questions: [{ question: 'Toppings?', options: ['Cheese'], multiSelect: true }] }), false);
  assert.equal(chat.answerBody(two, [1]), null, 'the second has no pick yet');
  assert.equal(chat.answerBody(two, [1, 3]), null);
  assert.deepEqual(chat.answerBody(two, [1, 0]), { kind: 'question', questions: [
    { question: 'Which colour?', options: ['Red', 'Blue'], pick: 1 }, { question: 'Which size?', options: ['S', 'M', 'L'], pick: 0 },
  ] });
});

test('an approval reads as what is asked, then what would run, the reason last', () => {
  assert.deepEqual(chat.approvalText({ what: 'Bash command', title: 'Do you want to proceed?', detail: ['Write the date', 'date > now.txt'] }),
    { asks: 'Bash command: Do you want to proceed?', lines: ['Write the date', 'date > now.txt'] });
  assert.deepEqual(chat.approvalText({ what: null, title: 'Would you like to run the following command?', detail: ['Reason: migrate first', '$ npm run migrate'] }),
    { asks: 'Would you like to run the following command?', lines: ['$ npm run migrate', 'Reason: migrate first'] });
});

test('one read at a time: one asked for meanwhile runs when it ends, so a session opened mid-read is read', async () => {
  // As the Chat tab: A's read is on its way when B is shown; its answer is for A, dropped, and B's read must still run.
  let shown = 'A';
  const ran = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const read = chat.oneAtATime(async () => {
    const id = shown;
    ran.push(`start ${id}`);
    if (id === 'A') await held;
    ran.push(`end ${id}`);
  });
  const first = read();
  shown = 'B';
  await read();
  assert.deepEqual(ran, ['start A'], 'B waits for A, and is not run twice at once');
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ['start A', 'end A', 'start B', 'end B'], 'B is read once A answered');
  await read();
  await read();
  assert.equal(ran.filter((r) => r === 'start B').length, 3, 'calls with nothing on its way run at once');
});

test('a message waits for a file still uploading, which Enter would otherwise send without and drop', () => {
  const up = { name: 'shot.png', path: '/tmp/uploads/shot.png' };
  const busy = { name: 'log.txt', path: null, busy: true };
  assert.equal(chat.notReady({ text: 'look at this', files: [up], sending: false }), null);
  assert.match(chat.notReady({ text: 'look at this', files: [up, busy], sending: false }), /log.txt is still uploading/);
  assert.equal(chat.notReady({ text: '  ', files: [], sending: false }), 'nothing to send');
  assert.equal(chat.notReady({ text: '', files: [up], sending: false }), null, 'a file alone is a message');
  assert.equal(chat.notReady({ text: 'x', files: [], sending: true }), 'sending');
});

test('a message the console holds says it is not sent yet, and waits as long as the turn runs', () => {
  assert.equal(chat.pendingLabel('held', 'claude'), 'Not sent yet: it goes in when claude is back at its prompt');
  assert.equal(chat.pendingLabel('sent', 'codex'), 'Sent, waiting for codex');
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const hour = 60 * 60_000;
  const left = chat.stillPending([{ text: 'held one', sentAt: now - hour, state: 'held' }, { text: 'sent one', sentAt: now - hour, state: 'sent' }], [], now);
  assert.deepEqual(left.map((p) => p.text), ['held one'], 'a held one is not let go after ten minutes; a sent one is');
});
