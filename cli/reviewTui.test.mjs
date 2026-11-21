import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createKeyReader, editKey, frame, initialState, mergeHint, parseKeys } from './reviewTui.mjs';
import { clean, diagramLines, qaLines, qaVisible, fileOrder, markdownLines, plainText, toAnsi, width, wrapSegments } from './reviewView.mjs';

test('raw stdin reads as keys: arrows, a paste with its newlines, and an escape sequence it does not know is skipped whole', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[5~\x1b[Z\t\r\x7f\x03q'), ['up', 'down', 'right', 'pageup', 'shift-tab', 'tab', 'enter', 'backspace', 'ctrl-c', 'q']);
  assert.deepEqual(parseKeys('\x1b[200~two\r\nlines\x1b[201~'), [{ paste: 'two\nlines' }]);
  assert.deepEqual(parseKeys('\x1b[1;5Pé'), ['é'], 'F1 with a modifier types nothing');
  assert.deepEqual(parseKeys('\x1b'), ['escape']);
});

test('a paste or an escape sequence cut between chunks of stdin is read whole, and a newline in a paste is never Enter', () => {
  const read = createKeyReader();
  assert.deepEqual(read('\x1b[200~one\r'), []);
  assert.deepEqual(read('two\r\n'), []);
  assert.deepEqual(read('three\x1b[2'), []);
  assert.deepEqual(read('01~x\x1b['), [{ paste: 'one\ntwo\nthree' }, 'x']);
  assert.deepEqual(read('A\r'), ['up', 'enter']);
});

test('a diagram\'s ids reach the terminal clean, named or not', () => {
  const lines = diagramLines({ nodes: [{ id: 'a', label: 'A\x1b[2J', change: 'added' }], edges: [{ from: 'a', to: 'b\x1b]0;x\x07', change: 'added' }] }, 80).map(plainText);
  assert.ok(lines.every((l) => !/[\x1b\x07]/.test(l)), lines.join('|'));
});

test('the line being typed edits as a terminal\'s does', () => {
  const ed = { text: '', pos: 0 };
  for (const k of [...'hello world']) editKey(ed, k);
  editKey(ed, 'ctrl-w');
  assert.deepEqual(ed, { text: 'hello ', pos: 6 });
  editKey(ed, 'home');
  editKey(ed, '>');
  editKey(ed, { paste: 'x\x1b[2Jy' });
  assert.equal(ed.text, '>x [2Jyhello ', 'a pasted escape code is not kept');
});

test('text from the session never carries a control character, and every line fits its width', () => {
  assert.equal(clean('a\x1b]0;pwned\x07b\tc'), 'a ]0;pwned b    c');
  const lines = wrapSegments([[null, 'a sentence that wraps, with averyveryverylongwordthatdoesnotfitatall in it']], 20, { first: '- ', rest: '  ' });
  assert.ok(lines.every((l) => width(plainText(l)) <= 20));
  assert.equal(plainText(lines[0]), '- a sentence that');
  assert.equal(width('日本'), 4);
  // No colour, as NO_COLOR asks: bold and reverse stay.
  assert.equal(toAnsi([['red bold', 'x']], { columns: 10, color: false }), '\x1b[1mx\x1b[0m');
  assert.equal(toAnsi([[null, 'abcdef']], { columns: 4 }), 'abc…');
});

test('markdown reads as the page draws it: headings, lists, code and tables', () => {
  const text = markdownLines('## Head\n\nSome `code` and **bold**.\n\n- one\n- two\n\n```\nx = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |', 40).map(plainText);
  assert.deepEqual(text, ['Head', '', 'Some code and bold.', '', '• one', '• two', '', '  x = 1', '', 'A │ B', '1 │ 2']);
});

test('every file of the diff is in Files changed once, in the analysis\'s order, whatever the analysis says', () => {
  const state = {
    status: { review: { groups: [{ title: 'G', files: [{ path: 'b' }, { path: 'nope' }, { path: 'b' }] }] } },
    diff: { files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] },
  };
  assert.deepEqual(fileOrder(state).map((x) => x.file.path), ['b', 'a', 'c']);
});

test('merge is offered as the page offers it, and every view fits 80 columns', () => {
  const status = {
    kind: 'worktree', headSha: 'aaaa', status: 'running', progress: { toolCalls: 3, currentFile: 'src/x.mjs', elapsedMs: 4000 },
    meta: { title: 'T', headRefName: 'b', baseRefName: 'main', dirtyFiles: 0, additions: 1, deletions: 0 },
    livePr: { number: 7, title: 'T', state: 'open', review: 'pending', checks: { pass: 1, fail: 0, pending: 1, total: 2 } },
    review: { overview: 'x '.repeat(200), decisions: [{ title: 'd', why: 'w', files: ['f'] }], architecture: 'a', diagram: { nodes: [{ id: 'a', label: 'A', change: 'added' }], edges: [] } },
  };
  const diff = { files: [{ path: 'f', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', oldNo: null, newNo: 1, text: 'y'.repeat(300) }] }] }] };
  const state = initialState({ status, diff, session: 'aaaa0001' });
  assert.equal(mergeHint(state), 'Merge is offered once the pull request is approved.');
  status.livePr.review = 'approved';
  assert.equal(mergeHint(state), 'Merge when checks pass: 1 running.');
  status.livePr.checks = { pass: 2, fail: 0, pending: 0, total: 2 };
  status.meta.dirtyFiles = 2;
  assert.match(mergeHint(state), /uncommitted changes/);
  status.meta.dirtyFiles = 0;
  assert.equal(mergeHint(state), null);
  for (const [tab, open] of [['analysis'], ['qa'], ['discussion'], ['files', false], ['files', true], ['chat']]) {
    state.tab = tab;
    state.fileOpen = Boolean(open);
    const lines = frame(state, { columns: 80, rows: 24, color: false });
    assert.equal(lines.length, 24, tab);
    for (const line of lines) assert.ok(width(line.replace(/\x1b\[[0-9;]*m/g, '')) <= 80, `${tab}: ${line}`);
  }
  state.tab = 'analysis';
  assert.match(frame(state, { columns: 80, rows: 24, color: false }).join('\n'), /reading the code · src\/x\.mjs · 3 files read · 4s/);
  assert.match(frame(state, { columns: 30, rows: 24 })[0], /^Make this window at least 40/);
});

test('the Q&A is folded: only the open question shows its answer and its follow-ups, and the cursor is on a question', () => {
  const items = [
    { id: 'a', parent: null, question: 'A?', answer: 'Because.' },
    { id: 'b', parent: null, question: 'B?', answer: 'So.' },
    { id: 'c', parent: 'b', question: 'C?', answer: 'Then.' },
    { id: 'd', parent: null, question: 'D?', asking: true },
  ];
  const state = { qa: { data: { status: 'ready', items }, open: [], cursor: 1 } };
  assert.deepEqual(qaVisible(state).map((i) => i.id), ['a', 'b', 'd']);
  const shut = qaLines(state, 80);
  assert.deepEqual(shut.lines.map(plainText).filter(Boolean).slice(0, 3), ['▸ A?', '▸ B? 1 follow-up', '▸ D? ⋯ being answered']);
  assert.equal(shut.items[shut.lines.map(plainText).indexOf('▸ B? 1 follow-up')], shut.cursor);
  state.qa.open = ['b'];
  assert.deepEqual(qaVisible(state).map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(qaLines(state, 80).lines.map(plainText).filter(Boolean).slice(0, 4), ['▸ A?', '▾ B?', '  So.', '  ▸ C?']);
  const last = qaLines(state, 80);
  assert.equal(last.lines.map(plainText).at(-1), '＋ Ask a question of your own', 'the last row asks one of your own');
  assert.equal(last.items.at(-1), qaVisible(state).length);
});
