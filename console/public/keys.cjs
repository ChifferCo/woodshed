// The console's keyboard shortcuts: which key does what, how a key press is read, and how a key is written for this
// computer (⌘ on a Mac, Ctrl elsewhere). One file for the pages (a script that sets `WoodshedKeys`, read by shell.js)
// and the tests, so the shortcuts sheet, the hover hints and the key handler cannot disagree.
(function (root, factory) {
  const keys = factory();
  if (typeof module === 'object' && module.exports) module.exports = keys;
  else root.WoodshedKeys = keys;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // `mod` is written the Mac way and shown as Ctrl elsewhere. `bare` is a key alone, read only while nothing takes
  // typing; a space in it is a sequence (G, then M).
  const SHORTCUTS = [
    { id: 'palette', mod: '⌘K', bare: '/', what: 'Jump to a session, or run a command' },
    { id: 'new', mod: '⇧⌘O', bare: 'N', what: 'New session' },
    { id: 'rail', mod: '⌘.', what: 'Show or hide the rail' },
    { id: 'settings', mod: '⇧⌘,', what: 'Settings' },
    // Read by the New session form itself (launcher.js), from any of its fields: `where` says so on the sheet.
    { id: 'start', mod: '⌘↵', what: 'Start the session', where: 'New session' },
    // ⌘? opens it too (match, below), and is left off the list: it is ? with ⌘ held, which says nothing more.
    { id: 'keys', bare: '?', what: 'Keyboard shortcuts' },
    { id: 'mine', bare: 'G M', what: 'Go to My Woodshed', href: '/' },
    { id: 'everyone', bare: 'G E', what: 'Go to shared sessions', href: '/all' },
    { id: 'mySettings', bare: 'G S', what: 'Go to My settings', href: '/settings' },
  ];
  const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]));
  // The second key of a G sequence.
  const AFTER_G = { m: 'mine', e: 'everyone', s: 'mySettings' };

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
   * @param {{inFrame?: boolean, typing?: boolean, afterG?: boolean}} where  inFrame: pressed in a terminal, where Ctrl
   *   and every key alone are the terminal's; typing: focus takes text; afterG: G was the last key alone
   * @returns {string|null}  a shortcut's id, 'g' for the start of a sequence, or null when the key is not ours
   */
  function match(e, where = {}) {
    const code = e.code || '';
    if (e.metaKey || (e.ctrlKey && !where.inFrame)) {
      if (e.altKey) return null;
      if (e.key === '?' || (e.shiftKey && code === 'Slash')) return 'keys';
      if (code === 'KeyK' && !e.shiftKey) return 'palette';
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

  return { SHORTCUTS, byId, isMac, caps, label, takesTyping, match };
});
