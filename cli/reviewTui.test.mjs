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

// The TUI on a made-up terminal over a scripted shed: `routes` answers each call by `METHOD path`, and every call is kept.
// Its timers run at once, so polls that wait seconds in a terminal take milliseconds here.
async function tuiOver(t, routes) {
  const { EventEmitter } = await import('node:events');
  const { runReviewTui } = await import('./reviewTui.mjs');
  const calls = [];
  const api = async (method, path, body) => {
    const key = `${method} ${path.split('?')[0]}`;
    calls.push({ method, path, body });
    const answer = routes.get(key);
    if (typeof answer !== 'function') throw Object.assign(new Error(`not scripted: ${key}`), { status: 404 });
    return answer(body, path);
  };
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
  let screen = '';
  const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, write: (s) => { screen += s; return true; } });
  const status = routes.get('GET ')();
  const diff = routes.get('GET /diff')();
  const done = runReviewTui({ api, initial: { status, diff, session: 'aaaa0001' }, stdin, stdout, color: false,
    timers: { set: (fn) => setTimeout(fn, 2), clear: clearTimeout } });
  t.after(() => stdin.emit('data', 'q'));
  const frame = () => screen.split('\x1b[H').at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/ /g, ' ').split('\r\n').map((l) => l.trimEnd());
  const until = async (test, what) => {
    for (let i = 0; i < 500; i += 1) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`never: ${what}\n${frame().join('\n')}`);
  };
  return { calls, done, frame, until, type: (s) => stdin.emit('data', Buffer.from(s)), said: (key) => calls.filter((c) => `${c.method} ${c.path.split('?')[0]}` === key) };
}

const T = '2026-11-20T10:00:00.000Z';
const baseRoutes = (over = {}) => new Map(Object.entries({
  'GET ': () => ({ ok: true, kind: 'worktree', status: 'ready', createdAt: T, headSha: 'aaaa', meta: { title: 'T', headRefName: 'b', baseRefName: 'main', dirtyFiles: 0 },
    livePr: { number: 7, title: 'T', state: 'open', review: 'pending', checks: null }, review: { overview: 'It changes things.' } }),
  'GET /diff': () => ({ ok: true, createdAt: T, files: [{ path: 'one.mjs', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', oldNo: null, newNo: 1, text: 'x' }] }] }] }),
  'GET /comments': () => ({ ok: true, prId: 'P', headSha: 'aaaa', reviewId: null, comments: [], threads: [], said: [] }),
  'GET /chat': () => ({ ok: true, messages: [] }),
  'GET /qa': () => ({ ok: true, qa: null }),
  ...over,
}));

test('the submit sheet keeps the verdict Enter posts on screen, however many draft comments go with it', async (t) => {
  const comments = Array.from({ length: 18 }, (_, i) => ({ path: 'one.mjs', line: 1, body: `note ${i + 1}` }));
  const tui = await tuiOver(t, baseRoutes({
    'GET /comments': () => ({ ok: true, prId: 'P', headSha: 'aaaa', reviewId: 'R', comments, threads: [], said: [] }),
    'POST /submit': () => ({ ok: true, pr: 7 }),
  }));
  await tui.until(() => tui.frame().some((l) => l.includes('18 drafts')), 'the drafts read');
  tui.type('s');
  tui.type('\t');
  await tui.until(() => tui.frame().some((l) => /^Verdict: +Comment +Approve +Request changes/.test(l)), 'the verdict, first');
  assert.ok(tui.frame().some((l) => l.includes('Enter post: Approve')), 'the footer says what Enter posts');
  tui.type('\x1b[6~');
  await tui.until(() => tui.frame().some((l) => l.includes('and 13 more, which go out with it too')), 'the rest, a page down');
  assert.ok(tui.frame().some((l) => l.includes('Enter post: Approve')), 'still said after a page down');
  tui.type('\r');
  await tui.until(() => tui.said('POST /submit').length === 1, 'the post');
  assert.deepEqual(tui.said('POST /submit')[0].body, { event: 'approve', body: '' });
});

test('opening Q&A starts it on the diff on screen, as the page does, and shows its answers as they come', async (t) => {
  let qa = null;
  const tui = await tuiOver(t, baseRoutes({
    'GET /qa': () => ({ ok: true, qa }),
    'POST /qa': () => {
      qa = { status: 'ready', forDiff: T, items: [{ id: 'q1', parent: null, question: 'What changes?', answer: 'Things.' }] };
      return { ok: true };
    },
  }));
  tui.type('2');
  await tui.until(() => tui.said('POST /qa').length === 1, 'the start');
  assert.equal(tui.said('POST /qa')[0].path, `/qa?forDiff=${encodeURIComponent(T)}&first=1`, 'about the diff on screen, kept if another made one');
  await tui.until(() => tui.frame().includes('▸ What changes?'), 'the question, read again');
  tui.type('\r');
  await tui.until(() => tui.frame().includes('  Things.'), 'its answer, open');
});

test('a Q&A the shed started when the review opened is shown as it goes, and the tab never asks for another', async (t) => {
  let reads = 0;
  const tui = await tuiOver(t, baseRoutes({
    'GET /qa': () => {
      reads += 1;
      const items = [{ id: 'q1', parent: null, question: 'What changes?', ...(reads > 2 ? { answer: 'Things.' } : {}) }];
      return { ok: true, qa: reads > 2 ? { status: 'ready', forDiff: T, items } : { status: 'running', phase: 'answering', depth: 1, forDiff: T, items } };
    },
    'POST /qa': () => ({ ok: true, status: 'running' }),
  }));
  // Read at launch, off the tab: the run is already going.
  await tui.until(() => reads >= 1, 'the first read');
  tui.type('2');
  await tui.until(() => tui.frame().includes('▸ What changes?'), 'the question, once it is answered');
  assert.equal(tui.said('POST /qa').length, 0, 'opening the tab joins the run the review started');
});

test('after a Re-review the new diff\'s Q&A, which the shed started with its analysis, is read without being asked for', async (t) => {
  const T2 = '2026-11-20T11:00:00.000Z';
  let at = T;
  const tui = await tuiOver(t, baseRoutes({
    'GET ': () => ({ ok: true, kind: 'worktree', status: 'running', createdAt: at, headSha: 'aaaa', meta: { title: 'T', headRefName: 'b', baseRefName: 'main', dirtyFiles: 0 }, livePr: null, review: null }),
    'GET /diff': () => ({ ok: true, createdAt: at, files: [{ path: 'one.mjs', additions: 1, deletions: 0, hunks: [] }] }),
    // Finished before the Re-review, so nothing is polling it: only a read after the Re-review finds the new one.
    'GET /qa': () => ({ ok: true, qa: { status: 'ready', phase: null, forDiff: at, items: [{ id: 'q1', parent: null, question: at === T2 ? 'What is new?' : 'What was there?', answer: 'This.' }] } }),
    'POST /qa': () => ({ ok: true, status: 'running' }),
    'POST ': () => { at = T2; return { ok: true }; },
  }));
  tui.type('2');
  await tui.until(() => tui.frame().includes('▸ What was there?'), 'the first diff\'s Q&A');
  tui.type('r');
  await tui.until(() => tui.frame().includes('▸ What is new?'), 'the new diff\'s Q&A');
  assert.equal(tui.said('POST /qa').length, 0, 'nothing asked for: the shed started it');
});

test('Re-review takes the diff again and draws the new one, and says so when nothing moved', async (t) => {
  let files = [{ path: 'one.mjs', additions: 1, deletions: 0, hunks: [] }];
  let unchanged = false;
  const tui = await tuiOver(t, baseRoutes({
    'GET /diff': () => ({ ok: true, createdAt: T, files }),
    'POST ': () => {
      if (unchanged) return { ok: true, unchanged: true };
      files = [...files, { path: 'two.mjs', additions: 3, deletions: 0, hunks: [] }];
      return { ok: true };
    },
  }));
  tui.type('4');
  await tui.until(() => tui.frame().includes('▸ one.mjs +1 −0'), 'the files');
  tui.type('r');
  await tui.until(() => tui.frame().some((l) => l.includes('Re-reviewed: the diff is as the branch is now.')), 'the re-review');
  assert.ok(tui.frame().includes('▸ two.mjs +3 −0'), 'the new diff drawn');
  assert.equal(tui.said('POST ').length, 1, 'a worktree review re-reviews with the bare POST');
  unchanged = true;
  tui.type('r');
  await tui.until(() => tui.frame().some((l) => l.includes('No new commits. a reads the same commit again anyway.')), 'nothing moved');
});

test('Discard asks first, and only y throws the analysis and the conversation away', async (t) => {
  const tui = await tuiOver(t, baseRoutes({ 'POST /discard': () => ({ ok: true }) }));
  tui.type('d');
  await tui.until(() => tui.frame().includes('Discard the analysis and the conversation?'), 'the question');
  tui.type('n');
  await tui.until(() => !tui.frame().includes('Discard the analysis and the conversation?'), 'kept');
  tui.type('d');
  tui.type('\r');
  await tui.until(() => !tui.frame().includes('Discard the analysis and the conversation?'), 'kept, with Enter too');
  assert.equal(tui.said('POST /discard').length, 0, 'nothing discarded but by y');
  tui.type('d');
  tui.type('y');
  await tui.until(() => tui.said('POST /discard').length === 1, 'the discard');
  await tui.until(() => tui.frame().some((l) => l.includes('Discarded. a reads it again.')), 'said');
});
