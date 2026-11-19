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
  // A file's path goes in the message itself (chat.js send), so the record holds the message as sent, its spaces aside.
  const pending = [{ text: 'Run the tests', sentAt: now - 2000 }, { text: 'Then  push\n/tmp/uploads/a.png', sentAt: now - 1000 }];
  assert.equal(chat.stillPending(pending, [], now).length, 2);
  const held = [{ role: 'user', text: 'Run the tests', at: new Date(now - 1500).toISOString() }];
  assert.deepEqual(chat.stillPending(pending, held, now).map((p) => p.text), ['Then  push\n/tmp/uploads/a.png']);
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

test('the page waits on a send longer than the console waits on statusd typing it', async () => {
  const { sendTimeoutMs } = await import('./fleet.mjs');
  for (const text of ['hi', 'x'.repeat(8000), Array.from({ length: 400 }, () => 'a').join('\n')]) {
    assert.ok(chat.sendTimeoutMs(text) > sendTimeoutMs(text), `${text.length} characters`);
  }
});


test('a queued message is not taken as arrived by an earlier prompt that starts the same', () => {
  // The review's case: "Run the tests" was sent a moment ago, and "Run the tests again" is queued behind a busy turn.
  const entries = [{ role: 'user', text: 'Run the tests', at: '2026-11-19T12:00:00.000Z' }, { role: 'assistant', text: 'ok', at: '2026-11-19T12:00:03.000Z' }];
  const sentAt = Date.parse('2026-11-19T12:00:05.000Z');
  const queued = { text: 'Run the tests', sentAt, state: 'held', after: chat.lastUserAt(entries) };
  assert.deepEqual(chat.stillPending([queued], entries, sentAt + 1000).length, 1, 'the earlier one is not it');
  const arrived = [...entries, { role: 'user', text: 'Run the tests', at: '2026-11-19T12:01:00.000Z' }];
  assert.equal(chat.stillPending([queued], arrived, sentAt + 60_000).length, 0, 'the one after it is');
  // A first message, with nothing of the person's in the record yet.
  const first = { text: 'hello', sentAt, state: 'sent', after: null };
  assert.equal(chat.stillPending([first], [{ role: 'user', text: 'hello', at: '2026-11-19T11:59:59.000Z' }], sentAt).length, 0, 'no earlier one: any is it, whatever the clocks say');
});

test('one entry in the record settles one of two identical messages, on this read and every one after', () => {
  // The review's case: "go on" sent twice, the second queued; the first arrives.
  const sentAt = Date.parse('2026-11-19T12:00:05.000Z');
  const pending = [
    { text: 'go on', sentAt, state: 'sent', after: null },
    { text: 'go on', sentAt: sentAt + 1000, state: 'held', after: null },
  ];
  const entries = [{ role: 'user', text: 'go on', at: '2026-11-19T12:00:06.000Z' }];
  const first = chat.stillPending(pending, entries, sentAt + 2000);
  assert.equal(first.length, 1, 'the first settled, the second still waiting');
  // The page keeps what it got and reads again with the same record: the same entry does not settle the second.
  const again = chat.stillPending(first, entries, sentAt + 4000);
  assert.equal(again.length, 1, 'still waiting on the next read');
  const arrived = [...entries, { role: 'user', text: 'go on', at: '2026-11-19T12:01:00.000Z' }];
  assert.equal(chat.stillPending(again, arrived, sentAt + 60_000).length, 0, 'its own entry settles it');
});

test('the page\'s pending messages are kept as the same objects, so its sends go on updating them', () => {
  const sentAt = Date.parse('2026-11-19T12:00:05.000Z');
  const first = { text: 'go on', sentAt, state: 'sent', after: null };
  const second = { text: 'go on', sentAt: sentAt + 1000, state: 'sending', after: null };
  const left = chat.stillPending([first, second], [{ role: 'user', text: 'go on', at: '2026-11-19T12:00:06.000Z' }], sentAt + 2000);
  assert.equal(left[0], second, 'the same bubble, not a copy');
  assert.equal(second.after, '2026-11-19T12:00:06.000Z');
});

test('a longer message that starts the same never settles a queued one, and stripped control characters do not hold one forever', () => {
  const sentAt = Date.parse('2026-11-19T12:00:05.000Z');
  // The review's case: "Run the tests" queued, and "Run the tests and lint" submitted in the TUI tab.
  const queued = { text: 'Run the tests', sentAt, state: 'held', after: null };
  assert.equal(chat.stillPending([queued], [{ role: 'user', text: 'Run the tests and lint', at: '2026-11-19T12:00:06.000Z' }], sentAt + 1000).length, 1);
  assert.equal(chat.stillPending([queued], [{ role: 'user', text: 'Run  the\ntests', at: '2026-11-19T12:00:06.000Z' }], sentAt + 1000).length, 0, 'whitespace aside');
  // A control character statusd leaves out: the record holds the message without it.
  const withNul = { text: 'fix it\u0000 now', sentAt, state: 'held', after: null };
  assert.equal(chat.stillPending([withNul], [{ role: 'user', text: 'fix it now', at: '2026-11-19T12:00:06.000Z' }], sentAt + 1000).length, 0);
  assert.equal(chat.typeable('a\r\nb\u001bc'), 'a\nbc');
});


test('a held bubble moves only on a word about its own id: sent once the console sent it, never on an older read', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: '/compact', sentAt: now - 60_000, state: 'held' };
  const b = { id: 'bbbbbbbb-2', text: 'then go on', sentAt: now - 30_000, state: 'held' };
  // An older read of the session, from before either was held: no word on them, so nothing moves (the review's stale count).
  assert.equal(chat.reconcile([a, b], { deliveredIds: [], leftInBox: null }, now).changed, false);
  assert.deepEqual([a.state, b.state], ['held', 'held']);
  const r = chat.reconcile([a, b], { deliveredIds: ['zzzz', 'aaaaaaaa-1'] }, now);
  assert.equal(r.changed, true);
  assert.deepEqual([a.state, b.state], ['sent', 'held']);
  assert.equal(a.sentAt, now - 60_000, 'its send time kept');
  assert.equal(r.pending[0], a, 'the bubble itself, not a copy');
  // Sent ten minutes ago from when it went in, not from when it was first sent: let go only then.
  assert.equal(chat.stillPending([a], [], now + 9 * 60_000).length, 1);
  assert.equal(chat.stillPending([a], [], now + 11 * 60_000).length, 0);
});

test('a held bubble the console left in the agent\'s box says so by its id, and goes once the box is empty again', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'same length', sentAt: now - 60_000, state: 'held' };
  const b = { id: 'bbbbbbbb-2', text: 'same length', sentAt: now - 30_000, state: 'held' };
  chat.reconcile([a, b], { leftInBox: { id: 'bbbbbbbb-2' } }, now);
  assert.deepEqual([a.state, b.state], ['held', 'in-box'], 'by its id, not its length');
  assert.equal(chat.pendingLabel('in-box', 'codex'), "In codex's box, not sent: send or clear it in the TUI tab");
  assert.deepEqual(chat.stillPending([a, b], [], now + 60 * 60_000).map((p) => p.id), ['aaaaaaaa-1', 'bbbbbbbb-2'], 'neither let go in an hour');
  const r = chat.reconcile([a, b], { leftInBox: null }, now);
  assert.deepEqual(r.pending.map((p) => p.id), ['aaaaaaaa-1'], 'the box empty again: let go');
});

test('a failed send is put back to send again only when the console refused it with its reason', () => {
  assert.equal(chat.consoleRefused({ status: 409, answered: true }), true);
  assert.equal(chat.consoleRefused({ status: 502, answered: false }), false, 'a proxy\'s page: the console may have sent it');
  assert.equal(chat.consoleRefused(new TypeError('Failed to fetch')), false, 'the connection lost');
  assert.equal(chat.consoleRefused(Object.assign(new Error('t'), { name: 'TimeoutError' })), false);
});

test('a send whose answer was lost waits as held once the console lists it held, else goes as a sent one does', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'go on', sentAt: now, state: 'unconfirmed' };
  assert.match(chat.pendingLabel('unconfirmed', 'claude'), /no word back/);
  assert.equal(chat.stillPending([a], [], now + 60 * 60_000).length, 1, 'not by the clock: the session list may be late');
  assert.equal(chat.reconcile([a], { heldIds: ['aaaaaaaa-1'] }, now + 60_000).changed, true);
  assert.equal(a.state, 'held');
  assert.equal(chat.stillPending([a], [], now + 60 * 60_000).length, 1, 'held: it waits for the turn, however long');
  assert.equal(chat.reconcile([a], { deliveredIds: ['aaaaaaaa-1'] }, now).changed, true);
  assert.equal(a.state, 'sent');
  const b = { id: 'bbbbbbbb-2', text: 'and then', sentAt: now, state: 'unconfirmed' };
  chat.reconcile([b], { refusedIds: ['bbbbbbbb-2'] }, now);
  assert.equal(b.state, 'refused');
});

test('the phone box keeps its draft only for a refusal that typed nothing, and says held, maybe and sent apart', () => {
  const o = (x) => chat.boxSendOutcome({ agent: 'codex', ...x });
  assert.deepEqual(o({ answer: { ok: true, held: false } }), { clear: true, toast: 'Sent' });
  assert.match(o({ answer: { ok: true, held: true } }).toast, /^Not sent yet: it goes in when codex is back at its prompt/);
  assert.match(o({ answer: { ok: true, unknown: true } }).toast, /may have gone in/);
  assert.match(o({ answer: {} }).toast, /no word back/, 'an answer that could not be read');
  assert.deepEqual(o({ err: Object.assign(new Error('too long'), { status: 400, answered: true }) }), { clear: false, toast: 'Not sent: too long' });
  assert.equal(o({ err: Object.assign(new Error('in the box'), { status: 409, answered: true, typed: true }) }).clear, true, 'in the box already');
  for (const err of [new TypeError('Failed to fetch'), Object.assign(new Error('t'), { name: 'TimeoutError' }), Object.assign(new Error('502'), { status: 502, answered: false })]) {
    assert.deepEqual(o({ err }), { clear: true, toast: 'No answer: it may have gone in. Check codex\'s screen before sending it again' });
  }
});

test('a lost answer not held on two reads of the session goes as sent; one read, or the same read again, is not enough', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'go on', sentAt: now, state: 'unconfirmed' };
  const read1 = { heldIds: [] };
  chat.reconcile([a], read1, now);
  chat.reconcile([a], read1, now + 1000);
  assert.equal(a.state, 'unconfirmed', 'one read, maybe asked for before the console took it');
  chat.reconcile([a], { heldIds: [] }, now + 5000);
  assert.equal(a.state, 'sent');
  assert.equal(chat.stillPending([a], [], now + 5000 + 11 * 60_000).length, 0);
});

test('a held message is never settled by the same words in the record: the console says when it went', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'run the tests', sentAt: now, state: 'held', after: null };
  const typedInTui = [{ role: 'user', text: 'run the tests', at: '2026-11-19T12:00:05.000Z' }];
  assert.equal(chat.stillPending([a], typedInTui, now + 6000).length, 1, 'the same words typed in the TUI tab');
  chat.reconcile([a], { deliveredIds: ['aaaaaaaa-1'] }, now + 60_000);
  const sentToo = [...typedInTui, { role: 'user', text: 'run the tests', at: '2026-11-19T12:01:00.000Z' }];
  assert.equal(chat.stillPending([a], sentToo, now + 61_000).length, 0, 'once sent, the record settles it');
});

test('a held message no longer listed on two reads went, though deliveredIds no longer names it; listed again, it is held', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'go on', sentAt: now, state: 'held' };
  chat.reconcile([a], { heldIds: ['aaaaaaaa-1'] }, now);
  const read = { heldIds: [], deliveredIds: [] };
  chat.reconcile([a], read, now + 1000);
  chat.reconcile([a], read, now + 2000);
  assert.equal(a.state, 'held', 'one read, seen twice');
  chat.reconcile([a], { heldIds: [], deliveredIds: [] }, now + 3000);
  assert.equal(a.state, 'sent', 'gone from the console\'s list on two reads: it went');
  chat.reconcile([a], { heldIds: ['aaaaaaaa-1'] }, now + 4000);
  assert.equal(a.state, 'held', 'a late read that lists it brings it back');
  const old = { id: 'bbbbbbbb-2', text: 'x', sentAt: now, state: 'held' };
  chat.reconcile([old], {}, now);
  chat.reconcile([old], {}, now + 1000);
  assert.equal(old.state, 'held', 'a console that sends no heldIds says nothing either way');
});

test('a held bubble the session could not take safely says it was not sent, and goes in time', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'yes do it', sentAt: now - 60_000, state: 'held' };
  assert.equal(chat.reconcile([a], { refusedIds: ['aaaaaaaa-1'] }, now).changed, true);
  assert.equal(a.state, 'refused');
  assert.match(chat.pendingLabel('refused', 'claude'), /^Not sent: .*TUI tab/);
  assert.equal(chat.stillPending([a], [], now + 9 * 60_000).length, 1);
  assert.equal(chat.stillPending([a], [], now + 11 * 60_000).length, 0);
});

test('a held bubble whose send got no answer in time stops promising delivery, says so, and goes in time', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  const a = { id: 'aaaaaaaa-1', text: 'go on', sentAt: now - 60 * 60_000, state: 'held' };
  assert.equal(chat.reconcile([a], { unknownIds: ['aaaaaaaa-1'] }, now).changed, true);
  assert.equal(a.state, 'unknown');
  assert.match(chat.pendingLabel('unknown', 'codex'), /it may have gone in/);
  assert.equal(chat.stillPending([a], [], now + 9 * 60_000).length, 1, 'shown a while, ten minutes from the word, though sent an hour ago');
  assert.equal(chat.stillPending([a], [], now + 11 * 60_000).length, 0);
});
