// The console's keyboard shortcuts: which key does what, how a key press is read, and how a key is written for this
// computer (⌘ on a Mac, Ctrl elsewhere). One file for the pages (a script that sets `WoodshedKeys`, read by shell.js)
// and the tests, so the shortcuts sheet, the hover hints and the key handler cannot disagree.
(function (root, factory) {
  const keys = factory();
  if (typeof module === 'object' && module.exports) module.exports = keys;
  else root.WoodshedKeys = keys;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // `mod` is written the Mac way and shown as Ctrl elsewhere, or as `modOther` is when it has one. `bare` is a key
  // alone, read only while nothing takes typing; a space in it is a sequence (G, then M).
  const SHORTCUTS = [
    { id: 'palette', mod: '⌘K', bare: '/', what: 'Jump to a session, or run a command' },
    { id: 'new', mod: '⇧⌘O', bare: 'N', what: 'New session' },
    { id: 'rail', mod: '⌘.', what: 'Show or hide the rail' },
    // Herdr's prefix and its navigate mode, on a key nothing else has: ⌘ tapped twice (Ctrl off a Mac), alone, turns on a
    // mode where the keys `then` names move through the sessions, wherever the focus is, typing or in a terminal (a
    // modifier alone sends a terminal nothing), until Esc, a click, or a key that is none of them. `tap` is the key,
    // written the Mac way; isTap reads it. Only where there is a rail (session.js).
    { id: 'prefix', tap: '⌘', what: 'Move through the sessions with the keys below, until Esc or a click', page: 'moveSession' },
    { id: 'nextSession', then: 'J ↓', what: 'Next session in the rail', page: 'moveSession' },
    { id: 'prevSession', then: 'K ↑', what: 'Previous session in the rail', page: 'moveSession' },
    // The pane bar's tabs by their place on it, as Herdr's prefix+1..9: Chat, TUI, Terminal, Review. Picking one ends the
    // mode, and the tab takes the keys.
    { id: 'tab', then: '1–4', what: 'The session\'s tabs, in their order on its bar', page: 'showTab' },
    // Herdr's goto picker filtered to the blocked: the next session, after the one shown, that waits on you.
    { id: 'needsYou', then: 'N', what: 'Next session that needs you', page: 'nextNeedsYou' },
    // Only where there is a list (notificationBell.js): a page with no one signed in leaves it off the sheet.
    { id: 'notifications', mod: '⌘J', what: 'Notifications', bell: true },
    { id: 'settings', mod: '⇧⌘,', what: 'Display settings: theme, review files, Chat or TUI' },
    // Read by the New session form itself (launcher.js), from any of its fields: `where` says so on the sheet.
    { id: 'start', mod: '⌘↵', what: 'Start the session', where: 'New session' },
    // Read by terminal.js (terminalFind.cjs's isFindKey). Off a Mac, `modOther`: Ctrl+F in a terminal is the pane's.
    { id: 'find', mod: '⌘F', modOther: '⇧⌘F', what: 'Find in the terminal', where: 'TUI and Terminal tabs' },
    // ⌘? opens it too (match, below), and is left off the list: it is ? with ⌘ held, which says nothing more.
    { id: 'keys', bare: '?', what: 'Keyboard shortcuts' },
    { id: 'mine', bare: 'G M', what: 'Go to My Woodshed', href: '/' },
    { id: 'everyone', bare: 'G E', what: 'Go to shared sessions', href: '/all' },
    { id: 'mySettings', bare: 'G S', what: 'Go to My settings', href: '/settings' },
  ];
  const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));
  // The second key of a G sequence.
  const AFTER_G = { m: 'mine', e: 'everyone', s: 'mySettings' };
  // What a key is while the double tap's mode is on: the session keys alone, read whatever has the focus. Arrows too, as Herdr's.
  const AFTER_PREFIX = { j: 'nextSession', k: 'prevSession', n: 'needsYou', arrowdown: 'nextSession', arrowup: 'prevSession' };
  // The tab keys: 1 to 4, read from the key's place.
  const TAB_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

  /** @returns {number}  which tab a tab key names, from 1, or 0 for none */
  function tabOf(e) {
    return TAB_CODES.indexOf(e.code || '') + 1;
  }

  /**
   * Whether a key event is the double tap's key on its own: ⌘ on a Mac, Ctrl elsewhere (where the Windows key is the
   * OS's), with no other modifier held. A tap is its press and release with nothing pressed between (shell.js).
   * @returns {boolean}
   */
  function isTap(e, mac) {
    if (e.key !== (mac ? 'Meta' : 'Control')) return false;
    return !e.shiftKey && !e.altKey && !(mac ? e.ctrlKey : e.metaKey);
  }

  /** @returns {boolean}  whether this browser is on an Apple computer, where ⌘ is the key */
  function isMac(nav) {
    return /Mac|iPhone|iPad/.test(String(nav?.platform || nav?.userAgent || ''));
  }

  const MAC_WORDS = { '⇧': 'Shift', '⌘': 'Ctrl', '⌥': 'Alt' };
  // A key written as a symbol on a Mac and as its name elsewhere.
  const KEY_WORDS = { '↵': 'Enter' };
  /**
   * @param {string} combo  as SHORTCUTS writes `mod`, e.g. '⇧⌘O'
   * @returns {string[]}  one key cap each: ['⇧', '⌘', 'O'] on a Mac, ['Ctrl', 'Shift', 'O'] elsewhere
   */
  function caps(combo, mac) {
    const chars = [...combo];
    const mods = chars.filter((c) => MAC_WORDS[c]);
    const key = chars.filter((c) => !MAC_WORDS[c]).join('');
    if (mac) return [...mods, key];
    // Ctrl first, as Windows and Linux write it.
    const order = ['⌘', '⇧', '⌥'].filter((m) => mods.includes(m));
    return [...order.map((m) => MAC_WORDS[m]), KEY_WORDS[key] || key];
  }

  /** @returns {string}  the combo as one line of text: '⇧⌘O', or 'Ctrl+Shift+O' */
  function label(combo, mac) {
    return mac ? caps(combo, true).join('') : caps(combo, false).join('+');
  }

  const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;
  /** @returns {boolean}  whether a key typed now goes into this element, so a key alone is the person's, not ours */
  function takesTyping(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXT_INPUTS.test(String(el.type || 'text').toLowerCase());
    return false;
  }

  /**
   * Which shortcut a key press is.
   * @param {{key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
   * @param {{inFrame?: boolean, typing?: boolean, afterG?: boolean, moving?: boolean}} where  inFrame: pressed in a
   *   terminal, where Ctrl and every key alone are the terminal's; typing: focus takes text; afterG: G was the last key
   *   alone; moving: the double tap's mode is on, so its keys are ours wherever they are pressed
   * @returns {string|null}  a shortcut's id, 'g' for the start of a sequence, 'cancel' for Esc in the mode, or null
   *   when the key is not ours (the double tap itself is isTap's, read over two presses)
   */
  function match(e, where = {}) {
    const code = e.code || '';
    if (where.moving && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'Escape') return 'cancel';
      // By the character it types, Shift or not: on AZERTY the digit row needs Shift for 1 to 4, and Shift+1 is ! here.
      if (tabOf(e) && String(e.key) === String(tabOf(e))) return 'tab';
      const move = e.shiftKey ? null : AFTER_PREFIX[String(e.key || '').toLowerCase()];
      // Any other key is what it would have been without the mode: / still opens the palette.
      if (move) return move;
    }
    if (e.metaKey || (e.ctrlKey && !where.inFrame)) {
      if (e.altKey) return null;
      if (e.key === '?' || (e.shiftKey && code === 'Slash')) return 'keys';
      if (code === 'KeyK' && !e.shiftKey) return 'palette';
      if (code === 'KeyJ' && !e.shiftKey) return 'notifications';
      if (code === 'Comma') return 'settings';
      if (code === 'Period') return 'rail';
      if (code === 'KeyO' && e.shiftKey) return 'new';
      if (e.key === 'Enter' && !e.shiftKey) return 'start';
      return null;
    }
    if (e.ctrlKey || e.altKey || where.inFrame || where.typing) return null;
    const k = String(e.key || '');
    if (where.afterG) return AFTER_G[k.toLowerCase()] && !e.shiftKey ? AFTER_G[k.toLowerCase()] : null;
    if (k === '?') return 'keys';
    if (k === '/') return 'palette';
    if (e.shiftKey) return null;
    if (k === 'n' || k === 'N') return 'new';
    if (k === 'g' || k === 'G') return 'g';
    return null;
  }

  return { SHORTCUTS, byId, isMac, isTap, caps, label, takesTyping, match, tabOf };
});
