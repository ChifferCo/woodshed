// `woodshed review <id>`'s full-screen terminal UI over the shed's review of a session (shared/review), through the
// console (console/reviewProxy.mjs forCli). It does what the Review tab's page does, with the same calls and in the same
// order, and decides nothing the page does not: whether a write may go to GitHub is the session's rule (statusd answers
// 403), whether a merge may go is GitHub's read on the shed (GET /merge), and the controls that need a pull request are
// offered only when the shed names one (`livePr`), as the page draws them.
//
// Plain Node: raw-mode stdin read as keys and mouse reports, an alternate screen drawn whole on each change
// (reviewView.mjs makes the lines), the size followed on resize, the keys for what is on screen in the footer. A click
// on a link the frame drew (the header's pull request number) opens it, as o does, through browser.mjs.

import {
  analysisLines, chatLines, chatStarters, clean, cut, diffRows, discussionLines, fileLines, fileListLines, fileOrder, headerLines,
  githubPullUrl, plainText, pullRequestUrl, qaLines, qaVisible, reviewTitle, stripAnsi, tabBar, tabsOf, toAnsi, width,
  wrapSegments, wrapText,
} from './reviewView.mjs';
import { canOpenBrowser, openBrowser } from './browser.mjs';

const STATUS_POLL_MS = 2000;
const ANSWER_POLL_MS = 1500;
const QA_POLL_MS = 3000;
const TICK_MS = 1000;
const SUBMIT_WORDS = { comment: 'Comment', approve: 'Approve', 'request-changes': 'Request changes' };
const SUBMIT_DONE = { comment: 'Comment posted', approve: 'Approved', 'request-changes': 'Changes requested' };
const EVENTS = ['comment', 'approve', 'request-changes'];
// Draft comments listed on the submit sheet; the rest are counted.
const SHOWN_PENDING = 5;

// --- keys ---------------------------------------------------------------------------

const SEQUENCES = {
  '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down', '\x1b[C': 'right', '\x1bOC': 'right',
  '\x1b[D': 'left', '\x1bOD': 'left', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[H': 'home', '\x1bOH': 'home',
  '\x1b[1~': 'home', '\x1b[F': 'end', '\x1bOF': 'end', '\x1b[4~': 'end', '\x1b[Z': 'shift-tab', '\x1b[3~': 'delete',
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// The longest tail of `text` that could be the start of `marker`, kept for the next chunk.
function partialTail(text, marker) {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n -= 1) if (marker.startsWith(text.slice(-n))) return n;
  return 0;
}

/**
 * A reader of raw stdin as keys: a name for a special key, the character for a printable one, and `{paste}` for a
 * bracketed paste, its newlines kept. It holds what one chunk leaves open for the next: a paste whose end marker has
 * not come yet is never read as typing, so a newline in it is never Enter (which would send what is in the box), and
 * an escape sequence cut between chunks is read whole.
 * @returns {(chunk: Buffer|string) => Array<string|{paste: string}>}
 */
export function createKeyReader() {
  let pasting = null;
  let held = '';
  return function read(chunk) {
    let text = held + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    held = '';
    const keys = [];
    let i = 0;
    while (i < text.length) {
      if (pasting !== null) {
        const end = text.indexOf(PASTE_END, i);
        if (end < 0) {
          const rest = text.slice(i);
          const keep = partialTail(rest, PASTE_END);
          pasting += rest.slice(0, rest.length - keep);
          held = rest.slice(rest.length - keep);
          return keys;
        }
        pasting += text.slice(i, end);
        keys.push({ paste: pasting.replace(/\r\n?/g, '\n') });
        pasting = null;
        i = end + PASTE_END.length;
        continue;
      }
      if (text.startsWith(PASTE_START, i)) {
        pasting = '';
        i += PASTE_START.length;
        continue;
      }
      if (text[i] === '\x1b') {
        // A mouse report: SGR's (ESC [ < button ; column ; row, M pressed, m released), or the older X10 form's three
        // bytes after ESC [ M from a terminal that does not know SGR's, whose bytes are never typed as keys.
        const sgr = /^\x1b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/.exec(text.slice(i, i + 24));
        if (sgr) {
          keys.push({ mouse: mouseEvent(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === 'M') });
          i += sgr[0].length;
          continue;
        }
        if (text.startsWith('\x1b[M', i)) {
          const bytes = [...text.slice(i + 3, i + 9)].slice(0, 3);
          if (bytes.length < 3) {
            held = text.slice(i);
            return keys;
          }
          const [b, x, y] = bytes.map((c) => c.codePointAt(0) - 32);
          keys.push({ mouse: mouseEvent(b, x, y, (b & 3) !== 3) });
          i += 3 + bytes.join('').length;
          continue;
        }
        const seq = Object.keys(SEQUENCES).find((q) => text.startsWith(q, i));
        if (seq) {
          keys.push(SEQUENCES[seq]);
          i += seq.length;
          continue;
        }
        // Another sequence this does not read: skipped whole, so its letters are not typed.
        const other = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(text.slice(i, i + 32));
        if (other) {
          i += other[0].length;
          continue;
        }
        // A sequence the chunk cut short (ESC [ and digits, or ESC O): finished by the next chunk.
        if (/^\x1b(\[<?[0-9;?]*[ -/]*|O)$/.test(text.slice(i)) && text.length - i > 1) {
          held = text.slice(i);
          return keys;
        }
        keys.push('escape');
        i += 1;
        continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i));
      i += ch.length;
      if (ch === '\r' || ch === '\n') keys.push('enter');
      else if (ch === '\t') keys.push('tab');
      else if (ch === '\x7f' || ch === '\b') keys.push('backspace');
      else if (ch === '\x03') keys.push('ctrl-c');
      else if (ch === '\x15') keys.push('ctrl-u');
      else if (ch === '\x17') keys.push('ctrl-w');
      else if (ch === '\x01') keys.push('home');
      else if (ch === '\x05') keys.push('end');
      else if (ch === '\x04') keys.push('ctrl-d');
      else if (ch === '\x0c') keys.push('ctrl-l');
      else if (ch === '\x1a') keys.push('ctrl-z');
      else if (ch.codePointAt(0) >= 0x20) keys.push(ch);
    }
    text = '';
    return keys;
  };
}

/**
 * A mouse report as {kind, column, row}, both from 1 as the terminal counts: `click` (the left button pressed, with or
 * without Shift, Alt or Ctrl), `wheel-up`, `wheel-down`, or `other` (another button, a release, a drag).
 */
function mouseEvent(button, column, row, pressed) {
  const base = button & ~(4 | 8 | 16);
  let kind = 'other';
  if (base === 64) kind = 'wheel-up';
  else if (base === 65) kind = 'wheel-down';
  else if (base === 0 && pressed) kind = 'click';
  return { kind, column, row };
}

/** One chunk's keys, with nothing held over: for a test. */
export function parseKeys(chunk) {
  return createKeyReader()(chunk);
}

// --- a line being typed ---------------------------------------------------------------

function editor(text = '') {
  return { text, pos: [...text].length };
}

/** @returns {boolean}  whether the key was the editor's */
export function editKey(ed, key) {
  const chars = [...ed.text];
  if (typeof key === 'object' && key.paste !== undefined) {
    const add = [...clean(key.paste)];
    chars.splice(ed.pos, 0, ...add);
    ed.pos += add.length;
  } else if (key === 'backspace') {
    if (ed.pos > 0) {
      chars.splice(ed.pos - 1, 1);
      ed.pos -= 1;
    }
  } else if (key === 'delete') chars.splice(ed.pos, 1);
  else if (key === 'left') ed.pos = Math.max(0, ed.pos - 1);
  else if (key === 'right') ed.pos = Math.min(chars.length, ed.pos + 1);
  else if (key === 'home') ed.pos = 0;
  else if (key === 'end') ed.pos = chars.length;
  else if (key === 'ctrl-u') {
    chars.splice(0, ed.pos);
    ed.pos = 0;
  } else if (key === 'ctrl-w') {
    let at = ed.pos;
    while (at > 0 && chars[at - 1] === ' ') at -= 1;
    while (at > 0 && chars[at - 1] !== ' ') at -= 1;
    chars.splice(at, ed.pos - at);
    ed.pos = at;
  } else if (typeof key === 'string' && [...key].length === 1) {
    chars.splice(ed.pos, 0, key);
    ed.pos += 1;
  } else return false;
  ed.text = chars.join('');
  return true;
}

/** The text being typed, wrapped after its prompt, with a reversed block where the cursor is. */
function editorLines(ed, prompt, columns, most = 4) {
  const chars = [...ed.text.replace(/\n/g, '⏎')];
  const before = chars.slice(0, ed.pos).join('');
  const at = chars[ed.pos] ?? ' ';
  const after = chars.slice(ed.pos + 1).join('');
  const lines = wrapSegments([[null, before], ['rev', at], [null, after]], columns, { first: prompt, rest: ' '.repeat(Math.min(width(prompt), 4)), firstStyle: 'bold cyan' });
  // The end of a long text, where the cursor usually is, rather than its start.
  const cursorLine = lines.findIndex((l) => l.some(([s]) => s === 'rev'));
  const end = Math.min(lines.length, Math.max(most, cursorLine + 1));
  return lines.slice(Math.max(0, end - most), end);
}

// --- the model ------------------------------------------------------------------------

/**
 * @param {{status: object, diff: object, session: string}} initial  the status and diff reviewOpen.mjs read first
 */
export function initialState({ status, diff, session, pulls = [] }) {
  return {
    // `pulls`: the session's pull requests as the console lists them ({number, url}), for the header's link.
    session, status, diff, pulls,
    tab: 'analysis',
    scroll: {},
    fileIndex: 0,
    // Files changed opens on the list of every file; Enter opens one's diff, Esc goes back.
    fileOpen: false,
    cursor: 0,
    draft: { prId: null, headSha: null, reviewId: null, description: null, comments: [], threads: [], outdated: 0, said: [] },
    draftLoading: Boolean(status.livePr),
    chat: { messages: [], busy: false, pending: null, error: null, since: null, starter: -1 },
    qa: { data: null, started: false, error: null },
    compose: null,
    sheet: null,
    flash: null,
    offerReanalysis: false,
    diffAt: diff?.createdAt ?? status.createdAt ?? null,
  };
}

/** The sentence that stands in for Merge, or null when it may be offered (mergeControl). */
export function mergeHint(state) {
  const pr = state.status.livePr;
  if (!pr) return 'This branch has no pull request to merge.';
  if (pr.state !== 'open') return `Pull request #${pr.number} is ${pr.state}.`;
  if (pr.review !== 'approved') return 'Merge is offered once the pull request is approved.';
  if (pr.queued) return 'In the merge queue.';
  if (state.draft.headSha && state.status.headSha && state.draft.headSha !== state.status.headSha) return 'New commits since this review. Re-review to merge.';
  if (state.status.kind === 'worktree' && state.status.meta?.dirtyFiles !== 0) return 'This review read uncommitted changes. Commit, push and re-review to merge.';
  const c = pr.checks;
  if (c?.fail) return `Merge when checks pass: ${c.fail} failing.`;
  if (c?.pending) return `Merge when checks pass: ${c.pending} running.`;
  return null;
}

/** The keys the footer offers for what is on screen. */
export function footerKeys(state) {
  if (state.sheet) return state.sheet.keys ?? [['Esc', 'close']];
  if (state.compose) {
    const keys = [['Enter', state.compose.kind === 'comment' ? (state.compose.mode === 'now' ? 'post now' : state.draft.reviewId ? 'add to review' : 'start a review') : 'send'], ['Esc', 'cancel']];
    if (state.compose.kind === 'comment' && !state.draft.reviewId) keys.push(['Tab', state.compose.mode === 'now' ? 'add to a review instead' : 'post it now instead']);
    if (state.compose.kind === 'chat') keys.push(['↑↓', 'suggestions']);
    keys.push(['Ctrl-U', 'clear']);
    return keys;
  }
  const keys = [['1-5 Tab', 'views']];
  if (state.tab === 'files' && !state.fileOpen) keys.push(['↑↓', 'file'], ['Enter', 'open'], ['i', 'chat about it']);
  else if (state.tab === 'files') {
    keys.push(['↑↓', 'line'], ['n p', 'file'], ['Esc', 'all files'], ['i', 'chat about it']);
    if (state.status.livePr) keys.push(['c', 'comment']);
  } else keys.push([state.tab === 'qa' && state.qa.data?.items?.length ? 'PgUp PgDn' : '↑↓ PgUp PgDn', 'scroll']);
  if (state.tab === 'chat' && !state.chat.busy) keys.push(['Enter', 'ask']);
  if (state.tab === 'qa' && state.qa.data?.items?.length) keys.push(['↑↓', 'question'], ['Enter', 'open']);
  if (state.tab === 'qa' && state.qa.data && state.qa.data.status !== 'running') keys.push(['i', state.qa.data.items?.length ? 'ask about it' : 'ask'], ['A', 'ask again']);
  if (state.tab === 'qa' && !state.qa.data && state.qa.started && !state.qa.loading) keys.push(['A', 'ask the questions']);
  if (state.status.livePr) keys.push(['s', 'submit review'], ['m', 'merge'], ['t', 'rename']);
  if (headerPullUrl(state)) keys.push(['o', 'open PR on GitHub']);
  const st = state.status.status;
  if (st !== 'running' && st !== 'queued' && (st !== 'ready' || state.offerReanalysis)) keys.push(['a', st === 'ready' ? 'read it again' : st === 'unknown' ? 'run analysis' : 'retry analysis']);
  keys.push(['r', 're-review'], ['d', 'discard'], ['?', 'help'], ['q', 'quit']);
  return keys;
}

function footerLines(keys, columns) {
  const segs = [];
  keys.forEach(([k, label], i) => {
    if (i) segs.push([null, '  ']);
    segs.push(['bold', k], ['dim', ` ${label}`]);
  });
  // Pairs are kept whole: a key is never on one line and its word on the next.
  const lines = [[]];
  let used = 0;
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i][1] === '  ') {
      const w = width(segs[i + 1][1]) + width(segs[i + 2][1]);
      if (used + 2 + w > columns) {
        lines.push([]);
        used = 0;
        continue;
      }
    }
    lines[lines.length - 1].push(segs[i]);
    used += width(segs[i][1]);
  }
  return lines.slice(-3);
}

/** The body of the tab on screen, and for Files changed which diff row each line draws. */
export function bodyOf(state, columns, nowMs = Date.now()) {
  if (state.sheet) return { lines: sheetLines(state, columns), items: null };
  if (!state.diff?.files?.length) return { lines: [[['dim', 'This change has no file changes.']]], items: null };
  if (state.tab === 'files') return state.fileOpen ? fileLines(state, columns) : fileListLines(state, columns);
  if (state.tab === 'qa') return qaLines(state, columns);
  const make = { analysis: analysisLines, discussion: discussionLines, chat: (s, c) => chatLines(s, c, nowMs) }[state.tab] ?? analysisLines;
  return { lines: make(state, columns), items: null };
}

function sheetLines(state, columns) {
  const sheet = state.sheet;
  const lines = [[['bold', sheet.title]], []];
  for (const l of sheet.lines ?? []) {
    if (Array.isArray(l)) lines.push(...wrapSegments(l, columns));
    else lines.push(...wrapText(l, columns));
  }
  if (sheet.error) lines.push([], ...wrapText(sheet.error, columns, 'red'));
  return lines;
}

/**
 * The whole screen, as lines of text with escape codes, exactly `rows` of them.
 * @returns {string[]}
 */
export function frame(state, { columns, rows, color = true, nowMs = Date.now(), links = null }) {
  if (columns < 40 || rows < 12) {
    const say = cut('Make this window at least 40 columns by 12 rows. q quits.', columns);
    return [say, ...Array(Math.max(0, rows - 1)).fill('')];
  }
  const top = [...headerLines(state, columns, nowMs).slice(0, Math.max(2, Math.floor(rows / 4))), ...tabBar(state, columns), [['dim', '─'.repeat(columns)]]];
  const bottom = [];
  if (state.flash) bottom.push(...wrapText(state.flash.text, columns, state.flash.bad ? 'red' : 'yellow').slice(0, 2));
  if (state.compose) bottom.push(...editorLines(state.compose.editor, state.compose.prompt, columns));
  if (state.sheet?.editor) bottom.push(...editorLines(state.sheet.editor, state.sheet.prompt ?? '> ', columns));
  bottom.push(...footerLines(footerKeys(state), columns));
  const room = Math.max(1, rows - top.length - bottom.length);
  const body = bodyOf(state, columns, nowMs);
  const { lines, items } = body;
  const cursor = body.cursor ?? state.cursor;
  const key = scrollKey(state);
  let scroll = state.scroll[key] ?? 0;
  if (items && !state.sheet && state.follow !== false) {
    // Files changed follows its cursor: the line is kept on screen, a few lines in from the edge where it can be.
    const first = items.indexOf(cursor);
    const last = items.lastIndexOf(cursor);
    if (first >= 0) {
      if (first < scroll + 1) scroll = Math.max(0, first - 2);
      if (last >= scroll + room - 1) scroll = Math.max(0, last - room + 3);
    }
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - room)));
  state.scroll[key] = scroll;
  // Each row's text, and the links drawn on it: `links` gets {row, from, to, url}, row and columns from 0.
  const out = [];
  const rowLinks = [];
  const put = (row, line, fill = null) => {
    const got = [];
    out[row] = line ? toAnsi(line, { columns, color, fill, links: got }) : '';
    rowLinks[row] = got;
  };
  top.forEach((l) => put(out.length, l));
  for (let i = 0; i < room; i += 1) {
    const at = scroll + i;
    put(out.length, lines[at], items && !state.sheet && !state.compose && items[at] === cursor && cursor >= 0 ? true : null);
  }
  // A cursor line while a comment is written on it stays marked.
  if (items && state.compose?.kind === 'comment') {
    for (let i = 0; i < room; i += 1) if (items[scroll + i] === cursor) put(top.length + i, lines[scroll + i], true);
  }
  const more = lines.length - scroll - room;
  if (more > 0 && out.length) put(out.length - 1, [['dim', `↓ ${more} more line${more === 1 ? '' : 's'}`]]);
  bottom.forEach((l) => put(out.length, l));
  if (links) rowLinks.slice(0, rows).forEach((got, row) => { for (const l of got) links.push({ row, ...l }); });
  return out.slice(0, rows);
}

/** The link drawn at a mouse report's column and row (each from 1), from what `frame` put in its `links`, else null. */
export function linkAt(links, column, row) {
  return (links ?? []).find((l) => l.row === row - 1 && column - 1 >= l.from && column - 1 < l.to)?.url ?? null;
}

/** The pull request's page the header's number links to (the o key opens it), else null. */
export function headerPullUrl(state) {
  const n = state.status?.meta?.number ?? state.status?.livePr?.number;
  return n ? pullRequestUrl(state, n) : null;
}

function scrollKey(state) {
  if (state.sheet) return `sheet:${state.sheet.kind}`;
  if (state.tab === 'files') return state.fileOpen ? `files:${state.fileIndex}` : 'files:list';
  return state.tab;
}

// --- the run --------------------------------------------------------------------------

/**
 * Runs the review on this terminal until the person quits.
 * @param {{api: (method: string, path: string, body?: object) => Promise<object>, initial: {status: object, diff: object, session: string, pulls?: object[]},
 *          stdin: object, stdout: object, color?: boolean, now?: () => number,
 *          timers?: {set: typeof setTimeout, clear: typeof clearTimeout},
 *          openUrl?: (url: string, failed: (why: string) => void) => void, canOpen?: () => boolean,
 *          proc?: {on: Function, off: Function, kill: Function, pid: number, platform: string}|null}} args
 *   `api` takes a path after /reviews/claude-<id> and answers the JSON, or throws an Error with `status` and `code`;
 *   one with `ended` set is a sign-in that ended, which ends the review. `openUrl` opens a pull request's page
 *   (browser.mjs, never a shell), and `canOpen` says whether a browser could open here at all. `proc` is the process
 *   whose exit and signals put the terminal back as it was: null for none.
 * @returns {Promise<{code: 'quit'|'ended', message?: string}>}
 */
export function runReviewTui({
  api, initial, stdin, stdout, color = true, now = Date.now, timers = { set: setTimeout, clear: clearTimeout },
  openUrl = (url, failed) => openBrowser(url, { failed }), canOpen = () => canOpenBrowser(process.platform, process.env),
  proc = process,
}) {
  const state = initialState(initial);
  const pending = new Set();
  let finished = null;
  let drawQueued = false;
  // Where the last frame drew each link, for a click on it.
  let links = [];

  return new Promise((resolve) => {
    const columns = () => stdout.columns || 80;
    const rows = () => stdout.rows || 24;
    const later = (fn, ms) => {
      const t = timers.set(() => {
        pending.delete(t);
        if (!finished) fn();
      }, ms);
      pending.add(t);
      return t;
    };
    function draw() {
      if (finished || drawQueued) return;
      drawQueued = true;
      later(() => {
        drawQueued = false;
        const drawn = [];
        const lines = frame(state, { columns: columns(), rows: rows(), color, nowMs: now(), links: drawn });
        links = drawn;
        stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\r\n')}\x1b[J`);
      }, 0);
    }
    function flash(text, bad = false) {
      state.flash = { text: clean(text), bad };
      draw();
    }
    // The terminal as the review takes it: the alternate screen, no cursor of the terminal's own (the boxes draw
    // theirs), pastes marked as pastes, and clicks and the wheel reported (1000, presses and releases only, never
    // motion; 1006, as SGR's numbers). And as it gives it back, on a quit, an exit, a crash, a signal or a suspend.
    function takeTerminal() {
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[2J');
    }
    function giveTerminalBack() {
      stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
      if (stdin.isTTY) stdin.setRawMode?.(false);
    }
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    function onExit() {
      if (!finished) giveTerminalBack();
    }
    function onSignal(signal) {
      if (!finished) {
        finished = { code: 'quit' };
        giveTerminalBack();
      }
      unhook();
      // Dies of the signal it was sent, as it would have with nobody listening.
      proc.kill(proc.pid, signal);
    }
    function onStop() {
      if (finished) return;
      giveTerminalBack();
      proc.off('SIGTSTP', onStop);
      proc.kill(proc.pid, 'SIGTSTP');
    }
    function onContinue() {
      if (finished) return;
      proc.on('SIGTSTP', onStop);
      takeTerminal();
      draw();
    }
    // Ctrl-Z in raw mode is a key, not a signal: it suspends as a terminal's would (not on Windows, which has none).
    function suspend() {
      if (!proc || proc.platform === 'win32') return undefined;
      return onStop();
    }
    function hook() {
      if (!proc) return;
      proc.on('exit', onExit);
      for (const sig of SIGNALS) proc.on(sig, onSignal);
      if (proc.platform !== 'win32') {
        proc.on('SIGTSTP', onStop);
        proc.on('SIGCONT', onContinue);
      }
    }
    function unhook() {
      if (!proc) return;
      proc.off('exit', onExit);
      for (const sig of SIGNALS) proc.off(sig, onSignal);
      proc.off('SIGTSTP', onStop);
      proc.off('SIGCONT', onContinue);
    }
    function finish(result) {
      if (finished) return;
      finished = result;
      for (const t of pending) timers.clear(t);
      stdin.off('data', onData);
      stdout.off?.('resize', draw);
      giveTerminalBack();
      unhook();
      stdin.pause?.();
      resolve(result);
    }
    // Every call: a sign-in that ended ends the review, anything else is the caller's to say.
    async function call(method, path, body) {
      try {
        return await api(method, path, body);
      } catch (err) {
        if (err.ended) finish({ code: 'ended', message: err.message });
        throw err;
      }
    }
    const soft = (err) => flash(err.message, true);

    // --- reads, in the page's order (loadReview) ---
    async function loadReview() {
      const status = await call('GET', '');
      if (status.ok === false) throw Object.assign(new Error(status.error ?? 'no review for this session'), { status: 404 });
      state.status = status;
      state.diff = await call('GET', '/diff');
      state.diffAt = state.diff?.createdAt ?? status.createdAt ?? null;
      state.fileIndex = Math.min(state.fileIndex, Math.max(0, (state.diff?.files?.length ?? 1) - 1));
      state.cursor = 0;
      draw();
      loadDraft();
      if (status.status === 'running' || status.status === 'queued') pollStatus();
    }
    async function loadDraft() {
      if (!state.status.livePr) {
        state.draftLoading = false;
        return;
      }
      state.draftLoading = true;
      draw();
      try {
        const got = await call('GET', '/comments');
        state.draft = {
          prId: got.prId ?? null, headSha: got.headSha ?? null, reviewId: got.reviewId ?? null, description: got.description ?? null,
          comments: got.comments ?? [], threads: got.threads ?? [], outdated: got.outdated ?? 0, said: got.said ?? [], truncated: Boolean(got.truncated),
        };
      } catch (err) {
        if (!finished) flash(`Could not read your draft review on GitHub: ${err.message}`, true);
      }
      state.draftLoading = false;
      draw();
    }
    let statusTimer = null;
    function pollStatus() {
      if (statusTimer) return;
      statusTimer = later(async () => {
        statusTimer = null;
        try {
          const got = await call('GET', '');
          if (got.ok !== false) {
            for (const k of ['status', 'progress', 'error', 'waiting', 'createdAt']) state.status[k] = got[k] ?? null;
            if (got.review) state.status.review = got.review;
          }
        } catch {
          // A read that failed for a moment does not blank what is on screen.
        }
        draw();
        if (state.status.status === 'running' || state.status.status === 'queued') pollStatus();
      }, STATUS_POLL_MS);
    }

    // --- chat (the page's conversation panel) ---
    async function loadChat() {
      try {
        const got = await call('GET', '/chat');
        state.chat.messages = got.messages ?? [];
        if (got.running && !state.chat.busy) {
          state.chat.busy = true;
          state.chat.since = now();
          draw();
          await settleChat(pollAnswer(got.running));
        }
      } catch (err) {
        if (!finished) state.chat.error = `Could not read the conversation: ${err.message}`;
      }
      draw();
    }
    function pollAnswer(askId) {
      return new Promise((resolve, reject) => {
        const once = async () => {
          try {
            const got = await call('GET', `/explain/${encodeURIComponent(askId)}`);
            if (got.status === 'ready') return resolve(got.answer);
            if (got.status === 'failed') return reject(new Error(got.error || 'the answer failed'));
            draw();
            later(once, ANSWER_POLL_MS);
          } catch (err) {
            reject(err);
          }
        };
        later(once, ANSWER_POLL_MS);
      });
    }
    let ticking = false;
    function tick() {
      if (ticking || !state.chat.busy) return;
      ticking = true;
      later(() => {
        ticking = false;
        draw();
        tick();
      }, TICK_MS);
    }
    async function settleChat(answering) {
      tick();
      try {
        await answering;
        state.chat.error = null;
        const got = await call('GET', '/chat');
        state.chat.messages = got.messages ?? [];
      } catch (err) {
        if (finished) return;
        state.chat.error = err.message;
        // A failed turn is not on the record: the question goes back in the box, as the page puts it back.
        if (state.chat.pending) state.chat.unsent = state.chat.pending;
      }
      state.chat.busy = false;
      state.chat.pending = null;
      state.chat.since = null;
      draw();
    }
    function sendChat(text) {
      state.chat.pending = text;
      state.chat.busy = true;
      state.chat.error = null;
      state.chat.since = now();
      draw();
      settleChat(call('POST', '/chat', { question: text }).then((res) => pollAnswer(res.askId)));
    }

    // --- Q&A ---
    let qaTimer = null;
    async function loadQa(start) {
      // A read already on its way: the start it was asked for here is made once that read is in (opening the tab while
      // the first read, at launch, has not come back), as the page asks again from its render.
      if (state.qa.loading) {
        if (start) state.qa.startWanted = true;
        return;
      }
      state.qa.loading = true;
      try {
        const got = await call('GET', '/qa');
        let data = got.qa ?? null;
        if (data && (data.forDiff ?? null) !== (state.diffAt ?? null)) data = null;
        state.qa.data = data;
        state.qa.error = null;
        if (!data && start && !state.qa.started) {
          state.qa.started = true;
          const asked = await call('POST', `/qa?forDiff=${encodeURIComponent(state.diffAt ?? '')}&first=1`);
          if (asked.kept) state.qa.data = (await call('GET', '/qa')).qa ?? null;
          else state.qa.data = { status: 'running', phase: 'asking', depth: 1, items: [] };
        }
      } catch (err) {
        if (finished) return;
        state.qa.error = err.message;
      } finally {
        state.qa.loading = false;
      }
      if (state.qa.startWanted && !finished) {
        state.qa.startWanted = false;
        if (!state.qa.data && !state.qa.started && !state.qa.error && state.tab === 'qa') return loadQa(true);
      }
      draw();
      const d = state.qa.data;
      if (d && (d.status === 'running' || (d.items ?? []).some((i) => i.asking)) && !qaTimer) {
        qaTimer = later(() => {
          qaTimer = null;
          loadQa(state.tab === 'qa');
        }, QA_POLL_MS);
      }
    }
    // Ask the questions (none yet: a first ask, which keeps a Q&A another tab made meanwhile), or Ask again (replaces
    // the tree, the reader's own questions with it: pressed twice when there are some), as askQaAgain does.
    async function askQaAgain() {
      const d = state.qa.data;
      if (d?.status === 'running') return flash('The Q&A is still being written.');
      const replace = Boolean(d);
      const mine = replace && ((d.items ?? []).some((i) => i.mine) || Object.keys(d.askErrors ?? {}).length > 0);
      if (mine && !state.qa.sure) {
        state.qa.sure = true;
        return flash('Ask again writes a new Q&A, without the questions you asked. A again to ask again.');
      }
      state.qa.sure = false;
      try {
        const asked = await call('POST', `/qa?forDiff=${encodeURIComponent(state.diffAt ?? '')}${replace ? '' : '&first=1'}`);
        state.qa = { data: asked.kept ? null : { status: 'running', phase: 'asking', depth: 1, items: [] }, started: true, error: null, loading: false };
        state.flash = null;
        draw();
        loadQa(false);
      } catch (err) {
        if (!finished) flash(`Not asked again: ${err.message}`, true);
      }
    }
    // A question of the reader's: at the top (parent null), or a follow-up under an answered one, as sendQaQuestion.
    async function askQa(question, parent = null) {
      let asked = null;
      try {
        asked = (await call('POST', '/qa/ask', { parent, question, forDiff: state.diffAt ?? '' })).item ?? null;
        // The question waits where it was asked, under the one it follows, which stays open to show it.
        if (parent) state.qa.open = qaPath(parent);
        flash(parent ? 'Asked. It waits for its answer under the question it follows.' : 'Asked. It waits for its answer at the end of the questions.');
      } catch (err) {
        if (!finished) flash(`Not asked: ${err.message}`, true);
      }
      await loadQa(false);
      // The cursor goes to it, so it is on screen where it was asked.
      const at = asked ? qaVisible(state).findIndex((i) => i.id === asked.id) : -1;
      if (at >= 0) {
        state.qa.cursor = at;
        state.follow = true;
        draw();
      }
    }

    // --- writes ---
    async function sendComment(text, mode) {
      const file = fileOrder(state)[state.fileIndex]?.file;
      const line = diffRows(file)[state.cursor];
      if (!file || !line) return;
      const side = line.newNo !== null && line.newNo !== undefined ? 'new' : 'old';
      const no = side === 'new' ? line.newNo : line.oldNo;
      try {
        await call('POST', '/comments', {
          mode, prId: state.draft.prId, headSha: state.draft.headSha, reviewId: state.draft.reviewId,
          path: file.path, line: no, startLine: null, side, body: text,
        });
        state.compose = null;
        flash(mode === 'now' ? `Comment posted on ${file.path}:${no}.` : `Added to your draft review. It goes out when you submit (s).`);
        await loadDraft();
      } catch (err) {
        // Kept in the box: what was written is never lost to an error.
        if (!finished) flash(err.message, true);
      }
    }
    function openSubmit() {
      const pr = state.status.livePr;
      const who = state.status.ghAccount ? `as ${clean(state.status.ghAccount)}` : 'as whichever account gh is signed in as in the session';
      let where = `This posts publicly to pull request #${pr.number} on GitHub, ${who}.`;
      const n = state.draft.comments.length;
      if (n) where += ` Your ${n} draft comment${n === 1 ? ' goes' : 's go'} out with it.`;
      if (state.status.kind !== 'pr') where += ' What you have been reading is the working tree of this session, which may not match what the pull request shows.';
      state.sheet = {
        kind: 'submit', title: `Submit review on #${pr.number}`, event: 'comment', editor: editor(state.submitDraft ?? ''), prompt: 'Comment: ', sure: false,
      };
      // The verdict is the first thing on the sheet, and Enter says it in the footer, which is always on screen: however
      // many draft comments there are, what Enter posts is never off the screen.
      const keysFor = () => [['Tab', 'verdict'], ['Enter', `post: ${SUBMIT_WORDS[state.sheet.event]}`], ...(state.draft.reviewId ? [['Ctrl-D', 'discard the draft']] : []),
        ...(n > SHOWN_PENDING ? [['PgUp PgDn', 'scroll']] : []), ['Esc', 'cancel']];
      const lines = () => {
        const choice = [];
        for (const e of EVENTS) choice.push([state.sheet.event === e ? 'rev bold' : 'dim', ` ${SUBMIT_WORDS[e]} `], [null, ' ']);
        const out = [[['bold', 'Verdict: '], ...choice], '', where];
        if (state.sheet.sure) out.push('', [['red bold', `Ctrl-D again discards ${n} comment${n === 1 ? '' : 's'}. Nothing is posted.`]]);
        if (n) {
          out.push('', [['bold', `${n} pending comment${n === 1 ? '' : 's'}`]]);
          for (const c of state.draft.comments.slice(0, SHOWN_PENDING)) out.push([['cyan', `${clean(c.path)}:${c.startLine && c.startLine !== c.line ? `${c.startLine}-` : ''}${c.line}`], [null, `  ${cut(clean(c.body).replace(/\n/g, ' '), 200)}`]]);
          if (n > SHOWN_PENDING) out.push([['dim', `and ${n - SHOWN_PENDING} more, which go out with it too (Discussion and Files changed show them all)`]]);
        }
        return out;
      };
      state.sheet.keys = keysFor();
      state.sheet.keysFor = keysFor;
      state.sheet.render = lines;
      state.sheet.lines = lines();
      draw();
    }
    async function submit() {
      const sheet = state.sheet;
      const event = sheet.event;
      sheet.error = null;
      sheet.busy = true;
      draw();
      try {
        const got = await call('POST', '/submit', { event, body: sheet.editor.text });
        state.sheet = null;
        state.submitDraft = '';
        if (event === 'approve' && state.status.livePr) state.status.livePr.review = 'approved';
        flash(`${SUBMIT_DONE[event]} on #${got.pr ?? state.status.livePr?.number}.${event === 'approve' ? ' m merges it.' : ''}`);
        loadDraft();
      } catch (err) {
        if (finished) return;
        sheet.busy = false;
        sheet.error = err.message;
        draw();
      }
    }
    async function discardDraft() {
      const sheet = state.sheet;
      if (!sheet.sure) {
        sheet.sure = true;
        sheet.lines = sheet.render();
        draw();
        return;
      }
      try {
        await call('DELETE', '/comments', { all: true, reviewId: state.draft.reviewId });
        state.sheet = null;
        flash('Draft review discarded. Nothing was posted.');
        loadDraft();
      } catch (err) {
        if (!finished) {
          sheet.error = err.message;
          draw();
        }
      }
    }
    function readinessLines(got) {
      const r = got.readiness ?? {};
      const item = (tone, text) => [[tone === 'ok' ? 'green' : tone === 'no' ? 'red' : 'yellow', tone === 'ok' ? '✓ ' : tone === 'no' ? '✗ ' : '• '], [null, text]];
      const out = [];
      const pr = state.status.livePr;
      const who = state.status.ghAccount ? `as ${clean(state.status.ghAccount)}` : 'as whichever account gh is signed in as in the session';
      out.push(r.mergeQueue
        ? `This repository uses the merge queue for all merges into the ${clean(r.baseRef)} branch. This adds pull request #${pr.number} to it on GitHub ${who}, and GitHub merges it once the queue's checks pass.`
        : `This merges pull request #${pr.number} on GitHub ${who}, and GitHub then deletes its branch.`, '');
      out.push(item(r.reviewDecision === 'APPROVED' ? 'ok' : 'no', r.reviewDecision === 'APPROVED' ? 'Approved' : 'Not approved'));
      const c = r.checks;
      if (!c) out.push(item('ok', 'No checks reported'));
      else if (c.fail) out.push(item('no', `${c.fail} of ${c.total} checks failing`));
      else if (c.pending) out.push(item('wait', `${c.pending} of ${c.total} checks still running`));
      else out.push(item('ok', `All ${c.total} checks passing`));
      const head = String(r.headSha ?? '').slice(0, 8);
      const read = String(got.reviewedSha ?? '').slice(0, 8);
      out.push(head && head === read ? item('ok', `Head is ${head}, the commit this review read`) : item('no', `Head is ${head || 'unknown'}, but this review read ${read || 'nothing'}`));
      if (r.queued) out.push(item('no', 'Already in the merge queue'));
      if (r.mergeState === 'DIRTY') out.push(item('no', `Conflicts with ${clean(r.baseRef)}`));
      else if (r.mergeState === 'UNKNOWN') out.push(item('wait', `GitHub is still checking for conflicts with ${clean(r.baseRef)}`));
      else out.push(item('ok', `No conflicts with ${clean(r.baseRef)}`));
      if (got.blocker) out.push('', [['red bold', `Can't merge: ${clean(got.blocker.error)}.`]]);
      return out;
    }
    async function openMerge() {
      const hint = mergeHint(state);
      if (hint) return flash(hint);
      const pr = state.status.livePr;
      state.sheet = { kind: 'merge', title: `Squash and merge #${pr.number}`, lines: ['Asking GitHub where this pull request stands…'], keys: [['Esc', 'cancel']] };
      draw();
      try {
        const got = await call('GET', '/merge');
        if (state.sheet?.kind !== 'merge') return;
        state.sheet.lines = readinessLines(got);
        state.sheet.blocked = Boolean(got.blocker);
        if (!got.blocker) {
          state.sheet.queue = Boolean(got.readiness?.mergeQueue);
          if (!state.sheet.queue) {
            state.sheet.editor = editor(`${clean(pr.title || state.status.meta?.title || '')} (#${pr.number})`);
            state.sheet.prompt = 'Commit title: ';
          }
          state.sheet.keys = [['Enter', state.sheet.queue ? 'add to the merge queue' : 'squash and merge'], ['Esc', 'cancel']];
        }
      } catch (err) {
        if (finished || state.sheet?.kind !== 'merge') return;
        state.sheet.error = err.message;
      }
      draw();
    }
    async function merge() {
      const sheet = state.sheet;
      if (sheet.blocked || sheet.busy || !sheet.keys?.some(([k]) => k === 'Enter')) return;
      sheet.busy = true;
      sheet.error = null;
      draw();
      try {
        const got = await call('POST', '/merge', { subject: sheet.editor?.text ?? '' });
        state.sheet = null;
        if (got.queued) {
          state.status.livePr.queued = true;
          flash(`Added #${got.pr} to the ${clean(got.baseRef)} merge queue${got.position ? ` at position ${got.position}` : ''}. GitHub merges it once the queue's checks pass.`);
        } else {
          Object.assign(state.status.livePr, { state: 'merged', review: null, checks: null });
          flash(`Merged #${got.pr} into ${clean(got.baseRef)} as ${String(got.sha ?? '').slice(0, 8)}.`);
        }
      } catch (err) {
        if (finished) return;
        sheet.busy = false;
        sheet.error = err.message;
        if (err.code) {
          sheet.blocked = true;
          call('GET', '/merge').then((got) => {
            if (state.sheet === sheet) {
              sheet.lines = readinessLines(got);
              draw();
            }
          }).catch(() => {});
        }
        draw();
      }
    }
    function openRename() {
      state.sheet = {
        kind: 'rename', title: `Rename pull request #${state.status.livePr.number} on GitHub`, lines: ['The new title is GitHub\'s at once: everyone on the pull request sees it.'],
        editor: editor(reviewTitle(state.status)), prompt: 'Title: ', keys: [['Enter', 'save'], ['Esc', 'cancel']],
      };
      draw();
    }
    async function rename() {
      const sheet = state.sheet;
      const text = sheet.editor.text.trim();
      if (!text || text === reviewTitle(state.status)) {
        state.sheet = null;
        return draw();
      }
      try {
        const got = await call('PATCH', '/title', { title: text });
        state.sheet = null;
        if (state.status.livePr) state.status.livePr.title = got.title || text;
        flash('Renamed on GitHub.');
      } catch (err) {
        if (finished) return;
        sheet.error = err.message;
        draw();
      }
    }
    async function reReview() {
      flash('Re-reviewing: taking the diff again…');
      try {
        const got = await call('POST', state.status.kind === 'worktree' ? '' : '/refresh', {});
        if (got.unchanged) {
          state.offerReanalysis = true;
          return flash('No new commits. a reads the same commit again anyway.');
        }
        state.offerReanalysis = false;
        state.qa = { data: null, started: true, error: null };
        await loadReview();
        // The shed started the new diff's Q&A with its analysis: read it, after the review that says which diff it is.
        loadQa(false);
        flash('Re-reviewed: the diff is as the branch is now.');
      } catch (err) {
        if (!finished) flash(`Re-review failed: ${err.message}`, true);
      }
    }
    async function runAnalysis() {
      try {
        await call('POST', '/analyze', {});
        state.offerReanalysis = false;
        state.status.status = 'running';
        state.status.review = state.status.review ?? null;
        flash('Reading the change: a minute or two.');
        pollStatus();
      } catch (err) {
        if (!finished) soft(err);
      }
    }
    function openDiscard() {
      state.sheet = {
        kind: 'discard', title: 'Discard the analysis and the conversation?',
        lines: ['The diff stays, and so do this session, its worktree and its branch. Your viewed ticks stay too: they live on the pull request, not here. You can read it again afterwards.'],
        keys: [['y', 'discard'], ['any other key', 'keep it']],
      };
      draw();
    }
    async function discard() {
      try {
        await call('POST', '/discard', {});
        state.sheet = null;
        state.chat = { messages: [], busy: false, pending: null, error: null, since: null, starter: -1 };
        state.qa = { data: null, started: true, error: null };
        await loadReview();
        flash('Discarded. a reads it again.');
      } catch (err) {
        if (!finished) {
          state.sheet = null;
          soft(err);
        }
      }
    }
    function openHelp() {
      state.sheet = {
        kind: 'help', title: 'Keys',
        lines: [
          '1-5 open the numbered tabs. In a text box, a number is text. Tab and Shift-Tab cycle.',
          '↑ ↓ j k scroll (on Files changed, move the line), PgUp PgDn Space b by a page, g G the top and the end.',
          '4 Files changed lists every file in the analysis\'s reading order: ↑ ↓ choose one, Enter opens its diff, Esc goes back to the list; in a diff, n p move to the next and previous file.',
          'i on Files changed starts a chat about the file (in its diff, about the line), with its path in the box.',
          'c comments on the line, into your draft review or posted at once (Tab chooses), with a pull request.',
          'Enter on Chat asks the session\'s agent about the change.',
          '2 Q&A: ↑ ↓ choose a question, Enter or → opens it (one at a time, with its follow-ups), ← closes it; i asks a follow-up on it (on the last row, a question of your own), A all of them again.',
          's submits your review (comment, approve or request changes) with your draft comments. m merges, t renames.',
          'o opens the pull request on GitHub in your browser, as a click on its underlined number in the header does. Over SSH, or with no display, the status line shows its address instead. In Herdr, Ctrl-click opens a link too.',
          'The review takes this window\'s clicks and wheel (the wheel scrolls). To select text, hold Shift as you drag (Option in some macOS terminals, such as iTerm2 and Terminal).',
          'r re-reviews: pulls the branch, takes the diff again and reads it again. a runs the analysis. d discards it.',
          'Writes to GitHub go as you, from your own My Woodshed session, once you have connected GitHub on My settings.',
          'q quits; the session and the review go on.',
        ],
        keys: [['any key', 'close']],
      };
      draw();
    }

    // --- keys ---
    function setTab(key) {
      if (!tabsOf(state).some((t) => t.key === key)) return;
      state.tab = key;
      state.flash = null;
      if (key === 'qa') loadQa(true);
      draw();
    }
    function scrollBy(n) {
      state.follow = false;
      const key = scrollKey(state);
      state.scroll[key] = Math.max(0, (state.scroll[key] ?? 0) + n);
      draw();
    }
    function moveCursor(n) {
      state.follow = true;
      const file = fileOrder(state)[state.fileIndex]?.file;
      const count = diffRows(file).length;
      if (!count) return scrollBy(n);
      state.cursor = Math.max(0, Math.min(count - 1, state.cursor + n));
      draw();
    }
    // --- the Q&A's tree: one question open at a time, with the ones it follows up ---
    function qaPath(id) {
      const items = state.qa.data?.items ?? [];
      const path = [];
      for (let at = items.find((i) => i.id === id); at && path.length < 20; at = items.find((i) => i.id === at.parent)) path.unshift(at.id);
      return path;
    }
    // The question the cursor is on, or null on the last row, which asks one of your own.
    function qaSelected() {
      return qaVisible(state)[Math.max(0, state.qa.cursor ?? 0)] ?? null;
    }
    function qaMove(n) {
      const count = qaVisible(state).length + (state.qa.data?.status === 'running' ? 0 : 1);
      if (!count) return scrollBy(n);
      state.qa.cursor = Math.max(0, Math.min(count - 1, (state.qa.cursor ?? 0) + n));
      state.follow = true;
      return draw();
    }
    // Enter or → opens the question (closing any other), and again closes it; ← closes it, or on a closed follow-up the
    // question it follows, and goes there.
    function qaToggle(close = false) {
      const item = qaSelected();
      if (!item) return undefined;
      const isOpen = (state.qa.open ?? []).includes(item.id);
      let at = item.id;
      if (isOpen) state.qa.open = qaPath(item.parent);
      else if (close) {
        if (!item.parent) return undefined;
        at = item.parent;
        state.qa.open = qaPath(state.qa.data.items.find((i) => i.id === item.parent)?.parent);
      } else {
        if (!item.answer) return flash(item.asking || state.qa.data?.status === 'running' ? 'That question is still being answered.' : 'That question was not answered.');
        state.qa.open = qaPath(item.id);
      }
      state.qa.cursor = Math.max(0, qaVisible(state).findIndex((i) => i.id === at));
      state.follow = true;
      return draw();
    }
    // `i`: a question asked where the cursor is. On a question, a follow-up under it; on the last row, one of your own.
    function qaAsk() {
      const d = state.qa.data;
      const item = qaSelected();
      if (!d || d.status === 'running') return flash('The Q&A is still being written: ask once it is done.');
      if (!item) return startCompose('qa');
      if (!item.answer) return flash('Follow up on a question once it is answered.');
      if ((item.depth ?? qaPath(item.id).length) >= 8) return flash('That is as deep as follow-ups go: ask it as a question of your own (i).');
      if ((d.items ?? []).some((i) => i.parent === item.id && i.asking)) return flash('A follow-up on that one is still being answered.');
      state.qa.open = qaPath(item.id);
      return startCompose('qa', item.id);
    }
    function openFile(open) {
      if (!fileOrder(state).length) return;
      state.fileOpen = open;
      state.cursor = 0;
      draw();
    }
    // The page's Send to the conversation: Chat, with the file's path (and the line's, in its diff) in the box.
    function chatAbout() {
      const file = fileOrder(state)[state.fileIndex]?.file;
      if (!file) return undefined;
      const line = state.fileOpen ? diffRows(file)[state.cursor] : null;
      const at = line ? `${clean(file.path)}:${line.newNo ?? line.oldNo}` : clean(file.path);
      state.tab = 'chat';
      return startCompose('chat', at);
    }
    function moveFile(n) {
      state.follow = true;
      const count = fileOrder(state).length;
      if (!count) return;
      state.fileIndex = Math.max(0, Math.min(count - 1, state.fileIndex + n));
      state.cursor = 0;
      draw();
    }
    function needsPr(what) {
      if (state.status.livePr) return true;
      flash(`This branch has no pull request to ${what}. It shows here once the session opens one; a session that cannot write to GitHub as you shows none.`);
      return false;
    }
    function startCompose(kind, reference = null) {
      if (kind === 'chat') {
        if (state.chat.busy) return flash('Still answering the last question: ask about it once the answer is in.');
        let text = state.chat.unsent ?? '';
        if (reference) text = `${text}${text && !text.endsWith(' ') ? ' ' : ''}${reference} `;
        state.compose = { kind, editor: editor(text), prompt: 'Ask: ' };
        state.chat.unsent = null;
        state.chat.starter = -1;
      } else if (kind === 'qa') {
        const parent = reference;
        const prompt = parent ? `Follow up on "${cut(clean(state.qa.data.items.find((i) => i.id === parent)?.question ?? ''), 30)}": ` : 'Your question: ';
        state.compose = { kind, parent, editor: editor(state.qa.drafts?.[parent ?? ''] ?? ''), prompt };
      }
      else {
        const file = fileOrder(state)[state.fileIndex]?.file;
        const line = diffRows(file)[state.cursor];
        if (!line) return flash('No line to comment on in this file.');
        const no = line.newNo ?? line.oldNo;
        state.compose = { kind, editor: editor(state.commentDraft ?? ''), prompt: `Comment on ${cut(clean(file.path), 30)}:${no}: `, mode: 'draft' };
      }
      draw();
    }
    function composeKey(key) {
      const c = state.compose;
      if (key === 'escape') {
        if (c.kind === 'comment') state.commentDraft = c.editor.text;
        if (c.kind === 'qa') state.qa.drafts = { ...state.qa.drafts, [c.parent ?? '']: c.editor.text };
        state.compose = null;
        return draw();
      }
      if (key === 'enter') {
        const text = c.editor.text.trim();
        if (!text) return;
        if (c.kind === 'chat') {
          state.compose = null;
          sendChat(text);
        } else if (c.kind === 'qa') {
          state.compose = null;
          if (state.qa.drafts) delete state.qa.drafts[c.parent ?? ''];
          askQa(text, c.parent ?? null);
        } else {
          state.commentDraft = '';
          sendComment(text, c.mode);
        }
        return draw();
      }
      if (key === 'tab' && c.kind === 'comment' && !state.draft.reviewId) {
        c.mode = c.mode === 'now' ? 'draft' : 'now';
        return draw();
      }
      if ((key === 'up' || key === 'down') && c.kind === 'chat') {
        const starters = chatStarters(state.status.review);
        state.chat.starter = (state.chat.starter + (key === 'up' ? -1 : 1) + starters.length + 1) % (starters.length + 1);
        c.editor = editor(starters[state.chat.starter] ?? '');
        return draw();
      }
      if (editKey(c.editor, key)) draw();
    }
    function sheetKey(key) {
      const sheet = state.sheet;
      if (sheet.kind === 'help') {
        state.sheet = null;
        return draw();
      }
      if (sheet.kind === 'discard') {
        if (key === 'y' || key === 'Y') return discard();
        state.sheet = null;
        return draw();
      }
      if (key === 'escape') {
        if (sheet.kind === 'submit') state.submitDraft = sheet.editor.text;
        state.sheet = null;
        return draw();
      }
      // A sheet longer than the screen scrolls, whatever is being typed in its box.
      if (key === 'pageup' || key === 'pagedown') return scrollBy((key === 'pageup' ? -1 : 1) * Math.max(1, rows() - 12));
      if (sheet.busy) return undefined;
      if (sheet.kind === 'submit') {
        if (key === 'tab' || key === 'shift-tab') {
          const i = EVENTS.indexOf(sheet.event);
          sheet.event = EVENTS[(i + (key === 'tab' ? 1 : EVENTS.length - 1)) % EVENTS.length];
          sheet.sure = false;
          sheet.lines = sheet.render();
          sheet.keys = sheet.keysFor();
          return draw();
        }
        if (key === 'ctrl-d' && state.draft.reviewId) return discardDraft();
        if (key === 'enter') return submit();
      }
      if (sheet.kind === 'merge' && key === 'enter') return merge();
      if (sheet.kind === 'rename' && key === 'enter') return rename();
      if (sheet.editor && editKey(sheet.editor, key)) return draw();
      return undefined;
    }
    // The o key and a click on a link: a pull request's page on github.com only, opened without a shell, or its
    // address in the status line where no browser could open (over SSH, with no display) or the opener failed.
    function openPullRequest(url) {
      const ok = githubPullUrl(url);
      if (!ok) return flash('Not opened: only a pull request\'s page on github.com opens from here.', true);
      if (!canOpen()) return flash(`No browser to open here. The pull request: ${ok}`);
      flash(`Opening ${ok} in your browser.`);
      openUrl(ok, (why) => flash(`Not opened (${clean(why)}). The pull request: ${ok}`, true));
      return undefined;
    }
    function onMouse({ kind, column, row }) {
      if (kind === 'wheel-up' || kind === 'wheel-down') return scrollBy(kind === 'wheel-up' ? -3 : 3);
      if (kind !== 'click') return undefined;
      const url = linkAt(links, column, row);
      return url ? openPullRequest(url) : undefined;
    }
    function onKey(key) {
      if (key === 'ctrl-c') return finish({ code: 'quit' });
      if (key === 'ctrl-z') return suspend();
      if (typeof key === 'object' && key.mouse) return onMouse(key.mouse);
      if (key === 'ctrl-l') {
        stdout.write('\x1b[2J');
        return draw();
      }
      if (state.sheet) return sheetKey(key);
      if (state.compose) return composeKey(key);
      if (state.flash && key !== 'escape') state.flash = null;
      if (key !== 'A' && state.qa.sure) state.qa.sure = false;
      const tabs = tabsOf(state);
      const page = Math.max(1, rows() - 12);
      // Files changed: the list moves between files and opens one; an open file moves between its lines.
      const list = state.tab === 'files' && !state.fileOpen;
      const diff = state.tab === 'files' && state.fileOpen;
      const qaTab = state.tab === 'qa' && Boolean(state.qa.data);
      const step = (n) => (list ? moveFile(n) : diff ? moveCursor(n) : qaTab && Math.abs(n) === 1 ? qaMove(n) : scrollBy(n));
      // On Q&A, g and G go to the first question and to the last row (a question of your own).
      switch (key) {
        case 'q': return finish({ code: 'quit' });
        case 'escape': case 'backspace':
          if (diff) return openFile(false);
          state.flash = null;
          return draw();
        case 'tab':
        case 'shift-tab': {
          const i = tabs.findIndex((t) => t.key === state.tab);
          return setTab(tabs[(i + (key === 'tab' ? 1 : tabs.length - 1)) % tabs.length].key);
        }
        case 'up': case 'k': return step(-1);
        case 'down': case 'j': return step(1);
        case 'pageup': case 'b': return step(-page);
        case 'pagedown': case ' ': return step(page);
        case 'home': case 'g':
          if (qaTab) return qaMove(-Infinity);
          if (list) return moveFile(-Infinity);
          if (diff) state.cursor = 0;
          state.scroll[scrollKey(state)] = 0;
          return draw();
        case 'end': case 'G':
          if (qaTab) return qaMove(Infinity);
          if (list) return moveFile(Infinity);
          if (diff) return moveCursor(Infinity);
          state.scroll[scrollKey(state)] = Number.MAX_SAFE_INTEGER;
          return draw();
        case 'o': {
          const url = headerPullUrl(state);
          return url ? openPullRequest(url) : flash('This review has no pull request to open on GitHub.');
        }
        case 'right':
          if (qaTab) return qaToggle();
          return list ? openFile(true) : diff ? moveFile(1) : undefined;
        case 'n': case ']': return diff ? moveFile(1) : list ? moveFile(1) : undefined;
        case 'left': case 'p': case '[':
          if (qaTab && key === 'left') return qaToggle(true);
          return diff && key === 'left' ? openFile(false) : state.tab === 'files' ? moveFile(-1) : undefined;
        case 'f': return state.tab === 'qa' && state.qa.data ? qaAsk() : undefined;
        case 'enter': case 'i':
          if (state.tab === 'chat') return startCompose('chat');
          if (qaTab && key === 'enter' && qaSelected()) return qaToggle();
          if (state.tab === 'qa' && state.qa.data) return qaAsk();
          if (state.tab === 'files' && key === 'i') return chatAbout();
          if (list) return openFile(true);
          if (diff && needsPr('comment on')) return startCompose('comment');
          return undefined;
        case 'c': return diff && needsPr('comment on') ? startCompose('comment') : undefined;
        case 's': return needsPr('submit a review to') ? openSubmit() : undefined;
        case 'm': return needsPr('merge') ? openMerge() : undefined;
        case 't': return needsPr('rename') ? openRename() : undefined;
        case 'r': return reReview();
        case 'a': {
          const st = state.status.status;
          if (st === 'running' || st === 'queued') return flash('The analysis is already running.');
          if (st === 'ready' && !state.offerReanalysis) return flash('The analysis is up to date. r re-reviews when the branch has moved.');
          return runAnalysis();
        }
        case 'A': return state.tab === 'qa' ? askQaAgain() : undefined;
        case 'd': return openDiscard();
        case '?': return openHelp();
        default: {
          const tab = tabs.find((t) => t.n === key);
          if (tab) return setTab(tab.key);
          return undefined;
        }
      }
    }
    const readKeys = createKeyReader();
    function onData(chunk) {
      for (const key of readKeys(chunk)) {
        if (finished) return;
        try {
          const out = onKey(key);
          if (out?.catch) out.catch(soft);
        } catch (err) {
          soft(err);
        }
      }
    }

    hook();
    takeTerminal();
    stdin.on('data', onData);
    stdin.resume?.();
    stdout.on?.('resize', draw);
    draw();
    loadDraft();
    loadChat();
    loadQa(false);
    if (state.status.status === 'running' || state.status.status === 'queued') pollStatus();
  });
}

/** The screen as plain text, for a test. */
export function screenText(state, size) {
  return frame(state, { ...size, color: false }).map(stripAnsi);
}

export { plainText };
