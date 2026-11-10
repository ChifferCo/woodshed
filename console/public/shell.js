// The shed's shell around every page: the command palette (⌘K), the shortcuts sheet (⌘?), the settings sheet
// (⇧⌘,) with the theme, and the keys that open them. The session page registers its sessions and their actions
// (W.shell.register); every other page gets the commands alone. Keys pressed in a terminal frame reach here too
// (W.shell.bindFrame), with ⌘ only: Ctrl there is the terminal's.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const THEME_KEY = 'woodshed-cloud-theme';
  // Read by the shed's review page, which is framed on this origin: writing it fires a storage event there.
  const REVIEW_EXPAND_KEY = 'shed.review.expand';

  let page = { sessions: () => [], actions: () => [], toggleRail: null, railShown: () => true };

  function register(next) {
    page = { ...page, ...next };
  }

  // ---- focus: a sheet takes it, and gives it back to where it was ----
  let returnFocus = null;
  function takeFocus(el) {
    returnFocus = document.activeElement;
    el.focus();
  }
  function giveFocusBack() {
    const el = returnFocus;
    returnFocus = null;
    if (el && el.isConnected) el.focus();
  }

  function overlay(child, onClose) {
    const el = h('div', { class: 'overlay', hidden: true }, child);
    el.addEventListener('click', (e) => { if (e.target === el) onClose(); });
    document.body.append(el);
    return el;
  }

  function closeAll() {
    closePalette();
    closeSheet(keys);
    closeSheet(settings);
  }

  // ---- toast ----
  let toastEl = null;
  let toastTimer = null;
  function toast(text) {
    toastEl ??= document.body.appendChild(h('div', { class: 'toast', role: 'status', hidden: true }));
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2000);
  }

  // ---- the palette ----
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search or start a session', 'aria-label': 'Search' });
  const list = h('div', { class: 'plist', role: 'listbox' });
  const foot = h('div', { class: 'pfoot' });
  const palette = overlay(h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list, foot), closePalette);
  let results = [];
  let cursor = 0;
  // A session whose actions the palette shows, after Tab on it.
  let actionsFor = null;

  // A page with the rail moves to its own pages in place (session.js); every other page loads the next.
  function go(href) {
    return () => { (W.navigate ?? ((to) => { window.location.href = to; }))(href); };
  }

  function commands() {
    return [
      { group: 'Go to', label: 'Shared sessions', run: go('/all') },
      { group: 'Go to', label: 'My Woodshed', run: go('/') },
      { group: 'Go to', label: 'My settings', run: go('/settings') },
      ...(W.isAdmin?.() ? W.consoleLinks().map((link) => ({ group: 'Go to', label: link.label, run: go(link.href) })) : []),
      { group: 'Commands', label: 'Keyboard shortcuts', meta: '⌘?', run: () => openSheet(keys) },
      { group: 'Commands', label: 'Settings', meta: '⇧⌘,', run: () => openSheet(settings) },
      page.toggleRail && { group: 'Commands', label: page.railShown() ? 'Hide the rail' : 'Show the rail', meta: '⌘.', run: page.toggleRail },
    ].filter(Boolean);
  }

  // A plain substring match, as the shed's: a name is typed, not guessed at.
  function find(query) {
    const q = query.trim().toLowerCase();
    const hit = (text) => !q || String(text || '').toLowerCase().includes(q);
    if (actionsFor) return page.actions(actionsFor).filter((a) => hit(a.label));
    const out = [];
    if (hit('new session')) out.push({ group: 'Quick actions', label: 'New session', meta: '⇧⌘O', run: go('/?new=1') });
    for (const s of page.sessions()) {
      // Stopped ones only once something is typed: the list is for jumping, and most of them are history.
      if (!s.live && !q) continue;
      if (!hit(`${s.title} ${s.id} ${s.branch || ''}`)) continue;
      out.push({ group: s.live ? 'Active' : 'Stopped', label: s.title, meta: s.meta, live: s.live, session: s, run: go(s.href) });
    }
    for (const c of commands()) if (hit(`${c.group} ${c.label}`)) out.push(c);
    return out;
  }

  function renderPalette() {
    results = find(input.value);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    let group = null;
    const rows = [];
    results.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        rows.push(h('div', { class: 'pgroup' }, group));
      }
      const row = h('button', {
        type: 'button', class: `pitem${item.danger ? ' is-danger' : ''}`, role: 'option', 'data-cursor': String(i === cursor),
        onmousemove: () => { if (cursor !== i) { cursor = i; renderPalette(); } },
        onclick: (e) => { e.stopPropagation(); run(item); },
      },
        h('span', { class: `pdot${item.live ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'plabel' }, item.label),
        item.meta && h('span', { class: 'pmeta' }, item.meta));
      rows.push(row);
    });
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'pempty' }, 'Nothing matches that.')]));
    list.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
    const hint = (label, key) => h('span', null, h('kbd', null, key), label);
    const onSession = Boolean(results[cursor]?.session);
    foot.replaceChildren(...(actionsFor
      ? [hint('Select', '↑↓'), hint('Run', '⏎'), hint('Back', '⇥'), hint('Close', 'esc')]
      : [hint('Select', '↑↓'), hint('Open', '⏎'), onSession && hint('Actions', '⇥'), hint('Close', 'esc')].filter(Boolean)));
  }

  function setLevel(session) {
    actionsFor = session;
    input.value = '';
    cursor = 0;
    input.placeholder = session ? `What to do with ${session.title}` : 'Search or start a session';
    renderPalette();
  }

  function run(item) {
    closePalette();
    item.run();
  }

  function openPalette() {
    closeSheet(keys);
    closeSheet(settings);
    setLevel(null);
    palette.hidden = false;
    takeFocus(input);
  }

  function closePalette() {
    if (palette.hidden) return;
    palette.hidden = true;
    actionsFor = null;
    giveFocusBack();
  }

  input.addEventListener('input', () => { cursor = 0; renderPalette(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[cursor]) run(results[cursor]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (actionsFor) setLevel(null);
      else if (results[cursor]?.session) setLevel(results[cursor].session);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (actionsFor) setLevel(null);
      else closePalette();
    }
  });

  // ---- the two sheets ----
  function sheet(title, body) {
    const dialog = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
      h('div', { class: 'sheet-head' }, h('h3', null, title), h('span', { class: 'esc' }, 'esc to close')),
      h('div', { class: 'sheet-body' }, body));
    const el = overlay(dialog, () => closeSheet(record));
    const record = { el, dialog, onOpen: null };
    return record;
  }

  function openSheet(s) {
    closePalette();
    for (const other of [keys, settings]) if (other !== s) closeSheet(other);
    s.onOpen?.();
    s.el.hidden = false;
    takeFocus(s.dialog);
  }

  function closeSheet(s) {
    if (s.el.hidden) return;
    s.el.hidden = true;
    giveFocusBack();
  }

  function toggleSheet(s) {
    if (s.el.hidden) openSheet(s);
    else closeSheet(s);
  }

  const KEYS = [
    [['⌘', 'K'], 'Jump to a session, or run a command'],
    [['⇧⌘', 'O'], 'New session'],
    [['⌘', '.'], 'Show or hide the rail'],
    [['⇧⌘', ','], 'Settings'],
    [['⌘', '?'], 'This list'],
  ];
  const keys = sheet('Keyboard', [
    KEYS.map(([combo, what]) => h('div', { class: 'krow' }, h('div', { class: 'kkeys' }, combo.map((k) => h('kbd', null, k))), h('div', null, what))),
    h('p', { class: 'sheet-note' }, 'Ctrl works for ⌘ too, except inside a terminal, where Ctrl is the terminal\'s. Sessions have no key of their own: ⌘K, then type a name.'),
  ]);

  // Appearance is this browser's.
  const THEMES = [['system', 'device', 'Follow my device'], ['light', 'light', 'Always light'], ['dark', 'dark', 'Always dark']];
  function currentTheme() {
    return document.documentElement.dataset.theme || 'system';
  }
  function setTheme(theme) {
    try {
      if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A private window keeps it for this page.
    }
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    paintSettings();
  }

  function reviewExpands() {
    try {
      return window.localStorage.getItem(REVIEW_EXPAND_KEY) === 'all';
    } catch {
      return false;
    }
  }
  function setReviewExpand(value) {
    try {
      if (value === 'all') window.localStorage.setItem(REVIEW_EXPAND_KEY, 'all');
      else window.localStorage.removeItem(REVIEW_EXPAND_KEY);
    } catch {
      // A private window keeps nothing.
    }
    paintSettings();
  }

  function seg(options, current, onPick) {
    return h('div', { class: 'theme-seg', role: 'group' }, options.map(([value, label, title]) => h('button', {
      type: 'button', class: 'theme-opt', title, 'aria-pressed': String(value === current), onclick: () => onPick(value),
    }, label)));
  }

  const settingsBody = h('div');
  const settings = sheet('Settings', settingsBody);
  function paintSettings() {
    settingsBody.replaceChildren(
      h('div', { class: 'set-row' },
        h('div', { class: 'set-title' }, 'Appearance'),
        h('p', { class: 'set-note' }, 'Follow the device, or pick one and keep it. Terminals stay dark either way: they are a program\'s colours, not the page\'s.'),
        seg(THEMES, currentTheme(), setTheme)),
      h('div', { class: 'set-row' },
        h('div', { class: 'set-title' }, 'Review files'),
        h('p', { class: 'set-note' }, 'Whether a review opens with every file\'s diff showing or folded. This browser\'s; files you mark as viewed stay folded.'),
        seg([['collapsed', 'folded', 'Open a review with every file folded'], ['all', 'expanded', 'Open a review with every file\'s diff showing']],
          reviewExpands() ? 'all' : 'collapsed', setReviewExpand)),
      h('p', { class: 'sheet-note' }, 'Your Claude token, GitHub and databases are on ', h('a', { href: '/settings' }, 'My settings'), '.'));
  }
  settings.onOpen = paintSettings;

  // ---- the keys ----
  function onKey(e, inFrame) {
    if (e.key === 'Escape' && (!palette.hidden || !keys.el.hidden || !settings.el.hidden)) {
      if (!palette.hidden && actionsFor) return;
      e.preventDefault();
      closeAll();
      return;
    }
    if (!e.metaKey && !(e.ctrlKey && !inFrame)) return;
    let act = null;
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) act = () => toggleSheet(keys);
    else if (e.code === 'KeyK' && !e.shiftKey) act = () => (palette.hidden ? openPalette() : closePalette());
    else if (e.code === 'Comma') act = () => toggleSheet(settings);
    else if (e.code === 'Period' && page.toggleRail) act = page.toggleRail;
    else if (e.code === 'KeyO' && e.shiftKey) act = go('/?new=1');
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }
  document.addEventListener('keydown', (e) => onKey(e, false), true);

  // A terminal frame is same-origin, so its document's keys can be read before xterm takes them.
  function bindFrame(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.__woodshedShell) return;
      doc.__woodshedShell = true;
      doc.addEventListener('keydown', (e) => onKey(e, true), true);
    } catch {
      // Not same-origin after all: the page's own keys still work.
    }
  }

  W.shell = {
    register, toast, bindFrame, openPalette, openSettings: () => openSheet(settings), openKeys: () => openSheet(keys),
  };
})();
