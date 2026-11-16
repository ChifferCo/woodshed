// Find in a terminal: xterm.js paints the screen on a canvas, so the browser's own find (⌘F) sees none of it. This reads
// the frame's xterm buffer instead, the screen and the scrollback the browser keeps of what tmux scrolled off
// (session/tmux.conf), and says where each match is in cells, for terminal.js to select and scroll to. One file for
// terminal.js (a script that sets `WoodshedTerminalFind`) and its test.
(function (root, factory) {
  const find = factory();
  if (typeof module === 'object' && module.exports) module.exports = find;
  else root.WoodshedTerminalFind = find;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // A logical line longer than this many rows is read in pieces of it: a match across the cut is missed.
  const MAX_ROWS = 200;

  /**
   * Every match of `query` in the buffer, oldest first. Case is ignored. A line xterm wrapped is read as one, so a match
   * across the wrap is found; a wide glyph is one character and two cells.
   * @param {{length: number, getLine: (i: number) => any, getNullCell: () => any}} buf  xterm's active buffer
   * @param {string} query
   * @param {number} cols  the terminal's width
   * @returns {{row: number, col: number, cells: number}[]}  where each match starts and how many cells it covers
   */
  function findAll(buf, query, cols) {
    const needle = String(query || '').toLowerCase();
    if (!needle) return [];
    const found = [];
    let row = 0;
    while (row < buf.length) {
      let end = row + 1;
      while (end < buf.length && end - row < MAX_ROWS && buf.getLine(end)?.isWrapped) end++;
      // translateToString first: most lines hold no match, and reading them cell by cell is what costs.
      let quick = '';
      for (let r = row; r < end; r++) quick += buf.getLine(r)?.translateToString(r === end - 1) ?? '';
      if (quick.toLowerCase().includes(needle)) found.push(...inLine(buf, row, end, needle, cols));
      row = end;
    }
    return found;
  }

  // The matches in rows [first, end), read a cell at a time so each character has its place.
  function inLine(buf, first, end, needle, cols) {
    const cell = buf.getNullCell();
    let text = '';
    const at = [];
    for (let r = first; r < end; r++) {
      const line = buf.getLine(r);
      if (!line) break;
      for (let c = 0; c < Math.min(line.length, cols); c++) {
        const got = line.getCell(c, cell);
        if (!got || got.getWidth() === 0) continue;
        const chars = got.getChars() || ' ';
        for (let i = 0; i < chars.length; i++) at.push({ row: r, col: c, width: got.getWidth() });
        text += chars;
      }
    }
    const lower = text.toLowerCase();
    const found = [];
    // toLowerCase keeps the length of nearly all text; where it does not, the text is matched as it is.
    const hay = lower.length === text.length ? lower : text;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
      const start = at[i];
      const last = at[i + needle.length - 1];
      if (!start || !last) break;
      const cells = (last.row - start.row) * cols + (last.col + last.width) - start.col;
      found.push({ row: start.row, col: start.col, cells });
    }
    return found;
  }

  /**
   * Which match to show after `from` (null: none shown yet), going `dir` (-1: older, up; 1: newer, down). The first
   * one shown is the newest, nearest the prompt, where what someone looks for usually is.
   * @param {{row: number, col: number}[]} matches  oldest first
   * @param {{row: number, col: number}|null} from
   * @param {-1|0|1} dir  0 keeps `from` when it still matches, as the query grows
   * @returns {number}  an index into `matches`, -1 when there are none
   */
  function step(matches, from, dir) {
    if (!matches.length) return -1;
    if (!from) return matches.length - 1;
    const before = (m) => m.row < from.row || (m.row === from.row && m.col < from.col);
    const same = (m) => m.row === from.row && m.col === from.col;
    if (dir === 0) {
      const kept = matches.findIndex(same);
      if (kept >= 0) return kept;
      // The match it was on went away: the nearest older one, as if stepping up from there.
      dir = -1;
    }
    if (dir < 0) {
      for (let i = matches.length - 1; i >= 0; i--) if (before(matches[i])) return i;
      return matches.length - 1;
    }
    for (let i = 0; i < matches.length; i++) if (!before(matches[i]) && !same(matches[i])) return i;
    return 0;
  }

  /**
   * The key that opens find: ⌘F on a Mac. Elsewhere Ctrl+F is the pane's (forward a character, in claude's prompt and a
   * shell), so it is a terminal's Ctrl+Shift+F, as the copy key is Ctrl+Shift+C.
   * @param {{key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
   */
  function isFindKey(e, mac) {
    if (e.altKey || (e.code ? e.code !== 'KeyF' : String(e.key).toLowerCase() !== 'f')) return false;
    if (mac) return Boolean(e.metaKey) && !e.ctrlKey && !e.shiftKey;
    return Boolean(e.ctrlKey && e.shiftKey) && !e.metaKey;
  }

  return { findAll, step, isFindKey };
});
