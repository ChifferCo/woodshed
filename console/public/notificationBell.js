// The notifications in the console's page: the bell in the rail's foot, the same list in the middle of the screen on ⌘J
// (Ctrl+J), and a card at the bottom right for each that arrives while the page is in front. In the desktop app, the app
// keeps them (desktop/notificationLog.mjs) and desktop/preload.cjs hands them over as window.woodshedNotifications; in a
// browser, browserNotifications.js keeps them, with the same calls. designSystem/components/NotificationBell.
//
// A notification is new until its session is opened (from here, a card, the OS's, the rail or a link: the app marks
// it), or Mark all read. Looking at the list marks nothing: what it lists is still to be done.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const bridge = window.woodshedNotifications ?? W.browserNotifications;
  const available = Boolean(bridge && typeof bridge.list === 'function');
  const BELL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  // Each kind's dot, in the rail's colours: yellow only for what needs the person, as on a card.
  const DOTS = { 'needs-you': 'is-needs', failed: 'is-failed', done: 'is-done', merged: 'is-done', review: 'is-done', qa: 'is-done' };
  const sessionHref = (id) => `/s/${encodeURIComponent(id)}`;
  // The session page moves in place (session.js); any other page loads the session's.
  const go = (href) => (W.navigate ?? ((to) => { window.location.href = to; }))(href);

  function when(at) {
    // An entry with no time of its own (the app always gives one) says none, rather than stop the list drawing.
    if (!Number.isFinite(at)) return '';
    const ms = Date.now() - at;
    return ms < 60_000 ? 'just now' : W.ago(new Date(at).toISOString());
  }

  // ---- the list, one for the page: every bell and the dialog draw from it ----
  let list = { items: [], unread: 0 };
  const listeners = new Set();
  function setList(next) {
    if (!next || !Array.isArray(next.items)) return;
    list = next;
    for (const fn of listeners) fn();
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  const markAllRead = () => bridge.markRead();
  function openEntry(n) {
    bridge.markRead(n.key);
    go(sessionHref(n.id));
  }

  // The list as the person reads it: one group per session, its latest notification first, the sessions with something
  // new before the rest (Earlier), each part newest first. The count is of sessions, not of notifications.
  function grouped() {
    const bySession = new Map();
    for (const n of list.items) {
      const g = bySession.get(n.id) ?? { id: n.id, latest: n, times: 0, unread: [] };
      g.times += 1;
      if (!n.read) g.unread.push(n.key);
      bySession.set(n.id, g);
    }
    const all = [...bySession.values()];
    return { fresh: all.filter((g) => g.unread.length), earlier: all.filter((g) => !g.unread.length) };
  }
  const newSessions = () => grouped().fresh.length;
  function openGroup(g) {
    for (const key of g.unread) bridge.markRead(key);
    go(sessionHref(g.id));
  }

  // One session's notifications as a row: its name, what it said last and when, how many times it did; a new one bold.
  function row(g, extra = {}) {
    const n = g.latest;
    return h('a', {
      class: `bell-item${g.unread.length ? ' is-new' : ''}`, href: sessionHref(g.id), ...extra,
      onclick: (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        extra.beforeOpen?.();
        openGroup(g);
      },
    },
    h('span', { class: `bell-dot ${DOTS[n.kind] || 'is-other'}`, 'aria-hidden': 'true' }),
    h('span', { class: 'bell-text' },
      h('b', { class: 'bell-title' }, n.title),
      h('span', { class: 'bell-body' }, n.body),
      h('span', { class: 'bell-when' }, when(n.at), g.times > 1 ? ` · ${g.times} notifications` : '')));
  }
  // The rows under their parts' names, New and Earlier, each named only when both are there.
  function rowsOf(groups, rowFor) {
    const { fresh, earlier } = groups;
    if (!fresh.length && !earlier.length) return [empty()];
    const both = fresh.length && earlier.length;
    return [
      both ? h('div', { class: 'bell-part' }, 'New') : null,
      ...fresh.map((g, i) => rowFor(g, i)),
      both ? h('div', { class: 'bell-part' }, 'Earlier') : null,
      ...earlier.map((g, i) => rowFor(g, fresh.length + i)),
    ].filter(Boolean);
  }
  const empty = () => h('p', { class: 'bell-empty' }, 'Nothing yet. What this app notifies you of shows here too.');
  // The list's head: its name, and Mark all read while something is new.
  function head(onMark) {
    return h('div', { class: 'bell-head' },
      h('span', { class: 'menu-label' }, 'Notifications'),
      newSessions() ? h('button', { type: 'button', class: 'bell-mark', onclick: (e) => { e.stopPropagation(); onMark?.(); markAllRead(); } }, 'Mark all read') : null);
  }
  // In a browser, its own notifications for when no tab of the console is in front: asked for once, from a click. The
  // desktop app's are the OS's already.
  function ask(redraw) {
    if (!bridge.canAsk?.()) return null;
    return h('button', {
      type: 'button', class: 'bell-ask',
      onclick: async (e) => {
        e.stopPropagation();
        await bridge.askPermission().catch(() => {});
        redraw();
      },
    }, 'Notify me outside this tab');
  }

  // ---- the bell ----
  /**
   * @returns {HTMLElement|null}  the bell and its list, or null outside the desktop app
   */
  function create() {
    if (!available) return null;
    const count = h('span', { class: 'bell-count', hidden: true });
    const button = h('button', { type: 'button', class: 'rail-bell', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-keys': 'notifications' });
    button.innerHTML = BELL_ICON;
    button.append(count);
    const panel = h('div', { class: 'bell-list', role: 'region', 'aria-label': 'Notifications', hidden: true });
    const el = h('div', { class: 'rail-bell-wrap' }, button, panel);

    function drawButton() {
      const fresh = newSessions();
      count.hidden = !fresh;
      count.textContent = fresh > 99 ? '99+' : String(fresh);
      const label = fresh ? `Notifications, ${fresh} ${fresh === 1 ? 'session' : 'sessions'} with something new` : 'Notifications';
      button.setAttribute('aria-label', label);
      button.dataset.hint = label;
    }
    function drawPanel() {
      const hadFocus = panel.contains(document.activeElement);
      panel.replaceChildren(head(), h('div', { class: 'bell-rows' }, rowsOf(grouped(), (g) => row(g, { beforeOpen: () => setOpen(false) }))),
        ask(drawPanel) ?? '');
      // Mark all read goes with what it marked: focus goes back to the bell, where Escape still closes the list.
      if (hadFocus && !panel.contains(document.activeElement)) button.focus();
    }
    function draw() {
      drawButton();
      if (!panel.hidden) drawPanel();
    }
    function setOpen(open) {
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) drawPanel();
    }
    button.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('click', (e) => { if (!panel.hidden && !el.contains(e.target)) setOpen(false); });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || panel.hidden) return;
      setOpen(false);
      button.focus();
    });
    // The rail's foot is made once (session.js), so one bell listens for the page's life.
    subscribe(draw);
    drawButton();
    return el;
  }

  // ---- ⌘J: the list in the middle of the screen, read with the keys ----
  const dialog = available ? h('div', { class: 'palette bell-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Notifications', tabindex: '-1' }) : null;
  const overlay = available ? h('div', { class: 'overlay', hidden: true }, dialog) : null;
  let cursor = 0;
  // The session the keys are on, so one arriving above it leaves them on it rather than on whatever takes its place.
  let cursorKey = null;
  // The groups in the order the dialog shows them, for its keys.
  let order = [];
  let returnFocus = null;
  function drawDialog() {
    if (!overlay || overlay.hidden) return;
    const groups = grouped();
    order = [...groups.fresh, ...groups.earlier];
    const at = cursorKey === null ? -1 : order.findIndex((g) => g.id === cursorKey);
    cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, order.length - 1));
    cursorKey = order[cursor]?.id ?? null;
    // A redraw takes away what had focus in it (Mark all read, gone once nothing is new): the dialog keeps it, for its keys.
    const hadFocus = dialog.contains(document.activeElement);
    const rows = rowsOf(groups, (g, i) => row(g, {
      'data-cursor': String(i === cursor), beforeOpen: closeDialog,
      onmousemove: () => { if (cursor !== i) { cursor = i; cursorKey = g.id; drawDialog(); } },
    }));
    const hint = (label, key) => h('span', null, h('kbd', null, key), label);
    dialog.replaceChildren(head(), h('div', { class: 'plist bell-rows' }, rows), ask(drawDialog) ?? '',
      h('div', { class: 'pfoot' }, order.length ? [hint('Select', '↑↓'), hint('Open', '⏎')] : null, hint('Close', 'esc')));
    dialog.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
    if (hadFocus && !dialog.contains(document.activeElement)) dialog.focus();
  }
  function openDialog() {
    if (!overlay) return;
    W.shell?.closeAll?.();
    if (!overlay.isConnected) document.body.append(overlay);
    returnFocus = document.activeElement;
    cursor = 0;
    cursorKey = null;
    overlay.hidden = false;
    drawDialog();
    dialog.focus();
  }
  function closeDialog() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    const el = returnFocus;
    returnFocus = null;
    if (el && el.isConnected) el.focus();
  }
  if (overlay) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
    dialog.addEventListener('keydown', (e) => {
      const n = order.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        cursorKey = order[cursor]?.id ?? null;
        drawDialog();
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const g = order[cursor];
        if (!g) return;
        closeDialog();
        openGroup(g);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDialog();
      }
    });
    subscribe(drawDialog);
  }

  // ---- cards: with the app in front, a notification shows here rather than in the OS's (desktop/main.mjs) ----
  // At the window's bottom right, opening its session, gone after a while or once its session is opened. The list
  // keeps it too.
  const SHOWN_MS = 10_000;
  let stack = null;
  function arrived(n) {
    if (!n?.id) return;
    stack ??= document.body.appendChild(h('div', { class: 'bell-toasts', role: 'status', 'aria-live': 'polite' }));
    let timer = null;
    const close = () => { clearTimeout(timer); card.remove(); };
    const card = h('div', { class: 'bell-toast', 'data-session': n.id },
      h('button', { type: 'button', class: 'bell-toast-open', onclick: () => { close(); openEntry(n); } },
        h('span', { class: `bell-dot ${DOTS[n.kind] || 'is-other'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'bell-text' }, h('b', { class: 'bell-title' }, n.title), h('span', { class: 'bell-body' }, n.body))),
      h('button', { type: 'button', class: 'bell-toast-close', 'aria-label': 'Dismiss', onclick: close }, '×'));
    // An older card of the same session says less than this one.
    for (const old of stack.querySelectorAll(`[data-session="${CSS.escape(n.id)}"]`)) old.remove();
    stack.append(card);
    const later = () => { timer = setTimeout(close, SHOWN_MS); };
    card.addEventListener('mouseenter', () => clearTimeout(timer));
    card.addEventListener('mouseleave', later);
    later();
  }
  // Opening a session takes its cards away, as it takes the OS's.
  function sessionOpened() {
    const id = /^\/s\/([0-9a-f]{8})$/.exec(location.pathname)?.[1];
    if (id && stack) for (const card of stack.querySelectorAll(`[data-session="${id}"]`)) card.remove();
  }

  if (available) {
    window.addEventListener('woodshed:route', sessionOpened);
    bridge.onChange?.(setList);
    bridge.onArrived?.(arrived);
    bridge.list().then(setList).catch(() => {});
  }

  W.notificationBell = create;
  // For the shell's ⌘J and its palette (shell.js): nothing on a page with no list (signed out).
  W.notifications = available
    ? { available: true, open: openDialog, close: closeDialog, toggle: () => (overlay.hidden ? openDialog() : closeDialog()), isOpen: () => !overlay.hidden }
    : { available: false, open() {}, close() {}, toggle() {}, isOpen: () => false };
})();
