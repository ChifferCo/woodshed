// Whose a terminal's scrolling is: the browser's own or tmux's. claude and codex run inline, so what scrolls off a pane
// on the main screen lands in the browser terminal's own scrollback (session/tmux.conf) and is read back there, with no
// round trip. A pane on the alternate screen (a full-screen program), in copy mode, or split, keeps no such history, so
// its wheel and swipes go to tmux as before. tmux says which in the terminal's title, and ttyd puts that title first in
// the frame's document title (`claude (main screen) | <ttyd's own>`). One file for terminal.js (a script that sets
// `WoodshedTerminalScroll`) and its test.
(function (root, factory) {
  const scroll = factory();
  if (typeof module === 'object' && module.exports) module.exports = scroll;
  else root.WoodshedTerminalScroll = scroll;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // tmux.conf's set-titles-string. Only this says the browser may scroll: a title without it (an older image, a
  // person's own tmux lines) leaves the scrolling to tmux, as before.
  const MAIN_SCREEN_RE = /\(main screen\)(?: \| |$)/;

  /** @returns {boolean}  whether the browser's own scrollback is the pane's history */
  function scrollsItself(title) {
    return MAIN_SCREEN_RE.test(String(title || ''));
  }

  /**
   * Where `lines` (negative: up) takes the view. Within the browser's scrollback it is the browser's. Past its top,
   * which holds only what came since the terminal attached, tmux holds the rest: its copy mode opens as far back as the
   * view would have gone, so reading goes on where it was, and the rest of the swipe is tmux's.
   * @param {{viewportY: number, baseY: number}} buf  xterm's active buffer: the view's first line, and the screen's
   * @param {number} lines
   * @returns {{own: number}|{tmux: number}}  lines to scroll the browser's view, or steps for tmux (POST /scroll)
   */
  function plan(buf, lines) {
    if (lines >= 0 || buf.viewportY + lines >= 0) return { own: lines };
    return { tmux: -(buf.baseY - buf.viewportY - lines) };
  }

  return { scrollsItself, plan };
});
