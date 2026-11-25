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
    // Herdr's prefix: ⌘B, then one key, from anywhere, typing or in a terminal (Ctrl+B off a Mac, outside a terminal,
    // where Ctrl+B is tmux's own prefix). AFTER_PREFIX says which keys follow it.
    { id: 'prefix', mod: '⌘B', what: 'Then J, K, 1–4 or N, even while typing', page: 'moveSession' },
    // Moving through the sessions as Herdr moves through its panes: J and K alone, and ⌥⌘ with an arrow, which a
    // terminal frame passes to the page on a Mac. Only where there is a rail (session.js registers them).
    { id: 'nextSession', mod: '⌥⌘↓', bare: 'J', what: 'Next session in the rail', page: 'moveSession' },
    { id: 'prevSession', mod: '⌥⌘↑', bare: 'K', what: 'Previous session in the rail', page: 'moveSession' },
    // The pane bar's tabs by their place on it, as Herdr's prefix+1..9: Chat, TUI, Terminal, Review.
    { id: 'tab', mod: '⌥⌘1–4', bare: '1–4', what: 'The session\'s tabs, in their order on its bar', page: 'showTab' },
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
    // Herdr's goto picker filtered to the blocked: the next session, after the one shown, that waits on you.
    { id: 'needsYou', bare: 'G N', what: 'Next session that needs you', page: 'nextNeedsYou' },
  ];
  const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));
  // The second key of a G sequence.
  const AFTER_G = { m: 'mine', e: 'everyone', s: 'mySettings', n: 'needsYou' };
  // What a key after ⌘B is: the session keys alone, read whatever has the focus. Arrows too, as Herdr's navigate mode.
  const AFTER_PREFIX = { j: 'nextSession', k: 'prevSession', n: 'needsYou', arrowdown: 'nextSession', arrowup: 'prevSession' };
  // The tab keys: 1 to 4, read from the key's place (⌥ on a Mac turns the digit into another character).
  const TAB_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

  /** @returns {number}  which tab a tab key names, from 1, or 0 for none */
  function tabOf(e) {
    return TAB_CODES.indexOf(e.code || '') + 1;
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
   * @param {{inFrame?: boolean, typing?: boolean, afterG?: boolean, afterPrefix?: boolean}} where  inFrame: pressed in a
   *   terminal, where Ctrl and every key alone are the terminal's; typing: focus takes text; afterG: G was the last key
   *   alone; afterPrefix: ⌘B was the last key, so the next one is ours wherever it is pressed
   * @returns {string|null}  a shortcut's id, 'g' or 'prefix' for the start of a sequence, 'cancel' for Esc after ⌘B, or
   *   null when the key is not ours
   */
  function match(e, where = {}) {
    const code = e.code || '';
    if (where.afterPrefix && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'Escape') return 'cancel';
      if (tabOf(e) && String(e.key) === String(tabOf(e))) return 'tab';
      return e.shiftKey ? null : AFTER_PREFIX[String(e.key || '').toLowerCase()] ?? null;
    }
    if (e.metaKey || (e.ctrlKey && !where.inFrame)) {
      if (e.altKey) {
        // Ctrl+Alt is AltGr on many keyboards, which types { or @ with a digit: never ours while typing.
        if (e.shiftKey || (!e.metaKey && where.typing)) return null;
        if (code === 'ArrowDown') return 'nextSession';
        if (code === 'ArrowUp') return 'prevSession';
        return tabOf(e) ? 'tab' : null;
      }
      if (e.key === '?' || (e.shiftKey && code === 'Slash')) return 'keys';
      if (code === 'KeyK' && !e.shiftKey) return 'palette';
      if (code === 'KeyJ' && !e.shiftKey) return 'notifications';
      if (code === 'Comma') return 'settings';
      if (code === 'Period') return 'rail';
      if (code === 'KeyO' && e.shiftKey) return 'new';
      if (code === 'KeyB' && !e.shiftKey) return 'prefix';
      if (e.key === 'Enter' && !e.shiftKey) return 'start';
      return null;
    }
    if (e.ctrlKey || e.altKey || where.inFrame || where.typing) return null;
    const k = String(e.key || '');
    if (where.afterG) return AFTER_G[k.toLowerCase()] && !e.shiftKey ? AFTER_G[k.toLowerCase()] : null;
    if (k === '?') return 'keys';
    if (k === '/') return 'palette';
    // By the character it types, Shift or not: on AZERTY the digit row needs Shift for 1 to 4, and on QWERTY Shift+1 is !.
    if (tabOf(e) && k === String(tabOf(e))) return 'tab';
    if (e.shiftKey) return null;
    if (k === 'n' || k === 'N') return 'new';
    if (k === 'j' || k === 'J') return 'nextSession';
    if (k === 'k' || k === 'K') return 'prevSession';
    if (k === 'g' || k === 'G') return 'g';
    return null;
  }

  return { SHORTCUTS, byId, isMac, caps, label, takesTyping, match, tabOf };
});
