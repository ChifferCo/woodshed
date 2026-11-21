import { test } from 'node:test';
import assert from 'node:assert/strict';

import { editKey, frame, initialState, mergeHint, parseKeys } from './reviewTui.mjs';
import { clean, fileOrder, markdownLines, plainText, toAnsi, width, wrapSegments } from './reviewView.mjs';

test('raw stdin reads as keys: arrows, a paste with its newlines, and an escape sequence it does not know is skipped whole', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\x1bOC\x1b[5~\x1b[Z\t\r\x7f\x03q'), ['up', 'down', 'right', 'pageup', 'shift-tab', 'tab', 'enter', 'backspace', 'ctrl-c', 'q']);
  assert.deepEqual(parseKeys('\x1b[200~two\r\nlines\x1b[201~'), [{ paste: 'two\nlines' }]);
  assert.deepEqual(parseKeys('\x1b[1;5Pé'), ['é'], 'F1 with a modifier types nothing');
  assert.deepEqual(parseKeys('\x1b'), ['escape']);
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
  for (const tab of ['analysis', 'qa', 'discussion', 'files', 'chat']) {
    state.tab = tab;
    const lines = frame(state, { columns: 80, rows: 24, color: false });
    assert.equal(lines.length, 24, tab);
    for (const line of lines) assert.ok(width(line.replace(/\x1b\[[0-9;]*m/g, '')) <= 80, `${tab}: ${line}`);
  }
  state.tab = 'analysis';
  assert.match(frame(state, { columns: 80, rows: 24, color: false }).join('\n'), /reading the code · src\/x\.mjs · 3 files read · 4s/);
  assert.match(frame(state, { columns: 30, rows: 24 })[0], /^Make this window at least 40/);
});
