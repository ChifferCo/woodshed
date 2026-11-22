import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createKeyReader, editKey, frame, initialState, mergeHint, parseKeys, screenText } from './reviewTui.mjs';
import { clean, diagramLines, headerLines, linkUrl, qaLines, qaVisible, fileOrder, markdownLines, plainText, pullRequestUrl, stripAnsi, tabBar, toAnsi, width, wrapSegments } from './reviewView.mjs';

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
async function tuiOver(t, routes, { columns = 80, rows = 24 } = {}) {
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
  const stdout = Object.assign(new EventEmitter(), { columns, rows, write: (s) => { screen += s; return true; } });
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

test('the tab bar numbers each tab by the key that opens it, on one line at 80 columns, and wraps only between tabs', () => {
  const bar = (state, columns) => tabBar(state, columns).map((l) => plainText(l).replace(/ /g, ' '));
  const withPr = { tab: 'analysis', status: { livePr: { number: 7 } }, draft: { comments: Array.from({ length: 12 }, () => ({})) } };
  assert.deepEqual(bar(withPr, 80), [' 1 Overview │ 2 Q&A │ 3 Discussion │ 4 Files changed │ 5 Chat   12 drafts']);
  // Without a pull request there is no Discussion, and every other tab keeps its number: 4 is always Files changed.
  assert.deepEqual(bar({ tab: 'files', status: {}, draft: { comments: [] } }, 80), [' 1 Overview │ 2 Q&A │ 4 Files changed │ 5 Chat ']);
  // The selected tab is one reversed block, its number in it; another tab's number is dim beside its name.
  const selected = toAnsi(tabBar({ ...withPr, tab: 'files' }, 80)[0], { columns: 80, color: true });
  assert.match(selected, /\x1b\[[0-9;]*7[0-9;]*m 4 Files changed \x1b\[0?m/);
  assert.match(selected, /\x1b\[2m1\x1b\[0?m Overview/);
  for (let columns = 40; columns <= 80; columns += 1) {
    const lines = bar(withPr, columns);
    for (const line of lines) {
      assert.ok(width(line) <= columns, `${columns}: ${line}`);
      assert.ok(!line.startsWith('│'), `${columns}: a line starts with a separator: ${line}`);
    }
    for (const name of ['1 Overview', '2 Q&A', '3 Discussion', '4 Files changed', '5 Chat', '12 drafts']) {
      assert.ok(lines.some((l) => l.includes(name)), `${columns}: ${name} whole on one line`);
    }
  }
  assert.equal(bar(withPr, 40).length, 2);
});

const QA_READY = { status: 'ready', forDiff: T, items: [{ id: 'q1', parent: null, question: 'What changes?', answer: 'Things.' }] };

test('1 to 5 open the tab with that number, and Tab still moves between them', async (t) => {
  const tui = await tuiOver(t, baseRoutes({ 'GET /qa': () => ({ ok: true, qa: QA_READY }) }));
  const on = {
    1: (f) => f.includes('It changes things.'),
    2: (f) => f.includes('▸ What changes?'),
    3: (f) => f.includes('Nobody has said anything about the change as a whole yet.'),
    4: (f) => f.includes('▸ one.mjs +1 −0'),
    5: (f) => f.some((l) => l.startsWith('A conversation about the change as a whole')),
  };
  await tui.until(() => on[1](tui.frame()), 'Overview first');
  assert.ok(tui.frame().some((l) => l.startsWith(' 1 Overview │ 2 Q&A │ 3 Discussion │ 4 Files changed │ 5 Chat')), 'the numbered tab bar');
  for (const n of ['4', '1', '5', '3', '2', '1']) {
    tui.type(n);
    await tui.until(() => on[n](tui.frame()), `${n} opens its tab`);
  }
  tui.type('\t');
  await tui.until(() => on[2](tui.frame()), 'Tab, the next tab');
  tui.type('\x1b[Z');
  await tui.until(() => on[1](tui.frame()), 'Shift-Tab, the one before');
  assert.equal(tui.said('POST /qa').length, 0, 'a Q&A already written for this diff is read, not asked again');
});

test('a number typed into a box is text, and switches no tab', async (t) => {
  const tui = await tuiOver(t, baseRoutes({ 'GET /qa': () => ({ ok: true, qa: QA_READY }) }));
  const has = (text) => tui.frame().some((l) => l.includes(text));
  await tui.until(() => has('It changes things.'), 'the first frame');
  // Chat's box.
  tui.type('5');
  tui.type('\r');
  await tui.until(() => has('Ask:'), 'the chat box');
  tui.type('3');
  await tui.until(() => has('Ask: 3'), 'the 3, typed');
  assert.ok(!has('Nobody has said anything'), 'not Discussion');
  tui.type('\x1b');
  // Q&A's box, on the row that asks a question of your own.
  tui.type('2');
  await tui.until(() => has('▸ What changes?'), 'Q&A');
  tui.type('G');
  tui.type('i');
  await tui.until(() => has('Your question:'), 'the Q&A box');
  tui.type('4');
  await tui.until(() => has('Your question: 4'), 'the 4, typed');
  assert.ok(!has('▸ one.mjs'), 'not Files changed');
  tui.type('\x1b');
  // The comment composer, on a line of an open diff.
  tui.type('4');
  await tui.until(() => has('▸ one.mjs +1 −0'), 'Files changed');
  tui.type('\r');
  tui.type('c');
  await tui.until(() => has('Comment on one.mjs:1:'), 'the comment box');
  tui.type('1');
  await tui.until(() => has('Comment on one.mjs:1: 1'), 'the 1, typed');
  assert.ok(!has('It changes things.'), 'not Overview');
  tui.type('\x1b');
  // The submit sheet's comment, and the rename sheet's title.
  tui.type('s');
  await tui.until(() => has('Comment:'), 'the submit sheet');
  tui.type('2');
  await tui.until(() => has('Comment: 2'), 'the 2, typed');
  assert.ok(has('Submit review on #7'), 'the sheet stays');
  tui.type('\x1b');
  tui.type('t');
  await tui.until(() => has('Title: T'), 'the rename sheet');
  tui.type('5');
  await tui.until(() => has('Title: T5'), 'the 5, typed');
  tui.type('\x1b');
  await tui.until(() => !has('Title:'), 'the sheet closed');
  const sent = ['POST /chat', 'POST /qa/ask', 'POST /comments', 'POST /submit', 'PATCH /title'].flatMap((k) => tui.said(k));
  assert.deepEqual(sent, [], 'nothing sent');
});

test('the help, on a terminal of 40 by 14, shows whole what the number keys do', async (t) => {
  const tui = await tuiOver(t, baseRoutes(), { columns: 40, rows: 14 });
  await tui.until(() => tui.frame().some((l) => l.includes('1 Overview')), 'the first frame');
  tui.type('?');
  await tui.until(() => tui.frame().includes('Keys'), 'the help');
  const text = tui.frame().join(' ').replace(/ +/g, ' ');
  assert.match(text, /1-5 open the numbered tabs\. In a text box, a number is text\. Tab and Shift-Tab cycle\./);
});

// The header's pull request number as a terminal hyperlink (OSC 8), as the page's #311 is a link.
const PR_URL = 'https://github.com/acme/app/pull/311';
const link = (url, text) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
const linkedStatus = (livePr = {}, meta = {}) => ({
  kind: 'worktree', headSha: 'cc8e8860aaaa', status: 'ready', session: 'claude-e58a87e8',
  meta: { title: 'T', headRefName: 'feat/review-tui-tab-numbers', baseRefName: 'main', headRefOid: 'cc8e8860aaaa', additions: 142, deletions: 14, ...meta },
  livePr: { number: 311, url: PR_URL, title: 'Number the tabs', state: 'open', review: 'approved', checks: { pass: 7, fail: 0, pending: 0, total: 7 }, ...livePr },
});

test('the header\'s pull request number links to the pull request, on the fact line or in the title', () => {
  const facts = frame(initialState({ status: linkedStatus(), diff: { files: [] }, session: 'e58a87e8' }), { columns: 120, rows: 24 });
  assert.ok(facts.some((l) => l.includes(link(PR_URL, '#311'))), facts.join('\n'));
  assert.match(stripAnsi(facts[1]), /feat\/review-tui-tab-numbers → main #311 Open ✓ approved ✓ 7 checks passing cc8e8860/);
  // A pull request review carries the number in its title, linked to the address read at launch.
  const titled = frame(initialState({ status: { ...linkedStatus({ url: null }, { number: 311, url: PR_URL }), kind: 'pr' }, diff: { files: [] }, session: 'e58a87e8' }), { columns: 80, rows: 24 });
  assert.ok(titled[0].includes(link(PR_URL, '#311')), titled[0]);
  assert.equal(stripAnsi(titled[0]), 'Review: Number the tabs #311');
  // With no address in the review, the session's own pull request with that number, as the console lists it.
  const listed = initialState({ status: linkedStatus({ url: null }), diff: { files: [] }, session: 'e58a87e8', pulls: [{ number: 311, url: PR_URL }, { number: 12, url: 'https://github.com/acme/app/pull/12' }] });
  assert.equal(pullRequestUrl(listed, 311), PR_URL);
  assert.ok(frame(listed, { columns: 80, rows: 24 }).some((l) => l.includes(link(PR_URL, '#311'))));
  assert.equal(pullRequestUrl({ status: linkedStatus({ url: null }), pulls: [{ number: 311, url: PR_URL }, { number: 311, url: 'https://github.com/acme/web/pull/311' }] }, 311), null, 'two repos\' #311: neither');
});

test('the link takes no columns: the header is as wide with it as without, at 40 and 80 columns', () => {
  for (const columns of [40, 80]) {
    const withLink = headerLines(initialState({ status: linkedStatus(), diff: { files: [] }, session: 'e58a87e8' }), columns);
    const without = headerLines(initialState({ status: linkedStatus({ url: null }), diff: { files: [] }, session: 'e58a87e8' }), columns);
    assert.deepEqual(withLink.map(plainText), without.map(plainText), `${columns}: the same words on the same lines`);
    const drawn = withLink.map((l) => toAnsi(l, { columns }));
    assert.ok(drawn.some((l) => l.includes(link(PR_URL, '#311'))), `${columns}: linked`);
    assert.deepEqual(drawn.map((l) => width(stripAnsi(l))), without.map((l) => width(stripAnsi(toAnsi(l, { columns })))), `${columns}: the same widths`);
    for (const l of drawn) assert.ok(width(stripAnsi(l)) <= columns, l);
    const lines = frame(initialState({ status: linkedStatus(), diff: { files: [] }, session: 'e58a87e8' }), { columns, rows: 24 });
    for (const l of lines) assert.ok(width(stripAnsi(l)) <= columns, `${columns}: ${l}`);
  }
});

test('a link cut by the line\'s end is cut whole: the sequence is never split, and always closed', () => {
  const opens = (s) => s.split('\x1b]8;;https').length - 1;
  const closes = (s) => s.split('\x1b]8;;\x1b\\').length - 1;
  for (let columns = 1; columns <= 12; columns += 1) {
    const out = toAnsi([['dim', 'main  '], ['bold', '#311', PR_URL], [null, '  Open']], { columns });
    assert.ok(width(stripAnsi(out)) <= columns, `${columns}: ${out}`);
    assert.equal(opens(out), closes(out), `${columns}: every link closed: ${JSON.stringify(out)}`);
    if (columns <= 6) assert.equal(opens(out), 0, `${columns}: no room, no link`);
    else assert.ok(out.includes(`\x1b]8;;${PR_URL}\x1b\\`), `${columns}: the whole address, or none`);
  }
  assert.equal(toAnsi([['bold', '#311', PR_URL]], { columns: 3 }), `\x1b[1m${link(PR_URL, '#3…')}\x1b[0m`);
  // A word longer than the line, cut by the wrapping: each piece its own closed link.
  const wrapped = wrapSegments([['bold', '#3110000000000', PR_URL]], 6).map((l) => toAnsi(l, { columns: 6 }));
  assert.ok(wrapped.length > 1 && wrapped.every((l) => opens(l) === 1 && closes(l) === 1), wrapped.join('|'));
});

test('only an https address with nothing but printable characters in it is linked, and plain text has no link', () => {
  for (const bad of ['http://github.com/acme/app/pull/311', 'javascript:alert(1)', 'https://github.com/acme/app/pull/311\x1b\\x', 'https://github.com/acme/app/pull/311\x07',
    'https://github.com/acme/app/pull/311\u009c', 'https://github.com/a b/pull/311', 'https://me:pw@github.com/acme/app/pull/311', 'file:///etc/passwd', '', null, 42]) {
    assert.equal(linkUrl(bad), null, JSON.stringify(bad));
    const lines = frame(initialState({ status: linkedStatus({ url: bad }), diff: { files: [] }, session: 'e58a87e8' }), { columns: 80, rows: 24 });
    assert.ok(lines.every((l) => !l.includes('\x1b]8')), `${JSON.stringify(bad)} is not linked`);
    assert.ok(lines.some((l) => stripAnsi(l).includes('#311')), 'the number is still drawn');
  }
  assert.equal(linkUrl(PR_URL), PR_URL);
  assert.equal(pullRequestUrl({ status: linkedStatus({ url: 'https://github.com/acme/app/pull/312' }) }, 311), null, 'an address for another pull request is not this one\'s link');
  assert.equal(pullRequestUrl({ status: linkedStatus({ url: 'https://evil.example/' }) }, 311), null);
  // The screen as text, as a pipe or a test reads it, has no link in it.
  assert.ok(screenText(initialState({ status: linkedStatus(), diff: { files: [] }, session: 'e58a87e8' }), { columns: 80, rows: 24 }).every((l) => !/\x1b/.test(l)));
});
